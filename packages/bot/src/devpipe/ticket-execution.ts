import { SESSION_OPERATION_PROTOCOL } from "@claude-bot/runner/gateway-protocol";
import { WORKSPACE_DEVELOPMENT_PROTOCOL } from "@claude-bot/runner/workspace-development-protocol";
import type { TicketExecutionOptions } from "@claude-bot/dashboard-web/contract";
import type { RunnerDeviceStatus } from "../runner/gateway.js";
import type { TicketRunnerBinding } from "../store/repositories/ticket-runner.js";
import type { TicketRunnerTarget } from "./runner-ticket.js";
import { cliFamilyForModel } from "./ticket-models.js";

const key = (...parts: string[]) => JSON.stringify(parts);

/** Only current owner registration and authenticated metadata can resolve a selection. */
export function ticketExecutionOptions(devices: RunnerDeviceStatus[], target?: TicketRunnerTarget): TicketExecutionOptions {
  const sources: TicketExecutionOptions["sources"] = [];
  const workspaces: TicketExecutionOptions["workspaces"] = [];
  for (const row of devices) {
    const inventory = row.inventory;
    const label = row.display_name ?? row.device;
    const sessionOperations = inventory?.session_operations?.protocol === SESSION_OPERATION_PROTOCOL;
    const development = inventory?.workspace_development;
    const developmentReady = development?.protocol === WORKSPACE_DEVELOPMENT_PROTOCOL && development.available;
    for (const source of ["codex", "claude"] as const) {
      const backend = inventory?.agent_backends.find((entry) => entry.kind === source);
      if (!backend?.available && row.device !== target?.device) continue;
      // Account discovery and durable session execution are separate facts.
      // Old backends may be readable, but cannot accept new ticket operations.
      const accounts = source === "codex"
        ? inventory?.ticket_options?.codex_accounts ?? [{ id: "@default", label: "codex" }]
        : [{ id: "@default", label: "Claude" }];
      for (const account of accounts) sources.push({ id: key(row.device, source, account.id), device: row.device, source, split_execution: backend?.split_execution === true,
        label: `${label} · ${("emailLabel" in account && account.emailLabel) || account.label}`,
        ...("quota" in account && account.quota ? { quota: account.quota } : {}),
        available: row.online && backend?.available === true && sessionOperations,
        ...(!row.online ? { reason: "offline" } : !backend?.available ? { reason: "backend_unavailable", ...backendDiagnostic(backend) }
          : !sessionOperations ? { reason: "runner_upgrade_required" } : {}) });
    }
    const registered = inventory?.ticket_options?.workspaces ?? [];
    // Ticket roots are a deployment choice, separate from session/file roots.
    const configured = target?.workspaces?.filter((workspace) => workspace.device === row.device);
    const preferred = row.device === target?.device ? target.workspace_id : undefined;
    const candidates = target?.workspaces
      ? (configured ?? []).map((workspace) => registered.find((row) => row.id === workspace.workspace_id)
        ?? { id: workspace.workspace_id, label: workspace.label ?? "Ticket workspace" })
      : preferred ? registered.filter((workspace) => workspace.id === preferred) : [];
    if (!target?.workspaces && row.device === target?.device && !candidates.some((w) => w.id === target.workspace_id)) {
      candidates.push({ id: target.workspace_id, label: "Ticket workspace" });
    }
    for (const workspace of candidates) workspaces.push({ id: key(row.device, workspace.id), device: row.device, codex_remote: inventory?.execution.codex_exec_server === true,
      label: `${label} · ${workspace.label}`,
      available: row.online && registered.some((row) => row.id === workspace.id) && Boolean(workspace.id) && inventory?.execution.shell === true && inventory.execution.workspace_files && developmentReady === true,
      ...(!row.online ? { reason: "offline" } : !workspace.id || !registered.some((row) => row.id === workspace.id) ? { reason: "workspace_inventory_required" }
        : !inventory?.execution.shell || !inventory.execution.workspace_files ? { reason: "workspace_unavailable" }
        : !development ? { reason: "runner_upgrade_required" } : !developmentReady ? { reason: "workspace_unavailable" } : {}) });
  }
  // Deployment fact, from configuration: the entry marked `default` is the
  // operator's choice and is kept even while it is unavailable. Without a mark
  // the first available configured ticket workspace is used (else the first
  // configured one), so an unmarked list never defaults to an offline root
  // while another configured root can run the ticket. Then the target's root.
  const row = (entry: { device: string; workspace_id: string }) => workspaces.find((w) => w.id === key(entry.device, entry.workspace_id));
  const marked = target?.workspaces?.find((workspace) => workspace.default);
  const configured = (target?.workspaces ?? []).map(row).filter((w) => w !== undefined);
  return { sources, workspaces,
    source_default: sources.find((s) => s.device === target?.device && s.source === "codex" && s.id === key(s.device, "codex", "@default"))?.id ?? sources.find((s) => s.device === target?.device && s.source === "codex" && s.available)?.id ?? "",
    workspace_default: (marked ? row(marked) : undefined)?.id
      ?? (configured.find((w) => w.available) ?? configured[0])?.id
      ?? (target ? row(target) : undefined)?.id
      ?? (workspaces.length === 1 ? workspaces[0]!.id : ""),
  };
}

