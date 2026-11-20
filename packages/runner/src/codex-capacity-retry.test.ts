import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerTurnResult } from "./codex-app-server.js";
import { CODEX_CAPACITY_DELAYS_MS, CodexCapacityRetry, isCodexCapacityFailure, parseCapacityCheckpoint, type CodexCapacityCheckpoint } from "./codex-capacity-retry.js";

const failed: CodexAppServerTurnResult = { started: true, ok: false, status: "failed",
  error: "Selected model is at capacity. Please try a different model.",
  providerError: { code: "serverOverloaded", message: "overloaded", threadId: "one", turnId: "first", willRetry: false } };
const done: CodexAppServerTurnResult = { started: true, ok: true, status: "completed" };
afterEach(() => vi.useRealTimers());

function fixture(results: CodexAppServerTurnResult[] = [done], restored?: CodexCapacityCheckpoint) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-24T12:00:00Z"));
  const writes: CodexCapacityCheckpoint[] = [];
  const dispatch = vi.fn(async () => ({ kind: "started" as const, turnId: `retry-${writes.length}`,
    completion: Promise.resolve(results.shift() ?? failed) }));
  const persist = vi.fn(async (state: CodexCapacityCheckpoint) => { writes.push({ ...state }); return true; });
  const changed = vi.fn();
  const retry = new CodexCapacityRetry({ dispatch, persist, changed, restored });
  return { retry, dispatch, persist, changed, writes };
}

describe("Runner-owned Codex capacity recovery", () => {
  it.each(["unauthorized", "usageLimitExceeded", "rateLimitExceeded", "unknown"])("does not retry %s even if prose mentions capacity", code => {
    expect(isCodexCapacityFailure({ ...failed, providerError: { ...failed.providerError!, code } })).toBe(false);
  });
  it("requires a failed terminal turn and yields to native willRetry", () => {
    expect(isCodexCapacityFailure({ ...failed, status: undefined })).toBe(false);
    expect(isCodexCapacityFailure({ ...failed, status: "interrupted" })).toBe(false);
    expect(isCodexCapacityFailure({ ...failed, providerError: { ...failed.providerError!, willRetry: true } })).toBe(false);
    expect(isCodexCapacityFailure({ ...failed, providerError: undefined })).toBe(true);
    expect(isCodexCapacityFailure({ ...failed, providerError: undefined, error: "out of disk capacity" })).toBe(false);
  });
  it("keeps one logical completion pending and charges before the single continuation", async () => {
    const f = fixture();
    const settled = vi.fn();
    const completion = f.retry.run(Promise.resolve(failed)).then(settled);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.retry.waiting).toBe(true);
    expect(f.writes).toEqual([expect.objectContaining({ phase: "waiting", attempts: 0, nextRetryAt: "2026-09-24T12:00:30.000Z" })]);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await completion;
    expect(f.writes.map(row => [row.phase, row.attempts])).toEqual([["waiting", 0], ["dispatching", 1], ["active", 1]]);
    expect(f.dispatch).toHaveBeenCalledOnce();
    expect(settled).toHaveBeenCalledWith(done);
  });
  it("exhausts six backoffs without extending the fixed deadline", async () => {
    const f = fixture([]);
    const completion = f.retry.run(Promise.resolve(failed));
    for (const delay of CODEX_CAPACITY_DELAYS_MS) await vi.advanceTimersByTimeAsync(delay);
    expect(await completion).toMatchObject({ ok: false, error: expect.stringContaining("6/6") });
    expect(f.dispatch).toHaveBeenCalledTimes(6);
    expect(new Set(f.writes.map(row => row.deadlineAt))).toEqual(new Set(["2026-09-24T12:30:00.000Z"]));
  });
  it("cancels pending timers without dispatch or resurrection", async () => {
    const f = fixture();
    const completion = f.retry.run(Promise.resolve(failed));
    await vi.advanceTimersByTimeAsync(0);
    f.retry.cancel();
    await expect(completion).resolves.toMatchObject({ status: "interrupted" });
    await vi.advanceTimersByTimeAsync(1_800_000);
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("honors cancellation while a durable barrier is pending", async () => {
    const f = fixture();
    let release!: (value: boolean) => void;
    f.persist.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const completion = f.retry.run(Promise.resolve(failed));
    await vi.advanceTimersByTimeAsync(0);
    f.retry.cancel(); release(true);
    await completion;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it("never repeats an ambiguous continuation", async () => {
    const f = fixture();
    f.dispatch.mockRejectedValue(new Error("turn/start timeout"));
    const completion = f.retry.run(Promise.resolve(failed));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await completion).toMatchObject({ ok: false, error: expect.stringContaining("无法确认") });
    expect(f.writes.at(-1)).toMatchObject({ phase: "dispatching", attempts: 1 });
    await vi.advanceTimersByTimeAsync(1_800_000);
    expect(f.dispatch).toHaveBeenCalledOnce();
  });
  it("does not dispatch when persistence fails or Stop has removed the row", async () => {
    for (const reject of [false, true]) {
      const f = fixture();
      if (reject) f.persist.mockRejectedValue(new Error("disk full"));
      else f.persist.mockResolvedValue(false);
      const completion = f.retry.run(Promise.resolve(failed));
      await vi.advanceTimersByTimeAsync(30_000);
      expect((await completion).ok).toBe(false);
      expect(f.dispatch).not.toHaveBeenCalled();
    }
  });
  it("carries the restart budget forward and rejects malformed checkpoints", async () => {
    const restored: CodexCapacityCheckpoint = { attempts: 6, phase: "active",
      firstFailureAt: "2026-09-24T11:55:00Z", deadlineAt: "2026-09-24T12:25:00Z" };
    const f = fixture([], restored);
    expect(await f.retry.run(Promise.resolve(failed))).toMatchObject({ ok: false, error: expect.stringContaining("6/6") });
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(parseCapacityCheckpoint(restored)).toEqual(restored);
    expect(() => parseCapacityCheckpoint({ ...restored, attempts: 7 })).toThrow();
    expect(() => parseCapacityCheckpoint({ ...restored, deadlineAt: "2099-01-01" })).toThrow();
  });
});
