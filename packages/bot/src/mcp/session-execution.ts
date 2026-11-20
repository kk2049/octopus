import { randomBytes } from "node:crypto";
import type { Operation } from "@claude-bot/capability-kernel";
import { WORKSPACE_FILES_CONTRACT_V2 } from "@claude-bot/workspace-files-contract";
import type { McpTokenRow, SessionExecutionBindingRow, Store } from "../store/store.js";
import {
  RUN_WORKSPACE_COMMAND,
  type ExecutionWorkspaceCapabilities,
  type ExecutionWorkspaceGrant,
} from "../execution-workspace/capability.js";
import type {
  ExecutionScopeIssuerPort,
  ExecutionScopePermissionProfile,
  ExecutionScopePickup,
  ExecutionScopeTarget,
} from "../execution-workspace/scope-issuer.js";
import { GrantWorkspaceFilesAuthority } from "../workspace-files/authority.js";
import {
  WORKSPACE_FILES_OPERATIONS,
  OWNER_FILES_WRITE_OPERATION,
  type WorkspaceFilesCapabilities,
  type WorkspaceFilesGrant,
} from "../workspace-files/capability.js";
import { RunnerWorkspaceFilesBackend } from "../workspace-files/runner-backend.js";
import { readWorkspaceDirectorySnapshot } from "../workspace-files/directory-index.js";
import { WorkspaceFilesService, type WorkspaceFilesScopePort } from "../workspace-files/service.js";
import { hashRunnerToken, type RunnerDeviceStatus, type RunnerExecutionRelayRequest } from "../runner/gateway.js";
import type { WorkspaceFilesBackend } from "../workspace-files/types.js";
import type { McpPrincipal, McpToolOutcome } from "./service.js";
import {
  decodeMcpTokenPolicy,
  mcpCredentialOf,
  mcpDocAssistantPolicy,
  mcpRegistration,
  type MintedMcpToken,
  mcpSessionExecutionPolicy,
  mintMcpToken,
} from "./tokens.js";

/** One credential's lifetime; ticket and Sessions+ split sessions renew it from their persisted placement. */
const SESSION_EXECUTION_TTL_MS = 24 * 60 * 60_000;
// This delegated scope only exposes registered-workspace file refs. New
// owner-local App consent must not widen existing execution credentials.
const SESSION_WORKSPACE_OPERATIONS = Object.keys(WORKSPACE_FILES_OPERATIONS)
  .filter((operation) => operation !== OWNER_FILES_WRITE_OPERATION) as Operation[];
/**
 * Everything a read-only scope (a Feishu document assistant) holds on its
 * workspace, all silently allowed: list the root, list a directory, read text.
 */
export const SESSION_READ_ONLY_OPERATIONS = ["list_session_workspaces", "list_workspace_entries", "read_workspace_text"] as const;
const READ_ONLY_OPS = [...SESSION_READ_ONLY_OPERATIONS] as Operation[];

/**
 * `read_only` is a document assistant's scope: the three workspace reads, no
 * command grant, no Codex relay, and one document share (`docShare`).
 */
export type SessionExecutionProfile = ExecutionScopePermissionProfile | "read_only";

/**
 * A document assistant's durable placement (`feishu_doc_assistants`), the one
 * record that says a provider session is one. `live` is false once it ended.
 */
export interface AssistantSessionPlacement {
  docShare: string;
  executionDevice: string;
  workspaceId: string;
  live: boolean;
}
/** A minted credential waits this long for its one-time pickup, then dies with its scope. */
const PICKUP_TTL_MS = 10 * 60_000;
const CODEX_EXEC_RELAY_METHODS = new Set([
  "codex_exec_open",
  "codex_exec_read",
  "codex_exec_write",
  "codex_exec_reconnect",
  "codex_exec_close",
]);

interface SessionExecutionScope {
  owner: string;
  runtimeOwner: string;
  runtimeResourceId: string | null;
  operationId: string;
  credential: string;
  token: string;
  tokenHash: string;
  /**
   * The bearer has a token row (minted here, or the row a restored scope came
   * back from): revoking the scope revokes it and deletes its binding,
   * whether or not the plaintext is still in memory. False for a scope whose
   * lifetime is a Runner connection's.
   */
  durable: boolean;
  workspace: WorkspaceFilesScopePort;
  workspaceGrant: WorkspaceFilesGrant;
  /** Null for a read-only scope: it holds no command authority at all. */
  executionGrant: ExecutionWorkspaceGrant | null;
  runtimeDevice: string;
  executionDevice: string;
  workspaceId: string;
  permissionProfile: SessionExecutionProfile;
  /** read_only only: the via='assistant' document share this scope reaches. */
  docShare: string | null;
  expiresAt: number;
  /** Credential handle of the token that opened this scope on demand; undefined for a launch scope. */
  issuer?: string;
  sessionKey?: string;
  source?: "claude" | "codex" | "omp";
  sessionId?: string;
  timer: NodeJS.Timeout | null;
}

interface PendingPickup {
  owner: string;
  issuer: string;
  credential: string;
  expiresAt: number;
  timer: NodeJS.Timeout;
}

export interface SessionExecutionCredential {
  /** Trusted in-process handle; local connections never receive a bearer. */
  credential: string;
  token: string;
  endpoint: string;
  expiresAt: number;
  /** Binds this launch-scoped authority to the provider session it created. */
  bindSession(source: string, sessionId: string): void;
  /** Trusted dispatch lifecycle hook; never serialized to the Runner. */
  release(): void;
}

export interface SessionExecutionDispatch {
  token: string;
  endpoint: string;
  expiresAt: number;
  operationId: string;
  executionDevice: string;
  workspaceId: string;
  runtimeOwner: string;
  runtimeResourceId: string | null;
}

export interface LocalAgentExecutionScope {
  principal: McpPrincipal;
  /** The workspace this scope is bound to: the caller's choice or the device's Home. */
  workspaceId: string;
  isActive(): boolean;
  close(): void;
}

/** A target roster waits this long for one device; a silent device is reported, not awaited. */
export const TARGET_WORKSPACES_BUDGET_MS = 10_000;

export interface TargetWorkspace {
  workspace_id: string;
  label: string;
  display?: string;
}

