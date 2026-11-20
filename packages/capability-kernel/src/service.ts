/**
 * The public face. Four collaborators, wired once, no logic of its own beyond
 * lifecycle bookkeeping:
 *
 *   store     → the only representation of every durable fact   (sqlite-store)
 *   graph     → contexts, slots, capabilities, `authorize`      (core.ts)   ← TCB
 *   registry  → Objects, arg schemas, the adapter               (objects.ts)
 *   gate      → authorize + validate + policy + dispatch        (gate.ts)
 *   desk      → the PendingCall state machine                   (approval.ts)
 *
 * A reader auditing "can the wrong person reach a resource?" needs `core.ts` and
 * `gate.ts` and nothing else. That is the point of the split: the two files
 * together are shorter than the single kernel they replaced, and everything that
 * was crowding them — 500 lines of pending workflow, schema validation, byte
 * accounting, a write-through cache — is now somewhere a bug costs less.
 */

import { CapabilityGraph } from "./core.js";
import { Gate } from "./gate.js";
import { ObjectRegistry } from "./objects.js";
import { ApprovalDesk, type ApprovalOptions, type PendingResultView, type PendingView } from "./approval.js";
import { SqliteCapabilityStore } from "./sqlite-store.js";
import type { AuditRow, CapabilityStore, RootRef } from "./store.js";
import {
  type AuditRecord,
  type AuditSink,
  type BoundCapabilities,
  type ContextId,
  type GrantTerms,
  type InvokeResult,
  type ObjectDefinition,
  type ObjectId,
  type Operation,
  type Slot,
} from "./types.js";

export type { PendingState } from "./store.js";
export type { PendingView, PendingResultView } from "./approval.js";

export interface ServiceOptions extends ApprovalOptions {
  audit?: AuditSink;
  /** Injectable clock so tests do not sleep. */
  now?: () => number;
  /**
   * Durable home for Contexts, capabilities, slots, Object identity and pending
   * calls. Defaults to an in-memory SQLite database, which is right for a test
   * and wrong for production — a deployment passes a file.
   */
  store?: CapabilityStore;
  /**
   * How long a destroyed Context's rows are kept before collection. Collection
   * already skips any Context a pending row or a child still names; this grace
   * only has to outlast the pending TTL.
   */
  contextRetentionMs?: number;
}

// A production deployment destroys ~150 Contexts a minute (one per request);
// a day of grace kept ~200K dead graph rows for nothing.
const DEFAULT_CONTEXT_RETENTION_MS = 3600_000;
const AUDIT_PAGE = 500;

export class CapabilityService {
  private store: CapabilityStore;
  private graph: CapabilityGraph;
  private registry: ObjectRegistry;
  private gate: Gate;
  private desk: ApprovalDesk;
  private nowMs: () => number;
  private audit: AuditSink;
  private contextRetentionMs: number;
  /** Contexts whose holder released them while a descendant call was undecided. */
  private deferredDestroy = new Set<ContextId>();
  private lastCollect = 0;
  /** Where the first full audit walk continues; null once it has finished. */
  private auditCursor: number | null = 0;

  constructor(opts: ServiceOptions = {}) {
    this.nowMs = opts.now ?? Date.now;
    this.audit = opts.audit ?? (() => {});
    this.contextRetentionMs = opts.contextRetentionMs ?? DEFAULT_CONTEXT_RETENTION_MS;
    this.store = opts.store ?? new SqliteCapabilityStore(":memory:", { now: this.nowMs });
    const emit = (r: AuditRecord): void => this.emit(r);
    this.graph = new CapabilityGraph(this.store, this.nowMs);
    this.registry = new ObjectRegistry(this.store);
    this.gate = new Gate(this.graph, this.registry, emit, this.nowMs);
    this.desk = new ApprovalDesk(this.gate, this.graph, this.store, emit, this.nowMs, opts);
  }

  /**
   * Audit is evidence, never authority: a failing sink or a failing durable
   * write must not change a decision that already happened.
   */
  private emit(record: AuditRecord): void {
    try {
      if (!this.routineRead(record)) this.store.appendAudit(record);
    } catch {
      /* evidence, not authority */
    }
    try {
      this.audit(record);
    } catch {
      /* same */
    }
  }

  /**
   * An unattended `observe`/`read` call that was allowed and did not fail.
   *
   * Session polling makes these nearly every gate decision (~500K rows a day in
   * production) and nothing reads them back, so they are not durable evidence.
   * Denials, approval-required decisions, every approval-desk event, failures
   * and every `modify`/`execute` call stay on the trail; the `audit` sink still
   * receives everything.
   */
  private routineRead(r: Pick<AuditRow, "event" | "decision" | "objectId" | "operation">
    & { outcome?: string | null; approver?: string | null; pendingCallId?: string | null }): boolean {
    if (r.decision !== "allow" || r.approver || r.pendingCallId || !r.objectId) return false;
    if (r.event === "executed" ? r.outcome !== "succeeded" : r.event !== "invoked") return false;
    const effect = this.registry.specOf(r.objectId, r.operation)?.effect;
    return effect === "observe" || effect === "read";
  }

