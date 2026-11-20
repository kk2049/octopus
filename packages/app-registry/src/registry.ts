/**
 * The trusted installer: install, activate, resolve, and say what is wrong.
 *
 * ## What this is not
 *
 * It is not App trust, not permission intent and not capability authorisation.
 * It records which immutable releases exist and which one is active; whether an
 * account trusts a publisher (`app_trust`), what an app may ask for
 * (`grant_intents`) and whether a specific call is allowed (the capability
 * Gate) are three separate decisions that stay where they are. The ports this
 * service holds cannot reach any of those tables, so that is a structural
 * statement rather than a promise.
 *
 * It also performs no authorisation of its own. Every method here is a trusted
 * operation; the caller is responsible for deciding who may publish. That is
 * why publication is an explicit API call and not a directory watcher: a
 * watcher makes "whoever can write a file" the deployment authority, which is
 * not a decision a filesystem should be making. A development watcher may later
 * feed this same `install()`, and it will get the same validation.
 *
 * ## Ordering, and what a crash can leave behind
 *
 * ```text
 * install   validate (pure) -> write artifact durably -> insert row -> emit
 * activate  read row -> check artifact -> move pointer in one txn -> emit
 * ```
 *
 * The artifact is durable before anything references it, so a crash can leave
 * an unreferenced artifact (safe, reported by `reconcile()`) but can never make
 * an incomplete release active. Events are emitted after the transaction
 * commits, never before and never inside it.
 */

import {
  DEFAULT_LIMITS,
  type AppReleaseDescriptor,
  type RegistryIssue,
  type RegistryLimits,
  IssueSink,
  issue,
  validateDescriptor,
  verifyPayload,
} from "./descriptor.js";
import type {
  ActivationRow,
  InstallProvenance,
  ReleaseCatalogRepository,
  ReleaseContentStore,
  ReleaseFilter,
  ReleaseRow,
} from "./ports.js";

// ── public shapes ──

/** An installed release, reassembled from the catalog and re-validated. */
export interface InstalledRelease {
  descriptor: AppReleaseDescriptor;
  provenance: InstallProvenance;
  contentRoot: string;
  installedBy: string;
  installedAt: string;
  removedBy: string | null;
  removedAt: string | null;
}

export interface ActiveRelease extends InstalledRelease {
  activatedBy: string;
  activatedAt: string;
}

export interface InstallRequest {
  descriptor: unknown;
  assets: ReadonlyArray<{ name: string; content: Uint8Array }>;
  provenance: InstallProvenance;
  installedBy: string;
}

export type InstallResult =
  | { ok: true; release: InstalledRelease; deduplicated: boolean }
  | { ok: false; issues: RegistryIssue[] };

export type ActivateResult =
  | { ok: true; release: ActiveRelease; previousPackageDigest: string | null; changed: boolean }
  | { ok: false; issues: RegistryIssue[] };

export type DeactivateResult =
  | { ok: true; previousPackageDigest: string | null; changed: boolean }
  | { ok: false; issues: RegistryIssue[] };

export type UninstallResult = { ok: true; changed: boolean } | { ok: false; issues: RegistryIssue[] };

export type ResolveResult = { ok: true; release: ActiveRelease } | { ok: false; issues: RegistryIssue[] };

export type InspectResult = { ok: true; release: InstalledRelease } | { ok: false; issues: RegistryIssue[] };

/**
 * Committed catalog changes.
 *
 * No secret, no authority, no content: an event names a release and says what
 * happened to it, and a subscriber has to go through the same API (and its own
 * authorisation) to act on that. Emitted only after the write commits, so a
 * subscriber never sees a change that did not happen.
 */
export type RegistryEvent =
  | { type: "release_installed"; stableAppId: string; publisher: string; packageDigest: string; at: string }
  | {
      type: "release_activated";
      stableAppId: string;
      publisher: string;
      packageDigest: string;
      previousPackageDigest: string | null;
      at: string;
    }
  | { type: "release_deactivated"; stableAppId: string; publisher: string; packageDigest: string; at: string }
  | { type: "release_uninstalled"; stableAppId: string; publisher: string; packageDigest: string; at: string };

export type RegistryListener = (event: RegistryEvent) => void;

