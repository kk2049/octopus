/**
 * One Agentic App's active pointer, and the transition that moves it.
 *
 * ── What "hot update" actually has to mean ──────────────────────────────────
 *
 * Not "reload some files". A release is an identity: it addresses an origin, it
 * binds every open browser instance, it fixes which backend code the sandbox
 * loads, and it names a permission contract somebody agreed to. Changing it is
 * therefore a transition with an order, and the order IS the safety property:
 *
 * ```text
 *   inspect installed release        (does it exist, is it ours, is it removed)
 *   adapter.prepare                  (contract/profile/declaration + materialise)
 *   origin policy                    (can this deployment even serve that name)
 *   runtime candidate + health       (does the backend actually come up)
 *   ── everything above may fail with the old release untouched ──
 *   registry.activate                (one row, one transaction)
 *   runtime commit                   (swap the child, stop the old one)
 *   notify                           (stale instances, closed streams, new CSP)
 * ```
 *
 * A candidate that fails anywhere above the line leaves a working deployment
 * exactly as it was — no pointer moved, no child replaced, no instance dropped.
 * That is the whole reason the health check happens before the pointer and not
 * after it.
 *
 * ── One of these per app, and why that is the whole generalisation ──────────
 *
 * Everything below is app-agnostic: it talks to an `AppReleaseAdapter` and a
 * registry that already keys pointers by `(stableAppId, publisher)`. What used
 * to make this file Session-Plus-specific was a single import; the app-specific
 * answers now arrive through the adapter, so a second app is a second instance
 * of this class rather than a second copy of it. Each instance owns its own
 * pointer, its own serialisation queue, its own runtime swap and its own
 * subscribers — two apps cannot half-switch each other, because they share no
 * mutable state at all (only the registry, which is transactional).
 *
 * ── What this object is NOT ─────────────────────────────────────────────────
 *
 * It is not an authorization boundary. Every method here is a trusted operation
 * and the caller decides who may publish; the panel puts the Cedar route table,
 * the mutation gate and an admin-only rule in front of it. It is also not App
 * trust, permission intent or a capability grant: it cannot reach `app_trust`,
 * `grant_intents` or the kernel, so "activating a release does not grant it
 * anything" is structural rather than a promise. A user who trusted an exact
 * package still sees the publisher-trust door again after an activation, because
 * that door is keyed on the package digest.
 *
 * ── First boot, and why a deploy must not move the pointer ──────────────────
 *
 * An empty registry is seeded from the checkout, idempotently. A registry that
 * already has an active pointer is left alone — deploying new trusted code must
 * not silently republish the App, or "roll the trusted code forward while
 * keeping the old View active" would be impossible, and that is exactly the
 * situation hot updates exist for.
 */

import {
  AppReleaseRegistry,
  packageHostLabel,
  type AppReleaseDescriptor,
  type InstalledRelease,
  type RegistryIssue,
} from "@claude-bot/app-registry";
import { createLogger } from "../logger.js";
import type { PublishedViewDocument } from "../app-core/view-app.js";
import { releaseView, type AppRegistryView, type AppBackendStatusView } from "./admin-view.js";
import type { AdapterCompatibility, AppReleaseAdapter } from "./adapter.js";
import type { ReleaseBundle } from "./bundle.js";

const log = createLogger("hosted-app");

/** A runtime that can be replaced without restarting the process. */
export type RuntimeCommitMode = "retain" | "swap";

export interface RuntimeSwap<C = unknown> {
  /** Start a candidate child and prove it loaded the expected backend code. */
  prepareRuntime(appDir: string, expectedBackendCodeDigest: string): Promise<C>;
  /** Adopt the candidate with an explicit retention policy. Must not reject. */
  commitRuntime(candidate: C, mode: RuntimeCommitMode): void;
  /** Throw the candidate away. Used on every failure path above the line. */
  discardRuntime(candidate: C): Promise<void>;
  /** Stop serving any release after the pointer is explicitly deactivated. Must not throw. */
  deactivateRuntime(): void;
  /** P2 lifecycle seams; optional for hosts that have no versioned instance plane. */
  hasRuntimeVersion?(backendCodeDigest: string): boolean;
  addRuntimeReference?(backendCodeDigest: string): boolean;
  removeRuntimeReference?(backendCodeDigest: string): boolean;
  retireRuntime?(backendCodeDigest: string): boolean;
}

