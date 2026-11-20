/**
 * The PendingCall state machine: "this needs a human" with exactly-once
 * semantics.
 *
 * ── What this layer can and cannot break ───────────────────────────────────
 *
 * It sits ABOVE the gate and holds no authority of its own. Approving does not
 * grant anything: `resume` re-runs the ORIGINAL call — same Context, same slot,
 * same operation, the canonical args as they were hashed — through the complete
 * gate again. Revocation, Context destruction, a code-version swap or a device
 * that changed hands all fail right there, after the human said yes.
 *
 * So the worst a bug in this file can do is execute a call the requester was
 * ALREADY entitled to make, twice or without consent. That is a serious bug and
 * it is a different class from the one `core.ts` can have: nothing here can
 * make one account reach another's resource. That is the whole reason the
 * pending machinery no longer lives inside the kernel — 250 lines came out of
 * the surface that must be perfect, without weakening any of it.
 *
 * Everything mutating is synchronous up to the claim, which is what makes
 * double-click, replay and concurrent approval collapse to at most one
 * execution on Node's single-threaded loop. The claim itself is a conditional
 * UPDATE, so it holds across processes and restarts too.
 */

import { randomBytes } from "node:crypto";
import type { CapabilityGraph } from "./core.js";
import type { Gate } from "./gate.js";
import type { CapabilityStore, PendingOutcome, PendingRow, PendingState } from "./store.js";
import {
  mintApprovalEvidence,
  type ApprovalEvidence,
  type AuditEvent,
  type AuditRecord,
  type ContextId,
  type InvokeResult,
  type Operation,
  type Slot,
  type TrustedSummary,
} from "./types.js";

/** What the trusted approval face may show. Server-authored strings only. */
export interface PendingView {
  id: string;
  title: string;
  target: string;
  details: string[];
  operation: Operation;
  requestedBy: Readonly<Record<string, string>>;
  createdAt: string;
  expiresAt: string;
  state: PendingState;
}

/**
 * What the ORIGINAL bound Context may learn about a dangerous call it made.
 * Note what is absent: the pending id alone gets you nothing — `resultOf` takes
 * the Context too, and refuses when the two do not match.
 */
export interface PendingResultView {
  id: string;
  state: PendingState;
  outcome: PendingOutcome | null;
  result: unknown;
  reason: string | null;
  /** The Object's declaration: is re-issuing this exact call safe? */
  retrySafe: boolean;
}

export interface ApprovalOptions {
  /** Default life of a PendingCall; a policy summary may shorten it. */
  pendingTtlMs?: number;
  /** Hard ceiling on unresolved PendingCalls held for one Context. */
  maxPendingPerContext?: number;
  /** How long a decided call's record stays queryable before cleanup. */
  resultRetentionMs?: number;
}

const DEFAULT_PENDING_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_PENDING_PER_CONTEXT = 16;
const DEFAULT_RESULT_RETENTION_MS = 24 * 3600_000;
const MIN_PENDING_TTL_MS = 30_000;

export class ApprovalDesk {
  private ttlMs: number;
  private maxPerContext: number;
  private retentionMs: number;

  constructor(
    private gate: Gate,
    private graph: CapabilityGraph,
    private store: CapabilityStore,
    private emitAudit: (record: AuditRecord) => void,
    private nowMs: () => number = Date.now,
    opts: ApprovalOptions = {},
  ) {
    this.ttlMs = opts.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS;
    this.maxPerContext = opts.maxPendingPerContext ?? DEFAULT_MAX_PENDING_PER_CONTEXT;
    this.retentionMs = opts.resultRetentionMs ?? DEFAULT_RESULT_RETENTION_MS;
    this.recoverInterrupted();
  }