/** The scan home itself ("~"), else the workspace labelled Home, else the only one. */
export function defaultTargetWorkspace(workspaces: readonly TargetWorkspace[]): string | undefined {
  const chosen = workspaces.find((workspace) => workspace.display === "~")
    ?? workspaces.find((workspace) => workspace.label === "Home")
    ?? (workspaces.length === 1 ? workspaces[0] : undefined);
  return chosen?.workspace_id;
}

/** What an on-demand opener receives once, after redeeming its pickup. */
export interface SessionExecutionIssued {
  token: string;
  endpoint: string;
  expires_at: number;
  operation_id: string;
  device: string;
  workspace_id: string;
  permission_profile: ExecutionScopePermissionProfile;
}

/**
 * Live authority created only after a Gate allowed it: the start_session Gate
 * for a split placement, or the execution-scope Gate for an owner's own
 * on-demand request. The durable token row is attenuation; these closable
 * grants are the authority. After a bot restart the row may still
 * authenticate, but no scope resolves, so it fails closed.
 */
export class SessionExecutionRegistry implements ExecutionScopeIssuerPort {
  private readonly scopes = new Map<string, SessionExecutionScope>();
  private readonly releaseListeners = new Set<(owner: string, credential: string) => void>();
  private readonly sessionCredentials = new Map<string, string>();
  /** One-time pickups: handle → the scope's credential, waiting for its opener. */
  private readonly pickups = new Map<string, PendingPickup>();

  constructor(private readonly options: {
    store: Store;
    workspaceCapabilities: WorkspaceFilesCapabilities;
    executionCapabilities: ExecutionWorkspaceCapabilities;
    workspaceFilesService: WorkspaceFilesService;
    /** Gateway-local presence + inventory of one owner's devices; absent = on-demand issue unavailable. */
    devices?: (owner: string) => readonly RunnerDeviceStatus[];
    /**
     * Whether a provider session is a document assistant, from its durable
     * record. An assistant's session binds and renews only as its read-only
     * scope, and a read-only scope binds only to a live assistant's session;
     * absent, no read-only scope binds at all.
     */
    assistantOf?: (owner: string, runtimeDevice: string, source: string, sessionId: string) => AssistantSessionPlacement | null;
    publicUrl?: string;
    dashboardPort: number;
    now?: () => number;
  }) {}

  /** Derived account grants and pending calls must end with their launch scope. */
  onRelease(listener: (owner: string, credential: string) => void): () => void {
    this.releaseListeners.add(listener);
    return () => { this.releaseListeners.delete(listener); };
  }

  /**
   * Rebuild live capability grants from bearer-free bindings after Bot boot.
   * The old plaintext token is unavailable by design; an already-running
   * Runner can keep presenting it, while the next dispatch rotates a fresh
   * bearer over the authenticated device socket.
   */
  restore(): number {
    const now = (this.options.now ?? Date.now)();
    const nowIso = new Date(now).toISOString();
    let restored = 0;
    for (const binding of this.options.store.listActiveSessionExecutionBindings(nowIso)) {
      const token = this.options.store.getActiveMcpTokenByHash(binding.token_hash, nowIso);
      if (!token) continue;
      try {
        const policy = decodeMcpTokenPolicy(token.policy_json)?.sessionExecution;
        if (
          !policy
          || policy.operationId !== binding.operation_id
          || policy.runtimeDevice !== binding.runtime_device
          || policy.executionDevice !== binding.execution_device
          || policy.workspaceId !== binding.workspace_id
          || policy.permissionProfile !== binding.permission_profile
          || (policy.docShare ?? null) !== (binding.doc_share_id ?? null)
        ) continue;
        // A document assistant's scope comes back only while that assistant lives; an ended one's goes for good.
        if (binding.permission_profile === "read_only") {
          const assistant = this.options.assistantOf?.(binding.owner, binding.runtime_device, binding.source, binding.session_id);
          if (!assistant?.live || assistant.docShare !== binding.doc_share_id) {
            this.dropBinding(binding);
            continue;
          }
        }
        if (this.restoreBinding(binding, token)) restored++;
      } catch {
        // Malformed/stale durable authority fails closed. A later explicit new
        // session can replace it; boot must not reinterpret it optimistically.
      }
    }
    return restored;
  }

