import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { migrateFixtureTo } from "./migration-test-helpers.js";
import { Store } from "./store.js";

it("upgrades review history and keeps exact candidate snapshots append-only across restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-review-"));
  const file = join(dir, "store.db");
  try {
    const old = new Database(file);
    migrateFixtureTo(old, 69);
    const deploymentSource = JSON.stringify({ kind: "ticket_agent", ticket_id: 523 });
    old.prepare("INSERT INTO deploy_intents(target_sha, triggered_by, trigger_source, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("old", "alice", deploymentSource, "succeeded", "2026-09-07", "2026-09-07");
    old.prepare("INSERT INTO knowledge_reviews (subject_id, rule, decision, note, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("requirement:a", "source", "question", "source pointer", "alice", "2026-09-07");
    old.close();
    let store = new Store(file);
    expect(store.devTickets.getDeployIntent(1)?.trigger_source).toBe(deploymentSource);
    const candidate = { conflict: { id: "conflict:a", rule: "required_record_changed", a_id: "requirement:a", b_id: null, severity: "high" as const, why: "原要求被删除" }, nodes: [null, null], target_sha: "a".repeat(40), fingerprint: "b".repeat(64) };
    store.knowledge.recordReviewCandidate(candidate);
    store.knowledge.recordReviewCandidate(candidate);
    expect(store.knowledge.listReviews()).toHaveLength(1);
    expect(store.knowledge.listReviewCandidates()).toEqual([candidate]);
    store.close();
    store = new Store(file);
    expect(store.devTickets.getDeployIntent(1)?.trigger_source).toBe(deploymentSource);
    expect(store.knowledge.listReviewCandidates()).toEqual([candidate]);
    store.close();
    const db = new Database(file);
    expect(() => db.prepare("DELETE FROM knowledge_reviews").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM knowledge_review_candidates").run()).toThrow(/append-only/);
    expect(() => db.prepare("UPDATE knowledge_review_candidates SET target_sha = 'changed'").run()).toThrow(/append-only/);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
