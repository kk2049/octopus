/**
 * `crdt-doc/v2`'s declaration, readers and adapter, against a scripted far
 * side. The vertical test with the real provider and store lives in
 * `packages/bot/src/agent-resources/crdt-doc-v2.e2e.test.ts`; this file pins the
 * shapes and the refusals a lying transport must get.
 */

import { describe, expect, it } from "vitest";
import { wireServiceableActions } from "@claude-bot/typed-port-kit";
import { answers, scriptedTransport } from "@claude-bot/typed-port-kit/testing";

import {
  CRDT_DOC_CONTRACT_V2,
  CRDT_DOC_DECLARATION_V2,
  CRDT_DOC_V2_LIMITS,
  CRDT_UPDATE_CHUNK_PAYLOAD,
  CRDT_UPDATE_MEDIA_TYPE,
  base64ByteLength,
} from "./contract-v2.js";
import { readCrdtDocDeltaWire, readCrdtDocSnapshotWire } from "./projection-v2.js";
import { CRDT_SCHEMA_MAJOR } from "./projection.js";
import { createRemoteCrdtDocPortV2 } from "./remote-v2.js";

const DOC = "doc-abc";
const SV = "AAEC";
const HANDLE = "rs_handle_0001";

function openFrame(totalBytes: number) {
  return {
    contract: "resource-stream/v1",
    kind: "open",
    handle: HANDLE,
    metadata: { payload: CRDT_UPDATE_CHUNK_PAYLOAD, mediaType: CRDT_UPDATE_MEDIA_TYPE, totalBytes },
  };
}

function chunkFrame(seq: number, data: string) {
  return { contract: "resource-stream/v1", kind: "chunk", handle: HANDLE, seq, bytes: base64ByteLength(data), value: { data } };
}

function endFrame(chunks: number, bytes: number) {
  return { contract: "resource-stream/v1", kind: "end", handle: HANDLE, chunks, bytes };
}

/** Pulls answered from a list of base64 slices, then `end`. */
function pulls(slices: string[]) {
  return (params: Readonly<Record<string, string>>) => {
    const seq = Number(params.seq);
    if (seq < slices.length) return answers(chunkFrame(seq, slices[seq]!));
    return answers(endFrame(slices.length, slices.reduce((sum, slice) => sum + base64ByteLength(slice), 0)));
  };
}

describe("the v2 declaration", () => {
  it("is servable over the View wire, with one oversized parameter per action", () => {
    expect(CRDT_DOC_DECLARATION_V2.contract).toBe(CRDT_DOC_CONTRACT_V2);
    expect([...wireServiceableActions(CRDT_DOC_DECLARATION_V2)].sort())
      .toEqual(["apply_update", "list_docs", "open_doc", "read_updates"]);
    expect(CRDT_DOC_DECLARATION_V2.operations).toEqual(["edit_document", "read_document"]);
    // Slices at this stride are whole base64 quanta of whole byte triples.
    expect(CRDT_DOC_V2_LIMITS.maxPartEncodedLength % 4).toBe(0);
    expect(CRDT_DOC_V2_LIMITS.maxPartBytes % 3).toBe(0);
    expect(CRDT_DOC_V2_LIMITS.chunkBytes % 3).toBe(0);
  });
});

describe("the v2 readers", () => {
  const head = { doc: DOC, schemaMajor: CRDT_SCHEMA_MAJOR, stateVector: SV };

  it("take exactly one of update and stream", () => {
    expect(readCrdtDocSnapshotWire({ ...head, update: "BQYH" }).ok).toBe(true);
    expect(readCrdtDocSnapshotWire({ ...head, stream: openFrame(9) }).ok).toBe(true);
    expect(readCrdtDocSnapshotWire({ ...head }).ok).toBe(false);
    expect(readCrdtDocSnapshotWire({ ...head, update: "BQYH", stream: openFrame(9) }).ok).toBe(false);
  });

  it("refuse a stream that does not announce an update with its size", () => {
    const { totalBytes: _, ...unsized } = openFrame(9).metadata;
    expect(readCrdtDocSnapshotWire({ ...head, stream: { ...openFrame(9), metadata: unsized } }).ok).toBe(false);
    expect(readCrdtDocSnapshotWire({
      ...head, stream: { ...openFrame(9), metadata: { ...openFrame(9).metadata, payload: "workspace-files/v1#text-chunk" } },
    }).ok).toBe(false);
  });

  it("never stream an empty delta", () => {
    expect(readCrdtDocDeltaWire({ doc: DOC, stateVector: SV, empty: true, stream: openFrame(9) }).ok).toBe(false);
    expect(readCrdtDocDeltaWire({ doc: DOC, stateVector: SV, empty: true, update: "AAA=" }).ok).toBe(true);
  });
});

