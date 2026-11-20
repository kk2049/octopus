import { afterEach, describe, expect, it, vi } from "vitest";
import { paceRetention } from "./retention.js";
import { Store } from "./store/store.js";

afterEach(() => { vi.useRealTimers(); });

describe("paced retention", () => {
  it("works off a backlog in separate steps, then waits for the idle interval", async () => {
    vi.useFakeTimers();
    const answers = [true, true, false, true, false];
    const step = vi.fn(() => answers.shift() ?? false);
    const stop = paceRetention("t", step, { firstDelayMs: 1000, pauseMs: 100, idleMs: 60_000, now: () => 0 });
    await vi.advanceTimersByTimeAsync(999);
    expect(step).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1 + 100 + 100);
    expect(step).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(step).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1 + 100);
    expect(step).toHaveBeenCalledTimes(5);
    stop();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(step).toHaveBeenCalledTimes(5);
  });

  it("waits ten times as long as a slow step took, and survives a throwing step", async () => {
    vi.useFakeTimers();
    let clock = 0;
    const calls: number[] = [];
    const step = vi.fn(() => {
      calls.push(Date.now());
      if (calls.length === 2) throw new Error("database is locked");
      clock += 80; // this step took 80 ms
      return true;
    });
    const stop = paceRetention("t", step, { firstDelayMs: 0, pauseMs: 100, idleMs: 5000, now: () => clock });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(799);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2); // threw: back off to the idle interval
    await vi.advanceTimersByTimeAsync(4999);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(3);
    stop();
  });
});

describe("permission activity retention", () => {
  it("deletes only expired records, oldest first, a bounded page at a time", () => {
    const store = new Store(":memory:");
    try {
      const row = (at: string, operation: string) => ({ at, owner: "lht", subject_type: "service", subject_id: "session-hub",
        operation, resource: "", decision: "allow", reason: null, detail: null });
      for (const op of ["a", "b", "c"]) store.recordPermissionAudit(row("2026-08-01T00:00:00.000Z", op));
      store.recordPermissionAudit(row("2026-10-14T00:00:00.000Z", "recent"));
      const before = "2026-09-15T00:00:00.000Z";
      expect(store.prunePermissionAudit(before, 2)).toBe(2);
      expect(store.prunePermissionAudit(before, 2)).toBe(1);
      expect(store.prunePermissionAudit(before, 2)).toBe(0);
      expect(store.listPermissionAudit("lht").map((r) => r.operation)).toEqual(["recent"]);
    } finally {
      store.close();
    }
  });
});
