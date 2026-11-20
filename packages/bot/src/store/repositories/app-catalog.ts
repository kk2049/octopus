import type Database from "better-sqlite3";

/** Durable declaration identity; a row alone serves no code. */
export interface AppDeclarationRow {
  app_id: string;
  publisher: string;
  title: string;
  enabled: number;
  declared_by: string;
  declared_at: string;
}

/** An owed App revision. This is debt, not authority. */
export interface PendingAppReleaseRow {
  app_id: string;
  commit_sha: string;
  ticket_id: number | null;
  requested_by: string;
  requested_at: string;
  reason: string;
}

export type AppHotswapApprovalState = "pending" | "approved" | "rejected" | "expired" | "executed";

export interface AppHotswapApprovalRow {
  id: string;
  ticket_id: number;
  app_id: string;
  source_commit: string;
  package_digest: string;
  previous_digest: string | null;
  contract_digest: string;
  coexistence_verdict: string;
  requested_by: string;
  requested_at: string;
  state: AppHotswapApprovalState;
  decided_by: string | null;
  decided_at: string | null;
  outcome: string | null;
}

export type AppHotswapClaimResult =
  | { ok: true; row: AppHotswapApprovalRow }
  | { ok: false; code: "unknown" | "not_pending"; row?: AppHotswapApprovalRow };

export interface AppReleaseRow {
  package_digest: string;
  stable_app_id: string;
  publisher: string;
  execution_profile: string;
  permission_contract_digest: string;
  descriptor: string;
  provenance_kind: string;
  provenance: string;
  content_root: string;
  installed_by: string;
  installed_at: string;
  removed_by: string | null;
  removed_at: string | null;
}

export interface AppReleaseActivationRow {
  stable_app_id: string;
  publisher: string;
  package_digest: string;
  activated_by: string;
  activated_at: string;
}

export type AppReleaseActivateOutcome =
  | { ok: true; previous: string | null; changed: boolean }
  | { ok: false; code: "unknown_release" | "removed_release" | "identity_mismatch" };

export type AppReleaseRemoveOutcome =
  | { ok: true; changed: boolean }
  | { ok: false; code: "unknown_release" | "active_release" };

/**
 * SQLite repository for declaration, immutable release, activation, pending
 * publication, and hot-swap approval state. It deliberately excludes App
 * trust, grants, and permission audit: catalog rows are never authority.
 */
export class AppCatalogRepository {
  constructor(private readonly db: Database.Database) {}

  insertAppDeclaration(row: AppDeclarationRow): boolean {
    return (
      this.db
        .prepare(
          `INSERT INTO app_declarations
             (app_id, publisher, title, enabled, declared_by, declared_at)
           VALUES (@app_id, @publisher, @title, @enabled, @declared_by, @declared_at)
           ON CONFLICT(app_id) DO NOTHING`,
        )
        .run(row).changes > 0
    );
  }

  getAppDeclaration(appId: string): AppDeclarationRow | undefined {
    return this.db.prepare("SELECT * FROM app_declarations WHERE app_id = ?").get(appId) as
      | AppDeclarationRow
      | undefined;
  }

  listAppDeclarations(): AppDeclarationRow[] {
    return this.db
      .prepare("SELECT * FROM app_declarations ORDER BY declared_at, app_id")
      .all() as AppDeclarationRow[];
  }

  setAppDeclarationEnabled(appId: string, enabled: boolean): boolean {
    return (
      this.db
        .prepare("UPDATE app_declarations SET enabled = ? WHERE app_id = ? AND enabled != ?")
        .run(enabled ? 1 : 0, appId, enabled ? 1 : 0).changes > 0
    );
  }

  insertAppRelease(row: AppReleaseRow): boolean {
    return (
      this.db
        .prepare(
          `INSERT INTO app_releases
             (package_digest, stable_app_id, publisher, execution_profile,
              permission_contract_digest, descriptor, provenance_kind, provenance,
              content_root, installed_by, installed_at, removed_by, removed_at)
           VALUES (@package_digest, @stable_app_id, @publisher, @execution_profile,
                   @permission_contract_digest, @descriptor, @provenance_kind, @provenance,
                   @content_root, @installed_by, @installed_at, @removed_by, @removed_at)
           ON CONFLICT(package_digest) DO NOTHING`,
        )
        .run(row).changes > 0
    );
  }

  getAppRelease(packageDigest: string): AppReleaseRow | undefined {
    return this.db.prepare("SELECT * FROM app_releases WHERE package_digest = ?").get(packageDigest) as
      | AppReleaseRow
      | undefined;
  }

