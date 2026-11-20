/**
 * The only representation: one SQLite file, WAL, six tables.
 *
 * Read per call rather than cached in memory. better-sqlite3 is synchronous and
 * an indexed point lookup is a few microseconds, so `authorize` doing four of
 * them costs less than the write-through cache cost in correctness: with one
 * representation there is no drift to have a bug in, and boot does not read the
 * whole history before it can answer anything.
 *
 * Three things are worth staring at:
 *
 *  - `claimPending`: one conditional UPDATE whose `changes` count decides who
 *    executes a dangerous call. That is the exactly-once primitive.
 *  - `insertPendingUnique`: a partial unique index plus one transaction, so two
 *    concurrent identical requests cannot both create a card.
 *  - the ownership lease: exactly ONE live service may write this file. The
 *    alternative — several services sharing it — needs leases on every row and
 *    buys nothing here, so we enforce single-writer rather than assume it. A
 *    second opener fails fast; an evicted one cannot write.
 *
 * Identity rows (objects, capabilities, slots) are INSERTed and verified, never
 * INSERT OR REPLACEd: replacing one silently is the same as retargeting
 * everyone who holds it.
 */

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { authorityKey, identityKey } from "./store.js";
import type {
  AuditRow,
  CapabilityRow,
  CapabilityStore,
  ContextRow,
  ObjectIdentityRow,
  PendingOutcome,
  PendingRow,
  PendingState,
  RootRef,
  SlotRow,
} from "./store.js";
import type { AuditRecord, ContextId, GrantTerms, ObjectId, Slot } from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cap_owner (
  id INTEGER PRIMARY KEY CHECK (id = 1), owner TEXT NOT NULL, heartbeat_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS cap_objects (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, metadata TEXT NOT NULL, operations TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cap_contexts (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, metadata TEXT NOT NULL,
  parent TEXT, lifecycle TEXT NOT NULL, created_at INTEGER NOT NULL, destroyed_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_cap_contexts_dead ON cap_contexts(lifecycle, destroyed_at);
CREATE INDEX IF NOT EXISTS idx_cap_contexts_collect ON cap_contexts(lifecycle, destroyed_at, id);
CREATE INDEX IF NOT EXISTS idx_cap_contexts_parent ON cap_contexts(parent);
CREATE TABLE IF NOT EXISTS cap_capabilities (
  id TEXT PRIMARY KEY, object_id TEXT NOT NULL, rights TEXT NOT NULL, terms TEXT NOT NULL DEFAULT '{}',
  parent_capability_id TEXT, holder_context_id TEXT NOT NULL, revoked_at TEXT);
CREATE INDEX IF NOT EXISTS idx_cap_roots ON cap_capabilities(object_id, parent_capability_id);
CREATE INDEX IF NOT EXISTS idx_cap_capabilities_holder ON cap_capabilities(holder_context_id);
CREATE TABLE IF NOT EXISTS cap_slots (
  context_id TEXT NOT NULL, slot TEXT NOT NULL, capability_id TEXT NOT NULL,
  PRIMARY KEY (context_id, slot));
CREATE INDEX IF NOT EXISTS idx_cap_slots_cap ON cap_slots(capability_id);
CREATE TABLE IF NOT EXISTS cap_pending (
  id TEXT PRIMARY KEY, context_id TEXT NOT NULL, slot TEXT NOT NULL, object_id TEXT NOT NULL,
  operation TEXT NOT NULL, args TEXT NOT NULL, args_hash TEXT NOT NULL,
  summary TEXT NOT NULL, allowed_approver TEXT NOT NULL, retry_safe INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  state TEXT NOT NULL, approver TEXT, claimed_at INTEGER,
  outcome TEXT, result TEXT, result_reason TEXT, decided_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_cap_pending_approver ON cap_pending(allowed_approver, state);
CREATE INDEX IF NOT EXISTS idx_cap_pending_state ON cap_pending(state);
CREATE INDEX IF NOT EXISTS idx_cap_pending_context ON cap_pending(context_id);
CREATE TABLE IF NOT EXISTS cap_audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, event TEXT NOT NULL,
  context_id TEXT, context_kind TEXT, slot TEXT, capability_id TEXT, object_id TEXT,
  operation TEXT, args_hash TEXT, decision TEXT, reason TEXT, approver TEXT,
  pending_call_id TEXT, outcome TEXT, duration_ms INTEGER, metadata TEXT);
CREATE INDEX IF NOT EXISTS idx_cap_audit_pending ON cap_audit(pending_call_id);
`;

/** One undecided card per (context, slot, operation, args). Created after any
 * pre-existing duplicates are collapsed — see `ensureDedupeIndex`. */
const DEDUPE_INDEX = `CREATE UNIQUE INDEX IF NOT EXISTS idx_cap_pending_dedupe
  ON cap_pending(context_id, slot, operation, args_hash) WHERE state IN ('pending','claimed');`;

interface ContextSqlRow {
  id: string;
  kind: string;
  metadata: string;
  parent: string | null;
  lifecycle: string;
  created_at: number;
  destroyed_at: number | null;
}

interface CapabilitySqlRow {
  id: string;
  object_id: string;
  rights: string;
  terms: string;
  parent_capability_id: string | null;
  holder_context_id: string;
  revoked_at: string | null;
}

interface PendingSqlRow {
  id: string;
  context_id: string;
  slot: string;
  object_id: string;
  operation: string;
  args: string;
  args_hash: string;
  summary: string;
  allowed_approver: string;
  retry_safe: number;
  created_at: number;
  expires_at: number;
  state: string;
  approver: string | null;
  claimed_at: number | null;
  outcome: string | null;
  result: string | null;
  result_reason: string | null;
  decided_at: number | null;
}

function toContext(r: ContextSqlRow): ContextRow {
  return {
    id: r.id,
    kind: r.kind,
    metadata: JSON.parse(r.metadata) as Record<string, string>,
    parent: r.parent,
    lifecycle: r.lifecycle === "live" ? "live" : "destroyed",
    createdAt: r.created_at,
    destroyedAt: r.destroyed_at,
  };
}

function toCapability(r: CapabilitySqlRow): CapabilityRow {
  const parsed = JSON.parse(r.terms || "{}") as Partial<GrantTerms>;
  return {
    id: r.id,
    objectId: r.object_id,
    rights: JSON.parse(r.rights) as string[],
    // A row written before terms existed auto-allows nothing: fail closed, so a
    // schema that predates the column cannot silently license anything.
    terms: { autoAllow: Array.isArray(parsed.autoAllow) ? parsed.autoAllow : [] },
    parentCapabilityId: r.parent_capability_id,
    holderContextId: r.holder_context_id,
    revokedAt: r.revoked_at,
  };
}

function toPending(r: PendingSqlRow): PendingRow {
  return {
    id: r.id,
    contextId: r.context_id,
    slot: r.slot,
    objectId: r.object_id,
    operation: r.operation,
    canonicalArgs: JSON.parse(r.args) as Record<string, unknown>,
    argsHash: r.args_hash,
    summaryJson: r.summary,
    allowedApprover: r.allowed_approver,
    // A row written before the column existed reads 0 — the conservative
    // answer, and the right one: nothing tells us it was safe to re-run.
    retrySafe: r.retry_safe === 1,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    state: r.state as PendingState,
    approver: r.approver,
    claimedAt: r.claimed_at,
    outcome: (r.outcome as PendingOutcome | null) ?? null,
    resultJson: r.result,
    resultReason: r.result_reason,
    decidedAt: r.decided_at,
  };
}

/** Thrown when a second writer tries to open a store someone else owns. */
export class StoreOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreOwnershipError";
  }
}

export interface SqliteStoreOptions {
  /** Identifies this writer in the lease row. Defaults to pid@host. */
  owner?: string;
  /** A lease older than this is considered abandoned. */
  leaseMs?: number;
  /** Injectable clock (tests). */
  now?: () => number;
}

const DEFAULT_LEASE_MS = 60_000;
// Bound candidates as well as deletions: retained parents must not turn one
// collection into a scan of the entire graph on the request's event loop.
const CONTEXT_COLLECTION_BATCH_SIZE = 256;
interface CollectionCursor { id: string; destroyed_at: number }

export class SqliteCapabilityStore implements CapabilityStore {
  private db: Database.Database;
  private owner: string;
  private leaseMs: number;
  private nowMs: () => number;
  private heartbeat: NodeJS.Timeout | null = null;
  private closed = false;
  /** Our own last heartbeat, so a clock rollback cannot shorten our lease. */
  private lastBeat = 0;
  private collectionCursor: CollectionCursor | null = null;

  constructor(file: string, opts: SqliteStoreOptions = {}) {
    if (file !== ":memory:") {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    }
    this.owner = opts.owner ?? `${process.pid}@${process.env.HOSTNAME ?? "local"}-${randomUUID().slice(0, 8)}`;
    this.leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
    this.nowMs = opts.now ?? Date.now;
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.exec(SCHEMA);
    this.migrate();
    this.acquireLease();
    // After the lease, so only the live writer ever rewrites rows.
    this.ensureDedupeIndex();
    if (file !== ":memory:") {
      // The store holds pending command lines and approver identities; the side
      // files must not be world-readable either.
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          fs.chmodSync(file + suffix, 0o600);
        } catch {
          // -wal/-shm may not exist yet; they inherit the mode when created.
        }
      }
    }
  }

  /** Additive columns for databases written by an earlier version. */
  private migrate(): void {
    const add = (table: string, column: string, ddl: string): void => {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    };
    add("cap_contexts", "destroyed_at", "destroyed_at INTEGER");
    add("cap_capabilities", "terms", "terms TEXT NOT NULL DEFAULT '{}'");
    add("cap_pending", "retry_safe", "retry_safe INTEGER NOT NULL DEFAULT 0");
  }

  /**
   * Take the single writer lease, or refuse to start.
   *
   * Fail-fast beats "last writer wins": two services over one capability file
   * would each recover the other's claimed approvals as `unknown` and race every
   * pending transition.
   */
  private acquireLease(): void {
    const now = this.nowMs();
    const taken = this.db.transaction(() => {
      const row = this.db.prepare("SELECT owner, heartbeat_at FROM cap_owner WHERE id = 1").get() as
        | { owner: string; heartbeat_at: number }
        | undefined;
      // `now - heartbeat_at < leaseMs` also covers a heartbeat in the FUTURE
      // (negative difference): a clock we cannot trust must not be a reason to
      // take someone else's lease away.
      if (row && row.owner !== this.owner && now - row.heartbeat_at < this.leaseMs) return row.owner;
      this.lastBeat = now;
      this.db
        .prepare(
          "INSERT INTO cap_owner (id, owner, heartbeat_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET owner = ?, heartbeat_at = ?",
        )
        .run(this.owner, now, this.owner, now);
      return null;
    })();
    if (taken) {
      this.db.close();
      throw new StoreOwnershipError(
        `capability store is owned by ${taken}; exactly one live service may write it`,
      );
    }
    this.heartbeat = setInterval(() => this.beat(), Math.max(1000, Math.floor(this.leaseMs / 3)));
    this.heartbeat.unref?.();
  }

  /**
   * Create the one-undecided-card-per-call index, collapsing anything that would
   * violate it first.
   *
   * A database written before this index existed can legitimately hold two
   * undecided rows for the same (context, slot, operation, args). `CREATE UNIQUE
   * INDEX` then fails — and when it lived in the schema exec, it took the whole
   * constructor down with it, so the store became unopenable rather than merely
   * untidy.
   *
   * The collapse is deterministic and conservative: the OLDEST row survives
   * (created_at, then id, as the tie-break), because that is the card a human may
   * already have in front of them. The rest become `expired` with a reason, which
   * is a terminal state — never `finished`, because nothing ran.
   */
  private ensureDedupeIndex(): void {
    const dupes = this.db
      .prepare(
        `SELECT id FROM cap_pending WHERE state IN ('pending','claimed') AND id NOT IN (
           SELECT id FROM (
             SELECT id, ROW_NUMBER() OVER (
               PARTITION BY context_id, slot, operation, args_hash ORDER BY created_at ASC, id ASC
             ) AS rn
             FROM cap_pending WHERE state IN ('pending','claimed')
           ) WHERE rn = 1)`,
      )
      .all() as Array<{ id: string }>;
    if (dupes.length) {
      const now = this.nowMs();
      const expire = this.db.prepare(
        `UPDATE cap_pending SET state = 'expired', decided_at = ?, result_reason = ?
         WHERE id = ? AND state IN ('pending','claimed')`,
      );
      this.db.transaction(() => {
        for (const d of dupes) {
          expire.run(now, "collapsed as a duplicate undecided call during migration", d.id);
        }
      })();
    }
    this.db.exec(DEDUPE_INDEX);
  }

  /**
   * Refresh the lease, never backwards.
   *
   * A wall clock can step back (NTP, a VM snapshot, an operator). If our
   * heartbeat followed it down, our own lease would suddenly look old enough for
   * a competitor to take over while we are still writing — two live writers,
   * which is the one outcome this mechanism exists to prevent.
   */
  private beat(): void {
    if (this.closed) return;
    try {
      const now = Math.max(this.nowMs(), this.lastBeat);
      this.lastBeat = now;
      this.db
        .prepare("UPDATE cap_owner SET heartbeat_at = MAX(heartbeat_at, ?) WHERE id = 1 AND owner = ?")
        .run(now, this.owner);
    } catch {
      // A closed database during shutdown is not worth a crash.
    }
  }

  /** Test hook: run one heartbeat synchronously. */
  beatForTest(): void {
    this.beat();
  }

  /**
   * Every write asserts the lease. An evicted owner (its lease expired and was
   * taken over) must stop writing rather than interleave with the new one.
   */
  private assertOwner(): void {
    const row = this.db.prepare("SELECT owner FROM cap_owner WHERE id = 1").get() as { owner: string } | undefined;
    if (!row || row.owner !== this.owner) {
      throw new StoreOwnershipError(
        `capability store ownership lost to ${row?.owner ?? "(none)"}; this service must stop writing`,
      );
    }
  }

  close(): void {
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    try {
      this.db.prepare("DELETE FROM cap_owner WHERE id = 1 AND owner = ?").run(this.owner);
    } catch {
      // best effort: a stale lease simply expires
    }
    this.db.close();
  }

  // ── the graph ──

  getContext(id: ContextId): ContextRow | null {
    const r = this.db.prepare("SELECT * FROM cap_contexts WHERE id = ?").get(id) as ContextSqlRow | undefined;
    return r ? toContext(r) : null;
  }

  putContext(row: ContextRow): void {
    this.assertOwner();
    // Contexts are created once with a fresh random id; a collision would be a
    // bug, not a legitimate update.
    this.db
      .prepare(
        `INSERT INTO cap_contexts (id, kind, metadata, parent, lifecycle, created_at, destroyed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.kind, JSON.stringify(row.metadata), row.parent, row.lifecycle, row.createdAt, row.destroyedAt);
  }

  setContextDestroyed(id: ContextId, at: number): void {
    this.assertOwner();
    // One-way: destroyed is terminal, so a stray write cannot resurrect.
    this.db
      .prepare("UPDATE cap_contexts SET lifecycle = 'destroyed', destroyed_at = ? WHERE id = ? AND lifecycle = 'live'")
      .run(at, id);
  }

  /**
   * Collect destroyed Contexts and everything hanging off them.
   *
   * Two conditions, both necessary. A Context is only collectable when no
   * pending row still names it — an undecided card resumes in its original
   * Context, so deleting the row would turn "approve" into "unknown context" —
   * and when it has no LIVE descendant, because `authorize` walks up through
   * ancestors and a missing one reads as a broken chain rather than a valid one.
   * The second condition also makes this safe to run in any order: a subtree is
   * collected leaves-first over successive sweeps.
   */
  deleteDestroyedContextsBefore(cutoff: number): number {
    this.assertOwner();
    const result = this.db.transaction(() => {
      const cursor = this.collectionCursor;
      const candidates = this.db.prepare(
        `SELECT id, destroyed_at FROM cap_contexts
         WHERE lifecycle = 'destroyed' AND destroyed_at < ?
         ${cursor ? "AND (destroyed_at, id) > (?, ?)" : ""}
         ORDER BY destroyed_at, id LIMIT ?`,
      ).all(
        cutoff, ...(cursor ? [cursor.destroyed_at, cursor.id] : []), CONTEXT_COLLECTION_BATCH_SIZE,
      ) as CollectionCursor[];
      // Probe references for only this page. An index on every lookup/delete
      // is essential: a LIMIT after NOT IN still materialises the whole graph.
      const pending = this.db.prepare("SELECT 1 FROM cap_pending WHERE context_id = ? LIMIT 1");
      const child = this.db.prepare("SELECT 1 FROM cap_contexts WHERE parent = ? LIMIT 1");
      const dropSlots = this.db.prepare("DELETE FROM cap_slots WHERE context_id = ?");
      const dropCaps = this.db.prepare("DELETE FROM cap_capabilities WHERE holder_context_id = ?");
      const dropCtx = this.db.prepare("DELETE FROM cap_contexts WHERE id = ?");
      let deleted = 0;
      for (const candidate of candidates) {
        // Any retained child or pending record still protects its ancestor,
        // including terminal approvals whose result retention has not elapsed.
        if (pending.get(candidate.id) || child.get(candidate.id)) continue;
        dropSlots.run(candidate.id);
        dropCaps.run(candidate.id);
        dropCtx.run(candidate.id);
        deleted++;
      }
      return {
        deleted,
        cursor: candidates.length === CONTEXT_COLLECTION_BATCH_SIZE ? candidates[candidates.length - 1] : null,
      };
    })();
    // Advance only after commit, including past protected rows so they cannot
    // starve later leaves. Wrap at the end to revisit parents after children
    // disappear. This cursor schedules cleanup; it never grants authority.
    this.collectionCursor = result.cursor;
    return result.deleted;
  }

  getCapability(id: string): CapabilityRow | null {
    const r = this.db.prepare("SELECT * FROM cap_capabilities WHERE id = ?").get(id) as CapabilitySqlRow | undefined;
    return r ? toCapability(r) : null;
  }

  putCapability(row: CapabilityRow): void {
    this.assertOwner();
    this.db.transaction(() => {
      const prev = this.db.prepare("SELECT * FROM cap_capabilities WHERE id = ?").get(row.id) as
        | CapabilitySqlRow
        | undefined;
      if (prev) {
        if (authorityKey(toCapability(prev)) !== authorityKey(row)) {
          throw new Error(`capability ${row.id} is immutable once created`);
        }
        return;
      }
      this.db
        .prepare(
          `INSERT INTO cap_capabilities
           (id, object_id, rights, terms, parent_capability_id, holder_context_id, revoked_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.id,
          row.objectId,
          JSON.stringify(row.rights),
          JSON.stringify(row.terms),
          row.parentCapabilityId,
          row.holderContextId,
          row.revokedAt,
        );
    })();
  }

  setCapabilityRevoked(id: string, at: string): void {
    this.assertOwner();
    this.db.prepare("UPDATE cap_capabilities SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(at, id);
  }

  getSlot(contextId: ContextId, slot: Slot): SlotRow | null {
    const r = this.db
      .prepare("SELECT * FROM cap_slots WHERE context_id = ? AND slot = ?")
      .get(contextId, slot) as { context_id: string; slot: string; capability_id: string } | undefined;
    return r ? { contextId: r.context_id, slot: r.slot, capabilityId: r.capability_id } : null;
  }

  putSlot(row: SlotRow): void {
    this.assertOwner();
    this.db.transaction(() => {
      const prev = this.db
        .prepare("SELECT capability_id FROM cap_slots WHERE context_id = ? AND slot = ?")
        .get(row.contextId, row.slot) as { capability_id: string } | undefined;
      if (prev) {
        if (prev.capability_id !== row.capabilityId) {
          throw new Error(`slot ${row.slot} is occupied; a slot binding is immutable`);
        }
        return;
      }
      this.db
        .prepare("INSERT INTO cap_slots (context_id, slot, capability_id) VALUES (?, ?, ?)")
        .run(row.contextId, row.slot, row.capabilityId);
    })();
  }

  slotsOf(contextId: ContextId): SlotRow[] {
    return (
      this.db.prepare("SELECT * FROM cap_slots WHERE context_id = ? ORDER BY slot").all(contextId) as Array<{
        context_id: string;
        slot: string;
        capability_id: string;
      }>
    ).map((r) => ({ contextId: r.context_id, slot: r.slot, capabilityId: r.capability_id }));
  }

  /**
   * Unrevoked roots over an Object, joined to the slot that still points at
   * them. A capability whose holder no longer points a slot at it is
   * unreachable by construction — `authorize` starts from (Context, slot),
   * never from a capability id — so it is not a live root.
   */
  rootsOf(objectId: ObjectId): RootRef[] {
    return this.db
      .prepare(
        `SELECT s.context_id AS contextId, s.slot AS slot, c.id AS capabilityId
         FROM cap_capabilities c JOIN cap_slots s ON s.capability_id = c.id
         WHERE c.object_id = ? AND c.parent_capability_id IS NULL AND c.revoked_at IS NULL
         ORDER BY c.id`,
      )
      .all(objectId) as RootRef[];
  }

  // ── object identity ──

  getObject(id: ObjectId): ObjectIdentityRow | null {
    const r = this.db.prepare("SELECT * FROM cap_objects WHERE id = ?").get(id) as
      | { id: string; kind: string; metadata: string; operations: string }
      | undefined;
    return r
      ? {
          id: r.id,
          kind: r.kind,
          metadata: JSON.parse(r.metadata) as Record<string, string>,
          operations: JSON.parse(r.operations) as string[],
        }
      : null;
  }

  putObject(row: ObjectIdentityRow): void {
    this.assertOwner();
    // Validate-and-write in ONE transaction: checking first and inserting after
    // leaves a window where two callers both see "absent" and the second
    // silently replaces the first.
    this.db.transaction(() => {
      const prev = this.db.prepare("SELECT * FROM cap_objects WHERE id = ?").get(row.id) as
        | { id: string; kind: string; metadata: string; operations: string }
        | undefined;
      if (prev) {
        const known: ObjectIdentityRow = {
          id: prev.id,
          kind: prev.kind,
          metadata: JSON.parse(prev.metadata) as Record<string, string>,
          operations: JSON.parse(prev.operations) as string[],
        };
        if (identityKey(known) !== identityKey(row)) {
          throw new Error(`object ${row.id} is already registered with a different identity`);
        }
        return;
      }
      this.db
        .prepare("INSERT INTO cap_objects (id, kind, metadata, operations) VALUES (?, ?, ?, ?)")
        .run(row.id, row.kind, JSON.stringify(row.metadata), JSON.stringify(row.operations));
    })();
  }

  // ── pending calls ──

  insertPendingUnique(row: PendingRow): string {
    this.assertOwner();
    return this.db.transaction(() => {
      const dup = this.db
        .prepare(
          `SELECT id FROM cap_pending
           WHERE context_id = ? AND slot = ? AND operation = ? AND args_hash = ? AND state IN ('pending','claimed')`,
        )
        .get(row.contextId, row.slot, row.operation, row.argsHash) as { id: string } | undefined;
      if (dup) return dup.id;
      this.putPendingRow(row);
      return row.id;
    })();
  }

  /**
   * Plain INSERT. `INSERT OR REPLACE` let a second write under the same id
   * silently swap the operation, the args or the approver of a card a human may
   * already be looking at — the row IS the security identity of a dangerous
   * call, so replacing it is the same class of mistake as retargeting an Object.
   */
  private putPendingRow(row: PendingRow): void {
    this.db
      .prepare(
        `INSERT INTO cap_pending
         (id, context_id, slot, object_id, operation, args, args_hash, summary, allowed_approver, retry_safe,
          created_at, expires_at, state, approver, claimed_at, outcome, result, result_reason, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.contextId,
        row.slot,
        row.objectId,
        row.operation,
        JSON.stringify(row.canonicalArgs),
        row.argsHash,
        row.summaryJson,
        row.allowedApprover,
        row.retrySafe ? 1 : 0,
        row.createdAt,
        row.expiresAt,
        row.state,
        row.approver,
        row.claimedAt,
        row.outcome,
        row.resultJson,
        row.resultReason,
        row.decidedAt,
      );
  }

  /** One conditional UPDATE. Exactly one caller sees changes === 1. */
  claimPending(id: string, approver: string, at: number): boolean {
    this.assertOwner();
    const res = this.db
      .prepare(
        "UPDATE cap_pending SET state = 'claimed', approver = ?, claimed_at = ? WHERE id = ? AND state = 'pending'",
      )
      .run(approver, at, id);
    return res.changes === 1;
  }

  /** The mirror image of `claimPending`, and conditional on the same state. */
  requeuePending(id: string): boolean {
    this.assertOwner();
    const res = this.db
      .prepare(
        "UPDATE cap_pending SET state = 'pending', approver = NULL, claimed_at = NULL WHERE id = ? AND state = 'claimed'",
      )
      .run(id);
    return res.changes === 1;
  }

  finishPending(
    id: string,
    patch: {
      state: PendingState;
      outcome?: PendingOutcome;
      resultJson?: string | null;
      resultReason?: string | null;
      decidedAt: number;
    },
  ): boolean {
    this.assertOwner();
    const res = this.db
      .prepare(
        `UPDATE cap_pending SET state = ?, outcome = ?, result = ?, result_reason = ?, decided_at = ?
         WHERE id = ? AND state IN ('pending','claimed')`,
      )
      .run(patch.state, patch.outcome ?? null, patch.resultJson ?? null, patch.resultReason ?? null, patch.decidedAt, id);
    return res.changes === 1;
  }

  getPending(id: string): PendingRow | null {
    const r = this.db.prepare("SELECT * FROM cap_pending WHERE id = ?").get(id) as PendingSqlRow | undefined;
    return r ? toPending(r) : null;
  }

  listPendingByApprover(approver: string): PendingRow[] {
    return (this.db.prepare("SELECT * FROM cap_pending WHERE allowed_approver = ?").all(approver) as PendingSqlRow[]).map(
      toPending,
    );
  }

  listUndecided(): PendingRow[] {
    return (
      this.db.prepare("SELECT * FROM cap_pending WHERE state IN ('pending','claimed')").all() as PendingSqlRow[]
    ).map(toPending);
  }

  deletePendingBefore(cutoff: number): number {
    this.assertOwner();
    return this.db
      .prepare("DELETE FROM cap_pending WHERE state NOT IN ('pending','claimed') AND COALESCE(decided_at, expires_at) < ?")
      .run(cutoff).changes;
  }

  appendAudit(record: AuditRecord): void {
    // Audit is evidence. An evicted writer appending to the same trail
    // interleaves two services' histories into one that describes neither.
    this.assertOwner();
    this.db
      .prepare(
        `INSERT INTO cap_audit (at, event, context_id, context_kind, slot, capability_id, object_id,
           operation, args_hash, decision, reason, approver, pending_call_id, outcome, duration_ms, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.at,
        record.event,
        record.contextId,
        record.contextKind,
        record.slot,
        record.capabilityId,
        record.objectId,
        record.operation,
        record.argsHash,
        record.decision,
        record.reason ?? null,
        record.approver ?? null,
        record.pendingCallId ?? null,
        record.outcome ?? null,
        record.durationMs ?? null,
        JSON.stringify(record.contextMetadata ?? {}),
      );
  }

  /** A rowid range scan: cost is the page asked for, never the table. */
  auditPage(afterSeq: number, limit: number): AuditRow[] {
    return this.db
      .prepare(
        `SELECT seq, at, event, decision, object_id AS objectId, operation, outcome, approver,
           pending_call_id AS pendingCallId
         FROM cap_audit WHERE seq > ? ORDER BY seq LIMIT ?`,
      )
      .all(afterSeq, limit) as AuditRow[];
  }

  deleteAudit(seqs: readonly number[]): number {
    // Same lease as appending: two services trimming one trail is the same
    // interleaving as two services writing it.
    this.assertOwner();
    const drop = this.db.prepare("DELETE FROM cap_audit WHERE seq = ?");
    return this.db.transaction(() => seqs.reduce((n, seq) => n + drop.run(seq).changes, 0))();
  }

  /** Test/diagnostics: the audit trail for one dangerous call. */
  auditFor(pendingCallId: string): Array<{ event: string; outcome: string | null; approver: string | null }> {
    return this.db
      .prepare("SELECT event, outcome, approver FROM cap_audit WHERE pending_call_id = ? ORDER BY seq")
      .all(pendingCallId) as Array<{ event: string; outcome: string | null; approver: string | null }>;
  }

  /** Test/diagnostics: how many rows the graph currently holds. */
  graphSize(): { contexts: number; capabilities: number; slots: number } {
    const one = (sql: string): number => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      contexts: one("SELECT COUNT(*) AS n FROM cap_contexts"),
      capabilities: one("SELECT COUNT(*) AS n FROM cap_capabilities"),
      slots: one("SELECT COUNT(*) AS n FROM cap_slots"),
    };
  }
}
