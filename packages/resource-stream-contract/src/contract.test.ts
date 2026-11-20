import { describe, expect, it } from "vitest";
import {
  RESOURCE_STREAM_CONTRACT,
  RESOURCE_STREAM_LIMITS,
  createResourceStream,
  drainResourceStream,
  memoryResourceStreamSource,
  readResourceStreamMetadata,
  readResourceStreamRequest,
  readResourceStreamResponse,
  type ResourceStreamPull,
} from "./index.js";

function chunk(text: string): ResourceStreamPull<string> {
  return { kind: "chunk", value: text, bytes: text.length };
}

describe("resource-stream/v1 semantics", () => {
  it("numbers chunks from zero and ends once with the totals", async () => {
    const source = memoryResourceStreamSource([chunk("ab"), chunk("cde"), { kind: "end" }]);
    const stream = createResourceStream(source);
    const drained = await drainResourceStream(stream);

    expect(drained.chunks).toEqual(["ab", "cde"]);
    expect(drained.seqs).toEqual([0, 1]);
    expect(drained.terminal).toEqual({ kind: "end", chunks: 2, bytes: 5 });
    expect(stream.contract).toBe(RESOURCE_STREAM_CONTRACT);
  });

  it("delivers exactly one terminal and never pulls the source again", async () => {
    const source = memoryResourceStreamSource([chunk("a"), { kind: "end" }]);
    const stream = createResourceStream(source);
    await drainResourceStream(stream);
    const pullsAtEnd = source.pulls;

    const after = await stream.next();
    expect(after).toEqual({ kind: "refused", code: "closed", message: expect.any(String) });
    expect(source.pulls).toBe(pullsAtEnd);
    // The end released the file handle; closing again must not release twice.
    await stream.close();
    expect(source.closes).toBe(1);
  });

  it("refuses a second concurrent next() instead of queueing it", async () => {
    let release!: (value: ResourceStreamPull<string>) => void;
    const source = {
      metadata: { payload: "test/v1#chunk", mediaType: "text/plain" },
      pull: () => new Promise<ResourceStreamPull<string>>((resolve) => { release = resolve; }),
      close: () => {},
    };
    const stream = createResourceStream(source);

    const first = stream.next();
    const second = await stream.next();
    expect(second).toMatchObject({ kind: "refused", code: "protocol" });

    // The in-flight read must not deliver the chunk that was already on its way.
    release(chunk("late"));
    expect(await first).toMatchObject({ kind: "refused", code: "protocol" });
  });

  it("fails closed on the per-chunk, per-stream and chunk-count caps", async () => {
    const tooBig = createResourceStream(
      memoryResourceStreamSource([{ kind: "chunk", value: "x", bytes: 4 }]),
      { maxChunkBytes: 3 },
    );
    expect(await tooBig.next()).toMatchObject({ kind: "refused", code: "too_large" });

    const overTotal = createResourceStream(
      memoryResourceStreamSource([chunk("aaa"), chunk("bbb")]),
      { maxStreamBytes: 5 },
    );
    expect(await overTotal.next()).toMatchObject({ kind: "chunk", seq: 0 });
    expect(await overTotal.next()).toMatchObject({ kind: "refused", code: "too_large" });

    const overCount = createResourceStream(
      memoryResourceStreamSource([chunk("a"), chunk("b")]),
      { maxChunks: 1 },
    );
    expect(await overCount.next()).toMatchObject({ kind: "chunk", seq: 0 });
    expect(await overCount.next()).toMatchObject({ kind: "refused", code: "too_large" });
  });

  it("a caller may narrow the caps but never widen them", async () => {
    const huge = RESOURCE_STREAM_LIMITS.maxChunkBytes + 1;
    const stream = createResourceStream(
      memoryResourceStreamSource([{ kind: "chunk", value: "x", bytes: huge }]),
      { maxChunkBytes: huge * 2 },
    );
    expect(await stream.next()).toMatchObject({ kind: "refused", code: "too_large" });
  });

  it("turns a producer exception into `unavailable` without echoing its text", async () => {
    const source = {
      metadata: { payload: "test/v1#chunk", mediaType: "text/plain" },
      pull: async (): Promise<ResourceStreamPull<string>> => {
        throw new Error("ENOENT: no such file, open '/tmp/secret-canonical/path'");
      },
      close: () => {},
    };
    const stream = createResourceStream(source);
    const read = await stream.next();

    expect(read).toMatchObject({ kind: "refused", code: "unavailable" });
    expect(JSON.stringify(read)).not.toContain("/tmp/secret-canonical");
  });

  it("never retries: a producer refusal is terminal and pulls stop", async () => {
    const source = memoryResourceStreamSource<string>([
      { kind: "refused", code: "denied", message: "撤销了" },
      chunk("must not be reached"),
    ]);
    const stream = createResourceStream(source);

    expect(await stream.next()).toMatchObject({ kind: "refused", code: "denied" });
    expect(await stream.next()).toMatchObject({ kind: "refused", code: "closed" });
    expect(source.pulls).toBe(1);
  });

  it("maps an unknown producer refusal code onto `protocol`", async () => {
    const source = memoryResourceStreamSource<string>([
      { kind: "refused", code: "made_up" as never, message: "x" },
    ]);
    expect(await createResourceStream(source).next()).toMatchObject({ kind: "refused", code: "protocol" });
  });

  it("close() is idempotent, releases once, and cancels a read in flight", async () => {
    let release!: (value: ResourceStreamPull<string>) => void;
    let closes = 0;
    const stream = createResourceStream({
      metadata: { payload: "test/v1#chunk", mediaType: "text/plain" },
      pull: () => new Promise<ResourceStreamPull<string>>((resolve) => { release = resolve; }),
      close: () => { closes += 1; },
    });

    const inFlight = stream.next();
    await stream.close();
    await stream.close();
    release(chunk("late"));

    expect(await inFlight).toMatchObject({ kind: "refused", code: "closed" });
    expect(await stream.next()).toMatchObject({ kind: "refused", code: "closed" });
    expect(closes).toBe(1);
  });

  it("every close() caller joins an asynchronous release already started by a terminal", async () => {
    let finishClose!: () => void;
    let closes = 0;
    const stream = createResourceStream({
      metadata: { payload: "test/v1#chunk", mediaType: "text/plain" },
      pull: async (): Promise<ResourceStreamPull<string>> => ({ kind: "end" }),
      close: async () => {
        closes += 1;
        await new Promise<void>((resolve) => { finishClose = resolve; });
      },
    });

    expect(await stream.next()).toMatchObject({ kind: "end" });
    let firstSettled = false;
    let secondSettled = false;
    const first = stream.close().then(() => { firstSettled = true; });
    const second = stream.close().then(() => { secondSettled = true; });
    await Promise.resolve();

    expect(closes).toBe(1);
    expect(firstSettled).toBe(false);
    expect(secondSettled).toBe(false);
    finishClose();
    await Promise.all([first, second]);
    expect(firstSettled).toBe(true);
    expect(secondSettled).toBe(true);
  });

  it("projects metadata down to the four declared fields", () => {
    const stream = createResourceStream(
      memoryResourceStreamSource([{ kind: "end" }], { totalBytes: 7 }),
    );
    const smuggled = { ...stream.metadata } as Record<string, unknown>;
    expect(Object.keys(smuggled).sort()).toEqual(["mediaType", "payload", "totalBytes"]);
  });
});

