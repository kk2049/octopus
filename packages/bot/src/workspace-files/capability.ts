/**
 * The Workspace Files capability plane — `workspace-files-runner-v2:<owner>`.
 *
 * ── Why this is a second Object over the same laptops ──────────────────────
 *
 * The first cut of `workspace-files/v1` proved the Gate path by adding its two
 * reads to `RUNNER_OPERATIONS`, which forced the account Object's id from
 * `runner-account-v2` to `v3`. The bump itself was correct — the kernel persists
 * an Object's operation list as part of its identity — but the shape it implies
 * is not: every backend module that ever ships would push the account Object to
 * v4, v5, v6, and each of those invalidates every unrelated capability and every
 * pending approval card on every account.
 *
 * So the split is not tidiness. It is the difference between "adding a file
 * browser costs the person who is halfway through approving an `exec`" and
 * "adding a file browser costs nothing that is not a file browser":
 *
 *   runner-account-v2:<owner>            unchanged closed set, unchanged identity
 *   workspace-files-runner-v2:<owner>    this file's table, versioned alone
 *
 * ── v1 → v2 (2026-08-07): what a bump costs, and why here ──────────────────
 *
 * `replace_workspace_text` joined the table, so the id moved. The kernel
 * persists an Object's sorted operation list as part of its identity and
 * `putObject` REFUSES a differing one — adding an operation under the old id is
 * not a thing that quietly works, it is a process that cannot register its own
 * Object. Even if it did register, `authorityFor` only re-mints a root when its
 * auto-allow terms change, and a `modify` operation does not change them: every
 * account with a persisted v1 root would keep exactly the three old rights, and
 * every write would be denied by a root nothing would ever rotate.
 *
 * The bump therefore retires this plane's roots and its undecided cards, and
 * NOTHING else — not the account plane, not the bot host's scan home, not any
 * other module's. That containment is the whole reason the split exists, and it
 * is why "a version bump" is the sanctioned cost here and would not have been on
 * `runner-account`. Persistent user consent is not affected either: `grant_intents`
 * records operation names against a permission contract digest, not an Object id.
 *
 * The two share the trusted `RunnerTransport` — the socket protocol is not what
 * differs between them, and a second copy of it is a drift surface (see
 * `../runner/dispatch.ts`). Everything that carries authority is separate:
 * operation identity, root, slot, grant, revocation, and the next version bump.
 *
 * ── The one thing they must NOT be independent about ───────────────────────
 *
 * The account's device set. Both roots exist only while the account has a user
 * row and at least one registered device, and a credential change has to end
 * BOTH at once — otherwise replacing a laptop leaves a live Workspace Files root
 * pointing at a target set that no longer exists. That is why
 * `attachToRunnerLifecycle()` below is not optional wiring: it is the same
 * `bindingFor` precondition, enforced at the moment it changes rather than at
 * the next use.
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
import { dispatchToRunner, type RunnerDispatchBinding } from "../runner/dispatch.js";
import type { RunnerCapabilities } from "../runner/capability.js";
import type { RunnerTransport } from "../runner/gateway.js";
import { createLogger } from "../logger.js";

const log = createLogger("workspace-files-capability");

/** The Context-local slot every Workspace Files grant is installed under. */
export const WORKSPACE_FILES_SLOT = "workspace-files";

/**
 * `${prefix}:${owner}` is the Object id. v7 added owner stat/session-link
 * arguments; v8 lets `list_session_workspaces` place one path (`path`,
 * `source`, `id`), so a v7 grant never gains that answer. Each bump retires
 * only this plane's old schema-bound roots/cards.
 *
 * 2026-10-20 did NOT bump it: the listing `after` cursor pages the same
 * directory a holder could already list, and the staged replacement
 * (`stage`/`upload_id`/`offset`/`size`) replaces the same file under the same
 * compare-and-swap a holder could already apply — the per-call windows were
 * blast-radius hygiene, not authority (the runner-account `read_file.offset` /
 * `list_dir.cursor` precedent). Persisted identity covers operation NAMES
 * only, and an old card's frozen args never carry the new keys, so it keeps
 * meaning exactly what it said.
 */
