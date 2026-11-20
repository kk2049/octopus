import type { RunnerInventory } from "@claude-bot/runner/inventory";
import type { RunnerCapabilityView } from "@claude-bot/dashboard-web/contract";

/** Presentation of existing inventory, not another registration or permission database. */
export function runnerCapabilityView(inventory?: RunnerInventory): RunnerCapabilityView[] | undefined {
  if (!inventory) return undefined;
  const rows: RunnerCapabilityView[] = [];
  const add = (id: string, available: boolean, protocol?: string, reason?: string) =>
    rows.push({ kind: "builtin", id, title: id, status: available ? "ready" : "unavailable", tools: [],
      ...(protocol ? { protocol } : {}), ...(reason ? { reason } : {}) });
  add("sessions", inventory.session_roster !== false);
  add("session-operations", Boolean(inventory.session_operations), inventory.session_operations?.protocol);
  add("shell", inventory.execution.shell);
  add("files", inventory.execution.workspace_files);
  add("file-transfer", Boolean(inventory.file_transfer), inventory.file_transfer?.protocol);
  add("workspace-jobs", Boolean(inventory.workspace_jobs), inventory.workspace_jobs?.protocol);
  add("workspace-development", Boolean(inventory.workspace_development?.available), inventory.workspace_development?.protocol, inventory.workspace_development?.reason);
  add("knowledge-index", Boolean(inventory.knowledge_index_jobs), inventory.knowledge_index_jobs?.protocol);
  add("meeting-transcription", Boolean(inventory.meeting_transcription_jobs?.available), inventory.meeting_transcription_jobs?.protocol, inventory.meeting_transcription_jobs?.reason);
  add("local-mcp", Boolean(inventory.local_mcp?.available), inventory.local_mcp?.protocol);
  add("gui", Boolean(inventory.gui_automation?.available), inventory.gui_automation?.protocol);
  for (const backend of inventory.agent_backends) {
    add("agent:" + backend.kind, backend.available, undefined, backend.reason);
    if (backend.version) rows.at(-1)!.version = backend.version;
  }
  for (const provider of inventory.capabilities?.providers ?? []) rows.push({
    kind: "extension", id: provider.id, title: provider.title, status: provider.status, reason: provider.reason,
    protocol: inventory.capabilities!.protocol, version: provider.version, revision: provider.revision, tools: provider.tools,
  });
  return rows;
}
