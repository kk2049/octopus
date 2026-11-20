/**
 * Session Plus write adapter for the shared durable operation coordinator.
 *
 * This module does not decide permissions. It selects the runner plane already
 * bound to one App instance, opens a ControllerRun, and asks the same kernel
 * Gate used by every other Runner caller. The only state it owns is a ticket:
 * one narrow run plus one lease from the Session Hub's shared single-writer
 * registry.
 */

import { createHash } from "node:crypto";
import { sessionOperationReceiptFromWire } from "@claude-bot/runner/gateway-protocol";
import {
  AGENT_PERMISSION_PROFILES,
  isAgentEffort,
  type AgentPermissionProfile,
} from "@claude-bot/agent-sessions-contract";
import type { ControllerRun } from "@claude-bot/engine";
import type { PermissionService } from "../permissions/service.js";
import {
  BOT_HOST_DEVICE,
  appendFingerprint,
  decodeResourceId,
  dispatchObserved,
  resourceId,
} from "../sessionhub/core.js";
import type { LeaseHandle, SessionLeases } from "../sessionhub/lease.js";
import type {
  OperationExecutor,
  OperationHooks,
  OperationIntent,
  OperationOutcome,
  OperationRefusal,
  OperationTicket,
} from "../sessionhub/operations.js";
import type { HubPrincipal } from "../sessionhub/service.js";
import { launchDirectoryProblem } from "@claude-bot/runner/directories";
import { AppAuthorityBundles } from "./bundle.js";
import type { Source as ScanSource } from "@claude-bot/plugin-sessions/scan";
import { SESSION_CLI_KINDS } from "../sessionhub/core.js";

export interface SessionProjectionRef {
  resourceId: string;
  deviceId: string;
  cliKind: ScanSource;
  sessionId: string;
}

export interface WorkspaceProjectionRef {
  device: string;
  id: string;
  label: string;
  display: string;
}

/**
 * Where a launch starts, in exactly one of the two supported forms.
 *
 * `workspace` is a row the View picked out of the trusted projection, so its
 * label and display text are evidence the person already saw. `directory` is a
 * path the person TYPED, so the evidence is the string itself — which is why
 * the approval card renders it verbatim and the Runner resolves that same
 * string rather than anything derived from it here.
 */
export type LaunchTarget =
  | { kind: "workspace"; workspace: WorkspaceProjectionRef }
  | { kind: "directory"; device: string; directory: string };

export type SessionResourceOperationInput =
  | {
      instanceId: string;
      action: "start_session";
      source: ScanSource;
      /** Physical Runner that hosts the provider process; old callers imply target.device. */
      runtimeDevice?: string;
      codexAccount?: string;
      /** Canonical cross-owner routing, resolved by trusted code from a projected alias. */
      borrowedRuntime?: { owner: string; resourceId: string };
      /** Trusted-host launch policy; never accepted from the untrusted View. */
      launchMode?: "independent_cli";
      prompt: string;
      target: LaunchTarget;
      model?: string;
      effort?: string;
      permissionProfile?: AgentPermissionProfile;
      /** Claude's bilingual lane; absent is the plain lane. */
      translatePrompt?: boolean;
    }
  | {
      instanceId: string;
      action: "append_session" | "resume_session" | "takeover_session" | "fallback_session" | "interrupt_session" | "release_session_control";
      prompt?: string;
      session: SessionProjectionRef;
      permissionProfile?: AgentPermissionProfile;
      model?: string;
      effort?: string;
    };

interface SessionResourceOperationTicket extends OperationTicket {
  action: SessionResourceOperationInput["action"];
  args: Record<string, unknown>;
  lease?: LeaseHandle;
  run: ControllerRun;
}

export class SessionResourceOperationExecutor implements OperationExecutor<
  SessionResourceOperationInput,
  SessionResourceOperationTicket
