/**
 * Architecture observatory service: the compact projection the panel serves,
 * and the single-slot background job that regenerates the snapshot.
 *
 * The snapshot is `packages/architecture-observatory`'s atlas — a tens-of-MB JSON
 * document whose bulk is the per-file/per-symbol/per-call fact tables. The
 * panel never ships those: `view()` projects the atlas down to the stable DTO
 * below (zones, modules, dependencies, flows, constraints, findings, TCB,
 * hotspots), which is what the browser page renders.
 *
 * Two deliberate shapes, both with precedent in this package:
 *
 * - `runAnalyzer` is a TEST SEAM exactly like `devpipe/app-ticket-refresh.ts`'s
 *   `pack`: production spawns the analyzer CLI as a subprocess, a test hands
 *   back an outcome without one.
 * - The refresh job is a PROCESS-LEVEL single slot, not per-user — the analyzer
 *   reads one shared checkout and writes one shared snapshot, so two concurrent
 *   runs would race on the same output file. Job state rides on the GET
 *   response (`status()`), the same way the secretary's job slot rides on its
 *   overview poll, so there is no separate status route.
 *
 * The projection types here deliberately do NOT import
 * `@claude-bot/architecture-observatory` — that package exports nothing
 * (`package.json` has no `exports`), the snapshot arrives as a file rather
 * than a call, and a disk file must be read defensively anyway. The structural
 * source of truth is `packages/architecture-observatory/src/shared/model.ts`;
 * the `Atlas*` types below are the narrow subset this projection reads.
 */

import type { ChildProcess } from "node:child_process";
import { runChild, stepLogTail, tailBytesFor } from "../devpipe/child-output.js";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { git as gitInRepo, type GitResult } from "../devpipe/worktree.js";
import { createLogger } from "../logger.js";
import {
  archiveCommitFromName,
  archiveMetadataFromAtlas,
  archiveMetadataPath,
  parseArchiveMetadata,
  retainedArchiveCommits,
  type ArchitectureArchiveCandidate,
  type ArchitectureArchiveMetadata,
} from "./architecture-archive.js";
import {
  COMMIT_SHA_RE,
  GIT_COMMIT_FORMAT,
  GIT_COMMIT_MARK,
  aggregateCodeChanges,
  diffArchitectureViews,
  nearestSnapshotCommit,
  parseCommitLog,
  parseNumstatLog,
  type ArchitectureDiff,
  type CodeChangeSummary,
  type EvolutionCommit,
  type ModuleRule,
} from "./architecture-evolution.js";

const log = createLogger("dashboard-architecture");

/**
 * Analysis is a cold TypeScript program build over ~800 files. Idle it takes
 * 1-2 minutes, but measured 2026-08-09 on this 2-core host under production
 * load (bot + dev agents) a full run took 19 minutes — a 5-minute budget would
 * make the first production refresh fail every time. Cached (--reuse) runs
 * return in seconds and never approach this.
 */
export const ANALYZER_TIMEOUT_MS = 1_500_000;
/**
 * Reconcile the atlas with this process's checkout often enough to recover
 * from a transient analyzer failure without turning a 19-minute cold scan into
 * a tight retry loop.
 */
export const AUTO_REFRESH_INTERVAL_MS = 5 * 60_000;
/** Kept from the failing analyzer's output: the refusal is at the end. */
const LOG_TAIL_BYTES = 4000;
/** Review-ordering signal, not a quality score (observatory CLAUDE.md). */
const HOTSPOT_LIMIT = 12;

// ── Evolution bounds (every response stays small no matter the range) ──

/**
 * One commit-axis WINDOW, not a history bound: `head` + `offset` page the rest
 * (the page asks for 200 first and 500 per "load older").
 */
export const COMMITS_LIMIT_MAX = 500;
/**
 * Commits listed in a diff response: a window with its total shown beside it.
 * The aggregation itself covers the whole range (a fold whose answer is per
 * module, so its size does not grow with the range), and the timeline pages
 * every commit.
 */
const RANGE_COMMITS_LISTED = 100;
/** Top touched files listed per module in a diff response. */
const MODULE_FILES_LISTED = 8;
/** rev-list window used to place snapshots relative to range endpoints. */
const ORDER_WINDOW = 2000;
/** Projected snapshot views kept in memory for diffing (each is small). */
const VIEW_CACHE_MAX = 4;

// ── The DTO the browser page is built against (field names are contract) ──

export interface ArchitectureApiResponse {
  generated: boolean;
  job: ArchitectureJob | null;
  /** Present only when `generated` is true. */
  snapshot?: ArchitectureView;
}

export type ArchitectureJob =
  | { running_since: string }
  | { done: true; finished_at: string; ok: boolean; error?: string };

