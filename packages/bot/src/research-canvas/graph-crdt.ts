import * as Y from "yjs";
import type {
  GraphConflict,
  GraphEdgeSpec,
  GraphIssue,
  GraphNodeSpec,
  GraphSpec,
  Provenance,
} from "@claude-bot/research-canvas-contract";
import { GraphInputError } from "./graph-yaml.js";

export type GraphBucket = "nodes" | "edges";
export interface GraphPatch {
  bucket: GraphBucket;
  id: string;
  field: "create" | "deleted" | "label" | "ref" | "endpoints" | "relation";
  value: unknown;
}
export interface GraphCoverage {
  nodes: string[];
  edges: string[];
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function cloneGraph(update: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  return doc;
}
export function graphSpec(doc: Y.Doc): GraphSpec {
  const nodes: Record<string, GraphNodeSpec> = Object.create(null);
  const edges: Record<string, GraphEdgeSpec> = Object.create(null);
  for (const [id, node] of doc.getMap<Y.Map<unknown>>("nodes")) {
    if (!(node instanceof Y.Map) || node.get("deleted") === true) continue;
    nodes[id] = { ref: String(node.get("ref")), label: String(node.get("label")) };
  }
  for (const [id, edge] of doc.getMap<Y.Map<unknown>>("edges")) {
    if (!(edge instanceof Y.Map) || edge.get("deleted") === true) continue;
    const endpoints = edge.get("endpoints") as { from: string; to: string };
    edges[id] = { ...endpoints, relation: String(edge.get("relation")) };
  }
  return { nodes: Object.fromEntries(Object.entries(nodes).sort()), edges: Object.fromEntries(Object.entries(edges).sort()) };
}
export function graphIssues(spec: GraphSpec): GraphIssue[] {
  return Object.entries(spec.edges)
    .filter(([, edge]) => !spec.nodes[edge.from] || !spec.nodes[edge.to])
    .map(([id]) => ({ code: "missing_endpoint", object: id, message: "关系端点已从图中摘除；关系记录保留" }));
}
export function projectGraph(spec: GraphSpec, coverage: GraphCoverage): GraphSpec {
  return {
    nodes: Object.fromEntries(coverage.nodes.filter(id => spec.nodes[id]).map(id => [id, spec.nodes[id]])),
    edges: Object.fromEntries(coverage.edges.filter(id => spec.edges[id]).map(id => [id, spec.edges[id]])),
  };
}
/** Omission only deletes objects actually exported in the original snapshot. */
export function diffGraph(base: GraphSpec, next: GraphSpec): GraphPatch[] {
  const patches: GraphPatch[] = [];
  for (const bucket of ["nodes", "edges"] as const) {
    for (const id of Object.keys(base[bucket])) {
      if (!next[bucket][id]) patches.push({ bucket, id, field: "deleted", value: true });
    }
    for (const [id, value] of Object.entries(next[bucket])) {
      if (!base[bucket][id]) {
        patches.push({ bucket, id, field: "create", value });
        continue;
      }
      if (bucket === "nodes") {
        const old = base.nodes[id], node = value as GraphNodeSpec;
        for (const field of ["ref", "label"] as const)
          if (old[field] !== node[field]) patches.push({ bucket, id, field, value: node[field] });
      } else {
        const old = base.edges[id], edge = value as GraphEdgeSpec;
        if (old.from !== edge.from || old.to !== edge.to)
          patches.push({ bucket, id, field: "endpoints", value: { from: edge.from, to: edge.to } });
        if (old.relation !== edge.relation)
          patches.push({ bucket, id, field: "relation", value: edge.relation });
      }
    }
  }
  return patches;
}
export function applyGraphPatches(doc: Y.Doc, patches: GraphPatch[], stamp: Provenance): void {
  doc.transact(() => {
    for (const patch of patches) {
      const collection = doc.getMap<Y.Map<unknown>>(patch.bucket);
      let entry = collection.get(patch.id);
      if (patch.field === "create") {
        if (entry) throw new GraphInputError("identity_collision", "对象 ID 已被使用；新对象请使用新 ID", patch.id);
        entry = new Y.Map<unknown>();
        collection.set(patch.id, entry);
        entry.set("created", stamp);
        entry.set("deleted", false);
        if (patch.bucket === "nodes") {
          const node = patch.value as GraphNodeSpec;
          entry.set("ref", node.ref);
          entry.set("label", node.label);
        } else {
          const edge = patch.value as GraphEdgeSpec;
          // Rewiring an edge is one value, so concurrent rewires cannot form a hybrid.
          entry.set("endpoints", { from: edge.from, to: edge.to });
          entry.set("relation", edge.relation);
        }
      } else {
        if (!entry) throw new GraphInputError("invalid_graph", "修改目标不存在于原始快照", patch.id);
        entry.set(patch.field, patch.value);
      }
      entry.set("updated", stamp);
    }
  });
}
/** Generate an update in the original causal state, then merge it with current state. */
export function compileGraphEdit(
  baseUpdate: Uint8Array,
  currentUpdate: Uint8Array,
  next: GraphSpec,
  coverage: GraphCoverage,
  stamp: Provenance,
): { update: Uint8Array; merged: Y.Doc; patches: GraphPatch[]; conflicts: GraphConflict[]; issues: GraphIssue[] } {
  const base = cloneGraph(baseUpdate), current = cloneGraph(currentUpdate);
  const branch = cloneGraph(baseUpdate);
  try {
    const original = graphSpec(base);
    const patches = diffGraph(projectGraph(original, coverage), next);
    for (const patch of patches) {
      if (patch.field === "create" && current.getMap(patch.bucket).has(patch.id))
        throw new GraphInputError("identity_collision", "对象 ID 已存在于当前图；请读取该对象或为新对象分配新 ID", patch.id);
      if (patch.bucket === "edges" && (patch.field === "create" || patch.field === "endpoints")) {
        const endpoints = patch.value as { from: string; to: string };
        for (const id of [endpoints.from, endpoints.to])
          if (!original.nodes[id] && !next.nodes[id])
            throw new GraphInputError("invalid_graph", "关系端点不在读取范围或新增节点中", `edges.${patch.id}`);
      }
    }
    applyGraphPatches(branch, patches, stamp);
    const update = Y.encodeStateAsUpdate(branch, Y.encodeStateVector(base));
    Y.applyUpdate(current, update);
    const conflicts: GraphConflict[] = [];
    const issues = graphIssues(graphSpec(current));
    const prior = cloneGraph(currentUpdate);
    try {
      for (const patch of patches) {
        if (patch.field === "create") continue;
        const before = base.getMap<Y.Map<unknown>>(patch.bucket).get(patch.id)!;
        const concurrent = prior.getMap<Y.Map<unknown>>(patch.bucket).get(patch.id);
        const effective = current.getMap<Y.Map<unknown>>(patch.bucket).get(patch.id);
        const was = before.get(patch.field), now = concurrent?.get(patch.field);
        if (!equal(was, now) && !equal(patch.value, now))
          conflicts.push({ object: patch.id, field: patch.field, base: was, current: now, submitted: patch.value, effective: effective?.get(patch.field) });
        if (patch.field !== "deleted" && concurrent?.get("deleted") === true)
          issues.push({ code: "concurrent_delete", object: patch.id, message: "修改期间对象已被摘除；本次字段修改不会恢复对象" });
      }
    } finally { prior.destroy(); }
    return { update, merged: current, patches, conflicts, issues };
  } catch (error) {
    current.destroy();
    throw error;
  } finally {
    base.destroy();
    branch.destroy();
  }
}
