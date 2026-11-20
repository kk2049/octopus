import { describe, expect, it, vi } from "vitest";
import { createAppRuntimeClient, type AppRuntimeReply } from "./runtime.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("direct App runtime", () => {
  it("applies the authoritative reply before settling and drops older SSE/reply frames", async () => {
    const reply = deferred<AppRuntimeReply>();
    const dispatch = vi.fn(() => reply.promise);
    const runtime = createAppRuntimeClient({ projection: { value: 0 }, revision: 0, dispatch });
    const pending = runtime.propose("save", { text: "one" });
    expect(runtime.snapshot().inFlight).toBe(1);
    expect(runtime.snapshot().proposals[0].phase).toBe("inflight");
    await Promise.resolve();
    runtime.update({ value: 2 }, 2);
    reply.resolve({ ok: true, projection: { value: 1 }, revision: 1 });
    await pending;
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(runtime.snapshot().projection).toEqual({ value: 2 });
    expect(runtime.snapshot().inFlight).toBe(0);
    expect(runtime.snapshot().proposals).toEqual([]);
    const snapshot = runtime.snapshot();
    expect(runtime.update({ value: -1 }, 2)).toBe(false);
    expect(runtime.snapshot()).toBe(snapshot);
  });

  it("settles on disposal and ignores late mutation results without replay", async () => {
    const reply = deferred<AppRuntimeReply>();
    const dispatch = vi.fn(() => reply.promise);
    const runtime = createAppRuntimeClient({ projection: { value: 0 }, dispatch });
    const pending = runtime.propose("send");
    await Promise.resolve();
    runtime.close();
    expect((await pending).code).toBe("backend_unavailable");
    reply.resolve({ ok: true, projection: { value: 1 } });
    await Promise.resolve();
    expect(runtime.snapshot().phase).toBe("closed");
    expect(runtime.snapshot().projection).toEqual({ value: 0 });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(await runtime.propose("send")).toMatchObject({ ok: false, code: "channel_closed" });
  });

  it("does not dispatch an action disposed before its dispatch microtask", async () => {
    const dispatch = vi.fn(async () => ({ ok: true }));
    const runtime = createAppRuntimeClient({ projection: {}, dispatch });
    const pending = runtime.propose("send");
    runtime.close();
    await pending;
    await Promise.resolve();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("keeps a bounded refusal with the server sentence and never treats network loss as success", async () => {
    const runtime = createAppRuntimeClient({
      projection: {},
      dispatch: vi.fn().mockResolvedValueOnce({ ok: false, code: "denied", result: { message: "retain this sentence" } })
        .mockRejectedValueOnce(new Error("private network details")),
    });
    expect(await runtime.propose("write")).toMatchObject({ ok: false, message: "retain this sentence" });
    expect(runtime.snapshot().proposals[0].phase).toBe("refused");
    runtime.dismissProposal(runtime.snapshot().proposals[0].rid);
    expect(runtime.snapshot().proposals).toEqual([]);
    expect(await runtime.propose("send")).toMatchObject({ ok: false, code: "backend_unavailable" });
    expect(runtime.snapshot().proposals[0].message).not.toContain("private");
  });

  it("allows late success after unknown but never regresses success", () => {
    const runtime = createAppRuntimeClient({ projection: {}, dispatch: async () => ({ ok: true }) });
    runtime.operation({ id: "one", status: "unknown" });
    runtime.operation({ id: "one", status: "succeeded", newResourceId: "session" });
    const snapshot = runtime.snapshot();
    runtime.operation({ id: "one", status: "running" });
    expect(runtime.snapshot()).toBe(snapshot);
    expect(runtime.snapshot().operations).toEqual([{ id: "one", status: "succeeded", newResourceId: "session" }]);
  });

  it("keeps drafts and recovery out of projection notifications and detaches draft listeners", () => {
    const off = vi.fn();
    const draft = { text: "draft", updatedAt: 1 };
    const drafts = { get: vi.fn(() => draft), set: vi.fn(), subscribe: vi.fn(() => off) };
    const recover = vi.fn();
    const runtime = createAppRuntimeClient({ projection: {}, drafts, onRecovery: recover, dispatch: async () => ({ ok: true }) });
    const listener = vi.fn();
    runtime.subscribe(listener);
    expect(runtime.drafts.get("session")).toBe(draft);
    runtime.drafts.subscribe("session", vi.fn());
    runtime.drafts.set("session", "");
    expect(runtime.publishRecovery("checkpoint")).toBe(true);
    expect(runtime.publishRecovery("checkpoint")).toBe(true);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(listener).not.toHaveBeenCalled();
    runtime.close();
    expect(off).toHaveBeenCalledTimes(1);
    runtime.drafts.set("session", "late");
    expect(drafts.set).toHaveBeenCalledTimes(1);
  });
});
