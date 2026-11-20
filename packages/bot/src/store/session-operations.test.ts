/**
 * The `session_operations` table (migrations v25-v26).
 *
 * Two properties are load-bearing rather than incidental: every read is scoped
 * to an owner (an operation id is opaque and must not be enough on its own), and
 * "live" is an explicit list of states rather than "not terminal" — the dedupe
 * lookup joins a submission to work that is still going, and joining anything
 * else would swallow a new instruction.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type SessionOperationRow } from "./store.js";

const NOW = "2026-08-03T09:00:00.000Z";
let dir: string;
let store: Store;

function row(over: Partial<SessionOperationRow> = {}): SessionOperationRow {
  return {
    id: "op_1",
    owner: "alice",
    surface: "hub",
    credential: "ws:one",
    resource_id: "res-a",
    device: "laptop",
    cli_kind: "claude",
    session_id: "s1",
    operation: "append_session",
    args_hash: "fp-1",
    pending_call_id: null,
    context_id: "ctx-1",
    status: "submitted",
    detail: null,
    new_session_id: null,
    submitted_at: NOW,
    started_at: null,
    finished_at: null,
    updated_at: NOW,
    ...over,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sessoprow-"));
  store = new Store(join(dir, "t.db"));
  store.saveUser({ username: "alice", uid: 1, home_dir: "/x/a", created_at: NOW });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("session operations", () => {
  it("reads are owner-scoped: an id from elsewhere finds nothing", () => {
    store.createSessionOperation(row());
    expect(store.getSessionOperation("op_1", "alice")?.status).toBe("submitted");
    expect(store.getSessionOperation("op_1", "bob")).toBeUndefined();
  });

  it("the dedupe lookup joins live work only, and only for the same intent", () => {
    store.createSessionOperation(row({ id: "op_live", status: "waiting_approval" }));
    expect(store.findLiveSessionOperation("alice", "hub", "res-a", "fp-1")?.id).toBe("op_live");
    // Another owner, another session, another prompt: three different intents.
    expect(store.findLiveSessionOperation("bob", "hub", "res-a", "fp-1")).toBeUndefined();
    expect(store.findLiveSessionOperation("alice", "hub", "res-b", "fp-1")).toBeUndefined();
    expect(store.findLiveSessionOperation("alice", "hub", "res-a", "fp-2")).toBeUndefined();
    expect(store.findLiveSessionOperation("alice", "app:session-plus", "res-a", "fp-1")).toBeUndefined();

    for (const done of ["succeeded", "failed", "rejected", "unknown"]) {
      store.updateSessionOperation("op_live", { status: done, updated_at: NOW });
      expect(store.findLiveSessionOperation("alice", "hub", "res-a", "fp-1"), done).toBeUndefined();
    }
  });

  it("the pending-call lookup is how an approval finds its submission", () => {
    store.createSessionOperation(row({ id: "op_p", pending_call_id: "pc_1", status: "waiting_approval" }));
    expect(store.getSessionOperationByPending("pc_1")?.id).toBe("op_p");
    expect(store.getSessionOperationByPending("pc_missing")).toBeUndefined();
  });

  it("lists newest first, optionally for one session, and never across owners", () => {
    // IDs are deliberately opposite to time: operation IDs are random and
    // must never be treated as a clock.
    store.createSessionOperation(
      row({ id: "op_z", session_id: "s1", submitted_at: "2026-08-03T09:01:00.000Z" }),
    );
    store.createSessionOperation(
      row({ id: "op_a", session_id: "s2", submitted_at: "2026-08-03T09:02:00.000Z" }),
    );
    store.createSessionOperation(row({ id: "op_c", owner: "bob", session_id: "s1" }));
    expect(store.listSessionOperations("alice").map((r) => r.id)).toEqual(["op_a", "op_z"]);
    expect(store.listSessionOperations("alice", { sessionId: "s1" }).map((r) => r.id)).toEqual(["op_z"]);
    expect(store.listSessionOperations("alice", { surface: "hub" }).map((r) => r.id)).toEqual(["op_a", "op_z"]);
    expect(store.listSessionOperations("bob").map((r) => r.id)).toEqual(["op_c"]);
  });

  it("lists everything still in flight, across owners, for boot recovery", () => {
    store.createSessionOperation(
      row({ id: "op_z", status: "running", submitted_at: "2026-08-03T09:01:00.000Z" }),
    );
    store.createSessionOperation(
      row({
        id: "op_a",
        owner: "bob",
        status: "waiting_approval",
        submitted_at: "2026-08-03T09:02:00.000Z",
      }),
    );
    store.createSessionOperation(row({ id: "op_done", status: "succeeded" }));
    expect(store.listLiveSessionOperations().map((r) => r.id)).toEqual(["op_z", "op_a"]);
  });

  it("an empty patch is a no-op rather than broken SQL", () => {
    store.createSessionOperation(row());
    expect(() => store.updateSessionOperation("op_1", { updated_at: NOW })).not.toThrow();
    store.updateSessionOperation("op_1", { status: "succeeded", detail: "OK", updated_at: "later" });
    const after = store.getSessionOperation("op_1", "alice")!;
    expect(after).toMatchObject({ status: "succeeded", detail: "OK", updated_at: "later" });
  });

  it("pruning keeps the newest N of one owner and touches nobody else", () => {
    for (let i = 0; i < 5; i++) {
      store.createSessionOperation(
        row({
          id: `op_${4 - i}`,
          status: "succeeded",
          submitted_at: `2026-08-03T09:0${i}:00.000Z`,
        }),
      );
    }
    store.createSessionOperation(row({ id: "op_bob", owner: "bob" }));
    expect(store.pruneSessionOperations("alice", 2)).toBe(3);
    expect(store.listSessionOperations("alice").map((r) => r.id)).toEqual(["op_0", "op_1"]);
    expect(store.listSessionOperations("bob")).toHaveLength(1);
  });

  it("pruning never deletes in-flight evidence even when it is older than the retained window", () => {
    store.createSessionOperation(row({ id: "op_live", status: "waiting_approval" }));
    for (let i = 0; i < 4; i++) {
      store.createSessionOperation(row({ id: `op_done_${i}`, status: "succeeded" }));
    }

    expect(store.pruneSessionOperations("alice", 2)).toBe(2);
    expect(store.getSessionOperation("op_live", "alice")?.status).toBe("waiting_approval");
    expect(store.listSessionOperations("alice").map((r) => r.id)).toEqual(["op_done_3", "op_done_2", "op_live"]);
  });
});

describe("session operation windows", () => {
  it("walks every record newest-first through the keyset cursor, past the 200-row window", () => {
    store.saveUser({ username: "bob", uid: 2, home_dir: "/x/b", created_at: NOW });
    for (let index = 0; index < 450; index += 1) {
      store.createSessionOperation(row({ id: `op_${index}`, args_hash: `fp-${index}`, status: "succeeded" }));
    }
    store.createSessionOperation(row({ id: "op_bob", owner: "bob", args_hash: "fp-bob", status: "succeeded" }));
    const seen: string[] = [];
    let before: string | undefined;
    for (;;) {
      const page = store.listSessionOperations("alice", { limit: 200, ...(before ? { beforeId: before } : {}) });
      seen.push(...page.map((r) => r.id));
      if (page.length < 200) break;
      before = page.at(-1)!.id;
    }
    expect(seen).toHaveLength(450);
    expect(new Set(seen).size).toBe(450);
    expect(seen[0]).toBe("op_449");
    expect(seen.at(-1)).toBe("op_0");
    // Another owner's id is not a cursor into this owner's records.
    expect(store.listSessionOperations("alice", { beforeId: "op_bob" })).toEqual([]);
  });
});

describe("recoverable receipts", () => {
  it("walks every observable receipt in bounded windows, newest first, each once", () => {
    for (let i = 0; i < 1_201; i += 1) {
      store.createSessionOperation(row({ id: `op_${i}`, args_hash: `fp-${i}`, status: i % 2 ? "running" : "unknown",
        runner_operation_id: `op_${i}` }));
      // Neither a settled receipt nor a submission without a Runner receipt is recoverable.
      if (i % 100 === 0) {
        store.createSessionOperation(row({ id: `done_${i}`, args_hash: `fd-${i}`, status: "succeeded", runner_operation_id: `done_${i}` }));
        store.createSessionOperation(row({ id: `bare_${i}`, args_hash: `fb-${i}`, status: "unknown" }));
      }
    }
    const seen: string[] = [];
    for (let before: number | undefined, pages = 0; ; pages += 1) {
      const page = store.listRecoverableSessionOperations({ beforeSequence: before });
      expect(page.rows.length).toBeLessThanOrEqual(500);
      seen.push(...page.rows.map((r) => r.id));
      if (page.next === null) { expect(pages).toBe(2); break; }
      before = page.next;
    }
    expect(seen).toEqual(Array.from({ length: 1_201 }, (_, i) => `op_${1_200 - i}`));
  });
});
