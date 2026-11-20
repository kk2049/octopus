import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Store } from "../store/store.js";
import { ResourceRecoveryService } from "../resources/recovery.js";
import { ManagedExecutionSupervisor, type ExecutionStep } from "./supervisor.js";

let dir: string;
let store: Store;
let supervisor: ManagedExecutionSupervisor;
let recovery: ResourceRecoveryService;
let now: number;
beforeEach(() => {
  vi.useFakeTimers(); now = Date.parse("2026-09-16T00:00:00.000Z");
  dir = mkdtempSync(join(tmpdir(), "managed-supervisor-"));
  store = new Store(join(dir, "bot.db"));
  recovery = new ResourceRecoveryService(store.resourceWaiters, () => new Date(now));
  supervisor = new ManagedExecutionSupervisor(store.managedExecutions, recovery, () => now);
});
afterEach(async () => { await supervisor.close(); store.close(); vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });
const intent = { id: "one", reference: "domain-one", owner: "alice", source: "session" as const,
  resumeOwner: "runner" as const, desired: "running" as const, observed: "running" as const, dispatch: "sent" as const };

describe("durable managed execution supervisor", () => {
  it("preserves a wait beyond thirty minutes and a Head restart, then only queries the original operation", async () => {
    let online = false;
    const attempts: string[] = [];
    const adapter = { authorized: () => true, reconcile: async (_lease: unknown, action: string): Promise<ExecutionStep> => {
      attempts.push(action);
      return online ? { kind: "completed" } : { kind: "wait", dependency: "runner:alice/laptop", detail: "offline" };
    } };
    supervisor.register("session", adapter);
    supervisor.submit(intent);
    await supervisor.sweep();
    const first = store.managedExecutions.get("alice", "one")!;
    expect(first.observed).toBe("reconnecting");
    supervisor.close();
    now += 31 * 60_000;
    supervisor = new ManagedExecutionSupervisor(store.managedExecutions, recovery, () => now);
    supervisor.register("session", adapter);
    await supervisor.sweep();
    expect(store.managedExecutions.get("alice", "one")).toMatchObject({ observed: "waiting_resource", unavailableSince: first.unavailableSince });
    online = true;
    await recovery.recovered("runner:alice/laptop");
    await supervisor.sweep();
    expect(store.managedExecutions.get("alice", "one")?.observed).toBe("completed");
    expect(attempts).toEqual(["query_original", "query_original", "query_original"]);
    expect(recovery.pending("managed-execution/one")).toEqual([]);
    expect(store.managedExecutions.get("bob", "one")).toBeUndefined();
  });

  it("checks cancellation again before a delayed preparation can cross the effect boundary", async () => {
    let unblock!: () => void;
    const block = new Promise<void>(resolve => { unblock = resolve; });
    const effect = vi.fn();
    supervisor.register("session", { authorized: () => true, reconcile: async lease => {
      await block;
      lease.checkpoint({ stage: "tool" }, "uncertain");
      effect();
      return { kind: "completed" };
    } });
    supervisor.submit({ ...intent, resumeOwner: "head", dispatch: "not_sent" });
    const turn = supervisor.sweep();
    await Promise.resolve();
    expect(supervisor.setDesired("bob", "one", "cancelled")).toBe(false);
    expect(supervisor.setDesired("alice", "one", "cancelled")).toBe(true);
    unblock(); await turn;
    expect(effect).not.toHaveBeenCalled();
    expect(store.managedExecutions.get("alice", "one")?.desired).toBe("cancelled");
  });

  it("does not run a revoked adapter or overwrite a foreign execution identity", async () => {
    const execute = vi.fn();
    supervisor.register("session", { authorized: () => false, reconcile: execute });
    supervisor.submit(intent);
    expect(() => supervisor.submit({ ...intent, owner: "bob" })).toThrow("identity collision");
    await supervisor.sweep();
    expect(execute).not.toHaveBeenCalled();
    expect(store.managedExecutions.get("alice", "one")).toMatchObject({ observed: "failed", failure: "authorization_revoked" });
  });
  it("honours a configured concurrency above the old hidden ceiling of eight", async () => {
    let running = 0, peak = 0, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    supervisor.register("session", { authorized: () => true, maxConcurrent: 10, reconcile: async (): Promise<ExecutionStep> => {
      running++; peak = Math.max(peak, running);
      await gate; running--;
      return { kind: "completed" };
    } });
    for (let index = 0; index < 12; index++) supervisor.submit({ ...intent, id: `job-${index}`, reference: `domain-${index}` });
    const sweep = supervisor.sweep();
    await vi.waitFor(() => expect(peak).toBe(10));
    release(); await sweep;
  });

  it("aborts an active request when paused and still schedules another source during slow work", async () => {
    let started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    let aborted = false;
    supervisor.register("session", { authorized: () => true, reconcile: async lease => {
      started();
      await new Promise<void>(resolve => lease.signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
      lease.assertCurrent();
      return { kind: "completed" };
    } });
    supervisor.submit(intent);
    const slow = supervisor.sweep();
    await began;
    const second = vi.fn(async (): Promise<ExecutionStep> => ({ kind: "completed" }));
    supervisor.register("knowledge-chat", { authorized: () => true, reconcile: second });
    supervisor.submit({ ...intent, id: "two", source: "knowledge-chat", resumeOwner: "head", dispatch: "not_sent" });
    await supervisor.sweep();
    expect(second).toHaveBeenCalledOnce();
    supervisor.setDesired("alice", "one", "paused");
    await slow;
    expect(aborted).toBe(true);
    expect(store.managedExecutions.get("alice", "one")?.desired).toBe("paused");
  });

  it("surfaces a broken authority lookup once and never retries it as transport loss", async () => {
    const execute = vi.fn();
    const authorized = vi.fn(() => { throw new Error("invalid grant registry"); });
    supervisor.register("session", { authorized, reconcile: execute });
    supervisor.submit(intent);
    await supervisor.sweep();
    now += 60_000;
    await supervisor.sweep();
    expect(authorized).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(store.managedExecutions.get("alice", "one")).toMatchObject({ observed: "unknown", failure: "internal" });
  });

  it("starts a fresh grace period only after positive recovery and drops settled private history", async () => {
    let progress = false;
    supervisor.register("session", { authorized: () => true, reconcile: async lease => {
      if (progress) {
        lease.dependencyAvailable();
        lease.checkpoint({ privateHistory: "sensitive test" }, "not_sent");
      }
      return { kind: "wait", dependency: "runner:alice/laptop", detail: "offline" };
    } });
    supervisor.submit(intent);
    await supervisor.sweep();
    const first = store.managedExecutions.get("alice", "one")!.unavailableSince;
    now += 70_000;
    await supervisor.sweep();
    expect(store.managedExecutions.get("alice", "one")!.unavailableSince).toBe(first);
    progress = true; now += 40_000;
    await supervisor.sweep();
    expect(store.managedExecutions.get("alice", "one")).toMatchObject({ observed: "reconnecting", unavailableSince: new Date(now).toISOString() });
    await supervisor.close();
    supervisor = new ManagedExecutionSupervisor(store.managedExecutions, recovery, () => now);
    supervisor.register("session", { authorized: () => true, reconcile: async () => ({ kind: "completed" }) });
    now += 40_000; await supervisor.sweep();
    expect(store.managedExecutions.get("alice", "one")!.checkpoint).toBeUndefined();
    expect(store.managedExecutions.get("alice", "one")!.observed).toBe("completed");
  });

});
