/**
 * A fair, process-local lock for work whose waiters have to be woken through
 * an external scheduler (an inbox, queue, webhook, and so on).
 *
 * Releasing the holder does not wake the whole queue. The oldest waiter gets
 * a bounded reservation and one wake. While that reservation is live, later
 * callers cannot barge in. If the waiter does not acquire before the lease
 * expires, the reservation is fenced off and the next waiter is offered the
 * lock. A late caller simply joins the tail.
 *
 * Delivery failures are distinct from stale waiters:
 *
 * - `retry` rotates the waiter to the tail and immediately tries somebody
 *   else. If every delivery fails, a bounded retry timer avoids a hot loop.
 * - `drop` removes a waiter that no longer exists or is no longer eligible.
 *
 * The coordinator deliberately owns no persistence and knows nothing about
 * tickets or agents. Its caller owns durable waiting intent and the wake
 * transport; this module owns ordering, fencing and timer cleanup.
 */

export type WakeDelivery = "delivered" | "retry" | "drop";

export type FairWakeLockEvent<Id extends PropertyKey> =
  | { type: "acquired"; id: Id; mode: "direct" | "reservation" | "reentrant" }
  | { type: "queued"; id: Id; position: number }
  | { type: "released"; id: Id }
  | { type: "cancelled"; id: Id; state: FairWakeLockCancellation }
  | { type: "restored"; ids: Id[] }
  | { type: "wake_selected" | "wake_delivered" | "wake_retry" | "wake_dropped" | "wake_error" | "reservation_expired"; id: Id }
  | { type: "closed" };

export interface FairWakeLockOptions<Id extends PropertyKey> {
  /** How long a successfully-woken queue head may claim its reservation. */
  leaseMs: number;
  /** Delay before retrying when every queued wake delivery failed. */
  retryMs?: number;
  /** Deliver one targeted wake to the selected waiter. */
  wake(id: Id): WakeDelivery;
  /** Observability hook. Exceptions are isolated from queue progress. */
  onWakeError?: (id: Id, error: unknown) => void;
  /** Observability hook for a delivered wake whose reservation expired. */
  onLeaseExpired?: (id: Id) => void;
  /** Complete transition audit hook. Exceptions cannot affect lock progress. */
  onEvent?: (event: FairWakeLockEvent<Id>) => void;
}

export type FairWakeLockAcquire<Id extends PropertyKey> =
  | { acquired: true; fresh: boolean }
  | {
      acquired: false;
      blockedBy: Id;
      blockedByState: "holder" | "reservation" | "queue";
      /** One-based place among waiters; the active holder is not counted. */
      position: number;
    };

export interface FairWakeLockCancellation {
  held: boolean;
  reserved: boolean;
  queued: boolean;
}

export class FairWakeLock<Id extends PropertyKey, Token extends PropertyKey> {
  private holder: { id: Id; token: Token } | null = null;
  private reserved: Id | null = null;
  private readonly queue: Id[] = [];
  private readonly queued = new Set<Id>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  readonly leaseMs: number;
  readonly retryMs: number;

  constructor(private readonly options: FairWakeLockOptions<Id>) {
    if (!Number.isFinite(options.leaseMs) || options.leaseMs <= 0) {
      throw new Error("FairWakeLock leaseMs must be positive");
    }
    const retryMs = options.retryMs ?? Math.min(options.leaseMs, 5_000);
    if (!Number.isFinite(retryMs) || retryMs <= 0) {
      throw new Error("FairWakeLock retryMs must be positive");
    }
    this.leaseMs = options.leaseMs;
    this.retryMs = retryMs;
  }

  get holderId(): Id | null {
    return this.holder?.id ?? null;
  }

  get reservedFor(): Id | null {
    return this.reserved;
  }

  isHolder(token: Token): boolean {
    return this.holder?.token === token;
  }

  /** The reservation stays first because it is still a parked waiter. */
  waiterIds(): Id[] {
    return [...(this.reserved === null ? [] : [this.reserved]), ...this.queue];
  }

  /**
   * Acquire immediately, claim this waiter's live reservation, or join the
   * FIFO queue. Repeated calls by one waiter never create duplicate entries.
   */
  acquire(id: Id, token: Token): FairWakeLockAcquire<Id> {
    if (this.closed) throw new Error("FairWakeLock is closed");
    if (this.holder?.id === id && this.holder.token === token) {
      this.emit({ type: "acquired", id, mode: "reentrant" });
      return { acquired: true, fresh: false };
    }

    if (!this.holder && this.reserved === id) {
      this.clearTimer();
      this.reserved = null;
      this.holder = { id, token };
      this.emit({ type: "acquired", id, mode: "reservation" });
      return { acquired: true, fresh: true };
    }

    if (!this.holder && this.reserved === null && this.queue.length === 0) {
      this.clearTimer();
      this.holder = { id, token };
      this.emit({ type: "acquired", id, mode: "direct" });
      return { acquired: true, fresh: true };
    }

    this.enqueue(id);

    // This state occurs only after every wake transport failed. A new caller
    // is useful evidence that the scheduler is alive, so retry the queued
    // deliveries now instead of idling until the backoff timer. FIFO is still
    // enforced: an older waiter is offered first.
    if (!this.holder && this.reserved === null) {
      this.promote();
      if (!this.holder && this.reserved === id) {
        this.clearTimer();
        this.reserved = null;
        this.removeQueued(id);
        this.holder = { id, token };
        this.emit({ type: "acquired", id, mode: "reservation" });
        return { acquired: true, fresh: true };
      }
    }

    const blockedBy = this.holder?.id ?? this.reserved ?? this.queue[0];
    if (blockedBy === undefined) {
      // All wake callbacks may have synchronously dropped their waiters,
      // including `id`. With nobody older left, take the free lock.
      this.clearTimer();
      this.holder = { id, token };
      this.emit({ type: "acquired", id, mode: "direct" });
      return { acquired: true, fresh: true };
    }
    const position = this.waiterIds().findIndex((waiter) => waiter === id) + 1;
    return {
      acquired: false,
      blockedBy,
      blockedByState: this.holder ? "holder" : this.reserved !== null ? "reservation" : "queue",
      position: Math.max(1, position),
    };
  }