  issue(input: {
    owner: string;
    /** Authenticated Runner owner; defaults to the caller for ordinary split placement. */
    runtimeOwner?: string;
    /** Exact canonical shared-runtime resource; null for owner-local placement. */
    runtimeResourceId?: string | null;
    operationId: string;
    runtimeDevice: string;
    executionDevice: string;
    workspaceId: string;
    permissionProfile: SessionExecutionProfile;
    /** read_only only, and required there: the document assistant's via='assistant' share. */
    docShare?: string;
    /** Bounded above by the 24h launch default. */
    ttlMs?: number;
    issuer?: string;
    /** Local interactive bridges may browse before asking on writes/commands. */
    manualObserveAutoAllow?: boolean;
    /** Lifetime is owned by an authenticated Runner connection, not a bearer. */
    connectionBound?: boolean;
  }): SessionExecutionCredential {
    const runtimeOwner = input.runtimeOwner ?? input.owner;
    const runtimeResourceId = input.runtimeResourceId ?? null;
    const borrowed = runtimeOwner !== input.owner;
    if (
      borrowed !== Boolean(runtimeResourceId)
      || (runtimeResourceId !== null && !/^agent-runtime:[0-9a-f]{32}$/.test(runtimeResourceId))
      || (borrowed && input.runtimeDevice === input.executionDevice)
    ) {
      throw new Error("共享 Agent scope 必须同时固定跨 owner 资源，并与调用者执行设备分离");
    }
    // A document assistant's scope is minted only here, directly after its
    // launch Gate: its own device, the owner's own Runner, no issuing token.
    const readOnly = input.permissionProfile === "read_only";
    // The `op_fda` launch namespace is the document assistants': nothing there is ever issued wider than read-only.
    if (input.operationId.startsWith("op_fda") && !readOnly) {
      throw new Error("文档助手的启动只能签发只读执行权限");
    }
    if (readOnly !== (input.docShare !== undefined)
      || (readOnly && (borrowed || input.runtimeDevice !== input.executionDevice
        || input.issuer !== undefined || input.connectionBound || input.manualObserveAutoAllow))) {
      throw new Error("只读执行权限只签给登记的文档助手：同一台设备、所有者自己的 Runner、由服务端直接签发");
    }
    const now = this.options.now ?? Date.now;
    const ttlMs = Math.max(60_000, Math.min(SESSION_EXECUTION_TTL_MS, input.ttlMs ?? SESSION_EXECUTION_TTL_MS));
    const { workspace, workspaceGrant, executionGrant, scopeId } = this.openScopeAuthority({
      owner: input.owner,
      operationId: input.operationId,
      executionDevice: input.executionDevice,
      workspaceId: input.workspaceId,
      profile: input.permissionProfile,
      ...(input.manualObserveAutoAllow ? { manualObserveAutoAllow: true } : {}),
    });

    let minted: MintedMcpToken | null = null;
    try {
      // Direct post-Gate launches (including ticket renewal/recovery) have no
      // external issuer. DSH pickups and local workspace leases keep their
      // existing narrower policy; the local bridge lists account tools itself.
      // A read-only scope's policy names its share and no group but workspace.
      if (!input.connectionBound) minted = mintMcpToken(this.options.store, {
        username: input.owner,
        label: `Session ${input.operationId.slice(0, 12)}`,
        ttlMs,
        policy: input.permissionProfile === "read_only"
          ? mcpDocAssistantPolicy({
            operationId: input.operationId,
            device: input.executionDevice,
            workspaceId: input.workspaceId,
            docShare: input.docShare!,
          })
          : mcpSessionExecutionPolicy({
            operationId: input.operationId,
            runtimeDevice: input.runtimeDevice,
            executionDevice: input.executionDevice,
            workspaceId: input.workspaceId,
            permissionProfile: input.permissionProfile,
          }, { accountTools: input.issuer === undefined && !input.connectionBound }),
        now,
      });
    } catch (error) {
      void this.options.workspaceFilesService.closeScope(scopeId).catch(() => undefined);
      executionGrant?.destroy();
      workspaceGrant.destroy();
      throw error;
    }
    const tokenHash = minted?.row.token_hash ?? randomBytes(32).toString("hex");
    const credential = mcpCredentialOf(tokenHash);
    // Use the durable row's exact boundary. Calling the clock again here can
    // otherwise make the live capability outlast its bearer by a millisecond.
    const expiresAt = minted ? Date.parse(String(minted.row.expires_at)) : Number.POSITIVE_INFINITY;
    const timer = minted ? setTimeout(() => this.releaseCredential(credential), ttlMs) : null;
    timer?.unref?.();
    this.scopes.set(credential, {
      owner: input.owner,
      runtimeOwner,
      runtimeResourceId,
      operationId: input.operationId,
      credential,
      token: minted?.token ?? "",
      tokenHash,
      durable: minted !== null,
      workspace,
      workspaceGrant,
      executionGrant,
      runtimeDevice: input.runtimeDevice,
      executionDevice: input.executionDevice,
      workspaceId: input.workspaceId,
      permissionProfile: input.permissionProfile,
      docShare: input.docShare ?? null,
      expiresAt,
      ...(input.issuer ? { issuer: input.issuer } : {}),
      timer,
    });
    return {
      credential,
      token: minted?.token ?? "",
      endpoint: mcpRegistration(this.options.publicUrl, this.options.dashboardPort).endpoint,
      expiresAt,
      bindSession: (source, sessionId) => this.bindSession(credential, source, sessionId),
      release: () => this.releaseCredential(credential),
    };
  }

  /**
   * The live grants and workspace port behind one scope, for a new scope and
   * for one restored after boot alike, so the two cannot drift apart. A
   * read-only scope holds the three workspace reads, all silently allowed, no
   * command grant, and a backend with no write path at all (without
   * `replaceText` a backend is read-only; see `workspace-files/types.ts`).
   */
  private openScopeAuthority(input: {
    owner: string;
    operationId: string;
    executionDevice: string;
    workspaceId: string;
    profile: SessionExecutionProfile;
    manualObserveAutoAllow?: boolean;
  }): { workspace: WorkspaceFilesScopePort; workspaceGrant: WorkspaceFilesGrant; executionGrant: ExecutionWorkspaceGrant | null; scopeId: string } {
    const readOnly = input.profile === "read_only";
    const autoAllow = readOnly ? READ_ONLY_OPS
      : input.profile === "full_access"
        ? SESSION_WORKSPACE_OPERATIONS
        : input.manualObserveAutoAllow ? READ_ONLY_OPS : [];
    const workspaceGrant = this.options.workspaceCapabilities.open({
      username: input.owner,
      purpose: `Session execution · ${input.operationId}`,
      kind: "agent-run",
      rights: readOnly ? READ_ONLY_OPS : SESSION_WORKSPACE_OPERATIONS,
      autoAllow,
      metadata: { surface: "session-execution", operation: input.operationId },
      device: input.executionDevice,
    });
    if (!workspaceGrant) throw new Error("无法派生远程工作区文件权限");
    let executionGrant: ExecutionWorkspaceGrant | null = null;
    if (!readOnly) {
      executionGrant = this.options.executionCapabilities.open({
        username: input.owner,
        purpose: `Session execution · ${input.operationId}`,
        autoAllow: input.profile === "full_access" ? [RUN_WORKSPACE_COMMAND] : [],
        metadata: { surface: "session-execution", operation: input.operationId },
        device: input.executionDevice,
      });
      if (!executionGrant) {
        workspaceGrant.destroy();
        throw new Error("无法派生远程命令权限");
      }
    }

    const scopeId = JSON.stringify(["session-execution", input.owner, input.operationId]);
    const runnerBackend = new RunnerWorkspaceFilesBackend(new GrantWorkspaceFilesAuthority({
      grant: workspaceGrant,
      devices: () => [{ device: input.executionDevice, label: input.executionDevice }],
    }));
    const backend: WorkspaceFilesBackend = {
      async listRoots() {
        const roots = await runnerBackend.listRoots();
        if (!roots.ok) return roots;
        const selected = roots.value.filter((root) =>
          root.binding.device === input.executionDevice
          && root.binding.workspaceId === input.workspaceId);
        return selected.length
          ? { ok: true, value: selected }
          : { ok: false, code: "not_found", message: "绑定的执行工作区已经不可用" };
      },
      listEntries: runnerBackend.listEntries.bind(runnerBackend),
      readText: runnerBackend.readText.bind(runnerBackend),
      ...(readOnly ? {} : {
        replaceText: runnerBackend.replaceText.bind(runnerBackend),
        // A save past one call's window is staged through the same operation.
        stageText: runnerBackend.stageText.bind(runnerBackend),
        commitStagedText: runnerBackend.commitStagedText.bind(runnerBackend),
      }),
    };
    try {
      const workspace = this.options.workspaceFilesService.open({
        scope: scopeId,
        owner: input.owner,
        backend,
        writable: !readOnly,
        contract: WORKSPACE_FILES_CONTRACT_V2,
      });
      return { workspace, workspaceGrant, executionGrant, scopeId };
    } catch (error) {
      executionGrant?.destroy();
      workspaceGrant.destroy();
      throw error;
    }
  }

