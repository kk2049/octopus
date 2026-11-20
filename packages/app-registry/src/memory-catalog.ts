/**
 * An in-memory catalog.
 *
 * Two jobs: it lets the domain package be tested without a database, and it is
 * the executable statement of what a catalog adapter must do — the bot's
 * SQLite-backed one is checked against the same behaviour suite. It is not a
 * production store: nothing here survives the process, which is the honest
 * shape for a reference implementation rather than a shortcut.
 */

import type {
  ActivateOutcome,
  ActivateRequest,
  ActivationRow,
  ReleaseCatalogRepository,
  ReleaseFilter,
  ReleaseRow,
  RemoveOutcome,
} from "./ports.js";

export class MemoryReleaseCatalog implements ReleaseCatalogRepository {
  private readonly releases = new Map<string, ReleaseRow>();
  private readonly active = new Map<string, ActivationRow>();
  /** Insertion order, so "newest first" is answerable without a clock. */
  private sequence = 0;
  private readonly order = new Map<string, number>();

  insertRelease(row: ReleaseRow): boolean {
    if (this.releases.has(row.packageDigest)) return false;
    this.releases.set(row.packageDigest, { ...row });
    this.order.set(row.packageDigest, (this.sequence += 1));
    return true;
  }

  getRelease(packageDigest: string): ReleaseRow | null {
    const row = this.releases.get(packageDigest);
    return row ? { ...row } : null;
  }

  listReleases(filter: ReleaseFilter = {}): ReleaseRow[] {
    return [...this.releases.values()]
      .filter((row) => {
        if (filter.stableAppId !== undefined && row.stableAppId !== filter.stableAppId) return false;
        if (filter.publisher !== undefined && row.publisher !== filter.publisher) return false;
        if (!filter.includeRemoved && row.removedAt) return false;
        return true;
      })
      .sort((a, b) => (this.order.get(b.packageDigest) ?? 0) - (this.order.get(a.packageDigest) ?? 0))
      .map((row) => ({ ...row }));
  }

  markRemovedIfInactive(packageDigest: string, by: string, at: string): RemoveOutcome {
    const row = this.releases.get(packageDigest);
    if (!row) return { ok: false, code: "unknown_release" };
    if ([...this.active.values()].some((active) => active.packageDigest === packageDigest)) {
      return { ok: false, code: "active_release" };
    }
    if (row.removedAt) return { ok: true, changed: false };
    this.releases.set(packageDigest, { ...row, removedBy: by, removedAt: at });
    return { ok: true, changed: true };
  }

  getActive(stableAppId: string, publisher: string): ActivationRow | null {
    const row = this.active.get(key(stableAppId, publisher));
    return row ? { ...row } : null;
  }

  listActive(): ActivationRow[] {
    return [...this.active.values()]
      .map((row) => ({ ...row }))
      .sort((a, b) => key(a.stableAppId, a.publisher).localeCompare(key(b.stableAppId, b.publisher)));
  }

  activate(request: ActivateRequest): ActivateOutcome {
    const row = this.releases.get(request.packageDigest);
    if (!row) return { ok: false, code: "unknown_release" };
    if (row.removedAt) return { ok: false, code: "removed_release" };
    if (row.stableAppId !== request.stableAppId || row.publisher !== request.publisher) {
      return { ok: false, code: "identity_mismatch" };
    }
    const at = key(request.stableAppId, request.publisher);
    const previous = this.active.get(at)?.packageDigest ?? null;
    if (previous === request.packageDigest) return { ok: true, previous, changed: false };
    this.active.set(at, {
      stableAppId: request.stableAppId,
      publisher: request.publisher,
      packageDigest: request.packageDigest,
      activatedBy: request.activatedBy,
      activatedAt: request.activatedAt,
    });
    return { ok: true, previous, changed: true };
  }

  deactivate(stableAppId: string, publisher: string): string | null {
    const at = key(stableAppId, publisher);
    const previous = this.active.get(at)?.packageDigest ?? null;
    this.active.delete(at);
    return previous;
  }
}

/** JSON array framing, so a publisher containing a separator cannot collide. */
function key(stableAppId: string, publisher: string): string {
  return JSON.stringify([publisher, stableAppId]);
}
