import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  LandGate,
  candidateTestFiles,
  distTypedWorkspaceDeps,
  landGateRefusalMessage,
  namedTestSteps,
  rosterBuildStep,
  rosterStep,
  selectChangedTestFiles,
  selectRosterFiles,
  trueBrowserTestFiles,
  type LandGateStep,
} from "./land-gate.js";
import { gitOrThrow } from "./worktree.js";
import { RemoteGateUnavailable, type RemoteGateSession } from "./remote-gate.js";

/**
 * The compiler these tests run is the REAL tsc from this repo's own
 * dependency — resolved directly so a temp fixture dir (which has no
 * node_modules) never tempts npx into a network install.
 */
const tscJs = join(dirname(createRequire(import.meta.url).resolve("typescript")), "tsc.js");

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "land-gate-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A minimal standalone tsconfig project the real tsc can check in ~a second. */
function tsFixture(dir: string, mainTs: string): string {
  const proj = join(dir, "proj");
  mkdirSync(join(proj, "src"), { recursive: true });
  writeFileSync(join(proj, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["src"] }));
  writeFileSync(join(proj, "src", "main.ts"), mainTs);
  return proj;
}

function tscStep(cacheDir: string): LandGateStep {
  return {
    id: "typecheck",
    bin: process.execPath,
    args: [tscJs, "--noEmit", "--incremental", "--tsBuildInfoFile", join(cacheDir, "t.tsbuildinfo"), "-p", "."],
  };
}

describe("land gate: the real incremental tsc", () => {
  // Three REAL tsc runs on a loaded 2-core box regularly brush the 20s default
  // (measured 19.6-20.3s at load ~15 on 2026-08-17). A longer wait cannot hide
  // a real defect here — a refusal is asserted by outcome, not by time.
  it("a type error refuses as `typecheck` with the tsc tail; the fix then passes on the SAME cache", { timeout: 120_000 }, async () => {
    const dir = tmp();
    const proj = tsFixture(dir, 'export const n: number = "oops";\n');
    const gate = new LandGate({ repoDir: proj, worktreesDir: join(dir, "wt"), stepsFor: async (_d, cacheDir) => [tscStep(cacheDir)] });

    const bad = await gate.check(proj);
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.refusal).toBe("typecheck");
      expect(bad.log).toContain("TS2322");
    }

    // The buildinfo lives OUTSIDE the checked tree (that is what keeps warm
    // runs warm across landings), and a refused run must not wedge it.
    const buildInfo = join(dir, "wt", "_land-gate-cache", "t.tsbuildinfo");
    expect(existsSync(buildInfo)).toBe(true);

    writeFileSync(join(proj, "src", "main.ts"), "export const n: number = 1;\n");
    const good = await gate.check(proj);
    expect(good.ok).toBe(true);

    // Cache reuse smoke: a second clean run against the same buildinfo passes.
    expect((await gate.check(proj)).ok).toBe(true);
  });

  it("a hung step is REFUSED as timeout — never passed, never waited out", async () => {
    const dir = tmp();
    const gate = new LandGate({
      repoDir: dir,
      worktreesDir: join(dir, "wt"),
      timeoutMs: 250,
      stepsFor: async () => [{ id: "typecheck", bin: process.execPath, args: ["-e", "setTimeout(() => {}, 60000)"] }],
    });
    const r = await gate.check(dir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal).toBe("timeout");
  });

  it("a failing step is classified by its id — the lockfile red class keeps its own name", async () => {
    const dir = tmp();
    const gate = new LandGate({
      repoDir: dir,
      worktreesDir: join(dir, "wt"),
      stepsFor: async () => [{ id: "lockfile", bin: process.execPath, args: ["-e", "console.error('ERR_PNPM_OUTDATED_LOCKFILE'); process.exit(1)"] }],
    });
    const r = await gate.check(dir);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.refusal).toBe("lockfile");
      expect(r.log).toContain("ERR_PNPM_OUTDATED_LOCKFILE");
    }
  });

  it("log tails have the staging path rewritten out, per the ticket-gate conventions", async () => {
    const dir = tmp();
    const gate = new LandGate({
      repoDir: dir,
      worktreesDir: join(dir, "wt"),
      // The step echoes the absolute staging dir itself — the worst case.
      stepsFor: async (d) => [{ id: "typecheck", bin: process.execPath, args: ["-e", "console.error(process.argv[1]); process.exit(1)", d] }],
    });
    const r = await gate.check(dir);
    expect(r.ok).toBe(false);
    // Rewritten to "." everywhere, command echo included.
    if (!r.ok) expect(r.log).not.toContain(dir);
  });
});

