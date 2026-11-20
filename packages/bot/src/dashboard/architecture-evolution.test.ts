/**
 * The evolution half of the architecture page's server: git log parsing,
 * path→module attribution, range aggregation, snapshot-endpoint resolution and
 * the snapshot set difference — all pure — plus the service-level behaviors
 * that tie them to files and git (archiving a successful run, the snapshot
 * manifest, and the range diff endpoint's honesty when history is thin).
 *
 * Nothing here runs the analyzer or a real git subprocess: the analyzer seam
 * writes the snapshot a real run would, and the git seam answers from
 * fixtures. That is the point of the design — dragging the range costs a
 * `git log`, and these tests pin the entire computation between those seams.
 */
import { describe, it, expect, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitResult } from "../devpipe/worktree.js";
import { ARCHIVE_RETENTION } from "./architecture-archive.js";
import { ArchitectureService, type ArchitectureView } from "./architecture.js";
import {
  GIT_FIELD_SEP,
  UNMAPPED_MODULE,
  aggregateCodeChanges,
  diffArchitectureViews,
  moduleForPath,
  nearestSnapshotCommit,
  parseCommitLog,
  parseNumstatLog,
} from "./architecture-evolution.js";

const SEP = GIT_FIELD_SEP;
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const SHA_D = "d".repeat(40);
const SHA_E = "e".repeat(40);
const numberedSha = (index: number): string => index.toString(16).padStart(40, "0");

// ── git log parsing ─────────────────────────────────────────────────────────

describe("parseCommitLog", () => {
  it("parses %H/%aI/%an/%s lines and preserves order", () => {
    const out = [
      `${SHA_A}${SEP}2026-08-10T10:00:00+08:00${SEP}Alice${SEP}Add the thing`,
      `${SHA_B}${SEP}2026-08-09T09:00:00+08:00${SEP}Bob Chen${SEP}Fix: colon, and	tab`,
    ].join("\n");
    expect(parseCommitLog(out)).toEqual([
      { sha: SHA_A, date: "2026-08-10T10:00:00+08:00", author: "Alice", subject: "Add the thing" },
      { sha: SHA_B, date: "2026-08-09T09:00:00+08:00", author: "Bob Chen", subject: "Fix: colon, and	tab" },
    ]);
  });

  it("keeps a subject containing the separator as one subject", () => {
    const parsed = parseCommitLog(`${SHA_A}${SEP}d${SEP}a${SEP}left${SEP}right`);
    expect(parsed[0].subject).toBe(`left${SEP}right`);
  });

  it("skips blank and malformed lines instead of inventing commits", () => {
    const out = ["", "not a commit", `${SHA_A}${SEP}d${SEP}a${SEP}s`].join("\n");
    expect(parseCommitLog(out)).toHaveLength(1);
  });
});

describe("parseNumstatLog", () => {
  const out = [
    `@@${SHA_A}${SEP}2026-08-10T10:00:00+08:00${SEP}Alice${SEP}Add feature`,
    "",
    "10\t2\tpackages/a/src/one.ts",
    "3\t1\tpackages/b/src/two.ts",
    `@@${SHA_B}${SEP}2026-08-09T10:00:00+08:00${SEP}Bob${SEP}Fix bug`,
    "",
    "-\t-\tassets/logo.png",
    "5\t0\tpackages/a/src/one.ts",
  ].join("\n");

  it("groups numstat records under their own commit", () => {
    const commits = parseNumstatLog(out);
    expect(commits.map((c) => c.sha)).toEqual([SHA_A, SHA_B]);
    expect(commits[0].files).toEqual([
      { path: "packages/a/src/one.ts", additions: 10, deletions: 2 },
      { path: "packages/b/src/two.ts", additions: 3, deletions: 1 },
    ]);
  });

  it("counts a binary file as touched with zero lines", () => {
    const commits = parseNumstatLog(out);
    expect(commits[1].files[0]).toEqual({ path: "assets/logo.png", additions: 0, deletions: 0 });
  });

  it("represents an empty commit as a commit with no files", () => {
    const commits = parseNumstatLog(`@@${SHA_C}${SEP}d${SEP}a${SEP}empty`);
    expect(commits).toEqual([{ sha: SHA_C, date: "d", author: "a", subject: "empty", files: [] }]);
  });
});

