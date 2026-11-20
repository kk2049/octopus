import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileReleaseContentStore } from "./content-store.js";
import { describeRelease, utf8Bytes, type AppReleaseDescriptor, type ReleaseSpec } from "./descriptor.js";
import { MemoryReleaseCatalog } from "./memory-catalog.js";
import type { InstallProvenance, ReleaseCatalogRepository } from "./ports.js";
import { AppReleaseRegistry, type RegistryEvent } from "./registry.js";

const temps: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

function tempRoot(): string {
  const base = mkdtempSync(path.join(tmpdir(), "app-registry-"));
  temps.push(base);
  return path.join(base, "artifacts");
}

function spec(overrides: Partial<ReleaseSpec> = {}): ReleaseSpec {
  return {
    stableAppId: "demo-app",
    publisher: "octopus:first-party",
    executionProfile: "publisher-js",
    permissionContractDigest: "9f".repeat(16),
    assets: [
      { name: "index.html", content: utf8Bytes("<!doctype html><title>demo</title>") },
      { name: "main.js", content: utf8Bytes("export const boot = () => {};") },
    ],
    composition: { view: ["index.html", "main.js"], backend: [] },
    source: {
      kind: "platform-hosted",
      digest: "sha256:demo",
      repository: "platform://octopus/source",
      commit: "0f".repeat(20),
      subdir: "packages/demo-app",
    },
    buildInput: {
      entry: "app.yaml",
      toolchain: { builder: "octopus:app-release-v1", format: "named-assets", lockfile: "pnpm-lock.yaml" },
      lockfileHash: "ab".repeat(32),
    },
    ...overrides,
  };
}

const PROVENANCE: InstallProvenance = {
  kind: "platform-built",
  builder: "octopus:release-builder",
  statement: "Built by this platform from the declared source snapshot.",
  signatureVerification: "none",
};

interface Harness {
  registry: AppReleaseRegistry;
  catalog: ReleaseCatalogRepository;
  content: FileReleaseContentStore;
  events: RegistryEvent[];
  root: string;
}

function harness(options: { root?: string; catalog?: ReleaseCatalogRepository } = {}): Harness {
  const root = options.root ?? tempRoot();
  const catalog = options.catalog ?? new MemoryReleaseCatalog();
  const content = new FileReleaseContentStore(root);
  let tick = 0;
  const registry = new AppReleaseRegistry({
    catalog,
    content,
    now: () => new Date(Date.UTC(2026, 7, 6, 0, 0, (tick += 1))).toISOString(),
  });
  const events: RegistryEvent[] = [];
  registry.subscribe((event) => events.push(event));
  return { registry, catalog, content, events, root };
}

function install(h: Harness, input: ReleaseSpec = spec(), provenance = PROVENANCE) {
  const descriptor = describeRelease(input);
  return { descriptor, result: h.registry.install({ descriptor, assets: input.assets, provenance, installedBy: "ops:lht" }) };
}

