/**
 * On-demand issuance of a session-execution scope for the owner's OWN device
 * and registered workspace — the Gate half of "a personal harness (dsh) uses
 * Octopus as its remote file + command backend".
 *
 * ── Why this is its own capability Object ──────────────────────────────────
 *
 * Until now a session-execution credential (`SessionExecutionRegistry.issue`)
 * was minted only inside the `start_session` adapter, after THAT Gate allowed a
 * split placement. A harness that runs its own agent loop has no
 * `start_session`; it needs the same least-privilege, revocable scope without a
 * Runner-hosted agent. Re-using the Runner account Object for that would put a
 * credential-minting operation on the same root as machine control, and
 * `resource-bindings.md` asks for a new Object per backend resource instead —
 * independent root, grants, approval line and revocation.
 *
 * ── What crosses this Object, and what never does ──────────────────────────
 *
 * The adapter validates the request against trusted facts (device owned by the
 * caller, online, advertising shell + workspace-files; workspace registered on
 * that device) and mints the scope. It answers with a one-time PICKUP HANDLE,
 * never the plaintext token: a Gate result can be persisted on a pending row
 * for the caller to collect after an approval, and a durable row must never
 * hold a bearer credential. The MCP surface redeems the handle in memory,
 * exactly once, for the same owner and issuing credential.
 *
 * `issuer` is the credential handle of the token that asked. The surface
 * injects it server-side (the model cannot choose it), so the approval card,
 * the args hash and the pickup all name the same caller, and revoking that
 * token can cascade to every scope it opened.
 */
import {
  CapabilityService,
  type ContextId,
  type ObjectDefinition,
  type Operation,
  type OperationSpec,
  type PolicyDecision,
  type PolicyInput,
} from "@claude-bot/capability-kernel";
import { MACHINE_LIMITS } from "@claude-bot/runner/limits";
import { AccountAuthority, SlotGrant } from "../runner/account-authority.js";

export const EXECUTION_SCOPE_SLOT = "execution-scope";
export const EXECUTION_SCOPE_OBJECT_PREFIX = "execution-scope-issuer-v1";
export const OPEN_WORKSPACE_EXECUTION = "open_workspace_execution" as const;
export const LIST_EXECUTION_TARGETS = "list_execution_targets" as const;

/** Bounds on the credential a caller may ask for. The registry caps at 24h. */
export const EXECUTION_SCOPE_TTL_MINUTES = { min: 5, max: 24 * 60, default: 8 * 60 } as const;
export const EXECUTION_SCOPE_RUNTIME_MAX = 64;

export const EXECUTION_SCOPE_PERMISSION_PROFILES = ["full_access", "manual"] as const;
export type ExecutionScopePermissionProfile = typeof EXECUTION_SCOPE_PERMISSION_PROFILES[number];

export const EXECUTION_SCOPE_OPERATIONS: Record<string, OperationSpec> = {
  [LIST_EXECUTION_TARGETS]: {
    args: {},
    effect: "observe",
    title: "列出可签发执行作用域的设备与已登记工作区",
  },
  [OPEN_WORKSPACE_EXECUTION]: {
    args: {
      device: { type: "string", required: true, maxLength: MACHINE_LIMITS.deviceMaxBytes },
      workspace_id: { type: "string", required: true, maxLength: MACHINE_LIMITS.workspaceIdMaxBytes },
      permission_profile: { type: "string", required: true, enum: EXECUTION_SCOPE_PERMISSION_PROFILES },
      runtime: { type: "string", maxLength: EXECUTION_SCOPE_RUNTIME_MAX },
      ttl_minutes: {
        type: "number",
        integer: true,
        min: EXECUTION_SCOPE_TTL_MINUTES.min,
        max: EXECUTION_SCOPE_TTL_MINUTES.max,
      },
      /** Server-injected credential handle of the asking token. */
      issuer: { type: "string", required: true, maxLength: 64 },
    },
    effect: "execute",
    retrySafe: false,
    title: "为自己的设备与已登记工作区签发会话执行凭证",
  },
};

export interface ExecutionScopeTargetWorkspace {
  workspace_id: string;
  label: string;
}

export interface ExecutionScopeTarget {
  device: string;
  online: boolean;
  shell: boolean;
  workspace_files: boolean;
  workspaces: ExecutionScopeTargetWorkspace[];
  /** Why `workspaces` is empty when the device did not answer; absent when it did. */
  workspaces_unavailable?: string;
}

/** What the adapter answers for a successful issue. No token, ever. */
export interface ExecutionScopePickup {
  pickup: string;
  operation_id: string;
  device: string;
  workspace_id: string;
  permission_profile: ExecutionScopePermissionProfile;
  expires_at: number;
}

/** The trusted issuer the adapter is bound to. Implemented by the registry. */
export interface ExecutionScopeIssuerPort {
  listTargets(owner: string): Promise<ExecutionScopeTarget[]>;
  open(input: {
    owner: string;
    issuer: string;
    device: string;
    workspaceId: string;
    permissionProfile: ExecutionScopePermissionProfile;
    runtime: string;
    ttlMs: number;
  }): Promise<ExecutionScopePickup>;
}

