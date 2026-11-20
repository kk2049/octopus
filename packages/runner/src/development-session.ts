import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseSessionText, resolveSessionPath, type SessionScanRoot } from "@claude-bot/plugin-sessions/scan";
import { listSessionWorkspaces, resolveWorkspace } from "./workspaces.js";
import { workspaceRelativePathProblem } from "./workspace-paths.js";
import type { SessionObservationIndex } from "./session-observation.js";
import { openCodexDaemon } from "./codex-daemon.js";
import type { AgentRuntimeRegistry } from "./agent-runtime.js";

const exec = promisify(execFile);
/** Provider evidence that the registered session is a live CLI the Runner did not start. */
interface NativeLiveness { recheck(): Promise<void>; close(): Promise<void> }

async function codexLiveness(codexHome: string | undefined, id: string, transcript: string): Promise<NativeLiveness> {
  if (!codexHome) throw new Error("session account is not registered on this Runner");
  const daemon = await openCodexDaemon(codexHome);
  if (!daemon) throw new Error("native Codex daemon is unavailable; registration does not launch or resume an agent");
  try {
    const thread = await daemon.thread(id);
    if (!thread || !(await daemon.loaded()).includes(id) || await fs.realpath(thread.path) !== await fs.realpath(transcript)) throw new Error("session is not an independently controllable, loaded native CLI thread");
  } catch (error) { await daemon.close(); throw error; }
  return {
    recheck: async () => {
      await daemon.revalidate();
      if (!(await daemon.loaded()).includes(id)) throw new Error("native session exited during registration");
    },
    close: () => daemon.close(),
  };
}

/** Claude Code has no daemon: its lifecycle hooks bind the session to one exact process incarnation. */
async function claudeLiveness(runtime: Pick<AgentRuntimeRegistry, "inspect"> | undefined, id: string): Promise<NativeLiveness> {
  if (!runtime) throw new Error("this Runner cannot observe native Claude Code sessions");
  const live = async () => {
    const inspection = await runtime.inspect("claude", id);
    if (!inspection?.exactProcessAlive || !inspection.process || inspection.controlMode !== "external_cli") {
      throw new Error("session is not a live Claude Code CLI observed through this Runner's hooks");
    }
    return inspection.process;
  };
  const first = await live();
  return {
    recheck: async () => {
      const current = await live().catch(() => undefined);
      if (current?.pid !== first.pid || current.startTicks !== first.startTicks || current.bootId !== first.bootId) {
        throw new Error("native session exited during registration");
      }
    },
    close: async () => {},
  };
}

/** The private local socket selects an existing native session. Only the Runner
 * may produce this proof; paths and homes never become caller-supplied authority.
 */
