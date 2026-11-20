/**
 * The consumer half of a `resource-stream/v1` stream carried on a proposal
 * transport.
 *
 * This is the generalisation of `@claude-bot/workspace-files-contract`'s
 * `RemoteTextSource`. The accounting it does is the part that is worth having
 * exactly one copy of, because getting it wrong produces the single outcome the
 * stream contract exists to make impossible: a PREFIX that every layer above
 * reports as a complete, digest-identified resource.
 *
 * ── The five things this source does that a naive one does not ────────────
 *
 *  1. **Measures the payload.** `resource-stream/v1`'s in-process guard bounds
 *     what a producer DECLARES, which is enough when the producer is trusted code
 *     in the same process — a wrong number there is a bug in code that could have
 *     handed over the bytes anyway. Across a transport it is not: an understated
 *     count lets a stream carry more than its cap while the accounting says
 *     otherwise. So the measured size is what the guard is given, and a frame
 *     whose claim disagrees with its own payload is a `protocol` termination.
 *  2. **States its cursor and checks the answer's.** `seq` travels on the pull so
 *     a producer can refuse a read that does not match its own position; a frame
 *     that comes back with a different one is two sides disagreeing about where
 *     they are, not a file to be silently reordered.
 *  3. **Compares the handle.** A handle names something the producer is holding;
 *     the only operation performed on it here is equality. A frame for another
 *     stream is a `protocol` termination, not a chunk.
 *  4. **Reconciles the end.** An `end` frame is a CLAIM that the resource is
 *     finished. Believed, a transport that dropped a chunk — or a hostile one
 *     that sent `end` after the first window — would produce exactly the prefix
 *     described above. So the end is checked against two independent facts: what
 *     this side actually received, and, when the header declared one, the whole
 *     resource's `totalBytes`.
 *  5. **Never retries.** A refusal is a terminal answer. Re-issuing a read a Gate
 *     refused is how one revoked grant becomes a stream of approval cards.
 *
 * ── What it does not do ────────────────────────────────────────────────────
 *
 * It does not decide the caps, wrap itself in the guard, or track itself in a
 * lifecycle. Those belong to the contract package, which knows its own limits
 * and owns its own teardown; a constructor that did all of it would be a
 * framework, and the caps in particular are a contract-level statement about the
 * resource rather than about the transport.
 */

import {
  RESOURCE_STREAM_LIMITS,
  RESOURCE_STREAM_REFUSALS,
  readResourceStreamResponse,
  type ContractResult,
  type ResourceStreamMetadata,
  type ResourceStreamPull,
  type ResourceStreamRefusalCode,
  type ResourceStreamSource,
} from "@claude-bot/resource-stream-contract";
import type { ProposalAnswer } from "./arrival.js";
import { foldRefusalInto, refusalVocabulary } from "./refusals.js";
import { RESERVED_PARAMS, STREAM_CLOSE_ACTION, STREAM_PULL_ACTION } from "./wire.js";

/**
 * How a contract's own refusal codes reach a stream's terminal vocabulary.
 *
 * `foldRefusalInto` from `refusals.ts` builds one of these; the default below is
 * the mapping `workspace-files/v1` arrived at, which is the sensible starting
 * point for any read contract: an ended scope is `expired`, an authority problem
 * is `denied`, a malformed request is `protocol`.
 */
export type StreamRefusalFold = (code: unknown, message: unknown) => {
  code: ResourceStreamRefusalCode;
  message: string;
};

/** `resource-stream/v1`'s own nine codes, as a vocabulary this kit can fold into. */
export const STREAM_REFUSALS = refusalVocabulary(RESOURCE_STREAM_REFUSALS, {
  fallback: "unavailable",
  maxMessageLength: RESOURCE_STREAM_LIMITS.maxMessageLength,
});

/**
 * The mapping a read contract almost always wants, as one call.
 *
 * `table` names only the codes whose meaning changes on the way across; anything
 * it does not name still passes through `STREAM_REFUSALS`' own fold, so an
 * unmapped code and an unknown code reach the same honest answer by the same
 * path rather than one of them being rendered as something it is not.
 */
export function streamRefusalFold(
  table: Readonly<Record<string, ResourceStreamRefusalCode>>,
  fallbackMessage: string,
): StreamRefusalFold {
  const fold = foldRefusalInto(STREAM_REFUSALS, table);
  return (code, message) => {
    const refusal = fold(code, message, fallbackMessage);
    return { code: refusal.code, message: refusal.message };
  };
}

