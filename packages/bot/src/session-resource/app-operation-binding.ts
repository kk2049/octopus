/** Trusted binding from declarative Session Plus actions to durable operations. */

import type { RuntimeJson } from "@claude-bot/app-runtime";
import {
  AGENT_PERMISSION_PROFILES,
  isAgentEffort,
  type AgentPermissionProfile,
} from "@claude-bot/agent-sessions-contract";
import type {
  SessionProjectionRef,
  SessionResourceOperationInput,
  WorkspaceProjectionRef,
} from "./operation-executor.js";
import {
  SessionOperationCoordinator,
  type SessionOperationView,
} from "../sessionhub/operations.js";
import { decodeResourceId, resourceId } from "../sessionhub/core.js";
import type { SessionPlusInstanceBinding, SessionPlusPrincipal } from "../app-core/instance.js";
import type { Source as ScanSource } from "@claude-bot/plugin-sessions/scan";
import { SESSION_CLI_KINDS } from "../sessionhub/core.js";
import type { BorrowedRuntimeResult } from "../agent-credits/service.js";
import { publicAgentDiagnosticDetail } from "@claude-bot/runner/inventory";

export const SESSION_PLUS_OPERATION_ACTIONS = [
  "start_session",
  "append_session",
  "resume_session",
  "takeover_session",
  "fallback_session",
  "interrupt_session",
  "release_session_control",
] as const;

export type SessionPlusOperationAction = (typeof SESSION_PLUS_OPERATION_ACTIONS)[number];

export type BoundOperationResult =
  | { ok: true; operation: SessionPlusOperationView }
  | { ok: false; status: number; error: string };

/**
 * The operation projection that may cross into publisher-controlled code.
 *
 * In particular, the kernel PendingCall id and the authenticated owner stay in
 * the trusted shell. The View only needs a durable operation id and status in
 * order to explain what is happening; neither value grants authority.
 */
export interface SessionPlusOperationView {
  input?: SessionOperationView["input"];
  recovery?: { state: "reconnecting" | "waiting_resource"; since: string; retry_at: string | null };
  id: string;
  resourceId: string;
  device: string;
  cliKind: string;
  sessionId: string;
  operation: string;
  status: SessionOperationView["status"];
  detail?: string;
  newSessionId?: string;
  /** Opaque resource for a newly started or provider-replaced session; absent before success. */
  newResourceId?: string;
  submittedAt: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
  live: boolean;
  message: string;
}

/** Accepted means tracked by this operation id; it is never a completion receipt. */
export function sessionOperationReceipt(operation: SessionPlusOperationView) {
  return { opId: operation.id, status: operation.status, message: operation.message };
}

/**
 * The View may name only an action and opaque selections. This object rebinds
 * those selections on the trusted side — from the resource id the trusted side
 * itself minted for a session, and from the tab's own workspace projection for
 * a launch target. Labels, device identity, CLI kind and session id are never
 * reflected from the proposal's own fields into a Gate call.
 */
export class SessionPlusOperationBinding {
  constructor(
    private readonly coordinator: SessionOperationCoordinator,
    private readonly sharedRuntimes: { resolveAlias(owner: string, alias: string): BorrowedRuntimeResult } | null = null,
    private readonly surface: import('../sessionhub/operations.js').OperationSurface = 'app:session-plus',
  ) {}

  async submit(
    binding: SessionPlusInstanceBinding,
    principal: SessionPlusPrincipal,
    action: SessionPlusOperationAction,
    params: Readonly<Record<string, string>>,
  ): Promise<BoundOperationResult> {
    const input = bindInput(binding, action, params, this.sharedRuntimes);
    if (!input.ok) return input;
    const submitted = await this.coordinator.submit(
      this.surface,
      {
        username: principal.owner,
        admin: false,
        session: principal.session,
        credential: principal.credential,
      },
      input.value,
    );
    return submitted.ok
      ? { ok: true, operation: publicOperation(submitted.operation) }
      : { ok: false, status: submitted.status, error: submitted.error };
  }

