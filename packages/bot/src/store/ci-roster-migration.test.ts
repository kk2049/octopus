import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrateFixtureTo } from "./migration-test-helpers.js";
import { Store } from "./store.js";

describe("migration v48 (CI repair roster)", () => {
  let fixtureDir: string | undefined;
  afterEach(async () => {
    if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
  });

  it("keeps v47 tickets intact and reads them as ordinary (non-CI) tickets", async () => {
    fixtureDir = await mkdtemp(path.join(tmpdir(), "octopus-ci-roster-v47-"));
    const dbPath = path.join(fixtureDir, "fixture.db");
    const oldDb = new Database(dbPath);
    migrateFixtureTo(oldDb, 47);
    oldDb.exec(`
      INSERT INTO users (username, uid, home_dir, created_at)
      VALUES ('lht', 5001, '/home/ubuntu', '2026-08-01T00:00:00.000Z');
      INSERT INTO dev_tickets
        (title, body, requester, kind, app_id, model, effort, dev_status,
         open_question, created_at, updated_at)
      VALUES
        ('历史工单', '在 v48 之前建的票', 'lht', 'simple', NULL, 'claude-opus-5',
         'high', 'landed', '这一半要你拍板', '2026-08-16T00:00:00.000Z',
         '2026-08-16T00:00:00.000Z');
    `);
    oldDb.close();

    const store = new Store(dbPath);
    const row = store.devTickets.getDevTicket(1);
    expect(row).toMatchObject({ title: "历史工单", open_question: "这一半要你拍板" });
    // NULL rather than '[]': a ticket that predates the lane never came from a
    // red batch, and must not pick up the repair contract retroactively.
    expect(row?.ci_roster).toBeNull();
    store.close();
  });

  it("stores an empty roster distinguishably from no roster at all", async () => {
    fixtureDir = await mkdtemp(path.join(tmpdir(), "octopus-ci-roster-new-"));
    const store = new Store(path.join(fixtureDir, "fresh.db"));
    store.saveUser({ username: "lht", uid: 5001, home_dir: "/home/ubuntu", created_at: "2026-08-17T00:00:00.000Z" });

    const ordinary = store.devTickets.createDevTicket({
      title: "普通票",
      body: "x",
      requester: "lht",
      kind: "simple",
      app_id: null,
      model: "claude-opus-5",
      effort: "high",
    });
    // An infrastructure red parses no failing file, and that ticket still
    // belongs to the repair lane — hence '[]' and not NULL.
    const infraRed = store.devTickets.createDevTicket({
      title: "修复 GitLab CI 红灯",
      body: "y",
      requester: "lht",
      kind: "simple",
      app_id: null,
      model: "claude-opus-5",
      effort: "high",
      ci_roster: "[]",
    });

    expect(store.devTickets.getDevTicket(ordinary.id)?.ci_roster).toBeNull();
    expect(store.devTickets.getDevTicket(infraRed.id)?.ci_roster).toBe("[]");

    store.devTickets.updateDevTicket(infraRed.id, { ci_roster: '["packages/bot/src/a.test.ts"]' });
    expect(store.devTickets.getDevTicket(infraRed.id)?.ci_roster).toBe('["packages/bot/src/a.test.ts"]');
    store.close();
  });
});
