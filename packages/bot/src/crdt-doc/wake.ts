/**
 * The trusted half of ADR 0006, for collaborative documents: turn "this
 * document changed" into "wake the instances that hold a ref to it".
 *
 * ── What this hub is, and is not ───────────────────────────────────────────
 *
 * It is a fan-out table plus two budgets. On one side, the `crdt-doc/v1`
 * provider reports every scope it opens (`onScopeOpened` hands over the
 * ref → document map) and closes; on the other, the document store reports
 * every successful merge (`onChanged`). The hub joins the two and calls
 * `deliver(instanceKey, binding, ref)` — a trusted-side callback the
 * composition root points at the Session Plus coordinator, which emits the
 * content-free `wake` instance event.
 *
 * It is NOT an authorisation path and carries no content: a wake names a ref
 * the scope was already handed at open, so it can never disclose a document
 * the scope could not address, and the View's response is its own `propose`,
 * which still passes the capability Gate (ADR 0006 §3).
 *
 * ── The two budgets, and why both are trusted-side ─────────────────────────
 *
 * Debounce per (scope, document): a burst of merges collapses to ONE wake on
 * the trailing edge, because the untrusted side's self-restraint is not a
 * guarantee and every wake invites a counted `propose`. A per-instance rolling
 * ceiling on top (`WAKE_WINDOW_MESSAGES` per `PORT_WINDOW_MS`): past it wakes
 * are DROPPED, which is safe precisely because a wake carries nothing — the
 * next one means exactly the same thing (§5.2).
 *
 * ── Who does not get woken ─────────────────────────────────────────────────
 *
 * The scope that made the change: the provider passes its own scope key as
 * the merge origin, and the author already holds the acknowledgement with the
 * post-merge state vector. Waking it would spend one of its counted proposals
 * on learning what it just did (ADR 0006 §9.3 chose "not the initiator").
 */

import { PORT_WINDOW_MS, WAKE_DEBOUNCE_MS, WAKE_WINDOW_MESSAGES } from "@claude-bot/web-trust/frame-protocol";
import type { ResourceProviderContext } from "../agent-resources/types.js";
import type { CrdtDocumentDescriptor } from "./types.js";

export interface CrdtWakeHubOptions {
  /**
   * Emit one wake to one App instance. `instanceKey` is the catalog identity
   * the provider scope was opened under — the Session Plus coordinator minted
   * it, so it is the one that can map it back to a live tab.
   */
  deliver: (instanceKey: string, binding: string, ref: string) => void;
  debounceMs?: number;
  windowMs?: number;
  maxPerWindow?: number;
  now?: () => number;
  /** Injected so a test does not have to run a real clock. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface WakeSubscription {
  /** The provider scope's derived key; also what a merge origin names. */
  scope: string;
  instanceKey: string;
  binding: string;
  /** document id → the ref THIS scope was handed for it. */
  docs: Map<string, string>;
  /** (document id) → pending trailing-edge timer. */
  timers: Map<string, unknown>;
  /** Delivery timestamps inside the rolling window. */
  delivered: number[];
}

export class CrdtWakeHub {
  private readonly subscriptions = new Map<string, WakeSubscription>();
  private readonly deliver: CrdtWakeHubOptions["deliver"];
  private readonly debounceMs: number;
  private readonly windowMs: number;
  private readonly maxPerWindow: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private stopped = false;

  constructor(options: CrdtWakeHubOptions) {
    this.deliver = options.deliver;
    this.debounceMs = options.debounceMs ?? WAKE_DEBOUNCE_MS;
    this.windowMs = options.windowMs ?? PORT_WINDOW_MS;
    this.maxPerWindow = options.maxPerWindow ?? WAKE_WINDOW_MESSAGES;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** The provider's `onScopeOpened`. Trusted-side to trusted-side, synchronous. */
  scopeOpened(context: ResourceProviderContext, refs: ReadonlyMap<string, CrdtDocumentDescriptor>): void {
    if (this.stopped) return;
    const docs = new Map<string, string>();
    for (const [ref, document] of refs) docs.set(document.id, ref);
    this.subscriptions.set(context.scope, {
      scope: context.scope,
      instanceKey: context.instance,
      binding: context.binding,
      docs,
      timers: new Map(),
      delivered: [],
    });
  }

  /** The provider's `onScopeClosed`. After this, no wake can name the scope. */
  scopeClosed(context: ResourceProviderContext): void {
    const subscription = this.subscriptions.get(context.scope);
    if (!subscription) return;
    this.subscriptions.delete(context.scope);
    for (const timer of subscription.timers.values()) this.clearTimer(timer);
    subscription.timers.clear();
  }

  /**
   * The store's `onChanged`. `origin` is whatever the writer passed to
   * `applyUpdate` — for provider merges it is the writing scope's key, and a
   * subscription with the same key is the author, who is not woken.
   */
  changed(docId: string, origin?: unknown): void {
    if (this.stopped) return;
    for (const subscription of this.subscriptions.values()) {
      if (subscription.scope === origin) continue;
      const ref = subscription.docs.get(docId);
      if (ref === undefined) continue;
      if (subscription.timers.has(docId)) continue; // already scheduled; wakes coalesce
      const timer = this.setTimer(() => {
        subscription.timers.delete(docId);
        this.emit(subscription, ref);
      }, this.debounceMs);
      subscription.timers.set(docId, timer);
    }
  }

  /** Tear down every timer. The hub refuses everything afterwards. */
  stop(): void {
    this.stopped = true;
    for (const subscription of this.subscriptions.values()) {
      for (const timer of subscription.timers.values()) this.clearTimer(timer);
      subscription.timers.clear();
    }
    this.subscriptions.clear();
  }

  /** Test/diagnostics. */
  get openSubscriptions(): number {
    return this.subscriptions.size;
  }

  private emit(subscription: WakeSubscription, ref: string): void {
    if (this.stopped || !this.subscriptions.has(subscription.scope)) return;
    const at = this.now();
    subscription.delivered = subscription.delivered.filter((stamp) => at - stamp < this.windowMs);
    if (subscription.delivered.length >= this.maxPerWindow) return; // dropped, deliberately
    subscription.delivered.push(at);
    try {
      this.deliver(subscription.instanceKey, subscription.binding, ref);
    } catch {
      /* a broken deliverer loses a hint, never a document */
    }
  }
}
