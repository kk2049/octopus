import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import type { GraphSpec, Provenance } from "@claude-bot/research-canvas-contract";
import { applyGraphPatches, cloneGraph, compileGraphEdit, graphSpec, projectGraph } from "./graph-crdt.js";
import { readGraphYaml, writeGraphYaml } from "./graph-yaml.js";

const stamp: Provenance = { kind: "human", owner: "alice", trigger: "alice", agent: null, run: null, model: null, at: "2026-09-24T00:00:00Z" };
const agent: Provenance = { ...stamp, kind: "agent", agent: "editor", run: "run" };
function initial() {
  const doc = new Y.Doc();
  applyGraphPatches(doc, [
    { bucket: "nodes", id: "a", field: "create", value: { ref: "note:a", label: "A" } },
    { bucket: "nodes", id: "b", field: "create", value: { ref: "note:b", label: "B" } },
    { bucket: "nodes", id: "c", field: "create", value: { ref: "note:c", label: "C" } },
    { bucket: "edges", id: "e", field: "create", value: { from: "a", to: "b", relation: "supports" } },
  ], stamp);
  const bytes = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return bytes;
}
const coverage = { nodes: ["a", "b", "c"], edges: ["e"] };
function spec(bytes: Uint8Array): GraphSpec {
  const doc = cloneGraph(bytes);
  try { return graphSpec(doc); } finally { doc.destroy(); }
}

describe("YAML graph snapshots", () => {
  it("round-trips structural references without coordinates or resource contents", () => {
    const source = writeGraphYaml("snapshot_42_s_1", spec(initial()));
    expect(readGraphYaml(source)).toMatchObject({ schema: "research-graph/v1", snapshot: "snapshot_42_s_1", nodes: { a: { ref: "note:a" } } });
    expect(source).not.toMatch(/\bx:|\by:|data:|text:/);
    expect(readGraphYaml(source + "\n# explanatory comment\n")).toEqual(readGraphYaml(source));
  });
  it("rejects duplicate ids, coordinates, unknown fields and non-string refs", () => {
    const source = writeGraphYaml("snapshot_42_s_1", spec(initial()));
    expect(() => readGraphYaml(source.replace("  a:", "  a: {}\n  a:"))).toThrow();
    expect(() => readGraphYaml(source.replace("    label: A", "    label: A\n    x: 12"))).toThrow("nodes.a.x");
    expect(() => readGraphYaml(source.replace("ref: note:a", "ref: 12"))).toThrow("nodes.a.ref");
    expect(() => readGraphYaml("!!js/function function() {}")).toThrow();
  });
  it("uses graph ids for identity and treats a label change as one field edit", () => {
    const bytes = initial(), next = spec(bytes);
    next.nodes.a.label = "A revised";
    const result = compileGraphEdit(bytes, bytes, next, coverage, agent);
    try { expect(result.patches).toEqual([{ bucket: "nodes", id: "a", field: "label", value: "A revised" }]); }
    finally { result.merged.destroy(); }
  });
});

