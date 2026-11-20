/**
 * The acceptance test for "an App is pure data" (convergence plan, decision 2).
 *
 * ── Read this first ─────────────────────────────────────────────────────────
 *
 * The App exercised below — `demo-notes`, published by `demo:acme` — is born in
 * THIS FILE, out of three strings and a byte array. Nothing in `packages/bot`
 * mentions it: no adapter constant, no composition-root line, no manifest, no
 * permission contract, no migration. That is the whole criterion. This file is
 * therefore the PLATFORM's acceptance test, not the App's code — an App that
 * needed a source file of its own to exist would be the thing decision 2 says
 * must stop being true.
 *
 * The bundle is assembled the way an outside packer would assemble one: the
 * descriptor comes from the registry's own `describeRelease` (which recomputes
 * every digest from the bytes) and the permission contract digest comes from the
 * engine's one implementation of that framing, over an EMPTY ask. No helper in
 * this repository knows what `demo-notes` is.
 *
 * ── What each case is actually protecting ───────────────────────────────────
 *
 *  · declare → install → activate, and Session Plus untouched — the positive
 *    claim, plus the property that makes it safe to make: two apps share the
 *    registry and nothing else, so moving one pointer cannot move the other.
 *  · the same thing again through `loadAll()` — the startup path. A declaration
 *    that only worked in the process that accepted it would evaporate on the
 *    next restart, which is the harder failure to notice.
 *  · a `modular-v2` release is refused — a declared App may not bind user
 *    resources, because which typed ports exist and which provider serves one
 *    are platform decisions a reviewer merged and a deployer deployed.
 *  · a non-empty permission contract is refused — the same fail-closed rule
 *    every app's adapter applies to an ask this build cannot project or audit.
 *  · a duplicate declaration is refused, in both directions (a second row, and
 *    an id a compiled-in app already owns).
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AppReleaseRegistry,
  FileReleaseContentStore,
  describeRelease,
  packageHostLabel,
  type AppReleaseDescriptor,
  type InstallProvenance,
} from "@claude-bot/app-registry";
import {
  encodeComposition,
  encodeModuleLock,
  encodeResourceBindings,
} from "@claude-bot/agent-module-contract";
import { contractDigestOf } from "@claude-bot/engine";
import { Store } from "../store/store.js";
import { StoreReleaseCatalog } from "./store-catalog.js";
import { appReleasePaths } from "./paths.js";
import { AppReleaseHost, HostedApp, type RuntimeSwap } from "./release-host.js";
import type { RuntimeCommitMode } from "./hosted-app.js";
import { DeclaredAppComposer } from "./declared-apps.js";
import { AppBackendCapacityExceeded } from "./backend-supervisor.js";
import {
  DeclaredAppAdapter,
  declaredAppHostingFrom,
  emptyContractDigestFor,
  type DeclaredAppHosting,
} from "./declared-adapter.js";
import { SessionPlusReleaseAdapter, type PreparedSessionPlusRelease } from "./session-plus-adapter.js";
import { buildCheckoutBundle, type ReleaseBundle } from "./session-plus-package.js";
import { resolveSessionPlus, type SessionPlusSettings } from "../app-core/settings.js";
import { VIEW_APP_HTML } from "../app-core/view-app.js";
import { PANEL_RESOURCE_CONTRACTS } from "../dashboard/server.js";

// ── The App, as data ────────────────────────────────────────────────────────

const DEMO_APP = "demo-notes";
const DEMO_PUBLISHER = "demo:acme";
const DEMO_TITLE = "Demo Notes";

/**
 * The four backend files, as literals.
 *
 * Minimal but real: the App Runtime's release digest is taken over `actions.ts`
 * and `projection.ts`, and the platform materialises all four. Nothing here is
 * Session Plus's — the point of writing them out is that a second App's backend
 * is authored, not inherited.
 */
