/**
 * Migration v49: the two credential tables `external-app-host/v1` persists.
 *
 * The invariant worth a test is not "the tables exist" — it is that a database
 * that predates the feature upgrades with its data intact and gains rows that
 * hold DIGESTS, and that a spent handoff stays spent across the restart that a
 * new `Store` object is.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrateFixtureTo } from "./migration-test-helpers.js";
import { Store } from "./store.js";

const NOW = "2026-08-17T00:00:00.000Z";
const LATER = "2026-08-17T00:01:00.000Z";
const APP = "chess";
const INSTANCE = "asi_" + "a".repeat(32);

function grant(overrides: Record<string, unknown> = {}) {
  return {
    grant_id: "xag_1",
    token_hash: "t".repeat(64),
    app_id: APP,
    instance_key: INSTANCE,
    username: "lht",
    host_id: "dsh-local",
    host_origin: "http://127.0.0.1:9931",
    release_digest: "d".repeat(64),
    authority: "human",
    created_at: NOW,
    expires_at: "2026-08-17T00:02:00.000Z",
    consumed_at: null,
    consumed_credential: null,
    ...overrides,
  };
}

function capability(overrides: Record<string, unknown> = {}) {
  return {
    credential_id: "xai_1",
    secret_hash: "s".repeat(64),
    app_id: APP,
    instance_key: INSTANCE,
    username: "lht",
    host_id: "dsh-local",
    host_origin: "http://127.0.0.1:9931",
    release_digest: "d".repeat(64),
    authority: "human",
    grant_id: "xag_1",
    created_at: NOW,
    expires_at: "2026-08-18T00:00:00.000Z",
    last_used_at: null,
    revoked_at: null,
    revoked_reason: null,
    ...overrides,
  };
}

describe("migration v49 (external App host bindings)", () => {
  let fixtureDir: string | undefined;
  afterEach(async () => {
    if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
  });

  it("upgrades a v48 database without touching what was already there", async () => {
    fixtureDir = await mkdtemp(path.join(tmpdir(), "octopus-external-v48-"));
    const dbPath = path.join(fixtureDir, "fixture.db");
    const oldDb = new Database(dbPath);
    migrateFixtureTo(oldDb, 48);
    oldDb.exec(`
      INSERT INTO users (username, uid, home_dir, created_at)
      VALUES ('lht', 5001, '/home/ubuntu', '${NOW}');
      INSERT INTO app_shared_instances (app_id, instance_key, creator, created_at, status)
      VALUES ('${APP}', '${INSTANCE}', 'lht', '${NOW}', 'open');
      INSERT INTO app_shared_members (app_id, instance_key, username, role, joined_at)
      VALUES ('${APP}', '${INSTANCE}', 'lht', 'white', '${NOW}');
    `);
    oldDb.close();

    const store = new Store(dbPath);
    expect(store.getSharedAppInstance(APP, INSTANCE)).toMatchObject({ creator: "lht", status: "open" });
    // The new tables start empty: an upgrade grants nobody anything.
    expect(store.listExternalAppCapabilities("lht", APP)).toEqual([]);
    expect(store.getExternalAppLaunchGrant("xag_1")).toBeUndefined();
    store.close();
  });

  it("redeems a handoff exactly once, and remembers that it did", async () => {
    fixtureDir = await mkdtemp(path.join(tmpdir(), "octopus-external-fresh-"));
    const dbPath = path.join(fixtureDir, "fresh.db");
    const store = new Store(dbPath);
    store.createExternalAppLaunchGrant(grant());

    const first = store.consumeExternalAppLaunchGrant("t".repeat(64), "xai_1", NOW, 8);
    expect(first).toMatchObject({ ok: true, row: { grant_id: "xag_1", consumed_credential: "xai_1" } });
    expect(store.consumeExternalAppLaunchGrant("t".repeat(64), "xai_2", NOW, 8))
      .toMatchObject({ ok: false, reason: "invalid" });
    // The row survives as evidence rather than being deleted: "was this link
    // ever redeemed, and by which credential" stays answerable.
    expect(store.getExternalAppLaunchGrant("xag_1")).toMatchObject({
      consumed_at: NOW,
      consumed_credential: "xai_1",
    });
    store.close();

    // A restart: the spent handoff is still spent, and the binding it minted
    // still resolves by digest.
    const reopened = new Store(dbPath);
    expect(reopened.consumeExternalAppLaunchGrant("t".repeat(64), "xai_3", NOW, 8))
      .toMatchObject({ ok: false, reason: "invalid" });
    reopened.createExternalAppCapability(capability());
    reopened.close();
    const third = new Store(dbPath);
    expect(third.getActiveExternalAppCapability("s".repeat(64), NOW)).toMatchObject({ username: "lht" });
    third.close();
  });

  it("refuses an expired handoff without consuming it, and never resolves a dead binding", async () => {
    fixtureDir = await mkdtemp(path.join(tmpdir(), "octopus-external-ttl-"));
    const store = new Store(path.join(fixtureDir, "fresh.db"));
    store.createExternalAppLaunchGrant(grant({ expires_at: NOW }));
    expect(store.consumeExternalAppLaunchGrant("t".repeat(64), "xai_1", LATER, 8))
      .toMatchObject({ ok: false, reason: "invalid" });
    expect(store.getExternalAppLaunchGrant("xag_1")?.consumed_at).toBeNull();

    store.createExternalAppCapability(capability({ expires_at: LATER }));
    expect(store.getActiveExternalAppCapability("s".repeat(64), NOW)).toMatchObject({ credential_id: "xai_1" });
    expect(store.getActiveExternalAppCapability("s".repeat(64), LATER)).toBeUndefined();

    store.createExternalAppCapability(capability({ credential_id: "xai_2", secret_hash: "q".repeat(64) }));
    // Owner-scoped: naming somebody else's credential id is not authority over it.
    expect(store.revokeExternalAppCapability("mallory", "xai_2", LATER, "user")).toBeUndefined();
    expect(store.revokeExternalAppCapability("lht", "xai_2", LATER, "user")).toMatchObject({ revoked_at: LATER });
    expect(store.getActiveExternalAppCapability("q".repeat(64), NOW)).toBeUndefined();
    // Revocation marks rather than deletes: the list still shows what ended.
    expect(store.listExternalAppCapabilities("lht", APP).map((row) => row.credential_id).sort())
      .toEqual(["xai_1", "xai_2"]);
    store.close();
  });

  it("deletes both credential kinds with the account that minted them", async () => {
    fixtureDir = await mkdtemp(path.join(tmpdir(), "octopus-external-user-"));
    const store = new Store(path.join(fixtureDir, "fresh.db"));
    store.saveUser({ username: "lht", uid: 5001, home_dir: "/home/ubuntu", created_at: NOW });
    store.createExternalAppLaunchGrant(grant());
    store.createExternalAppCapability(capability());
    expect(store.deleteUser("lht")).toBe(true);
    expect(store.listExternalAppCapabilities("lht", APP)).toEqual([]);
    expect(store.getExternalAppLaunchGrant("xag_1")).toBeUndefined();
    store.close();
  });
});
