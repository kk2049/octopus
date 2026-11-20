import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ResearchNode,
} from "@claude-bot/research-canvas-contract";
import { Store } from "../store/store.js";
import { ResearchGraph, type ResearchContext } from "./graph.js";
import { readGraphYaml, writeGraphYaml } from "./graph-yaml.js";
import { ResearchCollaboration } from "./collaboration.js";

describe("research graph authority and ordinary files", () => {
  let root: string, store: Store, graph: ResearchGraph, collaboration: ResearchCollaboration;
  const human: ResearchContext = { project: "project", actor: { kind: "human", owner: "alice" } };
  const agent: ResearchContext = { project: "project", actor: { kind: "agent", owner: "alice", agent: "researcher", run: "run1", model: "actual-model", trigger: "bob" } };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "research-graph-"));
    store = new Store(join(root, "store.sqlite"));
    store.createSharedAppInstance({ app_id: "research-v2", instance_key: "project", creator: "alice", status: "open", created_at: new Date().toISOString() }, "owner");
    graph = new ResearchGraph(store, root);
    collaboration = new ResearchCollaboration(graph, join(root, "documents"), () => {});
  });
  afterEach(() => { collaboration.close(); graph.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const add = (ctx: ResearchContext, request = "add", data: Record<string, unknown> = {}) => (graph.mutate(ctx, "node_add", { request, data: JSON.stringify({ type: "note", title: "证据", data: { text: "原文" }, ...data }) }) as { node: ResearchNode }).node;
  it("creates a child and its membership in one durable graph commit and replays both", () => {
    const parent = add(human, "parent", { type: "goal" });
    const data = { type: "note", title: "Child", data: {}, parent: { id: parent.id, label: "contains" } };
    const params = { request: "child", data: JSON.stringify(data) };
    const before = graph.documents.inspect("project").layout.sequence!;
    const result = graph.mutate(human, "node_add", params) as { node: ResearchNode; attached: boolean; parent: ResearchNode; edge: { source: string; target: string } };
    expect(result.attached).toBe(true); expect(result.parent.data.members).toContain(result.node.id);
    expect(result.edge).toMatchObject({ source: parent.id, target: result.node.id });
    expect(graph.documents.inspect("project").layout.sequence).toBe(before + 1);
    expect(graph.mutate(human, "node_add", params)).toEqual(result);
    graph.mutate(human, "node_archive", { request: "remove-parent", node: parent.id, version: String(parent.version) });
    expect(() => graph.mutate(human, "node_add", { ...params, request: "orphan" })).toThrow("归档");
  });
  it("uses bounded active pages without loading archived cards or losing the legacy view", () => {
    const a = add(human, "active"), b = add(human, "archived");
    graph.mutate(human, "node_archive", { request: "remove", node: b.id, version: String(b.version) });
    expect((graph.read(human, { active: "true" }) as { nodes: ResearchNode[] }).nodes.map(node => node.id)).toEqual([a.id]);
    expect((graph.read(human, {}) as { nodes: ResearchNode[] }).nodes).toHaveLength(2);
  });
  it("paginates more than 200 active nodes and interleaved edges without dropping either bucket", () => {
    const resource = add(human, "resource"), baseline = graph.documents.snapshot(human);
    const yaml = readGraphYaml(baseline.yaml);
    yaml.nodes = Object.fromEntries(Array.from({ length: 211 }, (_, i) => ["n_" + String(i).padStart(3, "0"), { ref: resource.ref!, label: "Card " + i }]));
    yaml.edges = Object.fromEntries(Array.from({ length: 210 }, (_, i) => ["n_" + String(i).padStart(3, "0") + "_edge", { from: "n_" + String(i).padStart(3, "0"), to: "n_" + String(i + 1).padStart(3, "0"), relation: "supports" }]));
    expect(graph.documents.apply(human, "large-graph", writeGraphYaml(yaml.snapshot, yaml), graph.provenance(human)).status).toBe("merged");
    const nodes: string[] = [], edges: string[] = []; let after: string | undefined, pages = 0;
    do {
      const page = graph.read(human, { active: "true", ...(after ? { after } : {}) }) as { nodes: { id: string }[]; edges: { id: string }[]; next: string | null };
      expect(page.nodes.length).toBeLessThanOrEqual(200); expect(page.edges.length).toBeLessThanOrEqual(200);
      nodes.push(...page.nodes.map(node => node.id)); edges.push(...page.edges.map(edge => edge.id));
      after = page.next ?? undefined; expect(++pages).toBeLessThan(5);
    } while (after);
    expect(nodes).toEqual(Object.keys(yaml.nodes).sort()); expect(edges).toEqual(Object.keys(yaml.edges).sort());
    expect(pages).toBeGreaterThan(1);
  });
  it("attributes decisions and replays a stable request across agent turns", () => {
    const node = add(agent);
    expect(node.created).toMatchObject({ kind: "agent", owner: "alice", trigger: "bob", model: "actual-model", run: "run1" });
    expect(add({ ...agent, actor: { ...agent.actor, run: "run2" } })).toEqual(node);
    expect(() => add(agent, "add", { title: "different" })).toThrow("请求 ID");
  });
  it("separates a read-only resource from editable graph membership", () => {
    const node = add(human, "readonly", { data: { text: "证据正文", meta: { read_only: true } } });
    graph.mutate(agent, "node_update", { request: "label", node: node.id, version: "1", data: JSON.stringify({ title: "分类标签" }) });
    expect(graph.node("project", node.id).title).toBe("分类标签");
    expect(() => collaboration.write(agent, { request: "text", node: node.id, text: "overwrite" })).toThrow("只读");
    graph.mutate(agent, "node_archive", { request: "remove", node: node.id, version: "2" });
    expect(graph.resourceNode("project", node.ref!).data.text).toBe("证据正文");
  });
  it("applies agent graph edits without mandatory proposals", () => {
    const node = add(human);
    const baseline = graph.documents.snapshot(agent);
    const yaml = readGraphYaml(baseline.yaml);
    yaml.nodes[node.id].label = "新的理解";
    const result = graph.documents.apply(agent, "edit", writeGraphYaml(yaml.snapshot, yaml), graph.provenance(agent));
    expect(result.status).toBe("merged");
    expect(graph.node("project", node.id).title).toBe("新的理解");
    expect([...graph.records("project", "proposals")]).toEqual([]);
  });
  it("names the project from its root goal even when a TARGET sorts first", () => {
    const target = add(human, "target", { type: "goal", title: "具体目标", data: { meta: { researchRole: "target" } } });
    const rootGoal = add(human, "root", { type: "goal", title: "ACC → OSDI" });
    const snapshot = readGraphYaml(graph.documents.snapshot(human).yaml);
    snapshot.nodes = { a_target: { ref: target.ref!, label: target.title }, z_root: { ref: rootGoal.ref!, label: rootGoal.title } };
    snapshot.edges = { hierarchy: { from: "z_root", to: "a_target", relation: "decomposes" } };
    expect(graph.documents.apply(human, "goal-order", writeGraphYaml(snapshot.snapshot, snapshot), graph.provenance(human)).status).toBe("merged");
    expect(graph.title(human.project)).toBe("ACC → OSDI");
    expect(graph.read(human, {})).toMatchObject({ title: "ACC → OSDI" });
  });
  it("changes a content card's presentation while retaining its fixed ref, file and relationships", () => {
    const node = add(human);
    const before = graph.texts.read("project", graph.resourceNode("project", node.id));
    const result = graph.mutate(human, "node_update", { request: "kind", node: node.id, version: String(node.version), data: JSON.stringify({ cardKind: "target" }) }) as { node: ResearchNode };
    expect(result.node.ref).toBe(node.ref); expect(result.node.type).toBe("note");
    expect(result.node.data.meta).toMatchObject({ cardKind: "target", researchRole: "target" });
    expect(graph.texts.read("project", graph.resourceNode("project", node.id))).toEqual(before);
    const agentNode = add(human, "agent-kind", { type: "agent", data: {} });
    expect(() => graph.mutate(human, "node_update", { request: "invalid-kind", node: agentNode.id, version: String(agentNode.version), data: JSON.stringify({ cardKind: "note" }) })).toThrow("不能转换");
  });
  it("keeps direct file edits and file versions outside the graph CRDT", () => {
    const node = add(human), revision = graph.documents.inspect("project").revision;
    const file = graph.texts.read("project", graph.resourceNode("project", node.id));
    writeFileSync(file.path, "agent edited the workspace");
    expect(collaboration.text(human, node.id)).toBe("agent edited the workspace");
    collaboration.write(human, { request: "save", node: node.id, text: "human saved the file" });
    expect(readFileSync(file.path, "utf8")).toBe("human saved the file");
    const history = graph.texts.versions("project", node.id).versions;
    expect(history).toHaveLength(1);
    graph.texts.restore("project", graph.resourceNode("project", node.id), history[0].id);
    expect(readFileSync(file.path, "utf8")).toBe("agent edited the workspace");
    expect(graph.documents.inspect("project").revision).toBe(revision);
  });
  it("rejects invalid provenance and follows current membership revocation", () => {
    expect(() => add(human, "bad", { data: { meta: { nested: ["x"] } } })).toThrow("标量");
    add(human);
    store.addSharedAppMember("research-v2", "project", "bob", "researcher", 20, new Date().toISOString());
    const bob: ResearchContext = { project: "project", actor: { kind: "human", owner: "bob" } };
    expect(() => graph.read(bob, {})).not.toThrow();
    expect(() => add(bob)).toThrow("编辑权限");
    store.removeSharedAppMember("research-v2", "project", "bob");
    expect(() => graph.read(bob, {})).toThrow("撤销");
  });
  it("keeps resources and subscriptions alive after graph removal", () => {
    const node = add(agent, "resource", { type: "agent", data: {} });
    const subscription = { id: "sub", version: 1, enabled: true, source: node.id, target: node.id };
    graph.repo.put("project", "subscriptions", subscription.id, subscription, 0);
    graph.mutate(human, "node_archive", { request: "detach", node: node.id, version: "1" });
    expect(graph.resourceNode("project", node.ref!).type).toBe("agent");
    expect(graph.repo.get("project", "subscriptions", "sub")).toEqual(subscription);
    expect(() => graph.node("project", node.id)).toThrow("归档");
  });
});

