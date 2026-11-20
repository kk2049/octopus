import { ticketResourceOwner } from "./ticket-workspaces.js";
import { transferTicketAttachments } from "../attachments/runner-transfer.js";
import { resolveTicketExecution, ticketExecutionOptions, withoutDiagnosticPaths } from "./ticket-execution.js";
import { cliFamilyForModel } from "./ticket-models.js";
import { SESSION_OPERATION_PROTOCOL, sessionOperationReceiptFromWire, type SessionOperationReceipt as Receipt } from "@claude-bot/runner/gateway-protocol";
import type { RunnerCapabilities } from "../runner/capability.js";
import { RUNNER_OPERATIONS } from "../runner/capability.js";
import type { PermissionService } from "../permissions/service.js";
import { defineOperationCatalog, type SubjectCatalogEntry } from "../permissions/catalog.js";
import type { TicketRunnerBinding, TicketRunnerTurn } from "../store/repositories/ticket-runner.js";
import { ResourceUnavailableError, resourceTransportFailure, runnerResource } from "../resources/recovery.js";

export const TICKET_RUNNER_OPERATIONS = ["start_session", "append_session", "get_session_operation", "read_session", "upload_session_file"] as const;
export const TICKET_RUNNER_SUBJECT: SubjectCatalogEntry = {
  info: { type: "service", id: "ticket-runner", title: "工单 Runner", publisher: "first-party", enforced: true,
    description: "工单使用所有者授权的 Runner 启动、继续和停止 Agent；明确列入共享策略的开发者可使用限定工作区提交工单。只读取该工单的会话及执行结果。" },
  userManaged: true,
  catalog: defineOperationCatalog("ticket-runner", TICKET_RUNNER_OPERATIONS.map((id) => ({
    id, runner: id, title: RUNNER_OPERATIONS[id].title ?? id,
    description: "工单只通过主人授权的 Runner 处理会话；不会获得服务主机权限。",
    risk: RUNNER_OPERATIONS[id].effect === "read" ? "读取私密内容" : "执行命令",
    effect: RUNNER_OPERATIONS[id].effect,
    alwaysApprove: false, mayAutoAllow: true,
  }))),
};
export interface TicketRunnerTarget {
  /**
   * Exact ticket-only allowlist. General session workspace registrations remain
   * intact. The entry marked `default` (at most one) is preselected for new
   * tickets and used when a ticket names no workspace, even while offline;
   * without a mark the first available entry is (else the first entry).
   */
  workspaces?: Array<{ device: string; workspace_id: string; label?: string; default?: boolean }>;
  device: string;
  workspace_id: string;
  /** Explicit provider tool profile; omission retains the Runner default. */
  permission_profile?: "manual" | "full_access";
  /** Trusted operator instructions naming explicit remote source/tool targets. */
  instructions?: string;
}
export interface TicketRunnerConfig {
  targets: Record<string, TicketRunnerTarget>;
  /** Ticket-only operator delegation; it never grants general session/file access. */
  shared_pool?: { owner: string; requesters: string[]; source_devices: string[];
    /** Use current trusted ticket capability, including contributors; no username snapshot. */
    all_developers?: boolean;
    /** Shared scope is intersected with the owner's current target roots. */
    workspaces?: Array<{ device: string; workspace_id: string }>;
    /** Shared tickets keep the model on its source device and every tool in the shared workspace. */
    split_only?: boolean;
    /** Earlier name of `split_only`. It never shares Claude: that requires `claude_devices`. */
    split_codex_only?: boolean;
    /** Fixed package membership, changed only by an explicit operator edit. */
    codex_accounts?: Array<{ device: string; account: string }>;
    /** Devices whose Claude Code login is shared. Claude is not shared without an explicit entry. */
    claude_devices?: string[];
  };
  /** Explicit initial owner policy, seeded once; later revocations survive restart. */
  initial_grants?: Record<string, { operations: string[]; auto_allow?: string[] }>;
  /** Exact historical host attribution, used for old transcript reads only. */
  legacy_host?: { owner: string; device: string };
}

