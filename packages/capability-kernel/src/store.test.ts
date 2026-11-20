/**
 * Repository semantics — the layer everything above assumes is honest.
 *
 * Each case here was a real defect: a literal NUL made the source unreviewable,
 * `INSERT OR REPLACE` let a security-identity row be swapped silently, object
 * identity was validated and written in two steps, the pending duplicate check
 * raced its own insert, every service start declared another service's claimed
 * work `unknown`, and failed durable transitions were reported as success.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { SqliteCapabilityStore, StoreOwnershipError } from "./sqlite-store.js";
import { CapabilityService } from "./service.js";
import type { ObjectDefinition } from "./types.js";

let dir: string;
let file: string;
let open: SqliteCapabilityStore[] = [];

function repo(opts?: { owner?: string; leaseMs?: number; now?: () => number }): SqliteCapabilityStore {
  const r = new SqliteCapabilityStore(file, opts);
  open.push(r);
  return r;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "repo-"));
  file = path.join(dir, "cap.db");
  open = [];
});

afterEach(() => {
  for (const r of open) {
    try {
      r.close();
    } catch {
      /* already closed */
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("the source is reviewable text", () => {
  it("contains no control characters that make git treat it as binary", () => {
    // Enumerated, not listed: a hard-coded list goes stale the moment a file is
    // renamed, and then the check silently covers nothing.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const sources = fs.readdirSync(here).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(sources.length).toBeGreaterThan(4);
    for (const name of sources) {
      const bytes = fs.readFileSync(path.join(here, name));
      expect(bytes.includes(0), `${name} contains a literal NUL`).toBe(false);
    }
  });
});

// ── shared row builders for the adversarial cases below ──

function ctxRow(id: string) {
  return { id, kind: "k", metadata: {}, parent: null, lifecycle: "live" as const, createdAt: 1, destroyedAt: null };
}

function auditRow() {
  return {
    event: "denied" as const,
    at: "2026-07-30T00:00:00.000Z",
    contextId: "ctx",
    contextKind: "k",
    contextMetadata: {},
    ancestry: [],
    slot: "s",
    capabilityId: null,
    objectId: "o:1",
    operation: "exec",
    argsHash: "h",
    decision: "deny" as const,
    reason: "nope",
  };
}

function anyPending(o: Partial<{
  id: string; contextId: string; operation: string; argsHash: string;
  state: "pending" | "claimed"; approver: string | null; retrySafe: boolean;
}> = {}) {
  return {
    id: o.id ?? "pc_x",
    contextId: o.contextId ?? "ctx_a",
    slot: "s",
    objectId: "o:1",
    operation: o.operation ?? "exec",
    canonicalArgs: {},
    argsHash: o.argsHash ?? "h1",
    summaryJson: "{}",
    allowedApprover: "alice",
    retrySafe: o.retrySafe ?? false,
    createdAt: 1,
    expiresAt: 10_000_000_000,
    state: o.state ?? ("pending" as const),
    approver: o.approver ?? null,
    claimedAt: o.state === "claimed" ? 1 : null,
    outcome: null,
    resultJson: null,
    resultReason: null,
    decidedAt: null,
  };
}

