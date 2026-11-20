import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrateFixtureTo } from "./migration-test-helpers.js";
import { Store } from "./store.js";

describe("migration v60 (knowledge conflict collaboration)", () => {
  let fixtureDir: string | undefined;

  afterEach(async () => {
    if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
    fixtureDir = undefined;
  });

  it("adds stable ticket linkage and the append-only annotation ledger", async () => {
    fixtureDir = await mkdtemp(path.join(tmpdir(), "octopus-knowledge-collaboration-v59-"));
    const dbPath = path.join(fixtureDir, "fixture.db");
    const oldDb = new Database(dbPath);
    migrateFixtureTo(oldDb, 59);
    oldDb.close();

    const store = new Store(dbPath);
    const first = store.knowledge.recordAnnotation({
      subject_id: "opposite:decision:a:decision:b",
      body: "Prefer the newer requirement.",
      actor: "alice",
    });
    const second = store.knowledge.recordAnnotation({
      subject_id: first.subject_id,
      body: "Keep the old statement as history.",
      actor: "bob",
    });

    expect(store.knowledge.listAnnotations(first.subject_id)).toEqual([first, second]);
    store.close();

    const upgraded = new Database(dbPath, { readonly: true });
    expect(upgraded.prepare("SELECT 1 AS present FROM schema_version WHERE version = 60").get()).toEqual({ present: 1 });
    const ticketColumns = upgraded.prepare("PRAGMA table_info(dev_tickets)").all() as Array<{ name: string }>;
    expect(ticketColumns.map((column) => column.name)).toContain("knowledge_subject_id");
    expect(upgraded.prepare("SELECT subject_id, body, actor FROM knowledge_annotations ORDER BY id").all()).toEqual([
      { subject_id: first.subject_id, body: first.body, actor: "alice" },
      { subject_id: first.subject_id, body: second.body, actor: "bob" },
    ]);
    upgraded.close();
  });
});
