/**
 * The Runner Object — the ONLY way anything in this process can make a laptop
 * Runner receive an RPC (resource side: doc/tcb-reading-guide.md §3).
 *
 * Shape, from the outside in:
 *
 *   trusted lifecycle event (a dashboard session, a chat turn, an agent run)
 *     -> RunnerCapabilities.open(...)          # derives a narrow Context
 *          -> BoundCapabilities.request(slot, operation, args)
 *               -> kernel: slot -> capability -> ancestry -> fixed Object
 *               -> mandatory policy: read = allow, write = PendingCall
 *               -> this file's adapter, holding the raw transport
 *                    -> RunnerGateway WebSocket frame
 *
 * Two invariants worth stating plainly because they are what make cross-user
 * access structurally impossible rather than merely checked:
 *
 *  - The Object's owner is fixed at registration from the trusted user row.
 *    `device` is a selector resolved INSIDE that owner's connection set; there
 *    is no code path that takes a username from arguments and looks up a
 *    device globally.
 *  - The adapter is the sole holder of the raw transport (claimed once from
 *    the gateway at boot). No caller can obtain it, so "forgot to check" is
 *    not reachable from any other entry point.
 */

import { receiptTargetOf } from "../sessionhub/operation-receipts.js";
import {
  CapabilityService,
  type AuditRecord,
  type ContextId,
  type InvokeResult,
  type ObjectDefinition,
  type Operation,
  type OperationSpec,
  type PolicyInput,
  type PendingView,
} from "@claude-bot/capability-kernel";
import { MACHINE_LIMITS } from "@claude-bot/runner/limits";
import { AGENT_EFFORT_LEVELS, SESSION_IDS_MAX, decodeSessionIds } from "@claude-bot/agent-sessions-contract";
import type { Store } from "../store/store.js";
import { hashRunnerToken, newRunnerTokenPlaintext, type RunnerDeviceStatus, type RunnerTransport } from "./gateway.js";
import { AccountAuthority, SlotGrant } from "./account-authority.js";
import { dispatchToRunner, type RunnerDispatchBinding } from "./dispatch.js";
import { createLogger } from "../logger.js";
import type { RunnerProjectionReadCache } from "./session-projection.js";
import { sessionAttachmentOperation } from "./session-attachment-operation.js";
import {
  RunnerGuiAutomationCapabilities,
  type RunnerGuiAutomationTarget,
  type RunnerGuiAutomationToggleResult,
} from "./gui-automation.js";
import {
  groupSessionCatalogEntries,
  mergeSessionCatalogList,
  mergeSessionCatalogSearch,
  sessionCatalogWireEntry,
  type PreparedSessionCatalogEntry,
  type SessionCatalogSupplement,
} from "./session-catalog.js";

const log = createLogger("runner-capability");

/** The Context-local slot name every Runner grant is installed under. */
export const RUNNER_SLOT = "runner";

/**
 * The closed operation registry — exactly `packages/runner/src/core.ts`'s
 * method table plus the gateway-local device roster. Adding a Runner method
 * without adding it here means it is denied, which is the intended default.
 */
/**
 * `device` is REQUIRED on every operation that acts on one box.
 *
 * It used to be optional, and the gateway picked "the single online device" at
 * DISPATCH time — which for a mutating call is after the human approved. The
 * approval card said `alice/(唯一在线设备)` and the args hash did not cover the
 * target at all, so:
 *
 *  - a card was created even when two devices were online (the ambiguity check
 *    lives in the adapter, which never runs for an approval_required call), and
 *  - between the card and the click the online set can change, so the exec the
 *    owner approved for their laptop could run on their desktop.
 *
 * Naming the device is not a privilege decision — every device of the account
 * is equally inside the Object's binding — it is what makes the frozen args
 * describe the call that will actually happen.
 *
 * The Object remains account-bound; durable roots define revocation domains.
 * Broad roster grants use an unscoped root and are invalidated by any device
 * change, so registering another device cannot widen an existing grant.
 * Exact-device grants (CI, execution, GUI) derive from an independently
 * revocable device root. Its immutable ancestor metadata is checked before
 * approval or auto-allow; a child cannot erase or replace the restriction.
 * Re-enrolling Windows revokes Windows and broad roster grants, while an
 * existing CI-only grant and its pending approvals remain valid.
 */
const DEVICE_ARG = { type: "string", required: true, maxLength: MACHINE_LIMITS.deviceMaxBytes } as const;

/**
 * The durable Object id is versioned whenever its closed operation registry or
 * an operation's accepted argument schema changes. Reusing an existing id
 * after widening either would retarget live capabilities at a different
 * Object, which the kernel correctly refuses. Keeping the previous version
 * under its old id also preserves a clean code rollback: old binaries re-attach
 * to their Object while this binary only derives from the new version.
 * ── Why a new resource does NOT bump it ────────────────────────────────────
 *
 * A version bump costs every live capability derived from the old root, every
 * pending approval card created under it, on every account — including the ones
 * that never heard of the new feature. That is the right price for changing what
 * THIS Object is; it is the wrong price for adding a different one.
 *
 * So `workspace-files/v1` is a separate Object (`workspace-files-runner-v2`,
 * `../workspace-files/capability.ts`) sharing this transport rather than two
 * more names in the table below. The two are independent in operation identity,
 * root, slot, grant, revocation and future versioning; what they DO share is the
 * real condition they both depend on — the account's device set — and that is
 * closed for both at once through `onTargetSetChanged` below.
 */
// v12 removes the command text cap and gives append the existing prompt wire budget.
// Declaring start_session's two borrowed-runtime routing keys (B13) did not
// bump it: they grant a holder nothing new, because the post-Gate preparer
// re-authorizes the exact run_agent permit, while a bump would revoke every
// live capability and pending card on every account.
// `read_file.offset` and `list_dir.cursor` did not bump it either: they page
// the same path a holder could already read or list (the windows were
// blast-radius hygiene, not authority), persisted identity covers operation
// names only, and an old card's frozen args never carry them.
export const RUNNER_ACCOUNT_OBJECT_PREFIX = "runner-account-v12";

/**
 * The closed operation registry.
 *
 * Every entry declares an `effect`, and that declaration is the whole input to
 * "does a human decide this call?". A root capability auto-allows `observe` and
 * `read` by default and never `modify` or `execute`, and each grant can narrow
 * further with `autoAllow` — so which of these need a click is a property of the
 * GRANT, decided where the grant is issued, not a boolean baked in here.
 */
