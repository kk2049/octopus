import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store/store.js";
import {
  InMemoryResourceWaiterStore,
  ResourceRecoveryService,
  ResourceUnavailableError,
  parseUnavailable,
  runnerResource,
  ticketScope,
  ticketScopeId,
  unavailableMessage,
} from "./recovery.js";

describe("unavailable marker", () => {
  it("round-trips resource and detail through the message text", () => {
    const text = unavailableMessage("runner:alice/laptop", "设备 laptop 不在线或不属于你。当前在线: (无)");
    expect(parseUnavailable(text)).toEqual({
      resource: "runner:alice/laptop",
      detail: "设备 laptop 不在线或不属于你。当前在线: (无)。已登记等待,资源恢复时会通知本会话;可以先做不依赖它的工作,不要反复重试。",
    });
    expect(parseUnavailable("ordinary failure")).toBeNull();
    expect(parseUnavailable(null)).toBeNull();
  });

  it("ResourceUnavailableError carries the code, the resource and the marker", () => {
    const err = new ResourceUnavailableError(runnerResource("alice", "laptop"), "offline");
    expect(err.code).toBe("resource_unavailable");
    expect(err.resource).toBe("runner:alice/laptop");
    expect(parseUnavailable(err.message)?.resource).toBe("runner:alice/laptop");
  });

  it("ticket scopes are spelled once", () => {
    expect(ticketScope(296)).toBe("dev-ticket/296");
    expect(ticketScopeId("dev-ticket/296")).toBe(296);
    expect(ticketScopeId("chat-feishu/lht")).toBeNull();
  });
});

describe("ResourceRecoveryService", () => {
  it("records one waiter per (scope, resource), counts repeats, and notifies the longest-prefix scope on recovery", async () => {
    let t = 0;
    const svc = new ResourceRecoveryService(new InMemoryResourceWaiterStore(), () => new Date(1_000 + t++ * 1_000));
    const ticketSeen: string[] = [];
    const chatSeen: string[] = [];
    svc.registerScope("dev-ticket/", (w) => { ticketSeen.push(`${w.scope}:${w.count}`); return true; });
    svc.registerScope("chat-feishu/", (w) => { chatSeen.push(w.scope); return true; });

    svc.note("dev-ticket/296", "runner:lht/ci", "offline #1");
    svc.note("dev-ticket/296", "runner:lht/ci", "offline #2");
    svc.note("dev-ticket/299", "runner:lht/ci", "offline");
    svc.note("chat-feishu/lht", "runner:lht/ci", "offline");
    svc.note("dev-ticket/296", "runner:lht/laptop", "offline");
    expect(svc.pending("dev-ticket/296")).toHaveLength(2);

    const result = await svc.recovered("runner:lht/ci");
    expect(result).toEqual({ notified: 3, kept: 0 });
    expect(ticketSeen).toEqual(["dev-ticket/296:2", "dev-ticket/299:1"]);
    expect(chatSeen).toEqual(["chat-feishu/lht"]);
    // The other resource is still awaited; the recovered one is gone.
    expect(svc.pending("dev-ticket/296").map((w) => w.resource)).toEqual(["runner:lht/laptop"]);
    expect(await svc.recovered("runner:lht/ci")).toEqual({ notified: 0, kept: 0 });
  });

  it("keeps a waiter whose notifier fails or is missing, and forgets a scope on demand", async () => {
    const svc = new ResourceRecoveryService(new InMemoryResourceWaiterStore());
    let attempts = 0;
    svc.registerScope("dev-ticket/", () => { attempts++; return attempts > 1; });
    svc.note("dev-ticket/1", "runner:a/b", "offline");
    svc.note("hq/alice", "runner:a/b", "offline");
    expect(await svc.recovered("runner:a/b")).toEqual({ notified: 0, kept: 2 });
    expect(await svc.recovered("runner:a/b")).toEqual({ notified: 1, kept: 1 });
    expect(svc.pending("hq/alice")).toHaveLength(1);
    expect(svc.forget("hq/alice")).toBe(1);
    expect(svc.pending("hq/alice")).toHaveLength(0);
  });

  it("ignores empty scopes", () => {
    const store = new InMemoryResourceWaiterStore();
    const svc = new ResourceRecoveryService(store);
    svc.note("", "runner:a/b", "x");
    expect(store.take("runner:a/b")).toHaveLength(0);
  });
});

describe("ResourceWaitersRepository (sqlite)", () => {
  let dir: string;
  let store: Store;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "waiters-"));
    store = new Store(join(dir, "t.db"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists waiters across service instances and takes them atomically", async () => {
    const first = new ResourceRecoveryService(store.resourceWaiters, () => new Date("2026-08-22T03:00:00Z"));
    first.note("dev-ticket/296", "runner:lht/lht-val15-ci", "设备离线");
    first.note("dev-ticket/296", "runner:lht/lht-val15-ci", "设备仍离线");
    // "Restart": a new service over the same database sees the promise.
    const second = new ResourceRecoveryService(store.resourceWaiters);
    const seen: Array<{ scope: string; count: number; detail: string }> = [];
    second.registerScope("dev-ticket/", (w) => { seen.push({ scope: w.scope, count: w.count, detail: w.detail }); return true; });
    expect(await second.recovered("runner:lht/lht-val15-ci")).toEqual({ notified: 1, kept: 0 });
    expect(seen).toEqual([{ scope: "dev-ticket/296", count: 2, detail: "设备仍离线" }]);
    expect(store.resourceWaiters.listByScope("dev-ticket/296")).toHaveLength(0);
  });
  it("retains a waiter during async delivery and does not acknowledge a newer failure", async () => {
    const svc = new ResourceRecoveryService(store.resourceWaiters);
    let finish!: (ok: boolean) => void;
    let calls = 0;
    svc.registerScope("test/", () => { calls++; return new Promise<boolean>((resolve) => { finish = resolve; }); });
    svc.note("test/1", "runner:a/b", "first");
    const one = svc.recovered("runner:a/b");
    const duplicate = svc.recovered("runner:a/b");
    expect(store.resourceWaiters.listByScope("test/1")).toHaveLength(1);
    svc.note("test/1", "runner:a/b", "new outage during notification");
    finish(true); await Promise.all([one, duplicate]);
    expect(calls).toBe(1);
    expect(store.resourceWaiters.listByScope("test/1")[0]?.count).toBe(2);
  });

});
