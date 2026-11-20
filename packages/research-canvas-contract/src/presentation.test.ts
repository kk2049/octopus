import { expect, it } from "vitest";
import { canvasCardSize } from "./presentation.js";
import type { ResearchNode } from "./model.js";
const stamp = { kind: "human" as const, owner: "reader", trigger: "reader", agent: null, run: null, model: null, at: "2026-09-26T00:00:00Z" };
it("reserves report summary, independent states and a chart while preserving user dimensions", () => {
  const report: ResearchNode = { schema: 1, id: "report", type: "finding", title: "Result", summary: "Observation", phase: "present", x: 0, y: 0, version: 1, archived: false, created: stamp, updated: stamp, data: { meta: { reportId: "report-v1" } } };
  expect(canvasCardSize(report)).toEqual({ width: 460, height: 440 });
  expect(canvasCardSize(report, "canvas", { width: 620, height: 600 })).toEqual({ width: 620, height: 600 });
  expect(canvasCardSize({ ...report, data: {} })).toEqual({ width: 300, height: 212 });
});