/** Import explicitly configured initial policy without claiming browser consent.
 * Existing owner decisions always win, including a revoked or narrowed grant.
 */
export function seedTicketRunnerGrants(config: TicketRunnerConfig, permissions: PermissionService): void {
  for (const [owner, grant] of Object.entries(config.initial_grants ?? {})) {
    if (!config.targets[owner]) throw new Error("Runner ticket grant requires an explicit owner target");
    if (permissions.get("service", "ticket-runner", owner)) continue;
    permissions.grant({ subjectType: "service", subjectId: "ticket-runner", owner,
      operations: grant.operations, autoAllow: grant.auto_allow ?? [], source: "bootstrap",
      createdBy: "system:ticket-runner-config", publisher: "first-party" });
  }
}

function sharedSplitOnly(pool: NonNullable<TicketRunnerConfig["shared_pool"]>): boolean {
  return Boolean(pool.split_only ?? pool.split_codex_only);
}

export class TicketRunnerAccess {
  constructor(
    readonly config: TicketRunnerConfig,
    private readonly caps: RunnerCapabilities,
    private readonly permissions: PermissionService,
    private readonly attachmentHome?: string,
    private readonly isDeveloper: (requester: string) => boolean = () => false,
  ) {}
  resourceOwner(requester: string): string {
    return ticketResourceOwner(this.config, requester, this.isDeveloper);
  }
  devicesFor(requester: string) {
    const owner = this.resourceOwner(requester), pool = this.config.shared_pool;
    const devices = this.caps.listDevices(owner);
    if (owner === requester || !pool) return devices;
    const allowed = new Set([...pool.source_devices, ...(this.target(requester).workspaces ?? []).map((row) => row.device)]);
    return devices.filter((row) => allowed.has(row.device));
  }
  quotaHosts(requester: string) {
    const owns = this.resourceOwner(requester) === requester;
    return this.devicesFor(requester).flatMap((row) => {
      const options = row.inventory?.ticket_options;
      if (!options) return [];
      const claudeAccounts = owns || this.config.shared_pool?.claude_devices?.includes(row.device)
        ? options.claude_accounts : undefined;
      if (!options.codex_accounts.length && !claudeAccounts?.length) return [];
      return [{ key: JSON.stringify([requester, row.device]), device: row.device, label: row.display_name ?? row.device,
        online: row.online, accounts: options.codex_accounts, ...(claudeAccounts ? { claudeAccounts } : {}) }];
    });
  }
  authorized(binding: TicketRunnerBinding): boolean {
    if (!binding.requester || binding.requester === binding.owner) return true;
    const pool = this.config.shared_pool;
    const grant = this.permissions.effectiveFor({ subjectType: "service", subjectId: "ticket-runner", owner: binding.owner,
      requested: ["start_session"] }).entries.find((row) => row.operation === "start_session");
    return Boolean(grant?.effective && grant.autoAllow && pool && pool.owner === binding.owner && this.resourceOwner(binding.requester) === binding.owner
      && this.sharedSourceAllowed(binding.device, binding.source, binding.codexAccount, false)
      && (!sharedSplitOnly(pool) || (binding.executionDevice && binding.executionDevice !== binding.device))
      && this.target(binding.requester).workspaces?.some((row) =>
        row.device === (binding.executionDevice || binding.device) && row.workspace_id === binding.parentWorkspaceId));
  }
  target(owner: string): TicketRunnerTarget {
    const target = this.config.targets[this.resourceOwner(owner)];
    if (!target) throw new Error("请先配置本人的工单 Runner 和已登记工作区");
    const pool = this.config.shared_pool;
    if (this.resourceOwner(owner) === owner || !pool?.workspaces) return target;
    return { ...target, workspaces: (target.workspaces ?? []).filter((row) => pool.workspaces!.some((allowed) =>
      allowed.device === row.device && allowed.workspace_id === row.workspace_id)) };
  }
  private sharedSourceAllowed(device: string, source: string, account?: string, requireInventory = true): boolean {
    const pool = this.config.shared_pool;
    if (!pool?.source_devices.includes(device)) return false;
    // Each provider is shared through its own explicit operator list: a fixed
    // Codex account package, or the devices whose Claude Code login is shared.
    if (source === "codex") {
      if (pool.codex_accounts && !pool.codex_accounts.some((row) => row.device === device && row.account === account)) return false;
    } else if (source !== "claude" || !pool.claude_devices?.includes(device)) return false;
    // Inventory proves placement when selecting a new source. Losing a device's
    // live report cannot revoke an existing binding: its original operation must
    // survive offline/reconnect and be reconciled through the owner Gate.
    if (sharedSplitOnly(pool) && requireInventory) {
      const inventory = this.caps.listDevices(pool.owner).find((row) => row.device === device)?.inventory;
      if (!inventory?.agent_backends.some((row) => row.kind === source && row.split_execution)) return false;
    }
    return true;
  }
  choices(requester: string) {
    const shared = this.resourceOwner(requester) !== requester;
    const options = ticketExecutionOptions(this.devicesFor(requester), shared ? this.target(requester) : this.config.targets[requester]);
    if (shared) {
      options.sources = withoutDiagnosticPaths(options.sources.filter((row) => this.sharedSourceAllowed(row.device, row.source, (JSON.parse(row.id) as string[])[2])));
      if (!options.sources.some((row) => row.id === options.source_default)) {
        options.source_default = options.sources.find((row) => row.available)?.id ?? "";
      }
    }
    return options;
  }
  resolve(owner: string, model: string, sourceId?: string, workspaceId?: string): TicketRunnerBinding {
    const resourceOwner = this.resourceOwner(owner);
    if (resourceOwner !== owner) {
      const options = this.choices(owner);
      // An omitted source follows the model's provider, not the Codex default.
      const provider = cliFamilyForModel(model) === "claude" ? "claude" : "codex";
      sourceId ||= options.sources.find((row) => row.id === options.source_default && row.source === provider)?.id
        ?? options.sources.find((row) => row.source === provider && row.available)?.id;
      if (!options.sources.some((row) => row.id === sourceId)) throw new Error("工单共享账号授权不可用");
    }
    const binding = resolveTicketExecution({ owner: resourceOwner, model, sourceId, workspaceId, target: this.target(owner), devices: this.devicesFor(owner) });
    if (resourceOwner === owner) return binding;
    const shared = { ...binding, requester: owner, parentWorkspaceId: binding.workspaceId };
    if (!this.authorized(shared)) throw new Error("工单共享工作区授权不可用");
    return shared;
  }
  async prepareAttachments(binding: TicketRunnerBinding, prompt: string, persistedBodies: readonly string[], sessionId: string): Promise<string> {
    if (!this.attachmentHome) {
      if (/`[^`\r\n]*\/\.octopus\/attachments\/[^`]+`/.test(prompt)) throw new Error("服务缺少附件存储配置；未发送 Agent 输入");
      return prompt;
    }
    return await transferTicketAttachments({ home: this.attachmentHome, owner: binding.requester ?? binding.owner, prompt, persistedBodies, sessionId,
      upload: (args) => this.call(binding, "upload_session_file", args) });
  }
  async call(binding: TicketRunnerBinding, operation: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.authorized(binding)) throw new Error("工单共享工作区或开发者授权已撤销");
    const effective = this.permissions.effectiveFor({ subjectType: "service", subjectId: "ticket-runner", owner: binding.owner,
      requested: TICKET_RUNNER_OPERATIONS });
    const entry = effective.entries.find((row) => row.operation === operation);
    if (!entry?.effective) throw new Error(operation === "upload_session_file"
      ? "工单 Runner 缺少 upload_session_file 附件上传授权；未发送 Agent 输入，请主人在权限页授权后明确继续"
      : "工单 Runner 尚未获得主人授权，或授权已经撤销");
    // Background observation cannot leave a deferred effect behind after a
    // ticket ends. Require explicit continuing consent before creating a Gate call.
    if (!entry.autoAllow) throw new Error("请在权限页为工单 Runner 开启所需操作的自动批准；尚未派发任务");
    const split = operation === "start_session" && binding.executionDevice && binding.executionDevice !== binding.device;
    if (split && (!this.caps.listDevices(binding.owner).some((row) => row.device === binding.device)
      || !this.caps.listDevices(binding.owner).some((row) => row.device === binding.executionDevice))) {
      throw new Error("工单来源和工作区必须属于工单主人");
    }
    const device = operation === "upload_session_file" ? binding.executionDevice || binding.device : binding.device;
    const grant = this.caps.open({ username: binding.owner, purpose: "ticket-runner", kind: "job",
      ...(split ? {} : { device }), rights: [operation], autoAllow: [operation] });
    if (!grant) throw new Error("工单绑定的 Runner 不属于该主人或已撤销");
    try {
      const request = { ...args, device,
      ...(operation === "upload_session_file" ? { workspace_id: binding.workspaceId } : {}),
      ...(operation === "start_session" ? { workspace_id: binding.workspaceId,
        ...(binding.executionDevice ? { execution_device: binding.executionDevice } : {}),
        ...(binding.codexAccount ? { codex_account: binding.codexAccount } : {}) } : {}) };
      let result: unknown;
      if (args.input_receipt === true && typeof args.operation_id === "string"
        && (operation === "start_session" || operation === "append_session")) {
        // Keep the kernel's definite refusal distinct from link-loss ambiguity.
        // The ordinary call() convenience throws away that typed distinction.
        const outcome = await grant.request(operation, request);
        if (outcome.status === "succeeded") result = outcome.result;
        else if (outcome.status === "unknown") throw new Error(outcome.reason);
        else {
          const reason = outcome.status === "approval_required"
            ? "工单操作需要资源主人批准；未派发，请检查工单 Runner 授权后明确继续。"
            : outcome.reason;
          result = { protocol: SESSION_OPERATION_PROTOCOL, operation_id: args.operation_id,
            state: "failed", result: { ok: false, code: "dispatch_refused", error: reason.slice(0, 600) } } satisfies Receipt;
        }
      } else result = await grant.call(operation, request);
      if (operation === "upload_session_file" && (!result || typeof result !== "object"
        || !("workspace_id" in result) || result.workspace_id !== binding.workspaceId)) {
        throw new Error("执行 Runner 未确认附件目标工作区，请升级 Runner；未发送 Agent 输入");
      }
      return result;
    } finally { grant.destroy(); }
  }
}

