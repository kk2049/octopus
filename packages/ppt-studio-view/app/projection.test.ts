import { describe, expect, it } from "vitest";
import { project, projectIncremental } from "./projection.js";

const ev = (name: string) => ({
  type: "skill_loaded", data: { name }, at: "2026-08-30T10:00:00Z", by: "ppt-studio",
});

describe("ppt-studio incremental projection", () => {
  it("equals a complete fold", () => {
    const events = [ev("visual"), ev("review")];
    expect(projectIncremental(project(events.slice(0, 1)), events.slice(1))).toEqual(project(events));
  });
});
