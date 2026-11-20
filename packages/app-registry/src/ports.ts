/**
 * The two narrow ports the registry needs, and nothing else.
 *
 * The domain package carries no database driver and no storage opinion beyond
 * these interfaces, so the release contract can be imported by the Runtime
 * Host, the permission layer and tests without dragging in SQLite. The bot
 * package supplies a `Store`-backed catalog; this package supplies a
 * filesystem content store and an in-memory catalog.
 *
 * ## Everything here is synchronous, on purpose
 *
 * The repository's durable layers are already synchronous (`better-sqlite3`,
 * the App state service), and the ordering this registry has to guarantee —
 * the artifact is durable BEFORE the row that references it, the pointer moves
 * in one transaction — is easier to state, read and test without interleaving.
 * A synchronous API also means two "concurrent" operations inside one process
 * cannot interleave at all; the only real concurrency is between processes,
 * where SQLite is the serializer.
 *
 * ## What is deliberately absent
 *
 * No delete. Uninstall marks metadata; content is left as an unreferenced
 * artifact that `reconcile()` reports. A registry with no destructive
 * filesystem operation cannot have a destructive-target bug, and reclaiming
 * disk is a separate, explicitly authorised job.
 */

import type { ExecutionProfile } from "./descriptor.js";

// ── catalog ──

/**
 * How this deployment came to hold the artifact.
 *
 * Not part of the descriptor: it is an installation fact, not a property of the
 * bytes. Two deployments can hold the same release with different provenance,
 * and each should say so honestly.
 */
export interface InstallProvenance {
  /**
   * `platform-built` — this platform produced the artifact from the declared
   * source and build input. `external-attestation` — it arrived built and the
   * statement below is somebody's claim about it.
   */
  kind: "platform-built" | "external-attestation";
  builder: string;
  /** Bounded prose shown to whoever has to decide whether to trust it. */
  statement: string;
  /**
   * There is no publisher signature verification in this system.
   *
   * The field exists so the absence is recorded rather than assumed, and the
   * union has exactly one member so that adding another requires implementing
   * the verification it would name. Any other value is rejected at install.
   */
  signatureVerification: "none";
}

/** One installed release, as the catalog stores it. */
export interface ReleaseRow {
  packageDigest: string;
  stableAppId: string;
  publisher: string;
  executionProfile: ExecutionProfile;
  permissionContractDigest: string;
  /**
   * The canonical descriptor as JSON, exactly as verified at install time.
   *
   * Stored as text rather than a live object so that reading it back is a real
   * trust boundary: the service re-validates before believing it, which is what
   * makes "an active row whose descriptor was corrupted" fail closed instead of
   * being served.
   */
  descriptor: string;
  /** JSON of `InstallProvenance`, re-validated on read for the same reason. */
  provenance: string;
  provenanceKind: InstallProvenance["kind"];
  /** Which content store root holds the artifact. */
  contentRoot: string;
  installedBy: string;
  installedAt: string;
  removedBy: string | null;
  removedAt: string | null;
}

export interface ActivationRow {
  stableAppId: string;
  publisher: string;
  packageDigest: string;
  activatedBy: string;
  activatedAt: string;
}

export interface ReleaseFilter {
  stableAppId?: string;
  publisher?: string;
  /** Uninstalled metadata is hidden unless asked for. */
  includeRemoved?: boolean;
}

export interface ActivateRequest {
  stableAppId: string;
  publisher: string;
  packageDigest: string;
  activatedBy: string;
  activatedAt: string;
}

/**
 * The result of moving the pointer.
 *
 * The failure codes are the ones only the transaction can decide — whether the
 * release still exists and still belongs to this app — so the service does not
 * have to check them first and hope nothing changed in between.
 */
export type ActivateOutcome =
  | { ok: true; previous: string | null; changed: boolean }
  | { ok: false; code: "unknown_release" | "removed_release" | "identity_mismatch" };

/**
 * The result of atomically marking an inactive release as removed.
 *
 * Checking the active pointer and updating the release must be one repository
 * operation. Otherwise another writer can activate the release between those
 * two statements and leave an active pointer naming removed metadata.
 */
export type RemoveOutcome =
  | { ok: true; changed: boolean }
  | { ok: false; code: "unknown_release" | "active_release" };

/**
 * Release metadata and the active pointer.
 *
 * Every method is atomic on its own; there is no transaction handle to pass
 * around, because a caller that could compose two of them into one transaction
 * could also hold a write lock across arbitrary work.
 */
export interface ReleaseCatalogRepository {
  /**
   * Insert if absent. Returns whether this call created the row — which is how
   * two processes installing the same release at the same time both end up
   * with a correct answer and exactly one of them reports a new install.
   */
  insertRelease(row: ReleaseRow): boolean;
  getRelease(packageDigest: string): ReleaseRow | null;
  listReleases(filter?: ReleaseFilter): ReleaseRow[];
  /** Atomic active-pointer check plus removal mark. */
  markRemovedIfInactive(packageDigest: string, by: string, at: string): RemoveOutcome;
  getActive(stableAppId: string, publisher: string): ActivationRow | null;
  listActive(): ActivationRow[];
  /** Atomic pointer change; validates the release row inside the transaction. */
  activate(request: ActivateRequest): ActivateOutcome;
  /** Removes catalog reachability. Returns the digest that was active, if any. */
  deactivate(stableAppId: string, publisher: string): string | null;
}

// ── content ──

export interface StoredAssetIdentity {
  name: string;
  sha256: string;
  bytes: number;
}

export interface StoredAsset extends StoredAssetIdentity {
  content: Uint8Array;
}

export type ContentCheck =
  | { ok: true }
  | { ok: false; code: "content_missing" | "content_corrupt"; detail: string };

export interface ReleaseContentStore {
  /** Absolute, resolved root. Recorded on the release row. */
  readonly root: string;
  /**
   * Persist the artifact durably and idempotently.
   *
   * Must return only once the complete artifact would survive power loss, and
   * must never publish a partial one: a crash mid-write leaves content that
   * reads as absent, not as a release with a missing file.
   */
  put(packageDigest: string, assets: readonly StoredAsset[]): void;
  has(packageDigest: string): boolean;
  /**
   * Exact-name lookup bound to the catalog's canonical inventory.
   *
   * The filesystem manifest is a completion marker, not an authority: every
   * consumer supplies the descriptor inventory and a mismatch fails closed.
   */
  read(packageDigest: string, name: string, expected: readonly StoredAssetIdentity[]): Uint8Array | null;
  /** Cheap: manifest matches the descriptor and every blob exists at its size. */
  checkManifest(packageDigest: string, expected: readonly StoredAssetIdentity[]): ContentCheck;
  /** Exact: re-hash every blob. Used by reconciliation, not by every resolve. */
  verify(packageDigest: string, expected: readonly StoredAssetIdentity[]): ContentCheck;
  /** Package digests with content present, for reconciliation against the catalog. */
  listStored(): string[];
}
