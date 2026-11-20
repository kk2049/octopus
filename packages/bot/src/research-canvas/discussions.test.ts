import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readDiscussionRange, ResearchDiscussions } from "./discussions.js";
import { Store } from "../store/store.js";
import { ResearchGraph, type ResearchContext } from "./graph.js";
import { ResearchCollaboration } from "./collaboration.js";
import { ResearchResources } from "./resources.js";
import type { ResearchNode } from "@claude-bot/research-canvas-contract";
const item = (message_id: string) => ({ message_id, body: message_id, create_time: "1790000000000" });
describe("fixed discussion intervals", () => {
  it("reads across pages, ignores later messages and duplicated page boundaries", async () => {
    const read = vi.fn().mockResolvedValueOnce({ items: [item("later"), item("3")], has_more: true, page_token: "b" }).mockResolvedValueOnce({ items: [item("3"), item("2")], has_more: true, page_token: "c" }).mockResolvedValueOnce({ items: [item("1"), item("older")], has_more: true, page_token: "d" });
    expect((await readDiscussionRange(read, "1", "3")).map(m => m.message_id)).toEqual(["1", "2", "3"]);
    expect(read.mock.calls).toEqual([[undefined], ["b"], ["c"]]);
  });
  it("refuses missing boundaries, partial bodies and non-advancing pagination", async () => {
    await expect(readDiscussionRange(async () => ({ items: [item("3")], has_more: false }), "1", "3")).rejects.toThrow("边界未找到");
    await expect(readDiscussionRange(async () => ({ items: [{ ...item("3"), truncated: true }], has_more: false }), "3", "3")).rejects.toThrow("截断");
    await expect(readDiscussionRange(async () => ({ items: [], has_more: true, page_token: "same" }), "1", "3")).rejects.toThrow("分页未推进");
  });
  it("recovers after a minutes failure from the frozen source and never starts execution", async () => {
    const root = mkdtempSync(join(tmpdir(), "discussion-test-")), store = new Store(join(root, "db")), graph = new ResearchGraph(store, root);
    const context: ResearchContext = { project: "p", actor: { kind: "human", owner: "alice" } };
    store.createSharedAppInstance({ app_id: "research-v2", instance_key: "p", creator: "alice", status: "open", created_at: new Date().toISOString() }, "owner");
    try {
      const group = (graph.mutate(context, "node_add", { request: "group", data: JSON.stringify({ type: "group", title: "讨论" }) }) as { node: ResearchNode }).node;
      const read = vi.fn(async () => ({ items: [item("2"), item("1")], has_more: false })), send = vi.fn();
      const resources = new ResearchResources(graph, root, { list: async () => [], validate: async () => {}, read, send, transcribe: async () => ({ text: "", model: null }) }, () => {}, () => {});
      await resources.bind(context, { request: "bind", node: group.id, data: JSON.stringify({ kind: "group", resource: "group-resource", config: {} }) });
      const capture = new ResearchDiscussions(graph, resources), params = { request: "freeze", node: group.id, from: "1", to: "2", title: "研究讨论" };
      const mutate = graph.mutate.bind(graph);
      const spy = vi.spyOn(graph, "mutate").mockImplementation((ctx, action, values) => { if (values.request.endsWith("_minutes")) throw new Error("simulated interruption"); return mutate(ctx, action, values); });
      await expect(capture.capture(context, params)).rejects.toThrow("interruption");
      spy.mockRestore(); read.mockResolvedValue({ items: [item("changed")], has_more: false });
      const result = await capture.capture(context, params);
      expect(await capture.capture(context, params)).toEqual(result);
      expect(read).toHaveBeenCalledTimes(1);
      const record = graph.resolveResource("p", result.record.ref);
      expect(graph.texts.read("p", record).text).toContain('"message_id": "1"');
      expect(record.data.meta).toMatchObject({ read_only: true, messageCount: 2 });
      expect(graph.texts.read("p", record).text).toContain('"resource": "group-resource"');
      const documents = new ResearchCollaboration(graph, root, () => {});
      expect(() => documents.write(context, { request: "overwrite-record", node: record.id, text: "edited" })).toThrow("只读");
      expect(() => documents.write(context, { request: "edit-minutes", node: result.minutes.id, text: "Reviewed [message_id:1]" })).not.toThrow();
      expect(Object.values(graph.documents.inspect("p").spec.edges)).toEqual(expect.arrayContaining([expect.objectContaining({ from: result.minutes.id, to: result.record.id, relation: "依据" })]));
      expect(send).not.toHaveBeenCalled();
      expect(store.researchCanvas.runs("p", {})).toHaveLength(0);
    } finally { graph.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
