import { moduleAssetName, MODULE_ENTRY_FILE, MODULE_ENTRY_ASSET, readAppModuleEntry } from "@claude-bot/agent-view-build/module-assets";
/**
 * Which Agentic Apps this process serves, and which release each of them is on.
 *
 * ── What changed, and why it is a catalog now ───────────────────────────────
 *
 * This object used to BE one app: it held a `SessionPlusReleaseAdapter`,
 * returned a Session-Plus-shaped active release, and had one active pointer.
 * Every question it answered was already app-agnostic — install, activate, roll
 * back, deactivate, list, describe — but the single adapter meant a second
 * production app was a change to the platform's own files rather than an entry
 * in a table. The transition machinery therefore moved to `HostedApp` (one
 * instance per app, unchanged semantics) and what is left here is the thing
 * that decides WHICH app a call is about:
 *
 *   stable app id → HostedApp → adapter → this build's answers about that app
 *
 * ── The three properties this layer owes ────────────────────────────────────
 *
 *  1. **Routing is by stable app id, and it is total.** A call naming an app
 *     this composition did not build gets a bounded refusal, not the first app
 *     in the table. Two adapters claiming one id is a composition error and
 *     throws at construction — an id collision that survives to runtime would
 *     make "which app did that activation move" unanswerable.
 *  2. **Apps do not share mutable state.** Each `HostedApp` owns its pointer,
 *     its serialisation queue, its runtime swap and its subscribers. The only
 *     thing they share is the registry, whose pointer moves are transactional
 *     and keyed by `(stableAppId, publisher)`. One app failing to start cannot
 *     stop another from being served.
 *  3. **Starting is best-effort, per app.** A deployment whose active release
 *     cannot be prepared must still serve the panel — `/apps` is where an
 *     operator rolls back, and a recovery tool that dies with the thing it
 *     recovers from is not one. `start()` therefore never throws; each app's
 *     own `unavailable()` says why it is not being served.
 *  4. **The set of apps is not fixed at construction.** `addApp` puts one more
 *     app into the catalog while the process runs, which is what makes a
 *     declared App (`declared-adapter.ts`) usable the moment somebody declares
 *     it rather than after the next deploy. Nothing else about the catalog
 *     changes: the new app owns its own pointer and queue exactly like the ones
 *     built at boot, and the id-collision rule is the same one.
 *
 * ── What this object is NOT ─────────────────────────────────────────────────
 *
 * Not an authorization boundary (the panel's route table, mutation gate and
 * admin-only rule are in front of every caller), not a store (no remote
 * catalogue, no search, no download), and not App trust or a capability grant —
 * it cannot reach `app_trust`, `grant_intents` or the kernel, so "activating a
 * release grants it nothing" stays structural.
 */

import type {
  AppReleaseDescriptor,
  AppReleaseRegistry,
  InstalledRelease,
  RegistryIssue,
} from "@claude-bot/app-registry";
import { createLogger } from "../logger.js";
import type { AppRegistryDirectoryView } from "./admin-view.js";
import type { InstallResult, ManagedApp, ReleaseFailure } from "./hosted-app.js";
import type { ReleaseBundle } from "./bundle.js";
import type { PublishedViewDocument } from "../app-core/view-app.js";

const log = createLogger("app-release-host");

export interface AppReleaseHostOptions {
  registry: AppReleaseRegistry;
  /** One entry per app this composition serves, in the order it built them. */
  apps: readonly ManagedApp[];
}

export class AppReleaseHost {
  private readonly registry: AppReleaseRegistry;
  private readonly byId = new Map<string, ManagedApp>();

  constructor(options: AppReleaseHostOptions) {
    this.registry = options.registry;
    for (const app of options.apps) this.adopt(app);
  }

  /**
   * The apps this catalog serves, in the order they were added.
   *
   * A snapshot rather than the live map: a caller that iterates while a
   * declaration is being added should see one consistent list, and nothing
   * outside this class may add an entry except through `addApp`.
   */
  get apps(): readonly ManagedApp[] {
    return [...this.byId.values()];
  }

