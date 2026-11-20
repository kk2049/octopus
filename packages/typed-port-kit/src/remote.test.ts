import { describe, expect, it } from "vitest";

import { IssueBag, objectAt, boundedStringAt, type ContractResult } from "@claude-bot/resource-stream-contract";

import { answers, refuses, scriptedTransport } from "./conformance.js";
import { declareContract } from "./declaration.js";
import { refusalVocabulary } from "./refusals.js";
import { createRemoteCall } from "./remote.js";
import { WIRE_PARAM_LIMITS } from "./wire.js";

const REFUSALS = refusalVocabulary(
  ["unavailable", "invalid_request", "scope_closed", "approval_required", "too_large"],
  { fallback: "unavailable" },
);

const DECLARATION = declareContract({
  contract: "demo/v1",
  summary: "a demo port",
  actions: {
    fetch_row: {
      summary: "fetch one row",
      params: { ref: { type: "string", description: "opaque ref", maxLength: 32 } },
      operation: "read_row",
    },
    ping: { summary: "say hello", params: {} },
  },
  refusals: REFUSALS,
});

const MESSAGES = {
  noAnswer: "资源通道没有作答。",
  malformedAnswer: "资源通道给出了无法识别的回复。",
  refusedWithoutReason: "这次读取没有完成。",
  closed: "这个视图的会话已经结束。",
};

interface Row {
  ref: string;
  label: string;
}

function readRow(value: unknown): ContractResult<Row> {
  const bag = new IssueBag();
  const row = objectAt(bag, value, "row");
  if (!row) return bag.fail();
  const ref = boundedStringAt(bag, row, "ref", "row", 32);
  const label = boundedStringAt(bag, row, "label", "row", 64);
  if (!bag.empty) return bag.fail();
  return { ok: true, value: { ref: ref!, label: label! } };
}

function build(script: Parameters<typeof scriptedTransport>[0]) {
  const scripted = scriptedTransport(script);
  const call = createRemoteCall({
    declaration: DECLARATION,
    transport: scripted.transport,
    binding: "rows",
    invalidRequest: "invalid_request",
    closed: "scope_closed",
    messages: MESSAGES,
  });
  const fetchRow = (ref: string) =>
    call.call({
      action: "fetch_row",
      params: { ref },
      read: readRow,
      malformed: "这一行没有通过公开契约校验。",
      echo: [{ field: "ref", param: "ref", message: "收到的不是所请求的那一行。" }],
    });
  return { scripted, call, fetchRow };
}

describe("proposing", () => {
  it("carries the binding, the prefixed action, and nothing else", () => {
    const { scripted, fetchRow } = build({
      "resource.fetch_row": answers({ ref: "r1", label: "one" }),
    });
    return fetchRow("r1").then((reply) => {
      expect(reply).toEqual({ ok: true, value: { ref: "r1", label: "one" } });
      expect(scripted.calls).toEqual([
        { action: "resource.fetch_row", params: { binding: "rows", ref: "r1" } },
      ]);
    });
  });

  it("sends nothing at all when the arguments fail the declaration", async () => {
    // Refused locally, with the contract's own field path. "Your ref is 400
    // characters" is a different sentence from "the service said no", and
    // sending it first would make it the second one.
    const { scripted, fetchRow } = build({ "resource.fetch_row": answers({ ref: "x", label: "y" }) });
    const reply = await fetchRow("x".repeat(40));
    expect(reply).toEqual({
      ok: false,
      code: "invalid_request",
      message: "fetch_row.ref: ref is longer than 32 characters",
    });
    expect(scripted.calls).toEqual([]);
  });
});

