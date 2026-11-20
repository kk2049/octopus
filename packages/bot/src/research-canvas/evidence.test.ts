import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import type { ResearchNode, ResearchEvidence } from "@claude-bot/research-canvas-contract";
import { Store } from "../store/store.js";
import { ResearchGraph, type ResearchContext } from "./graph.js";
import { ResearchEvidenceService } from "./evidence.js";

describe("research evidence and independent latest/adopted reports", () => {
  let root: string, store: Store, graph: ResearchGraph, service: ResearchEvidenceService, source: string;
  const context: ResearchContext = { project: "p", actor: { kind: "human", owner: "alice" } };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "research-evidence-"));
    store = new Store(join(root, "store.sqlite"));
    store.createSharedAppInstance({ app_id: "research-v2", instance_key: "p", creator: "alice", status: "open", created_at: new Date().toISOString() }, "owner");
    graph = new ResearchGraph(store, root, () => "2026-09-26T00:00:00Z");
    service = new ResearchEvidenceService(graph, () => {});
    source = (graph.mutate(context, "node_add", { request: "source", data: JSON.stringify({ type: "note", title: "原始文献", data: { text: "引用正文" } }) }) as { node: ResearchNode }).node.id;
  });
  afterEach(() => { graph.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const input = (request: string, extra = {}) => ({ request, data: JSON.stringify({ title: request, series: "research-a", kind: "literature", claim: "inference", motivation: "减少重复调研", goal: "检查假设", design: "比较文献", execution: "人工与Agent归档", results: "存在不同结果", analysis: "取决于条件", conclusion: "需要进一步验证", sources: [source], ...extra }) });
  const publish = (request: string, extra = {}) => (service.publish(context, input(request, extra)) as { report: ResearchEvidence }).report;
  it("keeps adopted evidence stable while a new report becomes latest, including equal timestamps", () => {
    const first = publish("first");
    service.adopt(context, { request: "adopt-first", node: first.node });
    const second = publish("second");
    expect(service.read(context, first.node)).toMatchObject({ report: { id: first.id }, latest: { id: second.id }, adopted: { id: first.id } });
    expect(service.read(context, second.node).adoptedBy?.owner).toBe("alice");
  });
  it("replays publication without duplicate graph members, body versions, or report rows", () => {
    const first = publish("once"), cursor = graph.repo.cursor("p");
    expect(publish("once")).toEqual(first);
    expect(graph.repo.cursor("p")).toBe(cursor);
    expect([...graph.records("p", "evidence-reports")]).toHaveLength(1);
    expect(() => publish("once", { conclusion: "changed" })).toThrow("请求 ID");
  });
  it("refuses incomplete experiments and fabricated evidence before creating a report", () => {
    expect(() => publish("bad-experiment", { kind: "experiment" })).toThrow("代码版本");
    expect(() => publish("bad-source", { sources: ["missing"] })).toThrow("节点不存在");
    expect([...graph.records("p", "evidence-reports")]).toHaveLength(0);
  });
  it("does not turn an agent's report into human acceptance or override concurrent acceptance", () => {
    const first = publish("first"), second = publish("second");
    const agent: ResearchContext = { ...context, actor: { ...context.actor, kind: "agent", agent: "worker" } };
    expect(() => service.adopt(agent, { request: "forged", node: first.id })).toThrow("人的明确动作");
    service.adopt(context, { request: "first-accept", node: first.id });
    expect(() => service.adopt(context, { request: "stale", node: second.id })).toThrow("采纳记录已变化");
    service.adopt(context, { request: "current", node: second.id, expected: first.id });
    expect(service.read(context, first.id).adopted?.id).toBe(second.id);
  });
  it("keeps the six sections in the real archived Markdown file and revokes project reads", () => {
    const report = publish("paper");
    const text = graph.texts.read("p", graph.resolveResource("p", report.node)).text;
    for (const heading of ["动机", "目标", "设计与方法", "执行方式", "结果", "分析"]) expect(text).toContain(`## ${heading}`);
    store.removeSharedAppMember("research-v2", "p", "alice");
    expect(() => service.read(context, report.id)).toThrow("撤销");
  });
});
