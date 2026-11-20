/**
 * The Feishu MCP Gateway — the only path from an Agent to Feishu (SEC-03).
 *
 *     Agent (holds no Feishu credential of any kind)
 *       -> feishu-gateway MCP server  (a loopback token, nothing else)
 *       -> CapabilityLoopback         (token -> one bound facade, no identity field)
 *       -> Capability Gate            (slot -> capability -> ancestry -> Object,
 *                                      then the mandatory policy)
 *       -> Credential Resolver        (server-side; picks the identity)
 *       -> lark-mcp / Feishu SDK      (an executor, not an authorizer)
 *
 * What this replaces: `AgentSession.buildMcpServers()` used to launch the
 * credential-bearing MCP inside the agent's own process tree, adding the user's
 * access token when one happened to exist. When one did not, the same server
 * still started — with the app id and secret — so a missing user authorisation
 * quietly became a call with tenant-wide authority. That is the confused deputy
 * this file exists to make unexpressible:
 *
 *  · identity is a property of the OPERATION (`credentialMode`), decided in a
 *    reviewed catalog, not inferred from a tool-name prefix;
 *  · the resolver has no fallback. Missing, expired or under-scoped user token
 *    means the call fails — it does not become a service-account call;
 *  · user identity and system identity are DIFFERENT OBJECTS with different
 *    principals, so "an agent borrowing the bot's identity" is not a check that
 *    could be forgotten, it is a capability nothing derives into an agent's
 *    Context.
 */

import { createHash } from "node:crypto";
import {
  CapabilityService,
  hashArgs,
  type BoundCapabilities,
  type ContextId,
  type ObjectDefinition,
  type Operation,
  type OperationSpec,
  type PolicyDecision,
  type PolicyInput,
} from "@claude-bot/capability-kernel";
import {
  canonicalizeFeishuOperationArgs,
  FEISHU_PRIVILEGED_OPERATIONS,
  FEISHU_PRIVILEGED_OPS,
  FEISHU_SYSTEM_OPERATIONS,
  FEISHU_SYSTEM_OPS,
  FEISHU_USER_AUTO_ALLOWABLE_OPS,
  FEISHU_USER_OPERATIONS,
  FEISHU_USER_OPS,
  CATALOGUED_TOOLS,
  FEISHU_FILE_MAX_BYTES,
  SEND_FILE_SOURCE_ARGS,
  type FeishuOperation,
  type FeishuReferenceKind,
} from "./catalog.js";
import type { FeishuToolBackend } from "./backend.js";
import { createLogger } from "../logger.js";

const log = createLogger("feishu-gateway");

/** The Context-local slot a user-identity Feishu grant lives in. */
export const FEISHU_SLOT = "feishu";
/** Explicit, per-user administrative/tenant authority. */
export const FEISHU_PRIVILEGED_SLOT = "feishu-privileged";
/** The slot the trusted control plane's system-identity grant lives in. */
export const FEISHU_SYSTEM_SLOT = "feishu-system";

/** The principal a Context must claim to touch the system Object at all. */
const SYSTEM_PRINCIPAL = "system:feishu-bot";
const OUTLINE_SLOT = "feishu-outline-sync";
const OUTLINE_WRITE = "doc_block_write";

interface OutlineWriteIntent {
  context: ContextId;
  owner: string;
  fingerprint: string;
  current: () => void;
  claimed: boolean;
}

/**
 * Where a credential comes from. Two functions, and no third that "falls back":
 * the absence of that function is the security property.
 */
export interface FeishuCredentialResolver {
  /**
   * The user's own OAuth token, refreshed server-side, or null. Null is a
   * final answer.
   */
  userToken(username: string): Promise<string | null>;
  /**
   * The scopes that token actually carries, or null for "this deployment
   * cannot prove them".
   *
   * NOT optional, and null is NOT "skip the check". The first version made
   * this an optional method and treated a missing answer as permission to
   * proceed — so the production resolver, which did not implement it, never
   * checked a scope, while the tests supplied one and passed. An operation
   * that declares scopes and cannot show them is refused (reconnecting in the
   * permission center records them again), because "we could not tell" and
   * "it is fine" are different answers and only one of them is safe.
   */
  userScopes(username: string): Promise<readonly string[] | null>;
  /** Whether the service account is configured at all. */
  serviceAccountAvailable?(): boolean;
}

export interface FeishuResourceUriIndex {
  canonicalize(
    value: string,
    expected: FeishuReferenceKind | readonly FeishuReferenceKind[],
  ): string;
}

/** A user token that is missing, expired or under-scoped. Never a fallback. */
export class FeishuIdentityUnavailable extends Error {
  constructor(
    readonly username: string,
    reason: string,
  ) {
    super(reason);
    this.name = "FeishuIdentityUnavailable";
  }
}

function specsOf(catalog: Record<string, FeishuOperation>): Record<string, OperationSpec> {
  const out: Record<string, OperationSpec> = {};
  for (const [name, entry] of Object.entries(catalog)) out[name] = entry.spec;
  return out;
}

function invalidPayloadReason(
  entry: FeishuOperation,
  args: Readonly<Record<string, unknown>>,
): string | null {
  try {
    entry.payload(args);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "参数无法映射到已审计的飞书工具";
  }
}