describe("install", () => {
  it("stores the artifact before the row that references it", () => {
    const h = harness();
    const { descriptor, result } = install(h);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deduplicated).toBe(false);
    expect(h.content.verify(descriptor.packageDigest, descriptor.assets).ok).toBe(true);
    expect(h.catalog.getRelease(descriptor.packageDigest)?.contentRoot).toBe(h.content.root);
    expect(Buffer.from(h.registry.readAsset(descriptor.packageDigest, "main.js")!).toString()).toContain("boot");
  });

  it("is idempotent for identical content", () => {
    const h = harness();
    const first = install(h);
    const second = install(h);
    expect(first.result.ok && second.result.ok).toBe(true);
    if (!second.result.ok) return;
    expect(second.result.deduplicated).toBe(true);
    expect(h.events.filter((event) => event.type === "release_installed")).toHaveLength(1);
    expect(h.registry.list()).toHaveLength(1);
  });

  it("refuses to reuse a package digest for a different permission contract", () => {
    // Same bytes, wider ask. Accepting it would let one artifact mean two
    // different things; silently keeping the old one would report a consent
    // decision nobody made.
    const h = harness();
    install(h);
    const other = describeRelease(spec({ permissionContractDigest: "0c".repeat(16) }));
    const result = h.registry.install({
      descriptor: other,
      assets: spec().assets,
      provenance: PROVENANCE,
      installedBy: "ops:lht",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]!.code).toBe("descriptor_conflict");
  });

  it("refuses to reuse a package digest under a different provenance record", () => {
    const h = harness();
    install(h);
    const result = install(h, spec(), {
      kind: "external-attestation",
      builder: "someone-else",
      statement: "Arrived prebuilt.",
      signatureVerification: "none",
    }).result;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]!.code).toBe("provenance_conflict");
  });

  it("refuses a provenance that claims signature verification", () => {
    const h = harness();
    const result = install(h, spec(), {
      ...PROVENANCE,
      signatureVerification: "verified" as unknown as "none",
    }).result;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]!.code).toBe("signature_verification");
    expect(h.registry.list()).toHaveLength(0);
  });

  it("writes nothing at all when the candidate fails validation", () => {
    const h = harness();
    const descriptor = describeRelease(spec());
    const tampered = { ...descriptor, packageDigest: "0".repeat(64) };
    const result = h.registry.install({
      descriptor: tampered,
      assets: spec().assets,
      provenance: PROVENANCE,
      installedBy: "ops:lht",
    });
    expect(result.ok).toBe(false);
    expect(h.registry.list()).toHaveLength(0);
    expect(h.content.listStored()).toEqual([]);
    expect(h.events).toEqual([]);
  });

  it("reports a failed artifact write instead of recording a release", () => {
    const root = tempRoot();
    const catalog = new MemoryReleaseCatalog();
    const content = new FileReleaseContentStore(root, {
      fault: (point) => {
        if (point === "before_manifest_rename") throw new Error("disk full");
      },
    });
    const registry = new AppReleaseRegistry({ catalog, content });
    const input = spec();
    const result = registry.install({
      descriptor: describeRelease(input),
      assets: input.assets,
      provenance: PROVENANCE,
      installedBy: "ops:lht",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]!.code).toBe("content_write_failed");
    expect(registry.list()).toHaveLength(0);
  });

  it("restores the artifact when a row survived a crash that lost it", () => {
    const h = harness();
    const { descriptor } = install(h);
    unlinkSync(path.join(h.root, "releases", `${descriptor.packageDigest}.json`));
    expect(h.registry.resolveActive("demo-app", "octopus:first-party").ok).toBe(false);

    const again = install(h);
    expect(again.result.ok).toBe(true);
    if (!again.result.ok) return;
    expect(again.result.deduplicated).toBe(true);
    expect(h.content.verify(descriptor.packageDigest, descriptor.assets).ok).toBe(true);
  });
});

describe("activation", () => {
  it("moves the pointer and reports what it replaced", () => {
    const h = harness();
    const first = install(h).descriptor;
    const second = install(h, spec({ assets: [...spec().assets, { name: "extra.js", content: utf8Bytes("1") }] })).descriptor;
    expect(second.packageDigest).not.toBe(first.packageDigest);

    const one = h.registry.activate("demo-app", "octopus:first-party", first.packageDigest, "ops:lht");
    expect(one.ok && one.previousPackageDigest).toBeNull();
    const two = h.registry.activate("demo-app", "octopus:first-party", second.packageDigest, "ops:lht");
    expect(two.ok).toBe(true);
    if (!two.ok) return;
    expect(two.previousPackageDigest).toBe(first.packageDigest);
    expect(two.changed).toBe(true);

    const again = h.registry.activate("demo-app", "octopus:first-party", second.packageDigest, "ops:lht");
    expect(again.ok && again.changed).toBe(false);
    expect(h.events.filter((event) => event.type === "release_activated")).toHaveLength(2);
  });

  it("leaves the previous release active when the candidate is not usable", () => {
    const h = harness();
    const good = install(h).descriptor;
    const bad = install(h, spec({ assets: [...spec().assets, { name: "extra.js", content: utf8Bytes("1") }] })).descriptor;
    h.registry.activate("demo-app", "octopus:first-party", good.packageDigest, "ops:lht");

    // The candidate's artifact goes missing after install.
    unlinkSync(path.join(h.root, "releases", `${bad.packageDigest}.json`));
    const result = h.registry.activate("demo-app", "octopus:first-party", bad.packageDigest, "ops:lht");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]!.code).toBe("content_missing");

    const active = h.registry.resolveActive("demo-app", "octopus:first-party");
    expect(active.ok).toBe(true);
    if (!active.ok) return;
    expect(active.release.descriptor.packageDigest).toBe(good.packageDigest);
    expect(h.events.filter((event) => event.type === "release_activated")).toHaveLength(1);
  });

  it("refuses a release belonging to another app or publisher", () => {
    const h = harness();
    const other = install(h, spec({ stableAppId: "other-app" })).descriptor;
    const result = h.registry.activate("demo-app", "octopus:first-party", other.packageDigest, "ops:lht");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]!.code).toBe("identity_mismatch");
  });

  it("refuses an unknown release", () => {
    const h = harness();
    const result = h.registry.activate("demo-app", "octopus:first-party", "f".repeat(64), "ops:lht");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]!.code).toBe("unknown_release");
  });

  it("gives concurrent activations one deterministic winner", () => {
    // The catalog is the serializer. Two callers racing on the same pointer
    // both get a truthful answer about what they replaced, and the pointer ends
    // up holding exactly one of the two.
    const h = harness();
    const a = install(h).descriptor;
    const b = install(h, spec({ assets: [...spec().assets, { name: "extra.js", content: utf8Bytes("1") }] })).descriptor;
    const first = h.registry.activate("demo-app", "octopus:first-party", a.packageDigest, "ops:one");
    const second = h.registry.activate("demo-app", "octopus:first-party", b.packageDigest, "ops:two");
    expect(first.ok && second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.previousPackageDigest).toBe(a.packageDigest);
    expect(h.catalog.getActive("demo-app", "octopus:first-party")?.packageDigest).toBe(b.packageDigest);
  });
});