export interface ReconcileReport {
  /** Active pointers whose artifact is gone or damaged. These fail closed. */
  activeUnusable: Array<{ stableAppId: string; publisher: string; packageDigest: string; issue: RegistryIssue }>;
  /** Installed but not active, and not usable if activated. */
  installedUnusable: Array<{ packageDigest: string; issue: RegistryIssue }>;
  /** Rows this build cannot re-validate — a downgrade or a damaged row. */
  undescribable: Array<{ packageDigest: string; issue: RegistryIssue }>;
  /** Artifacts with no catalog row. Safe; reclaiming them is a separate job. */
  orphanContent: string[];
}

export interface AppReleaseRegistryOptions {
  catalog: ReleaseCatalogRepository;
  content: ReleaseContentStore;
  limits?: RegistryLimits;
  /** Injected so tests are deterministic and nothing here reads a wall clock twice. */
  now?: () => string;
  /** A listener that throws must not break the registry; this reports it. */
  onListenerError?: (error: unknown, event: RegistryEvent) => void;
}

// ── service ──

export class AppReleaseRegistry {
  private readonly catalog: ReleaseCatalogRepository;
  private readonly content: ReleaseContentStore;
  private readonly limits: RegistryLimits;
  private readonly now: () => string;
  private readonly onListenerError?: (error: unknown, event: RegistryEvent) => void;
  private readonly listeners = new Set<RegistryListener>();

  constructor(options: AppReleaseRegistryOptions) {
    this.catalog = options.catalog;
    this.content = options.content;
    this.limits = options.limits ?? DEFAULT_LIMITS;
    this.now = options.now ?? (() => new Date().toISOString());
    this.onListenerError = options.onListenerError;
  }

  /**
   * Install one immutable release.
   *
   * Reinstalling the same content is idempotent, and "the same" means every
   * recorded fact is identical. A candidate that reuses a package digest but
   * changes anything the digest does not cover — the permission contract it
   * declares, how it was obtained — is a loud conflict rather than a silent
   * overwrite or a silent no-op, because both of those would make a stored
   * release stop describing what is actually there.
   */
  install(request: InstallRequest): InstallResult {
    const sink = new IssueSink(this.limits);
    const provenanceProblem = provenanceIssue(request.provenance, this.limits);
    if (provenanceProblem) sink.add(provenanceProblem.code, provenanceProblem.message, provenanceProblem.at);
    const installedBy = boundedActor(request.installedBy);
    if (!installedBy) sink.add("field_type", "installedBy must be a short, printable string", "installedBy");

    const verdict = validateDescriptor(request.descriptor, this.limits);
    if (!verdict.ok) return { ok: false, issues: [...sink.drain(), ...verdict.issues] };
    const descriptor = verdict.value;

    const payload = verifyPayload(descriptor, request.assets, this.limits);
    if (!payload.ok) return { ok: false, issues: [...sink.drain(), ...payload.issues] };
    if (!sink.empty) return { ok: false, issues: sink.drain() };

    const row: ReleaseRow = {
      packageDigest: descriptor.packageDigest,
      stableAppId: descriptor.stableAppId,
      publisher: descriptor.publisher,
      executionProfile: descriptor.executionProfile,
      permissionContractDigest: descriptor.permissionContractDigest,
      descriptor: JSON.stringify(descriptor),
      provenance: JSON.stringify(canonicalProvenance(request.provenance)),
      provenanceKind: request.provenance.kind,
      contentRoot: this.content.root,
      installedBy: installedBy!,
      installedAt: this.now(),
      removedBy: null,
      removedAt: null,
    };

    const existing = this.catalog.getRelease(descriptor.packageDigest);
    if (existing) return this.reinstall(existing, row, payload.value);

    try {
      // Durable artifact first: a row that points at content which is not there
      // yet is exactly the state this ordering exists to make impossible.
      this.content.put(descriptor.packageDigest, payload.value);
      const stored = this.content.verify(descriptor.packageDigest, descriptor.assets);
      if (!stored.ok) throw new Error(stored.detail);
    } catch (error) {
      return { ok: false, issues: [issue("content_write_failed", `artifact could not be stored: ${describe(error)}`)] };
    }

    const inserted = this.catalog.insertRelease(row);
    if (!inserted) {
      // Another writer won the race between `getRelease` and here. Its row is
      // the one that exists, so compare against it rather than assume ours.
      const winner = this.catalog.getRelease(descriptor.packageDigest);
      if (!winner) return { ok: false, issues: [issue("unknown_release", "release vanished during installation")] };
      return this.reinstall(winner, row, payload.value);
    }

    this.emit({
      type: "release_installed",
      stableAppId: row.stableAppId,
      publisher: row.publisher,
      packageDigest: row.packageDigest,
      at: row.installedAt,
    });
    return { ok: true, release: describeRow(row, descriptor, canonicalProvenance(request.provenance)), deduplicated: false };
  }

