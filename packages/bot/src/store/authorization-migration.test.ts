import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { AuthorizationService } from "../authorization/service.js";
import { MIGRATIONS } from "./migrations.js";
import { migrateFixtureTo } from "./migration-test-helpers.js";
import { Store } from "./store.js";

describe("canonical authorization migrations", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("upgrades a real v44 migration chain without rewriting retained data", () => {
    dir = mkdtempSync(path.join(tmpdir(), "octopus-authz-migration-"));
    const dbPath = path.join(dir, "fixture.db");
    const oldDb = new Database(dbPath);
    migrateFixtureTo(oldDb, 44);
    oldDb.exec(`
      CREATE TABLE retained_v42_fact (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO retained_v42_fact(id, value) VALUES ('old', 'keep-me');
    `);
    oldDb.close();

    const store = new Store(dbPath);
    expect(store.authorization.listDomains()).toEqual([]);
    const authorization = new AuthorizationService({
      repository: store.authorization,
      now: () => Date.parse("2026-08-15T00:00:00.000Z"),
      newId: () => "permit:persisted",
    });
    authorization.upsertDomain({
      id: "personal:alice",
      kind: "personal",
      title: "Alice",
      authority: { kind: "owner", id: "alice" },
      historyPolicy: "all",
    });
    authorization.upsertResource({
      id: "resource:persisted",
      uri: "object://fixtures/alice/persisted-note",
      owner: "alice",
      domainId: "personal:alice",
      kind: "note",
      title: "Persisted note",
      sensitivity: "normal",
      externalRef: { system: "fixture", id: "note:persisted" },
    });
    authorization.putPermit({
      subject: { type: "app", id: "reader" },
      resourceId: "resource:persisted",
      operation: "read",
      mode: "allow",
      authority: { kind: "owner", id: "alice" },
      source: "user",
      createdBy: "alice",
    });
    authorization.setAppInstallDefaults("alice", { writeMode: "deny", executeMode: "ask" }, "alice");
    authorization.close();
    store.close();

    const restartedStore = new Store(dbPath);
    const restarted = new AuthorizationService({ repository: restartedStore.authorization });
    expect(restarted.decideAccess({
      subject: { type: "app", id: "reader" },
      resourceId: "resource:persisted",
      operation: "read",
    })).toMatchObject({ result: "allow", code: "exact_permit_allow" });
    expect(restarted.getAppInstallDefaults("alice").profile.writeMode).toBe("deny");
    expect(restarted.revokePermit({
      subject: { type: "app", id: "reader" },
      resourceId: "resource:persisted",
      operation: "read",
      authority: { kind: "owner", id: "alice" },
      revokedBy: "alice",
    })).toMatchObject({ revokedBy: "alice", revokedAt: expect.any(String) });
    restarted.close();
    restartedStore.close();

    const afterRevokeStore = new Store(dbPath);
    const afterRevoke = new AuthorizationService({ repository: afterRevokeStore.authorization });
    expect(afterRevoke.decideAccess({
      subject: { type: "app", id: "reader" },
      resourceId: "resource:persisted",
      operation: "read",
    })).toMatchObject({ result: "deny", code: "install_permit_missing" });
    expect(afterRevoke.listPermits({
      resourceId: "resource:persisted",
      subject: { type: "app", id: "reader" },
      operation: "read",
      includeRevoked: true,
    })).toEqual([expect.objectContaining({ revokedBy: "alice", revokedAt: expect.any(String) })]);
    afterRevoke.close();
    afterRevokeStore.close();

    const upgraded = new Database(dbPath, { readonly: true });
    expect(upgraded.prepare("SELECT MAX(version) AS version FROM schema_version").get())
      .toEqual({ version: MIGRATIONS.at(-1)!.version });
    expect(upgraded.prepare("SELECT * FROM retained_v42_fact").get())
      .toEqual({ id: "old", value: "keep-me" });
    const tables = (upgraded.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'authorization_%' ORDER BY name",
    ).all() as Array<{ name: string }>).map((row) => row.name);
    expect(tables).toEqual([
      "authorization_domains",
      "authorization_owner_defaults",
      "authorization_permits",
      "authorization_resource_aliases",
      "authorization_resources",
    ]);
    upgraded.close();
  });

  it("backfills bounded canonical URIs, adopts semantic URIs once, and persists aliases from v52", () => {
    dir = mkdtempSync(path.join(tmpdir(), "octopus-authz-uri-migration-"));
    const dbPath = path.join(dir, "fixture.db");
    const oldDb = new Database(dbPath);
    migrateFixtureTo(oldDb, 52);
    oldDb.exec(`
      INSERT INTO authorization_domains(
        id, kind, title, authority_type, authority_id, history_policy, created_at, updated_at
      ) VALUES (
        'personal:alice', 'personal', 'Alice', 'owner', 'alice', 'all',
        '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z'
      );
      INSERT INTO authorization_resources(
        id, owner, domain_id, kind, title, sensitivity, external_system, external_id, created_at, updated_at
      ) VALUES (
        'resource:legacy', 'alice', 'personal:alice', 'note', 'Legacy', 'normal',
        'fixture', 'old:1', '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z'
      );
    `);
    const chunkedHex = (value: string) =>
      Buffer.from(value, "utf8").toString("hex").match(/.{1,256}/g)!.join("/");
    const legacyUri = (system: string, id: string) =>
      `object://legacy/s/${chunkedHex(system)}/i/${chunkedHex(id)}`;
    const maxSystem = "s".repeat(256);
    const maxId = "i".repeat(512);
    oldDb.prepare(`
      INSERT INTO authorization_resources(
        id, owner, domain_id, kind, title, sensitivity, external_system, external_id, created_at, updated_at
      ) VALUES (
        ?, 'alice', 'personal:alice', 'note', 'Maximum Legacy', 'normal',
        ?, ?, '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z'
      )
    `).run("resource:max-legacy", maxSystem, maxId);
    const tentacleObjectId = "tool:fixture:share-1";
    oldDb.prepare(`
      INSERT INTO authorization_resources(
        id, owner, domain_id, kind, title, sensitivity, external_system, external_id, created_at, updated_at
      ) VALUES (
        'resource:tentacle-share', 'alice', 'personal:alice', 'tentacle-tool', 'Legacy shell', 'sensitive',
        'tentacle', ?, '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z'
      )
    `).run(tentacleObjectId);
    oldDb.close();

    const store = new Store(dbPath);
    const authorization = new AuthorizationService({ repository: store.authorization });
    expect(authorization.getResource("resource:legacy")?.uri)
      .toBe(legacyUri("fixture", "old:1"));
    const maxLegacyUri = legacyUri(maxSystem, maxId);
    expect(Buffer.byteLength(maxLegacyUri, "utf8")).toBeLessThanOrEqual(2_048);
    expect(maxLegacyUri.split("/").slice(3).every((segment) =>
      Buffer.byteLength(segment, "utf8") <= 256
    )).toBe(true);
    expect(authorization.getResource(maxLegacyUri)?.id).toBe("resource:max-legacy");
    const migratedTentacleUri = legacyUri("tentacle", tentacleObjectId);
    expect(authorization.getResource("resource:tentacle-share")?.uri).toBe(migratedTentacleUri);
    const semanticTentacleUri = "tool://dsh/alice/dsh%3Alaptop/tools/bash";
    expect(authorization.upsertResource({
      id: "resource:tentacle-share",
      uri: semanticTentacleUri,
      owner: "alice",
      domainId: "personal:alice",
      kind: "tentacle-tool",
      title: "dsh 工具 · bash",
      sensitivity: "sensitive",
      externalRef: { system: "tentacle", id: tentacleObjectId },
    }).uri).toBe(semanticTentacleUri);
    expect(authorization.getResource(migratedTentacleUri)).toBeUndefined();
    expect(() => authorization.upsertResource({
      id: "resource:tentacle-share",
      uri: "tool://dsh/alice/dsh%3Alaptop/tools/other",
      owner: "alice",
      domainId: "personal:alice",
      kind: "tentacle-tool",
      title: "dsh 工具 · other",
      sensitivity: "sensitive",
      externalRef: { system: "tentacle", id: tentacleObjectId },
    })).toThrow("immutable");
    authorization.putResourceAlias({
      owner: "alice",
      uri: "object://legacy-fixtures/alice/old-1",
      targetUri: legacyUri("fixture", "old:1"),
      createdBy: "alice",
    });
    authorization.close();
    store.close();

    const restartedStore = new Store(dbPath);
    const restarted = new AuthorizationService({ repository: restartedStore.authorization });
    expect(restarted.getResource("object://legacy-fixtures/alice/old-1")?.id).toBe("resource:legacy");
    expect(restarted.listResourceAliases({ owner: "alice" })).toEqual([
      expect.objectContaining({
        uri: "object://legacy-fixtures/alice/old-1",
        targetUri: legacyUri("fixture", "old:1"),
      }),
    ]);
    restarted.close();
    restartedStore.close();
  });
});
