import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeDevTicketInput } from "../../devpipe/ticket-models.js";
import { migrateFixtureTo } from "../migration-test-helpers.js";
import { Store } from "../store.js";

describe("migration v64 (Runner bundle delivery debt)", () => {
  it("upgrades v63 additively and preserves per-ticket debt plus attempt audit", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "runner-debt-v63-"));
    const dbPath = path.join(dir, "store.db");
    const db = new Database(dbPath);
    migrateFixtureTo(db, 63);
    db.exec("INSERT INTO users (username, uid, home_dir, created_at) VALUES ('alice', 1, '/x', 't')");
    db.close();

    // Re-open through Store so the real migration runner applies v64.
    const store = new Store(dbPath);
    const ticket = store.devTickets.createDevTicket(normalizeDevTicketInput({
      title: "Runner install",
      body: "ship client",
      requester: "alice",
    }));
    store.runnerArtifacts.recordPending({
      ticket_id: ticket.id,
      commit_sha: "a".repeat(40),
      requested_by: "test",
      requested_at: "2026-08-29T00:00:00.000Z",
    });
    expect(store.runnerArtifacts.listPending()).toEqual([
      expect.objectContaining({ ticket_id: ticket.id, commit_sha: "a".repeat(40), last_error: null }),
    ]);

    store.runnerArtifacts.markFailed(
      [{ ticket_id: ticket.id, commit_sha: "a".repeat(40) }],
      "b".repeat(64),
      "syntax rejected",
      "2026-08-29T00:01:00.000Z",
    );
    expect(store.runnerArtifacts.listPending()[0]).toMatchObject({
      candidate_sha: "b".repeat(64),
      last_error: "syntax rejected",
    });
    store.runnerArtifacts.recordPending({
      ticket_id: ticket.id,
      commit_sha: "c".repeat(40),
      requested_by: "test:replay",
      requested_at: "2026-08-29T00:02:00.000Z",
    });
    store.runnerArtifacts.markFailed(
      [{ ticket_id: ticket.id, commit_sha: "a".repeat(40) }],
      "d".repeat(64),
      "stale attempt",
      "2026-08-29T00:03:00.000Z",
    );
    expect(store.runnerArtifacts.listPending()[0]).toMatchObject({
      commit_sha: "c".repeat(40),
      candidate_sha: null,
      last_error: null,
    });
    const audit = store.runnerArtifacts.recordAudit({
      target_commit: "a".repeat(40),
      candidate_sha: "b".repeat(64),
      previous_sha: null,
      outcome: "failed",
      actor: "test",
      attempted_at: "2026-08-29T00:01:00.000Z",
      error: "syntax rejected",
    });
    expect(store.runnerArtifacts.listAudit()).toEqual([audit]);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