  /**
   * Point one (app, publisher) at one installed release.
   *
   * The artifact is checked before the pointer moves, so an active release
   * whose content is missing is a state this call refuses to create — as
   * opposed to one it later has to report.
   */
  activate(stableAppId: string, publisher: string, packageDigest: string, activatedBy: string): ActivateResult {
    const actor = boundedActor(activatedBy);
    if (!actor) return { ok: false, issues: [issue("field_type", "activatedBy must be a short, printable string")] };
    const loaded = this.load(packageDigest);
    if (!loaded.ok) return loaded;
    const { row, descriptor, provenance } = loaded.value;
    if (row.removedAt) {
      return { ok: false, issues: [issue("removed_release", "this release has been uninstalled", packageDigest)] };
    }
    if (row.stableAppId !== stableAppId || row.publisher !== publisher) {
      return {
        ok: false,
        issues: [issue("identity_mismatch", "this release belongs to a different app or publisher", packageDigest)],
      };
    }
    const content = this.content.checkManifest(packageDigest, descriptor.assets);
    if (!content.ok) {
      return { ok: false, issues: [issue(content.code, `refusing to activate: ${content.detail}`, packageDigest)] };
    }

    const at = this.now();
    const outcome = this.catalog.activate({ stableAppId, publisher, packageDigest, activatedBy: actor, activatedAt: at });
    if (!outcome.ok) return { ok: false, issues: [issue(outcome.code, activateFailure(outcome.code), packageDigest)] };

    if (outcome.changed) {
      this.emit({
        type: "release_activated",
        stableAppId,
        publisher,
        packageDigest,
        previousPackageDigest: outcome.previous,
        at,
      });
    }
    const active = this.catalog.getActive(stableAppId, publisher);
    return {
      ok: true,
      release: {
        ...describeRow(row, descriptor, provenance),
        activatedBy: active?.activatedBy ?? actor,
        activatedAt: active?.activatedAt ?? at,
      },
      previousPackageDigest: outcome.previous,
      changed: outcome.changed,
    };
  }

  /**
   * Remove catalog reachability for one app.
   *
   * Nothing else is touched: durable App state, `app_trust`, `grant_intents`
   * and the audit record all survive, so a deactivated app can be reactivated
   * and the history of what it did is still there to read. Purging any of that
   * is a different, destructive operation this service does not have.
   */
  deactivate(stableAppId: string, publisher: string): DeactivateResult {
    const previous = this.catalog.deactivate(stableAppId, publisher);
    if (previous === null) return { ok: true, previousPackageDigest: null, changed: false };
    this.emit({ type: "release_deactivated", stableAppId, publisher, packageDigest: previous, at: this.now() });
    return { ok: true, previousPackageDigest: previous, changed: true };
  }

  /**
   * Mark release metadata uninstalled.
   *
   * Refuses while the release is active: a pointer to a row that says "removed"
   * is a state with two plausible readings, and there is a call that resolves
   * the ambiguity first. The artifact stays on disk as unreferenced content.
   */
  uninstall(packageDigest: string, uninstalledBy: string): UninstallResult {
    const actor = boundedActor(uninstalledBy);
    if (!actor) return { ok: false, issues: [issue("field_type", "uninstalledBy must be a short, printable string")] };
    const row = this.catalog.getRelease(packageDigest);
    if (!row) return { ok: false, issues: [issue("unknown_release", "no such release", packageDigest)] };
    const at = this.now();
    const outcome = this.catalog.markRemovedIfInactive(packageDigest, actor, at);
    if (!outcome.ok) {
      const message = outcome.code === "active_release"
        ? "deactivate this release before uninstalling it"
        : "no such release";
      return { ok: false, issues: [issue(outcome.code, message, packageDigest)] };
    }
    if (!outcome.changed) return { ok: true, changed: false };
    this.emit({
      type: "release_uninstalled",
      stableAppId: row.stableAppId,
      publisher: row.publisher,
      packageDigest,
      at,
    });
    return { ok: true, changed: true };
  }

  /** Every release this catalog knows about, newest install first. */
  list(filter?: ReleaseFilter): InstalledRelease[] {
    const out: InstalledRelease[] = [];
    for (const row of this.catalog.listReleases(filter)) {
      const parsed = this.parseRow(row);
      // A row this build cannot re-validate is omitted from the listing and
      // surfaced by `reconcile()`; a listing that quietly contained
      // half-understood rows would be the wrong place to learn about it.
      if (parsed) out.push(describeRow(row, parsed.descriptor, parsed.provenance));
    }
    return out;
  }

