import { describe, expect, it } from "vitest";
import { project, projectIncremental } from "./projection.js";

const event = (type: string, data: Record<string, unknown>) => ({
  type,
  data,
  at: "2026-08-30T10:00:00.000Z",
  by: "session-plus",
});

describe("Session Plus incremental projection", () => {
  it("matches a complete fold across a snapshot boundary", () => {
    const events = [
      event("session_pin_set", { session: "one", pinned: true }),
      event("session_title_set", { session: "one", title: "Alpha" }),
      event("session_reviewed", { session: "one", completed_at: "2026-08-30T09:00:00.000Z" }),
      event("file_annotations_set", { file_key: "doc", annotations: [{ id: "a1" }] }),
    ];
    expect(projectIncremental(project(events.slice(0, 2)), events.slice(2))).toEqual(project(events));
  });
});

describe("Session Plus folders", () => {
  it("keeps one folder per chat, survives the snapshot boundary and ignores stale events", () => {
    const events = [
      event("session_folder_saved", { folder: "f_a", name: "  实验   线 " }),
      event("session_folder_saved", { folder: "f_b", name: "论文" }),
      event("sessions_filed", { folder: "f_a", sessions: ["one", "two", "two"] }),
      event("sessions_filed", { folder: "f_b", sessions: ["two"] }),
      event("sessions_filed", { folder: "f_missing", sessions: ["one"] }),
      event("session_folder_saved", { folder: "f_b", name: "论文与汇报" }),
      event("sessions_filed", { folder: "", sessions: ["one"] }),
      event("session_folder_saved", { folder: "bad id!", name: "x" }),
      event("session_folder_saved", { folder: "f_c", name: "   " }),
    ];
    const folded = project(events);
    expect(folded.sessionFolders).toEqual([
      { id: "f_a", name: "实验 线", sessions: [] },
      { id: "f_b", name: "论文与汇报", sessions: ["two"] },
    ]);
    for (let split = 0; split <= events.length; split += 1) {
      expect(projectIncremental(project(events.slice(0, split)), events.slice(split))).toEqual(folded);
    }
    expect(project([...events, event("session_folder_deleted", { folder: "f_b" })]).sessionFolders)
      .toEqual([{ id: "f_a", name: "实验 线", sessions: [] }]);
  });

  it("bounds folders and names even when replaying events the action would refuse", () => {
    const many = Array.from({ length: 70 }, (_, index) => event("session_folder_saved", { folder: `f${index}`, name: "x".repeat(40) }));
    const folded = project(many);
    expect(folded.sessionFolders).toHaveLength(64);
    expect(Array.from(folded.sessionFolders[0]!.name)).toHaveLength(32);
  });
});
