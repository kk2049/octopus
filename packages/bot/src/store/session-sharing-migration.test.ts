import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { migrateFixtureTo } from "./migration-test-helpers.js";
import { Store } from "./store.js";

it("upgrades v70 without losing account data and keeps guest identities outside the user table", () => {
  const dir = mkdtempSync(join(tmpdir(), "sharing-v70-"));
  const file = join(dir, "db");
  try {
    const before = new Database(file); migrateFixtureTo(before, 70);
    before.prepare("INSERT INTO users(username, uid, home_dir, created_at) VALUES (?, ?, ?, ?)").run("alice", 5001, "/fixture/alice", "2026-09-09T00:00:00Z");
    before.close();
    const store = new Store(file);
    expect(store.getUser("alice")?.uid).toBe(5001);
    store.sessionShares.put({ id: "sh", owner: "alice", secretHash: "hash", resource: "opaque", title: "chat", session: {}, workspaces: [], createdAt: 1, expiresAt: 2, revokedAt: null, tokenLimit: 1_500_000, tokensUsed: 0, meter: null });
    store.sessionShares.join("sh", "share-guest:test");
    store.sessionShares.request("sh", "share-guest:test", "lease", 1);
    store.sessionShares.request("sh", "share-guest:test", "lease", 1);
    expect(store.sessionShares.requests("alice")).toHaveLength(1);
    expect(store.getUser("share-guest:test")).toBeFalsy();
    store.close();
    const reopened = new Store(file);
    expect(reopened.sessionShares.member("sh", "share-guest:test")).toBe(true);
    expect(reopened.sessionShares.list("other")).toEqual([]);
    reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
