/**
 * The App ticket scope table is DATA, and every property that makes it safe is
 * mechanical. These tests check the mechanical ones, because the failure mode of
 * a path list is silence: a typo, a rename or a moved package makes an entry
 * stop matching, and the only symptom is a gate that quietly lets more through.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  APP_TICKET_SCOPES,
  appGateVitestSteps,
  appScopeFor,
  appScopeViolations,
  appTicketChoices,
  appsWithReleaseChanges,
  pathMatches,
  scopeOfTicket,
  sharedModulePackages,
} from "./app-scopes.js";
import { SESSION_PLUS_VIEW_SOURCE } from "@claude-bot/session-plus-view";
import { SHOWCASE_VIEW_SOURCE } from "@claude-bot/showcase-view";
import { PPT_STUDIO_VIEW_SOURCE } from "@claude-bot/ppt-studio-view";
import { CHESS_VIEW_SOURCE } from "@claude-bot/chess-view";
import { DAILY_BRIEF_VIEW_SOURCE } from "@claude-bot/daily-brief-view";
import { REPORT_SPACE_VIEW_SOURCE } from "@claude-bot/report-space-view";
import { MEETING_ROOM_VIEW_SOURCE } from "@claude-bot/meeting-room-view";
import { EXPENSE_INTAKE_VIEW_SOURCE } from "@claude-bot/expense-intake-view";
import { RESEARCH_PROGRAM_VIEW_SOURCE } from "@claude-bot/research-program-view";
import type { AgentViewSourceInput } from "@claude-bot/agent-view-build/release";
import { DEFAULT_GATE_STEPS, SHARED_GATE_PREFIX, TCB_PATHS, gateStepsFor, tcbPathHits } from "./pipeline.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** Every vitest project name the repository actually defines. */
function definedProjects(): Set<string> {
  const names = new Set<string>(["node"]); // the root config declares this one inline
  for (const pkg of readdirSync(join(repoRoot, "packages"))) {
    const config = join(repoRoot, "packages", pkg, "vitest.config.ts");
    if (!existsSync(config)) continue;
    const match = /name:\s*"([^"]+)"/.exec(readFileSync(config, "utf8"));
    if (match) names.add(match[1]);
  }
  return names;
}

interface WorkspacePackage {
  dir: string;
  dependencies: Record<string, string>;
}

