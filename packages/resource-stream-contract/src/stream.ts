/**
 * `resource-stream/v1` — a bounded, pull-based, cancellable read.
 *
 * ── Why this shape and not a `ReadableStream` ───────────────────────────────
 *
 * WHATWG Streams already define the semantics we want — a consumer that pulls,
 * backpressure that follows from pulling, and a cancel that reaches the source
 * (<https://streams.spec.whatwg.org/>). What we cannot do is put a DOM
 * `ReadableStream` *object* in the ABI: the two halves of this contract are a
 * Node process holding a file handle and a bundle inside a sandboxed iframe, and
 * the thing between them is one MessagePort. Transferring a stream object is not
 * something either side can rely on, and a polyfill would put a runtime in a
 * package whose whole point is having none.
 *
 * So the ABI is the smallest shape a MessagePort adapter can implement —
 * `next()` and an idempotent `close()` — and the semantics stay the ones the
 * spec already settled.
 *
 * ── The five properties this file enforces ─────────────────────────────────
 *
 *  1. **One `next()` in flight.** A second concurrent call is a consumer bug,
 *     and it is answered with a terminal `protocol` refusal rather than queued.
 *     Queueing would make the producer's "at most one read outstanding"
 *     invariant a matter of politeness.
 *  2. **`seq` starts at 0 and only ever goes up by one.** It is assigned HERE,
 *     not stated by the source, so "cannot skip, cannot go backwards" is
 *     structural for every producer built on this.
 *  3. **Exactly one terminal.** After `end` or a refusal the source is never
 *     pulled again, and later `next()` calls answer `closed`.
 *  4. **Hard caps fail closed.** Per chunk, per stream, and per chunk count. A
 *     stream that hits one is refused with `too_large`, never truncated into
 *     something that looks complete.
 *  5. **`close()` is idempotent and releases the source once**, including while
 *     a pull is in flight.
 *
 * ── What v1 deliberately is not ────────────────────────────────────────────
 *
 * No seek, no tee, no generic patch, no priority, no durable cursor, no
 * cross-process resume, no unbounded history. A CRDT may later carry bounded
 * updates as chunks, but it does not get to drop Yjs's own causality and state
 * vectors on the way.
 */

import {
  RESOURCE_STREAM_CONTRACT,
  RESOURCE_STREAM_LIMITS,
  isResourceStreamRefusalCode,
  type ResourceStreamRefusalCode,
} from "./limits.js";

/**
 * What the chunks are and, when the producer can say so up front, how much of
 * them there is. Only these four fields; a reader refuses anything else.
 */
export interface ResourceStreamMetadata {
  /** The payload contract, e.g. `workspace-files/v1#text-chunk`. */
  readonly payload: string;
  /** Media type of the underlying resource. */
  readonly mediaType: string;
  /** Byte length of the whole resource, when the producer knows it. */
  readonly totalBytes?: number;
  /** `sha256:<64 hex>` identity of the whole resource, when the producer knows it. */
  readonly digest?: string;
}

/** One answer to one `next()`. Exactly one of these is terminal. */
export type ResourceStreamRead<T> =
  | { readonly kind: "chunk"; readonly seq: number; readonly value: T }
  | { readonly kind: "end"; readonly chunks: number; readonly bytes: number }
  | { readonly kind: "refused"; readonly code: ResourceStreamRefusalCode; readonly message: string };

/**
 * What a producer answers when it is pulled.
 *
 * It states `bytes` rather than letting the guard measure `value`, because the
 * guard is generic over T and "how big is this" is not a question it can ask
 * about an arbitrary payload.
 *
 * ── What that means, and what it does NOT mean ─────────────────────────────
 *
 * The guard bounds what the producer DECLARES. When the producer is trusted code
 * in this process, that is the whole story: a wrong number is a bug in code that
 * could have handed over the bytes anyway.
 *
 * Across a trust or transport boundary it is not. An adapter that took a remote
 * frame's `bytes` on faith would let an understated count carry more than the
 * caps allow while the accounting said otherwise. So an adapter MEASURES the
 * payload it decoded, gives the guard the measured value, and treats a frame
 * whose claim disagrees with its own content as a `protocol` termination. That
 * belongs to the adapter because only the adapter knows how to measure T —
 * `@claude-bot/workspace-files-contract`'s remote client is the worked example.
 */