export const WORKSPACE_FILES_OBJECT_PREFIX = "workspace-files-runner-v8";

/**
 * The staged-replacement arguments shared by both write operations. Every
 * step spends the same operation through the Gate as a one-call replace, so a
 * staged save is authorised exactly like an ordinary one — per call.
 */
const STAGED_WRITE_ARGS = {
  // Absent: the one-call replace. begin → append × N → commit: see the Runner.
  stage: { type: "string", enum: ["begin", "append", "commit"] },
  upload_id: { type: "string", maxLength: MACHINE_LIMITS.workspaceUploadIdMaxBytes },
  offset: { type: "number", min: 0, max: MACHINE_LIMITS.workspaceFileMaxOffset, integer: true },
  size: { type: "number", min: 0, max: MACHINE_LIMITS.workspaceFileMaxOffset, integer: true },
} as const;

const DEVICE_ARG = { type: "string", required: true, maxLength: MACHINE_LIMITS.deviceMaxBytes } as const;

/**
 * The closed operation table.
 *
 * Four names — three observe/read and one `modify` — and the bounds are the
 * device's own (`MACHINE_LIMITS`) so an approval card cannot describe a call the
 * device would refuse on arrival.
 *
 * What is absent is the content: there is no `path`, no `directory`, no `cwd`.
 * A caller names a device and a `workspace_id` that the device resolves against
 * its own private registry, plus a bounded POSIX-relative path INSIDE it. The
 * kernel refuses arguments a schema does not declare, so "this plane cannot read
 * an arbitrary file" is a property of the table rather than a check somebody has
 * to remember at each call site.
 *
 * `list_session_workspaces` is duplicated from the Runner Object's table on
 * purpose. It is the same operation NAME (the permission projection maps hub
 * operations by name), but a capability over this Object is not a capability
 * over that one — which is exactly the independence being bought here.
 */