  list(owner: string): SessionPlusOperationView[] {
    return this.coordinator
      // Session Plus is also the owner's session monitor. Hub/MCP-triggered
      // writes must enter the same public operation stream so an already-open
      // page can discover a provider pause without a blind roster poll.
      .list(owner, { limit: 100 })
      .map(publicOperation);
  }

  subscribe(owner: string, listener: (operation: SessionPlusOperationView) => void): () => void {
    return this.coordinator.subscribe(owner, (operation) => listener(publicOperation(operation)));
  }

  endContexts(owner: string, contextIds: readonly string[], reason?: string): number {
    return this.coordinator.endContexts(owner, contextIds, reason);
  }
}

export function publicOperation(operation: SessionOperationView): SessionPlusOperationView {
  const navigableSessionId = operation.operation === "start_session"
    ? operation.sessionId
    : operation.operation === "append_session"
      || operation.operation === "resume_session"
      || operation.operation === "takeover_session"
      || operation.operation === "fallback_session"
      ? operation.newSessionId
      : "";
  const newResourceId = operation.status === "succeeded" && navigableSessionId
    ? resourceId({
        owner: operation.owner,
        device: operation.device,
        cliKind: operation.cliKind,
        sessionId: navigableSessionId,
      })
    : "";
  return {
    id: operation.id,
    resourceId: operation.resourceId,
    device: operation.device,
    cliKind: operation.cliKind,
    sessionId: operation.sessionId,
    operation: operation.operation,
    status: operation.status,
    ...(operation.input ? { input: operation.input } : {}),
    ...(operation.recovery ? { recovery: { state: operation.recovery.state,
      since: operation.recovery.since, retry_at: operation.recovery.retry_at } } : {}),
    ...(operation.detail ? { detail: operation.detail } : {}),
    ...(operation.newSessionId ? { newSessionId: operation.newSessionId } : {}),
    ...(newResourceId ? { newResourceId } : {}),
    submittedAt: operation.submittedAt,
    ...(operation.startedAt ? { startedAt: operation.startedAt } : {}),
    ...(operation.finishedAt ? { finishedAt: operation.finishedAt } : {}),
    updatedAt: operation.updatedAt,
    live: operation.live,
    message: operation.message,
  };
}

/** Only bounded public inventory facts become a launch refusal, never raw Runner errors. */
function unavailableBackendMessage(device: string, source: ScanSource, backend?: Record<string, unknown>): string {
  const prefix = `${device} 的 ${source}`;
  // The owner's own device may name the offending local path; re-validated, never echoed raw.
  const detail = publicAgentDiagnosticDetail({ path: backend?.diagnosticPath, rule: backend?.diagnosticRule });
  const where = detail ? `（${detail.path}，${detail.rule}）` : "";
  if (backend?.diagnosticCode === "unsafe_permissions") {
    return `${prefix} 已找到，但被本机安装权限检查拒绝${where}。该检查防止程序被其他本机用户替换。请在该设备运行 octopus-runner agents list，按 detail/recovery 核对程序、解释器及上级目录的所有者和写权限。个人安装只移除不必要的写权限；共享安装确需保留时，由设备主人用 agents bind 的 --trust-installation 显式信任。不要递归改权限；世界可写路径仍拒绝。修复后重新检查，约一分钟后刷新设备资产。`;
  }
  if (backend?.reason === "authentication_unavailable") {
    return `${prefix} 已安装，但没有可用登录态；请检查 Runner 使用的 Codex 账号登录状态`;
  }
  if (backend?.reason === "command_unavailable" || backend?.diagnosticCode === "command_unavailable") {
    return `${prefix} 命令未被 Runner 找到；请在该设备运行 octopus-runner agents list 检查安装位置`;
  }
  if (backend?.diagnosticCode === "interpreter_unavailable") {
    return `${prefix} 已找到，但缺少可用解释器${where}；请在该设备运行 octopus-runner agents list 检查解释器安装`;
  }
  if (backend?.reason === "probe_failed" || backend?.diagnosticCode) {
    return `${prefix} 未通过本机程序探测${where}；请在该设备运行 octopus-runner agents list 查看原因`;
  }
  return `${device} 当前没有可用的 ${source} Agent 后端；请刷新设备资产`;
}

