import type { ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { runChild } from "./child-output.js";
import type { ReleaseManifest } from "./deploy-artifact.js";
import { createLogger } from "../logger.js";

const log = createLogger("release-stage");
/** The job's output is only quoted on failure; its volume never fails a release. */
const JOB_OUTPUT_TAIL_BYTES = 64 * 1024;
/** Foreground staging has priority over bounded, independently locked cleanup. */
export class ReleaseStager {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private collecting: Promise<void> | undefined;
  private closed = false;
  constructor(private readonly opts: {
    job: string; repository: string; releases: string; artifacts: string; database: string;
    pointers: () => Promise<{ current: string; previous: string }>;
    foregroundBusy?: () => boolean;
    idleMs?: number;
    run?: (args: string[], signal?: AbortSignal) => Promise<void>;
    availableBytes?: () => Promise<number>;
  }) { this.schedule(); }
  close(): void { this.closed = true; clearTimeout(this.timer); }
  private schedule(deadline = Date.now() + 30 * 60000): void {
    clearTimeout(this.timer);
    if (this.closed || Date.now() >= deadline) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.opts.foregroundBusy?.()) { this.schedule(deadline); return; }
      void this.collect().catch(error => log.warn({ error: String(error) }, "background release cleanup deferred or failed"));
    }, this.opts.idleMs ?? 60000);
    this.timer.unref?.();
  }
  private async run(args: string[], signal?: AbortSignal): Promise<void> {
    if (this.opts.run) return this.opts.run(args, signal);
    signal?.throwIfAborted();
    // Previously `execFile` with a 1 MiB `maxBuffer`: a chatty install was
    // killed and reported as a failed release although nothing read its output.
    let child: ChildProcess | undefined;
    const abort = (): void => { child?.kill("SIGTERM"); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const run = await runChild("bash", [this.opts.job, ...args], {
        cwd: process.cwd(),
        timeoutMs: 2_700_000,
        tailBytes: JOB_OUTPUT_TAIL_BYTES,
        onSpawn: (spawned) => { child = spawned; if (signal?.aborted) abort(); },
      });
      signal?.throwIfAborted();
      if (run.error) throw run.error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }
  private async free(): Promise<number> {
    if (this.opts.availableBytes) return this.opts.availableBytes();
    await fs.mkdir(this.opts.releases, { recursive: true });
    const disk = await fs.statfs(this.opts.releases);
    return disk.bavail * disk.bsize;
  }
  private collect(): Promise<void> {
    if (this.collecting) return this.collecting;
    this.collecting = (async () => {
      const { current, previous } = await this.opts.pointers();
      await this.run(["prune", this.opts.repository, this.opts.releases, this.opts.artifacts,
        this.opts.database, current, previous, "2"]);
    })().finally(() => { this.collecting = undefined; });
    return this.collecting;
  }
  async stage(manifestFile: string, sha: string, signal: AbortSignal): Promise<void> {
    clearTimeout(this.timer);
    const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8")) as ReleaseManifest;
    if (manifest.repoSha !== sha) throw new Error("staging source identity changed");
    // Admission reserve, not a guarantee about compression ratios. The installer
    // also checks free space while writing bounded chunks.
    const required = 2 * 1024 ** 3 + Math.max(2 * 1024 ** 3, manifest.parts.reduce((n, p) => n + p.bytes, 0) * 6);
    if (await this.free() < required) {
      await this.collect(); // Only low space puts cleanup on the critical path.
      if (await this.free() < required) throw new Error("insufficient release staging space after bounded cleanup; current service is unchanged");
    }
    await this.run(["install", manifestFile, this.opts.repository, path.join(this.opts.releases, sha)], signal);
    if (!this.closed && !signal.aborted) {
      this.schedule();
    }
  }
}
