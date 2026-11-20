/**
 * The transition, not the pieces.
 *
 * Every test here is about the ORDER an activation happens in, because that
 * order is the safety property: a candidate that fails at any step above the
 * pointer move must leave a working deployment byte-identical to what it was.
 * The registry's own suite already proves install/activate/reconcile in
 * isolation; this one proves that the thing wired into production cannot end up
 * half-switched.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AppReleaseRegistry,
  FileReleaseContentStore,
  packageHostLabel,
  type AppReleaseDescriptor,
  type InstallProvenance,
} from "@claude-bot/app-registry";
import { Store } from "../store/store.js";
import { StoreReleaseCatalog } from "./store-catalog.js";
import { appReleasePaths } from "./paths.js";
import { SessionPlusReleaseAdapter, type PreparedSessionPlusRelease } from "./session-plus-adapter.js";
import { AppReleaseHost, HostedApp, type RuntimeSwap } from "./release-host.js";
import type { RuntimeCommitMode } from "./hosted-app.js";
import type { AppReleaseAdapter } from "./adapter.js";
import {
  buildCheckoutBundle,
  bundleToWire,
  checkoutPlanProblem,
  DEFAULT_BUNDLE_LIMITS,
  parseBundle,
  type ReleaseBundle,
} from "./session-plus-package.js";
import {
  SESSION_PLUS_PUBLISHER,
  permissionContractDigest,
  sessionPlusDescriptor,
  sessionPlusReleasePackage,
} from "../app-core/identity.js";
import {
  SESSION_PLUS_PERMISSION_CONTRACT,
  SESSION_PLUS_SELF_SERVICE_PERMISSION_CONTRACT,
  SESSION_PLUS_FILE_DOWNLOAD_PERMISSION_CONTRACT,
  SESSION_PLUS_OWNER_FILES_WRITE_PERMISSION_CONTRACT,
  SESSION_PLUS_WORKSPACE_PERMISSION_CONTRACT,
  SESSION_PLUS_WORKSPACE_WRITE_CRDT_PERMISSION_CONTRACT,
  SESSION_PLUS_WORKSPACE_WRITE_NOTIFY_PERMISSION_CONTRACT,
  SESSION_PLUS_WORKSPACE_WRITE_PERMISSION_CONTRACT,
  type SessionPlusPermissionContract,
} from "../session-resource/contract.js";
import { PANEL_RESOURCE_CONTRACTS } from "../dashboard/server.js";
import {
  WORKSPACE_FILES_CONTRACT,
  WORKSPACE_FILES_CONTRACT_V2,
  WORKSPACE_FILES_CONTRACT_V4,
} from "@claude-bot/workspace-files-contract";
import { CRDT_DOC_CONTRACT, CRDT_DOC_CONTRACT_V2 } from "@claude-bot/crdt-doc-contract";
import { NOTIFY_CONTRACT } from "@claude-bot/notify-contract";
import { resolveSessionPlus, type SessionPlusSettings } from "../app-core/settings.js";
import { VIEW_APP_HTML, viewPackage, type AppPackage } from "../app-core/view-app.js";
import { PERMISSIONS_ASSET } from "@claude-bot/session-plus-view/plan";
import { MODULE_ENTRY_ASSET, moduleAssetName, readAppModuleEntry } from "@claude-bot/agent-view-build/module-assets";
import {
  RESOURCE_BINDINGS_SCHEMA_V2,
  encodeComposition,
  encodeModuleLock,
  encodeResourceBindings,
  parseComposition,
  parseModuleLock,
  parseResourceBindings,
  planTemplates,
  type AgentComposition,
  type AgentModuleLock,
  type ResourceBindingPlan,
} from "@claude-bot/agent-module-contract";

/**
 * Edit the real composition and re-encode it canonically.
 *
 * Canonical bytes matter: the adapter refuses a non-canonical document on its
 * own, so a hand-written variant would be refused for the WRONG reason and the
 * test would pass without exercising the check it names.
 */
function editedComposition(edit: (composition: AgentComposition) => AgentComposition): ReleaseBundle {
  return rewrittenCompositionBundle((source) => {
    const read = parseComposition(source);
    if (!read.ok) throw new Error("the checkout's own composition does not parse");
    return encodeComposition(edit(read.value));
  });
}

/** The same, for the binding plan — either schema. */
function editedBindings(edit: (plan: ResourceBindingPlan) => ResourceBindingPlan): ReleaseBundle {
  return rewrittenBindingsBundle((source) => {
    const read = parseResourceBindings(source);
    if (!read.ok) throw new Error("the checkout's own binding plan does not parse");
    return encodeResourceBindings(edit(read.value));
  });
}

/**
 * The same plan, restated as `agent-resource-bindings/v2` with templates.
 *
 * Written once because both the pack path and the install path ask about the
 * same document, and a second hand-built v2 fixture could drift into a shape
 * neither of them would ever see.
 */
function asV2(plan: ResourceBindingPlan, templates: Array<{ instance: string; maxInstances: number }>): ResourceBindingPlan {
  return {
    schema: RESOURCE_BINDINGS_SCHEMA_V2,
    app: plan.app,
    bindings: plan.bindings,
    connections: plan.connections,
    templates,
  };
}

/** The same connection graph restated as the historical v1 schema. */
function asV1(plan: ResourceBindingPlan): ResourceBindingPlan {
  return {
    schema: "agent-resource-bindings/v1",
    app: plan.app,
    bindings: plan.bindings,
    connections: plan.connections,
  };
}

/** The same, for the exact implementation inventory. */
function editedModuleLock(edit: (lock: AgentModuleLock) => AgentModuleLock): ReleaseBundle {
  const full = sessionPlusReleasePackage();
  const pkg = {
    assets: full.assets.map((asset) => {
      if (asset.name !== "view/module-lock.json") return asset;
      const read = parseModuleLock(asset.source);
      if (!read.ok) throw new Error("the checkout's own module lock does not parse");
      return { ...asset, source: encodeModuleLock(edit(read.value)) };
    }),
  };
  const descriptor = sessionPlusDescriptor({ pkg, lockfileHash: "9".repeat(64) });
  return {
    descriptor,
    assets: pkg.assets.map((asset) => ({
      name: asset.name,
      content: new Uint8Array(Buffer.from(asset.source, "utf8")),
    })),
    provenance: PROVENANCE,
  };
}

/** The `app_domain` deployment shape every fixture here is served under. */
function localSettings(): SessionPlusSettings {
  const resolved = resolveSessionPlus({
    config: { enabled: true, app_domain: "localhost", app_scheme: "http", app_public_port: 9821 },
    dashboardPort: 9820,
  });
  if (!resolved.enabled || !resolved.settings) throw new Error(`settings did not resolve: ${resolved.errors.join("; ")}`);
  return resolved.settings;
}

const PROVENANCE: InstallProvenance = {
  kind: "platform-built",
  builder: "test",
  statement: "built in a test",
  signatureVerification: "none",
};

/** A release built from the real checkout with one View byte changed. */
function variantBundle(marker: string): ReleaseBundle {
  const view = viewPackage();
  const pkg = sessionPlusReleasePackage(
    {
      assets: view.assets.map((asset) =>
        asset.name === "view.js" ? { ...asset, source: `${asset.source}\n/* ${marker} */` } : asset),
    },
  );
  const descriptor = sessionPlusDescriptor({ pkg, lockfileHash: "1".repeat(64) });
  return {
    descriptor,
    assets: pkg.assets.map((asset) => ({
      name: asset.name,
      content: new Uint8Array(Buffer.from(asset.source, "utf8")),
    })),
    provenance: PROVENANCE,
  };
}

const HISTORICAL_PLAN_ASSETS = ["view/module-lock.json", "view/composition.json", "view/resource-bindings.json", PERMISSIONS_ASSET];

/**
 * Keep actual backend/plan bytes, but supply the browser format these historical
 * releases used: one classic script, one stylesheet and the document template.
 * A current ESM entry without its import map is not a functioning legacy View.
 */
function historicalPackage(): AppPackage {
  const full = sessionPlusReleasePackage();
  return { assets: [
    ...full.assets.filter((asset) => asset.name.startsWith("app/") || HISTORICAL_PLAN_ASSETS.includes(asset.name)),
    { name: "view.html", source: VIEW_APP_HTML },
    { name: "view.css", source: "body { font: 16px sans-serif; }\n" },
    { name: "view.js", source: '(() => { document.getElementById("root").textContent = "Legacy Session Plus"; })();\n' },
  ] };
}

/** Original seven-asset rollback target: four backend assets and three View assets. */
function legacyBundle(): ReleaseBundle {
  const full = historicalPackage();
  const pkg = { assets: full.assets.filter((asset) => !asset.name.startsWith("view/")) };
  return bundleOf(pkg, "3".repeat(64));
}

/** A modular release whose composition names a module the lock does not list. */
function brokenPlanBundle(): ReleaseBundle {
  const full = sessionPlusReleasePackage();
  const pkg = {
    assets: full.assets.map((asset) =>
      asset.name === "view/composition.json"
        ? {
            ...asset,
            source: JSON.stringify(
              {
                schema: "agent-composition/v1",
                app: "session-plus",
                instances: [{ instance: "ghost", module: "workspace.files/v1", slot: "secondary" }],
                open: [],
              },
              null,
              2,
            ) + "\n",
          }
        : asset),
  };
  const descriptor = sessionPlusDescriptor({ pkg, lockfileHash: "4".repeat(64) });
  return {
    descriptor,
    assets: pkg.assets.map((asset) => ({
      name: asset.name,
      content: new Uint8Array(Buffer.from(asset.source, "utf8")),
    })),
    provenance: PROVENANCE,
  };
}

