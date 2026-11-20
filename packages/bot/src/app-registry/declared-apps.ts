/**
 * Turning rows in `app_declarations` into apps this process serves.
 *
 * ── One code path, two moments ──────────────────────────────────────────────
 *
 * A declared App can arrive two ways: it was already in the table when the
 * process started, or somebody just declared it through `/api/apps/declare`.
 * Both go through `compose()` here, deliberately — two paths would be two
 * chances for "an App declared at runtime" and "the same App after a restart"
 * to be built differently, and the difference would only show up on the restart.
 *
 * ── What composing an App does, in order ────────────────────────────────────
 *
 * ```text
 *   adapter        pure data in, refusals out (declared-adapter.ts)
 *   HostedApp      its own active pointer, queue, runtime swap, subscribers
 *   host.addApp    joins the catalog and resolves what should be running
 *   backends       its own State/Runtime children under its own state directory
 *   attachRuntime  from here on, an activation can swap that App's child
 * ```
 *
 * A freshly declared App has no installed release, so `start()` reports "no
 * servable release" and it joins the catalog anyway. It has to: the page an
 * operator installs a release on is the page that lists it.
 *
 * ── What this module does NOT decide ────────────────────────────────────────
 *
 * Not who may declare (the panel's route table puts `Administer` in front), not
 * whether an App is trusted (`app_trust`), not what it may do (a declared App's
 * permission contract is empty and its adapter refuses anything else), and not
 * which release is served (that is an explicit activation, as it is for every
 * app).
 */

import * as path from "node:path";
import type { AppReleaseRegistry } from "@claude-bot/app-registry";
import { createLogger } from "../logger.js";
import type { Store } from "../store/store.js";
import type { AppDeclarationRow } from "../store/repositories/app-catalog.js";
import type { AppBackendRegistry, AppBackendSupervisor } from "./backend-supervisor.js";
import {
  DeclaredAppAdapter,
  declarationProblem,
  type AppDeclaration,
  type DeclaredAppHosting,
  type DeclaredAppSettings,
  type PreparedDeclaredRelease,
} from "./declared-adapter.js";
import { AppInstanceService, type AppInstanceRelease } from "./app-instance.js";
import { AppReleaseHost, HostedApp } from "./release-host.js";
import { DeclaredAppAgentBackend } from "./declared-agent-backend.js";
import type { AppAgentPlane } from "../app-agents/plane.js";

const log = createLogger("declared-apps");

export type DeclaredHostedApp = HostedApp<PreparedDeclaredRelease, DeclaredAppSettings>;

export interface ComposedDeclaredApp {
  declaration: AppDeclaration;
  app: DeclaredHostedApp;
  /** Null when this composition builds no backend children (tests, dry runs). */
  supervisor: AppBackendSupervisor | null;
  /**
   * The per-tab coordinator a browser drives this App through, or null when
   * there are no backend children for it to talk to.
   *
   * Built here rather than by the panel, for the same reason the supervisor is:
   * the composition root owns the App's lifetime, and a panel that constructed
   * one would be a second owner of a State stream.
   */
  service: AppInstanceService | null;
}

/**
 * One declared App, as much of it as a trusted host page may know.
 *
 * Structurally the panel's `DeclaredAppSurface`; declared here so the composer
 * does not import the dashboard, and satisfied structurally so the dashboard
 * does not import the composer.
 */
export interface DeclaredAppView {
  stableAppId: string;
  publisher: string;
  title: string;
  viewOrigin: string | null;
  viewUrl?: string;
  packageDigest: string | null;
  service: AppInstanceService | null;
  unavailable: string | null;
}

export type DeclareOutcome =
  | { ok: true; app: string; publisher: string; title: string }
  | { ok: false; code: "invalid" | "app_exists" | "compose_failed"; message: string };