  /** Only installed browser assets are public; backend/source assets have no route. */
  viewAssetFor(packageDigest: string, file: string): Uint8Array | null {
    if (!/^[0-9a-f]{64}$/.test(packageDigest)) return null;
    const entryBytes = this.registry.readAsset(packageDigest, MODULE_ENTRY_ASSET);
    if (!entryBytes) return null;
    const entry = readAppModuleEntry(Buffer.from(entryBytes).toString("utf8"));
    if (!entry || !this.byId.has(entry.appId)) return null;
    if (file === MODULE_ENTRY_FILE) return entryBytes;
    if (!entry.assets.includes(file)) return null;
    return this.registry.readAsset(packageDigest, moduleAssetName(file));
  }

  /** The apps this composition serves, for a caller that has to enumerate. */
  ids(): string[] {
    return [...this.byId.keys()];
  }

  /**
   * Serve one more app, without restarting anything.
   *
   * This is what makes "App = pure data" true at runtime rather than only at
   * boot: a declaration accepted through `/api/apps/declare` becomes a served
   * app in this process, immediately, and the same code path runs at startup for
   * every row already in the table.
   *
   * Two properties, and they pull in opposite directions on purpose:
   *
   *  · **A duplicate id THROWS.** It is a composition error whichever way it
   *    arrives — with two entries under one id, "which app does
   *    `/api/apps?app=x` manage" has two answers. The caller turns it into a
   *    bounded refusal for the person who typed it.
   *  · **Starting is best-effort.** `start()` resolves what should be running;
   *    for a freshly declared app there is nothing installed yet, so it reports
   *    "no servable release" and the app still joins the catalog. It has to: the
   *    page an operator installs a release on is the one that lists it.
   */
  async addApp(app: ManagedApp): Promise<ManagedApp> {
    this.adopt(app);
    try {
      const active = await app.start();
      if (!active) {
        log.info(
          { app: app.appId, failure: app.unavailable() },
          "app added with no servable release yet; install and activate one on /apps",
        );
      }
    } catch (error) {
      // `HostedApp.start()` is documented never to throw. If a future
      // `ManagedApp` does, the app stays in the catalog — it is registered, and
      // removing it here would leave the panel unable to manage the thing that
      // just failed.
      log.error({ app: app.appId, err: error }, "an app threw while starting; it is still in the catalog");
    }
    return app;
  }

  private adopt(app: ManagedApp): void {
    if (this.byId.has(app.appId)) {
      // A composition error, and it has to be loud: with two adapters under
      // one id, "which app does /api/apps?app=x manage" has two answers and
      // the pointer either could move is chosen by array order.
      throw new Error(`two adapters claim the stable app id ${app.appId}`);
    }
    this.byId.set(app.appId, app);
  }

  /** One app by its stable id, or null when this composition serves no such app. */
  app(stableAppId: string): ManagedApp | null {
    return this.byId.get(stableAppId) ?? null;
  }

  /**
   * Resolve every app's active release.
   *
   * Never throws, and never lets one app's failure hide another's success: each
   * app records its own reason in `unavailable()` and the caller reports.
   */
  async start(): Promise<void> {
    for (const app of this.apps) {
      const active = await app.start();
      if (!active) {
        const failure = app.unavailable();
        // "Nothing installed yet" is where a declared App legitimately begins,
        // so it is not an error. Everything else is: a deployment that cannot
        // serve the release it was pointed at needs a reader to notice.
        if (failure?.code === "not_installed") {
          log.info({ app: app.appId, failure }, "app has no installed release yet; install one on /apps");
        } else {
          log.error(
            { app: app.appId, failure },
            "no servable release for this app; the panel still starts so it can be rolled back",
          );
        }
      }
    }
  }

