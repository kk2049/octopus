import type Database from "better-sqlite3";

export interface PendingRunnerBundleRow {
  ticket_id: number;
  commit_sha: string;
  requested_by: string;
  requested_at: string;
  last_attempt_at: string | null;
  candidate_sha: string | null;
  last_error: string | null;
}

export interface RunnerBundleActivationAuditRow {
  id: number;
  target_commit: string;
  candidate_sha: string | null;
  previous_sha: string | null;
  outcome: "activated" | "unchanged" | "failed";
  actor: string;
  attempted_at: string;
  error: string | null;
}

export class RunnerArtifactsRepository {
  constructor(private readonly db: Database.Database) {}

  recordPending(row: Pick<PendingRunnerBundleRow, "ticket_id" | "commit_sha" | "requested_by" | "requested_at">): void {
    this.db.prepare(
      `INSERT INTO runner_bundle_pending
         (ticket_id, commit_sha, requested_by, requested_at, last_attempt_at, candidate_sha, last_error)
       VALUES (@ticket_id, @commit_sha, @requested_by, @requested_at, NULL, NULL, NULL)
       ON CONFLICT(ticket_id) DO UPDATE SET
         commit_sha = excluded.commit_sha,
         requested_by = excluded.requested_by,
         requested_at = excluded.requested_at,
         last_attempt_at = NULL,
         candidate_sha = NULL,
         last_error = NULL`,
    ).run(row);
  }

  listPending(): PendingRunnerBundleRow[] {
    return this.db.prepare(
      "SELECT * FROM runner_bundle_pending ORDER BY requested_at, ticket_id",
    ).all() as PendingRunnerBundleRow[];
  }

  markFailed(
    rows: ReadonlyArray<Pick<PendingRunnerBundleRow, "ticket_id" | "commit_sha">>,
    candidateSha: string | null,
    error: string,
    at: string,
  ): void {
    if (!rows.length) return;
    const update = this.db.prepare(
      `UPDATE runner_bundle_pending
         SET last_attempt_at = ?, candidate_sha = ?, last_error = ?
       WHERE ticket_id = ? AND commit_sha = ?`,
    );
    this.db.transaction(() => {
      for (const row of rows) update.run(at, candidateSha, error, row.ticket_id, row.commit_sha);
    })();
  }

  clearIf(ticketId: number, commitSha: string): boolean {
    return this.db.prepare(
      "DELETE FROM runner_bundle_pending WHERE ticket_id = ? AND commit_sha = ?",
    ).run(ticketId, commitSha).changes === 1;
  }

  clearCoveredAndRecordAudit(
    rows: ReadonlyArray<Pick<PendingRunnerBundleRow, "ticket_id" | "commit_sha">>,
    audit: Omit<RunnerBundleActivationAuditRow, "id">,
  ): RunnerBundleActivationAuditRow {
    return this.db.transaction(() => {
      for (const row of rows) this.clearIf(row.ticket_id, row.commit_sha);
      return this.recordAudit(audit);
    })();
  }

  hasPendingForTickets(ticketIds: readonly number[]): boolean {
    if (!ticketIds.length) return false;
    const placeholders = ticketIds.map(() => "?").join(",");
    return Boolean(this.db.prepare(
      `SELECT 1 FROM runner_bundle_pending WHERE ticket_id IN (${placeholders}) LIMIT 1`,
    ).get(...ticketIds));
  }

  recordAudit(row: Omit<RunnerBundleActivationAuditRow, "id">): RunnerBundleActivationAuditRow {
    const result = this.db.prepare(
      `INSERT INTO runner_bundle_activation_audit
         (target_commit, candidate_sha, previous_sha, outcome, actor, attempted_at, error)
       VALUES (@target_commit, @candidate_sha, @previous_sha, @outcome, @actor, @attempted_at, @error)`,
    ).run(row);
    return this.db.prepare(
      "SELECT * FROM runner_bundle_activation_audit WHERE id = ?",
    ).get(result.lastInsertRowid) as RunnerBundleActivationAuditRow;
  }

  listAudit(limit = 20): RunnerBundleActivationAuditRow[] {
    return this.db.prepare(
      "SELECT * FROM runner_bundle_activation_audit ORDER BY id DESC LIMIT ?",
    ).all(Math.max(1, Math.min(100, limit))) as RunnerBundleActivationAuditRow[];
  }
}
