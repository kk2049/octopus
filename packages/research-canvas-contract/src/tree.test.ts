import { describe, expect, it } from "vitest";
import { canvasTree } from "./tree.js";
import { canvasCardSize } from "./presentation.js";
import { canvasEdgeCurve, diagnoseCanvasLayout, renderCanvasSnapshot } from "./layout.js";
import type { ResearchNode } from "./model.js";
const stamp = { kind: "system", owner: "test", agent: null, run: null, model: null, trigger: "test", at: "2026-09-26T00:00:00Z" } as const;
const node = (id: string, members: string[] = [], data = {}): ResearchNode => ({ id, title: id, summary: "", type: members.length ? "folder" : "note", data: { members, ...data }, x: 0, y: 0, archived: false, phase: "present", schema: 1, version: 1, created: stamp, updated: stamp });
describe("horizontal research tree", () => {
  it("expands stable identities, keeps shared evidence once, and preserves every semantic membership", () => {
    const nodes = [node("root", ["paper", "tests"]), node("paper", ["shared"]), node("tests", ["shared", "result"]), node("shared"), node("result")];
    const input = JSON.stringify(nodes), closed = canvasTree(nodes, "", new Set(["root"]));
    expect(closed.nodes.map(n => n.id)).toEqual(["root", "paper", "tests"]);
    const open = canvasTree(nodes, "", undefined, "canvas");
    expect(open.nodes.filter(n => n.id === "shared")).toHaveLength(1);
    expect(open.positions.paper.x).toBeGreaterThan(open.positions.root.x);
    expect(open.positions.shared.x).toBeGreaterThan(open.positions.paper.x);
    expect(JSON.stringify(nodes)).toBe(input);
    expect(diagnoseCanvasLayout({ nodes: open.nodes.map(n => ({ ...n, data: { ...n.data, members: [] } })), edges: [], positions: open.positions }).warnings).toEqual([]);
  });
  it("handles cycles, missing references, and deep trees without recursive stack growth", () => {
    expect(canvasTree([node("a", ["b", "missing"]), node("b", ["a"])]).nodes).toHaveLength(2);
    const nodes = Array.from({ length: 3000 }, (_, i) => node(String(i), i < 2999 ? [String(i + 1)] : []));
    expect(canvasTree(nodes).nodes).toHaveLength(3000);
  });
  it("routes mixed size cards to their real boundaries and reports actual overlaps", () => {
    const image = node("image", [], { meta: { previewKind: "image" } }), other = node("note");
    const route = canvasEdgeCurve({ x: 0, y: 0 }, { x: 600, y: 0 }, canvasCardSize(image), canvasCardSize(other), "horizontal");
    expect(route.points[0]).toEqual({ x: 520, y: 210 });
    expect(route.points.at(-1)).toEqual({ x: 600, y: 106 });
    expect(diagnoseCanvasLayout({ nodes: [image, { ...other, x: 400 }], edges: [] }).warnings[0].code).toBe("node_overlap");
  });
});


it("uses saved geometry for every legacy view argument without silently arranging", () => {
  const nodes = [{ ...node("goal", ["a", "b"]), type: "goal" } as ResearchNode, node("a", ["image"]), node("b"), node("image", [], { meta: { previewKind: "image" } })];
  const positions = { goal: { x: 0, y: 0 }, a: { x: 700, y: 0, width: 620, height: 550 }, b: { x: 700, y: 700 }, image: { x: 1500, y: 0 } };
  for (const layout of ["tree", "hierarchy", "canvas"] as const) {
    const report = diagnoseCanvasLayout({ nodes, edges: [], layout, positions });
    expect(report.counts.nodes).toBe(3);
    expect(report.warnings).toEqual([]);
    const expanded = ["goal", "a"];
    expect(diagnoseCanvasLayout({ nodes, edges: [], layout, positions, expanded }).counts.nodes).toBe(4);
    expect(renderCanvasSnapshot({ nodes, edges: [], layout, positions, expanded }).svg).toContain('width="620" height="550"');
    expect(renderCanvasSnapshot({ nodes, edges: [], layout, positions, expanded }).svg).toContain('translate(700 0)');
  }
  expect(canvasCardSize(nodes[1], "tree")).toEqual(canvasCardSize(nodes[1]));
});
