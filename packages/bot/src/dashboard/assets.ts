/**
 * Serving the built browser bundle.
 *
 * ── The three properties this file exists to hold ───────────────────────────
 *
 *  1. **The manifest is the only place filenames live.** `vite build` writes
 *     `.vite/manifest.json`; this reads it and hands the hashed names to the
 *     page renderer. Nothing spells an asset name twice, so a rebuild cannot
 *     leave the HTML pointing at a file that no longer exists.
 *  2. **Content-addressed means `immutable` is safe.** Every file under
 *     `/ui/a/` carries a content hash, so a year-long cache can never serve
 *     stale bytes for a name that means something else. The HTML shell is
 *     `no-store` for the opposite reason: it is the thing that names the
 *     hashes.
 *  3. **A static file server is a path-traversal bug waiting to happen.** The
 *     request path is resolved and then checked to be inside the root, the
 *     content type comes from a small allow-list rather than from the request,
 *     and anything else is a 404. There is no directory listing and no index
 *     fallback: this namespace serves exactly the files the build produced.
 *
 * The bundle is not secret and carries no credential, so it is served before the
 * identity gate — the login page needs it, which is the whole reason. That is
 * also why it is classified as a pre-route in `authz.ts` rather than being an
 * unnamed hole in the router.
 */

import { readFile, realpath, stat } from "node:fs/promises";
import { readFileSync, mkdirSync, readdirSync, copyFileSync, constants } from "node:fs";
import { APP_RUNTIME_IMPORTS, runtimeEntryName } from "@claude-bot/agent-view-build/runtime";
import path from "node:path";
import { createHash } from "node:crypto";
import { DASHBOARD_WEB_BASE, DASHBOARD_WEB_DIST } from "@claude-bot/dashboard-web";

/** Content types this namespace will serve. Anything else is a 404. */
const TYPES: Readonly<Record<string, string>> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

export interface BundleManifest {
  /** URL of the entry module, e.g. `/ui/a/app-abc123.js`. */
  script: string;
  /** URLs of the stylesheets the entry pulls in. */
  styles: string[];
  /**
   * Short content hash of the entry, reported to the browser so an open tab can
   * notice that a new version was published.
   */
  buildId: string;
  /** Bare ESM specifier -> immutable shared-runtime entry. */
  imports?: Record<string, string>;
}

interface ViteManifestEntry {
  file: string;
  css?: string[];
  isEntry?: boolean;
  name?: string;
}

let cached: BundleManifest | null = null;

/**
 * Read the build manifest, once.
 *
 * Deliberately synchronous and at first use rather than at import: the bot has
 * compositions that never serve a page (tests, the MCP servers), and making
 * every one of them fail because a frontend build is missing would be wrong.
 * What must fail loudly is a REQUEST for a page when the bundle is absent, and
 * that is what the thrown error does.
 */
export function bundleManifest(distDir: string = DASHBOARD_WEB_DIST): BundleManifest {
  if (cached) return cached;
  const manifestPath = path.join(distDir, ".vite", "manifest.json");
  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch {
    throw new Error(
      `dashboard bundle is missing (${manifestPath}) — run \`pnpm -r build\` on the bot host`,
    );
  }
  const parsed = JSON.parse(raw) as Record<string, ViteManifestEntry>;
  const entry =
    parsed["src/main.tsx"] ?? Object.values(parsed).find((candidate) => candidate.isEntry && candidate.name === "app") ?? Object.values(parsed).find((candidate) => candidate.isEntry);
  if (!entry) throw new Error("dashboard bundle manifest has no entry chunk");
  // Two shapes, because Vite emits two. With code splitting the entry chunk
  // lists its own `css`; with `cssCodeSplit: false` — which this build uses, so
  // that one bundle means one stylesheet — the single sheet is a TOP-LEVEL
  // manifest entry instead and the chunk lists nothing. Reading only `entry.css`
  // shipped a page with no stylesheet at all: the app worked, and every layout
  // rule silently did not.
  const styles = new Set<string>(entry.css ?? []);
  for (const candidate of Object.values(parsed)) {
    if (candidate.file.endsWith(".css")) styles.add(candidate.file);
  }
  if (styles.size === 0) {
    throw new Error("dashboard bundle manifest lists no stylesheet — the build is incomplete");
  }
  const imports: Record<string, string> = {};
  for (const [index, specifier] of APP_RUNTIME_IMPORTS.entries()) {
    const runtime = Object.values(parsed).find((candidate) => candidate.isEntry && candidate.name === runtimeEntryName(index));
    if (runtime) imports[specifier] = DASHBOARD_WEB_BASE + runtime.file;
  }
  if (Object.keys(imports).length && Object.keys(imports).length !== APP_RUNTIME_IMPORTS.length) {
    throw new Error("dashboard runtime manifest is incomplete");
  }
  archiveAssets(distDir);
  cached = {
    script: DASHBOARD_WEB_BASE + entry.file,
    ...(Object.keys(imports).length ? { imports } : {}),
    styles: [...styles].map((file) => DASHBOARD_WEB_BASE + file),
    buildId: createHash("sha256").update(entry.file).digest("hex").slice(0, 12),
  };
  return cached;
}

