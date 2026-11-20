import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { migrateFixtureTo } from "./migration-test-helpers.js";
import { Store } from "./store.js";

it("upgrades v79 without changing historical deployments and retains immutable release pins", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "release-pin-")), file = path.join(dir, "db"); let store: Store | undefined;
  try {
    const old = new Database(file); migrateFixtureTo(old, 79);
    old.prepare("INSERT INTO deploy_intents(target_sha,triggered_by,status,created_at,updated_at) VALUES('old','owner','succeeded','then','then')").run(); old.close();
    store = new Store(file); expect(store.devTickets.getDeployIntent(1)?.release_manifest_sha256).toBeNull();
    const intent = store.devTickets.createDeployIntent({ target_sha: "a".repeat(40), triggered_by: "owner", release_manifest_sha256: "b".repeat(64) });
    expect(() => store!.devTickets.updateDeployIntent(intent.id, { release_manifest_sha256: "c".repeat(64) } as never)).toThrow(/unpatchable/);
    store.close(); store = new Store(file); expect(store.devTickets.getDeployIntent(intent.id)?.release_manifest_sha256).toBe("b".repeat(64));
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});


it("upgrades v80 tickets without scheduling native sessions, and preserves input uncertainty across restart", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "native-migration-")), file = path.join(dir, "db"); let store: Store | undefined;
  try {
    const old = new Database(file); migrateFixtureTo(old, 80);
    old.prepare("INSERT INTO users(username,uid,home_dir,created_at) VALUES('alice',1,'/alice','then')").run();
    old.prepare("INSERT INTO dev_tickets(title,body,requester,kind,model,effort,created_at,updated_at) VALUES('legacy','body','alice','simple','codex','high','then','then')").run(); old.close();
    store = new Store(file); expect(store.devTickets.getDevTicket(1)?.native_binding).toBeNull();
    const ticket = store.devTickets.registerNativeTicket({ owner: "alice", device: "runner", source: "codex", sessionId: "native-session",
      workspaceId: "workspace", relativePath: "feature", branch: "dev/feature", remote: "git@gitlab:team/repo.git", title: "native" });
    const operation = store.devTickets.createNativeInput({ id: "operation", ticketId: ticket.id, kind: "message", state: "unknown" }, "alice", "continue");
    store.close(); store = new Store(file);
    expect(store.devTickets.nativeInput(operation.id)).toEqual(operation);
    expect(store.devTickets.getDevTicket(ticket.id)?.native_binding).toBe(ticket.native_binding);
    expect(store.devTickets.listTicketsNeedingTurn().some(row => row.id === ticket.id)).toBe(false);
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});
