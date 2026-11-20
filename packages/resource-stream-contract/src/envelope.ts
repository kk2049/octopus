/**
 * The wire framing a MessagePort (or any other) adapter carries.
 *
 * `stream.ts` defines the semantics; this file defines what those semantics look
 * like as JSON, and — more importantly — refuses anything that is not exactly
 * that. The rules are the ones the rest of this repository's contracts use:
 * unknown fields are a refusal rather than something to ignore, every string and
 * number is bounded, and nothing throws at the caller.
 *
 * Why a validator at all when the same process built the frame: because the
 * frame does not stay in the same process. The consumer of this contract is a
 * bundle on another origin behind a port, and "the other side is our own code"
 * is exactly the assumption that stops being true one release later.
 */

import {
  IssueBag,
  boundedIntAt,
  boundedStringAt,
  objectAt,
  refuseUnknownFields,
  type ContractResult,
} from "./issues.js";
import {
  RESOURCE_STREAM_CONTRACT,
  RESOURCE_STREAM_LIMITS,
  isResourceDigest,
  isResourceStreamHandle,
  isResourceStreamRefusalCode,
  type ResourceStreamRefusalCode,
} from "./limits.js";
import type { ResourceStreamMetadata } from "./stream.js";

// ── metadata ──

const METADATA_FIELDS = ["payload", "mediaType", "totalBytes", "digest"] as const;

export function readResourceStreamMetadata(
  value: unknown,
  at = "metadata",
): ContractResult<ResourceStreamMetadata> {
  const bag = new IssueBag();
  const row = objectAt(bag, value, at);
  if (!row) return bag.fail();
  refuseUnknownFields(bag, row, METADATA_FIELDS, at);
  const payload = boundedStringAt(bag, row, "payload", at, RESOURCE_STREAM_LIMITS.maxPayloadLength);
  const mediaType = boundedStringAt(bag, row, "mediaType", at, RESOURCE_STREAM_LIMITS.maxMediaTypeLength);
  const totalBytes = boundedIntAt(bag, row, "totalBytes", at, RESOURCE_STREAM_LIMITS.maxStreamBytes, {
    optional: true,
  });
  let digest: string | null = null;
  if (row.digest !== undefined) {
    if (!isResourceDigest(row.digest)) bag.add("identifier", "digest must be sha256:<64 hex>", `${at}.digest`);
    else digest = row.digest;
  }
  if (!bag.empty) return bag.fail();
  const out: {
    payload: string;
    mediaType: string;
    totalBytes?: number;
    digest?: string;
  } = { payload: payload!, mediaType: mediaType! };
  if (totalBytes !== null) out.totalBytes = totalBytes;
  if (digest !== null) out.digest = digest;
  return { ok: true, value: out };
}

// ── requests: consumer → producer ──

export interface ResourceStreamPullFrame {
  contract: typeof RESOURCE_STREAM_CONTRACT;
  kind: "pull";
  handle: string;
  /**
   * The chunk index the consumer expects next.
   *
   * It is stated rather than implied so a producer can refuse a pull that does
   * not match its own cursor. That turns "the two sides disagree about where we
   * are" into a `protocol` refusal instead of a silently reordered file.
   */
  seq: number;
}

export interface ResourceStreamCloseFrame {
  contract: typeof RESOURCE_STREAM_CONTRACT;
  kind: "close";
  handle: string;
}

export type ResourceStreamRequestFrame = ResourceStreamPullFrame | ResourceStreamCloseFrame;

const PULL_FIELDS = ["contract", "kind", "handle", "seq"] as const;
const CLOSE_FIELDS = ["contract", "kind", "handle"] as const;

export function readResourceStreamRequest(value: unknown): ContractResult<ResourceStreamRequestFrame> {
  const bag = new IssueBag();
  const row = objectAt(bag, value, "request");
  if (!row) return bag.fail();
  if (row.contract !== RESOURCE_STREAM_CONTRACT) {
    bag.add("schema", `contract must be ${RESOURCE_STREAM_CONTRACT}`, "request.contract");
    return bag.fail();
  }
  if (row.kind !== "pull" && row.kind !== "close") {
    bag.add("schema", "kind must be `pull` or `close`", "request.kind");
    return bag.fail();
  }
  refuseUnknownFields(bag, row, row.kind === "pull" ? PULL_FIELDS : CLOSE_FIELDS, "request");
  const handle = boundedStringAt(bag, row, "handle", "request", RESOURCE_STREAM_LIMITS.maxHandleLength);
  if (handle !== null && !isResourceStreamHandle(handle)) {
    bag.add("identifier", "handle must be a bounded opaque token", "request.handle");
  }
  if (row.kind === "close") {
    if (!bag.empty) return bag.fail();
    return { ok: true, value: { contract: RESOURCE_STREAM_CONTRACT, kind: "close", handle: handle! } };
  }
  const seq = boundedIntAt(bag, row, "seq", "request", RESOURCE_STREAM_LIMITS.maxChunks - 1);
  if (!bag.empty) return bag.fail();
  return { ok: true, value: { contract: RESOURCE_STREAM_CONTRACT, kind: "pull", handle: handle!, seq: seq! } };
}

