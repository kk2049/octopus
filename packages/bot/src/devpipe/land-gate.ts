/**
 * The THIN pre-land gate (delivery 2026-08-11-land-thin-gate).
 *
 * ── What it is ─────────────────────────────────────────────────────────────
 *
 * One typecheck, run by the PIPELINE against the exact tree a landing is about
 * to fast-forward the base branch to, shared by both landing doors (the ticket
 * lane's `toolSubmit` and the human lane's `land()` / POST /api/land):
 *
 *   1. `pnpm install --frozen-lockfile --prefer-offline` — materialises the
 *      candidate's dependencies AND is the stale-lockfile check (a historical
 *      CI-red class: package.json changed, pnpm-lock.yaml did not).
 *   2. build the few workspace deps whose TYPES resolve into gitignored
 *      `dist/` (discovered from the candidate's own manifests — currently
 *      `@claude-bot/runner` and `@claude-bot/plugin-sessions`; everything else
 *      exports types from `src/` and needs no build to typecheck).
 *   3. `tsc --noEmit --incremental -p packages/bot` with the tsbuildinfo kept
 *      OUTSIDE any worktree, so the check stays warm across landings.
 *
 * The base gate is deliberately not a test run: no vitest, no browser, no build of the
 * deployable. The post-submit batched GitLab CI remains the complete verdict;
 * this gate only keeps the tsc-class regressions (the measured majority of
 * "Fix CI red" chains) from reaching the watermark at all. A refusal here is a
 * GATE refusal, not a CI result, and the messages say so.
 *
 * ── The one exception: a CI repair ticket's own roster (ticket #219) ───────
 *
 * "No vitest" is right for a general landing and wrong for exactly one lane.
 * A repair ticket exists BECAUSE named spec files went red, and until this it
 * could land a guess about them for free — the cost landed on the next batch,
 * 20-45 minutes later, at which point the same conversation guessed again
 * (measured: `v4` 1c9928c..716ad3f, seven landings on one failure). So when
 * the candidate belongs to that lane, the gate appends ONE more step: run the
 * roster CI named, in the same staging tree, and refuse the landing if it is
 * still red. This is not a second opinion about the suite — it is the ticket's
 * own acceptance criterion, checked before it can spend a batch asking.
 *
 * Bounded so a repair can never hold the merge lock indefinitely: the roster
 * step gets its own budget on top of the base deadline, the file count is
 * capped (`ci-roster.ts`), and — as everywhere else here — a timeout refuses.
 *
 * ── What this gate CANNOT prove (measured, ticket #226) ───────────────────
 *
 * It runs the roster in ISOLATION, and CI does not: `.gitlab-ci.yml` runs the
 * suite in batches of 40 files per long-lived process. A test that fails only
 * because of process-global state another file left behind therefore passes
 * here and stays red there. That is not hypothetical — `bootstrap-v3.test.ts`
 * at 84968e4 passes alone (11/11, verified in the CI container) and fails in
 * its batch, which is exactly why three consecutive repair tickets "fixed" it
 * three times without ever seeing the failure.
 *
 * So a green roster means "the named files pass on their own", never "CI will
 * agree". The prompt says the same thing to the agent, because an agent that
 * reads a green here as proof will keep shipping fixture edits. Closing this
 * properly means running the file's BATCH, which is why the repair lane has a
 * machine with the whole suite warm on it.
 *
 * ── The second exception: the landing's own changed tests (2026-08-17) ─────
 *
 * Measured over the red batches of 2026-08-17: in 8 of 11, the failing spec
 * file had been MODIFIED inside that batch's own landing window, and 2 more
 * had their sibling source file modified — i.e. the dominant red class was
 * "a landing shipped a test (or its subject) that was never run". tsc cannot
 * see that, and the repair roster only exists after the batch has already
 * been spent. So every landing (both doors) now also runs the spec files its
 * own diff touched: files matching `*.test.*` in the diff, plus the sibling
 * `X.test.ts(x)` of every changed source `X.ts(x)` that has one. That set is
 * usually 0-3 files and shares the roster step's build, budget and cap; the
 * refusal (`changed_tests`) is a gate verdict about the landing's own diff,
 * not a CI verdict. Cross-module drift (a changed default breaking a spec
 * far away) is out of scope on purpose — that stays with the batched CI.
 *
 * ── Where it runs, and the invariant it depends on ─────────────────────────
 *
 * The check runs in the `_land` staging worktree parked at the candidate sha.
 * Both doors land with `merge --ff-only`, so the candidate TIP IS the tree the
 * base branch will point at:
 *
 *   · human lane: `land()` requires base to be an ancestor of the branch and
 *     re-reads base under the git lock before the ff (`base_moved` refusal),
 *     so a pass at `head` is a pass of the exact post-landing tree;
 *   · ticket lane: `toolSubmit` rebases onto the base tip while HOLDING the
 *     merge lock, pins `sha0`, gates, then ffs to `sha0` — a human landing
 *     that sneaks in between surfaces as the existing `base_moved` refusal.
 *
 * `_land` is stable on purpose: one absolute path means one warm incremental
 * cache for every landing (measured on this 2-core box, 2026-08-11: no-op
 * frozen install ≈3s, dist-typed deps build ≈15s, warm incremental tsc ≈8s;
 * cold tsc under load was measured at ~4 min, hence the generous timeout).
 * `ensureDetachedWorktree` re-parks with `checkout --force` + `clean -fd`
 * (no `-x`), so `node_modules`/`dist`/caches survive between landings.
 *
 * ── Concurrency ────────────────────────────────────────────────────────────
 *
 * `withLandWorktree` serialises ALL `_land` use through one promise chain —
 * the human lane's named tests and both lanes' gate checks — so one lane can
 * never re-park the worktree under a check the other lane is still running.
 * Lock order is acyclic: the ticket lane holds the merge lock when it enters
 * this chain, the human lane holds only its own `landing` flag, and neither
 * holds the repo git-ops lock here (the ff takes it AFTER the gate returns).
 * A slow check therefore delays other LANDINGS only, never coding turns, and
 * every hold is bounded by the step timeouts below.
 *
 * ── The machine (2026-08-21) ───────────────────────────────────────────────
 *
 * The step list above is the contract; the host that runs it is not. When the
 * composition root hands the gate a `remote` opener (the lht-val15 CI
 * container's Runner, `remote-gate.ts`), `check` syncs the candidate sha into
 * the machine's pipeline-owned `<work>/land` worktree and runs every step
 * there, polling detached processes so the Runner's per-call ceiling never
 * decides a verdict. `_land` on this node is still parked at the sha — it is
 * the serialisation point between the two doors and the tree the sync is
 * bundled from — and it is the fallback: no Runner, a failed sync or a machine
 * that stops answering mid-run all mean the same list runs here, never a pass.
 * Measured 2026-08-21 under load: tsc 30–47 s here vs 8 s warm there; the
 * knowledge regression tests 147–234 s here vs ~10 s there.
 *
 * Since the same date the tests a landing NAMES (`devpipe_submit`'s `tests`,
 * `land.sh --test`) are steps of this gate too (`named_tests`), instead of a
 * second install/build/tsc in the ticket's own worktree. True-browser specs
 * are always excluded from this synchronous path, including project-wide
 * named runs; they belong only to post-submit CI. One tree, one
 * install, one typecheck, one build, then every vitest the landing owes.
 *
 * ── Escape hatches ─────────────────────────────────────────────────────────
 *
 *   · `selfhosting.land_gate: false` turns the check off (both doors).
 *   · `selfhosting.ci_machine.gate: false` keeps the check but runs it here.
 *   · `OPS_LAND_LOCAL=1` in scripts/ops/land.sh bypasses the deployed
 *     machinery entirely — including this gate, by construction. That path
 *     exists precisely for when the deployed pipeline is broken.
 *   · Timeout (default 8 min) REFUSES rather than passes: a gate that cannot
 *     finish has not checked anything.
 */

