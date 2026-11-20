/** P2: package retention and backend-cohort references around HostedApp activation. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AppReleaseRegistry,
  FileReleaseContentStore,
  MemoryReleaseCatalog,
  describeRelease,
  utf8Bytes,
  type AppReleaseDescriptor,
  type InstallProvenance,
  type InstalledRelease,
  type ReleaseSpec,
} from "@claude-bot/app-registry";
import type { AppReleaseAdapter } from "./adapter.js";
import type { ReleaseBundle } from "./bundle.js";
import { HostedApp, type RuntimeCommitMode, type RuntimeSwap } from "./hosted-app.js";

const APP = "versioned-notes";
const PUBLISHER = "demo:versioning";
const PROVENANCE: InstallProvenance = {
  kind: "platform-built",
  builder: "p2-test",
  statement: "P2 version-routing fixture",
  signatureVerification: "none",
};

interface Prepared {
  descriptor: AppReleaseDescriptor;
  appDir: string;
  backendCodeDigest: string;
}

interface Settings {
  origin: string;
}

function bundle(view: string, backend: string): ReleaseBundle {
  const assets = [
    { name: "index.html", content: utf8Bytes(`<!doctype html><title>${view}</title>`) },
    { name: "actions.ts", content: utf8Bytes(`export const backend = ${JSON.stringify(backend)};`) },
  ];
  const spec: ReleaseSpec = {
    stableAppId: APP,
    publisher: PUBLISHER,
    executionProfile: "publisher-js",
    permissionContractDigest: "c".repeat(64),
    assets,
    composition: { view: ["index.html"], backend: ["actions.ts"] },
    source: {
      kind: "platform-hosted",
      digest: `sha256:${view}`,
      repository: "platform://p2-test",
      commit: "a".repeat(40),
      subdir: "packages/versioned-notes",
    },
    buildInput: {
      entry: "app.yaml",
      toolchain: { builder: "p2-test", format: "named-assets", lockfile: "pnpm-lock.yaml" },
      lockfileHash: "d".repeat(64),
    },
  };
  return { descriptor: describeRelease(spec), assets, provenance: PROVENANCE };
}

class LegacyAdapter implements AppReleaseAdapter<Prepared, Settings> {
  readonly stableAppId = APP;
  readonly publisher = PUBLISHER;
  readonly seedsFromCheckout = false;

  supports(descriptor: AppReleaseDescriptor): boolean {
    return descriptor.stableAppId === APP && descriptor.publisher === PUBLISHER;
  }

  compatibility(): { supported: true } {
    return { supported: true };
  }

  async prepare(release: InstalledRelease): Promise<{ ok: true; prepared: Prepared }> {
    return {
      ok: true,
      prepared: {
        descriptor: release.descriptor,
        appDir: `/prepared/${release.descriptor.packageDigest}`,
        backendCodeDigest: release.descriptor.evidence.backendDigest,
      },
    };
  }

  settingsFor(prepared: Prepared): { ok: true; settings: Settings } {
    return { ok: true, settings: { origin: `https://${prepared.descriptor.packageDigest}.example` } };
  }

  runtimeTargetOf(prepared: Prepared): { appDir: string; backendCodeDigest: string } {
    return { appDir: prepared.appDir, backendCodeDigest: prepared.backendCodeDigest };
  }

  documentOf() {
    return {
      body: "<!doctype html>",
      policy: { kind: "hash" as const, scriptHash: `${"A".repeat(43)}=`, styleHash: `${"A".repeat(43)}=` },
      immutable: true as const,
    };
  }
  viewOriginOf(settings: Settings): string { return settings.origin; }
  checkoutBundle(): never { throw new Error("test adapter has no checkout"); }
}

class CoexistingAdapter extends LegacyAdapter {
  coexistence(): { coexist: true } { return { coexist: true }; }
}

class FakeRuntime implements RuntimeSwap<{ appDir: string; backendCodeDigest: string }> {
  active: string | null = null;
  readonly versions = new Set<string>();
  readonly references = new Map<string, number>();
  readonly commits: Array<{ digest: string; mode: RuntimeCommitMode }> = [];
  readonly removedReferences: string[] = [];
  readonly retired: string[] = [];

  async prepareRuntime(appDir: string, backendCodeDigest: string) {
    return { appDir, backendCodeDigest };
  }

  commitRuntime(candidate: { appDir: string; backendCodeDigest: string }, mode: RuntimeCommitMode): void {
    const previous = this.active;
    if (mode === "swap") this.versions.clear();
    else if (previous) this.versions.add(previous);
    this.active = candidate.backendCodeDigest;
    this.versions.add(candidate.backendCodeDigest);
    this.commits.push({ digest: candidate.backendCodeDigest, mode });
  }

  async discardRuntime(): Promise<void> {}

  deactivateRuntime(): void {
    this.active = null;
    this.versions.clear();
  }

  hasRuntimeVersion(backendCodeDigest: string): boolean {
    return this.versions.has(backendCodeDigest);
  }

  addRuntimeReference(backendCodeDigest: string): boolean {
    if (!this.versions.has(backendCodeDigest)) return false;
    this.references.set(backendCodeDigest, (this.references.get(backendCodeDigest) ?? 0) + 1);
    return true;
  }

  removeRuntimeReference(backendCodeDigest: string): boolean {
    const count = this.references.get(backendCodeDigest) ?? 0;
    if (count === 0) return false;
    if (count === 1) this.references.delete(backendCodeDigest);
    else this.references.set(backendCodeDigest, count - 1);
    this.removedReferences.push(backendCodeDigest);
    return true;
  }

  retireRuntime(backendCodeDigest: string): boolean {
    if (backendCodeDigest === this.active || !this.versions.delete(backendCodeDigest)) return false;
    this.retired.push(backendCodeDigest);
    return true;
  }
}

interface Harness {
  dir: string;
  app: HostedApp<Prepared, Settings>;
  runtime: FakeRuntime;
}

const harnesses: Harness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.app.deactivate("test:cleanup");
    rmSync(harness.dir, { recursive: true, force: true });
  }
});

function harness(
  retainedLingerMs = 60_000,
  adapter: AppReleaseAdapter<Prepared, Settings> = new CoexistingAdapter(),
): Harness {
  const dir = mkdtempSync(join(tmpdir(), "hosted-version-routing-"));
  const registry = new AppReleaseRegistry({
    catalog: new MemoryReleaseCatalog(),
    content: new FileReleaseContentStore(join(dir, "content")),
  });
  const runtime = new FakeRuntime();
  const app = new HostedApp({ registry, adapter, runtime, retainedLingerMs });
  const value = { dir, app, runtime };
  harnesses.push(value);
  return value;
}

function install(h: Harness, release: ReleaseBundle): string {
  const installed = h.app.install(release, "test:installer");
  expect(installed.ok).toBe(true);
  if (!installed.ok) throw new Error("fixture release did not install");
  return installed.packageDigest;
}

describe("HostedApp retained releases", () => {
  it("previews an installed candidate without moving the pointer or committing a runtime", async () => {
    const h = harness();
    const oldDigest = install(h, bundle("old", "backend-old"));
    const nextDigest = install(h, bundle("next", "backend-next"));
    await h.app.activate(oldDigest, "test:activate");
    const beforeCommits = h.runtime.commits.length;
    const transitions: unknown[] = [];
    const unsubscribe = h.app.subscribe((_release, transition) => transitions.push(transition));

    const preview = await h.app.previewActivation(nextDigest);

    expect(preview).toMatchObject({
      ok: true,
      packageDigest: nextDigest,
      previousPackageDigest: oldDigest,
      permissionContractDigest: "c".repeat(64),
      coexistence: "multi_version",
      reason: null,
    });
    expect(h.app.activeRelease()?.prepared.descriptor.packageDigest).toBe(oldDigest);
    expect(h.runtime.commits).toHaveLength(beforeCommits);
    expect(transitions).toEqual([]);
    unsubscribe();
  });

  it("publishes transition metadata while distinguishing a changed activation from replay", async () => {
    const h = harness();
    const oldDigest = install(h, bundle("old", "backend-old"));
    const newDigest = install(h, bundle("new", "backend-new"));
    const transitions: unknown[] = [];
    const unsubscribe = h.app.subscribe((_release, transition) => transitions.push(transition));

    await h.app.activate(oldDigest, "test:activate");
    await h.app.activate(newDigest, "test:activate");
    await h.app.activate(newDigest, "test:replay");

    expect(transitions).toEqual([
      {
        previousPackageDigest: null,
        changed: true,
        coexistence: "multi_version",
        reason: null,
      },
      {
        previousPackageDigest: oldDigest,
        changed: true,
        coexistence: "multi_version",
        reason: null,
      },
      {
        previousPackageDigest: newDigest,
        changed: false,
        coexistence: "multi_version",
        reason: null,
      },
    ]);
    unsubscribe();
  });

  it("serves the replaced package until its last binding drains and linger expires", async () => {
    const h = harness(10);
    const oldDigest = install(h, bundle("old", "backend-old"));
    const newDigest = install(h, bundle("new", "backend-new"));
    expect((await h.app.activate(oldDigest, "test:activate")).ok).toBe(true);
    expect(h.app.addReleaseReference(oldDigest)).toBe(true);

    expect((await h.app.activate(newDigest, "test:activate")).ok).toBe(true);
    expect(h.runtime.commits.at(-1)?.mode).toBe("retain");
    expect(h.app.activeRelease()?.prepared.descriptor.packageDigest).toBe(newDigest);
    expect(h.app.servableRelease(oldDigest)?.prepared.descriptor.packageDigest).toBe(oldDigest);
    expect(h.app.servablePackageDigests()).toEqual(new Set([newDigest, oldDigest]));

    expect(h.app.removeReleaseReference(oldDigest)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(h.app.servableRelease(oldDigest)).toBeNull();
    expect(h.app.servablePackageDigests()).toEqual(new Set([newDigest]));
  });

  it("clears a retained timer when that package is promoted by rollback", async () => {
    const h = harness(10);
    const firstDigest = install(h, bundle("first", "backend-first"));
    const secondDigest = install(h, bundle("second", "backend-second"));
    await h.app.activate(firstDigest, "test:activate");
    await h.app.activate(secondDigest, "test:activate");
    await h.app.activate(firstDigest, "test:rollback");

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(h.app.activeRelease()?.prepared.descriptor.packageDigest).toBe(firstDigest);
    expect(h.app.servableRelease(firstDigest)?.prepared.descriptor.packageDigest).toBe(firstDigest);
    expect(h.app.servableRelease(secondDigest)).toBeNull();
  });

  it("uninstalls one View-only package without retiring a backend cohort another package still serves", async () => {
    const h = harness();
    const firstView = install(h, bundle("view-one", "shared-backend"));
    const secondView = install(h, bundle("view-two", "shared-backend"));
    const changedBackend = install(h, bundle("view-three", "changed-backend"));
    await h.app.activate(firstView, "test:activate");
    expect(h.app.addReleaseReference(firstView)).toBe(true);
    await h.app.activate(secondView, "test:activate");
    expect(h.app.addReleaseReference(secondView)).toBe(true);
    await h.app.activate(changedBackend, "test:activate");

    const sharedBackend = h.app.servableRelease(secondView)!.prepared.backendCodeDigest;
    expect(h.app.uninstall(firstView, "test:uninstall")).toEqual({ ok: true, changed: true });
    expect(h.app.servableRelease(firstView)).toBeNull();
    expect(h.app.servableRelease(secondView)).not.toBeNull();
    expect(h.runtime.retired).not.toContain(sharedBackend);

    // The removed package's binding closes later. Its package mapping is gone,
    // but the recorded backend identity still releases the shared Runtime ref.
    expect(h.app.removeReleaseReference(firstView)).toBe(true);
    expect(h.runtime.removedReferences).toContain(sharedBackend);
    expect(h.runtime.references.get(sharedBackend)).toBe(1);

    expect(h.app.uninstall(secondView, "test:uninstall")).toEqual({ ok: true, changed: true });
    expect(h.runtime.retired).toContain(sharedBackend);
  });

  it("forgets a retained package as soon as its backend cohort is force-retired", async () => {
    const h = harness();
    const oldDigest = install(h, bundle("old", "backend-old"));
    const newDigest = install(h, bundle("new", "backend-new"));
    await h.app.activate(oldDigest, "test:activate");
    expect(h.app.addReleaseReference(oldDigest)).toBe(true);
    await h.app.activate(newDigest, "test:activate");
    const oldBackend = h.app.servableRelease(oldDigest)!.prepared.backendCodeDigest;
    h.runtime.versions.delete(oldBackend);

    expect(h.app.servableRelease(oldDigest)).toBeNull();
    expect(h.app.servablePackageDigests()).toEqual(new Set([newDigest]));
  });

  it("fails safe to refresh_required when an adapter declares no coexistence rules", async () => {
    const h = harness(60_000, new LegacyAdapter());
    const oldDigest = install(h, bundle("old", "backend-old"));
    const newDigest = install(h, bundle("new", "backend-new"));
    await h.app.activate(oldDigest, "test:activate");

    const moved = await h.app.activate(newDigest, "test:activate");
    expect(moved).toMatchObject({
      ok: true,
      changed: true,
      coexistence: "refresh_required",
      reason: "adapter_does_not_support_coexistence",
    });
    expect(h.runtime.commits.at(-1)?.mode).toBe("swap");
    expect(h.runtime.versions).toEqual(new Set([h.app.activeRelease()!.prepared.backendCodeDigest]));
    expect(h.app.servableRelease(oldDigest)).toBeNull();
  });
});