describe("adversarial: ownership, migration and transitions", () => {

  /** A clock the test drives, so lease arithmetic is not a race. */
  function clocked(t0: number): { now: () => number; set: (v: number) => void } {
    let t = t0;
    return { now: () => t, set: (v: number) => { t = v; } };
  }

  it("EVERY write asserts the lease, including audit and retention", () => {
    const c = clocked(1000);
    const a = repo({ owner: "A", leaseMs: 1000, now: c.now });
    c.set(1000 + 5000);
    const b = repo({ owner: "B", leaseMs: 1000, now: c.now });
    // A is evicted. Nothing it can do may touch the file — an evicted writer
    // interleaving with the live one is exactly what the lease exists to stop,
    // and an audit row is still a row.
    expect(() => a.putContext(ctxRow("ctx-a"))).toThrow(StoreOwnershipError);
    expect(() => a.appendAudit(auditRow())).toThrow(StoreOwnershipError);
    expect(() => a.deletePendingBefore(9_000_000)).toThrow(StoreOwnershipError);
    expect(() => a.deleteAudit([1])).toThrow(StoreOwnershipError);
    expect(() => b.putContext(ctxRow("ctx-b"))).not.toThrow();
    expect(() => b.appendAudit(auditRow())).not.toThrow();
    expect(b.deleteAudit(b.auditPage(0, 10).map((r) => r.seq))).toBe(1);
  });

  it("our own heartbeat never moves backwards when the clock does", () => {
    // A clock rollback must not make OUR lease look expired to a competitor
    // while we are still writing. Refusing to start is an availability
    // problem; two live writers is a correctness one.
    const c = clocked(1_000_000);
    const a = repo({ owner: "A", leaseMs: 1000, now: c.now });
    a.beatForTest();
    c.set(1_000_000 - 600_000); // the clock jumps ten minutes back
    a.beatForTest();
    expect(() => a.putContext(ctxRow("still-a"))).not.toThrow();
    expect(() => repo({ owner: "B", leaseMs: 1000, now: c.now })).toThrow(StoreOwnershipError);
  });

  it("a pending row is never overwritten by a second insert of the same id", () => {
    const r = repo({ owner: "A" });
    r.putContext(ctxRow("ctx_a"));
    expect(r.insertPendingUnique(anyPending({ id: "pc_1", operation: "exec", argsHash: "h1" }))).toBe("pc_1");
    // The same id carrying DIFFERENT security identity. INSERT OR REPLACE would
    // silently rewrite what a human is about to approve.
    expect(() => r.insertPendingUnique(anyPending({ id: "pc_1", operation: "write_file", argsHash: "h2" }))).toThrow();
    expect(r.getPending("pc_1")!.operation).toBe("exec");
  });

  it("the dedupe index migration is deterministic when duplicates already exist", () => {
    // A database written before the index existed can hold two undecided rows
    // for the same call. `CREATE UNIQUE INDEX` would fail and take the schema
    // exec — and the constructor — with it, leaving the store unopenable.
    const legacy = path.join(dir, "dupes.db");
    const raw = new Database(legacy);
    raw.exec(`CREATE TABLE cap_pending (
      id TEXT PRIMARY KEY, context_id TEXT NOT NULL, slot TEXT NOT NULL, object_id TEXT NOT NULL,
      operation TEXT NOT NULL, args TEXT NOT NULL, args_hash TEXT NOT NULL,
      summary TEXT NOT NULL, allowed_approver TEXT NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      state TEXT NOT NULL, approver TEXT, claimed_at INTEGER,
      outcome TEXT, result TEXT, result_reason TEXT, decided_at INTEGER);`);
    const ins = raw.prepare(
      `INSERT INTO cap_pending (id, context_id, slot, object_id, operation, args, args_hash, summary,
        allowed_approver, created_at, expires_at, state) VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending')`,
    );
    // Deliberately inserted newest-first, so "the oldest survives" cannot pass
    // by accident of insertion order.
    for (const [id, at] of [["pc_new", 300], ["pc_mid", 200], ["pc_old", 100]] as const) {
      ins.run(id, "ctx", "s", "o:1", "exec", "{}", "same", "{}", "alice", at, at + 10_000_000_000);
    }
    raw.close();

    const r = new SqliteCapabilityStore(legacy, { owner: "A" });
    open.push(r);
    // Opening succeeded, and exactly the OLDEST duplicate survives undecided —
    // the card a human may already be looking at.
    expect(r.listUndecided().map((p) => p.id)).toEqual(["pc_old"]);
    for (const gone of ["pc_mid", "pc_new"]) {
      expect(r.getPending(gone)!.state).toBe("expired");
      expect(r.getPending(gone)!.resultReason).toMatch(/duplicate/i);
      // Never `finished`: nothing ran, so there is no outcome to record.
      expect(r.getPending(gone)!.outcome).toBeNull();
    }
    // And the index is genuinely in force afterwards.
    r.putContext(ctxRow("ctx"));
    expect(
      r.insertPendingUnique(anyPending({ id: "pc_again", contextId: "ctx", operation: "exec", argsHash: "same" })),
    ).toBe("pc_old");
  });

  it("only the live writer may recover claimed rows", () => {
    const c = clocked(5000);
    const a = repo({ owner: "A", leaseMs: 1000, now: c.now });
    a.putContext(ctxRow("ctx_a"));
    a.insertPendingUnique(anyPending({ id: "pc_c", state: "claimed", approver: "alice" }));
    c.set(5000 + 9000);
    const b = repo({ owner: "B", leaseMs: 1000, now: c.now });
    expect(() => a.claimPending("pc_c", "alice", c.now())).toThrow(StoreOwnershipError);
    expect(() => a.finishPending("pc_c", { state: "finished", outcome: "unknown", decidedAt: c.now() }))
      .toThrow(StoreOwnershipError);
    expect(b.getPending("pc_c")!.state).toBe("claimed");
    expect(b.finishPending("pc_c", { state: "finished", outcome: "unknown", decidedAt: c.now() })).toBe(true);
    expect(b.finishPending("pc_c", { state: "finished", outcome: "succeeded", decidedAt: c.now() })).toBe(false);
    expect(b.getPending("pc_c")!.outcome).toBe("unknown");
  });
});