export interface ArchitectureView {
  meta: {
    commit: string;
    branch: string;
    dirty: boolean;
    generatedAt: string;
    totals: { files: number; codeLoc: number; symbols: number; calls: number; annotations: number };
  };
  zones: Array<{ id: string; label: string; trust: string; color: string; description?: string }>;
  modules: Array<{
    id: string;
    label: string;
    description: string;
    zone: string;
    criticality: string;
    tags: string[];
    docs: string[];
    files: number;
    codeLoc: number;
    testFiles: number;
    gitTouches: number;
    runtimeFanIn: number;
    runtimeFanOut: number;
    typeOnlyFanIn: number;
    typeOnlyFanOut: number;
    /** Runtime-only compatibility aliases retained for archived consumers. */
    fanIn: number;
    fanOut: number;
    annotations: number;
  }>;
  dependencies: Array<{
    from: string;
    to: string;
    runtimeCount: number;
    typeOnlyCount: number;
    testCount: number;
    dynamicCount: number;
    circular: boolean;
    samples: Array<{ path: string; line: number; specifier: string }>;
  }>;
  moduleEcosystem: {
    frontend: Array<{
      id: string;
      title: string;
      version: string;
      implementation: string;
      packageId: string;
      packagePath: string;
      slots: string[];
      ports: Array<{ id: string; packageId?: string }>;
      opens: string[];
      summary: string;
      preview: "search" | "tree" | "chat" | "document" | "form" | "board" | "slides" | "detail" | "status" | "panel";
      configKeys: string[];
      source: { path: string; line: number };
    }>;
    contracts: Array<{
      id: string;
      packageId?: string;
      packagePath?: string;
      summary: string;
      actions: Array<{ id: string; summary: string; operation?: string }>;
      source?: { path: string; line: number };
      provision: "trusted-provider" | "app-or-host";
    }>;
    backend: Array<{
      id: string;
      name: string;
      summary: string;
      packageId: string;
      path: string;
      files: number;
      loc: number;
      kind: "provider";
      contracts: string[];
      actions: Array<{ id: string; summary: string; operation?: string }>;
      registered: boolean;
      dependencies: string[];
      source: { path: string; line: number };
    }>;
    dependencies: Array<{
      from: string;
      to: string;
      kind: "requires" | "provides" | "provider";
      label: string;
    }>;
    issues: Array<{ message: string; source?: { path: string; line: number } }>;
  };
  flows: Array<{
    id: string;
    title: string;
    description: string;
    perspective: string;
    coverage?: { mode: string; scope: string; exclusions: string[] };
    steps: Array<{
      id: string;
      label: string;
      description?: string;
      zone: string;
      after: string[];
      role?: string;
      condition?: string;
      outcome?: string;
      authority?: string;
      terminal?: boolean;
      source?: { path: string; line: number };
    }>;
  }>;
  constraints: Array<{
    id: string;
    title: string;
    description: string;
    concern: string;
    severity: string;
    status: string;
    mechanismKind: string | null;
    summary?: string;
    violations: Array<{ message: string; source?: { path: string; line: number } }>;
    evidence: Array<{ grade: string; label: string; source?: { path: string; line: number } }>;
  }>;
  findings: Array<{
    signal: string;
    severity: string;
    message: string;
    moduleIds: string[];
    source?: { path: string; line: number };
  }>;
  tcb: {
    label: string;
    lines: number;
    baseline: number;
    tolerance: number;
    files: Array<{ path: string; loc: number }>;
    unregistered: string[];
    stale: string[];
  } | null;
  hotspots: Array<{ moduleId: string; path: string; codeLoc: number; touches: number; score: number }>;
}

// ── Evolution DTOs (commit axis, snapshot manifest, range diff) ──

export interface ArchitectureCommitsResponse {
  /** Newest first, from `head` after skipping `offset` commits. */
  commits: EvolutionCommit[];
  /** True when history continues past this window; `next_offset` reaches it. */
  truncated: boolean;
  /**
   * The commit this axis is anchored on. Older windows name it so a landing
   * that moves HEAD between two requests cannot shift, repeat or skip a commit.
   * Absent only when the history is empty.
   */
  head?: string;
  /** The `offset` of the next older window; present exactly when `truncated`. */
  next_offset?: number;
}

/** Where an older commit-axis window starts. Both come from a previous answer. */
export interface ArchitectureCommitsCursor {
  head: string;
  offset: number;
}

export interface ArchitectureSnapshotInfo extends ArchitectureArchiveMetadata {
  /** True for the snapshot the live atlas.json currently holds. */
  current: boolean;
}

export interface ArchitectureSnapshotsResponse {
  /** Newest first by generatedAt. */
  snapshots: ArchitectureSnapshotInfo[];
}

export interface ArchitectureDiffResponse {
  from: string;
  to: string;
  /** Always present: git is always able to answer this half. */
  code: CodeChangeSummary;
  /** Null when the range's endpoints do not resolve to two distinct snapshots. */
  architecture: ArchitectureDiff | null;
  /** The honest reason `architecture` is null. */
  architectureUnavailable?: string;
}

// ── The narrow atlas subset the projection reads (see module header) ──

interface AtlasSource {
  path?: string;
  line?: number;
}

interface AtlasLike {
  meta?: {
    commit?: string;
    branch?: string;
    dirty?: boolean;
    generatedAt?: string;
  };
  zones?: Array<{ id?: string; label?: string; description?: string; color?: string; trust?: string }>;
  modules?: Array<{
    id?: string;
    label?: string;
    description?: string;
    zone?: string;
    criticality?: string;
    tags?: string[];
    docs?: string[];
    files?: number;
    codeLoc?: number;
    testFiles?: number;
    gitTouches?: number;
    runtimeFanIn?: number;
    runtimeFanOut?: number;
    typeOnlyFanIn?: number;
    typeOnlyFanOut?: number;
    /** Legacy snapshots used combined fan-in/out fields. */
    fanIn?: number;
    fanOut?: number;
  }>;
  files?: Array<{
    path?: string;
    moduleId?: string;
    isTest?: boolean;
    codeLoc?: number;
    git?: { touches?: number };
  }>;
  dependencies?: Array<{
    from?: string;
    to?: string;
    runtimeCount?: number;
    typeOnlyCount?: number;
    testCount?: number;
    dynamicCount?: number;
    circular?: boolean;
    samples?: Array<{ source?: AtlasSource; specifier?: string }>;
  }>;
  moduleEcosystem?: {
    frontend?: Array<{
      id?: string;
      title?: string;
      version?: string;
      implementation?: string;
      packageId?: string;
      packagePath?: string;
      slots?: string[];
      ports?: Array<{ id?: string; packageId?: string }>;
      opens?: string[];
      summary?: string;
      preview?: string;
      configKeys?: string[];
      source?: AtlasSource;
    }>;
    contracts?: Array<{
      id?: string;
      packageId?: string;
      packagePath?: string;
      summary?: string;
      actions?: Array<{ id?: string; summary?: string; operation?: string }>;
      source?: AtlasSource;
      provision?: string;
    }>;
    backend?: Array<{
      id?: string;
      name?: string;
      summary?: string;
      packageId?: string;
      path?: string;
      files?: number;
      loc?: number;
      kind?: string;
      contracts?: string[];
      actions?: Array<{ id?: string; summary?: string; operation?: string }>;
      registered?: boolean;
      dependencies?: string[];
      source?: AtlasSource;
    }>;
    dependencies?: Array<{
      from?: string;
      to?: string;
      kind?: string;
      label?: string;
    }>;
    issues?: Array<{ message?: string; source?: AtlasSource }>;
  };
  symbols?: unknown[];
  calls?: unknown[];
  annotations?: Array<{ source?: AtlasSource }>;
  flows?: Array<{
    id?: string;
    title?: string;
    description?: string;
    perspective?: string;
    coverage?: { mode?: string; scope?: string; exclusions?: string[] };
    steps?: Array<{
      id?: string;
      label?: string;
      description?: string;
      zone?: string;
      after?: string[];
      role?: string;
      condition?: string;
      outcome?: string;
      authority?: string;
      terminal?: boolean;
      source?: AtlasSource;
    }>;
  }>;
  constraints?: Array<{
    id?: string;
    title?: string;
    description?: string;
    concern?: string;
    severity?: string;
    status?: string;
    summary?: string;
    mechanism?: { kind?: string };
    violations?: Array<{ message?: string; source?: AtlasSource }>;
    evidence?: Array<{ grade?: string; label?: string; source?: AtlasSource }>;
  }>;
  tcbs?: Array<{
    constraintId?: string;
    total?: number;
    baseline?: number;
    tolerance?: number;
    files?: Array<{ path?: string; codeLoc?: number }>;
    unregistered?: string[];
    stale?: string[];
  }>;
  findings?: Array<{
    signal?: string;
    severity?: string;
    title?: string;
    description?: string;
    moduleIds?: string[];
    source?: AtlasSource;
  }>;
}

