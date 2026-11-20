import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrateFixtureTo } from "./migration-test-helpers.js";
import { Store } from "./store.js";

describe("migration v39 (identity display metadata)", () => {
  let fixtureDir: string | undefined;

  afterEach(async () => {
    if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
  });

  it("upgrades a v38 fixture without changing existing identity resolution", async () => {
    fixtureDir = await mkdtemp(path.join(tmpdir(), "octopus-identity-v38-"));
    const dbPath = path.join(fixtureDir, "fixture.db");
    const oldDb = new Database(dbPath);
    // Replay the shipped chain: a schema-version marker is only truthful when
    // all earlier tables exist, and later migrations may legitimately use any
    // of them even though this assertion focuses on identity rows.
    migrateFixtureTo(oldDb, 38);
    oldDb.exec(`
      INSERT INTO users (username, uid, home_dir, created_at)
      VALUES ('alice', 5001, '/data/users/alice', '2026-08-01T00:00:00.000Z');
      INSERT INTO user_identities (provider, external_id, username) VALUES
        ('feishu', 'ou_alice', 'alice'),
        ('cli', 'cli_alice', 'alice');
    `);
    oldDb.close();

    const store = new Store(dbPath);
    expect(store.resolveIdentity("feishu", "ou_alice")).toBe("alice");
    expect(store.resolveIdentity("cli", "cli_alice")).toBe("alice");
    expect(store.getIdentitiesByUser("alice")).toEqual([
      {
        provider: "feishu",
        external_id: "ou_alice",
        username: "alice",
        label: null,
        created_at: null,
      },
      {
        provider: "cli",
        external_id: "cli_alice",
        username: "alice",
        label: null,
        created_at: null,
      },
    ]);

    store.saveIdentity("alice", {
      provider: "github",
      externalId: "123456",
      label: "alice-gh",
    });
    const github = store.getIdentitiesByUser("alice").find((row) => row.provider === "github");
    expect(github).toMatchObject({
      external_id: "123456",
      username: "alice",
      label: "alice-gh",
    });
    expect(github?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(store.resolveIdentity("github", "123456")).toBe("alice");
    store.close();
  });
});