  /**
   * A `claimed` row that survived into this boot is a call we approved and then
   * lost the process for. We cannot prove whether the adapter ran — and nothing
   * could, because the side effect happened on somebody else's laptop.
   *
   * What we CAN act on is the Object's own declaration about running it twice:
   *
   *  - **not retry-safe** (`exec`, `write_file`, `append_session`): terminal
   *    `unknown`, never auto-retried. This is the case that rules out durable
   *    execution as a whole — its central guarantee is "resume by replaying the
   *    step", and replaying an approved `rm -rf` is a second side effect the
   *    human consented to once.
   *  - **retry-safe** (the read-class calls): the human's decision was consumed
   *    by a claim we cannot account for, so hand the card BACK to them. Worst
   *    case the read happens twice, which is exactly what retry-safe declares to
   *    be acceptable.
   *
   * Note what recovery does NOT do in either branch: execute. Re-running the
   * call here would reach out to a real resource at boot, with no human present
   * and — since the Context's holder died with the process — usually nobody left
   * to read the result. "Safe to run twice" is permission to ASK again, not a
   * reason to act unattended.
   */
  private recoverInterrupted(): void {
    const now = this.nowMs();
    for (const row of this.store.listUndecided()) {
      if (row.state !== "claimed") continue;
      if (row.retrySafe && this.revive(row, now)) continue;
      this.store.finishPending(row.id, {
        state: "finished",
        outcome: "unknown",
        resultReason: "the process ended between approval and a recorded result",
        decidedAt: now,
      });
      this.emit(row, "executed", { outcome: "unknown", reason: "interrupted by restart" });
    }
  }

  /**
   * Put an interrupted retry-safe call back in front of its approver, on its
   * ORIGINAL deadline.
   *
   * Not a fresh window, and that is the whole bound: a card can never outlive
   * the expiry it was created with, however many times the process restarts. A
   * renewed window would have to be capped, and a cap computed from the row's
   * own `expiresAt` ratchets outward every time it is applied — which is a
   * restart loop keeping one card alive forever, arrived at by arithmetic.
   *
   * The cost is that a crash late in the window leaves nothing to revive, and
   * the call falls through to `unknown`. That is the right answer for it: the
   * human's window really did run out.
   */
  private revive(row: PendingRow, now: number): boolean {
    if (row.expiresAt <= now) return false;
    if (!this.store.requeuePending(row.id)) return false;
    this.emit({ ...row, state: "pending", approver: null, claimedAt: null }, "requeued", {
      reason: "restarted before the result was recorded; this call is safe to run again, so it needs your decision again",
      approver: row.approver ?? undefined,
    });
    return true;
  }

  /**
   * Record a call the policy wants a human to decide, and return the id that is
   * now authoritative for it.
   *
   * A retry of the SAME call joins the existing approval rather than queueing a
   * second side effect, and the store decides that atomically so two concurrent
   * identical requests cannot both create a card.
   */
  create(o: {
    contextId: ContextId;
    slot: Slot;
    objectId: string;
    operation: Operation;
    canonicalArgs: Record<string, unknown>;
    argsHash: string;
    summary: TrustedSummary;
    /** From the Object's registry, resolved by the service. See `PendingRow`. */
    retrySafe: boolean;
  }): { status: "approval_required"; pendingCallId: string } | { status: "denied"; reason: string } {
    const undecided = this.store.listUndecided();
    const mine = undecided.filter((p) => p.contextId === o.contextId);
    const isRetry = mine.some((p) => p.slot === o.slot && p.operation === o.operation && p.argsHash === o.argsHash);
    if (mine.length >= this.maxPerContext && !isRetry) {
      return { status: "denied", reason: "too many pending approvals for this context" };
    }
    const now = this.nowMs();
    const ttl = Math.max(MIN_PENDING_TTL_MS, Math.min(this.ttlMs, o.summary.ttlMs ?? this.ttlMs));
    const id = `pc_${randomBytes(16).toString("hex")}`;
    const row: PendingRow = {
      id,
      contextId: o.contextId,
      slot: o.slot,
      objectId: o.objectId,
      operation: o.operation,
      canonicalArgs: o.canonicalArgs,
      argsHash: o.argsHash,
      summaryJson: JSON.stringify(o.summary),
      allowedApprover: o.summary.allowedApprover,
      retrySafe: o.retrySafe,
      createdAt: now,
      expiresAt: now + ttl,
      state: "pending",
      approver: null,
      claimedAt: null,
      outcome: null,
      resultJson: null,
      resultReason: null,
      decidedAt: null,
    };
    const authoritative = this.store.insertPendingUnique(row);
    if (authoritative === id) this.emit(row, "pending_created", {});
    return { status: "approval_required", pendingCallId: authoritative };
  }