export const WORKSPACE_FILES_OPERATIONS: Record<Operation, OperationSpec> = {
  list_session_workspaces: {
    args: {
      device: DEVICE_ARG,
      // Optional: ask the device which workspace holds this path (`~/`,
      // absolute, or relative to the named session's cwd). The answer is a
      // workspace id and a path inside it; reads stay workspace-confined.
      path: { type: "string", maxLength: 1024 },
      source: { type: "string", enum: ["codex", "claude", "omp"] },
      id: { type: "string", maxLength: 256 },
    },
    effect: "observe",
    title: "列出会话工作区",
  },
  list_workspace_entries: {
    args: {
      device: DEVICE_ARG,
      workspace_id: { type: "string", required: true, maxLength: MACHINE_LIMITS.workspaceIdMaxBytes },
      // Optional, so the workspace ROOT is expressible as `""` without a second
      // operation existing for it.
      relative_path: { type: "string", maxLength: MACHINE_LIMITS.workspaceRelativePathMaxBytes },
      limit: { type: "number", min: 1, max: MACHINE_LIMITS.workspaceListMaxEntries, integer: true },
      // One page; `after` (the previous page's last `<kind>/<name>`) reaches the rest.
      after: { type: "string", maxLength: MACHINE_LIMITS.workspaceListCursorMaxBytes },
    },
    effect: "read",
    title: "列出工作区目录",
  },
  access_owner_files: {
    args: {
      device: DEVICE_ARG,
      mode: { type: "string", required: true, enum: ["list", "text", "binary", "download", "stat", "resolve"] },
      absolute_path: { type: "string", maxLength: MACHINE_LIMITS.pathMaxBytes },
      path: { type: "string", maxLength: 400 },
      source: { type: "string", enum: ["codex", "claude", "omp"] },
      id: { type: "string", maxLength: 256 },
      workspace_id: { type: "string", maxLength: MACHINE_LIMITS.workspaceIdMaxBytes },
      limit: { type: "number", min: 1, max: MACHINE_LIMITS.workspaceListMaxEntries, integer: true },
      after: { type: "string", maxLength: MACHINE_LIMITS.workspaceListCursorMaxBytes },
      offset: { type: "number", min: 0, max: MACHINE_LIMITS.workspaceFileMaxOffset, integer: true },
      max_bytes: { type: "number", min: 1, max: MACHINE_LIMITS.workspaceMediaChunkMaxBytes, integer: true },
    },
    effect: "read",
    title: "访问本人 Runner 文件",
  },
  replace_owner_text: {
    args: {
      device: DEVICE_ARG,
      absolute_path: { type: "string", required: true, maxLength: MACHINE_LIMITS.pathMaxBytes },
      // Required by the device for a one-call replace, begin and commit; an
      // append carries a window and no precondition.
      expected_digest: { type: "string", maxLength: 71 },
      text: { type: "string", maxLength: MACHINE_LIMITS.workspaceWriteMaxBytes },
      ...STAGED_WRITE_ARGS,
    },
    effect: "modify",
    // Uses the same expected-digest CAS as replace_workspace_text.
    retrySafe: true,
    title: "改写本人 Runner 文本文件",
  },
  read_workspace_text: {
    args: {
      device: DEVICE_ARG,
      workspace_id: { type: "string", required: true, maxLength: MACHINE_LIMITS.workspaceIdMaxBytes },
      relative_path: { type: "string", required: true, maxLength: MACHINE_LIMITS.workspaceRelativePathMaxBytes },
      offset: { type: "number", min: 0, max: MACHINE_LIMITS.workspaceFileMaxOffset, integer: true },
      max_bytes: { type: "number", min: 1, max: MACHINE_LIMITS.workspaceTextChunkMaxBytes, integer: true },
    },
    effect: "read",
    title: "读取工作区文本文件",
  },
  read_workspace_binary: {
    args: {
      device: DEVICE_ARG,
      workspace_id: { type: "string", required: true, maxLength: MACHINE_LIMITS.workspaceIdMaxBytes },
      relative_path: { type: "string", required: true, maxLength: MACHINE_LIMITS.workspaceRelativePathMaxBytes },
      offset: { type: "number", min: 0, max: MACHINE_LIMITS.workspaceFileMaxOffset, integer: true },
      max_bytes: { type: "number", min: 1, max: MACHINE_LIMITS.workspaceMediaChunkMaxBytes, integer: true },
    },
    effect: "read",
    title: "读取工作区媒体文件",
  },
  download_workspace_file: {
    args: {
      device: DEVICE_ARG,
      workspace_id: { type: "string", required: true, maxLength: MACHINE_LIMITS.workspaceIdMaxBytes },
      relative_path: { type: "string", required: true, maxLength: MACHINE_LIMITS.workspaceRelativePathMaxBytes },
      offset: { type: "number", min: 0, max: MACHINE_LIMITS.workspaceFileMaxOffset, integer: true },
      max_bytes: { type: "number", min: 1, max: MACHINE_LIMITS.workspaceMediaChunkMaxBytes, integer: true },
    },
    effect: "read",
    title: "下载工作区文件",
  },
  /**
   * The one operation on this plane that changes anything.
   *
   * `effect: "modify"` makes the risk explicit for audit and disclosure. The
   * owner root permits it, while each derived grant still decides whether this
   * particular first-party surface may exercise it silently.
   *
   * `retrySafe: true` is stated rather than inherited. The effect-derived
   * default for `modify` is false — correct for `exec` and `write_file`, where
   * running a call twice is running it twice — but this operation is a
   * compare-and-swap: re-running it either applies the same edit to the same
   * version, or finds the digest no longer matches and refuses. There is no
   * input for which it can be applied twice, which is exactly the property
   * interrupt recovery asks about. So a claimed-but-undetermined replace goes
   * back to the owner as a pending decision instead of being written off as
   * `unknown`.
   *
   * It stays honest for each step of a staged replacement (2026-10-20): a
   * re-run `begin` answers the upload it already began (same token, file and
   * digest); a re-run `append` names its byte offset, so a replay of the last
   * window is recognised and writes nothing; and `commit` consumes the upload,
   * so a re-run finds nothing to commit — while the commit it repeats is the
   * same compare-and-swap.
   */
  replace_workspace_text: {
    args: {
      device: DEVICE_ARG,
      workspace_id: { type: "string", required: true, maxLength: MACHINE_LIMITS.workspaceIdMaxBytes },
      relative_path: { type: "string", required: true, maxLength: MACHINE_LIMITS.workspaceRelativePathMaxBytes },
      // `sha256:` + 64 hex, and that is the CAS: there is no shape of this call
      // that means "write regardless of what is there". The device requires it
      // on every call that can change the target — a one-call replace and a
      // staged commit (and begin, which binds the upload to it); an append only
      // fills the upload's sibling temp file.
      expected_digest: { type: "string", maxLength: 71 },
      // One call's window. A larger replacement is staged.
      text: { type: "string", maxLength: MACHINE_LIMITS.workspaceWriteMaxBytes },
      ...STAGED_WRITE_ARGS,
    },
    effect: "modify",
    retrySafe: true,
    title: "改写工作区文本文件",
  },
};

