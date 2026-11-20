import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { addManagedWorkspace, resolveWorkspace, withWorkspaceSite, workspaceRegistryPath } from "./workspaces.js";
import { WORKSPACE_DEVELOPMENT_WORKER } from "./workspace-development-worker.js";
import {
  WORKSPACE_DEVELOPMENT_PROTOCOL as protocol, WORKSPACE_DEVELOPMENT_LIMITS as limits,
  type WorkspaceDevelopmentAction, type WorkspaceDevelopmentIdentity, type WorkspaceDevelopmentInput,
  type WorkspaceDevelopmentStatus, type WorkspaceDevelopmentOperation, type WorkspaceDevelopmentCandidate,
  type WorkspaceDevelopmentArtifact,
} from "./workspace-development-protocol.js";

const exec = promisify(execFile);
const ID = /^[a-zA-Z0-9_-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;
const GIT_OPERATION_MARKERS = ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "sequencer"];
async function gitOperationInProgress(cwd: string): Promise<boolean> {
  const directory = await git(cwd, ["rev-parse", "--absolute-git-dir"]);
  const markers = await Promise.all(GIT_OPERATION_MARKERS.map(async (name) => {
    try { await fs.lstat(path.join(directory, name)); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }));
  return markers.some(Boolean);
}
type Request = WorkspaceDevelopmentIdentity & { request_id: string; base_sha?: string; target_sha?: string;
  expected_base_sha?: string; expected_head_sha?: string; input?: WorkspaceDevelopmentInput };
interface Binding extends WorkspaceDevelopmentIdentity { site: string; root: string; base_sha: string; worktree_workspace_id?: string }
interface OperationRecord { request: Omit<Request, "input"> & { input?: { sha256: string; bytes: number } };
  action: WorkspaceDevelopmentAction; fingerprint: string; created_at: string }
interface Bound { identity: WorkspaceDevelopmentIdentity; site: string; root: string; scope: string; development: string;
  cwd: string; mirror: string; lock: string; hash: string }
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function read<T>(file: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(file, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
async function atomic(file: string, value: unknown): Promise<void> {
  const temp = file + "." + randomUUID() + ".tmp", h = await fs.open(temp, "wx", 0o600);
  try { await h.writeFile(JSON.stringify(value)); await h.sync(); } finally { await h.close(); }
  await fs.rename(temp, file);
  const parent = await fs.open(path.dirname(file), "r"); try { await parent.sync(); } finally { await parent.close(); }
}
async function directory(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if (await fs.realpath(dir) !== dir) throw new Error("workspace_unavailable");
}
async function canonical(dir: string): Promise<void> {
  if (await fs.realpath(dir) !== dir) throw new Error("workspace_unavailable");
}
async function alive(pid: number, expected: string): Promise<boolean> {
  try {
    const text = await fs.readFile("/proc/" + pid + "/stat", "utf8");
    return text.slice(text.lastIndexOf(")") + 2).split(" ")[19] === expected;
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}
async function git(cwd: string, args: string[]): Promise<string> {
  const result = await exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args],
    { cwd, timeout: 10_000, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return result.stdout.trim();
}
function identity(raw: Readonly<Record<string, unknown>>): WorkspaceDevelopmentIdentity {
  if (typeof raw.workspace_id !== "string" || !/^ws_[0-9a-f]{24}$/.test(raw.workspace_id)
    || typeof raw.repository_id !== "string" || !ID.test(raw.repository_id)
    || typeof raw.development_id !== "string" || !ID.test(raw.development_id)
    || !Number.isSafeInteger(raw.ticket_id) || Number(raw.ticket_id) < 1) throw new Error("invalid_request");
  return { workspace_id: raw.workspace_id, repository_id: raw.repository_id,
    development_id: raw.development_id, ticket_id: Number(raw.ticket_id) };
}

/** Per-development durable intent; CI's reset and global execution slot are not reused. */
export class WorkspaceDevelopmentManager {
  private readonly pending = new Map<string, Promise<unknown>>();
  constructor(private readonly home: string, private readonly opts: { inputOrigins?: readonly string[] } = {}) {}

  private async bound(site: string | undefined, raw: Readonly<Record<string, unknown>>): Promise<Bound> {
    const id = identity(raw), trustedSite = site ?? "primary";
    const root = await withWorkspaceSite(trustedSite, () => resolveWorkspace(this.home, id.workspace_id));
    if (root.managed) throw new Error("binding_mismatch");
    const scope = path.join(root.path, ".octopus-development", digest([trustedSite, id.repository_id]));
    const hash = digest(id.development_id);
    for (const dir of [path.join(root.path, ".octopus-development"), scope, path.join(scope, "developments", hash)]) {
      try { await canonical(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return { identity: id, site: trustedSite, root: root.path, scope, hash, mirror: path.join(scope, "mirror.git"),
      development: path.join(scope, "developments", hash), cwd: path.join(scope, "worktrees", hash),
      lock: path.join(scope, "developments", hash, "active") };
  }
  private async binding(bound: Bound): Promise<Binding | null> {
    const binding = await read<Binding>(path.join(bound.development, "binding.json"));
    if (binding && (binding.root !== bound.root || binding.site !== bound.site
      || digest(identity(binding as unknown as Record<string, unknown>)) !== digest(bound.identity))) throw new Error("binding_mismatch");
    return binding;
  }
  private serial<T>(key: string, action: () => Promise<T>): Promise<T> {
    const promise = (this.pending.get(key) ?? Promise.resolve()).then(action, action);
    this.pending.set(key, promise);
    void promise.finally(() => { if (this.pending.get(key) === promise) this.pending.delete(key); }).catch(() => {});
    return promise;
  }
  async prepare(site: string | undefined, raw: Readonly<Record<string, unknown>>): Promise<WorkspaceDevelopmentStatus> {
    return await this.start("prepare", site, raw);
  }
  async sync(site: string | undefined, raw: Readonly<Record<string, unknown>>): Promise<WorkspaceDevelopmentStatus> {
    return await this.start("sync", site, raw);
  }
  async export(site: string | undefined, raw: Readonly<Record<string, unknown>>): Promise<WorkspaceDevelopmentStatus> {
    return await this.start("export", site, raw);
  }
  private parse(action: WorkspaceDevelopmentAction, raw: Readonly<Record<string, unknown>>): Request {
    const result: Request = { ...identity(raw), request_id: String(raw.request_id ?? "") };
    if (!ID.test(result.request_id)) throw new Error("invalid_request");
    const keys = action === "export" ? ["expected_base_sha", "expected_head_sha"] : action === "sync" ? ["base_sha", "target_sha"] : ["base_sha"];
    for (const key of keys) {
      if (typeof raw[key] !== "string" || !SHA.test(raw[key])) throw new Error("invalid_request");
      Object.assign(result, { [key]: raw[key] });
    }
    if (action !== "export" && raw.input !== undefined) {
      const input = raw.input as Partial<WorkspaceDevelopmentInput>;
      if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.url !== "string"
        || input.url.length > 2048 || typeof input.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(input.sha256)
        || !Number.isSafeInteger(input.bytes) || Number(input.bytes) < 1 || Number(input.bytes) > limits.bundleBytes) throw new Error("invalid_request");
      const url = new URL(input.url);
      const allowed = (this.opts.inputOrigins ?? []).map((origin) => new URL(origin).origin);
      const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
      if (url.username || url.password || url.hash || !["https:", "http:"].includes(url.protocol)
        || (url.protocol === "http:" && !loopback && !allowed.includes(url.origin))
        || (!loopback && !allowed.includes(url.origin))) throw new Error("invalid_request");
      result.input = { url: input.url, sha256: input.sha256, bytes: Number(input.bytes) };
    }
    return result;
  }
  private async start(action: WorkspaceDevelopmentAction, site: string | undefined, raw: Readonly<Record<string, unknown>>): Promise<WorkspaceDevelopmentStatus> {
    const request = this.parse(action, raw), bound = await this.bound(site, raw);
    return await this.serial(bound.development, async () => {
      let binding = await this.binding(bound);
      if (binding && action !== "export" && binding.base_sha !== request.base_sha) throw new Error("binding_mismatch");
      if (!binding && action !== "prepare") throw new Error("base_missing");
      for (const dir of [path.join(bound.root, ".octopus-development"), bound.scope,
        path.join(bound.scope, "developments"), bound.development, path.join(bound.development, "requests"),
        path.join(bound.development, "candidates"), path.join(bound.scope, "worktrees")]) await directory(dir);
      const dir = path.join(bound.development, "requests", request.request_id);
      const immutable = { ...request, ...(request.input ? { input: { sha256: request.input.sha256, bytes: request.input.bytes } } : {}) };
      const fingerprint = digest({ action, request: immutable });
      const prior = await read<OperationRecord>(path.join(dir, "request.json"));
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new Error("request_conflict");
        return await this.status(site, raw);
      }
      await this.clearFinishedLock(bound, site);
      try { await fs.mkdir(bound.lock, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("workspace_busy"); throw error; }
      const token = request.request_id + ":" + randomUUID();
      try {
        await atomic(path.join(bound.lock, "owner.json"), { request: token, request_id: request.request_id });
        if (!binding) {
          binding = { ...bound.identity, site: bound.site, root: bound.root, base_sha: request.base_sha! };
          await atomic(path.join(bound.development, "binding.json"), binding);
        }
        await directory(dir);
        await atomic(path.join(dir, "request.json"), { request: immutable, action, fingerprint, created_at: new Date().toISOString() });
        await fs.writeFile(path.join(dir, "worker.mjs"), WORKSPACE_DEVELOPMENT_WORKER, { flag: "wx", mode: 0o600 });
        await atomic(path.join(dir, "state.json"), { state: "accepted" });
        // Durable intent precedes spawn. Transport loss never grants a replay.
        try {
          const child = spawn(process.execPath, [path.join(dir, "worker.mjs")],
            { detached: true, stdio: ["pipe", "ignore", "ignore"], env: process.env });
          child.on("error", () => {}); child.stdin.on("error", () => {});
          child.stdin.end(JSON.stringify({ request: immutable, input: request.input, action, identity: bound.identity,
            root: bound.root, scope: bound.scope, mirror: bound.mirror, cwd: bound.cwd, dir,
            development_dir: bound.development, branch: "octopus-dev/" + bound.hash, registry: workspaceRegistryPath(this.home),
            lock_dir: bound.lock, lock_token: token, git_operation_markers: GIT_OPERATION_MARKERS, timeout_ms: limits.operationTimeoutMs, max_bundle_bytes: limits.bundleBytes }));
          child.unref();
        } catch { /* status reconciles the original accepted intent as unknown */ }
      } catch (error) {
        if (!await read(path.join(dir, "request.json"))) await fs.rm(bound.lock, { recursive: true, force: true });
        throw error;
      }
      return await this.status(site, raw);
    });
  }
  private async clearFinishedLock(bound: Bound, site: string | undefined): Promise<void> {
    const owner = await read<{ request: string; request_id: string }>(path.join(bound.lock, "owner.json"));
    if (!owner) return;
    const operation = await this.operation(bound, owner.request_id);
    if (!["succeeded", "failed", "unknown"].includes(operation.state)) return;
    const same = await read<{ request: string }>(path.join(bound.lock, "owner.json"));
    if (same?.request === owner.request) {
      await this.bound(site, bound.identity as unknown as Record<string, unknown>);
      await fs.rm(bound.lock, { recursive: true, force: true });
    }
  }
  private async operation(bound: Bound, requestId: string): Promise<WorkspaceDevelopmentOperation> {
    if (!ID.test(requestId)) throw new Error("invalid_request");
    const dir = path.join(bound.development, "requests", requestId);
    const record = await read<OperationRecord>(path.join(dir, "request.json"));
    if (!record) return { request_id: requestId, state: "missing" };
    await canonical(dir);
    const result = await read<Partial<WorkspaceDevelopmentOperation>>(path.join(dir, "result.json"));
    const running = await read<{ state: "accepted" | "running" }>(path.join(dir, "state.json"));
    let state = result?.state ?? running?.state ?? "unknown";
    if (!result) {
      const pid = await read<{ pid: number; start_ticks: string }>(path.join(dir, "pid.json"));
      if (pid ? !await alive(pid.pid, pid.start_ticks) : Date.now() - Date.parse(record.created_at) > 5000) state = "unknown";
    }
    return { request_id: requestId, action: record.action, created_at: record.created_at, ...result, state };
  }
  async status(site: string | undefined, raw: Readonly<Record<string, unknown>>): Promise<WorkspaceDevelopmentStatus> {
    const bound = await this.bound(site, raw), binding = await this.binding(bound);
    const result: WorkspaceDevelopmentStatus = { protocol, ...bound.identity };
    if (raw.request_id !== undefined) result.operation = await this.operation(bound, String(raw.request_id));
    if (binding) {
      const synced = await read<{ sha: string }>(path.join(bound.development, "synced.json"));
      if (synced) {
        await canonical(bound.cwd); await canonical(bound.mirror);
        if (await git(bound.cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]) !== bound.mirror) throw new Error("binding_mismatch");
        const head = await git(bound.cwd, ["rev-parse", "HEAD"]);
        const dirty = Boolean(await git(bound.cwd, ["status", "--porcelain", "--untracked-files=normal"]));
        const conflicted = Boolean(await git(bound.cwd, ["ls-files", "-u"])) || await gitOperationInProgress(bound.cwd);
        await this.bound(site, raw);
        const child = await withWorkspaceSite(bound.site, async () => binding.worktree_workspace_id
          ? await resolveWorkspace(this.home, binding.worktree_workspace_id)
          : await addManagedWorkspace(this.home, bound.cwd, "Ticket " + bound.identity.ticket_id,
            { site: bound.site, parent_workspace_id: bound.identity.workspace_id,
              repository_id: bound.identity.repository_id, development_id: bound.identity.development_id }));
        if (!binding.worktree_workspace_id) {
          binding.worktree_workspace_id = child.id;
          await atomic(path.join(bound.development, "binding.json"), binding);
        }
        result.development = { worktree_workspace_id: child.id, base_sha: binding.base_sha, head_sha: head,
          synced_head_sha: synced.sha, required_head_sha: synced.sha, dirty, conflicted };
      }
    }
    return result;
  }
  async artifact(site: string | undefined, raw: Readonly<Record<string, unknown>>): Promise<WorkspaceDevelopmentArtifact> {
    const bound = await this.bound(site, raw);
    if (!await this.binding(bound)) throw new Error("base_missing");
    const candidateId = String(raw.candidate_id ?? ""), artifactId = String(raw.artifact_id ?? "");
    if (!/^[a-f0-9-]{36}$/.test(candidateId) || artifactId !== "source.bundle") throw new Error("invalid_request");
    const offset = Number(raw.offset), length = Number(raw.length);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > limits.artifactChunkBytes) throw new Error("invalid_request");
    const record = await read<{ request_id: string; candidate: WorkspaceDevelopmentCandidate }>(path.join(bound.development, "candidates", candidateId + ".json"));
    if (!record || record.candidate.candidate_id !== candidateId) throw new Error("artifact_unavailable");
    const operation = await this.operation(bound, record.request_id);
    if (operation.state !== "succeeded" || operation.candidate?.candidate_id !== candidateId) throw new Error("artifact_unavailable");
    const dir = path.join(bound.development, "requests", record.request_id);
    await canonical(dir);
    const handle = await fs.open(path.join(dir, artifactId), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== record.candidate.bundle.bytes || stat.size > limits.bundleBytes) throw new Error("artifact_unavailable");
      const buffer = Buffer.alloc(length), { bytesRead } = await handle.read(buffer, 0, length, offset);
      await this.bound(site, raw);
      return { protocol, ...bound.identity, candidate_id: candidateId, artifact_id: artifactId,
        offset, bytes: bytesRead, total: stat.size, eof: offset + bytesRead >= stat.size,
        data: buffer.subarray(0, bytesRead).toString("base64") };
    } finally { await handle.close(); }
  }
}
