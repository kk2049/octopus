import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrateFixtureTo } from "./migration-test-helpers.js";
import { Store } from "./store.js";

/**
 * The dsh fleet was retired on 2026-10-15; its tables stay (migrations never
 * run backwards), so the v41 migration must still upgrade an old database
 * additively.
 */
describe("migration v41 (per-user dsh fleet tables)", () => {
  let fixtureDir: string | undefined;

  afterEach(async () => {
    if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
  });

  it("upgrades v40 additively and keeps existing accounts", async () => {
    fixtureDir = await mkdtemp(path.join(tmpdir(), "octopus-fleet-v40-"));
    const dbPath = path.join(fixtureDir, "fixture.db");
    const oldDb = new Database(dbPath);
    migrateFixtureTo(oldDb, 40);
    oldDb.exec(`
      INSERT INTO users (username, uid, home_dir, created_at) VALUES
        ('alice', 5001, '/data/users/alice', '2026-08-01T00:00:00.000Z'),
        ('bob', 5002, '/data/users/bob', '2026-08-01T00:00:00.000Z');
    `);
    oldDb.close();

    const store = new Store(dbPath);
    expect(store.getUser("alice")?.uid).toBe(5001);
    expect(store.getUser("bob")?.uid).toBe(5002);
    store.close();

    const after = new Database(dbPath, { readonly: true });
    const tables = after.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'fleet_%' ORDER BY name",
    ).all();
    expect(tables).toEqual([{ name: "fleet_instances" }, { name: "fleet_web_sessions" }]);
    after.close();
  });
});