describe("land gate: dist-typed dep discovery", () => {
  it("finds exactly the bot deps whose export surface points into dist/", async () => {
    const dir = tmp();
    const pkg = (rel: string, manifest: object): void => {
      mkdirSync(join(dir, dirname(rel)), { recursive: true });
      writeFileSync(join(dir, rel), JSON.stringify(manifest));
    };
    pkg("packages/bot/package.json", {
      name: "bot",
      dependencies: { "@x/dist-dep": "workspace:*", "@x/src-dep": "workspace:*" },
      devDependencies: { "@x/dev-dist": "workspace:*" },
    });
    pkg("packages/dist-dep/package.json", { name: "@x/dist-dep", exports: { ".": { types: "./dist/index.d.ts" } } });
    pkg("packages/src-dep/package.json", { name: "@x/src-dep", exports: { ".": { types: "./src/index.ts" } } });
    pkg("plugins/dev-dist/package.json", { name: "@x/dev-dist", types: "./dist/index.d.ts" });
    // dist-typed but NOT a bot dep → building it would be wasted gate time.
    pkg("packages/unrelated/package.json", { name: "@x/unrelated", exports: { ".": "./dist/index.js" } });

    expect(await distTypedWorkspaceDeps(dir)).toEqual(["@x/dev-dist", "@x/dist-dep"]);
  });

  it("matches this repository's measured reality: runner + plugin-sessions, nothing else", async () => {
    // Pinned against the LIVE tree on purpose: if a package flips its export
    // surface between src/ and dist/, the gate's build list follows — and this
    // test tells the author that the gate noticed.
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
    expect(await distTypedWorkspaceDeps(repoRoot)).toEqual(["@claude-bot/plugin-sessions", "@claude-bot/runner"]);
  });
});

describe("land gate: the _land staging worktree", () => {
  it("serialises both doors and parks the tree at exactly the requested sha", async () => {
    const dir = tmp();
    const repo = join(dir, "repo");
    await gitOrThrow(dir, ["init", "-b", "main", repo]);
    await gitOrThrow(repo, ["config", "user.email", "t@t"]);
    await gitOrThrow(repo, ["config", "user.name", "t"]);
    writeFileSync(join(repo, "a.txt"), "1\n");
    await gitOrThrow(repo, ["add", "a.txt"]);
    await gitOrThrow(repo, ["commit", "-m", "one"]);
    const shaA = await gitOrThrow(repo, ["rev-parse", "HEAD"]);
    writeFileSync(join(repo, "a.txt"), "2\n");
    await gitOrThrow(repo, ["commit", "-am", "two"]);
    const shaB = await gitOrThrow(repo, ["rev-parse", "HEAD"]);

    const gate = new LandGate({ repoDir: repo, worktreesDir: join(dir, "wt") });
    let active = 0;
    let maxActive = 0;
    const seen: string[] = [];
    const use = (sha: string): Promise<void> =>
      gate.withLandWorktree(sha, async (d) => {
        active++;
        maxActive = Math.max(maxActive, active);
        expect(d.endsWith("_land")).toBe(true);
        seen.push(await gitOrThrow(d, ["rev-parse", "HEAD"]));
        await new Promise((r) => setTimeout(r, 30));
        active--;
      });
    await Promise.all([use(shaA), use(shaB)]);

    // One user at a time — a concurrent re-park would yank files mid-check —
    // and each user saw its OWN candidate, not the other lane's.
    expect(maxActive).toBe(1);
    expect([...seen].sort()).toEqual([shaA, shaB].sort());
  });

  it("a failed session does not poison the chain for the next lane", async () => {
    const dir = tmp();
    const repo = join(dir, "repo");
    await gitOrThrow(dir, ["init", "-b", "main", repo]);
    await gitOrThrow(repo, ["config", "user.email", "t@t"]);
    await gitOrThrow(repo, ["config", "user.name", "t"]);
    writeFileSync(join(repo, "a.txt"), "1\n");
    await gitOrThrow(repo, ["add", "a.txt"]);
    await gitOrThrow(repo, ["commit", "-m", "one"]);
    const sha = await gitOrThrow(repo, ["rev-parse", "HEAD"]);

    const gate = new LandGate({ repoDir: repo, worktreesDir: join(dir, "wt") });
    await expect(gate.withLandWorktree(sha, async () => Promise.reject(new Error("gate refused")))).rejects.toThrow("gate refused");
    expect(await gate.withLandWorktree(sha, async (d) => await gitOrThrow(d, ["rev-parse", "HEAD"]))).toBe(sha);
  });
});

