import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ResearchNode,
  ResearchEvent,
  ResearchRun,
  ResearchSubscription,
} from "@claude-bot/research-canvas-contract";
import { Store } from "../store/store.js";
import { ManagedExecutionSupervisor } from "../managed-execution/supervisor.js";
import { ResourceRecoveryService } from "../resources/recovery.js";
import { ResearchGraph, type ResearchContext } from "./graph.js";
import { ResearchResources } from "./resources.js";
import { ResearchAutomation, type ResearchExecution } from "./automation.js";

describe("durable research event execution", () => {
  let root: string,
    store: Store,
    graph: ResearchGraph,
    resources: ResearchResources,
    supervisor: ManagedExecutionSupervisor,
    automation: ResearchAutomation,
    execution: ResearchExecution;
  const context: ResearchContext = {
    project: "project",
    actor: { kind: "human", owner: "alice" },
  };
  const now = Date.parse("2026-09-17T12:00:00Z");
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    root = mkdtempSync(join(tmpdir(), "research-events-"));
    store = new Store(join(root, "state.db"));
    graph = new ResearchGraph(store, root);
    store.createSharedAppInstance(
      {
        app_id: "research-v2",
        instance_key: "project",
        creator: "alice",
        status: "open",
        created_at: new Date().toISOString(),
      },
      "owner",
    );
    resources = new ResearchResources(
      graph,
      root,
      {
        list: async () => [],
        validate: async () => {},
        read: async () => ({}),
        send: async () => "receipt",
        transcribe: async () => ({ text: "text", model: null }),
      },
      (event) => automation.emit(event),
      () => {},
    );
    supervisor = new ManagedExecutionSupervisor(
      store.managedExecutions,
      new ResourceRecoveryService(store.resourceWaiters),
      () => now,
    );
    execution = {
      authorized: () => true,
      open: vi.fn<ResearchExecution["open"]>(async () => ({
        model: "selected-model",
        loop: {
          run: async (request) => {
            request.onUsage?.({
              id: "provider-receipt",
              model: "actual-model",
              input: 12,
              output: 6,
            });
            request.onAssistant?.("结论");
            return { kind: "done", text: "结论", toolCalls: 0 };
          },
        },
      })),
      filter: vi.fn(async () => ({ wake: true, reason: "relevant" })),
      tools: [],
      invoke: async () => ({}),
    };
    automation = new ResearchAutomation(
      graph,
      resources,
      supervisor,
      execution,
      () => {},
      () => now,
    );
  });
  afterEach(async () => {
    automation.close();
    await supervisor.close();
    graph.close();
    store.close();
    vi.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  });
  function node(type: string, data = {}) {
    return (
      graph.mutate(context, "node_add", {
        request: crypto.randomUUID(),
        data: JSON.stringify({ type, title: type, data }),
      }) as { node: ResearchNode }
    ).node;
  }
  async function bind(target: ResearchNode) {
    await resources.bind(context, {
      request: target.id,
      node: target.id,
      data: JSON.stringify({
        kind: target.type,
        resource: target.type === "group" ? "oc_test" : "model-resource",
        config: { model: "selected-model" },
      }),
    });
  }
  async function subscription(type = "group.message", mode = "mention") {
    const source = node(
        type === "group.message"
          ? "group"
          : type === "agent.completed"
            ? "agent"
            : "collection",
      ),
      target = node("agent");
    await bind(target);
    if (source.type === "group") await bind(source);
    const { subscription } = automation.save(context, {
      request: crypto.randomUUID(),
      data: JSON.stringify({
        source: source.id,
        target: target.id,
        event: type,
        enabled: true,
        filter: { mode, mentionId: "ou_bot", statuses: ["completed"] },
        prompt: "分析",
      }),
    }) as { subscription: ResearchSubscription };
    return { source, target, subscription };
  }
  const event = (
    source: string,
    rest: Partial<ResearchEvent> = {},
  ): ResearchEvent => ({
    id: "event-one",
    project: "project",
    source,
    type: "group.message",
    version: 1,
    at: new Date(now).toISOString(),
    root: "event-one",
    trigger: "feishu:ou_bob",
    chain: [],
    payload: { senderType: "user", mentions: ["ou_bot"], text: "请分析" },
    ...rest,
  });
  const runs = () => [...graph.records<ResearchRun>("project", "runs")];
  it("deduplicates events and executes them in a conversation separate from manual work", async () => {
    const { source, target, subscription: listener } = await subscription();
    automation.send(context, {
      request: "manual",
      node: target.id,
      prompt: "手动任务",
    });
    automation.emit(event(source.id));
    automation.emit(event(source.id));
    await automation.pump();
    expect(runs()).toHaveLength(2);
    expect(new Set(runs().map((run) => run.conversation))).toEqual(
      new Set([`manual:${target.id}`, listener.conversation]),
    );
    await supervisor.sweep();
    expect(runs().every((run) => run.status === "completed")).toBe(true);
    expect(runs()[0]).toMatchObject({
      model: "actual-model",
      usage: { input: 12, output: 6 },
    });
    expect(runs().find((run) => run.subscription)?.trigger).toBe(
      "feishu:ou_bob",
    );
    expect(automation.history(context, target.id)).toMatchObject({
      manualConversation: `manual:${target.id}`,
      messages: expect.arrayContaining([
        expect.objectContaining({ conversation: `manual:${target.id}`, text: "手动任务" }),
      ]),
    });
  });
  it("serializes messages on one listener while retaining queued work across host restart", async () => {
    const { source } = await subscription();
    automation.emit(event(source.id));
    automation.emit(event(source.id, { id: "event-two" }));
    await automation.pump();
    expect(runs().filter((run) => run.status === "running")).toHaveLength(1);
    expect(runs().filter((run) => run.status === "queued")).toHaveLength(1);
    automation.close();
    automation = new ResearchAutomation(
      graph,
      resources,
      supervisor,
      execution,
      () => {},
      () => now,
    );
    await supervisor.sweep();
    await automation.pump();
    await supervisor.sweep();
    expect(runs().every((run) => run.status === "completed")).toBe(true);
    expect(execution.open).toHaveBeenCalledTimes(2);
  });
  it("leaves model filter failures visible and never falls back to an expensive run", async () => {
    const { source, subscription: listener } = await subscription(
      "group.message",
      "model",
    );
    vi.mocked(execution.filter).mockRejectedValue(new Error("filter offline"));
    automation.emit(event(source.id));
    await automation.pump();
    expect(runs()).toHaveLength(0);
    expect(
      graph.repo.get<ResearchSubscription>(
        "project",
        "subscriptions",
        listener.id,
      ),
    ).toMatchObject({ state: "error", error: "filter offline" });
    await automation.pump();
    expect(execution.filter).toHaveBeenCalledOnce();
    expect(execution.open).not.toHaveBeenCalled();
  });
  it("does not wake for bot echoes, an absent stable mention, or a repeated causal edge", async () => {
    const { source, subscription: listener } = await subscription();
    automation.emit(
      event(source.id, {
        id: "bot",
        payload: { senderType: "app", mentions: ["ou_bot"] },
      }),
    );
    automation.emit(
      event(source.id, {
        id: "plain",
        payload: { senderType: "user", mentions: [], text: "@名字看起来一样" },
      }),
    );
    automation.emit(event(source.id, { id: "cycle", chain: [listener.id] }));
    await automation.pump();
    expect(runs()).toEqual([]);
  });
  it("cancels queued work when the owner loses authority", async () => {
    const { source } = await subscription();
    automation.emit(event(source.id));
    execution.authorized = () => false;
    await automation.pump();
    expect(runs()).toHaveLength(0);
    expect(execution.filter).not.toHaveBeenCalled();
  });
  it("preserves the causal chain when an Agent starts another Agent and bounds cycles", async () => {
    const target = node("agent");
    await bind(target);
    const parent = { id: "parent", root: "root-event", chain: ["listener"] };
    graph.repo.put("project", "runs", parent.id, parent);
    const caller: ResearchContext = {
      project: "project",
      actor: { kind: "agent", owner: "alice", run: parent.id },
    };
    const params = { node: target.id, prompt: "continue", request: "child" };
    const { run } = automation.send(caller, params) as { run: ResearchRun };
    expect(run).toMatchObject({
      root: "root-event",
      chain: ["listener", `call:${target.id}`],
    });
    expect(automation.send(caller, params)).toEqual({ run });
    expect(() =>
      automation.send(
        { ...caller, actor: { ...caller.actor, run: run.id } },
        { ...params, request: "cycle" },
      ),
    ).toThrow("因果链");
    graph.repo.put("project", "runs", "long", {
      ...parent,
      id: "long",
      chain: Array.from({ length: 12 }, (_, index) => `edge-${index}`),
    });
    expect(() =>
      automation.send(
        { ...caller, actor: { ...caller.actor, run: "long" } },
        { ...params, request: "long" },
      ),
    ).toThrow("因果链");
  });
  it("waits for a native completion after stop and cancels queued native work without submission", async () => {
    const target = node("agent");
    await resources.bind(context, {
      request: "native",
      node: target.id,
      data: JSON.stringify({
        kind: "session",
        resource: "runner:test:workspace",
        config: {},
      }),
    });
    const queued = (
      automation.send(context, {
        node: target.id,
        prompt: "first",
        request: "first",
      }) as { run: ResearchRun }
    ).run;
    await expect(automation.stop(context, { run: queued.id })).resolves.toEqual(
      { stopped: true },
    );
    expect(graph.repo.get("project", "runs", queued.id)).toMatchObject({
      status: "cancelled",
    });
    const active = (
      automation.send(context, {
        node: target.id,
        prompt: "next",
        request: "next",
      }) as { run: ResearchRun }
    ).run;
    graph.repo.put("project", "runs", active.id, {
      ...active,
      status: "running",
    });
    await expect(automation.stop(context, { run: active.id })).resolves.toEqual(
      { stopped: false, pending: true },
    );
    expect(graph.repo.get("project", "runs", active.id)).toMatchObject({
      status: "waiting",
      finished: null,
      stopRequested: { by: "alice" },
    });
    expect(execution.open).not.toHaveBeenCalled();
  });
  it("keeps semantic edges inert and filters completion events by status", async () => {
    const { source, target } = await subscription("agent.completed", "all");
    graph.mutate(context, "edge_add", {
      request: "semantic",
      source: source.id,
      target: target.id,
      label: "支持",
    });
    await automation.pump();
    expect(runs()).toEqual([]);
    automation.emit(
      event(source.id, {
        id: "failure",
        type: "agent.completed",
        payload: { status: "failed" },
      }),
    );
    await automation.pump();
    expect(runs()).toEqual([]);
    automation.emit(
      event(source.id, {
        id: "success",
        type: "agent.completed",
        payload: { status: "completed" },
      }),
    );
    await automation.pump();
    expect(runs()).toHaveLength(1);
  });
  it("backfills only the latest missed one-shot timer and never fires it twice", async () => {
    const timer = node("timer", {
        schedule: {
          kind: "once",
          at: "2026-09-16T12:00:00Z",
          timezone: "UTC",
          missed: "latest",
        },
      }),
      target = node("agent");
    await bind(target);
    automation.save(context, {
      request: "timer",
      data: JSON.stringify({
        source: timer.id,
        target: target.id,
        event: "timer.tick",
        enabled: true,
        filter: { mode: "all" },
        prompt: "分析",
      }),
    });
    await automation.pump();
    await automation.pump();
    expect(runs()).toHaveLength(1);
  });
});
