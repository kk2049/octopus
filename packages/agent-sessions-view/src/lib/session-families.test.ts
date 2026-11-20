import { describe, expect, it } from "vitest";
import { sessionFamilies } from "./session-families.js";
import type { RosterSession } from "./roster.js";

const row = (id: string, parentResourceId?: string): RosterSession => ({
  id, resourceId: id, sessionId: id, deviceId: "device", device: "device",
  cliKind: "codex", cwd: "~/town", parentResourceId,
});

describe("session families", () => {
  it("groups shuffled descendants by exact identity without using cwd, titles or activity", () => {
    const family = sessionFamilies([row("grandchild", "child"), row("same-cwd"), row("child", "parent"), row("parent")]);
    expect(family.roots.map((s) => s.resourceId)).toEqual(["same-cwd", "parent"]);
    expect(family.children.get("parent")?.map((s) => s.resourceId)).toEqual(["child"]);
    expect(family.children.get("child")?.map((s) => s.resourceId)).toEqual(["grandchild"]);
  });

  it("keeps independent headless runs visible and folds only declared children", () => {
    const family = sessionFamilies([
      row("interactive"),
      { ...row("exec-1"), executionMode: "exec" },
      { ...row("exec-2"), executionMode: "exec" },
      { ...row("other-directory"), executionMode: "exec", cwd: "~/other" },
      { ...row("native-child", "interactive"), executionMode: "exec" },
    ]);
    expect(family.roots.map((s) => s.resourceId)).toEqual(["interactive", "exec-1", "exec-2", "other-directory"]);
    expect(family.children.get("interactive")?.[0].resourceId).toBe("native-child");
  });

  it("shows actual chats when parents are missing or lineage is cyclic", () => {
    const family = sessionFamilies([row("orphan", "absent"), row("a", "b"), row("b", "a"), row("self", "self")]);
    expect(family.roots.map((s) => s.resourceId)).toEqual(["orphan", "a", "b", "self"]);
    expect(family.children.size).toBe(0);
  });

  it("keeps human named and pinned chats visible without changing native input ownership", () => {
    const named = { ...row("named", "parent"), title: "Town 4", userNamed: true, inputMode: "parent_owned" as const };
    const family = sessionFamilies([row("parent"), named, row("pinned", "parent"), row("worker", "parent")], ["pinned"]);
    expect(family.roots.map((s) => s.resourceId)).toEqual(["parent", "named", "pinned"]);
    expect(family.roots[1]).toBe(named);
    expect(family.children.get("parent")?.map((s) => s.resourceId)).toEqual(["worker"]);
  });

  it("does not fold a cross-device or cross-provider claim", () => {
    const family = sessionFamilies([row("parent"),
      { ...row("other-device", "parent"), deviceId: "elsewhere" },
      { ...row("other-provider", "parent"), cliKind: "claude" }]);
    expect(family.roots).toHaveLength(3);
    expect(family.children.size).toBe(0);
  });

  it("keeps a confirmed foreground tmux child directly visible", () => {
    const foreground = { ...row("foreground", "parent"), inputMode: "parent_owned" as const,
      runtime: { process_state: "alive", attachment: { kind: "terminal_tmux", state: "attached", transport: "tmux" } } };
    const family = sessionFamilies([row("parent"), foreground, row("worker", "parent")]);
    expect(family.roots.map((s) => s.resourceId)).toEqual(["parent", "foreground"]);
    expect(family.roots[1]).toBe(foreground);
    expect(family.children.get("parent")?.map((s) => s.resourceId)).toEqual(["worker"]);
  });
});