export interface RemoteStreamOptions<T> {
  /** How to reach the far side. `binding` is supplied by the remote call. */
  ask(action: string, params: Readonly<Record<string, string>>): Promise<ProposalAnswer>;
  /** The header the far side published when the stream was opened. */
  readonly metadata: ResourceStreamMetadata;
  /** The opaque handle the far side minted. Compared, never parsed. */
  readonly handle: string;
  /** The contract's strict reader for one chunk's payload. */
  readonly readChunk: (value: unknown) => ContractResult<T>;
  /** How to size a decoded chunk. Only the contract knows how to measure `T`. */
  readonly measure: (chunk: T) => number;
  /** The contract's own per-chunk ceiling, if narrower than the stream's. */
  readonly maxChunkBytes?: number;
  /** Turn a wire refusal into a stream terminal. */
  readonly fold: StreamRefusalFold;
  /** The sentences this source says. In the product's language, like every other. */
  readonly messages: RemoteStreamMessages;
}

export interface RemoteStreamMessages {
  readonly closed: string;
  readonly badFrame: string;
  readonly wrongStream: string;
  readonly outOfOrder: string;
  readonly badPayload: string;
  readonly sizeMismatch: string;
  readonly chunkTooLarge: string;
  readonly overran: string;
  readonly endMismatch: string;
  readonly truncated: string;
  readonly refusedWithoutReason: string;
}

/**
 * The producer half of one remote stream.
 *
 * Hand the result to `createResourceStream` from `@claude-bot/resource-stream-contract`:
 * that is the guard that assigns `seq`, enforces exactly one terminal, and applies
 * the hard caps. This source supplies what the guard cannot — the transport, the
 * payload reader, and the measurement.
 */
export function createRemoteStreamSource<T>(options: RemoteStreamOptions<T>): ResourceStreamSource<T> {
  const { ask, metadata, handle, readChunk, measure, fold, messages } = options;
  const chunkCeiling = Math.min(options.maxChunkBytes ?? RESOURCE_STREAM_LIMITS.maxChunkBytes, RESOURCE_STREAM_LIMITS.maxChunkBytes);

  let seq = 0;
  let closed = false;
  /** What actually arrived, counted here rather than taken from a frame. */
  let received = 0;
  let bytes = 0;

  const protocolPull = (message: string): ResourceStreamPull<T> => ({
    kind: "refused",
    code: "protocol",
    message,
  });

  return {
    metadata,

    async pull(): Promise<ResourceStreamPull<T>> {
      if (closed) return { kind: "refused", code: "closed", message: messages.closed };
      const answer = await ask(STREAM_PULL_ACTION, {
        [RESERVED_PARAMS.handle]: handle,
        // Stated rather than implied, so a producer can refuse a pull that does
        // not match its own cursor instead of silently reordering a resource.
        [RESERVED_PARAMS.seq]: String(seq),
      });
      if (!answer.ok) {
        const refusal = fold(answer.code, answer.message || messages.refusedWithoutReason);
        return { kind: "refused", code: refusal.code, message: refusal.message };
      }

      const frame = readResourceStreamResponse(answer.result);
      if (!frame.ok) return protocolPull(messages.badFrame);
      if (frame.value.handle !== handle) return protocolPull(messages.wrongStream);
      if (frame.value.kind === "end") {
        // A mismatch is `protocol` rather than `unavailable` on purpose: it is
        // the other side breaking the contract, not a resource being
        // unreachable, and the consumer must not be able to mistake it for a
        // partial read it could resume.
        if (frame.value.chunks !== received || frame.value.bytes !== bytes) {
          return protocolPull(messages.endMismatch);
        }
        if (metadata.totalBytes !== undefined && bytes !== metadata.totalBytes) {
          return protocolPull(messages.truncated);
        }
        return { kind: "end" };
      }
      if (frame.value.kind === "refused") {
        return { kind: "refused", code: frame.value.code, message: frame.value.message };
      }
      if (frame.value.kind !== "chunk") return protocolPull(messages.badFrame);
      if (frame.value.seq !== seq) return protocolPull(messages.outOfOrder);

      const chunk = readChunk(frame.value.value);
      if (!chunk.ok) return protocolPull(messages.badPayload);
      // Measured, never believed. See the file docstring.
      const size = measure(chunk.value);
      if (!Number.isInteger(size) || size < 0) return protocolPull(messages.badPayload);
      if (size !== frame.value.bytes) return protocolPull(messages.sizeMismatch);
      if (size > chunkCeiling) {
        return { kind: "refused", code: "too_large", message: messages.chunkTooLarge };
      }
      if (metadata.totalBytes !== undefined && bytes + size > metadata.totalBytes) {
        return protocolPull(messages.overran);
      }

      seq += 1;
      received += 1;
      bytes += size;
      return { kind: "chunk", value: chunk.value, bytes: size };
    },

    close(): void {
      if (closed) return;
      closed = true;
      // Best effort by definition: the channel may already be gone, and there is
      // nobody left to tell if it is. The trusted side closes this scope's
      // streams on its own when the instance ends, so a lost close frame leaks
      // nothing.
      void ask(STREAM_CLOSE_ACTION, { [RESERVED_PARAMS.handle]: handle }).catch(() => undefined);
    },
  };
}