/** Public operation evidence; native transcript availability is independent. */
export type TicketExecution = Pick<Receipt, "operation_id" | "state" | "session_id" | "input"> & {
  observed_at: string;
};

export function ticketExecutionFromWire(value: unknown, operationId: string): TicketExecution {
  const row = receipt(value, operationId);
  return { operation_id: row.operation_id, state: row.state,
    ...(row.session_id ? { session_id: row.session_id } : {}),
    ...(row.input ? { input: row.input } : {}),
    observed_at: new Date().toISOString() };
}

function receipt(value: unknown, id: string): Receipt {
  const row = sessionOperationReceiptFromWire(value, id);
  if (!row) throw new Error("Runner 尚不支持可恢复的工单执行；没有发送用户任务");
  return row;
}

/** Only a new prepared record can dispatch. Reattachment is read-only. */
export async function runRunnerTicketTurn(input: {
  turn: TicketRunnerTurn;
  binding: TicketRunnerBinding;
  access: Pick<TicketRunnerAccess, "call">;
  save(turn: TicketRunnerTurn): void;
  session(id: string): void;
  detached(): boolean;
  cancelled(): boolean;
  observe?(receipt: Receipt): Promise<void>;
  pause?: () => Promise<void>;
  /** The durable caller can park without holding an execution slot. */
  suspendOnUnavailable?: boolean;
}): Promise<{ detached?: true; receipt?: Receipt }> {
  const { turn, binding, access } = input;
  const pause = input.pause ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 1_000)));
  let interrupted = false;
  let dispatchError: string | undefined;
  while (!input.detached()) {
    let current: Receipt;
    try {
      current = receipt(await access.call(binding, "get_session_operation", { operation_id: turn.id }), turn.id);
    } catch (error) {
      // A known dispatched operation survives transient link loss. Revocation
      // and protocol refusal must remain visible, never become hot retries.
      const unavailable = error instanceof ResourceUnavailableError ? error : null;
      const boundRunnerOffline = unavailable?.resource === runnerResource(binding.owner, binding.device);
      if (input.suspendOnUnavailable && boundRunnerOffline) throw error;
      const transportFailure = resourceTransportFailure(error, runnerResource(binding.owner, binding.device));
      if (input.suspendOnUnavailable && transportFailure) throw transportFailure;
      if (input.suspendOnUnavailable) throw error;
      if (turn.state === "prepared" || (!boundRunnerOffline && !/离线|offline|disconnected|超时|timeout|连接/.test(String(error)))) throw error;
      await pause();
      continue;
    }
    if (input.detached()) return { detached: true };
    if (current.session_id) input.session(current.session_id);
    if (current.state === "missing" && turn.receipt?.operation_id === turn.id
      && (turn.receipt.state === "succeeded" || turn.receipt.state === "failed")) current = turn.receipt;
    if (current.state === "missing") {
      if (turn.state !== "prepared") {
        const unknown = { ...current, state: "unknown" as const,
          ...(dispatchError ? { result: { error: dispatchError } } : {}) };
        await input.observe?.(unknown);
        return { receipt: unknown };
      }
      if (input.cancelled()) {
        const stopped = { ...current, state: "failed" as const, result: { error: "轮次已取消，未派发" } };
        await input.observe?.(stopped);
        return { receipt: stopped };
      }
      if (current.live_input !== "steer-only/v1") {
        throw new Error("请先升级工单会话所在 Runner：需要支持运行中续发和发送回执；尚未启动 Agent。");
      }
      turn.state = "dispatched";
      input.save(turn); // Write-ahead: a service crash beyond here may only query.
      try { current = receipt(await access.call(binding, turn.method, { ...turn.args, operation_id: turn.id }), turn.id); }
      catch (error) { dispatchError = (error instanceof Error ? error.message : String(error)).slice(0, 600); await pause(); continue; }
    }
    if (current.session_id) input.session(current.session_id);
    await input.observe?.(current);
    if (current.state === "succeeded" || current.state === "failed" || current.state === "unknown") {
      if (current.state !== "unknown") {
        // Persist only execution evidence, not a second copy of the agent reply.
        turn.receipt = { protocol: current.protocol, operation_id: current.operation_id, state: current.state,
          ...(current.session_id ? { session_id: current.session_id } : {}), ...(current.input ? { input: current.input } : {}),
          ...(current.result ? { result: {
            ...(typeof current.result.error === "string" ? { error: current.result.error.slice(0, 600) } : {}),
            ...(typeof current.result.code === "string" ? { code: current.result.code.slice(0, 100) } : {}),
          } } : {}) };
        input.save(turn);
      }
      return { receipt: current };
    }
    if (input.cancelled() && !interrupted && current.session_id) {
      interrupted = true;
      await access.call(binding, "append_session", { id: current.session_id, source: binding.source, interrupt: true,
        operation_id: `${turn.id}:stop` });
    }
    // The one external operation owns its result across any number of reads.
    await pause();
  }
  return { detached: true };
}