describe("exactly one live writer owns a repository", () => {
  it("a second opener is refused while the first holds the lease", () => {
    repo({ owner: "first" });
    expect(() => repo({ owner: "second" })).toThrow(StoreOwnershipError);
  });

  it("a released lease can be taken by the next process", () => {
    const a = repo({ owner: "first" });
    a.close();
    expect(() => repo({ owner: "second" })).not.toThrow();
  });

  it("a stale lease (owner died without releasing) is taken over, a fresh one is not", () => {
    let now = 1_000_000;
    const a = new SqliteCapabilityStore(file, { owner: "dead", leaseMs: 30_000, now: () => now });
    open.push(a);
    // Same instant: the lease is live, so a second opener must fail.
    expect(() => repo({ owner: "b", leaseMs: 30_000, now: () => now })).toThrow(StoreOwnershipError);
    // Long after the holder stopped heartbeating: takeover is allowed.
    now += 120_000;
    expect(() => repo({ owner: "b", leaseMs: 30_000, now: () => now })).not.toThrow();
  });

  it("the evicted owner cannot keep writing", () => {
    let now = 1_000_000;
    const a = new SqliteCapabilityStore(file, { owner: "dead", leaseMs: 30_000, now: () => now });
    open.push(a);
    now += 120_000;
    repo({ owner: "b", leaseMs: 30_000, now: () => now });
    expect(() =>
      a.putContext({ id: "ctx_x", kind: "k", metadata: {}, parent: null, lifecycle: "live", createdAt: now, destroyedAt: null }),
    ).toThrow(StoreOwnershipError);
  });
});

describe("security identity rows are never silently replaced", () => {
  it("re-registering an object id with different identity is refused by the store itself", () => {
    const r = repo();
    r.putObject({ id: "o:1", kind: "device", metadata: { owner: "alice" }, operations: ["read"] });
    // Same identity: idempotent.
    expect(() => r.putObject({ id: "o:1", kind: "device", metadata: { owner: "alice" }, operations: ["read"] })).not.toThrow();
    // Different identity: refused, and the stored row is untouched.
    expect(() => r.putObject({ id: "o:1", kind: "device", metadata: { owner: "mallory" }, operations: ["read"] })).toThrow(
      /identity/i,
    );
    expect(r.getObject("o:1")!.metadata.owner).toBe("alice");
  });

  it("a capability row cannot be overwritten with different authority", () => {
    const r = repo();
    r.putContext({ id: "ctx_a", kind: "k", metadata: {}, parent: null, lifecycle: "live", createdAt: 1, destroyedAt: null });
    r.putCapability({
      id: "cap_1",
      objectId: "o:1",
      rights: ["read"], terms: { autoAllow: [] },
      parentCapabilityId: null,
      holderContextId: "ctx_a",
      revokedAt: null,
    });
    expect(() =>
      r.putCapability({
        id: "cap_1",
        objectId: "o:1",
        rights: ["read", "exec"], terms: { autoAllow: [] },
        parentCapabilityId: null,
        holderContextId: "ctx_a",
        revokedAt: null,
      }),
    ).toThrow(/immutable/i);
    expect(r.getCapability("cap_1")!.rights).toEqual(["read"]);
  });

  it("a slot cannot be silently repointed at another capability", () => {
    const r = repo();
    r.putContext({ id: "ctx_a", kind: "k", metadata: {}, parent: null, lifecycle: "live", createdAt: 1, destroyedAt: null });
    r.putSlot({ contextId: "ctx_a", slot: "s", capabilityId: "cap_1" });
    expect(() => r.putSlot({ contextId: "ctx_a", slot: "s", capabilityId: "cap_2" })).toThrow(/occupied|immutable/i);
    expect(r.getSlot("ctx_a", "s")!.capabilityId).toBe("cap_1");
  });

  it("a slot key with a delimiter in it cannot collide with another slot", () => {
    const r = repo();
    r.putContext({ id: "ctx_a", kind: "k", metadata: {}, parent: null, lifecycle: "live", createdAt: 1, destroyedAt: null });
    // Two different (context, slot) pairs that a naive string join would fuse.
    r.putSlot({ contextId: "ctx_a", slot: "x y", capabilityId: "cap_1" });
    r.putSlot({ contextId: "ctx_a", slot: "x", capabilityId: "cap_2" });
    expect(r.getSlot("ctx_a", "x y")!.capabilityId).toBe("cap_1");
    expect(r.getSlot("ctx_a", "x")!.capabilityId).toBe("cap_2");
    expect(r.slotsOf("ctx_a")).toHaveLength(2);
  });
});

