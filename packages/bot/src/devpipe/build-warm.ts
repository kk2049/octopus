/**
 * Post-landing build warming — the other half of the build cache.
 *
 * ── Why ────────────────────────────────────────────────────────────────────
 *
 * A deploy runs `pnpm install` + `pnpm -r build` in the run tree while the
 * requester watches a spinner. With `tools/build-cache` in place that build is
 * only slow for packages whose fingerprint nobody has built yet on this host —
 * and at deploy time nobody has, because the landing gate deliberately does
 * NOT build the deployable (it typechecks; see `land-gate.ts`), and a ticket
 * agent is told not to burn its turn on local builds.
 *
 * So the pipeline builds it: right after a landing fast-forwards the base
 * branch, this warms the cache for the EXACT landed sha. By the time anyone
 * presses 🚀, the run tree's build is a sequence of cache restores.
 *
 * ── Where it runs, and what it must not disturb ────────────────────────────
 *
 * In its own `_warm` detached worktree, not in `_land`. `_land` is serialised
 * with every landing gate, so a warm build there would park the next ticket's
 * landing behind a full build — trading the deploy wait for a landing wait.
 * The cost of a separate tree is one more `node_modules`; the benefit is that
 * warming never delays landing. An immediate deployment may deliberately join
 * the exact in-flight run instead of competing with it for the host's cores.
 *
 * Warming holds no merge lock, no git lock and no `_land` slot. It reads a
 * commit that is already ON the base branch, so it cannot affect what lands or
 * what deploys — the worst outcome of a failure is the deploy building the way
 * it does today. Rapid landings supersede each other: only the newest sha is
 * worth warming, and the older one's packages are mostly the same content
 * anyway, so its cache entries stay useful.
 */

import type { ChildProcess } from "node:child_process";
import { runChild, stepLogTail, tailBytesFor } from "./child-output.js";
import path from "node:path";
import { ensureDetachedWorktree } from "./worktree.js";
import { createLogger } from "../logger.js";

const log = createLogger("build-warm");

/** Generous by design: warming is fully asynchronous, the bound only catches hangs. */
export const BUILD_WARM_TIMEOUT_MS = 30 * 60_000;
/** Never let optional warming hold an explicit deployment for a long build. */
export const BUILD_WARM_JOIN_TIMEOUT_MS = 2 * 60_000;
const LOG_TAIL = 2_000;

export type BuildWarmSkip = "disabled" | "superseded" | "already_warm" | "stopped";

export type BuildWarmOutcome =
  | { ok: true; sha: string; ms: number }
  | { ok: false; sha: string; skipped: BuildWarmSkip }
  | { ok: false; sha: string; failed: "worktree" | "install" | "build" | "timeout"; log: string; ms: number };

/** Result of joining an exact SHA that landing has already scheduled. */
export interface BuildWarmJoinResult {
  sha: string;
  /** False means deployment must keep its ordinary build path. */
  ready: boolean;
  /** True only when this call actually waited for an existing warm run. */
  joined: boolean;
  waitedMs: number;
  /** Null means no reusable outcome was available (not running or join timeout). */
  outcome: BuildWarmOutcome | null;
}

export interface BuildWarmStep {
  id: "install" | "build";
  bin: string;
  args: string[];
}

/** The two steps, in order. Install first: `-r build` needs the tool binaries. */
export const BUILD_WARM_STEPS: ReadonlyArray<BuildWarmStep> = [
  { id: "install", bin: "pnpm", args: ["install", "--frozen-lockfile", "--prefer-offline"] },
  { id: "build", bin: "pnpm", args: ["-r", "build"] },
];

export interface BuildWarmOpts {
  repoDir: string;
  /** Parent of the `_warm` worktree (same directory `_land` lives in). */
  worktreesDir: string;
  /** Default true (`selfhosting.build_warm`). */
  enabled?: boolean;
  timeoutMs?: number;
  joinTimeoutMs?: number;
  /**
   * Serialise repo-level git with the pipeline. Creating `_warm` the first
   * time runs `git worktree add` in the shared repo, which takes `index.lock`
   * — and a landing losing that race would be a real cost paid for a pure
   * optimisation. Everything after parking happens inside `_warm` only.
   */
  gitLock?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Test hook: replaces worktree parking. */
  park?: (dir: string, sha: string) => Promise<string>;
  /** Test hook: replaces one step's execution. */
  exec?: (step: BuildWarmStep, cwd: string, timeoutMs: number) => Promise<{ ok: boolean; timedOut: boolean; log: string }>;
  now?: () => number;
}

/** Latest warming result, for `devpipe_status` and the logs. */
export type BuildWarmState =
  | { state: "off" }
  | { state: "idle" }
  | { state: "running"; sha: string; since: string }
  | { state: "done"; sha: string; ok: boolean; ms: number; at: string; detail: string };