> {
  constructor(
    private readonly bundles: AppAuthorityBundles,
    private readonly permissions: Pick<PermissionService, "audit">,
    private readonly leases: SessionLeases,
    private readonly now: () => number = Date.now,
    /** A reviewed project binding may delegate a fixed resource. Never set by a View. */
    private readonly delegated?: (principal: HubPrincipal, input: SessionResourceOperationInput) => boolean,
  ) {}

  describe(
    principal: HubPrincipal,
    input: SessionResourceOperationInput,
  ): { ok: true; intent: OperationIntent } | OperationRefusal {
    const bundle = this.bundles.get(String(input?.instanceId ?? ""));
    if (!bundle || (this.delegated ? !this.delegated(principal, input) : !principal.session || principal.username !== bundle.owner)) {
      return { ok: false, status: 403, error: "当前 App 实例没有可用于这个操作的账户权限" };
    }
    const controlOnly = input.action === "interrupt_session" || input.action === "release_session_control";
    if (controlOnly && (
      input.permissionProfile !== undefined
      || input.model !== undefined
      || input.effort !== undefined
    )) {
      return {
        ok: false,
        status: 400,
        error: input.action === "interrupt_session"
          ? "停止轮次不接受 Agent 权限档位、模型或 effort"
          : "放锁动作不接受 Agent 权限档位、模型或 effort",
      };
    }
    const prompt = controlOnly ? "" : validPrompt(input?.prompt);
    if (!controlOnly && !prompt) return { ok: false, status: 400, error: "请输入要交给本地 Agent 的指令" };

    if (input.action === "start_session") {
      if (input.codexAccount && (input.source !== "codex" || !/^(?:@default|[A-Za-z0-9_-]{1,32})$/.test(input.codexAccount))) {
        return { ok: false, status: 400, error: "Codex 账号选择无效" };
      }
      const target = validTarget(input.target);
      const runtimeDevice = validDevice(input.runtimeDevice ?? target?.device);
      const borrowedRuntime = validBorrowedRuntime(input.borrowedRuntime);
      const model = validModel(input.model);
      const effort = validEffort(input.source, input.effort);
      const permissionProfile = validPermissionProfile(input.source, input.permissionProfile, true);
      const launchMode = validLaunchMode(input.launchMode);
      if (permissionProfile === false) {
        return { ok: false, status: 400, error: "Agent 权限档位无效" };
      }
      if (input.translatePrompt === true && input.source !== "claude") {
        return { ok: false, status: 400, error: "只有 Claude 支持中英双语车道" };
      }
      if (
        !target
        || !runtimeDevice
        || (input.borrowedRuntime !== undefined && borrowedRuntime === false)
        || (target.args.directory && (runtimeDevice !== target.device || Boolean(borrowedRuntime)))
        || !SESSION_CLI_KINDS.includes(input.source)
        || model === false
        || effort === false
        || launchMode === false
      ) {
        return { ok: false, status: 400, error: targetRefusal(input.target) };
      }
      // Runtime and execution placement are both intent identity. Omitting
      // either would deduplicate launches across different machine boundaries.
      const fingerprint = startFingerprint(
        input.source,
        prompt || "",
        runtimeDevice,
        target.device,
        target.key,
        model || "",
        effort || "",
        permissionProfile || "",
        launchMode || "",
        // Two launches that differ only by lane are two different intents.
        // Without this they would dedupe onto one approval card and the second
        // choice would silently inherit the first one's lane.
        input.translatePrompt === true ? "bilingual" : "",
        borrowedRuntime ? `${borrowedRuntime.owner}:${borrowedRuntime.resourceId}` : "",
        input.codexAccount ?? "",
      );
      return {
        ok: true,
        intent: {
          owner: bundle.owner,
          resourceId: startResourceId(bundle.owner, runtimeDevice, target.device, input.source, target.key),
          device: runtimeDevice,
          cliKind: input.source,
          sessionId: "",
          operation: "start_session",
          fingerprint,
        },
      };
    }

    const session = validSession(bundle.owner, input.session);
    if (!session) return { ok: false, status: 400, error: "请选择当前列表中的可续跑会话" };
    if (input.action === "fallback_session" && session.cliKind !== "codex") {
      return { ok: false, status: 400, error: "只有 Codex 会话支持账号切换续跑" };
    }
    if (input.action === "release_session_control" && session.cliKind !== "codex") {
      return { ok: false, status: 400, error: "只有 Codex 会话可能持有可手动释放的 app-server 占用" };
    }
    if (session.deviceId === BOT_HOST_DEVICE) {
      return { ok: false, status: 400, error: "bot 主机扫描到的会话是只读的；请使用对应设备上的 Runner" };
    }
    const permissionProfile = validPermissionProfile(session.cliKind, input.permissionProfile, false);
    if (permissionProfile === false) return { ok: false, status: 400, error: "Agent 权限档位无效" };
    const model = validModel(input.model);
    if (model === false) return { ok: false, status: 400, error: "model 无效" };
    const effort = validEffort(session.cliKind, input.effort);
    if (effort === false) return { ok: false, status: 400, error: `${session.cliKind} effort 无效` };
    return {
      ok: true,
      intent: {
        owner: bundle.owner,
        resourceId: session.resourceId,
        device: session.deviceId,
        cliKind: session.cliKind,
        sessionId: session.sessionId,
        // `resume_session` is a UI alias. Persisted permission and Gate identity
        // stay the one six-word contract token.
        operation: input.action === "takeover_session"
          ? "takeover_session"
          : input.action === "fallback_session"
            ? "fallback_session"
            : input.action === "interrupt_session"
              ? "interrupt_session"
              : input.action === "release_session_control" ? "release_session_control" : "append_session",
        // A takeover may cancel an in-flight CLI turn. It must never join an
        // ordinary append merely because the prompt text happens to match.
        fingerprint: appendFingerprint(
          input.action,
          session.cliKind,
          prompt || "",
          permissionProfile || undefined,
          effort || undefined,
          model || undefined,
        ),
      },
    };
  }

  prepare(
    principal: HubPrincipal,
    input: SessionResourceOperationInput,
    operationId: string,
  ): { ok: true; ticket: SessionResourceOperationTicket } | OperationRefusal {
    const described = this.describe(principal, input);
    if (!described.ok) return described;
    const intent = described.intent;
    const bundle = this.bundles.get(input.instanceId);
    if (!bundle?.runnerContextId) {
      this.audit(intent.owner, intent.operation, "runner", "deny", "runner plane unavailable");
      return { ok: false, status: 403, error: "当前实例没有可用的 Runner 权限；请检查端点与 App 授权" };
    }

    const leaseSessionId = intent.operation === "start_session"
      ? `launch:${intent.fingerprint}`
      : intent.sessionId;
    let lease: LeaseHandle | undefined;
    if (input.action !== "interrupt_session" && input.action !== "release_session_control") {
      const taken = this.leases.acquire(
        {
          owner: intent.owner,
          device: intent.device,
          cliKind: intent.cliKind,
          sessionId: leaseSessionId,
        },
        `session-plus/${input.action} · ${intent.owner}`,
        intent.fingerprint,
        principal.credential,
      );
      if (!taken.ok) {
        this.audit(intent.owner, intent.operation, intent.resourceId, "deny", "busy");
        return { ok: false, status: 409, error: taken.message, pendingCallId: taken.pendingCallId };
      }
      lease = taken.lease;
    }

    const run = this.bundles.openController(input.instanceId, "runner", input.action);
    if (!run) {
      if (lease) this.leases.release(lease);
      this.audit(intent.owner, intent.operation, intent.resourceId, "deny", "no authority context");
      return { ok: false, status: 403, error: "App 权限已变化，请刷新页面后重试" };
    }

    let args: Record<string, unknown>;
    if (input.action === "start_session") {
      const target = validTarget(input.target);
      // `describe` already refused an invalid target, so this cannot be null.
      // Asserted rather than assumed: a `!` on a target that produced the Gate
      // hash would be a launch nobody described.
      if (!target) {
        if (lease) this.leases.release(lease);
        run.close();
        return { ok: false, status: 400, error: targetRefusal(input.target) };
      }
      const runtimeDevice = validDevice(input.runtimeDevice ?? target!.device)!;
      const selectedModel = validModel(input.model);
      const selectedEffort = validEffort(input.source, input.effort);
      const permissionProfile = validPermissionProfile(input.source, input.permissionProfile, true);
      const launchMode = validLaunchMode(input.launchMode);
      args = {
        // Gateway routing is the runtime machine. Execution is separately
        // named in the approved args and never inferred after the Gate.
        device: runtimeDevice,
        execution_device: target.device,
        ...target.args,
        source: input.source,
        prompt: validPrompt(input.prompt)!,
        ...(input.codexAccount ? { codex_account: input.codexAccount } : {}),
        ...(selectedModel ? { model: selectedModel } : {}),
        ...(selectedEffort ? { effort: selectedEffort } : {}),
        ...(permissionProfile ? { permission_profile: permissionProfile } : {}),
        ...(input.translatePrompt === true ? { translate_prompt: true } : {}),
        ...(launchMode ? { _octopus_launch_mode: launchMode } : {}),
        client_request_id: operationId,
        ...(!launchMode ? { operation_id: operationId, input_receipt: true } : {}),
        ...(input.borrowedRuntime
          ? {
              _octopus_runtime_owner: input.borrowedRuntime.owner,
              _octopus_runtime_resource_id: input.borrowedRuntime.resourceId,
            }
          : {}),
      };
    } else {
      const permissionProfile = validPermissionProfile(input.session.cliKind, input.permissionProfile, false);
      const model = validModel(input.model);
      const effort = validEffort(input.session.cliKind, input.effort);
      args = {
        device: input.session.deviceId,
        operation_id: operationId,
        input_receipt: true,
        id: input.session.sessionId,
        source: input.session.cliKind,
        ...(input.action === "interrupt_session" || input.action === "release_session_control"
          ? input.action === "interrupt_session" ? { interrupt: true } : { release_control: true }
          : {
              prompt: validPrompt(input.prompt)!,
              ...(input.action === "takeover_session" ? { takeover: true } : {}),
              ...(input.action === "fallback_session" ? { account_fallback: true } : {}),
              ...(permissionProfile ? { permission_profile: permissionProfile } : {}),
              ...(model ? { model } : {}),
              ...(effort ? { effort } : {}),
            }),
      };
    }
    return {
      ok: true,
      ticket: {
        ...intent,
        ...(typeof args.operation_id === "string" ? { runnerOperationId: operationId } : {}),
        ...(input.action === "start_session" && input.borrowedRuntime
          ? { receiptTarget: input.borrowedRuntime } : {}),
        contextId: String(bundle.runnerContextId),
        action: input.action,
        args,
        ...(lease ? { lease } : {}),
        run,
      },
    };
  }

  async run(ticket: SessionResourceOperationTicket, hooks?: OperationHooks): Promise<OperationOutcome> {
    const started = this.now();
    let dispatched = false;
    try {
      const gateOperation = ticket.operation === "takeover_session"
        || ticket.operation === "fallback_session"
        || ticket.operation === "interrupt_session"
        || ticket.operation === "release_session_control"
        ? "append_session"
        : ticket.operation;
      const call = ticket.run.caps.request("resources", gateOperation, ticket.args);
      if (await dispatchObserved(call)) {
        dispatched = true;
        // The App action has now crossed the same trusted Gate as the legacy
        // Hub surface. Ordinary append/resume messages may continue into the
        // Runner attachment while its turn is active; disruptive ownership or
        // account-switch operations deliberately keep their exclusive lease.
        if (ticket.lease && ticket.operation === "append_session") {
          this.leases.handoff(ticket.lease);
        }
        hooks?.onDispatched?.(ticket.contextId);
      }
      const out = await call;
      if (out.status === "approval_required") {
        if (ticket.lease) this.leases.bindPending(ticket.lease, out.pendingCallId);
        this.audit(ticket.owner, ticket.operation, ticket.resourceId, "pending", out.pendingCallId);
        hooks?.onPending?.(out.pendingCallId, ticket.contextId);
        return {
          ok: false,
          status: 202,
          approvalRequired: true,
          pendingCallId: out.pendingCallId,
          error: ticket.operation === "start_session"
            ? "新会话会在你批准后才启动；批准前设备上什么也不会发生。"
            : ticket.operation === "release_session_control"
              ? "后台占用会在你批准后才释放；批准前控制者不会改变。"
            : "这条指令会在你批准后才提交；批准前设备上什么也不会发生。",
        };
      }

      if (ticket.lease) this.leases.release(ticket.lease);
      if (out.status !== "succeeded") {
        this.audit(ticket.owner, ticket.operation, ticket.resourceId, "deny", out.reason);
        return {
          ok: false,
          status: out.status === "denied" ? 403 : out.status === "unknown" ? 504 : 502,
          error: out.reason,
          ...(out.status === "unknown" ? { indeterminate: true } : {}),
        };
      }
      const interpreted = this.interpret(out.result, ticket);
      this.audit(
        ticket.owner,
        ticket.operation,
        ticket.resourceId,
        interpreted.ok ? "result" : interpreted.indeterminate ? "unknown" : "error",
        interpreted.ok ? `${this.now() - started}ms` : interpreted.error,
      );
      return interpreted.ok ? { ...interpreted, durationMs: this.now() - started } : interpreted;
    } catch (error) {
      if (ticket.lease) this.leases.release(ticket.lease);
      const message = error instanceof Error ? error.message : String(error);
      this.audit(ticket.owner, ticket.operation, ticket.resourceId, dispatched ? "unknown" : "error", message);
      return {
        ok: false,
        status: dispatched ? 504 : 502,
        error: message,
        ...(dispatched ? { indeterminate: true } : {}),
      };
    } finally {
      ticket.run.close();
    }
  }

  interpret(result: unknown, intent: OperationIntent): OperationOutcome {
    const row = record(result);
    if (intent.runnerOperationId && row.protocol !== undefined) {
      const receipt = sessionOperationReceiptFromWire(result, intent.runnerOperationId);
      return receipt ? { ok: true, result, receipt } : { ok: false, status: 504, indeterminate: true,
        error: "Runner 返回了不属于这次提交的操作回执；不会自动重发。" };
    }
    if (row.ok === false) {
      const unknown = row.code === "unknown";
      return {
        ok: false,
        status: unknown ? 504 : row.code === "unsupported_cli_version" ? 422 : 502,
        error: typeof row.error === "string" ? row.error : "本地 CLI 执行失败",
        ...(unknown ? { indeterminate: true } : {}),
      };
    }
    if (intent.operation === "start_session") {
      const sessionId = typeof row.session_id === "string" ? row.session_id.trim() : "";
      if (!sessionId || sessionId.length > 200) {
        return {
          ok: false,
          status: 504,
          indeterminate: true,
          error: "Runner 没有返回可验证的会话 id；不会自动重发，请刷新会话列表核对。",
        };
      }
      return { ok: true, result, sessionId };
    }
    return {
      ok: true,
      result,
      ...(typeof row.new_session_id === "string" ? { newSessionId: row.new_session_id } : {}),
    };
  }

  discard(ticket: SessionResourceOperationTicket): void {
    if (ticket.lease) this.leases.release(ticket.lease);
    ticket.run.close();
  }

  releasePending(pendingCallId: string): void {
    this.leases.releaseByPending(pendingCallId);
  }

  private audit(
    owner: string,
    operation: string,
    resource: string,
    decision: string,
    reason?: string,
  ): void {
    this.permissions.audit({
      owner,
      subjectType: "app",
      subjectId: this.bundles.profile.app,
      operation,
      resource: resource.slice(0, 512),
      decision,
      reason: reason ?? null,
    });
  }
}