  /** Only the exact holder token can release; stale releases are harmless. */
  release(token: Token): Id | null {
    if (this.closed || !this.holder || this.holder.token !== token) return null;
    const released = this.holder.id;
    this.holder = null;
    this.emit({ type: "released", id: released });
    this.promote();
    return released;
  }

  /**
   * Remove an id from every state. Cancelling a holder or reservation advances
   * the queue immediately; cancelling an ordinary waiter preserves order.
   */
  cancel(id: Id): FairWakeLockCancellation {
    if (this.closed) return { held: false, reserved: false, queued: false };
    const held = this.holder?.id === id;
    const reserved = this.reserved === id;
    const queued = this.removeQueued(id);
    if (held) this.holder = null;
    if (reserved) {
      this.clearTimer();
      this.reserved = null;
    }
    const state = { held, reserved, queued };
    if (held || reserved || queued) this.emit({ type: "cancelled", id, state });
    if ((held || reserved) && !this.holder) this.promote();
    return state;
  }

  /** Restore durable FIFO order after restart, then offer the free lock once. */
  restoreWaiters(ids: readonly Id[]): void {
    if (this.closed) throw new Error("FairWakeLock is closed");
    for (const id of ids) this.enqueue(id);
    this.emit({ type: "restored", ids: [...ids] });
    this.promote();
  }

  /** Clear process-local state and ensure no timeout survives shutdown. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimer();
    this.holder = null;
    this.reserved = null;
    this.queue.length = 0;
    this.queued.clear();
    this.emit({ type: "closed" });
  }

  private enqueue(id: Id): void {
    if (this.reserved === id || this.queued.has(id)) return;
    this.queued.add(id);
    this.queue.push(id);
    this.emit({ type: "queued", id, position: this.waiterIds().length });
  }

  private removeQueued(id: Id): boolean {
    if (!this.queued.delete(id)) return false;
    const index = this.queue.indexOf(id);
    if (index >= 0) this.queue.splice(index, 1);
    return true;
  }

  /** Select at most one waiter, containing every callback failure. */
  private promote(): void {
    if (this.closed || this.holder || this.reserved !== null) return;
    this.clearTimer();
    // Retry outcomes rotate to the tail. Bound one pass to its starting size
    // so a broken transport cannot turn release() into an infinite hot loop.
    let remaining = this.queue.length;
    while (remaining-- > 0 && this.queue.length > 0) {
      const next = this.queue.shift()!;
      this.queued.delete(next);
      this.reserved = next;
      this.emit({ type: "wake_selected", id: next });
      let outcome: WakeDelivery = "retry";
      try {
        outcome = this.options.wake(next);
      } catch (error) {
        this.emit({ type: "wake_error", id: next });
        this.safeCallback(() => this.options.onWakeError?.(next, error));
      }

      // A synchronous wake implementation may let the waiter acquire (and
      // even release) re-entrantly. Its newer state wins.
      if (this.reserved !== next) return;

      if (outcome === "delivered") {
        this.emit({ type: "wake_delivered", id: next });
        this.schedule(this.leaseMs, () => this.expire(next));
        return;
      }

      this.reserved = null;
      if (outcome === "retry") {
        this.emit({ type: "wake_retry", id: next });
        this.enqueue(next);
      } else {
        this.emit({ type: "wake_dropped", id: next });
      }
    }

    if (!this.holder && this.reserved === null && this.queue.length > 0) {
      this.schedule(this.retryMs, () => this.promote());
    }
  }

  private expire(id: Id): void {
    this.timer = null;
    if (this.closed || this.reserved !== id) return;
    this.reserved = null;
    this.emit({ type: "reservation_expired", id });
    // Waiting intent survives a missed offer. Rotate it behind everyone who
    // was already queued, then continue; durable callers mirror the same
    // rotation in onLeaseExpired so restart order stays identical.
    this.enqueue(id);
    this.safeCallback(() => this.options.onLeaseExpired?.(id));
    this.promote();
  }

  private schedule(ms: number, fn: () => void): void {
    if (this.closed || this.timer) return;
    const timer = setTimeout(fn, ms);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.timer = timer;
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private safeCallback(fn: () => void): void {
    try {
      fn();
    } catch {
      // Observability must never become a second lock failure mode.
    }
  }

  private emit(event: FairWakeLockEvent<Id>): void {
    this.safeCallback(() => this.options.onEvent?.(event));
  }
}
