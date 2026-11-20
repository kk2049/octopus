import { afterEach, expect, it, vi } from "vitest";
import { InMemoryResourceWaiterStore, ResourceRecoveryService } from "./recovery.js";
import { ResourceSuspension } from "./suspension.js";

afterEach(() => vi.useRealTimers());

it("gives a transient outage one minute, retains a visible durable wait, and wakes immediately on presence", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-16T00:00:00Z"));
  const recovery = new ResourceRecoveryService(new InMemoryResourceWaiterStore());
  const scope = "agent/1", resource = "runner:alice/compute";
  const wake = vi.fn();
  const waits = new ResourceSuspension({ recovery, prefix: "agent/", wake });
  waits.suspend(scope, resource, "offline");
  expect(waits.view(scope)?.state).toBe("reconnecting");
  expect(waits.canAttempt(scope)).toBe(false);
  for (let i = 0; i < 11; i++) {
    await vi.advanceTimersByTimeAsync(5_000);
    expect(waits.canAttempt(scope)).toBe(true);
    waits.suspend(scope, resource, "offline");
  }
  expect(waits.view(scope)?.state).toBe("reconnecting");
  await vi.advanceTimersByTimeAsync(5_000);
  waits.suspend(scope, resource, "offline");
  expect(waits.view(scope)?.state).toBe("waiting_resource");
  expect(waits.view(scope)?.since).toBe("2026-09-16T00:00:00.000Z");
  expect(waits.canAttempt(scope)).toBe(false);
  await recovery.recovered(resource);
  expect(waits.canAttempt(scope)).toBe(true);
  expect(wake).toHaveBeenLastCalledWith(scope);
  expect(recovery.pending(scope)).toHaveLength(1);
  waits.clear(scope);
  expect(waits.view(scope)).toBeNull();
  waits.close();
});

it("recovers a wait after restart without requiring another presence edge, and clears timers on cancellation", async () => {
  vi.useFakeTimers();
  const recovery = new ResourceRecoveryService(new InMemoryResourceWaiterStore());
  const oldWake = vi.fn(), newWake = vi.fn();
  const old = new ResourceSuspension({ recovery, prefix: "agent/", wake: oldWake });
  old.suspend("agent/2", "runner:alice/compute", "offline");
  old.close();
  await vi.advanceTimersByTimeAsync(61_000);
  const next = new ResourceSuspension({ recovery, prefix: "agent/", wake: newWake });
  expect(next.view("agent/2")?.state).toBe("waiting_resource");
  expect(next.canAttempt("agent/2")).toBe(true);
  next.suspend("agent/2", "runner:alice/compute", "offline");
  next.clear("agent/2");
  await vi.advanceTimersByTimeAsync(120_000);
  await recovery.recovered("runner:alice/compute");
  expect(oldWake).not.toHaveBeenCalled(); expect(newWake).not.toHaveBeenCalled();
  next.close();
});
