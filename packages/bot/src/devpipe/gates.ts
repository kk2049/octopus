/**
 * Which test commands a landing runs, and running them.
 *
 * Extracted from `pipeline.ts` (#192). Since the post-submit model (2026-08-09)
 * the default is to run NOTHING here — so the valuable content is the reasoning
 * about why, and about which narrower set an author may name. That reasoning is
 * long and self-contained, and it was sitting between the prompt strings and the
 * pipeline class.
 *
 * `pipeline.ts` re-exports all of these, so importers and tests are unchanged.
 */

import { appGateVitestSteps, type AppTicketScope, type GateStep } from "./app-scopes.js";
import { runChild, stepLogTail, tailBytesFor } from "./child-output.js";

/** How much of a failed gate's output travels back to the agent. */
const GATE_LOG_TAIL = 4_000;

export interface GateOutcome {
  ok: boolean;
  log: string;
}

// ── default gate: install deps, build workspaces, typecheck, full test run ──
//
// `pnpm -r build` is a load-bearing step, not a warm cache: packages/bot imports
// sibling workspace packages via subpath exports (e.g. `@claude-bot/plugin-sessions/scan`)
// whose `exports` map points into `dist/`. `dist/` is gitignored, so a fresh worktree
// has no type declarations for those subpaths and tsc fails with TS2307 before it
// ever sees the ticket's own code. Every ticket's first submit used to hit this and
// waste a full turn (see workspace layout: plugins/*, packages/*) diagnosing it.

// The vitest step is capped at one worker ON PURPOSE. This host has two cores
// and ~3.8G shared with the production bot; an uncapped run schedules the SES
// sandbox children, the Runner/Host process suites and three real-browser
// projects side by side, and the symptom is not "slow" but a cascade of 5s
// timeouts and `fetch failed` that reads as flaky tests (documented in
// CLAUDE.md's 测试 section since the browser projects landed — the gate was
// the one caller that had not learned it). Measured 2026-08-07: the full
// suite is ~21 minutes wall with one worker under production load, so the
// old 900s budget guaranteed a SIGKILL mid-suite even on a healthy tree —
// which presented as "the gate never finishes".
export const DEFAULT_GATE_STEPS: ReadonlyArray<GateStep> = [
  { bin: "pnpm", args: ["install", "--prefer-offline"], timeoutMs: 600_000 },
  { bin: "pnpm", args: ["-r", "build"], timeoutMs: 600_000 },
  { bin: "npx", args: ["tsc", "--noEmit", "-p", "packages/bot/tsconfig.json"], timeoutMs: 300_000 },
  { bin: "npx", args: ["vitest", "run", "--maxWorkers=1"], timeoutMs: 2_700_000 },
];

/**
 * The first three steps are the SAME for every ticket kind, and that is the
 * point of splitting them out rather than writing two arrays.
 *
 * `pnpm install` and `pnpm -r build` are not a warm cache: workspace packages
 * are imported through subpath exports that point into gitignored `dist/`, so a
 * fresh worktree cannot typecheck without them — and for an App ticket the
 * build is additionally load-bearing, because the View bundle's bytes ARE the
 * release identity and the loader refuses a stale one. `tsc` covers the whole
 * bot project regardless of which package changed.
 */
export const SHARED_GATE_PREFIX: ReadonlyArray<GateStep> = DEFAULT_GATE_STEPS.slice(0, 3);

/**
 * The gate one ticket gets: the full suite, or an App's own projects.
 *
 * The trim is justified by TWO independent facts, and it would not be justified
 * by either alone:
 *
 *   1. **The diff is proven local.** `toolSubmit` refuses an app ticket whose
 *      `git diff --name-only --no-renames` leaves that App's path allowlist,
 *      BEFORE any gate runs. So "the rest of the repository is unchanged" is
 *      not an assumption here; it is a checked precondition. (`--no-renames` is
 *      load-bearing for that check — see the call site.)
 *   2. **The release pipeline re-verifies from the bytes.** Packing recomputes
 *      the View source digest and refuses a stale build, revalidates the module
 *      lock / composition / binding plan against this build's manifests, and
 *      the registry recomputes every digest on install; activation additionally
 *      refuses an unknown permission contract, an unsupported execution profile
 *      and a backend that will not come up. Those are fail-closed and they run
 *      after the merge, so a diff that satisfies the path gate but breaks the
 *      release still cannot become the App anybody is served.
 *
 * What the trim genuinely gives up: a change inside an App's own packages that
 * breaks a test somewhere else in the repository lands, and is caught by the
 * next full gate (any ordinary ticket) rather than by this one. The path gate is
 * what makes that a small set — nothing outside the App's packages moved.
 */
