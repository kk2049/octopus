import { describe, expect, it } from "vitest";
import {
  memoryResourceStreamSource,
  type ResourceStreamPull,
  type ResourceStreamSource,
} from "@claude-bot/resource-stream-contract";
import { ResourceStreamBroker } from "./broker.js";

function chunk(text: string): ResourceStreamPull<string> {
  return { kind: "chunk", value: text, bytes: text.length };
}

/** A source that records its release and can be held open on demand. */
function blockingSource(): ResourceStreamSource<string> & { closes: number; release: () => void } {
  let unblock: (() => void) | null = null;
  const state = {
    closes: 0,
    metadata: { payload: "test/v1#chunk", mediaType: "text/plain" },
    async pull(): Promise<ResourceStreamPull<string>> {
      await new Promise<void>((resolve) => { unblock = resolve; });
      return chunk("late");
    },
    close(): void {
      state.closes += 1;
    },
    release(): void {
      unblock?.();
    },
  };
  return state;
}

describe("ResourceStreamBroker", () => {
  it("mints an unguessable handle and serves chunks in order", async () => {
    const broker = new ResourceStreamBroker();
    const source = memoryResourceStreamSource([chunk("a"), chunk("b"), { kind: "end" }]);
    const opened = broker.open("scope-1", source);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    expect(opened.handle).toMatch(/^rs_[A-Za-z0-9_-]{32}$/);
    expect(await broker.pull("scope-1", opened.handle, 0)).toEqual({ kind: "chunk", seq: 0, value: "a" });
    expect(await broker.pull("scope-1", opened.handle, 1)).toEqual({ kind: "chunk", seq: 1, value: "b" });
    expect(await broker.pull("scope-1", opened.handle, 2)).toEqual({ kind: "end", chunks: 2, bytes: 2 });
    // The terminal released the entry, so the handle is gone.
    expect(broker.openStreams()).toBe(0);
    expect(source.closes).toBe(1);
  });

  it("refuses a handle presented by another scope, with no hint that it exists", async () => {
    const broker = new ResourceStreamBroker();
    const source = memoryResourceStreamSource([chunk("secret")]);
    const opened = broker.open("scope-1", source);
    if (!opened.ok) return;

    expect(await broker.pull("scope-2", opened.handle, 0)).toMatchObject({ kind: "refused", code: "expired" });
    expect(await broker.pull("scope-2", "rs_totallyMadeUpHandleValue000000", 0))
      .toMatchObject({ kind: "refused", code: "expired" });
    expect(source.pulls).toBe(0);
    expect(await broker.close("scope-2", opened.handle)).toBe(false);
    expect(broker.openStreams("scope-1")).toBe(1);
  });

  it("closes the stream when a transport asks for the wrong sequence", async () => {
    const broker = new ResourceStreamBroker();
    const source = memoryResourceStreamSource([chunk("a"), chunk("b")]);
    const opened = broker.open("scope-1", source);
    if (!opened.ok) return;

    expect(await broker.pull("scope-1", opened.handle, 0)).toMatchObject({ kind: "chunk", seq: 0 });
    expect(await broker.pull("scope-1", opened.handle, 0)).toMatchObject({ kind: "refused", code: "protocol" });
    expect(broker.openStreams()).toBe(0);
    expect(source.closes).toBe(1);
  });

  it("passes a provider refusal through as the terminal and stops pulling", async () => {
    const broker = new ResourceStreamBroker();
    const source = memoryResourceStreamSource<string>([
      { kind: "refused", code: "unavailable", message: "设备掉线了" },
      chunk("never"),
    ]);
    const opened = broker.open("scope-1", source);
    if (!opened.ok) return;

    expect(await broker.pull("scope-1", opened.handle, 0)).toMatchObject({ kind: "refused", code: "unavailable" });
    expect(source.pulls).toBe(1);
    expect(broker.openStreams()).toBe(0);
  });

  it("applies its own caps to every stream it opens", async () => {
    const broker = new ResourceStreamBroker({ caps: { maxStreamBytes: 3 } });
    const opened = broker.open("scope-1", memoryResourceStreamSource([chunk("aa"), chunk("bb")]));
    if (!opened.ok) return;

    expect(await broker.pull("scope-1", opened.handle, 0)).toMatchObject({ kind: "chunk", seq: 0 });
    expect(await broker.pull("scope-1", opened.handle, 1)).toMatchObject({ kind: "refused", code: "too_large" });
  });

  it("does not let one open widen a narrower broker-level cap", async () => {
    const broker = new ResourceStreamBroker({ caps: { maxStreamBytes: 3 } });
    const opened = broker.open(
      "scope-1",
      memoryResourceStreamSource([chunk("aa"), chunk("bb")]),
      { maxStreamBytes: 100 },
    );
    if (!opened.ok) return;

    expect(await opened.stream.next()).toMatchObject({ kind: "chunk", seq: 0 });
    expect(await opened.stream.next()).toMatchObject({ kind: "refused", code: "too_large" });
  });

  it("bounds how many streams one scope may hold open at once", () => {
    const broker = new ResourceStreamBroker({ maxStreamsPerScope: 2 });
    expect(broker.open("scope-1", memoryResourceStreamSource([])).ok).toBe(true);
    expect(broker.open("scope-1", memoryResourceStreamSource([])).ok).toBe(true);
    expect(broker.open("scope-1", memoryResourceStreamSource([]))).toEqual({ ok: false, code: "too_many_streams" });
    // A different scope is unaffected: the ceiling is per scope, not global.
    expect(broker.open("scope-2", memoryResourceStreamSource([])).ok).toBe(true);
  });

  it("closeScope cancels everything that scope holds, including a read in flight", async () => {
    const broker = new ResourceStreamBroker();
    const held = blockingSource();
    const idle = memoryResourceStreamSource([chunk("a")]);
    const other = memoryResourceStreamSource([chunk("a")]);
    const a = broker.open("scope-1", held);
    const b = broker.open("scope-1", idle);
    const c = broker.open("scope-2", other);
    if (!a.ok || !b.ok || !c.ok) return;

    const inFlight = broker.pull("scope-1", a.handle, 0);
    expect(await broker.closeScope("scope-1")).toBe(2);
    held.release();

    expect(await inFlight).toMatchObject({ kind: "refused", code: "closed" });
    expect(held.closes).toBe(1);
    expect(idle.closes).toBe(1);
    expect(broker.openStreams("scope-1")).toBe(0);

    // Every later use of a handle from the closed scope is refused...
    expect(await broker.pull("scope-1", a.handle, 0)).toMatchObject({ kind: "refused", code: "expired" });
    // ...and the other scope kept working throughout.
    expect(await broker.pull("scope-2", c.handle, 0)).toMatchObject({ kind: "chunk", seq: 0 });
    expect(await broker.closeScope("scope-1")).toBe(0);
  });

  it("close() is idempotent and releases the source exactly once", async () => {
    const broker = new ResourceStreamBroker();
    const source = memoryResourceStreamSource([chunk("a")]);
    const opened = broker.open("scope-1", source);
    if (!opened.ok) return;

    expect(await broker.close("scope-1", opened.handle)).toBe(true);
    expect(await broker.close("scope-1", opened.handle)).toBe(false);
    expect(source.closes).toBe(1);
    expect(await broker.pull("scope-1", opened.handle, 0)).toMatchObject({ kind: "refused", code: "expired" });
  });
});