import path from "node:path";
import * as fs from "node:fs/promises";
import { runChild, stepLogTail, tailBytesFor } from "./child-output.js";
import { ensureDetachedWorktree, git, gitOrThrow } from "./worktree.js";
import { createLogger } from "../logger.js";
import { RemoteGateUnavailable, type RemoteGateOpener, type RemoteGateSession } from "./remote-gate.js";
import type { AppTicketScope } from "./app-scopes.js";
import { CI_ROSTER_GATE_MAX_FILES, rosterGateFiles, type RosterGateSelection } from "./ci-roster.js";

const log = createLogger("land-gate");

/** Refuse-on-timeout budget for the whole check (install + build + tsc). */
export const LAND_GATE_TIMEOUT_MS = 8 * 60_000;
/**
 * Extra budget granted only when a CI repair roster is present.
 *
 * On top of the base deadline rather than inside it, so adding the roster step
 * cannot make the install/tsc steps time out. It bounds a merge-lock hold, so
 * it is deliberately smaller than the batch it replaces: 45 minutes of CI to
 * learn "still red" becomes at most 20 here, and usually a couple of minutes —
 * `_land` keeps its node_modules, the workspace build is mostly cache restores,
 * and the roster is a handful of files. It covers the build too, because since
 * ticket #226 the roster runs after the same `pnpm -r build` CI runs.
 */
export const LAND_GATE_ROSTER_BUDGET_MS = 20 * 60_000;
/** Same bound the ticket gates use for the log tail handed back to callers. */
const LOG_TAIL = 4_000;
/** Ceiling on the pinned "what the roster step ran" preamble. */
const ROSTER_NOTE_MAX = 1_200;

export type LandGateRefusal =
  | "lockfile"
  | "deps_build"
  | "typecheck"
  | "named_tests"
  | "roster"
  | "changed_tests"
  | "knowledge_tests"
  | "timeout"
  | "remote_unavailable"
  | "remote_unknown";

export type LandGateOutcome =
  | { ok: true; log: string }
  | { ok: false; refusal: LandGateRefusal; log: string };

export interface LandGateStep {
  /** Which refusal a failure of this step is reported as. */
  id: Exclude<LandGateRefusal, "timeout" | "remote_unavailable" | "remote_unknown">;
  bin: string;
  args: string[];
}