function approvalArgLine(key: string, value: unknown): string {
  if (key === "file_base64") return `${key}：[base64 ${String(value).length} 字符]`;
  return `${key}：${String(value).slice(0, 200)}`;
}

/**
 * The argument lines of an approval card. A by-reference file is ONE line —
 * where it is, how big, and the digest execution will check — so the card's
 * line budget never hides what is being approved.
 */
function approvalArgLines(args: Readonly<Record<string, unknown>>): string[] {
  const source = args.source_path !== undefined
    ? [`文件：${String(args.source_device)} · 工作区 ${String(args.source_workspace)} · ${String(args.source_path).slice(0, 300)}`
      + `（${String(args.file_size)} 字节，SHA-256 ${String(args.file_sha256).slice(0, 16)}…；执行时按这份内容核对）`]
    : [];
  const folded = new Set<string>(SEND_FILE_SOURCE_ARGS);
  return [
    ...source,
    ...Object.entries(args)
      .filter(([key, value]) => value !== undefined && value !== null && !(source.length && folded.has(key)))
      .slice(0, 6)
      .map(([key, value]) => approvalArgLine(key, value)),
  ];
}

/**
 * The approved bytes of a by-reference file: read in windows through the
 * owner's workspace authority, refused past Feishu's limit before holding
 * more, and checked against the size and SHA-256 the owner approved.
 */
async function approvedSourceBytes(binding: UserBinding, source: Record<string, unknown>): Promise<Buffer> {
  if (!binding.sourceFiles) throw new Error("这个 Octopus 没有接通工作区文件，无法按路径发送文件");
  const size = Number(source.size);
  const file = await binding.sourceFiles.read(binding.owner, String(source.device), String(source.workspace), String(source.path));
  if (file.size !== size) throw new Error(`文件在批准后已变化（现在 ${file.size} 字节，批准时 ${size} 字节），未发送`);
  if (file.size > FEISHU_FILE_MAX_BYTES) throw new Error("飞书只接收 1 字节到 30 MB 的文件（im/v1/files 的上限）");
  const hash = createHash("sha256");
  const parts: Buffer[] = [];
  let held = 0;
  for await (const part of file.chunks) {
    held += part.length;
    if (held > size) throw new Error("文件在批准后已变化，未发送");
    hash.update(part);
    parts.push(part);
  }
  if (held !== size || hash.digest("hex") !== source.sha256) throw new Error("文件内容与批准时的 SHA-256 不一致（批准后已改动），未发送");
  return Buffer.concat(parts, held);
}

interface UserBinding {
  /** Fixed at registration from the trusted user row. Never from arguments. */
  owner: string;
  resolver: FeishuCredentialResolver;
  backend: FeishuToolBackend;
  sourceFiles?: FeishuSourceFiles;
  /** Operations whose downstream tool the running backend actually offers. */
  runnable: () => ReadonlySet<string>;
  onIdentityUnavailable?: (username: string, operation: string, reason: string) => Promise<void> | void;
}

interface SystemBinding {
  resolver: FeishuCredentialResolver;
  backend: FeishuToolBackend;
  runnable: () => ReadonlySet<string>;
}

/**
 * Mandatory policy for a user-identity Feishu Object.
 *
 * Same three decisions as the Runner's, in the same order — evidence, then the
 * grant's own terms, then ask the owner — plus one thing this surface needs
 * that the Runner's does not: the card says which IDENTITY the call will use
 * and which resource it touches, because "as you" and "as the bot" are the
 * distinction the old design lost.
 */
function userPolicy(input: PolicyInput): PolicyDecision {
  const owner = input.object.metadata.owner ?? "";
  if (!owner) return { kind: "deny", reason: "feishu object has no bound owner" };
  const entry = FEISHU_USER_OPERATIONS[input.operation];
  if (!entry) return { kind: "deny", reason: `"${input.operation}" is not in the Feishu catalog` };
  if (entry.credentialMode !== "user_oauth") {
    // Belt and braces: a system-mode entry must never be reachable on the user
    // Object, whatever the operation tables come to look like.
    return { kind: "deny", reason: "this operation does not run as the user" };
  }
  const invalidPayload = invalidPayloadReason(entry, input.args);
  if (invalidPayload) return { kind: "deny", reason: `飞书参数无效：${invalidPayload}` };

  const a = input.approval;
  if (
    a
    && a.objectId === input.object.id
    && a.operation === input.operation
    && a.argsHash === input.argsHash
    && a.contextId === input.context.id
    && a.slot === input.slot
    && a.approver === owner
  ) {
    return { kind: "allow" };
  }

  if (input.terms.autoAllow.includes(input.operation)) return { kind: "allow" };

  const riskLabel = {
    read: "读取",
    write: "写入",
    "external-send": "向外发送",
    admin: "管理",
  }[entry.risk];
  const details = [
    `身份：以你自己的飞书账号（${owner}）`,
    `资源：${entry.resource}`,
    `动作类别：${riskLabel}`,
    `所需授权范围：${entry.scopes.join("、") || "（由飞书按具体命令核对）"}`,
    ...(entry.describe
      ? entry.describe(input.args)
      : Object.entries(input.args)
        .filter(([, v]) => v !== undefined && v !== null)
        .slice(0, 6)
        .map(([k, v]) => approvalArgLine(k, v))),
    `目录版本：${entry.operation}@${entry.version}`,
    `发起方：${input.context.metadata.purpose ?? input.context.kind}`,
    `参数指纹：${input.argsHash.slice(0, 16)}`,
  ];
  return {
    kind: "approval_required",
    summary: { title: `${entry.title} · ${owner}`, target: `${owner}/${entry.resource}`, details, allowedApprover: owner },
  };
}

