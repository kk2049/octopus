/**
 * The remote adapter, against a transport that is allowed to lie.
 *
 * Two properties get most of the attention here, and both are about damage this
 * contract can do that the others cannot:
 *
 *  1. **A reply about the wrong document must not be believed.** It passes every
 *     reader — it is a valid answer about somewhere else — and the consumer's
 *     next move is to merge the update it carries into a local `Y.Doc` and push
 *     its own diff back. That is not a mislabelled screen; it is two corrupted
 *     replicas.
 *  2. **An over-long update must be refused locally, before proposing.** A
 *     refused push is an edit the author still holds; the failure mode this
 *     guards is the platform-level one recorded in the P6c worklog, where a
 *     bounded-params helper TRUNCATED instead of refusing and the far side then
 *     rejected bytes that were no longer the author's.
 *
 * `wire.test.ts` covers the numbers themselves. This file covers what the port
 * does with them.
 */

import { describe, expect, it } from "vitest";

import { answers, refuses, scriptedTransport } from "@claude-bot/typed-port-kit/testing";

import { CRDT_DOC_CONTRACT, CRDT_DOC_LIMITS } from "./contract.js";
import { CRDT_SCHEMA_MAJOR } from "./projection.js";
import { createRemoteCrdtDocPort } from "./remote.js";

const DOC = "doc-abc";
const SV = "AAEC";
const UPDATE = "BQYH";

const SNAPSHOT = { doc: DOC, schemaMajor: CRDT_SCHEMA_MAJOR, stateVector: SV, update: UPDATE };
const ACK = { doc: DOC, stateVector: SV };
const DELTA = { doc: DOC, stateVector: SV, update: UPDATE, empty: false };

function build(script: Parameters<typeof scriptedTransport>[0]) {
  const scripted = scriptedTransport(script);
  return { scripted, ...createRemoteCrdtDocPort(scripted.transport, "notes") };
}

describe("what crosses the wire", () => {
  it("carries the binding, the prefixed action, and the declared params", async () => {
    const { scripted, port } = build({ "resource.open_doc": answers(SNAPSHOT) });
    expect(await port.openDoc(DOC)).toEqual({ ok: true, value: SNAPSHOT });
    expect(scripted.calls).toEqual([
      { action: "resource.open_doc", params: { binding: "notes", doc: DOC } },
    ]);
  });

  it("sends an update as one parameter beside the doc ref", async () => {
    const { scripted, port } = build({ "resource.apply_update": answers(ACK) });
    await port.applyUpdate(DOC, UPDATE);
    expect(scripted.calls).toEqual([
      { action: "resource.apply_update", params: { binding: "notes", doc: DOC, update: UPDATE } },
    ]);
  });

  it("sends a state vector as `since`, not as a cursor the far side has to remember", async () => {
    const { scripted, port } = build({ "resource.read_updates": answers(DELTA) });
    await port.readUpdates(DOC, SV);
    expect(scripted.calls[0]!.params).toEqual({ binding: "notes", doc: DOC, since: SV });
  });

  it("asks for the scope's documents with no parameters at all", async () => {
    const list = { docs: [{ doc: DOC, title: "说明" }] };
    const { scripted, port } = build({ "resource.list_docs": answers(list) });
    expect(await port.listDocs()).toEqual({ ok: true, value: list });
    expect(scripted.calls).toEqual([{ action: "resource.list_docs", params: { binding: "notes" } }]);
  });

  it("refuses a document list whose entries carry more than ref and title", async () => {
    const { port } = build({
      "resource.list_docs": answers({ docs: [{ doc: DOC, title: "t", owner: "alice" }] }),
    });
    expect(await port.listDocs()).toMatchObject({ ok: false, code: "unavailable" });
  });

  it("states its contract, and nothing else about where the document lives", () => {
    const { port } = build({});
    expect(port.contract).toBe(CRDT_DOC_CONTRACT);
    // No identity, no subscribe, no create. Not filtered — absent.
    expect(Object.keys(port).sort()).toEqual([
      "applyUpdate",
      "contract",
      "listDocs",
      "openDoc",
      "readUpdates",
    ]);
  });
});

describe("refusing locally, before anything is sent", () => {
  it("refuses an update past the DECLARED bound without proposing", async () => {
    const { scripted, port } = build({ "resource.apply_update": answers(ACK) });
    // One character over: base64 stays well-formed only in multiples of four,
    // so go four over to isolate «too long» from «not base64».
    const tooLong = "A".repeat(CRDT_DOC_LIMITS.maxUpdateEncodedLength + 4);
    const reply = await port.applyUpdate(DOC, tooLong);
    expect(reply).toMatchObject({ ok: false, code: "invalid_request" });
    expect(scripted.calls).toEqual([]);
  });

  it("refuses a state vector past its own, smaller bound without proposing", async () => {
    // The two big parameters do NOT share a bound: a state vector is 4 KiB and
    // an update is 64 KiB, so a value legal for one is illegal for the other.
    const { scripted, port } = build({ "resource.read_updates": answers(DELTA) });
    const reply = await port.readUpdates(DOC, "A".repeat(CRDT_DOC_LIMITS.maxStateVectorEncodedLength + 4));
    expect(reply).toMatchObject({ ok: false, code: "invalid_request" });
    expect(scripted.calls).toEqual([]);
  });

  it("refuses bytes that are not standard base64 at all", async () => {
    const { scripted, port } = build({ "resource.apply_update": answers(ACK) });
    // base64url. Two spellings of the same bytes would make "the same update
    // twice" stop looking the same, which is the cheap observation an
    // idempotent merge relies on.
    expect(await port.applyUpdate(DOC, "AA-_")).toMatchObject({ ok: false, code: "invalid_request" });
    expect(scripted.calls).toEqual([]);
  });

  it("refuses a doc ref that is not a bounded printable reference", async () => {
    const { scripted, port } = build({ "resource.open_doc": answers(SNAPSHOT) });
    const reply = await port.openDoc(`bad${String.fromCharCode(10)}ref`);
    expect(reply).toMatchObject({ ok: false, code: "invalid_request" });
    expect(scripted.calls).toEqual([]);
  });
});