const DEMO_BACKEND: ReadonlyArray<{ name: string; source: string }> = Object.freeze([
  {
    name: "app/app.yaml",
    source: [
      "id: demo-notes",
      "schema: 1",
      "state:",
      "  scope: account",
      "actions:",
      "  add_note:",
      "    binding: runtime",
      "    handler: add_note",
      "    params:",
      "      text:",
      "        type: string",
      "        max: 512",
      "view:",
      "  page: pages/main.yaml",
      "",
    ].join("\n"),
  },
  {
    name: "app/actions.ts",
    source: [
      "/** One event-producing action; App-owned state only. */",
      "export function add_note(ctx: any, params: any) {",
      "  const text = typeof params?.text === 'string' ? params.text.slice(0, 512) : '';",
      "  if (!text) throw new Error('add_note requires text');",
      "  return {",
      "    events: [{ type: 'note_added', data: { text }, at: String(ctx?.now ?? ''), by: 'demo-notes' }],",
      "    result: { added: true },",
      "  };",
      "}",
      "",
    ].join("\n"),
  },
  {
    name: "app/projection.ts",
    source: [
      "/** Pure fold over App-owned state only. */",
      "export function project(events: any[]) {",
      "  const notes = [];",
      "  for (const event of Array.isArray(events) ? events : []) {",
      "    if (event?.type === 'note_added') notes.push(String(event?.data?.text ?? ''));",
      "  }",
      "  return { notes };",
      "}",
      "",
    ].join("\n"),
  },
  {
    name: "app/pages/main.yaml",
    source: ["layout: list-detail", "sources: {}", "actions:", "  add: add_note", ""].join("\n"),
  },
]);

/** A genuine three-asset legacy browser fixture, authored by this App. */
function demoViewAssets(): Array<{ name: string; source: string }> {
  return [
    { name: "view.html", source: VIEW_APP_HTML },
    { name: "view.css", source: "body { font: 16px sans-serif; }\n" },
    { name: "view.js", source: '(() => { document.getElementById("root").textContent = "Demo Notes"; })();\n' },
  ];
}

/** A `modular-v1` plan that references only what its own lock lists. */
const DEMO_MODULE_LOCK = encodeModuleLock({
  schema: "agent-module-lock/v1",
  modules: [{ id: "notes.list/v1", version: "1.0.0", implementation: "@demo/notes-view#NotesList" }],
});

const DEMO_COMPOSITION = encodeComposition({
  schema: "agent-composition/v1",
  app: DEMO_APP,
  instances: [{ instance: "notes", module: "notes.list/v1", slot: "primary" }],
  open: [],
});

/** A binding plan, used only to prove it is refused. */
const DEMO_BINDINGS = encodeResourceBindings({
  schema: "agent-resource-bindings/v1",
  app: DEMO_APP,
  bindings: [{ binding: "files", contract: "workspace-files/v1" }],
  connections: [{ instance: "notes", port: "workspace-files/v1", binding: "files" }],
});

const PROVENANCE: InstallProvenance = {
  kind: "external-attestation",
  builder: "demo:acme packer",
  statement: "built outside this platform and handed over as bytes",
  signatureVerification: "none",
};

type DemoShape = "legacy" | "modular-v1" | "modular-v2";

/**
 * One `demo-notes` release, described exactly the way an outside packer would.
 *
 * `describeRelease` recomputes every digest from the bytes, so nothing this
 * function claims is believed — which is why the builder half is allowed to be
 * this small.
 */
