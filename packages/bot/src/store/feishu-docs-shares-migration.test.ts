import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { migrateFixtureTo } from "./migration-test-helpers.js";
import { Store } from "./store.js";

it("upgrades v86 with account data intact and keeps Feishu Docs shares owner-scoped and revocable", () => {
  const dir = mkdtempSync(join(tmpdir(), "docs-shares-v86-"));
  const file = join(dir, "db");
  try {
    const before = new Database(file); migrateFixtureTo(before, 86);
    before.prepare("INSERT INTO users(username, uid, home_dir, created_at) VALUES (?, ?, ?, ?)").run("alice", 5001, "/fixture/alice", "2026-10-16T00:00:00Z");
    before.close();
    const store = new Store(file);
    expect(store.getUser("alice")?.uid).toBe(5001);
    const shares = store.feishuDocsShares;
    shares.create({ id: "h1", owner: "alice", resource: "r1", title: "Paper", createdAt: 1, revokedAt: null });
    shares.create({ id: "h2", owner: "alice", resource: "r1", title: "Paper", createdAt: 2, revokedAt: null });
    shares.create({ id: "h3", owner: "bob", resource: "r2", title: "Other", createdAt: 3, revokedAt: null });
    expect(shares.liveCounts("alice")).toEqual(new Map([["r1", 2]]));
    expect(shares.revoke("bob", { id: "h1" }, 9)).toEqual([]);
    expect(shares.revoke("alice", { id: "h1" }, 9)).toEqual(["h1"]);
    store.close();
    const reopened = new Store(file);
    expect(reopened.feishuDocsShares.get("h1")?.revokedAt).toBe(9);
    expect(reopened.feishuDocsShares.revoke("alice", { resource: "r1" }, 10)).toEqual(["h2"]);
    expect(reopened.feishuDocsShares.liveCounts("alice").size).toBe(0);
    expect(reopened.feishuDocsShares.get("h3")?.revokedAt).toBeNull();
    reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