/** Workspace runtime dependencies reachable from one App package. */
function workspaceDependencyPrefixes(appPackageDir: string): string[] {
  const packages = new Map<string, WorkspacePackage>();
  for (const dir of readdirSync(join(repoRoot, "packages"))) {
    const manifestPath = join(repoRoot, "packages", dir, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      name?: string;
      dependencies?: Record<string, string>;
    };
    if (manifest.name) {
      packages.set(manifest.name, { dir, dependencies: manifest.dependencies ?? {} });
    }
  }

  const rootManifest = JSON.parse(
    readFileSync(join(repoRoot, "packages", appPackageDir, "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  const prefixes = new Set<string>();
  const visit = (dependencies: Record<string, string>): void => {
    for (const name of Object.keys(dependencies)) {
      const dependency = packages.get(name);
      if (!dependency) continue;
      const prefix = `packages/${dependency.dir}/`;
      if (prefixes.has(prefix)) continue;
      prefixes.add(prefix);
      visit(dependency.dependencies);
    }
  };
  visit(rootManifest.dependencies ?? {});
  return [...prefixes].sort();
}

describe("APP_TICKET_SCOPES", () => {
  it("every path exists in this repo", () => {
    // Same reasoning as the TCB_PATHS existence test, in the opposite direction:
    // a stale entry there stops REFUSING, a stale entry here stops ALLOWING —
    // and the symptom of the second is an app ticket that can never merge for a
    // reason nobody can see in the diff.
    const missing = APP_TICKET_SCOPES.flatMap((scope) =>
      scope.paths.filter((p) => !existsSync(join(repoRoot, p))).map((p) => `${scope.appId}: ${p}`),
    );
    expect(missing).toEqual([]);
  });

  it("no scope path is ever a TCB path", () => {
    // This is the load-bearing one. An app ticket's gate is trimmed BECAUSE its
    // diff cannot reach the platform; if a scope ever covered a file that
    // answers "can account A touch account B", the trim would be buying agility
    // with exactly the code that must not be under-tested.
    for (const scope of APP_TICKET_SCOPES) {
      for (const p of scope.paths) {
        // Probe both the prefix itself and a file invented underneath it, so a
        // directory entry that CONTAINS a TCB file is caught too.
        expect(tcbPathHits([p, `${p}some/new/file.ts`])).toEqual([]);
      }
    }
    // And the reverse direction: no TCB path is inside any scope.
    for (const tcb of TCB_PATHS) {
      for (const scope of APP_TICKET_SCOPES) {
        expect(appScopeViolations([tcb, `${tcb}deep/file.ts`], scope).length).toBeGreaterThan(0);
      }
    }
  });

  it("no scope path touches a protected path or the trusted bot process outside the App's own assets", () => {
    // `packages/bot/src/session-plus/app/` is the one entry inside `packages/bot`
    // and it is release ASSETS: hashed and materialised, never imported. Any
    // OTHER `packages/bot` entry would mean a trimmed gate over trusted code.
    const botPaths = APP_TICKET_SCOPES.flatMap((s) => s.paths).filter((p) => p.startsWith("packages/bot/"));
    expect(botPaths).toEqual(["packages/bot/src/session-plus/app/"]);
    const scripts = APP_TICKET_SCOPES.flatMap((s) => s.paths).filter(
      (p) => p.startsWith("scripts/") || p.startsWith(".claude/"),
    );
    expect(scripts).toEqual([]);
  });

  it("no package is claimed by two Apps", () => {
    // View module packages are reusable by design, so this WILL eventually be
    // non-empty. When it is, the fix is to move the shared package out of both
    // scopes (it has become platform), not to relax this test: otherwise an app
    // ticket for App A reshapes App B under a gate that only ran App A's tests.
    expect(sharedModulePackages()).toEqual([]);
  });

  it("every named vitest project exists", () => {
    const defined = definedProjects();
    for (const scope of APP_TICKET_SCOPES) {
      for (const project of scope.projects) {
        expect({ app: scope.appId, project, defined: defined.has(project) })
          .toEqual({ app: scope.appId, project, defined: true });
      }
    }
  });

  it("keeps Session Plus's now-shared research modules out of its narrow lane", () => {
    const scope = appScopeFor("session-plus")!;
    // The composition root, its still-exclusive editor module, and the
    // declarative backend assets remain App-local.
    expect(scope.paths).toContain("packages/session-plus-view/");
    expect(scope.paths).toContain("packages/agent-editor-view/");
    expect(scope.paths).toContain("packages/bot/src/session-plus/app/");
    // Shared foundations and modules are deliberately ABSENT even though both
    // bundles compile them: changing one affects two Apps.
    for (const platform of [
      "packages/agent-view-react/",
      "packages/agent-module-contract/",
      "packages/agent-sessions-contract/",
      "packages/agent-sessions-view/",
      "packages/agent-workspace-files-view/",
      "packages/agent-file-preview/",
      "packages/agent-text-view/",
      "packages/agent-feishu-view/",
      "packages/workspace-files-contract/",
      "packages/resource-stream-contract/",
      "packages/typed-port-kit/",
      "packages/web-trust/",
    ]) {
      expect(scope.paths).not.toContain(platform);
    }
  });

  it("keeps shared data modules out of every narrow App ticket scope", () => {
    const showcase = appScopeFor("showcase")!;
    const pptStudio = appScopeFor("ppt-studio")!;
    const chess = appScopeFor("chess")!;
    const dailyBrief = appScopeFor("daily-brief")!;
    const reportSpace = appScopeFor("report-space")!;
    const meetingRoom = appScopeFor("meeting-room")!;
    const expenseIntake = appScopeFor("expense-intake")!;
    for (const scope of [showcase, pptStudio, chess, dailyBrief, meetingRoom, expenseIntake, reportSpace]) {
      expect(scope.paths).not.toContain("packages/agent-data-view/");
      expect(scope.releasePaths).toContain("packages/agent-data-view/");
    }
    expect(chess.paths).toEqual([
      "packages/chess-view/",
      "packages/agent-board-view/",
    ]);
  });
});

describe("appScopeViolations", () => {
  const scope = appScopeFor("session-plus")!;

  it("passes files inside the App's packages", () => {
    expect(
      appScopeViolations(
        [
          "packages/session-plus-view/src/App.tsx",
          "packages/agent-editor-view/src/Editor.tsx",
          "packages/bot/src/session-plus/app/app.yaml",
        ],
        scope,
      ),
    ).toEqual([]);
  });

  it("names every file outside, including near-misses", () => {
    expect(
      appScopeViolations(
        [
          "packages/session-plus-view/src/App.tsx",
          // The SDK the modules compile against — shared platform.
          "packages/agent-view-react/src/client.ts",
          // Trusted wiring that happens to live next to the App's assets.
          "packages/bot/src/app-core/identity.ts",
          "doc/development/whatever.md",
        ],
        scope,
      ),
    ).toEqual([
      "packages/agent-view-react/src/client.ts",
      "packages/bot/src/app-core/identity.ts",
      "doc/development/whatever.md",
    ]);
  });

  it("a package whose name merely starts the same way is not the package", () => {
    expect(appScopeViolations(["packages/session-plus-view-extras/src/x.ts"], scope))
      .toEqual(["packages/session-plus-view-extras/src/x.ts"]);
  });

  it("routes the shared data module through the platform lane for both consumer Apps", () => {
    const changed = ["packages/agent-data-view/src/modules.tsx"];
    expect(appScopeViolations(changed, appScopeFor("showcase")!)).toEqual(changed);
    expect(appScopeViolations(changed, appScopeFor("chess")!)).toEqual(changed);
  });
});

describe("pathMatches", () => {
  it("directory entries match by prefix, file entries exactly", () => {
    expect(pathMatches("a/b/c.ts", "a/")).toBe(true);
    expect(pathMatches("a/b/c.ts", "a/b/c.ts")).toBe(true);
    expect(pathMatches("a/b/c.tsx", "a/b/c.ts")).toBe(false);
    expect(pathMatches("ab/c.ts", "a/")).toBe(false);
  });
});

describe("scopeOfTicket / appScopeFor", () => {
  it("only an app ticket has a scope", () => {
    expect(scopeOfTicket({ kind: "simple", app_id: "session-plus" })).toBeNull();
    expect(scopeOfTicket({ kind: "complex", app_id: "session-plus" })).toBeNull();
    expect(scopeOfTicket({ kind: "app", app_id: "session-plus" })?.appId).toBe("session-plus");
  });

  it("an unknown or missing app id resolves to nothing, never to a default", () => {
    // Falling back to "the first App in the table" would let a typo pick up a
    // real App's path allowlist and its trimmed gate.
    expect(scopeOfTicket({ kind: "app", app_id: "not-an-app" })).toBeNull();
    expect(scopeOfTicket({ kind: "app", app_id: null })).toBeNull();
    expect(appScopeFor("")).toBeNull();
    expect(appScopeFor(undefined)).toBeNull();
  });
});

describe("appTicketChoices", () => {
  it("offers each App once, with whether this repo can pack it", () => {
    const choices = appTicketChoices();
    expect(choices.map((c) => c.id)).toEqual(APP_TICKET_SCOPES.map((s) => s.appId));
    expect(choices.find((c) => c.id === "session-plus")?.refreshable).toBe(true);
    expect(choices.find((c) => c.id === "chess")?.refreshable).toBe(true);
  });
});

describe("gateStepsFor", () => {
  it("no scope = the full suite, unchanged", () => {
    expect(gateStepsFor(null)).toEqual(DEFAULT_GATE_STEPS);
    expect(gateStepsFor(undefined)).toEqual(DEFAULT_GATE_STEPS);
  });

  it("an app ticket keeps install/build/tsc and replaces the full vitest run", () => {
    const scope = appScopeFor("session-plus")!;
    const steps = gateStepsFor(scope);
    // The shared prefix is not optional: `dist/` is gitignored, so tsc cannot
    // resolve workspace subpath exports without it — and for an App the build is
    // also what makes the View bundle match its source digest.
    expect(steps.slice(0, 3)).toEqual([...SHARED_GATE_PREFIX]);
    expect(steps[1].args).toEqual(["-r", "build"]);

    const vitest = steps.slice(3);
    expect(vitest.length).toBe(2);
    // Browser projects by name…
    expect(vitest[0].args).toEqual([
      "vitest",
      "run",
      "--maxWorkers=1",
      "--project", "session-plus-view",
      "--project", "agent-editor-view",
    ]);
    // …then the trusted-side suites that re-derive the release, as a SEPARATE
    // run: positional filters apply across every selected project, so folding
    // these into the command above would filter the browser projects down to
    // files that do not exist there and silently run nothing.
    expect(vitest[1].args).toEqual([
      "vitest",
      "run",
      "--project", "node",
      "--maxWorkers=1",
      "packages/bot/src/session-plus",
      "packages/bot/src/app-registry",
    ]);
    // Never the bare full run.
    for (const step of vitest) {
      expect(step.args).toContain("--maxWorkers=1");
      expect(step.args.filter((a) => a === "--project").length).toBeGreaterThan(0);
    }
    // And it really is cheaper than the full gate's vitest budget.
    expect(vitest[0].timeoutMs).toBeLessThan(DEFAULT_GATE_STEPS[3].timeoutMs);
  });

  it("a scope with nothing to run produces no vitest step rather than a bare run", () => {
    // A bare `vitest run` here would be the worst outcome: it looks like a gate
    // and runs the whole repository under the App budget.
    expect(appGateVitestSteps({
      appId: "x", title: "x", paths: [], projects: [], nodePaths: [], releasePaths: [], packScript: null,
    })).toEqual([]);
  });

  it("a Chess ticket runs only its App-owned View projects plus registry checks", () => {
    expect(appGateVitestSteps(appScopeFor("chess")!)).toEqual([
      {
        bin: "npx",
        args: [
          "vitest", "run", "--maxWorkers=1",
          "--project", "chess-view",
          "--project", "agent-board-view",
        ],
        timeoutMs: 900_000,
      },
      {
        bin: "npx",
        args: [
          "vitest", "run", "--project", "node", "--maxWorkers=1",
          "packages/bot/src/app-registry",
        ],
        timeoutMs: 900_000,
      },
    ]);
  });
});

/**
 * `releasePaths` is the OTHER question about a path — "does changing this
 * produce a different package digest?" — and it is the one ticket #61 was
 * filed about: an ordinary ticket may edit a shared module package, which is
 * outside `paths` (a trimmed gate must not authorise that) and squarely inside
 * the App's bundle. If this list drifts from the App's real digest inputs, the
 * pipeline stops telling anybody their change is not live, which is exactly the
 * silence the ticket started from.
 */
describe("release inputs", () => {
  /** `<repo>/packages/foo/src` → `packages/foo/`, the prefix a diff is matched against. */
  function packagePrefixes(source: AgentViewSourceInput): string[] {
    const out = new Set<string>();
    for (const abs of [...source.roots, ...(source.files ?? [])]) {
      const rel = abs.slice(repoRoot.length).replace(/^[/\\]/, "").replace(/\\/g, "/");
      const match = /^(packages\/[^/]+)\//.exec(rel);
      out.add(match ? `${match[1]}/` : rel);
    }
    return [...out].sort();
  }

  it("covers every source tree the App's own digest hashes", async () => {
    const docs = await import(new URL("../../../research-docs-view/src/paths.ts", import.meta.url).href);
    const cases: Array<[string, AgentViewSourceInput]> = [
      ["session-plus", SESSION_PLUS_VIEW_SOURCE],
      ["showcase", SHOWCASE_VIEW_SOURCE],
      ["ppt-studio", PPT_STUDIO_VIEW_SOURCE],
      ["chess", CHESS_VIEW_SOURCE],
      ["daily-brief", DAILY_BRIEF_VIEW_SOURCE],
      ["report-space", REPORT_SPACE_VIEW_SOURCE],
      ["meeting-room", MEETING_ROOM_VIEW_SOURCE],
      ["expense-intake", EXPENSE_INTAKE_VIEW_SOURCE],
      ["research-program", RESEARCH_PROGRAM_VIEW_SOURCE],
      ["research-docs", docs.DOCS_SOURCE],
    ];
    for (const [appId, source] of cases) {
      const scope = appScopeFor(appId)!;
      const uncovered = packagePrefixes(source).filter(
        (prefix) => !scope.releasePaths.some((p) => prefix === p || pathMatches(prefix, p)),
      );
      expect(uncovered, `${appId} 的 digest 输入没有被 releasePaths 覆盖`).toEqual([]);
    }
  });

  it("covers every package in each App's workspace dependency closure", () => {
    const cases = [
      ["session-plus", "session-plus-view"],
      ["showcase", "showcase-view"],
      ["ppt-studio", "ppt-studio-view"],
      ["chess", "chess-view"],
      ["daily-brief", "daily-brief-view"],
      ["report-space", "report-space-view"],
      ["meeting-room", "meeting-room-view"],
      ["expense-intake", "expense-intake-view"],
      ["research-program", "research-program-view"],
    ] as const;
    for (const [appId, packageDir] of cases) {
      const scope = appScopeFor(appId)!;
      const uncovered = workspaceDependencyPrefixes(packageDir).filter(
        (prefix) => !scope.releasePaths.some((p) => prefix === p || pathMatches(prefix, p)),
      );
      expect(uncovered, `${appId} 的 workspace 依赖闭包没有被 releasePaths 覆盖`).toEqual([]);
    }
  });

  it("every release path exists, and contains the ticket allowlist", () => {
    for (const scope of APP_TICKET_SCOPES) {
      const missing = scope.releasePaths.filter((p) => !existsSync(join(repoRoot, p)));
      expect(missing, `${scope.appId} 的 releasePaths 有失效条目`).toEqual([]);
      // A path an app ticket may EDIT always changes that App's release; the
      // reverse is deliberately false (shared foundations are release inputs
      // that an app ticket may not touch).
      const notCovered = scope.paths.filter((p) => !scope.releasePaths.some((r) => p === r || pathMatches(p, r)));
      expect(notCovered, `${scope.appId}: paths ⊄ releasePaths`).toEqual([]);
    }
  });

  it("names the Apps a diff obliges a republication of — and only packable ones", () => {
    expect(appsWithReleaseChanges(["packages/agent-sessions-view/src/modules.tsx"]).map((s) => s.appId))
      .toEqual(["session-plus", "research-program", "research-v2", "research-docs"]);
    expect(appsWithReleaseChanges(["packages/chat-ui-commons/src/ChatTranscript.tsx"]).map((s) => s.appId))
      .toEqual(["session-plus", "research-program", "research-v2", "research-docs"]);
    expect(appsWithReleaseChanges(["packages/agent-text-view/src/index.ts"]).map((s) => s.appId))
      .toEqual(["session-plus", "research-program", "research-v2", "research-docs"]);
    // A shared foundation is in every bundle, so every App owes a release.
    expect(appsWithReleaseChanges(["packages/agent-view-react/src/client.ts"]).map((s) => s.appId))
      .toEqual(["session-plus", "showcase", "ppt-studio", "chess", "daily-brief", "meeting-room", "expense-intake", "report-space", "research-program", "research-v2", "research-docs"]);
    // The static document shell is shared by the same packers, even though it
    // lives beside trusted serving code and is not an App-ticket edit path.
    expect(appsWithReleaseChanges(["packages/bot/src/app-core/view-app.ts"]).map((s) => s.appId))
      .toEqual(["session-plus", "showcase", "ppt-studio", "chess", "daily-brief", "meeting-room", "expense-intake", "report-space", "research-program", "research-v2", "research-docs"]);
    // Shared View modules are outside both narrow ticket allowlists but remain
    // in each actual release closure.
    expect(appsWithReleaseChanges(["packages/agent-data-view/src/modules.tsx"]).map((s) => s.appId))
      .toEqual(["showcase", "ppt-studio", "chess", "daily-brief", "meeting-room", "expense-intake", "report-space"]);
    expect(appsWithReleaseChanges(["packages/agent-deck-view/src/modules.tsx"]).map((s) => s.appId))
      .toEqual(["showcase", "ppt-studio"]);
    expect(appsWithReleaseChanges(["packages/agent-board-view/src/modules.tsx"]).map((s) => s.appId))
      .toEqual(["chess"]);
    expect(appsWithReleaseChanges(["packages/agent-schedule-view/src/modules.tsx"]).map((s) => s.appId))
      .toEqual(["meeting-room"]);
    expect(appsWithReleaseChanges(["packages/agent-intake-view/src/modules.tsx"]).map((s) => s.appId))
      .toEqual(["expense-intake"]);
    // The lockfile pins every App's build and dependency closure.
    expect(appsWithReleaseChanges(["pnpm-lock.yaml"]).map((s) => s.appId))
      .toEqual(["session-plus", "showcase", "ppt-studio", "chess", "daily-brief", "meeting-room", "expense-intake", "report-space", "research-program", "research-v2", "research-docs"]);
    // Trusted code that no bundle compiles is not a release input.
    expect(appsWithReleaseChanges(["packages/bot/src/dashboard/server.ts"])).toEqual([]);
    // `packages/bot/src/session-plus/` is trusted host code; only the App's
    // declarative backend under it ships in the release.
    expect(appsWithReleaseChanges(["packages/bot/src/app-core/identity.ts"])).toEqual([]);
    expect(appsWithReleaseChanges(["packages/bot/src/session-plus/app/app.yaml"]).map((s) => s.appId))
      .toEqual(["session-plus"]);
    // An App this host cannot pack cannot owe a publication.
    expect(
      appsWithReleaseChanges(["packages/x/y.ts"], [
        { appId: "declared", title: "d", paths: [], projects: [], nodePaths: [], releasePaths: ["packages/x/"], packScript: null },
      ]),
    ).toEqual([]);
  });
});