/** The release one app is serving right now. Holding it grants nothing. */
export interface ActiveAppRelease<Prepared = unknown, Settings = unknown> {
  prepared: Prepared;
  settings: Settings;
  activatedBy: string;
  activatedAt: string;
}

export type ReleaseCoexistenceMode = "multi_version" | "refresh_required";
export const ADAPTER_COEXISTENCE_UNDECLARED = "adapter_does_not_support_coexistence";

export type ReleaseFailure = { code: string; message: string; issues?: RegistryIssue[] };

export type ActivateResult<Prepared = unknown, Settings = unknown> =
  | {
      ok: true;
      release: ActiveAppRelease<Prepared, Settings>;
      previousPackageDigest: string | null;
      changed: boolean;
      coexistence: ReleaseCoexistenceMode;
      reason: string | null;
    }
  | { ok: false; failure: ReleaseFailure };

/**
 * The exact facts an administrator reviews before an agent-requested
 * activation. This is deliberately a preview, not authority: approval later
 * re-runs the complete prepare/runtime-health/pointer transition and refuses
 * if the active predecessor changed in between.
 */
export type ActivationPreview =
  | {
      ok: true;
      packageDigest: string;
      previousPackageDigest: string | null;
      permissionContractDigest: string;
      coexistence: ReleaseCoexistenceMode;
      reason: string | null;
    }
  | { ok: false; failure: ReleaseFailure };

export type InstallResult =
  | { ok: true; packageDigest: string; deduplicated: boolean }
  | { ok: false; failure: ReleaseFailure };

export type SimpleResult = { ok: true; changed: boolean } | { ok: false; failure: ReleaseFailure };

/** The activation facts release subscribers need without replaying the verdict. */
export interface HostedAppReleaseTransition {
  previousPackageDigest: string | null;
  changed: boolean;
  coexistence: ReleaseCoexistenceMode;
  reason: string | null;
}

/**
 * What the catalog and the management routes need from an app, with its release
 * types erased.
 *
 * Every verb here is app-agnostic — it moves pointers and reports — so the panel
 * never has to know what a "prepared release" is for any particular app. The
 * typed `HostedApp<Prepared, Settings>` satisfies this structurally, which is
 * what lets a composition root keep `active()?.prepared.identity` as a
 * compile-time fact while the catalog holds the same object opaquely.
 */
export interface ManagedApp {
  readonly appId: string;
  readonly publisher: string;
  start(): Promise<unknown>;
  unavailable(): ReleaseFailure | null;
  install(bundle: ReleaseBundle, installedBy: string): InstallResult;
  /** Optional only for third-party ManagedApp implementations; HostedApp supplies it. */
  previewActivation?(packageDigest: string): Promise<ActivationPreview>;
  activate(packageDigest: string, activatedBy: string): Promise<ActivateResult>;
  deactivate(by: string): Promise<SimpleResult>;
  uninstall(packageDigest: string, by: string): SimpleResult;
  describe(): AppRegistryView;
  /**
   * The two publication verbs, on the catalog-facing interface rather than only
   * on the concrete class.
   *
   * They were reachable before — the composition root held one `HostedApp`
   * directly and closed over it — and that is exactly why a declared App could
   * be activated and still not be openable: the ONE listener was wired to ONE
   * app. Putting them here is what lets `AppReleaseHost` answer for every app it
   * serves without knowing what any of their releases contain.
   */
  publishedLabels(): Set<string>;
  documentFor(label: string, nonce: string): Promise<PublishedViewDocument | null>;
}

export interface HostedAppOptions<Prepared, Settings> {
  registry: AppReleaseRegistry;
  adapter: AppReleaseAdapter<Prepared, Settings>;
  /** Injected after construction; absent until this app's supervisor exists. */
  runtime?: RuntimeSwap;
  /** This app's backend process health, for the management page. */
  runtimeStatus?: () => AppBackendStatusView | null;
  /** Test seam: the bundle an empty registry is seeded from. */
  checkoutBundle?: () => ReleaseBundle;
  /** P2 test seam; production absorbs close/reopen churn for one minute. */
  retainedLingerMs?: number;
}