/**
 * A privileged grant is always an owner decision, even for a read. The Object
 * is per user so approval and audit never rely on a username supplied over the
 * MCP wire; the principal is fixed by the control plane when it derives.
 */
function privilegedPolicy(input: PolicyInput): PolicyDecision {
  const owner = input.object.metadata.owner ?? "";
  if (!owner || input.context.metadata.principal !== `privileged-feishu:${owner}`) {
    return { kind: "deny", reason: "privileged Feishu authority is not available to this principal" };
  }
  const entry = FEISHU_PRIVILEGED_OPERATIONS[input.operation];
  if (!entry) return { kind: "deny", reason: `"${input.operation}" is not a privileged Feishu operation` };
  const invalidPayload = invalidPayloadReason(entry, input.args);
  if (invalidPayload) return { kind: "deny", reason: `飞书参数无效：${invalidPayload}` };
  const approval = input.approval;
  if (
    approval
    && approval.objectId === input.object.id
    && approval.operation === input.operation
    && approval.argsHash === input.argsHash
    && approval.contextId === input.context.id
    && approval.slot === input.slot
    && approval.approver === owner
  ) return { kind: "allow" };
  const identity = entry.credentialMode === "user_oauth"
    ? `用户 OAuth（${owner}）`
    : "租户应用 / 系统 Bot";
  return {
    kind: "approval_required",
    summary: {
      title: `特权飞书能力 · ${entry.title}`,
      target: `${owner}/${entry.resource}`,
      allowedApprover: owner,
      details: [
        `身份：${identity}`,
        `动作类别：${entry.risk === "external-send" ? "向外发送" : "管理"}`,
        `所需用户授权范围：${entry.scopes.join("、") || "（使用租户应用权限）"}`,
        ...approvalArgLines(input.args),
        `目录版本：${entry.operation}@${entry.version}`,
        `参数指纹：${input.argsHash.slice(0, 16)}`,
      ],
    },
  };
}

/**
 * Mandatory policy for the SYSTEM Object.
 *
 * The first check is the one that matters and it is not about the operation: a
 * Context that is not the trusted control plane's is refused outright. Holding
 * the capability is already impossible for an agent — nothing derives it into
 * an agent Context — so this is the second wall, not the first.
 */
function systemPolicy(input: PolicyInput): PolicyDecision {
  if (input.context.metadata.principal !== SYSTEM_PRINCIPAL) {
    return { kind: "deny", reason: "system:feishu-bot is not available to this principal" };
  }
  const entry = FEISHU_SYSTEM_OPERATIONS[input.operation];
  if (!entry) return { kind: "deny", reason: `"${input.operation}" is not a system Feishu operation` };
  return { kind: "allow" };
}

async function userAdapter(
  binding: UserBinding,
  operation: Operation,
  args: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const entry = FEISHU_USER_OPERATIONS[operation];
  if (!entry) throw new Error(`"${operation}" is not in the Feishu catalog`);
  if (!binding.runnable().has(operation)) {
    throw new Error(`飞书后端没有提供 "${entry.tool}"，该操作已停用`);
  }
  // The identity is chosen HERE, from the operation's declared mode, and there
  // is no branch that answers "no user token" with another credential.
  const token = await binding.resolver.userToken(binding.owner);
  if (!token) {
    const reason = `${binding.owner} 尚未完成飞书授权（或授权已过期）；请在权限中心重新连接飞书。系统身份不会代替你执行这次调用。`;
    await binding.onIdentityUnavailable?.(binding.owner, operation, reason);
    throw new FeishuIdentityUnavailable(binding.owner, reason);
  }
  if (entry.scopes.length) {
    const scopes = await binding.resolver.userScopes(binding.owner);
    if (!scopes) {
      // Unprovable is not the same as sufficient. Reconnecting in the
      // permission center records the granted scope string, so this state has
      // an exit that does not involve widening anything.
      const reason = "无法确认你的飞书授权包含这次调用需要的范围（授权记录里没有 scope，通常是在本次改动之前授权的）；"
        + "请在权限中心重新连接飞书。系统身份不会代替你执行这次调用。";
      await binding.onIdentityUnavailable?.(binding.owner, operation, reason);
      throw new FeishuIdentityUnavailable(binding.owner, reason);
    }
    const missing = entry.scopes.filter((s) => !scopes.includes(s));
    if (missing.length) {
      const reason = `你的飞书授权缺少这次调用需要的范围：${missing.join("、")}；请在权限中心重新授权并勾选它们。`;
      await binding.onIdentityUnavailable?.(binding.owner, operation, reason);
      throw new FeishuIdentityUnavailable(binding.owner, reason);
    }
  }
  return await binding.backend.call({
    tool: entry.tool,
    payload: entry.payload(args),
    credential: { mode: "user_oauth", token },
  });
}

