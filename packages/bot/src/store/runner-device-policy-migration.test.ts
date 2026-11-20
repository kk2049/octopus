import { MIGRATIONS } from "./migrations.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrateFixtureTo } from "./migration-test-helpers.js";
import { Store } from "./store.js";

describe("Runner device-policy migrations", () => {
  let fixtureDir: string | undefined;

  afterEach(() => {
    if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
    fixtureDir = undefined;
  });

  it("keeps existing bridge policy while defaulting every device injection closed", () => {
    fixtureDir = mkdtempSync(path.join(tmpdir(), "octopus-runner-policy-v64-"));
    const dbPath = path.join(fixtureDir, "fixture.db");
    const oldDb = new Database(dbPath);
    migrateFixtureTo(oldDb, 64);
    oldDb.prepare("INSERT INTO users (username, uid, home_dir, created_at) VALUES (?, ?, ?, ?)")
      .run("alice", 5001, "/x/alice", "2026-08-30T00:00:00.000Z");
    oldDb.prepare("INSERT INTO runner_tokens (token_hash, username, device, created_at) VALUES (?, ?, ?, ?)")
      .run("hash", "alice", "laptop", "2026-08-30T00:00:00.000Z");
    oldDb.prepare(`
      INSERT INTO runner_device_policies
        (username, device, local_agent_bridge_mode, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?)
    `).run("alice", "laptop", "full_access", "2026-08-30T00:01:00.000Z", "alice");
    oldDb.close();

    const store = new Store(dbPath);
    expect(store.getRunnerDevicePolicy("alice", "laptop")).toMatchObject({
      local_agent_bridge_mode: "full_access",
      default_agent_injection: 0,
      gui_automation_enabled: 0,
    });
    store.close();

    const upgraded = new Database(dbPath);
    expect(upgraded.prepare("SELECT MAX(version) AS version FROM schema_version").get())
      .toEqual({ version: MIGRATIONS.at(-1)!.version });
    expect(() => upgraded.prepare(
      "UPDATE runner_device_policies SET default_agent_injection = 2 WHERE username = 'alice'",
    ).run()).toThrow(/CHECK constraint/);
    expect(() => upgraded.prepare(
      "UPDATE runner_device_policies SET gui_automation_enabled = 2 WHERE username = 'alice'",
    ).run()).toThrow(/CHECK constraint/);
    upgraded.close();
  });
});