describe("pending transitions are durable and checked", () => {
  function pendingRow(id: string, hash = "h1") {
    return {
      id,
      contextId: "ctx_a",
      slot: "s",
      objectId: "o:1",
      operation: "exec",
      canonicalArgs: {},
      argsHash: hash,
      summaryJson: "{}",
      allowedApprover: "alice",
      retrySafe: false,
      createdAt: 1,
      expiresAt: 10_000_000_000,
      state: "pending" as const,
      approver: null,
      claimedAt: null,
      outcome: null,
      resultJson: null,
      resultReason: null,
      decidedAt: null,
    };
  }

  it("two identical undecided pending calls cannot both be inserted", () => {
    const r = repo();
    r.putContext({ id: "ctx_a", kind: "k", metadata: {}, parent: null, lifecycle: "live", createdAt: 1, destroyedAt: null });
    expect(r.insertPendingUnique(pendingRow("pc_1"))).toBe("pc_1");
    // Same (context, slot, operation, argsHash) while still undecided: the
    // store returns the EXISTING id rather than creating a second card.
    expect(r.insertPendingUnique(pendingRow("pc_2"))).toBe("pc_1");
    expect(r.listUndecided()).toHaveLength(1);
  });

  it("finishPending reports whether the durable transition actually happened", () => {
    const r = repo();
    r.putContext({ id: "ctx_a", kind: "k", metadata: {}, parent: null, lifecycle: "live", createdAt: 1, destroyedAt: null });
    r.insertPendingUnique(pendingRow("pc_1"));
    expect(r.finishPending("pc_1", { state: "finished", outcome: "succeeded", decidedAt: 2 })).toBe(true);
    // Already terminal: the second transition is refused, not silently applied.
    expect(r.finishPending("pc_1", { state: "finished", outcome: "failed", decidedAt: 3 })).toBe(false);
    expect(r.getPending("pc_1")?.outcome).toBe("succeeded");
  });

  it("claimPending is won by exactly one caller", () => {
    const r = repo();
    r.putContext({ id: "ctx_a", kind: "k", metadata: {}, parent: null, lifecycle: "live", createdAt: 1, destroyedAt: null });
    r.insertPendingUnique(pendingRow("pc_1"));
    expect(r.claimPending("pc_1", "alice", 2)).toBe(true);
    expect(r.claimPending("pc_1", "alice", 3)).toBe(false);
  });
});

describe("restart recovery only touches this owner's work", () => {
  it("a service marks its OWN interrupted claims unknown, and only after it owns the repository", async () => {
    const hits: string[] = [];
    const def = (): ObjectDefinition<string> => ({
      id: "o:1",
      kind: "device",
      binding: "alice",
      metadata: { owner: "alice" },
      operations: { exec: { args: {}, effect: "modify" } },
      policy: (i) => (i.approval ? { kind: "allow" } : {
        kind: "approval_required",
        summary: { title: "x", target: "alice", details: [], allowedApprover: "alice" },
      }),
      adapter: async () => {
        hits.push("ran");
        return { ok: true };
      },
    });

    const r1 = repo({ owner: "svc1" });
    const s1 = new CapabilityService({ store: r1 });
    s1.registerObject(def());
    const ctx = s1.createContext("account-authority", { owner: "alice" });
    s1.mintRoot(ctx, "s", "o:1", ["exec"]);
    const out = (await s1.bind(ctx).request("s", "exec", {})) as { pendingCallId: string };
    // Claim it and "crash".
    expect(r1.claimPending(out.pendingCallId, "alice", Date.now())).toBe(true);
    r1.close();

    const r2 = repo({ owner: "svc2" });
    const s2 = new CapabilityService({ store: r2 });
    s2.registerObject(def());
    expect(s2.pendingState(out.pendingCallId)).toBe("finished");
    expect(s2.resultOf(ctx, out.pendingCallId)?.outcome).toBe("unknown");
    expect(hits).toHaveLength(0);
  });
});

