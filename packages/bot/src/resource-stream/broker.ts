/**
 * The trusted side of `resource-stream/v1`: a scoped, handle-addressed pull broker.
 *
 * ── What it adds to `createResourceStream` ─────────────────────────────────
 *
 * The contract's guard already enforces the per-stream rules — one pull in
 * flight, monotonic `seq`, one terminal, hard caps. What it cannot know is that
 * a stream BELONGS to something with a lifetime. This broker supplies exactly
 * that and nothing else:
 *
 *  · a random 192-bit handle, so a stream is addressable across a transport
 *    without the address being guessable or meaning anything;
 *  · a scope, so `closeScope()` is one call rather than an inventory somebody
 *    has to keep — and so a handle minted for one scope is refused when
 *    presented by another, whatever the transport claims;
 *  · a per-scope ceiling on concurrently open streams, because every open
 *    stream is a resource somewhere and "the consumer opened ten thousand" must
 *    be a refusal rather than a memory graph.
 *
 * ── Why the sequence number is checked here as well ────────────────────────
 *
 * A transport adapter states which chunk it expects. The guard would happily
 * serve the next one regardless, and the two sides would then disagree about
 * where they are in the file — silently, and in a way that looks like corruption
 * rather than a protocol error. Checking it turns that into one `protocol`
 * refusal at the first mismatch.
 *
 * ── What it is not ────────────────────────────────────────────────────────
 *
 * It has no HTTP route, no persistence and no reconnect. A handle is valid for
 * this process and this scope; there is no durable cursor to resume from, which
 * is a deliberate v1 boundary rather than something left to do.
 */

import { randomBytes } from "node:crypto";
import {
  createResourceStream,
  type ResourceStream,
  type ResourceStreamCaps,
  type ResourceStreamRead,
  type ResourceStreamSource,
} from "@claude-bot/resource-stream-contract";

export interface ResourceStreamBrokerOptions {
  /** Narrowed caps applied to every stream this broker opens. */
  caps?: ResourceStreamCaps;
  /** Concurrently open streams one scope may hold. */
  maxStreamsPerScope?: number;
}

export type BrokerOpen<T> =
  | { ok: true; handle: string; stream: ResourceStream<T> }
  | { ok: false; code: "too_many_streams" };

interface Entry {
  scope: string;
  stream: ResourceStream<unknown>;
  /** The chunk index a transport must ask for next. */
  nextSeq: number;
}

const DEFAULT_MAX_STREAMS_PER_SCOPE = 8;

/** `rs_` + 192 bits, base64url — printable, unguessable, and never parsed. */
function newHandle(): string {
  return `rs_${randomBytes(24).toString("base64url")}`;
}

export class ResourceStreamBroker {
  private readonly entries = new Map<string, Entry>();
  private readonly byScope = new Map<string, Set<string>>();

  constructor(private readonly options: ResourceStreamBrokerOptions = {}) {}

  /**
   * Register one source under a fresh handle.
   *
   * The returned `stream` is a thin face over the SAME guard the handle
   * addresses — not a second object with its own state. That matters because an
   * in-process consumer holds the object while a transport adapter holds the
   * handle, and if only one of them told the broker it was finished, the other
   * would leave a dead entry occupying this scope's ceiling forever.
   */
  open<T>(scope: string, source: ResourceStreamSource<T>, caps: ResourceStreamCaps = {}): BrokerOpen<T> {
    const held = this.byScope.get(scope);
    const ceiling = positiveInt(this.options.maxStreamsPerScope) ?? DEFAULT_MAX_STREAMS_PER_SCOPE;
    if (held && held.size >= ceiling) return { ok: false, code: "too_many_streams" };

    const guarded = createResourceStream(source, intersectCaps(this.options.caps, caps)) as ResourceStream<unknown>;
    const handle = newHandle();
    this.entries.set(handle, { scope, stream: guarded, nextSeq: 0 });
    if (held) held.add(handle);
    else this.byScope.set(scope, new Set([handle]));

    const facade: ResourceStream<T> = {
      contract: guarded.contract,
      metadata: guarded.metadata,
      next: () => this.advance(handle, guarded) as Promise<ResourceStreamRead<T>>,
      close: async () => {
        await this.release(handle);
        // Idempotent, and needed for the case where the entry is already gone:
        // releasing twice must still be releasing, not a no-op that skipped it.
        await guarded.close();
      },
    };
    return { ok: true, handle, stream: facade };
  }