async function privilegedAdapter(
  binding: UserBinding,
  operation: Operation,
  args: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const entry = FEISHU_PRIVILEGED_OPERATIONS[operation];
  if (!entry) throw new Error(`"${operation}" is not a privileged Feishu operation`);
  if (!binding.runnable().has(operation)) throw new Error(`飞书后端没有提供 "${entry.tool}"`);
  if (entry.credentialMode === "service_account") {
    if (binding.resolver.serviceAccountAvailable?.() === false) throw new Error("飞书租户应用身份未配置");
    const payload = entry.payload(args);
    // A by-reference file becomes bytes only here, after the owner's approval,
    // read under the owner's own workspace authority — never from arguments.
    if (payload.source && typeof payload.source === "object") {
      const { source, ...rest } = payload;
      return await binding.backend.call({ tool: entry.tool, payload: { ...rest, file_bytes: await approvedSourceBytes(binding, source as Record<string, unknown>) },
        credential: { mode: "service_account" } });
    }
    return await binding.backend.call({ tool: entry.tool, payload, credential: { mode: "service_account" } });
  }
  const token = await binding.resolver.userToken(binding.owner);
  if (!token) {
    const reason = `${binding.owner} 尚未完成飞书授权；特权调用不会回退到另一个身份。`;
    await binding.onIdentityUnavailable?.(binding.owner, operation, reason);
    throw new FeishuIdentityUnavailable(binding.owner, reason);
  }
  const scopes = await binding.resolver.userScopes(binding.owner);
  const missing = !scopes ? entry.scopes : entry.scopes.filter((scope) => !scopes.includes(scope));
  if (missing.length) {
    const reason = `你的飞书授权缺少特权调用需要的范围：${missing.join("、")}；请重新授权。`;
    await binding.onIdentityUnavailable?.(binding.owner, operation, reason);
    throw new FeishuIdentityUnavailable(binding.owner, reason);
  }
  return await binding.backend.call({
    tool: entry.tool,
    payload: entry.payload(args),
    credential: { mode: "user_oauth", token },
  });
}

async function systemAdapter(
  binding: SystemBinding,
  operation: Operation,
  args: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const entry = FEISHU_SYSTEM_OPERATIONS[operation];
  if (!entry) throw new Error(`"${operation}" is not a system Feishu operation`);
  if (!binding.runnable().has(operation)) throw new Error(`飞书后端没有提供 "${entry.tool}"`);
  return await binding.backend.call({
    tool: entry.tool,
    payload: entry.payload(args),
    credential: { mode: "service_account" },
  });
}

export class FeishuGrant {
  constructor(
    private svc: CapabilityService,
    readonly contextId: ContextId,
    readonly slot: string,
    readonly owner: string,
    private readonly normalizeArgs?: (operation: Operation, args: unknown) => unknown,
  ) {}

  get capabilities(): BoundCapabilities {
    const bound = this.svc.bind(this.contextId);
    if (!this.normalizeArgs) return bound;
    return {
      request: async (slot, operation, args) => {
        try {
          return await bound.request(slot, operation, this.normalizeArgs!(operation, args));
        } catch (error) {
          return {
            status: "denied",
            reason: error instanceof Error ? error.message : "飞书资源 URL 无法解析",
          };
        }
      },
      result: (pendingCallId) => bound.result(pendingCallId),
    };
  }

  close(): void {
    this.svc.destroyContext(this.contextId, { deferWhilePending: true });
  }

  destroy(): void {
    this.svc.destroyContext(this.contextId);
  }
}

/**
 * Reads a file the owner keeps in one of their registered workspaces, for a
 * by-reference `message_send_file_as_bot`. Composed from the owner's
 * read-only Workspace Files authority (the Feishu Docs image path's); the
 * device's Runner confines the read to the workspace's real path. Chunks are
 * pulled one window at a time and iteration throws if the file changes.
 */
export interface FeishuSourceFiles {
  read(owner: string, device: string, workspaceId: string, relativePath: string): Promise<{ size: number; chunks: AsyncIterable<Buffer> }>;
}

export interface FeishuCapabilitiesOptions {
  service: CapabilityService;
  resolver: FeishuCredentialResolver;
  backend: FeishuToolBackend;
  /** Absent: by-reference file sends fail with a message saying so. */
  sourceFiles?: FeishuSourceFiles;
  /** Trusted membership check: is this a registered user of this bot? */
  isUser: (username: string) => boolean;
  /** Owner-visible recovery hint; never an authorization decision or replay. */
  onIdentityUnavailable?: (username: string, operation: string, reason: string) => Promise<void> | void;
}

/**
 * Control plane for Feishu capabilities. One per process, constructed at boot
 * with the backend and the resolver, and never handed to agent code.
 */
export class FeishuCapabilities {
  /** Trusted, non-serializable task authority; it deliberately disappears on restart. */
  private readonly outlineWrites = new Map<ContextId, OutlineWriteIntent>();
  private readonly outlineDispatches = new WeakMap<object, OutlineWriteIntent>();
  /**
   * Operations whose downstream tool the backend actually offers.
   *
   * Empty until `verifyCatalog()` has answered. The first version started this
   * as the whole catalog and verified asynchronously at boot, so for the first
   * seconds of the process every catalogued operation was runnable on the word
   * of a check that had not happened — and a backend that turned out not to
   * offer a tool would have been discovered mid-call. Starting closed costs a
   * short window in which agents have no Feishu tools, which is the direction
   * an unverified claim should fail in.
   */
  private resourceIndex: FeishuResourceUriIndex | null = null;

