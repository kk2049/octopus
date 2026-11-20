import { validateMossPacket, type MossPacket } from "./meeting-transcription-integrity.js";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, open, opendir, readFile, rename, statfs } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { MOSS_WORKER } from "./meeting-transcription-worker.js";
import { MEETING_TRANSCRIPTION_PROTOCOL as PROTOCOL, MEETING_TRANSCRIPTION_LIMITS as LIMITS, MEETING_TRANSCRIPTION_ARTIFACTS, MEETING_TRANSCRIPTION_LEGACY_INPUT_BYTES,
  parseMeetingTranscriptionRequest, meetingTranscriptionTerminal, type MeetingTranscriptionAction,
  type MeetingTranscriptionAdvertisement, type MeetingTranscriptionStatus, type MeetingTranscriptionChunk,
  type MeetingTranscriptionArtifact, type MeetingTranscriptionState } from "./meeting-transcription-protocol.js";
export * from "./meeting-transcription-protocol.js";
const exec = promisify(execFile);
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const KEY = /^[0-9a-f]{64}$/;
const DISK_RESERVE_BYTES = 1024 ** 3;
export interface MeetingTranscriptionConfig { version: 1; jobsRoot: string; script: string; scriptSha256: string;
  pipeline: string; pipelineSha256: string; python: string; modelDir: string; deadlineMs?: number }
interface PublishedFile extends MeetingTranscriptionArtifact { ino: number; mtimeMs: number }
interface Job { version: 1; key: string; digest: string; bytes: number; title: string; state: MeetingTranscriptionState;
  received: number; created: string; deadline?: number; launched?: number; error?: string; files: PublishedFile[] }
interface ProcessIdentity { pid: number; ticks: string }
interface ManagerOptions { probe?: () => Promise<void>; now?: () => number;
  spawn?: (config: MeetingTranscriptionConfig, settings: Record<string, unknown>) => Promise<void> }
const artifactNames = [ ...MEETING_TRANSCRIPTION_ARTIFACTS,
  ...["asr", "recovery-1", "recovery-2", "recovery-3"].flatMap(prefix =>
    ["manifest.json", "runtime.json", "model-raw.txt", "inference.json", "quality.json", "complete.json"].map(name => `${prefix}/${name}`)) ];
