import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const KNOWLEDGE_INDEX_CHUNK_MAX_BYTES = 1024 * 1024;
export const KNOWLEDGE_INDEX_DEFAULT_ROOT = "/work/index-jobs";
export const KNOWLEDGE_INDEX_DEFAULT_CHECKOUT = "/work/knowledge-index-source";
export const KNOWLEDGE_INDEX_MIN_FREE_BYTES = 50 * 1024 * 1024 * 1024;
export const KNOWLEDGE_INDEX_DEFAULT_DEADLINE_MS = 4 * 60 * 60_000;
export const KNOWLEDGE_INDEX_LOG_MAX_BYTES = 2 * 1024 * 1024;
/** Terminal payloads remain retryable for one day, capped at the newest 32 jobs. */
export const KNOWLEDGE_INDEX_TERMINAL_TTL_MS = 24 * 60 * 60_000;
export const KNOWLEDGE_INDEX_TERMINAL_MAX_COUNT = 32;
/** Runner publication and bot ingestion intentionally share these fixed ceilings. */
export const KNOWLEDGE_ARTIFACT_MEMBER_MAX_BYTES = 512 * 1024 * 1024;
export const KNOWLEDGE_ARTIFACT_AGGREGATE_MAX_BYTES = 4 * 1024 * 1024 * 1024;
export const KNOWLEDGE_ARTIFACT_MANIFEST_MAX_BYTES = 1024 * 1024;
export const KNOWLEDGE_INDEX_MAX_LAUNCH_ATTEMPTS = 3;
export const KNOWLEDGE_INDEX_LAUNCH_LEASE_MS = 30_000;
const LOG_TAIL_BYTES = 16 * 1024;
const CANCEL_GRACE_MS = 30_000;
const MAX_INPUT_BYTES = 4 * 1024 * 1024 * 1024;
const KNOWLEDGE_JOB_RECORD_MAX_BYTES = 4 * 1024 * 1024;
const CONFORMANCE_OUTPUT_CAPTURE_BYTES = 512 * 1024;
const FIXED_CONFORMANCE_FILES = [
  "packages/bot/src/knowledge/contracts.test.ts",
  "packages/bot/src/session-plus/operation-binding.test.ts",
  "packages/runner/src/agent-control-plane.test.ts",
  "packages/runner/src/omp-rpc.test.ts",
] as const;
const JOB_KEY = /^[0-9a-f]{64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;

export type KnowledgeIndexState = "queued" | "running" | "upload_pending" | "succeeded" | "failed"
  | "cancellation_requested" | "cancelled" | "timed_out" | "orphaned";
export interface KnowledgeIndexArtifactFile { file: string; bytes: number; sha256: string; mtimeMs: number; ino: number }
interface LaunchLease { attempt: number; leasedAt: string }
interface JobRecord {
  version: 1; jobKey: string; repoSha: string; input: { sha256: string; bytes: number; ready: boolean };
  state: KnowledgeIndexState; createdAt: string; updatedAt: string; startedAt?: string; finishedAt?: string;
  deadlineAt?: string; cancellationRequestedAt?: string; error?: { code: string; message: string };
  files: KnowledgeIndexArtifactFile[]; readOffsets: Record<string, number>;
  launchAttempt: number; launchLease?: LaunchLease;
}
interface PidRecord {
  attempt: number;
  wrapperPid: number | null; wrapperPgid: number | null; wrapperStartTicks: string | null;
  workerPid: number | null; workerPgid: number | null; workerStartTicks: string | null;
}
interface RcRecord { attempt: number; rc: number | null; signal?: string | null; timedOut?: boolean; cancelled?: boolean; finishedAt?: string; failureCode?: string }
export interface KnowledgeIndexStatus {
  job_key: string; repo_sha: string; state: KnowledgeIndexState; created_at: string; updated_at: string;
  started_at?: string; finished_at?: string; error?: { code: string; message: string }; log_tail: string;
  files: Array<{ file: string; bytes: number; sha256: string }>;
}
export interface KnowledgeIndexWrapperSpec {
  version: 1; attempt: number; jobDir: string; checkoutRoot: string; inputFile: string; stageDir: string; repoSha: string; deadlineMs: number;
}
export interface KnowledgeIndexManagerOptions {
  jobsRoot?: string; checkoutRoot?: string; wrapperEntry: string; deadlineMs?: number; minFreeBytes?: number;
  inputOrigins?: readonly string[]; now?: () => number; fetch?: typeof fetch; enforceWorkRoots?: boolean;
  reconcileIntervalMs?: number; verifyCheckoutSha?: (root: string, sha: string) => Promise<void>;
  spawnWrapper?: (entry: string, specFile: string, cwd: string, attempt: number) => Promise<PidRecord>;
  signalProcessGroup?: (pgid: number, signal: NodeJS.Signals) => void;
  processAlive?: (pid: number, startTicks: string | null) => Promise<boolean>; freeBytes?: (root: string) => Promise<number>;
}

/** Execution-only Linux endpoints require an explicit opt-in to this fixed job capability. */
export function knowledgeIndexEnabled(input: {
  allowMachineOps: boolean; executionOnly: boolean; platform: NodeJS.Platform; setting?: string;
}): boolean {
  return input.allowMachineOps && input.platform === "linux"
    && input.setting !== "0" && (!input.executionOnly || input.setting === "1");
}

/** Durable, idempotent owner of the single trusted knowledge build command. */
export class KnowledgeIndexManager {
  readonly jobsRoot: string;
  readonly checkoutRoot: string;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly deadlineMs: number;
  private readonly minFreeBytes: number;
  private readonly origins: ReadonlySet<string>;
  private readonly verifyCheckout: (root: string, sha: string) => Promise<void>;
  private readonly spawnJob: (entry: string, specFile: string, cwd: string, attempt: number) => Promise<PidRecord>;
  private readonly signalGroup: (pgid: number, signal: NodeJS.Signals) => void;
  private readonly isAlive: (pid: number, ticks: string | null) => Promise<boolean>;
  private readonly availableBytes: (root: string) => Promise<number>;
  private readonly intervalMs: number;
  private serial: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(private readonly opts: KnowledgeIndexManagerOptions) {
    this.jobsRoot = path.resolve(opts.jobsRoot ?? KNOWLEDGE_INDEX_DEFAULT_ROOT);
    this.checkoutRoot = path.resolve(opts.checkoutRoot ?? KNOWLEDGE_INDEX_DEFAULT_CHECKOUT);
    if (opts.enforceWorkRoots !== false) { assertUnderWork(this.jobsRoot, "jobs root"); assertUnderWork(this.checkoutRoot, "checkout root"); }
    this.now = opts.now ?? Date.now;
    this.fetchImpl = opts.fetch ?? fetch;
    this.deadlineMs = integer(opts.deadlineMs ?? KNOWLEDGE_INDEX_DEFAULT_DEADLINE_MS, 60_000, 24 * 60 * 60_000, "deadline");
    this.minFreeBytes = integer(opts.minFreeBytes ?? KNOWLEDGE_INDEX_MIN_FREE_BYTES, 0, Number.MAX_SAFE_INTEGER, "free space");
    const origins = opts.inputOrigins ?? [];
    if (origins.length === 0) throw new Error("knowledge index jobs require an explicit trusted input origin");
    this.origins = new Set(origins.map((value) => {
      const url = secureHttpOrigin(value, "knowledge index input origin");
      return url.origin;
    }));
    this.verifyCheckout = opts.verifyCheckoutSha ?? verifyExactCheckout;
    this.spawnJob = opts.spawnWrapper ?? spawnDetachedWrapper;
    this.signalGroup = opts.signalProcessGroup ?? ((pgid, signal) => process.kill(-pgid, signal));
    this.isAlive = opts.processAlive ?? processIncarnationAlive;
    this.availableBytes = opts.freeBytes ?? freeBytesAt;
    this.intervalMs = integer(opts.reconcileIntervalMs ?? 1_000, 100, 60_000, "reconcile interval");
  }

  async start(): Promise<void> {
    await mkdir(this.jobsRoot, { recursive: true, mode: 0o700 });
    await chmod(this.jobsRoot, 0o700);
    await this.runSerial(() => this.reconcileLocked());
    this.timer ??= setInterval(() => void this.runSerial(() => this.reconcileLocked()).catch(() => undefined), this.intervalMs);
    this.timer.unref?.();
  }
  close(): void { this.closed = true; if (this.timer) clearInterval(this.timer); this.timer = null; }

  async rpcStart(raw: unknown): Promise<KnowledgeIndexStatus> {
    const input = parseStart(raw);
    return await this.runSerial(async () => {
      if (this.closed) throw new Error("knowledge index manager is closed");
      await this.reconcileLocked();
      const existing = await this.readJob(input.jobKey);
      if (existing) {
        if (existing.repoSha !== input.repoSha || existing.input.sha256 !== input.input.sha256 || existing.input.bytes !== input.input.bytes) {
          throw new Error("job_key is already bound to different immutable inputs");
        }
        if (
          (existing.state === "orphaned" || existing.state === "timed_out")
          && existing.input.ready
          && existing.launchAttempt < KNOWLEDGE_INDEX_MAX_LAUNCH_ATTEMPTS
        ) {
          await this.prepareRetry(existing);
          await this.launchNextLocked();
        } else if (!existing.input.ready && (existing.state === "queued" || existing.state === "orphaned")) {
          existing.state = "queued";
          delete existing.error;
          try {
            await this.materializeInput(existing, input.input.url);
            await this.launchNextLocked();
          } catch (error) {
            existing.state = error instanceof TransientInputError ? "queued" : "failed";
            if (existing.state === "failed") existing.finishedAt = iso(this.now()); else delete existing.finishedAt;
            existing.error = { code: existing.state === "queued" ? "input_pending" : "input_rejected", message: message(error) };
            await this.writeJob(existing);
          }
        }
        return await this.statusOf((await this.readJob(input.jobKey)) ?? existing);
      }
      const now = iso(this.now());
      const job: JobRecord = { version: 1, jobKey: input.jobKey, repoSha: input.repoSha,
        input: { sha256: input.input.sha256, bytes: input.input.bytes, ready: false }, state: "queued",
        createdAt: now, updatedAt: now, files: [], readOffsets: {}, launchAttempt: 0 };
      await this.initializeJob(job);
      if (await this.availableBytes(this.jobsRoot) < this.minFreeBytes) {
        job.state = "failed"; job.finishedAt = iso(this.now());
        job.error = { code: "insufficient_space", message: "knowledge indexing requires at least 50 GiB free under /work" };
        await this.writeJob(job); return await this.statusOf(job);
      }
      try { await this.materializeInput(job, input.input.url); await this.launchNextLocked(); }
      catch (error) {
        job.state = error instanceof TransientInputError ? "queued" : "failed";
        if (job.state === "failed") job.finishedAt = iso(this.now()); else delete job.finishedAt;
        job.error = { code: job.state === "queued" ? "input_pending" : "input_rejected", message: message(error) };
        await this.writeJob(job);
      }
      return await this.statusOf((await this.readJob(input.jobKey)) ?? job);
    });
  }

  async rpcStatus(raw: unknown): Promise<KnowledgeIndexStatus> {
    const key = parseKey(raw);
    return await this.runSerial(async () => { await this.reconcileLocked(); return await this.statusOf(await this.requireJob(key)); });
  }

  async rpcCancel(raw: unknown): Promise<KnowledgeIndexStatus> {
    const key = parseKey(raw);
    return await this.runSerial(async () => {
      await this.reconcileLocked(); const job = await this.requireJob(key);
      if (terminal(job.state) || job.state === "upload_pending") return await this.statusOf(job);
      if (job.state === "queued" || job.state === "orphaned") {
        job.state = "cancelled"; job.finishedAt = iso(this.now());
        await atomicJson(this.rcFile(key), { attempt: job.launchAttempt, rc: null, cancelled: true, finishedAt: job.finishedAt } satisfies RcRecord);
        await this.writeJob(job); await this.launchNextLocked(); return await this.statusOf(job);
      }
      job.state = "cancellation_requested"; job.cancellationRequestedAt = iso(this.now());
      await this.writeJob(job); await this.signalRecorded(key, "SIGTERM"); return await this.statusOf(job);
    });
  }

  async rpcRead(raw: unknown): Promise<{ job_key: string; file: string; offset: number; bytes: number; data: string; eof: boolean; sha256: string }> {
    const request = parseRead(raw);
    return await this.runSerial(async () => {
      await this.reconcileLocked(); const job = await this.requireJob(request.jobKey);
      if (job.state !== "upload_pending" && job.state !== "succeeded") throw new Error(`artifact is not readable in state ${job.state}`);
      const declared = job.files.find((entry) => entry.file === request.file);
      if (!declared) throw new Error("artifact file is not allowlisted by the immutable manifest");
      await assertRegularParents(this.stageDir(job.jobKey), request.file);
      const handle = await open(safeArtifactPath(this.stageDir(job.jobKey), request.file), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      let data = Buffer.alloc(0); let bytesRead = 0;
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size !== declared.bytes || info.ino !== declared.ino || info.mtimeMs !== declared.mtimeMs || (info.mode & 0o222) !== 0) {
          throw new Error("artifact file changed after publication");
        }
        if (request.offset > declared.bytes) throw new Error("offset exceeds artifact size");
        data = Buffer.allocUnsafe(Math.min(request.length, declared.bytes - request.offset));
        ({ bytesRead } = await handle.read(data, 0, data.length, request.offset)); data = data.subarray(0, bytesRead);
      } finally { await handle.close(); }
      const end = request.offset + bytesRead; const current = job.readOffsets[request.file] ?? 0;
      if (request.offset <= current && end > current) job.readOffsets[request.file] = end;
      if (job.state === "upload_pending" && job.files.every((entry) => (job.readOffsets[entry.file] ?? 0) >= entry.bytes)) {
        job.state = "succeeded"; job.finishedAt = iso(this.now());
      }
      await this.writeJob(job);
      return { job_key: job.jobKey, file: request.file, offset: request.offset, bytes: bytesRead,
        data: data.toString("base64"), eof: end === declared.bytes, sha256: declared.sha256 };
    });
  }

  private async initializeJob(job: JobRecord): Promise<void> {
    await mkdir(this.jobDir(job.jobKey), { mode: 0o700 });
    await writeFile(this.logFile(job.jobKey), "", { mode: 0o600, flag: "wx" });
    await atomicJson(this.pidFile(job.jobKey), emptyPid(0));
    await atomicJson(this.rcFile(job.jobKey), { attempt: 0, rc: null } satisfies RcRecord);
    await atomicJson(this.manifestFile(job.jobKey), { version: 1, files: [] });
    await this.writeJob(job);
  }

  private async materializeInput(job: JobRecord, rawUrl: string): Promise<void> {
    const url = this.validateInputUrl(rawUrl); const partial = `${this.inputFile(job.jobKey)}.partial`;
    let response: Response;
    try { response = await this.fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(120_000) }); }
    catch (error) {
      if (transientNetworkError(error)) throw new TransientInputError(`one-use input handoff is temporarily unavailable: ${message(error)}`);
      throw new Error(`one-use input handoff failed closed: ${message(error)}`);
    }
    if (!response.ok || !response.body) {
      if (response.status === 404 || response.status === 410 || response.status === 408 || response.status === 429 || response.status >= 500) {
        throw new TransientInputError(`one-use input handoff returned HTTP ${response.status}`);
      }
      throw new Error(`one-use input handoff returned HTTP ${response.status}`);
    }
    const announced = response.headers.get("content-length");
    if (announced && Number(announced) !== job.input.bytes) throw new Error("input content-length does not match signed size");
    const handle = await open(partial, "w", 0o600); const digest = createHash("sha256"); let bytes = 0;
    try {
      for await (const raw of response.body as unknown as AsyncIterable<Uint8Array>) {
        const chunk = Buffer.from(raw); bytes += chunk.length;
        if (bytes > job.input.bytes) throw new Error("input exceeded signed size"); digest.update(chunk); await handle.write(chunk);
      }
      await handle.sync();
    } catch (error) {
      await rm(partial, { force: true });
      if (transientNetworkError(error)) {
        throw new TransientInputError(`one-use input handoff was interrupted: ${message(error)}`);
      }
      throw error;
    } finally { await handle.close(); }
    if (bytes !== job.input.bytes || digest.digest("hex") !== job.input.sha256) {
      await rm(partial, { force: true });
      throw new Error("input digest/size mismatch");
    }
    await rename(partial, this.inputFile(job.jobKey)); await chmod(this.inputFile(job.jobKey), 0o400);
    job.input.ready = true; job.state = "queued"; await this.writeJob(job);
  }

  private validateInputUrl(raw: string): URL {
    const url = secureHttpUrl(raw, "input URL");
    if (!this.origins.has(url.origin)) throw new Error("input URL origin is not trusted by this Runner");
    if (!/^\/api\/contrib\/bundle\/bt_[0-9a-f]{48}$/.test(url.pathname) || url.search || url.hash) throw new Error("input URL is not an Octopus one-use handoff");
    return url;
  }

  private async reconcileLocked(): Promise<void> {
    const jobs = await this.readAllJobs();
    for (const job of jobs) {
      if (job.state !== "running" && job.state !== "cancellation_requested") continue;
      const rc = await readJson<RcRecord>(this.rcFile(job.jobKey), { attempt: 0, rc: null });
      if (rc.attempt === job.launchAttempt && (rc.rc !== null || rc.timedOut || rc.cancelled)) {
        await this.finishFromRc(job, rc);
        continue;
      }
      const pid = await readJson<PidRecord>(this.pidFile(job.jobKey), emptyPid(0));
      const currentPid = pid.attempt === job.launchAttempt;
      const wrapper = currentPid && pid.wrapperPid != null && await this.isAlive(pid.wrapperPid, pid.wrapperStartTicks);
      const worker = currentPid && pid.workerPid != null && await this.isAlive(pid.workerPid, pid.workerStartTicks);
      if (!wrapper && !worker) {
        const leaseAge = this.now() - Date.parse(job.launchLease?.leasedAt ?? "");
        if (job.launchLease?.attempt === job.launchAttempt && Number.isFinite(leaseAge) && leaseAge < KNOWLEDGE_INDEX_LAUNCH_LEASE_MS) continue;
        job.state = job.state === "cancellation_requested" ? "cancelled" : "orphaned";
        job.finishedAt = iso(this.now());
        if (job.state === "orphaned") job.error = { code: "process_lost", message: "recorded process exited without a durable result" };
        await this.writeJob(job);
        continue;
      }
      if (job.state === "running") await this.authorizeAttempt(job);
      if (job.state === "cancellation_requested" && job.cancellationRequestedAt && this.now() - Date.parse(job.cancellationRequestedAt) >= CANCEL_GRACE_MS) {
        await this.signalRecorded(job.jobKey, "SIGKILL");
      }
      await boundLog(this.logFile(job.jobKey));
    }
    await this.pruneTerminalJobsLocked();
    await this.launchNextLocked();
  }

  private async pruneTerminalJobsLocked(): Promise<void> {
    const now = this.now();
    const jobs = (await this.readAllJobs()).filter((job) => terminal(job.state))
      .sort((a, b) => terminalAt(b) - terminalAt(a) || a.jobKey.localeCompare(b.jobKey));
    for (const [index, job] of jobs.entries()) {
      if (index < KNOWLEDGE_INDEX_TERMINAL_MAX_COUNT && now - terminalAt(job) < KNOWLEDGE_INDEX_TERMINAL_TTL_MS) continue;
      await this.removeJobDirectory(job);
    }
  }

  private async removeJobDirectory(job: JobRecord): Promise<void> {
    if (!JOB_KEY.test(job.jobKey)) return;
    const directory = this.jobDir(job.jobKey);
    if (path.relative(this.jobsRoot, directory) !== job.jobKey) return;
    let info;
    try { info = await lstat(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (!info.isDirectory() || info.isSymbolicLink()) return;
    if (job.files.every((entry) => {
      try { assertArtifactName(entry.file, true); return true; } catch { return false; }
    })) {
      for (const artifactDirectory of artifactDirectories(this.stageDir(job.jobKey), job.files)) {
        try {
          const artifactInfo = await lstat(artifactDirectory);
          if (artifactInfo.isDirectory() && !artifactInfo.isSymbolicLink()) await chmod(artifactDirectory, 0o700);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
    await rm(directory, { recursive: true, force: true });
  }

  private async finishFromRc(job: JobRecord, rc: RcRecord): Promise<void> {
    job.finishedAt = rc.finishedAt ?? iso(this.now());
    if (job.state === "cancellation_requested" || rc.cancelled) job.state = "cancelled";
    else if (rc.timedOut) { job.state = "timed_out"; job.error = { code: "deadline", message: "fixed build deadline exceeded" }; }
    else if (rc.rc !== 0) {
      const failureCode = typeof rc.failureCode === "string" && /^[a-z0-9_:,.-]{1,100}$/u.test(rc.failureCode)
        ? rc.failureCode
        : "builder_failed";
      job.state = "failed";
      job.error = { code: failureCode, message: `builder exited with rc ${String(rc.rc)}` };
    }
    else {
      try { job.files = await this.verifyArtifact(job); job.readOffsets = Object.fromEntries(job.files.map((entry) => [entry.file, 0])); job.state = "upload_pending"; delete job.error; }
      catch (error) { job.state = "failed"; job.error = { code: "manifest_rejected", message: message(error) }; }
    }
    await boundLog(this.logFile(job.jobKey)); await this.writeJob(job);
  }

  private async prepareRetry(job: JobRecord): Promise<void> {
    job.state = "queued";
    delete job.finishedAt;
    delete job.deadlineAt;
    delete job.cancellationRequestedAt;
    delete job.error;
    job.files = [];
    job.readOffsets = {};
    await this.writeJob(job);
  }

  private async authorizeAttempt(job: JobRecord): Promise<void> {
    if (job.state !== "running" || job.launchLease?.attempt !== job.launchAttempt) return;
    const file = this.authorizationFile(job.jobKey, job.launchAttempt);
    await atomicJson(file, { version: 1, attempt: job.launchAttempt });
    await chmod(file, 0o400);
  }

  private async launchNextLocked(): Promise<void> {
    const jobs = await this.readAllJobs();
    if (jobs.some((job) => job.state === "running" || job.state === "cancellation_requested")) return;
    const job = jobs.filter((row) => row.state === "queued" && row.input.ready)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.jobKey.localeCompare(b.jobKey))[0];
    if (!job) return;
    if (job.launchAttempt >= KNOWLEDGE_INDEX_MAX_LAUNCH_ATTEMPTS) {
      job.state = "orphaned";
      job.finishedAt = iso(this.now());
      job.error = { code: "process_lost", message: "fixed launch attempt budget exhausted" };
      await this.writeJob(job);
      return;
    }
    if (await this.availableBytes(this.jobsRoot) < this.minFreeBytes) {
      job.state = "failed";
      job.finishedAt = iso(this.now());
      job.error = { code: "insufficient_space", message: "knowledge indexing requires at least 50 GiB free under /work" };
      await this.writeJob(job);
      return;
    }
    try {
      await this.verifyCheckout(this.checkoutRoot, job.repoSha);
      const attempt = job.launchAttempt + 1;
      const leasedAt = iso(this.now());
      const spec: KnowledgeIndexWrapperSpec = { version: 1, attempt, jobDir: this.jobDir(job.jobKey), checkoutRoot: this.checkoutRoot,
        inputFile: this.inputFile(job.jobKey), stageDir: this.stageDir(job.jobKey), repoSha: job.repoSha, deadlineMs: this.deadlineMs };
      const specFile = path.join(this.jobDir(job.jobKey), `wrapper-spec.${attempt}.json`);
      await atomicJson(specFile, spec);
      await chmod(specFile, 0o400);
      job.state = "running";
      job.launchAttempt = attempt;
      job.launchLease = { attempt, leasedAt };
      job.startedAt = leasedAt;
      job.deadlineAt = iso(this.now() + this.deadlineMs);
      delete job.finishedAt;
      delete job.error;
      await this.writeJob(job);
      await atomicJson(this.pidFile(job.jobKey), emptyPid(attempt));
      await atomicJson(this.rcFile(job.jobKey), { attempt, rc: null } satisfies RcRecord);
      try {
        const pid = await this.spawnJob(path.resolve(this.opts.wrapperEntry), specFile, this.checkoutRoot, attempt);
        if (pid.attempt !== attempt) throw new Error("wrapper returned a stale launch attempt");
        await atomicJson(this.pidFile(job.jobKey), pid);
        await this.authorizeAttempt(job);
      } catch (error) {
        job.error = { code: "launch_pending", message: `detached launch outcome is indeterminate: ${message(error)}` };
        await this.writeJob(job);
      }
    } catch (error) {
      if (job.state === "running") return;
      job.state = "failed";
      job.finishedAt = iso(this.now());
      job.error = { code: "launch_rejected", message: message(error) };
      await this.writeJob(job);
    }
  }

  private async verifyArtifact(job: JobRecord): Promise<KnowledgeIndexArtifactFile[]> {
    const stage = this.stageDir(job.jobKey);
    const manifestFile = path.join(stage, "knowledge-artifact-manifest.json");
    const source = await readBoundedRegularFile(manifestFile, KNOWLEDGE_ARTIFACT_MANIFEST_MAX_BYTES, "combined manifest");
    const raw = source.toString("utf8");
    const manifest = JSON.parse(raw) as Record<string, unknown>;
    if (manifest.schemaVersion !== 1 || manifest.kind !== "octopus-knowledge-artifact" || manifest.repoSha !== job.repoSha) throw new Error("combined manifest identity/SHA is invalid");
    const input = record(manifest.input); if (input.sha256 !== job.input.sha256 || input.bytes !== job.input.bytes) throw new Error("combined manifest input binding mismatch");
    const digest = String(manifest.manifestDigest ?? ""); const unsigned = { ...manifest }; delete unsigned.manifestDigest;
    if (!SHA256.test(digest) || sha256Buffer(Buffer.from(canonicalJson(unsigned))) !== digest) throw new Error("combined manifest digest mismatch");
    if (!Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 31) throw new Error("combined manifest file list is invalid");
    const declared: Array<{ file: string; bytes: number; sha256: string }> = [];
    const seen = new Set<string>();
    let aggregateBytes = source.length;
    for (const rawEntry of manifest.files) {
      const entry = record(rawEntry); const file = String(entry.path ?? ""); const bytes = entry.bytes; const sha256 = String(entry.sha256 ?? "");
      assertArtifactName(file); if (seen.has(file)) throw new Error(`duplicate artifact ${file}`); seen.add(file);
      if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > KNOWLEDGE_ARTIFACT_MEMBER_MAX_BYTES || !SHA256.test(sha256)) {
        throw new Error(`invalid or oversized artifact metadata for ${file}`);
      }
      aggregateBytes += bytes;
      if (!Number.isSafeInteger(aggregateBytes) || aggregateBytes > KNOWLEDGE_ARTIFACT_AGGREGATE_MAX_BYTES) {
        throw new Error("artifact aggregate exceeds fixed byte ceiling");
      }
      declared.push({ file, bytes, sha256 });
    }
    const files: KnowledgeIndexArtifactFile[] = [];
    for (const entry of declared) files.push(await verifiedFile(stage, entry.file, entry.bytes, entry.sha256));
    files.push(await verifiedFile(stage, "knowledge-artifact-manifest.json", source.length, sha256Buffer(source)));
    files.sort((a, b) => a.file.localeCompare(b.file));
    await atomicJson(this.manifestFile(job.jobKey), { version: 1, repoSha: job.repoSha, input: job.input, manifestDigest: digest, files });
    for (const entry of files) await chmod(safeArtifactPath(stage, entry.file), 0o400);
    for (const directory of artifactDirectories(stage, files).sort((a, b) => b.length - a.length)) await chmod(directory, 0o500);
    return files;
  }

  private async signalRecorded(key: string, signal: NodeJS.Signals): Promise<void> {
    const job = await this.requireJob(key);
    const pid = await readJson<PidRecord>(this.pidFile(key), emptyPid(0));
    if (pid.attempt !== job.launchAttempt) return;
    for (const pgid of new Set([pid.workerPgid, pid.wrapperPgid])) if (pgid && pgid > 1) {
      try { this.signalGroup(pgid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
  }
  private async readAllJobs(): Promise<JobRecord[]> {
    let names: string[]; try { names = await readdir(this.jobsRoot); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const jobs: JobRecord[] = [];
    for (const name of names.sort()) {
      if (!JOB_KEY.test(name)) continue;
      try {
        const info = await lstat(this.jobDir(name));
        if (!info.isDirectory() || info.isSymbolicLink()) continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const job = await this.readJob(name);
      if (job) jobs.push(job);
    }
    return jobs;
  }
  private async readJob(key: string): Promise<JobRecord | null> {
    try {
      const job = JSON.parse(await readFile(this.jobFile(key), "utf8")) as JobRecord;
      const lease = job.launchLease === undefined ? undefined : record(job.launchLease);
      const input = record(job.input);
      const states: KnowledgeIndexState[] = ["queued", "running", "upload_pending", "succeeded", "failed", "cancellation_requested", "cancelled", "timed_out", "orphaned"];
      if (
        job.version !== 1
        || job.jobKey !== key
        || !GIT_SHA.test(job.repoSha)
        || !states.includes(job.state)
        || !SHA256.test(String(input.sha256 ?? ""))
        || typeof input.bytes !== "number"
        || !Number.isSafeInteger(input.bytes)
        || typeof input.ready !== "boolean"
        || !Array.isArray(job.files)
        || !job.readOffsets
        || typeof job.readOffsets !== "object"
        || Array.isArray(job.readOffsets)
        || !Number.isSafeInteger(job.launchAttempt)
        || job.launchAttempt < 0
        || (lease !== undefined && (
          lease.attempt !== job.launchAttempt
          || typeof lease.leasedAt !== "string"
          || !Number.isFinite(Date.parse(lease.leasedAt))
        ))
        || job.launchAttempt > KNOWLEDGE_INDEX_MAX_LAUNCH_ATTEMPTS
      ) throw new Error("invalid durable job");
      return job;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  private async requireJob(key: string): Promise<JobRecord> { const job = await this.readJob(key); if (!job) throw new Error("knowledge index job not found"); return job; }
  private async writeJob(job: JobRecord): Promise<void> { job.updatedAt = iso(this.now()); await atomicJson(this.jobFile(job.jobKey), job); }
  private async statusOf(job: JobRecord): Promise<KnowledgeIndexStatus> {
    return { job_key: job.jobKey, repo_sha: job.repoSha, state: job.state, created_at: job.createdAt, updated_at: job.updatedAt,
      ...(job.startedAt ? { started_at: job.startedAt } : {}), ...(job.finishedAt ? { finished_at: job.finishedAt } : {}),
      ...(job.error ? { error: job.error } : {}), log_tail: await readLogTail(this.logFile(job.jobKey)),
      files: job.files.map(({ file, bytes, sha256 }) => ({ file, bytes, sha256 })) };
  }
  private runSerial<T>(fn: () => Promise<T>): Promise<T> { const next = this.serial.then(fn, fn); this.serial = next.then(() => undefined, () => undefined); return next; }
  private jobDir(key: string): string { return path.join(this.jobsRoot, key); }
  private jobFile(key: string): string { return path.join(this.jobDir(key), "job.json"); }
  private pidFile(key: string): string { return path.join(this.jobDir(key), "pid.json"); }
  private rcFile(key: string): string { return path.join(this.jobDir(key), "rc.json"); }
  private manifestFile(key: string): string { return path.join(this.jobDir(key), "manifest.json"); }
  private logFile(key: string): string { return path.join(this.jobDir(key), "build.log"); }
  private inputFile(key: string): string { return path.join(this.jobDir(key), "contextual-records.jsonl"); }
  private authorizationFile(key: string, attempt: number): string { return path.join(this.jobDir(key), `launch-${attempt}.authorized`); }
  private stageDir(key: string): string { return path.join(this.jobDir(key), "artifact"); }
}

/** Detached helper entry; survives Runner websocket/process replacement. */
export async function runKnowledgeIndexJobWrapper(specFile: string): Promise<void> {
  const spec = JSON.parse(await readFile(specFile, "utf8")) as KnowledgeIndexWrapperSpec;
  if (spec.version !== 1 || !GIT_SHA.test(spec.repoSha) || !Number.isSafeInteger(spec.attempt) || spec.attempt < 1 || spec.attempt > KNOWLEDGE_INDEX_MAX_LAUNCH_ATTEMPTS) throw new Error("invalid wrapper spec");
  if (path.basename(specFile) !== `wrapper-spec.${spec.attempt}.json`) throw new Error("wrapper spec is not bound to its launch attempt");
  for (const value of [spec.jobDir, spec.checkoutRoot, spec.inputFile, spec.stageDir]) if (!path.isAbsolute(value)) throw new Error("wrapper paths must be absolute");
  const wrapperStartTicks = await procTicks(process.pid);
  await atomicJson(path.join(spec.jobDir, "pid.json"), {
    attempt: spec.attempt,
    wrapperPid: process.pid,
    wrapperPgid: process.pid,
    wrapperStartTicks,
    workerPid: null,
    workerPgid: null,
    workerStartTicks: null,
  } satisfies PidRecord);
  const job = await readJson<JobRecord | null>(path.join(spec.jobDir, "job.json"), null);
  if (!job || job.state !== "running" || job.launchAttempt !== spec.attempt || job.launchLease?.attempt !== spec.attempt) return;
  let authorized = false;
  const authorizationFile = path.join(spec.jobDir, `launch-${spec.attempt}.authorized`);
  for (let poll = 0; poll < Math.ceil(KNOWLEDGE_INDEX_LAUNCH_LEASE_MS / 20); poll++) {
    const current = await readJson<JobRecord | null>(path.join(spec.jobDir, "job.json"), null);
    if (!current || current.state !== "running" || current.launchAttempt !== spec.attempt) return;
    const grant = await readJson<{ version: number; attempt: number } | null>(authorizationFile, null);
    if (grant?.version === 1 && grant.attempt === spec.attempt) {
      authorized = true;
      break;
    }
    await delay(20);
  }
  if (!authorized) return;
  const logFile = path.join(spec.jobDir, "build.log"); let writes = Promise.resolve();
  let workerPid: number | null = null;
  let timedOut = false; let cancelled = false; let killTimer: NodeJS.Timeout | null = null;
  const terminate = (why: "timeout" | "cancel") => {
    timedOut ||= why === "timeout"; cancelled ||= why === "cancel";
    if (workerPid == null) return;
    const targetPid = workerPid;
    try { process.kill(-targetPid, "SIGTERM"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    killTimer ??= setTimeout(() => { try { process.kill(-targetPid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } }, CANCEL_GRACE_MS - 1_000);
    killTimer.unref?.();
  };
  const onTerm = () => terminate("cancel");
  process.on("SIGTERM", onTerm); process.on("SIGINT", onTerm);
  const deadline = setTimeout(() => terminate("timeout"), spec.deadlineMs); deadline.unref?.();
  let outcome: { code: number | null; signal: NodeJS.Signals | null } = { code: 127, signal: null };
  let failureCode: string | undefined;
  for (let conformanceAttempt = 0; conformanceAttempt < 2; conformanceAttempt += 1) {
    let spawnFailure: string | null = null;
    let outputTail = "";
    const child = spawn("/usr/bin/ionice", ["-c", "3", "/usr/bin/nice", "-n", "10", "pnpm", "knowledge:artifact:build",
      "--root", spec.checkoutRoot, "--input", spec.inputFile, "--out", spec.stageDir, "--repo-sha", spec.repoSha],
    { cwd: spec.checkoutRoot, detached: true, stdio: ["ignore", "pipe", "pipe"], env: builderEnv() });
    const outcomePromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("error", (error) => { spawnFailure = message(error); resolve({ code: 127, signal: null }); });
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    workerPid = child.pid ?? null;
    const workerTicks = workerPid == null ? null : await procTicks(workerPid).catch(() => null);
    await atomicJson(path.join(spec.jobDir, "pid.json"), {
      attempt: spec.attempt,
      wrapperPid: process.pid,
      wrapperPgid: process.pid,
      wrapperStartTicks,
      workerPid,
      workerPgid: workerPid,
      workerStartTicks: workerTicks,
    } satisfies PidRecord);
    const append = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      outputTail = `${outputTail}${text}`.slice(-CONFORMANCE_OUTPUT_CAPTURE_BYTES);
      writes = writes.then(() => appendLog(logFile, text));
    };
    child.stdout?.on("data", append); child.stderr?.on("data", append);
    outcome = await outcomePromise;
    await writes;
    if (spawnFailure) await appendLog(logFile, `\n[octopus] builder spawn failed: ${spawnFailure}\n`);
    await appendLog(logFile, `\n[octopus] builder finished rc=${String(outcome.code)} signal=${String(outcome.signal)}\n`);
    const conformance = conformanceRetryResult({
      attempt: conformanceAttempt,
      exitCode: outcome.code,
      timedOut,
      cancelled,
      output: outputTail,
    });
    if (conformance.retry) {
      await appendLog(logFile, `\n[octopus] retrying failed conformance files once in the same durable job: ${conformance.names.join(",") || "unknown"}\n`);
      continue;
    }
    failureCode = conformance.failureCode;
    break;
  }
  clearTimeout(deadline); if (killTimer) clearTimeout(killTimer);
  process.off("SIGTERM", onTerm); process.off("SIGINT", onTerm);
  await writes;
  await atomicJson(path.join(spec.jobDir, "rc.json"), {
    attempt: spec.attempt,
    rc: outcome.code,
    signal: outcome.signal,
    timedOut,
    cancelled,
    finishedAt: iso(Date.now()),
    ...(failureCode ? { failureCode } : {}),
  } satisfies RcRecord);
}

export function fixedConformanceFailure(output: string): { detected: boolean; names: string[] } {
  const detected = /fixed conformance test file\(s\) failed/iu.test(output);
  if (!detected) return { detected: false, names: [] };
  const lines = output.split(/\r?\n/u);
  const names = FIXED_CONFORMANCE_FILES.filter((file) => lines.some((line) =>
    line.includes(file) && /(?:^|\s)(?:FAIL|failed|❯)(?:\s|$)/iu.test(line),
  )).map((file) => path.basename(file).replace(/\.test\.ts$/u, ""));
  return { detected: true, names };
}

export function conformanceFailureCode(names: readonly string[]): string {
  const bounded = names.length ? names : ["unknown"];
  return `conformance_failed:${bounded.join(",")}`.slice(0, 100);
}

export function conformanceRetryResult(input: {
  attempt: number;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  output: string;
}): { retry: boolean; names: string[]; failureCode?: string } {
  const conformance = fixedConformanceFailure(input.output);
  const failed = input.exitCode !== 0;
  return {
    retry: input.attempt === 0 && failed && !input.timedOut && !input.cancelled && conformance.detected,
    names: conformance.names,
    ...(failed && conformance.detected ? { failureCode: conformanceFailureCode(conformance.names) } : {}),
  };
}

function parseStart(value: unknown) {
  const args = closed(value, ["job_key", "repo_sha", "input"]); const input = closed(args.input, ["url", "sha256", "bytes"]);
  const jobKey = String(args.job_key ?? ""), repoSha = String(args.repo_sha ?? ""), url = String(input.url ?? ""), sha256 = String(input.sha256 ?? ""), bytes = Number(input.bytes);
  if (!JOB_KEY.test(jobKey) || !GIT_SHA.test(repoSha) || !SHA256.test(sha256)) throw new Error("invalid immutable job identity");
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_INPUT_BYTES || !url || url.length > 2_048) throw new Error("invalid bounded input handoff");
  return { jobKey, repoSha, input: { url, sha256, bytes } };
}
function parseKey(value: unknown): string { const key = String(closed(value, ["job_key"]).job_key ?? ""); if (!JOB_KEY.test(key)) throw new Error("invalid job_key"); return key; }
function parseRead(value: unknown) {
  const args = closed(value, ["job_key", "file", "offset", "length"]); const jobKey = String(args.job_key ?? ""), file = String(args.file ?? ""), offset = Number(args.offset), length = Number(args.length);
  if (!JOB_KEY.test(jobKey)) throw new Error("invalid job_key"); assertArtifactName(file, true);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > KNOWLEDGE_INDEX_CHUNK_MAX_BYTES) throw new Error("invalid immutable chunk range");
  return { jobKey, file, offset, length };
}
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("RPC args must be an object"); const row = value as Record<string, unknown>, allowed = new Set(keys);
  for (const key of Object.keys(row)) if (!allowed.has(key)) throw new Error(`unknown RPC argument: ${key}`); return row;
}
function assertArtifactName(file: string, manifest = false): void {
  if (!file || file.length > 240 || file.includes("\\") || file.startsWith("/") || file.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("unsafe artifact path");
  if (!(file.startsWith("code/") || file.startsWith("vector/") || file.startsWith("model/") || file === "conformance-tests.json" || (manifest && file === "knowledge-artifact-manifest.json")) || !/^[A-Za-z0-9._/-]+$/.test(file)) throw new Error("artifact path is outside allowlist");
}
function safeArtifactPath(root: string, file: string): string { assertArtifactName(file, true); const result = path.resolve(root, file); if (!result.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error("artifact traversal refused"); return result; }
async function verifiedFile(root: string, file: string, bytes: number, sha256: string): Promise<KnowledgeIndexArtifactFile> {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > KNOWLEDGE_ARTIFACT_MEMBER_MAX_BYTES) throw new Error(`artifact member exceeds fixed byte ceiling: ${file}`);
  await assertRegularParents(root, file);
  const filename = safeArtifactPath(root, file), info = await lstat(filename); if (!info.isFile() || info.isSymbolicLink() || info.size !== bytes || await sha256File(filename) !== sha256) throw new Error(`artifact checksum/type mismatch: ${file}`);
  return { file, bytes, sha256, mtimeMs: info.mtimeMs, ino: info.ino };
}
async function assertRegularParents(root: string, file: string): Promise<void> {
  let current = path.resolve(root);
  for (const part of file.split("/").slice(0, -1)) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`artifact parent is not a regular directory: ${file}`);
  }
}
function artifactDirectories(root: string, files: readonly KnowledgeIndexArtifactFile[]): string[] {
  const result = new Set([path.resolve(root)]);
  for (const entry of files) {
    let current = path.resolve(root);
    for (const part of entry.file.split("/").slice(0, -1)) {
      current = path.join(current, part);
      result.add(current);
    }
  }
  return [...result];
}
async function verifyExactCheckout(root: string, sha: string): Promise<void> { const { stdout } = await execFileAsync("git", ["-C", root, "rev-parse", "--verify", "HEAD^{commit}"], { timeout: 30_000, maxBuffer: 64 * 1024, env: builderEnv() }); if (stdout.trim() !== sha) throw new Error("trusted checkout is not at exact SHA"); }
async function spawnDetachedWrapper(entry: string, specFile: string, cwd: string, attempt: number): Promise<PidRecord> {
  const child = spawn(process.execPath, [entry, "knowledge-index-job", specFile], { cwd, detached: true, stdio: "ignore", env: builderEnv() });
  if (!child.pid) throw new Error("wrapper failed to start");
  child.unref();
  const initial: PidRecord = {
    attempt,
    wrapperPid: child.pid,
    wrapperPgid: child.pid,
    wrapperStartTicks: await procTicks(child.pid),
    workerPid: null,
    workerPgid: null,
    workerStartTicks: null,
  };
  const spec = JSON.parse(await readFile(specFile, "utf8")) as KnowledgeIndexWrapperSpec;
  if (spec.attempt !== attempt) throw new Error("wrapper spec launch attempt mismatch");
  for (let poll = 0; poll < 250; poll++) {
    const recorded = await readJson<PidRecord>(path.join(spec.jobDir, "pid.json"), emptyPid(attempt));
    if (recorded.attempt === attempt && recorded.wrapperPid === child.pid) return recorded;
    await delay(20);
  }
  return initial;
}
async function processIncarnationAlive(pid: number, ticks: string | null): Promise<boolean> { try { process.kill(pid, 0); return !ticks || await procTicks(pid) === ticks; } catch { return false; } }
async function procTicks(pid: number): Promise<string> { const raw = await readFile(`/proc/${pid}/stat`, "utf8"), end = raw.lastIndexOf(")"), value = raw.slice(end + 2).split(" ")[19]; if (end < 0 || !/^\d+$/.test(value ?? "")) throw new Error("cannot read process incarnation"); return value; }
async function freeBytesAt(root: string): Promise<number> { const fs = await statfs(root, { bigint: true }), value = fs.bavail * fs.bsize; return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value); }
function assertUnderWork(root: string, label: string) { if (root !== "/work" && !root.startsWith("/work/")) throw new Error(`${label} must be under /work`); }
function terminal(state: KnowledgeIndexState) { return ["succeeded", "failed", "cancelled", "timed_out", "orphaned"].includes(state); }
function terminalAt(job: JobRecord): number {
  const value = Date.parse(job.finishedAt ?? job.updatedAt ?? job.createdAt);
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}
function integer(value: number, min: number, max: number, label: string) { if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} outside bound`); return value; }
function iso(value: number) { return new Date(value).toISOString(); }
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function emptyPid(attempt: number): PidRecord { return { attempt, wrapperPid: null, wrapperPgid: null, wrapperStartTicks: null, workerPid: null, workerPgid: null, workerStartTicks: null }; }
function loopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return true;
  const octets = host.split(".");
  return octets.length === 4 && octets.every((value) => /^\d{1,3}$/.test(value) && Number(value) <= 255) && Number(octets[0]) === 127;
}
function secureHttpUrl(raw: string, label: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`${label} is invalid`); }
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopbackHost(url.hostname))) || url.username || url.password) {
    throw new Error(`${label} must use HTTPS except on an explicit loopback host`);
  }
  return url;
}
function secureHttpOrigin(raw: string, label: string): URL {
  const url = secureHttpUrl(raw, label);
  if (url.pathname !== "/" || url.search || url.hash) throw new Error(`${label} must be an origin`);
  return url;
}
async function readBoundedRegularFile(file: string, maxBytes: number, label: string): Promise<Buffer> {
  const handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) throw new Error(`${label} exceeds fixed byte ceiling`);
    const buffer = Buffer.allocUnsafe(info.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) throw new Error(`${label} changed while being read`);
      offset += bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    if ((await handle.read(extra, 0, 1, buffer.length)).bytesRead !== 0) throw new Error(`${label} changed while being read`);
    return buffer;
  } finally {
    await handle.close();
  }
}
function transientNetworkError(error: unknown): boolean {
  if (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) return true;
  const row = record(error);
  const code = String(row.code ?? record(row.cause).code ?? "");
  const transientCodes: Record<string, true> = {
    EAI_AGAIN: true,
    ECONNREFUSED: true,
    ECONNRESET: true,
    EHOSTUNREACH: true,
    ENETUNREACH: true,
    EPIPE: true,
    ETIMEDOUT: true,
    UND_ERR_CONNECT_TIMEOUT: true,
    UND_ERR_SOCKET: true,
  };
  return transientCodes[code] === true;
}
class TransientInputError extends Error {}
async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const source = await readBoundedRegularFile(file, KNOWLEDGE_JOB_RECORD_MAX_BYTES, "knowledge job state");
    return JSON.parse(source.toString("utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}
function message(error: unknown) { return redact(error instanceof Error ? error.message : String(error)).slice(0, 500); }
async function atomicJson(file: string, value: unknown) {
  const temporary = `${file}.${process.pid}.tmp`;
  const handle = await open(temporary, "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
  await chmod(file, 0o600);
  const directory = await open(path.dirname(file), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}
async function sha256File(file: string) { const hash = createHash("sha256"); for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer); return hash.digest("hex"); }
function sha256Buffer(value: Buffer) { return createHash("sha256").update(value).digest("hex"); }
function canonicalJson(value: unknown): string { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; const row = value as Record<string, unknown>; return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(",")}}`; }
function redact(value: string) { return value.replace(/\b(authorization|api[_-]?key|token|secret|password)\s*[:=]\s*[^\s]+/gi, "$1=[REDACTED]").replace(/\b(?:sk|rt|bt)_[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]").replace(/https?:\/\/[^\s/]+\/api\/contrib\/bundle\/bt_[0-9a-f]{48}/g, "[ONE-USE-INPUT]"); }
async function appendLog(file: string, text: string) { await writeFile(file, redact(text), { flag: "a", mode: 0o600 }); await boundLog(file); }
async function boundLog(file: string) { const info = await stat(file); if (info.size <= KNOWLEDGE_INDEX_LOG_MAX_BYTES) return; const handle = await open(file, "r"), keep = Buffer.allocUnsafe(KNOWLEDGE_INDEX_LOG_MAX_BYTES / 2); try { await handle.read(keep, 0, keep.length, info.size - keep.length); } finally { await handle.close(); } await writeFile(file, Buffer.concat([Buffer.from("[octopus] earlier bounded log omitted\n"), keep]), { mode: 0o600 }); }
async function readLogTail(file: string) { try { const info = await stat(file), length = Math.min(info.size, LOG_TAIL_BYTES), handle = await open(file, "r"), buffer = Buffer.allocUnsafe(length); try { await handle.read(buffer, 0, length, info.size - length); } finally { await handle.close(); } return redact(buffer.toString("utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; } }
function builderEnv(): NodeJS.ProcessEnv { const allowed = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "PNPM_HOME", "COREPACK_HOME", "NODE_OPTIONS", "OCTOPUS_KNOWLEDGE_MODEL_DIR", "TRANSFORMERS_CACHE", "HF_HOME"]; return Object.fromEntries(allowed.flatMap((key) => process.env[key] == null ? [] : [[key, process.env[key]]])) as NodeJS.ProcessEnv; }
