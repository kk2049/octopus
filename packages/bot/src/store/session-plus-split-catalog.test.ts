import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrateFixtureTo } from "./migration-test-helpers.js";
import { Store, type SessionPlusSplitSessionRow } from "./store.js";

const CREATED = "2026-08-31T00:00:00.000Z";
const UPDATED = "2026-09-01T00:00:00.000Z";

describe("migration v67 (Sessions+ split-session catalog)", () => {
  let fixtureDir: string | undefined;

  afterEach(async () => {
    if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
    fixtureDir = undefined;
  });

  it("backfills retained execution bindings as owner-scoped legacy provenance", async () => {
    fixtureDir = await mkdtemp(path.join(tmpdir(), "octopus-session-plus-catalog-v66-"));
    const dbPath = path.join(fixtureDir, "fixture.db");
    const oldDb = new Database(dbPath);
    migrateFixtureTo(oldDb, 66);
    oldDb.prepare(`
      INSERT INTO users (username, uid, home_dir, created_at)
      VALUES (?, ?, ?, ?)
    `).run("alice", 5001, "/x/alice", CREATED);
    oldDb.prepare(`
      INSERT INTO session_execution_bindings (
        owner, runtime_owner, runtime_device, runtime_resource_id, source,
        session_id, operation_id, execution_device, workspace_id,
        permission_profile, token_hash, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "alice",
      "runtime-owner",
      "runner-a",
      "agent-runtime:shared",
      "codex",
      "thread-existing",
      "op_existing123",
      "runner-b",
      "ws_0123456789abcdef01234567",
      "full_access",
      "hash",
      "2026-09-02T00:00:00.000Z",
      CREATED,
      UPDATED,
    );
    oldDb.close();

    const store = new Store(dbPath);
    expect(store.getSessionPlusSplitSession("alice", "runner-a", "codex", "thread-existing"))
      .toMatchObject({
        owner: "alice",
        runtime_owner: "runtime-owner",
        runtime_resource_id: "agent-runtime:shared",
        execution_device: "runner-b",
        workspace_id: "ws_0123456789abcdef01234567",
        catalog_id: null,
        workspace_label: "",
        workspace_display: "",
      });
    expect(store.getSessionPlusSplitSession("bob", "runner-a", "codex", "thread-existing"))
      .toBeUndefined();
    store.close();
  });

  it("keeps provenance after execution expiry and upgrades legacy display evidence", () => {
    const store = new Store(":memory:");
    store.saveUser({ username: "alice", uid: 5001, home_dir: "/x/alice", created_at: CREATED });
    const legacy: SessionPlusSplitSessionRow = {
      owner: "alice",
      runtime_owner: "alice",
      runtime_device: "runner-a",
      runtime_resource_id: null,
      source: "codex",
      session_id: "thread-one",
      catalog_id: null,
      execution_device: "runner-b",
      workspace_id: "ws_0123456789abcdef01234567",
      workspace_label: "",
      workspace_display: "",
      created_at: CREATED,
      updated_at: CREATED,
    };
    store.saveSessionPlusSplitSession(legacy);
    store.saveSessionPlusSplitSession({
      ...legacy,
      catalog_id: `spc_${"a".repeat(64)}`,
      workspace_label: "Octopus",
      workspace_display: "~/lht/octopus",
      updated_at: UPDATED,
    });

    expect(store.listSessionPlusSplitSessions("alice")).toEqual([
      expect.objectContaining({
        session_id: "thread-one",
        catalog_id: `spc_${"a".repeat(64)}`,
        workspace_label: "Octopus",
        workspace_display: "~/lht/octopus",
        created_at: CREATED,
        updated_at: UPDATED,
      }),
    ]);
    expect(() => store.saveSessionPlusSplitSession({
      ...legacy,
      catalog_id: `spc_${"b".repeat(64)}`,
      execution_device: "runner-c",
      updated_at: "2026-09-01T01:00:00.000Z",
    })).toThrow(/cannot be rebound/);
    store.close();
  });
});