/** A real modular package with only the composition asset rewritten. */
function rewrittenCompositionBundle(rewrite: (source: string) => string): ReleaseBundle {
  const full = sessionPlusReleasePackage();
  const pkg = {
    assets: full.assets.map((asset) =>
      asset.name === "view/composition.json" ? { ...asset, source: rewrite(asset.source) } : asset),
  };
  const descriptor = sessionPlusDescriptor({ pkg, lockfileHash: "5".repeat(64) });
  return {
    descriptor,
    assets: pkg.assets.map((asset) => ({
      name: asset.name,
      content: new Uint8Array(Buffer.from(asset.source, "utf8")),
    })),
    provenance: PROVENANCE,
  };
}

/**
 * A nine-asset `modular-v1` release: modules and a composition, no binding plan
 * and no permission declaration.
 *
 * The historical browser assets plus the real canonical module plan. Its
 * descriptor declares the SIX-token contract because that is what its shape declares.
 */
function modularV1Bundle(): ReleaseBundle {
  const pkg = withoutAssets(["view/resource-bindings.json", PERMISSIONS_ASSET]);
  return bundleOf(pkg, "6".repeat(64));
}

/**
 * A ten-asset `modular-v2` release: a binding plan, but no permission
 * declaration of its own.
 *
 * The rollback target that matters most for the write release, because it is the
 * one people are actually running: it asks for the EIGHT read-only tokens, which
 * is the ask their existing consent covers. Rolling back to it therefore has to
 * keep working without anybody re-consenting to anything.
 */
function modularV2Bundle(
  workspaceContract: typeof WORKSPACE_FILES_CONTRACT | typeof WORKSPACE_FILES_CONTRACT_V2 =
    WORKSPACE_FILES_CONTRACT_V2,
): ReleaseBundle {
  // A HISTORICAL release, not merely the checkout minus one asset: a
  // modular-v2-era plan never declared the document binding — its eight-token
  // ask cannot honour one. It also predates v3 media reads, so the fixture
  // restates the workspace edge against v2 (or v1 for rollback tests).
  const full = historicalPackage();
  const pkg: AppPackage = {
    assets: full.assets
      .filter((asset) => asset.name !== PERMISSIONS_ASSET)
      .map((asset) => {
        if (asset.name !== "view/resource-bindings.json") return asset;
        const read = parseResourceBindings(asset.source);
        if (!read.ok) throw new Error("the checkout's own binding plan does not parse");
        return {
          ...asset,
          source: encodeResourceBindings({
            ...read.value,
            bindings: read.value.bindings
              .filter((row) => row.contract !== CRDT_DOC_CONTRACT && row.contract !== CRDT_DOC_CONTRACT_V2)
              .map((row) => row.contract === WORKSPACE_FILES_CONTRACT_V4
                ? { ...row, contract: workspaceContract }
                : row),
            connections: read.value.connections
              .filter((row) => row.port !== CRDT_DOC_CONTRACT && row.port !== CRDT_DOC_CONTRACT_V2)
              .map((row) => row.port === WORKSPACE_FILES_CONTRACT_V4
                ? { ...row, port: workspaceContract }
                : row),
          } as ResourceBindingPlan),
        };
      }),
  };
  return bundleOf(pkg, "a".repeat(64));
}

function withoutAssets(names: readonly string[]): AppPackage {
  const full = historicalPackage();
  return { assets: full.assets.filter((asset) => !names.includes(asset.name)) };
}

function bundleOf(pkg: AppPackage, lockfileHash: string): ReleaseBundle {
  const descriptor = sessionPlusDescriptor({ pkg, lockfileHash });
  return {
    descriptor,
    assets: pkg.assets.map((asset) => ({
      name: asset.name,
      content: new Uint8Array(Buffer.from(asset.source, "utf8")),
    })),
    provenance: PROVENANCE,
  };
}

/** A real `modular-v3` package with only the permission declaration rewritten. */
function rewrittenPermissionsBundle(rewrite: (source: string) => string): ReleaseBundle {
  const full = sessionPlusReleasePackage();
  const pkg = {
    assets: full.assets.map((asset) =>
      asset.name === PERMISSIONS_ASSET ? { ...asset, source: rewrite(asset.source) } : asset),
  };
  // The declared contract is pinned explicitly: the builder derives the ask FROM
  // this document, so a test that rewrote it and let the derivation follow would
  // produce a self-consistent package and prove nothing. Pinning the write
  // contract is what a hand-built artifact looks like — a descriptor that claims
  // one thing while its own declaration says another.
  const descriptor = sessionPlusDescriptor({
    pkg,
    lockfileHash: "b".repeat(64),
    contract: SESSION_PLUS_WORKSPACE_WRITE_PERMISSION_CONTRACT,
  });
  return {
    descriptor,
    assets: pkg.assets.map((asset) => ({
      name: asset.name,
      content: new Uint8Array(Buffer.from(asset.source, "utf8")),
    })),
    provenance: PROVENANCE,
  };
}

/** Each crossed fixture's build input, so no two of them are one package. */
const CROSSED_LOCKFILE_HASH = {
  "legacy-wide": "7".repeat(64),
  "modular-v2-narrow": "c".repeat(64),
  "modular-v2-write": "d".repeat(64),
  "modular-v3-narrow": "e".repeat(64),
} as const;

type CrossedKind = keyof typeof CROSSED_LOCKFILE_HASH;

/**
 * A package whose SHAPE and declared permission contract disagree.
 *
 * Each kind gets its OWN build input, and that is not cosmetic: the permission
 * contract digest is a separate axis from the package digest, so two of these
 * fixtures — same assets, different ask — would otherwise be one package digest
 * making two claims, and the registry (correctly) refuses that as a conflict
 * rather than installing a second row. The property under test here is the
 * adapter's, so the fixtures must reach it.
 */
function crossedShapeBundle(kind: CrossedKind): ReleaseBundle {
  const full = sessionPlusReleasePackage();
  const pkg = kind === "legacy-wide"
    ? { assets: full.assets.filter((asset) => !asset.name.startsWith("view/")) }
    : kind === "modular-v3-narrow"
      ? full
      : withoutAssets([PERMISSIONS_ASSET]);
  const contract = kind === "legacy-wide"
    ? SESSION_PLUS_WORKSPACE_PERMISSION_CONTRACT
    : kind === "modular-v2-write"
      ? SESSION_PLUS_WORKSPACE_WRITE_PERMISSION_CONTRACT
      : SESSION_PLUS_PERMISSION_CONTRACT;
  const descriptor = sessionPlusDescriptor({ pkg, lockfileHash: CROSSED_LOCKFILE_HASH[kind], contract });
  return {
    descriptor,
    assets: pkg.assets.map((asset) => ({
      name: asset.name,
      content: new Uint8Array(Buffer.from(asset.source, "utf8")),
    })),
    provenance: PROVENANCE,
  };
}

/** A real modular-v2 package with only the binding plan rewritten. */
function rewrittenBindingsBundle(rewrite: (source: string) => string): ReleaseBundle {
  const full = sessionPlusReleasePackage();
  const pkg = {
    assets: full.assets.map((asset) =>
      asset.name === "view/resource-bindings.json" ? { ...asset, source: rewrite(asset.source) } : asset),
  };
  const descriptor = sessionPlusDescriptor({ pkg, lockfileHash: "8".repeat(64) });
  return {
    descriptor,
    assets: pkg.assets.map((asset) => ({
      name: asset.name,
      content: new Uint8Array(Buffer.from(asset.source, "utf8")),
    })),
    provenance: PROVENANCE,
  };
}

/** A release whose permission contract this build does not implement. */
/**
 * A real `modular-v2` package that declares a contract this build IMPLEMENTS but
 * no shape may declare.
 *
 * The distinction the accompanying test is about: `sessionPlusContractFor` will
 * resolve these digests, `IntentGrantResolver` will honour a grant stamped with
 * one, and the grant seams have working code behind them — none of which makes a
 * release allowed to ship with one.
 */
function undeclarableContractBundle(
  contract: SessionPlusPermissionContract,
  lockfileHash: string,
): ReleaseBundle {
  const pkg = sessionPlusReleasePackage();
  // The lockfile hash has to differ per candidate, and that is itself the
  // registry working: `permissionContractDigest` is the OTHER axis and is not
  // covered by `packageDigest`, so two bundles alike in everything but their
  // declared contract are two different facts recorded under one identity —
  // which the registry refuses as a conflict rather than silently keeping one.
  const descriptor = sessionPlusDescriptor({ pkg, lockfileHash, contract });
  return {
    descriptor,
    assets: pkg.assets.map((asset) => ({
      name: asset.name,
      content: new Uint8Array(Buffer.from(asset.source, "utf8")),
    })),
    provenance: PROVENANCE,
  };
}

function foreignContractBundle(): ReleaseBundle {
  const pkg = sessionPlusReleasePackage();
  const descriptor = sessionPlusDescriptor({
    pkg,
    lockfileHash: "2".repeat(64),
    contract: { operations: ["list_recent_sessions", "exec_anything"], autoAllow: [], deliveries: [] },
  });
  return {
    descriptor,
    assets: pkg.assets.map((asset) => ({
      name: asset.name,
      content: new Uint8Array(Buffer.from(asset.source, "utf8")),
    })),
    provenance: PROVENANCE,
  };
}