  // ── reading ──

  /** Pending calls this principal is entitled to decide. */
  list(approver: string): PendingView[] {
    this.sweep();
    return this.store
      .listPendingByApprover(approver)
      .filter((p) => p.state === "pending")
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((p) => this.viewOf(p));
  }

  get(id: string, approver: string): PendingView | null {
    this.sweep();
    const p = this.store.getPending(id);
    if (!p || p.allowedApprover !== approver) return null;
    return this.viewOf(p);
  }

  /**
   * The result of a dangerous call, for the Context that made it.
   *
   * `contextId` comes from the channel binding, exactly like a request does; the
   * pending id is a lookup key, not a credential. A Context may also read a call
   * made by one of its descendants (a Controller polling the run it started),
   * never one made by a sibling or a stranger.
   */
  resultOf(contextId: ContextId, pendingCallId: string): PendingResultView | null {
    this.sweep();
    const row = this.store.getPending(pendingCallId);
    if (!row) return null;
    // Walk UP from the call's Context, not down from the caller's: the question
    // is "is the asker an ancestor of the call", which is O(depth).
    if (!this.graph.isWithin(contextId, row.contextId)) return null;
    return {
      id: row.id,
      state: row.state,
      outcome: row.outcome,
      result: row.resultJson === null ? null : (JSON.parse(row.resultJson) as unknown),
      reason: row.resultReason,
      retrySafe: row.retrySafe,
    };
  }

  /** Is any call in this Context's subtree still undecided? */
  hasUndecided(contextId: ContextId): boolean {
    return this.store.listUndecided().some((p) => this.graph.isWithin(contextId, p.contextId));
  }

  /** Expire every undecided call inside a subtree that is being torn down. */
  expireWithin(contextId: ContextId, reason: string): void {
    for (const row of this.store.listUndecided()) {
      if (!this.graph.isWithin(contextId, row.contextId)) continue;
      if (this.store.finishPending(row.id, { state: "expired", decidedAt: this.nowMs() })) {
        this.emit(row, "expired", { reason });
      }
    }
  }

  pendingState(id: string): PendingState | null {
    return this.store.getPending(id)?.state ?? null;
  }

  // ── deciding ──

  /**
   * Approve exactly one saved call.
   *
   * `approver` MUST come from a server-side session, never from the request
   * body — this signature takes it as a parameter precisely so the HTTP layer
   * has to have resolved it before calling. The API accepts no operation,
   * target or args: there is nothing here to swap.
   */
  async approve(pendingCallId: string, approver: string): Promise<InvokeResult> {
    this.sweep();
    const p = this.store.getPending(pendingCallId);
    // @architecture flow=approval-resume step=precondition-deny after=human-decision role=refusal label="Refuse an invalid approval attempt" condition="record is missing, wrong principal, already terminal, or expired" outcome=deny authority=none terminal=true
    if (!p) return { status: "denied", reason: "unknown or expired approval request" };
    if (p.allowedApprover !== approver) {
      this.emit(p, "denied", { reason: "approver is not the entitled principal", approver });
      return { status: "denied", reason: "you are not entitled to approve this call" };
    }
    if (p.state !== "pending") {
      // Already decided. A retry must see the RECORDED outcome, never a second
      // execution — including after a restart, where the row is the only memory
      // the system has.
      return this.terminalResult(p, "approval already " + p.state);
    }
    if (this.nowMs() > p.expiresAt) {
      this.expire(p);
      return { status: "denied", reason: "approval request expired" };
    }
    // The durable CAS. Exactly one caller — in this process, in another, or
    // after a crash — gets true.
    // @architecture flow=approval-resume step=claim after=human-decision role=state label="Atomically claim one pending call" condition="pending record and entitled approver pass preconditions" outcome=claimed authority="authenticated entitled approver plus durable CAS"
    if (!this.store.claimPending(p.id, approver, this.nowMs())) {
      // @architecture flow=approval-resume step=claim-lost after=claim role=refusal label="Return the already-recorded decision" condition="durable compare-and-swap loses" outcome=recorded-or-deny authority="durable pending-call record" terminal=true
      const fresh = this.store.getPending(p.id);
      return fresh ? this.terminalResult(fresh, "approval already claimed") : { status: "denied", reason: "gone" };
    }
    this.emit(p, "claimed", { approver });
    this.emit(p, "approved", { approver });
    // @architecture flow=approval-resume step=resume after=claim role=control label="Resume the saved coordinates, not request fields" condition="durable claim succeeds" outcome=approval-evidence authority="saved Context, slot, Object, operation, args hash, and approver"
    return await this.resume({ ...p, approver, state: "claimed" });
  }