export const RUNNER_OPERATIONS: Record<string, OperationSpec> = {
  __list_devices: { args: {}, effect: "observe", title: "列出设备" },
  host_info: { args: { device: DEVICE_ARG }, effect: "observe", title: "读取主机信息" },
  list_dir: {
    args: {
      device: DEVICE_ARG,
      path: { type: "string", maxLength: MACHINE_LIMITS.pathMaxBytes },
      // One page; `cursor` (the previous page's `next_cursor`) reaches the rest.
      limit: { type: "number", min: 1, max: MACHINE_LIMITS.listMaxEntries, integer: true },
      cursor: { type: "string", maxLength: MACHINE_LIMITS.pathMaxBytes },
    },
    effect: "read",
    title: "列出目录",
  },
  read_file: {
    args: {
      device: DEVICE_ARG,
      path: { type: "string", required: true, maxLength: MACHINE_LIMITS.pathMaxBytes },
      // One window; `offset` (the previous window's `next_offset`) reaches the rest.
      max_bytes: { type: "number", min: 1, max: MACHINE_LIMITS.readFileMaxBytes, integer: true },
      offset: { type: "number", min: 0, max: Number.MAX_SAFE_INTEGER, integer: true },
    },
    effect: "read",
    title: "读取文件",
  },
  list_recent_sessions: {
    args: {
      cursor: { type: "string", maxLength: 1024 },
      primary_window: { type: "boolean" },
      device: { type: "string", maxLength: 128 },
      // Exact `source:id` selector (decodeSessionIds) for chats a person kept
      // that left the recent window. It narrows this read; never a path or owner.
      ids: { type: "string", maxLength: SESSION_IDS_MAX * 210 },
      source: { type: "string", enum: ["claude", "codex", "omp", "all"] },
      limit: { type: "number", min: 1, max: 500, integer: true },
      since_hours: { type: "number", min: 0, max: 24 * 365 },
      // Trusted Sessions+ coordinator opt-in. The post-Gate adapter removes it
      // before ordinary Runner dispatch and may only use owner-scoped catalog
      // rows; the View cannot supply operation arguments directly.
      _octopus_include_session_plus: { type: "boolean" },
    },
    effect: "read",
    title: "列出会话",
  },
  digest_recent_sessions: {
    args: {
      source: { type: "string", enum: ["claude", "codex", "omp", "all"] },
      limit: { type: "number", min: 1, max: 20, integer: true },
      turns_per_session: { type: "number", min: 2, max: 40, integer: true },
      chars_per_turn: { type: "number", min: 40, max: 400, integer: true },
      since_hours: { type: "number", min: 0, max: 24 * 365 },
    },
    effect: "read",
    title: "通读会话",
  },
  search_sessions: {
    args: {
      query: { type: "string", required: true, maxLength: 512 },
      source: { type: "string", enum: ["claude", "codex", "omp", "all"] },
      limit: { type: "number", min: 1, max: 50, integer: true },
      since_hours: { type: "number", min: 0, max: 24 * 365 },
      cursor: { type: "string", maxLength: 1024 },
      _octopus_include_session_plus: { type: "boolean" },
    },
    effect: "read",
    title: "搜索会话",
  },
  read_session: {
    args: {
      // Optional for callers that only know a session id; when a roster entry
      // already identified the device, pin it so the args hash and transport
      // name the same machine the UI selected. RunnerGateway has always
      // supported this selector, but it used to be missing from the Gate
      // schema and was therefore impossible to exercise through a capability.
      device: { type: "string", maxLength: MACHINE_LIMITS.deviceMaxBytes },
      source: { type: "string", enum: ["claude", "codex", "omp"] },
      id: { type: "string", maxLength: MACHINE_LIMITS.sessionIdMaxBytes },
      path: { type: "string", maxLength: MACHINE_LIMITS.pathMaxBytes },
      max_messages: { type: "number", min: 1, max: 500, integer: true },
      // Positions in a transcript of any length: windows are bounded, totals are not.
      offset: { type: "number", min: 0, max: Number.MAX_SAFE_INTEGER, integer: true },
      before: { type: "number", min: 0, max: Number.MAX_SAFE_INTEGER, integer: true },
      // One complete block of the message at `offset`, one character window at a time.
      block: { type: "number", min: 0, max: Number.MAX_SAFE_INTEGER, integer: true },
      field: { type: "string", enum: ["text", "input", "output"] },
      char_offset: { type: "number", min: 0, max: Number.MAX_SAFE_INTEGER, integer: true },
      continuation_settings: { type: "boolean" },
      rich: { type: "boolean" },
      tool_detail: { type: "boolean" },
      _octopus_include_session_plus: { type: "boolean" },
    },
    effect: "read",
    title: "读取会话",
  },
  list_session_workspaces: {
    args: { device: DEVICE_ARG },
    effect: "observe",
    title: "列出会话工作区",
  },
  open_workspace_terminal: {
    args: {
      device: DEVICE_ARG,
      lease_id: { type: "string", required: true, maxLength: MACHINE_LIMITS.terminalIdMaxBytes },
      workspace_id: { type: "string", required: true, maxLength: MACHINE_LIMITS.workspaceIdMaxBytes },
      cols: { type: "number", min: 40, max: 240, integer: true },
      rows: { type: "number", min: 12, max: 80, integer: true },
    },
    effect: "execute",
    title: "打开远端工作区终端",
  },
  open_dsh_tunnel: {
    args: {
      device: DEVICE_ARG,
      port: { type: "number", required: true, min: 1, max: 65_535, integer: true },
    },
    effect: "execute",
    title: "打开本机 DSH",
  },
  workspace_terminal: {
    args: {
      device: DEVICE_ARG,
      action: { type: "string", required: true, enum: ["claim", "read", "input", "close"] },
      lease_id: { type: "string", required: true, maxLength: MACHINE_LIMITS.terminalIdMaxBytes },
      terminal_id: { type: "string", maxLength: MACHINE_LIMITS.terminalIdMaxBytes },
      input: { type: "string", maxLength: MACHINE_LIMITS.terminalInputMaxBytes },
      cols: { type: "number", min: 40, max: 240, integer: true },
      rows: { type: "number", min: 12, max: 80, integer: true },
    },
    effect: "execute",
    title: "使用已批准的远端终端",
  },
  /**
   * `device` is OPTIONAL on the two export operations, and that asymmetry with
   * the machine ops is deliberate.
   *
   * A machine operation acts on a named machine, so an unnamed one is a caller
   * bug. An export names an id or a path and the caller may genuinely not know
   * which laptop holds it — the secretary picks a session out of a merged
   * listing. So the gateway asks each device in turn. What `device` buys when
   * the caller DOES know it: the answer comes from that machine and no other,
   * and — because args are hashed — the fact is in the audit record.
   *
   * Without it the order is at least deterministic (sorted by device name); it
   * used to be Map insertion order, i.e. whichever laptop reconnected last.
   */
  copy_session: {
    args: {
      id: { type: "string", required: true, maxLength: MACHINE_LIMITS.sessionIdMaxBytes },
      device: { type: "string", maxLength: MACHINE_LIMITS.deviceMaxBytes },
      // Byte window: a file of any size is exported whole through `next_offset`.
      offset: { type: "number", min: 0, max: Number.MAX_SAFE_INTEGER, integer: true },
    },
    effect: "read",
    title: "导出会话",
  },
  copy_file: {
    args: {
      path: { type: "string", required: true, maxLength: MACHINE_LIMITS.pathMaxBytes },
      device: { type: "string", maxLength: MACHINE_LIMITS.deviceMaxBytes },
      offset: { type: "number", min: 0, max: Number.MAX_SAFE_INTEGER, integer: true },
    },
    effect: "read",
    title: "导出文件",
  },

  // ── modify / execute (a root never auto-allows these) ──
  write_file: {
    args: {
      device: DEVICE_ARG,
      path: { type: "string", required: true, maxLength: MACHINE_LIMITS.pathMaxBytes },
      content: { type: "string", required: true, maxLength: MACHINE_LIMITS.writeFileMaxBytes },
      append: { type: "boolean" },
    },
    effect: "modify",
    title: "写入文件",
  },
  exec: {
    args: {
      device: DEVICE_ARG,
      // The Gate bounds the complete argument object; command length is not authority.
      command: { type: "string", required: true },
      cwd: { type: "string", maxLength: MACHINE_LIMITS.pathMaxBytes },
      timeout_ms: { type: "number", min: 1, max: MACHINE_LIMITS.execTimeoutMaxMs, integer: true },
    },
    effect: "execute",
    title: "执行命令",
  },
  get_session_operation: {
    args: { device: DEVICE_ARG, operation_id: { type: "string", required: true, maxLength: 160 } },
    effect: "read",
    title: "查询会话操作结果",
  },
  append_session: {
    args: {
      operation_id: { type: "string", maxLength: 160 },
      input_receipt: { type: "boolean" },
      // Narrows append to the active managed turn; never resumes an idle agent.
      steer_only: { type: "boolean" },
      // A narrowing contract: existing native CLI only; never spawn or take over.
      native_cli_only: { type: "boolean" },
      native_workspace_id: { type: "string", maxLength: 200 },
      native_relative_path: { type: "string", maxLength: MACHINE_LIMITS.pathMaxBytes },
      device: DEVICE_ARG,
      id: { type: "string", required: true, maxLength: MACHINE_LIMITS.sessionIdMaxBytes },
      // Prompt is required by the Runner for a normal append. The one
      // compatibility-envelope exceptions are the prompt-free interrupt and
      // exact-attachment release intents, both validated device-side.
      prompt: { type: "string", maxLength: MACHINE_LIMITS.appendMaxPromptBytes },
      source: { type: "string", enum: ["claude", "codex", "omp"] },
      // Human-confirmed cancel-and-resume. Optional keeps every older caller's
      // frame byte-for-byte valid; when true it is frozen into the args hash and
      // called out on the approval card before the Runner may signal anything.
      takeover: { type: "boolean" },
      // Human-confirmed Codex cross-account fork. The browser never chooses an
      // account or path; the device-local router resolves both after this
      // boolean has been frozen into the capability call.
      account_fallback: { type: "boolean" },
      interrupt: { type: "boolean" },
      release_control: { type: "boolean" },
      configure_continuation: { type: "boolean" },
      continuation_prompt: { type: "string", maxLength: 4000 },
      continuation_revision: { type: "string", maxLength: 36 },
      permission_profile: { type: "string", enum: ["full_access", "manual"] },
      model: { type: "string", maxLength: MACHINE_LIMITS.modelMaxBytes },
      effort: {
        type: "string",
        maxLength: MACHINE_LIMITS.effortMaxBytes,
        enum: [...AGENT_EFFORT_LEVELS],
      },
    },
    effect: "execute",
    title: "续跑会话",
  },
  upload_session_file: sessionAttachmentOperation(DEVICE_ARG),
  start_session: {
    args: {
      operation_id: { type: "string", maxLength: 160 },
      input_receipt: { type: "boolean" },
      device: DEVICE_ARG,
      execution_device: { type: "string", maxLength: MACHINE_LIMITS.deviceMaxBytes },
      codex_account: { type: "string", maxLength: 32 },
      // ── Two ways to name where the Agent starts; the Runner takes exactly one ──
      //
      // Neither is `required` here, because "exactly one of these" is not a
      // shape a per-field schema can state. The kernel's job is to bound each
      // field; deciding WHICH form this call is belongs to the two places that
      // can also act on the answer — the trusted executor that builds the
      // approval card, and the device that refuses both-or-neither before it
      // spawns anything.
      //
      // `workspace_id` is the original form: an opaque id the device resolves
      // against its own private registry, so the canonical path never crosses
      // the wire. An older Agent View — one the release registry may still have
      // active, or one an operator rolls back to — sends only this.
      workspace_id: { type: "string", maxLength: MACHINE_LIMITS.workspaceIdMaxBytes },
      // Labels are display evidence frozen into the approval, not authority.
      // The Runner resolves only workspace_id against its private registry.
      workspace_label: { type: "string", maxLength: MACHINE_LIMITS.workspaceLabelMaxBytes },
      workspace_display: { type: "string", maxLength: MACHINE_LIMITS.workspaceDisplayMaxBytes },
      // `directory` is the v4 form: the person typed a path on their own device.
      // It is display evidence AND the request — the approval card shows exactly
      // this string, and the device resolves exactly this string. It is bounded
      // here; whether it exists, is a directory, and is reachable is decided on
      // the device, at execution, after the approval.
      directory: { type: "string", maxLength: MACHINE_LIMITS.pathMaxBytes },
      source: { type: "string", required: true, enum: ["claude", "codex", "omp"] },
      model: { type: "string", maxLength: MACHINE_LIMITS.modelMaxBytes },
      // The kernel bounds the union; the Host binding and the device apply the
      // chosen provider's own ladder from the same shared definition.
      effort: {
        type: "string",
        maxLength: MACHINE_LIMITS.effortMaxBytes,
        enum: [...AGENT_EFFORT_LEVELS],
      },
      permission_profile: { type: "string", enum: ["full_access", "manual"] },
      // Opt-in bilingual lane for Claude: translate the prompt to English
      // through GPT before Claude sees it, and project the reply in both
      // languages. Absent means the plain Claude lane, which never reaches a
      // second provider — that lane has to keep working when the translator
      // does not.
      translate_prompt: { type: "boolean" },
      // Trusted Session Plus composition may select the lifecycle policy after
      // binding the runtime and execution devices. It remains in the same
      // closed schema as every other dispatch fact so the Gate freezes it into
      // the approved/idempotent call; the untrusted View never supplies it.
      _octopus_launch_mode: { type: "string", enum: ["independent_cli"] },
      // Trusted Session Plus routing onto a borrowed (shared) Agent runtime:
      // the runtime's owner and its exact `agent-runtime:<hex>` resource. In
      // the same closed schema for the same reason as the launch mode — the
      // Gate freezes them into the approved/idempotent call. The post-Gate
      // dispatch preparer re-checks the run_agent permit for exactly this
      // pair, strips both, and routes; they never reach a device (B13: left
      // undeclared, the kernel refused every borrowed launch).
      _octopus_runtime_owner: { type: "string", maxLength: 128 },
      _octopus_runtime_resource_id: { type: "string", maxLength: 128 },
      prompt: { type: "string", required: true, maxLength: MACHINE_LIMITS.startMaxPromptBytes },
      client_request_id: {
        type: "string",
        required: true,
        maxLength: MACHINE_LIMITS.clientRequestIdMaxBytes,
      },
    },
    effect: "execute",
    title: "启动新会话",
  },
};