/** A runtime that records what happened and can be told to fail its health check. */
class FakeRuntime implements RuntimeSwap<{ appDir: string; digest: string }> {
  prepared: Array<{ appDir: string; digest: string }> = [];
  committed: Array<{ appDir: string; digest: string }> = [];
  modes: RuntimeCommitMode[] = [];
  discarded: Array<{ appDir: string; digest: string }> = [];
  deactivated = 0;
  failNext = false;

  async prepareRuntime(appDir: string, digest: string): Promise<{ appDir: string; digest: string }> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("candidate App Runtime reported an unhealthy state");
    }
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

/**
 * The transition semantics, which live in `HostedApp` — one instance per app.
 *
 * This block was written against `AppReleaseHost` when that class WAS one app.
 * The generalisation moved the machinery to `HostedApp` and left the catalog
 * behind; every assertion below is byte-for-byte the same question it always
 * asked, which is the point — a refactor that changed what "roll back" means
 * would be a different change.
 */
describe("HostedApp", () => {
  let dir: string;
  let store: Store;
  let host: HostedApp<PreparedSessionPlusRelease, SessionPlusSettings>;
  let runtime: FakeRuntime;
  let settings: SessionPlusSettings;

  const build = (base: SessionPlusSettings = settings): HostedApp<PreparedSessionPlusRelease, SessionPlusSettings> => {
    const paths = appReleasePaths(dir);
    return new HostedApp({
      registry: new AppReleaseRegistry({
        catalog: new StoreReleaseCatalog(store),
        content: new FileReleaseContentStore(paths.contentRoot),
      }),
      adapter: new SessionPlusReleaseAdapter({
        preparedRoot: paths.preparedRoot,
        resourceContracts: () => new Set(contracts),
        baseSettings: base,
      }),
      runtime,
    });
  };

  /** What the panel this composition would build installs. Overridable per test. */
  let contracts: readonly string[] = PANEL_RESOURCE_CONTRACTS;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "release-host-"));
    store = new Store(path.join(dir, "bot.db"));
    runtime = new FakeRuntime();
    contracts = PANEL_RESOURCE_CONTRACTS;
    settings = localSettings();
    host = build();
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("seeds this checkout on an empty registry, and does not re-seed once a pointer exists", async () => {
    const active = await host.start();
    expect(active).not.toBeNull();
    const checkout = buildCheckoutBundle().descriptor.packageDigest;
    expect(active!.prepared.identity.packageDigest).toBe(checkout);
    expect(active!.activatedBy).toBe("system:bootstrap");
    expect(runtime.committed).toHaveLength(1);

    // Somebody activates a different release …
    const other = variantBundle("second");
    expect(host.install(other, "user:lht").ok).toBe(true);
    const moved = await host.activate(other.descriptor.packageDigest, "user:lht");
    expect(moved.ok).toBe(true);

    // … and a RESTART of the trusted code respects it. This is the property the
    // second half of this work depends on: deploying new bot code must not
    // silently republish the App from whatever the checkout happens to contain.
    const restarted = build();
    const adopted = await restarted.start();
    expect(adopted!.prepared.identity.packageDigest).toBe(other.descriptor.packageDigest);
    expect(adopted!.activatedBy).toBe("user:lht");
  });

  it("installs without changing what is served", async () => {
    await host.start();
    const before = host.active()!.prepared.identity.packageDigest;
    const other = variantBundle("installed-only");
    expect(host.install(other, "user:lht")).toMatchObject({ ok: true, deduplicated: false });
    expect(host.active()!.prepared.identity.packageDigest).toBe(before);
    // Reinstalling the exact same artifact is idempotent, not a second release.
    expect(host.install(other, "user:lht")).toMatchObject({ ok: true, deduplicated: true });
  });

  it("moves the origin and fail-safes Session Plus to refresh_required", async () => {
    await host.start();
    const first = host.active()!;
    const other = variantBundle("origin");
    host.install(other, "user:lht");
    const moved = await host.activate(other.descriptor.packageDigest, "user:lht");
    expect(moved).toMatchObject({
      ok: true,
      coexistence: "refresh_required",
      reason: "adapter_does_not_support_coexistence",
    });
    const second = host.active()!;
    expect(second.settings.viewOrigin).not.toBe(first.settings.viewOrigin);
    expect(second.settings.viewOrigin).toContain(packageHostLabel(other.descriptor.packageDigest));
    expect(runtime.modes.at(-1)).toBe("swap");
    expect(host.servableRelease(first.prepared.identity.packageDigest)).toBeNull();
    // Static release documents remain immutable and published, so an already
    // loaded iframe is not destroyed or rewritten. Its next stateful submit is
    // stale because the built-in Session Plus adapter does not opt into P2.
    expect(host.publishedLabels()).toEqual(
      new Set([first.prepared.identity.packageHostLabel, second.prepared.identity.packageHostLabel]),
    );
  });

  it("refuses a candidate whose permission contract this build does not implement", async () => {
    await host.start();
    const before = host.active()!;
    const foreign = foreignContractBundle();
    expect(host.install(foreign, "user:lht").ok).toBe(true);
    const outcome = await host.activate(foreign.descriptor.packageDigest, "user:lht");
    expect(outcome).toMatchObject({ ok: false, failure: { code: "unknown_permission_contract" } });
    // Nothing moved: same release, same origin, no runtime swap.
    expect(host.active()!.prepared.identity.packageDigest).toBe(before.prepared.identity.packageDigest);
    expect(runtime.committed).toHaveLength(1);
    // A widened contract is visible in the listing as installed-but-unsupported
    // rather than being silently absent.
    const row = host.list().find((entry) => entry.release.descriptor.packageDigest === foreign.descriptor.packageDigest);
    expect(row?.compatibility).toMatchObject({ supported: false, code: "unknown_permission_contract" });
  });

  it("refuses a candidate declaring a contract this build implements but no shape may declare", async () => {
    // Implementing a contract and shipping one are two different permissions to
    // hold, and this is the test that keeps them apart. When it was written,
    // BOTH write-class asks were undeclarable; `modular-v3` then made the
    // nine-token write ask declarable (its Gate enforcement exists), so the
    // write case moved to the modular-v3 suite's positive path and what
    // remains pinned here is the ten-token notify ask: it resolves from a
    // digest, projects onto a consent screen and has a working grant seam —
    // and is still not allowed on a release, because the platform cannot yet
    // enforce what its consent row promises (a per-call approval for the
    // send, which has no capability Object behind it).
    //
    // If this ever starts failing because a shape was pointed at it, the fix
    // is not to delete the case: it is to make the promise true first.
    await host.start();
    const before = host.active()!.prepared.identity.packageDigest;
    const candidate = undeclarableContractBundle(
      SESSION_PLUS_WORKSPACE_WRITE_NOTIFY_PERMISSION_CONTRACT as SessionPlusPermissionContract,
      "4".repeat(64),
    );
    expect(host.install(candidate, "user:lht").ok).toBe(true);
    const row = host.list().find((entry) =>
      entry.release.descriptor.packageDigest === candidate.descriptor.packageDigest);
    expect(row?.compatibility).toMatchObject({ supported: false, code: "unknown_permission_contract" });
    const outcome = await host.activate(candidate.descriptor.packageDigest, "user:lht");
    expect(outcome).toMatchObject({ ok: false, failure: { code: "unknown_permission_contract" } });
    expect(host.active()!.prepared.identity.packageDigest).toBe(before);
    expect(runtime.committed).toHaveLength(1);
  });

  it("refuses a candidate whose backend does not come up, without moving the pointer", async () => {
    await host.start();
    const before = host.active()!.prepared.identity.packageDigest;
    const other = variantBundle("unhealthy");
    host.install(other, "user:lht");
    runtime.failNext = true;
    const outcome = await host.activate(other.descriptor.packageDigest, "user:lht");
    expect(outcome).toMatchObject({ ok: false, failure: { code: "runtime_unhealthy" } });
    expect(host.active()!.prepared.identity.packageDigest).toBe(before);
    expect(runtime.committed).toHaveLength(1);
    expect(runtime.discarded).toHaveLength(0); // it never became a candidate
  });

  it("installs, activates and rolls back across all four shapes", async () => {
    // The rollback matrix for the whole module platform, and the acceptance
    // criterion for the write release specifically. If any of the older three
    // stops working, "the shortest way back is the active pointer" stops being
    // true — and it stops being true at the exact moment somebody needs it,
    // because the reason to roll back a write release is that writing went
    // wrong.
    const current = (await host.start())!;
    expect(current.prepared.shape).toBe("modular-v3");
    expect(current.prepared.modulePlan?.composition.app).toBe("session-plus");
    expect(current.prepared.resourceBindings?.bindings).toEqual([
      { binding: "docs", contract: "crdt-doc/v2" },
      { binding: "workspace", contract: "workspace-files/v4" },
    ]);
    // The checkout asks for bounded media preview, generic download and one terminal handshake.
    expect(current.prepared.identity.contract.operations).toContain("replace_workspace_text");
    expect(current.prepared.identity.contract.operations).toContain("edit_document");
    // Local CAS write is silent; shared edit still needs its capability lease.
    expect(current.prepared.identity.contract.autoAllow).toContain("replace_workspace_text");
    expect(current.prepared.identity.contract.autoAllow).toContain("start_session");
    expect(current.prepared.identity.contract.autoAllow).toContain("append_session");
    expect(current.prepared.identity.contract.autoAllow).not.toContain("edit_document");
    expect(current.prepared.identity.contract.autoAllow).toContain("read_document");

    const legacy = legacyBundle();
    expect(legacy.assets).toHaveLength(7);
    expect(host.install(legacy, "user:lht").ok).toBe(true);
    const legacyRow = host.list().find((entry) => entry.release.descriptor.packageDigest === legacy.descriptor.packageDigest);
    expect(legacyRow?.compatibility).toEqual({ supported: true });

    const moved = await host.activate(legacy.descriptor.packageDigest, "user:lht");
    expect(moved.ok).toBe(true);
    expect(host.active()!.prepared.shape).toBe("legacy");
    // A legacy release has no plan, and the adapter says so rather than
    // inventing an empty one. With no plan there is no resource handle, so a
    // `resource.*` proposal is a bounded refusal and sessions behave as before.
    expect(host.active()!.prepared.modulePlan).toBeNull();
    expect(host.active()!.prepared.resourceBindings).toBeNull();
    expect(host.active()!.prepared.descriptor.composition.view).toEqual(["view.css", "view.html", "view.js"]);

    const modularV1 = modularV1Bundle();
    expect(modularV1.assets).toHaveLength(9);
    expect(host.install(modularV1, "user:lht").ok).toBe(true);
    expect((await host.activate(modularV1.descriptor.packageDigest, "user:lht")).ok).toBe(true);
    expect(host.active()!.prepared.shape).toBe("modular-v1");
    expect(host.active()!.prepared.modulePlan).not.toBeNull();
    expect(host.active()!.prepared.resourceBindings).toBeNull();
    // And it declares the SIX-token ask, so the two workspace operations are
    // not grantable while it is the one being served.
    expect(host.active()!.prepared.identity.contract.operations).not.toContain("read_workspace_text");

    // The rollback target people are actually running today: file reads, no
    // write. Its ask must be exactly the eight tokens their consent covers.
    const modularV2 = modularV2Bundle();
    expect(modularV2.assets).toHaveLength(10);
    expect(host.install(modularV2, "user:lht").ok).toBe(true);
    expect((await host.activate(modularV2.descriptor.packageDigest, "user:lht")).ok).toBe(true);
    expect(host.active()!.prepared.shape).toBe("modular-v2");
    expect(host.active()!.prepared.resourceBindings).not.toBeNull();
    expect(host.active()!.prepared.identity.contract.operations).toContain("read_workspace_text");
    expect(host.active()!.prepared.identity.contract.operations).not.toContain("replace_workspace_text");
    // And its permission digest is byte-identical to what a pre-write release
    // declared — which is what makes rolling back to it not a re-consent.
    expect(host.active()!.prepared.descriptor.permissionContractDigest).toBe(
      permissionContractDigest(SESSION_PLUS_PUBLISHER, SESSION_PLUS_WORKSPACE_PERMISSION_CONTRACT),
    );

    const back = await host.activate(current.prepared.identity.packageDigest, "user:lht");
    expect(back.ok).toBe(true);
    expect(host.active()!.prepared.shape).toBe("modular-v3");
    expect(host.active()!.prepared.identity.contract.operations).toContain("replace_workspace_text");
    // Four activations after the seed, none of which needed a restart.
    expect(runtime.committed).toHaveLength(5);
  });

  it("refuses a shape whose declared permission contract belongs to another shape", async () => {
    await host.start();
    const before = host.active()!.prepared.identity.packageDigest;
    for (const kind of ["legacy-wide", "modular-v2-narrow", "modular-v2-write", "modular-v3-narrow"] as const) {
      const crossed = crossedShapeBundle(kind);
      expect(host.install(crossed, "user:lht").ok, kind).toBe(true);
      const row = host.list().find((entry) => entry.release.descriptor.packageDigest === crossed.descriptor.packageDigest);
      // Visible on the management page, so nobody discovers it by pressing
      // activate. `legacy-wide` is an old View that somehow acquired file
      // permissions; `modular-v2-narrow` is a file tree whose reads can never
      // be granted — a half-working release; `modular-v2-write` is the one that
      // matters most now, a read-only release claiming the WRITE ask, which
      // would let a package that ships no editor collect consent for one; and
      // `modular-v3-narrow` is an editor whose writes can never be granted.
      expect(row?.compatibility, kind).toMatchObject({ supported: false, code: "unknown_permission_contract" });
      const outcome = await host.activate(crossed.descriptor.packageDigest, "user:lht");
      expect(outcome, kind).toMatchObject({ ok: false, failure: { code: "unknown_permission_contract" } });
    }
    expect(host.active()!.prepared.identity.packageDigest).toBe(before);
    expect(runtime.committed).toHaveLength(1);
  });

  it("refuses a release whose own declaration disagrees with the ask its shape makes", async () => {
    // The cross-check the eleventh asset exists for. `compatibility()` has
    // already matched the descriptor's DIGEST against the shape table, so a
    // package reaching this point is one whose bytes say one thing and whose
    // digest says another — a typo in exactly the field a reviewer reads to
    // learn what they are being asked to agree to.
    await host.start();
    const before = host.active()!.prepared.identity.packageDigest;

    const narrower = rewrittenPermissionsBundle(() =>
      `${JSON.stringify({ schema: "app-permissions/v1", contract: "sessions-workspace/v1" }, null, 2)}\n`);
    expect(host.install(narrower, "user:lht").ok).toBe(true);
    // Cheap enough to be decided from the descriptor? No — the document is a
    // byte, so this refusal is a `prepare()` one and the listing says the
    // release is fine until somebody tries. That is the honest split: the
    // management page never reads artifact content.
    const row = host.list().find((entry) => entry.release.descriptor.packageDigest === narrower.descriptor.packageDigest);
    expect(row?.compatibility).toEqual({ supported: true });
    const refused = await host.activate(narrower.descriptor.packageDigest, "user:lht");
    expect(refused).toMatchObject({ ok: false, failure: { code: "unknown_permission_contract" } });
    expect(refused.ok === false && refused.failure.message).toContain("sessions-workspace/v1");

    // An id no build implements is the same refusal, not a smaller one.
    const foreign = rewrittenPermissionsBundle(() =>
      `${JSON.stringify({ schema: "app-permissions/v1", contract: "everything/v1" }, null, 2)}\n`);
    expect(host.install(foreign, "user:lht").ok).toBe(true);
    expect(await host.activate(foreign.descriptor.packageDigest, "user:lht"))
      .toMatchObject({ ok: false, failure: { code: "unknown_permission_contract" } });

    expect(host.active()!.prepared.identity.packageDigest).toBe(before);
    expect(runtime.committed).toHaveLength(1);
  });

  it("refuses a permission declaration that is malformed or not canonical", async () => {
    await host.start();
    const before = host.active()!.prepared.identity.packageDigest;

    // Same declaration, different bytes. Refused because "one ask, one
    // digest-protected representation" is what lets a digest stand for a claim.
    const reformatted = rewrittenPermissionsBundle((source) => `${source.trimEnd()}\n\n`);
    expect(host.install(reformatted, "user:lht").ok).toBe(true);
    expect(await host.activate(reformatted.descriptor.packageDigest, "user:lht"))
      .toMatchObject({ ok: false, failure: { code: "invalid_declaration" } });

    // A field this build does not understand — a newer schema, or a typo that
    // disabled something. Both get the loud answer.
    const extended = rewrittenPermissionsBundle(() => `${JSON.stringify({
      schema: "app-permissions/v1",
      contract: "sessions-workspace-write/v1",
      operations: ["replace_workspace_text"],
    }, null, 2)}\n`);
    expect(host.install(extended, "user:lht").ok).toBe(true);
    expect(await host.activate(extended.descriptor.packageDigest, "user:lht"))
      .toMatchObject({ ok: false, failure: { code: "invalid_declaration" } });

    const garbage = rewrittenPermissionsBundle(() => "{ not json");
    expect(host.install(garbage, "user:lht").ok).toBe(true);
    expect(await host.activate(garbage.descriptor.packageDigest, "user:lht"))
      .toMatchObject({ ok: false, failure: { code: "invalid_declaration" } });

    expect(host.active()!.prepared.identity.packageDigest).toBe(before);
    expect(runtime.committed).toHaveLength(1);
  });

  it("refuses a release whose plan names a contract this deployment did not install", async () => {
    // A deployment with no provider for `workspace-files/v1`. Activating a
    // release that needs one would produce a file panel that is permanently
    // `no_authority` while the release looked healthy.
    contracts = [];
    const bare = build();
    // The checkout's own package needs one, so seeding it fails — loudly, at the
    // adapter, and without moving anything.
    expect(await bare.start()).toBeNull();
    expect(bare.unavailable()?.code).toBe("unsupported_resource_contract");

    // And the older shapes still work on that same deployment, which is what
    // makes "no Runner" a rollback rather than an outage.
    const legacy = legacyBundle();
    expect(bare.install(legacy, "user:lht").ok).toBe(true);
    expect((await bare.activate(legacy.descriptor.packageDigest, "user:lht")).ok).toBe(true);
    expect(bare.active()!.prepared.shape).toBe("legacy");
  });

  /**
   * v1 and v2 remain valid rollback targets for historical releases. The
   * current v3 ask is intentionally not interchangeable: it adds binary reads.
   */
  describe("binding historical workspace-files versions", () => {
    const boundToV1 = () => modularV2Bundle(WORKSPACE_FILES_CONTRACT);

    it("activates a historical v1-binding release and rolls back", async () => {
      await host.start();
      const before = host.active()!.prepared;
      const bundle = boundToV1();
      expect(host.install(bundle, "user:lht").ok).toBe(true);
      const activated = await host.activate(bundle.descriptor.packageDigest, "user:lht");
      expect(activated.ok).toBe(true);

      const after = host.active()!.prepared;
      expect(after.shape).toBe("modular-v2");
      expect(after.identity.packageDigest).not.toBe(before.identity.packageDigest);
      expect(after.identity.contract.operations).not.toContain("read_workspace_binary");
      expect(after.resourceBindings!.bindings.map((row) => row.contract))
        .toEqual([WORKSPACE_FILES_CONTRACT]);

      // …and back, which is what makes v1 a rollback target rather than a thing
      // that was removed.
      expect((await host.activate(before.identity.packageDigest, "user:lht")).ok).toBe(true);
      expect(host.active()!.prepared.resourceBindings!.bindings.map((row) => row.contract))
        .toEqual([CRDT_DOC_CONTRACT_V2, WORKSPACE_FILES_CONTRACT_V4]);
    });

    it("refuses a plan that binds BOTH versions", async () => {
      await host.start();
      const before = host.active()!.prepared.identity.packageDigest;
      const both = editedBindings((plan) => ({
        ...plan,
        bindings: [
          ...plan.bindings,
          { binding: "workspace-prev", contract: WORKSPACE_FILES_CONTRACT },
        ],
        // One surface moved onto the second binding, so both are referenced and
        // the plan links — the refusal has to come from the ask, not from a
        // dangling binding.
        connections: plan.connections.map((row, index) => (index === 0
          ? { ...row, port: WORKSPACE_FILES_CONTRACT, binding: "workspace-prev" }
          : row)),
      } as ResourceBindingPlan));
      expect(host.install(both, "user:lht").ok).toBe(true);
      expect(await host.activate(both.descriptor.packageDigest, "user:lht"))
        .toMatchObject({ ok: false, failure: { code: "invalid_module_plan" } });
      expect(host.active()!.prepared.identity.packageDigest).toBe(before);
    });

    it("refuses to seed the checkout when only an older version is installed", async () => {
      // Only v1 installed: the checkout, which binds v3, cannot be served. Its
      // own store, because a failed seed still records the install — and any
      // history makes the next start an operator decision, not a re-seed.
      contracts = [WORKSPACE_FILES_CONTRACT, NOTIFY_CONTRACT];
      const onlyV1 = build();
      expect(await onlyV1.start()).toBeNull();
      expect(onlyV1.unavailable()?.code).toBe("unsupported_resource_contract");
    });

    it("refuses to activate a release binding a version this deployment did not install", async () => {
      // Only the current v4 installed: the checkout seeds, and a v1-binding
      // release does not activate. Supporting one version never implies
      // authority for another.
      contracts = [WORKSPACE_FILES_CONTRACT_V4, NOTIFY_CONTRACT, CRDT_DOC_CONTRACT_V2];
      const onlyV4 = build();
      expect(await onlyV4.start()).not.toBeNull();
      const bundle = boundToV1();
      expect(onlyV4.install(bundle, "user:lht").ok).toBe(true);
      expect(await onlyV4.activate(bundle.descriptor.packageDigest, "user:lht"))
        .toMatchObject({ ok: false, failure: { code: "unsupported_resource_contract" } });
    });
  });

  it("refuses a resource plan that is not canonical, or is wired to nothing", async () => {
    await host.start();
    const before = host.active()!.prepared.identity.packageDigest;

    const reordered = rewrittenBindingsBundle((source) => `${source.trimEnd()}\n\n`);
    expect(host.install(reordered, "user:lht").ok).toBe(true);
    expect(await host.activate(reordered.descriptor.packageDigest, "user:lht"))
      .toMatchObject({ ok: false, failure: { code: "invalid_module_plan" } });

    const dangling = rewrittenBindingsBundle(() => JSON.stringify({
      schema: "agent-resource-bindings/v1",
      app: "session-plus",
      bindings: [{ binding: "workspace", contract: "workspace-files/v1" }],
      connections: [{ instance: "ghost", port: "workspace-files/v1", binding: "workspace" }],
    }));
    expect(host.install(dangling, "user:lht").ok).toBe(true);
    expect(await host.activate(dangling.descriptor.packageDigest, "user:lht"))
      .toMatchObject({ ok: false, failure: { code: "invalid_module_plan" } });

    const foreign = rewrittenBindingsBundle(() => JSON.stringify({
      schema: "agent-resource-bindings/v1",
      app: "somebody-else",
      bindings: [{ binding: "workspace", contract: "workspace-files/v1" }],
      connections: [],
    }));
    expect(host.install(foreign, "user:lht").ok).toBe(true);
    expect(await host.activate(foreign.descriptor.packageDigest, "user:lht"))
      .toMatchObject({ ok: false, failure: { code: "invalid_module_plan" } });

    // Nothing moved, and no candidate runtime was adopted.
    expect(host.active()!.prepared.identity.packageDigest).toBe(before);
    expect(runtime.committed).toHaveLength(1);
  });

  it("activates a v2 binding plan, and rolls back to the v1 one it replaced", async () => {
    await host.start();
    // The checkout now ships v2 itself. Make the historical rollback target
    // explicit rather than accidentally treating whatever the checkout seeds
    // today as v1.
    const v1Bundle = editedBindings(asV1);
    expect(host.install(v1Bundle, "user:lht").ok).toBe(true);
    expect((await host.activate(v1Bundle.descriptor.packageDigest, "user:lht")).ok).toBe(true);
    const v1 = host.active()!.prepared;
    const v1Digest = v1.identity.packageDigest;
    expect(v1.resourceBindings?.schema).toBe("agent-resource-bindings/v1");

    const templated = editedBindings((plan) => asV2(plan, [{ instance: "file-viewer", maxInstances: 12 }]));

    // A schema major is not a new release inventory. Same asset name, same
    // asset count, same shape, same permission contract digest — because a
    // template changes what the layout may show, never what the App may reach.
    expect(templated.descriptor.assets.map((asset) => asset.name).sort())
      .toEqual(v1.descriptor.assets.map((asset) => asset.name).sort());
    expect(templated.descriptor.permissionContractDigest).toBe(v1.descriptor.permissionContractDigest);
    // The bytes changed, so the hostname does. That is the axis that SHOULD
    // move: a release is addressed by what it is made of.
    expect(templated.descriptor.packageDigest).not.toBe(v1Digest);

    expect(host.install(templated, "user:lht").ok).toBe(true);
    const outcome = await host.activate(templated.descriptor.packageDigest, "user:lht");
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    const prepared = host.active()!.prepared;
    expect(prepared.shape).toBe(v1.shape);
    expect(prepared.resourceBindings?.schema).toBe("agent-resource-bindings/v2");
    expect(planTemplates(prepared.resourceBindings!)).toEqual([{ instance: "file-viewer", maxInstances: 12 }]);

    // And back. A rollback target does not stop working the day a newer schema
    // ships — that is the whole reason v2 is a second schema and not a wider v1.
    expect((await host.activate(v1Digest, "user:lht")).ok).toBe(true);
    const rolled = host.active()!.prepared.resourceBindings!;
    expect(rolled.schema).toBe("agent-resource-bindings/v1");
    expect(planTemplates(rolled)).toEqual([]);
  });

  it("refuses a v2 template the composition cannot honour, with no manifests in sight", async () => {
    // `prepare()` deliberately supplies no registry. Template validation must
    // still happen here: a template names an instance, and every port it claims
    // is in this document's own connections — so nothing about it needs the
    // manifests, and deferring it would leave the pack path as the only place
    // a bad template was ever caught.
    await host.start();
    const before = host.active()!.prepared.identity.packageDigest;

    const dangling = editedBindings((plan) => asV2({
      ...plan,
      connections: [...plan.connections, { instance: "ghost", port: "workspace-files/v1", binding: "workspace" }],
    } as ResourceBindingPlan, [{ instance: "ghost", maxInstances: 4 }]));

    // A prototype in a slot that holds a strip of widgets rather than a document.
    const misSlotted = editedBindings((plan) => asV2(plan, [{ instance: "index", maxInstances: 4 }]));

    // A prototype this plan wires to nothing would inherit nothing.
    const unwired = editedBindings((plan) => asV2(plan, [{ instance: "chat", maxInstances: 4 }]));

    // A ceiling outside this build's bound.
    const unbounded = editedBindings((plan) => asV2(plan, [{ instance: "file-viewer", maxInstances: 999 }]));

    for (const candidate of [dangling, misSlotted, unwired, unbounded]) {
      expect(host.install(candidate, "user:lht").ok).toBe(true);
      expect(await host.activate(candidate.descriptor.packageDigest, "user:lht"))
        .toMatchObject({ ok: false, failure: { code: "invalid_module_plan" } });
    }

    expect(host.active()!.prepared.identity.packageDigest).toBe(before);
    expect(runtime.committed).toHaveLength(1);
  });

  it("activates a release whose module inventory differs from this build's — rollback semantics", async () => {
    // A historical release's lock, composition and View bundle were produced
    // together and are covered by one package digest; they are self-consistent
    // whatever THIS build's manifests say. Until 2026-08-07 the adapter audited
    // them against today's inventory, which meant one module version bump made
    // every previously installed release refuse to activate — the moment a
    // rollback is needed is exactly the moment it would have failed. The
    // manifest questions moved to the pack path (`checkoutPlanProblem`), where
    // build and bundle are the same checkout by definition; at mount time the
    // bundle's own compiled registry re-links the composition against the
    // manifests that will actually render.
    await host.start();

    const changedVersion = editedModuleLock((lock) => ({
      ...lock,
      modules: lock.modules.map((entry, index) => index === 0 ? { ...entry, version: "9.9.9" } : entry),
    }));
    const changedImplementation = editedModuleLock((lock) => ({
      ...lock,
      modules: lock.modules.map((entry, index) =>
        index === 0 ? { ...entry, implementation: "other-package#Module" } : entry),
    }));
    const extraModule = editedModuleLock((lock) => ({
      ...lock,
      modules: [
        ...lock.modules,
        { id: "demo.extra/v1", version: "1.0.0", implementation: "test#Extra" },
      ],
    }));
    // An old release may also have been built when a module still accepted a
    // slot this build's manifest no longer lists. Its own registry mounted it
    // then and will judge it now; the host does not re-litigate placement.
    const olderPlacement = editedComposition((composition) => ({
      ...composition,
      instances: composition.instances.map((row) =>
        row.instance === "index" ? { ...row, slot: "bottom" as const } : row),
    }));

    for (const candidate of [changedVersion, changedImplementation, extraModule, olderPlacement]) {
      expect(host.install(candidate, "user:lht").ok).toBe(true);
      const outcome = await host.activate(candidate.descriptor.packageDigest, "user:lht");
      expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
      expect(host.active()!.prepared.identity.packageDigest).toBe(candidate.descriptor.packageDigest);
    }
  });

  it("the pack path refuses a plan this build's manifests do not allow", () => {
    // The questions the adapter stopped asking are asked HERE, at the one
    // moment when "the manifests in this process" and "the manifests the
    // bundle was built from" coincide by definition. `buildCheckoutBundle`
    // throws on any of these; the check is exported so each refusal can be
    // pinned without a filesystem.
    const assets = sessionPlusReleasePackage().assets;
    expect(checkoutPlanProblem(assets)).toBeNull();

    const problem = (name: string, rewrite: (source: string) => string): string | null =>
      checkoutPlanProblem(assets.map((asset) =>
        asset.name === name ? { ...asset, source: rewrite(asset.source) } : asset));
    const lockProblem = (edit: (lock: AgentModuleLock) => AgentModuleLock) =>
      problem("view/module-lock.json", (source) => {
        const read = parseModuleLock(source);
        if (!read.ok) throw new Error("the checkout's own module lock does not parse");
        return encodeModuleLock(edit(read.value));
      });
    const compositionProblem = (edit: (composition: AgentComposition) => AgentComposition) =>
      problem("view/composition.json", (source) => {
        const read = parseComposition(source);
        if (!read.ok) throw new Error("the checkout's own composition does not parse");
        return encodeComposition(edit(read.value));
      });
    const bindingsProblem = (edit: (plan: ResourceBindingPlan) => ResourceBindingPlan) =>
      problem("view/resource-bindings.json", (source) => {
        const read = parseResourceBindings(source);
        if (!read.ok) throw new Error("the checkout's own binding plan does not parse");
        return encodeResourceBindings(edit(read.value));
      });

    // The lock must be exactly this build's implementation inventory.
    expect(lockProblem((lock) => ({
      ...lock,
      modules: lock.modules.map((entry, index) => index === 0 ? { ...entry, version: "9.9.9" } : entry),
    }))).toContain("与本构建的清单不符");
    expect(lockProblem((lock) => ({
      ...lock,
      modules: [...lock.modules, { id: "demo.extra/v1", version: "1.0.0", implementation: "test#Extra" }],
    }))).toContain("与本构建的清单不符");

    // Placement and routing must be what the modules themselves declare.
    expect(compositionProblem((composition) => ({
      ...composition,
      instances: composition.instances.map((row) =>
        row.instance === "index" ? { ...row, slot: "bottom" as const } : row),
    }))).toContain("与本构建的清单不符");
    // Exactly ONE rule is repointed. Rewriting every `workspace-text` rule would
    // now route the kind to one module twice — a different, earlier refusal —
    // and the claim under test is about a module that never declared the kind.
    expect(compositionProblem((composition) => {
      let done = false;
      return {
        ...composition,
        open: composition.open.map((row) => {
          if (done || row.resource !== "workspace-text") return row;
          done = true;
          return { ...row, module: "agent.chat/v1" };
        }),
      };
    })).toContain("与本构建的清单不符");

    // A binding wired to a module that never declared that port. The port must
    // match the binding's own v4 contract so the refusal under test is the
    // manifest one, not the port↔binding mismatch.
    expect(bindingsProblem((plan) => ({
      ...plan,
      connections: [
        ...plan.connections,
        { instance: "chat", port: WORKSPACE_FILES_CONTRACT_V4, binding: "workspace" },
      ],
    }))).toContain("不匹配");

    // v2 at pack time, against the checkout's real composition: `file-viewer`
    // is connected, sits in a document slot, and is what `workspace-text` opens
    // into there — so a template on it is a plan this build could publish.
    expect(bindingsProblem((plan) => asV2(plan, [{ instance: "file-viewer", maxInstances: 12 }]))).toBeNull();
    // `index` is the unified tree: connected, but a navigation strip is not a
    // document region, so nothing would ever derive from it.
    expect(bindingsProblem((plan) => asV2(plan, [{ instance: "index", maxInstances: 12 }]))).toContain("不匹配");

    // Wiring one surface and forgetting the other — per instance, not per
    // module: two instances of one module are two surfaces. The linker itself
    // owns this refusal ("<instance> needs <port> but has no resource
    // connection"), so the pack path inherits it with the manifests.
    for (const keep of ["index", "file-viewer", "editor"]) {
      expect(bindingsProblem((plan) => asV1({
        ...plan,
        // Keep the independent CRDT plane fully wired and retain exactly one
        // workspace surface. Restating this manifest-link test as v1 avoids a
        // v2 prototype-orphan refusal masking the missing per-instance edges.
        connections: plan.connections.filter((row) =>
          row.port !== WORKSPACE_FILES_CONTRACT_V4 || row.instance === keep),
      } as ResourceBindingPlan)), `wiring only ${keep} must be refused at pack time`).toContain("不匹配");
    }

    // The permission declaration gets exactly the two builder-checkable
    // properties: it parses and its bytes are canonical. Whether it names the
    // contract its SHAPE may declare is the adapter's question, on the install
    // path — asking it here too would put the shape→contract table in two
    // places, and this build's own package is described from the very constants
    // that table is compared against.
    expect(problem(PERMISSIONS_ASSET, (source) => `${source} `)).toContain("canonical");
    expect(problem(PERMISSIONS_ASSET, () => "{ not json")).toContain("权限声明不被接受");
    expect(problem(PERMISSIONS_ASSET, () =>
      `${JSON.stringify({ schema: "app-permissions/v2", contract: "sessions/v1" }, null, 2)}\n`))
      .toContain("权限声明不被接受");
    // …and a narrower id still PASSES the pack check, which is the honest
    // division of labour rather than an oversight: it is a well-formed
    // declaration, and it is the adapter that owns "may this shape say that".
    expect(problem(PERMISSIONS_ASSET, () =>
      `${JSON.stringify({ schema: "app-permissions/v1", contract: "sessions/v1" }, null, 2)}\n`)).toBeNull();
  });

  it("refuses a binding plan whose contract set is not exactly what the ask implies", async () => {
    await host.start();
    const before = host.active()!.prepared.identity.packageDigest;

    // Missing: the release asks for the two file operations and then wires no
    // file port at all, so the panel could never work.
    const empty = editedBindings((plan) => ({ ...plan, bindings: [], connections: [] }));
    expect(host.install(empty, "user:lht").ok).toBe(true);
    expect(await host.activate(empty.descriptor.packageDigest, "user:lht"))
      .toMatchObject({ ok: false, failure: { code: "invalid_module_plan" } });

    // Extra: a typed port nobody agreed to when they agreed to this permission
    // contract. "The deployment happens to have a provider" is not consent.
    const extra = editedBindings((plan) => ({
      ...plan,
      bindings: [...plan.bindings, { binding: "extra", contract: "collab-document/v1" }],
    }));
    expect(host.install(extra, "user:lht").ok).toBe(true);
    expect(await host.activate(extra.descriptor.packageDigest, "user:lht"))
      .toMatchObject({ ok: false, failure: { code: "invalid_module_plan" } });

    expect(host.active()!.prepared.identity.packageDigest).toBe(before);
    expect(runtime.committed).toHaveLength(1);
  });

  it("does not demand a binding for the sessions port, which no plan declares", async () => {
    // The counterweight to the rule above. Every sessions module declares
    // `agent-sessions/v1`, which the App serves over its own channel rather than
    // through a resource binding — requiring it here would refuse every release
    // that has ever existed, including both rollback targets.
    await host.start();
    expect(host.active()!.prepared.shape).toBe("modular-v3");
    expect(host.active()!.prepared.resourceBindings?.bindings.map((row) => row.contract))
      .toEqual(["crdt-doc/v2", "workspace-files/v4"]);
  });

  it("refuses a module plan that references a module outside its lock", async () => {
    await host.start();
    const before = host.active()!.prepared.identity.packageDigest;
    const broken = brokenPlanBundle();
    expect(host.install(broken, "user:lht").ok).toBe(true);
    const outcome = await host.activate(broken.descriptor.packageDigest, "user:lht");
    expect(outcome).toMatchObject({ ok: false, failure: { code: "invalid_module_plan" } });
    // The pointer did not move, and no runtime was swapped.
    expect(host.active()!.prepared.identity.packageDigest).toBe(before);
    expect(runtime.committed).toHaveLength(1);
  });

  it("binds a canonical module plan to the descriptor's stable App id", async () => {
    await host.start();
    const before = host.active()!.prepared.identity.packageDigest;
    const wrongApp = rewrittenCompositionBundle((source) => {
      const value = JSON.parse(source) as Record<string, unknown>;
      value.app = "another-app";
      return `${JSON.stringify(value, null, 2)}\n`;
    });
    const nonCanonical = rewrittenCompositionBundle((source) => `${source} `);

    for (const candidate of [wrongApp, nonCanonical]) {
      expect(host.install(candidate, "user:lht").ok).toBe(true);
      const outcome = await host.activate(candidate.descriptor.packageDigest, "user:lht");
      expect(outcome).toMatchObject({ ok: false, failure: { code: "invalid_module_plan" } });
      expect(host.active()!.prepared.identity.packageDigest).toBe(before);
    }
    expect(runtime.committed).toHaveLength(1);
  });

  it("rolls back to an installed older release without a restart", async () => {
    const first = (await host.start())!.prepared.identity.packageDigest;
    const other = variantBundle("rollback");
    host.install(other, "user:lht");
    await host.activate(other.descriptor.packageDigest, "user:lht");
    expect(host.active()!.prepared.identity.packageDigest).toBe(other.descriptor.packageDigest);

    const back = await host.activate(first, "user:lht");
    expect(back.ok).toBe(true);
    expect(host.active()!.prepared.identity.packageDigest).toBe(first);
    expect((back as { previousPackageDigest: string }).previousPackageDigest).toBe(other.descriptor.packageDigest);
    expect(runtime.committed).toHaveLength(3);
  });

  it("deactivates durably across restart, stops Runtime, and can be activated again", async () => {
    const first = (await host.start())!.prepared.identity.packageDigest;
    expect(await host.deactivate("user:lht")).toMatchObject({ ok: true, changed: true });
    expect(host.active()).toBeNull();
    expect(host.unavailable()).toMatchObject({ code: "not_active" });
    expect(host.list()).toHaveLength(1);
    expect(runtime.deactivated).toBe(1);

    // No active pointer plus existing history means "explicitly off", not
    // "first boot". A restart must not silently seed and reactivate checkout.
    const restarted = build();
    expect(await restarted.start()).toBeNull();
    expect(restarted.unavailable()).toMatchObject({ code: "not_active" });
    expect(runtime.committed).toHaveLength(1);

    expect((await restarted.activate(first, "user:lht")).ok).toBe(true);
    expect(restarted.active()!.prepared.identity.packageDigest).toBe(first);
  });

  it("refuses to serve a release whose artifact has been damaged, and says which", async () => {
    await host.start();
    const digest = host.active()!.prepared.identity.packageDigest;
    // Corrupt the stored artifact behind the active pointer.
    const paths = appReleasePaths(dir);
    const manifest = path.join(paths.contentRoot, "releases", `${digest}.json`);
    writeFileSync(manifest, "{ not a manifest", "utf8");

    const restarted = build();
    expect(await restarted.start()).toBeNull();
    expect(restarted.unavailable()?.message).toContain("回滚");
    // And the management surface still works, which is the whole point.
    expect(restarted.describe().releases.length).toBeGreaterThan(0);
  });

  it("refuses to activate a release whose hostname a pinned deployment cannot serve", async () => {
    const label = packageHostLabel(buildCheckoutBundle().descriptor.packageDigest);
    const pinnedBase = resolveSessionPlus({
      config: { enabled: true, view_origin: `http://${label}.localhost:9821` },
      dashboardPort: 9820,
    });
    if (!pinnedBase.enabled || !pinnedBase.settings) {
      throw new Error(`pinned fixture did not resolve: ${pinnedBase.errors.join("; ")}`);
    }
    const pinned = build(pinnedBase.settings);
    expect(await pinned.start()).not.toBeNull();

    const other = variantBundle("pinned");
    pinned.install(other, "user:lht");
    const outcome = await pinned.activate(other.descriptor.packageDigest, "user:lht");
    expect(outcome).toMatchObject({ ok: false, failure: { code: "origin_pinned" } });
    expect(outcome.ok === false && outcome.failure.message).toContain("app_domain");
  });

  it("serves each label its OWN document and nothing for a label it does not publish", async () => {
    await host.start();
    const first = host.active()!.prepared.identity.packageHostLabel;
    const other = variantBundle("documents");
    host.install(other, "user:lht");
    const otherLabel = packageHostLabel(other.descriptor.packageDigest);

    const a = await host.documentFor(first, "noncenonce");
    const b = await host.documentFor(otherLabel, "noncenonce");
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b);
    expect(b!.body).toContain("/* documents */");
    expect(a!.body).not.toContain("/* documents */");
    expect(await host.documentFor("app-00000000000000000000", "noncenonce")).toBeNull();
  });

  it("never lets the admin projection carry a local path or an artifact byte", async () => {
    await host.start();
    const view = host.describe();
    const json = JSON.stringify(view);
    expect(json).not.toContain(dir);
    expect(json).not.toContain("preparedRoot");
    expect(json).not.toContain("contentRoot");
    // The inventory is names + digests + sizes, never content.
    const active = view.releases.find((row) => row.active)!;
    expect(active.assets.map((asset) => asset.name)).toContain("view.js");
    expect(json).not.toContain("<!doctype html>");
  });
});