export type ResourceStreamPull<T> =
  | { kind: "chunk"; value: T; bytes: number }
  | { kind: "end" }
  | { kind: "refused"; code: ResourceStreamRefusalCode; message: string };

/**
 * The producer half.
 *
 * `pull()` is called at most once at a time and never after a terminal answer.
 * `close()` is called exactly once and must tolerate being called while a pull
 * is still in flight — that is what cancellation is.
 */
export interface ResourceStreamSource<T> {
  readonly metadata: ResourceStreamMetadata;
  pull(): Promise<ResourceStreamPull<T>>;
  close(): void | Promise<void>;
}

/** The consumer half. Metadata is read-only; there is nothing else to inspect. */
export interface ResourceStream<T> {
  readonly contract: typeof RESOURCE_STREAM_CONTRACT;
  readonly metadata: ResourceStreamMetadata;
  next(): Promise<ResourceStreamRead<T>>;
  /** Release the underlying resource. Safe to call repeatedly and after the end. */
  close(): Promise<void>;
}

/** A caller may narrow the contract's caps for one stream. It may not widen them. */
export interface ResourceStreamCaps {
  maxChunkBytes?: number;
  maxStreamBytes?: number;
  maxChunks?: number;
}

function refuse<T>(code: ResourceStreamRefusalCode, message: string): ResourceStreamRead<T> {
  return {
    kind: "refused",
    code,
    message: message
      .replace(/[\u0000-\u001f\u007f]/g, "\uFFFD")
      .slice(0, RESOURCE_STREAM_LIMITS.maxMessageLength),
  };
}

function narrow(requested: number | undefined, ceiling: number): number {
  if (!Number.isInteger(requested) || (requested as number) < 1) return ceiling;
  return Math.min(ceiling, requested as number);
}

/** Copy exactly the declared fields, so a producer cannot smuggle a fifth. */
function projectMetadata(value: ResourceStreamMetadata): ResourceStreamMetadata {
  const out: {
    payload: string;
    mediaType: string;
    totalBytes?: number;
    digest?: string;
  } = {
    payload: String(value?.payload ?? "").slice(0, RESOURCE_STREAM_LIMITS.maxPayloadLength),
    mediaType: String(value?.mediaType ?? "").slice(0, RESOURCE_STREAM_LIMITS.maxMediaTypeLength),
  };
  if (Number.isInteger(value?.totalBytes) && (value.totalBytes as number) >= 0) {
    out.totalBytes = value.totalBytes as number;
  }
  if (typeof value?.digest === "string" && value.digest.length <= RESOURCE_STREAM_LIMITS.maxDigestLength) {
    out.digest = value.digest;
  }
  return Object.freeze(out);
}

class GuardedResourceStream<T> implements ResourceStream<T> {
  readonly contract = RESOURCE_STREAM_CONTRACT;
  readonly metadata: ResourceStreamMetadata;

  private readonly caps: Required<ResourceStreamCaps>;
  private chunks = 0;
  private bytes = 0;
  private inFlight = false;
  /** A terminal answer has already been handed to the consumer. */
  private finished = false;
  /**
   * A terminal decided OUTSIDE the normal pull path — a double pull or a
   * `close()` that landed while a pull was still running. The in-flight call
   * returns this instead of the answer it is about to receive, which is what
   * makes "cancel means cancel" true rather than "cancel means one more chunk".
   */
  private aborted: ResourceStreamRead<T> | null = null;
  /**
   * The one close operation, shared by every caller.
   *
   * A boolean is not enough here: after a terminal answer `terminate()` starts
   * an asynchronous release. A later `await stream.close()` must join that
   * release rather than observe "close was started" and return while the file
   * handle is still open.
   */
  private sourceClose: Promise<void> | null = null;