describe("resource-stream/v1 envelopes", () => {
  const handle = "rs_0123456789abcdef";

  it("reads the request frames it defines", () => {
    const pull = readResourceStreamRequest({
      contract: RESOURCE_STREAM_CONTRACT,
      kind: "pull",
      handle,
      seq: 3,
    });
    expect(pull).toEqual({ ok: true, value: { contract: RESOURCE_STREAM_CONTRACT, kind: "pull", handle, seq: 3 } });

    const close = readResourceStreamRequest({ contract: RESOURCE_STREAM_CONTRACT, kind: "close", handle });
    expect(close.ok).toBe(true);
  });

  it("refuses unknown fields, foreign contracts, bad handles and out-of-range sequences", () => {
    const extra = readResourceStreamRequest({
      contract: RESOURCE_STREAM_CONTRACT,
      kind: "close",
      handle,
      seq: 0,
    });
    expect(extra.ok).toBe(false);

    const foreign = readResourceStreamRequest({ contract: "resource-stream/v2", kind: "close", handle });
    expect(foreign.ok).toBe(false);

    const badHandle = readResourceStreamRequest({
      contract: RESOURCE_STREAM_CONTRACT,
      kind: "close",
      handle: "../../etc/passwd",
    });
    expect(badHandle.ok).toBe(false);

    const badSeq = readResourceStreamRequest({
      contract: RESOURCE_STREAM_CONTRACT,
      kind: "pull",
      handle,
      seq: RESOURCE_STREAM_LIMITS.maxChunks,
    });
    expect(badSeq.ok).toBe(false);
  });

  it("reads every response frame and refuses an invented refusal code", () => {
    const open = readResourceStreamResponse({
      contract: RESOURCE_STREAM_CONTRACT,
      kind: "open",
      handle,
      metadata: { payload: "workspace-files/v1#text-chunk", mediaType: "text/plain; charset=utf-8" },
    });
    expect(open.ok).toBe(true);

    const chunkFrame = readResourceStreamResponse({
      contract: RESOURCE_STREAM_CONTRACT,
      kind: "chunk",
      handle,
      seq: 0,
      bytes: 2,
      value: { text: "hi" },
    });
    expect(chunkFrame.ok).toBe(true);

    const end = readResourceStreamResponse({
      contract: RESOURCE_STREAM_CONTRACT,
      kind: "end",
      handle,
      chunks: 1,
      bytes: 2,
    });
    expect(end.ok).toBe(true);

    const refused = readResourceStreamResponse({
      contract: RESOURCE_STREAM_CONTRACT,
      kind: "refused",
      handle,
      code: "cancelled",
      message: "撤销了",
    });
    expect(refused.ok).toBe(true);

    const invented = readResourceStreamResponse({
      contract: RESOURCE_STREAM_CONTRACT,
      kind: "refused",
      handle,
      code: "retry_later",
      message: "x",
    });
    expect(invented.ok).toBe(false);
  });

  it("requires a chunk to carry a value even when it is null", () => {
    const missing = readResourceStreamResponse({
      contract: RESOURCE_STREAM_CONTRACT,
      kind: "chunk",
      handle,
      seq: 0,
      bytes: 0,
    });
    expect(missing.ok).toBe(false);

    const nullValue = readResourceStreamResponse({
      contract: RESOURCE_STREAM_CONTRACT,
      kind: "chunk",
      handle,
      seq: 0,
      bytes: 0,
      value: null,
    });
    expect(nullValue.ok).toBe(true);
  });

  it("checks the digest grammar rather than carrying any string", () => {
    const good = readResourceStreamMetadata({
      payload: "workspace-files/v1#text-chunk",
      mediaType: "text/plain",
      digest: `sha256:${"a".repeat(64)}`,
    });
    expect(good.ok).toBe(true);

    const bad = readResourceStreamMetadata({
      payload: "workspace-files/v1#text-chunk",
      mediaType: "text/plain",
      digest: "md5:abc",
    });
    expect(bad.ok).toBe(false);
  });
});