describe("causal graph edits", () => {
  it("retains concurrent additions and independent fields in both update orders", () => {
    const bytes = initial(), human = cloneGraph(bytes), next = spec(bytes);
    applyGraphPatches(human, [
      { bucket: "nodes", id: "d", field: "create", value: { ref: "note:d", label: "D" } },
      { bucket: "nodes", id: "a", field: "ref", value: "file:artifact" },
    ], stamp);
    next.nodes.a.label = "agent label";
    const result = compileGraphEdit(bytes, Y.encodeStateAsUpdate(human), next, coverage, agent);
    const inverse = cloneGraph(bytes);
    try {
      Y.applyUpdate(inverse, result.update);
      Y.applyUpdate(inverse, Y.encodeStateAsUpdate(human));
      expect(graphSpec(inverse)).toEqual(graphSpec(result.merged));
      expect(graphSpec(result.merged).nodes).toMatchObject({ a: { label: "agent label", ref: "file:artifact" }, d: { label: "D" } });
      expect(result.conflicts).toEqual([]);
      const beforeRetry = graphSpec(inverse);
      Y.applyUpdate(inverse, result.update);
      expect(graphSpec(inverse)).toEqual(beforeRetry);
    } finally { human.destroy(); inverse.destroy(); result.merged.destroy(); }
  });
  it("limits omissions to the exported snapshot coverage", () => {
    const bytes = initial(), next = projectGraph(spec(bytes), { nodes: ["a"], edges: [] });
    delete next.nodes.a;
    const result = compileGraphEdit(bytes, bytes, next, { nodes: ["a"], edges: [] }, agent);
    try {
      expect(graphSpec(result.merged).nodes).toEqual({ b: { ref: "note:b", label: "B" }, c: { ref: "note:c", label: "C" } });
      expect(graphSpec(result.merged).edges.e).toBeDefined();
      expect(result.issues).toContainEqual(expect.objectContaining({ code: "missing_endpoint", object: "e" }));
    } finally { result.merged.destroy(); }
  });
  it("reports competing scalar edits with their effective merged value", () => {
    const bytes = initial(), human = cloneGraph(bytes), next = spec(bytes);
    applyGraphPatches(human, [{ bucket: "nodes", id: "a", field: "label", value: "human label" }], stamp);
    next.nodes.a.label = "agent label";
    const result = compileGraphEdit(bytes, Y.encodeStateAsUpdate(human), next, coverage, agent);
    try {
      expect(result.conflicts).toEqual([{ object: "a", field: "label", base: "A", current: "human label", submitted: "agent label", effective: graphSpec(result.merged).nodes.a.label }]);
    } finally { human.destroy(); result.merged.destroy(); }
  });
  it("does not resurrect a concurrently removed node", () => {
    const bytes = initial(), human = cloneGraph(bytes), next = spec(bytes);
    applyGraphPatches(human, [{ bucket: "nodes", id: "a", field: "deleted", value: true }], stamp);
    next.nodes.a.label = "late edit";
    const result = compileGraphEdit(bytes, Y.encodeStateAsUpdate(human), next, coverage, agent);
    try {
      expect(graphSpec(result.merged).nodes.a).toBeUndefined();
      expect(result.issues).toContainEqual(expect.objectContaining({ code: "concurrent_delete", object: "a" }));
    } finally { human.destroy(); result.merged.destroy(); }
  });
  it("keeps an edge's two endpoints together under concurrent rewiring", () => {
    const bytes = initial(), human = cloneGraph(bytes), next = spec(bytes);
    applyGraphPatches(human, [{ bucket: "edges", id: "e", field: "endpoints", value: { from: "b", to: "c" } }], stamp);
    next.edges.e = { from: "c", to: "a", relation: "supports" };
    const result = compileGraphEdit(bytes, Y.encodeStateAsUpdate(human), next, coverage, agent);
    try {
      expect([{ from: "b", to: "c", relation: "supports" }, next.edges.e]).toContainEqual(graphSpec(result.merged).edges.e);
      expect(result.conflicts[0]?.field).toBe("endpoints");
    } finally { human.destroy(); result.merged.destroy(); }
  });
  it("rejects an unseen identity collision without changing current state", () => {
    const bytes = initial(), human = cloneGraph(bytes), next = spec(bytes);
    applyGraphPatches(human, [{ bucket: "nodes", id: "d", field: "create", value: { ref: "note:d", label: "Human" } }], stamp);
    next.nodes.d = { ref: "file:other", label: "Agent" };
    try {
      expect(() => compileGraphEdit(bytes, Y.encodeStateAsUpdate(human), next, coverage, agent)).toThrow("ID 已存在");
      expect(graphSpec(human).nodes.d.label).toBe("Human");
    } finally { human.destroy(); }
  });
});
