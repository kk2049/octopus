import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Store } from "./store.js";
import { MIGRATIONS } from "./migrations.js";

it("upgrades the preceding schema without changing durable session evidence, then fences stale recovery writes", () => {
  const dir = mkdtempSync(join(tmpdir(), "managed-migration-"));
  const file = join(dir, "bot.db");
  let store: Store | undefined;
  try {
    const old = new Database(file);
    old.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY)");
    for (const migration of MIGRATIONS.filter(row => row.version < 77)) {
      old.exec(migration.sql);
      old.prepare("INSERT INTO schema_version VALUES (?)").run(migration.version);
    }
    old.prepare("INSERT INTO users (username, uid, home_dir, created_at) VALUES (?, ?, ?, ?)")
      .run("alice", 2001, dir, "2026-09-16T00:00:00Z");
    old.close();
    store = new Store(file);
    expect(store.getUser("alice")?.uid).toBe(2001);
    const at = "2026-09-16T00:00:00.000Z";
    const first = store.managedExecutions.create({ id: "job", reference: "original", owner: "alice", source: "session",
      desired: "running", observed: "reconnecting", resumeOwner: "runner", dispatch: "sent", createdAt: at, updatedAt: at });
    expect(store.managedExecutions.get("bob", "job")).toBeUndefined();
    expect(store.managedExecutions.replace(first, { ...first, desired: "cancelled" })?.revision).toBe(2);
    expect(store.managedExecutions.replace(first, { ...first, observed: "running" })).toBeNull();
    expect(store.managedExecutions.ready("session", at)).toEqual([]);
    store.close(); store = new Store(file);
    expect(store.managedExecutions.get("alice", "job")).toMatchObject({ desired: "cancelled", revision: 2 });
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});