interface RetainedAppRelease<Prepared, Settings> {
  release: ActiveAppRelease<Prepared, Settings>;
  mode: "coexist" | "refresh_required";
  retainedAt: string;
  retireTimer: NodeJS.Timeout | null;
}

export class HostedApp<Prepared = unknown, Settings = unknown> {
  private readonly registry: AppReleaseRegistry;
  private readonly adapter: AppReleaseAdapter<Prepared, Settings>;
  private readonly checkoutBundle: () => ReleaseBundle;
  private readonly runtimeStatus: () => AppBackendStatusView | null;
  private runtime: RuntimeSwap | null;
  private current: ActiveAppRelease<Prepared, Settings> | null = null;
  private currentPackageDigest: string | null = null;
  private readonly retained = new Map<string, RetainedAppRelease<Prepared, Settings>>();
  private readonly releaseReferences = new Map<string, {
    count: number;
    backendCodeDigest: string;
  }>();
  private readonly retainedLingerMs: number;
  private failure: ReleaseFailure | null = null;
  private readonly listeners = new Set<(
    release: ActiveAppRelease<Prepared, Settings> | null,
    transition: HostedAppReleaseTransition | null,
  ) => void>();
  /** Serialises activations: two half-applied transitions would interleave. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: HostedAppOptions<Prepared, Settings>) {
    this.registry = options.registry;
    this.adapter = options.adapter;
    this.runtime = options.runtime ?? null;
    this.runtimeStatus = options.runtimeStatus ?? (() => null);
    this.checkoutBundle = options.checkoutBundle ?? (() => this.adapter.checkoutBundle());
    this.retainedLingerMs = Math.max(0, options.retainedLingerMs ?? 60_000);
  }

  /** The release being served, or null when nothing usable is active. */
  active(): ActiveAppRelease<Prepared, Settings> | null {
    return this.current;
  }

  /** P2's explicit active read face; `active()` remains for existing callers. */
  activeRelease(): ActiveAppRelease<Prepared, Settings> | null {
    return this.current;
  }

  /** The active package or a still-backed coexist package; never a downgrade entry. */
  servableRelease(packageDigest: string): ActiveAppRelease<Prepared, Settings> | null {
    if (packageDigest === this.currentPackageDigest) return this.current;
    const retained = this.retained.get(packageDigest);
    if (!retained || retained.mode !== "coexist") return null;
    const backendCodeDigest = this.adapter.runtimeTargetOf(retained.release.prepared).backendCodeDigest;
    if (this.runtime?.hasRuntimeVersion && !this.runtime.hasRuntimeVersion(backendCodeDigest)) {
      this.forgetRetained(packageDigest);
      return null;
    }
    return retained.release;
  }

  /** A fresh immutable snapshot for instance resolution and SSE reconnects. */
  servablePackageDigests(): ReadonlySet<string> {
    const digests = new Set<string>();
    if (this.current && this.currentPackageDigest) digests.add(this.currentPackageDigest);
    for (const packageDigest of [...this.retained.keys()]) {
      if (this.servableRelease(packageDigest)) digests.add(packageDigest);
    }
    return digests;
  }

  /** Count one live binding against both its release and backend cohort. */
  addReleaseReference(packageDigest: string): boolean {
    const release = this.servableRelease(packageDigest);
    if (!release) return false;
    const backendCodeDigest = this.adapter.runtimeTargetOf(release.prepared).backendCodeDigest;
    if (this.runtime?.addRuntimeReference && !this.runtime.addRuntimeReference(backendCodeDigest)) return false;
    const references = this.releaseReferences.get(packageDigest);
    if (references && references.backendCodeDigest !== backendCodeDigest) {
      this.runtime?.removeRuntimeReference?.(backendCodeDigest);
      return false;
    }
    this.releaseReferences.set(packageDigest, {
      count: (references?.count ?? 0) + 1,
      backendCodeDigest,
    });
    const retained = this.retained.get(packageDigest);
    if (retained?.retireTimer) {
      clearTimeout(retained.retireTimer);
      retained.retireTimer = null;
    }
    return true;
  }

