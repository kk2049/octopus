import { describe, expect, it } from "vitest";

import {
  RESOURCE_STREAM_CONTRACT,
  createResourceStream,
  drainResourceStream,
  type ContractResult,
  type ResourceStreamMetadata,
} from "@claude-bot/resource-stream-contract";

import type { ProposalAnswer } from "./arrival.js";
import { createRemoteStreamSource, streamRefusalFold } from "./stream.js";

interface TextChunk {
  text: string;
}

function readChunk(value: unknown): ContractResult<TextChunk> {
  if (!value || typeof value !== "object" || typeof (value as { text?: unknown }).text !== "string") {
    return { ok: false, issues: [{ code: "field_type", message: "text must be a string" }] };
  }
  return { ok: true, value: { text: (value as { text: string }).text } };
}

const MESSAGES = {
  closed: "已经关闭",
  badFrame: "无法识别的帧",
  wrongStream: "另一条流的帧",
  outOfOrder: "读取顺序不一致",
  badPayload: "内容契约校验失败",
  sizeMismatch: "声明的字节数与内容不符",
  chunkTooLarge: "超过单块上限",
  overran: "超过声明的长度",
  endMismatch: "结束位置与实际不一致",
  truncated: "读完之前就结束了",
  refusedWithoutReason: "没有继续",
};

const FOLD = streamRefusalFold(
  { scope_closed: "expired", approval_required: "denied", invalid_request: "protocol" },
  MESSAGES.refusedWithoutReason,
);

const HANDLE = "handle-0000001";

function chunkFrame(seq: number, text: string, bytes = text.length): unknown {
  return { contract: RESOURCE_STREAM_CONTRACT, kind: "chunk", handle: HANDLE, seq, bytes, value: { text } };
}

function endFrame(chunks: number, bytes: number): unknown {
  return { contract: RESOURCE_STREAM_CONTRACT, kind: "end", handle: HANDLE, chunks, bytes };
}

interface Harness {
  pulls: { action: string; params: Record<string, string> }[];
  ask(action: string, params: Readonly<Record<string, string>>): Promise<ProposalAnswer>;
}

function harness(script: readonly (unknown | ProposalAnswer)[], options: { refusal?: ProposalAnswer } = {}): Harness {
  const pulls: { action: string; params: Record<string, string> }[] = [];
  let index = 0;
  return {
    pulls,
    async ask(action, params) {
      pulls.push({ action, params: { ...params } });
      if (action.endsWith("stream_close")) return { ok: true, result: null, message: "" };
      if (options.refusal) return options.refusal;
      const next = script[index++];
      if (next === undefined) return { ok: true, result: endFrame(0, 0), message: "" };
      return { ok: true, result: next, message: "" };
    },
  };
}

function streamOf(h: Harness, metadata: Partial<ResourceStreamMetadata> = {}) {
  const source = createRemoteStreamSource<TextChunk>({
    ask: h.ask,
    metadata: { payload: "demo/v1#text", mediaType: "text/plain; charset=utf-8", ...metadata },
    handle: HANDLE,
    readChunk,
    measure: (chunk) => chunk.text.length,
    maxChunkBytes: 8,
    fold: FOLD,
    messages: MESSAGES,
  });
  return createResourceStream<TextChunk>(source, { maxChunkBytes: 8, maxStreamBytes: 64 });
}

describe("a well-behaved remote stream", () => {
  it("reads chunks in order and ends", async () => {
    const h = harness([chunkFrame(0, "abc"), chunkFrame(1, "de"), endFrame(2, 5)]);
    const drained = await drainResourceStream(streamOf(h, { totalBytes: 5 }));
    expect(drained.chunks).toEqual([{ text: "abc" }, { text: "de" }]);
    expect(drained.seqs).toEqual([0, 1]);
    expect(drained.terminal).toEqual({ kind: "end", chunks: 2, bytes: 5 });
  });

  it("states its own cursor on every pull", async () => {
    // Stated rather than implied, so a producer can refuse a pull that does not
    // match its own position instead of silently reordering a resource.
    const h = harness([chunkFrame(0, "a"), chunkFrame(1, "b"), endFrame(2, 2)]);
    await drainResourceStream(streamOf(h, { totalBytes: 2 }));
    const pulls = h.pulls.filter((pull) => pull.action.endsWith("stream_pull"));
    expect(pulls.map((pull) => pull.params.seq)).toEqual(["0", "1", "2"]);
    expect(h.pulls.every((pull) => pull.params.handle === HANDLE)).toBe(true);
    // The guard releases the source on the terminal, so the close frame is the
    // last thing on the wire and nothing follows it.
    expect(h.pulls.at(-1)?.action).toBe("resource.stream_close");
  });
});