describe("reported outcome never disagrees with the durable record", () => {
  it("a lost race on a DENIED resume reports the record, not our own verdict", () => {
    // Every terminal branch has to go through the record. If a resume computes
    // "denied" but the row was already decided by someone else, answering
    // "denied" tells the caller something the store contradicts.
    const r = repo({ owner: "A" });
    r.putContext(ctxRow("ctx_a"));
    r.insertPendingUnique(anyPending({ id: "pc_race" }));
    // Someone else finished it first.
    expect(r.finishPending("pc_race", { state: "finished", outcome: "succeeded", resultJson: '"ran"', decidedAt: 5 })).toBe(true);
    // A late transition is refused, and the record still says it succeeded.
    expect(r.finishPending("pc_race", { state: "rejected", decidedAt: 6 })).toBe(false);
    expect(r.getPending("pc_race")).toMatchObject({ state: "finished", outcome: "succeeded" });
  });

  it("a lost race reports what the store says, not what this call hoped", async () => {
    const r = repo();
    let ran = 0;
    const svc = new CapabilityService({ store: r });
    svc.registerObject({
      id: "o:1",
      kind: "device",
      binding: "alice",
      metadata: { owner: "alice" },
      operations: { exec: { args: {}, effect: "modify" } },
      policy: (i) =>
        i.approval
          ? { kind: "allow" }
          : { kind: "approval_required", summary: { title: "x", target: "alice", details: [], allowedApprover: "alice" } },
      adapter: async () => {
        ran++;
        // Somebody else decides the record while the adapter is in flight.
        r.finishPending(id, { state: "finished", outcome: "unknown", resultReason: "decided elsewhere", decidedAt: Date.now() });
        return { ok: true };
      },
    } as ObjectDefinition<string>);
    const ctx = svc.createContext("account-authority", { owner: "alice" });
    svc.mintRoot(ctx, "s", "o:1", ["exec"]);
    const out = (await svc.bind(ctx).request("s", "exec", {})) as { pendingCallId: string };
    const id = out.pendingCallId;
    const res = await svc.approve(id, "alice");
    expect(ran).toBe(1);
    // The store won: the caller is told `unknown`, matching what is recorded.
    expect(res.status).toBe("unknown");
    expect(svc.resultOf(ctx, id)?.outcome).toBe("unknown");
  });
});


