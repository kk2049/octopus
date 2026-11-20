import { describe, expect, it } from "vitest";
import { project, projectIncremental } from "./projection.js";

const ev = (id: string, state: string) => ({
  type: "note_added", data: { id, title: id, body: "Body", state }, at: "2026-08-30T10:00:00Z", by: "user:alice",
});

describe("showcase incremental projection", () => {
  it("equals a complete fold", () => {
    const events = [ev("one", "草稿"), ev("two", "待办")];
    expect(projectIncremental(project(events.slice(0, 1)), events.slice(1))).toEqual(project(events));
  });
});
