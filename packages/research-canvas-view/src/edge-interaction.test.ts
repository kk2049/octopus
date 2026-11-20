import { describe, expect, it } from "vitest";
import type { ResearchEdge, ResearchNode } from "@claude-bot/research-canvas-contract";
import { mainlineEdges } from "./edge-interaction.js";
const node = (id: string, data = {}, type = "task") => ({ id, data, type, archived: false }) as ResearchNode;
const edge = (id: string, source: string, target: string, label = "contains") => ({ id, source, target, label, archived: false }) as ResearchEdge;
describe("explicit mainline presentation", () => {
  const children = [node("first"), node("second"), node("material")];
  const edges = [edge("entry", "folder", "first"), edge("second-membership", "folder", "second"), edge("material-membership", "folder", "material"), edge("next", "first", "second", "下一步"), edge("support", "material", "second", "支持"), edge("ordinary", "other", "material")];
  it.each([JSON.stringify(["first", "second"]), ["first", "second"]])("hides only direct contains lines after the first step and preserves all semantic edges: %j", mainline => {
    const folder = node("folder", { members: ["first", "second", "material"], meta: { mainline } }, "folder");
    const before = JSON.stringify({ folder, children, edges });
    const result = mainlineEdges([folder, ...children], edges);
    expect([...result.hidden]).toEqual(["second-membership", "material-membership"]);
    expect([...result.emphasized]).toEqual(["next"]);
    expect(JSON.stringify({ folder, children, edges })).toBe(before);
  });
  it.each([undefined, "not json", "{}", JSON.stringify(["first", "missing"]), [], ["first"], ["first", "first"], ["first", "missing"], ["first", "outside"], ["first", 123]])("leaves invalid or absent mainline metadata unchanged: %j", mainline => {
    const folder = node("folder", { members: ["first", "second", "material"], meta: { mainline } }, "folder");
    const result = mainlineEdges([folder, ...children, node("outside")], edges);
    expect(result.hidden.size).toBe(0); expect(result.emphasized.size).toBe(0);
  });
  it("ignores archived steps and metadata on other node kinds", () => {
    const folder = node("folder", { members: ["first", "second"], meta: { mainline: ["first", "second"] } }, "folder");
    expect(mainlineEdges([folder, children[0], { ...children[1], archived: true }], edges).hidden.size).toBe(0);
    expect(mainlineEdges([{ ...folder, type: "task" }, ...children], edges).hidden.size).toBe(0);
  });
});
