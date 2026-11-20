import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  AppReleaseRegistry,
  FileReleaseContentStore,
  describeRelease,
  utf8Bytes,
  type InstallProvenance,
  type ReleaseSpec,
} from "@claude-bot/app-registry";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS } from "../store/migrations.js";
import { Store } from "../store/store.js";
import { StoreReleaseCatalog } from "./store-catalog.js";
import Database from "better-sqlite3";

const temps: string[] = [];
const stores: Store[] = [];

afterEach(() => {
  while (stores.length) stores.pop()!.close();
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

function workspace(): { dbPath: string; contentRoot: string } {
  const base = mkdtempSync(path.join(tmpdir(), "app-registry-store-"));
  temps.push(base);
  return { dbPath: path.join(base, "bot.db"), contentRoot: path.join(base, "artifacts") };
}

function openRegistry(dbPath: string, contentRoot: string): { registry: AppReleaseRegistry; store: Store } {
  const store = new Store(dbPath);
  stores.push(store);
  const registry = new AppReleaseRegistry({
    catalog: new StoreReleaseCatalog(store),
    content: new FileReleaseContentStore(contentRoot),
  });
  return { registry, store };
}

function spec(overrides: Partial<ReleaseSpec> = {}): ReleaseSpec {
  return {
    stableAppId: "demo-app",
    publisher: "octopus:first-party",
    executionProfile: "publisher-js",
    permissionContractDigest: "9f".repeat(16),
    assets: [
      { name: "index.html", content: utf8Bytes("<!doctype html><title>demo</title>") },
      { name: "main.js", content: utf8Bytes("export const boot = () => {};") },
    ],
    composition: { view: ["index.html", "main.js"], backend: [] },
    source: {
      kind: "platform-hosted",
      digest: "sha256:demo",
      repository: "platform://octopus/source",
      commit: "0f".repeat(20),
      subdir: "packages/demo-app",
    },
    buildInput: {
      entry: "app.yaml",
      toolchain: { builder: "octopus:app-release-v1", format: "named-assets", lockfile: "pnpm-lock.yaml" },
      lockfileHash: "ab".repeat(32),
    },
    ...overrides,
  };
}

const PROVENANCE: InstallProvenance = {
  kind: "platform-built",
  builder: "octopus:release-builder",
  statement: "Built by this platform from the declared source snapshot.",
  signatureVerification: "none",
};

function install(registry: AppReleaseRegistry, input: ReleaseSpec = spec()) {
  const descriptor = describeRelease(input);
  const result = registry.install({
    descriptor,
    assets: input.assets,
    provenance: PROVENANCE,
    installedBy: "ops:lht",
  });
  return { descriptor, result };
}

describe("migration v28", () => {
  it("only adds tables, so an older binary is unaffected", () => {
    // The repository's rule is additive migrations. Stated as a check rather
    // than a convention: no ALTER, no DROP, and no write to a table that
    // existed before this version.
    const sql = MIGRATIONS.find((row) => row.version === 28)!.sql;
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS app_releases/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS app_release_activations/);
    expect(sql).toMatch(/UNIQUE\s*\(package_digest, stable_app_id, publisher\)/);
    expect(sql).toMatch(
      /FOREIGN KEY\s*\(package_digest, stable_app_id, publisher\)\s*REFERENCES app_releases\(package_digest, stable_app_id, publisher\)/,
    );
    for (const forbidden of [/\bALTER\b/i, /\bDROP\b/i, /\bUPDATE\b/i, /\bDELETE\b/i, /\bINSERT\b/i]) {
      expect(sql, String(forbidden)).not.toMatch(forbidden);
    }
  });

  it("enforces the two closed vocabularies in the database", () => {
    const { dbPath, contentRoot } = workspace();
    const { store } = openRegistry(dbPath, contentRoot);
    const row = {
      package_digest: "a".repeat(64),
      stable_app_id: "demo-app",
      publisher: "octopus:first-party",
      execution_profile: "native",
      permission_contract_digest: "9f".repeat(16),
      descriptor: "{}",
      provenance_kind: "platform-built",
      provenance: "{}",
      content_root: contentRoot,
      installed_by: "ops:lht",
      installed_at: "2026-08-06T00:00:00.000Z",
      removed_by: null,
      removed_at: null,
    };
    expect(() => store.appCatalog.insertAppRelease(row)).toThrow(/CHECK/);
    expect(() => store.appCatalog.insertAppRelease({ ...row, execution_profile: "publisher-js", provenance_kind: "signed" })).toThrow(
      /CHECK/,
    );
  });

  it("binds every active pointer to the release's app and publisher", () => {
    const { dbPath, contentRoot } = workspace();
    const { registry } = openRegistry(dbPath, contentRoot);
    const { descriptor } = install(registry);
    const raw = new Database(dbPath);
    raw.pragma("foreign_keys = ON");
    try {
      expect(() =>
        raw.prepare(
          `INSERT INTO app_release_activations
             (stable_app_id, publisher, package_digest, activated_by, activated_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run("another-app", "octopus:first-party", descriptor.packageDigest, "ops:lht", "2026-08-06T00:00:00.000Z"),
      ).toThrow(/FOREIGN KEY/);
    } finally {
      raw.close();
    }
  });
});

describe("the Store-backed catalog", () => {
  it("round-trips install, activate and resolve", () => {
    const { dbPath, contentRoot } = workspace();
    const { registry, store } = openRegistry(dbPath, contentRoot);
    const { descriptor, result } = install(registry);
    expect(result.ok).toBe(true);

    expect(registry.activate("demo-app", "octopus:first-party", descriptor.packageDigest, "ops:lht").ok).toBe(true);
    const resolved = registry.resolveActive("demo-app", "octopus:first-party");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.release.descriptor.packageDigest).toBe(descriptor.packageDigest);
    expect(store.appCatalog.getActiveAppRelease("demo-app", "octopus:first-party")?.activated_by).toBe("ops:lht");
  });

  it("survives a restart: a fresh process resolves the same active release", () => {
    const { dbPath, contentRoot } = workspace();
    const first = openRegistry(dbPath, contentRoot);
    const { descriptor } = install(first.registry);
    first.registry.activate("demo-app", "octopus:first-party", descriptor.packageDigest, "ops:lht");
    first.store.close();
    stores.pop();

    const second = openRegistry(dbPath, contentRoot);
    const resolved = second.registry.resolveActive("demo-app", "octopus:first-party");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.release.descriptor).toEqual(descriptor);
    expect(resolved.release.installedBy).toBe("ops:lht");
    expect(Buffer.from(second.registry.readAsset(descriptor.packageDigest, "main.js")!).toString()).toContain("boot");
  });

  it("fails closed after a restart when the artifact did not survive", () => {
    const { dbPath, contentRoot } = workspace();
    const first = openRegistry(dbPath, contentRoot);
    const { descriptor } = install(first.registry);
    first.registry.activate("demo-app", "octopus:first-party", descriptor.packageDigest, "ops:lht");
    first.store.close();
    stores.pop();
    unlinkSync(path.join(contentRoot, "releases", `${descriptor.packageDigest}.json`));

    const second = openRegistry(dbPath, contentRoot);
    const resolved = second.registry.resolveActive("demo-app", "octopus:first-party");
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.issues[0]!.code).toBe("content_missing");
    expect(second.registry.reconcile().activeUnusable).toHaveLength(1);
  });

  it("gives two connections on the same database one deterministic result", () => {
    // Real cross-connection concurrency: two Store handles on one file, which
    // is what two processes look like to SQLite.
    const { dbPath, contentRoot } = workspace();
    const a = openRegistry(dbPath, contentRoot);
    const b = openRegistry(dbPath, contentRoot);
    const first = install(a.registry).descriptor;
    const second = install(
      b.registry,
      spec({ assets: [...spec().assets, { name: "extra.js", content: utf8Bytes("1") }] }),
    ).descriptor;

    // Each connection sees the other's committed rows.
    expect(b.registry.inspect(first.packageDigest).ok).toBe(true);
    expect(a.registry.inspect(second.packageDigest).ok).toBe(true);

    const one = a.registry.activate("demo-app", "octopus:first-party", first.packageDigest, "ops:a");
    const two = b.registry.activate("demo-app", "octopus:first-party", second.packageDigest, "ops:b");
    expect(one.ok && one.changed).toBe(true);
    expect(two.ok).toBe(true);
    if (!two.ok) return;
    expect(two.previousPackageDigest).toBe(first.packageDigest);
    expect(a.store.appCatalog.getActiveAppRelease("demo-app", "octopus:first-party")?.package_digest).toBe(second.packageDigest);
  });

  it("atomically refuses removal when another connection has activated the release", () => {
    const { dbPath, contentRoot } = workspace();
    const a = openRegistry(dbPath, contentRoot);
    const b = openRegistry(dbPath, contentRoot);
    const { descriptor } = install(a.registry);

    expect(b.registry.activate("demo-app", "octopus:first-party", descriptor.packageDigest, "ops:b").ok).toBe(true);
    expect(a.store.appCatalog.markAppReleaseRemovedIfInactive(descriptor.packageDigest, "ops:a", "2026-08-06T00:00:01.000Z"))
      .toEqual({ ok: false, code: "active_release" });
    expect(a.store.appCatalog.getAppRelease(descriptor.packageDigest)?.removed_at).toBeNull();

    b.registry.deactivate("demo-app", "octopus:first-party");
    expect(a.store.appCatalog.markAppReleaseRemovedIfInactive(descriptor.packageDigest, "ops:a", "2026-08-06T00:00:02.000Z"))
      .toEqual({ ok: true, changed: true });
  });

  it("reports a concurrent duplicate install as a deduplication, not a second row", () => {
    const { dbPath, contentRoot } = workspace();
    const a = openRegistry(dbPath, contentRoot);
    const b = openRegistry(dbPath, contentRoot);
    const first = install(a.registry);
    const second = install(b.registry);
    expect(first.result.ok && !first.result.deduplicated).toBe(true);
    expect(second.result.ok).toBe(true);
    if (!second.result.ok) return;
    expect(second.result.deduplicated).toBe(true);
    expect(b.store.appCatalog.listAppReleases()).toHaveLength(1);
  });

  it("orders listings newest install first, deterministically", () => {
    const { dbPath, contentRoot } = workspace();
    const { registry } = openRegistry(dbPath, contentRoot);
    const now = ["2026-08-06T00:00:01.000Z", "2026-08-06T00:00:02.000Z", "2026-08-06T00:00:03.000Z"];
    let tick = 0;
    const paced = new AppReleaseRegistry({
      catalog: new StoreReleaseCatalog(stores.at(-1)!),
      content: new FileReleaseContentStore(contentRoot),
      now: () => now[tick++]!,
    });
    void registry;
    const digests = [1, 2, 3].map((n) => {
      const input = spec({ assets: [...spec().assets, { name: `extra${n}.js`, content: utf8Bytes(String(n)) }] });
      const descriptor = describeRelease(input);
      paced.install({ descriptor, assets: input.assets, provenance: PROVENANCE, installedBy: "ops:lht" });
      return descriptor.packageDigest;
    });
    expect(paced.list().map((row) => row.descriptor.packageDigest)).toEqual([...digests].reverse());
  });
});

describe("deactivation does not purge anything", () => {
  it("leaves App trust, permission intent and audit history untouched", () => {
    const { dbPath, contentRoot } = workspace();
    const { registry, store } = openRegistry(dbPath, contentRoot);
    const { descriptor } = install(registry);
    registry.activate("demo-app", "octopus:first-party", descriptor.packageDigest, "ops:lht");

    store.saveUser({ username: "lht", uid: 2001, home_dir: "/home/lht", created_at: "2026-08-06T00:00:00.000Z" });
    store.saveAppTrust({
      owner: "lht",
      app_id: "demo-app",
      publisher: "octopus:first-party",
      profile: "publisher-js",
      package_digest_at_consent: descriptor.packageDigest,
      follow_updates: 0,
      decided_at: "2026-08-06T00:00:00.000Z",
      revoked_at: null,
    });
    store.saveGrantIntent({
      id: "gi_1",
      subject_type: "app",
      subject_id: "demo-app",
      owner: "lht",
      resource_type: "runner-account",
      resource_id: "*",
      operations: JSON.stringify(["read_session"]),
      terms: "{}",
      source: "user",
      status: "active",
      contract_digest: descriptor.permissionContractDigest,
      publisher: "octopus:first-party",
      created_by: "lht",
      created_at: "2026-08-06T00:00:00.000Z",
      expires_at: null,
      revoked_by: null,
      revoked_at: null,
    });
    store.recordPermissionAudit({
      at: "2026-08-06T00:00:00.000Z",
      owner: "lht",
      subject_type: "app",
      subject_id: "demo-app",
      operation: "read_session",
      resource: "runner-account:lht",
      decision: "allow",
      reason: null,
      detail: null,
    });

    expect(registry.deactivate("demo-app", "octopus:first-party")).toEqual({
      ok: true,
      previousPackageDigest: descriptor.packageDigest,
      changed: true,
    });
    expect(registry.uninstall(descriptor.packageDigest, "ops:lht")).toEqual({ ok: true, changed: true });

    // Everything a reinstall would want to be auditable against is still here.
    expect(store.getAppTrust("lht", "demo-app", "octopus:first-party")?.revoked_at).toBeNull();
    expect(store.listGrantIntents("lht")).toHaveLength(1);
    expect(store.listPermissionAudit("lht")).toHaveLength(1);
    expect(store.appCatalog.listAppReleases({ includeRemoved: true })).toHaveLength(1);
    // Uninstall removes registry reachability, while leaving the immutable
    // artifact available to the separate reconciliation/reclamation path.
    expect(registry.readAsset(descriptor.packageDigest, "main.js")).toBeNull();
    expect(new FileReleaseContentStore(contentRoot).verify(descriptor.packageDigest, descriptor.assets).ok).toBe(true);
  });
});
