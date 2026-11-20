import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assembleSnapshot, buildGraph, type BuildResult } from "./build.js";
import { acknowledgementSet, buildPathContext, buildStartupPack } from "./context-pack.js";
import { GraphDb } from "./graph-db.js";
import { buildContextualRecords } from "./contextual-record.js";
import { KnowledgeRetriever, type SimilarityIndex } from "./retrieval.js";
import { validateCapabilities } from "./sources/capabilities.js";
import { validateCuratedRecord } from "./sources/curated.js";
import type { RuntimeInputs } from "./sources/landings.js";
import type { KnowledgeEdge, KnowledgeNode } from "./model.js";

const OBSERVED_AT = "2026-08-21T00:00:00.000Z";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" }).trim();
}

function write(root: string, file: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
}

function fixtureRepo(): { root: string; firstSha: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-fixture-"));
  git(root, ["init", "-q", "-b", "main"]);
  write(root, "AGENTS.md", "# Rules\n\n- Land through the landing door; never commit to the watermark directly.\n");
  write(root, ".claude/rules/frontend.md", [
    "---",
    "paths:",
    '  - "packages/web/**/*"',
    "---",
    "# Frontend stability",
    "",
    "## Interaction state",
    "",
    "- Key user-owned interaction state by stable semantic identity, never a list index.",
    "- Stale responses must be dropped, never applied to shared state.",
    "",
  ].join("\n"));
  write(root, ".claude/rules/global.md", "---\npaths:\n  - \"**/*.ts\"\n---\n# TypeScript\n\n- The repository is ESM; use import, not require().\n");
  // A partial-name wildcard segment: must anchor to the packages it matches, never to `packages/`.
  write(root, ".claude/rules/apps.md", "---\npaths:\n  - \"packages/app-*/**/*\"\n---\n# Apps\n\n- App views render only their own publisher's data and never import the API.\n");
  write(root, "packages/app-one/index.ts", "export const one = 1;\n");
  write(root, "architecture/atlas.json", JSON.stringify({
    system: { id: "fixture", title: "Fixture", description: "" },
    zones: [
      { id: "browser", label: "Browser", description: "untrusted browser code", color: "#000", trust: "untrusted" },
      { id: "server", label: "Server", description: "trusted server code", color: "#111", trust: "trusted" },
    ],
    modules: [
      { id: "web", label: "Web UI", description: "menus and routing", zone: "browser", criticality: "high", pathPrefixes: ["packages/web/"], tags: ["browser"], docs: ["packages/web/CLAUDE.md"] },
      { id: "api", label: "API", description: "server handlers", zone: "server", criticality: "critical", pathPrefixes: ["packages/api/"] },
    ],
    flows: [{ id: "request", title: "Request", description: "http to handler", perspective: "authority", entrySteps: [{ id: "in", label: "in", zone: "server", module: "api" }] }],
    constraints: [{
      id: "TRUST-001",
      title: "Web must not import the API",
      description: "browser code cannot depend on server internals",
      concern: "trust",
      severity: "critical",
      mechanism: { kind: "forbid-dependency", from: ["web"], to: ["api"] },
      evidence: [{ grade: "executable", label: "dependency test", source: { path: "packages/web/dep.test.ts", line: 1 }, command: "npx vitest run packages/web/dep.test.ts" }],
    }],
  }, null, 2));
  write(root, "architecture/capabilities.json", JSON.stringify({
    version: 1,
    capabilities: [
      { id: "web.navigation", kind: "product", label: "Navigation", description: "Menu and routing", aliases: ["导航", "菜单", "navigation", "menu"], modules: ["web"], constraints: ["TRUST-001"] },
      { id: "concern.stability", kind: "concern", label: "Stability", description: "State survives refresh", aliases: ["stable", "稳定"], modules: ["web"] },
    ],
  }, null, 2));
  write(root, "packages/web/CLAUDE.md", [
    "# Web UI",
    "",
    "## Rules",
    "",
    "- Selection is keyed by resourceId and survives a roster refresh.",
    "",
    "## Click not hover（2026-08-01，工单 #5）",
    "",
    "The menu opens on click, not hover, because touch devices have no hover state.",
    "",
  ].join("\n"));
  write(root, "packages/web/menu.ts", "export const menu = 1;\n");
  write(root, "packages/web/dep.test.ts", "// dependency test\n");
  write(root, "packages/web/menu.test.ts", "// menu test\n");
  write(root, "doc/adr/0001-menu-click.md", "# ADR 0001: Menus are click-driven\n\n- 状态：**已接受并实现**（2026-08-01）\n\n## 决定\n\n- Menus open on click so that touch devices behave like pointers.\n\n## 拒绝的方案\n\n- Hover-opened menus were rejected because touch has no hover.\n\n## 现状实现\n\n- `packages/web/menu.ts`\n");
  write(root, "doc/adr/0002-old-menu.md", "---\ndecision_status: superseded\nrealization_status: implemented\nsuperseded_by: []\n---\n# ADR 0002: Hover menus\n\n## 决定\n\n- Menus open on hover for desktop users.\n");
  write(root, "doc/adr/0003-menu-v2.md", "---\ndecision_status: accepted\nrealization_status: planned\nsupersedes: [\"0002\"]\ntickets: [5]\n---\n# ADR 0003: Menu v2\n\n## 决定\n\n- Menu v2 will add keyboard navigation.\n");
  write(root, "doc/deliveries/2026-08-02-menu.md", "---\ntickets: [5]\n---\n# Menu delivery\n\n## 结果\n\nThe menu now opens on click.\n\n## 没改什么\n\n- Did not add hover previews to the menu.\n\n## 风险与回滚\n\n- Touch devices without synthetic click events need a manual check.\n\n## 关键文件\n\n- `packages/web/menu.ts`\n");
  write(root, "architecture/knowledge/patterns.jsonl", `${JSON.stringify({
    id: "menu-state-loss",
    title: "Menu loses selection after refresh",
    detail: "Tickets 5 and 6 both lost the selected entry when the roster refreshed.",
    capabilities: ["web.navigation"],
    tickets: [5, 6],
    modules: ["web"],
    tests: ["packages/web/menu.test.ts"],
    mandatory_facts: ["selected entry id", "refresh generation"],
    confidence: 0.9,
  })}\n`);
  write(root, "architecture/knowledge/curated/b01.jsonl", [
    JSON.stringify({ id: "cur:cli:1", kind: "principle", statement: "Navigation preserves the user's active discussion context.", source: { type: "cli_message", ref: "cli:codex:example#line:9", sha: "a".repeat(64) }, capabilities: ["web.navigation"], status: "active", certainty: "inferred", rationale: "Historical CLI discussion; authenticated author unknown." }),
    JSON.stringify({ id: "cur:b01:5:1", kind: "requirement", statement: "Add hover previews to the menu for desktop users.", ticket: 5, source: { type: "ticket_body", ref: "ticket:5" }, capabilities: ["web.navigation"], modules: ["web"], status: "active", certainty: "exact", rationale: "Opening request of #5", quote: "请加上悬停预览" }),
    JSON.stringify({ id: "cur:b01:5:2", kind: "decision", statement: "Menus open on hover when a pointer is present.", ticket: 5, source: { type: "ticket_message", ref: "ticket:5", message_id: 12 }, capabilities: ["web.navigation"], modules: ["web"], status: "superseded", superseded_by: "cur:b01:6:1", certainty: "exact", rationale: "Reversed by #6" }),
    JSON.stringify({ id: "cur:b01:6:1", kind: "decision", statement: "Menus open on click only; hover never opens a menu.", ticket: 6, source: { type: "ticket_message", ref: "ticket:6", message_id: 30 }, capabilities: ["web.navigation"], modules: ["web"], status: "active", supersedes: ["cur:b01:5:2"], certainty: "exact", rationale: "User confirmed in #6", realized_by: ["packages/web/menu.ts"], verified_by: ["packages/web/menu.test.ts"] }),
    JSON.stringify({ id: "cur:b01:6:2", kind: "risk", statement: "Hover-only affordances disappear entirely on touch devices.", ticket: 6, source: { type: "ticket_body", ref: "ticket:6" }, capabilities: ["web.navigation"], status: "active", certainty: "ambiguous", conflict_note: "Unclear whether hover previews were ever shipped", rationale: "Inferred from #6 discussion" }),
  ].join("\n") + "\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "fixture"]);
  const firstSha = git(root, ["rev-parse", "HEAD"]);
  write(root, "doc/cli-reports/2026-08-03-menu-report.json", JSON.stringify({
    version: 2,
    base_sha: firstSha,
    title: "Menu click landing",
    summary: "Menus open on click.",
    requester: "t",
    requirements: ["Menus open on click"],
    decisions: ["Hover is never an opener"],
    non_goals: ["No keyboard navigation yet"],
    risks: ["Touch devices need manual verification"],
    supersedes: [],
    verification: ["vitest passed"],
    acceptance: ["Menu opens on click in production"],
  }, null, 2));
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "report"]);
  return { root, firstSha };
}

