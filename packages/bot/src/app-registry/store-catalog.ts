/**
 * The bot's SQLite adapter for the App release catalog.
 *
 * Two reasons this is a thin translation layer and not where the logic lives:
 *
 *  · The registry's rules — what a valid release is, what the digest covers,
 *    what a reinstall means — belong to `@claude-bot/app-registry`, which has
 *    no database driver and can therefore be imported by the Runtime Host, the
 *    permission layer and their tests without dragging SQLite along.
 *  · The durable rows belong to the existing `Store`, which already owns the
 *    connection, WAL mode, foreign keys and the versioned migration ladder. A
 *    second SQLite handle on `bot.db` would be a second writer to the same
 *    file, and the repository has already paid for that lesson once (the
 *    capability kernel keeps a single-writer lease for exactly this reason).
 *
 * Nothing here decides who may publish. The registry is a trusted API and its
 * callers are responsible for authorisation, the same way `Store` is.
 */

import type {
  ActivateOutcome,
  ActivateRequest,
  ActivationRow,
  ExecutionProfile,
  InstallProvenance,
  ReleaseCatalogRepository,
  ReleaseFilter,
  ReleaseRow,
  RemoveOutcome,
} from "@claude-bot/app-registry";
import type { Store } from "../store/store.js";
import type { AppReleaseActivationRow, AppReleaseRow } from "../store/repositories/app-catalog.js";

export class StoreReleaseCatalog implements ReleaseCatalogRepository {
  constructor(private readonly store: Store) {}

  insertRelease(row: ReleaseRow): boolean {
    return this.store.appCatalog.insertAppRelease(toDbRow(row));
  }

  getRelease(packageDigest: string): ReleaseRow | null {
    const row = this.store.appCatalog.getAppRelease(packageDigest);
    return row ? fromDbRow(row) : null;
  }

  listReleases(filter: ReleaseFilter = {}): ReleaseRow[] {
    return this.store.appCatalog.listAppReleases(filter).map(fromDbRow);
  }

  markRemovedIfInactive(packageDigest: string, by: string, at: string): RemoveOutcome {
    return this.store.appCatalog.markAppReleaseRemovedIfInactive(packageDigest, by, at);
  }

  getActive(stableAppId: string, publisher: string): ActivationRow | null {
    const row = this.store.appCatalog.getActiveAppRelease(stableAppId, publisher);
    return row ? fromDbActivation(row) : null;
  }

  listActive(): ActivationRow[] {
    return this.store.appCatalog.listActiveAppReleases().map(fromDbActivation);
  }

  activate(request: ActivateRequest): ActivateOutcome {
    return this.store.appCatalog.activateAppRelease(request);
  }

  deactivate(stableAppId: string, publisher: string): string | null {
    return this.store.appCatalog.deactivateAppRelease(stableAppId, publisher);
  }
}

function toDbRow(row: ReleaseRow): AppReleaseRow {
  return {
    package_digest: row.packageDigest,
    stable_app_id: row.stableAppId,
    publisher: row.publisher,
    execution_profile: row.executionProfile,
    permission_contract_digest: row.permissionContractDigest,
    descriptor: row.descriptor,
    provenance_kind: row.provenanceKind,
    provenance: row.provenance,
    content_root: row.contentRoot,
    installed_by: row.installedBy,
    installed_at: row.installedAt,
    removed_by: row.removedBy,
    removed_at: row.removedAt,
  };
}

/**
 * Column values are widened `string`s; the registry's types are closed unions.
 *
 * The cast is safe rather than hopeful: the database enforces both vocabularies
 * with CHECK constraints, and the registry re-validates the descriptor (which
 * carries the same execution profile) before believing any of it.
 */
function fromDbRow(row: AppReleaseRow): ReleaseRow {
  return {
    packageDigest: row.package_digest,
    stableAppId: row.stable_app_id,
    publisher: row.publisher,
    executionProfile: row.execution_profile as ExecutionProfile,
    permissionContractDigest: row.permission_contract_digest,
    descriptor: row.descriptor,
    provenance: row.provenance,
    provenanceKind: row.provenance_kind as InstallProvenance["kind"],
    contentRoot: row.content_root,
    installedBy: row.installed_by,
    installedAt: row.installed_at,
    removedBy: row.removed_by,
    removedAt: row.removed_at,
  };
}

function fromDbActivation(row: AppReleaseActivationRow): ActivationRow {
  return {
    stableAppId: row.stable_app_id,
    publisher: row.publisher,
    packageDigest: row.package_digest,
    activatedBy: row.activated_by,
    activatedAt: row.activated_at,
  };
}
