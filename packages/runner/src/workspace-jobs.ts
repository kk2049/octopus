import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { resolveWorkspace } from "./workspaces.js";
import { WORKSPACE_JOB_WORKER } from "./workspace-job-worker.js";

export const WORKSPACE_JOB_PROTOCOL = "workspace-jobs/v1";
export type WorkspaceJobState = "accepted" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out" | "unknown" | "missing" | "not_started";
export interface WorkspaceJobRequest {
  job_id: string; workspace_id: string; workspace_key: string; repo_sha: string;
  command: string; timeout_ms: number;
  input?: { url: string; sha256: string; bytes: number };
  files?: Array<{ name: string; url: string; sha256: string; bytes: number }>;
}
export interface WorkspaceJobStatus {
  protocol: typeof WORKSPACE_JOB_PROTOCOL; job_id: string; workspace_id: string;
  workspace_key?: string; repo_sha?: string; state: WorkspaceJobState;
  exit_code?: number | null; error?: string | null; log_bytes?: number; created_at?: string;
  finished_at?: string; cancellation_requested?: boolean;
}
interface RecordRow extends Omit<WorkspaceJobRequest, "input" | "files"> {
  protocol: typeof WORKSPACE_JOB_PROTOCOL; fingerprint: string; created_at: string;
  workspace_path: string; input?: { sha256: string; bytes: number };
  files?: Array<{ name: string; sha256: string; bytes: number }>;
}
const JOB_ID = /^[a-zA-Z0-9_-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;
const MAX_INPUT = 128 * 1024 * 1024;

/** Explicit workspace jobs reuse Runner ownership and the device-local workspace registry.
 * A job id is claimed before spawn. Missing workers are unknown, never launch permission.
 * Only its detached worker writes results; transport/Runner restarts merely read receipts.
 */
export class WorkspaceJobManager {
  private serial: Promise<unknown> = Promise.resolve();
  constructor(private readonly home: string, private readonly opts: {
    inputOrigins?: readonly string[]; now?: () => number;
  } = {}) {}

  private directory(site: string | undefined, workspaceId: string, jobId: string): string {
    if (!JOB_ID.test(jobId)) throw new Error("invalid workspace job id");
    const scope = createHash("sha256").update(JSON.stringify([site ?? "primary", workspaceId])).digest("hex");
    return path.join(this.home, ".octopus", "workspace-jobs", scope, jobId);
  }
  private async read<T>(file: string): Promise<T | null> {
    try { return JSON.parse(await fs.readFile(file, "utf8")) as T; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  private async atomic(file: string, value: unknown): Promise<void> {
    const temporary = `${file}.${randomUUID()}.tmp`;
    const h = await fs.open(temporary, "wx", 0o600);
    try { await h.writeFile(JSON.stringify(value)); await h.sync(); } finally { await h.close(); }
    await fs.rename(temporary, file);
    const parent = await fs.open(path.dirname(file), "r");
    try { await parent.sync(); } finally { await parent.close(); }
  }
  private async bound(site: string | undefined, raw: Readonly<Record<string, unknown>>): Promise<{ dir: string; root: string; id: string; workspaceId: string }> {
    const workspaceId = String(raw.workspace_id ?? "");
    const workspace = await resolveWorkspace(this.home, workspaceId);
    return { dir: this.directory(site, workspaceId, String(raw.job_id ?? "")), root: workspace.path,
      id: String(raw.job_id ?? ""), workspaceId };
  }
  async start(site: string | undefined, raw: Readonly<Record<string, unknown>>): Promise<WorkspaceJobStatus> {
    const work = async (): Promise<WorkspaceJobStatus> => {
      const request = parseRequest(raw, this.opts.inputOrigins ?? []);
      const bound = await this.bound(site, raw);
      const { input, files, ...publicRequest } = request;
      const immutable = { ...publicRequest, input: input ? { sha256: input.sha256, bytes: input.bytes } : undefined,
        ...(files ? { files: files.map(({ url: _url, ...file }) => file) } : {}) };
      const fingerprint = createHash("sha256").update(JSON.stringify(immutable)).digest("hex");
      const prior = await this.read<RecordRow>(path.join(bound.dir, "request.json"));
      if (prior) {
        if (prior.fingerprint !== fingerprint || prior.workspace_path !== bound.root) throw new Error("workspace job id already binds different inputs");
        return await this.status(site, raw);
      }
      const privateRoot = path.join(bound.root, ".octopus-ci");
      await fs.mkdir(privateRoot, { recursive: true, mode: 0o700 });
      if ((await fs.realpath(privateRoot)) !== privateRoot) throw new Error("managed workspace root must not be a symlink");
      const workspaceParent = path.join(privateRoot, "workspaces");
      await fs.mkdir(workspaceParent, { recursive: true, mode: 0o700 });
      if ((await fs.realpath(workspaceParent)) !== workspaceParent) throw new Error("managed workspace parent must not be a symlink");
      const cwd = path.join(workspaceParent, request.workspace_key);
      // Validate before reserving this checkout's execution slot. Jobs in other
      // checkouts share nothing mutable and run concurrently; the container's
      // resource limits, not a Runner-wide slot, bound their aggregate load.
      try { if ((await fs.realpath(cwd)) !== cwd) throw new Error("managed workspace must not be a symlink"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const busy = (): WorkspaceJobStatus => ({ protocol: WORKSPACE_JOB_PROTOCOL, job_id: request.job_id, workspace_id: request.workspace_id, workspace_key: request.workspace_key, repo_sha: request.repo_sha, state: "not_started", error: "workspace_busy" });
      // A worker launched before the per-checkout locks still owns the legacy Runner-wide slot.
      if (await this.read(path.join(this.home, ".octopus", "workspace-jobs-active", "job-id")).catch(() => true)) return busy();
      const lockDir = path.join(this.home, ".octopus", "workspace-job-locks", createHash("sha256").update(cwd).digest("hex"));
      await fs.mkdir(path.dirname(lockDir), { recursive: true, mode: 0o700 });
      try { await fs.mkdir(lockDir, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return busy(); throw error; }
      const lockToken = JSON.stringify({ job_id: request.job_id, job_dir: bound.dir, workspace_id: request.workspace_id,
        workspace_key: request.workspace_key, repo_sha: request.repo_sha, fingerprint });
      const lock = await fs.open(path.join(lockDir, "job-id"), "wx", 0o600);
      try { await lock.writeFile(lockToken); await lock.sync(); } finally { await lock.close(); }
      await fs.mkdir(bound.dir, { recursive: true, mode: 0o700 });
      const record: RecordRow = { ...immutable, protocol: WORKSPACE_JOB_PROTOCOL, fingerprint,
        workspace_path: bound.root, created_at: new Date((this.opts.now ?? Date.now)()).toISOString() };
      await this.atomic(path.join(bound.dir, "request.json"), record);
      await fs.writeFile(path.join(bound.dir, "worker.mjs"), WORKSPACE_JOB_WORKER, { flag: "wx", mode: 0o600 });
      await this.atomic(path.join(bound.dir, "state.json"), { state: "accepted" });
      for (const directory of [lockDir, path.dirname(bound.dir), path.dirname(path.dirname(bound.dir)), path.dirname(lockDir)]) {
        const handle = await fs.open(directory, "r");
        try { await handle.sync(); } finally { await handle.close(); }
      }
      // Launch intent is durable above. Any failure below leaves an unknown job,
      // not an exception that can be mistaken for proof that nothing executed.
      try {
        const child = spawn(process.execPath, [path.join(bound.dir, "worker.mjs")], {
          detached: true, stdio: ["pipe", "ignore", "ignore"], env: process.env,
        });
        child.on("error", () => undefined);
        child.stdin.on("error", () => undefined);
        child.stdin.end(JSON.stringify({ ...request, cwd, source_root: bound.root, job_dir: bound.dir, lock_dir: lockDir, lock_token: lockToken }));
        child.unref();
      } catch { /* Durable intent remains inspectable as unknown. */ }
      return await this.status(site, raw);
    };
    const result = this.serial.then(work, work); this.serial = result.catch(() => undefined); return await result;
  }
  async status(site: string | undefined, raw: Readonly<Record<string, unknown>>): Promise<WorkspaceJobStatus> {
    const bound = await this.bound(site, raw);
    const record = await this.read<RecordRow>(path.join(bound.dir, "request.json"));
    const base = { protocol: WORKSPACE_JOB_PROTOCOL, job_id: bound.id, workspace_id: bound.workspaceId } as const;
    if (!record) return { ...base, state: "missing" };
    if (record.workspace_path !== bound.root) throw new Error("workspace job registration changed");
    const result = await this.read<Partial<WorkspaceJobStatus>>(path.join(bound.dir, "result.json"));
    const running = await this.read<{ state: "accepted" | "running" }>(path.join(bound.dir, "state.json"));
    const pid = await this.read<{ pid: number; start_ticks: string }>(path.join(bound.dir, "pid.json"));
    let state: WorkspaceJobState = result?.state ?? running?.state ?? "unknown";
    if (!result) {
      const alive = pid ? await processAlive(pid.pid, pid.start_ticks) : false;
      const age = (this.opts.now ?? Date.now)() - Date.parse(record.created_at);
      if (!alive && (pid || age > 5_000)) state = "unknown";
    }
    const logBytes = await fs.stat(path.join(bound.dir, "output.log")).then((s) => s.size).catch(() => 0);
    const cancellation = await this.read<unknown>(path.join(bound.dir, "cancel.json"));
    return { ...base, workspace_key: record.workspace_key, repo_sha: record.repo_sha, created_at: record.created_at,
      ...result, state, log_bytes: logBytes, cancellation_requested: Boolean(cancellation) };
  }
  async cancel(site: string | undefined, raw: Readonly<Record<string, unknown>>): Promise<WorkspaceJobStatus> {
    const current = await this.status(site, raw);
    if (!["accepted", "running", "unknown"].includes(current.state)) return current;
    const bound = await this.bound(site, raw);
    await this.atomic(path.join(bound.dir, "cancel.json"), { job_id: bound.id, requested_at: new Date().toISOString() });
    return await this.status(site, raw);
  }
  async readLog(site: string | undefined, raw: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> {
    const state = await this.status(site, raw);
    if (state.state === "missing") throw new Error("workspace job missing");
    const offset = Number(raw.offset ?? 0), length = Number(raw.length ?? 65536);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 1 || length > 65536) throw new Error("invalid bounded workspace log range");
    const bound = await this.bound(site, raw);
    const data = Buffer.alloc(length);
    const h = await fs.open(path.join(bound.dir, "output.log"), "r").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null; throw error;
    });
    let bytes = 0;
    try { if (h) ({ bytesRead: bytes } = await h.read(data, 0, length, offset)); } finally { await h?.close(); }
    return { protocol: WORKSPACE_JOB_PROTOCOL, job_id: bound.id, workspace_id: bound.workspaceId,
      offset, bytes, data: data.subarray(0, bytes).toString("base64"), eof: offset + bytes >= (state.log_bytes ?? 0), state: state.state };
  }

  /** Artifacts belong to the original successful job, never an arbitrary device path. */
  async readArtifact(site: string | undefined, raw: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> {
    const state = await this.status(site, raw);
    if (state.state !== "succeeded") throw new Error("workspace artifact requires a successful original job");
    const name = String(raw.name ?? "");
    const offset = Number(raw.offset ?? 0), length = Number(raw.length ?? 1048576);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name)
      || !Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 1 || length > 1048576) {
      throw new Error("invalid workspace artifact name or range");
    }
    const bound = await this.bound(site, raw);
    const directory = path.join(bound.dir, "artifacts");
    if (await fs.realpath(directory) !== directory) throw new Error("workspace artifact directory must not be a symlink");
    const handle = await fs.open(path.join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024 * 1024 || offset > stat.size) throw new Error("invalid workspace artifact file");
      const data = Buffer.alloc(Math.min(length, stat.size - offset));
      const { bytesRead } = await handle.read(data, 0, data.length, offset);
      return { protocol: WORKSPACE_JOB_PROTOCOL, job_id: bound.id, workspace_id: bound.workspaceId,
        repo_sha: state.repo_sha, name, offset, bytes: bytesRead, total: stat.size,
        data: data.subarray(0, bytesRead).toString("base64"), eof: offset + bytesRead === stat.size };
    } finally { await handle.close(); }
  }
}

export async function processAlive(pid: number, ticks: string): Promise<boolean> {
  try { const raw = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" "); return fields[0] !== "Z" && fields[19] === ticks;
  } catch { return false; }
}
function parseRequest(raw: Readonly<Record<string, unknown>>, origins: readonly string[]): WorkspaceJobRequest {
  const job_id = String(raw.job_id ?? ""), workspace_id = String(raw.workspace_id ?? ""), workspace_key = String(raw.workspace_key ?? "");
  const repo_sha = String(raw.repo_sha ?? ""), command = String(raw.command ?? ""), timeout_ms = Number(raw.timeout_ms);
  if (!JOB_ID.test(job_id) || !/^[a-zA-Z0-9_-]{1,80}$/.test(workspace_key) || !SHA.test(repo_sha)) throw new Error("invalid workspace job identity or exact source SHA");
  if (!command.trim()) throw new Error("invalid workspace job command");
  if (!Number.isInteger(timeout_ms) || timeout_ms < 1000 || timeout_ms > 45 * 60000) throw new Error("invalid workspace job deadline");
  let input: WorkspaceJobRequest["input"];
  if (raw.input) {
    const row = raw.input as Record<string, unknown>; const url = new URL(String(row.url ?? ""));
    if (url.protocol !== "https:" || url.username || url.password || !origins.includes(url.origin)) throw new Error("workspace bundle origin is not trusted");
    const sha256 = String(row.sha256 ?? ""), bytes = Number(row.bytes);
    if (!/^[0-9a-f]{64}$/.test(sha256) || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_INPUT) throw new Error("invalid workspace bundle digest or size");
    input = { url: url.toString(), sha256, bytes };
  }
  let files: WorkspaceJobRequest["files"];
  if (raw.files !== undefined) {
    if (!Array.isArray(raw.files) || raw.files.length > 8) throw new Error("invalid workspace side inputs");
    files = raw.files.map((value) => {
      const row = value as Record<string, unknown>, name = String(row.name ?? ""), url = new URL(String(row.url ?? ""));
      const bytes = Number(row.bytes), sha256 = String(row.sha256 ?? "");
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name) || url.protocol !== "https:" || url.username || url.password
        || !origins.includes(url.origin) || !/^[0-9a-f]{64}$/.test(sha256)
        || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > 32 * 1024 * 1024) throw new Error("invalid workspace side input identity, origin or size");
      return { name, url: url.toString(), sha256, bytes };
    });
    if (new Set(files.map(f => f.name)).size !== files.length || files.reduce((n, f) => n + f.bytes, 0) > 64 * 1024 * 1024) throw new Error("workspace side inputs exceed budget");
  }
  return { job_id, workspace_id, workspace_key, repo_sha, command, timeout_ms, ...(input ? { input } : {}), ...(files ? { files } : {}) };
}