/** Operations a grant may exercise on its own once the grant says so. */
export const RUNNER_READ_OPS = Object.entries(RUNNER_OPERATIONS)
  .filter(([, spec]) => spec.effect === "observe" || spec.effect === "read")
  .map(([name]) => name);
/** Operations that change or run something. Child grants still decide whether they run silently. */
export const RUNNER_WRITE_OPS = Object.entries(RUNNER_OPERATIONS)
  .filter(([, spec]) => spec.effect === "modify" || spec.effect === "execute")
  .map(([name]) => name);

/** Session-investigation reads: what a secretary/HQ agent may see. */
export const SESSION_READ_OPS = [
  "list_recent_sessions",
  "digest_recent_sessions",
  "search_sessions",
  "read_session",
] as const;
/** Report archiving pulls whole files out of the laptop into the bot host. */
export const ARCHIVE_OPS = ["copy_session", "copy_file"] as const;
/** The machines MCP surface: device roster + files + shell. */
export const MACHINE_OPS = [
  "__list_devices",
  "host_info",
  "list_dir",
  "read_file",
  "write_file",
  "exec",
] as const;

/**
 * A person's own chat agent is their interactive control surface over their own
 * registered Runner. Its child grant deliberately names the whole machine
 * surface as silent. This does not make the Runner public: the account Object
 * is owner-bound, another account cannot derive from it, and sharing/export
 * planes have their own grants and approval policies.
 */
export const MACHINE_AUTO_ALLOW = [...MACHINE_OPS] as const;

/**
 * Fixed at registration from the trusted user row; `transport` is the raw
 * gateway face, claimed once at boot. Shared with the Workspace Files Object,
 * which reaches the same laptops through the same one implementation.
 */
export interface PreparedRunnerDispatch {
  args: Readonly<Record<string, unknown>>;
  /** Trusted shared-agent routing; accepted only for the closed session-op set below. */
  dispatchOwner?: string;
  /** Runs only after the Runner returned a determinate RPC result. */
  afterResult?: (result: unknown) => void | Promise<void>;
  /** Positive, owner-scoped Sessions+ provenance; never accepted from a View. */
  sessionCatalog?: readonly PreparedSessionCatalogEntry[];
}
export type RunnerDispatchPreparer = (
  owner: string,
  operation: Operation,
  args: Readonly<Record<string, unknown>>,
) => Promise<PreparedRunnerDispatch>;

interface RunnerBinding extends RunnerDispatchBinding {
  /** Runs only inside the adapter, after the Gate allowed this exact call. */
  prepareDispatch?: RunnerDispatchPreparer;
  /** Materialized session data only; this adapter is already post-Gate. */
  projectionReadCache?: RunnerProjectionReadCache;
}

/**
 * Mandatory policy for every Runner Object. Ordinary closed code on purpose: no
 * DSL, no expression language, no manifest-supplied rules, and it never inspects
 * the shell text of an `exec` to guess that it "looks read-only".
 *
 * It is now three decisions, in this order:
 *
 *  1. evidence that a human approved EXACTLY this call → allow;
 *  2. the grant's own terms say it may do this unsupervised → allow;
 *  3. otherwise, ask the owner, with a server-authored summary.
 *
 * What it no longer does is decide by effect class. "Which of my rights may I
 * exercise alone" is a property of the grant (`terms.autoAllow`, attenuating
 * down the derive chain), so changing it for one caller — the chat agent, say —
 * is a change at that caller's `open()`, not a new branch here.
 */