const runtime: RuntimeInputs = {
  tickets: [
    { id: 5, title: "菜单需要悬停预览", requester: "alice", kind: "simple", dev_status: "landed", created_at: "2026-08-01T00:00:00.000Z", landed_at: "2026-08-02T00:00:00.000Z", commit_sha: null, parent_ticket_id: null },
    { id: 6, title: "菜单改为点击打开", requester: "bob", kind: "simple", dev_status: "landed", created_at: "2026-08-05T00:00:00.000Z", landed_at: "2026-08-06T00:00:00.000Z", commit_sha: null, parent_ticket_id: 5, actor_kind: "token" },
    { id: 7, title: "取消的工单", requester: "carol", kind: "simple", dev_status: "cancelled", created_at: "2026-08-07T00:00:00.000Z", landed_at: null, commit_sha: null, parent_ticket_id: null },
  ],
  landings: [{
    id: 1,
    ticket_id: 6,
    from_sha: "a".repeat(40),
    to_sha: "b".repeat(40),
    landed_at: "2026-08-06T00:00:00.000Z",
    source: "devpipe",
    report_path: null,
    summary: "Menu opens on click",
    changed_files: ["packages/web/menu.ts"],
    changed_modules: ["web"],
    knowledge: {
      summary: "Menu opens on click",
      requirements: ["Menu must open on click for touch users"],
      decisions: ["Click is the only opener"],
      non_goals: [],
      risks: [],
      verification: ["menu.test.ts passed"],
      context_keys: [],
      supersedes: ["landing:0:decision:9"],
    },
  }],
};

