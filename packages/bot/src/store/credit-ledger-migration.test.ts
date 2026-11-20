import { MIGRATIONS } from "./migrations.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrateFixtureTo } from "./migration-test-helpers.js";
import { Store } from "./store.js";

describe("migration v66 (agent token credits)", () => {
  let fixtureDir: string | undefined;

  afterEach(() => {
    if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
    fixtureDir = undefined;
  });

  it("upgrades v65 with an append-only ledger and rebuildable balances", () => {
    fixtureDir = mkdtempSync(path.join(tmpdir(), "octopus-credit-v65-"));
    const dbPath = path.join(fixtureDir, "fixture.db");
    const oldDb = new Database(dbPath);
    migrateFixtureTo(oldDb, 65);
    oldDb.close();

    const store = new Store(dbPath);
    const first = store.credits.record({
      username: "alice",
      delta: 125,
      reason: "ticket_earn",
      refKind: "dev_ticket_turn",
      refId: "465:turn-a",
      createdAt: "2026-08-30T18:50:00.000Z",
    });
    expect(first).toMatchObject({ applied: true, balance: 125 });
    expect(store.credits.record({
      username: "alice",
      delta: 125,
      reason: "ticket_earn",
      refKind: "dev_ticket_turn",
      refId: "465:turn-a",
    })).toMatchObject({ applied: false, balance: 125 });
    expect(store.credits.record({
      username: "alice",
      delta: -40,
      reason: "session_spend",
      refKind: "session_execution_turn",
      refId: "op-a:turn-1",
    })).toMatchObject({ applied: true, balance: 85 });
    expect(store.credits.record({
      username: "alice",
      delta: -40,
      reason: "session_spend",
      refKind: "session_execution_turn",
      refId: "op-a:turn-1",
    })).toMatchObject({ applied: false, balance: 85 });
    expect(() => store.credits.record({
      username: "bob",
      delta: 125,
      reason: "ticket_earn",
      refKind: "dev_ticket_turn",
      refId: "465:turn-a",
    })).toThrow(/different accounting fact/);

    expect(store.credits.rebuildBalances("2026-08-30T19:00:00.000Z")).toBe(1);
    expect(store.credits.balance("alice")).toBe(85);
    expect(store.credits.list("alice")).toHaveLength(2);
    store.close();

    const restarted = new Store(dbPath);
    expect(restarted.credits.record({
      username: "alice",
      delta: 125,
      reason: "ticket_earn",
      refKind: "dev_ticket_turn",
      refId: "465:turn-a",
    })).toMatchObject({ applied: false, balance: 85 });
    restarted.close();

    const upgraded = new Database(dbPath);
    expect(upgraded.prepare("SELECT MAX(version) AS version FROM schema_version").get())
      .toEqual({ version: MIGRATIONS.at(-1)!.version });
    expect(() => upgraded.prepare(`
      INSERT INTO credit_entries (username, delta, reason, ref_kind, ref_id, created_at)
      VALUES ('alice', 1, 'other', 'test', 'bad', '2026-08-30T19:01:00.000Z')
    `).run()).toThrow(/CHECK constraint/);
    expect(() => upgraded.prepare("UPDATE credit_entries SET delta = 1 WHERE id = 1").run())
      .toThrow(/append-only/);
    expect(() => upgraded.prepare("DELETE FROM credit_entries WHERE id = 1").run())
      .toThrow(/append-only/);
    upgraded.close();
  });
});