// ── responses: producer → consumer ──

export interface ResourceStreamOpenFrame {
  contract: typeof RESOURCE_STREAM_CONTRACT;
  kind: "open";
  handle: string;
  metadata: ResourceStreamMetadata;
}

export interface ResourceStreamChunkFrame {
  contract: typeof RESOURCE_STREAM_CONTRACT;
  kind: "chunk";
  handle: string;
  seq: number;
  bytes: number;
  /** The payload contract validates this; here it is only carried. */
  value: unknown;
}

export interface ResourceStreamEndFrame {
  contract: typeof RESOURCE_STREAM_CONTRACT;
  kind: "end";
  handle: string;
  chunks: number;
  bytes: number;
}

export interface ResourceStreamRefusedFrame {
  contract: typeof RESOURCE_STREAM_CONTRACT;
  kind: "refused";
  handle: string;
  code: ResourceStreamRefusalCode;
  message: string;
}

export type ResourceStreamResponseFrame =
  | ResourceStreamOpenFrame
  | ResourceStreamChunkFrame
  | ResourceStreamEndFrame
  | ResourceStreamRefusedFrame;

const OPEN_FIELDS = ["contract", "kind", "handle", "metadata"] as const;
const CHUNK_FIELDS = ["contract", "kind", "handle", "seq", "bytes", "value"] as const;
const END_FIELDS = ["contract", "kind", "handle", "chunks", "bytes"] as const;
const REFUSED_FIELDS = ["contract", "kind", "handle", "code", "message"] as const;

export function readResourceStreamResponse(value: unknown): ContractResult<ResourceStreamResponseFrame> {
  const bag = new IssueBag();
  const row = objectAt(bag, value, "response");
  if (!row) return bag.fail();
  if (row.contract !== RESOURCE_STREAM_CONTRACT) {
    bag.add("schema", `contract must be ${RESOURCE_STREAM_CONTRACT}`, "response.contract");
    return bag.fail();
  }
  const kind = row.kind;
  if (kind !== "open" && kind !== "chunk" && kind !== "end" && kind !== "refused") {
    bag.add("schema", "kind must be `open`, `chunk`, `end` or `refused`", "response.kind");
    return bag.fail();
  }
  const fields =
    kind === "open" ? OPEN_FIELDS : kind === "chunk" ? CHUNK_FIELDS : kind === "end" ? END_FIELDS : REFUSED_FIELDS;
  refuseUnknownFields(bag, row, fields, "response");
  const handle = boundedStringAt(bag, row, "handle", "response", RESOURCE_STREAM_LIMITS.maxHandleLength);
  if (handle !== null && !isResourceStreamHandle(handle)) {
    bag.add("identifier", "handle must be a bounded opaque token", "response.handle");
  }

  if (kind === "open") {
    const metadata = readResourceStreamMetadata(row.metadata, "response.metadata");
    if (!metadata.ok) return { ok: false, issues: [...bag.drain(), ...metadata.issues] };
    if (!bag.empty) return bag.fail();
    return {
      ok: true,
      value: { contract: RESOURCE_STREAM_CONTRACT, kind: "open", handle: handle!, metadata: metadata.value },
    };
  }

  if (kind === "chunk") {
    const seq = boundedIntAt(bag, row, "seq", "response", RESOURCE_STREAM_LIMITS.maxChunks - 1);
    const bytes = boundedIntAt(bag, row, "bytes", "response", RESOURCE_STREAM_LIMITS.maxChunkBytes);
    if (!("value" in row)) bag.add("missing_field", "missing value", "response");
    if (!bag.empty) return bag.fail();
    return {
      ok: true,
      value: {
        contract: RESOURCE_STREAM_CONTRACT,
        kind: "chunk",
        handle: handle!,
        seq: seq!,
        bytes: bytes!,
        value: row.value,
      },
    };
  }

  if (kind === "end") {
    const chunks = boundedIntAt(bag, row, "chunks", "response", RESOURCE_STREAM_LIMITS.maxChunks);
    const bytes = boundedIntAt(bag, row, "bytes", "response", RESOURCE_STREAM_LIMITS.maxStreamBytes);
    if (!bag.empty) return bag.fail();
    return {
      ok: true,
      value: { contract: RESOURCE_STREAM_CONTRACT, kind: "end", handle: handle!, chunks: chunks!, bytes: bytes! },
    };
  }

  if (!isResourceStreamRefusalCode(row.code)) {
    bag.add("schema", "code must be a resource-stream refusal code", "response.code");
  }
  const message = boundedStringAt(bag, row, "message", "response", RESOURCE_STREAM_LIMITS.maxMessageLength);
  if (!bag.empty) return bag.fail();
  return {
    ok: true,
    value: {
      contract: RESOURCE_STREAM_CONTRACT,
      kind: "refused",
      handle: handle!,
      code: row.code as ResourceStreamRefusalCode,
      message: message!,
    },
  };
}
