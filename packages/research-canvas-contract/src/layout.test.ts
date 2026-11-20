import { describe, expect, it } from "vitest";
import { canvasScope, canvasEdgeCurve, diagnoseCanvasLayout, renderCanvasSnapshot } from "./layout.js";
import type { ResearchEdge, ResearchNode } from "./model.js";
const stamp = { kind: "system", owner: "test", agent: null, run: null, model: null, trigger: "test", at: "2026-09-22T00:00:00Z" } as const;
const node = (id: string, x = 0, y = 0, type: ResearchNode["type"] = "task", members?: string[]): ResearchNode => ({ id, type, schema: 1, title: id, summary: "", phase: "present", x, y, data: members ? { members } : {}, version: 1, archived: false, created: stamp, updated: stamp });
const edge = (id: string, source: string, target: string): ResearchEdge => ({ id, source, target, label: "支持", version: 1, archived: false, created: stamp, updated: stamp });

describe("scope-aware canvas inspection", () => {
  it("checks local public coordinates without treating another folder as overlap", () => {
    const nodes = [node("goal", -600, 0, "goal"), node("left", 0, -400, "folder", ["a", "b"]), node("right", 340, 0, "folder", ["c"]), node("a"), node("b", 50), node("c")];
    expect(diagnoseCanvasLayout({ nodes, edges: [], layout: "canvas" }).warnings).toEqual([]);
    expect(diagnoseCanvasLayout({ nodes, edges: [], scope: "left", layout: "canvas" }).warnings).toMatchObject([{ code: "node_overlap", nodes: ["a", "b"] }]);
    expect(diagnoseCanvasLayout({ nodes, edges: [], scope: "left", layout: "hierarchy" }).warnings).toMatchObject([{ code: "node_overlap", nodes: ["a", "b"] }]);
  });
  it("checks public resized bounds for either card, including smaller cards", () => {
    const nodes = [node("a"), node("b")];
    const small = { x: 0, y: 0, width: 240, height: 144 };
    const check = (positions: Parameters<typeof diagnoseCanvasLayout>[0]["positions"]) =>
      diagnoseCanvasLayout({ nodes, edges: [], positions }).warnings;
    expect(check({ a: small, b: { ...small, x: 260, y: 164 } })).toEqual([]);
    expect(check({ a: { ...small, width: 600, height: 500 }, b: { ...small, x: 500, y: 400 } }))
      .toMatchObject([{ code: "node_overlap", nodes: ["a", "b"] }]);
    expect(check({ a: small, b: { x: -500, y: -400, width: 600, height: 500 } }))
      .toMatchObject([{ code: "node_overlap", nodes: ["a", "b"] }]);
  });
  it("finds actual crossing curves and through-card links, ignoring cross-scope and archived relations", () => {
    const nodes = [node("a"), node("b", 650, 400), node("c", 0, 400), node("d", 650), node("middle", 400, 190), node("folder", 1200, 0, "folder", ["hidden"]), node("hidden")];
    const result = diagnoseCanvasLayout({ nodes, edges: [edge("ab", "a", "b"), edge("cd", "c", "d"), edge("hidden-edge", "a", "hidden"), { ...edge("old", "a", "d"), archived: true }], layout: "canvas" });
    expect(result.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "edge_crossing", edges: ["ab", "cd"] }), expect.objectContaining({ code: "edge_through_node" })]));
    expect(result.counts.checkedEdges).toBe(2);
    expect(diagnoseCanvasLayout({ nodes, edges: [edge("ab", "a", "b")], layout: "canvas", relations: "none" }).warnings.some((warning) => warning.code.startsWith("edge_"))).toBe(false);
  });
  it("keeps cycle islands reachable, refuses unknown scopes and bounds diagnostics", () => {
    const nodes = [node("a", 0, 0, "folder", ["b"]), node("b", 0, 0, "folder", ["a"])];
    expect(canvasScope(nodes).nodes.map((node) => node.id)).toEqual(["a"]);
    expect(diagnoseCanvasLayout({ nodes, edges: [] }).warnings[0].code).toBe("hierarchy_cycle");
    expect(() => canvasScope(nodes, "missing")).toThrow("画布节点不存在");
    const large = Array.from({ length: 121 }, (_, i) => node(String(i)));
    const report = diagnoseCanvasLayout({ nodes: large, edges: [], layout: "canvas" });
    expect(report.complete).toBe(false);
    expect(report.warnings).toHaveLength(30);
    expect(report.warningsTruncated).toBe(true);
    expect(() => renderCanvasSnapshot({ nodes: large, edges: [] })).toThrow("120");
  });
  it("detects a cycle reachable from a valid root and reports it only in related scopes", () => {
    const nodes = [node("root", 0, 0, "folder", ["a"]), node("a", 0, 0, "folder", ["b"]), node("b", 0, 0, "folder", ["a"]), node("unrelated", 340, 0, "folder")];
    expect(canvasScope(nodes).nodes.map((node) => node.id)).toEqual(["root", "unrelated"]);
    expect(new Set(canvasScope(nodes).cycles)).toEqual(new Set(["a", "b"]));
    for (const scope of ["", "root", "a", "b"]) {
      expect(diagnoseCanvasLayout({ nodes, edges: [], scope }).warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "hierarchy_cycle", nodes: expect.arrayContaining(["a", "b"]) })]));
    }
    expect(diagnoseCanvasLayout({ nodes, edges: [], scope: "unrelated" }).warnings).toEqual([]);
    expect(canvasScope(nodes.map((item) => item.id === "b" ? { ...item, archived: true } : item)).cycles).toEqual([]);
  });

  it("produces deterministic inert SVG and names it a structure preview", () => {
    const a = { ...node("a", 999_999, 999_999), title: '<script>alert("x")</script>', summary: "<img src=x onerror=x>" };
    const input = { nodes: [a], edges: [] };
    const snapshot = renderCanvasSnapshot(input);
    expect(snapshot).toEqual(renderCanvasSnapshot(input));
    expect(snapshot).toMatchObject({ kind: "structure-preview", mime: "image/svg+xml", layout: "canvas" });
    expect(snapshot.svg).toContain("非浏览器截图");
    expect(snapshot.svg).toContain("&lt;script&gt;");
    expect(snapshot.svg).not.toContain("<script>");
    expect(snapshot.svg).not.toContain("<img");
    expect(snapshot.svg).toContain("999999");
    expect(renderCanvasSnapshot({ ...input, layout: "hierarchy" }).svg).toContain("999999");
  });
});

 it("keeps goals and their edges on the default canvas and routes reverse/vertical edges outside their cards", () => {
  const nodes = [node("goal", 0, 0, "goal"), node("branch", 450, 0, "folder")];
  expect(canvasScope(nodes).nodes.map(n => n.id)).toEqual(["goal", "branch"]);
  expect(diagnoseCanvasLayout({ nodes, edges: [edge("plan", "goal", "branch")] }).counts.checkedEdges).toBe(1);
  expect(canvasEdgeCurve({x:450,y:0},{x:0,y:0}).points[0]).toEqual({x:450,y:106});
  expect(canvasEdgeCurve({x:0,y:0},{x:0,y:400}).points[0]).toEqual({x:150,y:212});
 });

it("routes every chosen source handle and target side without losing it when cards move", () => {
  const sides = { top: [150, 0], right: [300, 106], bottom: [150, 212], left: [0, 106] } as const;
  for (const side of Object.keys(sides) as (keyof typeof sides)[]) {
    const curve = canvasEdgeCurve({ x: 0, y: 0 }, { x: 600, y: 400 }, undefined, undefined, undefined, { sourceSide: side, targetSide: "bottom" });
    expect(curve.points[0]).toEqual({ x: sides[side][0], y: sides[side][1] });
    expect(curve.points.at(-1)).toEqual({ x: 750, y: 612 });
  }
});
