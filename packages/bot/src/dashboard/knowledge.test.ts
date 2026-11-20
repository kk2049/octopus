import { dashboardCookies } from "./web-session.js";
/**
 * Knowledge wiki: the projection over a built graph, the review ledger, and
 * the route gate. The graph builder itself is tested in
 * `packages/bot/src/knowledge`; here a hand-made snapshot stands in for it.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GraphDb, type GraphSnapshot } from "../knowledge/graph-db.js";
import { createRetrievalTraceEnvelope, type RetrievalTraceId } from "../knowledge/retrieval-trace.js";
import type { KnowledgeEdge, KnowledgeNode } from "../knowledge/model.js";
import { Store } from "../store/store.js";
import { createDashboardTestServer } from "../e2e/dashboard-test-support.js";
import { mintDashboardToken, type DashboardServer } from "./server.js";
import { KnowledgeChatService } from "./knowledge-chat.js";
import { KnowledgeWikiService, collapseGoverningDocuments, type WikiGraphView, type WikiOverview, type WikiReviewView } from "./knowledge.js";

const ADMIN = "admin-secret";
const SHA = "f".repeat(40);
const AT = "2026-08-21T00:00:00.000Z";

function node(partial: Partial<KnowledgeNode> & Pick<KnowledgeNode, "id" | "kind" | "statement">): KnowledgeNode {
  return {
    status: "active",
    authority: "declared",
    source_ref: "architecture/atlas.json",
    source_sha: SHA,
    method: "declared",
    certainty: "exact",
    ...partial,
  };
}

function edge(from_id: string, relation: KnowledgeEdge["relation"], to_id: string, certainty: KnowledgeEdge["certainty"] = "exact"): KnowledgeEdge {
  return { from_id, relation, to_id, method: "declared", certainty, source_ref: "fixture", source_sha: SHA, observed_at: AT };
}
function seedRetrieval(store: Store): RetrievalTraceId {
  const envelope = createRetrievalTraceEnvelope({
    lane: "ticket",
    purpose: "startup",
    subject_ref: "ticket:324",
    turn: 1,
    query: "private ticket body that must never be returned",
    repo_sha: SHA,
    graph_input_fingerprint: "a".repeat(64),
  }, "k".repeat(32));
  store.knowledgeRetrieval.beginTrace(envelope);
  store.knowledgeRetrieval.appendError(envelope.trace_id, "vector", "provider_unavailable");
  store.knowledgeRetrieval.markDeliveredError(envelope.trace_id, "ticket_prompt", "index_failed");
  return envelope.trace_id;
}


function snapshot(): GraphSnapshot {
  const nodes: KnowledgeNode[] = [
    node({ id: "zone:browser", kind: "zone", statement: "Browser（browser，trust=untrusted）", metadata: { trust: "untrusted" } }),
    node({ id: "module:web", kind: "module", statement: "Web UI（web）：menus", aliases: ["web", "Web UI"], metadata: { zone: "browser", criticality: "high", pathPrefixes: ["packages/web/"] } }),
    node({ id: "module:api", kind: "module", statement: "API（api）：handlers", aliases: ["api"], metadata: { zone: "browser", criticality: "high", pathPrefixes: ["packages/api/"] } }),
    node({ id: "path:packages/web/", kind: "path", statement: "packages/web/" }),
    node({ id: "capability:web.navigation", kind: "capability", statement: "导航：Menu and routing", aliases: ["web.navigation", "导航", "菜单", "menu"], metadata: { kind: "product", modules: ["web"], docs: ["packages/web/CLAUDE.md"], paths: [], constraints: ["TRUST-001"] } }),
    node({ id: "constraint:TRUST-001", kind: "constraint", statement: "Web must not import the API（TRUST-001）", aliases: ["TRUST-001"], metadata: { commands: ["npx vitest run packages/web/dep.test.ts"], evidence: [] } }),
    node({ id: "principle:p1", kind: "principle", statement: "Selection is keyed by resourceId and survives a roster refresh.", authority: "path_rule", source_ref: ".claude/rules/frontend.md#state:12", method: "parsed" }),
    node({ id: "decision:cur:b01:6:1", kind: "decision", statement: "菜单只在点击时打开；悬停不再打开菜单。", authority: "curated", source_ref: "ticket:6#message:30", method: "curated", valid_from: "2026-08-06T00:00:00.000Z", metadata: { ticket: 6, requester: "bob", origins: [{ ticket: 6, requester: "bob", role: "task_evolution", actor_kind: "token" }], rationale: "用户在 #6 确认", quote: "只在点击时打开", curated_id: "cur:b01:6:1" } }),
    node({ id: "non_goal:ng1", kind: "non_goal", statement: "不给菜单增加悬停预览。", status: "historical", authority: "record", source_ref: "doc/deliveries/2026-08-02-menu.md#没改什么:20", method: "parsed" }),
    node({ id: "requirement:cur:b01:5:1", kind: "requirement", statement: "给菜单增加悬停预览。", authority: "curated", certainty: "ambiguous", source_ref: "ticket:5", method: "curated", metadata: { ticket: 5, requester: "alice", origins: [{ ticket: 5, requester: "alice", role: "user_requirement" }], conflict_note: "与 #6 的决定相反，不确定是否仍然有效", rationale: "#5 正文" } }),
    node({ id: "pattern:menu-state-loss", kind: "pattern", statement: "菜单在刷新后丢失选择", authority: "curated", certainty: "inferred", source_ref: "architecture/knowledge/patterns.jsonl:1", method: "curated", metadata: { tickets: [5, 6], mandatory_facts: ["selected entry id"] } }),
    node({ id: "ticket:6", kind: "ticket", statement: "#6 菜单改为点击打开", authority: "record", source_ref: "ticket:6", method: "landing" }),
    node({ id: "landing:1", kind: "landing", statement: "Menu opens on click", authority: "user", source_ref: "landing:1", method: "landing", valid_from: "2026-08-06T00:00:00.000Z", metadata: { ticket_id: 6, to_sha: "b".repeat(40) } }),
    node({ id: "decision:adr:0005", kind: "decision", statement: "ADR 0005 — 后端组合子", authority: "adr", realization: "planned", source_ref: "doc/adr/0005-x.md", method: "declared", metadata: { adr: "0005", lifecycle: { source: "frontmatter" } } }),
    node({ id: "doc:packages/web/CLAUDE.md", kind: "doc", statement: "packages/web/CLAUDE.md" }),
  ];
  const edges: KnowledgeEdge[] = [
    edge("module:web", "in_zone", "zone:browser"),
    edge("module:web", "owns", "path:packages/web/"),
    edge("capability:web.navigation", "spans", "module:web"),
    edge("capability:web.navigation", "constrained_by", "constraint:TRUST-001"),
    edge("capability:web.navigation", "documented_by", "doc:packages/web/CLAUDE.md"),
    edge("constraint:TRUST-001", "constrains", "module:web"),
    edge("principle:p1", "governs", "module:web"),
    edge("decision:cur:b01:6:1", "realizes", "module:web"),
    edge("decision:cur:b01:6:1", "about", "capability:web.navigation"),
    edge("decision:cur:b01:6:1", "about", "ticket:6"),
    edge("non_goal:ng1", "bounds", "module:web", "inferred"),
    edge("requirement:cur:b01:5:1", "about", "capability:web.navigation", "ambiguous"),
    edge("pattern:menu-state-loss", "about", "capability:web.navigation"),
    edge("pattern:menu-state-loss", "guards", "module:web", "inferred"),
    edge("landing:1", "touches", "module:web"),
    edge("landing:1", "about", "ticket:6"),
    edge("landing:1", "implements", "decision:cur:b01:6:1"),
  ];
  return {
    nodes,
    edges,
    cells: [],
    observations: [],
    observationArtifacts: [],
    coverage: [
      { scope_kind: "module", scope_id: "module:api", measure: "capabilities", value: 0, note: "no capability spans this module" },
      { scope_kind: "ticket", scope_id: "ticket:7", measure: "knowledge", value: 0, note: "no requirement, decision, landing or pattern points at this ticket" },
      { scope_kind: "adr", scope_id: "doc/adr/0009-y.md", measure: "legacy_status", value: 1, note: "status parsed from free text; add frontmatter" },
    ],
    conflicts: [
      { id: "non_goal_vs_requirement:non_goal:ng1:requirement:cur:b01:5:1", rule: "non_goal_vs_requirement", a_id: "non_goal:ng1", b_id: "requirement:cur:b01:5:1", why: "overlap 0.52", severity: "review" },
    ],
    meta: {
      schema_version: 2,
      commit: SHA,
      built_at: AT,
      evaluation_as_of: "2026-08-23",
      tool_version: "2",
      input_fingerprint: "x",
      projection_digest: "fixture",
      node_count: nodes.length,
      edge_count: edges.length,
    },
  };
}

describe("administrator knowledge review", () => {
  it("requires complete investigation and one explicit confirmation, records questions without promotion, and invalidates a changed investigation", () => {
    const dir = mkdtempSync(join(tmpdir(), "knowledge-admin-review-"));
    const store = new Store(":memory:");
    const graph = snapshot();
    const claim = graph.nodes.find((node) => node.id === graph.conflicts[0]!.b_id)!;
    claim.metadata = { ...claim.metadata, provenance: { author: { kind: "human", name: "alice", model: null, ref: "ticket:5" }, basis: [], events: [{ kind: "requirement", actor: "alice", at: AT, source_kind: "original_prompt", source_sha256: "a".repeat(64), quote: claim.statement, design: claim.statement }] } };
    mkdirSync(join(dir, "knowledge"));
    GraphDb.writeSnapshot(join(dir, "knowledge/graph.db"), graph);
    const service = new KnowledgeWikiService({ dataDir: dir, store });
    const subject = graph.conflicts[0]!.id;
    const input = { subject_id: subject, rule: "non_goal_vs_requirement", decision: "approved_change", actor: "alice", admin: true, note: "我理解给菜单增加悬停预览，同意此修改同时接受触屏环境不提供悬停预览的代价。" };
    const investigation = { record_id: claim.id, original_motivation: "原设计保护触屏与鼠标操作行为的一致性", proposed_motivation: "新任务要求在鼠标环境提供快捷的菜单预览", proposed_behavior: "鼠标允许悬停预览而触屏继续使用点击", alternatives: "统一禁止悬停会失去鼠标环境的快捷操作", impact: "两类输入有不同入口但菜单选择状态一致", verification: "检查菜单实现和两类输入对应的回归测试" };
    try {
      expect(service.conflictWorkspace(subject)?.conflict?.policy?.blocked).toBe(true);
      expect(service.decide({ ...input, fingerprint: service.conflictWorkspace(subject)?.conflict?.policy?.fingerprint })).toMatchObject({ ok: false });
      expect(service.investigate({ subject_id: subject, investigation: {}, actor: "agent:alice" })).toMatchObject({ ok: false });
      expect(service.investigate({ subject_id: subject, investigation, actor: "agent:alice" })).toEqual({ ok: true });
      const fingerprint = service.conflictWorkspace(subject)!.conflict!.policy!.fingerprint;
      expect(service.decide({ ...input, fingerprint, admin: false })).toMatchObject({ ok: false });
      expect(service.decide({ ...input, fingerprint: "stale" })).toMatchObject({ ok: false, error: "冲突内容已经变化，请重新阅读后再批准" });
      // The confirmation itself is the review; the note is optional.
      expect(service.decide({ ...input, fingerprint, note: "" })).toMatchObject({ ok: true });
      expect(service.conflictWorkspace(subject)?.conflict?.policy?.blocked).toBe(false);
      expect(JSON.parse(service.conflictWorkspace(subject)!.review!.note)).toEqual({ fingerprint, confirmed: true });
      expect(service.decide({ ...input, fingerprint, note: "好的" })).toMatchObject({ ok: true });
      expect(JSON.parse(service.conflictWorkspace(subject)!.review!.note)).toEqual({ fingerprint, confirmed: true, note: "好的" });
      expect(service.conflictWorkspace(subject)?.conflict?.policy?.blocked).toBe(false);
      store.knowledge.recordReview({ subject_id: claim.id, rule: "discussion", decision: "question", actor: "bob", note: "讨论指针" });
      expect(service.node(claim.id)?.history).toEqual([expect.objectContaining({ actor: "bob", decision: "question" })]);
      expect(service.node(claim.id)?.node.detail.strength).toBe("human_required");
      expect(service.decide({ ...input, decision: "reopened", note: "重新调查" })).toMatchObject({ ok: true });
      expect(service.investigate({ subject_id: subject, investigation: { ...investigation, proposed_behavior: "不同的新行为必须重新提交管理员审阅" }, actor: "agent:alice" })).toEqual({ ok: true });
      expect(service.conflictWorkspace(subject)?.conflict?.policy?.fingerprint).not.toBe(fingerprint);
      expect(service.conflictWorkspace(subject)?.conflict?.policy?.blocked).toBe(true);
    } finally { service.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("governing document collapse", () => {
  it("lists a rule or package document once with its link instead of every bullet", () => {
    const SHA = "a".repeat(40);
    const doc = (file: string, statement: string, authority: KnowledgeNode["authority"]): KnowledgeNode => ({
      id: `doc:${file}`, kind: "doc", statement, status: "active", authority,
      source_ref: file, source_sha: SHA, method: "parsed", certainty: "exact",
    });
    const bullet = (file: string, line: number, authority: KnowledgeNode["authority"]): KnowledgeNode => ({
      id: `principle:${file}:${line}`, kind: "principle", statement: `bullet ${line}`, status: "active",
      authority, source_ref: `${file}#section:${line}`, source_sha: SHA, method: "parsed", certainty: "exact",
    });
    const curated: KnowledgeNode = {
      id: "principle:curated:1", kind: "principle", statement: "手机端交互状态按稳定身份保存。", status: "active",
      authority: "curated", source_ref: "ticket:61", source_sha: SHA, method: "curated", certainty: "exact",
    };
    const nodes = [
      doc(".claude/rules/agentic-app.md", "Agentic Apps and untrusted Views", "path_rule"),
      doc("packages/agent-view-react/CLAUDE.md", "Agent View React", "package"),
      bullet(".claude/rules/agentic-app.md", 17, "path_rule"),
      bullet(".claude/rules/agentic-app.md", 20, "path_rule"),
      bullet("packages/agent-view-react/CLAUDE.md", 8, "package"),
      curated,
    ];
    const graph = GraphDb.openInMemory();
    graph.fill({
      nodes, edges: [], coverage: [], conflicts: [], cells: [], observations: [], observationArtifacts: [],
      meta: {
        schema_version: 2, commit: SHA, built_at: "2026-08-24T00:00:00.000Z", evaluation_as_of: "2026-08-24",
        tool_version: "2", input_fingerprint: "b".repeat(64), projection_digest: "b".repeat(64),
        node_count: nodes.length, edge_count: 0,
      },
    });
    try {
      const collapsed = collapseGoverningDocuments(graph, [
        ...nodes.filter((node) => node.kind === "principle" && node.id !== curated.id),
        curated,
      ]);
      expect(collapsed.map((node) => node.id)).toEqual([
        "principle:curated:1",
        "doc:.claude/rules/agentic-app.md",
        "doc:packages/agent-view-react/CLAUDE.md",
      ]);
      expect(collapsed[1].statement).toBe(".claude/rules/agentic-app.md：整份文档适用（命中 2 条）");
    } finally {
      graph.close();
    }
  });
});

describe("KnowledgeWikiService list completeness", () => {
  it("returns every statement of a big capability and every neighbour of a busy node", () => {
    const dir = mkdtempSync(join(tmpdir(), "knowledge-wiki-lists-"));
    const store = new Store(":memory:");
    const svc = new KnowledgeWikiService({ dataDir: dir, store });
    try {
      const base = snapshot();
      // 150 decisions on one capability: past both the old 80-per-kind list
      // window and the old 60-per-relation edge window.
      const extra = Array.from({ length: 150 }, (_, index) => node({
        id: `decision:bulk:${String(index).padStart(3, "0")}`, kind: "decision", statement: `批量决策 ${index}`,
        authority: "curated", source_ref: `ticket:${1000 + index}`, method: "curated",
        valid_from: new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString(),
      }));
      mkdirSync(join(dir, "knowledge"), { recursive: true });
      GraphDb.writeSnapshot(join(dir, "knowledge", "graph.db"), {
        ...base,
        nodes: [...base.nodes, ...extra],
        edges: [...base.edges, ...extra.map((item) => edge(item.id, "about", "capability:web.navigation"))],
      });
      const view = svc.capability("web.navigation")!;
      const ids = view.decisions.map((item) => item.id);
      expect(ids).toHaveLength(151);
      expect(new Set(ids).size).toBe(151);
      expect(ids).toEqual(expect.arrayContaining(extra.map((item) => item.id)));
      expect("totals" in view).toBe(false);

      const about = svc.node("capability:web.navigation")!.in.find((group) => group.relation === "about")!;
      // Every neighbour is on the wire, deduplicated, and the total names the same set.
      expect(about.nodes).toHaveLength(about.total);
      expect(about.total).toBe(150 + 3);
      expect(about.nodes.map((item) => item.id)).toEqual(expect.arrayContaining(extra.map((item) => item.id)));
    } finally {
      svc.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("KnowledgeWikiService", () => {
  let dir: string;
  let store: Store;
  let svc: KnowledgeWikiService;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "knowledge-wiki-"));
    store = new Store(":memory:");
    store.saveUser({ username: "maintainer", uid: 1, home_dir: "/x/maintainer", created_at: AT });
    svc = new KnowledgeWikiService({ dataDir: dir, store });
  });

  afterAll(() => {
    svc.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("answers {generated:false} with an empty index before a graph exists", () => {
    const out = svc.overview();
    expect(out.generated).toBe(false);
    expect(out.capabilities).toEqual([]);
    expect(svc.capability("web.navigation")).toBeNull();
    expect(svc.relationGraph()).toEqual({ generated: false, nodes: [], edges: [] });
    expect(svc.decide({ subject_id: "x", rule: "r", decision: "dismissed", note: "", actor: "a" })).toMatchObject({ ok: false });
  });

  it("indexes capabilities, counts their reading list, and summarises the review queue once a graph is in place", () => {
    mkdirSync(join(dir, "knowledge"), { recursive: true });
    GraphDb.writeSnapshot(join(dir, "knowledge", "graph.db"), snapshot());
    const out: WikiOverview = svc.overview();
    expect(out.generated).toBe(true);
    expect(out.meta?.commit).toBe(SHA);
    expect(out.capabilities).toHaveLength(1);
    const cap = out.capabilities[0];
    expect(cap.id).toBe("web.navigation");
    expect(cap.counts.principle).toBe(1);
    expect(cap.counts.decision).toBe(1);
    expect(cap.counts.constraint).toBe(1);
    expect(cap.counts.pattern).toBe(1);
    expect(cap.direct).toBe(3);
    expect(out.review).toMatchObject({ conflictsOpen: 1, conflictsDismissed: 0, ambiguous: 1, adrLegacy: 1, adrPlanned: 1, unmappedModules: 1, ticketsWithoutKnowledge: 1 });
    expect(out.landings.map((item) => item.id)).toEqual(["landing:1"]);
  });

  it("projects every graph node and edge without forwarding metadata", () => {
    const graph: WikiGraphView = svc.relationGraph();
    expect(graph).toMatchObject({
      generated: true,
      meta: { commit: SHA, built_at: AT },
    });
    expect(graph.nodes).toHaveLength(snapshot().nodes.length);
    expect(graph.edges).toHaveLength(snapshot().edges.length);
    expect(graph.nodes.find((item) => item.id === "module:web")).toEqual({
      id: "module:web",
      kind: "module",
      statement: "Web UI（web）：menus",
      status: "active",
      authority: "declared",
      certainty: "exact",
      source_ref: "architecture/atlas.json",
    });
    expect(graph.edges).toContainEqual({
      from_id: "capability:web.navigation",
      relation: "spans",
      to_id: "module:web",
      certainty: "exact",
    });
    expect(JSON.stringify(graph)).not.toContain("pathPrefixes");
  });

  it("renders a capability's reading list with whitelisted metadata only", () => {
    const view = svc.capability("web.navigation");
    expect(view).not.toBeNull();
    expect(view!.modules.map((item) => item.id)).toEqual(["module:web"]);
    expect(view!.principles.map((item) => item.id)).toEqual(["principle:p1"]);
    expect(view!.constraints[0]?.detail.commands).toEqual(["npx vitest run packages/web/dep.test.ts"]);
    expect(view!.decisions[0]).toMatchObject({ id: "decision:cur:b01:6:1", detail: { ticket: 6, quote: "只在点击时打开", rationale: "用户在 #6 确认" } });
    expect("curated_id" in (view!.decisions[0] as unknown as Record<string, unknown>)).toBe(false);
    expect(view!.nonGoals).toEqual([]);
    expect(view!.patterns[0]?.detail.mandatory_facts).toEqual(["selected entry id"]);
    expect(view!.landings.map((item) => item.id)).toEqual(["landing:1"]);
    expect(view!.docs).toEqual(["packages/web/CLAUDE.md"]);
  });

  it("shows a node with its neighbourhood grouped by relation and the conflicts it is part of", () => {
    const view = svc.node("non_goal:ng1");
    expect(view?.node.status).toBe("historical");
    expect(view?.out.map((group) => group.relation)).toEqual(["bounds"]);
    expect(view?.conflicts).toHaveLength(1);
    expect(view?.conflicts[0].b?.id).toBe("requirement:cur:b01:5:1");
    expect(view?.conflicts[0]).toMatchObject({
      object: { id: "requirement:cur:b01:5:1", detail: { origins: [{ ticket: 5, requester: "alice", role: "user_requirement" }] } },
      explanation: expect.stringContaining("用户意图"),
    });
    const module = svc.module("web");
    expect(module?.decisions.map((item) => item.id)).toEqual(["decision:cur:b01:6:1"]);
    // A recorded origin-ticket actor kind reaches the page; an unrecorded one stays absent.
    expect(module?.decisions[0]?.detail.origins).toEqual([{ ticket: 6, requester: "bob", role: "task_evolution", actor_kind: "token" }]);
    expect(view?.conflicts[0]?.b?.detail.origins?.[0]).not.toHaveProperty("actor_kind");
  });

  it("searches statements and classifies the query into capabilities", async () => {
    const out = await svc.search("菜单只在点击时打开");
    expect(out.statements.map((item) => item.id)).toContain("decision:cur:b01:6:1");
    expect(out.capabilities[0]?.id).toBe("web.navigation");
    const preview = await svc.preview("导航菜单", "菜单点击后没有打开");
    expect(preview?.text).toContain("### 未知、冲突与陈旧性（禁止省略）");
    expect(preview?.capabilities[0]?.id).toBe("web.navigation");
  });

  it("keeps shared annotations on one stable conflict subject and exposes read-only chat context", async () => {
    const subject = "non_goal_vs_requirement:non_goal:ng1:requirement:cur:b01:5:1";
    expect(svc.annotate({ subject_id: subject, body: "  按 Alice 的原始需求处理。  ", actor: "maintainer" })).toMatchObject({
      ok: true,
      annotation: { body: "按 Alice 的原始需求处理。", actor: "maintainer" },
    });
    const workspace = svc.conflictWorkspace(subject);
    expect(workspace).toMatchObject({
      subject_id: subject,
      terminal: false,
      annotations: [{ body: "按 Alice 的原始需求处理。", actor: "maintainer" }],
    });
    expect(workspace).not.toHaveProperty("threads");
    await expect(svc.chatContext(subject, "为什么冲突")).resolves.toMatchObject({
      readOnly: false,
      context: expect.stringContaining("Alice"),
    });
  });

  it("records review decisions as a ledger and reflects the latest one", () => {
    const conflictId = "non_goal_vs_requirement:non_goal:ng1:requirement:cur:b01:5:1";
    expect(svc.decide({ subject_id: "nope", rule: "x", decision: "dismissed", note: "", actor: "alice" })).toMatchObject({ ok: false });
    expect(svc.decide({ subject_id: conflictId, rule: "x", decision: "maybe", note: "", actor: "alice" })).toMatchObject({ ok: false });
    expect(svc.decide({ subject_id: conflictId, rule: "non_goal_vs_requirement", decision: "dismissed", note: "同一件事", actor: "alice" })).toMatchObject({ ok: true });
    const review: WikiReviewView = svc.review();
    expect(review.conflicts[0].review).toMatchObject({ decision: "dismissed", actor: "alice", note: "同一件事" });
    expect(svc.overview().review).toMatchObject({ conflictsOpen: 0, conflictsDismissed: 1 });
    expect(svc.decide({ subject_id: conflictId, rule: "non_goal_vs_requirement", decision: "reopened", note: "", actor: "bob" })).toMatchObject({ ok: true });
    expect(svc.overview().review).toMatchObject({ conflictsOpen: 1, conflictsDismissed: 0 });
    expect(svc.decide({ subject_id: "requirement:cur:b01:5:1", rule: "ambiguous", decision: "confirmed", note: "", actor: "bob" })).toMatchObject({ ok: true });
    expect(svc.review().ambiguous[0].review?.decision).toBe("confirmed");
    expect(review.adr.map((item) => item.node.id)).toEqual(["decision:adr:0005"]);
    expect(review.coverage.modulesWithoutCapability).toEqual(["api"]);
    expect(review.coverage.ticketsWithoutKnowledge).toEqual({ count: 1, sample: [7] });
  });
  it("returns bounded redacted retrieval review evidence without query hashes or prose", () => {
    const traceId = seedRetrieval(store);
    const page = svc.retrievals({ limit: 100 });
    expect(page).toMatchObject({
      items: [expect.objectContaining({ trace_id: traceId, subject_ref: "ticket:324", outcome: "error" })],
      limit: 50,
      has_more: false,
    });
    expect(page.next_before).toBeUndefined();
    const detail = svc.retrievalTrace(traceId);
    expect(detail?.events.map((event) => event.event)).toEqual(["started", "error", "delivered_error"]);
    expect(detail).toMatchObject({ events_total: 3, events_has_more: false });
    const wire = JSON.stringify(detail);
    expect(wire).not.toContain("private ticket body");
    expect(wire).not.toContain("query_hash");
    expect(wire).not.toContain("\"body\"");
    expect(wire).not.toContain("\"stack\"");
  });

});

describe("knowledge wiki routes", () => {
  let dir: string;
  let store: Store;
  let dash: DashboardServer;
  let base: string;
  let retrievalTraceId: RetrievalTraceId;
  let aliceToken: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "knowledge-wiki-routes-"));
    mkdirSync(join(dir, "knowledge"), { recursive: true });
    GraphDb.writeSnapshot(join(dir, "knowledge", "graph.db"), snapshot());
    store = new Store(":memory:");
    store.saveUser({ username: "alice", uid: 1, home_dir: "/x/alice", created_at: AT });
    store.grantCapability("alice", "dev", "test", AT);
    aliceToken = mintDashboardToken(store, "alice");
    const knowledge = new KnowledgeWikiService({
      dataDir: dir,
      store,
      artifactHealth: () => ({
        configured: true,
        status: "degraded",
        protocolAvailable: true,
        vectorSearchOnline: true,
        active: {
          repoSha: "a".repeat(40),
          manifestDigest: "b".repeat(64),
          activatedAt: "2026-08-30T10:00:00.000Z",
          ageMs: 3_600_000,
          baselineRef: "v4",
          baselineSha: "c".repeat(40),
          commitsBehind: 2,
          baselineCheckedAt: "2026-08-30T11:00:00.000Z",
          evaluations: {
            journeys: { state: "failed", startedAt: "2026-08-30T10:00:01.000Z", finishedAt: "2026-08-30T10:00:02.000Z", failureCode: "journeys_failed:J004", metrics: { recall_at_10: 0.7 } },
            vectorBenchmark: { state: "passed", startedAt: "2026-08-30T10:00:02.000Z", finishedAt: "2026-08-30T10:00:03.000Z", failureCode: null, metrics: { p95_ms: 12 } },
          },
        },
        task: { phase: "remote", remoteState: "running", reconcileStep: null },
        lastFailureCode: "conformance_failed:contracts",
        lastFailureAt: "2026-08-30T09:00:00.000Z",
        recentActivations: [],
      }),
    });
    const chatFetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: "这是独立知识对话的回答。" } }],
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof globalThis.fetch;
    dash = createDashboardTestServer(store, undefined, {
      port: 0,
      host: "127.0.0.1",
      authToken: ADMIN,
      knowledge,
      knowledgeChat: new KnowledgeChatService({
        baseUrl: "http://llm.invalid/v1",
        apiKey: "test-key",
        model: "test-model",
        fetchImpl: chatFetch,
      }, store, knowledge),
    });
    retrievalTraceId = seedRetrieval(store);
    for (let index = 0; index < 3; index += 1) {
      store.knowledgeRetrieval.recordFeedback(retrievalTraceId, "helpful", undefined, `statement:route-${index}`);
    }
    seedRetrieval(store);
    await dash.start();
    base = `http://127.0.0.1:${dash.port}`;
  });

  afterAll(async () => {
    await dash?.stop();
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const auth = { headers: { authorization: `Bearer ${ADMIN}` } };

  const aliceAuth = () => ({ headers: { authorization: `Bearer ${aliceToken}` } });
  it("refuses anonymous callers on every knowledge route", async () => {
    for (const path of ["/api/knowledge/sources", "/api/knowledge/repairs", "/api/knowledge", "/api/knowledge/health", "/api/knowledge/graph", "/api/knowledge/review", "/api/knowledge/conflict?subject=x", "/api/knowledge/chats", "/api/knowledge/chat?id=kc_x", "/api/knowledge/retrievals", "/api/knowledge/retrievals?view=tickets", "/api/knowledge/retrieval?id=kr_00000000000000000000000000000000", "/api/knowledge/capability?id=web.navigation", "/api/knowledge/search?q=x"]) {
      expect((await fetch(`${base}${path}`)).status, path).toBe(401);
    }
    for (const path of ["/api/knowledge/review/decide", "/api/knowledge/conflict/annotate", "/api/knowledge/chats", "/api/knowledge/chat/send"]) {
      expect((await fetch(`${base}${path}`, { method: "POST" })).status, path).toBe(401);
    }
  });

  it("keeps sources private and requires a real owner browser input, including CSRF, for confirmation",async()=>{
    const source=store.knowledgeSources.import("alice",{provider:"codex",device:"device",session_id:"s1",message_id:"m1",source_at:AT,role:"user",text:"私有历史记录不是已确认的人类证据"});
    const input={id:source.id,source_sha256:source.source_sha256,kind:"requirement",statement:"来源必须保持每个用户之间的隔离边界"};
    for(const headers of [auth.headers,aliceAuth().headers]) {
      expect((await fetch(`${base}/api/knowledge/sources/confirm`,{method:"POST",headers:{...headers,"content-type":"application/json"},body:JSON.stringify(input)})).status).toBe(403);
    }
    expect(store.knowledgeSources.confirmations("alice",source.id)).toEqual([]);
    store.saveUser({username:"bob",uid:2,home_dir:"/x/bob",created_at:AT});
    const bobToken=mintDashboardToken(store,"bob");
    const hidden=await fetch(`${base}/api/knowledge/sources?id=${source.id}`,{headers:{authorization:`Bearer ${bobToken}`}});
    expect(hidden.status).toBe(400);expect(await hidden.text()).not.toContain(source.text);
    const login=await fetch(`${base}/login`,{method:"POST",redirect:"manual",headers:{"content-type":"application/json",origin:base},body:JSON.stringify({token:aliceToken})});
    const names=dashboardCookies(undefined).names,cookies=login.headers.getSetCookie();
    const cookie=cookies.map(c=>c.split(";")[0]).join("; ");
    const csrf=cookies.find(c=>c.startsWith(`${names.csrf}=`))!.split(";")[0].slice(names.csrf.length+1);
    const headers={cookie,origin:base,"content-type":"application/json"};
    expect((await fetch(`${base}/api/knowledge/sources/confirm`,{method:"POST",headers,body:JSON.stringify(input)})).status).toBe(403);
    const invalidImport=await fetch(`${base}/api/knowledge/sources`,{method:"POST",headers:{...headers,"x-csrf-token":csrf},body:JSON.stringify({source_json:'{"text":"private-import-do-not-audit'})});
    expect(invalidImport.status).toBe(400);expect(await invalidImport.text()).not.toContain("private-import-do-not-audit");
    const confirmed=await fetch(`${base}/api/knowledge/sources/confirm`,{method:"POST",headers:{...headers,"x-csrf-token":csrf},body:JSON.stringify(input)});
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toMatchObject({actor:"alice",quote:input.statement,source_kind:"human_message"});
    expect(store.knowledgeSources.confirmations("alice",source.id)).toHaveLength(1);
  });

  it("serves the index, the capability view, search and the review queue to an authorised caller", async () => {
    const overview = (await (await fetch(`${base}/api/knowledge`, auth)).json()) as WikiOverview;
    expect(overview.generated).toBe(true);
    expect(overview.capabilities[0]?.id).toBe("web.navigation");
    const health = await (await fetch(`${base}/api/knowledge/health`, auth)).json() as {
      active: { commitsBehind: number; evaluations: { journeys: { failureCode: string } } };
      vectorSearchOnline: boolean;
      lastFailureCode: string;
    };
    expect(health).toMatchObject({
      vectorSearchOnline: true,
      lastFailureCode: "conformance_failed:contracts",
      active: { commitsBehind: 2, evaluations: { journeys: { failureCode: "journeys_failed:J004" } } },
    });
    expect(JSON.stringify(health)).not.toMatch(/generation|jobKey|\/work\//u);
    const graph = (await (await fetch(`${base}/api/knowledge/graph`, auth)).json()) as WikiGraphView;
    expect(graph.nodes).toHaveLength(snapshot().nodes.length);
    expect(graph.edges).toContainEqual(expect.objectContaining({ relation: "implements" }));
    const capability = await fetch(`${base}/api/knowledge/capability?id=web.navigation`, auth);
    expect(capability.status).toBe(200);
    expect((await fetch(`${base}/api/knowledge/capability?id=missing`, auth)).status).toBe(404);
    expect((await fetch(`${base}/api/knowledge/node`, auth)).status).toBe(400);
    const search = (await (await fetch(`${base}/api/knowledge/search?q=${encodeURIComponent("菜单只在点击时打开")}`, auth)).json()) as { statements: unknown[] };
    expect(search.statements.length).toBeGreaterThan(0);
    const review = (await (await fetch(`${base}/api/knowledge/review`, auth)).json()) as WikiReviewView;
    expect(review.conflicts).toHaveLength(1);
    const subject = review.conflicts[0]!.id;
    const annotation = await fetch(`${base}/api/knowledge/conflict/annotate`, {
      method: "POST",
      headers: { ...auth.headers, "content-type": "application/json" },
      body: JSON.stringify({ subject_id: subject, body: "按最新用户意图处理" }),
    });
    expect(annotation.status).toBe(200);
    const conflictWorkspace = await (await fetch(
      `${base}/api/knowledge/conflict?subject=${encodeURIComponent(subject)}`,
      auth,
    )).json() as { subject_id: string; annotations: Array<{ body: string; actor: string }> };
    expect(conflictWorkspace).toMatchObject({
      subject_id: subject,
      annotations: [{ body: "按最新用户意图处理" }],
    });
    const firstRetrievals = await (await fetch(`${base}/api/knowledge/retrievals?limit=1`, auth)).json() as {
      items: Array<{ trace_id: string }>;
      limit: number;
      has_more: boolean;
      next_before?: string;
    };
    expect(firstRetrievals).toMatchObject({ limit: 1, has_more: true });
    expect(firstRetrievals.items).toHaveLength(1);
    const secondRetrievals = await (await fetch(
      `${base}/api/knowledge/retrievals?limit=1&before=${encodeURIComponent(firstRetrievals.next_before!)}`,
      auth,
    )).json() as { items: Array<{ trace_id: string }>; has_more: boolean };
    expect(secondRetrievals.items).toHaveLength(1);
    expect(secondRetrievals.has_more).toBe(false);
    expect(new Set([...firstRetrievals.items, ...secondRetrievals.items].map((item) => item.trace_id)).size).toBe(2);
    expect((await fetch(`${base}/api/knowledge/retrievals?before=${encodeURIComponent(AT)}`, auth)).status).toBe(400);
    for (const suffix of ["ticket_id=-1", "ticket_id=1.5", "ticket_id=9007199254740992", "view=tickets&before_ticket=bad"]) {
      expect((await fetch(`${base}/api/knowledge/retrievals?${suffix}`, auth)).status).toBe(400);
    }
    const tickets = await (await fetch(`${base}/api/knowledge/retrievals?view=tickets&limit=1`, auth)).json() as { items: unknown[]; limit: number };
    expect(tickets.limit).toBe(1);
    expect(tickets.items.length).toBeLessThanOrEqual(1);
    const filtered = await (await fetch(`${base}/api/knowledge/retrievals?outcome=all&ticket_id=999999`, auth)).json() as { items: unknown[] };
    expect(filtered.items).toEqual([]);

    const trace = await (await fetch(
      `${base}/api/knowledge/retrieval?id=${retrievalTraceId}&events_limit=1`,
      auth,
    )).json() as {
      events: Array<{ event: string; event_key: string }>;
      events_total: number;
      events_has_more: boolean;
      events_next_before?: string;
    };
    expect(trace.events.filter((event) => event.event !== "feedback").map((event) => event.event)).toEqual(["started", "error", "delivered_error"]);
    expect(trace.events.filter((event) => event.event === "feedback")).toHaveLength(1);
    expect(trace).toMatchObject({ events_total: 6, events_has_more: true });
    const nextTrace = await (await fetch(
      `${base}/api/knowledge/retrieval?id=${retrievalTraceId}&events_limit=1&events_before=${encodeURIComponent(trace.events_next_before!)}`,
      auth,
    )).json() as typeof trace;
    expect(nextTrace.events.filter((event) => event.event !== "feedback").map((event) => event.event)).toEqual(["started", "error", "delivered_error"]);
    expect(nextTrace.events.find((event) => event.event === "feedback")?.event_key)
      .not.toBe(trace.events.find((event) => event.event === "feedback")?.event_key);
    expect((await fetch(`${base}/api/knowledge/retrieval?id=${retrievalTraceId}&events_before=not-a-cursor`, auth)).status).toBe(400);
    expect(JSON.stringify(trace)).not.toMatch(/query_hash|private ticket body|transcript|stack/);
  });

  it("creates and continues a personal knowledge chat without creating a development ticket", async () => {
    const subject = "non_goal_vs_requirement:non_goal:ng1:requirement:cur:b01:5:1";
    const beforeTickets = store.devTickets.listDevTickets().length;
    const invalid = await fetch(`${base}/api/knowledge/chats`, {
      method: "POST",
      headers: { ...aliceAuth().headers, "content-type": "application/json" },
      body: JSON.stringify({ subject_id: subject, request_id: "request-invalid" }),
    });
    expect(invalid.status).toBe(400);

    const created = await fetch(`${base}/api/knowledge/chats`, {
      method: "POST",
      headers: { ...aliceAuth().headers, "content-type": "application/json" },
      body: JSON.stringify({ subject_id: subject, message: "请比较两条要求", request_id: "request-route-create" }),
    });
    expect(created.status).toBe(200);
    const createdBody = await created.json() as { chat: { id: string; subject_id: string }; running: boolean };
    expect(createdBody).toMatchObject({
      running: true,
      chat: { subject_id: subject },
    });
    expect(createdBody.chat).not.toHaveProperty("requester");
    expect(createdBody.chat).not.toHaveProperty("dev_status");
    expect(store.devTickets.listDevTickets()).toHaveLength(beforeTickets);

    await vi.waitFor(() => {
      expect(store.knowledgeChats.get("alice", createdBody.chat.id)?.running_since).toBeNull();
    });
    const roster = await (await fetch(`${base}/api/knowledge/chats`, aliceAuth())).json() as { chats: Array<{ id: string; updated_at: string }>; next_before: string | null };
    expect(roster.chats.map((chat) => chat.id)).toContain(createdBody.chat.id);
    expect(roster.next_before).toBeNull();
    const cursor = `${roster.chats[0]!.updated_at}|${roster.chats[0]!.id}`;
    expect(await (await fetch(`${base}/api/knowledge/chats?before=${encodeURIComponent(cursor)}`, aliceAuth())).json())
      .toMatchObject({ chats: [], next_before: null });
    expect((await fetch(`${base}/api/knowledge/chats?before=x`, aliceAuth())).status).toBe(400);
    const history = await (await fetch(
      `${base}/api/knowledge/chat?id=${encodeURIComponent(createdBody.chat.id)}`,
      aliceAuth(),
    )).json() as { messages: Array<{ id: number; role: string; content: string }>; has_earlier: boolean };
    expect(history.messages).toMatchObject([
      { role: "user", content: "请比较两条要求" },
      { role: "assistant", content: "这是独立知识对话的回答。" },
    ]);
    expect(history.has_earlier).toBe(false);
    const older = await (await fetch(
      `${base}/api/knowledge/chat?id=${encodeURIComponent(createdBody.chat.id)}&before=${history.messages[1]!.id}`,
      aliceAuth(),
    )).json() as typeof history;
    expect(older.messages.map((message) => message.content)).toEqual(["请比较两条要求"]);
    expect((await fetch(`${base}/api/knowledge/chat?id=${encodeURIComponent(createdBody.chat.id)}&before=x`, aliceAuth())).status).toBe(400);

    const continued = await fetch(`${base}/api/knowledge/chat/send`, {
      method: "POST",
      headers: { ...aliceAuth().headers, "content-type": "application/json" },
      body: JSON.stringify({ chat_id: createdBody.chat.id, message: "再解释一次", request_id: "request-route-send" }),
    });
    expect(continued.status).toBe(200);
    expect((await fetch(`${base}/api/knowledge/conflict/chat`, {
      method: "POST",
      headers: { ...aliceAuth().headers, "content-type": "application/json" },
      body: "{}",
    })).status).toBe(404);
  });

  it("records a decision through the gate and rejects a malformed body", async () => {
    const ok = await fetch(`${base}/api/knowledge/review/decide`, {
      method: "POST",
      headers: { ...auth.headers, "content-type": "application/json" },
      body: JSON.stringify({ subject_id: "non_goal_vs_requirement:non_goal:ng1:requirement:cur:b01:5:1", rule: "non_goal_vs_requirement", decision: "confirmed", note: "real" }),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, review: { decision: "confirmed", note: "real" } });
    const bad = await fetch(`${base}/api/knowledge/review/decide`, {
      method: "POST",
      headers: { ...auth.headers, "content-type": "application/json" },
      body: JSON.stringify({ subject_id: "x", decision: "whatever" }),
    });
    expect(bad.status).toBe(400);
    const preview = await fetch(`${base}/api/knowledge/preview`, {
      method: "POST",
      headers: { ...auth.headers, "content-type": "application/json" },
      body: JSON.stringify({ title: "导航", body: "菜单点击后没有打开" }),
    });
    expect(preview.status).toBe(200);
    expect(((await preview.json()) as { text: string }).text).toContain("未知");
  });
});
