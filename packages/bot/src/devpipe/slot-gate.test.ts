import { describe, it, expect } from "vitest";
import { SlotGate } from "./slot-gate.js";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("SlotGate", () => {
  it("runs at most `slots` bodies at once and drains the queue in order", async () => {
    const gate = new SlotGate(2);
    const order: string[] = [];
    const holds = [deferred<void>(), deferred<void>(), deferred<void>(), deferred<void>()];
    const runs = holds.map((h, i) => gate.run(async () => { order.push(`start${i}`); await h.promise; order.push(`end${i}`); return i; }));
    await new Promise((r) => setTimeout(r, 5));
    expect(gate.inUse).toBe(2);
    expect(gate.queued).toBe(2);
    expect(order).toEqual(["start0", "start1"]);
    holds[0].resolve();
    await new Promise((r) => setTimeout(r, 5));
    expect(order).toEqual(["start0", "start1", "end0", "start2"]);
    holds[1].resolve();
    holds[2].resolve();
    await new Promise((r) => setTimeout(r, 5));
    expect(order.at(-1)).toBe("start3");
    holds[3].resolve();
    expect(await Promise.all(runs)).toEqual([0, 1, 2, 3]);
    expect(gate.inUse).toBe(0);
    expect(gate.queued).toBe(0);
  });

  it("releases the slot when the body throws", async () => {
    const gate = new SlotGate(1);
    await expect(gate.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(gate.inUse).toBe(0);
    expect(await gate.run(async () => "ok")).toBe("ok");
  });

  it("refuses a zero-slot gate", () => {
    expect(() => new SlotGate(0)).toThrow();
  });
});