export interface ArchitectureServiceOptions {
  /** Repository checkout the analyzer reads — this process's own tree. */
  repoDir: string;
  /** Data dir; the snapshot lives at `<dataDir>/architecture/atlas.json`. */
  dataDir: string;
  /**
   * Test seam, exactly `devpipe/app-ticket-refresh.ts`'s `pack`: production
   * spawns the analyzer CLI in `repoDir`, a test resolves an outcome directly.
   */
  runAnalyzer?: (input: {
    repoDir: string;
    outFile: string;
    signal: AbortSignal;
  }) => Promise<{ ok: boolean; log: string }>;
  /**
   * Test seam for the evolution reads: production runs `git` in `repoDir`
   * through `devpipe/worktree.ts`'s execFile wrapper (read-only queries only),
   * a test answers from fixtures.
   */
  runGit?: (args: string[]) => Promise<GitResult>;
}

export class ArchitectureService {
  private readonly snapshotPath: string;
  /** Archive of past analyses, one `<commit sha>.json` per analysed commit. */
  private readonly archiveDir: string;
  /**
   * The ONE job slot of this process. Not per-user: the analyzer reads one
   * shared checkout and writes one shared snapshot, so a second concurrent run
   * would race the first on the same file for the same answer.
   */
  private job: ArchitectureJob | null = null;
  /** The analyzer child owned by the current job, aborted during process drain. */
  private activeRun: { controller: AbortController; promise: Promise<void> } | null = null;
  /** Automatic checkout reconciliation is one self-rescheduling timer. */
  private autoRefresh: { enabled: boolean; intervalMs: number; timer: NodeJS.Timeout | null } | null = null;
  /** Parsed projection, keyed on the snapshot file's identity at read time. */
  private cache: { mtimeMs: number; size: number; view: ArchitectureView } | null = null;
  /** Archived-snapshot metadata, keyed on data-file identity after a tiny sidecar read. */
  private readonly metaCache = new Map<string, { mtimeMs: number; size: number; ref: ArchitectureSnapshotInfo }>();
  /** Projected archived views for diffing, small and insertion-order evicted. */
  private readonly viewCache = new Map<string, { mtimeMs: number; size: number; view: ArchitectureView }>();

  constructor(private readonly opts: ArchitectureServiceOptions) {
    this.snapshotPath = path.join(opts.dataDir, "architecture", "atlas.json");
    this.archiveDir = path.join(opts.dataDir, "architecture", "snapshots");
  }

  /** The compact projection, or null when no snapshot has been generated. */
  async view(): Promise<ArchitectureView | null> {
    let stat: { mtimeMs: number; size: number };
    try {
      stat = await fsp.stat(this.snapshotPath);
    } catch {
      return null;
    }
    if (this.cache && this.cache.mtimeMs === stat.mtimeMs && this.cache.size === stat.size) {
      return this.cache.view;
    }
    let atlas: AtlasLike;
    try {
      atlas = JSON.parse(await fsp.readFile(this.snapshotPath, "utf8")) as AtlasLike;
    } catch (err) {
      // A torn or corrupt snapshot reads as "not generated" rather than a 500:
      // the fix is a refresh, and the page offers exactly that.
      log.warn({ err, snapshot: this.snapshotPath }, "architecture snapshot is unreadable");
      return null;
    }
    if (typeof atlas !== "object" || atlas === null) return null;
    const view = projectAtlas(atlas);
    this.cache = { mtimeMs: stat.mtimeMs, size: stat.size, view };
    return view;
  }

  /** Job state, riding on the GET response. `null` = never ran this process. */
  status(): ArchitectureJob | null {
    return this.job;
  }

  /**
   * Keep the live atlas and archive aligned with this process's checkout.
   *
   * Startup checks immediately. Afterwards one self-rescheduling timer retries
   * failures and also catches a checkout whose HEAD was advanced in place. A
   * matching atlas costs one cheap `git rev-parse` plus a cached projection;
   * the expensive analyzer only starts when the commit is absent or stale.
   */
  startAutoRefresh(intervalMs = AUTO_REFRESH_INTERVAL_MS): void {
    if (this.autoRefresh?.enabled) return;
    this.autoRefresh = {
      enabled: true,
      intervalMs: Math.max(10, Math.floor(intervalMs)),
      timer: null,
    };
    void this.autoRefreshTick();
  }

  /** Stop future reconciliation and kill any analyzer child owned by us. */
  async stop(): Promise<void> {
    const auto = this.autoRefresh;
    if (auto) {
      auto.enabled = false;
      if (auto.timer) clearTimeout(auto.timer);
      auto.timer = null;
    }
    const active = this.activeRun;
    if (active) {
      active.controller.abort();
      await active.promise;
    }
  }

