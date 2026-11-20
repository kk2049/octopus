import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateFixtureTo } from "./migration-test-helpers.js";
import { Store } from "./store.js";

describe("migration v44 (session-channel durable edge)", () => {
  let dir: string | undefined;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

  it("upgrades a v43 database and preserves its user while adding restart state", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "octopus-session-channel-v43-"));
    const file = path.join(dir, "bot.db");
    const db = new Database(file);
    migrateFixtureTo(db, 43);
    db.exec(`
      INSERT INTO users (username, uid, home_dir, created_at)
      VALUES ('alice', 2001, '/tmp/alice', '2026-08-15T00:00:00.000Z');
      INSERT INTO pending_inbound(channel_id, sender_id, text, mentioned_bot, received_at)
      VALUES ('feishu:p2p:oc_restart', 'ou_alice', 'queued', 1, '2026-08-15T00:00:00.000Z');
    `);
    db.close();

    const store = new Store(file);
    expect(store.getUser("alice")?.uid).toBe(2001);
    store.close();
    // The tables stay (the retired v2 session channel was their only writer);
    // the migration must still upgrade additively and keep the queued row.
    const after = new Database(file, { readonly: true });
    expect(after.prepare("SELECT text, message_id FROM pending_inbound").all()).toEqual([
      { text: "queued", message_id: null },
    ]);
    const tables = after.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'session_channel_%' ORDER BY name").all();
    expect(tables).toEqual([
      { name: "session_channel_bindings" },
      { name: "session_channel_inbox" },
      { name: "session_channel_outbox" },
    ]);
    after.close();
  });
});