function demoBundle(options: {
  shape?: DemoShape;
  /** Override the declared permission contract, to prove it is checked. */
  permissionContractDigest?: string;
  publisher?: string;
  app?: string;
  /** Distinguishes two otherwise identical releases of the same App. */
  marker?: string;
  /** Explicitly opts this schema-2 fixture into multi-version coexistence. */
  stateEpoch?: number;
} = {}): ReleaseBundle {
  const shape = options.shape ?? "legacy";
  const app = options.app ?? DEMO_APP;
  const publisher = options.publisher ?? DEMO_PUBLISHER;
  const view = demoViewAssets();
  if (options.marker) {
    for (const asset of view) {
      if (asset.name === "view.js") asset.source = `${asset.source}\n/* ${options.marker} */`;
    }
  }
  if (shape !== "legacy") {
    view.push({ name: "view/module-lock.json", source: DEMO_MODULE_LOCK });
    view.push({ name: "view/composition.json", source: DEMO_COMPOSITION });
  }
  if (shape === "modular-v2") {
    view.push({ name: "view/resource-bindings.json", source: DEMO_BINDINGS });
  }
  const backend = DEMO_BACKEND.map((asset) => ({ ...asset }));
  if (options.stateEpoch !== undefined) {
    const manifest = backend.find((asset) => asset.name === "app/app.yaml");
    if (!manifest) throw new Error("demo manifest fixture is missing");
    manifest.source = manifest.source.replace(
      "schema: 1",
      `schema: 2\nstate_epoch: ${options.stateEpoch}`,
    );
  }
  const assets = [...view, ...backend];
  const descriptor: AppReleaseDescriptor = describeRelease({
    stableAppId: app,
    publisher,
    executionProfile: "publisher-js",
    permissionContractDigest: options.permissionContractDigest ?? emptyContractDigestFor(app, publisher),
    assets: assets.map((asset) => ({
      name: asset.name,
      content: new Uint8Array(Buffer.from(asset.source, "utf8")),
    })),
    composition: {
      view: view.map((asset) => asset.name),
      backend: backend.map((asset) => asset.name),
    },
    source: {
      // Not `platform-hosted`: this platform did not build these bytes, and
      // saying it did would be the one claim a descriptor must not make.
      kind: "vcs",
      digest: "d".repeat(64),
      repository: "https://example.invalid/acme/demo-notes",
      commit: `sha256:${"d".repeat(64)}`,
      // A snapshot of the whole tree: the empty string is the honest answer and
      // the descriptor validator refuses it spelled "." or "/".
      subdir: "",
    },
    buildInput: {
      entry: "app/app.yaml",
      toolchain: { builder: "demo:acme-packer-v1", format: "named-utf8-assets", lockfile: "pnpm-lock.yaml" },
      lockfileHash: "e".repeat(64),
    },
  });
  return {
    descriptor,
    assets: assets.map((asset) => ({
      name: asset.name,
      content: new Uint8Array(Buffer.from(asset.source, "utf8")),
    })),
    provenance: PROVENANCE,
  };
}

/** A runtime that records what happened, so no child process is spawned. */
class FakeRuntime implements RuntimeSwap<{ appDir: string; digest: string }> {
  prepared: Array<{ appDir: string; digest: string }> = [];
  committed: Array<{ appDir: string; digest: string }> = [];
  modes: RuntimeCommitMode[] = [];
  discarded: Array<{ appDir: string; digest: string }> = [];
  deactivated = 0;

  async prepareRuntime(appDir: string, digest: string): Promise<{ appDir: string; digest: string }> {
    const candidate = { appDir, digest };
    this.prepared.push(candidate);
    return candidate;
  }

  commitRuntime(candidate: { appDir: string; digest: string }, mode: RuntimeCommitMode): void {
    this.committed.push(candidate);
    this.modes.push(mode);
  }

  async discardRuntime(candidate: { appDir: string; digest: string }): Promise<void> {
    this.discarded.push(candidate);
  }

  deactivateRuntime(): void {
    this.deactivated += 1;
  }
}

// ── The fixture ─────────────────────────────────────────────────────────────