  installResourceIndex(index: FeishuResourceUriIndex): () => void {
    if (this.resourceIndex && this.resourceIndex !== index) {
      throw new Error("a different Feishu resource URI index is already installed");
    }
    this.resourceIndex = index;
    return () => {
      if (this.resourceIndex === index) this.resourceIndex = null;
    };
  }

  private normalizeResourceArgs(operation: Operation, args: unknown): unknown {
    const entry = FEISHU_USER_OPERATIONS[operation] ?? FEISHU_PRIVILEGED_OPERATIONS[operation];
    if (!entry?.references) return args;
    if (!this.resourceIndex) throw new Error("飞书资源 URL 索引尚未组合，拒绝执行引用型工具");
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("飞书工具参数必须是对象");
    return canonicalizeFeishuOperationArgs(
      entry,
      args as Readonly<Record<string, unknown>>,
      (value, expected) => this.resourceIndex!.canonicalize(value, expected),
    );
  }
  private runnableOps = new Set<string>();
  private verified = false;

  constructor(private opts: FeishuCapabilitiesOptions) {}

  /**
   * Startup audit of the downstream server.
   *
   * Two directions, both reported:
   *  · tools the backend offers that the catalog does not list — never exposed
   *    and never forwardable, which is already true by construction; the report
   *    exists so a new tool is a decision somebody makes rather than a surface
   *    that appears;
   *  · catalogued operations whose tool the backend does NOT offer — disabled,
   *    so they deny instead of failing halfway through a call.
   */
  async verifyCatalog(): Promise<{ unclassified: string[]; missing: string[] }> {
    let offered: string[];
    try {
      offered = await this.opts.backend.listTools();
    } catch (err) {
      // Fail closed: an unverifiable backend runs nothing.
      this.runnableOps = new Set();
      this.verified = true;
      log.error({ err }, "Feishu backend tool listing failed; every catalogued operation is disabled");
      return { unclassified: [], missing: [...FEISHU_USER_OPS, ...FEISHU_PRIVILEGED_OPS, ...FEISHU_SYSTEM_OPS] };
    }
    const have = new Set(offered);
    const unclassified = offered.filter((t) => !CATALOGUED_TOOLS.includes(t)).sort();
    const runnable = new Set<string>();
    const missing: string[] = [];
    for (const [name, entry] of Object.entries({
      ...FEISHU_USER_OPERATIONS,
      ...FEISHU_PRIVILEGED_OPERATIONS,
      ...FEISHU_SYSTEM_OPERATIONS,
    })) {
      if (have.has(entry.tool)) runnable.add(name);
      else missing.push(name);
    }
    this.runnableOps = runnable;
    this.verified = true;
    if (unclassified.length) {
      log.warn(
        { count: unclassified.length, tools: unclassified.slice(0, 20) },
        "Feishu backend offers tools that are not in the gateway catalog; they are not exposed and not forwardable",
      );
    }
    if (missing.length) {
      log.error({ operations: missing }, "catalogued Feishu operations have no downstream tool; they are disabled");
    }
    return { unclassified, missing: missing.sort() };
  }

  /** Which catalogued operations can currently run. */
  runnable(): ReadonlySet<string> {
    return this.runnableOps;
  }

  get catalogVerified(): boolean {
    return this.verified;
  }

  /**
   * Does this user have a Feishu identity right now?
   *
   * Asked before an agent is given any Feishu tool, so "Alice never
   * authorised" produces an agent with no Feishu tools rather than an agent
   * holding tools that would each fail at the last step. The refusal is
   * enforced in the adapter regardless — this is the UX half of the same fact,
   * and it is also the half that keeps a useless tool list out of the model's
   * context.
   */
  async hasIdentity(username: string): Promise<boolean> {
    const name = String(username ?? "").trim();
    if (!name || !this.opts.isUser(name)) return false;
    try {
      return Boolean(await this.opts.resolver.userToken(name));
    } catch (err) {
      log.warn({ err, username: name }, "Feishu identity check failed; treating as absent");
      return false;
    }
  }

  /**
   * Versioned because the kernel persists an Object's operation list and
   * refuses to re-register an id whose list changed. v3 added the lark-cli
   * operations; a v2 root left in the store is never registered again, so it
   * denies, and `revokeUser` retires it with the other legacy ids.
   */
  private userObjectId(username: string): string {
    return `feishu-user-v3:${username}`;
  }

  private outlineObjectId(username: string): string {
    return `feishu-outline-sync-v1:${username}`;
  }

  private checkOutline(intent: OutlineWriteIntent): void {
    if (this.outlineWrites.get(intent.context) !== intent || !this.opts.isUser(intent.owner)
      || this.opts.service.objectIdOf(intent.context, OUTLINE_SLOT) !== this.outlineObjectId(intent.owner)
      || !this.opts.service.rightsOf(intent.context, OUTLINE_SLOT).includes(OUTLINE_WRITE))
      throw new Error("论文大纲同步的本次授权已释放或撤销");
    intent.current();
  }

