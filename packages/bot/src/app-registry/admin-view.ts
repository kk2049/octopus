/**
 * What the local App management page is allowed to be told.
 *
 * A projection rather than the domain objects, for two reasons that are not the
 * same reason:
 *
 *  · **Local paths never cross.** `InstalledRelease.contentRoot` and the
 *    materialised `appDir` are filesystem facts about this host. They are useful
 *    to an operator with a shell and useless in a browser, and a page that
 *    printed them would be teaching every reader where to aim.
 *  · **Artifact bytes never cross.** The page shows the inventory — name, digest,
 *    size — which is what "is this the release I built?" needs. Shipping the
 *    bytes would make a read of the admin page a download of publisher code.
 *
 * Everything here is already public in the sense that matters: the package digest
 * addresses a hostname, and the descriptor is what the registry re-validates on
 * every read.
 */

import type { AppReleaseDescriptor, InstalledRelease, RegistryIssue } from "@claude-bot/app-registry";
import type { AdapterCompatibility } from "./adapter.js";

export interface AppReleaseAssetView {
  name: string;
  sha256: string;
  bytes: number;
}

export interface AppReleaseView {
  packageDigest: string;
  hostLabel: string;
  stableAppId: string;
  publisher: string;
  executionProfile: string;
  permissionContractDigest: string;
  assets: AppReleaseAssetView[];
  totalBytes: number;
  composition: { view: string[]; backend: string[] };
  source: { kind: string; digest: string; repository: string; commit: string; subdir: string };
  buildInput: {
    entry: string;
    toolchain: { builder: string; format: string; lockfile: string };
    lockfileHash: string;
  };
  provenance: { kind: string; builder: string; statement: string; signatureVerification: string };
  installedBy: string;
  installedAt: string;
  removedBy: string | null;
  removedAt: string | null;
  active: boolean;
  /** Present only for the active release. */
  activatedBy?: string;
  activatedAt?: string;
  /**
   * Whether this build could run it at all, and why not when it could not.
   *
   * The code is a plain string here on purpose: refusal vocabularies belong to
   * each app's adapter, and a projection that enumerated one app's codes would
   * have to be edited every time another app gained a reason of its own.
   */
  supported: boolean;
  unsupportedCode?: string;
  unsupportedReason?: string;
}

/** One app's backend children, as its supervisor reports them. */
export interface AppBackendStatusView {
  state: string;
  runtime: string;
  statePid: number | null;
  runtimePid: number | null;
}

/** Everything the management page may be told about ONE app. */
export interface AppRegistryView {
  /** The app this block manages. */
  stableAppId: string;
  publisher: string;
  /** The origin the active release is served from, or null when none is. */
  activeViewOrigin: string | null;
  activePackageDigest: string | null;
  /** Whether this checkout's package is already installed, and its digest. */
  checkout: { packageDigest: string; hostLabel: string; installed: boolean } | null;
  /** Why nothing is being served, when that is the case. */
  unavailable: { code: string; message: string; issues?: RegistryIssue[] } | null;
  /** This app's backend process health, as its own supervisor reports it. */
  runtime: AppBackendStatusView | null;
  releases: AppReleaseView[];
}

/**
 * The whole management page: every app this host serves, plus one reconciliation.
 *
 * Reconciliation sits at THIS level rather than inside each app because it is a
 * fact about the registry's content store as a whole — an orphaned artifact
 * belongs to no app by definition, so attributing it to one would be an
 * invention, and running the scan once per app would make reading the page cost
 * a filesystem walk per entry.
 */
export interface AppRegistryDirectoryView {
  apps: AppRegistryView[];
  /** Catalog vs. manifests/file metadata. Digests and counts only; never a path. */
  reconcile: {
    /** Directory health does not claim a full historical content audit. */
    verification: "manifest";
    activeUnusable: Array<{ packageDigest: string; code: string; message: string }>;
    installedUnusable: Array<{ packageDigest: string; code: string; message: string }>;
    undescribable: string[];
    orphanContent: number;
  };
}

export function describeAsset(descriptor: AppReleaseDescriptor): AppReleaseAssetView[] {
  return descriptor.assets.map((asset) => ({ name: asset.name, sha256: asset.sha256, bytes: asset.bytes }));
}

export function releaseView(input: {
  release: InstalledRelease;
  active: boolean;
  hostLabel: string;
  compatibility: AdapterCompatibility;
  activatedBy?: string;
  activatedAt?: string;
}): AppReleaseView {
  const d = input.release.descriptor;
  const assets = describeAsset(d);
  return {
    packageDigest: d.packageDigest,
    hostLabel: input.hostLabel,
    stableAppId: d.stableAppId,
    publisher: d.publisher,
    executionProfile: d.executionProfile,
    permissionContractDigest: d.permissionContractDigest,
    assets,
    totalBytes: assets.reduce((sum, asset) => sum + asset.bytes, 0),
    composition: { view: [...d.composition.view], backend: [...d.composition.backend] },
    source: { ...d.source },
    buildInput: {
      entry: d.buildInput.entry,
      toolchain: { ...d.buildInput.toolchain },
      lockfileHash: d.buildInput.lockfileHash,
    },
    provenance: { ...input.release.provenance },
    installedBy: input.release.installedBy,
    installedAt: input.release.installedAt,
    removedBy: input.release.removedBy,
    removedAt: input.release.removedAt,
    active: input.active,
    ...(input.activatedBy ? { activatedBy: input.activatedBy } : {}),
    ...(input.activatedAt ? { activatedAt: input.activatedAt } : {}),
    supported: input.compatibility.supported,
    ...(input.compatibility.supported
      ? {}
      : { unsupportedCode: input.compatibility.code, unsupportedReason: input.compatibility.message }),
  };
}