export interface DeclaredAppComposerOptions {
  store: Store;
  registry: AppReleaseRegistry;
  host: AppReleaseHost;
  /** Root under which one directory per package digest is materialised. */
  preparedRoot: string;
  /** The App origin policy this deployment configured. */
  hosting: DeclaredAppHosting;
  /**
   * Where each declared App's State/Runtime children come from.
   *
   * Optional so a test can compose an App without spawning two child processes
   * per declaration. Absent means the App is catalogued and manageable but has
   * no backend — which is also the honest state of an App whose supervisor
   * failed to register.
   */
  backends?: AppBackendRegistry | null;
  /** Optional trusted agent plane; absence keeps `binding: agent` fail-closed. */
  agentPlane?: AppAgentPlane | null;
  /** Injected for tests; production stamps the wall clock. */
  now?: () => string;
}

export class DeclaredAppComposer {
  private resourceFactory: import('./resource-plane.js').DeclaredResourceFactory | null = null;
  private readonly resourceDetachers = new Map<string, () => void>();
  attachResources(factory: import('./resource-plane.js').DeclaredResourceFactory): () => void {
    if (this.resourceFactory) throw new Error('declared resources already composed');
    this.resourceFactory = factory;
    for (const record of this.composed.values()) this.attachRecordResources(record);
    return () => {
      for (const detach of this.resourceDetachers.values()) detach();
      this.resourceDetachers.clear(); this.resourceFactory = null;
    };
  }
  private attachRecordResources(record: ComposedDeclaredApp): void {
    const plane = this.resourceFactory?.(record.declaration.stableAppId, record.declaration.publisher);
    if (plane && record.service) this.resourceDetachers.set(record.declaration.stableAppId, record.service.attachResources(plane));
  }
  private readonly options: DeclaredAppComposerOptions;
  private readonly composed = new Map<string, ComposedDeclaredApp>();
  private readonly releaseSubscriptions = new Map<string, () => void>();

  constructor(options: DeclaredAppComposerOptions) {
    this.options = options;
  }

  /** Every declared App this process built, in the order it built them. */
  get apps(): readonly ComposedDeclaredApp[] {
    return [...this.composed.values()];
  }

  /**
   * Build every enabled declaration already in the table. The startup path.
   *
   * Best-effort per row and never throws: one App whose backend cannot start
   * must not stop the control plane, because `/apps` is where that App gets
   * disabled or rolled back.
   */
  async loadAll(): Promise<readonly ComposedDeclaredApp[]> {
    for (const row of this.options.store.appCatalog.listAppDeclarations()) {
      if (!row.enabled) {
        log.info({ app: row.app_id }, "declared App is disabled; not composing it");
        continue;
      }
      const problem = declarationProblem(declarationOf(row));
      if (problem) {
        // A row that predates a grammar change, or one written by something
        // other than the declare route. Reported, skipped, never repaired here.
        log.error({ app: row.app_id, problem }, "declared App row does not satisfy the declaration grammar");
        continue;
      }
      try {
        await this.compose(declarationOf(row));
      } catch (error) {
        log.error({ app: row.app_id, err: error }, "could not compose a declared App; the panel still starts");
      }
    }
    return this.apps;
  }