  private ensureOutlineObject(owner: string): string {
    const id = this.outlineObjectId(owner);
    if (this.opts.service.hasObject(id)) return id;
    this.opts.service.registerObject({
      id, kind: "feishu-outline-sync", binding: { owner },
      metadata: { owner, principal: `outline-sync:${owner}`, credential_mode: "user_oauth" },
      operations: { [OUTLINE_WRITE]: FEISHU_USER_OPERATIONS[OUTLINE_WRITE].spec },
      policy: input => {
        const intent = this.outlineWrites.get(input.context.id);
        if (!intent || intent.claimed || intent.owner !== owner || input.slot !== OUTLINE_SLOT
          || input.operation !== OUTLINE_WRITE || input.argsHash !== intent.fingerprint)
          return { kind: "deny", reason: "没有与当前任务、参数匹配的一次性大纲同步授权" };
        this.checkOutline(intent);
        const decision = userPolicy(input);
        if (decision.kind !== "allow") return decision;
        intent.claimed = true;
        // Gate and ObjectRegistry pass the same validated args object to the adapter.
        // Object identity prevents concurrent identical writes from borrowing another guard.
        this.outlineDispatches.set(input.args, intent);
        return { kind: "allow" };
      },
      adapter: async (binding, operation, args) => {
        const intent = this.outlineDispatches.get(args);
        this.outlineDispatches.delete(args);
        if (!intent || binding.owner !== intent.owner || operation !== OUTLINE_WRITE || hashArgs(args) !== intent.fingerprint)
          throw new Error("大纲同步调用没有匹配的可信检查结果");
        const current = () => this.checkOutline(intent);
        current();
        const resolver: FeishuCredentialResolver = {
          userToken: async username => {
            current();
            if (username !== intent.owner) throw new Error("大纲同步身份不匹配");
            const token = await this.opts.resolver.userToken(username);
            current(); return token;
          },
          userScopes: async username => {
            current();
            if (username !== intent.owner) throw new Error("大纲同步身份不匹配");
            const scopes = await this.opts.resolver.userScopes(username);
            current(); return scopes;
          },
        };
        const backend: FeishuToolBackend = {
          call: async call => {
            current();
            if (call.credential.mode !== "user_oauth" || call.tool !== FEISHU_USER_OPERATIONS[OUTLINE_WRITE].tool)
              throw new Error("大纲同步只允许用户 OAuth 文档块写入");
            const result = await this.opts.backend.call(call);
            current(); return result;
          },
          listTools: async () => [FEISHU_USER_OPERATIONS[OUTLINE_WRITE].tool],
          stop() {},
        };
        return userAdapter({ owner: binding.owner, resolver, backend, runnable: () => this.runnableOps,
          onIdentityUnavailable: this.opts.onIdentityUnavailable }, operation, args);
      },
    });
    return id;
  }

  /** Trusted research service only. The guard is executable server authority, never a wire argument. */
  async approvedOutlineWrite(owner: string, args: Readonly<Record<string, unknown>>, current: () => void): Promise<unknown> {
    if (typeof current !== "function") throw new Error("大纲同步需要可信的当前任务授权检查");
    current();
    const name = String(owner ?? "").trim();
    if (!name || !this.opts.isUser(name) || !this.verified || !this.runnableOps.has(OUTLINE_WRITE))
      throw new Error("飞书账号或文档块写入能力尚未连接");
    const frozen = Object.freeze({ ...args }), fingerprint = hashArgs(frozen);
    const object = this.ensureOutlineObject(name);
    const context = this.opts.service.createContext("feishu-outline-sync-call", { owner: name, purpose: "按已授权任务同步明确的大纲块" });
    try {
      this.opts.service.mintRoot(context, OUTLINE_SLOT, object, [OUTLINE_WRITE], { autoAllow: [OUTLINE_WRITE] });
      const intent: OutlineWriteIntent = { context, owner: name, fingerprint, current, claimed: false };
      this.outlineWrites.set(context, intent);
      this.checkOutline(intent);
      const response = await this.opts.service.bind(context).request(OUTLINE_SLOT, OUTLINE_WRITE, frozen);
      this.checkOutline(intent);
      if (response.status !== "succeeded") throw new Error("reason" in response ? response.reason : "大纲同步未获得本次明确授权");
      return response.result;
    } finally {
      this.outlineWrites.delete(context);
      this.opts.service.destroyContext(context);
    }
  }

  private privilegedObjectId(username: string): string {
    return `feishu-privileged-v2:${username}`;
  }

  private legacyPrivilegedObjectId(username: string): string {
    return `feishu-privileged:${username}`;
  }

  private ensureUserObject(username: string): string | null {
    if (!this.opts.isUser(username)) return null;
    const id = this.userObjectId(username);
    if (!this.opts.service.hasObject(id)) {
      const def: ObjectDefinition<UserBinding> = {
        id,
        kind: "feishu-user",
        binding: {
          owner: username,
          resolver: this.opts.resolver,
          backend: this.opts.backend,
          runnable: () => this.runnableOps,
          onIdentityUnavailable: this.opts.onIdentityUnavailable,
        },
        metadata: { owner: username, principal: `user:${username}`, credential_mode: "user_oauth" },
        operations: specsOf(FEISHU_USER_OPERATIONS),
        policy: userPolicy,
        adapter: userAdapter as ObjectDefinition<UserBinding>["adapter"],
      };
      this.opts.service.registerObject(def);
    }
    return id;
  }