  reject(pendingCallId: string, approver: string): boolean {
    const p = this.store.getPending(pendingCallId);
    if (!p || p.state !== "pending" || p.allowedApprover !== approver) return false;
    const ok = this.store.finishPending(p.id, { state: "rejected", decidedAt: this.nowMs() });
    if (ok) this.emit(p, "rejected", { approver });
    return ok;
  }

  /**
   * Rebuild the saved call and run the FULL gate again. Internal only — the
   * evidence this mints is the one thing a policy will accept as "a human said
   * yes to exactly this", and it never leaves the package.
   */
  private async resume(p: PendingRow): Promise<InvokeResult> {
    const evidence: ApprovalEvidence = mintApprovalEvidence(
      p.id,
      p.contextId,
      p.slot,
      p.objectId,
      p.operation,
      p.argsHash,
      p.approver!,
    );
    let outcome;
    try {
      // @architecture flow=approval-resume step=recheck-gate after=resume role=gate label="Run the complete Gate again" condition="server mints evidence for the exact saved call" outcome=gate-outcome authority="opaque ApprovalEvidence plus original call coordinates" enforces=AUTH-002
      outcome = await this.gate.invoke(p.contextId, p.slot, p.operation, p.canonicalArgs, evidence);
    } catch (err) {
      // The adapter never ran: the gate refused before dispatch.
      const why = String((err as Error)?.message ?? err);
      // @architecture flow=approval-resume step=gate-throws after=recheck-gate role=outcome label="Translate a thrown recheck" condition="Gate throws before returning an outcome" outcome=failed authority="rechecked Gate result"
      return this.settle(p, "finished", "failed", null, why, { status: "failed", reason: why });
    }
    // EVERY branch reports what the store actually holds. A terminal transition
    // that did not happen means somebody else decided this call first, and
    // answering with our own computed outcome would tell the caller something
    // the record contradicts.
    switch (outcome.status) {
      case "succeeded":
        // @architecture flow=approval-resume step=resume-success after=recheck-gate role=outcome label="Accept the successful adapter result" condition="rechecked Gate succeeds" outcome=success authority="rechecked Gate result"
        return this.settle(p, "finished", "succeeded", JSON.stringify(outcome.result ?? null), null, {
          status: "succeeded",
          result: outcome.result,
        }, { status: "unknown", reason: "the adapter ran but the record was already decided" });
      case "denied":
        // @architecture flow=approval-resume step=resume-denied after=recheck-gate role=outcome label="Keep the rechecked denial closed" condition="current Gate denies" outcome=deny authority=none
        return this.settle(p, "rejected", null, null, outcome.reason, { status: "denied", reason: outcome.reason });
      case "unknown":
        // @architecture flow=approval-resume step=resume-unknown after=recheck-gate role=outcome label="Preserve an indeterminate adapter outcome" condition="adapter outcome is unknown" outcome=unknown authority="rechecked adapter outcome"
        return this.settle(p, "finished", "unknown", null, outcome.reason, {
          status: "unknown",
          reason: outcome.reason,
        });
      case "approval_required": {
        // A policy that still demands approval when given matching evidence is
        // misconfigured; refusing is the only safe reading.
        const why = "policy did not accept the approval evidence";
        // @architecture flow=approval-resume step=approval-loop-deny after=recheck-gate role=refusal label="Refuse a repeated approval demand" condition="policy still asks for approval with matching evidence" outcome=deny authority=none
        return this.settle(p, "rejected", null, null, why, { status: "denied", reason: why });
      }
      default:
        // @architecture flow=approval-resume step=resume-failed after=recheck-gate role=outcome label="Preserve a failed adapter outcome" condition="adapter reports failure" outcome=failed authority="rechecked adapter outcome"
        return this.settle(p, "finished", "failed", null, outcome.reason, {
          status: "failed",
          reason: outcome.reason,
        });
    }
  }