describe("resolving the active release", () => {
  it("fails closed when the artifact is missing", () => {
    const h = harness();
    const { descriptor } = install(h);
    h.registry.activate("demo-app", "octopus:first-party", descriptor.packageDigest, "ops:lht");
    unlinkSync(path.join(h.root, "releases", `${descriptor.packageDigest}.json`));

    const result = h.registry.resolveActive("demo-app", "octopus:first-party");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]!.code).toBe("content_missing");
    expect(result.issues[0]!.at).toBe(descriptor.packageDigest);
  });

  it("fails closed when the artifact is corrupt", () => {
    const h = harness();
    const { descriptor } = install(h);
    h.registry.activate("demo-app", "octopus:first-party", descriptor.packageDigest, "ops:lht");
    const asset = descriptor.assets.find((row) => row.name === "main.js")!;
    writeFileSync(path.join(h.root, "blobs", asset.sha256.slice(0, 2), asset.sha256), "x".repeat(asset.bytes - 1));

    const result = h.registry.resolveActive("demo-app", "octopus:first-party");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]!.code).toBe("content_corrupt");
    expect(h.registry.readAsset(descriptor.packageDigest, "main.js")).toBeNull();
  });

  it("fails closed when the stored descriptor cannot be re-validated", () => {
    // A downgraded binary or a damaged row. Serving a release nobody in this
    // process can describe is exactly the state to refuse.
    const catalog = new MemoryReleaseCatalog();
    const h = harness({ catalog });
    const { descriptor } = install(h);
    h.registry.activate("demo-app", "octopus:first-party", descriptor.packageDigest, "ops:lht");
    const row = catalog.getRelease(descriptor.packageDigest)!;
    const damaged = JSON.parse(row.descriptor) as Record<string, unknown>;
    damaged.futureField = true;
    (catalog as unknown as { releases: Map<string, typeof row> }).releases.set(descriptor.packageDigest, {
      ...row,
      descriptor: JSON.stringify(damaged),
    });

    const result = h.registry.resolveActive("demo-app", "octopus:first-party");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]!.code).toBe("descriptor_invalid");
    expect(h.registry.list()).toHaveLength(0);
    expect(h.registry.reconcile().undescribable).toHaveLength(1);
  });

  it("says so plainly when nothing is active", () => {
    const h = harness();
    install(h);
    const result = h.registry.resolveActive("demo-app", "octopus:first-party");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]!.code).toBe("not_active");
  });
});