  // ── on-demand issue for the owner's OWN device (ExecutionScopeIssuerPort) ──

  /**
   * The devices an owner could open a scope on right now, with the registered
   * workspaces each reports. Presence and inventory are gateway-local facts;
   * the workspace roster is one `list_session_workspaces` per capable device
   * through a pooled, observe-only workspace grant.
   */
  async listTargets(owner: string, excludeDevice?: string): Promise<ExecutionScopeTarget[]> {
    const devices = this.capableDevices(owner).filter((target) => target.device !== excludeDevice);
    if (devices.length === 0) return [];
    return await this.withTargetsAuthority(owner, devices.map((device) => device.device), async (listWorkspaces) =>
      await Promise.all(devices.map(async (device) => {
        const listed = await listWorkspaces(device.device);
        // An empty list would read as "this device has no workspace"; say why instead.
        return listed.ok
          ? { ...device, workspaces: listed.workspaces.map(({ workspace_id, label }) => ({ workspace_id, label })) }
          : { ...device, workspaces: [], workspaces_unavailable: listed.reason };
      })));
  }

  /** The workspace a caller that named none is bound to: the device's Home. */
  async defaultWorkspace(owner: string, device: string): Promise<string> {
    const listed = await this.deviceWorkspaces(owner, device);
    if (!listed.ok) throw new Error(listed.reason);
    const workspaceId = defaultTargetWorkspace(listed.workspaces);
    if (!workspaceId) throw new Error(`设备 ${device} 没有 Home 工作区；请从 octopus_list_execution_targets 选一个 workspace_id`);
    return workspaceId;
  }

  /**
   * The registered workspaces one capable device of the owner reports, with
   * their display paths: for a caller that must tell the Home workspace (the
   * scan home, `~`) apart from a project.
   */
  async deviceWorkspaces(owner: string, device: string): Promise<{ ok: true; workspaces: TargetWorkspace[] } | { ok: false; reason: string }> {
    if (!this.capableDevices(owner).some((target) => target.device === device)) {
      return { ok: false, reason: `设备 ${device} 不在线、不属于你，或没有报告 shell 与 workspace-files 能力` };
    }
    return await this.withTargetsAuthority(owner, [device], async (listWorkspaces) => await listWorkspaces(device));
  }

  /**
   * Presence and inventory are gateway-local facts; the workspace roster is one
   * `list_session_workspaces` per device through a pooled, observe-only grant,
   * each bounded by TARGET_WORKSPACES_BUDGET_MS.
   */
  private async withTargetsAuthority<T>(
    owner: string,
    devices: readonly string[],
    use: (listWorkspaces: (device: string) => Promise<
      { ok: true; workspaces: TargetWorkspace[] } | { ok: false; reason: string }>) => Promise<T>,
  ): Promise<T> {
    const grant = this.options.workspaceCapabilities.open({
      username: owner,
      purpose: "Execution scope · targets",
      kind: "session",
      rights: ["list_session_workspaces"],
      autoAllow: ["list_session_workspaces"],
      metadata: { surface: "execution-scope" },
      pool: "execution-scope:targets",
    });
    if (!grant) return await use(async () => ({ ok: false, reason: "工作区列表服务暂不可用。" }));
    const authority = new GrantWorkspaceFilesAuthority({
      grant,
      devices: () => devices.map((device) => ({ device, label: device })),
    });
    try {
      return await use(async (device) => {
        let timer: NodeJS.Timeout | undefined;
        const silent = new Promise<"silent">((resolve) => { timer = setTimeout(() => resolve("silent"), TARGET_WORKSPACES_BUDGET_MS); });
        const outcome = await Promise.race([
          authority.call(device, "list_session_workspaces", { device }).catch(() => ({ status: "failed" as const })),
          silent,
        ]).finally(() => clearTimeout(timer));
        if (outcome === "silent") {
          return { ok: false, reason: `设备暂不响应：${TARGET_WORKSPACES_BUDGET_MS / 1000} 秒内没有返回工作区列表，稍后重试。` };
        }
        if (outcome.status === "approval_required") return { ok: false, reason: "读取这台设备的工作区列表需要设备主人先批准。" };
        if (outcome.status === "denied") return { ok: false, reason: "当前授权不允许读取这台设备的工作区列表。" };
        if (outcome.status !== "succeeded") return { ok: false, reason: "设备暂不响应，没有返回工作区列表，稍后重试。" };
        const snapshot = readWorkspaceDirectorySnapshot(outcome.result, device);
        if (!snapshot) return { ok: false, reason: "设备返回了无法识别的工作区列表。" };
        return { ok: true, workspaces: snapshot.roots.map((root) => ({
          workspace_id: root.workspaceId, label: root.label, ...(root.display ? { display: root.display } : {}),
        })) };
      });
    } finally {
      grant.close();
    }
  }

