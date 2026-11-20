import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { migrateFixtureTo } from "./migration-test-helpers.js";
import { Store } from "./store.js";

it("preserves pre-v83 debt and consumes only the published revision across restart", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "app-revisions-")), file = path.join(dir, "db");
  let store: Store | undefined;
  try {
    const old = new Database(file); migrateFixtureTo(old, 82);
    old.prepare("INSERT INTO app_release_pending VALUES ('session-plus','older',1,'alice','2026-10-13T01:00:00Z','original')").run();
    old.close();
    store = new Store(file);
    const older = store.appCatalog.listPendingAppReleases()[0];
    expect(store.appCatalog.listPendingAppReleaseRevisions()).toEqual([older]);
    const newer = { ...older, commit_sha: "newer", ticket_id: 2, requested_at: "2026-10-13T02:00:00Z" };
    store.appCatalog.recordPendingAppRelease(newer);
    expect(store.appCatalog.listPendingAppReleases()).toEqual([newer]);
    expect(store.appCatalog.listPendingAppReleaseRevisions()).toEqual([older, newer]);
    expect(store.appCatalog.clearPendingAppReleaseIf("session-plus", "older", 2)).toBe(false);
    expect(store.appCatalog.clearPendingAppReleaseIf("session-plus", "older", 1)).toBe(true);
    store.close(); store = new Store(file);
    expect(store.appCatalog.listPendingAppReleases()).toEqual([newer]);
    expect(store.appCatalog.listPendingAppReleaseRevisions()).toEqual([newer]);
    expect(store.appCatalog.clearPendingAppReleaseIf("session-plus", "newer", 2)).toBe(true);
    expect(store.appCatalog.listPendingAppReleaseRevisions()).toEqual([]);
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("keeps retained older binaries' writes and clears coherent with the revision ledger", () => {
  const store = new Store(":memory:");
  try {
    const row = { app_id: "session-plus", commit_sha: "older", ticket_id: 1,
      requested_by: "alice", requested_at: "same-time", reason: "original" };
    store.appCatalog.recordPendingAppRelease(row);
    store.appCatalog.recordPendingAppRelease({ ...row, commit_sha: "newer", ticket_id: 2 });
    // Removing a single revision must retain/reproject the other receipt.
    expect(store.appCatalog.clearPendingAppReleaseIf("session-plus", "newer", 2)).toBe(true);
    expect(store.appCatalog.listPendingAppReleases()).toEqual([row]);
    store.appCatalog.recordPendingAppRelease({ ...row, commit_sha: "latest", ticket_id: 3 });
    // This is also the pre-v83 clear: deleting the summary after its newest
    // release was published must not resurrect debt on a later upgrade.
    store.appCatalog.clearPendingAppRelease("session-plus");
    expect(store.appCatalog.listPendingAppReleases()).toEqual([]);
    expect(store.appCatalog.listPendingAppReleaseRevisions()).toEqual([]);
  } finally { store.close(); }
});
