import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { migrateFixtureTo } from "./migration-test-helpers.js";
import { Store } from "./store.js";

it("upgrades v81 without inventing publication or changing an accepted ticket, and persists projection identity", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cli-release-migration-")), file = path.join(dir, "db");
  let store: Store | undefined;
  try {
    const old = new Database(file); migrateFixtureTo(old, 81);
    old.prepare("INSERT INTO users(username,uid,home_dir,created_at) VALUES('alice',1,'/alice','before')").run();
    old.prepare("INSERT INTO dev_tickets(title,body,requester,kind,model,effort,dev_status,deploy_status,created_at,updated_at) VALUES('accepted','preserve','alice','cli','codex','high','landed','verified','before','before')").run();
    old.close(); store = new Store(file);
    expect(store.devTickets.getDevTicket(1)).toMatchObject({ body: "preserve", deploy_status: "verified" });
    expect(store.devTickets.cliReleaseProjection("a".repeat(40))).toBeUndefined();
    expect(store.appCatalog.listPendingAppReleases()).toEqual([]); expect(store.runnerArtifacts.listPending()).toEqual([]);
    store.devTickets.recordCliReleaseProjection(1, "a".repeat(40));
    store.close(); store = new Store(file);
    expect(store.devTickets.cliReleaseProjection("a".repeat(40))?.ticket_id).toBe(1);
    expect(() => store!.devTickets.recordCliReleaseProjection(2, "a".repeat(40))).toThrow("其他工单");
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});