  /**
   * Mint a scope for the owner's own device + workspace, verify the workspace
   * is really registered there, and park the credential behind a one-time
   * pickup handle. Only the handle leaves this method: the Gate that called it
   * may persist the answer on a pending row.
   */
  async open(input: {
    owner: string;
    issuer: string;
    device: string;
    workspaceId: string;
    permissionProfile: ExecutionScopePermissionProfile;
    runtime: string;
    ttlMs: number;
  }): Promise<ExecutionScopePickup> {
    const issuer = input.issuer.trim();
    if (!issuer) throw new Error("执行作用域必须由一个具名凭证签发");
    const target = this.capableDevices(input.owner).find((device) => device.device === input.device);
    if (!target) throw new Error(`设备 ${input.device} 不在线、不属于你，或没有报告 shell 与 workspace-files 能力`);
    const operationId = `scope_${randomBytes(8).toString("hex")}`;
    const credential = this.issue({
      owner: input.owner,
      operationId,
      runtimeDevice: input.runtime,
      executionDevice: input.device,
      workspaceId: input.workspaceId,
      permissionProfile: input.permissionProfile,
      ttlMs: input.ttlMs,
      issuer,
    });
    const scope = this.scopes.get(mcpCredentialOf(hashRunnerToken(credential.token)));
    if (!scope) {
      credential.release();
      throw new Error("执行作用域未能登记");
    }
    const roots = await scope.workspace.refreshRoots();
    if (!roots.ok || roots.value.roots.length === 0) {
      credential.release();
      throw new Error(`工作区 ${input.workspaceId} 没有登记在设备 ${input.device} 上`);
    }
    const pickup = `pick_${randomBytes(16).toString("hex")}`;
    const now = (this.options.now ?? Date.now)();
    const timer = setTimeout(() => this.expirePickup(pickup), PICKUP_TTL_MS);
    timer.unref?.();
    this.pickups.set(pickup, {
      owner: input.owner,
      issuer,
      credential: scope.credential,
      expiresAt: now + PICKUP_TTL_MS,
      timer,
    });
    return {
      pickup,
      operation_id: operationId,
      device: input.device,
      workspace_id: input.workspaceId,
      permission_profile: input.permissionProfile,
      expires_at: credential.expiresAt,
    };
  }

  /**
   * Open a connection-bound scope for the MCP server embedded in a Runner.
   * No bearer credential or wall-clock lease is minted: the authenticated
   * connection owns the scope and supplies the in-process McpSurface principal.
   */
  async openLocalAgent(request: {
    owner: string;
    runtimeDevice: string;
    executionDevice: string;
    /** Omitted: the execution device's Home workspace. */
    workspaceId?: string;
    permissionProfile: ExecutionScopePermissionProfile;
  }): Promise<LocalAgentExecutionScope> {
    const target = this.capableDevices(request.owner)
      .find((device) => device.device === request.executionDevice);
    if (!target) {
      throw new Error(`设备 ${request.executionDevice} 不在线、不属于你，或没有报告 shell 与 workspace-files 能力`);
    }
    const input = {
      ...request,
      workspaceId: request.workspaceId ?? await this.defaultWorkspace(request.owner, request.executionDevice),
    };
    const operationId = `local_${randomBytes(8).toString("hex")}`;
    const issued = this.issue({
      owner: input.owner,
      operationId,
      runtimeDevice: input.runtimeDevice,
      executionDevice: input.executionDevice,
      workspaceId: input.workspaceId,
      permissionProfile: input.permissionProfile,
      issuer: `runner:${input.runtimeDevice}`,
      manualObserveAutoAllow: true,
      connectionBound: true,
    });
    const credential = issued.credential;
    const scope = this.scopes.get(credential);
    if (!scope) {
      issued.release();
      throw new Error("本地 Agent 执行作用域未能登记");
    }
    let roots: Awaited<ReturnType<WorkspaceFilesScopePort["refreshRoots"]>>;
    try { roots = await scope.workspace.refreshRoots(); }
    catch (error) { issued.release(); throw error; }
    if (this.scopes.get(credential) !== scope || !roots.ok || roots.value.roots.length === 0) {
      issued.release();
      throw new Error(`工作区 ${input.workspaceId} 没有登记在设备 ${input.executionDevice} 上`);
    }
    return {
      principal: {
        owner: input.owner,
        credential,
        policy: mcpSessionExecutionPolicy({
          operationId,
          runtimeDevice: input.runtimeDevice,
          executionDevice: input.executionDevice,
          workspaceId: input.workspaceId,
          permissionProfile: input.permissionProfile,
        }),
      },
      workspaceId: input.workspaceId,
      isActive: () => this.scopes.get(credential) === scope,
      close: issued.release,
    };
  }

  /** Redeem a pickup exactly once, for the same owner and issuing credential. */
  redeem(pickup: string, principal: McpPrincipal): SessionExecutionIssued | null {
    const pending = this.pickups.get(pickup);
    if (!pending) return null;
    const now = (this.options.now ?? Date.now)();
    if (pending.expiresAt <= now) {
      this.expirePickup(pickup);
      return null;
    }
    if (pending.owner !== principal.owner || pending.issuer !== principal.credential) return null;
    this.pickups.delete(pickup);
    clearTimeout(pending.timer);
    const scope = this.scopes.get(pending.credential);
    if (!scope || scope.expiresAt <= now || scope.permissionProfile === "read_only") return null;
    return {
      token: scope.token,
      endpoint: mcpRegistration(this.options.publicUrl, this.options.dashboardPort).endpoint,
      expires_at: scope.expiresAt,
      operation_id: scope.operationId,
      device: scope.executionDevice,
      workspace_id: scope.workspaceId,
      permission_profile: scope.permissionProfile,
    };
  }

  /** A pickup nobody collected: the scope it guarded dies with it. */
  private expirePickup(pickup: string): void {
    const pending = this.pickups.get(pickup);
    if (!pending) return;
    this.pickups.delete(pickup);
    clearTimeout(pending.timer);
    this.releaseCredential(pending.credential);
  }

  private capableDevices(owner: string): Array<Omit<ExecutionScopeTarget, "workspaces">> {
    const rows = this.options.devices?.(owner) ?? [];
    return rows
      .filter((row) => row.online && row.inventory?.execution.shell && row.inventory.execution.workspace_files)
      .map((row) => ({
        device: row.device,
        online: true,
        shell: true,
        workspace_files: true,
      }));
  }

  resolve(principal: McpPrincipal): SessionExecutionScope | null {
    const policy = principal.policy?.sessionExecution;
    const scope = this.scopes.get(principal.credential);
    const now = (this.options.now ?? Date.now)();
    if (
      !policy || !scope || scope.owner !== principal.owner || scope.expiresAt <= now
      || scope.operationId !== policy.operationId
      || scope.executionDevice !== policy.executionDevice
      || scope.workspaceId !== policy.workspaceId
      // The flavour is part of the identity: a token never resolves to a
      // scope of another profile, or of another assistant's share.
      || scope.permissionProfile !== policy.permissionProfile
      || scope.docShare !== (policy.docShare ?? null)
    ) return null;
    return scope;
  }