export function transcriptionAdvertisement(available: boolean, reason?: MeetingTranscriptionAdvertisement["reason"]): MeetingTranscriptionAdvertisement {
  return { protocol: PROTOCOL, available, ...(reason ? { reason } : {}), backend: "MOSS-Transcribe-Diarize",
    concurrency: 1, max_input_bytes: MEETING_TRANSCRIPTION_LEGACY_INPUT_BYTES, max_chunk_bytes: LIMITS.chunkBytes, max_recording_bytes: LIMITS.inputBytes };
}
export async function readMeetingTranscriptionConfig(home: string): Promise<MeetingTranscriptionConfig | null> {
  const filename = path.join(home, ".octopus", "runner", "meeting-transcription.json");
  let info; try { info = await lstat(filename); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 || (info.mode & 0o077) !== 0
    || (typeof process.getuid === "function" && info.uid !== process.getuid())) throw new Error("transcription configuration must be a private owned regular file");
  const value = JSON.parse(await readFile(filename, "utf8")) as MeetingTranscriptionConfig;
  if (!value || value.version !== 1 || Object.keys(value).some(key => !["version", "jobsRoot", "script", "scriptSha256", "pipeline", "pipelineSha256", "python", "modelDir", "deadlineMs"].includes(key))) throw new Error("invalid transcription configuration");
  for (const name of ["jobsRoot", "script", "pipeline", "python", "modelDir"] as const)
    if (typeof value[name] !== "string" || !path.isAbsolute(value[name]) || value[name].includes("\0") || value[name].length > 4096) throw new Error(`invalid transcription ${name}`);
  if (!KEY.test(value.scriptSha256) || !KEY.test(value.pipelineSha256) || (value.deadlineMs !== undefined &&
    (!Number.isSafeInteger(value.deadlineMs) || value.deadlineMs < 60_000 || value.deadlineMs > LIMITS.deadlineMs))) throw new Error("invalid transcription pin or deadline");
  return value;
}
async function atomic(filename: string, value: unknown): Promise<void> {
  const temporary = `${filename}.${randomUUID()}.tmp`, handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, filename);
  const parent = await open(path.dirname(filename), "r"); try { await parent.sync(); } finally { await parent.close(); }
}
async function json<T>(filename: string): Promise<T | null> {
  try {
    const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const info = await handle.stat(); if (!info.isFile() || info.size > 256 * 1024) throw new Error("transcription record exceeds budget"); return JSON.parse(await handle.readFile("utf8")) as T; }
    finally { await handle.close(); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
async function regular(filename: string, max: number): Promise<Buffer> {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const info = await handle.stat(); if (!info.isFile() || info.size > max) throw new Error("invalid transcription file"); return await handle.readFile(); }
  finally { await handle.close(); }
}
/** Whole-file digest by sequential window reads; a recording of any size is never buffered whole. */
async function streamedDigest(filename: string): Promise<{ bytes: number; sha256: string }> {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat(); if (!info.isFile()) throw new Error("invalid transcription file");
    const hash = createHash("sha256"), window = Buffer.alloc(LIMITS.chunkBytes * 4); let bytes = 0;
    for (;;) {
      const { bytesRead } = await handle.read(window, 0, window.length, bytes);
      if (!bytesRead) break;
      hash.update(window.subarray(0, bytesRead)); bytes += bytesRead;
    }
    return { bytes, sha256: hash.digest("hex") };
  } finally { await handle.close(); }
}
async function processAlive(identity: ProcessIdentity | null): Promise<boolean> {
  if (!identity || !Number.isSafeInteger(identity.pid) || identity.pid <= 1 || !/^\d+$/.test(identity.ticks)) return false;
  try { const stat = await readFile(`/proc/${identity.pid}/stat`, "utf8"); const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" "); return fields[0] !== "Z" && fields[19] === identity.ticks; }
  catch { return false; }
}
async function defaultSpawn(config: MeetingTranscriptionConfig, settings: Record<string, unknown>): Promise<void> {
  const job = String(settings.job), log = await open(path.join(job, "run.log"), "ax", 0o600);
  try {
    const child = spawn(config.python, ["-u", "-c", MOSS_WORKER, JSON.stringify(settings)], { cwd: path.dirname(config.script), detached: true,
      stdio: ["ignore", log.fd, log.fd], env: { ...process.env, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1", OMP_NUM_THREADS: "4" } });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); }); child.unref();
  } finally { await log.close(); }
}
/** Fixed pipeline, persistent receipts, one writer per daemon and one GPU lock across daemon lifetimes. */
export class MeetingTranscriptionManager {
  private serial: Promise<unknown> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private closed = false;
  private readonly now: () => number;
  private readonly jobs = new Map<string, Job>();
  constructor(readonly config: MeetingTranscriptionConfig, private readonly options: ManagerOptions = {}) { this.now = options.now ?? Date.now; }
  async start(): Promise<void> {
    await mkdir(this.config.jobsRoot, { recursive: true, mode: 0o700 });
    const root = await lstat(this.config.jobsRoot);
    if (!root.isDirectory() || root.isSymbolicLink() || (root.mode & 0o077) !== 0 || (typeof process.getuid === "function" && root.uid !== process.getuid())) throw new Error("transcription job root must be a private owned directory");
    const dirs = []; let entries = 0;
    for await (const entry of await opendir(this.config.jobsRoot)) {
      if (++entries > LIMITS.jobs * 2) throw new Error("transcription directory entry budget exceeded");
      if (KEY.test(entry.name)) dirs.push(entry);
    }
    if (dirs.length > LIMITS.jobs) throw new Error("transcription retained job budget exceeded");
    for (const entry of dirs) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("transcription job directory replaced");
      const job = await json<Job>(path.join(this.config.jobsRoot, entry.name, "job.json"));
      if (!job || job.version !== 1 || job.key !== entry.name || !KEY.test(job.digest) || !Number.isSafeInteger(job.bytes) || job.bytes < 1 || job.bytes > LIMITS.inputBytes || !Array.isArray(job.files)) throw new Error("invalid retained transcription job");
      this.jobs.set(job.key, job);
    }
    await this.locked(() => this.reconcile());
    this.timer = setInterval(() => { void this.locked(() => this.reconcile()).catch(() => undefined); }, 5000); this.timer.unref();
  }
  close(): void { this.closed = true; if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  async readiness(): Promise<MeetingTranscriptionAdvertisement> {
    try { await this.probe(); return transcriptionAdvertisement(true); } catch { return transcriptionAdvertisement(false, "environment_unavailable"); }
  }
  private async probe(): Promise<void> {
    if (this.options.probe) return this.options.probe();
    if (sha(await regular(this.config.script, 64 * 1024)) !== this.config.scriptSha256 ||
      sha(await regular(this.config.pipeline, 1024 * 1024)) !== this.config.pipelineSha256) throw new Error("transcription pipeline pin mismatch");
    await access(this.config.script, constants.X_OK); await access(this.config.python, constants.X_OK);
    await access(path.join(this.config.modelDir, "config.json"), constants.R_OK);
    await exec(this.config.python, ["-c", "import importlib.util; assert all(importlib.util.find_spec(x) is not None for x in ('torch','moss_transcribe_diarize','transformers'))"], { timeout: 10_000, maxBuffer: 4096 });
    await exec("ffmpeg", ["-version"], { timeout: 3000, maxBuffer: 16384 });
    await exec("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"], { timeout: 3000, maxBuffer: 4096 });
  }
  async call(action: MeetingTranscriptionAction, raw: unknown): Promise<MeetingTranscriptionStatus | MeetingTranscriptionChunk> {
    const request = parseMeetingTranscriptionRequest(action, raw);
    return this.locked(async () => {
      await this.reconcile();
      const key = String(request.job_key), digest = String(request.input_sha256);
      let job = this.jobs.get(key);
      if (job) await this.assertJobDirectory(job);
      if (job && job.digest !== digest) throw new Error("job identity is bound to another recording");
      if (action === "begin") {
        if (job) { if (job.bytes !== request.input_bytes || job.title !== request.title) throw new Error("job identity is bound to different immutable inputs"); return this.status(job); }
        if (this.jobs.size >= LIMITS.jobs) throw new Error("transcription retained job budget exhausted");
        job = { version: 1, key, digest, bytes: Number(request.input_bytes), title: String(request.title), state: "uploading", received: 0, created: new Date(this.now()).toISOString(), files: [] };
        // Publish input + receipt together. A crash before rename leaves only an
        // uncommitted private draft, never a retained key that disables recovery.
        const draft = path.join(this.config.jobsRoot, `.initializing-${key}-${randomUUID()}`);
        await mkdir(draft, { mode: 0o700 });
        const input = await open(path.join(draft, "input.audio"), "wx", 0o600);
        try { await input.sync(); } finally { await input.close(); }
        await atomic(path.join(draft, "job.json"), job);
        await rename(draft, this.dir(job));
        const parent = await open(this.config.jobsRoot, "r"); try { await parent.sync(); } finally { await parent.close(); }
        this.jobs.set(key, job); return this.status(job);
      }
      if (!job) throw new Error("transcription job not found");
      if (action === "upload") {
        const data = Buffer.from(String(request.data), "base64"), offset = Number(request.offset);
        if (!data.length || data.length > LIMITS.chunkBytes || data.toString("base64") !== request.data || sha(data) !== request.chunk_sha256 || offset + data.length > job.bytes) throw new Error("invalid recording chunk or digest");
        const handle = await open(this.input(job), constants.O_RDWR | constants.O_NOFOLLOW);
        try {
          const info = await handle.stat();
          if (!info.isFile() || info.size > job.bytes || offset > info.size) throw new Error("recording upload has a gap");
          if (offset < info.size) {
            const existing = Buffer.alloc(data.length), { bytesRead } = await handle.read(existing, 0, data.length, offset);
            if (bytesRead !== data.length || !existing.equals(data)) throw new Error("recording chunk conflicts with committed bytes");
          } else {
            if (job.state !== "uploading") throw new Error("recording is already sealed");
            // Per-window disk guard: a recording has no total, but must not fill the device.
            const disk = await statfs(this.config.jobsRoot, { bigint: true });
            if (disk.bavail * disk.bsize < BigInt(data.length + DISK_RESERVE_BYTES)) throw new Error("device disk space is low; recording chunk not written, upload resumable after freeing space");
            const written = await handle.write(data, 0, data.length, offset); if (written.bytesWritten !== data.length) throw new Error("recording chunk write was incomplete"); await handle.sync();
          }
          job.received = (await handle.stat()).size;
        } finally { await handle.close(); }
        await this.save(job); return this.status(job);
      }
      if (action === "start") {
        if (job.state === "uploading") {
          const received = await streamedDigest(this.input(job));
          if (received.bytes !== job.bytes || received.sha256 !== job.digest) throw new Error("recording upload is incomplete or digest does not match");
          await this.probe(); job.received = received.bytes; job.state = "queued"; job.deadline = this.now() + (this.config.deadlineMs ?? LIMITS.deadlineMs);
          await this.save(job); await this.launchNext();
        }
        return this.status(job);
      }
      if (action === "cancel") {
        if (!meetingTranscriptionTerminal(job.state)) {
          // Persist cancellation before signalling. A crash cannot turn cancellation into a queued restart.
          job.state = "cancelled"; await this.save(job); await this.signal(job); await this.launchNext();
        }
        return this.status(job);
      }
      if (action === "read") return this.readArtifact(job, request);
      return this.status(job);
    });
  }
  private locked<T>(run: () => Promise<T>): Promise<T> {
    const promise = this.serial.then(() => { if (this.closed) throw new Error("transcription manager closed"); return run(); });
    this.serial = promise.catch(() => undefined); return promise;
  }
  private dir(job: Job): string { return path.join(this.config.jobsRoot, job.key); }
  private input(job: Job): string { return path.join(this.dir(job), "input.audio"); }
  private save(job: Job): Promise<void> { return atomic(path.join(this.dir(job), "job.json"), job); }
  private async assertJobDirectory(job: Job): Promise<void> {
    const info = await lstat(this.dir(job));
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error("transcription job directory changed");
  }
  private async identity(job: Job): Promise<ProcessIdentity | null> { return json(path.join(this.dir(job), "pid.json")); }
  private async signal(job: Job): Promise<void> { const identity = await this.identity(job); if (await processAlive(identity)) { try { process.kill(-identity!.pid, "SIGTERM"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } } }
  private async reconcile(): Promise<void> {
    for (const job of this.jobs.values()) {
      await this.assertJobDirectory(job);
      if (job.state === "cancelled" || job.state === "timed_out") { await this.signal(job); continue; }
      if (meetingTranscriptionTerminal(job.state) || job.state === "uploading") continue;
      const exit = await json<{ exit_code: number; error?: string }>(path.join(this.dir(job), "exit.json"));
      if (exit) {
        try {
          job.files = await this.publish(job);
          job.state = job.files.some(file => file.file === "dialogue.md") ? "needs_review" : "failed";
          if (exit.exit_code === 0) { await this.verifyExport(job); job.state = "succeeded"; }
        }
        catch (error) { job.state = job.files.some(file => file.file === "dialogue.md") ? "needs_review" : "failed"; job.error = String(error).slice(0, 500); }
        if (exit.error) job.error = exit.error.slice(0, 500); await this.save(job); continue;
      }
      if (job.deadline && this.now() >= job.deadline) { job.state = "timed_out"; job.error = "absolute job deadline exceeded"; await this.save(job); await this.signal(job); continue; }
      if (job.state === "queued") continue;
      const identity = await this.identity(job);
      if (await processAlive(identity)) { if (job.state !== "running") { job.state = "running"; await this.save(job); } }
      else if (this.now() - (job.launched ?? 0) > 60_000) { job.state = "orphaned"; job.error = "original worker identity has no terminal receipt; automatic replay refused"; await this.save(job); }
    }
    await this.launchNext();
  }
  private async launchNext(): Promise<void> {
    for (const job of this.jobs.values()) {
      if (["launching", "running"].includes(job.state) || await processAlive(await this.identity(job))) return;
    }
    const next = [...this.jobs.values()].find(job => job.state === "queued");
    if (!next) return;
    try { await this.probe(); } catch { next.state = "failed"; next.error = "fixed transcription environment unavailable"; await this.save(next); return; }
    next.state = "launching"; next.launched = this.now(); await this.save(next);
    // The durable launch intent precedes spawn. An ambiguous launch is never replayed.
    const settings = { job: this.dir(next), input: this.input(next), root: this.config.jobsRoot, script: this.config.script,
      cwd: path.dirname(this.config.script), title: next.title, model_dir: this.config.modelDir,
      timeout: Math.max(1, (next.deadline! - this.now()) / 1000), deadline_at: next.deadline, durable: true };
    try { await (this.options.spawn ?? defaultSpawn)(this.config, settings); }
    catch (error) { next.state = "failed"; next.error = `worker launch failed: ${String(error).slice(0, 300)}`; await this.save(next); }
  }
  private async verifyExport(job: Job): Promise<void> {
    const get = async (name: string) => job.files.some(file => file.file === name)
      ? (await regular(path.join(this.dir(job), "result", name), LIMITS.artifactBytes)).toString("utf8") : "";
    const decode = async (name: string) => { const text = await get(name); return text ? JSON.parse(text) : null; };
    const packet: MossPacket = { manifest: await decode("manifest.json"), complete: await decode("complete.json"),
      quality: await decode("quality.json") ?? {}, inference: await decode("inference.json") ?? {},
      segments: await decode("segments.json"), raw: await get("model-raw.txt"), dialogue: await get("dialogue.md"),
      ...(job.files.some(file => file.file === "recovery.json") ? { recovery: await decode("recovery.json") } : {}) };
    if (packet.manifest?.settings?.audio_sha256 !== job.digest) throw new Error("transcription export does not match immutable recording");
    validateMossPacket(packet);
  }
  private async publish(job: Job): Promise<PublishedFile[]> {
    const files: PublishedFile[] = []; let total = 0;
    for (const file of artifactNames) {
      const filename = path.join(this.dir(job), file.includes("/") ? file : `result/${file}`);
      const parent = await lstat(path.dirname(filename)).catch(() => null);
      if (!parent) continue;
      if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("artifact directory changed");
      let bytes: Buffer; try { bytes = await regular(filename, LIMITS.artifactBytes); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      total += bytes.length; if (total > LIMITS.artifactTotalBytes) throw new Error("transcription artifact budget exceeded");
      await chmod(filename, 0o400); const info = await lstat(filename);
      files.push({ file, bytes: bytes.length, sha256: sha(bytes), ino: info.ino, mtimeMs: info.mtimeMs });
    }
    return files;
  }
  private async status(job: Job): Promise<MeetingTranscriptionStatus> {
    let progress: MeetingTranscriptionStatus["progress"];
    const raw = await json<Record<string, unknown>>(path.join(this.dir(job), "result/progress.json"));
    if (raw && typeof raw.status === "string") progress = { status: raw.status.slice(0, 80),
      ...(typeof raw.generated_tokens === "number" && Number.isSafeInteger(raw.generated_tokens) ? { generated_tokens: raw.generated_tokens } : {}),
      ...(typeof raw.attempt === "number" && Number.isSafeInteger(raw.attempt) ? { attempt: raw.attempt } : {}) };
    return { protocol: PROTOCOL, job_key: job.key, input_sha256: job.digest, input_bytes: job.bytes, received: job.received,
      state: job.state, created_at: job.created, ...(job.deadline ? { deadline_at: new Date(job.deadline).toISOString() } : {}),
      ...(job.error ? { error: job.error } : {}), ...(progress ? { progress } : {}), files: job.files.map(({ file, bytes, sha256 }) => ({ file, bytes, sha256 })) };
  }
  private async readArtifact(job: Job, request: Record<string, string | number>): Promise<MeetingTranscriptionChunk> {
    if (!meetingTranscriptionTerminal(job.state)) throw new Error("transcription artifacts are not yet published");
    const file = String(request.file), item = job.files.find(entry => entry.file === file);
    if (!item || !artifactNames.includes(file) || Number(request.offset) > item.bytes) throw new Error("artifact is not in the fixed manifest");
    const filename = path.join(this.dir(job), file.includes("/") ? file : `result/${file}`);
    const parent = await lstat(path.dirname(filename)); if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("artifact directory changed");
    const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW), offset = Number(request.offset);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.ino !== item.ino || info.size !== item.bytes || info.mtimeMs !== item.mtimeMs || (info.mode & 0o222)) throw new Error("published transcription artifact changed");
      const bytes = Buffer.alloc(Math.min(Number(request.length), item.bytes - offset));
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, offset);
      if (bytesRead !== bytes.length) throw new Error("transcription artifact read was incomplete");
      return { protocol: PROTOCOL, job_key: job.key, input_sha256: job.digest, file, offset, bytes: bytes.length, total: item.bytes,
        data: bytes.toString("base64"), eof: offset + bytes.length === item.bytes, sha256: item.sha256 };
    } finally { await handle.close(); }
  }
}