  /**
   * Start a background re-analysis, unless one is already running.
   *
   * The outcome always resolves into the job slot — the analyzer failing, the
   * subprocess being killed by its timeout, even the seam throwing all become
   * a `done` record with `ok: false`, never an unhandled rejection.
   */
  refresh(): { started: true } | { started: false; running_since: string } {
    const active = this.activeRun;
    if (active) {
      const current = this.job;
      return {
        started: false,
        running_since: current && "running_since" in current ? current.running_since : new Date().toISOString(),
      };
    }
    this.job = { running_since: new Date().toISOString() };
    const controller = new AbortController();
    const promise = this.run(controller.signal)
      .then((outcome) => {
        this.job = {
          done: true,
          finished_at: new Date().toISOString(),
          ok: outcome.ok,
          ...(outcome.ok ? {} : { error: outcome.error }),
        };
      })
      .finally(() => {
        if (this.activeRun?.promise === promise) this.activeRun = null;
      });
    this.activeRun = { controller, promise };
    void promise;
    return { started: true };
  }

  private async run(signal: AbortSignal): Promise<{ ok: true } | { ok: false; error: string }> {
    const runner = this.opts.runAnalyzer ?? runAnalyzerCli;
    const started = Date.now();
    log.info({ execution: this.opts.runAnalyzer ? "provider" : "local" }, "architecture refresh started");
    try {
      const result = await runner({ repoDir: this.opts.repoDir, outFile: this.snapshotPath, signal });
      log.info({ ok: result.ok, ms: Date.now() - started, execution: this.opts.runAnalyzer ? "provider" : "local" }, "architecture refresh finished");
      if (!result.ok) return { ok: false, error: tail(result.log) };
      await this.archiveSnapshot();
      return { ok: true };
    } catch (error) {
      log.warn({ error: describeError(error), ms: Date.now() - started }, "architecture refresh unavailable; previous snapshot retained");
      return { ok: false, error: describeError(error) };
    }
  }

  /** One automatic comparison. The scheduler calls it again after the delay. */
  private async autoRefreshTick(): Promise<void> {
    const auto = this.autoRefresh;
    if (!auto?.enabled) return;
    try {
      const head = await this.runGit(["rev-parse", "HEAD"]);
      const commit = head.stdout.trim();
      if (!this.autoRefresh?.enabled) return;
      if (!head.ok || !COMMIT_SHA_RE.test(commit)) {
        log.warn({ err: head.stderr || head.code }, "cannot resolve checkout HEAD for automatic architecture refresh");
      } else {
        const current = await this.view();
        if (current?.meta.commit === commit) {
          await this.ensureArchived(commit);
        } else {
          const started = this.refresh();
          if (started.started) {
            log.info(
              { commit, previous: current?.meta.commit || null },
              "checkout has no current architecture snapshot; automatic analysis started",
            );
          }
        }
      }
    } catch (err) {
      log.warn({ err }, "automatic architecture refresh check failed");
    } finally {
      const latest = this.autoRefresh;
      if (latest?.enabled) {
        latest.timer = setTimeout(() => void this.autoRefreshTick(), latest.intervalMs);
        latest.timer.unref?.();
      }
    }
  }

  // ── Evolution: commit axis, snapshot manifest, range diff ──
  //
  // All of it is snapshot files plus CHEAP git reads — never the analyzer.
  // A full analysis takes ~19 minutes on this 2-core host; the evolution view
  // exists precisely so that dragging a range costs a `git log`, not that.

  /**
   * Copy a successful run's atlas into the archive as `<commit>.json`.
   *
   * Same commit twice (e.g. re-analysed with a dirty tree) overwrites — one
   * archive entry per commit is the invariant the diff endpoint keys on. A
   * failed archive is logged but does not fail the refresh: the analysis
   * itself succeeded, and the live atlas is intact.
   */
  private async archiveSnapshot(): Promise<void> {
    let archived: ArchitectureArchiveMetadata | null = null;
    let dataTmp = "";
    let metadataTmp = "";
    try {
      const raw = await fsp.readFile(this.snapshotPath, "utf8");
      const atlas = JSON.parse(raw) as AtlasLike;
      archived = archiveMetadataFromAtlas(atlas);
      if (!archived) {
        log.warn({ commit: atlas.meta?.commit ?? "" }, "snapshot has no usable commit; not archiving");
        return;
      }
      await fsp.mkdir(this.archiveDir, { recursive: true });
      const target = path.join(this.archiveDir, `${archived.commit}.json`);
      const metadataTarget = archiveMetadataPath(target);
      dataTmp = `${target}.tmp`;
      metadataTmp = `${metadataTarget}.tmp`;
      await Promise.all([
        fsp.writeFile(dataTmp, raw),
        fsp.writeFile(metadataTmp, `${JSON.stringify(archived)}\n`),
      ]);
      // Two files cannot be renamed transactionally. Removing the old sidecar
      // first makes the only intermediate state honest: readers fall back to
      // the newly renamed atlas and repair its metadata themselves.
      await fsp.rm(metadataTarget, { force: true });
      await fsp.rename(dataTmp, target);
      dataTmp = "";
      await fsp.rename(metadataTmp, metadataTarget);
      metadataTmp = "";
      this.metaCache.delete(target);
      this.viewCache.delete(target);
      log.info({ commit: archived.commit }, "archived architecture snapshot");
    } catch (err) {
      log.warn({ err }, "failed to archive architecture snapshot");
      return;
    } finally {
      await Promise.allSettled([
        dataTmp ? fsp.rm(dataTmp, { force: true }) : Promise.resolve(),
        metadataTmp ? fsp.rm(metadataTmp, { force: true }) : Promise.resolve(),
      ]);
    }
    if (archived) await this.pruneArchives(archived.commit);
  }

  /** Repair an old live atlas whose successful run predated snapshot archives. */
  private async ensureArchived(commit: string): Promise<void> {
    const target = path.join(this.archiveDir, `${commit}.json`);
    if ((await this.archivedMeta(target)) === null) {
      await this.archiveSnapshot();
      return;
    }
    await this.pruneArchives(commit);
  }

  private runGit(args: string[]): Promise<GitResult> {
    const runner = this.opts.runGit ?? ((a: string[]) => gitInRepo(this.opts.repoDir, a));
    return runner(args);
  }