/** The Runner's own reason for an unavailable backend, including the offending local path when it has one. */
function backendDiagnostic(backend: NonNullable<RunnerDeviceStatus["inventory"]>["agent_backends"][number] | undefined) {
  const code = backend?.diagnostic_code ?? backend?.reason;
  return code ? { diagnostic: { code, ...backend?.diagnostic_detail } } : {};
}

/** A shared requester sees the pool owner's sources, never the owner's local paths. */
export function withoutDiagnosticPaths(sources: TicketExecutionOptions["sources"]): TicketExecutionOptions["sources"] {
  return sources.map((row) => {
    if (!row.diagnostic?.path) return row;
    const { path: _path, ...diagnostic } = row.diagnostic;
    return { ...row, diagnostic };
  });
}

export function resolveTicketExecution(input: {
  owner: string; model: string; sourceId?: string; workspaceId?: string;
  target: TicketRunnerTarget; devices: RunnerDeviceStatus[];
}): TicketRunnerBinding {
  const options = ticketExecutionOptions(input.devices, input.target);
  const family = cliFamilyForModel(input.model);
  const provider = family === "codex-runner" ? "codex" : family;
  const sourceId = input.sourceId || (provider === "codex" ? options.source_default
    : options.sources.find((s) => s.source === provider && s.device === input.target.device)?.id);
  const source = options.sources.find((s) => s.id === sourceId);
  const workspace = options.workspaces.find((w) => w.id === (input.workspaceId || options.workspace_default));
  if (source?.reason === "runner_upgrade_required") throw new Error(`所选 Agent 来源 ${source.device} 需要更新 Runner 的可恢复会话协议；未创建工单或发送任务`);
  if (!source?.available || source.source !== provider) throw new Error("所选 Agent 来源不可用或与模型不匹配，请检查 Runner 登记与在线状态");
  if (workspace?.reason === "runner_upgrade_required") throw new Error(`所选工作区 ${workspace.device} 需要更新 Runner 的开发工作区协议；未创建工单或发送任务`);
  if (!workspace?.available) throw new Error("所选工作区不可用，请检查 Runner 工作区登记与在线状态");
  const runtime = input.devices.find((row) => row.device === source.device)!;
  const execution = input.devices.find((row) => row.device === workspace.device)!;
  if (source.device !== workspace.device && (!runtime.inventory?.agent_backends.find((b) => b.kind === provider)?.split_execution
    || (provider === "codex" && !execution.inventory?.execution.codex_exec_server))) {
    throw new Error("所选来源与工作区尚不支持分离执行；Codex 工作区需要 Runner 的远程执行能力");
  }
  const [, , account] = JSON.parse(source.id) as string[];
  const [, workspaceId] = JSON.parse(workspace.id) as string[];
  return { owner: input.owner, device: source.device, workspaceId: workspaceId!, source: source.source,
    executionDevice: workspace.device,
    ...(source.source === "codex" && runtime.inventory?.ticket_options ? { codexAccount: account } : {}) };
}