// ── path → module attribution ───────────────────────────────────────────────

describe("moduleForPath", () => {
  const rules = [
    { id: "bot", pathPrefixes: ["packages/bot/"] },
    { id: "bot-dashboard", pathPrefixes: ["packages/bot/src/dashboard/"] },
    { id: "authz", pathPrefixes: ["packages/bot/src/dashboard/authz.ts"] },
  ];

  it("attributes by LONGEST matching prefix, exactly like the analyzer", () => {
    expect(moduleForPath("packages/bot/src/bot.ts", rules)).toBe("bot");
    expect(moduleForPath("packages/bot/src/dashboard/server.ts", rules)).toBe("bot-dashboard");
    expect(moduleForPath("packages/bot/src/dashboard/authz.ts", rules)).toBe("authz");
  });

  it("does not let a file prefix match a sibling (authz.ts vs authz.test.ts)", () => {
    expect(moduleForPath("packages/bot/src/dashboard/authz.test.ts", rules)).toBe("bot-dashboard");
  });

  it("returns null when no rule owns the path", () => {
    expect(moduleForPath("doc/deliveries/x.md", rules)).toBeNull();
  });
});

// ── aggregation ─────────────────────────────────────────────────────────────

describe("aggregateCodeChanges", () => {
  const rules = [
    { id: "mod.a", pathPrefixes: ["packages/a/"] },
    { id: "mod.b", pathPrefixes: ["packages/b"] },
  ];
  const commits = parseNumstatLog(
    [
      `@@${SHA_A}${SEP}2026-08-10T10:00:00+08:00${SEP}Alice${SEP}Add feature`,
      "10\t2\tpackages/a/src/one.ts",
      "3\t1\tpackages/b/src/two.ts",
      `@@${SHA_B}${SEP}2026-08-09T10:00:00+08:00${SEP}Bob${SEP}Fix bug`,
      "-\t-\tassets/logo.png",
      "5\t0\tpackages/a/src/one.ts",
    ].join("\n"),
  );

  it("sums per module with a per-module touching-commit count", () => {
    const sum = aggregateCodeChanges(commits, rules, 2, { moduleFiles: 8, commits: 100 });
    expect(sum.commitCount).toBe(2);
    expect(sum.aggregatedCommits).toBe(2);
    expect(sum.additions).toBe(18);
    expect(sum.deletions).toBe(3);
    // Sorted by churn descending; unmatched paths land in the unmapped bucket.
    expect(sum.modules.map((m) => m.moduleId)).toEqual(["mod.a", "mod.b", UNMAPPED_MODULE]);
    expect(sum.modules[0]).toEqual({
      moduleId: "mod.a",
      additions: 15,
      deletions: 2,
      commits: 2,
      files: [{ path: "packages/a/src/one.ts", additions: 15, deletions: 2 }],
      filesTotal: 1,
    });
    expect(sum.modules[2].commits).toBe(1);
  });

  it("bounds the LISTS but never the totals", () => {
    const sum = aggregateCodeChanges(commits, rules, 2, { moduleFiles: 1, commits: 1 });
    expect(sum.additions).toBe(18); // full range still aggregated
    expect(sum.commits).toHaveLength(1); // newest only
    expect(sum.commits[0].sha).toBe(SHA_A);
    const a = sum.modules.find((m) => m.moduleId === "mod.a")!;
    expect(a.files).toHaveLength(1);
    expect(a.filesTotal).toBe(1);
  });

  it("strips per-commit file lists from the commit list", () => {
    const sum = aggregateCodeChanges(commits, rules, 2, { moduleFiles: 8, commits: 100 });
    expect(sum.commits[0]).toEqual({
      sha: SHA_A,
      date: "2026-08-10T10:00:00+08:00",
      author: "Alice",
      subject: "Add feature",
    });
  });
});

// ── snapshot endpoint resolution ────────────────────────────────────────────