describe("folding what the transport does", () => {
  it("resolves when the transport rejects", async () => {
    // A rejection is where a stack trace lives, and a stack trace is the most
    // reliable carrier of a canonical path across this boundary.
    const { fetchRow } = build({ "resource.fetch_row": "reject" });
    expect(await fetchRow("r1")).toEqual({ ok: false, code: "unavailable", message: MESSAGES.noAnswer });
  });

  it("resolves when the transport answers with something that is not an answer", async () => {
    for (const malformed of [null, "ok", 42, [], { ok: 1, message: "" }, { ok: true }]) {
      const { fetchRow } = build({ "resource.fetch_row": { malformed } });
      expect(await fetchRow("r1"), `for ${JSON.stringify(malformed)}`).toEqual({
        ok: false,
        code: "unavailable",
        message: MESSAGES.malformedAnswer,
      });
    }
  });

  it("keeps a refusal code this build knows", async () => {
    const { fetchRow } = build({ "resource.fetch_row": refuses("approval_required", "去批准一下") });
    expect(await fetchRow("r1")).toEqual({ ok: false, code: "approval_required", message: "去批准一下" });
  });

  it("folds a refusal code this build does not know", async () => {
    // Rendering a newer Host's vocabulary as if it meant something is the one
    // outcome worse than saying the build cannot interpret it.
    const { fetchRow } = build({ "resource.fetch_row": refuses("rate_limited", "慢一点") });
    expect(await fetchRow("r1")).toEqual({ ok: false, code: "unavailable", message: "慢一点" });
  });

  it("substitutes its own sentence for a refusal that carries none", async () => {
    const { fetchRow } = build({ "resource.fetch_row": refuses("too_large", "") });
    expect(await fetchRow("r1")).toEqual({ ok: false, code: "too_large", message: MESSAGES.refusedWithoutReason });
  });
});

describe("validating the payload again on arrival", () => {
  it("refuses a payload that fails the contract's own reader", async () => {
    const { fetchRow } = build({ "resource.fetch_row": answers({ ref: "r1" }) });
    expect(await fetchRow("r1")).toEqual({
      ok: false,
      code: "unavailable",
      message: "这一行没有通过公开契约校验。",
    });
  });

  it("refuses an answer that is valid but for somewhere else", async () => {
    // The failure a reader cannot catch: a row for `r2` passes every check a
    // row for `r1` would.
    const { fetchRow } = build({ "resource.fetch_row": answers({ ref: "r2", label: "two" }) });
    expect(await fetchRow("r1")).toEqual({
      ok: false,
      code: "unavailable",
      message: "收到的不是所请求的那一行。",
    });
  });

  it("refuses when the echo rule names a parameter that was never sent", async () => {
    // An echo rule against something absent proves nothing, and reading it as
    // "no expectation" is how this check quietly stops running.
    const scripted = scriptedTransport({ "resource.ping": answers({ ref: "anything", label: "x" }) });
    const call = createRemoteCall({
      declaration: DECLARATION,
      transport: scripted.transport,
      binding: "rows",
      invalidRequest: "invalid_request",
      closed: "scope_closed",
      messages: MESSAGES,
    });
    const reply = await call.call({
      action: "ping",
      read: readRow,
      malformed: "bad",
      echo: [{ field: "ref", param: "ref", message: "没有可比对的请求参数。" }],
    });
    expect(reply).toEqual({ ok: false, code: "unavailable", message: "没有可比对的请求参数。" });
  });
});

describe("destroy", () => {
  it("refuses afterwards with the contract's own closed code", async () => {
    const { call, fetchRow } = build({ "resource.fetch_row": answers({ ref: "r1", label: "one" }) });
    call.destroy();
    call.destroy();
    expect(await fetchRow("r1")).toEqual({ ok: false, code: "scope_closed", message: MESSAGES.closed });
    expect(call.closed()).toEqual({ ok: false, code: "scope_closed", message: MESSAGES.closed });
  });

  it("does not hand back a value that was already in flight", async () => {
    const scripted = scriptedTransport({
      "resource.fetch_row": () => answers({ ref: "r1", label: "one" }),
    });
    const call = createRemoteCall({
      declaration: DECLARATION,
      transport: scripted.transport,
      binding: "rows",
      invalidRequest: "invalid_request",
      closed: "scope_closed",
      messages: MESSAGES,
    });
    const discarded: Row[] = [];
    const inFlight = call.call({
      action: "fetch_row",
      params: { ref: "r1" },
      read: readRow,
      malformed: "bad",
      discard: (row) => discarded.push(row),
    });
    call.destroy();
    expect(await inFlight).toEqual({ ok: false, code: "scope_closed", message: MESSAGES.closed });
    expect(discarded).toEqual([{ ref: "r1", label: "one" }]);
  });
});

