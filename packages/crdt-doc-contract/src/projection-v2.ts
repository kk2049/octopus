/**
 * What a consumer of `crdt-doc/v2` may see on the wire.
 *
 * The same field lists as v1 (`projection.ts`), with one substitution: where v1
 * always carried `update`, a v2 answer carries EITHER `update` (it fit one
 * window) OR `stream` (a `resource-stream/v1` open frame whose chunks, joined,
 * are that update). Never both and never neither — a reader that accepted both
 * would let a producer hand two different documents to two consumers, and one
 * that accepted neither would turn "the document is empty" into a missing field.
 *
 * These are wire shapes. The remote adapter (`remote-v2.ts`) drains the stream
 * and hands its caller the same `CrdtDocSnapshot` / `CrdtDocDelta` v1 does, so
 * an editor written against `CrdtDocPort` cannot tell which version it holds.
 */

import {
  readResourceStreamResponse,
  type ResourceStreamMetadata,
} from "@claude-bot/resource-stream-contract";
import {
  IssueBag,
  boundedIntAt,
  booleanAt,
  objectAt,
  refuseUnknownFields,
  type ContractResult,
} from "@claude-bot/typed-port-kit";

import { isBase64 } from "./contract.js";
import {
  CRDT_DOC_V2_LIMITS,
  CRDT_UPDATE_CHUNK_PAYLOAD,
  CRDT_UPDATE_MEDIA_TYPE,
} from "./contract-v2.js";
import { base64At, docAt, type CrdtDocAck, type CrdtDocDelta, type CrdtDocSnapshot } from "./projection.js";

/** The stream half of an answer: the handle to pull and what it promises. */
export interface CrdtUpdateStream {
  readonly handle: string;
  readonly metadata: ResourceStreamMetadata & { readonly totalBytes: number };
}

/** An update as v2 carries it: inline when it fits one window, else a stream. */
export type CrdtUpdateCarrier = { readonly update: string } | { readonly stream: CrdtUpdateStream };

export type CrdtDocSnapshotWire = Omit<CrdtDocSnapshot, "update"> & CrdtUpdateCarrier;
export type CrdtDocDeltaWire = Omit<CrdtDocDelta, "update"> & CrdtUpdateCarrier;

/**
 * The answer to one `apply_update`. `staged` is present exactly when the call
 * carried a part that did not complete its update: it is the byte count the
 * trusted side now holds, i.e. the next part's `offset`.
 */
export interface CrdtDocAckWire extends CrdtDocAck {
  readonly staged?: number;
}

/** One stream chunk: a padding-free base64 slice, except possibly the last. */
export interface CrdtUpdateChunk {
  readonly data: string;
}

const SNAPSHOT_FIELDS = ["doc", "schemaMajor", "stateVector", "update", "stream"] as const;
const DELTA_FIELDS = ["doc", "stateVector", "update", "stream", "empty"] as const;
const ACK_FIELDS = ["doc", "stateVector", "staged"] as const;
const CHUNK_FIELDS = ["data"] as const;

function carrierAt(bag: IssueBag, row: Record<string, unknown>, at: string): CrdtUpdateCarrier | null {
  const inline = row.update !== undefined;
  const streamed = row.stream !== undefined;
  if (inline === streamed) {
    bag.add("schema", "exactly one of update and stream must be present", at);
    return null;
  }
  if (inline) {
    const update = base64At(bag, row, "update", at, CRDT_DOC_V2_LIMITS.maxPartEncodedLength);
    return update === null ? null : { update };
  }
  const frame = readResourceStreamResponse(row.stream);
  if (!frame.ok) {
    bag.add("schema", "stream is not a resource-stream/v1 frame", `${at}.stream`);
    return null;
  }
  if (frame.value.kind !== "open") {
    bag.add("schema", "stream must be an `open` frame", `${at}.stream`);
    return null;
  }
  const metadata = frame.value.metadata;
  if (
    metadata.payload !== CRDT_UPDATE_CHUNK_PAYLOAD
    || metadata.mediaType !== CRDT_UPDATE_MEDIA_TYPE
    || metadata.totalBytes === undefined
  ) {
    // `totalBytes` is required: it is what lets the consumer refuse a stream a
    // transport ended early instead of merging a prefix of somebody's document.
    bag.add("schema", `stream must announce ${CRDT_UPDATE_CHUNK_PAYLOAD} with totalBytes`, `${at}.stream.metadata`);
    return null;
  }
  return { stream: { handle: frame.value.handle, metadata: { ...metadata, totalBytes: metadata.totalBytes } } };
}

