import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResearchNode, ResearchRun } from "@claude-bot/research-canvas-contract";
import { Store } from "../store/store.js";
import { ResearchGraph, type ResearchContext } from "./graph.js";
import { ResearchResources, type ResearchFile, type ResearchResourceAdapters } from "./resources.js";
import { ResearchDiscussionSources } from "./discussion-sources.js";
import { ResearchMeetingFlow, meetingSelection } from "./meeting-flow.js";
import type { ResearchAutomation } from "./automation.js";
import type { ResearchNative } from "./native.js";

const owner: ResearchContext = { project: "p", actor: { kind: "human", owner: "alice" } };
describe("selected meeting pipeline and authenticated whole-source submission", () => {
  let root: string, store: Store, graph: ResearchGraph, resources: ResearchResources, sources: ResearchDiscussionSources, flow: ResearchMeetingFlow;
  let adapters: ResearchResourceAdapters, automation: ResearchAutomation, native: ResearchNative;
  let reconcile: () => void, serial: number, allowed: boolean;
  const prepare = vi.fn((_context: ResearchContext, _input: unknown) => ({ batch: { id: "batch-review" } }));
  const send = vi.fn();
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "meeting-flow-")); store = new Store(join(root, "db")); graph = new ResearchGraph(store, root);
    store.createSharedAppInstance({ app_id: "research-v2", instance_key: "p", creator: "alice", status: "open", created_at: new Date().toISOString() }, "owner");
    serial = 0; allowed = true; prepare.mockClear(); send.mockReset();
    adapters = { list: async () => [], validate: vi.fn(async () => {}), read: vi.fn(), send: vi.fn(),
      transcribe: vi.fn(async () => ({ text: "完整来源，后期结论保留。", model: "MOSS@pinned",
        segments: Array.from({ length: 150 }, (_, i) => ({ id: `D${i + 1}`, start: i, end: i + 1, text: i === 149 ? "最终先做上传，不自动执行任务。" : `讨论片段${i + 1}`, speaker: "A" })),
        integrity: { complete: true, rawClosed: true, durationSeconds: 150, lastEndSeconds: 150, trailingSeconds: 0, segments: 150, tokenLimited: false, recovered: false, warnings: [] } })),
      summarize: vi.fn(async () => ({ minutes: "旧客户端纪要", candidates: [], model: "legacy" })) };
    resources = new ResearchResources(graph, root, adapters, () => {}, () => {});
    sources = new ResearchDiscussionSources(graph, resources, () => {}, prepare, () => allowed);
    send.mockImplementation((context: ResearchContext, params: Record<string, string>) => {
      const run = { id: `run${++serial}`, node: params.node, project: context.project, binding: resources.binding(context, params.node), status: "running", model: null,
        prompt: params.prompt, conversation: "meeting", subscription: null, event: null, root: "", chain: [], trigger: "alice", at: new Date().toISOString(), finished: null, usage: null, error: null } satisfies ResearchRun;
      graph.repo.put(context.project, "runs", run.id, run); return { run };
    });
    automation = { send, transcribe: vi.fn(() => ({ run: { id: "asr", status: "queued" } })), onReconcile: (fn: () => void) => { reconcile = fn; return () => {}; } } as unknown as ResearchAutomation;
    native = { meetingSources: vi.fn(async () => [{ id: "runner:gpu:ws_123456789012345678901234", title: "个人 Codex", accounts: [{ id: "a", label: "账号 A" }], efforts: ["max"], models: [] }]) } as unknown as ResearchNative;
    flow = makeFlow();
  });
  function makeFlow() { return new ResearchMeetingFlow(graph, resources, sources, automation, () => allowed, () => ({ available: true, status: "就绪", backend: "MOSS" }), native); }
  afterEach(() => { flow.close(); sources.close(); graph.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  function node(type: string) { return (graph.mutate(owner, "node_add", { request: randomUUID(), data: JSON.stringify({ type, title: type }) }) as { node: ResearchNode }).node; }
  function audio(target = node("audio")) {
    const bytes = Buffer.from(randomUUID());
    const { upload } = resources.begin(owner, { request: randomUUID(), node: target.id, data: JSON.stringify({ name: "讨论.wav", mime: "audio/wav", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }) }) as { upload: { id: string } };
    resources.chunk(owner, { upload: upload.id, offset: "0", data: bytes.toString("base64") });
    const { file } = resources.commit(owner, { request: randomUUID(), upload: upload.id }) as { file: ResearchFile };
    return { target, file, binding: resources.binding(owner, target.id) };
  }
  async function agent() { const target = node("agent"); await resources.bind(owner, { request: randomUUID(), node: target.id, data: JSON.stringify({ kind: "agent", resource: "configured", config: {} }) }); return target; }
  async function selected() {
    const recording = audio(), target = await agent();
    await flow.transcribe(owner, { request: "asr", node: recording.target.id, version: String(recording.file.version), summary: JSON.stringify({ kind: "agent", agent: target.id }) });
    await resources.processTranscription(owner, recording.binding, recording.file, new AbortController().signal);
    const source = sources.require(owner, recording.target.id, recording.file.id), run = graph.repo.get<ResearchRun>("p", "runs", source.summary!.run)!;
    return { ...recording, agent: target, source, run, context: { project: "p", actor: { kind: "agent", owner: "alice", agent: target.id, run: run.id } } as ResearchContext };
  }
  function result(value: Awaited<ReturnType<typeof selected>>) { return { node: value.target.id, version: value.file.id, attempt: value.source.summary!.attempt, request: "submit",
    data: JSON.stringify({ minutes: "后期结论：先做上传，任务须确认。[D150]", candidates: [{ title: "会议上传", summary: "便于保留原始记录", body: "新增上传按钮，完整转写后可查看。", kind: "task", evidence: ["D150"] }] }) }; }
  function readAll(value: Awaited<ReturnType<typeof selected>>) {
    let after: string | null = "0";
    do { const page = flow.segments(value.context, { node: value.target.id, version: value.file.id, after }); after = page.next; } while (after !== null);
  }
  it("pages an utterance longer than the page target alone and whole", async () => {
    const long = "持续发言".repeat(6000);
    vi.mocked(adapters.transcribe).mockResolvedValueOnce({ text: long, model: "MOSS@pinned",
      segments: [{ id: "D1", start: 0, end: 600, text: long, speaker: "A" }, { id: "D2", start: 600, end: 601, text: "结束。", speaker: "B" }],
      integrity: { complete: true, rawClosed: true, durationSeconds: 601, lastEndSeconds: 601, trailingSeconds: 0, segments: 2, tokenLimited: false, recovered: false, warnings: [] } });
    const value = await selected();
    const first = flow.segments(value.context, { node: value.target.id, version: value.file.id });
    expect(first.segments).toEqual([expect.objectContaining({ id: "D1", text: long })]);
    expect(JSON.stringify(first.segments[0]).length).toBeGreaterThan(18000);
    const second = flow.segments(value.context, { node: value.target.id, version: value.file.id, after: first.next! });
    expect(second).toMatchObject({ segments: [expect.objectContaining({ id: "D2" })], next: null });
  });
  it("publishes only tiny current-file card metadata and retains uploaded bytes", () => {
    const recording = audio();
    expect(graph.resourceNode("p", recording.target.id).data.meta).toMatchObject({ meeting: { fileVersion: 1, fileName: "讨论.wav", stage: "uploaded" } });
    expect(resources.file(owner, recording.target.id).sha256).toBe(recording.file.sha256);
  });
  it("explicit none saves complete transcription without any summary or task execution", async () => {
    const recording = audio();
    await flow.transcribe(owner, { request: "asr", node: recording.target.id, version: "1", summary: '{"kind":"none"}' });
    await resources.processTranscription(owner, recording.binding, recording.file, new AbortController().signal);
    expect(sources.read(owner, { node: recording.target.id }).source).toMatchObject({ stage: "transcribed", model: "MOSS@pinned" });
    expect(adapters.summarize).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
  });
  it("queues only the selected Agent and rejects a different late ASR plan", async () => {
    const value = await selected();
    expect(send).toHaveBeenCalledTimes(1); expect(value.source.summary).toMatchObject({ agent: { id: value.agent.id }, model: null });
    expect(value.run.prompt).toContain("读至 null"); expect(adapters.summarize).not.toHaveBeenCalled();
    await expect(flow.transcribe(owner, { request: "another", node: value.target.id, version: "1", summary: '{"kind":"none"}' })).resolves.toMatchObject({ status: "not_started", message: expect.stringContaining("已登记") });
  });
  it("rejects human, wrong Agent, skipped pages and early complete-summary claims", async () => {
    const value = await selected(), params = result(value);
    await expect(flow.submit(owner, params)).rejects.toThrow("仅本次");
    await expect(flow.submit({ ...value.context, actor: { ...value.context.actor, agent: "impostor" } }, params)).rejects.toThrow("仅本次");
    await expect(flow.submit(value.context, params)).rejects.toThrow("尚未读完");
    expect(() => flow.segments(value.context, { node: value.target.id, version: value.file.id, after: "100" })).toThrow("连续");
    const first = flow.segments(value.context, { node: value.target.id, version: value.file.id });
    expect(first.next).toBe("100");
    await expect(flow.submit(value.context, params)).rejects.toThrow("尚未读完");
    expect(prepare).not.toHaveBeenCalled();
  });
  it("requires actual source evidence and commits editable minutes plus pending candidates exactly once", async () => {
    const value = await selected(), params = result(value); readAll(value);
    await expect(flow.submit(value.context, { ...params, data: params.data.replace('"D150"]', '"fabricated"]') })).rejects.toThrow("有效来源");
    await flow.submit(value.context, params); await flow.submit(value.context, params);
    const final = sources.require(owner, value.target.id, value.file.id);
    expect(final.stage).toBe("completed"); expect(final.summary?.state).toBe("completed");
    expect(graph.texts.read("p", graph.resourceNode("p", final.minutes!.id)).text).toContain("后期结论");
    expect(prepare).toHaveBeenCalledTimes(1); expect(prepare.mock.calls[0]?.[1]).toMatchObject({ items: [{ state: "pending", evidence: [{ locator: "D150@149.00-150.00s" }] }] });
    expect(send).toHaveBeenCalledTimes(1); expect(adapters.send).not.toHaveBeenCalled();
  });
  it("restores an existing summary run and reports no-submission completion without replay", async () => {
    const value = await selected(); flow.close(); flow = makeFlow();
    graph.repo.put("p", "runs", value.run.id, { ...value.run, status: "completed" }); reconcile();
    expect(sources.read(owner, { node: value.target.id }).source).toMatchObject({ stage: "needs_review", summary: { state: "failed" } });
    expect(send).toHaveBeenCalledTimes(1); expect(adapters.transcribe).toHaveBeenCalledTimes(1);
  });
  it("preserves the complete transcript when a selected Agent changes before ASR finishes", async () => {
    const recording = audio(), target = await agent();
    await flow.transcribe(owner, { request: "asr", node: recording.target.id, version: "1", summary: JSON.stringify({ kind: "agent", agent: target.id }) });
    await resources.bind(owner, { request: "rebind", node: target.id, data: JSON.stringify({ kind: "agent", resource: "other", config: {} }) });
    await resources.processTranscription(owner, recording.binding, recording.file, new AbortController().signal);
    expect(sources.read(owner, { node: recording.target.id }).source).toMatchObject({ stage: "needs_review", integrity: { complete: true } }); expect(send).not.toHaveBeenCalled();
  });
  it("keeps new upload metadata when an old source tries to update its status", async () => {
    const value = await selected(), newer = audio(value.target);
    resources.meetingStatus("p", value.target.id, value.file.id, "failed");
    expect(graph.resourceNode("p", value.target.id).data.meta).toMatchObject({ meeting: { fileVersion: newer.file.version, stage: "uploaded" } });
    await expect(flow.submit(value.context, result(value))).rejects.toThrow("绑定已变化");
  });
  it("builds a registered native binding and rejects arbitrary account or command fields", async () => {
    const recording = audio();
    expect(() => meetingSelection({ kind: "codex", resource: "source", command: "arbitrary" })).toThrow("无效");
    const selection = { kind: "codex", resource: "runner:gpu:ws_123456789012345678901234", account: "unregistered" };
    await expect(flow.transcribe(owner, { request: "asr", node: recording.target.id, version: "1", summary: JSON.stringify(selection) })).resolves.toMatchObject({ status: "not_started", message: expect.stringContaining("未在该来源登记") });
    await flow.transcribe(owner, { request: "asr", node: recording.target.id, version: "1", summary: JSON.stringify({ ...selection, account: "a", effort: "max" }) });
    expect(adapters.validate).toHaveBeenLastCalledWith("alice", "session", selection.resource, expect.objectContaining({ device: "gpu", workspace: "ws_123456789012345678901234", account: "a", provider: "codex" }));
  });
  it("does not perform effects after the project grant is revoked", async () => {
    const value = await selected(); readAll(value); allowed = false;
    await expect(flow.submit(value.context, result(value))).rejects.toThrow("撤销"); expect(prepare).not.toHaveBeenCalled();
  });
  it("uses the recording owner's Runner readiness for a shared member and follows graph aliases", async () => {
    const value = await selected();
    store.addSharedAppMember("research-v2", "p", "bob", "editor", 20, new Date().toISOString());
    graph.documents.patch(owner, "audio-alias", "alias-fingerprint", [{ bucket: "nodes", id: "alias", field: "create", value: { ref: `audio:${value.target.id}`, label: "会议引用" } }], graph.provenance(owner));
    flow.close(); const readiness = vi.fn((username: string) => ({ available: username === "alice", status: username, backend: "MOSS" }));
    flow = new ResearchMeetingFlow(graph, resources, sources, automation, () => true, readiness, native);
    const options = await flow.options({ project: "p", actor: { kind: "human", owner: "bob" } }, "alias");
    expect(options.transcription.available).toBe(true); expect(readiness).toHaveBeenCalledWith("alice");
    expect(options.mayBind).toBe(false);
    expect(sources.read(owner, { node: "alias" }).source?.sourceVersion).toBe(value.file.id);
  });
  it("rechecks a revoked binding grant after asynchronous source validation", async () => {
    const recording = audio();
    vi.mocked(adapters.validate).mockImplementation(async () => { allowed = false; });
    await expect(flow.transcribe(owner, { request: "asr", node: recording.target.id, version: "1", summary: JSON.stringify({ kind: "codex", resource: "runner:gpu:ws_123456789012345678901234", account: "a" }) })).resolves.toMatchObject({ status: "not_started", message: expect.stringContaining("撤销") });
    expect([...graph.records<{ id: string; kind: string }>("p", "bindings")].filter(binding => binding.kind === "session")).toHaveLength(0);
    expect(automation.transcribe).not.toHaveBeenCalled();
  });
  it("keeps reviewed minutes unchanged when explicitly creating a second summary attempt", async () => {
    const value = await selected(); readAll(value); await flow.submit(value.context, result(value));
    const old = sources.require(owner, value.target.id, value.file.id);
    const oldMinutes = graph.resourceNode("p", old.minutes!.id);
    graph.texts.write("p", oldMinutes, "用户审定：请保留这份修订。");
    await flow.summarize(owner, { node: value.target.id, version: value.file.id, request: "second-summary", selection: JSON.stringify({ kind: "agent", agent: value.agent.id }) });
    const second = sources.require(owner, value.target.id, value.file.id);
    const context = { ...value.context, actor: { ...value.context.actor, run: second.summary!.run } };
    readAll({ ...value, source: second, context });
    await flow.submit(context, { ...result(value), request: "second-submit", attempt: second.summary!.attempt });
    expect(graph.texts.read("p", oldMinutes).text).toBe("用户审定：请保留这份修订。");
    expect(sources.require(owner, value.target.id, value.file.id).minutes!.id).not.toBe(oldMinutes.id);
  });
  it("atomically finalizes a submission receipt and recovers a failure between the two writes", async () => {
    const value = await selected(), params = result(value); readAll(value);
    const original = graph.repo.remember.bind(graph.repo);
    const remember = vi.spyOn(graph.repo, "remember").mockImplementation((project, actor, request, fingerprint, result) => {
      if (actor.startsWith("meeting:")) throw new Error("simulated interruption before receipt");
      return original(project, actor, request, fingerprint, result);
    });
    await expect(flow.submit(value.context, params)).rejects.toThrow("simulated interruption");
    expect(graph.repo.get<{ finished: boolean }>("p", "meeting-summaries", value.source.summary!.attempt)?.finished).toBe(false);
    const minutes = sources.require(owner, value.target.id, value.file.id).minutes!.id;
    remember.mockRestore();
    await expect(flow.submit(value.context, { ...params, data: params.data.replace("会议上传", "另一个事项") })).rejects.toThrow("沿用原请求");
    await flow.submit(value.context, params); await flow.submit(value.context, params);
    expect(sources.require(owner, value.target.id, value.file.id).minutes!.id).toBe(minutes);
    expect(graph.repo.get<{ finished: boolean }>("p", "meeting-summaries", value.source.summary!.attempt)?.finished).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("can change Codex source after a failed binding without colliding with the first request", async () => {
    const recording = audio();
    const choices = [{ id: "runner:gpu:ws_123456789012345678901234", title: "来源A", accounts: [], efforts: [], models: [] },
      { id: "runner:laptop:ws_123456789012345678901234", title: "来源B", accounts: [], efforts: [], models: [] }];
    vi.mocked(native.meetingSources).mockResolvedValue(choices);
    vi.mocked(adapters.validate).mockRejectedValueOnce(new Error("来源A离线"));
    const params = { request: "asr", node: recording.target.id, version: "1" };
    await expect(flow.transcribe(owner, { ...params, summary: JSON.stringify({ kind: "codex", resource: choices[0].id }) })).resolves.toMatchObject({ status: "not_started", message: expect.stringContaining("离线") });
    await expect(flow.transcribe(owner, { ...params, summary: JSON.stringify({ kind: "codex", resource: choices[1].id }) })).resolves.toMatchObject({ run: { status: "queued" } });
    expect(automation.transcribe).toHaveBeenCalledTimes(1);
  });
  it("does not regress a completed card when replay returns the original queued ASR receipt", async () => {
    const value = await selected(); readAll(value); await flow.submit(value.context, result(value));
    graph.repo.put("p", "runs", "asr", { ...value.run, id: "asr", node: value.target.id, binding: value.binding, status: "completed" });
    const replay = await flow.transcribe(owner, { request: "asr", node: value.target.id, version: "1", summary: JSON.stringify({ kind: "agent", agent: value.agent.id }) });
    expect(replay).toMatchObject({ run: { status: "completed" } });
    expect(graph.resourceNode("p", value.target.id).data.meta).toMatchObject({ meeting: { stage: "completed" } });
    expect(send).toHaveBeenCalledTimes(1); expect(adapters.transcribe).toHaveBeenCalledTimes(1);
  });
});