/** Every operation this resource can back. Used by the permission projection. */
export const WORKSPACE_FILES_OPERATION_NAMES: readonly string[] = Object.keys(WORKSPACE_FILES_OPERATIONS);

/**
 * The one operation on this plane that changes anything, named once.
 *
 * Callers ask "did the write survive the grant intersection?" with this, rather
 * than with a string literal each: a literal typo would answer `false` forever
 * and look exactly like a permission that was never granted.
 */
export const WORKSPACE_FILES_WRITE_OPERATION = "replace_workspace_text";
export const OWNER_FILES_WRITE_OPERATION = "replace_owner_text";

/**
 * Mandatory policy: the same three decisions, in the same order, as the Runner
 * Object's and the bot host's.
 *
 *   1. evidence that a human approved EXACTLY this call → allow;
 *   2. this grant's own terms say it may act unsupervised → allow;
 *   3. otherwise ask the owner, with a summary the server wrote.
 *
 * It is written out rather than shared because a policy that took a parameter
 * would be a policy with a branch, and the point of a mandatory policy is that
 * reading it tells you what it does. The approver is the Object's bound owner
 * and nothing else can name one: a card for somebody else's laptop is not a
 * thing this file can produce.
 */
function workspaceFilesPolicy(input: PolicyInput): PolicyDecision {
  const owner = input.object.metadata.owner ?? "";
  if (!owner) return { kind: "deny", reason: "workspace-files object has no bound owner" };

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

  // `device` is present because the schema requires it, so the card names the
  // machine the frozen args name.
  const device = String(input.args.device ?? "本机端点");
  const details: string[] = [];
  if (input.operation === "list_session_workspaces") {
    details.push(typeof input.args.path === "string"
      ? `范围：查询这个路径属于哪个已登记的工作区：${input.args.path.slice(0, 300)}`
      : "范围：这台设备上已登记的工作区列表");
  } else if (input.operation === "access_owner_files" || input.operation === OWNER_FILES_WRITE_OPERATION) {
    details.push("范围：本人 Runner 上当前 OS 账号可访问的文件");
    details.push(`路径：${String(input.args.absolute_path ?? input.args.path ?? "").slice(0, 300)}`);
    if (input.args.mode === "resolve") details.push(`相对于：${String(input.args.workspace_id ?? input.args.id ?? "").slice(0, 256)}`);
  } else {
    // The workspace id is opaque, so the relative path is the part a person can
    // actually recognise — and the root has to be spelled out rather than
    // rendered as an empty string.
    details.push(`工作区：${String(input.args.workspace_id ?? "").slice(0, 64)}`);
    const relative = String(input.args.relative_path ?? "");
    details.push(`路径：${relative === "" ? "(工作区根目录)" : relative.slice(0, 300)}`);
  }
  if (input.operation === WORKSPACE_FILES_WRITE_OPERATION || input.operation === OWNER_FILES_WRITE_OPERATION) {
    // A person approving a write needs the two facts a read does not have: how
    // much is about to land, and that the old content is not kept anywhere. The
    // CONTENT is deliberately not previewed — a card is a bounded summary, and a
    // partial preview of a file is a way to approve something other than what
    // was read.
    const bytes = typeof input.args.text === "string" ? Buffer.byteLength(input.args.text, "utf8") : 0;
    const expected = String(input.args.expected_digest ?? "");
    const stage = input.args.stage;
    if (stage === "begin") {
      details.push("分段保存：开始（整份替换，内容按窗口暂存在同目录临时文件，提交前不改动该文件）");
      details.push(`基于版本：${expected.slice(0, 20)}…（与设备上的实际内容不符时不会写入）`);
    } else if (stage === "append") {
      details.push(`分段保存：暂存从第 ${String(input.args.offset ?? 0)} 字节起的 ${bytes} 字节（该文件尚未改动）`);
    } else if (stage === "commit") {
      details.push(`分段保存：提交，共 ${String(input.args.size ?? 0)} 字节（整份替换）`);
      details.push(`基于版本：${expected.slice(0, 20)}…（与设备上的实际内容不符时不会写入）`);
      details.push("这次改写会覆盖该文件的全部内容，且不保留可撤销的旧副本。");
    } else {
      details.push(`将写入：${bytes} 字节（整份替换）`);
      details.push(`基于版本：${expected.slice(0, 20)}…（与设备上的实际内容不符时不会写入）`);
      details.push("这次改写会覆盖该文件的全部内容，且不保留可撤销的旧副本。");
    }
  }
  details.push(`动作类别：${input.effect}`);
  details.push(`发起方：${input.context.metadata.purpose ?? input.context.kind}`);
  details.push(`参数指纹：${input.argsHash.slice(0, 16)}`);
  return {
    kind: "approval_required",
    summary: {
      title: `${input.spec.title ?? input.operation} · ${owner}/${device}`,
      target: `${owner}/${device}`,
      details,
      allowedApprover: owner,
    },
  };
}

