import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResearchNode, ResourceBinding } from "@claude-bot/research-canvas-contract";
import { Store } from "../store/store.js";
import { ResearchGraph, type ResearchContext } from "./graph.js";
import { ResearchResources, type ResearchFile, type ResearchResourceAdapters } from "./resources.js";
import { ResearchDiscussionSources } from "./discussion-sources.js";
import { ResearchDiscussions } from "./discussions.js";
import { SourceIntegrityError } from "./moss.js";
const context: ResearchContext = { project: "p", actor: { kind: "human", owner: "alice" } };
const message = (message_id: string) => ({ message_id, body: JSON.stringify({ text: "先核对参数，再决定是否执行。" }), sender: "ou_source", create_time: "1790000000000" });
describe("source processing and human candidate boundary", () => {
  let root: string, store: Store, graph: ResearchGraph, resources: ResearchResources, sources: ResearchDiscussionSources, discussions: ResearchDiscussions, adapters: ResearchResourceAdapters;
  const emit = vi.fn();
  const prepare = vi.fn(() => ({ batch: { id: "candidate-batch" } }));
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "research-sources-")); store = new Store(join(root, "db")); graph = new ResearchGraph(store, root);
    store.createSharedAppInstance({ app_id: "research-v2", instance_key: "p", creator: "alice", status: "open", created_at: new Date().toISOString() }, "owner");
    adapters = { list: async () => [], validate: async () => {}, read: vi.fn(async () => ({ items: [message("2"), message("1")], has_more: false })), send: vi.fn(),
      transcribe: vi.fn(async () => ({ text: "[D000001] 说话人A：先核对参数。", model: "MOSS@fixed", segments: [{ id: "D000001", start: 0, end: 89.9, speaker: "A", text: "先核对参数。" }],
        integrity: { complete: true, rawClosed: true, durationSeconds: 90, lastEndSeconds: 89.9, trailingSeconds: .1, segments: 1, tokenLimited: false, recovered: false, warnings: [] } })),
      summarize: vi.fn(async () => ({ minutes: "# 纪要\n\n先核对参数，执行尚未确认。[1]", candidates: [], model: "summary-model" })),
      createGroup: vi.fn(async () => "oc_created") };
    emit.mockClear(); resources = new ResearchResources(graph, root, adapters, emit, () => {});
    prepare.mockClear(); sources = new ResearchDiscussionSources(graph, resources, () => {}, prepare);
    discussions = new ResearchDiscussions(graph, resources, sources);
  });
  afterEach(() => { discussions.close(); sources.close(); graph.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  function node(type: string) { return (graph.mutate(context, "node_add", { request: crypto.randomUUID(), data: JSON.stringify({ type, title: "讨论来源" }) }) as { node: ResearchNode }).node; }
  async function group() { const target = node("group"); await resources.bind(context, { request: "bind", node: target.id, data: JSON.stringify({ kind: "group", resource: "oc_group", config: {} }) }); return target; }
  function audio() {
    const target = node("audio"), bytes = Buffer.from("fixture recording");
    const { upload } = resources.begin(context, { request: "upload", node: target.id, data: JSON.stringify({ name: "meeting.wav", mime: "audio/wav", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }) }) as { upload: { id: string } };
    resources.chunk(context, { upload: upload.id, offset: "0", data: bytes.toString("base64") });
    const { file } = resources.commit(context, { request: "commit", upload: upload.id }) as { file: ResearchFile };
    return { target, file, binding: resources.binding(context, target.id, "audio") };
  }
  it("saves full audio, editable minutes and one candidate batch without publishing or executing", async () => {
    const { target, file, binding } = audio();
    const first = await resources.processTranscription(context, binding, file, new AbortController().signal);
    expect(sources.read(context, { node: target.id }).source).toMatchObject({ stage: "completed", batch: "candidate-batch", transcript: { id: first.artifact.id } });
    await resources.processTranscription(context, binding, file, new AbortController().signal);
    expect(adapters.transcribe).toHaveBeenCalledTimes(1); expect(prepare).toHaveBeenCalledTimes(1);
    expect(graph.repo.runs("p")).toEqual([]); expect(adapters.send).not.toHaveBeenCalled();
    expect(emit.mock.calls.map(([event]) => event).filter(event => event.type === "audio.transcribed")).toEqual([expect.objectContaining({ source: target.id, payload: expect.objectContaining({ audioVersion: file.id, artifact: first.artifact.id }) })]);
  });
  it("keeps an incomplete recording readable and refuses to publish a completed result", async () => {
    const { target, file, binding } = audio();
    vi.mocked(adapters.transcribe).mockRejectedValue(new SourceIntegrityError("末尾需要补段", { complete: false, rawClosed: false, durationSeconds: 300, lastEndSeconds: 180, trailingSeconds: 120, segments: 1, tokenLimited: false, recovered: false, warnings: ["末尾需要补段"] }, "{}", "部分原文"));
    await expect(resources.processTranscription(context, binding, file, new AbortController().signal)).rejects.toThrow("补段");
    expect(sources.read(context, { node: target.id }).source).toMatchObject({ stage: "needs_review", integrity: { complete: false }, transcript: expect.any(Object) });
    expect(adapters.summarize).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
    expect(emit.mock.calls.map(([event]) => event).some(event => event.type === "audio.transcribed")).toBe(false);
  });
  it("summarizes frozen chat with original message IDs, never ASR, and deduplicates another capture request", async () => {
    const target = await group();
    const first = await discussions.capture(context, { request: "capture", node: target.id, from: "1", to: "2", title: "参数讨论" });
    await vi.waitFor(() => expect(sources.read(context, { node: target.id }).source).toMatchObject({ stage: "completed" }));
    const second = await discussions.capture(context, { request: "capture-again", node: target.id, from: "1", to: "2", title: "另一个标题" });
    expect(second.record.id).toBe(first.record.id); expect(second.minutes.id).toBe(first.minutes.id);
    expect(adapters.transcribe).not.toHaveBeenCalled(); expect(adapters.summarize).toHaveBeenCalledTimes(1);
    expect(graph.texts.read("p", graph.resourceNode("p", first.minutes.id)).text).toContain("先核对参数");
  });
  it("uses an incremental cursor exactly once and performs no reads after pause", async () => {
    const target = await group();
    await discussions.follow(context, { request: "follow", node: target.id, data: JSON.stringify({ enabled: true, cursor: "1" }) });
    expect(await discussions.sync(context, { node: target.id })).toMatchObject({ imported: 1 });
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
    expect(await discussions.sync(context, { node: target.id })).toMatchObject({ imported: 0 });
    await discussions.follow(context, { request: "pause", node: target.id, data: JSON.stringify({ enabled: false }) });
    const reads = vi.mocked(adapters.read).mock.calls.length;
    await expect(discussions.sync(context, { node: target.id })).rejects.toThrow("启用");
    expect(adapters.read).toHaveBeenCalledTimes(reads);
  });
  it("does not retry a group create whose external receipt is unknown", async () => {
    const target = node("group"); vi.mocked(adapters.createGroup!).mockRejectedValue(new Error("lost receipt"));
    const params = { request: "create", node: target.id, title: "小组" };
    await expect(discussions.create(context, params)).rejects.toThrow("lost receipt");
    await expect(discussions.create(context, params)).rejects.toThrow("不会重复");
    expect(adapters.createGroup).toHaveBeenCalledTimes(1); expect(adapters.send).not.toHaveBeenCalled();
  });
});