  /**
   * The document share a live read-only scope reaches, and where it reads:
   * how the document-share service checks, on its own, that an assistant
   * caller is bound to a share and still runs against the card's project.
   */
  docShareScope(owner: string, credential: string): { docShare: string; device: string; workspaceId: string } | null {
    const scope = this.scopes.get(credential);
    if (!scope || scope.owner !== owner || scope.permissionProfile !== "read_only" || !scope.docShare
      || scope.expiresAt <= (this.options.now ?? Date.now)()) return null;
    return { docShare: scope.docShare, device: scope.executionDevice, workspaceId: scope.workspaceId };
  }

  /** A read receipt can bind an already-issued launch, never mint new authority. */
  bindObservedLaunch(input: {
    owner: string; runtimeDevice: string; operationId: string; source: string; sessionId: string;
  }): boolean {
    const scope = [...this.scopes.values()].find((row) => row.owner === input.owner
      && row.runtimeDevice === input.runtimeDevice && row.operationId === input.operationId);
    if (!scope || !scope.token || scope.expiresAt <= (this.options.now ?? Date.now)()) return false;
    if (scope.sessionId && (scope.sessionId !== input.sessionId || scope.source !== input.source)) {
      throw new Error("启动回执与原执行会话身份不一致");
    }
    if (!scope.sessionId) this.bindSession(scope.credential, input.source, input.sessionId);
    return true;
  }

  /**
   * Fresh credentials for a session's own persisted placement (a ticket
   * binding, a Sessions+ launch catalog, or a document assistant), called only
   * after an append Gate. The placement can never change; a live scope for the
   * same operation is reused. A document assistant's session renews as its
   * read-only scope whatever the caller asked for, and only while it lives.
   */
  renewSession(input: {
    owner: string; runtimeDevice: string; executionDevice: string; workspaceId: string;
    operationId: string; source: string; sessionId: string; permissionProfile: SessionExecutionProfile;
  }): SessionExecutionDispatch {
    const assistant = this.options.assistantOf?.(input.owner, input.runtimeDevice, input.source, input.sessionId) ?? null;
    if (assistant && !assistant.live) throw new Error("这个文档助手已经结束，不能再续轮");
    if (!assistant && input.permissionProfile === "read_only") throw new Error("只读执行权限只续给登记的文档助手会话");
    const binding = this.options.store.getSessionExecutionBinding(
      input.owner, input.runtimeDevice, input.source, input.sessionId, "0000-01-01T00:00:00.000Z",
    ) ?? this.options.store.getSessionPlusSplitSession(input.owner, input.runtimeDevice, input.source, input.sessionId);
    if ((binding && (binding.runtime_owner !== input.owner || binding.runtime_resource_id
      || binding.execution_device !== input.executionDevice || binding.workspace_id !== input.workspaceId))
      || (assistant && (assistant.executionDevice !== input.executionDevice || input.runtimeDevice !== input.executionDevice
        || assistant.workspaceId !== input.workspaceId))) {
      throw new Error("续轮不能更换原会话的执行放置");
    }
    const key = sessionExecutionKey(input.owner, input.runtimeDevice, input.source, input.sessionId);
    const old = this.sessionCredentials.get(key);
    const previous = old ? this.scopes.get(old) : undefined;
    if (previous?.operationId === input.operationId) {
      const dispatch = this.dispatchForSession(input);
      if (dispatch) return dispatch;
    }
    const issued = this.issue({ ...input, ...(assistant
      ? { permissionProfile: "read_only" as const, docShare: assistant.docShare }
      : { permissionProfile: input.permissionProfile }) });
    try {
      if (old) this.releaseCredential(old);
      issued.bindSession(input.source, input.sessionId);
      const dispatch = this.dispatchForSession(input);
      if (!dispatch) throw new Error("续轮执行凭证未能绑定");
      return dispatch;
    } catch (error) {
      issued.release();
      throw error;
    }
  }

  dispatchForSession(input: {
    owner: string;
    runtimeDevice: string;
    source: string;
    sessionId: string;
  }): SessionExecutionDispatch | null {
    const key = sessionExecutionKey(input.owner, input.runtimeDevice, input.source, input.sessionId);
    const credential = this.sessionCredentials.get(key);
    let scope = credential ? this.scopes.get(credential) : undefined;
    const now = (this.options.now ?? Date.now)();
    if (!scope || scope.expiresAt <= now || scope.sessionKey !== key
      || !this.options.store.getActiveMcpTokenByHash(scope.tokenHash, new Date(now).toISOString())) {
      if (credential) this.releaseCredential(credential);
      return null;
    }
    // Restored scopes intentionally know only the token hash. Rotate a fresh
    // plaintext now, over this trusted dispatch path, instead of ever storing
    // the previous bearer in SQLite.
    if (!scope.token) {
      const rotated = this.rotateBinding(scope);
      if (!rotated) return null;
      scope = rotated;
    }
    return {
      token: scope.token,
      endpoint: mcpRegistration(this.options.publicUrl, this.options.dashboardPort).endpoint,
      expiresAt: scope.expiresAt,
      operationId: scope.operationId,
      executionDevice: scope.executionDevice,
      workspaceId: scope.workspaceId,
      runtimeOwner: scope.runtimeOwner,
      runtimeResourceId: scope.runtimeResourceId,
    };
  }

  /** Authenticated Runner restart asks for the exact session it already owns. */
  issueRecovery(input: {
    owner: string;
    runtimeDevice: string;
    source: string;
    sessionId: string;
  }): SessionExecutionDispatch | null {
    const now = (this.options.now ?? Date.now)();
    const binding = this.options.store.getSessionExecutionBinding(
      input.owner,
      input.runtimeDevice,
      input.source,
      input.sessionId,
      new Date(now).toISOString(),
    );
    if (!binding) return null;
    // An ended document assistant is not recovered, however long its row lasts.
    if (binding.permission_profile === "read_only"
      && !this.options.assistantOf?.(binding.owner, binding.runtime_device, binding.source, binding.session_id)?.live) return null;
    const credential = mcpCredentialOf(binding.token_hash);
    let scope = this.scopes.get(credential);
    if (!scope) {
      const token = this.options.store.getActiveMcpTokenByHash(binding.token_hash, new Date(now).toISOString());
      if (!token || !this.restoreBinding(binding, token)) return null;
      scope = this.scopes.get(credential);
    }
    const rotated = scope ? this.rotateBinding(scope) : null;
    if (!rotated?.token) return null;
    return {
      token: rotated.token,
      endpoint: mcpRegistration(this.options.publicUrl, this.options.dashboardPort).endpoint,
      expiresAt: rotated.expiresAt,
      operationId: rotated.operationId,
      executionDevice: rotated.executionDevice,
      workspaceId: rotated.workspaceId,
      runtimeOwner: rotated.runtimeOwner,
      runtimeResourceId: rotated.runtimeResourceId,
    };
  }

