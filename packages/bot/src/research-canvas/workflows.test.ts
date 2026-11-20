import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ResearchNode, ResearchRun, WorkflowBatch, WorkflowCandidate, WorkflowDraft, WorkflowExecution, WorkflowFlag, WorkflowRule,
} from "@claude-bot/research-canvas-contract";
import { Store } from "../store/store.js";
import { ManagedExecutionSupervisor } from "../managed-execution/supervisor.js";
import { ResourceRecoveryService } from "../resources/recovery.js";
import { ResearchGraph, type ResearchContext } from "./graph.js";
import { readGraphYaml, writeGraphYaml } from "./graph-yaml.js";
import { ResearchResources } from "./resources.js";
import { ResearchAutomation } from "./automation.js";
import { ResearchWorkflows, summarizeWorkflowFlags, validateCandidates } from "./workflows.js";
import { ensurePromptWindow, PROMPT_WINDOW_BYTES } from "./rules.js";

describe("explicit durable research workflows", () => {
  let root: string, store: Store, graph: ResearchGraph, resources: ResearchResources, automation: ResearchAutomation, workflows: ResearchWorkflows, supervisor: ManagedExecutionSupervisor;
  const context: ResearchContext = { project: "project", actor: { kind: "human", owner: "alice" } };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-26T13:00:00Z"));
    root = mkdtempSync(join(tmpdir(), "research-workflows-"));
    store = new Store(join(root, "state.db"));
    store.createSharedAppInstance({ app_id: "research-v2", instance_key: "project", creator: "alice", status: "open", created_at: new Date().toISOString() }, "owner");
    graph = new ResearchGraph(store, root);
    resources = new ResearchResources(graph, root, { list: async () => [], validate: async () => {}, read: async () => ({}), send: async () => "receipt", transcribe: async () => ({ text: "fixture", model: null }) }, () => {}, () => {});
    supervisor = new ManagedExecutionSupervisor(store.managedExecutions, new ResourceRecoveryService(store.resourceWaiters));
    automation = new ResearchAutomation(graph, resources, supervisor, {
      authorized: () => true, open: async () => ({ model: "fixture", loop: { run: async () => ({ kind: "done", text: "fixture", toolCalls: 0 }) } }),
      filter: async () => ({ wake: true, reason: "fixture" }), tools: [], invoke: async () => ({}),
    }, () => {});
    workflows = new ResearchWorkflows(graph, automation, resources);
  });
  afterEach(async () => {
    workflows.close(); automation.close(); await supervisor.close(); graph.close(); store.close();
    vi.useRealTimers(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true });
  });
  function node(type = "note", title = type, body = ""): ResearchNode {
    return (graph.mutate(context, "node_add", { request: crypto.randomUUID(), data: JSON.stringify({ type, title, data: type === "agent" ? {} : { text: body } }) }) as { node: ResearchNode }).node;
  }
  async function agent() {
    const target = node("agent");
    await resources.bind(context, { request: crypto.randomUUID(), node: target.id, data: JSON.stringify({ kind: "agent", resource: "fixture-model", config: { model: "fixture" } }) });
    return target;
  }
  const params = (data: unknown, rest: Record<string, string> = {}) => ({ request: crypto.randomUUID(), version: "0", data: JSON.stringify(data), ...rest });
  const candidate = (id: string, dependencies: string[] = []): WorkflowCandidate => ({ id, title: id, summary: "", body: "请实现并报告 " + id, kind: "task", state: "pending", dependencies, evidence: [] });
  function batch(items: WorkflowCandidate[]) {
    const source = node("note", "讨论来源");
    return workflows.prepareCandidates(context, { request: "source-extraction", source: source.ref!, items }).batch;
  }
  function confirm(batch: WorkflowBatch) {
    return workflows.saveCandidates(context, params({ items: batch.items.map(item => ({ ...item, state: "confirmed" })) }, { batch: batch.id, version: String(batch.version) })).batch;
  }

  it("saving context does not launch, explicit startup injects it, and continuation reuses the same conversation", async () => {
    const target = await agent(), material = node("note", "测试依据", "科研正文");
    let draft = workflows.saveDraft(context, params({ title: "验证依据", agent: target.id, contexts: [material.id], prompt: "读取并验证" })).draft;
    expect(graph.repo.runs(context.project)).toHaveLength(0);
    const request = { request: "start-one", draft: draft.id, version: String(draft.version) };
    const started = workflows.startDraft(context, request);
    draft = started.draft;
    expect(started.run.prompt).toContain(material.ref);
    expect(started.run.prompt).toContain("读取并验证");
    expect(workflows.startDraft(context, request).run.id).toBe(started.run.id);
    expect(workflows.startDraft(context, { ...request, request: "another-click" }).run.id).toBe(started.run.id);
    const continued = workflows.continueDraft(context, { request: "continue-one", draft: draft.id, prompt: "补充新的观察" });
    expect(continued.run.conversation).toBe(started.run.conversation);
    expect(continued.run.id).not.toBe(started.run.id);
    expect(graph.repo.runs(context.project)).toHaveLength(2);
  });

  it("starts a draft whose instruction and selected context summaries exceed the old 24k composed cap", async () => {
    const target = await agent();
    const contexts = Array.from({ length: 6 }, (_, i) => (graph.mutate(context, "node_add", { request: crypto.randomUUID(),
      data: JSON.stringify({ type: "note", title: `依据 ${i}`, summary: `摘要${i}：` + "证".repeat(1990) }) }) as { node: ResearchNode }).node);
    const draft = workflows.saveDraft(context, params({ title: "长任务", agent: target.id, contexts: contexts.map(item => item.id), prompt: "任务说明".repeat(4900) })).draft;
    const started = workflows.startDraft(context, { request: "long-start", draft: draft.id, version: String(draft.version) });
    expect(started.run.prompt.length).toBeGreaterThan(24_000);
    for (const item of contexts) expect(started.run.prompt).toContain(item.summary);
    expect(() => ensurePromptWindow("长".repeat(PROMPT_WINDOW_BYTES / 3 + 1))).toThrow("超过 Agent 单条消息的 384 KiB");
  });
  it("keeps flags asynchronous, deduplicates answer delivery, and does not impose a global waiting policy", async () => {
    const target = await agent(), artifact = node("finding", "待审观察");
    const original = (automation.send(context, { request: "original-run", node: target.id, prompt: "继续观察" }) as { run: ResearchRun }).run;
    const agentContext: ResearchContext = { ...context, actor: { kind: "agent", owner: "alice", agent: target.id, run: original.id } };
    let flag = workflows.openFlag(agentContext, params({ kind: "decision", title: "异常结果是否可信", background: "两种解释尚未排除", related: [artifact.id], affected: [artifact.id], options: ["复验", "记录限制"] })).flag;
    expect(flag.conversation).toBe(original.conversation);
    flag = workflows.saveFlag(context, params({ answer: "先复验并保留异常", state: "resolved" }, { flag: flag.id, version: String(flag.version) })).flag;
    expect(graph.repo.runs(context.project)).toHaveLength(1);
    const first = workflows.continueFlag(context, { request: "deliver-answer", flag: flag.id, version: String(flag.version) });
    const again = workflows.continueFlag(context, { request: "deliver-again", flag: flag.id, version: String(flag.version) });
    expect(first.run.conversation).toBe(original.conversation);
    expect(again.run.id).toBe(first.run.id);
    expect(graph.repo.runs(context.project)).toHaveLength(2);
    const flag2 = workflows.openFlag(agentContext, params({ kind: "review", title: "仍待核对", related: [artifact.id] })).flag;
    expect(() => automation.send(context, { request: "independent-work", node: target.id, prompt: "按本任务说明继续" })).not.toThrow();
    expect(workflows.read(context).flags.find(item => item.id === flag2.id)?.state).toBe("open");
  });

  it("summarizes review and decision counts through multiple ancestors without counting shared paths twice", () => {
    const goal = node("goal"), child = node("goal"), artifact = node("finding");
    for (const [source, target] of [[goal.id, child.id], [goal.id, artifact.id], [child.id, artifact.id]])
      graph.mutate(context, "edge_add", { request: crypto.randomUUID(), source, target, label: "contains" });
    workflows.openFlag(context, params({ kind: "review", title: "结果待审", related: [artifact.id, child.id] }));
    workflows.openFlag(context, params({ kind: "decision", title: "参数选择", related: [artifact.id] }));
    const page = workflows.read(context);
    expect(page.summaries[goal.id]).toMatchObject({ review: 1, decision: 1 });
    expect(page.summaries[goal.id].ids).toHaveLength(2);
  });

  it("only publishes confirmed edited candidates and replays publication across uncertain graph response", () => {
    const initial = batch([candidate("keep"), candidate("duplicate"), candidate("misheard")]);
    const saved = workflows.saveCandidates(context, params({ items: initial.items.map(item => ({ ...item, title: item.id === "keep" ? "人工修正的任务" : item.title, state: item.id === "keep" ? "confirmed" : item.id === "duplicate" ? "deleted" : "edited" })) }, { batch: initial.id, version: String(initial.version) })).batch;
    const request = params({ mode: "publish" }, { request: "publish-once", batch: saved.id, version: String(saved.version) });
    const patch = graph.documents.patch.bind(graph.documents);
    let failed = false;
    vi.spyOn(graph.documents, "patch").mockImplementation((...args) => {
      const result = patch(...args);
      if (!failed && args[1].startsWith("publish_")) { failed = true; throw new Error("fixture response lost"); }
      return result;
    });
    expect(() => workflows.publishCandidates(context, request)).toThrow("response lost");
    const result = workflows.publishCandidates(context, request);
    const replay = workflows.publishCandidates(context, request);
    expect(Object.keys(result.batch.published)).toEqual(["keep"]);
    expect(replay.batch.published.keep.node).toBe(result.batch.published.keep.node);
    expect([...graph.records<ResearchNode>(context.project, "nodes")].filter(node => node.title === "人工修正的任务")).toHaveLength(1);
    expect(graph.repo.runs(context.project)).toHaveLength(0);
    expect(workflows.trace(context, { source: initial.source }).traces[0].targets[0].id).toBe(result.batch.published.keep.node);
    expect(workflows.trace(context, { node: result.batch.published.keep.node }).traces[0].sources).toContain(initial.source);
  });

  it("persists explicit execution scope, honors dependencies, and never dispatches the same candidate twice after recovery", async () => {
    const target = await agent(), confirmed = confirm(batch([candidate("first"), candidate("second", ["first"])]));
    const data = { mode: "publish_execute", execution: { scope: ["first", "second"], agents: { first: target.id, second: target.id }, parallelism: 2 } };
    const released = workflows.publishCandidates(context, params(data, { batch: confirmed.id, version: String(confirmed.version) }));
    expect(released.execution?.scope).toEqual(["first", "second"]);
    workflows.reconcile();
    let execution = workflows.read(context).executions[0];
    expect(execution.items.first.state).toBe("running");
    expect(execution.items.second.state).toBe("pending");
    const firstRun = graph.repo.get<ResearchRun>(context.project, "runs", execution.items.first.run!)!;
    graph.repo.put(context.project, "runs", firstRun.id, { ...firstRun, status: "completed", finished: new Date().toISOString() });
    workflows.close(); workflows = new ResearchWorkflows(graph, automation, resources);
    workflows.reconcile();
    execution = workflows.read(context).executions[0];
    expect(execution.items.second.state).toBe("running");
    expect(graph.repo.runs(context.project)).toHaveLength(2);
    workflows.reconcile();
    workflows.publishCandidates(context, params(data, { batch: released.batch.id, version: String(released.batch.version) }));
    workflows.reconcile();
    expect(graph.repo.runs(context.project)).toHaveLength(2);
    expect(workflows.read(context).executions).toHaveLength(1);
  });

  it("refuses cyclic and deleted dependencies before publishing or queueing", () => {
    expect(() => validateCandidates([candidate("a", ["b"]), candidate("b", ["a"])])).toThrow("循环");
    const initial = batch([candidate("a"), candidate("b", ["a"])]);
    const saved = workflows.saveCandidates(context, params({ items: initial.items.map(item => ({ ...item, state: item.id === "a" ? "deleted" : "confirmed" })) }, { batch: initial.id, version: String(initial.version) })).batch;
    expect(() => workflows.publishCandidates(context, params({ mode: "publish" }, { batch: saved.id, version: String(saved.version) }))).toThrow("依赖");
    expect(Object.keys(workflows.read(context).batches[0].published)).toHaveLength(0);
  });

  it("injects current scoped rules on both start and continuation, checks objective omissions, and allows disabling wrong rules", async () => {
    const target = await agent(), task = node("task", "测试轮次", "只有测试结果，没有归档链接");
    const ruleData = { title: "测试需要报告", instruction: "每轮测试附报告归档链接", motivation: "结果可复查", enabled: true, scope: { kind: "descendants", ids: [task.id] }, sources: [{ source: task.ref }], stages: ["start", "continue", "completion"], checks: [{ kind: "required_text", value: "报告归档：" }], conflicts: [], enforcement: "inform" };
    let rule = workflows.saveRule(context, params(ruleData)).rule;
    const draft = workflows.saveDraft(context, params({ title: "核对报告", agent: target.id, contexts: [task.id], prompt: "开始测试" })).draft;
    const started = workflows.startDraft(context, { request: "rule-start", draft: draft.id, version: String(draft.version) });
    expect(started.run.prompt).toContain("每轮测试附报告归档链接");
    expect(workflows.read(context).flags.some(flag => flag.title.includes("检查缺口"))).toBe(true);
    const check = workflows.checkRules(context, { data: JSON.stringify({ contexts: [task.id], stage: "completion" }) });
    expect(check.checks[0].status).toBe("missing");
    rule = workflows.saveRule(context, params({ ...ruleData, instruction: "新的报告要求" }, { rule: rule.id, version: String(rule.version) })).rule;
    const continued = workflows.continueDraft(context, { request: "rule-next", draft: draft.id, prompt: "继续测试" });
    expect(continued.run.prompt).toContain("新的报告要求");
    rule = workflows.saveRule(context, params({ ...ruleData, enabled: false }, { rule: rule.id, version: String(rule.version) })).rule;
    const last = workflows.continueDraft(context, { request: "rule-disabled", draft: draft.id, prompt: "继续测试" });
    expect(last.run.prompt).not.toContain("适用的项目约束");
  });

  it("only explicitly blocking rules stop a stage and still expose their review flag", async () => {
    const target = await agent();
    workflows.saveRule(context, params({ title: "指定 Agent 需上下文", instruction: "完成验证前不要启动此任务", motivation: "", enabled: true, scope: { kind: "agents", ids: [target.id] }, sources: [], stages: ["start"], checks: [{ kind: "manual", value: "需要独立核对" }], conflicts: [], enforcement: "block" }));
    expect(() => automation.send(context, { request: "blocked-stage", node: target.id, prompt: "测试" })).toThrow("明确阻止");
    expect(graph.repo.runs(context.project)).toHaveLength(0);
    expect(workflows.read(context).flags).toHaveLength(1);
  });

  it("does not let a source or agent publication request grant execution authority", async () => {
    const target = await agent(), confirmed = confirm(batch([candidate("a")]));
    const agentContext: ResearchContext = { ...context, actor: { kind: "agent", owner: "alice", agent: target.id } };
    expect(() => workflows.publishCandidates(agentContext, params({ mode: "publish_execute", execution: { scope: ["a"], agents: { a: target.id }, parallelism: 1 } }, { batch: confirmed.id, version: String(confirmed.version) }))).toThrow("明确提交");
    expect(graph.repo.runs(context.project)).toHaveLength(0);
  });
  it("links later affected results without re-sending an already delivered answer", async () => {
    const target = await agent(), original = (automation.send(context, { request: "original", node: target.id, prompt: "观察" }) as { run: ResearchRun }).run;
    const agentContext: ResearchContext = { ...context, actor: { kind: "agent", owner: "alice", agent: target.id, run: original.id } };
    let flag = workflows.openFlag(agentContext, params({ kind: "decision", title: "观察解释", related: [] })).flag;
    flag = workflows.saveFlag(context, params({ answer: "采用第二种解释", state: "resolved" }, { flag: flag.id, version: String(flag.version) })).flag;
    const delivered = workflows.continueFlag(context, { request: "deliver", flag: flag.id, version: String(flag.version) });
    const result = node("finding", "依赖此解释的结果");
    const linked = workflows.linkFlag(agentContext, params({ affected: [result.id] }, { flag: flag.id, version: String(delivered.flag.version) })).flag;
    expect(linked.affected).toEqual([result.ref]);
    expect(workflows.continueFlag(context, { request: "deliver-linked", flag: flag.id, version: String(linked.version) }).run.id).toBe(delivered.run.id);
    expect(graph.repo.runs(context.project)).toHaveLength(2);
  });

  it("exposes explicitly declared overlapping rule conflicts without inventing a project-wide stop policy", async () => {
    const target = await agent();
    const base = { title: "保留原始证据", instruction: "材料注明限制", motivation: "", enabled: true, scope: { kind: "project", ids: [] }, sources: [], stages: ["start"], checks: [], conflicts: [], enforcement: "inform" };
    const first = workflows.saveRule(context, params(base)).rule;
    workflows.saveRule(context, params({ ...base, title: "当前研究策略存在分歧", conflicts: [first.id] }));
    expect(() => automation.send(context, { request: "conflicting-guidance", node: target.id, prompt: "按任务说明推进" })).not.toThrow();
    expect(workflows.read(context).flags.some(flag => flag.kind === "decision" && flag.background.includes(first.id))).toBe(true);
  });

  it("records bulk graph changes from one indexed snapshot with archived targets and original provenance", async () => {
    const source = node("note", "来源材料"), author = await agent();
    const { run } = automation.send(context, { request: "trace-run", node: author.id, prompt: "整理图结构" }, { contexts: [source.ref!] }) as { run: ResearchRun };
    const actorContext: ResearchContext = { ...context, actor: { kind: "agent", owner: "alice", agent: author.id, run: run.id, model: "fixture", trigger: "trace-fixture" } };
    const seeded = readGraphYaml(graph.documents.snapshot(actorContext).yaml);
    const ids = Array.from({ length: 240 }, (_, index) => "bulk_" + String(index).padStart(3, "0"));
    for (const id of ids) seeded.nodes[id] = { ref: source.ref!, label: id };
    graph.documents.apply(actorContext, "trace-seed", writeGraphYaml(seeded.snapshot, seeded), graph.provenance(actorContext));
    const edited = readGraphYaml(graph.documents.snapshot(actorContext).yaml);
    const removed = ids.slice(0, 178), updated = ids.at(-1)!;
    for (const id of removed) delete edited.nodes[id];
    edited.nodes[updated].label = "更新标题";
    edited.nodes.created = { ref: source.ref!, label: "新增卡片" };
    edited.edges.related = { from: updated, to: "created", relation: "supports" };
    const request = { request: "trace-bulk", yaml: writeGraphYaml(edited.snapshot, edited) };
    const stamp = graph.provenance(actorContext);
    const result = graph.documents.apply(actorContext, request.request, request.yaml, stamp);
    const inspect = vi.spyOn(graph.documents, "inspect"), nodeRead = vi.spyOn(graph, "node");
    const list = vi.spyOn(graph.repo, "list");
    workflows.recordChange(actorContext, "graph_apply", request, result);
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(nodeRead).not.toHaveBeenCalled();
    expect(list.mock.calls.filter(([, bucket]) => bucket === "graph-nodes")).toHaveLength(2);
    const trace = workflows.trace(context, {}).traces[0];
    expect(trace).toMatchObject({ action: "graph_apply", state: "applied", outcome: "merged", actor: stamp });
    expect(trace.sources).toEqual(expect.arrayContaining([source.ref, "agent:" + author.id, "run:" + run.id]));
    expect(trace.targets.filter(target => target.operation === "removed").map(target => target.id).sort()).toEqual(removed);
    expect(trace.targets.filter(target => target.operation === "updated")).toEqual([{ kind: "node", id: updated, operation: "updated" }]);
    expect(trace.targets.filter(target => target.operation === "created")).toEqual([{ kind: "node", id: "created", operation: "created" }]);
    expect(trace.targets.filter(target => target.kind === "edge")).toEqual([{ kind: "edge", id: "related", operation: "related" }]);
    expect(trace.targets).toHaveLength(181);

    vi.setSystemTime(new Date("2026-09-26T13:01:00Z"));
    const resumed = { ...actorContext, actor: { ...actorContext.actor, run: "another-turn" } };
    expect(graph.documents.apply(resumed, request.request, request.yaml, graph.provenance(resumed))).toEqual(result);
    workflows.recordChange(resumed, "graph_apply", request, result);
    expect(workflows.trace(context, {}).traces).toEqual([trace]);
  });

  it("keeps missing graph targets queryable and skips node inspection for edge-only or unchanged edits", () => {
    const inspect = vi.spyOn(graph.documents, "inspect");
    workflows.recordChange(context, "graph_apply", { request: "missing-target" }, { status: "merged_with_conflicts", changes: { nodes: ["removed-identity"] } });
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(workflows.trace(context, { node: "removed-identity" }).traces[0].targets).toEqual([{ kind: "node", id: "removed-identity", operation: "removed" }]);
    inspect.mockClear();
    workflows.recordChange(context, "graph_apply", { request: "edge-only" }, { status: "merged", changes: { edges: ["edge-only"] } });
    workflows.recordChange(context, "graph_apply", { request: "unchanged" }, { status: "unchanged", changes: { nodes: [], edges: [] } });
    expect(inspect).not.toHaveBeenCalled();
    expect(workflows.trace(context, {}).traces).toHaveLength(2);
  });

  it("does not label unknown or rejected changes as applied, and records suggestions separately", () => {
    const target = node("note", "可编辑材料");
    for (const status of ["unknown", "rejected", "failed"])
      workflows.recordChange(context, "document_write", { request: status, node: target.id }, { status });
    expect(workflows.trace(context, { node: target.id }).traces).toEqual([]);
    workflows.recordChange(context, "document_write", { request: "proposal", node: target.id }, { proposal: { id: "proposal" } });
    workflows.recordChange(context, "document_write", { request: "committed", node: target.id }, { text: "saved" });
    expect(workflows.trace(context, { node: target.id }).traces.map(trace => trace.state).sort()).toEqual(["applied", "suggested"]);
    workflows.recordChange(context, "paper_sync_run", { request: "check-only", node: target.id, localDigest: "local", cloudDigest: "cloud" }, { binding: { node: target.id, localNode: target.id, status: "synced" }, local: { digest: "local" }, cloud: { digest: "cloud" } });
    const checked = workflows.trace(context, { node: target.id }).traces.find(trace => trace.action === "paper_sync_run");
    expect(checked).toMatchObject({ state: "observed", targets: [{ operation: "checked" }] });
  });

  it("rejects rebinding drift when continuing an existing session or dispatching a reviewed plan", async () => {
    const target = await agent();
    const draft = workflows.saveDraft(context, params({ title: "绑定稳定性", agent: target.id, contexts: [], prompt: "开始工作" })).draft;
    const started = workflows.startDraft(context, { request: "bound-start", draft: draft.id, version: String(draft.version) });
    const confirmed = confirm(batch([candidate("next")]));
    workflows.publishCandidates(context, params({ mode: "publish_execute", execution: { scope: ["next"], agents: { next: target.id }, parallelism: 1 } }, { batch: confirmed.id, version: String(confirmed.version) }));
    await resources.bind(context, { request: "rebind", node: target.id, data: JSON.stringify({ kind: "agent", resource: "different-runtime", config: { model: "fixture" } }) });
    expect(() => workflows.continueDraft(context, { request: "bound-continue", draft: draft.id, prompt: "继续原任务" })).toThrow("绑定已经变化");
    expect(() => workflows.continueRun(context, { request: "bound-run-continue", run: started.run.id, prompt: "继续原任务" })).toThrow("绑定已经变化");
    workflows.reconcile();
    expect(workflows.read(context).executions[0].items.next).toMatchObject({ state: "blocked", run: null });
    expect(graph.repo.runs(context.project)).toHaveLength(1);
  });

});
