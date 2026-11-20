import { describe, expect, it } from "vitest";
import { type GraphSpec, type GraphPosition } from "@claude-bot/research-canvas-contract";
import { arrangeGraph } from "./layout.js";
const spec: GraphSpec = { nodes: { root: { ref: "goal:r", label: "Goal" }, a: { ref: "goal:a", label: "Target" }, b: { ref: "note:b", label: "Evidence" }, hidden: { ref: "note:h", label: "Hidden" } }, edges: { ra: { from: "root", to: "a", relation: "decomposes" }, rb: { from: "root", to: "b", relation: "contains" }, ah: { from: "a", to: "hidden", relation: "contains" } } };
describe("explicit shared layout", () => {
  it("arranges only the requested visible nodes with actual sizes, preserving pinned cards", () => {
    const current: Record<string, GraphPosition> = { root: { x: 80, y: 400, pinned: true, width: 800, height: 450 }, a: { x: 80, y: 400, width: 640, height: 500 }, b: { x: 80, y: 400 }, hidden: { x: 992, y: 400, width: 1000, height: 1200 } };
    const before = JSON.stringify(current);
    const moved = arrangeGraph(spec, current, undefined, false, [], { nodes: ["root", "a", "b"], mode: "tree" });
    expect(Object.keys(moved).sort()).toEqual(["a", "b"]);
    expect(moved.a).toMatchObject({ width: 640, height: 500 });
    expect(moved.a.x).toBeGreaterThanOrEqual(80 + 800);
    expect(moved.b.y).toBeGreaterThanOrEqual(moved.a.y + 500);
    expect(JSON.stringify(current)).toBe(before);
  });
  it("places a new child near its actual parent without moving existing geometry", () => {
    const current = { root: { x: 2300, y: 1700, width: 820, height: 500, pinned: true }, a: { x: 0, y: 0 }, hidden: { x: 50, y: 200 } };
    const moved = arrangeGraph(spec, current, "b", true);
    expect(Object.keys(moved)).toEqual(["b"]);
    expect(moved.b).toEqual({ x: 2300 + 820 + 112, y: 1700 });
  });
  it("compact arrangement retains dimensions and pins; an empty scope is a no-op", () => {
    const current = { root: { x: 0, y: 0, pinned: true }, a: { x: 100, y: 100, width: 600, height: 500 } };
    expect(arrangeGraph(spec, current, undefined, false, [], { nodes: [] })).toEqual({});
    const moved = arrangeGraph(spec, current, undefined, false, [], { nodes: ["root", "a", "b"], mode: "compact" });
    expect(moved.root).toBeUndefined(); expect(moved.hidden).toBeUndefined();
    expect(moved.a).toMatchObject({ width: 600, height: 500 });
    expect(moved.b.x).toBeGreaterThanOrEqual(moved.a.x + 600);
    expect(() => arrangeGraph(spec, current, undefined, false, [], { nodes: ["missing"] })).toThrow("范围");
  });
});

it("never places a newly expanded branch over another collapsed branch's saved geometry", () => {
  const current = { root: { x: 0, y: 0, pinned: true }, a: { x: 412, y: 0 }, hidden: { x: 412, y: 0, width: 600, height: 800 } };
  const moved = arrangeGraph(spec, current, undefined, false, [], { nodes: ["root", "a"] });
  expect(moved.a.y).toBeGreaterThanOrEqual(832);
  expect(moved.hidden).toBeUndefined();
});