describe("land gate: discarding a private gate after landing", () => {
  it("removes the parked checkout and cache but never the gate's parent, and can rebuild after", async () => {
    const dir = tmp();
    const repo = join(dir, "repo");
    await gitOrThrow(dir, ["init", "-b", "main", repo]);
    await gitOrThrow(repo, ["config", "user.email", "t@t"]);
    await gitOrThrow(repo, ["config", "user.name", "t"]);
    writeFileSync(join(repo, "a.txt"), "1\n");
    await gitOrThrow(repo, ["add", "a.txt"]);
    await gitOrThrow(repo, ["commit", "-m", "one"]);
    const sha = await gitOrThrow(repo, ["rev-parse", "HEAD"]);
    const parent = join(dir, "_cli-gate-x");
    const gate = new LandGate({ repoDir: repo, worktreesDir: parent });
    await gate.withLandWorktree(sha, async (d) => {
      mkdirSync(join(d, "node_modules"));
      writeFileSync(join(d, "node_modules", "dep.js"), "x");
      mkdirSync(join(parent, "_land-gate-cache"));
      writeFileSync(join(parent, "_land-gate-cache", "t.tsbuildinfo"), "{}");
    });
    await gate.discard();
    expect(existsSync(join(parent, "_land"))).toBe(false);
    expect(existsSync(join(parent, "_land-gate-cache"))).toBe(false);
    expect(existsSync(parent)).toBe(true);
    expect(await gitOrThrow(repo, ["worktree", "list", "--porcelain"])).not.toContain("_land");
    expect(await gate.withLandWorktree(sha, async (d) => await gitOrThrow(d, ["rev-parse", "HEAD"]))).toBe(sha);
  });
});

describe("land gate: refusal wording", () => {
  it("owns being a gate — and never claims to be the CI verdict", () => {
    const msg = landGateRefusalMessage("typecheck", "v4");
    expect(msg).toContain("落地门禁");
    expect(msg).toContain("不是完整 CI 的结论");
    expect(msg).toContain("v4 未改动");
  });

  it("timeout refuses and names both escape hatches", () => {
    const msg = landGateRefusalMessage("timeout", "v4", 8 * 60_000);
    expect(msg).toContain("8 分钟");
    expect(msg).toContain("land_gate");
    expect(msg).toContain("OPS_LAND_LOCAL");
  });
});