export class BuildWarmer {
  readonly enabled: boolean;
  private readonly repoDir: string;
  private readonly worktreesDir: string;
  private readonly timeoutMs: number;
  private readonly joinTimeoutMs: number;
  private readonly gitLock: <T>(fn: () => Promise<T>) => Promise<T>;
  private readonly parkFn: (dir: string, sha: string) => Promise<string>;
  private readonly execFn: (step: BuildWarmStep, cwd: string, timeoutMs: number) => Promise<{ ok: boolean; timedOut: boolean; log: string }>;
  private readonly now: () => number;

  /** Serialises warm runs; a prior failure must not poison the chain. */
  private chain: Promise<unknown> = Promise.resolve();
  /** Exact-SHA single-flight, so a deploy can join rather than duplicate it. */
  private pending = new Map<string, Promise<BuildWarmOutcome>>();
  /** The newest sha anybody asked for — older queued runs skip themselves. */
  private wanted: string | null = null;
  /** Last sha whose warm build completed successfully. */
  private warmed: string | null = null;
  private current: { sha: string; since: number } | null = null;
  private last: BuildWarmState = { state: "idle" };
  private child: ChildProcess | null = null;
  private stopped = false;

  constructor(opts: BuildWarmOpts) {
    this.repoDir = opts.repoDir;
    this.worktreesDir = opts.worktreesDir;
    this.enabled = opts.enabled ?? true;
    this.timeoutMs = opts.timeoutMs ?? BUILD_WARM_TIMEOUT_MS;
    this.joinTimeoutMs = Math.max(1, opts.joinTimeoutMs ?? BUILD_WARM_JOIN_TIMEOUT_MS);
    this.gitLock = opts.gitLock ?? ((fn) => fn());
    this.parkFn = opts.park ?? ((dir, sha) => ensureDetachedWorktree(this.repoDir, dir, sha));
    this.execFn = opts.exec ?? ((step, cwd, timeoutMs) => this.spawn(step, cwd, timeoutMs));
    this.now = opts.now ?? (() => Date.now());
  }

  /** The staging worktree warming owns. */
  warmDir(): string {
    return path.join(this.worktreesDir, "_warm");
  }

  status(): BuildWarmState {
    if (!this.enabled) return { state: "off" };
    if (this.current) return { state: "running", sha: this.current.sha, since: new Date(this.current.since).toISOString() };
    return this.last;
  }

  /**
   * Fire-and-forget entry point for the landing doors. Never rejects and never
   * blocks the caller: a landing must not become slower, or fail, because a
   * performance optimisation had a bad day.
   */
  schedule(sha: string): void {
    void this.warm(sha).catch((err) => {
      log.warn({ sha, err: err instanceof Error ? err.message : String(err) }, "build warm crashed");
    });
  }

  /** Awaitable variant. Concurrent callers for one SHA share the same run. */
  warm(sha: string): Promise<BuildWarmOutcome> {
    if (!this.enabled) return Promise.resolve({ ok: false, sha, skipped: "disabled" });
    this.wanted = sha;
    const existing = this.pending.get(sha);
    if (existing) return existing;
    const run = async (): Promise<BuildWarmOutcome> => {
      if (this.stopped) return { ok: false, sha, skipped: "stopped" };
      // A newer landing arrived while this one waited: that sha is what a
      // deploy will ask for, so warming this one would spend the box's two
      // cores on the wrong tree.
      if (this.wanted !== sha) return { ok: false, sha, skipped: "superseded" };
      if (this.warmed === sha) return { ok: false, sha, skipped: "already_warm" };
      return await this.runOnce(sha);
    };
    const next = this.chain.then(run, run);
    this.pending.set(sha, next);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    void next.then(
      () => this.forgetPending(sha, next),
      () => this.forgetPending(sha, next),
    );
    return next;
  }