/**
 * The catalog: which app a call is about.
 *
 * Session Plus is the first entry rather than the only shape the code knows, so
 * what is asserted here is routing and isolation — the two things that did not
 * exist while there was one adapter and could not be tested for.
 */
describe("AppReleaseHost", () => {
  let dir: string;
  let store: Store;
  let registry: AppReleaseRegistry;
  let sessionPlus: HostedApp<PreparedSessionPlusRelease, SessionPlusSettings>;
  let settings: SessionPlusSettings;

  /** A second app this build cannot serve: its checkout produces nothing. */
  class StubAdapter implements AppReleaseAdapter<{ marker: string }, { origin: string }> {
    constructor(readonly stableAppId: string, readonly publisher = "octopus.local") {}
    supports(descriptor: AppReleaseDescriptor): boolean {
      return descriptor.stableAppId === this.stableAppId && descriptor.publisher === this.publisher;
    }
    compatibility(): { supported: true } { return { supported: true }; }
    async prepare(): Promise<{ ok: false; code: string; message: string }> {
      return { ok: false, code: "not_implemented", message: "本构建没有这个 App 的实现" };
    }
    settingsFor(): { ok: true; settings: { origin: string } } { return { ok: true, settings: { origin: "" } }; }
    runtimeTargetOf(): { appDir: string; backendCodeDigest: string } {
      return { appDir: "", backendCodeDigest: "" };
    }
    documentOf() { return { body: "", policy: { kind: "hash" as const, scriptHash: `${"A".repeat(43)}=`, styleHash: `${"A".repeat(43)}=` }, immutable: true as const }; }
    viewOriginOf(): string | null { return null; }
    checkoutBundle(): never { throw new Error("this build ships no package for demo-app"); }
  }

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "release-catalog-"));
    store = new Store(path.join(dir, "bot.db"));
    const paths = appReleasePaths(dir);
    registry = new AppReleaseRegistry({
      catalog: new StoreReleaseCatalog(store),
      content: new FileReleaseContentStore(paths.contentRoot),
    });
    settings = localSettings();
    sessionPlus = new HostedApp({
      registry,
      adapter: new SessionPlusReleaseAdapter({
        preparedRoot: paths.preparedRoot,
        resourceContracts: () => new Set(PANEL_RESOURCE_CONTRACTS),
        baseSettings: settings,
      }),
    });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("routes by stable app id and answers nothing for an app it does not serve", async () => {
    const host = new AppReleaseHost({ registry, apps: [sessionPlus] });
    expect(host.ids()).toEqual(["session-plus"]);
    expect(host.app("session-plus")).toBe(sessionPlus);
    expect(host.app("demo-app")).toBeNull();
    // A refusal that names what this process actually serves, so an operator
    // learns the id was wrong rather than that "the release is bad".
    expect(host.unknownApp("demo-app").code).toBe("unknown_app");
    expect(host.unknownApp("demo-app").message).toContain("session-plus");
    await host.start();
    expect(sessionPlus.active()).not.toBeNull();
  });

  it("refuses two adapters claiming one id, at construction", () => {
    const twin = new HostedApp({ registry, adapter: new StubAdapter("session-plus", SESSION_PLUS_PUBLISHER) });
    // Array order would otherwise decide which app an activation moves, and
    // that is not a question a table should answer by accident.
    expect(() => new AppReleaseHost({ registry, apps: [sessionPlus, twin] })).toThrow(/session-plus/);
  });

  it("keeps one app's failure out of another app's way", async () => {
    const demo = new HostedApp({ registry, adapter: new StubAdapter("demo-app") });
    const host = new AppReleaseHost({ registry, apps: [demo, sessionPlus] });
    // The failing app is FIRST: a start that threw, or that stopped at the
    // first failure, would leave Session Plus unserved for a reason that has
    // nothing to do with it.
    await host.start();
    expect(demo.active()).toBeNull();
    expect(demo.unavailable()?.code).toBe("seed_build_failed");
    expect(sessionPlus.active()).not.toBeNull();
    expect(sessionPlus.unavailable()).toBeNull();

    // Directory reads inspect metadata without hashing historical bundles on
    // the HTTP event loop. Explicit integrity audits remain byte-exact.
    const fullCheck = vi.spyOn(FileReleaseContentStore.prototype, "verify");
    try {
      const view = host.describe();
      expect(view.apps.map((app) => app.stableAppId)).toEqual(["demo-app", "session-plus"]);
      expect(view.apps[0]?.checkout).toBeNull();
      expect(view.apps[0]?.releases).toEqual([]);
      expect(view.apps[1]?.releases.length).toBeGreaterThan(0);
      expect(view.reconcile.verification).toBe("manifest");
      expect(view.reconcile.orphanContent).toBe(0);
      expect(fullCheck).not.toHaveBeenCalled();
      expect(host.reconcile().activeUnusable).toEqual([]);
      expect(fullCheck).toHaveBeenCalled();
    } finally {
      fullCheck.mockRestore();
    }
  });

  it("routes an install by the descriptor the bundle carries, and refuses an unknown app", () => {
    const demo = new HostedApp({ registry, adapter: new StubAdapter("demo-app") });
    const host = new AppReleaseHost({ registry, apps: [demo] });
    const bundle = buildCheckoutBundle();
    // Nothing here can serve Session Plus, so installing its release would only
    // produce a row that can never be activated.
    const refused = host.install(bundle, "user:lht");
    expect(refused).toMatchObject({ ok: false, failure: { code: "unknown_app" } });
    expect(registry.list()).toHaveLength(0);

    const both = new AppReleaseHost({ registry, apps: [demo, sessionPlus] });
    const installed = both.install(bundle, "user:lht");
    expect(installed).toMatchObject({ ok: true, app: "session-plus" });
    // Installing still changes nothing about what is served.
    expect(sessionPlus.active()).toBeNull();
  });

  it("lists only its own app's releases", async () => {
    const host = new AppReleaseHost({ registry, apps: [sessionPlus] });
    await host.start();
    const demo = new HostedApp({ registry, adapter: new StubAdapter("demo-app") });
    // Every row in the catalog belongs to Session Plus, so the second app's
    // page is empty rather than full of other people's releases marked
    // "wrong_app" — a true sentence about a row with no business being there.
    expect(demo.describe().releases).toEqual([]);
    expect(sessionPlus.describe().releases.length).toBeGreaterThan(0);
  });
});