  /**
   * The commit axis: newest first from this checkout's HEAD, one window at a
   * time. An older window is `git log --skip` from the SAME anchor commit the
   * first window reported, so the walk order is git's deterministic order from
   * one fixed commit and every reachable commit is eventually listed once.
   */
  async commits(
    limit: number,
    cursor?: ArchitectureCommitsCursor,
  ): Promise<ArchitectureCommitsResponse | { error: string }> {
    const take = Math.max(1, Math.min(COMMITS_LIMIT_MAX, Math.floor(limit)));
    if (cursor && (!COMMIT_SHA_RE.test(cursor.head) || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0)) {
      return { error: "head 必须是 commit SHA，offset 必须是非负整数" };
    }
    const offset = cursor?.offset ?? 0;
    // One PAST the limit so "truncated" is an observation, not a guess.
    const result = await this.runGit([
      "log",
      `-${take + 1}`,
      `--format=${GIT_COMMIT_FORMAT}`,
      ...(offset > 0 ? [`--skip=${offset}`] : []),
      ...(cursor ? [cursor.head, "--"] : []),
    ]);
    if (!result.ok) return { error: `git log failed: ${result.stderr || result.code}` };
    const all = parseCommitLog(result.stdout);
    const commits = all.slice(0, take);
    const truncated = all.length > take;
    // The first window starts at HEAD, so its first commit IS the anchor.
    const head = cursor?.head ?? commits[0]?.sha;
    return {
      commits,
      truncated,
      ...(head ? { head } : {}),
      ...(truncated ? { next_offset: offset + commits.length } : {}),
    };
  }

  /**
   * The snapshot manifest: every archived analysis plus the live atlas.
   * On a fresh deployment this is honestly ONE entry — the page says so
   * rather than pretending at history.
   */
  async snapshots(): Promise<ArchitectureSnapshotsResponse> {
    const entries: ArchitectureSnapshotInfo[] = [];
    const current = await this.view();
    // Prune before any legacy fallback parse. On the first upgraded read this
    // reduces a large sidecar-less archive to the bounded set using only stat
    // data, then backfills metadata for the survivors.
    await this.pruneArchives(current?.meta.commit);
    let names: string[] = [];
    try {
      names = (await fsp.readdir(this.archiveDir)).filter((name) => archiveCommitFromName(name) !== null);
    } catch {
      // No archive directory yet: nothing has been archived, which is an answer.
    }
    for (const name of names.sort()) {
      const ref = await this.archivedMeta(path.join(this.archiveDir, name));
      if (ref) entries.push({ ...ref });
    }
    if (current) {
      const existing = entries.find((entry) => entry.commit === current.meta.commit);
      if (existing) {
        existing.current = true;
      } else {
        entries.push({
          commit: current.meta.commit,
          branch: current.meta.branch,
          dirty: current.meta.dirty,
          generatedAt: current.meta.generatedAt,
          current: true,
        });
      }
    }
    entries.sort((a, b) => (a.generatedAt < b.generatedAt ? 1 : a.generatedAt > b.generatedAt ? -1 : 0));
    return { snapshots: entries };
  }

  /**
   * The range answer: code change from git (always), architecture change from
   * the two archived snapshots nearest the endpoints (when two distinct ones
   * exist — otherwise `architecture` is null and the response says why).
   */
  async evolutionDiff(from: string, to: string): Promise<ArchitectureDiffResponse | { error: string }> {
    if (!COMMIT_SHA_RE.test(from) || !COMMIT_SHA_RE.test(to)) {
      return { error: "from/to 必须是 commit SHA（十六进制，≥7 位）" };
    }
    if (from === to) return { error: "from 与 to 不能相同" };
    const ancestry = await this.runGit(["merge-base", "--is-ancestor", from, to]);
    if (!ancestry.ok) {
      return { error: "from 必须是 to 的祖先（范围左端应是更早的 commit）" };
    }
    const counted = await this.runGit(["rev-list", "--count", `${from}..${to}`]);
    if (!counted.ok) return { error: `git rev-list failed: ${counted.stderr || counted.code}` };
    const commitCount = Number(counted.stdout.trim()) || 0;
    const numstat = await this.runGit([
      "log",
      `--format=${GIT_COMMIT_MARK}${GIT_COMMIT_FORMAT}`,
      "--numstat",
      "--no-renames",
      `${from}..${to}`,
    ]);
    if (!numstat.ok) return { error: `git log failed: ${numstat.stderr || numstat.code}` };
    const rangeCommits = parseNumstatLog(numstat.stdout);
    const code = aggregateCodeChanges(rangeCommits, await this.moduleRules(), commitCount, {
      moduleFiles: MODULE_FILES_LISTED,
      commits: RANGE_COMMITS_LISTED,
    });

    const { architecture, why } = await this.architectureBetween(from, to);
    return {
      from,
      to,
      code,
      architecture,
      ...(why === undefined ? {} : { architectureUnavailable: why }),
    };
  }

  /** The architecture half of a diff, or the honest reason there is none. */
  private async architectureBetween(
    from: string,
    to: string,
  ): Promise<{ architecture: ArchitectureDiff | null; why?: string }> {
    const listing = await this.runGit(["rev-list", `-${ORDER_WINDOW}`, "HEAD"]);
    if (!listing.ok) {
      return { architecture: null, why: `git rev-list failed: ${listing.stderr || listing.code}` };
    }
    const order = new Map<string, number>();
    listing.stdout.split(/\r?\n/).forEach((sha, at) => {
      if (sha) order.set(sha, at);
    });
    const manifest = (await this.snapshots()).snapshots;
    const placeable = manifest.filter((snap) => order.has(snap.commit)).map((snap) => snap.commit);
    if (placeable.length === 0) {
      return { architecture: null, why: "还没有可定位的架构快照——只显示代码变化。快照会随每次成功分析自动留档。" };
    }
    const baseSha = nearestSnapshotCommit(order, placeable, from);
    const headSha = nearestSnapshotCommit(order, placeable, to);
    if (baseSha === null || headSha === null) {
      return { architecture: null, why: "范围端点不在最近的提交窗口内，无法定位架构快照——只显示代码变化。" };
    }
    if (baseSha === headSha) {
      return {
        architecture: null,
        why: "该区间附近只有一份架构快照，无法做架构对比——只显示代码变化。快照会随每次成功分析自动留档。",
      };
    }
    const base = await this.archivedView(baseSha);
    const head = await this.archivedView(headSha);
    if (base === null || head === null) {
      return { architecture: null, why: "架构快照文件不可读——只显示代码变化。" };
    }
    return { architecture: diffArchitectureViews(base, head) };
  }

