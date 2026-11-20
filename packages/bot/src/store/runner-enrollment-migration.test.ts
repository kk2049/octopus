import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrateFixtureTo } from "./migration-test-helpers.js";

describe("migration v63 (one-shot Runner installation enrollment)", () => {
  it("adds the bounded credential table without changing existing Runner tokens", () => {
    const db = new Database(":memory:");
    migrateFixtureTo(db, 63);
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'runner_enrollments'").get() as { sql?: string } | undefined;
    const sql = String(row?.sql ?? "");
    expect(sql).toContain("consumed_at");
    expect(sql).toContain("REFERENCES users(username) ON DELETE CASCADE");
    expect(db.prepare("SELECT MAX(version) AS version FROM schema_version").get()).toEqual({ version: 63 });
    db.close();
  });
});