describe("an Agentic App that is nothing but data", () => {
  let dir: string;
  let store: Store;
  let registry: AppReleaseRegistry;
  let host: AppReleaseHost;
  let composer: DeclaredAppComposer;
  let hosting: DeclaredAppHosting;
  let settings: SessionPlusSettings;
  let sessionPlus: HostedApp<PreparedSessionPlusRelease, SessionPlusSettings>;

  const newComposer = (): DeclaredAppComposer =>
    new DeclaredAppComposer({
      store,
      registry,
      host,
      preparedRoot: appReleasePaths(dir).preparedRoot,
      hosting,
      // No backends: this test is about the catalog and the pointer, and two
      // child processes per declaration would prove nothing extra about either.
      backends: null,
      now: () => "2026-08-07T00:00:00.000Z",
    });

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "declared-app-"));
    store = new Store(path.join(dir, "bot.db"));
    const paths = appReleasePaths(dir);
    registry = new AppReleaseRegistry({
      catalog: new StoreReleaseCatalog(store),
      content: new FileReleaseContentStore(paths.contentRoot),
    });
    const resolved = resolveSessionPlus({
      config: { enabled: true, app_domain: "localhost", app_scheme: "http", app_public_port: 9821 },
      dashboardPort: 9820,
    });
    if (!resolved.enabled || !resolved.settings) throw new Error(`settings did not resolve: ${resolved.errors.join("; ")}`);
    settings = resolved.settings;
    const borrowed = declaredAppHostingFrom(settings);
    if (!borrowed.ok) throw new Error(borrowed.error);
    hosting = borrowed.hosting;

    // The compiled-in app, alongside the declared one, because "adding an App
    // does not disturb the App already being served" is half of the claim.
    sessionPlus = new HostedApp({
      registry,
      adapter: new SessionPlusReleaseAdapter({
        preparedRoot: paths.preparedRoot,
        resourceContracts: () => new Set(PANEL_RESOURCE_CONTRACTS),
        baseSettings: settings,
      }),
      runtime: new FakeRuntime(),
    });
    host = new AppReleaseHost({ registry, apps: [sessionPlus] });
    await host.start();
    composer = newComposer();
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("declares, installs and activates a second App, leaving the first one alone", async () => {
    const before = sessionPlus.active();
    expect(before).not.toBeNull();

    const declared = await composer.declare({
      stableAppId: DEMO_APP,
      publisher: DEMO_PUBLISHER,
      title: DEMO_TITLE,
      by: "user:lht",
    });
    expect(declared).toEqual({ ok: true, app: DEMO_APP, publisher: DEMO_PUBLISHER, title: DEMO_TITLE });

    // In the catalog immediately, with nothing served yet: declaring is not
    // installing, and installing is not activating.
    const app = host.app(DEMO_APP);
    expect(app).not.toBeNull();
    expect(host.ids()).toEqual(["session-plus", DEMO_APP]);
    expect(app!.publisher).toBe(DEMO_PUBLISHER);
    const empty = app!.describe();
    expect(empty.releases).toEqual([]);
    // No checkout to describe: this platform did not build these bytes. And
    // "nothing installed yet" rather than "a build failed" — the next step
    // belongs to an operator, so it must not read as a defect.
    expect(empty.checkout).toBeNull();
    expect(empty.unavailable?.code).toBe("not_installed");

    const runtime = new FakeRuntime();
    (composer.apps.find((row) => row.declaration.stableAppId === DEMO_APP)!.app).attachRuntime(runtime);

    const bundle = demoBundle();
    const installed = host.install(bundle, "user:lht");
    expect(installed).toMatchObject({ ok: true, app: DEMO_APP, deduplicated: false });
    // Installing changed nothing about what is served, for either app.
    expect(app!.describe().activePackageDigest).toBeNull();
    expect(sessionPlus.active()!.prepared.identity.packageDigest)
      .toBe(before!.prepared.identity.packageDigest);

    const activated = await app!.activate(bundle.descriptor.packageDigest, "user:lht");
    expect(activated.ok).toBe(true);

    const view = app!.describe();
    expect(view.activePackageDigest).toBe(bundle.descriptor.packageDigest);
    expect(view.activeViewOrigin)
      .toBe(`http://${packageHostLabel(bundle.descriptor.packageDigest)}.localhost:9821`);
    expect(view.unavailable).toBeNull();

    // The App Runtime was pointed at THIS release's materialised tree, and the
    // four declared files are the ones on disk.
    expect(runtime.committed).toHaveLength(1);
    const appDir = runtime.committed[0].appDir;
    for (const asset of DEMO_BACKEND) {
      const file = asset.name.replace(/^app\//, "");
      expect(readFileSync(path.join(appDir, file), "utf8")).toBe(asset.source);
    }

    // And Session Plus is byte-for-byte where it was: two apps share the
    // registry and nothing else.
    expect(sessionPlus.active()!.prepared.identity.packageDigest)
      .toBe(before!.prepared.identity.packageDigest);
    expect(sessionPlus.unavailable()).toBeNull();
  });

  it("defaults undeclared state_epoch releases to refresh_required", async () => {
    await composer.declare({
      stableAppId: DEMO_APP,
      publisher: DEMO_PUBLISHER,
      title: DEMO_TITLE,
      by: "user:lht",
    });
    const app = composer.apps.find((row) => row.declaration.stableAppId === DEMO_APP)!.app;
    const runtime = new FakeRuntime();
    app.attachRuntime(runtime);
    const first = demoBundle({ marker: "coexist-first" });
    const second = demoBundle({ marker: "coexist-second" });
    expect(host.install(first, "user:lht").ok).toBe(true);
    expect(host.install(second, "user:lht").ok).toBe(true);
    await app.activate(first.descriptor.packageDigest, "user:lht");

    const moved = await app.activate(second.descriptor.packageDigest, "user:lht");
    expect(moved).toMatchObject({
      ok: true,
      changed: true,
      coexistence: "refresh_required",
      reason: "state_epoch_undeclared",
    });
    expect(runtime.modes).toEqual(["swap", "swap"]);
    expect(app.servableRelease(first.descriptor.packageDigest)).toBeNull();
  });

  it("keeps explicitly declared same-epoch releases in multi-version mode", async () => {
    await composer.declare({
      stableAppId: DEMO_APP,
      publisher: DEMO_PUBLISHER,
      title: DEMO_TITLE,
      by: "user:lht",
    });
    const app = composer.apps.find((row) => row.declaration.stableAppId === DEMO_APP)!.app;
    const runtime = new FakeRuntime();
    app.attachRuntime(runtime);
    const first = demoBundle({ marker: "explicit-first", stateEpoch: 0 });
    const second = demoBundle({ marker: "explicit-second", stateEpoch: 0 });
    expect(host.install(first, "user:lht").ok).toBe(true);
    expect(host.install(second, "user:lht").ok).toBe(true);
    await app.activate(first.descriptor.packageDigest, "user:lht");

    const moved = await app.activate(second.descriptor.packageDigest, "user:lht");
    expect(moved).toMatchObject({
      ok: true,
      changed: true,
      coexistence: "multi_version",
      reason: null,
    });
    expect(runtime.modes).toEqual(["swap", "retain"]);
    expect(app.servableRelease(first.descriptor.packageDigest)).not.toBeNull();
  });

  it("forwards only changed HostedApp transitions to its instance coordinator", async () => {
    const wiredHost = new AppReleaseHost({ registry, apps: [] });
    const runtime = new FakeRuntime();
    const supervisor = Object.assign(runtime, {
      state: {},
      runtime: {},
      status: { state: "ready", runtime: "stopped" },
      start: async () => {},
    });
    const wired = new DeclaredAppComposer({
      store,
      registry,
      host: wiredHost,
      preparedRoot: appReleasePaths(dir).preparedRoot,
      hosting,
      backends: { assertCanRegister: () => {}, register: () => supervisor } as never,
    });
    await wired.declare({
      stableAppId: DEMO_APP,
      publisher: DEMO_PUBLISHER,
      title: DEMO_TITLE,
      by: "user:lht",
    });
    const record = wired.apps[0]!;
    if (!record.service) throw new Error("fixture did not compose an instance service");
    const marked = vi.spyOn(record.service, "markReleaseAvailable");
    const first = demoBundle({ marker: "notify-first" });
    const second = demoBundle({ marker: "notify-second" });
    expect(wiredHost.install(first, "user:lht").ok).toBe(true);
    expect(wiredHost.install(second, "user:lht").ok).toBe(true);

    await record.app.activate(first.descriptor.packageDigest, "user:lht");
    marked.mockClear();
    await record.app.activate(first.descriptor.packageDigest, "user:lht");
    expect(marked).not.toHaveBeenCalled();

    await record.app.activate(second.descriptor.packageDigest, "user:lht");
    expect(marked).toHaveBeenCalledOnce();
    expect(marked).toHaveBeenCalledWith({
      availableDigest: second.descriptor.packageDigest,
      mode: "refresh_required",
    });
    wired.stop();
  });

  it("records an over-capacity declaration without half-composing it", async () => {
    const boundedHost = new AppReleaseHost({ registry, apps: [] });
    const register = vi.fn();
    const bounded = new DeclaredAppComposer({
      store,
      registry,
      host: boundedHost,
      preparedRoot: appReleasePaths(dir).preparedRoot,
      hosting,
      backends: {
        assertCanRegister: () => { throw new AppBackendCapacityExceeded(1); },
        register,
      } as never,
    });

    const result = await bounded.declare({
      stableAppId: DEMO_APP,
      publisher: DEMO_PUBLISHER,
      title: DEMO_TITLE,
      by: "user:lht",
    });
    expect(result).toMatchObject({ ok: false, code: "compose_failed" });
    expect(result.ok ? "" : result.message).toContain("承载已满");
    expect(store.appCatalog.getAppDeclaration(DEMO_APP)).toMatchObject({ enabled: 1 });
    expect(boundedHost.ids()).toEqual([]);
    expect(register).not.toHaveBeenCalled();
  });

  it("composes declarations that were already in the table when the process started", async () => {
    // No `declare()` call: the row is what a previous process left behind.
    expect(
      store.appCatalog.insertAppDeclaration({
        app_id: DEMO_APP,
        publisher: DEMO_PUBLISHER,
        title: DEMO_TITLE,
        enabled: 1,
        declared_by: "user:lht",
        declared_at: "2026-08-07T00:00:00.000Z",
      }),
    ).toBe(true);

    const composed = await newComposer().loadAll();
    expect(composed.map((row) => row.declaration.stableAppId)).toEqual([DEMO_APP]);
    const app = host.app(DEMO_APP);
    expect(app).not.toBeNull();

    const bundle = demoBundle({ marker: "startup" });
    expect(host.install(bundle, "system:test").ok).toBe(true);
    const activated = await app!.activate(bundle.descriptor.packageDigest, "system:test");
    expect(activated.ok).toBe(true);
    expect(app!.describe().activePackageDigest).toBe(bundle.descriptor.packageDigest);

    // A disabled row is reported and skipped rather than composed — and the id
    // stays free of a half-built app.
    expect(store.appCatalog.setAppDeclarationEnabled(DEMO_APP, false)).toBe(true);
    const second = new AppReleaseHost({ registry, apps: [] });
    const rebuilt = await new DeclaredAppComposer({
      store,
      registry,
      host: second,
      preparedRoot: appReleasePaths(dir).preparedRoot,
      hosting,
      backends: null,
    }).loadAll();
    expect(rebuilt).toEqual([]);
    expect(second.ids()).toEqual([]);
  });

  it("accepts a module plan validated only against itself", async () => {
    await composer.declare({ stableAppId: DEMO_APP, publisher: DEMO_PUBLISHER, title: DEMO_TITLE, by: "user:lht" });
    const app = host.app(DEMO_APP)!;
    // This build compiles no manifests for `demo-notes`; the plan is checked for
    // canonical bytes, internal reference resolution and app identity, which is
    // exactly what makes a foreign App's plan validatable at all.
    const bundle = demoBundle({ shape: "modular-v1" });
    expect(host.install(bundle, "user:lht").ok).toBe(true);
    const activated = await app.activate(bundle.descriptor.packageDigest, "user:lht");
    expect(activated.ok).toBe(true);

    // A plan whose composition claims another app is refused, even though its
    // bytes are perfectly canonical.
    const foreign = demoBundle({ shape: "modular-v1", app: "other-notes" });
    expect(host.install(foreign, "user:lht")).toMatchObject({ ok: false });
  });

  it("refuses a release that binds user resources", async () => {
    await composer.declare({ stableAppId: DEMO_APP, publisher: DEMO_PUBLISHER, title: DEMO_TITLE, by: "user:lht" });
    const app = host.app(DEMO_APP)!;
    const bundle = demoBundle({ shape: "modular-v2" });
    // Installing is allowed — the registry records bytes; whether this build can
    // RUN them is the adapter's answer, and the page shows it as unsupported.
    expect(host.install(bundle, "user:lht").ok).toBe(true);
    const row = app.describe().releases.find((r) => r.packageDigest === bundle.descriptor.packageDigest);
    expect(row?.supported).toBe(false);
    expect(row?.unsupportedCode).toBe("resource_bindings_not_allowed");

    const activated = await app.activate(bundle.descriptor.packageDigest, "user:lht");
    expect(activated.ok).toBe(false);
    if (activated.ok) throw new Error("unreachable");
    expect(activated.failure.code).toBe("resource_bindings_not_allowed");
    expect(activated.failure.message).toContain("资源型 App");
    expect(app.describe().activePackageDigest).toBeNull();
  });

  it("refuses a release whose permission contract is not the empty one", async () => {
    await composer.declare({ stableAppId: DEMO_APP, publisher: DEMO_PUBLISHER, title: DEMO_TITLE, by: "user:lht" });
    const app = host.app(DEMO_APP)!;
    const wide = demoBundle({
      permissionContractDigest: contractDigestOf({
        app: DEMO_APP,
        publisher: DEMO_PUBLISHER,
        operations: ["read_session"],
        autoAllow: [],
        actions: {},
        agents: {},
        delivery: [],
      }),
    });
    expect(host.install(wide, "user:lht").ok).toBe(true);
    const activated = await app.activate(wide.descriptor.packageDigest, "user:lht");
    expect(activated.ok).toBe(false);
    if (activated.ok) throw new Error("unreachable");
    expect(activated.failure.code).toBe("unknown_permission_contract");

    // The empty ask is per (app, publisher) because the engine puts both inside
    // the digest — so one App's "asks for nothing" is not another's.
    expect(emptyContractDigestFor(DEMO_APP, DEMO_PUBLISHER))
      .not.toBe(emptyContractDigestFor("other-notes", DEMO_PUBLISHER));
    expect(emptyContractDigestFor(DEMO_APP, DEMO_PUBLISHER))
      .not.toBe(emptyContractDigestFor(DEMO_APP, "demo:other"));
  });

  it("refuses a duplicate id, whichever direction it collides from", async () => {
    expect((await composer.declare({
      stableAppId: DEMO_APP,
      publisher: DEMO_PUBLISHER,
      title: DEMO_TITLE,
      by: "user:lht",
    })).ok).toBe(true);

    // A second declaration of the same id — including one that would silently
    // rename the publisher who vouches for the code.
    const again = await composer.declare({
      stableAppId: DEMO_APP,
      publisher: "demo:someone-else",
      title: "Impostor",
      by: "user:lht",
    });
    expect(again).toMatchObject({ ok: false, code: "app_exists" });

    // And an id a compiled-in app already owns. The catalog is asked, not just
    // the table, because Session Plus was never declared.
    const collides = await composer.declare({
      stableAppId: "session-plus",
      publisher: DEMO_PUBLISHER,
      title: "Not Session Plus",
      by: "user:lht",
    });
    expect(collides).toMatchObject({ ok: false, code: "app_exists" });
    expect(store.appCatalog.getAppDeclaration("session-plus")).toBeUndefined();

    // Grammar failures are refused before anything is written.
    for (const bad of [
      { stableAppId: "Demo-Notes", publisher: DEMO_PUBLISHER, title: "x" },
      { stableAppId: "demo notes", publisher: DEMO_PUBLISHER, title: "x" },
      { stableAppId: "../escape", publisher: DEMO_PUBLISHER, title: "x" },
      { stableAppId: "fine", publisher: "NOT OK", title: "x" },
      { stableAppId: "fine", publisher: DEMO_PUBLISHER, title: "   " },
    ]) {
      expect(await composer.declare({ ...bad, by: "user:lht" })).toMatchObject({ ok: false, code: "invalid" });
    }
    expect(store.appCatalog.listAppDeclarations().map((row) => row.app_id)).toEqual([DEMO_APP]);
  });

  it("has no checkout to seed from, and says so instead of inventing one", () => {
    const adapter = new DeclaredAppAdapter({
      declaration: { stableAppId: DEMO_APP, publisher: DEMO_PUBLISHER, title: DEMO_TITLE },
      preparedRoot: appReleasePaths(dir).preparedRoot,
      hosting,
    });
    expect(() => adapter.checkoutBundle()).toThrow(/没有 checkout/);
    // The compiled-in app does have one, which is the difference this platform
    // is drawing: one App's bytes come from this tree, the other's arrive.
    expect(buildCheckoutBundle().descriptor.stableAppId).toBe("session-plus");
  });

  it("refuses to host declared Apps under a pinned App origin", () => {
    const pinned = resolveSessionPlus({
      config: {
        enabled: true,
        view_origin: `http://${settings.identity.packageHostLabel}.localhost:9821`,
      },
      dashboardPort: 9820,
    });
    if (!pinned.enabled || !pinned.settings) throw new Error(`pinned settings did not resolve: ${pinned.errors.join("; ")}`);
    const outcome = declaredAppHostingFrom(pinned.settings);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error).toContain("app_domain");
  });
});