  private ensurePrivilegedObject(username: string): string | null {
    if (!this.opts.isUser(username)) return null;
    const id = this.privilegedObjectId(username);
    if (!this.opts.service.hasObject(id)) {
      const def: ObjectDefinition<UserBinding> = {
        id,
        kind: "feishu-privileged",
        binding: {
          owner: username,
          resolver: this.opts.resolver,
          backend: this.opts.backend,
          ...(this.opts.sourceFiles ? { sourceFiles: this.opts.sourceFiles } : {}),
          runnable: () => this.runnableOps,
          onIdentityUnavailable: this.opts.onIdentityUnavailable,
        },
        metadata: { owner: username, principal: `privileged-feishu:${username}`, credential_mode: "catalogued" },
        operations: specsOf(FEISHU_PRIVILEGED_OPERATIONS),
        policy: privilegedPolicy,
        adapter: privilegedAdapter as ObjectDefinition<UserBinding>["adapter"],
      };
      this.opts.service.registerObject(def);
    }
    return id;
  }

  private ensureSystemObject(): string {
    const id = "feishu-system:bot";
    if (!this.opts.service.hasObject(id)) {
      const def: ObjectDefinition<SystemBinding> = {
        id,
        kind: "feishu-system",
        binding: { resolver: this.opts.resolver, backend: this.opts.backend, runnable: () => this.runnableOps },
        metadata: { principal: SYSTEM_PRINCIPAL, credential_mode: "service_account" },
        operations: specsOf(FEISHU_SYSTEM_OPERATIONS),
        policy: systemPolicy,
        adapter: systemAdapter as ObjectDefinition<SystemBinding>["adapter"],
      };
      this.opts.service.registerObject(def);
    }
    return id;
  }

  /** The ONE root per user, found in the durable tables rather than a Map. */
  private authorityFor(username: string): ContextId | null {
    const name = String(username ?? "").trim();
    if (!name) return null;
    const objectId = this.ensureUserObject(name);
    if (!objectId) return null;
    const roots = this.opts.service.rootsOf(objectId).filter((r) => r.slot === FEISHU_SLOT);
    // The root's terms are the ceiling on what a grant may run unsupervised;
    // the owner's permission choices only narrow it. A root minted under a
    // narrower ceiling would silently keep asking, so it is replaced.
    const covers = (root: ContextId) => {
      const autoAllow = this.opts.service.termsOf(root, FEISHU_SLOT).autoAllow;
      return FEISHU_USER_AUTO_ALLOWABLE_OPS.every((operation) => autoAllow.includes(operation));
    };
    if (roots.length === 1 && covers(roots[0].contextId)) return roots[0].contextId;
    if (roots.length > 1) {
      log.error({ username: name, roots: roots.length }, "multiple live Feishu roots; revoking all");
      this.revokeUser(name);
    } else if (roots.length === 1) {
      this.opts.service.revoke(roots[0].contextId, FEISHU_SLOT);
      this.opts.service.destroyContext(roots[0].contextId);
    }
    const ctx = this.opts.service.createContext("feishu-authority", {
      owner: name,
      principal: `user:${name}`,
      purpose: "feishu account authority",
    });
    this.opts.service.mintRoot(ctx, FEISHU_SLOT, objectId, FEISHU_USER_OPS, { autoAllow: FEISHU_USER_AUTO_ALLOWABLE_OPS });
    return ctx;
  }

  private privilegedAuthorityFor(username: string): ContextId | null {
    const name = String(username ?? "").trim();
    if (!name) return null;
    const objectId = this.ensurePrivilegedObject(name);
    if (!objectId) return null;
    const roots = this.opts.service.rootsOf(objectId).filter((root) => root.slot === FEISHU_PRIVILEGED_SLOT);
    if (roots.length === 1) return roots[0].contextId;
    for (const root of roots) {
      this.opts.service.revoke(root.contextId, root.slot);
      this.opts.service.destroyContext(root.contextId);
    }
    const context = this.opts.service.createContext("feishu-privileged-authority", {
      owner: name,
      principal: `privileged-feishu:${name}`,
      purpose: "explicit Feishu privileged authority",
    });
    this.opts.service.mintRoot(context, FEISHU_PRIVILEGED_SLOT, objectId, FEISHU_PRIVILEGED_OPS);
    return context;
  }

  /**
   * Derive one agent turn's Feishu authority.
   *
   * Returns null when the user has no Feishu identity at all — which is a
   * refusal, not a reason to hand out something else. The caller's correct
   * response is to give the agent no Feishu tools, and a chat agent with no
   * tools cannot accidentally act as the tenant app.
   */
  open(o: {
    username: string;
    purpose: string;
    kind: "agent-run" | "controller-run" | "job" | "session";
    /**
     * What the caller applies for. REQUIRED, and an empty list is a valid
     * answer meaning "no Feishu tools". The product default is resolved by
     * `feishu/grants.ts` before this boundary; the capability constructor never
     * guesses or widens an omitted operation set.
     */
    rights: readonly Operation[];
    /** Which of those need no per-call approval. Default: none. */
    autoAllow?: readonly Operation[];
    metadata?: Record<string, string>;
  }): FeishuGrant | null {
    // An unverified backend grants nothing: `runnableOps` is empty until the
    // startup audit answers, and this says so rather than letting the empty
    // intersection below look like "the user applied for nothing".
    if (!this.verified) return null;
    const username = String(o.username ?? "").trim();
    const root = this.authorityFor(username);
    if (!root) return null;
    const available = new Set(this.opts.service.rightsOf(root, FEISHU_SLOT));
    const wanted = o.rights.filter((r) => available.has(r) && this.runnableOps.has(r));
    if (!wanted.length) return null;
    const ctx = this.opts.service.createContext(
      o.kind,
      // Caller metadata first, trusted fields last: `owner` decides who may
      // approve and `principal` is what the system policy checks, so neither
      // may be chosen by whoever asked for the grant.
      { ...(o.metadata ?? {}), owner: username, principal: `user:${username}`, purpose: o.purpose },
      root,
    );
    try {
      this.opts.service.derive(
        root,
        FEISHU_SLOT,
        ctx,
        FEISHU_SLOT,
        wanted,
        o.autoAllow ? { autoAllow: o.autoAllow.filter((r) => wanted.includes(r)) } : undefined,
      );
    } catch (err) {
      this.opts.service.destroyContext(ctx);
      log.warn({ err, username, purpose: o.purpose }, "Feishu capability derive refused");
      return null;
    }
    return new FeishuGrant(
      this.opts.service,
      ctx,
      FEISHU_SLOT,
      username,
      (operation, args) => this.normalizeResourceArgs(operation, args),
    );
  }