function bindInput(
  binding: SessionPlusInstanceBinding,
  action: SessionPlusOperationAction,
  params: Readonly<Record<string, string>>,
  sharedRuntimes: { resolveAlias(owner: string, alias: string): BorrowedRuntimeResult } | null = null,
): { ok: true; value: SessionResourceOperationInput } | { ok: false; status: number; error: string } {
  const prompt = String(params.prompt ?? "");
  const promptless = action === "interrupt_session" || action === "release_session_control";
  if (!promptless && !prompt.trim()) {
    return { ok: false, status: 400, error: "请输入要交给本地 Agent 的指令" };
  }

  if (action === "start_session") {
    const source = SESSION_CLI_KINDS.includes(params.source as ScanSource)
      ? params.source as ScanSource
      : null;
    const device = String(params.device ?? "").trim();
    // Manifest normalization materializes every absent optional string as "".
    // Treat that wire form as colocated placement; only a non-empty value may
    // name a distinct Agent runtime.
    const selectedRuntimeDevice = String(params.runtime_device ?? "").trim() || device;
    if (!source || !device || !selectedRuntimeDevice) {
      return { ok: false, status: 400, error: "请选择执行设备、Agent 设备与 CLI" };
    }
    const permissionProfile = bindPermissionProfile(params.permission_profile);
    if (permissionProfile === false) {
      return { ok: false, status: 400, error: "Agent 权限档位无效" };
    }
    // The bilingual lane exists on Claude only. Asking for it on another
    // provider is a View that does not match this trusted side, not a request
    // to silently start something else.
    const translatePrompt = String(params.translate_prompt ?? "") === "true";
    if (translatePrompt && source !== "claude") {
      return { ok: false, status: 400, error: "只有 Claude 支持中英双语车道" };
    }

    // ── Two ways for a View to name where to start, and one of them is new ───
    //
    // `directory` is what the person typed. Nothing in the projection can
    // confirm it — that is the point: it is a path on THEIR machine, and only
    // that machine can say whether it exists. So the trusted side does not
    // pretend to validate it against a list; it bounds the string, freezes it
    // into the approval card verbatim, and lets the device adjudicate after the
    // click. The device name is likewise not authority: the gateway resolves it
    // inside this owner's own connection set, so a name that is not one of
    // their devices simply cannot be reached.
    //
    // `workspace_id` remains, unchanged, because an OLDER release's View sends
    // only that — including after a rollback — and it must keep working.
    const directory = String(params.directory ?? "");
    const workspaceParam = String(params.workspace_id ?? "");
    const root = object(binding.projection);
    const placementDevices = array(object(root.placement).devices);
    const runtime = placementDevices.find((entry) => String(entry.device ?? "") === selectedRuntimeDevice);
    const execution = placementDevices.find((entry) => String(entry.device ?? "") === device);
    const codexAccount = String(params.codex_account ?? "");
    if (codexAccount && (source !== "codex" || !/^(?:@default|[A-Za-z0-9_-]{1,32})$/.test(codexAccount)
      || !array(runtime?.codexAccounts).some((account) => account.id === codexAccount))) {
      return { ok: false, status: 409, error: "所选 Codex 账号未在当前运行机登记；请刷新后重新选择" };
    }
    const shared = runtime?.sharedAgentRuntime === true;
    const resolvedShared = shared
      ? sharedRuntimes?.resolveAlias(binding.owner, selectedRuntimeDevice)
        ?? { ok: false as const, status: 403 as const, error: "共享 Agent 运行机当前不可用" }
      : null;
    if (resolvedShared && !resolvedShared.ok) {
      return { ok: false, status: resolvedShared.status, error: resolvedShared.error };
    }
    const runtimeDevice = resolvedShared?.ok ? resolvedShared.runtime.device : selectedRuntimeDevice;
    const split = shared || runtimeDevice !== device;
    const runtimeBackend = array(runtime?.agentBackends)
      .find((entry) => String(entry.kind ?? "") === source);
    if (runtime && runtime.online !== true) {
      return { ok: false, status: 409, error: `${selectedRuntimeDevice} 当前离线；请检查 Runner 连接后刷新设备资产` };
    }
    if (runtime && runtimeBackend?.available !== true) {
      return { ok: false, status: 409, error: unavailableBackendMessage(selectedRuntimeDevice, source, runtimeBackend) };
    }
    if (split && runtimeBackend?.splitExecution !== true) {
      return {
        ok: false,
        status: 409,
        error: runtimeBackend?.splitExecutionReason === "local_tools_unfilterable"
          ? `${source} 当前不能关闭 Agent 机器上的本机工具，不能与执行工作区分机`
          : `${selectedRuntimeDevice} 没有报告 ${source} 的安全跨机器执行能力`,
      };
    }
    if (split) {
      const executionFacts = object(execution?.execution);
      if (!workspaceParam) {
        return { ok: false, status: 400, error: "跨机器启动必须选择已登记工作区，不能使用任意目录" };
      }
      if (!runtime || !execution || execution.online !== true) {
        return { ok: false, status: 409, error: "设备资产已经变化；请刷新后重新选择运行与执行设备" };
      }
      if (source === "codex" && executionFacts.codexExecServer !== true) {
        return { ok: false, status: 409, error: `${device} 没有报告 Codex exec-server 执行能力` };
      }
      if (executionFacts.shell !== true || executionFacts.workspaceFiles !== true) {
        return { ok: false, status: 409, error: `${device} 没有报告远程命令与工作区文件能力` };
      }
    }
    if (directory && workspaceParam) {
      // Refused rather than resolved by precedence, at every layer that sees
      // both (here, the executor, the device). The approval card names ONE
      // target; a rule that silently picks a winner is a rule under which the
      // card and the working directory can disagree.
      return { ok: false, status: 400, error: "只能指定目录或已登记工作区其中一个" };
    }
    if (directory) {
      return {
        ok: true,
        value: {
          instanceId: binding.id,
          action,
          source,
          prompt,
          runtimeDevice,
          ...(codexAccount ? { codexAccount } : {}),
          ...(resolvedShared?.ok
            ? { borrowedRuntime: { owner: resolvedShared.runtime.owner, resourceId: resolvedShared.runtime.resourceId } }
            : {}),
          target: { kind: "directory", device, directory },
          ...(params.model ? { model: params.model } : {}),
          ...(params.effort ? { effort: params.effort } : {}),
          ...(permissionProfile ? { permissionProfile } : {}),
          ...(translatePrompt ? { translatePrompt: true } : {}),
        },
      };
    }


    const byDevice = object(root.workspacesByDevice);
    const projected = object(byDevice[device] ?? root.workspaces);
    const row = array(projected.workspaces).find((entry) => String(entry.id ?? "") === workspaceParam);
    if (String(projected.device ?? "") !== device || !row) {
      return {
        ok: false,
        status: 409,
        error: "工作区列表已经变化；请重新选择设备并刷新工作区，或直接填写目录",
      };
    }
    const workspace: WorkspaceProjectionRef = {
      device,
      id: String(row.id ?? ""),
      label: String(row.label ?? ""),
      display: String(row.display ?? ""),
    };
    return {
      ok: true,
      value: {
        instanceId: binding.id,
        action,
        source,
        runtimeDevice,
        ...(codexAccount ? { codexAccount } : {}),
        ...(resolvedShared?.ok
          ? { borrowedRuntime: { owner: resolvedShared.runtime.owner, resourceId: resolvedShared.runtime.resourceId } }
          : {}),
        prompt,
        target: { kind: "workspace", workspace },
        ...(params.model ? { model: params.model } : {}),
        ...(params.effort ? { effort: params.effort } : {}),
        ...(permissionProfile ? { permissionProfile } : {}),
        ...(translatePrompt ? { translatePrompt: true } : {}),
      },
    };
  }

  // ── Why the roster frame is not what binds a write (ticket #208) ──────────
  //
  // The session id, device and CLI kind come from the resource id, which the
  // trusted side minted from exactly those three fields plus the owner, and
  // whose owner is re-checked here against this instance's own owner. The
  // executor decodes it again before any Gate call, so a proposal still cannot
  // name a target of its own.
  //
  // They used to come from the row for this resource in the LATEST roster
  // frame, and that quietly made "continue this conversation" conditional on
  // the session still being one of the ~200 most recently active rows. A page
  // legitimately keeps showing an older session — the chat retains the last
  // known row precisely because absence is not deletion, and `read_session`
  // still serves its transcript from this same id — so the write was refused
  // with "the list changed; refresh and pick again", naming the one remedy
  // that cannot work: refreshing returns the same truncated window, and the
  // row that aged out never comes back.
  const resource = String(params.resource ?? "");
  const decoded = decodeResourceId(resource);
  if (!decoded || decoded.owner !== binding.owner || !decoded.device) {
    return { ok: false, status: 400, error: "这个会话标识无效或不属于当前账户；请重新选择会话" };
  }
  // A roster row is still not REQUIRED to write (#208), but a current row may
  // carry an explicit provider prohibition. Multi-agent v2 thread-spawn
  // children belong to their parent; turning a direct-input proposal into a
  // copied/forked conversation would change the target's identity. Old or
  // truncated projections fall through to the Runner, which independently
  // rejects `canAcceptDirectInput: false` before prompt ownership transfers.
  const projected = array(object(binding.projection).sessions)
    .find((entry) => String(entry.resourceId ?? "") === resource);
  if (projected?.inputMode === "parent_owned" && action !== "release_session_control") {
    return {
      ok: false,
      status: 409,
      error: "这个 Codex 子 Agent 由父 Agent 管理，不能从外部直接输入；请打开父 Agent，由它继续或唤醒子 Agent。",
    };
  }
  const session: SessionProjectionRef = {
    resourceId: resource,
    deviceId: decoded.device,
    cliKind: decoded.cliKind,
    sessionId: decoded.sessionId,
  };
  const suppliedPermissionProfile = bindPermissionProfile(params.permission_profile);
  if (suppliedPermissionProfile === false) {
    return { ok: false, status: 400, error: "Agent 权限档位无效" };
  }
  // For append this is a conditional fallback, not an override: the device
  // inherits a still-live attachment/CLI, but applies the frozen profile if
  // that owner disappears before execution and it must open managed control.
  const permissionProfile = promptless ? "" : suppliedPermissionProfile;
  const suppliedModel = bindModel(params.model);
  if (suppliedModel === false) {
    return { ok: false, status: 400, error: "model 无效" };
  }
  const model = promptless ? "" : suppliedModel;
  const suppliedEffort = bindEffort(session.cliKind, params.effort);
  if (suppliedEffort === false) {
    return { ok: false, status: 400, error: `${session.cliKind} effort 无效` };
  }
  const effort = promptless ? "" : suppliedEffort;
  return { ok: true, value: {
    instanceId: binding.id,
    action,
    ...(promptless ? {} : { prompt }),
    session,
    ...(permissionProfile ? { permissionProfile } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  } };
}

function bindPermissionProfile(value: string | undefined): AgentPermissionProfile | "" | false {
  if (value === undefined || value === "") return AGENT_PERMISSION_PROFILES.fullAccess;
  return value === AGENT_PERMISSION_PROFILES.fullAccess || value === AGENT_PERMISSION_PROFILES.manual
    ? value
    : false;
}

function bindModel(value: string | undefined): string | "" | false {
  if (value === undefined || value === "") return "";
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(value) ? value : false;
}

function bindEffort(source: ScanSource, value: string | undefined): string | "" | false {
  if (value === undefined || value === "") return "";
  return isAgentEffort(source, value) ? value : false;
}

function object(value: RuntimeJson | undefined): Record<string, RuntimeJson> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, RuntimeJson>
    : {};
}

function array(value: RuntimeJson | undefined): Array<Record<string, RuntimeJson>> {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, RuntimeJson> => (
        Boolean(entry) && typeof entry === "object" && !Array.isArray(entry)
      ))
    : [];
}
