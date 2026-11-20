import { describe, expect, it } from "vitest";
import { delete_session_folder, file_sessions, pin_session, save_session_folder } from "./actions.js";

const context = (state: Record<string, unknown> = {}) => ({ now: "2026-10-22T13:00:00.000Z", state });

describe("Session Plus App-owned organisation actions", () => {
  it("pins idempotently when asked and still toggles without an explicit state", () => {
    expect(pin_session(context({ pinned: ["r1"] }), { session: "r1", pinned: "true" }).events[0]!.data).toEqual({ session: "r1", pinned: true });
    expect(pin_session(context({ pinned: ["r1"] }), { session: "r1", pinned: "" }).events[0]!.data).toEqual({ session: "r1", pinned: false });
    expect(pin_session(context({ pinned: [] }), { session: "r1", pinned: "false" }).events[0]!.data).toEqual({ session: "r1", pinned: false });
  });

  it("validates folder ids, names and the folder count", () => {
    expect(save_session_folder(context(), { folder: "f_a", name: " 实验  线 " }).events[0]!.data).toEqual({ folder: "f_a", name: "实验 线" });
    expect(() => save_session_folder(context(), { folder: "../x", name: "x" })).toThrow(/folder id/);
    expect(() => save_session_folder(context(), { folder: "f_a", name: "   " })).toThrow(/不能为空/);
    expect(() => save_session_folder(context(), { folder: "f_a", name: "x".repeat(33) })).toThrow(/32/);
    const full = { sessionFolders: Array.from({ length: 64 }, (_, index) => ({ id: `f${index}`, name: "x", sessions: [] })) };
    expect(() => save_session_folder(context(full), { folder: "f_new", name: "x" })).toThrow(/64/);
    // Renaming an existing folder is still allowed at the limit.
    expect(save_session_folder(context(full), { folder: "f3", name: "y" }).events).toHaveLength(1);
    expect(delete_session_folder(context(), { folder: "f_a" }).events[0]!.data).toEqual({ folder: "f_a" });
  });

  it("files a bounded batch into an existing folder or out of all folders", () => {
    const state = { sessionFolders: [{ id: "f_a", name: "A", sessions: [] }] };
    expect(file_sessions(context(state), { sessions: "r1,r2,r1", folder: "f_a" }).events[0]!.data).toEqual({ folder: "f_a", sessions: ["r1", "r2"] });
    expect(file_sessions(context(state), { sessions: "r1", folder: "" }).events[0]!.data).toEqual({ folder: "", sessions: ["r1"] });
    expect(() => file_sessions(context(state), { sessions: "r1", folder: "f_gone" })).toThrow(/不存在/);
    expect(() => file_sessions(context(state), { sessions: "", folder: "f_a" })).toThrow(/1–64/);
    expect(() => file_sessions(context(state), { sessions: "bad id", folder: "f_a" })).toThrow(/1–64/);
    expect(() => file_sessions(context(state), { sessions: Array.from({ length: 65 }, (_, i) => `r${i}`).join(","), folder: "f_a" })).toThrow(/1–64/);
  });
});