interface IssuerBinding {
  owner: string;
  port: ExecutionScopeIssuerPort;
}

function scopePolicy(input: PolicyInput): PolicyDecision {
  const owner = input.object.metadata.owner ?? "";
  if (!owner) return { kind: "deny", reason: "execution-scope object has no bound owner" };
  const approval = input.approval;
  if (
    approval
    && approval.objectId === input.object.id
    && approval.operation === input.operation
    && approval.argsHash === input.argsHash
    && approval.contextId === input.context.id
    && approval.slot === input.slot
    && approval.approver === owner
  ) {
    return { kind: "allow" };
  }
  if (input.terms.autoAllow.includes(input.operation)) return { kind: "allow" };
  if (input.operation === LIST_EXECUTION_TARGETS) {
    return { kind: "deny", reason: "execution-scope target listing is observe-only and must be auto-allowed" };
  }
  const device = String(input.args.device ?? "");
  const ttl = Number(input.args.ttl_minutes ?? EXECUTION_SCOPE_TTL_MINUTES.default);
  return {
    kind: "approval_required",
    summary: {
      title: `签发远程执行凭证 · ${owner}/${device}`,
      target: `${owner}/${device}`,
      details: [
        `工作区：${String(input.args.workspace_id ?? "").slice(0, 64)}`,
        `权限档位：${String(input.args.permission_profile ?? "")}`,
        `有效期：${ttl} 分钟`,
        `调用方：${String(input.args.runtime ?? "dsh").slice(0, 64)}`,
      ],
      allowedApprover: owner,
    },
  };
}

async function scopeAdapter(
  binding: IssuerBinding,
  operation: Operation,
  args: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  if (operation === LIST_EXECUTION_TARGETS) {
    return { targets: await binding.port.listTargets(binding.owner) };
  }
  if (operation !== OPEN_WORKSPACE_EXECUTION) throw new Error("unknown execution-scope operation");
  const profile = String(args.permission_profile ?? "");
  if (!(EXECUTION_SCOPE_PERMISSION_PROFILES as readonly string[]).includes(profile)) {
    throw new Error("invalid permission profile");
  }
  const ttlMinutes = Number(args.ttl_minutes ?? EXECUTION_SCOPE_TTL_MINUTES.default);
  return await binding.port.open({
    owner: binding.owner,
    issuer: String(args.issuer ?? ""),
    device: String(args.device ?? "").trim(),
    workspaceId: String(args.workspace_id ?? "").trim(),
    permissionProfile: profile as ExecutionScopePermissionProfile,
    runtime: String(args.runtime ?? "dsh").trim() || "dsh",
    ttlMs: ttlMinutes * 60_000,
  });
}

export class ExecutionScopeGrant extends SlotGrant {
  constructor(service: CapabilityService, contextId: ContextId, purpose: string, owner: string, borrowed = false) {
    super(service, contextId, EXECUTION_SCOPE_SLOT, purpose, owner, borrowed);
  }
}

export interface ExecutionScopeCapabilitiesOptions {
  service: CapabilityService;
  port: ExecutionScopeIssuerPort;
  userExists(username: string): boolean;
  hasDevice(username: string): boolean;
  now?: () => number;
}

export class ExecutionScopeCapabilities {
  private readonly authority: AccountAuthority<IssuerBinding>;

  constructor(private readonly options: ExecutionScopeCapabilitiesOptions) {
    this.authority = new AccountAuthority<IssuerBinding>({
      service: options.service,
      slot: EXECUTION_SCOPE_SLOT,
      objectPrefix: EXECUTION_SCOPE_OBJECT_PREFIX,
      kind: "execution-scope-issuer",
      operations: EXECUTION_SCOPE_OPERATIONS,
      policy: scopePolicy,
      adapter: scopeAdapter as ObjectDefinition<IssuerBinding>["adapter"],
      now: options.now,
      // The root may let an owner-bound surface issue unsupervised; each
      // derived grant still has to ask for it, and the permission centre's
      // auto-allow term is what the MCP surface passes down.
      rootAutoAllow: () => Object.keys(EXECUTION_SCOPE_OPERATIONS),
      bindingFor: (username) => options.userExists(username) && options.hasDevice(username)
        ? { owner: username, port: options.port }
        : null,
    });
  }

  open(input: {
    username: string;
    purpose: string;
    rights: readonly Operation[];
    autoAllow?: readonly Operation[];
    metadata?: Record<string, string>;
    pool?: string;
  }): ExecutionScopeGrant | null {
    const username = String(input.username ?? "").trim();
    const derived = this.authority.derive({
      username,
      purpose: input.purpose,
      kind: "session",
      rights: input.rights,
      autoAllow: input.autoAllow,
      metadata: input.metadata,
      pool: input.pool,
    });
    return derived
      ? new ExecutionScopeGrant(this.options.service, derived.contextId, input.purpose, username, derived.borrowed)
      : null;
  }

  /** What this account's issuer root holds right now (empty without a device). */
  accountOperations(username: string): string[] {
    return this.authority.rightsOfAccount(username);
  }

  revokeAccount(username: string): void {
    this.authority.revokeAccount(username);
  }
}