/**
 * The adapter. Nothing but the shared dispatch: this plane has no execute-class
 * operation, so a lost link is an ordinary failed read rather than an outcome
 * nobody can determine.
 */
async function workspaceFilesAdapter(
  binding: RunnerDispatchBinding,
  operation: Operation,
  args: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  return await dispatchToRunner(binding, operation, args);
}

/** A narrow, closable authority over one account's workspace files. */
export class WorkspaceFilesGrant extends SlotGrant {
  constructor(svc: CapabilityService, contextId: ContextId, purpose: string, owner: string, borrowed = false) {
    super(svc, contextId, WORKSPACE_FILES_SLOT, purpose, owner, borrowed);
  }
}

export interface WorkspaceFilesCapabilitiesOptions {
  /**
   * The process's ONE capability service, shared with `RunnerCapabilities`. A
   * Context minted by one service is meaningless to another, and the SQLite
   * store takes a single-writer lease, so "two services" is not a configuration
   * that exists.
   */
  service: CapabilityService;
  /** The raw gateway face, claimed once at boot. Never handed to app code. */
  transport: RunnerTransport;
  /** The trusted user directory. An account that does not exist holds nothing. */
  userExists: (username: string) => boolean;
  /**
   * Whether this account has at least one registered device. An account with no
   * laptop has no workspace to hold authority over, so there is nothing to be
   * the root OF.
   */
  hasDevice: (username: string) => boolean;
  now?: () => number;
}

export class WorkspaceFilesCapabilities {
  private authority: AccountAuthority<RunnerDispatchBinding>;

  constructor(private opts: WorkspaceFilesCapabilitiesOptions) {
    this.authority = new AccountAuthority<RunnerDispatchBinding>({
      service: opts.service,
      slot: WORKSPACE_FILES_SLOT,
      objectPrefix: WORKSPACE_FILES_OBJECT_PREFIX,
      kind: "workspace-files-runner",
      operations: WORKSPACE_FILES_OPERATIONS,
      policy: workspaceFilesPolicy,
      scopeAllows: (device, input) => input.args.device === device,
      adapter: workspaceFilesAdapter as ObjectDefinition<RunnerDispatchBinding>["adapter"],
      now: opts.now,
      // This is the owner's own workspace authority. A child grant must still
      // opt into each silent operation, and another owner cannot derive it.
      rootAutoAllow: () => Object.keys(WORKSPACE_FILES_OPERATIONS),
      /**
       * The same two trusted facts the Runner Object re-reads on every use, and
       * they are the same facts on purpose: this plane reaches the same laptops
       * through the same transport, so "the account was deleted" and "the last
       * device went away" have to end it too. Returning null does not merely
       * refuse — `AccountAuthority` revokes whatever root is still standing.
       */
      bindingFor: (name) =>
        opts.userExists(name) && opts.hasDevice(name)
          ? { owner: name, transport: opts.transport }
          : null,
      onWarning: (message, fields) => log.warn(fields, message),
    });
  }