describe("release bundles on the wire", () => {
  it("round-trips exactly, and refuses anything unbounded or malformed", () => {
    const bundle = buildCheckoutBundle();
    const wire = bundleToWire(bundle);
    const largestAssetBytes = Math.max(...bundle.assets.map((asset) => asset.content.byteLength));
    expect(largestAssetBytes).toBeGreaterThan(0);
    expect(largestAssetBytes).toBeLessThanOrEqual(DEFAULT_BUNDLE_LIMITS.maxAssetBytes);
    const parsed = parseBundle(wire);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.bundle.descriptor.packageDigest).toBe(bundle.descriptor.packageDigest);
    for (const [index, asset] of parsed.bundle.assets.entries()) {
      expect(Buffer.from(asset.content).equals(Buffer.from(bundle.assets[index].content))).toBe(true);
    }

    expect(parseBundle({ ...wire, kind: "something-else" })).toMatchObject({ ok: false });
    expect(parseBundle({ ...wire, schemaVersion: 2 })).toMatchObject({ ok: false });
    expect(parseBundle({ ...wire, assets: "nope" })).toMatchObject({ ok: false });
    // base64 that does not round-trip would hand `install()` different bytes
    // than the sender believed it sent, and the digest mismatch would then read
    // as a build problem rather than as a transport one.
    expect(parseBundle({ ...wire, assets: [{ name: "view.js", base64: "!!!!" }] })).toMatchObject({ ok: false });
    expect(parseBundle({ ...wire, assets: [{ base64: "AAA=" }] })).toMatchObject({ ok: false });
    expect(
      parseBundle(wire, { maxAssets: 1, maxAssetBytes: 10, maxTotalBytes: 10 }),
    ).toMatchObject({ ok: false });
  });

  it("keeps the exact single-asset and aggregate byte limits after bundle splitting", () => {
    const base = buildCheckoutBundle();
    const single = Buffer.alloc(DEFAULT_BUNDLE_LIMITS.maxAssetBytes, 0xa5);
    const wire = bundleToWire({ ...base, assets: [{ name: "boundary.bin", content: single }] });
    const exactSingle = parseBundle(wire);
    expect(exactSingle.ok).toBe(true);
    if (!exactSingle.ok) throw new Error(exactSingle.error);
    expect(Buffer.from(exactSingle.bundle.assets[0]!.content).equals(single)).toBe(true);
    expect(parseBundle(bundleToWire({ ...base, assets: [{ name: "boundary.bin", content: Buffer.concat([single, Buffer.of(0)]) }] })))
      .toMatchObject({ ok: false });

    const remainder = Buffer.alloc(DEFAULT_BUNDLE_LIMITS.maxTotalBytes - single.byteLength, 0x5a);
    const exactTotal = bundleToWire({ ...base, assets: [
      { name: "first.bin", content: single }, { name: "second.bin", content: remainder },
    ] });
    const parsed = parseBundle(exactTotal);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(Buffer.from(parsed.bundle.assets[0]!.content).equals(single)).toBe(true);
    expect(Buffer.from(parsed.bundle.assets[1]!.content).equals(remainder)).toBe(true);
    expect(parseBundle({ ...exactTotal, assets: [...exactTotal.assets, { name: "overflow.bin", base64: "AA==" }] }))
      .toMatchObject({ ok: false });
  });

  it("packs the declared module asset inventory and media-and-terminal contract this deployment can activate", () => {
    // The acceptance criterion for shipping the document ask: what `pnpm run
    // app:pack` produces must be a shape THIS composition can serve, decided by
    // the same `compatibility()` the management page calls and against the same
    // contract list the panel installs. Answering it here, from the descriptor
    // alone, is what makes "install then activate" two decisions rather than a
    // gamble — an operator learns the answer before the pointer can move.
    const bundle = buildCheckoutBundle();
    expect(bundle.assets.map((asset) => asset.name)).toContain(PERMISSIONS_ASSET);
    const entryAsset = bundle.assets.find((asset) => asset.name === MODULE_ENTRY_ASSET);
    expect(entryAsset).toBeDefined();
    const entry = readAppModuleEntry(Buffer.from(entryAsset!.content).toString("utf8"));
    expect(entry).not.toBeNull();
    if (!entry) throw new Error("checkout module declaration did not parse");
    expect(entry.appId).toBe("session-plus");
    const expectedNames = new Set([
      "app/app.yaml", "app/actions.ts", "app/projection.ts", "app/pages/main.yaml",
      "view.html", "view.css", "view.js", ...HISTORICAL_PLAN_ASSETS,
      MODULE_ENTRY_ASSET, ...entry.assets.map(moduleAssetName),
    ]);
    expect(bundle.assets.map((asset) => asset.name).sort()).toEqual([...expectedNames].sort());
    expect(bundle.descriptor.permissionContractDigest).toBe(
      permissionContractDigest(SESSION_PLUS_PUBLISHER, SESSION_PLUS_OWNER_FILES_WRITE_PERMISSION_CONTRACT),
    );

    const dir = mkdtempSync(path.join(tmpdir(), "release-pack-"));
    try {
      const adapterWith = (contracts: readonly string[]) =>
        new SessionPlusReleaseAdapter({
          preparedRoot: appReleasePaths(dir).preparedRoot,
          resourceContracts: () => new Set(contracts),
          baseSettings: localSettings(),
        });
      expect(adapterWith(PANEL_RESOURCE_CONTRACTS).compatibility(bundle.descriptor))
        .toEqual({ supported: true });

      // And the counterfactual that makes the assertion mean something: on a
      // deployment with no `workspace-files/v1` provider this same bundle is
      // `installed / unsupported` rather than a release whose editor would be
      // permanently `no_authority`.
      expect(adapterWith([]).compatibility(bundle.descriptor)).toMatchObject({
        supported: false,
        code: "unsupported_resource_contract",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("describes the checkout without publishing anything", () => {
    const a = buildCheckoutBundle();
    const b = buildCheckoutBundle();
    expect(a.descriptor.packageDigest).toBe(b.descriptor.packageDigest);
    expect(a.descriptor.publisher).toBe(SESSION_PLUS_PUBLISHER);
    expect(a.provenance.signatureVerification).toBe("none");
    // The bundle's bytes are the release's bytes; nothing is read back from a
    // build directory at install time.
    const viewJs = a.assets.find((asset) => asset.name === "view.js")!;
    expect(Buffer.from(viewJs.content).toString("utf8")).toBe(
      readFileSync(path.join(process.cwd(), "packages/session-plus-view/dist/agent-view.js"), "utf8"),
    );
  });
});