  /**
   * Trim the durable audit trail by one bounded page: rows older than `before`
   * (epoch ms), and routine reads (see `routineRead`) that an earlier version
   * still recorded. Returns true while more work is immediately available, so
   * a caller can pace small synchronous steps instead of one long delete.
   *
   * The first walk after construction covers the whole table, because those
   * routine reads can be anywhere in it. After that only the oldest end can
   * hold anything to delete. A row whose Object is not registered in this
   * process is kept until it ages out.
   */
  pruneAudit(before: number, limit = AUDIT_PAGE): boolean {
    const cutoff = new Date(before).toISOString();
    const page = this.store.auditPage(this.auditCursor ?? 0, limit);
    const doomed = page.filter((r) => r.at < cutoff || this.routineRead(r)).map((r) => r.seq);
    if (doomed.length) this.store.deleteAudit(doomed);
    // Trimming the oldest end: a page that was not entirely expired proves
    // nothing older remains, because rows are appended in time order.
    if (this.auditCursor === null) return doomed.length === limit;
    this.auditCursor = page.length === limit ? page[page.length - 1]!.seq : null;
    return this.auditCursor !== null;
  }

  // ── trusted control plane (never handed to app/controller/agent code) ──

  registerObject<B>(def: ObjectDefinition<B>): ObjectId {
    return this.registry.register(def);
  }

  hasObject(id: ObjectId): boolean {
    return this.registry.has(id);
  }

  rebindObject<B>(id: ObjectId, binding: B): void {
    this.registry.rebind(id, binding);
  }

  createContext(kind: string, metadata?: Record<string, string>, parent?: ContextId | null): ContextId {
    return this.graph.createContext(kind, metadata, parent ?? null);
  }

  /**
   * Mint the root authority over an Object.
   *
   * `terms.autoAllow` defaults to every requested right whose declared effect is
   * `observe` or `read` — so a root never auto-allows a modification or an
   * execution, and a new dangerous operation added to a registry is
   * approval-required from the moment it exists rather than from the moment
   * somebody remembers to classify it.
   */
  mintRoot(
    contextId: ContextId,
    slot: Slot,
    objectId: ObjectId,
    rights: Iterable<Operation>,
    terms?: Partial<GrantTerms>,
  ): void {
    const wanted = [...rights];
    const autoAllow =
      terms?.autoAllow
      ?? wanted.filter((op) => {
        const effect = this.registry.specOf(objectId, op)?.effect;
        return effect === "observe" || effect === "read";
      });
    this.graph.mintRoot(contextId, slot, objectId, wanted, { autoAllow }, this.registry.operationsOf(objectId));
  }

  derive(
    sourceContextId: ContextId,
    sourceSlot: Slot,
    targetContextId: ContextId,
    targetSlot: Slot,
    rights: Iterable<Operation>,
    terms?: Partial<GrantTerms>,
  ): void {
    this.graph.derive(sourceContextId, sourceSlot, targetContextId, targetSlot, rights, terms);
  }

  revoke(contextId: ContextId, slot: Slot): boolean {
    return this.graph.revoke(contextId, slot);
  }

  /**
   * End a Context.
   *
   *  - default (hard): the run/instance is over or revoked. Every undecided call
   *    in its SUBTREE expires with it, so an approval arriving afterwards fails
   *    closed.
   *  - `deferWhilePending`: the short-lived holder finished but a call somewhere
   *    below it is still waiting on a human. Approval re-runs the original call
   *    in the original Context, so tearing the ancestor down here would break
   *    it. The Context — and every ancestor deferred for the same reason — dies
   *    once the last descendant call is terminal, which the pending TTL
   *    guarantees happens.
   */
  destroyContext(contextId: ContextId, opts?: { deferWhilePending?: boolean }): void {
    this.sweep();
    if (opts?.deferWhilePending && this.desk.hasUndecided(contextId)) {
      this.deferredDestroy.add(contextId);
      return;
    }
    this.deferredDestroy.delete(contextId);
    this.graph.destroyContext(contextId);
    this.desk.expireWithin(contextId, "requesting context destroyed");
  }

  /** Is any call in this Context's subtree still undecided? */
  hasUndecidedPending(contextId: ContextId): boolean {
    return this.desk.hasUndecided(contextId);
  }

  contextIsLive(contextId: ContextId): boolean {
    return this.graph.contextIsLive(contextId);
  }

  /** Trusted control-plane inspection; never exposed on BoundCapabilities. */
  contextMetadata(contextId: ContextId): Readonly<Record<string, string>> | null {
    const metadata = this.graph.contextMetadata(contextId);
    return metadata ? Object.freeze({ ...metadata }) : null;
  }

  rightsOf(contextId: ContextId, slot: Slot): Operation[] {
    return this.graph.rightsOf(contextId, slot);
  }