  /**
   * Write the terminal outcome and answer.
   *
   * When the durable transition did NOT happen, someone else decided this call
   * first, so we answer with what the store holds rather than what we computed —
   * a result that disagrees with the record is the one thing this state machine
   * must never produce. `lostRace` lets the success path say something stronger
   * than the record for that case: the adapter did run.
   */
  private settle(
    p: PendingRow,
    state: PendingState,
    outcome: PendingOutcome | null,
    resultJson: string | null,
    reason: string | null,
    won: InvokeResult,
    lostRace: InvokeResult = won,
  ): InvokeResult {
    // @architecture flow=approval-resume step=record-result after=gate-throws,resume-success,resume-denied,resume-unknown,approval-loop-deny,resume-failed role=state label="Persist one terminal result" condition="one rechecked outcome branch settles" outcome=persisted-terminal-result authority="durable compare-and-set record" terminal=true
    const wrote = this.store.finishPending(p.id, {
      state,
      outcome: outcome ?? undefined,
      resultJson,
      resultReason: reason,
      decidedAt: this.nowMs(),
    });
    if (wrote) {
      this.emit(p, "executed", {
        outcome: outcome ?? undefined,
        reason: reason ?? undefined,
        approver: p.approver ?? undefined,
      });
      return won;
    }
    const fresh = this.store.getPending(p.id);
    if (!fresh) return { status: "denied", reason: "approval record is gone" };
    if (fresh.state === "pending" || fresh.state === "claimed") return lostRace;
    return this.terminalResult(fresh, "already decided");
  }

  private terminalResult(p: PendingRow, why: string): InvokeResult {
    if (p.outcome === "succeeded") {
      return { status: "succeeded", result: p.resultJson === null ? null : (JSON.parse(p.resultJson) as unknown) };
    }
    if (p.outcome === "unknown") return { status: "unknown", reason: p.resultReason ?? why };
    if (p.outcome === "failed") return { status: "failed", reason: p.resultReason ?? why };
    return { status: "denied", reason: why };
  }

  private expire(p: PendingRow): void {
    if (this.store.finishPending(p.id, { state: "expired", decidedAt: this.nowMs() })) {
      this.emit(p, "expired", {});
    }
  }

  /** Age out expired calls and drop decided records past their retention. */
  sweep(): void {
    const now = this.nowMs();
    for (const p of this.store.listUndecided()) {
      if (p.state === "pending" && now > p.expiresAt) this.expire(p);
    }
    this.store.deletePendingBefore(now - this.retentionMs);
  }

  private viewOf(p: PendingRow): PendingView {
    const summary = JSON.parse(p.summaryJson) as TrustedSummary;
    return {
      id: p.id,
      title: summary.title,
      target: summary.target,
      details: summary.details,
      operation: p.operation,
      requestedBy: this.graph.contextMetadata(p.contextId) ?? {},
      createdAt: new Date(p.createdAt).toISOString(),
      expiresAt: new Date(p.expiresAt).toISOString(),
      state: p.state,
    };
  }

  private emit(
    p: PendingRow,
    event: AuditEvent,
    extra: { reason?: string; approver?: string; outcome?: PendingOutcome },
  ): void {
    this.emitAudit({
      event,
      at: new Date(this.nowMs()).toISOString(),
      contextId: p.contextId,
      contextKind: "pending",
      contextMetadata: this.graph.contextMetadata(p.contextId) ?? {},
      ancestry: [],
      slot: p.slot,
      capabilityId: null,
      objectId: p.objectId,
      operation: p.operation,
      argsHash: p.argsHash,
      decision:
        event === "denied" ? "deny" : event === "pending_created" || event === "requeued" ? "approval_required" : "allow",
      pendingCallId: p.id,
      ...extra,
    });
  }
}