export function gateStepsFor(scope: AppTicketScope | null | undefined): ReadonlyArray<GateStep> {
  if (!scope) return DEFAULT_GATE_STEPS;
  return [...SHARED_GATE_PREFIX, ...appGateVitestSteps(scope)];
}

/**
 * The steps for tests an author NAMED, or none at all.
 *
 * ── Why the default is nothing (2026-08-09) ────────────────────────────────
 *
 * Landing used to run the full suite inside the merge lock, which cost ~26
 * minutes (≈4½ for install+build+tsc, ≈21 for vitest) on every landing
 * including documentation-only ones, and blocked every other agent's submit for
 * the duration. That gate was never what decided whether the site survived a
 * bad change: deploy builds in its own tree, refuses to touch the running
 * process if the build fails, has a health gate on the ready line, and has a
 * rollback ladder behind a liveness window. Those are independent of any test.
 *
 * So the model is now post-submit: land immediately, test the watermark in the
 * background, fix forward. What an author may still ask for here is the small
 * set they believe is relevant — cheap enough to be worth waiting for.
 *
 * ── Two commands, for the reason `appGateVitestSteps` documents ────────────
 *
 * `--project` and positional path filters do not compose: selecting projects
 * and then filtering by a path that only exists in one of them silently runs
 * nothing. So a `project:<name>` entry becomes its own command, and bare paths
 * go into a single run with NO project selection — vitest then runs each file
 * in whichever project owns it, which is exactly what a path filter should mean.
 */
export function namedGateSteps(tests: readonly string[]): ReadonlyArray<GateStep> {
  const projects: string[] = [];
  const paths: string[] = [];
  for (const raw of tests) {
    const spec = raw.trim();
    if (!spec) continue;
    if (spec.startsWith("project:")) projects.push(spec.slice("project:".length));
    else paths.push(spec);
  }
  if (!projects.length && !paths.length) return [];
  const steps: GateStep[] = [...SHARED_GATE_PREFIX];
  for (const project of projects) {
    steps.push({ bin: "npx", args: ["vitest", "run", "--project", project, "--maxWorkers=1"], timeoutMs: 1_800_000 });
  }
  if (paths.length) {
    steps.push({ bin: "npx", args: ["vitest", "run", "--maxWorkers=1", ...paths], timeoutMs: 1_800_000 });
  }
  return steps;
}

/**
 * One gate step. Its verdict is the command's own exit status: output of any
 * volume is kept as a bounded tail and never fails the step by itself.
 */
async function execStep(bin: string, args: string[], cwd: string, timeoutMs: number): Promise<GateOutcome> {
  const run = await runChild(bin, args, { cwd, timeoutMs, killSignal: "SIGKILL", tailBytes: tailBytesFor(GATE_LOG_TAIL) });
  return { ok: !run.error, log: `$ ${bin} ${args.join(" ")}\n${stepLogTail(run, GATE_LOG_TAIL)}` };
}

/** The newest `GATE_LOG_TAIL` characters of the joined step logs, marked when earlier ones were cut. */
function gateLog(logs: readonly string[]): string {
  const all = logs.join("\n\n");
  return all.length > GATE_LOG_TAIL ? `…（更早的门禁日志未保留）\n${all.slice(-GATE_LOG_TAIL)}` : all;
}

export async function defaultGate(
  worktree: string,
  scope?: AppTicketScope | null,
  steps?: ReadonlyArray<GateStep>,
): Promise<GateOutcome> {
  const logs: string[] = [];
  for (const s of steps ?? gateStepsFor(scope)) {
    const r = await execStep(s.bin, s.args, worktree, s.timeoutMs);
    logs.push(r.log);
    if (!r.ok) return { ok: false, log: gateLog(logs) };
  }
  return { ok: true, log: gateLog(logs) };
}