  /** The terms in force on a slot — chiefly, what it may do unsupervised. */
  termsOf(contextId: ContextId, slot: Slot): GrantTerms {
    return this.graph.termsOf(contextId, slot);
  }

  /** Live roots over an Object — how a control plane finds the root it minted before the last restart. */
  rootsOf(objectId: ObjectId): RootRef[] {
    return this.graph.rootsOf(objectId);
  }

  /** Which slots a Context has bound at all — "none" and "revoked" are different states. */
  slotsOf(contextId: ContextId): Slot[] {
    return this.graph.slotsOf(contextId);
  }

  /** Which Object a slot points at. Diagnostic: `derive` can never change it. */
  objectIdOf(contextId: ContextId, slot: Slot): ObjectId | null {
    return this.graph.objectIdOf(contextId, slot);
  }

  /**
   * Hand an untrusted runtime its whole security API. The returned object closes
   * over the Context id; nothing on it accepts an identity.
   */
  bind(contextId: ContextId): BoundCapabilities {
    const self = this;
    return {
      request(slot: Slot, operation: Operation, args: unknown): Promise<InvokeResult> {
        return self.request(contextId, String(slot ?? ""), String(operation ?? ""), args);
      },
      result(pendingCallId: string) {
        const view = self.resultOf(contextId, String(pendingCallId ?? ""));
        // Deliberately narrower than PendingResultView: the caller gets what
        // happened, not the id it already has or anything about other Contexts.
        return view
          ? {
              state: view.state,
              outcome: view.outcome,
              result: view.result,
              reason: view.reason,
              retrySafe: view.retrySafe,
            }
          : null;
      },
    };
  }

  // ── the request path ──

  private async request(
    contextId: ContextId,
    slot: Slot,
    operation: Operation,
    args: unknown,
  ): Promise<InvokeResult> {
    this.sweep();
    const outcome = await this.gate.invoke(contextId, slot, operation, args, null);
    switch (outcome.status) {
      case "approval_required":
        return this.desk.create({
          contextId,
          slot,
          objectId: outcome.objectId,
          operation,
          canonicalArgs: outcome.canonicalArgs,
          argsHash: outcome.argsHash,
          summary: outcome.summary,
          // Read from the registry HERE rather than inside the gate: it is not
          // an authorization decision, and the gate is the file that has to stay
          // short enough to check by eye. `specOf` is total on `retrySafe`
          // because `register()` resolves the default.
          retrySafe: this.registry.specOf(outcome.objectId, operation)?.retrySafe === true,
        });
      case "succeeded":
        return { status: "succeeded", result: outcome.result };
      case "denied":
        return { status: "denied", reason: outcome.reason };
      case "unknown":
        return { status: "unknown", reason: outcome.reason };
      default:
        return { status: "failed", reason: outcome.reason,
          ...(outcome.dependency ? { dependency: outcome.dependency } : {}) };
    }
  }

  resultOf(contextId: ContextId, pendingCallId: string): PendingResultView | null {
    this.sweep();
    return this.desk.resultOf(contextId, pendingCallId);
  }

  // ── approval ──

  listPending(approver: string): PendingView[] {
    this.sweep();
    return this.desk.list(approver);
  }

  getPending(id: string, approver: string): PendingView | null {
    this.sweep();
    return this.desk.get(id, approver);
  }

  async approve(pendingCallId: string, approver: string): Promise<InvokeResult> {
    this.sweep();
    const out = await this.desk.approve(pendingCallId, approver);
    this.sweepDeferred();
    return out;
  }

  reject(pendingCallId: string, approver: string): boolean {
    const ok = this.desk.reject(pendingCallId, approver);
    this.sweepDeferred();
    return ok;
  }

  /** Test/diagnostics: current state of one pending record. */
  pendingState(id: string): PendingState | null {
    return this.desk.pendingState(id);
  }

  close(): void {
    this.store.close?.();
  }

  // ── housekeeping ──

  private sweep(): void {
    this.desk.sweep();
    this.sweepDeferred();
    this.collect();
  }

  /** Finish deferred teardowns whose descendant calls have all been decided. */
  private sweepDeferred(): void {
    for (const ctx of this.deferredDestroy) {
      if (!this.desk.hasUndecided(ctx)) {
        this.deferredDestroy.delete(ctx);
        this.graph.destroyContext(ctx);
      }
    }
  }

  /**
   * Collect the rows of Contexts that ended long enough ago that nothing can
   * still name them.
   *
   * Without this the graph tables grow for the life of the deployment — and the
   * bot side creates a Context per HTTP request, so "the life of the deployment"
   * meant tens of thousands of rows a day per open browser tab. Throttled to
   * once a minute, one bounded candidate page per sweep, so requests can run
   * between batches even when retention has a backlog.
   */
  private collect(): void {
    const now = this.nowMs();
    if (now - this.lastCollect < 60_000) return;
    this.lastCollect = now;
    this.store.deleteDestroyedContextsBefore(now - this.contextRetentionMs);
  }
}

type PendingState = import("./store.js").PendingState;
