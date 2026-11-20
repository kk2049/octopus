import { describe, expect, it } from "vitest";
import { normaliseSession } from "../sessionhub/core.js";
import { SESSION_ROSTER_STALE_TTL_MS, SessionRosterMemory } from "./roster-memory.js";

function row(device: string, id: string, activity = "2026-08-13T00:00:00Z") {
  return normaliseSession({ device, source: "claude", id, last_activity: activity }, "alice", device);
}

describe("SessionRosterMemory", () => {
  it("retains an absent device, expires it, and clears stale when it recovers", () => {
    const memory = new SessionRosterMemory();
    memory.reconcile("tab", "runner", ["A", "B"], [row("A", "a1"), row("B", "b1")], 0);

    const missing = memory.reconcile("tab", "runner", ["A"], [row("A", "a2")], 1);
    expect(missing.map((entry) => [entry.deviceId, entry.sessionId, entry.stale])).toEqual([
      ["A", "a2", undefined],
      ["B", "b1", true],
    ]);

    const recovered = memory.reconcile("tab", "runner", ["A", "B"], [row("A", "a3"), row("B", "b2")], 2);
    expect(recovered.map((entry) => [entry.deviceId, entry.sessionId, entry.stale])).toEqual([
      ["A", "a3", undefined],
      ["B", "b2", undefined],
    ]);

    memory.reconcile("tab", "runner", ["A"], [row("A", "a4")], 3);
    const expired = memory.reconcile(
      "tab",
      "runner",
      ["A"],
      [row("A", "a5")],
      2 + SESSION_ROSTER_STALE_TTL_MS + 1,
    );
    expect(expired.map((entry) => entry.deviceId)).toEqual(["A"]);
  });

  it("keeps runner and local failures independent", () => {
    const memory = new SessionRosterMemory();
    memory.reconcile("tab", "runner", ["A"], [row("A", "a1")], 0);
    memory.reconcile("tab", "local", ["bot-host"], [row("bot-host", "local1")], 0);

    expect(memory.stale("tab", "runner", 1)).toMatchObject([{ deviceId: "A", stale: true }]);
    expect(memory.reconcile("tab", "local", ["bot-host"], [row("bot-host", "local2")], 1))
      .toMatchObject([{ deviceId: "bot-host", sessionId: "local2" }]);
    expect(memory.stale("tab", "local", 2)).toMatchObject([{ deviceId: "bot-host", stale: true }]);
  });

  it("partitions by instance, prunes closed instances, and is bounded both ways", () => {
    const memory = new SessionRosterMemory(100, 2, 2, 1);
    memory.reconcile("gone", "runner", ["A"], [row("A", "a1"), row("A", "a2")], 0);
    memory.reconcile("live", "runner", ["A", "B", "C"], [row("A", "a"), row("B", "b"), row("C", "c")], 0);
    memory.reconcile("new", "runner", ["A"], [row("A", "a")], 0);

    expect(memory.size()).toBe(2);
    expect(memory.size("live")).toBe(2);
    expect(memory.stale("live", "runner", 1).flatMap((entry) => entry.sessionId)).toEqual(["b", "c"]);
    memory.prune((instance) => instance === "new", 1);
    expect(memory.size()).toBe(1);
    expect(memory.size("live")).toBe(0);
  });
});