/** Test seam: forget the memoised manifest. */
export function resetBundleManifest(): void {
  cached = null;
}

export interface AssetHit {
  body: Buffer;
  contentType: string;
  /** Hashed filenames are content-addressed, so they may be cached forever. */
  immutable: boolean;
}

/**
 * Resolve a `/ui/...` request to a file, or `null`.
 *
 * `null` is a 404 in every failure case — a traversal attempt, an unknown
 * extension, a directory, a missing file — because they are all the same answer
 * to the caller and distinguishing them only tells a prober about the layout.
 */
async function readAssetFrom(
  pathname: string,
  distDir: string = DASHBOARD_WEB_DIST,
): Promise<AssetHit | null> {
  if (!pathname.startsWith(DASHBOARD_WEB_BASE)) return null;
  let relative: string;
  try {
    relative = decodeURIComponent(pathname.slice(DASHBOARD_WEB_BASE.length));
  } catch {
    // Malformed percent escapes are just another unknown public asset. Letting
    // URIError escape turns an unauthenticated typo/probe into a 500.
    return null;
  }
  if (!relative || relative.includes("\0")) return null;
  let root: string;
  try {
    root = await realpath(path.resolve(distDir));
  } catch {
    return null;
  }
  const target = path.resolve(root, relative);
  // The lexical check rejects `..` before touching the filesystem. The
  // canonical check below separately rejects a symlink inside dist that points
  // outside it; path.resolve alone does not resolve symlinks.
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  try {
    const canonical = await realpath(target);
    if (canonical !== root && !canonical.startsWith(root + path.sep)) return null;
    const extension = path.extname(canonical).toLowerCase();
    const contentType = TYPES[extension];
    if (!contentType) return null;
    const info = await stat(canonical);
    if (!info.isFile()) return null;
    return {
      body: await readFile(canonical),
      contentType,
      // Vite hashes every emitted name; anything without a hash is still safe to
      // revalidate rather than cache forever.
      immutable: /-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(path.basename(canonical)),
    };
  } catch {
    return null;
  }
}


let archiveDir: string | undefined;
/** Startup wiring only. The archive stores public hashed assets, never source or data. */
export function configureDashboardAssetArchive(dir: string): void {
  archiveDir = path.resolve(dir);
}
function archiveAssets(distDir: string): void {
  if (!archiveDir) return;
  const source = path.join(distDir, "a");
  const target = path.join(archiveDir, "a");
  mkdirSync(target, { recursive: true });
  for (const item of readdirSync(source, { withFileTypes: true })) {
    if (!item.isFile() || !/-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(item.name)) continue;
    try { copyFileSync(path.join(source, item.name), path.join(target, item.name), constants.COPYFILE_EXCL); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
}
/** An older page resolves its own hashed lazy chunks after a deployment. */
export async function readAsset(pathname: string, distDir: string = DASHBOARD_WEB_DIST): Promise<AssetHit | null> {
  const current = await readAssetFrom(pathname, distDir);
  if (current || !archiveDir || distDir !== DASHBOARD_WEB_DIST) return current;
  // The historical store is narrower than dist: only flat, hashed build
  // assets belong to its public namespace, never operator metadata/files.
  let relative: string;
  try { relative = decodeURIComponent(pathname.slice(DASHBOARD_WEB_BASE.length)); }
  catch { return null; }
  if (!/^a\/[A-Za-z0-9][A-Za-z0-9._-]*-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(relative)) return null;
  return readAssetFrom(pathname, archiveDir);
}