describe("every refusal resolves", () => {
  it("when the transport rejects", async () => {
    const { port } = build({ "resource.open_doc": "reject" });
    expect(await port.openDoc(DOC)).toEqual({
      ok: false,
      code: "unavailable",
      message: "协作文档通道没有作答。",
    });
  });

  it("when the transport answers with something that is not an answer", async () => {
    for (const malformed of [null, "merged", 42, [], { ok: "yes", message: "" }]) {
      const { port } = build({ "resource.apply_update": { malformed } });
      expect(await port.applyUpdate(DOC, UPDATE), `for ${JSON.stringify(malformed)}`).toEqual({
        ok: false,
        code: "unavailable",
        message: "协作文档通道给出了无法识别的回复。",
      });
    }
  });

  it("for every code this contract declares", async () => {
    const codes = [
      "refused",
      "unknown_doc",
      "bad_update",
      "doc_too_large",
      "approval_required",
      "no_authority",
      "rate_limited",
    ] as const;
    for (const code of codes) {
      const { port } = build({ "resource.apply_update": refuses(code, `因为 ${code}`) });
      expect(await port.applyUpdate(DOC, UPDATE)).toEqual({ ok: false, code, message: `因为 ${code}` });
    }
  });

  it("folding a code this build has never heard of", async () => {
    const { port } = build({ "resource.open_doc": refuses("document_on_holiday", "度假中") });
    expect(await port.openDoc(DOC)).toEqual({ ok: false, code: "unavailable", message: "度假中" });
  });

  it("substituting its own sentence for a refusal that carries none", async () => {
    const { port } = build({ "resource.read_updates": refuses("rate_limited", "") });
    expect(await port.readUpdates(DOC, SV)).toEqual({
      ok: false,
      code: "rate_limited",
      message: "这次协作文档操作没有完成。",
    });
  });
});

describe("validating the answer again on arrival", () => {
  it("refuses a snapshot that fails the contract's own reader", async () => {
    const { port } = build({ "resource.open_doc": answers({ doc: DOC, stateVector: SV }) });
    expect(await port.openDoc(DOC)).toEqual({
      ok: false,
      code: "unavailable",
      message: "文档快照没有通过公开契约校验。",
    });
  });

  it("refuses an answer carrying a field this contract does not have", async () => {
    const { port } = build({ "resource.apply_update": answers({ ...ACK, docPath: "/srv/notes/a.md" }) });
    expect(await port.applyUpdate(DOC, UPDATE)).toMatchObject({ ok: false, code: "unavailable" });
  });

  it("refuses a snapshot for a DIFFERENT document", async () => {
    // The dangerous one. This payload is a perfectly valid snapshot — of
    // something else — so no reader can reject it. Believing it means merging a
    // foreign history into this replica and pushing the result back.
    const { port } = build({ "resource.open_doc": answers({ ...SNAPSHOT, doc: "doc-other" }) });
    expect(await port.openDoc(DOC)).toEqual({
      ok: false,
      code: "unavailable",
      message: "收到的回复不是所请求的那份文档的。",
    });
  });

  it("checks the echo on the merge receipt and on the delta too, not just on open", async () => {
    const ackElsewhere = build({ "resource.apply_update": answers({ ...ACK, doc: "doc-other" }) });
    expect(await ackElsewhere.port.applyUpdate(DOC, UPDATE)).toMatchObject({
      ok: false,
      message: "收到的回复不是所请求的那份文档的。",
    });

    const deltaElsewhere = build({ "resource.read_updates": answers({ ...DELTA, doc: "doc-other" }) });
    expect(await deltaElsewhere.port.readUpdates(DOC, SV)).toMatchObject({
      ok: false,
      message: "收到的回复不是所请求的那份文档的。",
    });
  });
});

describe("after destroy", () => {
  it("refuses everything and proposes nothing", async () => {
    const { scripted, port, destroy } = build({
      "resource.open_doc": answers(SNAPSHOT),
      "resource.apply_update": answers(ACK),
    });
    destroy();
    destroy(); // idempotent

    for (const reply of [await port.openDoc(DOC), await port.applyUpdate(DOC, UPDATE)]) {
      expect(reply).toEqual({
        ok: false,
        code: "scope_closed",
        message: "这个视图的会话已经结束，请重新打开。",
      });
    }
    expect(scripted.calls).toEqual([]);
  });
});

describe("what it never does", () => {
  it("never touches the stream verbs", async () => {
    // This contract opens no streams: three actions, three complete answers.
    // The kit's stream half is opt-in and a contract that does not open streams
    // must carry none of it.
    const { scripted, port } = build({
      "resource.open_doc": answers(SNAPSHOT),
      "resource.apply_update": answers(ACK),
      "resource.read_updates": answers(DELTA),
    });
    await port.openDoc(DOC);
    await port.applyUpdate(DOC, UPDATE);
    await port.readUpdates(DOC, SV);
    expect(scripted.calls.map((c) => c.action)).toEqual([
      "resource.open_doc",
      "resource.apply_update",
      "resource.read_updates",
    ]);
  });
});
