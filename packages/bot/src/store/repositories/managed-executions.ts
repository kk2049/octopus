import type Database from "better-sqlite3";
import type { ManagedExecution, RecoveryEvidence } from "@claude-bot/runner/managed-execution";

export interface ManagedExecutionRow extends ManagedExecution {
  revision: number;
  reference: string;
  dispatch: RecoveryEvidence["dispatch"];
  createdAt: string;
  updatedAt: string;
  detail?: string;
  /** Private adapter checkpoint, like a transcript; never part of a public projection. */
  checkpoint?: unknown;
}

/** This journal owns recovery, not grants. Every adapter rechecks its own authority. */
export class ManagedExecutionsRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: Omit<ManagedExecutionRow, "revision">): ManagedExecutionRow {
    const row = { ...input, revision: 1 };
    this.db.prepare(`INSERT INTO managed_executions (id, owner, source, desired, observed, next_retry_at, revision, record)
      VALUES (@id, @owner, @source, @desired, @observed, @nextRetryAt, @revision, @record)
      ON CONFLICT(id) DO NOTHING`).run({ ...row, nextRetryAt: row.nextRetryAt ?? null, record: JSON.stringify(row) });
    const stored = this.get(input.owner, input.id);
    if (!stored || stored.source !== input.source || stored.reference !== input.reference) throw new Error("managed execution identity collision");
    return stored;
  }

  get(owner: string, id: string): ManagedExecutionRow | undefined {
    const row = this.db.prepare("SELECT record FROM managed_executions WHERE owner=? AND id=?").get(owner, id) as { record: string } | undefined;
    return row ? JSON.parse(row.record) as ManagedExecutionRow : undefined;
  }

  /** Internal wake path; callers never expose this unscoped lookup to requests. */
  getForRecovery(id: string): ManagedExecutionRow | undefined {
    const row = this.db.prepare("SELECT record FROM managed_executions WHERE id=?").get(id) as { record: string } | undefined;
    return row ? JSON.parse(row.record) as ManagedExecutionRow : undefined;
  }

  replace(previous: ManagedExecutionRow, next: Omit<ManagedExecutionRow, "revision">): ManagedExecutionRow | null {
    if (next.id !== previous.id || next.owner !== previous.owner || next.source !== previous.source || next.reference !== previous.reference) {
      throw new Error("managed execution identity cannot change");
    }
    const row = { ...next, revision: previous.revision + 1 };
    const result = this.db.prepare(`UPDATE managed_executions SET desired=@desired, observed=@observed,
      next_retry_at=@nextRetryAt, revision=@revision, record=@record WHERE owner=@owner AND id=@id AND revision=@previousRevision`)
      .run({ ...row, nextRetryAt: row.nextRetryAt ?? null, record: JSON.stringify(row), previousRevision: previous.revision });
    return result.changes === 1 ? row : null;
  }

  /** Trusted startup/worker scan. User reads must use listOwned/get. */
  ready(source: string, now: string, limit = 100): ManagedExecutionRow[] {
    return this.decode(this.db.prepare(`SELECT record FROM managed_executions
      WHERE source=? AND desired='running' AND observed IN ('preparing','running','reconnecting','waiting_resource')
      AND (next_retry_at IS NULL OR next_retry_at <= ?) ORDER BY next_retry_at, id LIMIT ?`)
      .all(source, now, Math.max(1, Math.min(1000, limit))));
  }

  /** Domain identity lookup; only an active owner-scoped intent can be reattached. */
  active(owner: string, source: string, reference: string): ManagedExecutionRow | undefined {
    const rows = this.db.prepare(`SELECT record FROM managed_executions
      WHERE owner=? AND source=? AND desired='running'
      AND observed IN ('preparing','running','reconnecting','waiting_resource')
      AND json_extract(record, '$.reference')=? ORDER BY rowid DESC LIMIT 1`).all(owner, source, reference);
    return this.decode(rows)[0];
  }

  listOwned(owner: string, limit = 100): ManagedExecutionRow[] {
    return this.decode(this.db.prepare("SELECT record FROM managed_executions WHERE owner=? ORDER BY id DESC LIMIT ?")
      .all(owner, Math.max(1, Math.min(1000, limit))));
  }

  private decode(rows: unknown[]): ManagedExecutionRow[] {
    return (rows as { record: string }[]).map(row => JSON.parse(row.record) as ManagedExecutionRow);
  }
}