  private bindSession(credential: string, source: string, sessionId: string): void {
    const scope = this.scopes.get(credential);
    const cleanSource = source.trim();
    const cleanSessionId = sessionId.trim();
    if (
      !scope
      || !scope.token
      || (cleanSource !== "claude" && cleanSource !== "codex" && cleanSource !== "omp")
      || !cleanSessionId
      || cleanSessionId.length > 200
    ) {
      throw new Error("无法把执行凭证绑定到无效的 Agent 会话");
    }
    // Whatever path binds (launch, renewal, rotation, research): a document
    // assistant's session takes only its own live read-only scope, and a
    // read-only scope binds only to the session of the assistant it was for.
    const assistant = this.options.assistantOf?.(scope.owner, scope.runtimeDevice, cleanSource, cleanSessionId) ?? null;
    if (scope.permissionProfile === "read_only"
      ? !assistant?.live || assistant.docShare !== scope.docShare || assistant.workspaceId !== scope.workspaceId
        || assistant.executionDevice !== scope.executionDevice
      : assistant) {
      throw new Error("文档助手会话只能绑定它自己的只读执行权限");
    }
    const key = sessionExecutionKey(scope.owner, scope.runtimeDevice, cleanSource, cleanSessionId);
    const priorCredential = this.sessionCredentials.get(key);
    if (priorCredential && priorCredential !== credential) {
      throw new Error("这个 Agent 会话已经绑定到另一组执行权限");
    }
    scope.sessionKey = key;
    scope.source = cleanSource;
    scope.sessionId = cleanSessionId;
    this.sessionCredentials.set(key, credential);
    const now = new Date((this.options.now ?? Date.now)()).toISOString();
    const existingBinding = this.options.store.getSessionExecutionBinding(
      scope.owner,
      scope.runtimeDevice,
      cleanSource,
      cleanSessionId,
      "0000-01-01T00:00:00.000Z",
    );
    this.options.store.saveSessionExecutionBinding({
      owner: scope.owner,
      runtime_owner: scope.runtimeOwner,
      runtime_device: scope.runtimeDevice,
      runtime_resource_id: scope.runtimeResourceId,
      source: cleanSource,
      session_id: cleanSessionId,
      operation_id: scope.operationId,
      execution_device: scope.executionDevice,
      workspace_id: scope.workspaceId,
      permission_profile: scope.permissionProfile,
      doc_share_id: scope.docShare,
      token_hash: scope.tokenHash,
      expires_at: new Date(scope.expiresAt).toISOString(),
      created_at: existingBinding?.created_at ?? now,
      updated_at: now,
    });
  }

  private restoreBinding(binding: SessionExecutionBindingRow, token: McpTokenRow): boolean {
    const credential = mcpCredentialOf(binding.token_hash);
    if (this.scopes.has(credential)) return true;
    const expiresAt = Date.parse(binding.expires_at);
    const now = (this.options.now ?? Date.now)();
    if (
      !Number.isFinite(expiresAt)
      || expiresAt <= now
      || token.username !== binding.owner
      || token.expires_at !== binding.expires_at
      // A read-only row comes back only as the read-only scope it was, for its share.
      || (binding.permission_profile === "read_only") !== Boolean(binding.doc_share_id)
    ) return false;
    let authority: ReturnType<SessionExecutionRegistry["openScopeAuthority"]>;
    try {
      authority = this.openScopeAuthority({
        owner: binding.owner,
        operationId: binding.operation_id,
        executionDevice: binding.execution_device,
        workspaceId: binding.workspace_id,
        profile: binding.permission_profile,
      });
    } catch {
      return false;
    }
    const { workspace, workspaceGrant, executionGrant } = authority;
    const sessionKey = sessionExecutionKey(
      binding.owner,
      binding.runtime_device,
      binding.source,
      binding.session_id,
    );
    const timer = setTimeout(() => this.releaseCredential(credential), Math.max(1, expiresAt - now));
    timer.unref?.();
    this.scopes.set(credential, {
      owner: binding.owner,
      runtimeOwner: binding.runtime_owner,
      runtimeResourceId: binding.runtime_resource_id,
      operationId: binding.operation_id,
      credential,
      // Plaintext is intentionally unrecoverable from SQLite. Existing
      // clients present it; a future dispatch rotates a newly minted token.
      token: "",
      tokenHash: binding.token_hash,
      durable: true,
      workspace,
      workspaceGrant,
      executionGrant,
      runtimeDevice: binding.runtime_device,
      executionDevice: binding.execution_device,
      workspaceId: binding.workspace_id,
      permissionProfile: binding.permission_profile,
      docShare: binding.doc_share_id ?? null,
      expiresAt,
      sessionKey,
      source: binding.source,
      sessionId: binding.session_id,
      timer,
    });
    this.sessionCredentials.set(sessionKey, credential);
    return true;
  }

  private rotateBinding(scope: SessionExecutionScope): SessionExecutionScope | null {
    if (!scope.source || !scope.sessionId || !scope.sessionKey) return null;
    const now = (this.options.now ?? Date.now)();
    const remaining = scope.expiresAt - now;
    if (remaining < 60_000) return null;
    // Revocation in durable storage wins even before its local teardown arrives.
    // A cached live grant must never mint a replacement for a revoked token.
    if (!this.options.store.getActiveMcpTokenByHash(scope.tokenHash, new Date(now).toISOString())) {
      this.releaseCredential(scope.credential);
      return null;
    }
    const operationId = `${scope.operationId}:r:${randomBytes(4).toString("hex")}`.slice(0, 128);
    let issued: SessionExecutionCredential | null = null;
    try {
      issued = this.issue({
        owner: scope.owner,
        runtimeOwner: scope.runtimeOwner,
        runtimeResourceId: scope.runtimeResourceId,
        operationId,
        runtimeDevice: scope.runtimeDevice,
        executionDevice: scope.executionDevice,
        workspaceId: scope.workspaceId,
        permissionProfile: scope.permissionProfile,
        ...(scope.docShare ? { docShare: scope.docShare } : {}),
        ttlMs: remaining,
      });
      const oldCredential = scope.credential;
      this.releaseScope(oldCredential, true);
      issued.bindSession(scope.source, scope.sessionId);
      return this.scopes.get(mcpCredentialOf(hashRunnerToken(issued.token))) ?? null;
    } catch {
      issued?.release();
      return null;
    }
  }