describe("deactivate and uninstall", () => {
  it("removes reachability without erasing anything", () => {
    const h = harness();
    const { descriptor } = install(h);
    h.registry.activate("demo-app", "octopus:first-party", descriptor.packageDigest, "ops:lht");

    const result = h.registry.deactivate("demo-app", "octopus:first-party");
    expect(result.ok && result.changed).toBe(true);
    expect(h.registry.resolveActive("demo-app", "octopus:first-party").ok).toBe(false);
    // The release, its artifact and its bytes are all still here.
    expect(h.registry.inspect(descriptor.packageDigest).ok).toBe(true);
    expect(h.registry.readAsset(descriptor.packageDigest, "main.js")).not.toBeNull();
    expect(h.content.verify(descriptor.packageDigest, descriptor.assets).ok).toBe(true);

    // And it can be reactivated, which is what makes the history worth keeping.
    expect(h.registry.activate("demo-app", "octopus:first-party", descriptor.packageDigest, "ops:lht").ok).toBe(true);
  });

  it("is a no-op when nothing was active", () => {
    const h = harness();
    const result = h.registry.deactivate("demo-app", "octopus:first-party");
    expect(result).toEqual({ ok: true, previousPackageDigest: null, changed: false });
    expect(h.events).toEqual([]);
  });

  it("refuses to uninstall the active release", () => {
    const h = harness();
    const { descriptor } = install(h);
    h.registry.activate("demo-app", "octopus:first-party", descriptor.packageDigest, "ops:lht");
    const result = h.registry.uninstall(descriptor.packageDigest, "ops:lht");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]!.code).toBe("active_release");
  });

  it("hides uninstalled metadata but keeps the artifact and the row", () => {
    const h = harness();
    const { descriptor } = install(h);
    expect(h.registry.uninstall(descriptor.packageDigest, "ops:lht")).toEqual({ ok: true, changed: true });
    expect(h.registry.list()).toHaveLength(0);
    expect(h.registry.list({ includeRemoved: true })).toHaveLength(1);
    expect(h.registry.readAsset(descriptor.packageDigest, "main.js")).toBeNull();
    // Uninstalled means unreachable, not runnable-if-you-ask-nicely.
    expect(h.registry.activate("demo-app", "octopus:first-party", descriptor.packageDigest, "ops:lht").ok).toBe(false);
    expect(h.registry.uninstall(descriptor.packageDigest, "ops:lht")).toEqual({ ok: true, changed: false });
  });
});

describe("committed events", () => {
  it("emits in order, after the change, and never for a rejected one", () => {
    const h = harness();
    const { descriptor } = install(h);
    h.registry.activate("demo-app", "octopus:first-party", descriptor.packageDigest, "ops:lht");
    h.registry.install({ descriptor, assets: spec().assets, provenance: PROVENANCE, installedBy: "ops:lht" });
    h.registry.activate("demo-app", "octopus:first-party", "f".repeat(64), "ops:lht");
    h.registry.deactivate("demo-app", "octopus:first-party");
    h.registry.uninstall(descriptor.packageDigest, "ops:lht");

    expect(h.events.map((event) => event.type)).toEqual([
      "release_installed",
      "release_activated",
      "release_deactivated",
      "release_uninstalled",
    ]);
  });

  it("carries no secret and no authority", () => {
    const h = harness();
    const { descriptor } = install(h);
    expect(h.events[0]).toEqual({
      type: "release_installed",
      stableAppId: "demo-app",
      publisher: "octopus:first-party",
      packageDigest: descriptor.packageDigest,
      at: expect.any(String),
    });
  });

  it("sees the committed state from inside a listener", () => {
    const catalog = new MemoryReleaseCatalog();
    const content = new FileReleaseContentStore(tempRoot());
    const registry = new AppReleaseRegistry({ catalog, content });
    const seen: Array<string | null> = [];
    registry.subscribe((event) => {
      if (event.type === "release_activated") {
        seen.push(catalog.getActive(event.stableAppId, event.publisher)?.packageDigest ?? null);
      }
    });
    const input = spec();
    const descriptor = describeRelease(input);
    registry.install({ descriptor, assets: input.assets, provenance: PROVENANCE, installedBy: "ops:lht" });
    registry.activate("demo-app", "octopus:first-party", descriptor.packageDigest, "ops:lht");
    expect(seen).toEqual([descriptor.packageDigest]);
  });

  it("keeps going when a listener throws", () => {
    const h = harness();
    const errors: unknown[] = [];
    const registry = new AppReleaseRegistry({
      catalog: h.catalog,
      content: h.content,
      onListenerError: (error) => errors.push(error),
    });
    const seen: RegistryEvent[] = [];
    registry.subscribe(() => {
      throw new Error("subscriber is broken");
    });
    registry.subscribe((event) => seen.push(event));
    const input = spec();
    const result = registry.install({
      descriptor: describeRelease(input),
      assets: input.assets,
      provenance: PROVENANCE,
      installedBy: "ops:lht",
    });
    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });

  it("stops delivering after unsubscribe", () => {
    const h = harness();
    const seen: RegistryEvent[] = [];
    const stop = h.registry.subscribe((event) => seen.push(event));
    install(h);
    stop();
    install(h, spec({ assets: [...spec().assets, { name: "extra.js", content: utf8Bytes("1") }] }));
    expect(seen).toHaveLength(1);
  });
});

