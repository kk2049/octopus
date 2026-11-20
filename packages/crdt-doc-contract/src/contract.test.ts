/**
 * The contract's own properties, and the readers' refusals.
 *
 * The interesting assertions are the negative ones: a delta that is perfectly
 * well-formed but for another document, a base64 string of a length no decoder
 * can honour, and a schema major from the future. Each is a value that a naive
 * consumer would treat as good.
 */

import { describe, expect, it } from "vitest";
import { mcpToolsOf } from "@claude-bot/typed-port-kit";

import {
  CRDT_DOC_CONTRACT,
  CRDT_DOC_DECLARATION,
  CRDT_DOC_LIMITS,
  CRDT_DOC_OPERATIONS,
  CRDT_DOC_REFUSALS,
  CRDT_EDIT_OPERATION,
  CRDT_READ_OPERATION,
  isBase64,
} from "./contract.js";
import {
  CRDT_SCHEMA_MAJOR,
  readCrdtDocAck,
  readCrdtDocDelta,
  readCrdtDocList,
  readCrdtDocSnapshot,
} from "./projection.js";

const DOC = "cd_0123456789abcdef";
const B64 = "AQIDBA==";

function codes(result: { ok: boolean; issues?: { code: string; at?: string }[] }): string[] {
  return (result.issues ?? []).map((issue) => issue.code);
}

describe("crdt-doc/v1 declaration", () => {
  it("declares the bootstrap verb plus the three synchronisation verbs", () => {
    expect(CRDT_DOC_DECLARATION.contract).toBe(CRDT_DOC_CONTRACT);
    expect([...CRDT_DOC_DECLARATION.actionIds]).toEqual([
      "list_docs",
      "open_doc",
      "apply_update",
      "read_updates",
    ]);
    // The bootstrap verb takes nothing: it can be the FIRST call a scope ever
    // receives, which is the whole reason it exists.
    expect(Object.keys(CRDT_DOC_DECLARATION.byAction.list_docs.params)).toEqual([]);
  });

  it("spends two permission tokens, and reading does not imply writing", () => {
    expect([...CRDT_DOC_OPERATIONS]).toEqual([CRDT_EDIT_OPERATION, CRDT_READ_OPERATION].sort());
    expect(CRDT_DOC_DECLARATION.byAction.list_docs.operation).toBe(CRDT_READ_OPERATION);
    expect(CRDT_DOC_DECLARATION.byAction.open_doc.operation).toBe(CRDT_READ_OPERATION);
    expect(CRDT_DOC_DECLARATION.byAction.read_updates.operation).toBe(CRDT_READ_OPERATION);
    expect(CRDT_DOC_DECLARATION.byAction.apply_update.operation).toBe(CRDT_EDIT_OPERATION);
  });

  it("closes the refusal set around the three this contract adds", () => {
    for (const code of ["unknown_doc", "bad_update", "doc_too_large"]) {
      expect(CRDT_DOC_REFUSALS.has(code)).toBe(true);
    }
    expect(CRDT_DOC_REFUSALS.fallback).toBe("unavailable");
    // A code from a newer Host folds into the fallback rather than being
    // rendered as if this build understood it.
    expect(CRDT_DOC_REFUSALS.coerce("presence_conflict")).toBe("unavailable");
  });

  it("derives an MCP face that carries every declared bound", () => {
    const tools = mcpToolsOf(CRDT_DOC_DECLARATION);
    expect(tools.map((tool) => tool.name)).toEqual([
      "crdt-doc_list_docs",
      "crdt-doc_open_doc",
      "crdt-doc_apply_update",
      "crdt-doc_read_updates",
    ]);
    const apply = tools.find((tool) => tool.name === "crdt-doc_apply_update")!;
    const update = apply.inputSchema.properties.update as Record<string, unknown>;
    // The bound the wire cannot honour is still stated on the face that can:
    // a model that cannot see a limit will exceed it and be refused for a
    // reason it was never told.
    expect(update.maxLength).toBe(CRDT_DOC_LIMITS.maxUpdateEncodedLength);
    expect(apply.inputSchema.additionalProperties).toBe(false);
  });
});

describe("base64 well-formedness", () => {
  it("accepts canonical base64 and refuses a length no decoder can honour", () => {
    expect(isBase64("AQIDBA==", 64)).toBe(true);
    expect(isBase64("", 64)).toBe(true);
    // Three characters is a truncated quantum. A decoder either refuses it or
    // silently rounds it — and rounding produces bytes nobody sent.
    expect(isBase64("AQI", 64)).toBe(false);
    expect(isBase64("AQID-A==", 64)).toBe(false);
    expect(isBase64("AQIDBA==", 4)).toBe(false);
  });
});