describe("land gate: a CI repair ticket's own failure roster", () => {
  /** A step that reports which files the roster run was handed. */
  const echoArgs: LandGateStep = {
    id: "typecheck",
    bin: process.execPath,
    args: ["-e", "console.log('base ok')"],
  };

  it("appends the roster files to the run, in roster order", () => {
    const step = rosterStep(["packages/bot/src/a.test.ts", "packages/bot/src/b.test.ts"]);
    expect(step.id).toBe("roster");
    // Same invocation shape .gitlab-ci.yml uses, so a pass here and a pass
    // there mean the same thing.
    expect(step.args.slice(0, 4)).toEqual(["vitest", "run", "--maxWorkers=1", "--no-file-parallelism"]);
    expect(step.args.slice(-2)).toEqual(["packages/bot/src/a.test.ts", "packages/bot/src/b.test.ts"]);
  });

  // Ticket #226, the first repair this gate ever refused: the agent had a
  // genuinely green fix — in its worktree AND in the CI container — and was
  // refused by three source-digest failures that exist only in `_land`, which
  // has no built View assets because they are gitignored. It then began
  // rewriting those tests to fit the harness. A gate that reports failures CI
  // would not report teaches exactly the behaviour this lane exists to stop.
  it("builds the workspace the way CI does before it believes a roster result", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "a.test.ts"), "");
    const order: string[] = [];
    const gate = new LandGate({
      repoDir: dir,
      worktreesDir: join(dir, "wt"),
      stepsFor: async () => [echoArgs],
      rosterBuildFor: () => {
        order.push("build");
        return { id: "deps_build", bin: process.execPath, args: ["-e", "0"] };
      },
      rosterStepFor: () => {
        order.push("roster");
        return { id: "roster", bin: process.execPath, args: ["-e", "0"] };
      },
    });
    expect((await gate.check(dir, { roster: ["a.test.ts"] })).ok).toBe(true);
    expect(order).toEqual(["build", "roster"]);
  });

  it("uses the same workspace build command CI runs", () => {
    // Not the thin gate's dist-typed subset: that one exists to support tsc,
    // and tests need the built View assets too.
    expect(rosterBuildStep().args).toEqual(["-r", "build"]);
  });

  it("a build failure refuses before any roster result is believed", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "a.test.ts"), "");
    let rosterRan = false;
    const gate = new LandGate({
      repoDir: dir,
      worktreesDir: join(dir, "wt"),
      stepsFor: async () => [echoArgs],
      rosterBuildFor: () => ({ id: "deps_build", bin: process.execPath, args: ["-e", "process.exit(1)"] }),
      rosterStepFor: () => {
        rosterRan = true;
        return { id: "roster", bin: process.execPath, args: ["-e", "0"] };
      },
    });
    const r = await gate.check(dir, { roster: ["a.test.ts"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal).toBe("deps_build");
    expect(rosterRan).toBe(false);
  });

  it("runs only the roster files that still exist in the candidate tree", async () => {
    const dir = tmp();
    mkdirSync(join(dir, "packages", "bot", "src"), { recursive: true });
    writeFileSync(join(dir, "packages", "bot", "src", "kept.test.ts"), "");
    const sel = await selectRosterFiles(dir, ["packages/bot/src/kept.test.ts", "packages/bot/src/gone.test.ts"]);
    expect(sel.files).toEqual(["packages/bot/src/kept.test.ts"]);
    expect(sel.missing).toEqual(["packages/bot/src/gone.test.ts"]);
  });

  it("refuses the landing as `roster` when the named failures are still red", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "a.test.ts"), "");
    let handed: readonly string[] = [];
    const gate = new LandGate({
      repoDir: dir,
      worktreesDir: join(dir, "wt"),
      stepsFor: async () => [echoArgs],
      // A temp fixture has no node_modules; only the composition and the
      // classification are under test, not vitest itself.
      rosterStepFor: (files) => {
        handed = files;
        return { id: "roster", bin: process.execPath, args: ["-e", "console.error('FAIL a.test.ts'); process.exit(1)"] };
      },
    });
    const r = await gate.check(dir, { roster: ["a.test.ts"] });
    expect(handed).toEqual(["a.test.ts"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.refusal).toBe("roster");
      expect(r.log).toContain("FAIL a.test.ts");
    }
  });

  it("lets the landing through once the roster is green", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "a.test.ts"), "");
    const gate = new LandGate({
      repoDir: dir,
      worktreesDir: join(dir, "wt"),
      stepsFor: async () => [echoArgs],
      rosterStepFor: () => ({ id: "roster", bin: process.execPath, args: ["-e", "console.log('1 passed')"] }),
    });
    const r = await gate.check(dir, { roster: ["a.test.ts"] });
    expect(r.ok).toBe(true);
    expect(r.log).toContain("本次门禁执行:a.test.ts");
  });

  it("a hung roster run refuses as timeout, like every other step", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "a.test.ts"), "");
    const gate = new LandGate({
      repoDir: dir,
      worktreesDir: join(dir, "wt"),
      timeoutMs: 200,
      rosterBudgetMs: 200,
      stepsFor: async () => [],
      rosterStepFor: () => ({ id: "roster", bin: process.execPath, args: ["-e", "setTimeout(() => {}, 60000)"] }),
    });
    const r = await gate.check(dir, { roster: ["a.test.ts"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal).toBe("timeout");
  });

  it("pins what it skipped to the FRONT of the log, where a tail cannot eat it", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "present.test.ts"), "");
    const gate = new LandGate({
      repoDir: dir,
      worktreesDir: join(dir, "wt"),
      // Fails, and floods well past the 4 000-char tail bound.
      stepsFor: async () => [
        { id: "typecheck", bin: process.execPath, args: ["-e", "console.error('x'.repeat(9000)); process.exit(1)"] },
      ],
      rosterStepFor: () => ({ id: "roster", bin: process.execPath, args: ["-e", "0"] }),
    });
    const r = await gate.check(dir, { roster: ["present.test.ts", "vanished.test.ts"] });
    expect(r.ok).toBe(false);
    expect(r.log).toContain("vanished.test.ts");
    expect(r.log.startsWith("# CI 修复票的失败清单")).toBe(true);
  });

  it("adds no step at all when the lane's roster gate is switched off", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "a.test.ts"), "");
    let asked = false;
    const gate = new LandGate({
      repoDir: dir,
      worktreesDir: join(dir, "wt"),
      rosterGateEnabled: false,
      stepsFor: async () => [echoArgs],
      rosterStepFor: () => {
        asked = true;
        return { id: "roster", bin: process.execPath, args: ["-e", "process.exit(1)"] };
      },
    });
    const r = await gate.check(dir, { roster: ["a.test.ts"] });
    expect(r.ok).toBe(true);
    expect(asked).toBe(false);
    expect(r.log).not.toContain("CI 修复票的失败清单");
  });

  it("an ordinary landing is untouched — no roster, no vitest, no preamble", async () => {
    const dir = tmp();
    const gate = new LandGate({
      repoDir: dir,
      worktreesDir: join(dir, "wt"),
      stepsFor: async () => [{ id: "typecheck", bin: process.execPath, args: ["-e", "0"] }],
    });
    const r = await gate.check(dir);
    expect(r.ok).toBe(true);
    expect(r.log).not.toContain("CI 修复票的失败清单");
  });

  it("says the roster refusal is a refused landing, and asks for a local green first", () => {
    const message = landGateRefusalMessage("roster", "v4");
    expect(message).toContain("仍然是红的");
    expect(message).toContain("v4 未改动");
    expect(message).toContain("先在本机跑绿");
    expect(message).toContain("立即触发完整 CI");
    expect(message).toContain("同一个 ticket/session");
  });
});