describe("context collection keeps request work bounded", () => {
  function seed(r: SqliteCapabilityStore, count: number, prefix = "ctx"): void {
    const raw = new Database(file);
    try {
      const context = raw.prepare(
        "INSERT INTO cap_contexts (id, kind, metadata, parent, lifecycle, created_at, destroyed_at) VALUES (?, 'request', '{}', NULL, 'destroyed', 0, 1)",
      );
      const capability = raw.prepare(
        "INSERT INTO cap_capabilities (id, object_id, rights, terms, holder_context_id) VALUES (?, 'o:1', '[]', '{}', ?)",
      );
      const slot = raw.prepare("INSERT INTO cap_slots VALUES (?, 's', ?)");
      raw.transaction(() => {
        for (let i = 0; i < count; i++) {
          const id = `${prefix}-${String(i).padStart(5, "0")}`;
          context.run(id);
          capability.run(`cap-${id}`, id);
          slot.run(id, `cap-${id}`);
        }
      })();
    } finally {
      raw.close();
    }
    expect(r.graphSize().contexts).toBeGreaterThanOrEqual(count);
  }

  it("migrates existing stores to indexed, bounded cleanup and drains equal-timestamp pages", () => {
    const first = repo();
    seed(first, 600);
    first.close();
    const legacy = new Database(file);
    legacy.exec(`DROP INDEX idx_cap_contexts_collect;
      DROP INDEX idx_cap_contexts_parent;
      DROP INDEX idx_cap_capabilities_holder;
      DROP INDEX idx_cap_pending_context;`);
    legacy.close();
    const r = repo();
    const prepared = vi.spyOn(Database.prototype, "prepare");
    let statements: string[];
    try {
      expect(r.deleteDestroyedContextsBefore(2)).toBe(256);
      expect(r.graphSize()).toEqual({ contexts: 344, capabilities: 344, slots: 344 });
      expect(r.deleteDestroyedContextsBefore(2)).toBe(256);
      statements = [...new Set(prepared.mock.calls.map(([sql]) => sql))].filter((sql) => !sql.includes("COUNT(*)"));
      expect(r.deleteDestroyedContextsBefore(2)).toBe(88);
      expect(r.graphSize()).toEqual({ contexts: 0, capabilities: 0, slots: 0 });
    } finally {
      prepared.mockRestore();
    }
    // Explain the statements the collector actually prepared, including the
    // continuation page; a full scan or sorting the backlog regresses latency.
    const raw = new Database(file, { readonly: true });
    try {
      raw.pragma("automatic_index = OFF");
      for (const sql of statements!) {
        const plan = raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(
          ...Array.from(sql.matchAll(/\?/g), () => 2),
        ) as Array<{ detail: string }>;
        expect(plan.map((row) => row.detail).join("\n"), sql).not.toMatch(/\bSCAN\b|USE TEMP B-TREE/);
      }
    } finally {
      raw.close();
    }
  });

  it("advances past protected parents and revisits them after their children disappear", () => {
    const r = repo();
    seed(r, 300, "a-parent");
    seed(r, 300, "b-leaf");
    const raw = new Database(file);
    try {
      const insert = raw.prepare(
        "INSERT INTO cap_contexts (id, kind, metadata, parent, lifecycle, created_at) VALUES (?, 'child', '{}', ?, 'live', 0)",
      );
      raw.transaction(() => {
        for (let i = 0; i < 300; i++) {
          const key = String(i).padStart(5, "0");
          insert.run(`z-child-${key}`, `a-parent-${key}`);
        }
      })();
      // The first entire page is protected; LIMIT on only deleted rows would
      // still scan the backlog. A zero-deletion page must nevertheless advance.
      expect(r.deleteDestroyedContextsBefore(2)).toBe(0);
      expect(r.deleteDestroyedContextsBefore(2)).toBe(212);
      expect(r.deleteDestroyedContextsBefore(2)).toBe(88);
      expect(r.graphSize()).toEqual({ contexts: 600, capabilities: 300, slots: 300 });
      raw.exec("UPDATE cap_contexts SET lifecycle = 'destroyed', destroyed_at = 1 WHERE kind = 'child'");
      for (let i = 0; i < 8; i++) r.deleteDestroyedContextsBefore(2);
      expect(r.graphSize()).toEqual({ contexts: 0, capabilities: 0, slots: 0 });
    } finally {
      raw.close();
    }
  });

  it("retains every referenced context, live context and exact-cutoff row", () => {
    const r = repo();
    seed(r, 5);
    for (const [i, state] of ["pending", "claimed", "finished", "rejected", "expired"].entries()) {
      const id = `ctx-${String(i).padStart(5, "0")}`;
      r.insertPendingUnique(anyPending({ id: `pc-${i}`, contextId: id }));
      if (state === "claimed") r.claimPending(`pc-${i}`, "alice", 2);
      else if (state !== "pending") {
        r.finishPending(`pc-${i}`, { state: state as "finished" | "rejected" | "expired", decidedAt: 2 });
      }
    }
    r.putContext(ctxRow("live"));
    r.putContext({ ...ctxRow("cutoff"), lifecycle: "destroyed", destroyedAt: 2 });
    expect(r.deleteDestroyedContextsBefore(2)).toBe(0);
    expect(r.graphSize().contexts).toBe(7);
    expect(r.deleteDestroyedContextsBefore(3)).toBe(1);
    expect(r.getContext("cutoff")).toBeNull();
    for (let i = 0; i < 5; i++) expect(r.getContext(`ctx-${String(i).padStart(5, "0")}`)).not.toBeNull();
    expect(r.getContext("live")?.lifecycle).toBe("live");
  });

  it("rolls back a failed batch without advancing its cursor", () => {
    const r = repo();
    seed(r, 300);
    const raw = new Database(file);
    try {
      raw.exec(`CREATE TRIGGER fail_collection BEFORE DELETE ON cap_contexts
        WHEN OLD.id = 'ctx-00010' BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END;`);
      expect(() => r.deleteDestroyedContextsBefore(2)).toThrow("simulated write failure");
      expect(r.graphSize()).toEqual({ contexts: 300, capabilities: 300, slots: 300 });
      raw.exec("DROP TRIGGER fail_collection");
      expect(r.deleteDestroyedContextsBefore(2)).toBe(256);
      expect(r.getContext("ctx-00000")).toBeNull();
      expect(r.deleteDestroyedContextsBefore(2)).toBe(44);
      expect(r.graphSize()).toEqual({ contexts: 0, capabilities: 0, slots: 0 });
    } finally {
      raw.close();
    }
  });
});