describe("nearestSnapshotCommit", () => {
  // order: E(0, newest) D(1) C(2) B(3) A(4, oldest)
  const order = new Map([SHA_E, SHA_D, SHA_C, SHA_B, SHA_A].map((sha, at) => [sha, at] as const));

  it("picks the snapshot nearest the endpoint by commit distance", () => {
    expect(nearestSnapshotCommit(order, [SHA_E, SHA_A], SHA_B)).toBe(SHA_A);
    expect(nearestSnapshotCommit(order, [SHA_E, SHA_A], SHA_D)).toBe(SHA_E);
  });

  it("breaks a tie toward the newer snapshot, deterministically", () => {
    expect(nearestSnapshotCommit(order, [SHA_B, SHA_D], SHA_C)).toBe(SHA_D);
  });

  it("returns null for an endpoint outside the order window", () => {
    expect(nearestSnapshotCommit(order, [SHA_A], "f".repeat(40))).toBeNull();
  });

  it("ignores snapshots that cannot be placed", () => {
    expect(nearestSnapshotCommit(order, ["f".repeat(40)], SHA_C)).toBeNull();
  });
});

// ── snapshot set difference ─────────────────────────────────────────────────

type ViewModule = ArchitectureView["modules"][number];
type ViewDependency = ArchitectureView["dependencies"][number];
type ViewConstraint = ArchitectureView["constraints"][number];

function mod(id: string, codeLoc: number, files: number): ViewModule {
  return {
    id,
    label: id.toUpperCase(),
    description: "",
    zone: "trusted",
    criticality: "normal",
    tags: [],
    docs: [],
    files,
    codeLoc,
    testFiles: 0,
    gitTouches: 0,
    runtimeFanIn: 0,
    runtimeFanOut: 0,
    typeOnlyFanIn: 0,
    typeOnlyFanOut: 0,
    fanIn: 0,
    fanOut: 0,
    annotations: 0,
  };
}

function dep(from: string, to: string, patch: Partial<ViewDependency> = {}): ViewDependency {
  return {
    from,
    to,
    runtimeCount: 1,
    typeOnlyCount: 0,
    testCount: 0,
    dynamicCount: 0,
    circular: false,
    samples: [],
    ...patch,
  };
}

function constraint(id: string, status: string): ViewConstraint {
  return {
    id,
    title: `title ${id}`,
    description: "",
    concern: "modularity",
    severity: "high",
    status,
    mechanismKind: null,
    violations: [],
    evidence: [],
  };
}

function view(patch: {
  commit: string;
  modules: ViewModule[];
  dependencies: ViewDependency[];
  constraints: ViewConstraint[];
  codeLoc?: number;
}): ArchitectureView {
  return {
    meta: {
      commit: patch.commit,
      branch: "v4",
      dirty: false,
      generatedAt: `2026-08-0${patch.commit === SHA_A ? 1 : 9}T00:00:00.000Z`,
      totals: { files: 10, codeLoc: patch.codeLoc ?? 1000, symbols: 5, calls: 5, annotations: 1 },
    },
    zones: [],
    modules: patch.modules,
    dependencies: patch.dependencies,
    moduleEcosystem: { frontend: [], contracts: [], backend: [], dependencies: [], issues: [] },
    flows: [],
    constraints: patch.constraints,
    findings: [],
    tcb: null,
    hotspots: [],
  };
}