  constructor(private readonly source: ResourceStreamSource<T>, caps: ResourceStreamCaps = {}) {
    this.metadata = projectMetadata(source.metadata);
    this.caps = {
      maxChunkBytes: narrow(caps.maxChunkBytes, RESOURCE_STREAM_LIMITS.maxChunkBytes),
      maxStreamBytes: narrow(caps.maxStreamBytes, RESOURCE_STREAM_LIMITS.maxStreamBytes),
      maxChunks: narrow(caps.maxChunks, RESOURCE_STREAM_LIMITS.maxChunks),
    };
  }

  async next(): Promise<ResourceStreamRead<T>> {
    if (this.finished) return refuse("closed", "这条资源流已经结束。");
    if (this.inFlight) {
      // Not queued: the producer's "one read outstanding" invariant has to be
      // a property of this object, not a habit of its callers.
      const answer = refuse<T>("protocol", "同一条资源流上不能同时发起两次读取。");
      return this.terminate(answer);
    }

    this.inFlight = true;
    let pulled: ResourceStreamPull<T>;
    try {
      pulled = await this.source.pull();
    } catch {
      // The error text is dropped on purpose. A producer's exception message is
      // the one place a canonical path reliably leaks across this boundary, and
      // the consumer can do nothing with it that it cannot do with the code.
      this.inFlight = false;
      return this.terminate(refuse<T>("unavailable", "资源流的生产方异常终止。"));
    }
    this.inFlight = false;
    if (this.aborted) return this.aborted;
    return this.accept(pulled);
  }

  async close(): Promise<void> {
    if (!this.finished) {
      this.finished = true;
      this.aborted = refuse<T>("closed", "这条资源流已经被关闭。");
    }
    await this.releaseSource();
  }

  private accept(pulled: ResourceStreamPull<T>): ResourceStreamRead<T> {
    if (!pulled || typeof pulled !== "object") {
      return this.terminate(refuse<T>("protocol", "资源流生产方返回了无法识别的帧。"));
    }
    if (pulled.kind === "end") {
      return this.terminate({ kind: "end", chunks: this.chunks, bytes: this.bytes });
    }
    if (pulled.kind === "refused") {
      const code = isResourceStreamRefusalCode(pulled.code) ? pulled.code : "protocol";
      return this.terminate(refuse<T>(code, String(pulled.message ?? "")));
    }
    if (pulled.kind !== "chunk") {
      return this.terminate(refuse<T>("protocol", "资源流生产方返回了无法识别的帧。"));
    }

    const size = pulled.bytes;
    if (!Number.isInteger(size) || size < 0) {
      return this.terminate(refuse<T>("protocol", "资源块没有声明合法的字节数。"));
    }
    if (size > this.caps.maxChunkBytes) {
      return this.terminate(refuse<T>("too_large", "资源块超过了单块上限。"));
    }
    if (this.chunks >= this.caps.maxChunks) {
      return this.terminate(refuse<T>("too_large", "资源流超过了分块数量上限。"));
    }
    if (this.bytes + size > this.caps.maxStreamBytes) {
      return this.terminate(refuse<T>("too_large", "资源流超过了总字节上限。"));
    }

    const seq = this.chunks;
    this.chunks += 1;
    this.bytes += size;
    return { kind: "chunk", seq, value: pulled.value };
  }

  /** One terminal, delivered once, and the source released with it. */
  private terminate(answer: ResourceStreamRead<T>): ResourceStreamRead<T> {
    this.finished = true;
    this.aborted = answer;
    void this.releaseSource();
    return answer;
  }

  private async releaseSource(): Promise<void> {
    if (!this.sourceClose) {
      this.sourceClose = Promise.resolve()
        .then(async () => await this.source.close())
        .catch(() => {
          // Releasing is best effort by definition: there is nobody left to
          // tell, and a throwing release must not become the consumer's problem.
        });
    }
    await this.sourceClose;
  }
}

/**
 * Wrap a pull source in the `resource-stream/v1` state machine.
 *
 * Every producer in this repository goes through here rather than implementing
 * `ResourceStream` directly, which is what makes the sequence, terminal and cap
 * rules one implementation instead of a convention.
 */
export function createResourceStream<T>(
  source: ResourceStreamSource<T>,
  caps: ResourceStreamCaps = {},
): ResourceStream<T> {
  return new GuardedResourceStream(source, caps);
}
