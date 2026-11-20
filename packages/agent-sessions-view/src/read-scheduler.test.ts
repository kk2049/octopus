import { describe, expect, it, vi } from "vitest";
import type { ReadWindowRequest, SessionsPort, SessionsReply } from "@claude-bot/agent-sessions-contract";
import { createSessionReadScheduler } from "./read-scheduler.js";

const OK: SessionsReply = { ok: true, message: "" };
function deferred() {
  let resolve!: (reply: SessionsReply) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<SessionsReply>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
function fixture() {
  const reads: Array<ReturnType<typeof deferred> & { resource: string }> = [];
  const workspaces: Array<ReturnType<typeof deferred> & { device: string }> = [];
  const port = {
    snapshot: () => ({ projection: { transcript: { a: { messages: [] } } } }),
    readWindow: vi.fn((request: ReadWindowRequest) => { const item = { ...deferred(), resource: request.resource }; reads.push(item); return item.promise; }),
    listWorkspaces: vi.fn((device: string) => { const item = { ...deferred(), device }; workspaces.push(item); return item.promise; }),
    closeSession: vi.fn(async () => OK),
  } as unknown as SessionsPort;
  const observer = { busy: vi.fn(), read: vi.fn() };
  const scheduler = createSessionReadScheduler(port, observer);
  return { scheduler, port, observer, reads, workspaces };
}

describe("per-port session read ownership", () => {
  it("runs two different resources concurrently, deduplicates identical windows and serializes one resource", async () => {
    const f = fixture();
    f.scheduler.read("a", 200);
    f.scheduler.read("a", 200);
    f.scheduler.read("a", 100, 0);
    f.scheduler.read("b", 200);
    f.scheduler.read("c", 200);
    expect(f.reads.map((row) => row.resource)).toEqual(["a", "b"]);
    f.reads[1].resolve(OK);
    await flush();
    expect(f.reads.map((row) => row.resource)).toEqual(["a", "b", "c"]);
    f.reads[0].resolve(OK);
    await flush();
    expect(f.reads.map((row) => row.resource)).toEqual(["a", "b", "c", "a"]);
  });

  it("releases a failed workspace call and advances the next device without retry", async () => {
    const f = fixture();
    for (const device of ["slow", "broken", "ready"]) f.scheduler.workspace(device, false);
    expect(f.workspaces.map((row) => row.device)).toEqual(["slow", "broken"]);
    f.workspaces[1].reject(new Error("provider bug"));
    await flush();
    expect(f.workspaces.map((row) => row.device)).toEqual(["slow", "broken", "ready"]);
    f.scheduler.workspace("broken", false);
    expect(f.workspaces).toHaveLength(3);
  });

  it("never lets an old port result pump queued work or change the new port busy state", async () => {
    const old = fixture();
    for (const resource of ["a", "b", "old-queued"]) old.scheduler.read(resource, 200);
    old.scheduler.destroy();
    const next = fixture();
    next.scheduler.read("new", 200);
    old.reads[0].resolve(OK);
    old.reads[1].resolve(OK);
    await flush();
    expect(old.reads).toHaveLength(2);
    expect(old.observer.read).not.toHaveBeenCalled();
    expect(next.reads.map((row) => row.resource)).toEqual(["new"]);
    expect(next.observer.busy).toHaveBeenLastCalledWith(["new"]);
  });

  it("restores a cached resource lease, closes only after its last panel and reopens explicitly", async () => {
    const f = fixture();
    const one = f.scheduler.retain("a");
    const two = f.scheduler.retain("a");
    expect(f.reads).toHaveLength(1);
    f.reads[0].resolve(OK);
    await flush();
    one();
    await flush();
    expect(f.port.closeSession).not.toHaveBeenCalled();
    two();
    await flush();
    expect(f.port.closeSession).toHaveBeenCalledExactlyOnceWith("a");
    f.scheduler.retain("a");
    expect(f.reads).toHaveLength(2);
  });

  it("waits for a pending read before closing its lease so a late open cannot resurrect it", async () => {
    const f = fixture();
    const release = f.scheduler.retain("a");
    release();
    await flush();
    expect(f.port.closeSession).not.toHaveBeenCalled();
    f.reads[0].resolve(OK);
    await flush();
    expect(f.port.closeSession).toHaveBeenCalledExactlyOnceWith("a");
    expect(f.observer.read).not.toHaveBeenCalled();
  });

  it("preserves a lease across immediate effect replay and then destroys it once", async () => {
    const f = fixture();
    const release = f.scheduler.retain("a");
    f.scheduler.pause();
    release();
    f.scheduler.activate();
    f.scheduler.retain("a");
    await flush();
    expect(f.port.closeSession).not.toHaveBeenCalled();
    f.reads[0].resolve(OK);
    await flush();
    f.scheduler.destroy();
    await flush();
    expect(f.port.closeSession).toHaveBeenCalledExactlyOnceWith("a");
  });
});