// New hierarchy/review records stay in the same versioned graph authority.
describe("research hierarchy and review records", () => {
  let root: string, store: Store, graph: ResearchGraph;
  const human: ResearchContext = { project: "project", actor: { kind: "human", owner: "alice" } };
  const agent: ResearchContext = { project: "project", actor: { kind: "agent", owner: "alice", agent: "a1", run: "r1" } };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "research-hierarchy-"));
    store = new Store(join(root, "store.sqlite"));
    store.createSharedAppInstance({ app_id: "research-v2", instance_key: "project", creator: "alice", status: "open", created_at: new Date().toISOString() }, "owner");
    graph = new ResearchGraph(store, root);
  });
  afterEach(() => { graph.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  it("supports folders, goals, adapters and human-only review decisions", () => {
    const evidence = graph.mutate(human, "node_add", { request: "evidence", data: JSON.stringify({ type: "note", title: "证据" }) }) as { node: ResearchNode };
    const folder = graph.mutate(human, "node_add", { request: "folder", data: JSON.stringify({ type: "folder", title: "待审查材料", data: { members: [evidence.node.id] } }) }) as { node: ResearchNode };
    expect(folder.node.data.members).toEqual([evidence.node.id]);
    const goal = graph.mutate(human, "node_add", { request: "goal", data: JSON.stringify({ type: "goal", title: "核心目标", data: { text: "证明系统可审查" } }) }) as { node: ResearchNode };
    expect(goal.node.type).toBe("goal");
    const adapter = graph.mutate(agent, "adapter_register", { request: "adapter", data: JSON.stringify({ title: "文件观察器", source: "report.json", entry: "runner-resource", schema: { view: "table", columns: [{ key: "case", label: "Case" }] } }) }) as { node: ResearchNode };
    expect(adapter.node.type).toBe("adapter");
    const published = graph.mutate(agent, "adapter_publish", {
      request: "adapter-publish",
      node: adapter.node.id,
      version: "1",
      data: JSON.stringify({ sourceRevision: "sha-1", rows: [{ id: "case-1", cells: { case: "case-1" } }] }),
    }) as { node: ResearchNode };
    expect(published.node.data.adapter).toMatchObject({ status: "live", sourceRevision: "sha-1" });
    expect(() => graph.mutate({ ...agent, actor: { ...agent.actor, agent: "other" } }, "adapter_publish", {
      request: "adapter-publish-other",
      node: published.node.id,
      version: "2",
      data: JSON.stringify({ sourceRevision: "sha-2", rows: [] }),
    })).toThrow("登记者");
    const paused = graph.mutate(human, "adapter_control", {
      request: "adapter-pause",
      node: published.node.id,
      version: "2",
      state: "paused",
    }) as { node: ResearchNode };
    expect(paused.node.data.adapter).toMatchObject({ status: "paused" });
    const review = graph.mutate(human, "node_add", { request: "review", data: JSON.stringify({ type: "review", title: "审查结论", data: { targets: { [evidence.node.id]: evidence.node.version } } }) }) as { node: ResearchNode };
    expect(() => graph.mutate(agent, "review_decide", { request: "agent-review", node: review.node.id, version: "1", decision: "approved", targets: JSON.stringify({ [evidence.node.id]: 1 }) })).toThrow("只有人");
    const decided = graph.mutate(human, "review_decide", { request: "human-review", node: review.node.id, version: "1", decision: "approved", targets: JSON.stringify({ [evidence.node.id]: 1 }) }) as { node: ResearchNode };
    expect(decided.node.data.reviewStatus).toBe("approved");
  });
  it("reads a review-heavy page with bounded graph scans and keeps target version checks", () => {
    const evidence = (graph.mutate(human, "node_add", { request: "evidence", data: JSON.stringify({ type: "note", title: "Evidence" }) }) as { node: ResearchNode }).node;
    for (let i = 0; i < 24; i++) graph.mutate(human, "node_add", { request: "review-" + i, data: JSON.stringify({ type: "review", title: "Review " + i, data: { targets: { [evidence.id]: 1 } } }) });
    graph.mutate(human, "node_update", { request: "changed-source", node: evidence.id, version: "1", data: JSON.stringify({ summary: "New evidence" }) });
    const scans = vi.spyOn(graph, "records");
    try {
      const page = graph.read(human, {}) as { nodes: ResearchNode[] };
      expect(page.nodes.filter(node => node.type === "review")).toHaveLength(24);
      expect(page.nodes.filter(node => node.type === "review").every(node => node.data.reviewStatus === "stale")).toBe(true);
      expect(scans.mock.calls.filter(([, bucket]) => bucket === "nodes").length).toBeLessThanOrEqual(3);
    } finally { scans.mockRestore(); }
  });
  it("does not read every resource when only one graph card is renamed", () => {
    const original = (graph.mutate(human, "node_add", { request: "resource", data: JSON.stringify({ type: "note", title: "Evidence" }) }) as { node: ResearchNode }).node;
    const base = readGraphYaml(graph.documents.snapshot(human).yaml);
    for (let i = 0; i < 30; i++) base.nodes["alias_" + i] = { ref: original.ref!, label: "Alias " + i };
    graph.documents.apply(human, "aliases", writeGraphYaml(base.snapshot, base), graph.provenance(human));
    const cursor = String(graph.repo.cursor(human.project));
    const edited = readGraphYaml(graph.documents.snapshot(human).yaml);
    edited.nodes.alias_1.label = "Renamed";
    graph.documents.apply(human, "rename", writeGraphYaml(edited.snapshot, edited), graph.provenance(human));
    const reads = vi.spyOn(graph.repo, "get");
    try {
      const result = graph.changes(human, cursor) as { changes: { bucket: string; id: string; record: ResearchNode }[] };
      expect(result.changes.filter(change => change.bucket === "nodes")).toHaveLength(1);
      expect(result.changes.find(change => change.id === "alias_1")?.record).toMatchObject({ title: "Renamed", ref: original.ref });
      expect(reads.mock.calls.filter(([, bucket]) => bucket === "node-resources")).toHaveLength(1);
    } finally { reads.mockRestore(); }
  });
  it("shares batch projections while refreshing aliases, removed cards and hierarchy members", () => {
    const original = (graph.mutate(human, "node_add", { request: "resource", data: JSON.stringify({ type: "note", title: "Shared evidence" }) }) as { node: ResearchNode }).node;
    const base = readGraphYaml(graph.documents.snapshot(human).yaml);
    for (let i = 0; i < 30; i++) base.nodes["alias_" + i] = { ref: original.ref!, label: "Alias " + i };
    graph.documents.apply(human, "aliases", writeGraphYaml(base.snapshot, base), graph.provenance(human));
    const cursor = String(graph.repo.cursor(human.project));
    const resource = graph.resourceNode(human.project, original.ref!);
    for (let i = 1; i <= 24; i++) graph.repo.put(human.project, "node-resources", resource.id, { ...resource, version: i + 1, summary: "Update " + i }, i);
    const edited = readGraphYaml(graph.documents.snapshot(human).yaml);
    edited.nodes.alias_1.label = "Renamed alias";
    delete edited.nodes.alias_2;
    edited.edges.group = { from: "alias_0", to: "alias_1", relation: "contains" };
    graph.documents.apply(human, "membership", writeGraphYaml(edited.snapshot, edited), graph.provenance(human));
    const inspections = vi.spyOn(graph.documents, "inspect");
    try {
      const result = graph.changes(human, cursor) as { changes: { bucket: string; id: string; record: ResearchNode }[]; hasMore: boolean };
      const nodes = new Map(result.changes.filter(change => change.bucket === "nodes").map(change => [change.id, change.record]));
      expect(result.hasMore).toBe(false);
      expect(nodes.size).toBe(31);
      expect(nodes.get("alias_0")).toMatchObject({ summary: "Update 24", resourceVersion: 25, data: { members: ["alias_1"] } });
      expect(nodes.get("alias_1")).toMatchObject({ title: "Renamed alias", summary: "Update 24" });
      expect(nodes.get("alias_2")).toMatchObject({ archived: true });
      expect(result.changes.find(change => change.bucket === "edges" && change.id === "group")?.record).toMatchObject({ source: "alias_0", target: "alias_1", archived: false });
      expect(inspections.mock.calls.length).toBeLessThanOrEqual(2);
    } finally { inspections.mockRestore(); }
  });
  it("keeps the original change cursor across repeated updates and reads fresh state on the next request", () => {
    const node = (graph.mutate(human, "node_add", { request: "resource", data: JSON.stringify({ type: "note", title: "Evidence" }) }) as { node: ResearchNode }).node;
    const resource = graph.resourceNode(human.project, node.ref!);
    const cursor = String(graph.repo.cursor(human.project));
    for (let i = 1; i <= 105; i++) graph.repo.put(human.project, "node-resources", resource.id, { ...resource, version: i + 1, summary: "Update " + i }, i);
    type Page = { changes: { bucket: string; id: string; record: ResearchNode }[]; cursor: number; hasMore: boolean };
    const first = graph.changes(human, cursor) as Page;
    expect(first.hasMore).toBe(true);
    expect(first.cursor).toBe(Number(cursor) + 100);
    expect(first.changes.find(change => change.id === node.id)?.record.summary).toBe("Update 105");
    graph.repo.put(human.project, "node-resources", resource.id, { ...resource, version: 107, summary: "Latest request" }, 106);
    const next = graph.changes(human, String(first.cursor)) as Page;
    expect(next.hasMore).toBe(false);
    expect(next.cursor).toBe(Number(cursor) + 106);
    expect(next.changes.find(change => change.id === node.id)?.record).toMatchObject({ summary: "Latest request", resourceVersion: 107 });
  });
  it("marks approvals stale when a target version changes", () => {
    const evidence = graph.mutate(human, "node_add", { request: "evidence", data: JSON.stringify({ type: "note", title: "证据" }) }) as { node: ResearchNode };
    const review = graph.mutate(human, "node_add", { request: "review", data: JSON.stringify({ type: "review", title: "审查", data: { targets: { [evidence.node.id]: 1 } } }) }) as { node: ResearchNode };
    graph.mutate(human, "review_decide", { request: "approve", node: review.node.id, version: "1", decision: "approved", targets: JSON.stringify({ [evidence.node.id]: 1 }) });
    graph.mutate(human, "node_update", { request: "change", node: evidence.node.id, version: "1", data: JSON.stringify({ summary: "新证据" }) });
    const page = graph.read(human, {}) as { nodes: ResearchNode[] };
    expect(page.nodes.find((node) => node.id === review.node.id)?.data.reviewStatus).toBe("stale");
  });
});