describe("reconciliation", () => {
  it("keeps directory scans metadata-only while real reads and full audits reject same-size corruption", () => {
    const h = harness();
    const { descriptor } = install(h);
    h.registry.activate("demo-app", "octopus:first-party", descriptor.packageDigest, "ops:lht");
    const fullCheck = vi.spyOn(h.content, "verify");
    const asset = descriptor.assets.find((entry) => entry.name === "main.js")!;
    writeFileSync(path.join(h.root, "blobs", asset.sha256.slice(0, 2), asset.sha256), Buffer.alloc(asset.bytes, 120));

    expect(h.registry.reconcile({ verification: "manifest" }).activeUnusable).toEqual([]);
    expect(fullCheck).not.toHaveBeenCalled();
    expect(h.registry.readAsset(descriptor.packageDigest, "main.js")).toBeNull();
    expect(h.registry.reconcile().activeUnusable).toEqual([
      expect.objectContaining({ packageDigest: descriptor.packageDigest, issue: expect.objectContaining({ code: "content_corrupt" }) }),
    ]);
    expect(fullCheck).toHaveBeenCalled();
    expect(h.catalog.getActive("demo-app", "octopus:first-party")?.packageDigest).toBe(descriptor.packageDigest);
  });

  it("reports orphan content without touching it", () => {
    const h = harness();
    const { descriptor } = install(h);
    // Simulate the crash window: the artifact landed, the row never did.
    const orphan = describeRelease(spec({ assets: [{ name: "solo.js", content: utf8Bytes("orphan") }], composition: { view: ["solo.js"], backend: [] } }));
    h.content.put(orphan.packageDigest, [
      { name: "solo.js", sha256: orphan.assets[0]!.sha256, bytes: orphan.assets[0]!.bytes, content: utf8Bytes("orphan") },
    ]);

    const report = h.registry.reconcile();
    expect(report.orphanContent).toEqual([orphan.packageDigest]);
    expect(report.activeUnusable).toEqual([]);
    expect(h.content.verify(orphan.packageDigest, orphan.assets).ok).toBe(true);
    expect(h.content.verify(descriptor.packageDigest, descriptor.assets).ok).toBe(true);
  });

  it.each(["content", "manifest"] as const)("separates an unusable active pointer from an unusable spare (%s)", (verification) => {
    const h = harness();
    const active = install(h).descriptor;
    const spare = install(h, spec({ assets: [...spec().assets, { name: "extra.js", content: utf8Bytes("1") }] })).descriptor;
    h.registry.activate("demo-app", "octopus:first-party", active.packageDigest, "ops:lht");
    unlinkSync(path.join(h.root, "releases", `${active.packageDigest}.json`));
    unlinkSync(path.join(h.root, "releases", `${spare.packageDigest}.json`));

    const report = h.registry.reconcile({ verification });
    expect(report.activeUnusable.map((row) => row.packageDigest)).toEqual([active.packageDigest]);
    expect(report.installedUnusable.map((row) => row.packageDigest)).toEqual([spare.packageDigest]);
  });
});

describe("restart", () => {
  it("resolves the same active release from a fresh registry over the same data", () => {
    const root = tempRoot();
    const catalog = new MemoryReleaseCatalog();
    const first = harness({ root, catalog });
    const { descriptor } = install(first);
    first.registry.activate("demo-app", "octopus:first-party", descriptor.packageDigest, "ops:lht");

    // A new process over the same durable state: same catalog rows, same
    // content root, no in-memory carry-over in the service itself.
    const second = harness({ root, catalog });
    const resolved = second.registry.resolveActive("demo-app", "octopus:first-party");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.release.descriptor).toEqual(descriptor as AppReleaseDescriptor);
    expect(resolved.release.provenance).toEqual(PROVENANCE);
    expect(resolved.release.activatedBy).toBe("ops:lht");
    expect(Buffer.from(second.registry.readAsset(descriptor.packageDigest, "index.html")!).toString()).toContain("demo");
  });
});
