import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { migrateFixtureTo } from "./migration-test-helpers.js";
import { Store } from "./store.js";

const receipt = { owner: "alice", device: "laptop", provider: "codex", turnId: "turn-1", completedAt: "2026-10-15T10:00:00.000Z" };

it("upgrades v83 and claims each completion notice once, durably, inside its window", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "completion-notice-migration-")), file = path.join(dir, "db");
  let store: Store | undefined;
  try {
    const old = new Database(file); migrateFixtureTo(old, 83);
    old.prepare("INSERT INTO users(username,uid,home_dir,created_at) VALUES('alice',1,'/alice','before')").run();
    old.close(); store = new Store(file);
    expect(store.getUser("alice")).toMatchObject({ username: "alice" });
    const notBefore = "2026-10-15T09:30:00.000Z";
    expect(store.claimManagedCompletionNotice(receipt, notBefore)).toBe(true);
    expect(store.claimManagedCompletionNotice(receipt, notBefore)).toBe(false);
    // The same turn id on another device or provider is another receipt.
    expect(store.claimManagedCompletionNotice({ ...receipt, device: "desktop" }, notBefore)).toBe(true);
    expect(store.claimManagedCompletionNotice({ ...receipt, provider: "claude" }, notBefore)).toBe(true);
    // A receipt that is no longer news never notifies.
    expect(store.claimManagedCompletionNotice({ ...receipt, turnId: "old", completedAt: "2026-10-15T09:00:00.000Z" }, notBefore)).toBe(false);
    store.close(); store = new Store(file);
    expect(store.claimManagedCompletionNotice(receipt, notBefore)).toBe(false);
    // Moving the window prunes rows no replay can still make news.
    expect(store.claimManagedCompletionNotice({ ...receipt, turnId: "later", completedAt: "2026-10-15T12:00:00.000Z" }, "2026-10-15T11:00:00.000Z")).toBe(true);
    const db = new Database(file, { readonly: true });
    try {
      expect(db.prepare("SELECT turn_id FROM managed_completion_notices ORDER BY turn_id").all()).toEqual([{ turn_id: "later" }]);
    } finally { db.close(); }
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});
