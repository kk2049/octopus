import { afterEach, describe, expect, it, vi } from "vitest";
import { FairWakeLock, type WakeDelivery } from "./wake-lock.js";

afterEach(() => vi.useRealTimers());

describe("FairWakeLock", () => {
  it("restores durable FIFO order and emits an auditable transition stream", () => {
    const woken: number[] = [];
    const events: string[] = [];
    const lock = new FairWakeLock<number, string>({
      leaseMs: 1_000,
      wake: (id) => { woken.push(id); return "delivered"; },
      onEvent: (event) => events.push(event.type),
    });

    lock.restoreWaiters([7, 8]);
    expect(woken).toEqual([7]);
    expect(lock.waiterIds()).toEqual([7, 8]);
    expect(events).toEqual(["queued", "queued", "restored", "wake_selected", "wake_delivered"]);
    expect(lock.acquire(7, "restored-7")).toEqual({ acquired: true, fresh: true });
    lock.release("restored-7");
    expect(woken).toEqual([7, 8]);
    expect(events).toContain("released");
    lock.close();
  });

  it("offers waiters one at a time in arrival order", () => {
    const woken: number[] = [];
    const lock = new FairWakeLock<number, string>({
      leaseMs: 1_000,
      wake: (id) => { woken.push(id); return "delivered"; },
    });

    expect(lock.acquire(1, "a")).toEqual({ acquired: true, fresh: true });
    expect(lock.acquire(2, "b")).toMatchObject({ acquired: false, blockedBy: 1, position: 1 });
    expect(lock.acquire(3, "c")).toMatchObject({ acquired: false, blockedBy: 1, position: 2 });
    expect(lock.waiterIds()).toEqual([2, 3]);

    expect(lock.release("a")).toBe(1);
    expect(woken).toEqual([2]);
    expect(lock.reservedFor).toBe(2);
    expect(lock.waiterIds()).toEqual([2, 3]);
    expect(lock.acquire(3, "c")).toMatchObject({
      acquired: false,
      blockedBy: 2,
      blockedByState: "reservation",
      position: 2,
    });

    expect(lock.acquire(2, "b")).toEqual({ acquired: true, fresh: true });
    expect(lock.release("b")).toBe(2);
    expect(woken).toEqual([2, 3]);
    expect(lock.acquire(3, "c")).toEqual({ acquired: true, fresh: true });
    lock.close();
  });

  it("rotates a failed delivery behind other waiters instead of blocking them", () => {
    const attempts: number[] = [];
    let first = true;
    const lock = new FairWakeLock<number, string>({
      leaseMs: 1_000,
      wake: (id) => {
        attempts.push(id);
        if (id === 2 && first) { first = false; throw new Error("inbox unavailable"); }
        return "delivered";
      },
    });

    lock.acquire(1, "a");
    lock.acquire(2, "b");
    lock.acquire(3, "c");
    lock.release("a");
    expect(attempts).toEqual([2, 3]);
    expect(lock.waiterIds()).toEqual([3, 2]);

    lock.acquire(3, "c");
    lock.release("c");
    expect(attempts).toEqual([2, 3, 2]);
    expect(lock.reservedFor).toBe(2);
    lock.close();
  });

  it("backs off when every delivery fails and retries without a hot loop", () => {
    vi.useFakeTimers();
    const outcomes: WakeDelivery[] = ["retry", "delivered"];
    const wake = vi.fn(() => outcomes.shift() ?? "delivered");
    const lock = new FairWakeLock<number, string>({ leaseMs: 1_000, retryMs: 50, wake });

    lock.acquire(1, "a");
    lock.acquire(2, "b");
    lock.release("a");
    expect(wake).toHaveBeenCalledTimes(1);
    expect(lock.reservedFor).toBeNull();
    expect(lock.waiterIds()).toEqual([2]);

    vi.advanceTimersByTime(49);
    expect(wake).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(wake).toHaveBeenCalledTimes(2);
    expect(lock.reservedFor).toBe(2);
    lock.close();
  });

  it("expires an unclaimed wake, advances, and fences the stale waiter to the tail", () => {
    vi.useFakeTimers();
    const woken: number[] = [];
    const expired: number[] = [];
    const lock = new FairWakeLock<number, string>({
      leaseMs: 100,
      wake: (id) => { woken.push(id); return "delivered"; },
      onLeaseExpired: (id) => expired.push(id),
    });

    lock.acquire(1, "a");
    lock.acquire(2, "b");
    lock.acquire(3, "c");
    lock.release("a");
    vi.advanceTimersByTime(100);
    expect(expired).toEqual([2]);
    expect(woken).toEqual([2, 3]);
    expect(lock.reservedFor).toBe(3);

    expect(lock.acquire(2, "late-b")).toMatchObject({ acquired: false, blockedBy: 3, position: 2 });
    expect(lock.waiterIds()).toEqual([3, 2]);
    expect(lock.acquire(3, "c")).toEqual({ acquired: true, fresh: true });
    lock.release("c");
    expect(woken).toEqual([2, 3, 2]);
    lock.close();
  });

  it("skips dropped and cancelled waiters and ignores stale releases", () => {
    const woken: number[] = [];
    const lock = new FairWakeLock<number, string>({
      leaseMs: 1_000,
      wake: (id) => { woken.push(id); return id === 2 ? "drop" : "delivered"; },
    });
    lock.acquire(1, "a");
    lock.acquire(2, "b");
    lock.acquire(3, "c");
    expect(lock.release("wrong")).toBeNull();
    expect(lock.holderId).toBe(1);

    lock.release("a");
    expect(woken).toEqual([2, 3]);
    expect(lock.cancel(3)).toEqual({ held: false, reserved: true, queued: false });
    expect(lock.waiterIds()).toEqual([]);
    lock.close();
  });
});
