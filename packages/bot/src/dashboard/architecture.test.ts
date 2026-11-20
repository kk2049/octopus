/**
 * Architecture observatory service: the projection, the single job slot, and
 * the route shape.
 *
 * The analyzer itself is tested in `packages/architecture-observatory`. Here we
 * care about three things only this layer decides: that the ~9 MB atlas is
 * projected down to the stable DTO (and the per-file/symbol/call fact tables
 * are actually DROPPED, not forwarded), that the refresh job is one
 * process-level slot rather than one per caller, and that the GET response
 * keeps its contract shape whether or not a snapshot exists.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store/store.js";
import { ArchitectureService, type ArchitectureView } from "./architecture.js";
import { DashboardServer } from "./server.js";
import { createDashboardTestServer } from "../e2e/dashboard-test-support.js";

const ADMIN = "admin-secret";

/** A tiny hand-built atlas: every projected section, plus the bulk to drop. */
const FIXTURE = {
  schemaVersion: 1,
  meta: {
    systemId: "octopus",
    title: "octopus",
    description: "test atlas",
    generatedAt: "2026-08-09T00:00:00.000Z",
    inputFingerprint: "f".repeat(64),
    commit: "abc1234",
    branch: "dev-test",
    dirty: true,
    root: "/repo",
    analyzer: { dependencyCruiser: "18", typescript: "5.7" },
    limitations: ["no runtime trace"],
  },
  zones: [
    { id: "trusted", label: "可信进程", description: "bot 主进程", color: "#123456", trust: "trusted" },
  ],
  modules: [
    {
      id: "mod.a",
      label: "A",
      description: "module a",
      zone: "trusted",
      criticality: "critical",
      pathPrefixes: ["packages/a"],
      tags: ["tcb"],
      docs: ["doc/a.md"],
      files: 2,
      loc: 300,
      codeLoc: 220,
      testFiles: 1,
      symbols: 4,
      complexity: 9,
      gitTouches: 7,
      runtimeFanIn: 1,
      runtimeFanOut: 0,
      typeOnlyFanIn: 0,
      typeOnlyFanOut: 0,
      fanIn: 1,
      fanOut: 0,
    },
    {
      id: "mod.b",
      label: "B",
      description: "module b",
      zone: "trusted",
      criticality: "normal",
      pathPrefixes: ["packages/b"],
      files: 1,
      loc: 100,
      codeLoc: 80,
      testFiles: 0,
      symbols: 2,
      complexity: 3,
      gitTouches: 31,
      fanIn: 0,
      fanOut: 1,
    },
  ],
  packages: [{ id: "pkg.a", name: "a", path: "packages/a", files: 2, loc: 300, dependencies: [], devDependencies: [] }],
  moduleEcosystem: {
    frontend: [{
      id: "demo.viewer/v1",
      title: "Viewer",
      version: "1.0.0",
      implementation: "@demo/view#Viewer",
      packageId: "@demo/view",
      packagePath: "packages/view",
      slots: ["primary"],
      ports: [{ id: "demo/v1", packageId: "@demo/contract" }],
      opens: ["demo"],
      summary: "用于打开 demo 资源的 Viewer 视图。",
      preview: "detail",
      configKeys: ["source"],
      source: { path: "packages/view/src/manifests.ts", line: 4, excerpt: ["const manifest = …"] },
    }],
    contracts: [{
      id: "demo/v1", packageId: "@demo/contract", packagePath: "packages/contract", summary: "读取演示数据。",
      actions: [{ id: "read", summary: "读取", operation: "read_demo" }],
      source: { path: "packages/contract/src/index.ts", line: 2, excerpt: ["declareContract"] },
      provision: "trusted-provider",
    }],
    backend: [{
      id: "@demo/backend#demoProvider:demo/v1", name: "demoProvider", summary: "可信后端：读取演示数据。",
      packageId: "@demo/backend", path: "packages/backend/src/provider.ts", files: 1, loc: 40, kind: "provider",
      contracts: ["demo/v1"], actions: [{ id: "read", summary: "读取", operation: "read_demo" }],
      registered: true, dependencies: [], source: { path: "packages/backend/src/provider.ts", line: 8 },
    }],
    dependencies: [
      { from: "frontend:@demo/view:demo.viewer/v1", to: "contract:demo/v1", kind: "requires", label: "demo/v1" },
      { from: "contract:demo/v1", to: "backend:@demo/backend#demoProvider:demo/v1", kind: "provides", label: "可信实现" },
    ],
    issues: [{ message: "one unreadable manifest", source: { path: "packages/view/src/bad.ts", line: 2, excerpt: ["bad"] } }],
  },
  files: [
    {
      id: "file.a",
      path: "packages/a/src/a.ts",
      moduleId: "mod.a",
      isTest: false,
      loc: 200,
      codeLoc: 160,
      git: { touches: 7, additions: 10, deletions: 2 },
      declarationCount: 3,
      complexity: 6,
    },
    {
      id: "file.a.test",
      path: "packages/a/src/a.test.ts",
      moduleId: "mod.a",
      isTest: true,
      loc: 100,
      codeLoc: 60,
      git: { touches: 99, additions: 5, deletions: 1 },
      declarationCount: 1,
      complexity: 3,
    },
    {
      id: "file.b",
      path: "packages/b/src/b.ts",
      moduleId: "mod.b",
      isTest: false,
      loc: 100,
      codeLoc: 80,
      git: { touches: 31, additions: 4, deletions: 4 },
      declarationCount: 2,
      complexity: 3,
    },
  ],
  dependencies: [
    {
      id: "dep.1",
      from: "mod.b",
      to: "mod.a",
      runtimeCount: 2,
      typeOnlyCount: 1,
      testCount: 0,
      dynamicCount: 0,
      circular: false,
      samples: [
        {
          source: { path: "packages/b/src/b.ts", line: 3, endLine: 3, excerpt: ["import { a } from ..."] },
          specifier: "@x/a",
          typeOnly: false,
          dynamic: false,
          test: false,
        },
      ],
    },
  ],
  externalDependencies: [],
  symbols: [{ id: "sym.1" }, { id: "sym.2" }, { id: "sym.3" }],
  calls: [{ id: "call.1", from: "sym.1", to: "sym.2", count: 4, samples: [] }],
  annotations: [
    { id: "ann.1", attributes: { flow: "f1", step: "s1" }, source: { path: "packages/a/src/a.ts", line: 10 } },
    { id: "ann.2", attributes: { flow: "f1", step: "s2" }, source: { path: "packages/zzz/unknown.ts", line: 1 } },
  ],
  flows: [
    {
      id: "f1",
      title: "flow one",
      description: "d",
      perspective: "authority",
      coverage: { mode: "critical-branches", scope: "the gate", exclusions: ["startup"] },
      steps: [
        {
          id: "s1",
          label: "step one",
          zone: "trusted",
          after: [],
          role: "gate",
          condition: "authorized",
          outcome: "admitted",
          authority: "route table",
          source: { path: "packages/a/src/a.ts", line: 10, symbol: "gate", excerpt: ["..."] },
          enforces: ["C-1"],
        },
        { id: "s2", label: "step two", zone: "trusted", terminal: true, enforces: [] },
      ],
      missingAnchors: [],
      duplicateAnchors: [],
      missingPredecessors: [],
      cycles: [],
      invalidAttributes: [],
    },
  ],
  constraints: [
    {
      id: "C-1",
      title: "no b→a",
      description: "b must not import a",
      concern: "modularity",
      severity: "high",
      mechanism: { kind: "forbid-dependency", from: ["mod.b"], to: ["mod.a"] },
      status: "fail",
      summary: "1 violation",
      violations: [{ message: "b imports a", source: { path: "packages/b/src/b.ts", line: 3 } }],
      evidence: [{ grade: "executable", label: "dep graph", source: { path: "packages/b/src/b.ts", line: 3 } }],
    },
  ],
  tcbs: [
    {
      constraintId: "C-TCB",
      budgetFile: "tcb.json",
      entries: ["packages/a/src/a.ts"],
      files: [{ path: "packages/a/src/a.ts", codeLoc: 160, critical: true }],
      total: 160,
      baseline: 150,
      tolerance: 20,
      delta: 10,
      unregistered: ["packages/b/src/b.ts"],
      stale: [],
    },
  ],
  findings: [
    {
      id: "find.1",
      severity: "high",
      title: "violation of C-1",
      description: "b reaches into a",
      moduleIds: ["mod.b"],
      source: { path: "packages/b/src/b.ts", line: 3 },
      constraintId: "C-1",
      signal: "violation",
    },
  ],
};