  /** Meta of one archived snapshot: sidecar first, full-atlas fallback once. */
  private async archivedMeta(file: string): Promise<ArchitectureSnapshotInfo | null> {
    const expectedCommit = archiveCommitFromName(path.basename(file));
    if (!expectedCommit) return null;
    let stat: { mtimeMs: number; size: number };
    try {
      stat = await fsp.stat(file);
    } catch {
      return null;
    }
    const cached = this.metaCache.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.ref;
    const sidecar = await this.readArchiveSidecar(file, expectedCommit);
    if (sidecar) {
      const ref = { ...sidecar, current: false };
      this.metaCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, ref });
      return ref;
    }
    try {
      const atlas = JSON.parse(await fsp.readFile(file, "utf8")) as AtlasLike;
      const metadata = archiveMetadataFromAtlas(atlas);
      if (!metadata || metadata.commit !== expectedCommit) return null;
      const ref: ArchitectureSnapshotInfo = { ...metadata, current: false };
      try {
        await this.writeArchiveSidecar(file, metadata);
      } catch (err) {
        log.warn({ err, file }, "failed to backfill architecture snapshot metadata sidecar");
      }
      this.metaCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, ref });
      return ref;
    } catch (err) {
      log.warn({ err, file }, "archived architecture snapshot is unreadable");
      return null;
    }
  }

  private async readArchiveSidecar(
    file: string,
    expectedCommit: string,
  ): Promise<ArchitectureArchiveMetadata | null> {
    try {
      return parseArchiveMetadata(
        JSON.parse(await fsp.readFile(archiveMetadataPath(file), "utf8")) as unknown,
        expectedCommit,
      );
    } catch {
      return null;
    }
  }

  private async writeArchiveSidecar(file: string, metadata: ArchitectureArchiveMetadata): Promise<void> {
    const target = archiveMetadataPath(file);
    const tmp = `${target}.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
    try {
      await fsp.writeFile(tmp, `${JSON.stringify(metadata)}\n`);
      await fsp.rename(tmp, target);
    } finally {
      await fsp.rm(tmp, { force: true });
    }
  }

  /** Apply the dense-recent + sparse-history disk budget without parsing atlases. */
  private async pruneArchives(protectedCommit?: string): Promise<void> {
    let names: string[];
    try {
      names = await fsp.readdir(this.archiveDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn({ err }, "failed to list architecture snapshots for retention");
      }
      return;
    }

    const candidates: Array<ArchitectureArchiveCandidate & { file: string; size: number }> = [];
    for (const name of names.sort()) {
      const commit = archiveCommitFromName(name);
      if (!commit) continue;
      const file = path.join(this.archiveDir, name);
      try {
        const stat = await fsp.stat(file);
        const sidecar = await this.readArchiveSidecar(file, commit);
        candidates.push({
          commit,
          ...(sidecar?.generatedAt ? { generatedAt: sidecar.generatedAt } : {}),
          mtimeMs: stat.mtimeMs,
          file,
          size: stat.size,
        });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          log.warn({ err, file }, "failed to inspect architecture snapshot for retention");
        }
      }
    }

    const retained = retainedArchiveCommits(
      candidates,
      new Set(protectedCommit ? [protectedCommit] : []),
    );
    let removed = 0;
    let bytesFreed = 0;
    for (const candidate of candidates) {
      if (retained.has(candidate.commit)) continue;
      let dataRemoved = false;
      try {
        await fsp.unlink(candidate.file);
        dataRemoved = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          log.warn({ err, file: candidate.file }, "failed to prune architecture snapshot");
          continue;
        }
      }
      try {
        await fsp.unlink(archiveMetadataPath(candidate.file));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          log.warn({ err, file: archiveMetadataPath(candidate.file) }, "failed to prune snapshot metadata sidecar");
        }
      }
      this.metaCache.delete(candidate.file);
      this.viewCache.delete(candidate.file);
      if (dataRemoved) {
        removed += 1;
        bytesFreed += candidate.size;
      }
    }
    if (removed > 0) {
      log.info(
        { removed, retained: candidates.length - removed, bytesFreed },
        "pruned architecture snapshot archive",
      );
    }
  }

  /** Projected view of one archived snapshot (falls back to the live atlas). */
  private async archivedView(commit: string): Promise<ArchitectureView | null> {
    const file = path.join(this.archiveDir, `${commit}.json`);
    let stat: { mtimeMs: number; size: number } | null = null;
    try {
      stat = await fsp.stat(file);
    } catch {
      // Not archived — the live atlas may still BE this commit (first launch).
      const current = await this.view();
      return current !== null && current.meta.commit === commit ? current : null;
    }
    const cached = this.viewCache.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.view;
    try {
      const atlas = JSON.parse(await fsp.readFile(file, "utf8")) as AtlasLike;
      if (typeof atlas !== "object" || atlas === null) return null;
      const view = projectAtlas(atlas);
      this.viewCache.delete(file);
      this.viewCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, view });
      while (this.viewCache.size > VIEW_CACHE_MAX) {
        const oldest = this.viewCache.keys().next().value;
        if (oldest === undefined) break;
        this.viewCache.delete(oldest);
      }
      return view;
    } catch (err) {
      log.warn({ err, file }, "archived architecture snapshot is unreadable");
      return null;
    }
  }

  /**
   * The path→module rules from this checkout's human-maintained atlas config —
   * the same vocabulary the analyzer attributes files with. Unreadable config
   * degrades to "everything unmapped" rather than a failed diff.
   */
  private async moduleRules(): Promise<ModuleRule[]> {
    try {
      const raw = await fsp.readFile(path.join(this.opts.repoDir, "architecture", "atlas.json"), "utf8");
      const config = JSON.parse(raw) as { modules?: Array<{ id?: string; pathPrefixes?: string[] }> };
      return (config.modules ?? []).flatMap((module) =>
        module.id && Array.isArray(module.pathPrefixes) && module.pathPrefixes.length > 0
          ? [{ id: module.id, pathPrefixes: module.pathPrefixes }]
          : [],
      );
    } catch (err) {
      log.warn({ err }, "architecture atlas config is unreadable; code changes will be unmapped");
      return [];
    }
  }
}

/**
 * Production analyzer run: the CLI in this checkout, `--reuse` deliberately.
 *
 * `--reuse` skips the expensive analysis when the input fingerprint already
 * matches the snapshot; NOT `--check`, whose non-zero exit means "the
 * architecture has violations" — a truthful atlas that must still be served,
 * not a failed refresh.
 */
function runAnalyzerCli(input: {
  repoDir: string;
  outFile: string;
  signal: AbortSignal;
}): Promise<{ ok: boolean; log: string }> {
  const args = [
    "tsx",
    "packages/architecture-observatory/src/analyzer/cli.ts",
    "--root",
    input.repoDir,
    "--config",
    path.join(input.repoDir, "architecture", "atlas.json"),
    "--out",
    input.outFile,
    "--reuse",
  ];
  // Only `tail(log)` is ever reported; keep a bounded tail so output volume
  // cannot kill the analyzer (it used to run under a 16 MiB maxBuffer).
  return (async () => {
    let child: ChildProcess | undefined;
    const abort = (): void => { child?.kill("SIGKILL"); };
    input.signal.addEventListener("abort", abort, { once: true });
    try {
      const run = await runChild("npx", args, {
        cwd: input.repoDir, timeoutMs: ANALYZER_TIMEOUT_MS, killSignal: "SIGKILL",
        tailBytes: tailBytesFor(ANALYZER_LOG_CHARS),
        onSpawn: (spawned) => { child = spawned; if (input.signal.aborted) abort(); },
      });
      return { ok: !run.error && !input.signal.aborted, log: `$ npx ${args.join(" ")}\n${stepLogTail(run, ANALYZER_LOG_CHARS)}` };
    } finally {
      input.signal.removeEventListener("abort", abort);
    }
  })();
}

const ANALYZER_LOG_CHARS = 16 * 1024;

// ── Projection ──

/**
 * Atlas → DTO. Drops the `files[]`/`symbols[]`/`calls[]` fact tables (the
 * snapshot's bulk) after deriving three things from them: the totals, each
 * module's `@architecture` anchor count, and the hotspot list.
 */
function projectAtlas(atlas: AtlasLike): ArchitectureView {
  const files = atlas.files ?? [];
  const annotations = atlas.annotations ?? [];

  // Every module's anchor count: annotation source path → owning module, via
  // the files table (the analyzer already did longest-prefix attribution).
  const moduleByPath = new Map<string, string>();
  for (const file of files) {
    if (file.path && file.moduleId) moduleByPath.set(file.path, file.moduleId);
  }
  const anchorsByModule = new Map<string, number>();
  for (const annotation of annotations) {
    const owner = annotation.source?.path ? moduleByPath.get(annotation.source.path) : undefined;
    if (!owner) continue;
    anchorsByModule.set(owner, (anchorsByModule.get(owner) ?? 0) + 1);
  }

  // Hotspots recomputed from the file facts (codeLoc × log2(touches+1), the
  // aggregate's own review-ordering signal), because hotspot FINDINGS carry
  // neither the size nor the touch count the page charts.
  const hotspots = files
    .filter((file) => file.path && !file.isTest)
    .map((file) => {
      const codeLoc = file.codeLoc ?? 0;
      const touches = file.git?.touches ?? 0;
      return {
        moduleId: file.moduleId ?? "",
        path: file.path!,
        codeLoc,
        touches,
        score: Math.round(codeLoc * Math.log2(touches + 1) * 10) / 10,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, HOTSPOT_LIMIT);

  const tcbFact = (atlas.tcbs ?? [])[0];

  return {
    meta: {
      commit: atlas.meta?.commit ?? "",
      branch: atlas.meta?.branch ?? "",
      dirty: Boolean(atlas.meta?.dirty),
      generatedAt: atlas.meta?.generatedAt ?? "",
      totals: {
        files: files.length,
        codeLoc: files.reduce((sum, file) => sum + (file.codeLoc ?? 0), 0),
        symbols: (atlas.symbols ?? []).length,
        calls: (atlas.calls ?? []).length,
        annotations: annotations.length,
      },
    },
    zones: (atlas.zones ?? []).map((zone) => ({
      id: zone.id ?? "",
      label: zone.label ?? "",
      trust: zone.trust ?? "",
      color: zone.color ?? "",
      ...(zone.description ? { description: zone.description } : {}),
    })),
    modules: (atlas.modules ?? []).map((module) => ({
      id: module.id ?? "",
      label: module.label ?? "",
      description: module.description ?? "",
      zone: module.zone ?? "",
      criticality: module.criticality ?? "",
      tags: module.tags ?? [],
      docs: module.docs ?? [],
      files: module.files ?? 0,
      codeLoc: module.codeLoc ?? 0,
      testFiles: module.testFiles ?? 0,
      gitTouches: module.gitTouches ?? 0,
      runtimeFanIn: module.runtimeFanIn ?? module.fanIn ?? 0,
      runtimeFanOut: module.runtimeFanOut ?? module.fanOut ?? 0,
      typeOnlyFanIn: module.typeOnlyFanIn ?? 0,
      typeOnlyFanOut: module.typeOnlyFanOut ?? 0,
      fanIn: module.runtimeFanIn ?? module.fanIn ?? 0,
      fanOut: module.runtimeFanOut ?? module.fanOut ?? 0,
      annotations: anchorsByModule.get(module.id ?? "") ?? 0,
    })),
    dependencies: (atlas.dependencies ?? []).map((edge) => ({
      from: edge.from ?? "",
      to: edge.to ?? "",
      runtimeCount: edge.runtimeCount ?? 0,
      typeOnlyCount: edge.typeOnlyCount ?? 0,
      testCount: edge.testCount ?? 0,
      dynamicCount: edge.dynamicCount ?? 0,
      circular: Boolean(edge.circular),
      samples: (edge.samples ?? []).flatMap((sample) =>
        sample.source?.path
          ? [{ path: sample.source.path, line: sample.source.line ?? 0, specifier: sample.specifier ?? "" }]
          : [],
      ),
    })),
    moduleEcosystem: {
      frontend: (atlas.moduleEcosystem?.frontend ?? []).map((module) => ({
        id: module.id ?? "",
        title: module.title ?? "",
        version: module.version ?? "",
        implementation: module.implementation ?? "",
        packageId: module.packageId ?? "",
        packagePath: module.packagePath ?? "",
        slots: module.slots ?? [],
        ports: (module.ports ?? []).map((port) => ({
          id: port.id ?? "",
          ...(port.packageId ? { packageId: port.packageId } : {}),
        })),
        opens: module.opens ?? [],
        summary: module.summary ?? "该前端模组尚无说明。",
        preview: module.preview === "search" || module.preview === "tree" || module.preview === "chat"
          || module.preview === "document" || module.preview === "form" || module.preview === "board"
          || module.preview === "slides" || module.preview === "detail" || module.preview === "status"
          ? module.preview
          : "panel",
        configKeys: module.configKeys ?? [],
        source: { path: module.source?.path ?? "", line: module.source?.line ?? 0 },
      })),
      contracts: (atlas.moduleEcosystem?.contracts ?? []).map((contract) => ({
        id: contract.id ?? "",
        ...(contract.packageId ? { packageId: contract.packageId } : {}),
        ...(contract.packagePath ? { packagePath: contract.packagePath } : {}),
        summary: contract.summary ?? "该 typed contract 尚无说明。",
        actions: (contract.actions ?? []).map((action) => ({
          id: action.id ?? "",
          summary: action.summary ?? "该动作尚无说明。",
          ...(action.operation ? { operation: action.operation } : {}),
        })),
        ...sourceOf(contract.source),
        provision: contract.provision === "trusted-provider" ? "trusted-provider" : "app-or-host",
      })),
      backend: (atlas.moduleEcosystem?.backend ?? []).map((module) => ({
        id: module.id ?? "",
        name: module.name ?? "",
        summary: module.summary ?? "该 Provider 尚无说明。",
        packageId: module.packageId ?? "",
        path: module.path ?? "",
        files: module.files ?? 0,
        loc: module.loc ?? 0,
        kind: "provider" as const,
        contracts: module.contracts ?? [],
        actions: (module.actions ?? []).map((action) => ({
          id: action.id ?? "",
          summary: action.summary ?? "该动作尚无说明。",
          ...(action.operation ? { operation: action.operation } : {}),
        })),
        registered: Boolean(module.registered),
        dependencies: module.dependencies ?? [],
        source: { path: module.source?.path ?? module.path ?? "", line: module.source?.line ?? 0 },
      })),
      dependencies: (atlas.moduleEcosystem?.dependencies ?? []).map((edge) => ({
        from: edge.from ?? "",
        to: edge.to ?? "",
        kind: edge.kind === "provides" ? "provides" : edge.kind === "provider" ? "provider" : "requires",
        label: edge.label ?? "",
      })),
      issues: (atlas.moduleEcosystem?.issues ?? []).map((issue) => ({
        message: issue.message ?? "",
        ...sourceOf(issue.source),
      })),
    },
    flows: (atlas.flows ?? []).map((flow) => ({
      id: flow.id ?? "",
      title: flow.title ?? "",
      description: flow.description ?? "",
      perspective: flow.perspective ?? "",
      ...(flow.coverage
        ? {
            coverage: {
              mode: flow.coverage.mode ?? "",
              scope: flow.coverage.scope ?? "",
              exclusions: flow.coverage.exclusions ?? [],
            },
          }
        : {}),
      steps: (flow.steps ?? []).map((step) => ({
        id: step.id ?? "",
        label: step.label ?? "",
        ...(step.description ? { description: step.description } : {}),
        zone: step.zone ?? "",
        after: step.after ?? [],
        ...(step.role ? { role: step.role } : {}),
        ...(step.condition ? { condition: step.condition } : {}),
        ...(step.outcome ? { outcome: step.outcome } : {}),
        ...(step.authority ? { authority: step.authority } : {}),
        ...(step.terminal ? { terminal: true } : {}),
        ...sourceOf(step.source),
      })),
    })),
    constraints: (atlas.constraints ?? []).map((constraint) => ({
      id: constraint.id ?? "",
      title: constraint.title ?? "",
      description: constraint.description ?? "",
      concern: constraint.concern ?? "",
      severity: constraint.severity ?? "",
      status: constraint.status ?? "unknown",
      mechanismKind: constraint.mechanism?.kind ?? null,
      ...(constraint.summary ? { summary: constraint.summary } : {}),
      violations: (constraint.violations ?? []).map((violation) => ({
        message: violation.message ?? "",
        ...sourceOf(violation.source),
      })),
      evidence: (constraint.evidence ?? []).map((reference) => ({
        grade: reference.grade ?? "",
        label: reference.label ?? "",
        ...sourceOf(reference.source),
      })),
    })),
    findings: (atlas.findings ?? []).map((finding) => ({
      signal: finding.signal ?? "",
      severity: finding.severity ?? "",
      // The model splits headline and detail; the DTO carries one sentence.
      message: [finding.title, finding.description].filter(Boolean).join(" — "),
      moduleIds: finding.moduleIds ?? [],
      ...sourceOf(finding.source),
    })),
    tcb: tcbFact
      ? {
          label: tcbFact.constraintId ?? "",
          lines: tcbFact.total ?? 0,
          baseline: tcbFact.baseline ?? 0,
          tolerance: tcbFact.tolerance ?? 0,
          files: (tcbFact.files ?? []).flatMap((file) =>
            file.path ? [{ path: file.path, loc: file.codeLoc ?? 0 }] : [],
          ),
          unregistered: tcbFact.unregistered ?? [],
          stale: tcbFact.stale ?? [],
        }
      : null,
    hotspots,
  };
}

function sourceOf(source: AtlasSource | undefined): { source?: { path: string; line: number } } {
  return source?.path ? { source: { path: source.path, line: source.line ?? 0 } } : {};
}

function tail(text: string): string {
  return text.length > LOG_TAIL_BYTES ? text.slice(-LOG_TAIL_BYTES) : text;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
