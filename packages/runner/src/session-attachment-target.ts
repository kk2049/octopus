import { resolveSessionPath, type SessionScanRoot } from "@claude-bot/plugin-sessions/scan";
import { readSessionInputMetadata } from "./session-metadata.js";
import { LaunchJournal } from "./launch-journal.js";
import { listSessionWorkspaces, resolveWorkspace, type WorkspaceRecord } from "./workspaces.js";

/** Resolve on the receiving device. Public display paths never become destinations. */
export async function sessionAttachmentWorkspace(
  home: string, args: Readonly<Record<string, unknown>>, scanRoot: SessionScanRoot = home, executionOnly = false,
): Promise<WorkspaceRecord | undefined> {
  if (args.workspace_id !== undefined) return await resolveWorkspace(home, String(args.workspace_id));
  if (executionOnly) throw new Error("执行 Runner 上传必须指定已登记工作区");
  const id = String(args.id ?? "").trim();
  if (await new LaunchJournal(home).sessionPlacement(id)) {
    throw new Error("split 会话附件必须发送到原执行 Runner 的已登记工作区");
  }
  // Old ordinary sessions retain temporary uploads if they have no registered
  // workspace. Read only the metadata prefix, not a full transcript per chunk.
  let resolved: Awaited<ReturnType<typeof resolveSessionPath>>;
  try { resolved = await resolveSessionPath(scanRoot, undefined, id, undefined); }
  catch (error) {
    if (error instanceof Error && error.message === `session not found for id: ${id}`) return undefined;
    throw error;
  }
  const meta = await readSessionInputMetadata(resolved.path, resolved.source);
  const snapshot = await listSessionWorkspaces(home, [{ id, source: resolved.source, cwd: meta.cwd }]);
  const workspace = snapshot.session_directories.find((row) => row.id === id && row.source === resolved.source);
  return workspace ? await resolveWorkspace(home, workspace.workspace_id) : undefined;
}