function writeSnapshot(dataDir: string, atlas: unknown): void {
  mkdirSync(join(dataDir, "architecture"), { recursive: true });
  writeFileSync(join(dataDir, "architecture", "atlas.json"), JSON.stringify(atlas));
}

describe("atlas projection", () => {
  let dir: string;
  let view: ArchitectureView;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "arch-proj-"));
    writeSnapshot(dir, FIXTURE);
    const svc = new ArchitectureService({ repoDir: dir, dataDir: dir });
    const got = await svc.view();
    expect(got).not.toBeNull();
    view = got!;
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps exactly the DTO sections — the fact tables are dropped, not forwarded", () => {
    expect(Object.keys(view).sort()).toEqual([
      "constraints",
      "dependencies",
      "findings",
      "flows",
      "hotspots",
      "meta",
      "moduleEcosystem",
      "modules",
      "tcb",
      "zones",
    ]);
    // The three tables that make the atlas 9 MB never reach the wire.
    expect(view).not.toHaveProperty("files");
    expect(view).not.toHaveProperty("symbols");
    expect(view).not.toHaveProperty("calls");
  });

  it("projects the automatic frontend/backend module ecosystem without source excerpts", () => {
    expect(view.moduleEcosystem).toEqual({
      frontend: [{
        id: "demo.viewer/v1",
        title: "Viewer",
        version: "1.0.0",
        implementation: "@demo/view#Viewer",
        packageId: "@demo/view",
        packagePath: "packages/view",
        slots: ["primary"],
        ports: [{ id: "demo/v1", packageId: "@demo/contract" }],
        opens: ["demo"],
        summary: "用于打开 demo 资源的 Viewer 视图。",
        preview: "detail",
        configKeys: ["source"],
        source: { path: "packages/view/src/manifests.ts", line: 4 },
      }],
      contracts: [{
        id: "demo/v1", packageId: "@demo/contract", packagePath: "packages/contract", summary: "读取演示数据。",
        actions: [{ id: "read", summary: "读取", operation: "read_demo" }],
        source: { path: "packages/contract/src/index.ts", line: 2 }, provision: "trusted-provider",
      }],
      backend: [{
        id: "@demo/backend#demoProvider:demo/v1", name: "demoProvider", summary: "可信后端：读取演示数据。",
        packageId: "@demo/backend", path: "packages/backend/src/provider.ts", files: 1, loc: 40, kind: "provider",
        contracts: ["demo/v1"], actions: [{ id: "read", summary: "读取", operation: "read_demo" }],
        registered: true, dependencies: [], source: { path: "packages/backend/src/provider.ts", line: 8 },
      }],
      dependencies: [
        { from: "frontend:@demo/view:demo.viewer/v1", to: "contract:demo/v1", kind: "requires", label: "demo/v1" },
        { from: "contract:demo/v1", to: "backend:@demo/backend#demoProvider:demo/v1", kind: "provides", label: "可信实现" },
      ],
      issues: [{ message: "one unreadable manifest", source: { path: "packages/view/src/bad.ts", line: 2 } }],
    });
  });

  it("projects meta and derives the totals from the dropped tables", () => {
    expect(view.meta).toEqual({
      commit: "abc1234",
      branch: "dev-test",
      dirty: true,
      generatedAt: "2026-08-09T00:00:00.000Z",
      totals: { files: 3, codeLoc: 300, symbols: 3, calls: 1, annotations: 2 },
    });
  });

  it("counts @architecture anchors per module via the file table", () => {
    const a = view.modules.find((m) => m.id === "mod.a")!;
    const b = view.modules.find((m) => m.id === "mod.b")!;
    // ann.1 lives in mod.a's file; ann.2 names a path no module owns.
    expect(a.annotations).toBe(1);
    expect(b.annotations).toBe(0);
    expect(a).toEqual({
      id: "mod.a",
      label: "A",
      description: "module a",
      zone: "trusted",
      criticality: "critical",
      tags: ["tcb"],
      docs: ["doc/a.md"],
      files: 2,
      codeLoc: 220,
      testFiles: 1,
      gitTouches: 7,
      runtimeFanIn: 1,
      runtimeFanOut: 0,
      typeOnlyFanIn: 0,
      typeOnlyFanOut: 0,
      fanIn: 1,
      fanOut: 0,
      annotations: 1,
    });
    // Optional model fields default to empty rather than leaking undefined.
    expect(b.tags).toEqual([]);
    expect(b.docs).toEqual([]);
  });

  it("flattens dependency samples to path/line/specifier", () => {
    expect(view.dependencies).toEqual([
      {
        from: "mod.b",
        to: "mod.a",
        runtimeCount: 2,
        typeOnlyCount: 1,
        testCount: 0,
        dynamicCount: 0,
        circular: false,
        // No excerpt, no endLine, no typeOnly flag: the DTO sample is 3 fields.
        samples: [{ path: "packages/b/src/b.ts", line: 3, specifier: "@x/a" }],
      },
    ]);
  });

  it("projects flows with bare source locations and defaulted after[]", () => {
    const flow = view.flows[0];
    expect(flow.coverage).toEqual({ mode: "critical-branches", scope: "the gate", exclusions: ["startup"] });
    expect(flow.steps[0]).toEqual({
      id: "s1",
      label: "step one",
      zone: "trusted",
      after: [],
      role: "gate",
      condition: "authorized",
      outcome: "admitted",
      authority: "route table",
      // symbol/excerpt dropped; enforces is not part of the DTO.
      source: { path: "packages/a/src/a.ts", line: 10 },
    });
    expect(flow.steps[1]).toEqual({ id: "s2", label: "step two", zone: "trusted", after: [], terminal: true });
  });

  it("projects constraints with mechanismKind and bounded violations/evidence", () => {
    expect(view.constraints).toEqual([
      {
        id: "C-1",
        title: "no b→a",
        description: "b must not import a",
        concern: "modularity",
        severity: "high",
        status: "fail",
        mechanismKind: "forbid-dependency",
        summary: "1 violation",
        violations: [{ message: "b imports a", source: { path: "packages/b/src/b.ts", line: 3 } }],
        evidence: [{ grade: "executable", label: "dep graph", source: { path: "packages/b/src/b.ts", line: 3 } }],
      },
    ]);
  });

  it("folds a finding's title and description into one message", () => {
    expect(view.findings).toEqual([
      {
        signal: "violation",
        severity: "high",
        message: "violation of C-1 — b reaches into a",
        moduleIds: ["mod.b"],
        source: { path: "packages/b/src/b.ts", line: 3 },
      },
    ]);
  });

  it("maps the first TCB fact onto the DTO's single tcb block", () => {
    expect(view.tcb).toEqual({
      label: "C-TCB",
      lines: 160,
      baseline: 150,
      tolerance: 20,
      files: [{ path: "packages/a/src/a.ts", loc: 160 }],
      unregistered: ["packages/b/src/b.ts"],
      stale: [],
    });
  });

  it("recomputes hotspots from non-test files, codeLoc × log2(touches+1)", () => {
    // file.b: 80 × log2(32) = 400 beats file.a: 160 × log2(8) = 480? No:
    // 160 × 3 = 480 > 80 × 5 = 400. The test file (touches 99) must not appear.
    expect(view.hotspots.map((h) => h.path)).toEqual(["packages/a/src/a.ts", "packages/b/src/b.ts"]);
    expect(view.hotspots[0]).toEqual({
      moduleId: "mod.a",
      path: "packages/a/src/a.ts",
      codeLoc: 160,
      touches: 7,
      score: 480,
    });
  });

  it("caches by file identity and re-projects when the snapshot changes", async () => {
    const dir2 = mkdtempSync(join(tmpdir(), "arch-cache-"));
    try {
      writeSnapshot(dir2, FIXTURE);
      const svc = new ArchitectureService({ repoDir: dir2, dataDir: dir2 });
      const first = await svc.view();
      expect(await svc.view()).toBe(first); // same parse, not a re-read
      // A refreshed snapshot (different size, so the cache key changes even on
      // filesystems with coarse mtime) is picked up on the next read.
      writeSnapshot(dir2, { ...FIXTURE, meta: { ...FIXTURE.meta, commit: "def5678-longer" } });
      expect((await svc.view())!.meta.commit).toBe("def5678-longer");
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});

describe("the refresh job slot", () => {
  it("is one per process: a second refresh while one runs is refused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arch-job-"));
    try {
      let release!: (v: { ok: boolean; log: string }) => void;
      const hang = new Promise<{ ok: boolean; log: string }>((resolve) => {
        release = resolve;
      });
      let calls = 0;
      const svc = new ArchitectureService({
        repoDir: dir,
        dataDir: dir,
        runAnalyzer: () => {
          calls += 1;
          return hang;
        },
      });

      expect(svc.status()).toBeNull();
      expect(svc.refresh()).toEqual({ started: true });
      const running = svc.status();
      expect(running && "running_since" in running && !("done" in running)).toBe(true);

      // Second slot ask: refused, and told whose run it is waiting on.
      const second = svc.refresh();
      expect(second.started).toBe(false);
      if (!second.started) {
        expect(second.running_since).toBe((running as { running_since: string }).running_since);
      }
      expect(calls).toBe(1);

      // A failing run resolves INTO the slot (log tail, never a rejection)…
      release({ ok: false, log: "x".repeat(5000) });
      await new Promise((resolve) => setTimeout(resolve, 0));
      const done = svc.status();
      expect(done && "done" in done && done.ok === false).toBe(true);
      if (done && "done" in done) expect(done.error).toHaveLength(4000);

      // …and a finished slot is free again.
      expect(svc.refresh()).toEqual({ started: true });
      expect(calls).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("turns a throwing seam into a done/failed record, never a rejection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arch-throw-"));
    try {
      const svc = new ArchitectureService({
        repoDir: dir,
        dataDir: dir,
        runAnalyzer: () => Promise.reject(new Error("spawn ENOENT")),
      });
      expect(svc.refresh()).toEqual({ started: true });
      await new Promise((resolve) => setTimeout(resolve, 0));
      const done = svc.status();
      expect(done && "done" in done && done.ok === false).toBe(true);
      if (done && "done" in done) expect(done.error).toContain("spawn ENOENT");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("architecture routes", () => {
  let dir: string;
  let store: Store;
  let dash: DashboardServer;
  let base: string;
  let release!: (v: { ok: boolean; log: string }) => void;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "arch-routes-"));
    store = new Store(join(dir, "t.db"));
    const svc = new ArchitectureService({
      repoDir: dir,
      dataDir: dir,
      runAnalyzer: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      // The evolution reads go through git; the seam answers one commit.
      runGit: async (args) =>
        args[0] === "log"
          ? {
              ok: true,
              stdout: ["f".repeat(40), "2026-08-10T00:00:00+08:00", "A", "subject"].join("\u001f"),
              stderr: "",
              code: 0,
            }
          : { ok: false, stdout: "", stderr: "not a repo", code: 128 },
    });
    dash = createDashboardTestServer(store, undefined, {
      port: 0,
      host: "127.0.0.1",
      authToken: ADMIN,
      architecture: svc,
    });
    await dash.start();
    base = `http://127.0.0.1:${dash.port}`;
  });

  afterAll(async () => {
    await dash?.stop();
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const get = () => fetch(`${base}/api/architecture`, { headers: { authorization: `Bearer ${ADMIN}` } });
  const post = () =>
    fetch(`${base}/api/architecture/refresh`, { method: "POST", headers: { authorization: `Bearer ${ADMIN}` } });

  it("rejects anonymous callers", async () => {
    expect((await fetch(`${base}/api/architecture`)).status).toBe(401);
  });

  it("answers {generated:false, job:null} with NO snapshot key before any run", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ generated: false, job: null });
    expect("snapshot" in body).toBe(false);
  });

  it("starts one job with 202, reports busy with 200, and rides state on the GET", async () => {
    const started = await post();
    expect(started.status).toBe(202);
    expect(await started.json()).toEqual({ ok: true });

    const busy = await post();
    expect(busy.status).toBe(200);
    const busyBody = (await busy.json()) as { ok: boolean; reason: string; running_since: string };
    expect(busyBody.ok).toBe(false);
    expect(busyBody.reason).toBe("busy");
    expect(typeof busyBody.running_since).toBe("string");

    // The GET carries the job — there is no separate status route to drift.
    const during = (await (await get()).json()) as { job: { running_since?: string } };
    expect(during.job.running_since).toBe(busyBody.running_since);

    release({ ok: true, log: "done" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const after = (await (await get()).json()) as { generated: boolean; job: { done?: boolean; ok?: boolean } };
    // The seam wrote no snapshot file, and the response says exactly that.
    expect(after.generated).toBe(false);
    expect(after.job.done).toBe(true);
    expect(after.job.ok).toBe(true);
  });

  it("serves the projection once a snapshot exists", async () => {
    writeSnapshot(dir, FIXTURE);
    const body = (await (await get()).json()) as { generated: boolean; snapshot?: ArchitectureView };
    expect(body.generated).toBe(true);
    expect(body.snapshot?.meta.commit).toBe("abc1234");
    expect(body.snapshot?.modules).toHaveLength(2);
  });

  it("serves the evolution reads behind the same gate", async () => {
    // Anonymous: the route table refuses before any handler runs.
    for (const path of ["/api/architecture/commits", "/api/architecture/snapshots", "/api/architecture/diff"]) {
      expect((await fetch(`${base}${path}`)).status, path).toBe(401);
    }
    const auth = { headers: { authorization: `Bearer ${ADMIN}` } };
    const commits = (await (await fetch(`${base}/api/architecture/commits?limit=5`, auth)).json()) as {
      commits: Array<{ sha: string }>;
      truncated: boolean;
    };
    expect(commits.commits.map((c) => c.sha)).toEqual(["f".repeat(40)]);
    expect(commits.truncated).toBe(false);
    expect(commits).toMatchObject({ head: "f".repeat(40) });
    expect(commits).not.toHaveProperty("next_offset");
    // An older window names its anchor and offset; a malformed cursor is the caller's 400.
    for (const query of ["head=xyz&offset=0", `head=${"f".repeat(40)}&offset=-1`, `head=${"f".repeat(40)}`]) {
      expect((await fetch(`${base}/api/architecture/commits?${query}`, auth)).status, query).toBe(400);
    }

    // The snapshot written by the previous test IS the manifest, marked current.
    const snapshots = (await (await fetch(`${base}/api/architecture/snapshots`, auth)).json()) as {
      snapshots: Array<{ commit: string; current: boolean }>;
    };
    expect(snapshots.snapshots).toEqual([
      expect.objectContaining({ commit: "abc1234", current: true }),
    ]);

    // Malformed endpoints are the caller's 400, not a 500.
    const bad = await fetch(`${base}/api/architecture/diff?from=xyz&to=abc`, auth);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBeTruthy();
  });

  it("404s when the composition has no architecture service", async () => {
    const dir2 = mkdtempSync(join(tmpdir(), "arch-off-"));
    const store2 = new Store(join(dir2, "t.db"));
    const d2 = createDashboardTestServer(store2, undefined, { port: 0, host: "127.0.0.1", authToken: ADMIN });
    await d2.start();
    try {
      for (const [method, path] of [
        ["GET", "/api/architecture"],
        ["POST", "/api/architecture/refresh"],
        ["GET", "/api/architecture/commits"],
        ["GET", "/api/architecture/snapshots"],
        ["GET", "/api/architecture/diff"],
        ["GET", "/architecture"],
      ] as const) {
        const res = await fetch(`http://127.0.0.1:${d2.port}${path}`, {
          method,
          headers: { authorization: `Bearer ${ADMIN}` },
        });
        expect(res.status, `${method} ${path}`).toBe(404);
      }
    } finally {
      await d2.stop();
      store2.close();
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});