describe("snapshot reader", () => {
  const good = { doc: DOC, schemaMajor: CRDT_SCHEMA_MAJOR, stateVector: B64, update: B64 };

  it("accepts a well-formed snapshot", () => {
    const read = readCrdtDocSnapshot(good);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value).toEqual(good);
  });

  it("refuses a field this build does not know", () => {
    const read = readCrdtDocSnapshot({ ...good, presence: [] });
    expect(read.ok).toBe(false);
    expect(codes(read)).toContain("unknown_field");
  });

  it("refuses a state vector that is not base64", () => {
    const read = readCrdtDocSnapshot({ ...good, stateVector: "not base64!" });
    expect(read.ok).toBe(false);
    expect(codes(read)).toContain("schema");
  });

  it("refuses an update longer than the contract's own bound", () => {
    const long = "A".repeat(CRDT_DOC_LIMITS.maxUpdateEncodedLength + 4);
    const read = readCrdtDocSnapshot({ ...good, update: long });
    expect(read.ok).toBe(false);
    expect(codes(read)).toContain("limit");
  });

  it("refuses a schema major of zero", () => {
    const read = readCrdtDocSnapshot({ ...good, schemaMajor: 0 });
    expect(read.ok).toBe(false);
    expect(codes(read)).toContain("limit");
  });

  it("reads a schema major from the future rather than refusing it", () => {
    // The compatibility decision is the consumer's: a document it cannot edit is
    // still one it can be shown. Refusing here would take that choice away.
    const read = readCrdtDocSnapshot({ ...good, schemaMajor: CRDT_SCHEMA_MAJOR + 1 });
    expect(read.ok).toBe(true);
  });
});

describe("ack and delta readers", () => {
  it("accepts an ack and refuses one carrying a document id it invented", () => {
    expect(readCrdtDocAck({ doc: DOC, stateVector: B64 }).ok).toBe(true);
    const read = readCrdtDocAck({ doc: "a".repeat(CRDT_DOC_LIMITS.maxDocRefLength + 1), stateVector: B64 });
    expect(read.ok).toBe(false);
    expect(codes(read)).toContain("limit");
  });

  it("requires the delta to say whether it is empty", () => {
    const read = readCrdtDocDelta({ doc: DOC, stateVector: B64, update: B64 });
    expect(read.ok).toBe(false);
    expect(codes(read)).toContain("missing_field");
  });

  it("accepts a delta for ANOTHER document, which is why the port must echo-check", () => {
    // This is the case a reader structurally cannot catch: the value is a
    // completely valid delta, just not the one that was asked for. Recording it
    // here is what justifies the echo rule living in the caller.
    const read = readCrdtDocDelta({ doc: "cd_somebodyelse", stateVector: B64, update: B64, empty: false });
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value.doc).not.toBe(DOC);
  });
});

describe("doc list reader", () => {
  const good = { docs: [{ doc: DOC, title: "使用说明" }] };

  it("accepts a well-formed list, including an empty one", () => {
    const read = readCrdtDocList(good);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value).toEqual(good);
    expect(readCrdtDocList({ docs: [] }).ok).toBe(true);
  });

  it("refuses an entry carrying anything beyond ref and title", () => {
    // `path`, `owner`, `id` — every field a trusted answer must not leak has to
    // be a refusal here, not something a consumer learns to read around.
    const read = readCrdtDocList({ docs: [{ doc: DOC, title: "t", path: "/tmp/x" }] });
    expect(read.ok).toBe(false);
    expect(codes(read)).toContain("unknown_field");
  });

  it("refuses more documents than the contract allows a scope to hold", () => {
    const docs = Array.from({ length: CRDT_DOC_LIMITS.maxDocs + 1 }, (_, i) => ({
      doc: `cd_${String(i).padStart(16, "0")}`,
      title: "x",
    }));
    const read = readCrdtDocList({ docs });
    expect(read.ok).toBe(false);
    expect(codes(read)).toContain("limit");
  });

  it("refuses a title longer than its declared bound", () => {
    const read = readCrdtDocList({
      docs: [{ doc: DOC, title: "长".repeat(CRDT_DOC_LIMITS.maxTitleLength + 1) }],
    });
    expect(read.ok).toBe(false);
    expect(codes(read)).toContain("limit");
  });
});
