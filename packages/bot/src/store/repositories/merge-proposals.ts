/**
 * Merge proposals — the review lane's durable record (2026-08-20).
 *
 * A review-lane ticket cannot fast-forward the base branch. When its agent
 * calls `devpipe_submit`, the pipeline publishes the verified candidate as a
 * `contrib/<user>/ticket-<id>` branch and writes ONE row here. Everything that
 * happens to that candidate afterwards — CI verdict, merge request, the
 * maintainer's decision, the batch merge — is a status transition on this row.
 *
 * The ticket itself stays a conversation (`dev_status` remains `open`): a
 * rejected proposal is feedback the agent answers with another submit, which
 * supersedes the previous row rather than mutating it.
 *
 * State machine (see `devpipe/contrib-review.ts` for who moves what):
 *
 *   ci_pending ──red──▶ ci_failed          (agent fixes, resubmits → new row)
 *       │
 *       └──green──▶ awaiting_review ──reject──▶ rejected (same feedback loop)
 *                         │
 *                         └──approve──▶ approved ──batch──▶ merging
 *                                                              │
 *                                                   ┌──────────┴──────────┐
 *                                                 merged            merge_failed
 *
 *   any non-terminal ──resubmit──▶ superseded
 */

import type Database from "better-sqlite3";

export const MERGE_PROPOSAL_STATUSES = [
  "ci_pending",
  "ci_failed",
  "awaiting_review",
  "approved",
  "rejected",
  "merging",
  "merged",
  "merge_failed",
  "superseded",
] as const;
export type MergeProposalStatus = (typeof MERGE_PROPOSAL_STATUSES)[number];

/** Rows in these states may still change; everything else is history. */
export const MERGE_PROPOSAL_LIVE_STATUSES: ReadonlySet<MergeProposalStatus> = new Set([
  "ci_pending",
  "ci_failed",
  "awaiting_review",
  "approved",
  "rejected",
  "merging",
  "merge_failed",
]);

export interface MergeProposalRow {
  id: number;
  ticket_id: number;
  requester: string;
  /** The remote branch the candidate was pushed to: `contrib/<user>/ticket-<id>`. */
  branch: string;
  /** The candidate commit — already rebased onto `base_sha` when published. */
  sha: string;
  base_sha: string;
  /** The agent's own summary of the change, shown to the reviewer. */
  summary: string;
  status: MergeProposalStatus;
  pipeline_id: string | null;
  pipeline_url: string | null;
  mr_iid: number | null;
  mr_url: string | null;
  review_by: string | null;
  review_at: string | null;
  review_note: string | null;
  /** The direct-lane ticket whose agent was asked to merge this batch. */
  merge_ticket_id: number | null;
  merged_sha: string | null;
  /** Free-text evidence for the current status (CI digest, merge error, …). */
  detail: string | null;
  created_at: string;
  updated_at: string;
}

export interface MergeProposalPatch {
  status: MergeProposalStatus;
  pipeline_id: string | null;
  pipeline_url: string | null;
  mr_iid: number | null;
  mr_url: string | null;
  review_by: string | null;
  review_at: string | null;
  review_note: string | null;
  merge_ticket_id: number | null;
  merged_sha: string | null;
  detail: string | null;
}

const PATCHABLE = new Set<keyof MergeProposalPatch>([
  "status",
  "pipeline_id",
  "pipeline_url",
  "mr_iid",
  "mr_url",
  "review_by",
  "review_at",
  "review_note",
  "merge_ticket_id",
  "merged_sha",
  "detail",
]);

export class MergeProposalsRepository {
  constructor(private readonly db: Database.Database) {}

