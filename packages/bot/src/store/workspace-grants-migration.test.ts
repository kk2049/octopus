import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { migrateFixtureTo } from "./migration-test-helpers.js";
import { Store } from "./store.js";

it("upgrades v87 and keeps workspace read grants exact, owner-scoped and replaceable", () => {
  const dir = mkdtempSync(join(tmpdir(), "workspace-grants-v87-"));
  const file = join(dir, "db");
  try {
    const before = new Database(file); migrateFixtureTo(before, 87);
    for (const [name, uid] of [["alice", 5001], ["bob", 5002], ["carol", 5003]] as const) {
      before.prepare("INSERT INTO users(username, uid, home_dir, created_at) VALUES (?, ?, ?, ?)").run(name, uid, `/fixture/${name}`, "2026-10-18T00:00:00Z");
    }
    before.close();
    const store = new Store(file);
    const grants = store.workspaceGrants;
    expect(grants.replace("alice", "laptop", "ws_a", "paper", ["bob", "carol", "alice"], 1).map((g) => g.grantee)).toEqual(["bob", "carol"]);
    expect(grants.has("alice", "laptop", "ws_a", "bob")).toBe(true);
    expect(grants.has("alice", "desktop", "ws_a", "bob")).toBe(false);
    expect(grants.has("bob", "laptop", "ws_a", "alice")).toBe(false);
    // Unchanged grantees keep their date; the label follows the latest decision.
    const next = grants.replace("alice", "laptop", "ws_a", "paper-v2", ["carol"], 5);
    expect(next).toEqual([{ owner: "alice", device: "laptop", workspaceId: "ws_a", grantee: "carol", label: "paper-v2", createdAt: 1 }]);
    store.close();
    const reopened = new Store(file);
    expect(reopened.workspaceGrants.has("alice", "laptop", "ws_a", "bob")).toBe(false);
    expect(reopened.deleteUser("carol")).toBe(true);
    expect(reopened.workspaceGrants.members("alice", "laptop", "ws_a")).toEqual([]);
    reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