  /**
   * Declare one App at runtime: a row, an adapter, a catalog entry, children.
   *
   * The order is "write the row first" on purpose. A declaration is a durable
   * decision that survives this process; composition is this process's attempt
   * to honour it. If the row were written last, a composition that failed
   * halfway would leave a serving App that vanishes on restart — the harder of
   * the two states to notice. This way a failure leaves a declared App that is
   * not yet composed, and the next restart tries again.
   */
  async declare(input: {
    stableAppId: string;
    publisher: string;
    title: string;
    by: string;
  }): Promise<DeclareOutcome> {
    const declaration: AppDeclaration = {
      stableAppId: input.stableAppId,
      publisher: input.publisher,
      title: input.title.trim(),
    };
    const problem = declarationProblem(declaration);
    if (problem) return { ok: false, code: "invalid", message: problem };

    // Asked of the CATALOG, not only of the table: this host already serves apps
    // that were never declared (Session Plus is compiled in), and letting a
    // declaration take one of their ids would make "which app does
    // /api/apps?app=x manage" ambiguous.
    if (this.options.host.app(declaration.stableAppId)) {
      return {
        ok: false,
        code: "app_exists",
        message: `本进程已经在服务 ${declaration.stableAppId} 这个 App，不能用同一个 id 再声明一个`,
      };
    }
    const inserted = this.options.store.appCatalog.insertAppDeclaration({
      app_id: declaration.stableAppId,
      publisher: declaration.publisher,
      title: declaration.title,
      enabled: 1,
      declared_by: input.by,
      declared_at: (this.options.now ?? (() => new Date().toISOString()))(),
    });
    if (!inserted) {
      const existing = this.options.store.appCatalog.getAppDeclaration(declaration.stableAppId);
      return {
        ok: false,
        code: "app_exists",
        message:
          `${declaration.stableAppId} 已经被声明过`
          + (existing && existing.publisher !== declaration.publisher
            ? `（发布者是 ${existing.publisher}，不是 ${declaration.publisher}）`
            : "")
          + (existing && !existing.enabled ? "，但当前是停用状态；重启后才会被组合" : ""),
      };
    }
    try {
      await this.compose(declaration);
    } catch (error) {
      log.error({ app: declaration.stableAppId, err: error }, "declared App was recorded but could not be composed");
      return {
        ok: false,
        code: "compose_failed",
        message:
          "声明已经记录，但本进程没能把它组合起来；重启后会再试一次。"
          + `原因：${error instanceof Error ? error.message : String(error)}`,
      };
    }
    log.info(
      { app: declaration.stableAppId, publisher: declaration.publisher, by: input.by },
      "declared a new Agentic App; it is now in the catalog and awaits an installed release",
    );
    return {
      ok: true,
      app: declaration.stableAppId,
      publisher: declaration.publisher,
      title: declaration.title,
    };
  }

  /**
   * The one place a declaration becomes a served App.
   *
   * Order matches the compiled-in apps' composition exactly: resolve what should
   * be running first, then point the backend at THAT release's materialised tree
   * — so "which code is in the sandbox" and "which code the hostname names"
   * cannot disagree.
   */
  async compose(declaration: AppDeclaration): Promise<ComposedDeclaredApp> {
    let supervisor: AppBackendSupervisor | null = null;
    const app = new HostedApp<PreparedDeclaredRelease, DeclaredAppSettings>({
      registry: this.options.registry,
      adapter: new DeclaredAppAdapter({
        declaration,
        preparedRoot: this.options.preparedRoot,
        hosting: this.options.hosting,
      }),
      // Read late: the supervisor is built below, from the release this resolves.
      runtimeStatus: () => {
        const status = supervisor?.status;
        if (!status) return null;
        return {
          state: status.state,
          runtime: status.runtime,
          statePid: status.statePid ?? null,
          runtimePid: status.runtimePid ?? null,
        };
      },
    });
    // Capacity refusal happens before the release host mutates its catalog, so
    // an over-limit durable declaration remains pending rather than half-composed.
    this.options.backends?.assertCanRegister(declaration.stableAppId);
    // Throws on a duplicate id, which is what the caller turns into a refusal.
    // Done before any child process exists, so a rejected declaration has not
    // spawned anything.
    await this.options.host.addApp(app);
    const active = app.active();

    const backends = this.options.backends;
    let service: AppInstanceService | null = null;
    if (backends) {
      supervisor = backends.register(declaration.stableAppId, {
        appDir: active?.prepared.appDir ?? path.join(this.options.preparedRoot, "__none__"),
      });
      // State always; Runtime only when there is a release for it to load. An
      // activation later brings the Runtime up through the same candidate/commit
      // path a hot update uses.
      await supervisor.start({ runtime: Boolean(active) });
      app.attachRuntime(supervisor);
      // Reads both active and retained releases through the HostedApp so new
      // opens follow the pointer while an existing binding stays pinned to the
      // immutable release (and backend digest) it opened against.
      service = new AppInstanceService({
        stableAppId: declaration.stableAppId,
        state: supervisor.state,
        runtime: supervisor.runtime,
        activeRelease: () => releaseFacts(app),
        servableRelease: (packageDigest) => releaseFacts(app, packageDigest),
        servablePackageDigests: () => app.servablePackageDigests(),
        onInstanceCreated: (binding) => app.addReleaseReference(binding.packageDigest),
        onInstanceDestroyed: (binding) => {
          app.removeReleaseReference(binding.packageDigest);
        },
        // The membership door reads the store FRESH per open/dispatch
        // (ADR 0007 P1); the composer already holds the only Store.
        shared: {
          instance: (appId, key) => this.options.store.getSharedAppInstance(appId, key),
          member: (appId, key, username) => this.options.store.getSharedAppMember(appId, key, username),
        },
        agentActivity: this.options.agentPlane ?? undefined,
        deliverAgent: this.options.agentPlane
          ? (input) => this.options.agentPlane!.deliver(input)
          : undefined,
      });
      const instanceService = service;
      this.releaseSubscriptions.set(declaration.stableAppId, app.subscribe((release, transition) => {
        if (!release || !transition?.changed) return;
        instanceService.markReleaseAvailable({
          availableDigest: release.prepared.descriptor.packageDigest,
          mode: transition.coexistence,
        });
      }));
    }
    const record: ComposedDeclaredApp = { declaration, app, supervisor, service };
    this.composed.set(declaration.stableAppId, record);
    this.attachRecordResources(record);
    if (service && this.options.agentPlane) {
      this.options.agentPlane.registerBackend(new DeclaredAppAgentBackend(declaration.stableAppId, service));
    }
    return record;
  }