  /**
   * Install one immutable release, routed by the descriptor it carries.
   *
   * The bundle names its own app, so this needs no separate parameter — and
   * because it is routed rather than accepted, a bundle for an app this host
   * does not compose is a refusal with a reason instead of a row nothing can
   * ever activate.
   */
  install(bundle: ReleaseBundle, installedBy: string): InstallResult & { app?: string } {
    const app = this.byId.get(bundle.descriptor.stableAppId);
    if (!app || app.publisher !== bundle.descriptor.publisher) {
      return {
        ok: false,
        failure: {
          code: "unknown_app",
          message:
            `本进程没有为 ${bundle.descriptor.publisher}/${bundle.descriptor.stableAppId} 组合适配器，`
            + `装了也永远激活不了。本进程服务的是：${this.ids().join("、") || "（没有）"}`,
        },
      };
    }
    const outcome = app.install(bundle, installedBy);
    return outcome.ok ? { ...outcome, app: app.appId } : outcome;
  }

  /** Everything the local management page may be told, for every app. */
  describe(): AppRegistryDirectoryView {
    // A directory GET must not synchronously read/hash every historical
    // bundle on the shared HTTP event loop. Structural damage is still
    // reported; explicit reconcile() and actual asset reads verify contents.
    const report = this.registry.reconcile({ verification: "manifest" });
    return {
      apps: this.apps.map((app) => app.describe()),
      reconcile: {
        verification: "manifest",
        activeUnusable: report.activeUnusable.map((row) => ({
          packageDigest: row.packageDigest,
          code: row.issue.code,
          message: row.issue.message,
        })),
        installedUnusable: report.installedUnusable.map((row) => ({
          packageDigest: row.packageDigest,
          code: row.issue.code,
          message: row.issue.message,
        })),
        undescribable: report.undescribable.map((row) => row.packageDigest),
        orphanContent: report.orphanContent.length,
      },
    };
  }

  /** Cross-check the catalog against the filesystem. Reports; never repairs. */
  reconcile(): ReturnType<AppReleaseRegistry["reconcile"]> {
    return this.registry.reconcile();
  }

  /**
   * Every digest label this host publishes, across every app in the catalog.
   *
   * ── Why a union is the right answer, and why it is safe ─────────────────────
   *
   * A label is `app-<first 20 hex of packageDigest>`, and the package digest
   * covers the stable app id and the publisher — so two apps cannot mint the
   * same label except by finding a digest collision. The union is therefore not
   * a merge of two namespaces; it is one namespace that several apps contribute
   * to, which is what makes ONE listener and ONE on-demand-TLS `ask` endpoint
   * correct for a host that serves several apps.
   *
   * Every INSTALLED release of every app qualifies, not only the active ones —
   * see `HostedApp.publishedLabels` for why a tab draining on the previous
   * release must keep loading its own bytes.
   */
  publishedLabels(): Set<string> {
    const labels = new Set<string>();
    for (const app of this.apps) {
      for (const label of app.publishedLabels()) labels.add(label);
    }
    return labels;
  }

  /**
   * One published label's document, from whichever app publishes it.
   *
   * The label is the ONLY key, exactly as it is for a single app: this cannot be
   * asked for "the current release" or "app X's release", so serving one
   * package's bytes under another package's hostname is not an operation that
   * exists. Apps are asked in catalog order and the FIRST that publishes the
   * label answers — a collision is unreachable (see `publishedLabels`), and if
   * one ever happened, answering deterministically beats answering by whichever
   * app was asked to prepare fastest.
   */
  async documentFor(label: string, nonce: string): Promise<PublishedViewDocument | null> {
    for (const app of this.apps) {
      if (!app.publishedLabels().has(label)) continue;
      return await app.documentFor(label, nonce);
    }
    return null;
  }

  /** The refusal a route hands back when its `app` names nothing here. */
  unknownApp(stableAppId: string): ReleaseFailure {
    return {
      code: "unknown_app",
      message:
        `本进程没有服务 ${stableAppId} 这个 App。`
        + `本进程服务的是：${this.ids().join("、") || "（没有）"}`,
    };
  }
}

export { HostedApp } from "./hosted-app.js";
export type {
  ActivationPreview,
  ActivateResult,
  ActiveAppRelease,
  HostedAppOptions,
  InstallResult,
  ManagedApp,
  ReleaseFailure,
  RuntimeSwap,
  SimpleResult,
} from "./hosted-app.js";
export type { AppReleaseAdapter } from "./adapter.js";
export type { AppReleaseDescriptor, InstalledRelease, RegistryIssue };
