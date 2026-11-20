import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrateFixtureTo } from "./migration-test-helpers.js";
import { Store } from "./store.js";

describe("migration v58 (managed split-session recovery)", () => {
  let fixtureDir: string | undefined;

  afterEach(async () => {
    if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
    fixtureDir = undefined;
  });

  it("upgrades v57 with a bearer-free, provider-bounded binding table", async () => {
    fixtureDir = await mkdtemp(path.join(tmpdir(), "octopus-session-recovery-v57-"));
    const dbPath = path.join(fixtureDir, "fixture.db");
    const oldDb = new Database(dbPath);
    migrateFixtureTo(oldDb, 57);
    oldDb.prepare(`
      INSERT INTO users (username, uid, home_dir, created_at)
      VALUES (?, ?, ?, ?)
    `).run("alice", 5001, "/x/alice", "2026-08-25T00:00:00.000Z");
    oldDb.close();

    const store = new Store(dbPath);
    store.close();

    const upgraded = new Database(dbPath);
    expect(upgraded.prepare("SELECT 1 AS present FROM schema_version WHERE version = 58").get())
      .toEqual({ present: 1 });
    expect(upgraded.prepare("SELECT username, uid FROM users").get())
      .toEqual({ username: "alice", uid: 5001 });
    const columns = upgraded.prepare("PRAGMA table_info(session_execution_bindings)").all() as Array<{ name: string }>;
    expect(columns.map((row) => row.name)).toEqual([
      "owner",
      "runtime_device",
      "source",
      "session_id",
      "operation_id",
      "execution_device",
      "workspace_id",
      "permission_profile",
      "token_hash",
      "expires_at",
      "created_at",
      "updated_at",
      "runtime_owner",
      "runtime_resource_id",
    ]);
    expect(() => upgraded.prepare(`
      INSERT INTO session_execution_bindings (
        owner, runtime_device, source, session_id, operation_id,
        execution_device, workspace_id, permission_profile, token_hash,
        expires_at, created_at, updated_at
      ) VALUES ('alice', 'runner', 'unknown', 's', 'op', 'exec', 'ws',
        'full_access', 'hash', '2026-08-26T00:00:00.000Z',
        '2026-08-25T00:00:00.000Z', '2026-08-25T00:00:00.000Z')
    `).run()).toThrow(/CHECK constraint/);
    upgraded.close();
  });
});