  /**
   * Record a freshly published candidate. Every live row of the same ticket
   * becomes `superseded` in the same transaction: a ticket has at most one
   * proposal a reviewer can act on.
   */
  create(input: {
    ticket_id: number;
    requester: string;
    branch: string;
    sha: string;
    base_sha: string;
    summary: string;
    status: Extract<MergeProposalStatus, "ci_pending" | "awaiting_review">;
    pipeline_id?: string | null;
    pipeline_url?: string | null;
    detail?: string | null;
  }): MergeProposalRow {
    return this.db.transaction(() => {
      const now = new Date().toISOString();
      const live = [...MERGE_PROPOSAL_LIVE_STATUSES].map(() => "?").join(", ");
      this.db
        .prepare(
          `UPDATE merge_proposals SET status = 'superseded', updated_at = ?
            WHERE ticket_id = ? AND status IN (${live})`,
        )
        .run(now, input.ticket_id, ...MERGE_PROPOSAL_LIVE_STATUSES);
      const res = this.db
        .prepare(
          `INSERT INTO merge_proposals
             (ticket_id, requester, branch, sha, base_sha, summary, status, pipeline_id, pipeline_url, detail, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.ticket_id,
          input.requester,
          input.branch,
          input.sha,
          input.base_sha,
          input.summary,
          input.status,
          input.pipeline_id ?? null,
          input.pipeline_url ?? null,
          input.detail ?? null,
          now,
          now,
        );
      return this.get(Number(res.lastInsertRowid))!;
    })();
  }

  get(id: number): MergeProposalRow | undefined {
    return this.db.prepare("SELECT * FROM merge_proposals WHERE id = ?").get(id) as MergeProposalRow | undefined;
  }

  /** The newest row of a ticket, whatever its status. */
  latestForTicket(ticketId: number): MergeProposalRow | undefined {
    return this.db
      .prepare("SELECT * FROM merge_proposals WHERE ticket_id = ? ORDER BY id DESC LIMIT 1")
      .get(ticketId) as MergeProposalRow | undefined;
  }

  /** The one row a reviewer or the pipeline may still act on, if any. */
  liveForTicket(ticketId: number): MergeProposalRow | undefined {
    const live = [...MERGE_PROPOSAL_LIVE_STATUSES].map(() => "?").join(", ");
    return this.db
      .prepare(`SELECT * FROM merge_proposals WHERE ticket_id = ? AND status IN (${live}) ORDER BY id DESC LIMIT 1`)
      .get(ticketId, ...MERGE_PROPOSAL_LIVE_STATUSES) as MergeProposalRow | undefined;
  }

  listByStatus(statuses: readonly MergeProposalStatus[], limit = 200): MergeProposalRow[] {
    if (statuses.length === 0) return [];
    const marks = statuses.map(() => "?").join(", ");
    return this.db
      .prepare(`SELECT * FROM merge_proposals WHERE status IN (${marks}) ORDER BY id ASC LIMIT ?`)
      .all(...statuses, limit) as MergeProposalRow[];
  }

  /** Every row a board wants to show: live ones plus recent history. */
  listRecent(limit = 200): MergeProposalRow[] {
    return this.db
      .prepare("SELECT * FROM merge_proposals ORDER BY id DESC LIMIT ?")
      .all(limit) as MergeProposalRow[];
  }

  /** Rows handed to one batch-merge ticket. */
  listForMergeTicket(mergeTicketId: number): MergeProposalRow[] {
    return this.db
      .prepare("SELECT * FROM merge_proposals WHERE merge_ticket_id = ? ORDER BY id ASC")
      .all(mergeTicketId) as MergeProposalRow[];
  }

  update(id: number, patch: Partial<MergeProposalPatch>): MergeProposalRow | undefined {
    const keys = Object.keys(patch) as Array<keyof MergeProposalPatch>;
    for (const key of keys) {
      if (!PATCHABLE.has(key)) throw new Error(`unpatchable merge_proposal column: ${String(key)}`);
    }
    if (keys.length) {
      const sets = keys.map((key) => `${String(key)} = ?`).join(", ");
      this.db
        .prepare(`UPDATE merge_proposals SET ${sets}, updated_at = ? WHERE id = ?`)
        .run(...keys.map((key) => patch[key] ?? null), new Date().toISOString(), id);
    }
    return this.get(id);
  }

  /**
   * Move a row from one status to another, atomically. Returns false when
   * the row is no longer in `from` — the caller's view was stale and nothing
   * was written, which is how two reviewers clicking at once resolve.
   */
  transition(
    id: number,
    from: readonly MergeProposalStatus[],
    to: MergeProposalStatus,
    patch: Partial<Omit<MergeProposalPatch, "status">> = {},
  ): boolean {
    const keys = Object.keys(patch) as Array<keyof Omit<MergeProposalPatch, "status">>;
    for (const key of keys) {
      if (!PATCHABLE.has(key)) throw new Error(`unpatchable merge_proposal column: ${String(key)}`);
    }
    const marks = from.map(() => "?").join(", ");
    const sets = ["status = ?", ...keys.map((key) => `${String(key)} = ?`), "updated_at = ?"].join(", ");
    const res = this.db
      .prepare(`UPDATE merge_proposals SET ${sets} WHERE id = ? AND status IN (${marks})`)
      .run(to, ...keys.map((key) => patch[key] ?? null), new Date().toISOString(), id, ...from);
    return res.changes === 1;
  }

  /** ticket_id → newest row, for annotating a ticket roster in one query. */
  latestByTicket(): Map<number, MergeProposalRow> {
    const rows = this.db
      .prepare(
        `SELECT p.* FROM merge_proposals p
          WHERE p.id = (SELECT MAX(q.id) FROM merge_proposals q WHERE q.ticket_id = p.ticket_id)`,
      )
      .all() as MergeProposalRow[];
    return new Map(rows.map((row) => [row.ticket_id, row]));
  }
}
