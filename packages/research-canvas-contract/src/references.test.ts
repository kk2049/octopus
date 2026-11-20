import { describe, expect, it } from "vitest";
import type { GraphSpec } from "./graph-document.js";
import { commonResearchScope, referenceResearchNode } from "./references.js";
const graph: GraphSpec = { nodes: Object.fromEntries(["P", "A", "B", "C", "X"].map(id => [id, { ref: "note:" + id, label: id }])), edges: { pa: { from: "P", to: "A", relation: "contains" }, pb: { from: "P", to: "B", relation: "decomposes" }, ax: { from: "A", to: "X", relation: "contains" } } };
describe("single-entity cross-scope references", () => {
  it("defaults shared material to the closest common scope and retains references in both branches", () => {
    const result = referenceResearchNode(graph, "X", "B", "common", "first");
    expect(result.owner).toBe("P"); expect(result.relocated).toBe(true);
    expect(result.graph.nodes).toBe(graph.nodes);
    expect(Object.values(result.graph.edges)).toEqual(expect.arrayContaining([{ from: "A", to: "X", relation: "references" }, { from: "B", to: "X", relation: "references" }, { from: "P", to: "X", relation: "contains" }]));
    expect(graph.edges.ax.relation).toBe("contains");
    expect(referenceResearchNode(result.graph, "X", "B", "common", "repeat").graph).toEqual(result.graph);
  });
  it("can retain ownership in A while B references the same stable ref", () => {
    const result = referenceResearchNode(graph, "X", "B", "retain", "keep");
    expect(result.owner).toBe("A"); expect(result.relocated).toBe(false);
    expect(result.graph.edges.ax).toEqual(graph.edges.ax);
    expect(Object.keys(result.graph.nodes)).toHaveLength(5);
    expect(Object.values(result.graph.edges)).toContainEqual({ from: "B", to: "X", relation: "references" });
  });
  it("uses the project root across independent trees and bounds legacy cycles", () => {
    expect(referenceResearchNode(graph, "X", "C", "common", "root").owner).toBe("");
    expect(commonResearchScope({ ...graph, edges: { ...graph.edges, cycle: { from: "A", to: "P", relation: "contains" } } }, ["A", "B"])).toBe("P");
    expect(() => referenceResearchNode(graph, "X", "missing", "common", "bad")).toThrow();
  });
});
