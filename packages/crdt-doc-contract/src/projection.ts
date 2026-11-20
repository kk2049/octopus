/**
 * What a consumer of `crdt-doc/v1` may see.
 *
 * ── The field list IS the boundary ─────────────────────────────────────────
 *
 * An answer may carry the echoed doc ref, a schema major, a state vector and an
 * update — all of them opaque bytes or numbers that mean something only to a
 * CRDT library. It may NOT carry:
 *
 *   a file path, a storage key, a database id, a log offset
 *   who else has the document open, who wrote which part, a client id list
 *   owner · credential · app · scope · instance handle
 *   grant · capability · context id · pending-call id
 *
 * Not filtered — absent. The interesting one is the third line: a CRDT update
 * DOES carry client ids internally, and this contract does not project them,
 * decode them or promise anything about them. Presence — who is looking at the
 * document right now, where their cursor is — is deliberately not here at all;
 * design doc §15.4 puts awareness outside the persistent document, and a
 * contract that carried it in the same answer as the document state would be the
 * first step towards storing it.
 *
 * ── Why a schema major ─────────────────────────────────────────────────────
 *
 * Because §15.4 requires a compatibility check BEFORE opening: a document
 * written by a newer editor may use a shape this build's components cannot
 * render, and rendering it anyway produces silent data loss the moment somebody
 * types. It is a single integer rather than a structure because the only
 * decision a consumer makes with it is "edit / read-only / refuse".
 *
 * ── Why readers exist for shapes we also construct ─────────────────────────
 *
 * Because the constructing side and the reading side are different processes and
 * eventually different release versions. Unknown fields are refused rather than
 * ignored: a field this build does not understand is either a newer schema or a
 * typo that quietly turned something off.
 */

import {
  IssueBag,
  boundedIntAt,
  boundedStringAt,
  booleanAt,
  isResourceRef,
  objectAt,
  refuseUnknownFields,
  type ContractResult,
} from "@claude-bot/typed-port-kit";

import { CRDT_DOC_LIMITS, isBase64 } from "./contract.js";

/**
 * The document shapes this build's editors understand.
 *
 * One today. A snapshot announcing a higher major is opened READ-ONLY rather
 * than refused, because a person who cannot edit a document can still be shown
 * it — but a lower major is refused, since this build has no code that ever
 * wrote one and a document claiming to be older is a document something else
 * produced.
 */
export const CRDT_SCHEMA_MAJOR = 1;

/** Everything needed to construct a local replica from nothing. */
export interface CrdtDocSnapshot {
  /** The document this is for, echoed so a caller can check it. */
  readonly doc: string;
  /** The document shape. See `CRDT_SCHEMA_MAJOR`. */
  readonly schemaMajor: number;
  /** The trusted replica's state vector, base64. */
  readonly stateVector: string;
  /** The whole document as ONE update, base64. Never truncated. */
  readonly update: string;
}

/** What the trusted side answers when it has merged an update. */
export interface CrdtDocAck {
  readonly doc: string;
  /** The trusted replica's state vector AFTER the merge, base64. */
  readonly stateVector: string;
}

/** Everything that happened since a state vector the caller already had. */
export interface CrdtDocDelta {
  readonly doc: string;
  /** The trusted replica's state vector now, base64. */
  readonly stateVector: string;
  /** The diff, base64. Meaningful only when `empty` is false. */
  readonly update: string;
  /**
   * Whether the diff contains nothing.
   *
   * Stated rather than derived, because "an update that changes nothing" is not
   * an empty byte string in any CRDT encoding — it is a short, valid, non-empty
   * one — and a consumer that had to recognise it would need the CRDT library to
   * answer a question about the transport. A boolean is what lets a caller skip
   * a merge, and skipping merges is most of what a polling consumer does.
   */
  readonly empty: boolean;
}

/** One document a scope may open: the minted ref plus display text. */
export interface CrdtDocEntry {
  /** Opaque ref, meaningful only to the scope that answered. */
  readonly doc: string;
  /** Display title. Presentation text, never an identifier. */
  readonly title: string;
}

/** The answer to `list_docs`: everything this scope may reach, in stable order. */
export interface CrdtDocList {
  readonly docs: readonly CrdtDocEntry[];
}

const SNAPSHOT_FIELDS = ["doc", "schemaMajor", "stateVector", "update"] as const;
const ACK_FIELDS = ["doc", "stateVector"] as const;
const DELTA_FIELDS = ["doc", "stateVector", "update", "empty"] as const;
const LIST_FIELDS = ["docs"] as const;
const ENTRY_FIELDS = ["doc", "title"] as const;