  /**
   * Has this app ever had release metadata on this host?
   *
   * This deliberately reads raw catalog history, including removed and
   * currently-undescribable rows. Its one caller must distinguish a genuinely
   * empty first boot from an operator who explicitly deactivated (and perhaps
   * uninstalled) every release. Re-validating first would turn damaged history
   * into "never existed" and silently re-activate the checkout on restart.
   */
  hasReleaseHistory(stableAppId: string, publisher: string): boolean {
    return this.catalog.listReleases({ stableAppId, publisher, includeRemoved: true }).length > 0;
  }

  inspect(packageDigest: string): InspectResult {
    const loaded = this.load(packageDigest);
    if (!loaded.ok) return loaded;
    const { row, descriptor, provenance } = loaded.value;
    return { ok: true, release: describeRow(row, descriptor, provenance) };
  }

  /** What is active for every app, omitting any pointer whose identity is inconsistent. */
  listActive(): ActivationRow[] {
    return this.catalog.listActive().filter((active) => {
      const row = this.catalog.getRelease(active.packageDigest);
      if (!row || row.removedAt) return false;
      if (row.stableAppId !== active.stableAppId || row.publisher !== active.publisher) return false;
      return this.parseRow(row) !== null;
    });
  }

  /**
   * The release an app should be running right now.
   *
   * Fail closed: no pointer, a pointer to a row this build cannot re-validate,
   * or a pointer to an artifact that is missing or damaged all produce a
   * diagnosis rather than a descriptor. The manifest check here is the cheap
   * one (present, complete, right sizes); the exact per-asset digest check
   * happens on read, so serving a corrupted byte is not possible either way.
   */
  resolveActive(stableAppId: string, publisher: string): ResolveResult {
    const active = this.catalog.getActive(stableAppId, publisher);
    if (!active) {
      return { ok: false, issues: [issue("not_active", "no release is active for this app", `${publisher}/${stableAppId}`)] };
    }
    const loaded = this.load(active.packageDigest);
    if (!loaded.ok) return loaded;
    const { row, descriptor, provenance } = loaded.value;
    if (
      active.stableAppId !== stableAppId
      || active.publisher !== publisher
      || row.stableAppId !== active.stableAppId
      || row.publisher !== active.publisher
    ) {
      return {
        ok: false,
        issues: [issue("identity_mismatch", "the active pointer is bound to a different app or publisher", active.packageDigest)],
      };
    }
    if (row.removedAt) {
      return {
        ok: false,
        issues: [issue("removed_release", "the active release has been uninstalled", active.packageDigest)],
      };
    }
    const content = this.content.checkManifest(active.packageDigest, descriptor.assets);
    if (!content.ok) {
      return { ok: false, issues: [issue(content.code, content.detail, active.packageDigest)] };
    }
    return {
      ok: true,
      release: {
        ...describeRow(row, descriptor, provenance),
        activatedBy: active.activatedBy,
        activatedAt: active.activatedAt,
      },
    };
  }

  /**
   * Read one asset of one release by exact name.
   *
   * Returns null for an unknown release, an unknown name, or bytes that do not
   * hash to what the manifest says. There is no "read by path" variant.
   */
  readAsset(packageDigest: string, name: string): Uint8Array | null {
    const loaded = this.load(packageDigest);
    if (!loaded.ok || loaded.value.row.removedAt) return null;
    return this.content.read(packageDigest, name, loaded.value.descriptor.assets);
  }

