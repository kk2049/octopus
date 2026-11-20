import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrateFixtureTo } from "./migration-test-helpers.js";
import { Store } from "./store.js";

describe("migration v43 (bounded Tentacle distribution evidence)", () => {
  let fixtureDir: string | undefined;
  afterEach(async () => {
    if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
  });

  it("preserves v42 fleet identity and starts legacy releases disabled", async () => {
    fixtureDir = await mkdtemp(path.join(tmpdir(), "octopus-c5-v42-"));
    const dbPath = path.join(fixtureDir, "fixture.db");
    const oldDb = new Database(dbPath);
    migrateFixtureTo(oldDb, 42);
    oldDb.exec(`
      INSERT INTO users (username, uid, home_dir, created_at)
      VALUES ('alice', 5001, '/data/users/alice', '2026-08-01T00:00:00.000Z');
      INSERT INTO fleet_instances
        (username, octopus_uid, instance_id, os_user, public_host, port,
         desired_state, observed_state, dsh_revision, tentacle_revision,
         mcp_token_hash, credential_generation, restart_count, last_health_at,
         failure_reason, created_at, updated_at)
      VALUES
        ('alice', 5001, 'u-5001', 'octo-dsh-5001', 'u-5001.dsh.example', 32000,
         'running', 'healthy', 'dsh', 'da4db5a84dec940b4332f147d87628464e2e1e23',
         NULL, 1, 0, '2026-08-15T00:00:00.000Z', NULL,
         '2026-08-15T00:00:00.000Z', '2026-08-15T00:00:00.000Z');
    `);
    oldDb.close();

    new Store(dbPath).close();
    const after = new Database(dbPath, { readonly: true });
    expect(after.prepare("SELECT * FROM fleet_instances WHERE username = ?").get("alice")).toMatchObject({
      observed_state: "healthy",
      tentacle_desired_release: "legacy-da4db5a84dec",
      tentacle_observed_release: "legacy-da4db5a84dec",
      tentacle_upgrade_state: "disabled",
      tentacle_last_attempt_release: null,
    });
    after.close();
  });
});