  listAppReleases(
    filter: { stableAppId?: string; publisher?: string; includeRemoved?: boolean } = {},
  ): AppReleaseRow[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.stableAppId !== undefined) {
      where.push("stable_app_id = ?");
      args.push(filter.stableAppId);
    }
    if (filter.publisher !== undefined) {
      where.push("publisher = ?");
      args.push(filter.publisher);
    }
    if (!filter.includeRemoved) where.push("removed_at IS NULL");
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    return this.db
      .prepare(`SELECT * FROM app_releases ${clause} ORDER BY installed_at DESC, package_digest ASC`)
      .all(...args) as AppReleaseRow[];
  }

  markAppReleaseRemovedIfInactive(packageDigest: string, by: string, at: string): AppReleaseRemoveOutcome {
    return this.db.transaction((): AppReleaseRemoveOutcome => {
      const release = this.getAppRelease(packageDigest);
      if (!release) return { ok: false, code: "unknown_release" };
      const active = this.db
        .prepare("SELECT 1 FROM app_release_activations WHERE package_digest = ? LIMIT 1")
        .get(packageDigest);
      if (active) return { ok: false, code: "active_release" };
      if (release.removed_at) return { ok: true, changed: false };
      const changed = this.db
        .prepare(
          `UPDATE app_releases SET removed_by = ?, removed_at = ?
           WHERE package_digest = ? AND removed_at IS NULL`,
        )
        .run(by, at, packageDigest).changes > 0;
      return { ok: true, changed };
    }).immediate();
  }

  getActiveAppRelease(stableAppId: string, publisher: string): AppReleaseActivationRow | undefined {
    return this.db
      .prepare("SELECT * FROM app_release_activations WHERE stable_app_id = ? AND publisher = ?")
      .get(stableAppId, publisher) as AppReleaseActivationRow | undefined;
  }

  listActiveAppReleases(): AppReleaseActivationRow[] {
    return this.db
      .prepare("SELECT * FROM app_release_activations ORDER BY publisher, stable_app_id")
      .all() as AppReleaseActivationRow[];
  }

  activateAppRelease(request: {
    stableAppId: string;
    publisher: string;
    packageDigest: string;
    activatedBy: string;
    activatedAt: string;
  }): AppReleaseActivateOutcome {
    return this.db.transaction((): AppReleaseActivateOutcome => {
      const release = this.getAppRelease(request.packageDigest);
      if (!release) return { ok: false, code: "unknown_release" };
      if (release.removed_at) return { ok: false, code: "removed_release" };
      if (release.stable_app_id !== request.stableAppId || release.publisher !== request.publisher) {
        return { ok: false, code: "identity_mismatch" };
      }
      const previous = this.getActiveAppRelease(request.stableAppId, request.publisher)?.package_digest ?? null;
      if (previous === request.packageDigest) return { ok: true, previous, changed: false };
      this.db
        .prepare(
          `INSERT INTO app_release_activations
             (stable_app_id, publisher, package_digest, activated_by, activated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(stable_app_id, publisher) DO UPDATE SET
             package_digest = excluded.package_digest,
             activated_by = excluded.activated_by,
             activated_at = excluded.activated_at`,
        )
        .run(request.stableAppId, request.publisher, request.packageDigest, request.activatedBy, request.activatedAt);
      return { ok: true, previous, changed: true };
    }).immediate();
  }

  deactivateAppRelease(stableAppId: string, publisher: string): string | null {
    return this.db.transaction((): string | null => {
      const previous = this.getActiveAppRelease(stableAppId, publisher)?.package_digest ?? null;
      if (previous === null) return null;
      this.db
        .prepare("DELETE FROM app_release_activations WHERE stable_app_id = ? AND publisher = ?")
        .run(stableAppId, publisher);
      return previous;
    }).immediate();
  }

  recordPendingAppRelease(row: PendingAppReleaseRow): void {
    this.db
      .prepare(
        `INSERT INTO app_release_pending (app_id, commit_sha, ticket_id, requested_by, requested_at, reason)
         VALUES (@app_id, @commit_sha, @ticket_id, @requested_by, @requested_at, @reason)
         ON CONFLICT(app_id) DO UPDATE SET
           commit_sha = excluded.commit_sha,
           ticket_id = excluded.ticket_id,
           requested_by = excluded.requested_by,
           requested_at = excluded.requested_at,
           reason = excluded.reason`,
      )
      .run(row);
  }

  /** Every revision survives until the release containing it is activated. */
  recordPendingAppReleaseRevision(row: PendingAppReleaseRow): void {
    this.db.prepare(`INSERT INTO app_release_pending_revisions
      (app_id, commit_sha, ticket_id, requested_by, requested_at, reason)
      VALUES (@app_id, @commit_sha, @ticket_id, @requested_by, @requested_at, @reason)
      ON CONFLICT(app_id, commit_sha) DO NOTHING`).run(row);
  }

  listPendingAppReleaseRevisions(appId?: string): PendingAppReleaseRow[] {
    return this.db.prepare(`SELECT * FROM app_release_pending_revisions
      WHERE (? IS NULL OR app_id = ?) ORDER BY requested_at, rowid`)
      .all(appId ?? null, appId ?? null) as PendingAppReleaseRow[];
  }

  listPendingAppReleases(): PendingAppReleaseRow[] {
    return this.db
      .prepare("SELECT * FROM app_release_pending ORDER BY app_id")
      .all() as PendingAppReleaseRow[];
  }

  clearPendingAppRelease(appId: string): void {
    this.db.prepare("DELETE FROM app_release_pending WHERE app_id = ?").run(appId);
  }

  clearPendingAppReleaseIf(appId: string, commitSha: string, ticketId: number | null): boolean {
    return this.db.transaction(() => {
      const changed = this.db.prepare("DELETE FROM app_release_pending_revisions WHERE app_id = ? AND commit_sha = ? AND ticket_id IS ?")
        .run(appId, commitSha, ticketId).changes;
      if (!changed) return false;
      const summaryMatches = this.db.prepare("SELECT 1 FROM app_release_pending WHERE app_id = ? AND commit_sha = ? AND ticket_id IS ?")
        .get(appId, commitSha, ticketId);
      if (!summaryMatches) return true;
      const next = this.db.prepare(`SELECT * FROM app_release_pending_revisions
        WHERE app_id = ? ORDER BY requested_at DESC, rowid DESC LIMIT 1`).get(appId) as PendingAppReleaseRow | undefined;
      if (next) this.recordPendingAppRelease(next);
      else this.clearPendingAppRelease(appId);
      return true;
    }).immediate();
  }

  recordAppHotswapApproval(
    row: Omit<AppHotswapApprovalRow, "state" | "decided_by" | "decided_at" | "outcome">,
  ): { created: boolean; row: AppHotswapApprovalRow } {
    const result = this.db
      .prepare(
        `INSERT INTO app_hotswap_approvals
           (id, ticket_id, app_id, source_commit, package_digest, previous_digest,
            contract_digest, coexistence_verdict, requested_by, requested_at, state)
         VALUES
           (@id, @ticket_id, @app_id, @source_commit, @package_digest, @previous_digest,
            @contract_digest, @coexistence_verdict, @requested_by, @requested_at, 'pending')
         ON CONFLICT(ticket_id, app_id, package_digest) DO NOTHING`,
      )
      .run(row);
    const stored = this.db
      .prepare("SELECT * FROM app_hotswap_approvals WHERE ticket_id = ? AND app_id = ? AND package_digest = ?")
      .get(row.ticket_id, row.app_id, row.package_digest) as AppHotswapApprovalRow | undefined;
    if (!stored) throw new Error("app hotswap approval insert was not readable");
    return { created: result.changes > 0, row: stored };
  }

  getAppHotswapApproval(id: string): AppHotswapApprovalRow | undefined {
    return this.db.prepare("SELECT * FROM app_hotswap_approvals WHERE id = ?").get(id) as
      | AppHotswapApprovalRow
      | undefined;
  }

  listAppHotswapApprovals(state?: AppHotswapApprovalState): AppHotswapApprovalRow[] {
    return (state
      ? this.db
        .prepare("SELECT * FROM app_hotswap_approvals WHERE state = ? ORDER BY requested_at, id")
        .all(state)
      : this.db.prepare("SELECT * FROM app_hotswap_approvals ORDER BY requested_at, id").all()) as
      AppHotswapApprovalRow[];
  }

  expireAppHotswapApprovals(cutoff: string, decidedAt: string): number {
    return this.db
      .prepare(
        `UPDATE app_hotswap_approvals
         SET state = 'expired', decided_by = 'system:expiry', decided_at = ?,
             outcome = '{"code":"expired"}'
         WHERE state = 'pending' AND requested_at <= ?`,
      )
      .run(decidedAt, cutoff).changes;
  }

  claimAppHotswapApproval(
    id: string,
    decision: "approve" | "reject",
    decidedBy: string,
    decidedAt: string,
  ): AppHotswapClaimResult {
    return this.db.transaction((): AppHotswapClaimResult => {
      const row = this.getAppHotswapApproval(id);
      if (!row) return { ok: false, code: "unknown" };
      if (row.state !== "pending") return { ok: false, code: "not_pending", row };
      const nextState = decision === "approve" ? "approved" : "rejected";
      const outcome = decision === "reject" ? '{"code":"rejected"}' : null;
      const changed = this.db
        .prepare(
          `UPDATE app_hotswap_approvals
           SET state = ?, decided_by = ?, decided_at = ?, outcome = ?
           WHERE id = ? AND state = 'pending'`,
        )
        .run(nextState, decidedBy, decidedAt, outcome, id).changes;
      if (changed !== 1) {
        const raced = this.getAppHotswapApproval(id);
        return { ok: false, code: raced ? "not_pending" : "unknown", ...(raced ? { row: raced } : {}) };
      }
      return { ok: true, row: this.getAppHotswapApproval(id)! };
    })();
  }

  finishAppHotswapApproval(id: string, state: "approved" | "executed", outcome: string): boolean {
    return this.db
      .prepare(
        `UPDATE app_hotswap_approvals SET state = ?, outcome = ?
         WHERE id = ? AND state = 'approved'`,
      )
      .run(state, outcome, id).changes === 1;
  }
}
