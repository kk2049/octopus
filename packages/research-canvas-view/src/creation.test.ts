import { expect, it, vi } from "vitest";
import type { Call } from "./client.js";
import { readNodeCreation, resumeNodeCreation, type NodeCreation } from "./creation.js";
const plan = (): NodeCreation => ({ request: "stable-node", data: { type: "note", title: "新节点", summary: "", x: 10, y: 20, data: {} }, parent: { id: "parent", label: "contains", request: "stable-edge" } });

it("reuses the exact node request after an unknown response without making another node", async () => {
  let pending = plan(), dropped = false;
  const nodes = new Set<string>();
  const call = vi.fn(async (action: string, params?: Record<string, unknown>) => {
    if (action === "node_add") {
      nodes.add(String(params!.request));
      if (!dropped) { dropped = true; throw new Error("reply lost"); }
      return { node: { id: "created" } };
    }
    if (action === "graph_read") return { snapshot: "after-create" };
    return { edge: { id: "relation" } };
  });
  const checkpoint = (next: NodeCreation) => { pending = next; };
  await expect(resumeNodeCreation(call as Call, pending, checkpoint)).rejects.toThrow("reply lost");
  expect(pending.node).toBeUndefined();
  const restored = readNodeCreation(JSON.parse(JSON.stringify(pending)))!;
  await expect(resumeNodeCreation(call as Call, restored, checkpoint)).resolves.toBe("created");
  expect(nodes.size).toBe(1);
  const creates = call.mock.calls.filter(([action]) => action === "node_add");
  expect(creates).toHaveLength(2); expect(creates[1]).toEqual(creates[0]);
});

it("checkpoints the returned node before a failed fresh read and only repairs the attachment", async () => {
  let pending = plan(), blocked = true;
  const call = vi.fn(async (action: string) => {
    if (action === "node_add") return { node: { id: "created" } };
    if (action === "graph_read") { if (blocked) throw new Error("read interrupted"); return { snapshot: "fresh" }; }
    return { edge: { id: "relation" } };
  });
  const checkpoint = (next: NodeCreation) => { pending = next; };
  await expect(resumeNodeCreation(call as Call, pending, checkpoint)).rejects.toThrow("read interrupted");
  expect(pending.node).toBe("created");
  blocked = false;
  await resumeNodeCreation(call as Call, readNodeCreation(JSON.parse(JSON.stringify(pending)))!, checkpoint);
  expect(call.mock.calls.filter(([action]) => action === "node_add")).toHaveLength(1);
  expect(pending.attachment).toMatchObject({ request: "stable-edge", snapshot: "fresh", source: "parent", target: "created" });
});

it("retries an uncertain attachment with its immutable snapshot and request, then never replays completed writes", async () => {
  let pending = plan(), dropped = false;
  const edges = new Set<string>();
  const call = vi.fn(async (action: string, params?: Record<string, unknown>) => {
    if (action === "node_add") return { node: { id: "created" } };
    if (action === "graph_read") return { snapshot: "fresh" };
    if (action === "edge_add") {
      edges.add(String(params!.request));
      if (!dropped) { dropped = true; throw new Error("attachment reply lost"); }
      return { edge: { id: "relation" } };
    }
  });
  const checkpoint = (next: NodeCreation) => { pending = next; };
  await expect(resumeNodeCreation(call as Call, pending, checkpoint)).rejects.toThrow("attachment reply lost");
  await resumeNodeCreation(call as Call, pending, checkpoint);
  expect(edges.size).toBe(1);
  expect(call.mock.calls.filter(([action]) => action === "node_add")).toHaveLength(1);
  expect(call.mock.calls.filter(([action]) => action === "graph_read")).toHaveLength(1);
  const attaches = call.mock.calls.filter(([action]) => action === "edge_add");
  expect(attaches).toHaveLength(2); expect(attaches[1]).toEqual(attaches[0]);
  const count = call.mock.calls.length;
  await resumeNodeCreation(call as Call, pending, checkpoint);
  expect(call.mock.calls).toHaveLength(count);
});

it("creates and attaches in one receipt, preserving its request through an uncertain response", async () => {
  let pending = plan(); pending.data.parent = { id: "parent", label: "contains" };
  const original = JSON.parse(JSON.stringify(pending));
  const call = vi.fn().mockRejectedValueOnce(new Error("reply lost")).mockResolvedValue({ node: { id: "created" }, attached: true });
  const checkpoint = (next: NodeCreation) => { pending = next; };
  await expect(resumeNodeCreation(call as Call, pending, checkpoint)).rejects.toThrow("reply lost");
  const receipt = vi.fn();
  await resumeNodeCreation(call as Call, readNodeCreation(pending)!, checkpoint, receipt);
  expect(call.mock.calls).toEqual([["node_add", { request: original.request, data: original.data }], ["node_add", { request: original.request, data: original.data }]]);
  expect(receipt).toHaveBeenCalledWith({ node: { id: "created" }, attached: true });
  expect(readNodeCreation(JSON.parse(JSON.stringify(pending)))?.attached).toBe(true);
});