  /**
   * Serve one pull by handle.
   *
   * `scope` is the CALLER's scope, established by whatever authenticated it —
   * never something the caller stated alongside the handle. A mismatch answers
   * `expired` rather than "wrong scope": a caller that guessed a handle learns
   * nothing about whether it exists.
   */
  async pull(scope: string, handle: string, seq: number): Promise<ResourceStreamRead<unknown>> {
    const entry = this.entries.get(handle);
    if (!entry || entry.scope !== scope) {
      return { kind: "refused", code: "expired", message: "这条资源流不存在或已经结束。" };
    }
    if (seq !== entry.nextSeq) {
      await this.release(handle);
      return { kind: "refused", code: "protocol", message: "资源流的读取顺序不一致，已经关闭。" };
    }
    return await this.advance(handle, entry.stream);
  }

  /**
   * One step of the shared state machine, whichever face asked for it.
   *
   * A terminal releases the entry here rather than at the two call sites, so
   * "the stream ended" and "the broker stopped holding it" cannot come apart.
   * Once the entry is gone the guard itself answers, which is how a consumer
   * that keeps pulling after the end gets `closed` instead of an invention.
   */
  private async advance(handle: string, guarded: ResourceStream<unknown>): Promise<ResourceStreamRead<unknown>> {
    const entry = this.entries.get(handle);
    if (!entry) return await guarded.next();
    const read = await guarded.next();
    if (read.kind === "chunk") entry.nextSeq += 1;
    else await this.release(handle);
    return read;
  }

  /** Close one stream. Idempotent, like the stream's own `close()`. */
  async close(scope: string, handle: string): Promise<boolean> {
    const entry = this.entries.get(handle);
    if (!entry || entry.scope !== scope) return false;
    await this.release(handle);
    return true;
  }

  /**
   * Cancel every stream this scope holds.
   *
   * The teardown half of a revocation, a logout or an instance ending: from the
   * moment it returns there is no handle left that can produce another byte, and
   * every source has been released.
   */
  async closeScope(scope: string): Promise<number> {
    const handles = this.byScope.get(scope);
    if (!handles) return 0;
    const victims = [...handles];
    for (const handle of victims) await this.release(handle);
    return victims.length;
  }

  /** Diagnostics and tests: how many streams are open, in total or per scope. */
  openStreams(scope?: string): number {
    if (scope === undefined) return this.entries.size;
    return this.byScope.get(scope)?.size ?? 0;
  }

  private async release(handle: string): Promise<void> {
    const entry = this.entries.get(handle);
    if (!entry) return;
    this.entries.delete(handle);
    const held = this.byScope.get(entry.scope);
    if (held) {
      held.delete(handle);
      if (held.size === 0) this.byScope.delete(entry.scope);
    }
    await entry.stream.close();
  }
}

/** Per-open policy may only narrow the broker's process-level policy. */
function intersectCaps(base: ResourceStreamCaps | undefined, local: ResourceStreamCaps): ResourceStreamCaps {
  const out: ResourceStreamCaps = {};
  for (const key of ["maxChunkBytes", "maxStreamBytes", "maxChunks"] as const) {
    const left = positiveInt(base?.[key]);
    const right = positiveInt(local[key]);
    const value = left === undefined ? right : right === undefined ? left : Math.min(left, right);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function positiveInt(value: number | undefined): number | undefined {
  return Number.isInteger(value) && (value as number) > 0 ? value : undefined;
}