  /**
   * Cross-check the database against the filesystem.
   *
   * Reports; never repairs and never deletes. Orphan content is safe by
   * construction (nothing references it), and an unusable active pointer is
   * something a human has to decide about — the two automatic answers
   * available here would be "reactivate an older release" and "delete data",
   * and neither is the registry's call.
   */
  // Management reads only need manifests and file metadata. The default keeps
  // the explicit integrity audit byte-exact; readAsset also always verifies
  // the bytes it returns, independently of this diagnostic mode.
  reconcile(options: { verification?: "content" | "manifest" } = {}): ReconcileReport {
    const report: ReconcileReport = { activeUnusable: [], installedUnusable: [], undescribable: [], orphanContent: [] };
    const referenced = new Set<string>();
    const activeByDigest = new Map<string, ActivationRow>();
    for (const active of this.catalog.listActive()) activeByDigest.set(active.packageDigest, active);

    for (const row of this.catalog.listReleases({ includeRemoved: true })) {
      const parsed = this.parseRow(row);
      if (!parsed) {
        report.undescribable.push({
          packageDigest: row.packageDigest,
          issue: issue("descriptor_invalid", "this build cannot re-validate the stored descriptor", row.packageDigest),
        });
        continue;
      }
      if (row.removedAt) continue;
      referenced.add(row.packageDigest);
      const check = options.verification === "manifest"
        ? this.content.checkManifest(row.packageDigest, parsed.descriptor.assets)
        : this.content.verify(row.packageDigest, parsed.descriptor.assets);
      if (check.ok) continue;
      const problem = issue(check.code, check.detail, row.packageDigest);
      const active = activeByDigest.get(row.packageDigest);
      if (active) {
        report.activeUnusable.push({
          stableAppId: active.stableAppId,
          publisher: active.publisher,
          packageDigest: row.packageDigest,
          issue: problem,
        });
      } else {
        report.installedUnusable.push({ packageDigest: row.packageDigest, issue: problem });
      }
    }
    report.orphanContent = this.content.listStored().filter((digest) => !referenced.has(digest));
    return report;
  }

  /** Subscribe to committed catalog changes. Returns the unsubscribe. */
  subscribe(listener: RegistryListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ── internals ──

  private reinstall(
    existing: ReleaseRow,
    candidate: ReleaseRow,
    assets: ReadonlyArray<{ name: string; sha256: string; bytes: number; content: Uint8Array }>,
  ): InstallResult {
    const conflict = conflictIssue(existing, candidate);
    if (conflict) return { ok: false, issues: [conflict] };
    const parsed = this.parseRow(existing);
    if (!parsed) {
      return {
        ok: false,
        issues: [issue("descriptor_invalid", "the stored release cannot be re-validated by this build", existing.packageDigest)],
      };
    }
    const content = this.content.verify(existing.packageDigest, parsed.descriptor.assets);
    if (!content.ok) {
      // The row survived a crash that lost the artifact, or the artifact was
      // removed underneath us. We are holding the exact verified bytes, so the
      // honest repair is to write them again rather than report a release that
      // exists in the catalogue and nowhere else.
      try {
        this.content.put(existing.packageDigest, assets);
        const repaired = this.content.verify(existing.packageDigest, parsed.descriptor.assets);
        if (!repaired.ok) throw new Error(repaired.detail);
      } catch (error) {
        return { ok: false, issues: [issue("content_write_failed", `artifact could not be restored: ${describe(error)}`)] };
      }
    }
    return { ok: true, release: describeRow(existing, parsed.descriptor, parsed.provenance), deduplicated: true };
  }

  private load(
    packageDigest: string,
  ):
    | { ok: true; value: { row: ReleaseRow; descriptor: AppReleaseDescriptor; provenance: InstallProvenance } }
    | { ok: false; issues: RegistryIssue[] } {
    const row = this.catalog.getRelease(packageDigest);
    if (!row) return { ok: false, issues: [issue("unknown_release", "no such release", packageDigest)] };
    const parsed = this.parseRow(row);
    if (!parsed) {
      return {
        ok: false,
        issues: [issue("descriptor_invalid", "the stored release cannot be re-validated by this build", packageDigest)],
      };
    }
    return { ok: true, value: { row, descriptor: parsed.descriptor, provenance: parsed.provenance } };
  }

  /**
   * Re-validate a stored row.
   *
   * The catalog is trusted to be ours, not to be intact: this is what makes a
   * damaged or downgraded row fail closed instead of being handed to a Runtime
   * Host that would then run something nobody described.
   */
  private parseRow(row: ReleaseRow): { descriptor: AppReleaseDescriptor; provenance: InstallProvenance } | null {
    let descriptorJson: unknown;
    let provenanceJson: unknown;
    try {
      descriptorJson = JSON.parse(row.descriptor);
      provenanceJson = JSON.parse(row.provenance);
    } catch {
      return null;
    }
    const verdict = validateDescriptor(descriptorJson, this.limits);
    if (!verdict.ok) return null;
    if (verdict.value.packageDigest !== row.packageDigest) return null;
    if (verdict.value.stableAppId !== row.stableAppId || verdict.value.publisher !== row.publisher) return null;
    if (verdict.value.executionProfile !== row.executionProfile) return null;
    if (verdict.value.permissionContractDigest !== row.permissionContractDigest) return null;
    if (row.contentRoot !== this.content.root) return null;
    const provenance = parseProvenance(provenanceJson, this.limits);
    if (!provenance || provenance.kind !== row.provenanceKind) return null;
    return { descriptor: verdict.value, provenance };
  }

  private emit(event: RegistryEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        // One bad subscriber must not stop the others or unwind a committed
        // write; the change already happened and the event is a notification.
        this.onListenerError?.(error, event);
      }
    }
  }
}