describe("land gate: the landing's own changed tests", () => {
  const baseOk: LandGateStep = { id: "typecheck", bin: process.execPath, args: ["-e", "0"] };

  it("derives the diff's spec files: touched tests plus existing siblings of touched sources", () => {
    expect(
      candidateTestFiles([
        "packages/bot/src/devpipe/gitlab-ci.test.ts", // a test in the diff
        "packages/dashboard-web/src/pages/TicketsPage.tsx", // a source with a sibling test
        "doc/runbooks/ci-triage.md", // not a source at all
        "packages/bot/src/devpipe/gitlab-ci.test.ts", // duplicate stays single
      ]),
    ).toEqual([
      "packages/bot/src/devpipe/gitlab-ci.test.ts",
      "packages/dashboard-web/src/pages/TicketsPage.test.ts",
      "packages/dashboard-web/src/pages/TicketsPage.test.tsx",
    ]);
  });

  it("runs only the candidates that exist, and never re-runs a roster file", async () => {
    const dir = tmp();
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.test.ts"), "");
    writeFileSync(join(dir, "src", "b.test.tsx"), "");
    const sel = await selectChangedTestFiles(
      dir,
      ["src/a.test.ts", "src/b.tsx", "src/c.ts"], // c has no sibling test on disk
      ["src/a.test.ts"], // already owed to the roster run
    );
    expect(sel.files).toEqual(["src/b.test.tsx"]);
    expect(sel.overflow).toEqual([]);
  });

  it("refuses as `changed_tests` when a spec the diff touched is red", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "a.test.ts"), "");
    let handed: readonly string[] = [];
    const gate = new LandGate({
      repoDir: dir,
      worktreesDir: join(dir, "wt"),
      stepsFor: async () => [baseOk],
      rosterStepFor: (files) => {
        handed = files;
        return { id: "roster", bin: process.execPath, args: ["-e", "console.error('FAIL a.test.ts'); process.exit(1)"] };
      },
    });
    const r = await gate.check(dir, { changedFiles: ["a.test.ts"] });
    expect(handed).toEqual(["a.test.ts"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.refusal).toBe("changed_tests");
      expect(r.log).toContain("本次落地 diff 涉及的测试文件");
    }
  });

  it("a repair candidate keeps the `roster` refusal even with diff tests in the same run", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "a.test.ts"), "");
    writeFileSync(join(dir, "b.test.ts"), "");
    let handed: readonly string[] = [];
    const gate = new LandGate({
      repoDir: dir,
      worktreesDir: join(dir, "wt"),
      stepsFor: async () => [baseOk],
      rosterStepFor: (files) => {
        handed = files;
        return { id: "roster", bin: process.execPath, args: ["-e", "process.exit(1)"] };
      },
    });
    const r = await gate.check(dir, { roster: ["a.test.ts"], changedFiles: ["b.test.ts", "a.test.ts"] });
    // One vitest invocation: roster first, then the diff's own tests, deduped.
    expect(handed).toEqual(["a.test.ts", "b.test.ts"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal).toBe("roster");
  });

  it("lets the landing through when the diff's tests are green, and says what it ran", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "a.test.ts"), "");
    const gate = new LandGate({
      repoDir: dir,
      worktreesDir: join(dir, "wt"),
      stepsFor: async () => [baseOk],
      rosterStepFor: () => ({ id: "roster", bin: process.execPath, args: ["-e", "console.log('1 passed')"] }),
    });
    const r = await gate.check(dir, { changedFiles: ["a.test.ts"] });
    expect(r.ok).toBe(true);
    expect(r.log).toContain("本次门禁执行:a.test.ts");
  });

  it("adds no step when the switch is off, or when the diff touches no spec file", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "a.test.ts"), "");
    let asked = false;
    const off = new LandGate({
      repoDir: dir,
      worktreesDir: join(dir, "wt"),
      changedTestsGateEnabled: false,
      stepsFor: async () => [baseOk],
      rosterStepFor: () => {
        asked = true;
        return { id: "roster", bin: process.execPath, args: ["-e", "process.exit(1)"] };
      },
    });
    expect((await off.check(dir, { changedFiles: ["a.test.ts"] })).ok).toBe(true);
    expect(asked).toBe(false);

    const on = new LandGate({
      repoDir: dir,
      worktreesDir: join(dir, "wt"),
      stepsFor: async () => [baseOk],
      rosterStepFor: () => {
        asked = true;
        return { id: "roster", bin: process.execPath, args: ["-e", "process.exit(1)"] };
      },
    });
    expect((await on.check(dir, { changedFiles: ["doc/x.md", "src/no-sibling.ts"] })).ok).toBe(true);
    expect(asked).toBe(false);
  });

  it("tells the agent the refusal is about its own diff, not a CI verdict", () => {
    const message = landGateRefusalMessage("changed_tests", "v4");
    expect(message).toContain("diff");
    expect(message).toContain("v4 未改动");
    expect(message).toContain("vitest run");
  });
  it("runs matched knowledge evidence even when the diff did not touch that test", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "historical.test.ts"), "");
    let handed: readonly string[] = [];
    const gate = new LandGate({
      repoDir: dir,
      worktreesDir: join(dir, "wt"),
      stepsFor: async () => [baseOk],
      rosterStepFor: (files) => {
        handed = files;
        return { id: "roster", bin: process.execPath, args: ["-e", "process.exit(1)"] };
      },
    });
    const r = await gate.check(dir, { requiredTests: ["historical.test.ts"] });
    expect(handed).toEqual(["historical.test.ts"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal).toBe("knowledge_tests");
  });

  it("refuses rather than silently skipping a missing knowledge evidence file", async () => {
    const dir = tmp();
    const gate = new LandGate({
      repoDir: dir,
      worktreesDir: join(dir, "wt"),
      stepsFor: async () => [baseOk],
    });
    const r = await gate.check(dir, { requiredTests: ["removed.test.ts"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal).toBe("knowledge_tests");
    expect(r.log).toContain("候选树上不存在:removed.test.ts");
  });

});