  /** Derive the exact privileged operations explicitly configured for one user. */
  openPrivileged(o: {
    username: string;
    purpose: string;
    kind: "agent-run" | "controller-run" | "job" | "session";
    rights: readonly Operation[];
    metadata?: Record<string, string>;
  }): FeishuGrant | null {
    if (!this.verified) return null;
    const username = String(o.username ?? "").trim();
    const root = this.privilegedAuthorityFor(username);
    if (!root) return null;
    const available = new Set(this.opts.service.rightsOf(root, FEISHU_PRIVILEGED_SLOT));
    const wanted = o.rights.filter((operation) => available.has(operation) && this.runnableOps.has(operation));
    if (!wanted.length) return null;
    const context = this.opts.service.createContext(
      o.kind,
      { ...(o.metadata ?? {}), owner: username, principal: `privileged-feishu:${username}`, purpose: o.purpose },
      root,
    );
    try {
      // Do not supply autoAllow. The mandatory policy above asks the owner even
      // if the kernel's root terms happen to classify a privileged read as safe.
      this.opts.service.derive(root, FEISHU_PRIVILEGED_SLOT, context, FEISHU_PRIVILEGED_SLOT, wanted);
    } catch (err) {
      this.opts.service.destroyContext(context);
      log.warn({ err, username, purpose: o.purpose }, "Feishu privileged derive refused");
      return null;
    }
    return new FeishuGrant(
      this.opts.service,
      context,
      FEISHU_PRIVILEGED_SLOT,
      username,
      (operation, args) => this.normalizeResourceArgs(operation, args),
    );
  }

  /**
   * The system identity, for the trusted control plane only.
   *
   * There is no request path that reaches this method, and the Context it
   * creates is the only one the system policy accepts. An ordinary Agent grant
   * (`open()` above) is on a different Object entirely, so "an agent asking for
   * a system operation" resolves to an operation its Object does not have.
   */
  openSystem(purpose: string): FeishuGrant | null {
    if (!this.verified) return null;
    if (this.opts.resolver.serviceAccountAvailable?.() === false) return null;
    const objectId = this.ensureSystemObject();
    const roots = this.opts.service.rootsOf(objectId).filter((r) => r.slot === FEISHU_SYSTEM_SLOT);
    let root = roots.length === 1 ? roots[0].contextId : null;
    if (!root) {
      for (const r of roots) this.opts.service.revoke(r.contextId, r.slot);
      root = this.opts.service.createContext("feishu-system-authority", {
        principal: SYSTEM_PRINCIPAL,
        purpose: "feishu system authority",
      });
      // The control plane's own calls are not queued for a human: there is no
      // human whose account they act on. The narrowness of the catalog is what
      // bounds them.
      this.opts.service.mintRoot(root, FEISHU_SYSTEM_SLOT, objectId, FEISHU_SYSTEM_OPS, {
        autoAllow: FEISHU_SYSTEM_OPS,
      });
    }
    const ctx = this.opts.service.createContext(
      "controller-run",
      { principal: SYSTEM_PRINCIPAL, purpose },
      root,
    );
    try {
      this.opts.service.derive(root, FEISHU_SYSTEM_SLOT, ctx, FEISHU_SYSTEM_SLOT, FEISHU_SYSTEM_OPS);
    } catch (err) {
      this.opts.service.destroyContext(ctx);
      log.warn({ err, purpose }, "Feishu system derive refused");
      return null;
    }
    return new FeishuGrant(this.opts.service, ctx, FEISHU_SYSTEM_SLOT, SYSTEM_PRINCIPAL);
  }

  /** Revoke a user's whole Feishu authority (OAuth revoked, user removed). */
  revokeUser(username: string): void {
    const name = String(username ?? "").trim();
    if (!name) return;
    for (const [context, intent] of this.outlineWrites)
      if (intent.owner === name) this.outlineWrites.delete(context);
    for (const objectId of [
      this.outlineObjectId(name),
      this.userObjectId(name),
      `feishu-user-v2:${name}`,
      `feishu-user:${name}`,
      this.privilegedObjectId(name),
      this.legacyPrivilegedObjectId(name),
    ]) {
      for (const root of this.opts.service.rootsOf(objectId)) {
        this.opts.service.revoke(root.contextId, root.slot);
        this.opts.service.destroyContext(root.contextId);
      }
    }
  }
}
