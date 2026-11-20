/**
 * The durable home of every fact this package owns, as an interface.
 *
 * ── Why there is no in-memory copy ──────────────────────────────────────────
 *
 * The previous shape kept Contexts, capabilities and slots in `Map`s AND in
 * SQLite, written through by hand at every mutation. Two representations of one
 * fact means every invariant has to hold in both, and the bugs that actually
 * shipped were all of that kind: a write that forgot to assert the lease, an
 * `INSERT OR REPLACE` that let a row's identity change under a live cache, a
 * migration that could not build its index, a boot that loaded the entire
 * history into memory before it could answer anything.
 *
 * None of those were authorization bugs. They were synchronisation bugs, and
 * they existed because there was something to synchronise. So the store is the
 * only representation: `core.ts` asks it a handful of indexed questions per
 * call and better-sqlite3 answers them synchronously in microseconds.
 *
 * The interface is deliberately dumb — rows in, rows out, plus two conditional
 * writes that are the concurrency primitives: `claimPending` (exactly-once
 * approval) and `insertPendingUnique` (one card per undecided call). All
 * policy, ancestry and validation live above it; a store that got clever would
 * be a second place to get authorization wrong.
 *
 * Rows that ARE security identity — objects, capabilities, slot bindings — are
 * write-once. A store that quietly replaced one would let "register the object
 * again, differently" become "retarget everyone holding it".
 */

import type { AuditRecord, ContextId, GrantTerms, ObjectId, Operation, Slot } from "./types.js";

export interface ContextRow {
  id: ContextId;
  kind: string;
  metadata: Record<string, string>;
  parent: ContextId | null;
  lifecycle: "live" | "destroyed";
  createdAt: number;
  /** When it was destroyed, for retention. Null while live. */
  destroyedAt: number | null;
}

export interface CapabilityRow {
  id: string;
  objectId: ObjectId;
  rights: string[];
  /** Attenuating conditions; see `GrantTerms`. */
  terms: GrantTerms;
  parentCapabilityId: string | null;
  holderContextId: ContextId;
  revokedAt: string | null;
}

export interface SlotRow {
  contextId: ContextId;
  slot: Slot;
  capabilityId: string;
}

/**
 * The Object's IDENTITY, not its code. Adapters and policies are supplied by
 * the trusted bootstrap on every boot; what persists is enough to prove the
 * thing being re-registered is the same thing live capabilities point at.
 */
export interface ObjectIdentityRow {
  id: ObjectId;
  kind: string;
  metadata: Record<string, string>;
  operations: string[];
}

export type PendingState = "pending" | "claimed" | "rejected" | "expired" | "finished";
export type PendingOutcome = "succeeded" | "failed" | "unknown";

export interface PendingRow {
  id: string;
  contextId: ContextId;
  slot: Slot;
  objectId: ObjectId;
  operation: Operation;
  canonicalArgs: Record<string, unknown>;
  argsHash: string;
  summaryJson: string;
  allowedApprover: string;
  /**
   * The Object's `OperationSpec.retrySafe`, copied in at creation.
   *
   * Recorded rather than looked up, because the only reader is boot recovery and
   * at that moment no Object has been registered yet — the control plane
   * registers them lazily, on first use. Copying also pins the declaration that
   * was in force when the human was asked, which is the one they were answering.
   */
  retrySafe: boolean;
  createdAt: number;
  expiresAt: number;
  state: PendingState;
  approver: string | null;
  claimedAt: number | null;
  outcome: PendingOutcome | null;
  resultJson: string | null;
  resultReason: string | null;
  decidedAt: number | null;
}

/** What makes two Object registrations "the same thing". */
export function identityKey(row: ObjectIdentityRow): string {
  return JSON.stringify([row.kind, sortedEntries(row.metadata), [...row.operations].sort()]);
}

/** What makes two capability rows the same authority (revocation may change). */
export function authorityKey(row: CapabilityRow): string {
  return JSON.stringify([
    row.objectId,
    [...row.rights].sort(),
    [...row.terms.autoAllow].sort(),
    row.parentCapabilityId,
    row.holderContextId,
  ]);
}

function sortedEntries(o: Record<string, string>): Array<[string, string]> {
  return Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** A live root over an Object: where it is held and under which slot. */
export interface RootRef {
  contextId: ContextId;
  slot: Slot;
  capabilityId: string;
}

/** The columns audit retention decides on, for one durable audit row. */
export interface AuditRow {
  seq: number;
  at: string;
  event: string;
  decision: string;
  objectId: ObjectId | null;
  operation: Operation;
  outcome: string | null;
  approver: string | null;
  pendingCallId: string | null;
}

export interface CapabilityStore {
  // ── the graph ──
  getContext(id: ContextId): ContextRow | null;
  putContext(row: ContextRow): void;
  setContextDestroyed(id: ContextId, at: number): void;
  /** Collect one bounded page of contexts destroyed before `cutoff` with no retained references. */
  deleteDestroyedContextsBefore(cutoff: number): number;

  getCapability(id: string): CapabilityRow | null;
  putCapability(row: CapabilityRow): void;
  setCapabilityRevoked(id: string, at: string): void;

  getSlot(contextId: ContextId, slot: Slot): SlotRow | null;
  putSlot(row: SlotRow): void;
  slotsOf(contextId: ContextId): SlotRow[];
  /** Unrevoked roots over an Object, deterministically ordered by id. */
  rootsOf(objectId: ObjectId): RootRef[];

  // ── object identity ──
  getObject(id: ObjectId): ObjectIdentityRow | null;
  /** Idempotent for an identical identity; throws when the identity differs. */
  putObject(row: ObjectIdentityRow): void;

  // ── pending calls ──
  /**
   * Insert a pending call unless an undecided one with the same
   * (context, slot, operation, argsHash) already exists. Returns the id that
   * is now authoritative — the new one, or the existing one. Atomic, so two
   * concurrent identical requests cannot both create a card.
   */
  insertPendingUnique(row: PendingRow): string;
  /**
   * The exactly-once door. Moves `pending -> claimed` for exactly one caller
   * and returns false for everyone else, including a caller in another process
   * or after a restart. Must be atomic in the underlying store.
   */
  claimPending(id: string, approver: string, at: number): boolean;
  /**
   * The one NON-terminal transition: `claimed -> pending`, forgetting the
   * approver and the claim but NOT the deadline. Only boot recovery calls it,
   * and only for a call whose Object declared it retry-safe.
   *
   * Conditional on the row still being `claimed`, so a second process — or a
   * second pass — cannot undo a decision somebody has since made.
   */
  requeuePending(id: string): boolean;
  /** Terminal transitions: reject / expire / record an outcome. */
  finishPending(
    id: string,
    patch: {
      state: PendingState;
      outcome?: PendingOutcome;
      resultJson?: string | null;
      resultReason?: string | null;
      decidedAt: number;
    },
  ): boolean;
  getPending(id: string): PendingRow | null;
  listPendingByApprover(approver: string): PendingRow[];
  listUndecided(): PendingRow[];
  deletePendingBefore(cutoff: number): number;

  appendAudit(record: AuditRecord): void;
  /** Up to `limit` audit rows with `seq > afterSeq`, oldest first. */
  auditPage(afterSeq: number, limit: number): AuditRow[];
  /** Delete these audit rows; returns how many existed. */
  deleteAudit(seqs: readonly number[]): number;
  close?(): void;
}