function runnerPolicy(input: PolicyInput): import("@claude-bot/capability-kernel").PolicyDecision {
  const owner = input.object.metadata.owner ?? "";
  if (!owner) return { kind: "deny", reason: "runner object has no bound owner" };

  // Devpipe's CI-machine grant is intentionally narrower than the account
  // Object that backs ordinary owner chat. Context metadata is written by the
  // trusted composition root, never by MCP args. Enforce it before approval or
  // auto-allow so neither mechanism can widen the target back to another device
  // owned by the same account. Device enumeration is also outside this scope:
  // the caller already receives the one configured device name in its prompt.
  const deviceScope = input.context.metadata.runner_device_scope;
  if (deviceScope) {
    if (input.operation === "__list_devices") {
      return { kind: "deny", reason: "device-scoped grant cannot enumerate the account device set" };
    }
    if (String(input.args.device ?? "") !== deviceScope) {
      return { kind: "deny", reason: `grant is scoped to runner device ${deviceScope}` };
    }
  }

  const receiptScope = input.context.metadata.session_receipt_operation;
  if (receiptScope && (input.operation !== "get_session_operation"
    || input.args.operation_id !== receiptScope
    || input.args.device !== input.context.metadata.session_receipt_device)) {
    return { kind: "deny", reason: "receipt grant is bound to one owner operation and device" };
  }

  const a = input.approval;
  if (
    a &&
    a.objectId === input.object.id &&
    a.operation === input.operation &&
    a.argsHash === input.argsHash &&
    a.contextId === input.context.id &&
    a.slot === input.slot &&
    a.approver === owner
  ) {
    return { kind: "allow" };
  }

  if (input.terms.autoAllow.includes(input.operation)) return { kind: "allow" };

  // `device` is present because the schema requires it. The card names the
  // machine the frozen args name, and the gateway refuses if that machine is not
  // the one online when the approval lands — so what is approved is what runs.
  const device = String(input.args.device ?? "本机端点");
  const details: string[] = [];
  if (input.operation === "exec") {
    details.push(`命令：${String(input.args.command ?? "").slice(0, 300)}`);
    if (input.args.cwd) details.push(`工作目录：${String(input.args.cwd).slice(0, 200)}`);
  } else if (input.operation === "write_file") {
    details.push(`路径：${String(input.args.path ?? "").slice(0, 300)}`);
    details.push(`模式：${input.args.append ? "追加" : "覆盖"}`);
    details.push(`内容长度：${String(input.args.content ?? "").length} 字符`);
  } else if (input.operation === "append_session") {
    details.push(`会话：${String(input.args.id ?? "").slice(0, 64)}`);
    if (input.args.configure_continuation === true) {
      details.push("模式：保存这个 Codex 会话的自动续接消息；不启动模型、不发送消息");
      details.push(`续接消息：${String(input.args.continuation_prompt || "继续执行").slice(0, 300)}`);
    } else if (input.args.interrupt === true) {
      // The card cannot know which of the two mechanisms the device will use —
      // that depends on what the session IS when the approval lands. So it
      // states the bound both share: the turn stops, nothing is killed.
      details.push("模式：停止这个会话当前的轮次");
      details.push("托管轮次用供应商原生 interrupt；本机 tmux CLI 只收到一次 Esc 停止键");
      details.push("不会结束 CLI 进程、不会关闭 tmux、不会丢弃会话——停下之后仍可继续对话或续接");
    } else if (input.args.release_control === true) {
      details.push("模式：释放已结束 Codex 轮次残留的独立 app-server 占用");
      details.push("只关闭 Runner 为当前会话启动的精确子进程；共享宿主、本机 tmux 与其他会话不受影响");
      details.push("若设备不能证明轮次已结束且自动关闭失败，这个动作会拒绝");
    } else if (input.args.takeover === true) {
      details.push("模式：立即接管（先中断 Runner 精确识别的本机 CLI，再恢复会话）");
      details.push("注意：被取消轮次已经产生的文件或命令副作用不会自动回滚。");
    } else if (input.args.account_fallback === true) {
      details.push("模式：换备用 Codex 账号并创建新会话");
      details.push("原会话保留；上下文会复制，但 provider 缓存不会跨账号复用。");
      details.push("账号和会话文件路径只由 Runner 在设备本地选择。");
    }
    if (input.args.interrupt !== true && input.args.release_control !== true && input.args.configure_continuation !== true) {
      details.push(`指令：${String(input.args.prompt ?? "").slice(0, 300)}`);
    }
    if (input.args.model) details.push(`模型：${String(input.args.model).slice(0, MACHINE_LIMITS.modelMaxBytes)}`);
    if (input.args.effort) details.push(`Effort：${String(input.args.effort)}`);
    if ((input.args.source === "codex" || input.args.source === "claude") && input.args.permission_profile) {
      const provider = input.args.source === "claude" ? "Claude Code" : "Codex";
      details.push(`${provider} 权限（仅在必须新开托管 attachment 时）：${input.args.permission_profile === "manual" ? "手动确认" : "全通过（完整系统访问）"}`);
    }
  } else if (input.operation === "upload_session_file") {
    details.push(`会话：${String(input.args.id ?? "").slice(0, 64)}`);
    if (input.args.workspace_id) details.push(`执行工作区：${String(input.args.workspace_id).slice(0, 64)}`);
    details.push(`文件：${String(input.args.name ?? "").slice(0, 120)}`);
    details.push(
      `分块：${String(input.args.chunk_index ?? "?")}/${String(input.args.chunk_count ?? "?")}`,
    );
  } else if (input.operation === "start_session") {
    const executionDevice = String(input.args.execution_device ?? device);
    const split = executionDevice !== device;
    // The card names the target in the SAME form the caller used. A card that
    // rendered a registered workspace's label for a typed directory (or the
    // reverse) would be describing a launch that is not the one being approved.
    if (input.args.directory !== undefined && input.args.directory !== "") {
      details.push(`目录：${String(input.args.directory).slice(0, MACHINE_LIMITS.pathMaxBytes)}`);
    } else {
      details.push(
        `工作区：${String(input.args.workspace_label ?? "").slice(0, 120)}`
        + `（${String(input.args.workspace_display ?? "").slice(0, 240)}）`,
      );
    }
    details.push(`Agent 运行机：${device}`);
    if (split) details.push(`命令与文件执行机：${executionDevice}`);
    details.push(`CLI：${String(input.args.source ?? "")}`);
    if (input.args.codex_account) details.push(`Codex 账号：${String(input.args.codex_account).slice(0, 32)}`);
    if (input.args.model) details.push(`模型：${String(input.args.model).slice(0, MACHINE_LIMITS.modelMaxBytes)}`);
    if (input.args.effort) details.push(`Effort：${String(input.args.effort).slice(0, MACHINE_LIMITS.effortMaxBytes)}`);
    if ((input.args.source === "codex" || input.args.source === "claude") && input.args.permission_profile) {
      const provider = input.args.source === "claude" ? "Claude Code" : "Codex";
      details.push(`${provider} 权限：${input.args.permission_profile === "manual" ? "手动确认" : "全通过（完整系统访问）"}`);
    }
    details.push(`指令：${String(input.args.prompt ?? "").slice(0, 300)}`);
    details.push(`请求：${String(input.args.client_request_id ?? "").slice(0, 128)}`);
    details.push(split
      ? "Agent 运行机上的本地命令与文件工具会被关闭；Agent 只能通过会话凭证操作所选执行机。执行命令仍以执行机上你的系统账号运行，不是沙箱。"
      : "这个目录决定新会话的起始位置,但它不是沙箱:CLI 会以该设备上你的系统账号运行,能访问该账号能访问的一切。");
  } else if (input.operation === "open_workspace_terminal") {
    details.push(`工作区：${String(input.args.workspace_id ?? "").slice(0, MACHINE_LIMITS.workspaceIdMaxBytes)}`);
    details.push("本次批准会打开一个真实 shell；该 shell 可以离开起始工作区。");
    details.push("关闭或闲置 30 分钟前，画面刷新、命令输入和关闭不再逐条申请批准。");
  } else if (input.operation === "open_dsh_tunnel") {
    details.push(`本机端口：${String(input.args.port)}`);
    details.push("本次批准会把浏览器流量转发到所选设备的 loopback DSH；DSH 可操作该系统账号可访问的文件和 CLI。");
  } else if (input.args.path !== undefined) {
    // Every remaining path-shaped operation (read_file, list_dir, copy_file):
    // if a grant did not auto-allow it, the owner needs to see WHAT was asked
    // for, not just which verb.
    details.push(`路径：${String(input.args.path).slice(0, 300)}`);
    if (input.args.offset) details.push(`起始字节：${String(input.args.offset)}`);
    if (input.args.cursor) details.push(`续页位置：${String(input.args.cursor).slice(0, 200)} 之后`);
  }
  details.push(`动作类别：${input.effect}`);
  const who = input.context.metadata.purpose ?? input.context.kind;
  details.push(`发起方：${who}`);
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

async function runnerAdapter(
  binding: RunnerBinding,
  operation: Operation,
  args: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  // The gateway-local roster answers without any device being reachable and
  // without a frame leaving the process.
  if (operation === "__list_devices") {
    return { devices: binding.transport.listDevices(binding.owner) };
  }
  if (operation === "open_dsh_tunnel") {
    return { authorized: true };
  }
  const prepared = binding.prepareDispatch
    ? await binding.prepareDispatch(binding.owner, operation, args)
    : { args };
  const dispatchOwner = prepared.dispatchOwner ?? binding.owner;
  if (
    dispatchOwner !== binding.owner
    && operation !== "start_session"
    && operation !== "append_session"
    && operation !== "read_session"
    && operation !== "get_session_operation"
  ) {
    throw new Error("cross-owner Runner routing is restricted to bound Agent session operations");
  }
  const catalog = prepared.sessionCatalog ?? [];
  if (operation === "read_session" && catalog.length) {
    if (catalog.length !== 1) throw new Error("read_session requires one exact Sessions+ catalog row");
    const row = catalog[0];
    const result = await dispatchToRunner(
      { ...binding, owner: row.runtimeOwner },
      "session_plus_read_session",
      {
        ...prepared.args,
        device: row.runtimeDevice,
        source: row.source,
        id: row.sessionId,
        _octopus_session_catalog: [sessionCatalogWireEntry(row)],
      },
    );
    await prepared.afterResult?.(result);
    return result;
  }
  if ((operation === "list_recent_sessions" || operation === "search_sessions") && catalog.length) {
    const result = await dispatchSessionCatalogRoster(binding, operation, prepared.args, catalog);
    await prepared.afterResult?.(result);
    return result;
  }
  // The caller-owned projection cache contains no facts from the provider's
  // account. A borrowed read goes to the authenticated runtime every time.
  // Exact journaled ticket reads use a separate native namespace. The ordinary
  // projection cache has no namespace coordinate, so it cannot serve/store them.
  const cacheableRead = dispatchOwner === binding.owner && prepared.args._octopus_include_session_plus !== true;
  const cached = cacheableRead
    ? binding.projectionReadCache?.read(binding.owner, operation, prepared.args)
    : undefined;
  if (cached?.hit) {
    await prepared.afterResult?.(cached.result);
    return cached.result;
  }
  const wireOperation = operation === "open_workspace_terminal" ? "workspace_terminal" : operation;
  const wireArgs = operation === "open_workspace_terminal" ? { ...prepared.args, action: "open" } : prepared.args;
  const result = await dispatchToRunner({ ...binding, owner: dispatchOwner }, wireOperation, wireArgs, {
    // A lost link during an execute operation means "we do not know whether it
    // ran"; the effect declaration stays on the capability operation even when
    // the wire method is the shared workspace_terminal endpoint.
    indeterminateOnLinkLoss: RUNNER_OPERATIONS[operation]?.effect === "execute",
  });
  assertPagingHonoured(operation, wireArgs, result);
  if (cacheableRead) {
    binding.projectionReadCache?.remember(binding.owner, operation, prepared.args, result);
  }
  await prepared.afterResult?.(result);
  return result;
}

/**
 * A Runner older than windowed reads ignores `offset`/`cursor` and answers
 * from the start; handing that back as a later page would be silently wrong
 * content. Updated Runners echo what they honoured, so an answer without the
 * echo is refused with the reason instead.
 */
export function assertPagingHonoured(
  operation: string,
  args: Readonly<Record<string, unknown>>,
  result: unknown,
): void {
  const answer = result && typeof result === "object" ? result as Record<string, unknown> : {};
  const offset = Number(args.offset ?? 0);
  if (operation === "read_file" && offset > 0 && answer.offset !== offset) {
    throw new Error("该设备的 Runner 版本不支持按 offset 分页读取文件，请先升级 Runner");
  }
  const cursor = typeof args.cursor === "string" ? args.cursor : "";
  if (operation === "list_dir" && cursor && answer.cursor !== cursor) {
    throw new Error("该设备的 Runner 版本不支持按 cursor 分页列目录，请先升级 Runner");
  }
}

/**
 * Add exact split-session reads to an already-authorized roster/search call.
 * Each supplemental frame is pinned to the catalog's authenticated runtime
 * owner + device. Operational failure of one provider is partial absence; if
 * every normal and supplemental source fails, the original error is preserved.
 * Complete-catalog pages must refuse partial reads: advancing their cursor
 * would permanently skip unread rows from the failed source.
 */
async function dispatchSessionCatalogRoster(
  binding: RunnerBinding,
  operation: "list_recent_sessions" | "search_sessions",
  args: Readonly<Record<string, unknown>>,
  catalog: readonly PreparedSessionCatalogEntry[],
): Promise<unknown> {
  const requestedSource = String(args.source ?? "all");
  const exact = args.ids === undefined ? null
    : new Set(decodeSessionIds(args.ids).map((row) => `${row.source}:${row.id}`));
  const selected = catalog.filter((row) => (requestedSource === "all" || row.source === requestedSource)
    && (typeof args.device !== "string" || row.runtimeDevice === args.device)
    && (!exact || exact.has(`${row.source}:${row.sessionId}`)));
  if (!selected.length) {
    const cached = operation === "list_recent_sessions"
      ? binding.projectionReadCache?.read(binding.owner, operation, args)
      : undefined;
    if (cached?.hit) return cached.result;
    return await dispatchToRunner(binding, operation, { ...args });
  }

  const baseCached = operation === "list_recent_sessions"
    ? binding.projectionReadCache?.read(binding.owner, operation, args)
    : undefined;
  const calls: Array<Promise<{ kind: "base"; result: unknown } | {
    kind: "supplement";
    device: string;
    catalog: readonly PreparedSessionCatalogEntry[];
    result: unknown;
  }>> = [baseCached?.hit
    ? Promise.resolve({ kind: "base", result: baseCached.result })
    : dispatchToRunner(binding, operation, { ...args }).then((result) => ({ kind: "base", result }))];
  const wireOperation = operation === "list_recent_sessions"
    ? "session_plus_list_sessions"
    : "session_plus_search_sessions";
  const callDevices: string[] = [];
  for (const group of groupSessionCatalogEntries(selected)) {
    const first = group[0];
    callDevices.push(first.runtimeDevice);
    calls.push(dispatchToRunner(
      { ...binding, owner: first.runtimeOwner },
      wireOperation,
      {
        ...args,
        device: first.runtimeDevice,
        source: first.source,
        _octopus_session_catalog: group.map(sessionCatalogWireEntry),
      },
    ).then((result) => ({
      kind: "supplement" as const,
      device: first.runtimeDevice,
      catalog: group,
      result,
    })));
  }

  const settled = await Promise.allSettled(calls);
  if (operation === "list_recent_sessions" && typeof args.cursor === "string"
    && settled.some((item) => item.status === "rejected")) {
    throw new Error("部分会话来源读取失败，未推进翻页位置，请重试");
  }
  let base: unknown;
  const supplements: SessionCatalogSupplement[] = [];
  const failed: string[] = [];
  for (const [index, item] of settled.entries()) {
    if (item.status !== "fulfilled") {
      failed.push(index === 0 ? (typeof args.device === "string" ? args.device : "runner") : callDevices[index - 1]!);
      continue;
    }
    if (item.value.kind === "base") base = item.value.result;
    else supplements.push({
      device: item.value.device,
      catalog: item.value.catalog,
      result: item.value.result,
    });
  }
  if (base === undefined && !supplements.length) {
    const failure = settled.find((item): item is PromiseRejectedResult => item.status === "rejected");
    throw failure?.reason instanceof Error ? failure.reason : new Error("所有 Runner 均未响应");
  }
  return operation === "list_recent_sessions"
    ? mergeSessionCatalogList(base, supplements, args)
    : mergeSessionCatalogSearch(base, supplements, args, failed);
}

/**
 * A narrow, closable authority over one account's Runner.
 *
 * The body is in `SlotGrant`, shared with the bot host's scan home: the four
 * methods are pure forwarding onto the kernel's own facade, and having two
 * copies of them would mean two places where "close vs destroy" could drift.
 * What this subclass fixes is the slot — a caller never names one.
 */
export class SessionReceiptQueryError extends Error {
  constructor(readonly failure: "authorization_revoked" | "transport_unavailable" | "internal", message: string) {
    super(message); this.name = "SessionReceiptQueryError";
  }
}

export class RunnerGrant extends SlotGrant {
  constructor(svc: CapabilityService, contextId: ContextId, purpose: string, owner: string, borrowed = false) {
    super(svc, contextId, RUNNER_SLOT, purpose, owner, borrowed);
  }
}

export { ApprovalRequiredError as RunnerApprovalRequired } from "./account-authority.js";

/**
 * What a device credential change was.
 *
 * `minted` covers first registration and re-minting alike: from the point of
 * view of anything holding authority over "this account's laptops", replacing a
 * credential and adding one are the same event — the set the authority was
 * issued against is no longer the set that exists.
 */
export interface RunnerTargetSetEvent {
  username: string;
  device: string;
  reason: "minted" | "revoked";
}

/**
 * A trusted listener over the account's device set.
 *
 * ── Why this registry exists ───────────────────────────────────────────────
 *
 * The Runner Object revokes its device branch and broad roster root when a credential changes,
 * which is what makes "removing a laptop removes access to it" true for it. The
 * moment a second Object (`workspace-files-runner-v2`) depends on the same
 * device set, that guarantee stops covering the system: the Workspace Files root
 * would survive a device replacement, and a scope opened against the old set
 * would keep answering.
 *
 * The alternative — having every resource re-derive its own answer from the
 * store — is the shape where one of them forgets. So the door that changes a
 * credential announces it, and the announcement is part of the operation rather
 * than a notification after it.
 *
 * ── The contract a listener signs ──────────────────────────────────────────
 *
 * It must be SYNCHRONOUS in the only sense that matters: by the time it returns,
 * no grant covering the changed device may still be usable. Releasing what is
 * already open (cancelling streams, closing sockets) may continue afterwards —
 * that is the same "record the decision, then dismantle" ordering the permission
 * centre uses — but a call arriving after the listener returned must already be
 * refused.
 *
 * ── Exactly what a failure blocks, and what it does not ────────────────────
 *
 * A listener that throws SYNCHRONOUSLY costs availability: `mintDeviceToken`
 * propagates and no NEW credential is written. That is the fail-closed
 * direction, and it is the reason the announcement happens before the write.
 *
 * It is NOT a promise that every kind of teardown failure blocks a credential
 * change, and claiming otherwise would be worse than claiming nothing. A
 * listener that hands its release to something asynchronous — the provider
 * catalog does exactly this — has already returned by then, so a provider whose
 * `close()` later rejects is logged and swallowed and the token is minted. That
 * is the right outcome: the safety property is "nothing new can start", it was
 * established synchronously, and the scope is unreachable either way. What a
 * rejected release costs is a leaked file handle, not authority.
 */
export type RunnerTargetSetListener = (event: RunnerTargetSetEvent) => void;

export interface RunnerCapabilitiesOptions {
  /** Injectable for tests. */
  now?: () => number;
  pendingTtlMs?: number;
  /** Durable home for contexts, capabilities and pending calls. */
  store?: import("@claude-bot/capability-kernel").CapabilityStore;
  /**
   * Share ONE capability service with the rest of the process. The v3 Host's
   * plane derives App/Controller/AgentRun Contexts from the same Runner Object
   * this adapter registers, and they cannot be two services: a Context in one
   * is meaningless to the other.
   */
  service?: CapabilityService;
  /**
   * Compatibility hook for trusted deployments. The owner root now permits its
   * whole closed operation table; every child `open()` still has to name the
   * operation in its own `autoAllow` terms.
   */
  extraRootAutoAllow?: (username: string) => readonly Operation[];
  /** Post-Gate materialized session read path; never stores authorization. */
  projectionReadCache?: RunnerProjectionReadCache;
}

/**
 * Control plane for Runner capabilities. One per process; constructed at boot
 * with the raw transport claimed from the gateway, and never handed to app,
 * controller or agent code.
 */
export class RunnerCapabilities {
  private svc: CapabilityService;
  /**
   * The account root and the pooled Contexts derived from it, in the shared
   * implementation (`account-authority.ts`) that the bot host's scan home also
   * uses. What stays HERE is what is Runner-specific: the two trusted facts
   * that decide whether this account holds anything (below), the device
   * credential lifecycle, and the transport.
   *
   * Pooling is not an optimisation, it is a correctness fix (P1-3) — see
   * `AccountAuthority.derive`.
   */
  private authority: AccountAuthority<RunnerBinding>;
  /**
   * Planes that hold authority over this account's device set, and therefore
   * have to be closed down when a credential changes. Empty in a deployment
   * that composes nothing else, which is why the Runner's own revocation is
   * still done directly rather than through this list.
   */
  private readonly targetSetListeners = new Set<RunnerTargetSetListener>();
  private dispatchPreparer: RunnerDispatchPreparer | null = null;
  private readonly guiAutomation: RunnerGuiAutomationCapabilities;

  constructor(
    private storeFull: Store,
    private transport: RunnerTransport,
    opts: RunnerCapabilitiesOptions = {},
  ) {
    this.svc =
      opts.service
      ?? new CapabilityService({
        now: opts.now,
        pendingTtlMs: opts.pendingTtlMs,
        store: opts.store,
        audit: (r: AuditRecord) => auditToLog(r),
      });
    this.authority = new AccountAuthority<RunnerBinding>({
      service: this.svc,
      slot: RUNNER_SLOT,
      objectPrefix: RUNNER_ACCOUNT_OBJECT_PREFIX,
      kind: "runner-account",
      operations: RUNNER_OPERATIONS,
      policy: runnerPolicy,
      scopeAllows: (device, input) => input.args.device === device
        && (input.args.execution_device === undefined || input.args.execution_device === device),
      adapter: runnerAdapter as ObjectDefinition<RunnerBinding>["adapter"],
      now: opts.now,
      rootAutoAllow: (username) => [
        ...Object.keys(RUNNER_OPERATIONS),
        ...(opts.extraRootAutoAllow?.(username) ?? []),
      ],
      /**
       * Two trusted facts, re-read on every single use:
       *
       *  1. the user row exists — an account that was deleted holds nothing;
       *  2. at least one device token is registered — an account with no device
       *     has no Runner to hold authority over, so there is nothing to be the
       *     root OF.
       *
       * Returning null does not merely refuse: `AccountAuthority` revokes
       * whatever root is still standing, because "you may no longer do this"
       * and "the grants you already took out are dead" have to be the same
       * event. That is the entire mechanism by which removing a laptop removes
       * access to it.
       */
      bindingFor: (name) =>
        this.storeFull.getUser(name)
          && this.storeFull.listRunnerTokens(name).some((row) => !row.device.startsWith("dsh:"))
          ? {
              owner: name,
              transport: this.transport,
              prepareDispatch: (owner, operation, args) =>
                this.dispatchPreparer ? this.dispatchPreparer(owner, operation, args) : Promise.resolve({ args }),
              ...(opts.projectionReadCache ? { projectionReadCache: opts.projectionReadCache } : {}),
            }
          : null,
      onWarning: (message, fields) => log.warn(fields, message),
    });
    this.guiAutomation = new RunnerGuiAutomationCapabilities(this.storeFull, this.transport, this.svc, {
      now: opts.now,
    });
  }
  /**
   * Install the one post-Gate launch augmentation seam. The returned closure
   * removes only the same registration, so shutdown cannot erase a replacement.
   */
  installDispatchPreparer(preparer: RunnerDispatchPreparer): () => void {
    if (this.dispatchPreparer) throw new Error("Runner dispatch preparer is already installed");
    this.dispatchPreparer = preparer;
    return () => {
      if (this.dispatchPreparer === preparer) this.dispatchPreparer = null;
    };
  }


  /**
   * Derive a narrow Context for one trusted lifecycle event and return its
   * grant. `rights` is the intersection the control plane decided; nothing
   * downstream can widen it.
   *
   * Returns null when the user is unknown — that is a fail-closed answer, not
   * an error to fall back from.
   */
  open(opts: {
    username: string;
    purpose: string;
    kind: "controller-run" | "agent-run" | "job" | "app-instance" | "session";
    rights: readonly Operation[];
    /**
     * Which of `rights` this grant may exercise WITHOUT a per-call approval.
     *
     * Omitted preserves the historical `observe`/`read` default. Trusted
     * owner-local surfaces name execute/modify operations explicitly; the
     * kernel intersects that ask with the owner's root terms.
     *
     * This is where "should the agent be able to read any file it likes?" is
     * answered. Not in the policy, and not by effect class — by the code that
     * decides to hand out this particular authority.
     */
    autoAllow?: readonly Operation[];
    metadata?: Record<string, string>;
    /** A durable independently revocable device branch. */
    device?: string;
    /** Derive from another grant instead of the account root (chained runs). */
    parent?: RunnerGrant;
    /**
     * Reuse one Context for this (user, surface) instead of deriving a new one
     * per call — for callers whose "lifecycle" is a browser surface rather than a
     * run, i.e. anything driven by individual HTTP requests.
     *
     * Give it the surface, not the request: `"dashboard-append"`, not the session
     * id being appended to. What makes two calls the same PendingCall is the
     * kernel's (context, slot, operation, argsHash) — so sharing a Context is
     * what lets a re-submitted identical action join the card that already
     * exists, while two genuinely different actions still get their own.
     *
     * Grants borrowed from the pool ignore `close()`: the pool owns the lifetime.
     */
    pool?: string;
  }): RunnerGrant | null {
    const username = String(opts.username ?? "").trim();
    // The parent grant's owner is checked HERE rather than in the shared
    // authority: "a chained run may only chain off its own account" is a Runner
    // rule about `RunnerGrant`, and the shared class does not know that type.
    if (opts.parent && opts.parent.owner !== username) return null;
    const device = opts.device ?? opts.metadata?.runner_device_scope;
    if (device && !this.storeFull.listRunnerTokens(username).some((row) => row.device === device)) return null;
    const derived = this.authority.derive({
      username,
      purpose: opts.purpose,
      kind: opts.kind,
      rights: opts.rights,
      // Never inherit a newly-added dangerous root term merely because a
      // caller omitted this option.  The historical default is preserved for
      // observe/read operations; modify/execute requires an explicit child
      // request even when an operator deliberately raised the root ceiling.
      autoAllow:
        opts.autoAllow
        ?? opts.rights.filter((operation) => {
          const effect = RUNNER_OPERATIONS[operation]?.effect;
          return effect === "observe" || effect === "read";
        }),
      metadata: opts.metadata,
      parentContext: opts.parent?.contextId,
      scope: device,
      pool: opts.pool,
    });
    if (!derived) return null;
    return new RunnerGrant(this.svc, derived.contextId, opts.purpose, username, derived.borrowed);
  }


  /** Trusted recovery seam: no request-supplied device, foreign owner, or execute right. */
  async querySessionOperation(owner: string, operationId: string): Promise<unknown> {
    const row = this.storeFull.getSessionOperation(operationId, owner);
    if (!row || row.runner_operation_id !== operationId) throw new Error("session receipt has no owned durable intent");
    const target = receiptTargetOf(row);
    if (!target) throw new Error("session receipt has no exact runtime binding");
    const grant = this.open({ username: owner, purpose: "session-input-receipt", kind: "job",
      rights: ["get_session_operation"], autoAllow: ["get_session_operation"],
      ...(target.owner === owner ? { device: row.device } : {}),
      metadata: { session_receipt_operation: operationId, session_receipt_device: row.device } });
    if (!grant) throw new SessionReceiptQueryError("authorization_revoked", "session receipt target is no longer authorized");
    try {
      const out = await grant.request("get_session_operation", { device: row.device, operation_id: operationId });
      if (out.status === "succeeded") return out.result;
      if (out.status === "denied" || out.status === "approval_required") {
        throw new SessionReceiptQueryError("authorization_revoked", "原操作回执的读取授权已结束；不会重复请求审批");
      }
      throw new SessionReceiptQueryError(this.transport.listDevices(target.owner).some(device => device.device === row.device && device.online) ? "internal" : "transport_unavailable", out.reason);
    }
    finally { grant.destroy(); }
  }

  /**
   * Drop this user's pooled Contexts NOW, hard — the teardown half of a
   * revocation. `surface` narrows to one pool prefix, which is how ending ONE
   * browser login closes exactly that login's Contexts. See
   * `AccountAuthority.dropPooled` for why it is hard rather than deferred.
   */
  dropPooled(username: string, surface?: string): number {
    return this.authority.dropPooled(username, surface);
  }

  /** Test/diagnostics: how many pooled Contexts are held. */
  get pooledContexts(): number {
    return this.authority.pooledContexts;
  }

  /**
   * Make sure this user's Runner Object exists and their account authority is
   * minted, without deriving anything. The trusted control plane calls it
   * before it tells another component "this user holds that Object" — claiming
   * authority over an Object nobody registered turns a missing device into an
   * exception instead of a refusal.
   */
  ensureAccount(username: string): boolean {
    const account = this.accountAuthority(username) !== null;
    const gui = this.guiAutomation.ensureAccount(username);
    return account && gui;
  }

  /**
   * Broad roster authority for trusted planes that cover all owned devices.
   * A device lifecycle change invalidates this root. Callers selecting exactly
   * one device should use open({ device }) for independent revocation.
   *
   * Server-only: this is not reachable from any request path.
   */
  accountAuthority(username: string): { contextId: ContextId; slot: string } | null {
    const a = this.authority.authorityFor(username);
    return a ? { contextId: a.context, slot: RUNNER_SLOT } : null;
  }

  /**
   * Revoke a whole account's Runner authority. Called when the user row goes
   * away: every device branch and broad roster grant dies with it (ancestry check, next call). It works from the
   * durable root list, so it is still correct in a process that never minted
   * the root it is killing.
   */
  revokeAccount(username: string): void {
    this.authority.revokeAccount(username);
    this.guiAutomation.revokeAccount(username);
  }

  /**
   * A device was removed or its token re-minted. Kick the socket, drop the
   * device and broad roster authority, and tell other dependent planes:
   * the target set the Object is bound to just changed, and a grant issued
   * against the old set is no longer a description of reality.
   *
   * Throws if a listener refused to close down — see `RunnerTargetSetListener`
   * for why that has to reach the caller instead of being logged.
   */
  deviceRevoked(username: string, device: string, reason: RunnerTargetSetEvent["reason"] = "revoked"): void {
    this.transport.disconnect(username, device);
    this.authority.revokeScope(username, device);
    this.guiAutomation.revokeDevice(username, device);
    this.announceTargetSetChanged({ username, device, reason });
    log.info({ username, device, reason, revocationScope: "device-and-broad-roster" }, "runner device authority retired");
  }

  /**
   * Register a plane that holds authority over this account's device set.
   *
   * Trusted composition only: it is reachable from the boot wiring and from
   * nothing that starts in a request. Returns an unsubscribe function so a test
   * (and one day a hot-swapped provider) can detach without a second registry.
   */
  onTargetSetChanged(listener: RunnerTargetSetListener): () => void {
    this.targetSetListeners.add(listener);
    return () => {
      this.targetSetListeners.delete(listener);
    };
  }

  /**
   * Subscribe to content-free change hints for one fixed owner. This grants no
   * read authority: consumers must use their existing capability to refresh.
   */
  onSessionChanged(username: string, listener: (device: string) => void): () => void {
    return this.transport.subscribeSessionChanges?.((owner, device) => {
      if (owner === username) listener(device);
    }) ?? (() => {});
  }

  /**
   * Every listener is attempted, and then the first synchronous failure is
   * raised.
   *
   * Both halves are deliberate. Attempting all of them means one broken plane
   * cannot leave the others holding authority over a device set that changed;
   * raising afterwards means the caller — which is about to write a NEW
   * credential — does not get to proceed as if the teardown had not happened.
   *
   * Only what a listener does BEFORE it returns can be raised here. A listener
   * that starts an asynchronous release has already succeeded by this
   * definition, and that is the correct reading: what must hold at this instant
   * is that nothing new can start.
   */
  private announceTargetSetChanged(event: RunnerTargetSetEvent): void {
    const failures: unknown[] = [];
    for (const listener of [...this.targetSetListeners]) {
      try {
        listener(event);
      } catch (err) {
        failures.push(err);
        log.error({ err, ...event }, "runner target-set listener failed; credential change refused");
      }
    }
    if (failures.length === 0) return;
    const first = failures[0];
    throw new Error(
      `设备凭据变更未完成：${failures.length} 个受影响的资源平面没有关闭`
      + `（${first instanceof Error ? first.message : String(first)}）`,
    );
  }

  // ── trusted approval face ──

  listPending(approver: string): PendingView[] {
    return this.svc.listPending(approver);
  }

  getPending(id: string, approver: string): PendingView | null {
    return this.svc.getPending(id, approver);
  }

  async approve(pendingCallId: string, approver: string): Promise<InvokeResult> {
    return await this.svc.approve(pendingCallId, approver);
  }

  reject(pendingCallId: string, approver: string): boolean {
    return this.svc.reject(pendingCallId, approver);
  }

  /** The shared service, for the trusted control plane that composes it. */
  get service(): CapabilityService {
    return this.svc;
  }

  /**
   * Mint a device token THROUGH the capability layer — the ONLY way a stored
   * device credential comes into existence.
   *
   * The ordering is the security content, and it used to be backwards: the new
   * row was written first and the old authority revoked second. A crash — or
   * just a throw — in between left the OLD capability root and the OLD socket
   * live while a REPLACEMENT credential already existed, which is the one state
   * this operation must never produce.
   *
   * So the old credential dies first, as a fact of the store:
   *
   *   1. delete the old (user, device) row — the previous token stops
   *      authenticating, and `authorityFor` re-reads the registry on every use;
   *   2. revoke affected device/roster roots, close the socket, and tell other planes
   *      bound to this device set to close down (it throws if one refuses
   *      SYNCHRONOUSLY — see `RunnerTargetSetListener` for what that does and
   *      does not promise);
   *   3. only then persist the replacement.
   *
   * A failure after (1) or (2) costs availability — the user re-mints — and
   * cannot leave old authority standing next to a new credential. Note the
   * order also matters WITHIN step 1-3: writing the new row before revoking
   * would let the next `authorityFor` see a registered device and mint a fresh
   * root that the old, still-connected socket could use. Step (2) covers the
   * OTHER planes for exactly the same reason — a Workspace Files scope that
   * outlived the credential it was authorised against is the same defect one
   * Object over.
   */
  mintDeviceToken(username: string, device: string): string {
    // The initiator policy is user-managed state, not credential state.  The
    // fail-safe delete below cascades it temporarily, so retain it only across
    // a fully successful rotation.  If revocation or persistence fails, the
    // device stays absent and closed rather than leaving detached authority.
    const policy = this.storeFull.getRunnerDevicePolicy(username, device);
    this.storeFull.deleteRunnerToken(username, device);
    this.deviceRevoked(username, device, "minted");
    const token = newRunnerTokenPlaintext();
    this.storeFull.saveRunnerToken(hashRunnerToken(token), username, device, new Date().toISOString());
    if (policy) {
      this.storeFull.setRunnerLocalAgentBridgeMode(
        username,
        device,
        policy.local_agent_bridge_mode,
        policy.updated_at,
        policy.updated_by,
      );
      this.storeFull.setRunnerDefaultAgentInjection(
        username,
        device,
        policy.default_agent_injection === 1,
        policy.updated_at,
        policy.updated_by,
      );
      this.storeFull.setRunnerGuiAutomationEnabled(
        username,
        device,
        policy.gui_automation_enabled === 1,
        policy.updated_at,
        policy.updated_by,
      );
    }
    return token;
  }

  /**
   * Remove a device token through the same door, in the same fail-safe order:
   * the credential stops authenticating first, then the authority and the
   * socket go. Dropping the row while the connection stays inside the Object's
   * target set is not a revocation, and neither is closing a socket that can
   * reconnect with a token that still works.
   */
  revokeDeviceToken(username: string, device: string): boolean {
    const existed = this.storeFull.deleteRunnerToken(username, device);
    this.deviceRevoked(username, device);
    // A deleted or self-uninstalled guest is gone; a later device of the same
    // name starts as an ordinary enrollment. A rotation (mint) keeps it.
    this.storeFull.deleteRunnerGuestProfile?.(username, device);
    return existed;
  }

  /** Presence only: never a Runner RPC, so it carries no user data. */
  listDevices(username: string): RunnerDeviceStatus[] {
    return this.transport.listDevices(username);
  }

  /** The device is online and lists and reads sessions only (`RUNNER_ALLOW_MACHINE_OPS=0`). */
  isReadOnly(username: string, device: string): boolean {
    return this.transport.isReadOnly?.(username, device) ?? false;
  }

  isOnline(username: string): boolean {
    return this.transport.isOnline(username);
  }

  async ping(username: string, device: string): Promise<number | null> {
    return await this.transport.ping(username, device);
  }

  /** Device removed: kick the socket so it leaves the Object's target set now. */
  disconnectDevice(username: string, device: string): boolean {
    return this.transport.disconnect(username, device);
  }

  /** Persisted policy is authoritative; this only accelerates convergence for an online Runner. */
  setDefaultAgentInjection(username: string, device: string, enabled: boolean): boolean {
    return this.transport.setDefaultAgentInjection?.(username, device, enabled) ?? false;
  }

  listGuiAutomationTargets(username: string): RunnerGuiAutomationTarget[] {
    return this.guiAutomation.listTargets(username);
  }

  async openGuiAutomation(input: {
    username: string;
    controllerDevice: string;
    targetDevice: string;
  }): Promise<import("./gateway.js").RunnerLocalAgentBridgeLease> {
    return await this.guiAutomation.open(input);
  }

  setGuiAutomationEnabled(
    username: string,
    device: string,
    enabled: boolean,
    updatedAt: string,
    updatedBy: string,
  ): RunnerGuiAutomationToggleResult {
    return this.guiAutomation.setEnabled(username, device, enabled, updatedAt, updatedBy);
  }
}

function auditToLog(r: AuditRecord): void {
  const base = {
    ctx: r.contextKind,
    purpose: r.contextMetadata.purpose,
    owner: r.contextMetadata.owner,
    slot: r.slot,
    op: r.operation,
    args: r.argsHash.slice(0, 16),
    approver: r.approver,
    pending: r.pendingCallId,
  };
  if (r.decision === "deny") log.warn({ ...base, reason: r.reason }, "capability denied");
  else if (r.decision === "approval_required") log.info(base, "capability needs approval");
  else if (r.outcome) log.debug({ ...base, outcome: r.outcome, ms: r.durationMs }, "capability executed");
}