  /** Stop every coordinator this composer built. Instances are destroyed with them. */
  stop(): void {
    for (const unsubscribe of this.releaseSubscriptions.values()) unsubscribe();
    this.releaseSubscriptions.clear();
    for (const record of this.composed.values()) record.service?.stop();
  }

  /**
   * The narrow view the panel is given, so it can host one App's frame.
   *
   * A projection rather than the composed record: the panel may look an App up
   * and drive one tab of it, and it must not be able to declare, compose or tear
   * one down. Nulls are the honest first state of a declared App — "nothing
   * activated yet" is where every one of them begins, and it has to read as
   * "install one" rather than as a defect.
   */
  list(): readonly DeclaredAppView[] {
    return [...this.composed.values()].map((record) => this.view(record));
  }

  get(stableAppId: string): DeclaredAppView | null {
    const record = this.composed.get(stableAppId);
    return record ? this.view(record) : null;
  }

  private view(record: ComposedDeclaredApp): DeclaredAppView {
    const active = record.app.active();
    return {
      stableAppId: record.declaration.stableAppId,
      publisher: record.declaration.publisher,
      title: record.declaration.title,
      viewOrigin: active?.settings.viewOrigin ?? null,
      ...(active?.settings.viewUrl ? { viewUrl: active.settings.viewUrl } : {}),
      packageDigest: active?.prepared.descriptor.packageDigest ?? null,
      service: record.service,
      unavailable: record.app.unavailable()?.message ?? null,
    };
  }
}

function declarationOf(row: AppDeclarationRow): AppDeclaration {
  return { stableAppId: row.app_id, publisher: row.publisher, title: row.title };
}

/**
 * The subset of the active release a coordinator needs, or null.
 *
 * Projected here rather than passed as a value so that "which release is being
 * served" is asked at the moment of use — the same reason `HostedApp.active()`
 * is a method. `appDir` never leaves this process.
 */
function releaseFacts(app: DeclaredHostedApp, packageDigest?: string): AppInstanceRelease | null {
  const release = packageDigest ? app.servableRelease(packageDigest) : app.activeRelease();
  if (!release) return null;
  return {
    stableAppId: release.prepared.descriptor.stableAppId,
    publisher: release.prepared.descriptor.publisher,
    packageDigest: release.prepared.descriptor.packageDigest,
    permissionContractDigest: release.prepared.descriptor.permissionContractDigest,
    backendCodeDigest: release.prepared.backendCodeDigest,
    appDir: release.prepared.appDir,
  };
}
