import { createHash, randomUUID } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { DeployIntentRow } from "../store/repositories/dev-tickets.js";
import type { WorkspaceProvider, WorkspaceTask } from "./workspace-provider.js";
import { WorkspaceProviderUnavailable, WorkspaceProviderUnknown } from "./workspace-provider.js";
import { runChild } from "./child-output.js";
import { gitOrThrow } from "./worktree.js";
import { createLogger } from "../logger.js";

const log = createLogger("deploy-artifact");
export interface ReleasePart { name: "dependencies" | "outputs"; file: string; bytes: number; sha256: string }
export interface ReleaseApp { script: string; file: string; bytes: number; sha256: string }
export interface ReleaseDependencyIndex {
  version: 1; file: "packages/bot/dist/release-dependency-index.jsonl";
  archiveSha256: string; sha256: string; bytes: number; entries: number; payloadBytes: number;
}
export interface ReleaseManifest {
  version: 1; repoSha: string; node: string; platform: string; arch: string; nodeAbi: string;
  lockSha256: string; parts: ReleasePart[]; outputs: string[]; apps?: ReleaseApp[];
  dependencyIndex?: ReleaseDependencyIndex;
}
export interface ReleasePreparation {
  sha: string; state: string; updatedAt?: string; error?: string; device?: string; manifestSha256?: string;
  phases?: ReleasePhase[];
  installation?: { state: string; elapsedMs: number; profile?: string; dependencyCacheHit?: boolean; phases: ReleasePhase[] };
  maintenance?: { state: string; elapsedMs: number; phases: ReleasePhase[] };
}
export interface ReleasePhase {
  name: string; state: string; startedAt: string; finishedAt?: string; elapsedMs: number;
  bytes?: number; entries?: number; pacedMs?: number; cpuMs?: number;
  cacheHit?: boolean; filesReused?: number; bytesReused?: number;
}
export interface ReleaseProvider {
  target: WorkspaceProvider["target"]; manifestSha256?: string;
  wait: (task: WorkspaceTask, signal?: AbortSignal) => Promise<{ state: string; job_id: string; error?: string | null; exit_code?: number | null }>;
  artifact: WorkspaceProvider["artifact"];
}
export function parseReleaseManifest(text: string, sha: string): ReleaseManifest {
  const m = JSON.parse(text) as ReleaseManifest;
  if (m.version !== 1 || m.repoSha !== sha || m.node !== process.version || m.platform !== process.platform
    || m.arch !== process.arch || m.nodeAbi !== process.versions.modules || !/^[0-9a-f]{64}$/.test(m.lockSha256)
    || !Array.isArray(m.parts) || m.parts.length !== 2
    || new Set(m.parts.map(p => p.name)).size !== 2
    || m.parts.some(p => !["dependencies", "outputs"].includes(p.name) || p.file !== `${p.name}.tar.gz`
      || !Number.isSafeInteger(p.bytes) || p.bytes < 1 || p.bytes > 2 * 1024 ** 3 || !/^[0-9a-f]{64}$/.test(p.sha256))
    || !Array.isArray(m.outputs) || m.outputs.some(p => !/^(packages|plugins|tools)\/[a-zA-Z0-9_-]+\/dist$/.test(p))
    || (m.apps !== undefined && (!Array.isArray(m.apps) || m.apps.length > 40 || new Set(m.apps.map(a => a.script)).size !== m.apps.length || m.apps.some(a =>
      !/^app:pack(?::[a-z0-9-]+)?$/.test(a.script) || a.file !== `packages/bot/dist/release-apps/${a.script.replaceAll(":", "-")}.json`
      || !Number.isSafeInteger(a.bytes) || a.bytes < 1 || a.bytes > 24 * 1024 ** 2 || !/^[0-9a-f]{64}$/.test(a.sha256))))) {
    throw new Error("release artifact source, runtime or manifest mismatch; local build is disabled");
  }
  const index = m.dependencyIndex;
  if (index !== undefined && (!index || index.version !== 1 || index.file !== "packages/bot/dist/release-dependency-index.jsonl"
    || index.archiveSha256 !== m.parts.find(p => p.name === "dependencies")!.sha256 || !/^[0-9a-f]{64}$/.test(index.sha256)
    || !Number.isSafeInteger(index.bytes) || index.bytes < 1 || index.bytes > 64 * 1024 ** 2
    || !Number.isSafeInteger(index.entries) || index.entries < 1 || index.entries > 200000
    || !Number.isSafeInteger(index.payloadBytes) || index.payloadBytes < 0 || index.payloadBytes > 8 * 1024 ** 3
    || !m.outputs.includes("packages/bot/dist"))) throw new Error("invalid CI dependency inventory descriptor");
  return m;
}
async function atomic(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`, handle = await fs.open(temp, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(data)); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(temp, file);
  const parent = await fs.open(path.dirname(file), "r"); try { await parent.sync(); } finally { await parent.close(); }
}
/** At most 100 ms of idle credit; actual network/disk time pays for the budget. */
export class ReleaseBytePacer {
  private due: number;
  constructor(private readonly rate: number, private readonly clock = () => performance.now(),
    private readonly sleep = (ms: number, signal: AbortSignal) => delay(ms, undefined, { signal })) {
    if (!(rate > 0)) throw new Error("invalid release byte budget");
    this.due = clock();
  }
  async step(bytes: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const now = this.clock();
    this.due = Math.max(this.due, now - 100) + bytes * 1000 / this.rate;
    if (this.due > now) await this.sleep(this.due - now, signal);
  }
}
/** Both network reception and cached-file validation yield with a bounded byte rate. */
async function hash(file: string, signal: AbortSignal, bytesPerSecond: number): Promise<string> {
  const digest = createHash("sha256"), pace = new ReleaseBytePacer(bytesPerSecond);
  for await (const bytes of createReadStream(file, { highWaterMark: 256 * 1024, signal })) {
    digest.update(bytes);
    await pace.step(bytes.length, signal);
  }
  return digest.digest("hex");
}
/** The no-checkout source worktree `prepareOnce` leaves per SHA; swept when a day old. */
export const RELEASE_SCRATCH = /^_release-[0-9a-f]{40}$/;
/**
 * A failed preparation is not a verdict on the release: a full disk, a dropped
 * connection or an interrupted install all clear up, and the installer resumes
 * its own partial target. A later poll or check retries it after this pause,
 * never in a tight loop.
 */
const FAILED_RETRY_MS = 10 * 60_000;
/** One immutable preparation per SHA, serial across SHAs, shared by warming and deployment. */
export class DeployArtifactService {
  private readonly pending = new Map<string, Promise<void>>();
  private readonly intents = new Map<number, Promise<void>>();
  private serial: Promise<void> = Promise.resolve();
  private readonly controller = new AbortController();
  constructor(private readonly opts: { dir: string; repoDir: string; worktreesDir: string; releasesDir?: string;
    isActive?: (intent: DeployIntentRow) => boolean;
    bytesPerSecond?: number;
    stage?: (manifest: string, sha: string, signal: AbortSignal) => Promise<void>;
    provider: (target: Pick<DeployIntentRow, "target_sha"> & { release_manifest_sha256?: string | null }) => Promise<ReleaseProvider> | ReleaseProvider }) {}
  close(): void { this.controller.abort(); }
  /** Shallow local inventory; no downloads and no dependency-tree traversal. */
  async stagedShas(): Promise<string[]> {
    if (!this.opts.releasesDir) return [];
    const entries = await fs.readdir(this.opts.releasesDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    return entries.filter(entry => entry.isDirectory() && /^[a-f0-9]{40}$/.test(entry.name)).map(entry => entry.name);
  }
  async status(sha: string): Promise<ReleasePreparation> {
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("release requires an exact SHA");
    const read = async (file: string) => {
      if (!await fs.stat(file).then(s => s.size <= 256 * 1024).catch(() => false)) return null;
      return fs.readFile(file, "utf8").then(s => JSON.parse(s)).catch(() => null);
    };
    const saved = await read(path.join(this.opts.dir, "preparations", `${sha}.json`));
    const state = saved?.sha === sha ? saved : { sha, state: "pending" };
    const installation = await read(path.join(this.opts.dir, "preparations", `${sha}.install.json`));
    const maintenance = await read(path.join(this.opts.dir, "maintenance.json"));
    const evidence = {
      ...(installation?.sha === sha && Array.isArray(installation.phases) ? { installation } : {}),
      ...(maintenance?.action === "prune" && Array.isArray(maintenance.phases) ? { maintenance } : {}),
    };
    if (this.opts.releasesDir) {
      if (await fs.stat(path.join(this.opts.releasesDir, sha, ".octopus-pruning")).catch(() => null)) {
        return { sha, state: "failed", error: "release is being retired" };
      }
      const marker = path.join(this.opts.releasesDir, sha, ".octopus-release.json");
      const installed = await fs.readFile(marker, "utf8").catch(() => null);
      if (installed) { const manifest = parseReleaseManifest(installed, sha); return { ...state, ...evidence, sha, state: "ready", manifestSha256: createHash("sha256").update(JSON.stringify(manifest)).digest("hex") }; }
    }
    return { ...state, ...evidence, ...(this.opts.releasesDir && state.state === "ready" ? { state: "pending" } : {}) };
  }
  /** `retryFailed`: an explicit operator request retries a failed preparation without waiting out the pause. */
  prewarm(sha: string, opts: { retryFailed?: boolean } = {}): Promise<void> {
    const prior = this.pending.get(sha); if (prior) return prior;
    const running = (async () => {
      // Activating an already staged release must not join an unrelated newer
      // download/install. Only actual preparation work owns the serial queue.
      if ((await this.status(sha)).state === "ready") return;
      const preparation = this.serial.then(() => this.prepareOnce(sha, opts.retryFailed === true));
      this.serial = preparation.catch(() => undefined);
      await preparation;
    })().finally(() => this.pending.delete(sha));
    this.pending.set(sha, running); return running;
  }
  prepare(intent: DeployIntentRow): Promise<void> {
    const prior = this.intents.get(intent.id); if (prior) return prior;
    const running = (async () => {
      // Policy is checked again for the real intent even if warming used this SHA earlier.
      try { await this.opts.provider(intent); }
      catch (error) {
        await atomic(path.join(this.opts.dir, "intents", `${intent.id}.json`), { version: 1, id: intent.id,
          sha: intent.target_sha, state: "failed", error: String(error), updatedAt: new Date().toISOString() });
        return;
      }
      await this.prewarm(intent.target_sha);
      if (this.controller.signal.aborted || (this.opts.isActive && !this.opts.isActive(intent))) return;
      const state = await this.status(intent.target_sha);
      if (intent.release_manifest_sha256 && state.manifestSha256 !== intent.release_manifest_sha256) throw new Error("staged release differs from the pinned deployment");
      await atomic(path.join(this.opts.dir, "intents", `${intent.id}.json`), { version: 1, id: intent.id,
        ...state, manifest: path.join(this.opts.dir, "manifests", `${intent.target_sha}.json`), cached: true, transferredBytes: 0 });
    })().finally(() => this.intents.delete(intent.id));
    this.intents.set(intent.id, running); return running;
  }
  private async prepareOnce(sha: string, retryFailed = false): Promise<void> {
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("release requires an exact SHA");
    const signal = this.controller.signal, rate = this.opts.bytesPerSecond ?? 16 * 1024 ** 2;
    signal.throwIfAborted();
    const prior = await this.status(sha);
    if (["ready", "unknown"].includes(prior.state)) return;
    const age = Date.now() - Date.parse(prior.updatedAt ?? "");
    if (prior.state === "unavailable" && age < 60000) return;
    if (prior.state === "failed" && !retryFailed && !(age >= FAILED_RETRY_MS)) return;
    const stateFile = path.join(this.opts.dir, "preparations", `${sha}.json`);
    let device: string | undefined;
    const phases: ReleasePhase[] = [];
    let currentState = "pending", currentDetails: Record<string, unknown> = {};
    const update = (state: string, details: Record<string, unknown> = {}) => {
      currentState = state; currentDetails = { ...currentDetails, ...details };
      return atomic(stateFile, { version: 1, sha, state, device, updatedAt: new Date().toISOString(), ...currentDetails, phases });
    };
    const phase = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
      const start = performance.now();
      const row: ReleasePhase = { name, state: "running", startedAt: new Date().toISOString(), elapsedMs: 0 };
      phases.push(row); await update(currentState);
      try { const value = await run(); row.state = "succeeded"; return value; }
      catch (error) { row.state = "failed"; throw error; }
      finally { row.elapsedMs = Math.round(performance.now() - start); row.finishedAt = new Date().toISOString(); await update(currentState); }
    };
    try {
      const provider = await this.opts.provider({ target_sha: sha }); device = provider.target.device;
      // Only Git objects are sent. Avoid checking out thousands of source files on the control node.
      const sourceDir = path.join(this.opts.worktreesDir, `_release-${sha}`);
      if (!await fs.stat(sourceDir).catch(() => null)) await gitOrThrow(this.opts.repoDir, ["worktree", "add", "--detach", "--no-checkout", sourceDir, sha]);
      if (await gitOrThrow(sourceDir, ["rev-parse", "HEAD"]) !== sha) throw new Error("release preparation checkout changed");
      // Hashed whole; no maxBuffer, so a growing lockfile never fails a release.
      const shownLock = await runChild("git", ["-C", sourceDir, "show", "HEAD:pnpm-lock.yaml"], { cwd: sourceDir, timeoutMs: 30000 });
      if (shownLock.error) throw shownLock.error;
      const lockBytes = shownLock.stdout.bytes();
      const lock = createHash("sha256").update(lockBytes).digest("hex");
      const manifestFile = path.join(this.opts.dir, "manifests", `${sha}.json`);
      let manifest: ReleaseManifest | null = null;
      const cachedText = await fs.readFile(manifestFile, "utf8").catch(() => null);
      if (cachedText) {
        manifest = parseReleaseManifest(cachedText, sha);
        if (manifest.lockSha256 !== lock) throw new Error("cached release lock mismatch");
        await update("receiving", { objectDigests: manifest.parts.map(p => p.sha256) });
        for (const part of manifest.parts) {
          const file = path.join(this.opts.dir, "objects", `${part.sha256}.tar.gz`);
          if (!(await fs.stat(file).then(s => s.size === part.bytes).catch(() => false))
            || await phase(`cached_${part.name}`, () => hash(file, signal, rate)) !== part.sha256) { manifest = null; break; }
        }
      }
      let transferred = 0;
      const key = `release:${sha}`;
      if (!manifest) {
        await update("building", { key, target: provider.target });
        const task = { key, workspaceKey: "release", sha, sourceDir,
          command: `node scripts/ops/release-build.mjs ${sha}`, timeoutMs: 2700000 };
        let result;
        const busyDeadline = Date.now() + 600000;
        do {
          result = await provider.wait(task, signal);
          if (result.state !== "not_started" || result.error !== "workspace_busy" || Date.now() >= busyDeadline) break;
          await delay(5000, undefined, { signal });
        } while (!signal.aborted);
        if (result.state === "not_started") throw new WorkspaceProviderUnavailable("release builder is busy");
        if (result.state !== "succeeded") throw new Error(`release Runner job ${result.job_id}: ${result.state} (${result.error ?? result.exit_code})`);
        const raw = await provider.artifact(key, "release.json", 0, 65536, signal);
        if (!raw.eof) throw new Error("release manifest exceeds 64 KiB");
        manifest = parseReleaseManifest(raw.data.toString("utf8"), sha);
        if (manifest.lockSha256 !== lock) throw new Error("release dependency lock mismatch");
        await update("receiving", { key, jobId: result.job_id, target: provider.target, objectDigests: manifest.parts.map(p => p.sha256) });
        const objects = path.join(this.opts.dir, "objects"); await fs.mkdir(objects, { recursive: true, mode: 0o700 });
        for (const part of manifest.parts) {
          const file = path.join(objects, `${part.sha256}.tar.gz`);
          if (await fs.stat(file).then(s => s.size === part.bytes).catch(() => false)
            && await phase(`cached_${part.name}`, () => hash(file, signal, rate)) === part.sha256) continue;
          const partial = `${file}.partial`;
          let offset = await fs.stat(partial).then(s => s.size).catch(() => 0);
          if (offset > part.bytes) { await fs.rm(partial); offset = 0; }
          const handle = await fs.open(partial, "a", 0o600);
          try {
            await phase(`receive_${part.name}`, async () => {
            const pace = new ReleaseBytePacer(rate);
            while (offset < part.bytes) {
              signal.throwIfAborted();
              const length = Math.min(256 * 1024, part.bytes - offset);
              const chunk = await provider.artifact(key, part.file, offset, length, signal);
              if (chunk.total !== part.bytes || !chunk.data.length || chunk.data.length > length
                || chunk.eof !== (offset + chunk.data.length === part.bytes)) throw new Error("release artifact truncated or changed during transfer");
              await handle.writeFile(chunk.data); offset += chunk.data.length; transferred += chunk.data.length;
              await pace.step(chunk.data.length, signal);
            }
            await handle.sync();
            });
          } finally { await handle.close(); }
          if (await phase(`verify_${part.name}`, () => hash(partial, signal, rate)) !== part.sha256) { await fs.rm(partial); throw new Error("release artifact digest mismatch"); }
          await fs.rename(partial, file);
        }
        await atomic(manifestFile, manifest);
      }
      const manifestSha256 = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
      if (provider.manifestSha256 && manifestSha256 !== provider.manifestSha256) throw new Error("staged manifest digest mismatch");
      await update("staging", { manifest: manifestFile, transferredBytes: transferred });
      await this.opts.stage?.(manifestFile, sha, signal);
      signal.throwIfAborted();
      await update("ready", { manifest: manifestFile, manifestSha256, key, transferredBytes: transferred });
      log.info({ sha, device, bytes: transferred }, "complete release staged before deployment");
    } catch (error) {
      if (signal.aborted) return;
      await update(error instanceof WorkspaceProviderUnknown ? "unknown" : error instanceof WorkspaceProviderUnavailable ? "unavailable" : "failed",
        { error: error instanceof Error ? error.message : String(error) });
      log.warn({ sha, device, error: String(error) }, "release preparation incomplete; no local build fallback");
    }
  }
}