/** What a single `check()` is being asked to prove, beyond the base steps. */
export interface LandGateCandidate {
  /**
   * The CI failure roster this landing must make green, or empty/absent for
   * every ordinary landing. Repo-relative spec paths.
   */
  roster?: readonly string[];
  /**
   * Every path the landing's own diff touches (base..candidate, repo-relative).
   * The gate derives the spec files it must run from this — see
   * `candidateTestFiles`. Absent/empty = the step is skipped, not refused: a
   * caller that cannot compute its diff has not proven anything wrong.
   */
  changedFiles?: readonly string[];
  /** Executable evidence attached to matched active knowledge constraints. */
  requiredTests?: readonly string[];
  /**
   * The tests this landing NAMED (`devpipe_submit` `tests`, `land.sh --test`):
   * `project:<vitest project>` or repo-relative paths. Run after the workspace
   * build, before the roster/diff files; a red refuses as `named_tests`.
   */
  namedTests?: readonly string[];
  /**
   * The App an app ticket's landing was trimmed to (its path allowlist was
   * enforced before any step ran). Informational: the gate runs what was
   * named, not what the scope implies; it travels so an App-aware step could
   * trim by it and so the record says which App the run belonged to.
   */
  appScope?: AppTicketScope | null;
}

export interface LandGateOpts {
  repoDir: string;
  /** Parent of `_land` and of the `_land-gate-cache` dir (NOT a worktree). */
  worktreesDir: string;
  /** Default true (`selfhosting.land_gate`). */
  enabled?: boolean;
  /**
   * Run a CI repair ticket's roster before letting it land (default true,
   * `selfhosting.ci_roster_gate`). Separate from `enabled` so an operator can
   * drop the vitest step — the one that costs minutes — without also losing
   * the typecheck that every landing depends on.
   */
  rosterGateEnabled?: boolean;
  /**
   * Run the spec files a landing's own diff touched (default true,
   * `selfhosting.changed_tests_gate`). Separate switch for the same reason as
   * `rosterGateEnabled`: it is the other place the gate runs vitest, and an
   * operator may need to shed the minutes without losing the typecheck.
   */
  changedTestsGateEnabled?: boolean;
  timeoutMs?: number;
  rosterBudgetMs?: number;
  /** Test hook: replaces the real steps (discovery + install/build/tsc). */
  stepsFor?: (dir: string, cacheDir: string) => Promise<ReadonlyArray<LandGateStep>>;
  /** Test hook: replaces the roster command (a temp fixture has no vitest). */
  rosterStepFor?: (files: readonly string[]) => LandGateStep;
  /** Test hook: replaces the pre-roster workspace build. */
  rosterBuildFor?: () => LandGateStep;
  /** Test hook: replaces the named-test commands (a temp fixture has no vitest). */
  namedStepsFor?: (tests: readonly string[], excludedBrowserTests: readonly string[]) => LandGateStep[];
  /** Test hook: replaces `check` wholesale (worktree parking still real). */
  check?: (dir: string, candidate?: LandGateCandidate) => Promise<LandGateOutcome>;
  /**
   * Opens a session on the CI machine for one check (`remote-gate.ts`), or
   * returns null to run here. Absent = always here.
   */
  remote?: RemoteGateOpener;
  /** The control host must never execute or replay remote gate steps. */
  remoteRequired?: boolean;
}

/**
 * The roster step's command.
 *
 * Same invocation shape as `.gitlab-ci.yml` uses for the batched suite — root
 * `vitest run` with explicit repo-relative paths and one worker — so a file
 * lands in whichever project's `include` claims it and the result means the
 * same thing here as it does there. `--no-file-parallelism` matters on this
 * two-core box: the resource-starvation failures the CI triage runbook warns
 * about are indistinguishable from real ones in a gate log.
 */
export function rosterStep(files: readonly string[]): LandGateStep {
  return {
    id: "roster",
    bin: "npx",
    args: ["vitest", "run", "--maxWorkers=1", "--no-file-parallelism", "--reporter=default", ...files],
  };
}

/**
 * The named tests as gate steps: one `vitest run --project` per project, one
 * path run for all paths — the same shapes `gates.ts` used when these ran in
 * the ticket worktree, so `project:x` and path filters never share one
 * invocation (combining them can filter a project to zero tests and read as a
 * pass). Unknown shapes are not guessed at.
 */
export function namedTestSteps(tests: readonly string[], excludedBrowserTests: readonly string[] = []): LandGateStep[] {
  const projects: string[] = [];
  const paths: string[] = [];
  for (const raw of tests) {
    const spec = raw.trim();
    if (!spec) continue;
    if (spec.startsWith("project:")) projects.push(spec.slice("project:".length));
    else paths.push(spec);
  }
  const steps: LandGateStep[] = projects.map((project) => ({
    id: "named_tests",
    bin: "npx",
    args: [
      "vitest", "run", "--project", project, "--maxWorkers=1",
      ...excludedBrowserTests.flatMap((file) => ["--exclude", file]),
    ],
  }));
  if (paths.length) {
    steps.push({
      id: "named_tests",
      bin: "npx",
      args: [
        "vitest", "run", "--maxWorkers=1", "--no-file-parallelism",
        ...excludedBrowserTests.flatMap((file) => ["--exclude", file]),
        ...paths,
      ],
    });
  }
  return steps;
}