  /**
   * Join warming that landing already scheduled for this exact target.
   *
   * This never starts a new build: an old/ref-specific deploy and a host that
   * restarted after landing keep the ordinary supervisor path. The immediate
   * "land, then deploy" path instead waits for the work already in flight, so
   * the run tree restores its result rather than cold-building beside it.
   */
  async join(sha: string): Promise<BuildWarmJoinResult> {
    if (!this.enabled) {
      return {
        sha,
        ready: false,
        joined: false,
        waitedMs: 0,
        outcome: { ok: false, sha, skipped: "disabled" },
      };
    }
    const pending = this.pending.get(sha);
    if (!pending) {
      const alreadyWarm = this.warmed === sha;
      return {
        sha,
        ready: alreadyWarm,
        joined: false,
        waitedMs: 0,
        outcome: alreadyWarm ? { ok: false, sha, skipped: "already_warm" } : null,
      };
    }
    const started = this.now();
    log.info({ sha }, "build warm join started");
    const timeout = Symbol("build-warm-join-timeout");
    let timer: NodeJS.Timeout | null = null;
    const outcome = await Promise.race([
      pending,
      new Promise<typeof timeout>((resolve) => {
        timer = setTimeout(() => resolve(timeout), this.joinTimeoutMs);
        timer.unref?.();
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    const waitedMs = this.now() - started;
    if (outcome === timeout) {
      log.warn({ sha, waitedMs }, "build warm join timed out; deploy will build normally");
      return { sha, ready: false, joined: true, waitedMs, outcome: null };
    }
    const ready = outcome.ok || ("skipped" in outcome && outcome.skipped === "already_warm");
    log.info({ sha, ready, waitedMs, outcome }, "build warm join settled");
    return { sha, ready, joined: true, waitedMs, outcome };
  }

  /** Stop warming (bot shutdown). Kills the running step; the cache keeps whatever completed. */
  stop(): void {
    this.stopped = true;
    this.child?.kill("SIGTERM");
  }

  private async runOnce(sha: string): Promise<BuildWarmOutcome> {
    const started = this.now();
    this.current = { sha, since: started };
    log.info({ sha }, "build warm started");
    try {
      let dir: string;
      const parkStarted = this.now();
      try {
        dir = await this.gitLock(() => this.parkFn(this.warmDir(), sha));
      } catch (err) {
        return this.finish({ ok: false, sha, failed: "worktree", log: err instanceof Error ? err.message : String(err), ms: this.now() - started });
      }
      log.info({ sha, phase: "worktree", ms: this.now() - parkStarted }, "build warm phase ready");
      const deadline = started + this.timeoutMs;
      for (const step of BUILD_WARM_STEPS) {
        const remaining = deadline - this.now();
        if (remaining <= 0) {
          return this.finish({ ok: false, sha, failed: "timeout", log: `(${step.id} 未执行:预热预算已用尽)`, ms: this.now() - started });
        }
        const stepStarted = this.now();
        const r = await this.execFn(step, dir, remaining);
        log.info(
          { sha, phase: step.id, ms: this.now() - stepStarted, ok: r.ok, timedOut: r.timedOut },
          "build warm phase settled",
        );
        if (this.stopped) return this.finish({ ok: false, sha, skipped: "stopped" });
        if (!r.ok) {
          return this.finish({
            ok: false,
            sha,
            failed: r.timedOut ? "timeout" : step.id,
            log: r.log.split(dir).join(".").slice(-LOG_TAIL),
            ms: this.now() - started,
          });
        }
      }
      this.warmed = sha;
      return this.finish({ ok: true, sha, ms: this.now() - started });
    } finally {
      this.current = null;
    }
  }

  private forgetPending(sha: string, pending: Promise<BuildWarmOutcome>): void {
    if (this.pending.get(sha) === pending) this.pending.delete(sha);
  }

  private finish(outcome: BuildWarmOutcome): BuildWarmOutcome {
    if ("skipped" in outcome) {
      log.info({ sha: outcome.sha, skipped: outcome.skipped }, "build warm skipped");
      return outcome;
    }
    const detail = outcome.ok ? "构建缓存已就绪" : `预热失败(${outcome.failed})`;
    this.last = {
      state: "done",
      sha: outcome.sha,
      ok: outcome.ok,
      ms: outcome.ms,
      at: new Date().toISOString(),
      detail,
    };
    if (outcome.ok) {
      log.info({ sha: outcome.sha, ms: outcome.ms }, "build warm ready: deploy should hit the cache");
    } else {
      // Not an error: a cold deploy build is exactly today's behaviour.
      log.warn({ sha: outcome.sha, failed: outcome.failed, tail: outcome.log.slice(-400) }, "build warm failed; deploy will build normally");
    }
    return outcome;
  }

  private async spawn(step: BuildWarmStep, cwd: string, timeoutMs: number): Promise<{ ok: boolean; timedOut: boolean; log: string }> {
    // Output volume never fails a step; only its exit status and the timeout do.
    const run = await runChild(step.bin, step.args, { cwd, timeoutMs, killSignal: "SIGKILL", tailBytes: tailBytesFor(LOG_TAIL),
      onSpawn: (child) => { this.child = child; } });
    this.child = null;
    return {
      ok: !run.error,
      timedOut: Boolean(run.error?.killed),
      log: `$ ${step.bin} ${step.args.join(" ")}\n${stepLogTail(run, LOG_TAIL)}`,
    };
  }
}

/** One line for the agent-facing status tool. */
export function buildWarmSummary(state: BuildWarmState): string {
  switch (state.state) {
    case "off":
      return "构建预热:已关闭(部署时会完整构建)";
    case "idle":
      return "构建预热:本次启动后还没有落地需要预热";
    case "running":
      return `构建预热:正在为 ${state.sha.slice(0, 10)} 预构建(部署时可直接复用)`;
    case "done":
      return state.ok
        ? `构建预热:${state.sha.slice(0, 10)} 已就绪(耗时 ${Math.round(state.ms / 1000)}s),部署时命中缓存`
        : `构建预热:${state.sha.slice(0, 10)} ${state.detail},部署会照常完整构建`;
  }
}
