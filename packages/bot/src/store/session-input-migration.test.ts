import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { migrateFixtureTo } from "./migration-test-helpers.js";
import { Store } from "./store.js";

it("upgrades v73 without changing old unknown outcomes or granting receipt recovery to legacy rows", () => {
  const dir = mkdtempSync(join(tmpdir(), "session-input-v73-"));
  const file = join(dir, "store.db");
  try {
    const old = new Database(file);
    migrateFixtureTo(old, 73);
    old.prepare(`INSERT INTO session_operations (id, owner, surface, credential, resource_id, device, cli_kind,
      session_id, operation, args_hash, status, submitted_at, updated_at)
      VALUES ('op_old', 'alice', 'hub', 'browser', 'resource', 'laptop', 'codex', 'original',
      'append_session', 'fingerprint', 'unknown', '2026-09-14T00:00:00Z', '2026-09-14T00:00:00Z')`).run();
    old.close();
    const upgraded = new Store(file);
    expect(upgraded.getSessionOperation("op_old", "alice")).toMatchObject({ status: "unknown", session_id: "original",
      input_receipt: null, runner_operation_id: null, runner_receipt_target: null });
    expect(upgraded.listRecoverableSessionOperations()).toEqual({ rows: [], next: null });
    expect(upgraded.getSessionOperation("op_old", "bob")).toBeUndefined();
    upgraded.close();
    const reopened = new Store(file);
    expect(reopened.getSessionOperation("op_old", "alice")?.status).toBe("unknown");
    reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