/**
 * The build the roster step needs, and the reason it is not the thin gate's
 * usual `deps_build`.
 *
 * `defaultStepsFor` builds only the workspace deps whose TYPES resolve through
 * `dist/`, because typechecking is all it ever had to support. Running TESTS is
 * a different requirement: several suites assert over BUILT View assets — the
 * Session Plus identity digest is computed from them — and those assets are
 * gitignored, so a fresh `_land` checkout simply does not have them.
 *
 * Measured on the first real repair this gate ever refused (ticket #226, batch
 * 49454): the agent reproduced the named failure, fixed it, saw 11/11 green in
 * its own worktree AND in the CI container, and was refused here — by three
 * source-digest failures that exist nowhere else. It then started rewriting
 * those tests to satisfy the harness, which is precisely the behaviour this
 * whole lane was built to stop. A gate that reports failures CI would not
 * report is worse than no gate: it teaches the agent to fit the gate.
 *
 * So the roster runs after the same build CI runs. It is normally cheap —
 * `tools/build-cache` restores byte-exact outputs and every landing already
 * warms the cache for its sha (`build-warm.ts`) — and when it is not, the
 * budget below is what bounds it.
 */
export function rosterBuildStep(): LandGateStep {
  return { id: "deps_build", bin: "pnpm", args: ["-r", "build"] };
}

/** Same spec-file shape the CI trace digest recognises. */
const TEST_FILE_RE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const TRUE_BROWSER_IMPORT_RE = /["'](?:@playwright\/test|playwright(?:-core)?|puppeteer(?:-core)?|cypress)["']|(?:chromium|firefox|webkit|puppeteer)\.launch\s*\(/;

/**
 * Discover specs that launch/control a real browser. Synchronous landing and
 * deployment gates must never execute these: the shared production node and
 * merge lock cannot safely absorb browser CPU or browser-process hangs.
 */
export async function trueBrowserTestFiles(dir: string): Promise<string[]> {
  let files: string[] = [];
  try {
    files = (await gitOrThrow(dir, ["ls-files"]))
      .split("\n")
      .filter((file) => TEST_FILE_RE.test(file));
  } catch {
    // Unit-test fixtures need not be git repositories. Keep this fallback
    // bounded by skipping dependency/build/VCS trees.
    const walk = async (relative = ""): Promise<void> => {
      for (const entry of await fs.readdir(path.join(dir, relative), { withFileTypes: true })) {
        if (entry.isDirectory() && [".git", "node_modules", "dist", "coverage"].includes(entry.name)) continue;
        const child = path.join(relative, entry.name);
        if (entry.isDirectory()) await walk(child);
        else if (TEST_FILE_RE.test(child)) files.push(child);
      }
    };
    await walk();
  }
  const browser: string[] = [];
  for (const file of files) {
    try {
      if (TRUE_BROWSER_IMPORT_RE.test(await fs.readFile(path.join(dir, file), "utf8"))) browser.push(file);
    } catch {
      // Deleted/unreadable candidates cannot be executed by the gate anyway.
    }
  }
  return [...new Set(browser)].sort();
}

/**
 * The spec files a diff makes suspect, in diff order, deduplicated:
 * test files the diff touched directly, plus the sibling `X.test.ts(x)` of
 * every changed source `X.ts(x)`. Pure — existence is the async selector's
 * job — so the naming rule itself is unit-testable.
 */
export function candidateTestFiles(changed: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    out.push(file);
  };
  for (const file of changed) {
    if (TEST_FILE_RE.test(file)) {
      add(file);
      continue;
    }
    const source = /^(.*)\.[cm]?[jt]sx?$/.exec(file);
    if (!source) continue;
    add(`${source[1]}.test.ts`);
    add(`${source[1]}.test.tsx`);
  }
  return out;
}

/**
 * Which of the diff's candidate spec files the gate will actually run:
 * present in the candidate tree, not already covered by the roster run, and
 * inside what remains of the shared file cap. Overflow is reported, never
 * silently dropped — same contract as `rosterGateFiles`.
 */
export async function selectChangedTestFiles(
  dir: string,
  changed: readonly string[],
  alreadyRunning: readonly string[],
  excluded: readonly string[] = [],
): Promise<{ files: string[]; overflow: string[] }> {
  const skip = new Set(alreadyRunning);
  const excludedSet = new Set(excluded);
  const present: string[] = [];
  for (const file of candidateTestFiles(changed)) {
    if (skip.has(file) || excludedSet.has(file)) continue;
    try {
      await fs.access(path.join(dir, file));
      present.push(file);
    } catch {
      // a sibling that does not exist, or a test the diff deleted
    }
  }
  const room = Math.max(0, CI_ROSTER_GATE_MAX_FILES - alreadyRunning.length);
  return { files: present.slice(0, room), overflow: present.slice(room) };
}