function validPrompt(value: unknown): string | null {
  // Required text here; the capability schema owns the shared prompt byte budget.
  return typeof value === "string" && value.trim() ? value : null;
}

/** One resolved target: how to address it, how to name it, how to hash it. */
interface ResolvedTarget {
  device: string;
  /** Identity for the fingerprint and the resource id. Never a canonical path. */
  key: string;
  args: Record<string, string>;
}

function validTarget(value: LaunchTarget | undefined): ResolvedTarget | null {
  if (!value || typeof value !== "object") return null;
  if (value.kind === "workspace") {
    const workspace = validWorkspace(value.workspace);
    if (!workspace) return null;
    return {
      device: workspace.device,
      key: `ws:${workspace.id}`,
      args: {
        workspace_id: workspace.id,
        workspace_label: workspace.label,
        workspace_display: workspace.display,
      },
    };
  }
  if (value.kind !== "directory") return null;
  const device = String(value.device ?? "").trim();
  const directory = typeof value.directory === "string" ? value.directory : "";
  // The SAME syntax rule the device applies, imported rather than restated:
  // two spellings of "which paths are acceptable" would mean a card can be
  // approved for a request the device then refuses, after the click.
  if (!device || device.length > 64 || launchDirectoryProblem(directory)) return null;
  return { device, key: `dir:${directory}`, args: { directory } };
}

