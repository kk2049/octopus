import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS } from "./migrations.js";
import { Store, type AppAgentKey } from "./store.js";

let dir: string;
let store: Store;

const KEY: AppAgentKey = { appId: "session-plus", scopeKey: "account:alice", agent: "keeper" };
const OTHER: AppAgentKey = { appId: "session-plus", scopeKey: "account:bob", agent: "keeper" };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "app-agent-store-"));
  store = new Store(join(dir, "t.db"));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("migration v29", () => {
  it("is additive only, so an older binary reads and writes everything it knows", () => {
    const sql = MIGRATIONS.find((row) => row.version === 29)!.sql;
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS app_agent_cursors/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS app_agent_turns/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS app_agent_messages/);
    for (const forbidden of [/\bALTER\b/i, /\bDROP\b/i, /\bUPDATE\b/i, /\bDELETE\b/i, /\bINSERT\b/i]) {
      expect(sql, String(forbidden)).not.toMatch(forbidden);
    }
  });

  it("does not store inbox messages: those belong to the App's own event log", () => {
    // The split is the design. Messages must survive a restart, be ordered and
    // be idempotent — App State gives all three — while the cursor and the
    // transcript need updates and pruning, which an append-only log does not.
    const sql = MIGRATIONS.find((row) => row.version === 29)!.sql;
    expect(sql).not.toMatch(/inbox_text|message_body|sys_agent_inbox/);
  });
});

describe("app agent cursors and turns", () => {
  it("registers an agent without consuming anything", () => {
    expect(store.getAppAgentCursor(KEY)).toBeUndefined();
    const created = store.ensureAppAgentCursor(KEY);
    expect(created.upto_seq).toBe(0);
    // Idempotent: a second delivery must not reset a cursor.
    store.claimAppAgentInbox({ key: KEY, owner: "alice", turnId: "t1", trigger: "inbox", fromSeq: 0, uptoSeq: 4 });
    expect(store.ensureAppAgentCursor(KEY).upto_seq).toBe(4);
  });

  it("advances the cursor and opens the turn atomically, or does neither", () => {
    store.ensureAppAgentCursor(KEY);
    const turn = store.claimAppAgentInbox({ key: KEY, owner: "alice", turnId: "t1", trigger: "inbox", fromSeq: 0, uptoSeq: 3 });
    expect(turn).toMatchObject({ status: "running", from_seq: 0, upto_seq: 3, owner: "alice" });
    expect(store.getAppAgentCursor(KEY)!.upto_seq).toBe(3);

    // A second pump that read the same range loses: `fromSeq` no longer
    // matches, so it claims nothing AND opens no turn. Without the check the
    // same batch would run twice.
    expect(store.claimAppAgentInbox({ key: KEY, owner: "alice", turnId: "t2", trigger: "inbox", fromSeq: 0, uptoSeq: 3 }))
      .toBeNull();
    expect(store.getAppAgentTurn("t2")).toBeUndefined();
    expect(store.getAppAgentCursor(KEY)!.upto_seq).toBe(3);
  });

  it("refuses to claim before the cursor row exists", () => {
    expect(store.claimAppAgentInbox({ key: KEY, owner: "alice", turnId: "t1", trigger: "inbox", fromSeq: 0, uptoSeq: 1 }))
      .toBeNull();
  });

  it("settles what a previous process left running as unknown, and only that", () => {
    store.ensureAppAgentCursor(KEY);
    store.claimAppAgentInbox({ key: KEY, owner: "alice", turnId: "t1", trigger: "inbox", fromSeq: 0, uptoSeq: 1 });
    store.claimAppAgentInbox({ key: KEY, owner: "alice", turnId: "t2", trigger: "inbox", fromSeq: 1, uptoSeq: 2 });
    store.finishAppAgentTurn("t1", "succeeded", null);
    expect(store.recoverAppAgentTurns("restarted")).toEqual(["t2"]);
    expect(store.getAppAgentTurn("t1")!.status).toBe("succeeded");
    expect(store.getAppAgentTurn("t2")).toMatchObject({ status: "unknown", note: "restarted" });
    // The cursor is untouched: nothing is replayed.
    expect(store.getAppAgentCursor(KEY)!.upto_seq).toBe(2);
    expect(store.recoverAppAgentTurns("again")).toEqual([]);
  });

  it("never lets a finish rewrite a turn that already ended", () => {
    store.ensureAppAgentCursor(KEY);
    store.claimAppAgentInbox({ key: KEY, owner: "alice", turnId: "t1", trigger: "inbox", fromSeq: 0, uptoSeq: 1 });
    store.finishAppAgentTurn("t1", "failed", "boom", 2);
    store.finishAppAgentTurn("t1", "succeeded", "actually fine");
    expect(store.getAppAgentTurn("t1")).toMatchObject({ status: "failed", note: "boom", tool_calls: 2 });
  });

  it("scopes every read by (app, scope, agent) rather than by caller convention", () => {
    store.ensureAppAgentCursor(KEY);
    store.ensureAppAgentCursor(OTHER);
    store.claimAppAgentInbox({ key: KEY, owner: "alice", turnId: "t1", trigger: "inbox", fromSeq: 0, uptoSeq: 1 });
    store.addAppAgentMessage(KEY, "t1", "user", "alice 的话");
    store.addAppAgentMessage(OTHER, "-", "user", "bob 的话");
    expect(store.listAppAgentTurns(OTHER)).toHaveLength(0);
    expect(store.listAppAgentMessages(KEY).map((row) => row.content)).toEqual(["alice 的话"]);
    expect(store.listAppAgentMessages(OTHER).map((row) => row.content)).toEqual(["bob 的话"]);
  });

  it("returns the transcript oldest-first and prunes only the oldest", () => {
    store.ensureAppAgentCursor(KEY);
    for (let i = 0; i < 6; i++) store.addAppAgentMessage(KEY, "t1", "user", `m${i}`);
    expect(store.listAppAgentMessages(KEY).map((row) => row.content)).toEqual(["m0", "m1", "m2", "m3", "m4", "m5"]);
    expect(store.pruneAppAgentMessages(KEY, 2)).toBe(4);
    expect(store.listAppAgentMessages(KEY).map((row) => row.content)).toEqual(["m4", "m5"]);
  });

  it("lists cursors so a scheduler never has to enumerate accounts", () => {
    store.ensureAppAgentCursor(KEY);
    store.ensureAppAgentCursor(OTHER);
    expect(store.listAppAgentCursors("session-plus").map((row) => row.scope_key))
      .toEqual(["account:alice", "account:bob"]);
    expect(store.listAppAgentCursors("other-app")).toHaveLength(0);
  });
});
