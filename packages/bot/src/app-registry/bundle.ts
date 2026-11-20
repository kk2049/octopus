/**
 * A release bundle: the transport shape every Agentic App is installed through.
 *
 * ── Why this is app-agnostic, and lives on its own ──────────────────────────
 *
 * A bundle is a descriptor, a provenance statement and a list of named byte
 * arrays. Nothing in it is about Session Plus, React or any particular app —
 * the registry recomputes every digest from the bytes it is handed, so this
 * module decides only whether a document is a bundle AT ALL and whether it is
 * bounded. Keeping it apart from the Session Plus builder is what lets the
 * platform core (`adapter.ts`, `hosted-app.ts`, `release-host.ts`) talk about
 * installable releases without importing one app's packaging code.
 *
 * Base64 in one JSON document rather than a multipart upload: the whole
 * artifact goes through the same body limit, the same content-type parser and
 * the same mutation gate as any other request. A second transport for "but this
 * one is big" is a second set of rules to get right.
 */

import type { AppReleaseDescriptor, InstallProvenance } from "@claude-bot/app-registry";

/** One installable release: what it is, and the exact bytes it is made of. */
export interface ReleaseBundle {
  descriptor: AppReleaseDescriptor;
  assets: Array<{ name: string; content: Uint8Array }>;
  provenance: InstallProvenance;
}

/**
 * The wire form of a bundle — what the packer writes and the install API takes.
 *
 * Base64 rather than a multipart upload: the whole artifact is one bounded JSON
 * document that the same body limit, the same content-type parser and the same
 * mutation gate see as any other request. A second transport for "but this one
 * is big" is a second set of rules to get right.
 */
export interface ReleaseBundleWire {
  kind: "octopus.app-release-bundle";
  schemaVersion: 1;
  descriptor: AppReleaseDescriptor;
  provenance: InstallProvenance;
  assets: Array<{ name: string; base64: string }>;
}

export const BUNDLE_KIND = "octopus.app-release-bundle";

export function bundleToWire(bundle: ReleaseBundle): ReleaseBundleWire {
  return {
    kind: BUNDLE_KIND,
    schemaVersion: 1,
    descriptor: bundle.descriptor,
    provenance: bundle.provenance,
    assets: bundle.assets.map((asset) => ({
      name: asset.name,
      base64: Buffer.from(asset.content).toString("base64"),
    })),
  };
}

export type BundleParse =
  | { ok: true; bundle: ReleaseBundle }
  | { ok: false; error: string };

/** Bounds applied before a byte is decoded, so a hostile bundle cannot be large. */
export interface BundleLimits {
  maxAssets: number;
  maxAssetBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_BUNDLE_LIMITS: BundleLimits = Object.freeze({
  maxAssets: 64,
  // Session Plus keeps PDF.js, its loopback worker and the local Mermaid layout
  // engine in one sandbox document. Six MiB admits the reviewed 5.64 MiB View
  // while the 8 MiB release ceiling still bounds aggregate decode and storage.
  maxAssetBytes: 6 * 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
});

/**
 * Read an untrusted bundle document.
 *
 * Shape only: this function decides nothing about whether the release is valid,
 * because that is `install()`'s job and there must not be two opinions. What it
 * does do is refuse anything unbounded before allocating for it, and refuse a
 * base64 string that does not round-trip — a decoder that silently drops
 * invalid characters would hand `install()` different bytes than the sender
 * believed it sent, and the digest mismatch would then read as a build problem.
 */
export function parseBundle(value: unknown, limits: BundleLimits = DEFAULT_BUNDLE_LIMITS): BundleParse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "bundle 不是一个 JSON 对象" };
  const row = value as Record<string, unknown>;
  if (row.kind !== BUNDLE_KIND) return { ok: false, error: `bundle.kind 必须是 ${BUNDLE_KIND}` };
  if (row.schemaVersion !== 1) return { ok: false, error: "bundle.schemaVersion 必须是 1" };
  if (!row.descriptor || typeof row.descriptor !== "object" || Array.isArray(row.descriptor)) {
    return { ok: false, error: "bundle.descriptor 缺失" };
  }
  if (!row.provenance || typeof row.provenance !== "object" || Array.isArray(row.provenance)) {
    return { ok: false, error: "bundle.provenance 缺失" };
  }
  if (!Array.isArray(row.assets)) return { ok: false, error: "bundle.assets 必须是数组" };
  if (row.assets.length > limits.maxAssets) return { ok: false, error: `bundle.assets 超过 ${limits.maxAssets} 个` };

  const assets: Array<{ name: string; content: Uint8Array }> = [];
  let total = 0;
  for (const raw of row.assets) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "bundle.assets 含非对象条目" };
    const entry = raw as Record<string, unknown>;
    const name = typeof entry.name === "string" ? entry.name : "";
    const base64 = typeof entry.base64 === "string" ? entry.base64 : "";
    if (!name) return { ok: false, error: "bundle.assets 条目缺少 name" };
    if (base64.length > Math.ceil(limits.maxAssetBytes / 3) * 4 + 4) {
      return { ok: false, error: `bundle 资产 ${clip(name)} 超过单个上限` };
    }
    const content = Buffer.from(base64, "base64");
    if (content.toString("base64").replace(/=+$/, "") !== base64.replace(/=+$/, "")) {
      return { ok: false, error: `bundle 资产 ${clip(name)} 的 base64 不能原样还原` };
    }
    total += content.byteLength;
    if (content.byteLength > limits.maxAssetBytes) return { ok: false, error: `bundle 资产 ${clip(name)} 过大` };
    if (total > limits.maxTotalBytes) return { ok: false, error: "bundle 总字节超过上限" };
    assets.push({ name, content: new Uint8Array(content) });
  }
  return {
    ok: true,
    bundle: {
      descriptor: row.descriptor as AppReleaseDescriptor,
      provenance: row.provenance as InstallProvenance,
      assets,
    },
  };
}

function clip(name: string): string {
  return name.replace(/[\x00-\x1f\x7f]/g, "�").slice(0, 80);
}