describe("land gate: true-browser tests stay out of synchronous landing", () => {
  const baseOk: LandGateStep = { id: "typecheck", bin: process.execPath, args: ["-e", "0"] };

  it("discovers browser-driver specs and excludes knowledge, diff and explicit path requests", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "browser.e2e.test.ts"), 'import { chromium } from "playwright";\nvoid chromium;\n');
    writeFileSync(join(dir, "ordinary.test.ts"), "export {};\n");
    expect(await trueBrowserTestFiles(dir)).toEqual(["browser.e2e.test.ts"]);
    let built = false;
    let rostered: readonly string[] = [];
    let named: readonly string[] = [];
    const gate = new LandGate({
      repoDir: dir,
      worktreesDir: join(dir, "wt"),
      stepsFor: async () => [baseOk],
      rosterBuildFor: () => {
        built = true;
        return { id: "deps_build", bin: process.execPath, args: ["-e", "0"] };
      },
      rosterStepFor: (files) => {
        rostered = files;
        return { id: "roster", bin: process.execPath, args: ["-e", "0"] };
      },
      namedStepsFor: (tests) => {
        named = tests;
        return [];
      },
    });
    const result = await gate.check(dir, {
      requiredTests: ["browser.e2e.test.ts"],
      changedFiles: ["browser.e2e.test.ts"],
      namedTests: ["browser.e2e.test.ts"],
    });
    expect(result.ok).toBe(true);
    expect(built).toBe(false);
    expect(rostered).toEqual([]);
    expect(named).toEqual([]);
    expect(result.log).toContain("真浏览器测试不在落地/上线门禁运行");
  });

  it("adds browser exclusions to project and directory runs while retaining ordinary tests", () => {
    const excluded = ["packages/bot/src/session-plus/browser.e2e.test.ts"];
    const steps = namedTestSteps(["project:node", "packages/bot/src/session-plus"], excluded);
    expect(steps).toHaveLength(2);
    for (const step of steps) {
      expect(step.args).toContain("--exclude");
      expect(step.args).toContain(excluded[0]);
    }
    expect(steps[1].args).toContain("packages/bot/src/session-plus");
  });
});