function validDevice(value: unknown): string | null {
  const device = typeof value === "string" ? value.trim() : "";
  return device && device.length <= 64 ? device : null;
}

function targetRefusal(target: LaunchTarget | undefined): string {
  if (target?.kind === "directory") {
    const problem = launchDirectoryProblem(target.directory);
    if (problem) return problem;
  }
  return "设备、目录或 CLI 选择无效";
}

function validWorkspace(value: WorkspaceProjectionRef): WorkspaceProjectionRef | null {
  if (!value || typeof value !== "object") return null;
  const device = String(value.device ?? "").trim();
  const id = String(value.id ?? "");
  const label = String(value.label ?? "").trim();
  const display = String(value.display ?? "").trim();
  if (
    !device || device.length > 64
    || !/^ws_[0-9a-f]{24}$/.test(id)
    || !label || label.length > 120
    || !display || display.length > 240
  ) return null;
  return { device, id, label, display };
}

function validSession(owner: string, value: SessionProjectionRef): SessionProjectionRef | null {
  if (!value || typeof value !== "object") return null;
  const decoded = decodeResourceId(String(value.resourceId ?? ""));
  if (
    !decoded
    || decoded.owner !== owner
    || decoded.device !== value.deviceId
    || decoded.cliKind !== value.cliKind
    || decoded.sessionId !== value.sessionId
    || resourceId(decoded) !== value.resourceId
  ) return null;
  return { ...value };
}

