import { describe, expect, it } from "vitest";
import type { ResearchNode, ResearchEdge } from "@claude-bot/research-canvas-contract";
import { buildHierarchy, fitScopeCamera, nodeStatus, scopeEdges, scopeReferences, oneHopNeighbors, nodesInRectangle } from "./hierarchy.js";
const node = (id: string, members?: string[], archived = false): ResearchNode => ({ id, type: members ? "folder" : "task", title: id, archived, phase: "future", x: 0, y: 0, data: members ? { members } : {} } as ResearchNode);
describe("research hierarchy", () => {
  it("shows only direct children while keeping shared material reachable from both branches", () => {
    const graph = buildHierarchy([node("A", ["A0"]), node("A0", ["design", "evidence"]), node("B", ["evidence"]), node("design"), node("evidence"), node("old", [], true)]);
    expect(graph.roots.map((n) => n.id)).toEqual(["A", "B"]);
    expect(graph.children.get("A")?.map((n) => n.id)).toEqual(["A0"]);
    expect(graph.trail("design").map((n) => n.id)).toEqual(["A", "A0", "design"]);
    expect(graph.parents.get("evidence")).toEqual(["A0", "B"]);
  });
  it("bounds cycles, ignores stale references and provides an entry to isolated components", () => {
    const graph = buildHierarchy([node("A", ["A", "B", "gone", "B"]), node("B", ["A"])]);
    expect(graph.roots.map((n) => n.id)).toEqual(["A"]);
    expect(graph.children.get("A")?.map((n) => n.id)).toEqual(["B"]);
    expect(graph.descendants("A").map((n) => n.id)).toEqual(["B"]);
    expect(graph.trail("B")).toHaveLength(2);
  });
  it("never draws cross-scope or archived relations and makes full scope relations opt-in", () => {
    const edges = [{ id: "ab", source: "a", target: "b" }, { id: "ac", source: "a", target: "c" }, { id: "ba", source: "b", target: "a", archived: true }] as ResearchEdge[];
    expect(scopeEdges(edges, new Set(["a", "b"]), "none", "a")).toEqual([]);
    expect(scopeEdges(edges, new Set(["a", "b"]), "selected", "a").map((e) => e.id)).toEqual(["ab"]);
    expect(scopeEdges(edges, new Set(["a", "b"]), "selected", "c")).toEqual([]);
  });
  it("uses explicit task progress and never calls a historical record completed", () => {
    expect(nodeStatus({ ...node("a"), phase: "past" }).label).toBe("历史记录");
    expect(nodeStatus({ ...node("a"), data: { meta: { status: "in_progress" } } }).label).toBe("进行中");
  });
  it("fits the current scope inside reserved chrome without changing public positions", () => {
    const nodes = [node("a"), { ...node("b"), x: 340 }];
    expect(fitScopeCamera(nodes, (n) => n, { left: 280, top: 260, width: 640, height: 250 })).toEqual({ x: 280, y: 260, zoom: 1 });
    expect(nodes[1].x).toBe(340);
  });
});

it("shows live one-hop references with their original object and direction, without pulling neighbors of neighbors", () => {
  const nodes = [node("A", ["n"]), node("n"), node("x"), node("far"), node("old", undefined, true)];
  const edges = [{ id: "out", source: "n", target: "x", label: "supports" }, { id: "back", source: "x", target: "n", label: "derived_from" }, { id: "far", source: "x", target: "far", label: "supports" }, { id: "dead", source: "n", target: "old" }] as ResearchEdge[];
  const scoped = scopeReferences(nodes, edges, nodes.slice(0, 2), "A");
  expect(scoped.nodes.map(node => node.id)).toEqual(["A", "n", "x"]);
  expect(scoped.nodes[2]).toBe(nodes[2]);
  expect(oneHopNeighbors(nodes, edges, "n").map(row => [row.direction, row.node.id])).toEqual([["out", "x"], ["in", "x"]]);
});
it("box selection uses card dimensions and works when dragged backwards", () => {
  const nodes = [node("a"), { ...node("b"), x: 900 }];
  expect(nodesInRectangle(nodes, { x: 500, y: 500 }, { x: 100, y: 100 }, node => node)).toEqual(["a"]);
});