describe("land gate: the tests a landing names (2026-08-21)", () => {
  const echoArgs: LandGateStep = { id: "typecheck", bin: process.execPath, args: ["-e", "console.log('base ok')"] };

  it("turns `project:` and path specs into separate vitest steps, never one combined run", () => {
    const steps = namedTestSteps(["project:dashboard-web", " packages/bot/src/devpipe ", "", "project:node", "a.test.ts"]);
    expect(steps.map((s) => s.id)).toEqual(["named_tests", "named_tests", "named_tests"]);
    expect(steps[0].args).toEqual(["vitest", "run", "--project", "dashboard-web", "--maxWorkers=1"]);
    expect(steps[1].args).toEqual(["vitest", "run", "--project", "node", "--maxWorkers=1"]);
    expect(steps[2].args).toEqual(["vitest", "run", "--maxWorkers=1", "--no-file-parallelism", "packages/bot/src/devpipe", "a.test.ts"]);
    expect(namedTestSteps(["", "  "])).toEqual([]);
  });

  it("runs them after the workspace build and before the diff's own tests; a red refuses as named_tests", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "a.test.ts"), "");
    const order: string[] = [];
    const gate = new LandGate({
      repoDir: dir,
      worktreesDir: join(dir, "wt"),
      stepsFor: async () => [echoArgs],
      rosterBuildFor: () => {
        order.push("build");
        return { id: "deps_build", bin: process.execPath, args: ["-e", "0"] };
      },
      namedStepsFor: () => {
        order.push("named");
        return [{ id: "named_tests", bin: process.execPath, args: ["-e", "console.log('1 passed')"] }];
      },
      rosterStepFor: () => {
        order.push("changed");
        return { id: "changed_tests", bin: process.execPath, args: ["-e", "0"] };
      },
    });
    let handed: readonly string[] = [];
    const gateRed = new LandGate({
      repoDir: dir,
      worktreesDir: join(dir, "wt"),
      stepsFor: async () => [echoArgs],
      rosterBuildFor: () => {
        order.push("build");
        return { id: "deps_build", bin: process.execPath, args: ["-e", "0"] };
      },
      namedStepsFor: (tests) => {
        handed = tests;
        order.push("named");
        return [{ id: "named_tests", bin: process.execPath, args: ["-e", "console.error('FAIL project:node'); process.exit(1)"] }];
      },
      rosterStepFor: () => {
        order.push("changed");
        return { id: "changed_tests", bin: process.execPath, args: ["-e", "0"] };
      },
    });
    const r = await gateRed.check(dir, { namedTests: ["project:node"], changedFiles: ["a.test.ts"] });
    expect(handed).toEqual(["project:node"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.refusal).toBe("named_tests");
      expect(r.log).toContain("FAIL project:node");
    }
    // Build, then the named tests; the diff's own tests were never reached.
    expect(order).toEqual(["build", "named"]);

    // Green named tests → the diff's tests follow, in that order.
    order.length = 0;
    const green = await gate.check(dir, { namedTests: ["project:node"], changedFiles: ["a.test.ts"] });
    expect(green.ok).toBe(true);
    expect(order).toEqual(["build", "named", "changed"]);
  });

  it("names its refusal without claiming to be CI", () => {
    expect(landGateRefusalMessage("named_tests", "v4")).toContain("点名的测试");
    expect(landGateRefusalMessage("named_tests", "v4")).toContain("v4 未改动");
  });
});