/** Which roster files exist in the candidate tree (the gate runs only those). */
export async function selectRosterFiles(dir: string, roster: readonly string[]): Promise<RosterGateSelection> {
  const present = new Set<string>();
  await Promise.all(
    roster.map(async (file) => {
      try {
        await fs.access(path.join(dir, file));
        present.add(file);
      } catch {
        // renamed or deleted by the fix; reported, not run
      }
    }),
  );
  return rosterGateFiles(roster, (file) => present.has(file));
}

/**
 * Workspace deps of packages/bot whose export surface points into `dist/` —
 * the only packages that must be BUILT before `tsc -p packages/bot` can see
 * their types (verified empirically 2026-08-11: a fresh worktree with install
 * but no build fails typecheck ONLY on `@claude-bot/runner/*` and
 * `@claude-bot/plugin-sessions/*` subpaths). Discovered from the candidate's
 * own manifests rather than hardcoded, so the set follows the repo; the
 * directory groups mirror pnpm-workspace.yaml (`packages/*`, `plugins/*`).
 * Discovery failures degrade to "build nothing" — tsc then reports any gap as
 * a visible TS2307 in the refusal tail, never as a silent pass.
 */
export async function distTypedWorkspaceDeps(dir: string): Promise<string[]> {
  const bot = JSON.parse(await fs.readFile(path.join(dir, "packages", "bot", "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const wanted = new Set([...Object.keys(bot.dependencies ?? {}), ...Object.keys(bot.devDependencies ?? {})]);
  const found: string[] = [];
  for (const group of ["packages", "plugins"]) {
    let entries: string[];
    try {
      entries = await fs.readdir(path.join(dir, group));
    } catch {
      continue; // group dir absent in this tree
    }
    for (const entry of entries) {
      let manifest: { name?: string; exports?: unknown; types?: unknown; main?: unknown };
      try {
        manifest = JSON.parse(await fs.readFile(path.join(dir, group, entry, "package.json"), "utf8")) as typeof manifest;
      } catch {
        continue; // not a package
      }
      if (!manifest.name || !wanted.has(manifest.name)) continue;
      const surface = JSON.stringify(manifest.exports ?? manifest.types ?? manifest.main ?? "");
      if (surface.includes("dist/")) found.push(manifest.name);
    }
  }
  return found.sort();
}

async function defaultStepsFor(dir: string, cacheDir: string): Promise<ReadonlyArray<LandGateStep>> {
  const steps: LandGateStep[] = [
    { id: "lockfile", bin: "pnpm", args: ["install", "--frozen-lockfile", "--prefer-offline"] },
  ];
  let distDeps: string[] = [];
  try {
    distDeps = await distTypedWorkspaceDeps(dir);
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "land gate: dist-typed dep discovery failed; tsc will surface any gap");
  }
  if (distDeps.length) {
    steps.push({ id: "deps_build", bin: "pnpm", args: [...distDeps.flatMap((n) => ["--filter", n]), "run", "build"] });
  }
  steps.push({
    id: "typecheck",
    bin: "npx",
    args: [
      "tsc",
      "--noEmit",
      "--incremental",
      "--tsBuildInfoFile",
      path.join(cacheDir, "bot.tsbuildinfo"),
      "-p",
      "packages/bot/tsconfig.json",
    ],
  });
  return steps;
}

/**
 * One landing-gate step. The verdict is the command's exit status and the
 * gate's own timeout (`timedOut` = this gate killed it); output of any volume
 * is kept as a bounded tail and can no longer fail a step on its own.
 */
async function execStep(
  step: LandGateStep,
  cwd: string,
  timeoutMs: number,
): Promise<{ ok: boolean; timedOut: boolean; log: string }> {
  // Honor the candidate packageManager pin even on machines with another global pnpm.
  const bin = step.bin === "pnpm" ? "corepack" : step.bin;
  const args = step.bin === "pnpm" ? ["pnpm", ...step.args] : step.args;
  const run = await runChild(bin, args, { cwd, timeoutMs, killSignal: "SIGKILL", tailBytes: tailBytesFor(LOG_TAIL) });
  return {
    ok: !run.error,
    timedOut: Boolean(run.error?.killed),
    log: `$ ${step.bin} ${step.args.join(" ")}\n${stepLogTail(run, LOG_TAIL)}`,
  };
}

/** The refusal text both doors show. Honest about being a gate, not CI. */
export function landGateRefusalMessage(refusal: LandGateRefusal, baseBranch: string, timeoutMs = LAND_GATE_TIMEOUT_MS): string {
  switch (refusal) {
    case "remote_unavailable":
      return `落地门禁:必需的远端执行机不可用，未获得门禁结论。${baseBranch} 未改动。恢复设备后再显式提交。`;
    case "remote_unknown":
      return `落地门禁:远端执行状态未确认。${baseBranch} 未改动。先按日志核实原 run 的回执与工作区锁，禁止自动重播；这不是测试红灯。`;
    case "lockfile":
      return (
        `落地门禁:候选树上 pnpm install --frozen-lockfile 失败——package.json 与 pnpm-lock.yaml 不一致(历史 CI 红类之一)。` +
        `改依赖时请把 pnpm-lock.yaml 一起提交,然后重新落地。${baseBranch} 未改动。`
      );
    case "deps_build":
      return `落地门禁:候选树上 dist 类型依赖(runner / plugin-sessions 一类)构建失败,tsc 无法进行。${baseBranch} 未改动。`;
    case "named_tests":
      return `落地门禁:你点名的测试在候选树上未通过,拒绝落地。${baseBranch} 未改动。`;
    case "typecheck":
      return (
        `落地门禁:增量 tsc(packages/bot)在候选树上报了类型错误,拒绝落地。` +
        `这是薄门禁的拒绝,不是完整 CI 的结论(后台批次照常);修掉类型错误、commit,再重新落地。${baseBranch} 未改动。`
      );
    case "changed_tests":
      return (
        `落地门禁:本次落地的 diff 改动了若干测试文件(或它们对应的源文件),而这些测试在候选树上是红的,拒绝落地。${baseBranch} 未改动。\n` +
        `这是门禁对你自己 diff 的判定,不是完整 CI 的结论(后台批次照常)。门禁日志点名了失败文件;在本票 worktree 里跑\n` +
        `npx vitest run --maxWorkers=1 --no-file-parallelism <失败文件…>\n` +
        `看着它变绿,再 commit 并重新落地。不要为了过门禁放宽断言迁就错误行为。`
      );
    case "knowledge_tests":
      return (
        `落地门禁:本次改动命中了现行架构/回归约束,其声明的证据测试缺失、超限或仍为红色,拒绝落地。${baseBranch} 未改动。\n`
        + "日志列出知识记录要求的测试。先确认约束仍适用并修复行为；若约束已经失效，必须修改其权威来源或让用户裁决，不能静默跳过。"
      );
    case "roster":
      return (
        `落地门禁:本票是 CI 修复票,而它要负责的失败文件在候选树上**仍然是红的**,拒绝落地。${baseBranch} 未改动。\n` +
        `这一步阻止把全量 CI 当成逐行调试器:同一份失败先在本机跑绿,再 commit + devpipe_submit。` +
        `submit 后流水线会立即触发完整 CI 作为本票的收尾门禁;若仍红,同一个 ticket/session 自动收到完整清单并继续修。` +
        `如果你判断这批红灯是过期批次(失败 sha 是你已修内容的祖先)或属于基础设施故障,不要绕过门禁或制造提交,` +
        `在回复里说明;后续全量绿灯会自动关闭本票。`
      );
    case "timeout":
      return (
        `落地门禁:${Math.round(timeoutMs / 60_000)} 分钟内没跑完,按拒绝处理(超时不放行)。${baseBranch} 未改动。` +
        `确认机器负载后重试;门禁本身有问题时,selfhosting.land_gate: false 可关闭,OPS_LAND_LOCAL=1 走本地回退路径。`
      );
  }
}

export class LandGate {
  readonly enabled: boolean;
  readonly rosterGateEnabled: boolean;
  readonly changedTestsGateEnabled: boolean;
  private readonly repoDir: string;
  private readonly worktreesDir: string;
  private readonly timeoutMs: number;
  private readonly rosterBudgetMs: number;
  private readonly stepsFor: (dir: string, cacheDir: string) => Promise<ReadonlyArray<LandGateStep>>;
  private readonly rosterStepFor: (files: readonly string[]) => LandGateStep;
  private readonly rosterBuildFor: () => LandGateStep;
  private readonly namedStepsFor: (tests: readonly string[], excludedBrowserTests: readonly string[]) => LandGateStep[];
  private readonly checkFn: ((dir: string, candidate?: LandGateCandidate) => Promise<LandGateOutcome>) | null;
  private readonly remote: RemoteGateOpener | null;
  private readonly remoteRequired: boolean;
  /** Serialises every `_land` user across both landing doors (see header). */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(opts: LandGateOpts) {
    this.repoDir = opts.repoDir;
    this.worktreesDir = opts.worktreesDir;
    this.enabled = opts.enabled ?? true;
    this.rosterGateEnabled = opts.rosterGateEnabled ?? true;
    this.changedTestsGateEnabled = opts.changedTestsGateEnabled ?? true;
    this.timeoutMs = opts.timeoutMs ?? LAND_GATE_TIMEOUT_MS;
    this.rosterBudgetMs = opts.rosterBudgetMs ?? LAND_GATE_ROSTER_BUDGET_MS;
    this.stepsFor = opts.stepsFor ?? defaultStepsFor;
    this.rosterStepFor = opts.rosterStepFor ?? rosterStep;
    this.rosterBuildFor = opts.rosterBuildFor ?? rosterBuildStep;
    this.namedStepsFor = opts.namedStepsFor ?? namedTestSteps;
    this.checkFn = opts.check ?? null;
    this.remote = opts.remote ?? null;
    this.remoteRequired = opts.remoteRequired === true;
  }

  /** The `_land` staging worktree — landing machinery's, not any ticket's. */
  landDir(): string {
    return path.join(this.worktreesDir, "_land");
  }

  /**
   * Park `_land` at `sha` and run `fn` there, serialised with every other
   * `_land` user. Same promise-chain shape as the pipeline's `withGitLock`;
   * a prior failure must not poison the chain.
   */
  async withLandWorktree<T>(sha: string, fn: (dir: string) => Promise<T>): Promise<T> {
    const work = async (): Promise<T> => {
      await fs.mkdir(this.worktreesDir, { recursive: true });
      const dir = await ensureDetachedWorktree(this.repoDir, this.landDir(), sha);
      return await fn(dir);
    };
    const run = this.chain.then(work, work);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Drop the parked `_land` checkout and the local step cache, after any check
   * still running; the next check rebuilds both cold. Never removes
   * `worktreesDir` itself — in the pipeline that is the shared parent.
   */
  async discard(): Promise<void> {
    const work = async (): Promise<void> => {
      if (!(await git(this.repoDir, ["worktree", "remove", "--force", this.landDir()])).ok) {
        await fs.rm(this.landDir(), { recursive: true, force: true });
        await git(this.repoDir, ["worktree", "prune"]);
      }
      await fs.rm(path.join(this.worktreesDir, "_land-gate-cache"), { recursive: true, force: true });
    };
    const run = this.chain.then(work, work);
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * The check itself: frozen install → dist-typed dep builds → incremental
   * tsc — and, for a CI repair candidate, its own failure roster — under one
   * refuse-on-timeout deadline. Call inside `withLandWorktree` (the caller
   * decides which sha is the candidate). Logs are bounded and have the staging
   * path rewritten out, per the ticket-gate conventions.
   */
  async check(dir: string, candidate?: LandGateCandidate): Promise<LandGateOutcome> {
    if (this.checkFn) return await this.checkFn(dir, candidate);
    const session = this.remote?.() ?? null;
    if (!session && this.remoteRequired) {
      return { ok: false, refusal: "remote_unavailable", log: "Required remote gate unavailable; no local steps executed." };
    }
    if (session) {
      try {
        const sha = await gitOrThrow(dir, ["rev-parse", "HEAD"]);
        const syncStarted = Date.now();
        const synced = await session.sync(dir, sha);
        log.info(
          { device: session.device, ok: synced.ok, ms: Date.now() - syncStarted, detail: synced.detail.slice(-200) },
          "land gate: candidate synced to the CI machine",
        );
        if (synced.ok) {
          try {
            return await this.runSteps(dir, candidate, session);
          } catch (err) {
            if (!(err instanceof RemoteGateUnavailable)) throw err;
            if (this.remoteRequired) return { ok: false, refusal: err.kind === "offline" ? "remote_unavailable" : "remote_unknown", log: err.message };
            log.warn({ device: session.device, err: err.message }, "land gate: CI machine stopped answering; rerunning the same steps here");
          }
        } else {
          if (this.remoteRequired) return { ok: false, refusal: synced.refusal ?? "remote_unknown", log: synced.detail };
          log.warn({ device: session.device, detail: synced.detail }, "land gate: CI machine sync failed; running here");
        }
      } catch (err) {
        if (this.remoteRequired) return { ok: false, refusal: err instanceof RemoteGateUnavailable && err.kind === "offline" ? "remote_unavailable" : "remote_unknown", log: err instanceof Error ? err.message : String(err) };
        log.warn({ device: session.device, err: err instanceof Error ? err.message : String(err) }, "land gate: CI machine unusable; running here");
      } finally {
        await session.close();
      }
    }
    return await this.runSteps(dir, candidate, null);
  }

  /**
   * The step list, run where `session` says: on the machine's landing
   * workspace, or in `dir` here. Discovery (which deps are dist-typed, which
   * spec files exist) always reads the local tree — it is the same sha.
   */
  private async runSteps(dir: string, candidate: LandGateCandidate | undefined, session: RemoteGateSession | null): Promise<LandGateOutcome> {
    const cacheDir = session ? session.cacheDir : path.join(this.worktreesDir, "_land-gate-cache");
    if (!session) await fs.mkdir(cacheDir, { recursive: true });
    const where = session ? `# 门禁执行位置:${session.device}:${session.workspace}\n` : "";
    const logs: string[] = [];
    // The roster note is PINNED rather than pushed onto `logs`: a failing
    // vitest run easily exceeds LOG_TAIL, and a tail that drops "these three
    // files were skipped" turns a partial check into one that reads complete.
    let rosterNote = "";
    const bounded = (): string => {
      const all = logs.join("\n\n").split(dir).join(".");
      return where + rosterNote + (all.length > LOG_TAIL ? `…（更早的门禁日志未保留）\n${all.slice(-LOG_TAIL)}` : all);
    };

    const steps = [...(await this.stepsFor(dir, cacheDir))];
    let deadline = Date.now() + this.timeoutMs;
    const browserTests = await trueBrowserTestFiles(dir);
    const browserSet = new Set(browserTests);
    const normalizeSpec = (spec: string): string => spec.trim().replace(/^\.\//, "");
    const omittedBrowser = new Set<string>();
    const withoutBrowser = (specs: readonly string[]): string[] => specs.filter((raw) => {
      const spec = normalizeSpec(raw);
      if (!browserSet.has(spec)) return true;
      omittedBrowser.add(spec);
      return false;
    });
    const roster = this.rosterGateEnabled ? withoutBrowser(candidate?.roster ?? []) : [];
    const changed = this.changedTestsGateEnabled ? (candidate?.changedFiles ?? []) : [];
    const required = withoutBrowser(candidate?.requiredTests ?? []);
    const namedSpecs = withoutBrowser((candidate?.namedTests ?? []).map(normalizeSpec).filter(Boolean));
    for (const test of candidateTestFiles(changed)) {
      if (browserSet.has(test)) omittedBrowser.add(test);
    }
    if (omittedBrowser.size) {
      rosterNote = `# 真浏览器测试不在落地/上线门禁运行,移交 post-submit CI:${[...omittedBrowser].join(" ")}\n`;
    }
    let rosterBuild: LandGateStep | null = null;
    /** After this step passes, the diff/roster vitest step is constructed and queued. */
    let vitestAfter: LandGateStep | null = null;
    let vitestFiles: readonly string[] = [];
    // Roster dominates diff-derived tests; knowledge tests dominate ordinary
    // changed tests because they are an explicit historical regression guard.
    let vitestRefusal: "roster" | "changed_tests" | "knowledge_tests" = "roster";
    if (roster.length || changed.length || required.length) {
      const selection = roster.length
        ? await selectRosterFiles(dir, roster)
        : { files: [] as string[], missing: [] as string[], overflow: [] as string[] };
      const requiredSelection = required.length
        ? await selectRosterFiles(dir, required)
        : { files: [] as string[], missing: [] as string[], overflow: [] as string[] };
      const diffTests = changed.length
        ? await selectChangedTestFiles(dir, changed, [...selection.files, ...requiredSelection.files], browserTests)
        : { files: [] as string[], overflow: [] as string[] };
      const note: string[] = [];
      if (roster.length) {
        note.push(
          `# CI 修复票的失败清单(${roster.length} 个文件)\n`
            + `#   本次门禁执行:${selection.files.length ? selection.files.join(" ") : "(无)"}\n`
            + (selection.missing.length ? `#   候选树上已不存在(改名/删除,跳过):${selection.missing.join(" ")}\n` : "")
            + (selection.overflow.length ? `#   超出单次门禁上限,未执行:${selection.overflow.join(" ")}\n` : ""),
        );
      }
      if (required.length) {
        note.push(
          `# 命中知识约束的回归证据(${required.length} 个文件)\n`
            + `#   本次门禁执行:${requiredSelection.files.length ? requiredSelection.files.join(" ") : "(无)"}\n`
            + (requiredSelection.missing.length ? `#   候选树上不存在:${requiredSelection.missing.join(" ")}\n` : "")
            + (requiredSelection.overflow.length ? `#   超出单次门禁上限:${requiredSelection.overflow.join(" ")}\n` : ""),
        );
      }
      if (diffTests.files.length || diffTests.overflow.length) {
        note.push(
          `# 本次落地 diff 涉及的测试文件\n`
            + `#   本次门禁执行:${diffTests.files.length ? diffTests.files.join(" ") : "(无)"}\n`
            + (diffTests.overflow.length ? `#   超出单次门禁上限,未执行:${diffTests.overflow.join(" ")}\n` : ""),
        );
      }
      if (note.length) rosterNote = (rosterNote + note.join("")).slice(0, ROSTER_NOTE_MAX) + "\n";
      if (requiredSelection.missing.length || requiredSelection.overflow.length) {
        return { ok: false, refusal: "knowledge_tests", log: bounded() };
      }
      const files = [...selection.files, ...requiredSelection.files, ...diffTests.files];
      if (files.length) {
        vitestRefusal = roster.length ? "roster" : required.length ? "knowledge_tests" : "changed_tests";
        vitestFiles = files;
      }
    }
    if (namedSpecs.length || vitestFiles.length) {
      // Construct the vitest steps only after the build succeeds. Besides
      // preserving strict order, this prevents step factories from doing
      // observable work for a test result the gate must not believe.
      rosterBuild = this.rosterBuildFor();
      steps.push(rosterBuild);
      deadline += this.rosterBudgetMs;
    }

    for (const step of steps) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        logs.push(`$ ${step.bin} ${step.args.join(" ")}\n(未执行:门禁总预算已用尽)`);
        return { ok: false, refusal: "timeout", log: bounded() };
      }
      const started = Date.now();
      const r = session ? await session.run(step, remaining) : await execStep(step, dir, remaining);
      logs.push(r.log);
      log.info({ step: step.id, ok: r.ok, ms: Date.now() - started, where: session ? session.device : "local" }, "land gate step");
      if (!r.ok) {
        return { ok: false, refusal: r.timedOut ? "timeout" : step.id, log: bounded() };
      }
      // Build passed → the named tests run next; the diff/roster files only
      // after the last of those passed. Each vitest step is constructed just
      // before it is needed, never for a result the gate will not reach.
      if (step === rosterBuild) {
        const named = namedSpecs.length ? this.namedStepsFor(namedSpecs, browserTests) : [];
        steps.push(...named);
        vitestAfter = named.length ? named[named.length - 1] : step;
        rosterBuild = null;
      }
      if (step === vitestAfter) {
        if (vitestFiles.length) steps.push({ ...this.rosterStepFor(vitestFiles), id: vitestRefusal });
        vitestAfter = null;
      }
    }
    return { ok: true, log: bounded() };
  }
}
