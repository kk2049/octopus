import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { migrateFixtureTo } from "./migration-test-helpers.js";
import { Store } from "./store.js";

it("upgrades v68 without inventing historical provenance and retains new attribution after reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "deploy-source-"));
  const file = join(dir, "store.db");
  let store: Store | undefined;
  try {
    const db = new Database(file);
    migrateFixtureTo(db, 68);
    db.prepare("INSERT INTO deploy_intents(target_sha,triggered_by,status,created_at,updated_at) VALUES('old','alice','succeeded','then','then')").run();
    db.close();
    store = new Store(file);
    expect(store.devTickets.getDeployIntent(1)).toMatchObject({ triggered_by: "alice", target_sha: "old", trigger_source: null });
    const source = JSON.stringify({ kind: "ticket_agent", ticket_id: 523, agent: "codex" });
    const row = store.devTickets.createDeployIntent({ target_sha: "new", triggered_by: "alice", trigger_source: source });
    expect(() => store!.devTickets.updateDeployIntent(row.id, { trigger_source: "forged" } as never)).toThrow(/unpatchable/);
    store.close();
    store = new Store(file);
    expect(store.devTickets.getDeployIntent(row.id)?.trigger_source).toBe(source);
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});
