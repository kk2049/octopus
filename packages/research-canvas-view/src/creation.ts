import { NODE_TYPES, type NodeType, type ResearchNode, type ResearchEdge } from "@claude-bot/research-canvas-contract";
import type { Call } from "./client.js";

export interface NodeCreation {
  request: string;
  data: { type: NodeType; title: string; summary: string; x: number; y: number; data: Record<string, unknown>; parent?: { id: string; label: string } };
  parent?: { id: string; label: string; request: string };
  node?: string;
  attachment?: { request: string; snapshot: string; source: string; target: string; label: string };
  attached?: boolean;
}
export function readNodeCreation(value: unknown): NodeCreation | undefined {
  if (!value || typeof value !== "object") return;
  const pending = value as NodeCreation, data = pending.data, parent = pending.parent, edge = pending.attachment;
  if (typeof pending.request !== "string" || !pending.request || !data || !NODE_TYPES.includes(data.type)
    || typeof data.title !== "string" || typeof data.summary !== "string" || !Number.isFinite(data.x) || !Number.isFinite(data.y)
    || !data.data || typeof data.data !== "object" || Array.isArray(data.data)) return;
  if (parent && (typeof parent.id !== "string" || typeof parent.label !== "string" || typeof parent.request !== "string")) return;
  if (pending.node !== undefined && typeof pending.node !== "string") return;
  if (edge && (!parent || edge.request !== parent.request || typeof edge.snapshot !== "string" || edge.source !== parent.id || edge.target !== pending.node || edge.label !== parent.label)) return;
  if (pending.attached && (!pending.node || parent && !edge && (!data.parent || data.parent.id !== parent.id || data.parent.label !== parent.label))) return;
  return pending;
}
/** Checkpoint each acknowledged phase and the exact next request before dispatch.
 * Refresh is deliberately outside this workflow: it cannot invalidate a completed write. */
export async function resumeNodeCreation(call: Call, pending: NodeCreation, checkpoint: (next: NodeCreation) => void, created?: (receipt: { node: ResearchNode; edge?: ResearchEdge; parent?: ResearchNode }) => void): Promise<string> {
  let next = pending;
  if (!next.node) {
    const result = await call<{ node: ResearchNode; attached?: boolean; edge?: ResearchEdge; parent?: ResearchNode }>("node_add", { request: next.request, data: next.data });
    if (!result.node?.id) throw new Error("创建结果未返回节点标识，请重试确认");
    next = { ...next, node: result.node.id, ...(result.attached ? { attached: true } : {}) }; checkpoint(next);
    created?.(result);
  }
  if (next.parent && !next.attached) {
    if (!next.attachment) {
      // A parent's pre-creation snapshot cannot contain the newly created endpoint.
      const fresh = await call<{ snapshot: string }>("graph_read");
      if (typeof fresh.snapshot !== "string" || !fresh.snapshot) throw new Error("未取得连接所需的图快照，请重试连接");
      next = { ...next, attachment: { request: next.parent.request, snapshot: fresh.snapshot, source: next.parent.id, target: next.node!, label: next.parent.label } };
      checkpoint(next);
    }
    await call("edge_add", next.attachment);
    next = { ...next, attached: true }; checkpoint(next);
  }
  return next.node!;
}