describe("diffArchitectureViews", () => {
  const base = view({
    commit: SHA_A,
    codeLoc: 1000,
    modules: [mod("a", 100, 2), mod("b", 50, 1), mod("gone", 30, 1)],
    dependencies: [
      dep("a", "b"),
      dep("a", "gone"),
      dep("x", "y", { circular: false }),
      dep("t", "u", { runtimeCount: 0, typeOnlyCount: 3 }), // type-only: not architecture
    ],
    constraints: [constraint("C-1", "pass"), constraint("C-GONE", "pass")],
  });
  const head = view({
    commit: SHA_B,
    codeLoc: 1200,
    modules: [mod("a", 150, 3), mod("b", 50, 1), mod("fresh", 40, 2)],
    dependencies: [dep("a", "b"), dep("a", "fresh", { dynamicCount: 1 }), dep("x", "y", { circular: true })],
    constraints: [constraint("C-1", "fail"), constraint("C-NEW", "review")],
  });
  const diff = diffArchitectureViews(base, head);

  it("names both snapshots and carries the totals through", () => {
    expect(diff.base.commit).toBe(SHA_A);
    expect(diff.head.commit).toBe(SHA_B);
    expect(diff.totals.before.codeLoc).toBe(1000);
    expect(diff.totals.after.codeLoc).toBe(1200);
  });

  it("reports module additions, removals and resizes", () => {
    expect(diff.modules.added).toEqual([{ id: "fresh", label: "FRESH", zone: "trusted", codeLoc: 40, files: 2 }]);
    expect(diff.modules.removed).toEqual([{ id: "gone", label: "GONE", zone: "trusted", codeLoc: 30, files: 1 }]);
    expect(diff.modules.resized).toEqual([
      {
        id: "a",
        label: "A",
        zone: "trusted",
        codeLocBefore: 100,
        codeLocAfter: 150,
        filesBefore: 2,
        filesAfter: 3,
      },
    ]);
  });

  it("diffs VALUE edges only, and tracks circularity transitions", () => {
    expect(diff.dependencies.added).toEqual([
      { from: "a", to: "fresh", runtimeCount: 1, dynamicCount: 1, circular: false },
    ]);
    expect(diff.dependencies.removed).toEqual([{ from: "a", to: "gone" }]);
    expect(diff.dependencies.becameCircular).toEqual([{ from: "x", to: "y" }]);
    expect(diff.dependencies.becameAcyclic).toEqual([]);
    // t→u is type-only on the base side: its absence on head is NOT a removal.
    expect(diff.dependencies.removed.find((e) => e.from === "t")).toBeUndefined();
  });

  it("reports constraint verdict changes by id", () => {
    expect(diff.constraints.changed).toEqual([{ id: "C-1", title: "title C-1", before: "pass", after: "fail" }]);
    expect(diff.constraints.added).toEqual([{ id: "C-NEW", title: "title C-NEW", status: "review" }]);
    expect(diff.constraints.removed).toEqual([{ id: "C-GONE", title: "title C-GONE" }]);
  });

  it("is empty — not fabricated — when both sides are identical", () => {
    const same = diffArchitectureViews(base, base);
    expect(same.modules).toEqual({ added: [], removed: [], resized: [] });
    expect(same.dependencies).toEqual({ added: [], removed: [], becameCircular: [], becameAcyclic: [] });
    expect(same.constraints).toEqual({ added: [], removed: [], changed: [] });
  });
});

// ── service: archive, manifest, range diff ──────────────────────────────────

/** A minimal but complete atlas file for one commit. */
function atlasFor(commit: string, generatedAt: string, extras: Partial<Record<string, unknown>> = {}): unknown {
  return {
    schemaVersion: 1,
    meta: { commit, branch: "v4", dirty: false, generatedAt },
    zones: [],
    modules: [
      {
        id: "mod.a",
        label: "A",
        description: "",
        zone: "trusted",
        criticality: "normal",
        files: 1,
        codeLoc: 100,
        testFiles: 0,
        gitTouches: 0,
        fanIn: 0,
        fanOut: 0,
      },
    ],
    files: [],
    dependencies: [],
    symbols: [],
    calls: [],
    annotations: [],
    flows: [],
    constraints: [],
    tcbs: [],
    findings: [],
    ...extras,
  };
}

function ok(stdout: string): GitResult {
  return { ok: true, stdout, stderr: "", code: 0 };
}

function fail(code = 1): GitResult {
  return { ok: false, stdout: "", stderr: "", code };
}