export function readCrdtDocSnapshotWire(value: unknown, at = "snapshot"): ContractResult<CrdtDocSnapshotWire> {
  const bag = new IssueBag();
  const row = objectAt(bag, value, at);
  if (!row) return bag.fail();
  refuseUnknownFields(bag, row, SNAPSHOT_FIELDS, at);
  const doc = docAt(bag, row, at);
  const schemaMajor = boundedIntAt(bag, row, "schemaMajor", at, 255, { min: 1 });
  const stateVector = base64At(bag, row, "stateVector", at, CRDT_DOC_V2_LIMITS.maxStateVectorEncodedLength);
  const carrier = carrierAt(bag, row, at);
  if (!bag.empty) return bag.fail();
  return { ok: true, value: { doc: doc!, schemaMajor: schemaMajor!, stateVector: stateVector!, ...carrier! } };
}

export function readCrdtDocDeltaWire(value: unknown, at = "delta"): ContractResult<CrdtDocDeltaWire> {
  const bag = new IssueBag();
  const row = objectAt(bag, value, at);
  if (!row) return bag.fail();
  refuseUnknownFields(bag, row, DELTA_FIELDS, at);
  const doc = docAt(bag, row, at);
  const stateVector = base64At(bag, row, "stateVector", at, CRDT_DOC_V2_LIMITS.maxStateVectorEncodedLength);
  const empty = booleanAt(bag, row, "empty", at);
  const carrier = carrierAt(bag, row, at);
  if (empty === true && carrier && "stream" in carrier) {
    bag.add("schema", "an empty delta is never streamed", `${at}.stream`);
  }
  if (!bag.empty) return bag.fail();
  return { ok: true, value: { doc: doc!, stateVector: stateVector!, empty: empty!, ...carrier! } };
}

export function readCrdtDocAckWire(value: unknown, at = "ack"): ContractResult<CrdtDocAckWire> {
  const bag = new IssueBag();
  const row = objectAt(bag, value, at);
  if (!row) return bag.fail();
  refuseUnknownFields(bag, row, ACK_FIELDS, at);
  const doc = docAt(bag, row, at);
  const stateVector = base64At(bag, row, "stateVector", at, CRDT_DOC_V2_LIMITS.maxStateVectorEncodedLength);
  const staged = row.staged === undefined
    ? undefined
    : boundedIntAt(bag, row, "staged", at, Number.MAX_SAFE_INTEGER, { min: 1 });
  if (!bag.empty) return bag.fail();
  return {
    ok: true,
    value: { doc: doc!, stateVector: stateVector!, ...(staged === undefined ? {} : { staged: staged! }) },
  };
}

export function readCrdtUpdateChunk(value: unknown, at = "chunk"): ContractResult<CrdtUpdateChunk> {
  const bag = new IssueBag();
  const row = objectAt(bag, value, at);
  if (!row) return bag.fail();
  refuseUnknownFields(bag, row, CHUNK_FIELDS, at);
  if (typeof row.data !== "string" || row.data.length === 0 || !isBase64(row.data, CRDT_DOC_V2_LIMITS.maxPartEncodedLength)) {
    bag.add("schema", "data must be non-empty, bounded base64", `${at}.data`);
    return bag.fail();
  }
  return { ok: true, value: { data: row.data } };
}