  /** Release one binding; Runtime and package mappings share the same linger. */
  removeReleaseReference(packageDigest: string): boolean {
    const references = this.releaseReferences.get(packageDigest);
    if (!references || references.count === 0) return false;
    if (references.count === 1) this.releaseReferences.delete(packageDigest);
    else this.releaseReferences.set(packageDigest, { ...references, count: references.count - 1 });
    this.runtime?.removeRuntimeReference?.(references.backendCodeDigest);
    if (references.count === 1 && this.retained.has(packageDigest)) {
      this.scheduleRetainedReleaseRetirement(packageDigest);
    }
    return true;
  }

  /** Why nothing is being served, when that is the case. */
  unavailable(): ReleaseFailure | null {
    return this.current ? null : this.failure;
  }

  get appId(): string {
    return this.adapter.stableAppId;
  }

  get publisher(): string {
    return this.adapter.publisher;
  }

  /** This app's App Runtime is attached after its supervisor exists. */
  attachRuntime(runtime: RuntimeSwap): void {
    this.runtime = runtime;
  }

  subscribe(listener: (
    release: ActiveAppRelease<Prepared, Settings> | null,
    transition: HostedAppReleaseTransition | null,
  ) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Resolve what should be running, seeding the checkout release only when this
   * app has never been activated on this host.
   *
   * Never throws for a broken artifact. A deployment whose active release cannot
   * be prepared must still serve the panel — the page an operator uses to roll
   * back is on it, and a recovery tool that dies with the thing it recovers from
   * is not one.
   */
  async start(): Promise<ActiveAppRelease<Prepared, Settings> | null> {
    const existing = this.registry.resolveActive(this.appId, this.publisher);
    if (!existing.ok) {
      const notActive = existing.issues.some((issue) => issue.code === "not_active");
      if (!notActive) {
        this.failure = {
          code: existing.issues[0]?.code ?? "unknown",
          message: "已激活的 release 无法使用；请在 /apps 回滚到一个可用版本",
          issues: existing.issues,
        };
        log.error({ app: this.appId, issues: existing.issues }, "the active release is unusable");
        return null;
      }
      // "No pointer" has two meanings. Only an entirely empty catalog is a
      // first boot that may seed the checkout. Any history — including removed
      // or damaged rows — means an operator has already made a publication
      // decision, and an explicit deactivation must survive a process restart.
      if (this.registry.hasReleaseHistory(this.appId, this.publisher)) {
        this.failure = { code: "not_active", message: "本 App 当前没有被激活的 release" };
        return null;
      }
      // An app whose bytes only ever arrive has nothing to seed FROM, and that
      // is not a failure — it is the state every declared App starts in, and
      // the next step belongs to an operator rather than to a maintainer.
      // Reported as its own code so the log and the page can say so.
      if (this.adapter.seedsFromCheckout === false) {
        this.failure = {
          code: "not_installed",
          message: "本 App 还没有安装任何 release；请在 /apps 上安装一个 bundle 并激活它",
        };
        log.info({ app: this.appId }, "app has no checkout to seed from; awaiting an installed release");
        return null;
      }
      const seeded = await this.seed();
      if (!seeded.ok) {
        this.failure = seeded.failure;
        log.error({ app: this.appId, failure: seeded.failure }, "could not seed the first release");
        return null;
      }
      return this.current;
    }
    const adopted = await this.adopt(existing.release, existing.release.activatedBy, existing.release.activatedAt);
    if (!adopted.ok) {
      this.failure = adopted.failure;
      log.error({ app: this.appId, failure: adopted.failure }, "the active release cannot be served by this build");
      return null;
    }
    return this.current;
  }

  /** Install one immutable release. Installing never changes what is served. */
  install(bundle: ReleaseBundle, installedBy: string): InstallResult {
    const outcome = this.registry.install({
      descriptor: bundle.descriptor,
      assets: bundle.assets,
      provenance: bundle.provenance,
      installedBy,
    });
    if (!outcome.ok) {
      return { ok: false, failure: { code: "install_rejected", message: "release 未通过校验", issues: outcome.issues } };
    }
    return {
      ok: true,
      packageDigest: outcome.release.descriptor.packageDigest,
      deduplicated: outcome.deduplicated,
    };
  }

  /**
   * Inspect and prepare one installed candidate without starting a Runtime or
   * moving the active pointer. The same per-App queue as `activate()` makes the
   * predecessor and compatibility verdict one coherent snapshot.
   */
  previewActivation(packageDigest: string): Promise<ActivationPreview> {
    return this.serialise(async () => {
      const previous = this.current;
      const inspected = this.registry.inspect(packageDigest);
      if (!inspected.ok) {
        return {
          ok: false as const,
          failure: { code: "unknown_release", message: "没有这个 release", issues: inspected.issues },
        };
      }
      if (inspected.release.removedAt) {
        return {
          ok: false as const,
          failure: { code: "removed_release", message: "这个 release 已卸载，不能创建或执行 activation 审批" },
        };
      }
      const prepared = await this.prepare(inspected.release);
      if (!prepared.ok) return { ok: false as const, failure: prepared.failure };
      const verdict = previous
        ? (this.adapter.coexistence?.(previous.prepared, prepared.value.prepared)
          ?? { coexist: false as const, reason: ADAPTER_COEXISTENCE_UNDECLARED })
        : { coexist: true as const };
      return {
        ok: true as const,
        packageDigest,
        previousPackageDigest: this.currentPackageDigest,
        permissionContractDigest: inspected.release.descriptor.permissionContractDigest,
        coexistence: verdict.coexist ? "multi_version" : "refresh_required",
        reason: verdict.coexist ? null : verdict.reason,
      };
    });
  }

  /** Point this app at one installed release, in the order documented above. */
  activate(packageDigest: string, activatedBy: string): Promise<ActivateResult<Prepared, Settings>> {
    return this.serialise(async () => {
      const previous = this.current;
      const previousPackageDigest = this.currentPackageDigest;
      const inspected = this.registry.inspect(packageDigest);
      if (!inspected.ok) {
        return { ok: false as const, failure: { code: "unknown_release", message: "没有这个 release", issues: inspected.issues } };
      }
      const prepared = await this.prepare(inspected.release);
      if (!prepared.ok) return { ok: false as const, failure: prepared.failure };

      const coexistenceVerdict = previous
        ? (this.adapter.coexistence?.(previous.prepared, prepared.value.prepared)
          ?? { coexist: false as const, reason: ADAPTER_COEXISTENCE_UNDECLARED })
        : { coexist: true as const };
      const coexistence: ReleaseCoexistenceMode = coexistenceVerdict.coexist
        ? "multi_version"
        : "refresh_required";
      const reason = coexistenceVerdict.coexist ? null : coexistenceVerdict.reason;

      const candidate = await this.startCandidate(prepared.value);
      if (!candidate.ok) return { ok: false as const, failure: candidate.failure };

      const moved = this.registry.activate(this.appId, this.publisher, packageDigest, activatedBy);
      if (!moved.ok) {
        await this.discard(candidate.handle);
        return { ok: false as const, failure: { code: "activate_rejected", message: "激活被登记处拒绝", issues: moved.issues } };
      }
      // With no prior release there is nothing to retain. Every replacement is
      // fail-safe: only an adapter's explicit positive verdict keeps old code.
      this.commit(candidate.handle, previous && coexistenceVerdict.coexist ? "retain" : "swap");
      const release: ActiveAppRelease<Prepared, Settings> = {
        prepared: prepared.value.prepared,
        settings: prepared.value.settings,
        activatedBy: moved.release.activatedBy,
        activatedAt: moved.release.activatedAt,
      };
      // A rollback can promote a release that was itself retained. It is active
      // now, so its old mapping/timer must not later forget it as if it were an
      // abandoned cohort.
      this.forgetRetained(packageDigest);
      if (moved.changed && previous && previousPackageDigest && previousPackageDigest !== packageDigest) {
        this.retainRelease(
          previousPackageDigest,
          previous,
          coexistenceVerdict.coexist ? "coexist" : "refresh_required",
        );
      }
      this.currentPackageDigest = packageDigest;
      this.publish(release, packageHostLabel(packageDigest), {
        previousPackageDigest: moved.previousPackageDigest,
        changed: moved.changed,
        coexistence,
        reason,
      });
      log.info(
        {
          app: this.appId,
          packageDigest,
          previous: moved.previousPackageDigest,
          viewOrigin: this.adapter.viewOriginOf(release.settings),
          activatedBy,
          coexistence,
          reason,
        },
        "Agentic App release activated",
      );
      return {
        ok: true as const,
        release,
        previousPackageDigest: moved.previousPackageDigest,
        changed: moved.changed,
        coexistence,
        reason,
      };
    });
  }

  /** Stop serving this app without removing anything. */
  deactivate(by: string): Promise<SimpleResult> {
    return this.serialise(async () => {
      const outcome = this.registry.deactivate(this.appId, this.publisher);
      if (!outcome.ok) {
        return { ok: false as const, failure: { code: "deactivate_rejected", message: "停用失败", issues: outcome.issues } };
      }
      if (outcome.changed) {
        this.failure = { code: "not_active", message: "本 App 当前没有被激活的 release" };
        this.runtime?.deactivateRuntime();
        for (const packageDigest of [...this.retained.keys()]) this.forgetRetained(packageDigest);
        this.releaseReferences.clear();
        this.currentPackageDigest = null;
        this.publish(null, null);
        log.info({ app: this.appId, previous: outcome.previousPackageDigest, by }, "Agentic App release deactivated");
      }
      return { ok: true as const, changed: outcome.changed };
    });
  }

  /** Mark release metadata uninstalled. Refused while it is the active one. */
  uninstall(packageDigest: string, by: string): SimpleResult {
    const outcome = this.registry.uninstall(packageDigest, by);
    if (!outcome.ok) {
      return { ok: false, failure: { code: "uninstall_rejected", message: "卸载失败", issues: outcome.issues } };
    }
    if (outcome.changed && this.retained.has(packageDigest)) this.retireRelease(packageDigest);
    return { ok: true, changed: outcome.changed };
  }

  /**
   * Every installed release OF THIS APP, newest first, with this build's verdict.
   *
   * Filtered by the adapter rather than listed wholesale: with more than one app
   * in the catalog, an unfiltered listing would show every other app's releases
   * as `wrong_app`, which is a true sentence about a row that has no business
   * being on this app's page.
   */
  list(): Array<{
    release: InstalledRelease;
    active: boolean;
    compatibility: AdapterCompatibility;
    hostLabel: string;
  }> {
    const activeDigest = this.registry.listActive()
      .find((row) => row.stableAppId === this.appId && row.publisher === this.publisher)?.packageDigest ?? null;
    return this.registry
      .list({ stableAppId: this.appId, publisher: this.publisher })
      .map((release) => ({
        release,
        active: release.descriptor.packageDigest === activeDigest,
        compatibility: this.adapter.compatibility(release.descriptor),
        hostLabel: packageHostLabel(release.descriptor.packageDigest),
      }));
  }

  /**
   * Everything the local management page may be told about this app.
   *
   * The projection lives in `admin-view.ts`; what this method adds is the live
   * facts only the host has — which release is active, why none is, this app's
   * backend health, and whether this checkout's own package is already installed
   * (which is the difference between "publish" and "nothing to do").
   */
  describe(): AppRegistryView {
    const rows = this.list();
    const active = rows.find((row) => row.active) ?? null;
    let checkout: AppRegistryView["checkout"] = null;
    try {
      const digest = this.checkoutBundle().descriptor.packageDigest;
      checkout = {
        packageDigest: digest,
        hostLabel: packageHostLabel(digest),
        installed: rows.some((row) => row.release.descriptor.packageDigest === digest && !row.release.removedAt),
      };
    } catch {
      // No built Agent View in this deployment (or an installed-only host). The
      // page says "cannot describe this checkout" rather than inventing a digest.
      checkout = null;
    }
    return {
      stableAppId: this.appId,
      publisher: this.publisher,
      activeViewOrigin: this.current ? this.adapter.viewOriginOf(this.current.settings) : null,
      activePackageDigest: active?.release.descriptor.packageDigest ?? null,
      checkout,
      unavailable: this.unavailable(),
      runtime: this.runtimeStatus(),
      releases: rows.map((row) =>
        releaseView({
          release: row.release,
          active: row.active,
          hostLabel: row.hostLabel,
          compatibility: row.compatibility,
          ...(row.active && this.current
            ? { activatedBy: this.current.activatedBy, activatedAt: this.current.activatedAt }
            : {}),
        })),
    };
  }

  /**
   * Is this DNS label one this app currently publishes?
   *
   * Used by the View listener and by the reverse proxy's on-demand-TLS `ask`.
   * Every INSTALLED release qualifies, not only the active one, because the
   * bytes under a digest label are immutable and belong to that label — a tab
   * that was already open on the previous release keeps loading its own document
   * while it drains. The trusted panel only ever frames the ACTIVE origin, so
   * nothing new can be entered through an old one.
   */
  publishedLabels(): Set<string> {
    const labels = new Set<string>();
    for (const release of this.registry.list({ stableAppId: this.appId, publisher: this.publisher })) {
      if (!this.adapter.supports(release.descriptor)) continue;
      labels.add(packageHostLabel(release.descriptor.packageDigest));
    }
    return labels;
  }

  /**
   * The document for one published label, or null.
   *
   * Resolution is by digest: the label names a package, and this returns that
   * package's bytes or nothing. Serving one package's bytes under another
   * package's name is not a mistake this function can make, because the label is
   * the only key it has.
   */
  async documentFor(label: string, nonce: string): Promise<PublishedViewDocument | null> {
    const cached = this.documents.get(label);
    if (cached) return this.adapter.documentOf(cached, nonce);
    for (const release of this.registry.list({ stableAppId: this.appId, publisher: this.publisher })) {
      if (!this.adapter.supports(release.descriptor)) continue;
      if (packageHostLabel(release.descriptor.packageDigest) !== label) continue;
      const prepared = await this.adapter.prepare(release, (name) =>
        this.registry.readAsset(release.descriptor.packageDigest, name));
      if (!prepared.ok) return null;
      this.remember(label, prepared.prepared);
      return this.adapter.documentOf(prepared.prepared, nonce);
    }
    return null;
  }

  // ── internals ──

  /** A tiny bounded cache; a release is immutable so a hit can never be stale. */
  private readonly documents = new Map<string, Prepared>();

  private remember(label: string, prepared: Prepared): void {
    this.documents.set(label, prepared);
    while (this.documents.size > 4) {
      const oldest = this.documents.keys().next().value;
      if (oldest === undefined) break;
      this.documents.delete(oldest);
    }
  }

  private async seed(): Promise<ActivateResult<Prepared, Settings>> {
    let bundle: ReleaseBundle;
    try {
      bundle = this.checkoutBundle();
    } catch (error) {
      return { ok: false, failure: { code: "seed_build_failed", message: describe(error) } };
    }
    const installed = this.install(bundle, "system:bootstrap");
    if (!installed.ok) return { ok: false, failure: installed.failure };
    log.info(
      { app: this.appId, packageDigest: installed.packageDigest, deduplicated: installed.deduplicated },
      "seeding the first release from this checkout",
    );
    return await this.activate(installed.packageDigest, "system:bootstrap");
  }

  /** Adopt an already-active release at startup — same checks, no pointer move. */
  private async adopt(
    release: InstalledRelease,
    activatedBy: string,
    activatedAt: string,
  ): Promise<{ ok: true } | { ok: false; failure: ReleaseFailure }> {
    const prepared = await this.prepare(release);
    if (!prepared.ok) return { ok: false, failure: prepared.failure };
    this.current = {
      prepared: prepared.value.prepared,
      settings: prepared.value.settings,
      activatedBy,
      activatedAt,
    };
    this.currentPackageDigest = release.descriptor.packageDigest;
    this.failure = null;
    this.remember(packageHostLabel(release.descriptor.packageDigest), prepared.value.prepared);
    return { ok: true };
  }

  private async prepare(
    release: InstalledRelease,
  ): Promise<
    | { ok: true; value: { prepared: Prepared; settings: Settings } }
    | { ok: false; failure: ReleaseFailure }
  > {
    if (release.removedAt) {
      return { ok: false, failure: { code: "removed_release", message: "这个 release 已被卸载" } };
    }
    const prepared = await this.adapter.prepare(release, (name) =>
      this.registry.readAsset(release.descriptor.packageDigest, name));
    if (!prepared.ok) return { ok: false, failure: { code: prepared.code, message: prepared.message } };
    const settings = this.adapter.settingsFor(prepared.prepared);
    if (!settings.ok) return { ok: false, failure: { code: settings.code, message: settings.message } };
    return { ok: true, value: { prepared: prepared.prepared, settings: settings.settings } };
  }

  private async startCandidate(
    value: { prepared: Prepared; settings: Settings },
  ): Promise<{ ok: true; handle: unknown } | { ok: false; failure: ReleaseFailure }> {
    if (!this.runtime) return { ok: true, handle: null };
    const target = this.adapter.runtimeTargetOf(value.prepared);
    try {
      const handle = await this.runtime.prepareRuntime(target.appDir, target.backendCodeDigest);
      return { ok: true, handle };
    } catch (error) {
      return {
        ok: false,
        failure: {
          code: "runtime_unhealthy",
          message: `候选 release 的应用后端没有通过健康检查，active 指针未移动：${describe(error)}`,
        },
      };
    }
  }

  private commit(handle: unknown, mode: RuntimeCommitMode): void {
    if (this.runtime && handle !== null) this.runtime.commitRuntime(handle, mode);
  }

  private async discard(handle: unknown): Promise<void> {
    if (this.runtime && handle !== null) await this.runtime.discardRuntime(handle).catch(() => {});
  }

  private retainRelease(
    packageDigest: string,
    release: ActiveAppRelease<Prepared, Settings>,
    mode: RetainedAppRelease<Prepared, Settings>["mode"],
  ): void {
    this.forgetRetained(packageDigest);
    this.retained.set(packageDigest, {
      release,
      mode,
      retainedAt: new Date().toISOString(),
      retireTimer: null,
    });
    if ((this.releaseReferences.get(packageDigest)?.count ?? 0) === 0) {
      this.scheduleRetainedReleaseRetirement(packageDigest);
    }
  }

  private scheduleRetainedReleaseRetirement(packageDigest: string): void {
    const retained = this.retained.get(packageDigest);
    if (!retained || retained.retireTimer) return;
    retained.retireTimer = setTimeout(() => {
      retained.retireTimer = null;
      if ((this.releaseReferences.get(packageDigest)?.count ?? 0) === 0) this.forgetRetained(packageDigest);
    }, this.retainedLingerMs);
    retained.retireTimer.unref?.();
  }

  private retireRelease(packageDigest: string): void {
    const retained = this.retained.get(packageDigest);
    if (!retained) return;
    const backendCodeDigest = this.adapter.runtimeTargetOf(retained.release.prepared).backendCodeDigest;
    this.forgetRetained(packageDigest);
    // Several immutable packages can share one backend digest (the common
    // View-only fix). Removing one package must stale only that package's tabs,
    // not kill a cohort still serving another retained package or the active
    // release. References for the removed package keep their recorded backend
    // digest so their later destruction can still decrement the shared record.
    if (!this.hasServableBackend(backendCodeDigest, packageDigest)) {
      this.runtime?.retireRuntime?.(backendCodeDigest);
    }
  }

  private hasServableBackend(backendCodeDigest: string, exceptPackageDigest: string): boolean {
    if (this.current && this.currentPackageDigest !== exceptPackageDigest) {
      if (this.adapter.runtimeTargetOf(this.current.prepared).backendCodeDigest === backendCodeDigest) return true;
    }
    for (const [packageDigest, retained] of this.retained) {
      if (packageDigest === exceptPackageDigest || retained.mode !== "coexist") continue;
      if (this.adapter.runtimeTargetOf(retained.release.prepared).backendCodeDigest === backendCodeDigest) return true;
    }
    return false;
  }

  private forgetRetained(packageDigest: string): void {
    const retained = this.retained.get(packageDigest);
    if (!retained) return;
    if (retained.retireTimer) clearTimeout(retained.retireTimer);
    this.retained.delete(packageDigest);
  }

  /**
   * Adopt a transition's outcome and tell everyone who is watching.
   *
   * The label is passed in rather than derived from the prepared release: the
   * digest that addresses a release is a registry fact, and asking the app's own
   * prepared object for it would let an adapter answer with a name that is not
   * the one the pointer moved to.
   */
  private publish(
    release: ActiveAppRelease<Prepared, Settings> | null,
    label: string | null,
    transition: HostedAppReleaseTransition | null = null,
  ): void {
    this.current = release;
    if (release && label) {
      this.failure = null;
      this.remember(label, release.prepared);
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(release, transition);
      } catch (error) {
        // One bad subscriber must not unwind a transition that already happened.
        log.warn({ app: this.appId, err: error }, "a release listener threw");
      }
    }
  }

  private serialise<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

export type { AppReleaseDescriptor, InstalledRelease };

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 300);
}