describe("what a lying transport gets", () => {
  const cases: { name: string; script: unknown[]; metadata?: Partial<ResourceStreamMetadata>; message: string }[] = [
    {
      name: "a chunk that understates its own size",
      // The whole reason a remote source measures: an understated count lets a
      // stream carry more than its cap while the accounting says otherwise.
      script: [chunkFrame(0, "abcdef", 2)],
      message: MESSAGES.sizeMismatch,
    },
    {
      name: "a chunk that overstates its own size",
      script: [chunkFrame(0, "ab", 200)],
      message: MESSAGES.sizeMismatch,
    },
    { name: "a skipped sequence number", script: [chunkFrame(1, "ab")], message: MESSAGES.outOfOrder },
    {
      name: "a frame for another stream",
      script: [{ contract: RESOURCE_STREAM_CONTRACT, kind: "chunk", handle: "other-handle-1", seq: 0, bytes: 1, value: { text: "a" } }],
      message: MESSAGES.wrongStream,
    },
    { name: "a frame that is not a frame", script: [{ nope: true }], message: MESSAGES.badFrame },
    {
      name: "a payload the contract's reader rejects",
      script: [{ contract: RESOURCE_STREAM_CONTRACT, kind: "chunk", handle: HANDLE, seq: 0, bytes: 1, value: { text: 7 } }],
      message: MESSAGES.badPayload,
    },
    {
      name: "an end that disagrees with what arrived",
      script: [chunkFrame(0, "ab"), endFrame(5, 5)],
      message: MESSAGES.endMismatch,
    },
    {
      name: "an early end against a declared total",
      // Send one window, then an `end` consistent with what was sent. Nothing
      // but the declared total can tell that from a complete short resource.
      script: [chunkFrame(0, "ab"), endFrame(1, 2)],
      metadata: { totalBytes: 40 },
      message: MESSAGES.truncated,
    },
    {
      name: "a chunk that overruns the declared total",
      script: [chunkFrame(0, "ab"), chunkFrame(1, "cd")],
      metadata: { totalBytes: 3 },
      message: MESSAGES.overran,
    },
  ];

  for (const scenario of cases) {
    it(`terminates on ${scenario.name}`, async () => {
      const h = harness(scenario.script);
      const drained = await drainResourceStream(streamOf(h, scenario.metadata));
      expect(drained.terminal).toMatchObject({ kind: "refused", code: "protocol", message: scenario.message });
    });
  }

  it("refuses a chunk larger than the contract's own ceiling", async () => {
    const h = harness([chunkFrame(0, "0123456789")]);
    const drained = await drainResourceStream(streamOf(h));
    expect(drained.terminal).toMatchObject({ kind: "refused", code: "too_large" });
  });

  it("stops pulling after a terminal", async () => {
    const h = harness([chunkFrame(0, "ab"), endFrame(5, 5)]);
    const stream = streamOf(h);
    await stream.next();
    await stream.next();
    const pullsAtTerminal = h.pulls.filter((pull) => pull.action.endsWith("stream_pull")).length;
    await stream.next();
    await stream.next();
    expect(h.pulls.filter((pull) => pull.action.endsWith("stream_pull")).length).toBe(pullsAtTerminal);
  });
});

describe("refusals from the far side", () => {
  it("folds the codes the mapping names", async () => {
    const h = harness([], { refusal: { ok: false, code: "approval_required", result: null, message: "去批准" } });
    const drained = await drainResourceStream(streamOf(h));
    expect(drained.terminal).toEqual({ kind: "refused", code: "denied", message: "去批准" });
  });

  it("folds an unmapped code through the stream vocabulary's own fallback", async () => {
    const h = harness([], { refusal: { ok: false, code: "bad_recipient", result: null, message: "谁" } });
    const drained = await drainResourceStream(streamOf(h));
    expect(drained.terminal).toEqual({ kind: "refused", code: "unavailable", message: "谁" });
  });

  it("passes a refused FRAME through with its own code", async () => {
    const h = harness([
      { contract: RESOURCE_STREAM_CONTRACT, kind: "refused", handle: HANDLE, code: "cancelled", message: "撤销了" },
    ]);
    const drained = await drainResourceStream(streamOf(h));
    expect(drained.terminal).toEqual({ kind: "refused", code: "cancelled", message: "撤销了" });
  });

  it("substitutes its own sentence for a refusal that carries none", async () => {
    const h = harness([], { refusal: { ok: false, code: "scope_closed", result: null, message: "" } });
    const drained = await drainResourceStream(streamOf(h));
    expect(drained.terminal).toEqual({ kind: "refused", code: "expired", message: MESSAGES.refusedWithoutReason });
  });
});

describe("close", () => {
  it("tells the far side once and never pulls again", async () => {
    const h = harness([chunkFrame(0, "ab"), endFrame(1, 2)]);
    const stream = streamOf(h, { totalBytes: 2 });
    await stream.next();
    await stream.close();
    await stream.close();
    const closes = h.pulls.filter((pull) => pull.action.endsWith("stream_close"));
    expect(closes).toEqual([{ action: "resource.stream_close", params: { handle: HANDLE } }]);
    expect(await stream.next()).toMatchObject({ kind: "refused", code: "closed" });
  });

  it("survives a close the transport rejects", async () => {
    // Best effort by definition: the channel may already be gone, and there is
    // nobody left to tell if it is.
    const source = createRemoteStreamSource<TextChunk>({
      ask: async () => {
        throw new Error("channel gone");
      },
      metadata: { payload: "demo/v1#text", mediaType: "text/plain" },
      handle: HANDLE,
      readChunk,
      measure: (chunk) => chunk.text.length,
      fold: FOLD,
      messages: MESSAGES,
    });
    expect(() => source.close()).not.toThrow();
    expect(() => source.close()).not.toThrow();
  });
});