// ── helpers ──

function describeRow(
  row: ReleaseRow,
  descriptor: AppReleaseDescriptor,
  provenance: InstallProvenance,
): InstalledRelease {
  return {
    descriptor,
    provenance,
    contentRoot: row.contentRoot,
    installedBy: row.installedBy,
    installedAt: row.installedAt,
    removedBy: row.removedBy,
    removedAt: row.removedAt,
  };
}

/**
 * Is the candidate the same release, in every recorded sense?
 *
 * The package digest already proves the bytes and the identity match. What is
 * left is exactly the set of facts the digest deliberately does not cover, and
 * a disagreement in any of them means one artifact would be claiming two
 * different things.
 */
function conflictIssue(existing: ReleaseRow, candidate: ReleaseRow): RegistryIssue | null {
  if (existing.permissionContractDigest !== candidate.permissionContractDigest) {
    return issue(
      "descriptor_conflict",
      "this release is already installed with a different permission contract; build a new release instead",
      existing.packageDigest,
    );
  }
  if (existing.descriptor !== candidate.descriptor) {
    return issue(
      "descriptor_conflict",
      "this release is already installed with a different descriptor",
      existing.packageDigest,
    );
  }
  if (existing.provenance !== candidate.provenance) {
    return issue(
      "provenance_conflict",
      "this release is already installed with a different provenance record",
      existing.packageDigest,
    );
  }
  return null;
}

function activateFailure(code: "unknown_release" | "removed_release" | "identity_mismatch"): string {
  if (code === "unknown_release") return "no such release";
  if (code === "removed_release") return "this release has been uninstalled";
  return "this release belongs to a different app or publisher";
}

function canonicalProvenance(provenance: InstallProvenance): InstallProvenance {
  return {
    kind: provenance.kind,
    builder: provenance.builder,
    statement: provenance.statement,
    signatureVerification: "none",
  };
}

function provenanceIssue(provenance: unknown, limits: RegistryLimits): RegistryIssue | null {
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) {
    return issue("provenance", "provenance must be a plain object", "provenance");
  }
  const row = provenance as Record<string, unknown>;
  for (const key of Object.keys(row)) {
    if (!["kind", "builder", "statement", "signatureVerification"].includes(key)) {
      return issue("provenance", "provenance has an unexpected field", `provenance.${key}`);
    }
  }
  if (row.kind !== "platform-built" && row.kind !== "external-attestation") {
    return issue("provenance", "provenance.kind must be platform-built or external-attestation", "provenance.kind");
  }
  if (row.signatureVerification !== "none") {
    // Refusing the value rather than ignoring it: a deployment that records
    // "verified" gets a rejection instead of a comforting field nobody checks.
    return issue(
      "signature_verification",
      "this registry performs no publisher signature verification; provenance.signatureVerification must be \"none\"",
      "provenance.signatureVerification",
    );
  }
  for (const key of ["builder", "statement"] as const) {
    const value = row[key];
    if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > limits.maxFieldLength) {
      return issue("provenance", `provenance.${key} must be a non-empty string of at most ${limits.maxFieldLength} bytes`, `provenance.${key}`);
    }
    if (/[\x00-\x1f\x7f]/.test(value)) {
      return issue("provenance", `provenance.${key} contains a control character`, `provenance.${key}`);
    }
  }
  return null;
}

function parseProvenance(value: unknown, limits: RegistryLimits): InstallProvenance | null {
  if (provenanceIssue(value, limits)) return null;
  const row = value as Record<string, unknown>;
  return {
    kind: row.kind as InstallProvenance["kind"],
    builder: row.builder as string,
    statement: row.statement as string,
    signatureVerification: "none",
  };
}

/** Who did it, for the record. Bounded and printable; never authority. */
function boundedActor(actor: unknown): string | null {
  if (typeof actor !== "string" || actor.length === 0 || actor.length > 128) return null;
  if (/[\x00-\x1f\x7f]/.test(actor)) return null;
  return actor;
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 120);
}