function startFingerprint(
  source: string,
  prompt: string,
  runtimeDevice: string,
  executionDevice: string,
  targetKey: string,
  model: string,
  effort: string,
  permissionProfile: string,
  launchMode: string,
  lane: string,
  borrowedRuntime: string,
  codexAccount: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify([
      "start_session",
      source,
      runtimeDevice,
      executionDevice,
      targetKey,
      model,
      effort,
      permissionProfile,
      launchMode,
      lane,
      borrowedRuntime,
      ...(codexAccount ? [codexAccount] : []),
      prompt,
    ]), "utf8")
    .digest("hex");
}

function validBorrowedRuntime(
  value: { owner: string; resourceId: string } | undefined,
): { owner: string; resourceId: string } | "" | false {
  if (value === undefined) return "";
  const owner = typeof value.owner === "string" ? value.owner.trim() : "";
  const resourceId = typeof value.resourceId === "string" ? value.resourceId.trim() : "";
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/.test(owner)
    || !/^agent-runtime:[0-9a-f]{32}$/.test(resourceId)
  ) return false;
  return { owner, resourceId };
}

function validLaunchMode(value: unknown): "independent_cli" | "" | false {
  if (value === undefined || value === "") return "";
  return value === "independent_cli" ? value : false;
}

function validPermissionProfile(
  source: unknown,
  value: unknown,
  defaultFullAccess: boolean,
): AgentPermissionProfile | "" | false {
  if (!SESSION_CLI_KINDS.includes(source as ScanSource)) return false;
  // omp's only managed transport cannot prompt for approval at all, so
  // offering the manual profile there would promise a review step that can
  // never happen. The device refuses it too; refusing here keeps the App's
  // control surface from ever showing an option that must fail.
  if (source === "omp" && value === AGENT_PERMISSION_PROFILES.manual) return false;
  if (value === undefined || value === "") {
    return defaultFullAccess ? AGENT_PERMISSION_PROFILES.fullAccess : "";
  }
  return value === AGENT_PERMISSION_PROFILES.fullAccess || value === AGENT_PERMISSION_PROFILES.manual
    ? value
    : false;
}

function validModel(value: unknown): string | false {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(value)) return false;
  return value;
}

function validEffort(source: unknown, value: unknown): string | false {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") return false;
  return isAgentEffort(source, value) ? value : false;
}

function startResourceId(
  owner: string,
  runtimeDevice: string,
  executionDevice: string,
  source: string,
  targetKey: string,
): string {
  return `spr_${createHash("sha256")
    .update(JSON.stringify([owner, runtimeDevice, executionDevice, source, targetKey]), "utf8")
    .digest("base64url")}`;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