describe("land gate: on the CI machine (remote-gate.ts)", () => {
  const echoArgs: LandGateStep = { id: "typecheck", bin: process.execPath, args: ["-e", "console.log('base ok')"] };

  /** A session whose steps run here, recording what it was asked. */
  function fakeSession(opts: { syncOk?: boolean; fail?: "unavailable" | "step"; log: string[]; closed: string[] }): RemoteGateSession {
    return {
      device: "ci-box",
      workspace: "/work/land",
      cacheDir: "/work/land-gate-cache",
      async sync(_dir, sha) {
        opts.log.push(`sync ${sha.slice(0, 7)}`);
        return opts.syncOk === false ? { ok: false, detail: "bundle download failed" } : { ok: true, detail: "synced" };
      },
      async run(step) {
        opts.log.push(`run ${step.id}`);
        if (opts.fail === "unavailable") throw new RemoteGateUnavailable("runner offline");
        if (opts.fail === "step") return { ok: false, timedOut: false, log: `$ ${step.bin}\nTS2322 remote red` };
        return { ok: true, timedOut: false, log: `$ ${step.bin}\nremote ok /work/land` };
      },
      close() {
        opts.closed.push("closed");
      },
    };
  }

  async function gitFixture(): Promise<string> {
    const dir = tmp();
    await gitOrThrow(dir, ["init", "-q", "-b", "main"]);
    await gitOrThrow(dir, ["config", "user.email", "t@t"]);
    await gitOrThrow(dir, ["config", "user.name", "t"]);
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    await gitOrThrow(dir, ["add", "."]);
    await gitOrThrow(dir, ["commit", "-q", "-m", "one"]);
    return dir;
  }

  it("syncs the candidate sha there, runs every step there, says so in the log, and closes the session", async () => {
    const dir = await gitFixture();
    const log: string[] = [];
    const closed: string[] = [];
    let localRan = 0;
    const gate = new LandGate({
      repoDir: dir,
      worktreesDir: join(dir, "wt"),
      // A local step that would be visible if the gate fell back here.
      stepsFor: async () => [{ id: "typecheck", bin: process.execPath, args: ["-e", `require('fs').writeFileSync(${JSON.stringify(join(dir, "LOCAL"))}, '1')`] }],
      remote: () => fakeSession({ log, closed }),
    });
    const r = await gate.check(dir);
    expect(r.ok).toBe(true);
    expect(log).toEqual([`sync ${(await gitOrThrow(dir, ["rev-parse", "HEAD"])).slice(0, 7)}`, "run typecheck"]);
    expect(r.log).toContain("门禁执行位置:ci-box:/work/land");
    expect(r.log).toContain("remote ok");
    expect(existsSync(join(dir, "LOCAL"))).toBe(false);
    expect(closed).toEqual(["closed"]);
    void localRan;
  });

  it("a red step there is a refusal here — the machine's verdict is the gate's verdict", async () => {
    const dir = await gitFixture();
    const log: string[] = [];
    const gate = new LandGate({
      repoDir: dir,
      worktreesDir: join(dir, "wt"),
      stepsFor: async () => [echoArgs],
      remote: () => fakeSession({ log, closed: [], fail: "step" }),
    });
    const r = await gate.check(dir);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.refusal).toBe("typecheck");
      expect(r.log).toContain("TS2322 remote red");
    }
  });

  it.each(["offline", "sync", "running"] as const)("required remote mode refuses %s without executing local steps", async (failure) => {
    const dir = await gitFixture();
    const marker = join(dir, "LOCAL");
    const closed: string[] = [];
    const gate = new LandGate({ repoDir: dir, worktreesDir: join(dir, "wt"), remoteRequired: true,
      stepsFor: async () => [{ id: "typecheck", bin: process.execPath,
        args: ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, '1')`] }],
      remote: () => failure === "offline" ? null : fakeSession({ log: [], closed,
        ...(failure === "sync" ? { syncOk: false } : { fail: "unavailable" as const }) }),
    });
    const result = await gate.check(dir);
    expect(result).toMatchObject({ ok: false, refusal: failure === "offline" ? "remote_unavailable" : "remote_unknown" });
    expect(existsSync(marker)).toBe(false);
    expect(closed).toHaveLength(failure === "offline" ? 0 : 1);
    expect(landGateRefusalMessage(failure === "offline" ? "remote_unavailable" : "remote_unknown", "v4")).toContain("v4 未改动");
  });

  it("a failed sync runs the same steps here instead", async () => {
    const dir = await gitFixture();
    const log: string[] = [];
    const closed: string[] = [];
    const gate = new LandGate({
      repoDir: dir,
      worktreesDir: join(dir, "wt"),
      stepsFor: async () => [echoArgs],
      remote: () => fakeSession({ log, closed, syncOk: false }),
    });
    const r = await gate.check(dir);
    expect(r.ok).toBe(true);
    expect(log).toHaveLength(1); // the sync only; no remote step ran
    expect(r.log).not.toContain("门禁执行位置");
    expect(r.log).toContain("base ok");
    expect(closed).toEqual(["closed"]);
  });

  it("a machine that stops answering mid-run reruns here — never a pass by default", async () => {
    const dir = await gitFixture();
    const log: string[] = [];
    const gate = new LandGate({
      repoDir: dir,
      worktreesDir: join(dir, "wt"),
      stepsFor: async () => [{ id: "typecheck", bin: process.execPath, args: ["-e", "console.error('local TS9999'); process.exit(1)"] }],
      remote: () => fakeSession({ log, closed: [], fail: "unavailable" }),
    });
    const r = await gate.check(dir);
    expect(log).toEqual([expect.stringMatching(/^sync /), "run typecheck"]);
    // The local rerun's verdict stands: here the fixture's tsc is red.
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.refusal).toBe("typecheck");
      expect(r.log).toContain("local TS9999");
    }
  });

  it("no session (machine offline) is simply the local gate", async () => {
    const dir = await gitFixture();
    const gate = new LandGate({
      repoDir: dir,
      worktreesDir: join(dir, "wt"),
      stepsFor: async () => [echoArgs],
      remote: () => null,
    });
    const r = await gate.check(dir);
    expect(r.ok).toBe(true);
    expect(r.log).toContain("base ok");
  });

it.each(["deps_build", "timeout", "remote_unavailable"] as const)("strict gate preserves typed preparation refusal %s without a local run", async (refusal) => {
  const dir = await gitFixture(); let ran = false;
  const gate = new LandGate({ repoDir: dir, worktreesDir: join(dir, "wt"), remoteRequired: true,
    stepsFor: async () => { ran = true; return []; },
    remote: () => ({ device: "ci", workspace: "registered", cacheDir: ".cache",
      sync: async () => ({ ok: false, detail: "original receipt", refusal }), run: async () => { throw new Error("must not execute"); }, close() {},
    }),
  });
  expect(await gate.check(dir)).toMatchObject({ ok: false, refusal }); expect(ran).toBe(false);
});

});