describe("knowledge graph build", () => {
  let root: string;
  let result: BuildResult;
  let graph: GraphDb;

  beforeAll(async () => {
    ({ root } = fixtureRepo());
    result = await buildGraph({ repoDir: root, ref: "HEAD", runtime, observedAt: OBSERVED_AT });
    graph = GraphDb.openInMemory();
    graph.fill(result.snapshot);
  }, 30_000);

  afterAll(() => {
    graph?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("is deterministic for identical inputs", async () => {
    const again = await buildGraph({ repoDir: root, ref: "HEAD", runtime, observedAt: OBSERVED_AT });
    expect(again.snapshot.nodes).toEqual(result.snapshot.nodes);
    expect(again.snapshot.edges).toEqual(result.snapshot.edges);
    expect(again.snapshot.meta.input_fingerprint).toBe(result.snapshot.meta.input_fingerprint);
  });

  it("projects every authority into typed nodes with bounded statements", () => {
    const counts = graph.counts().byKind;
    for (const kind of ["principle", "decision", "non_goal", "risk", "requirement", "capability", "module", "constraint", "pattern", "landing", "ticket", "doc", "evidence"]) {
      expect(counts[kind], kind).toBeGreaterThan(0);
    }
    for (const node of graph.allNodes()) {
      expect(node.statement.length).toBeLessThanOrEqual(400);
      expect(node.statement).not.toContain("请加上悬停预览"); // quotes stay in metadata, never in statements
    }
    expect(graph.node("ticket:7")?.status).toBe("rejected");
    expect(graph.node("ticket:5")?.metadata?.requester).toBe("alice");
    expect(graph.node("requirement:cur:b01:5:1")?.metadata?.origins).toEqual([
      { ticket: 5, requester: "alice", role: "task_evolution" },
    ]);
  });

  it("connects an authored specification to exact implementation and test artifacts", () => {
    const id = "decision:cur:b01:6:1";
    const implementation = graph.edgesFrom(id, ["realized_by"]);
    const verification = graph.edgesFrom(id, ["verified_by"]);
    expect(implementation).toHaveLength(1);
    expect(verification).toHaveLength(1);
    expect(graph.node(implementation[0]!.to_id)?.metadata?.path).toBe("packages/web/menu.ts");
    expect(graph.node(verification[0]!.to_id)?.metadata?.path).toBe("packages/web/menu.test.ts");
    expect(verification[0]?.certainty).toBe("exact");
  });

  it("exports CLI historical evidence without confusing its message digest with a Git SHA", () => {
    const node = graph.node("principle:cur:cli:1");
    expect(node?.metadata?.source).toMatchObject({ sha: "a".repeat(64) });
    const record = buildContextualRecords(graph).records.find((item) => item.id === node?.id);
    expect(record?.source_sha).toBe(graph.meta().commit);
    expect(record?.source_ref).toBe("cli:codex:example#line:9");
  });

  it("links path-scoped rules to modules and keeps global rules out of the graph's edges", () => {
    const principles = graph.nodesByKind("principle");
    const scoped = principles.find((node) => node.statement.startsWith("Key user-owned interaction state"));
    const global = principles.find((node) => node.statement.startsWith("The repository is ESM"));
    const alwaysOn = principles.find((node) => node.statement.startsWith("Land through the landing door"));
    expect(scoped && graph.edgesFrom(scoped.id, ["governs"]).map((edge) => edge.to_id)).toContain("module:web");
    expect(global?.metadata?.global).toBe(true);
    expect(global && graph.edgesFrom(global.id, ["governs"])).toEqual([]);
    expect(alwaysOn?.authority).toBe("always_on");
  });

  it("anchors a partial-name wildcard glob to the packages it matches, not to their common prefix", () => {
    const app = graph.nodesByKind("principle").find((node) => node.statement.startsWith("App views render"));
    const targets = app ? graph.edgesFrom(app.id, ["governs"]).map((edge) => edge.to_id) : [];
    expect(targets).toContain("path:packages/app-one/");
    expect(targets).not.toContain("path:packages/");
    // The web package is not an app: nothing from the apps rule reaches it.
    const retriever = new KnowledgeRetriever(graph);
    const web = retriever.expandFromPaths(["packages/web/menu.ts"]);
    expect(web.principles.some((node) => node.statement.startsWith("App views render"))).toBe(false);
    expect(retriever.expandFromPaths(["packages/app-one/index.ts"]).principles.some((node) => node.statement.startsWith("App views render"))).toBe(true);
  });

  it("reads ADR lifecycle on both axes and records rejected alternatives", () => {
    const adr1 = graph.node("decision:adr:0001");
    expect(adr1).toMatchObject({ status: "active", realization: "implemented", authority: "adr" });
    expect(graph.edgesFrom("decision:adr:0001", ["realizes"]).map((edge) => edge.to_id)).toContain("module:web");
    const rejected = graph.edgesFrom("decision:adr:0001", ["rejects"]);
    expect(rejected).toHaveLength(1);
    expect(graph.node(rejected[0].to_id)?.status).toBe("rejected");
    expect(graph.node("decision:adr:0002")?.status).toBe("superseded");
    expect(graph.node("decision:adr:0003")).toMatchObject({ status: "active", realization: "planned" });
  });

  it("applies curated supersession and routes conflicts instead of resolving them", () => {
    expect(graph.node("decision:cur:b01:5:2")).toMatchObject({ status: "superseded" });
    expect(graph.node("decision:cur:b01:5:2")?.metadata?.superseded_by).toBe("decision:cur:b01:6:1");
    const rules = graph.conflicts().map((conflict) => conflict.rule);
    expect(rules).toContain("supersedes_not_mutual");
    expect(rules).toContain("dangling_supersedes");
    expect(rules).not.toContain("non_goal_vs_requirement");
    expect(graph.node("requirement:cur:b01:5:1")?.status).toBe("active");
  });

  it("projects CLI reports and landings with exact ranges", () => {
    const landings = graph.nodesByKind("landing");
    expect(landings.map((node) => node.statement)).toEqual(expect.arrayContaining(["Menu click landing", "Menu opens on click"]));
    const ticketLanding = graph.node("landing:1");
    expect(ticketLanding?.metadata?.ticket_id).toBe(6);
    expect(graph.edgesFrom("landing:1", ["touches"]).map((edge) => edge.to_id)).toEqual(expect.arrayContaining(["path:packages/web/menu.ts", "module:web"]));
    expect(graph.node("landing:1:decision:2")?.statement).toBe("Click is the only opener");
    // Ticket #6 was filed through a bearer key (bot.db v86): its origins say so.
    expect(graph.node("landing:1:decision:2")?.metadata?.origins).toEqual([
      { ticket: 6, requester: "bob", role: "task_evolution", actor_kind: "token" },
    ]);
    expect(graph.node("ticket:6")?.metadata?.actor_kind).toBe("token");
    // An unrecorded (pre-v86) ticket node is unchanged.
    expect(graph.node("ticket:5")?.metadata).not.toHaveProperty("actor_kind");
  });

  it("classifies requirement text into capabilities and expands exact neighbourhoods", async () => {
    const retriever = new KnowledgeRetriever(graph);
    const matches = await retriever.classify({ text: "导航菜单点击后没有打开，刷新后选择也丢了" });
    expect(matches[0]?.id).toBe("web.navigation");
    expect(matches[0]?.certainty).toBe("inferred");
    const expansion = retriever.expandFromPaths(["packages/web/menu.ts"], { seedCapabilities: ["web.navigation"] });
    expect(expansion.modules.map((node) => node.id)).toEqual(["module:web"]);
    expect(expansion.principles.some((node) => node.statement.startsWith("Key user-owned"))).toBe(true);
    expect(expansion.constraints.map((node) => node.id)).toContain("constraint:TRUST-001");
    expect(expansion.patterns.map((node) => node.id)).toContain("pattern:menu-state-loss");
    expect(expansion.landings.map((node) => node.id)).toContain("landing:1");
    expect(expansion.decisions.some((node) => node.id === "decision:cur:b01:6:1")).toBe(true);
    expect(expansion.decisions.some((node) => node.id === "decision:cur:b01:5:2")).toBe(false);
  });

  it("builds a bounded startup pack with a mandatory unknown section", async () => {
    const retriever = new KnowledgeRetriever(graph);
    const pack = await buildStartupPack(retriever, { title: "导航菜单", body: "菜单点击后没有打开" }, { budget: 2_500 });
    expect(pack.chars).toBeLessThanOrEqual(2_500);
    expect(pack.text).toContain("### 未知、冲突与陈旧性（禁止省略）");
    expect(pack.text).toContain("web.navigation");
    expect(pack.text).toContain("TRUST-001");
    expect(pack.text).not.toContain("The repository is ESM");
    expect(pack.text).not.toContain("Land through the landing door");
    expect(pack.included.length).toBeGreaterThan(0);
    expect(pack.unknown.some((item) => item.code === "missing_slot")).toBe(true);

    const context = await buildPathContext(retriever, ["packages/web/menu.ts"], "hover");
    expect(context.text).toContain("### 动作、路径与符号");
    expect(context.text).toContain("Menu loses selection after refresh");
    expect(context.text).toContain("TRUST-001");
    expect(context.text).not.toContain("Land through the landing door");
  });

  it("computes the submit-time acknowledgement set from exact edges only", () => {
    const set = acknowledgementSet(new KnowledgeRetriever(graph), ["packages/web/menu.ts"]);
    expect(set.principles.some((node) => node.statement.startsWith("Key user-owned"))).toBe(true);
    expect(set.principles.every((node) => node.authority !== "always_on" && node.certainty === "exact")).toBe(true);
    expect(set.constraints.map((node) => node.id)).toEqual(["constraint:TRUST-001"]);
  });

  it("fuses additional similarity indexes without caller changes", async () => {
    const retriever = new KnowledgeRetriever(graph);
    const fake: SimilarityIndex = {
      name: "fake-vector",
      version: "1",
      search: async () => ({
        hits: [{ id: "capability:concern.stability", score: 1 }],
        trace: {
          index: "fake-vector",
          version: "1",
          kind: "vector",
          sourceGitSha: result.sha,
          artifactSha256: "f".repeat(64),
          recordCount: 1,
          status: "ok",
          latencyMs: 0,
          hits: [{ id: "capability:concern.stability", rank: 1, score: 1 }],
        },
      }),
    };
    retriever.similarity.register(fake);
    expect(retriever.similarity.names).toEqual(["lexical", "fake-vector"]);
    const hits = await retriever.similarity.search({ text: "anything", filters: { kinds: ["capability"] }, limit: 3 });
    expect(hits.hits.map((hit) => hit.id)).toContain("capability:concern.stability");
  });

  it("writes the snapshot atomically and reopens it read-only", () => {
    const file = path.join(root, "out", "graph.db");
    GraphDb.writeSnapshot(file, result.snapshot);
    const reopened = GraphDb.openReadonly(file);
    expect(reopened).not.toBeNull();
    expect(reopened!.counts().nodes).toBe(result.snapshot.nodes.length);
    expect(reopened!.meta().commit).toBe(result.sha);
    reopened!.close();
    expect(fs.readdirSync(path.dirname(file))).toEqual(["graph.db"]);
  });
});

describe("knowledge requester attribution", () => {
  it("keeps every originating user ticket when duplicate requirements fold", () => {
    const tickets: KnowledgeNode[] = [
      { id: "ticket:5", kind: "ticket", statement: "#5 first", status: "active", authority: "record", source_ref: "ticket:5", source_sha: "f", method: "landing", certainty: "exact", metadata: { requester: "alice", origin_ticket_id: 5 } },
      { id: "ticket:6", kind: "ticket", statement: "#6 second", status: "active", authority: "record", source_ref: "ticket:6", source_sha: "f", method: "landing", certainty: "exact", metadata: { requester: "bob", origin_ticket_id: 6 } },
    ];
    const requirements: KnowledgeNode[] = [
      { id: "requirement:first", kind: "requirement", statement: "Menus must open on click.", status: "active", authority: "curated", source_ref: "ticket:5", source_sha: "f", method: "curated", certainty: "exact", metadata: { ticket: 5 } },
      { id: "requirement:second", kind: "requirement", statement: "Menus must open on click.", status: "active", authority: "curated", source_ref: "ticket:6", source_sha: "f", method: "curated", certainty: "exact", metadata: { ticket: 6 } },
    ];
    const edges: KnowledgeEdge[] = [
      { from_id: "requirement:first", relation: "about", to_id: "ticket:5", method: "curated", certainty: "exact", source_ref: "ticket:5", source_sha: "f", observed_at: OBSERVED_AT },
      { from_id: "requirement:second", relation: "about", to_id: "ticket:6", method: "curated", certainty: "exact", source_ref: "ticket:6", source_sha: "f", observed_at: OBSERVED_AT },
    ];
    const result = assembleSnapshot(
      { nodes: [...tickets, ...requirements], edges, coverage: [], warnings: [] },
      {
        sha: "f",
        observedAt: OBSERVED_AT,
        evaluationAsOf: "2026-08-21",
        existingPaths: null,
        inputsFingerprint: "requester-attribution",
      },
    );
    const requirement = result.nodes.find((node) => node.kind === "requirement");
    expect(result.nodes.filter((node) => node.kind === "requirement")).toHaveLength(1);
    expect(requirement?.metadata?.origins).toEqual([
      { ticket: 5, requester: "alice", role: "task_evolution" },
      { ticket: 6, requester: "bob", role: "task_evolution" },
    ]);
  });
});

describe("curated and capability validation", () => {
  const ctx = { capabilities: new Set(["web.navigation"]), modules: new Set(["web"]) };
  const valid = {
    id: "cur:b02:9:1",
    kind: "decision",
    statement: "Menus open on click only.",
    ticket: 9,
    source: { type: "ticket_body", ref: "ticket:9" },
    capabilities: ["web.navigation"],
    status: "active",
    certainty: "exact",
    rationale: "stated in the opening request",
  };

  it("accepts a complete record and rejects each contract violation", () => {
    expect(validateCuratedRecord(valid, ctx)).toEqual([]);
    expect(validateCuratedRecord({ ...valid, capabilities: ["nope"] }, ctx)).toContain("unknown capability nope");
    expect(validateCuratedRecord({ ...valid, statement: "x".repeat(401) }, ctx)).toContain("statement longer than 400 chars");
    expect(validateCuratedRecord({ ...valid, quote: "q".repeat(121) }, ctx)).toContain("quote must be ≤ 120 chars");
    expect(validateCuratedRecord({ ...valid, rationale: "" }, ctx)).toContain("rationale required, ≤ 200 chars");
    expect(validateCuratedRecord({ ...valid, certainty: "ambiguous" }, ctx)).toContain("ambiguous records must carry conflict_note");
    expect(validateCuratedRecord({ ...valid, status: "superseded" }, ctx)).toContain("superseded records must name superseded_by");
    expect(validateCuratedRecord({ ...valid, extra: 1 }, ctx)).toContain("unknown field extra");
    expect(validateCuratedRecord({ ...valid, statement: "token=abcdef123456 leaked" }, ctx)).toContain("statement looks like a credential");
  });

  it("validates the capability taxonomy against the atlas", () => {
    const { errors } = validateCapabilities({
      version: 1,
      capabilities: [{ id: "x.y", kind: "product", label: "X", description: "d", aliases: ["xx"], modules: ["missing"], constraints: ["NOPE"] }],
    }, new Set(["web"]), new Set(["TRUST-001"]));
    expect(errors).toEqual(expect.arrayContaining(["capability x.y: unknown module missing", "capability x.y: unknown constraint NOPE"]));
  });
});