/** @internal shared with the v2 readers. */
export function docAt(bag: IssueBag, row: Record<string, unknown>, at: string): string | null {
  const doc = boundedStringAt(bag, row, "doc", at, CRDT_DOC_LIMITS.maxDocRefLength);
  if (doc !== null && !isResourceRef(doc)) {
    bag.add("identifier", "doc must be a bounded printable reference", `${at}.doc`);
    return null;
  }
  return doc;
}

/** @internal shared with the v2 readers. */
export function base64At(
  bag: IssueBag,
  row: Record<string, unknown>,
  key: string,
  at: string,
  max: number,
): string | null {
  const raw = row[key];
  if (raw === undefined) {
    bag.add("missing_field", `missing ${key}`, at);
    return null;
  }
  if (typeof raw !== "string") {
    bag.add("field_type", `${key} must be a string`, at);
    return null;
  }
  if (raw.length > max) {
    bag.add("limit", `${key} is longer than ${max} characters`, `${at}.${key}`);
    return null;
  }
  if (!isBase64(raw, max)) {
    bag.add("schema", `${key} is not well-formed base64`, `${at}.${key}`);
    return null;
  }
  return raw;
}

export function readCrdtDocSnapshot(value: unknown, at = "snapshot"): ContractResult<CrdtDocSnapshot> {
  const bag = new IssueBag();
  const row = objectAt(bag, value, at);
  if (!row) return bag.fail();
  refuseUnknownFields(bag, row, SNAPSHOT_FIELDS, at);

  const doc = docAt(bag, row, at);
  // Bounded at 255 because it is a major version, not a build number; a value
  // outside a byte is a field that means something else.
  const schemaMajor = boundedIntAt(bag, row, "schemaMajor", at, 255, { min: 1 });
  const stateVector = base64At(bag, row, "stateVector", at, CRDT_DOC_LIMITS.maxStateVectorEncodedLength);
  const update = base64At(bag, row, "update", at, CRDT_DOC_LIMITS.maxUpdateEncodedLength);

  if (!bag.empty) return bag.fail();
  return { ok: true, value: { doc: doc!, schemaMajor: schemaMajor!, stateVector: stateVector!, update: update! } };
}

export function readCrdtDocAck(value: unknown, at = "ack"): ContractResult<CrdtDocAck> {
  const bag = new IssueBag();
  const row = objectAt(bag, value, at);
  if (!row) return bag.fail();
  refuseUnknownFields(bag, row, ACK_FIELDS, at);

  const doc = docAt(bag, row, at);
  const stateVector = base64At(bag, row, "stateVector", at, CRDT_DOC_LIMITS.maxStateVectorEncodedLength);

  if (!bag.empty) return bag.fail();
  return { ok: true, value: { doc: doc!, stateVector: stateVector! } };
}

export function readCrdtDocList(value: unknown, at = "list"): ContractResult<CrdtDocList> {
  const bag = new IssueBag();
  const row = objectAt(bag, value, at);
  if (!row) return bag.fail();
  refuseUnknownFields(bag, row, LIST_FIELDS, at);

  const raw = row.docs;
  if (!Array.isArray(raw)) {
    bag.add(raw === undefined ? "missing_field" : "field_type", "docs must be an array", at);
    return bag.fail();
  }
  if (raw.length > CRDT_DOC_LIMITS.maxDocs) {
    bag.add("limit", `docs is longer than ${CRDT_DOC_LIMITS.maxDocs} entries`, `${at}.docs`);
    return bag.fail();
  }
  const docs: CrdtDocEntry[] = [];
  raw.forEach((item, index) => {
    const itemAt = `${at}.docs[${index}]`;
    const entry = objectAt(bag, item, itemAt);
    if (!entry) return;
    refuseUnknownFields(bag, entry, ENTRY_FIELDS, itemAt);
    const doc = docAt(bag, entry, itemAt);
    const title = boundedStringAt(bag, entry, "title", itemAt, CRDT_DOC_LIMITS.maxTitleLength);
    if (doc !== null && title !== null) docs.push({ doc, title });
  });

  if (!bag.empty) return bag.fail();
  return { ok: true, value: { docs } };
}

export function readCrdtDocDelta(value: unknown, at = "delta"): ContractResult<CrdtDocDelta> {
  const bag = new IssueBag();
  const row = objectAt(bag, value, at);
  if (!row) return bag.fail();
  refuseUnknownFields(bag, row, DELTA_FIELDS, at);

  const doc = docAt(bag, row, at);
  const stateVector = base64At(bag, row, "stateVector", at, CRDT_DOC_LIMITS.maxStateVectorEncodedLength);
  const update = base64At(bag, row, "update", at, CRDT_DOC_LIMITS.maxUpdateEncodedLength);
  const empty = booleanAt(bag, row, "empty", at);

  if (!bag.empty) return bag.fail();
  return { ok: true, value: { doc: doc!, stateVector: stateVector!, update: update!, empty: empty! } };
}