export async function describeDevelopmentSession(home: string, scan: SessionScanRoot,
  observation: Pick<SessionObservationIndex, "resolve">, args: Record<string, unknown>,
  runtime?: Pick<AgentRuntimeRegistry, "inspect">): Promise<Record<string, unknown>> {
  const id = String(args.session_id ?? "");
  const source = args.source;
  if ((source !== "codex" && source !== "claude") || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(id)) {
    throw new Error("development registration requires a complete native Codex or Claude Code session id");
  }
  if (args.ticket_id !== undefined && (!Number.isSafeInteger(args.ticket_id) || Number(args.ticket_id) < 1)) throw new Error("invalid existing CLI report id");
  const indexed = await observation.resolve({ source, id });
  const resolved = await resolveSessionPath(indexed?.scan ?? scan, source, id, indexed?.path);
  const liveness = source === "codex" ? await codexLiveness(resolved.codexHome, id, resolved.path) : await claudeLiveness(runtime, id);
  try {
    const file = await fs.open(resolved.path, "r"), buffer = Buffer.alloc(131072);
    let header: string;
    try { const { bytesRead } = await file.read(buffer, 0, buffer.length, 0); header = buffer.subarray(0, bytesRead).toString("utf8"); }
    finally { await file.close(); }
    const { meta } = parseSessionText(source, header.slice(0, header.lastIndexOf("\n") + 1));
    if (meta.id !== id || !meta.cwd) throw new Error("session metadata does not identify its working directory");
    // This is an explicit declaration over the private local bridge, not a
    // request to move/resume the CLI. Its initial cwd can be outside the repo.
    if (args.worktree !== undefined && (typeof args.worktree !== "string" || !path.isAbsolute(args.worktree))) throw new Error("development worktree must be an absolute local directory");
    const cwd = await fs.realpath(typeof args.worktree === "string" ? args.worktree : meta.cwd);
    const association = (await listSessionWorkspaces(home, [{ source, id, cwd }], { includeManaged: false })).session_directories[0];
    if (!association) throw new Error("register this development directory as a Runner workspace before attaching the session");
    const git = async (...gitArgs: string[]) => (await exec("git", ["-C", cwd, ...gitArgs], { timeout: 10000, maxBuffer: 65536 })).stdout.trim();
    if (await fs.realpath(await git("rev-parse", "--show-toplevel")) !== cwd) throw new Error("declare the dedicated repository worktree root");
    const branch = await git("branch", "--show-current");
    if (!branch || ["v4", "v4-stable", "main"].includes(branch)) throw new Error("use a dedicated feature branch for native development");
    const remote = await git("remote", "get-url", "origin");
    if (!/^git@[a-zA-Z0-9.-]+:[a-zA-Z0-9_./-]+$/u.test(remote)) throw new Error("native development requires a credential-free SSH origin");
    const sha = await git("rev-parse", "HEAD");
    await liveness.recheck();
    return { protocol: "native-development/v1", source, session_id: id, workspace_id: association.workspace_id,
      ...(args.ticket_id !== undefined ? { ticket_id: args.ticket_id } : {}),
      relative_path: association.relative_path, branch, remote, sha, observed_at: new Date().toISOString(),
      title: typeof args.title === "string" ? args.title.trim().slice(0, 120) : `CLI ${branch}` };
  } finally { await liveness.close(); }
}

/** Recheck the registered project without changing the native session's cwd. */
export async function resolveNativeDevelopmentWorkspace(home: string, workspaceId: unknown, relativePath: unknown): Promise<string> {
  if (typeof workspaceId !== "string" || workspaceRelativePathProblem(relativePath)) throw new Error("invalid native development workspace");
  const workspace = await resolveWorkspace(home, workspaceId);
  if (workspace.managed) throw new Error("native development requires an unmanaged workspace");
  const directory = await fs.realpath(path.join(workspace.path, relativePath as string));
  const relative = path.relative(workspace.path, directory);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
    || relative.split(path.sep).join("/") !== relativePath || !(await fs.stat(directory)).isDirectory()) throw new Error("registered native development workspace changed or was revoked");
  return directory;
}

/** Interrupt the exact observed native turn. A completion race cannot stop a
 * successor, and an ambiguous reply is never retried through another transport.
 */
export async function interruptNativeDevelopment(codexHome: string, id: string, transcriptPath: string): Promise<Record<string, unknown>> {
  const daemon = await openCodexDaemon(codexHome);
  if (!daemon) throw new Error("original native CLI is unavailable");
  let submitted = false;
  try {
    const thread = await daemon.thread(id);
    if (!thread || thread.turnState !== "working" || !(await daemon.loaded()).includes(id)
      || await fs.realpath(thread.path) !== await fs.realpath(transcriptPath)) throw new Error("native CLI has no interruptible turn");
    const page = await daemon.client.request("thread/turns/list", { threadId: id, limit: 1, sortDirection: "desc", itemsView: "notLoaded" }, 5000) as { data?: Array<{ id?: string; status?: string }> };
    const turn = page.data?.length === 1 ? page.data[0] : undefined;
    if (!turn?.id || turn.status !== "inProgress") throw new Error("native turn already ended");
    await daemon.revalidate();
    submitted = true;
    await daemon.client.request("turn/interrupt", { threadId: id, turnId: turn.id }, 10000);
    return { ok: true, session_id: id, turn_id: turn.id, control_action: "native_interrupt" };
  } catch (error) {
    if (!submitted) throw error;
    return { ok: false, code: "native_control_unknown", error: "native interrupt response is uncertain; observe this session, do not replay", session_id: id };
  } finally { await daemon.close(); }
}