describe("what the constructor refuses to build", () => {
  const scripted = scriptedTransport({});
  const base = {
    transport: scripted.transport,
    binding: "rows",
    invalidRequest: "invalid_request" as const,
    closed: "scope_closed" as const,
    messages: MESSAGES,
  };

  it("a declaration the wire cannot carry", () => {
    // Legal on the MCP face. Building a remote adapter anyway would surface the
    // incompatibility as a refusal at the first call, from a caller with no way
    // to know it was structural. Since the editor batch a large field is only
    // uncarryable OVER THE CEILING — under it, one per action is the deal.
    const over = WIRE_PARAM_LIMITS.maxDeclaredValueLength + 1;
    const wide = declareContract({
      contract: "demo/v1",
      summary: "s",
      actions: { go: { summary: "s", params: { body: { type: "string", description: "d", maxLength: over } } } },
      refusals: REFUSALS,
    });
    expect(() => createRemoteCall({ ...base, declaration: wide })).toThrow(
      new RegExp(`cannot be served over the View wire: go \\(body allows ${over}`),
    );
  });

  it("a declaration with two oversized parameters, even though each fits alone", () => {
    const both = declareContract({
      contract: "demo/v1",
      summary: "s",
      actions: {
        go: {
          summary: "s",
          params: {
            body: { type: "string", description: "d", maxLength: 4000 },
            note: { type: "string", description: "d", maxLength: 4000 },
          },
        },
      },
      refusals: REFUSALS,
    });
    expect(() => createRemoteCall({ ...base, declaration: both })).toThrow(/one proposal carries at most 1/);
  });

  it("builds for a declaration with exactly one oversized parameter", () => {
    const one = declareContract({
      contract: "demo/v1",
      summary: "s",
      actions: {
        go: {
          summary: "s",
          params: {
            ref: { type: "string", description: "d", maxLength: 200 },
            body: { type: "string", description: "d", maxLength: 4000 },
          },
        },
      },
      refusals: REFUSALS,
    });
    expect(() => createRemoteCall({ ...base, declaration: one })).not.toThrow();
  });

  it("a declaration that claims one of the kit's reserved parameters", () => {
    for (const reserved of ["binding", "handle", "seq"]) {
      const clashing = declareContract({
        contract: "demo/v1",
        summary: "s",
        actions: { go: { summary: "s", params: { [reserved]: { type: "string", description: "d", maxLength: 4 } } } },
        refusals: REFUSALS,
      });
      expect(() => createRemoteCall({ ...base, declaration: clashing })).toThrow(
        new RegExp(`declares the reserved parameter ${reserved}`),
      );
    }
  });

  it("a refusal code the contract does not have", () => {
    expect(() => createRemoteCall({ ...base, declaration: DECLARATION, invalidRequest: "nope" as never })).toThrow(
      /has no refusal code "nope"/,
    );
    expect(() => createRemoteCall({ ...base, declaration: DECLARATION, closed: "nope" as never })).toThrow(
      /has no refusal code "nope"/,
    );
  });
});

describe("ask", () => {
  it("supplies the binding so no caller has to remember it", async () => {
    const { scripted, call } = build({ "resource.stream_pull": answers(null) });
    await call.ask("resource.stream_pull", { handle: "h1", seq: "0" });
    expect(scripted.calls).toEqual([
      { action: "resource.stream_pull", params: { binding: "rows", handle: "h1", seq: "0" } },
    ]);
  });
});