  /**
   * Authenticate one Runner-to-Runner exec relay hop against the same live
   * scope that backs this launch's MCP surface.
   *
   * A durable token row alone is insufficient: after restart no scope exists,
   * so the relay remains closed even if the row has not reached its TTL.
   */
  authorizeRelay(request: RunnerExecutionRelayRequest): boolean {
    if (!CODEX_EXEC_RELAY_METHODS.has(request.method)) return false;
    if (!request.token.startsWith("mcp_")) return false;
    const tokenHash = hashRunnerToken(request.token);
    const now = (this.options.now ?? Date.now)();
    const row = this.options.store.getActiveMcpTokenByHash(tokenHash, new Date(now).toISOString());
    if (!row || row.username !== request.owner) return false;
    try {
      const policy = decodeMcpTokenPolicy(row.policy_json);
      if (!policy?.sessionExecution) return false;
      const scope = this.resolve({
        owner: row.username,
        credential: mcpCredentialOf(tokenHash),
        policy,
      });
      return Boolean(
        scope
        // A document assistant is Claude without commands: no Codex relay.
        && scope.permissionProfile !== "read_only"
        && scope.runtimeDevice === request.runtimeDevice
        && scope.executionDevice === request.executionDevice
        && scope.workspaceId === request.workspaceId,
      );
    } catch {
      return false;
    }
  }

  async runCommand(
    principal: McpPrincipal,
    args: Readonly<Record<string, unknown>>,
  ): Promise<McpToolOutcome> {
    const scope = this.resolve(principal);
    if (!scope) return { ok: false, code: "no_authority", message: "这个会话执行凭证已过期或不再存活" };
    if (!scope.executionGrant) return { ok: false, code: "no_authority", message: "这个会话执行凭证是只读的，不能运行命令" };
    const result = await scope.executionGrant.request(RUN_WORKSPACE_COMMAND, {
      device: scope.executionDevice,
      workspace_id: scope.workspaceId,
      command: args.command,
      ...(args.timeout_ms === undefined ? {} : { timeout_ms: args.timeout_ms }),
    });
    if (result.status === "succeeded") return { ok: true, result: result.result };
    if (result.status === "approval_required") {
      return { ok: false, code: "approval_required", message: `命令等待人工批准：${result.pendingCallId}` };
    }
    return { ok: false, code: result.status, message: result.reason };
  }

  workspacePort(principal: McpPrincipal): WorkspaceFilesScopePort | null {
    return this.resolve(principal)?.workspace ?? null;
  }

  /**
   * End one credential: the scope it names, and — when it was an issuing
   * token — every scope it opened on demand. Revoking the opener must take its
   * children with it, or a revoked dsh would keep its remote hands.
   */
  releaseCredential(credential: string): void {
    for (const scope of [...this.scopes.values()]) {
      if (scope.issuer === credential) this.releaseScope(scope.credential, true);
    }
    this.releaseScope(credential, true);
  }

  private releaseScope(credential: string, revoke: boolean): void {
    const scope = this.scopes.get(credential);
    if (!scope) return;
    this.scopes.delete(credential);
    if (scope.sessionKey && this.sessionCredentials.get(scope.sessionKey) === credential) {
      this.sessionCredentials.delete(scope.sessionKey);
    }
    for (const [pickup, pending] of [...this.pickups]) {
      if (pending.credential !== credential) continue;
      this.pickups.delete(pickup);
      clearTimeout(pending.timer);
    }
    if (scope.timer) clearTimeout(scope.timer);
    if (revoke && scope.durable) {
      this.options.store.revokeMcpToken(scope.owner, scope.tokenHash, new Date().toISOString());
      if (scope.source && scope.sessionId) {
        this.options.store.deleteSessionExecutionBinding(
          scope.owner,
          scope.runtimeDevice,
          scope.source,
          scope.sessionId,
          scope.tokenHash,
        );
      }
    }
    void this.options.workspaceFilesService.closeScope(JSON.stringify([
      "session-execution",
      scope.owner,
      scope.operationId,
    ])).catch(() => undefined);
    scope.executionGrant?.destroy();
    scope.workspaceGrant.destroy();
    for (const listener of this.releaseListeners) listener(scope.owner, credential);
  }

  /**
   * A document assistant ended: every scope reaching its share goes now, with
   * its token and binding — the ones in memory, and every stored binding of
   * the share, restored or not, plaintext or not.
   */
  releaseDocShare(shareId: string): void {
    for (const scope of [...this.scopes.values()]) {
      if (scope.docShare === shareId) this.releaseScope(scope.credential, true);
    }
    for (const binding of this.options.store.listReadOnlySessionExecutionBindings(shareId)) this.dropBinding(binding);
  }

  /** A stored binding with no future: its token revoked, its row deleted. */
  private dropBinding(binding: SessionExecutionBindingRow): void {
    this.options.store.revokeMcpToken(binding.owner, binding.token_hash, new Date().toISOString());
    this.options.store.deleteSessionExecutionBinding(binding.owner, binding.runtime_device, binding.source, binding.session_id, binding.token_hash);
  }

  releaseOwner(owner: string): void {
    for (const scope of [...this.scopes.values()]) {
      if (scope.owner === owner) this.releaseScope(scope.credential, true);
    }
  }

  releaseDevice(owner: string, device: string): void {
    for (const scope of [...this.scopes.values()]) {
      if ((scope.owner === owner && scope.executionDevice === device)
        || (scope.runtimeOwner === owner && scope.runtimeDevice === device)) {
        this.releaseScope(scope.credential, true);
      }
    }
  }

  close(): void {
    // Bot shutdown drops live grants but preserves the short-lived credential
    // rows and bearer-free bindings. The next process restores them; explicit
    // owner/token revocation still takes the `revoke=true` paths above.
    for (const credential of [...this.scopes.keys()]) this.releaseScope(credential, false);
  }
}

function sessionExecutionKey(owner: string, runtimeDevice: string, source: string, sessionId: string): string {
  return JSON.stringify([owner, runtimeDevice, source, sessionId]);
}