describe("the v2 adapter", () => {
  it("joins a streamed snapshot into the one update an editor merges", async () => {
    const slices = ["AAECAwQF", "BgcICQoL", "DA=="];
    const scripted = scriptedTransport({
      "resource.open_doc": answers({ doc: DOC, schemaMajor: CRDT_SCHEMA_MAJOR, stateVector: SV, stream: openFrame(13) }),
      "resource.stream_pull": pulls(slices),
      "resource.stream_close": answers({ closed: false }),
    });
    const { port } = createRemoteCrdtDocPortV2(scripted.transport, "notes");
    expect(await port.openDoc(DOC)).toEqual({
      ok: true,
      value: { doc: DOC, schemaMajor: CRDT_SCHEMA_MAJOR, stateVector: SV, update: slices.join("") },
    });
    expect(scripted.calls.filter((call) => call.action === "resource.stream_pull").map((call) => call.params.seq))
      .toEqual(["0", "1", "2", "3"]);
  });

  it("refuses a stream padded before its last slice instead of mis-joining it", async () => {
    const slices = ["AAE=", "AgME"];
    const scripted = scriptedTransport({
      "resource.read_updates": answers({ doc: DOC, stateVector: SV, empty: false, stream: openFrame(5) }),
      "resource.stream_pull": pulls(slices),
      "resource.stream_close": answers({ closed: true }),
    });
    const { port } = createRemoteCrdtDocPortV2(scripted.transport, "notes");
    expect(await port.readUpdates(DOC, SV)).toMatchObject({ ok: false, code: "unavailable" });
  });

  it("refuses a stream that ends short of its announced size", async () => {
    const scripted = scriptedTransport({
      "resource.open_doc": answers({ doc: DOC, schemaMajor: CRDT_SCHEMA_MAJOR, stateVector: SV, stream: openFrame(99) }),
      "resource.stream_pull": pulls(["AAECAwQF"]),
      "resource.stream_close": answers({ closed: true }),
    });
    const { port } = createRemoteCrdtDocPortV2(scripted.transport, "notes");
    expect(await port.openDoc(DOC)).toMatchObject({ ok: false, code: "unavailable" });
  });

  it("pushes a large update as offset-addressed parts, each one window", async () => {
    const window = CRDT_DOC_V2_LIMITS.maxPartEncodedLength;
    const update = "QUJD".repeat((window * 2 + 8) / 4);
    const total = base64ByteLength(update);
    const scripted = scriptedTransport({
      "resource.apply_update": (params) => {
        const end = Number(params.offset) + base64ByteLength(params.update!);
        return answers(end < total ? { doc: DOC, stateVector: SV, staged: end } : { doc: DOC, stateVector: "AAED" });
      },
    });
    const { port } = createRemoteCrdtDocPortV2(scripted.transport, "notes");
    expect(await port.applyUpdate(DOC, update)).toEqual({ ok: true, value: { doc: DOC, stateVector: "AAED" } });
    expect(scripted.calls.map((call) => [call.params.offset, call.params.total, call.params.update!.length])).toEqual([
      ["0", String(total), window],
      [String((window / 4) * 3), String(total), window],
      [String((window / 2) * 3), String(total), 8],
    ]);
  });

  it("stops at a part whose acknowledgement disagrees with what was sent", async () => {
    const window = CRDT_DOC_V2_LIMITS.maxPartEncodedLength;
    const scripted = scriptedTransport({
      "resource.apply_update": answers({ doc: DOC, stateVector: SV, staged: 1 }),
    });
    const { port } = createRemoteCrdtDocPortV2(scripted.transport, "notes");
    expect(await port.applyUpdate(DOC, "QUJD".repeat(window / 2))).toMatchObject({ ok: false, code: "unavailable" });
    expect(scripted.calls).toHaveLength(1);
  });
});
