/**
 * The constants two halves of a resource stream must agree on.
 *
 * They are numbers rather than policy: a producer that exceeds one of them has
 * broken the contract, and the consumer side refuses and closes rather than
 * truncating. "Truncated but reported as complete" is the single outcome this
 * whole contract exists to make impossible, so every bound below has a matching
 * terminal refusal instead of a silent clamp.
 *
 * The contract bounds the WINDOW, not the total: one chunk is what either side
 * holds at a time, and pulls are single-in-flight, so a stream of any length
 * runs in bounded memory. The whole-stream defaults are therefore numeric
 * representation bounds; a consumer that buffers everything states its own
 * smaller total through `ResourceStreamCaps`, which can only narrow.
 */

export const RESOURCE_STREAM_CONTRACT = "resource-stream/v1";

export const RESOURCE_STREAM_LIMITS = Object.freeze({
  /** Bytes one chunk may carry. */
  maxChunkBytes: 256 * 1024,
  /** Bytes one whole stream may carry. Representation bound, not policy. */
  maxStreamBytes: Number.MAX_SAFE_INTEGER,
  /** Chunks one whole stream may carry; also bounds `seq`. Representation bound. */
  maxChunks: Number.MAX_SAFE_INTEGER,
  /** An opaque stream handle, as carried by a transport adapter. */
  maxHandleLength: 128,
  /** Refusal text, which is written for a person and ends up in a log. */
  maxMessageLength: 200,
  maxMediaTypeLength: 128,
  /** The payload contract id, e.g. `workspace-files/v1#text-chunk`. */
  maxPayloadLength: 120,
  /** `sha256:` + 64 hex. */
  maxDigestLength: 71,
});

/**
 * Every way a stream can end other than completing.
 *
 * A closed vocabulary because the consumer has to *decide* something: retrying
 * makes sense for none of them (this contract never retries), but showing a
 * person "the file is bigger than this viewer can open" and "your permission was
 * revoked" are different sentences.
 */
export const RESOURCE_STREAM_REFUSALS = Object.freeze([
  /** The consumer already finished or closed this stream. */
  "closed",
  /** The trusted side ended it: a scope closed, a grant was revoked. */
  "cancelled",
  /** The handle is no longer known to the producer. */
  "expired",
  /** Authority refused the read. */
  "denied",
  /** The resource is gone. */
  "not_found",
  /** A declared bound was exceeded. Never a truncated success. */
  "too_large",
  /** The resource cannot be produced under this contract at all. */
  "unsupported",
  /** The producer failed; nothing is claimed about how much is missing. */
  "unavailable",
  /** The other side broke the contract (bad sequence, bad frame, double pull). */
  "protocol",
] as const);

export type ResourceStreamRefusalCode = (typeof RESOURCE_STREAM_REFUSALS)[number];

export function isResourceStreamRefusalCode(value: unknown): value is ResourceStreamRefusalCode {
  return typeof value === "string" && (RESOURCE_STREAM_REFUSALS as readonly string[]).includes(value);
}

/**
 * A stream handle, as it crosses a transport.
 *
 * Deliberately narrow and deliberately never parsed: it names something the
 * producer is holding, and the only operation performed on it is lookup. The
 * grammar exists so a handle cannot be mistaken for a path, a URL or a JSON
 * fragment by anything downstream that gets careless.
 */
const HANDLE = /^[A-Za-z0-9_-]{8,128}$/;

/** `sha256:<64 lowercase hex>` — the only digest form this contract states. */
const DIGEST = /^sha256:[0-9a-f]{64}$/;

export function isResourceStreamHandle(value: unknown): value is string {
  return typeof value === "string" && HANDLE.test(value);
}

export function isResourceDigest(value: unknown): value is string {
  return typeof value === "string" && DIGEST.test(value);
}