  /** Shared process kernel, for the trusted composition that owns both planes. */
  get service(): CapabilityService {
    return this.opts.service;
  }

  /**
   * Derive a Context over this account's workspace files.
   *
   * Null is a fail-closed answer rather than an error to fall back from: no user
   * row, no device, or none of `rights` survives the intersection.
   */
  open(o: {
    username: string;
    purpose: string;
    kind?: "app-instance" | "controller-run" | "agent-run" | "session" | "job";
    rights: readonly Operation[];
    /**
     * Which of `rights` may be exercised WITHOUT a per-call approval. Omitted
     * preserves the observe/read default; trusted owner-local writers opt in
     * explicitly. Naming it can only narrow against the owner root.
     *
     * This is where "may a file browser walk the tree unsupervised?" is
     * answered — at the issuing call, not in the policy.
     */
    autoAllow?: readonly Operation[];
    metadata?: Record<string, string>;
    device?: string;
    pool?: string;
  }): WorkspaceFilesGrant | null {
    const username = String(o.username ?? "").trim();
    const derived = this.authority.derive({
      username,
      purpose: o.purpose,
      kind: o.kind ?? "app-instance",
      rights: o.rights,
      autoAllow: o.autoAllow,
      metadata: o.metadata,
      scope: o.device,
      pool: o.pool,
    });
    if (!derived) return null;
    return new WorkspaceFilesGrant(this.opts.service, derived.contextId, o.purpose, username, derived.borrowed);
  }

  /** What this account's Workspace Files root holds right now. */
  accountOperations(username: string): string[] {
    return this.authority.rightsOfAccount(username);
  }

  /** The one root another trusted plane may derive from. Never mints a second. */
  accountAuthority(username: string): { contextId: ContextId; slot: string } | null {
    const authority = this.authority.authorityFor(username);
    return authority ? { contextId: authority.context, slot: WORKSPACE_FILES_SLOT } : null;
  }

  /** Teardown half of a revocation; `surface` narrows to one pool prefix. */
  dropPooled(username: string, surface?: string): number {
    return this.authority.dropPooled(username, surface);
  }

  revokeAccount(username: string): void {
    this.authority.revokeAccount(username);
  }

  revokeDevice(username: string, device: string): void {
    this.authority.revokeScope(username, device);
  }

  /** Test/diagnostics. */
  get pooledContexts(): number {
    return this.authority.pooledContexts;
  }

  /**
   * Bind this plane's lifetime to the account's device set.
   *
   * `bindingFor` already refuses once the last device is gone, but that is a
   * check at the NEXT use; replacing a credential leaves the device count at one
   * and would leave this root standing over a set that changed underneath it.
   * So the door that changes a credential announces it, and this is the
   * listener: revoke the root, then let the caller (typically a provider
   * catalog) close what is already open.
   *
   * Returns an unsubscribe function. Registering it is composition, not policy.
   *
   * What a failure here does: `revokeAccount` and whatever `onChanged` does
   * BEFORE it returns are what `mintDeviceToken` can still refuse on — a
   * synchronous throw from either propagates and no replacement credential is
   * written. An `onChanged` that hands its release to something asynchronous
   * (the provider catalog does) has already returned by then, so a later
   * rejection is logged, not raised. That is correct rather than a gap: the
   * property this listener owes is "nothing new can start", and revoking first
   * is what establishes it.
   */
  attachToRunnerLifecycle(
    runner: Pick<RunnerCapabilities, "onTargetSetChanged">,
    onChanged?: (username: string) => void,
  ): () => void {
    return runner.onTargetSetChanged((event) => {
      // Revoke FIRST: from here on nothing new can be derived, so a teardown
      // that throws afterwards cannot leave a way back in.
      this.revokeDevice(event.username, event.device);
      onChanged?.(event.username);
    });
  }
}
