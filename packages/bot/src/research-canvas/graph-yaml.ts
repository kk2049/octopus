import { dump, JSON_SCHEMA, load, YAMLException } from "js-yaml";
import {
  GRAPH_SCHEMA,
  type GraphEdgeSpec,
  type GraphNodeSpec,
  type GraphSpec,
  type GraphYamlSnapshot,
} from "@claude-bot/research-canvas-contract";

export const GRAPH_YAML_MAX_BYTES = 192_000;
export const GRAPH_MAX_NODES = 1000;
export const GRAPH_MAX_EDGES = 3000;
const identifier = /^[A-Za-z][A-Za-z0-9_.-]{0,159}$/;
const reference = /^[a-z][a-z0-9_-]{0,63}:[A-Za-z0-9_.:-]{1,240}$/;
const forbiddenKeys = new Set(["__proto__", "constructor", "prototype"]);

export class GraphInputError extends Error {
  constructor(
    readonly code: "invalid_yaml" | "invalid_graph" | "snapshot_expired" | "snapshot_scope" | "identity_collision" | "layout_stale" | "layout_busy",
    message: string,
    readonly path = "",
    readonly line?: number,
    readonly column?: number,
  ) {
    super(message);
    this.name = "GraphInputError";
  }
}
function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new GraphInputError("invalid_graph", `${path} 必须是对象`, path);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[], path: string): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key) || forbiddenKeys.has(key))
      throw new GraphInputError("invalid_graph", `不支持字段 ${path}.${key}`, `${path}.${key}`);
}
function string(value: unknown, path: string, max: number, pattern?: RegExp): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || (pattern && !pattern.test(value)))
    throw new GraphInputError("invalid_graph", `${path} 必须是有效字符串（最多 ${max} 字符）`, path);
  return value;
}
export function validateGraphSpec(value: unknown): GraphSpec {
  const root = record(value, "graph");
  keys(root, ["nodes", "edges"], "graph");
  const rawNodes = record(root.nodes, "nodes"), rawEdges = record(root.edges, "edges");
  if (Object.keys(rawNodes).length > GRAPH_MAX_NODES || Object.keys(rawEdges).length > GRAPH_MAX_EDGES)
    throw new GraphInputError("invalid_graph", "图快照过大，请读取较小范围");
  const nodes: Record<string, GraphNodeSpec> = Object.create(null);
  const edges: Record<string, GraphEdgeSpec> = Object.create(null);
  for (const [id, raw] of Object.entries(rawNodes)) {
    string(id, "nodes.id", 160, identifier);
    if (forbiddenKeys.has(id)) throw new GraphInputError("invalid_graph", "节点 ID 是保留名称", id);
    const node = record(raw, `nodes.${id}`);
    keys(node, ["ref", "label"], `nodes.${id}`);
    nodes[id] = {
      ref: string(node.ref, `nodes.${id}.ref`, 305, reference),
      label: string(node.label, `nodes.${id}.label`, 200),
    };
  }
  for (const [id, raw] of Object.entries(rawEdges)) {
    string(id, "edges.id", 160, identifier);
    if (forbiddenKeys.has(id)) throw new GraphInputError("invalid_graph", "关系 ID 是保留名称", id);
    const edge = record(raw, `edges.${id}`);
    keys(edge, ["from", "to", "relation"], `edges.${id}`);
    edges[id] = {
      from: string(edge.from, `edges.${id}.from`, 160, identifier),
      to: string(edge.to, `edges.${id}.to`, 160, identifier),
      relation: string(edge.relation, `edges.${id}.relation`, 120),
    };
  }
  return { nodes, edges };
}
export function readGraphYaml(source: string): GraphYamlSnapshot {
  if (typeof source !== "string" || Buffer.byteLength(source) > GRAPH_YAML_MAX_BYTES)
    throw new GraphInputError("invalid_yaml", "YAML 超过快照大小限制，请读取较小范围");
  let value: unknown;
  try {
    // No executable/custom tags, implicit dates, or merge-key expansion.
    // Duplicate keys remain errors; JSON-compatible scalar semantics are explicit.
    value = load(source, { schema: JSON_SCHEMA, json: false });
  } catch (error) {
    if (error instanceof YAMLException)
      throw new GraphInputError("invalid_yaml", error.reason, "", error.mark?.line === undefined ? undefined : error.mark.line + 1, error.mark?.column === undefined ? undefined : error.mark.column + 1);
    throw error;
  }
  const root = record(value, "graph");
  keys(root, ["schema", "snapshot", "nodes", "edges"], "graph");
  if (root.schema !== GRAPH_SCHEMA)
    throw new GraphInputError("invalid_graph", `schema 必须是 ${GRAPH_SCHEMA}`, "schema");
  return {
    schema: GRAPH_SCHEMA,
    snapshot: string(root.snapshot, "snapshot", 160, identifier),
    ...validateGraphSpec({ nodes: root.nodes, edges: root.edges }),
  };
}
export function writeGraphYaml(snapshot: string, spec: GraphSpec): string {
  const source = dump({ schema: GRAPH_SCHEMA, snapshot, nodes: spec.nodes, edges: spec.edges }, {
    schema: JSON_SCHEMA,
    noRefs: true,
    sortKeys: false,
    lineWidth: -1,
    noCompatMode: true,
  });
  if (Buffer.byteLength(source) > GRAPH_YAML_MAX_BYTES)
    throw new GraphInputError("invalid_graph", "图快照过大，请读取较小范围");
  return source;
}