describe("ArchitectureService evolution", () => {
  it("automatically analyzes and archives a checkout whose snapshot is stale", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arch-auto-stale-"));
    let svc: ArchitectureService | null = null;
    try {
      let calls = 0;
      svc = new ArchitectureService({
        repoDir: dir,
        dataDir: dir,
        runGit: async (args) => args[0] === "rev-parse" ? ok(SHA_A) : fail(),
        runAnalyzer: async () => {
          calls += 1;
          mkdirSync(join(dir, "architecture"), { recursive: true });
          writeFileSync(
            join(dir, "architecture", "atlas.json"),
            JSON.stringify(atlasFor(SHA_A, "2026-08-12T01:00:00Z")),
          );
          return { ok: true, log: "" };
        },
      });

      svc.startAutoRefresh(1_000);
      await vi.waitFor(() => {
        expect(calls).toBe(1);
        expect(existsSync(join(dir, "architecture", "snapshots", `${SHA_A}.json`))).toBe(true);
      });
    } finally {
      await svc?.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("repairs a missing archive without rerunning an already-current analysis", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arch-auto-archive-"));
    let svc: ArchitectureService | null = null;
    try {
      mkdirSync(join(dir, "architecture"), { recursive: true });
      writeFileSync(
        join(dir, "architecture", "atlas.json"),
        JSON.stringify(atlasFor(SHA_A, "2026-08-12T01:00:00Z")),
      );
      let calls = 0;
      svc = new ArchitectureService({
        repoDir: dir,
        dataDir: dir,
        runGit: async () => ok(SHA_A),
        runAnalyzer: async () => {
          calls += 1;
          return { ok: true, log: "" };
        },
      });

      svc.startAutoRefresh(1_000);
      await vi.waitFor(() => {
        expect(existsSync(join(dir, "architecture", "snapshots", `${SHA_A}.json`))).toBe(true);
      });
      expect(calls).toBe(0);
    } finally {
      await svc?.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retries a transient automatic-analysis failure and aborts an active child on stop", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arch-auto-retry-"));
    let svc: ArchitectureService | null = null;
    try {
      let calls = 0;
      let aborted = false;
      svc = new ArchitectureService({
        repoDir: dir,
        dataDir: dir,
        runGit: async () => ok(SHA_A),
        runAnalyzer: async ({ signal }) => {
          calls += 1;
          if (calls === 1) return { ok: false, log: "temporary failure" };
          return await new Promise((resolve) => {
            signal.addEventListener("abort", () => {
              aborted = true;
              resolve({ ok: false, log: "aborted" });
            }, { once: true });
          });
        },
      });

      svc.startAutoRefresh(10);
      await vi.waitFor(() => expect(calls).toBe(2));
      await svc.stop();
      expect(aborted).toBe(true);
    } finally {
      await svc?.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("archives a successful run as snapshots/<commit>.json and lists it once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arch-archive-"));
    try {
      const svc = new ArchitectureService({
        repoDir: dir,
        dataDir: dir,
        runAnalyzer: async () => {
          // A real run writes the atlas; the seam does the same.
          mkdirSync(join(dir, "architecture"), { recursive: true });
          writeFileSync(join(dir, "architecture", "atlas.json"), JSON.stringify(atlasFor(SHA_A, "2026-08-10T01:00:00Z")));
          return { ok: true, log: "" };
        },
      });
      expect(svc.refresh()).toEqual({ started: true });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(existsSync(join(dir, "architecture", "snapshots", `${SHA_A}.json`))).toBe(true);
      const sidecar = join(dir, "architecture", "snapshots", `${SHA_A}.meta.json`);
      expect(JSON.parse(readFileSync(sidecar, "utf8"))).toEqual({
        commit: SHA_A,
        branch: "v4",
        dirty: false,
        generatedAt: "2026-08-10T01:00:00Z",
      });
      // The archived entry and the live atlas are the SAME commit: one entry,
      // flagged current, not a fabricated pair.
      const manifest = await svc.snapshots();
      expect(manifest.snapshots).toHaveLength(1);
      expect(manifest.snapshots[0]).toMatchObject({ commit: SHA_A, current: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not archive — and still succeeds — when the atlas has no usable commit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arch-nocommit-"));
    try {
      const svc = new ArchitectureService({
        repoDir: dir,
        dataDir: dir,
        runAnalyzer: async () => {
          mkdirSync(join(dir, "architecture"), { recursive: true });
          writeFileSync(join(dir, "architecture", "atlas.json"), JSON.stringify(atlasFor("", "2026-08-10T01:00:00Z")));
          return { ok: true, log: "" };
        },
      });
      svc.refresh();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const done = svc.status();
      expect(done && "done" in done && done.ok).toBe(true);
      expect(existsSync(join(dir, "architecture", "snapshots"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lists archived snapshots newest-first with the live atlas marked current", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arch-manifest-"));
    try {
      const archive = join(dir, "architecture", "snapshots");
      mkdirSync(archive, { recursive: true });
      writeFileSync(join(archive, `${SHA_A}.json`), JSON.stringify(atlasFor(SHA_A, "2026-08-01T00:00:00Z")));
      writeFileSync(join(archive, `${SHA_B}.json`), JSON.stringify(atlasFor(SHA_B, "2026-08-05T00:00:00Z")));
      mkdirSync(join(dir, "architecture"), { recursive: true });
      writeFileSync(join(dir, "architecture", "atlas.json"), JSON.stringify(atlasFor(SHA_C, "2026-08-09T00:00:00Z")));
      const svc = new ArchitectureService({ repoDir: dir, dataDir: dir });
      const manifest = await svc.snapshots();
      expect(manifest.snapshots.map((s) => [s.commit, s.current])).toEqual([
        [SHA_C, true],
        [SHA_B, false],
        [SHA_A, false],
      ]);
      // Legacy archives pay for one fallback parse, then every later listing
      // can read the tiny sidecars only.
      expect(existsSync(join(archive, `${SHA_A}.meta.json`))).toBe(true);
      expect(existsSync(join(archive, `${SHA_B}.meta.json`))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lists from a valid sidecar without parsing the full archived atlas", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arch-sidecar-"));
    try {
      const archive = join(dir, "architecture", "snapshots");
      mkdirSync(archive, { recursive: true });
      writeFileSync(join(archive, `${SHA_A}.json`), "not valid JSON");
      writeFileSync(join(archive, `${SHA_A}.meta.json`), JSON.stringify({
        commit: SHA_A,
        branch: "v4",
        dirty: false,
        generatedAt: "2026-08-01T00:00:00Z",
      }));

      const manifest = await new ArchitectureService({ repoDir: dir, dataDir: dir }).snapshots();
      expect(manifest.snapshots).toEqual([{
        commit: SHA_A,
        branch: "v4",
        dirty: false,
        generatedAt: "2026-08-01T00:00:00Z",
        current: false,
      }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("answers the commit axis from git and observes truncation past the limit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arch-commits-"));
    try {
      const line = (sha: string) => `${sha}${SEP}2026-08-10T00:00:00+08:00${SEP}A${SEP}s`;
      const seen: string[][] = [];
      const svc = new ArchitectureService({
        repoDir: dir,
        dataDir: dir,
        runGit: async (args) => {
          seen.push(args);
          return ok([SHA_A, SHA_B, SHA_C].map(line).join("\n"));
        },
      });
      const out = await svc.commits(2);
      expect(seen[0][0]).toBe("log");
      expect(seen[0][1]).toBe("-3"); // limit + 1: truncation is observed
      if ("error" in out) throw new Error(out.error);
      expect(out.commits.map((c) => c.sha)).toEqual([SHA_A, SHA_B]);
      expect(out.truncated).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pages the whole commit axis from one anchored head, even while HEAD moves", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arch-commit-pages-"));
    const git = (args: string[], input?: string) => execFileSync("git", args, {
      cwd: dir,
      input,
      encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" },
    });
    try {
      git(["init", "-q", "-b", "main"]);
      // 1,234 commits through fast-import: far past one 500-commit window.
      const total = 1234;
      const stream: string[] = [];
      for (let i = 1; i <= total; i += 1) {
        const message = `c${i}`;
        stream.push(
          "commit refs/heads/main",
          `mark :${i}`,
          `committer t <t@x> ${1_700_000_000 + i} +0000`,
          `data ${Buffer.byteLength(message)}`,
          message,
          ...(i > 1 ? [`from :${i - 1}`] : []),
          "",
        );
      }
      git(["fast-import", "--quiet"], `${stream.join("\n")}\n`);
      const svc = new ArchitectureService({ repoDir: dir, dataDir: dir });

      const first = await svc.commits(200);
      if ("error" in first) throw new Error(first.error);
      expect(first.commits).toHaveLength(200);
      expect(first.truncated).toBe(true);
      expect(first.next_offset).toBe(200);
      expect(first.head).toBe(first.commits[0]!.sha);

      // A landing after the first window must not shift the older windows.
      git(["commit", "--allow-empty", "-q", "-m", "landed meanwhile"]);

      const seen = first.commits.map((commit) => commit.subject);
      let next = first.next_offset;
      let windows = 0;
      while (next !== undefined) {
        const page = await svc.commits(500, { head: first.head!, offset: next });
        if ("error" in page) throw new Error(page.error);
        expect(page.head).toBe(first.head);
        seen.push(...page.commits.map((commit) => commit.subject));
        next = page.next_offset;
        expect(page.truncated).toBe(next !== undefined);
        windows += 1;
      }
      expect(windows).toBe(3); // 200 + 500 + 500 + 34
      expect(seen).toEqual(Array.from({ length: total }, (_, index) => `c${total - index}`));
      expect(new Set(seen).size).toBe(total);

      expect(await svc.commits(10, { head: "not-a-sha", offset: 0 })).toHaveProperty("error");
      expect(await svc.commits(10, { head: first.head!, offset: -1 })).toHaveProperty("error");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses malformed or reversed ranges before touching git history", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arch-badrange-"));
    try {
      const svc = new ArchitectureService({
        repoDir: dir,
        dataDir: dir,
        runGit: async (args) => (args[0] === "merge-base" ? fail(1) : ok("")),
      });
      expect(await svc.evolutionDiff("nothex", SHA_B)).toHaveProperty("error");
      expect(await svc.evolutionDiff(SHA_A, SHA_A)).toHaveProperty("error");
      // Reversed range: merge-base --is-ancestor says no.
      const reversed = await svc.evolutionDiff(SHA_B, SHA_A);
      expect(reversed).toHaveProperty("error");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prunes an existing archive on reconciliation and degrades cleaned endpoints honestly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arch-retention-"));
    let svc: ArchitectureService | null = null;
    try {
      const architectureDir = join(dir, "architecture");
      const archive = join(architectureDir, "snapshots");
      mkdirSync(archive, { recursive: true });
      const commits = Array.from({ length: 40 }, (_, index) => numberedSha(index + 1));
      const start = Date.parse("2026-01-01T00:00:00Z");
      for (const [index, commit] of commits.entries()) {
        const generatedAt = new Date(start + index * 24 * 60 * 60_000).toISOString();
        writeFileSync(join(archive, `${commit}.json`), JSON.stringify(atlasFor(commit, generatedAt)));
        writeFileSync(join(archive, `${commit}.meta.json`), JSON.stringify({
          commit,
          branch: "v4",
          dirty: false,
          generatedAt,
        }));
      }
      const current = commits.at(-1)!;
      writeFileSync(join(architectureDir, "atlas.json"), JSON.stringify(atlasFor(current, "2026-02-09T00:00:00Z")));
      let diffOrder: string[] | null = null;
      svc = new ArchitectureService({
        repoDir: dir,
        dataDir: dir,
        runGit: async (args) => {
          if (args[0] === "rev-parse") return ok(current);
          if (args[0] === "merge-base") return ok("");
          if (args[0] === "rev-list" && args[1] === "--count") return ok("1");
          if (args[0] === "rev-list") return ok((diffOrder ?? [...commits].reverse()).join("\n"));
          if (args[0] === "log") return ok("");
          return fail();
        },
      });

      svc.startAutoRefresh(1_000);
      await vi.waitFor(() => {
        const dataFiles = readdirSync(archive).filter((name) => /^[0-9a-f]{40}\.json$/.test(name));
        expect(dataFiles.length).toBeLessThanOrEqual(ARCHIVE_RETENTION.max);
      });
      await svc.stop();

      const deleted = commits.filter((commit) => !existsSync(join(archive, `${commit}.json`)));
      expect(deleted.length).toBeGreaterThanOrEqual(2);
      expect(existsSync(join(archive, `${deleted[0]}.meta.json`))).toBe(false);
      expect(existsSync(join(archive, `${current}.json`))).toBe(true);

      // The git window deliberately contains only two commits whose archive
      // files were pruned. The code half still answers; the architecture half
      // must use the documented unavailable DTO rather than throwing.
      diffOrder = [deleted[1], deleted[0]];
      const out = await svc.evolutionDiff(deleted[0], deleted[1]);
      if ("error" in out) throw new Error(out.error);
      expect(out.architecture).toBeNull();
      expect(out.architectureUnavailable).toContain("只显示代码变化");
    } finally {
      await svc?.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("the range diff", () => {
    /** Repo fixture: E(newest) D C B A(oldest); snapshots vary per test. */
    function service(dir: string): ArchitectureService {
      mkdirSync(join(dir, "architecture"), { recursive: true });
      writeFileSync(
        join(dir, "architecture", "atlas.json"),
        // repoDir doubles as dataDir: this file is BOTH the live snapshot and
        // the module-rule config. Rules only matter for code attribution.
        JSON.stringify({
          ...(atlasFor(SHA_E, "2026-08-09T00:00:00Z") as Record<string, unknown>),
          modules: [
            { id: "mod.a", pathPrefixes: ["packages/a/"] },
            { id: "mod.b", pathPrefixes: ["packages/b/"] },
          ],
        }),
      );
      return new ArchitectureService({
        repoDir: dir,
        dataDir: dir,
        runGit: async (args) => {
          if (args[0] === "merge-base") return ok("");
          if (args[0] === "rev-list" && args[1] === "--count") return ok("2");
          if (args[0] === "rev-list") return ok([SHA_E, SHA_D, SHA_C, SHA_B, SHA_A].join("\n"));
          if (args[0] === "log") {
            // The aggregation folds the WHOLE range: no `-N` commit cap.
            if (args.some((arg) => /^-\d+$/.test(arg))) throw new Error(`range log capped: ${args.join(" ")}`);
            return ok(
              [
                `@@${SHA_D}${SEP}2026-08-08T10:00:00+08:00${SEP}Alice${SEP}newest in range`,
                "7\t1\tpackages/a/src/one.ts",
                `@@${SHA_C}${SEP}2026-08-07T10:00:00+08:00${SEP}Bob${SEP}older in range`,
                "2\t2\tdoc/notes.md",
              ].join("\n"),
            );
          }
          return fail();
        },
      });
    }

    it("returns code changes plus the diff of the two nearest snapshots", async () => {
      const dir = mkdtempSync(join(tmpdir(), "arch-diff-"));
      try {
        const archive = join(dir, "architecture", "snapshots");
        mkdirSync(archive, { recursive: true });
        writeFileSync(
          join(archive, `${SHA_A}.json`),
          JSON.stringify(
            atlasFor(SHA_A, "2026-08-01T00:00:00Z", {
              modules: [],
            }),
          ),
        );
        writeFileSync(join(archive, `${SHA_D}.json`), JSON.stringify(atlasFor(SHA_D, "2026-08-08T00:00:00Z")));
        const svc = service(dir);
        const out = await svc.evolutionDiff(SHA_B, SHA_D);
        if ("error" in out) throw new Error(out.error);
        expect(out.from).toBe(SHA_B);
        expect(out.to).toBe(SHA_D);
        // Code half, attributed through the config's module rules.
        expect(out.code.commitCount).toBe(2);
        expect(out.code.modules.map((m) => m.moduleId)).toEqual(["mod.a", UNMAPPED_MODULE]);
        // Architecture half: nearest(B)=A, nearest(D)=D — mod.a appears.
        expect(out.architecture).not.toBeNull();
        expect(out.architecture!.base.commit).toBe(SHA_A);
        expect(out.architecture!.head.commit).toBe(SHA_D);
        expect(out.architecture!.modules.added.map((m) => m.id)).toEqual(["mod.a"]);
        expect(out.architectureUnavailable).toBeUndefined();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("is honest when only ONE snapshot is reachable: code changes only", async () => {
      const dir = mkdtempSync(join(tmpdir(), "arch-thin-"));
      try {
        const svc = service(dir); // live atlas at E is the only snapshot
        const out = await svc.evolutionDiff(SHA_B, SHA_D);
        if ("error" in out) throw new Error(out.error);
        expect(out.architecture).toBeNull();
        expect(out.architectureUnavailable).toContain("只显示代码变化");
        // The code half is still fully served.
        expect(out.code.additions).toBe(9);
        expect(out.code.commits).toHaveLength(2);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
