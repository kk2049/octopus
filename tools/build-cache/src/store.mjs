/**
 * The on-disk store of build outputs, keyed by fingerprint.
 *
 * Layout (`<root>` defaults to `~/.cache/octopus-build-cache`):
 *
 *   <root>/<CACHE_FORMAT>/<safe-package-name>/<key>/manifest.json
 *   <root>/<CACHE_FORMAT>/<safe-package-name>/<key>/files/<output>/...
 *
 * Properties this file is responsible for:
 *
 *   · BYTE EXACT. Files are stored and restored verbatim with their exec bit,
 *     and every restored byte is re-hashed against the manifest. Agent View
 *     releases are content-addressed by digest, so an "almost the same" dist
 *     would silently change what a release resolves to. A checksum mismatch
 *     discards the entry and falls back to a real build.
 *   · ATOMIC. Entries are written to a temp dir and `rename`d into place, so a
 *     concurrent `pnpm -r build` never reads a half-written entry.
 *   · CONTAINED. Declared outputs must resolve inside the package directory;
 *     restore deletes those directories before writing, and deleting something
 *     outside the package would be a very expensive bug.
 *   · BOUNDED. Each package keeps the N most recent entries (LRU by mtime), so
 *     a long-lived host does not accumulate every dist it ever produced.
 *
 * The store is a same-host, same-OS-user performance facility, not a trust
 * boundary: every writer here (ticket worktrees, the `_warm` tree, the deploy
 * run tree) already runs as the bot account, which is exactly what
 * `.claude/rules/devpipe-and-ops.md` says about worktrees. It never becomes
 * the source of WHAT is deployed — Git remains that — only of whether a
 * byte-identical build has to be repeated.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { CACHE_FORMAT, sha256 } from "./fingerprint.mjs";

/** How many entries to keep per package. */
export const DEFAULT_KEEP = 6;

/**
 * Where the cache lives. `OCTO_BUILD_CACHE_DIR` wins; otherwise the XDG cache
 * home. A machine with no HOME (some container builds) gets null, which the
 * caller reads as "no cache, just build".
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | null}
 */
export function defaultCacheDir(env = process.env) {
  const explicit = env.OCTO_BUILD_CACHE_DIR?.trim();
  if (explicit) return path.resolve(explicit);
  const base = env.XDG_CACHE_HOME?.trim() || (env.HOME ? path.join(env.HOME, ".cache") : "");
  return base ? path.join(base, "octopus-build-cache") : null;
}

/** `@claude-bot/bot` → `claude-bot__bot`; one directory, no nesting surprises. */
export function safeName(packageName) {
  return packageName.replace(/^@/, "").replace(/[^a-zA-Z0-9._-]+/g, "__");
}

/** Directory holding every entry of one package. */
export function packageCacheDir(cacheDir, packageName) {
  return path.join(cacheDir, CACHE_FORMAT, safeName(packageName));
}

/** Directory of one entry. */
export function entryDir(cacheDir, packageName, key) {
  return path.join(packageCacheDir(cacheDir, packageName), key);
}

/**
 * Remove one exact cache entry so an explicit refresh can replace bad bytes.
 * Best effort: a cache cleanup failure must not turn a successful build into
 * a failed build.
 *
 * @param {{ cacheDir: string; packageName: string; key: string }} input
 * @returns {Promise<boolean>}
 */
export async function removeEntry(input) {
  try {
    await fs.rm(entryDir(input.cacheDir, input.packageName, input.key), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve declared outputs against the package directory, refusing anything
 * that escapes it.
 *
 * @param {string} pkgDir
 * @param {readonly string[]} outputs
 * @returns {Array<{ rel: string; abs: string }>}
 */
export function resolveOutputs(pkgDir, outputs) {
  return outputs.map((output) => {
    const abs = path.resolve(pkgDir, output);
    const rel = path.relative(pkgDir, abs);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`输出目录必须位于包目录内: ${output}`);
    }
    return { rel: rel.split(path.sep).join("/"), abs };
  });
}

/**
 * Collect every file under one output directory.
 *
 * @param {string} root absolute output dir
 * @param {string} prefix output-relative prefix used in the manifest
 * @returns {Promise<Array<{ path: string; size: number; mode: number; sha256: string }>>}
 */
async function collectFiles(root, prefix) {
  /** @type {Array<{ path: string; size: number; mode: number; sha256: string }>} */
  const out = [];
  /** @param {string} abs @param {string} rel */
  const walk = async (abs, rel) => {
    const entries = await fs.readdir(abs, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const childAbs = path.join(abs, entry.name);
      const childRel = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(childAbs, childRel);
        continue;
      }
      // Symlinks inside build output are not something this repo's builders
      // emit; storing them as regular files would change semantics, so the
      // entry is refused and the build runs for real.
      if (!entry.isFile()) throw new Error(`构建产物包含非普通文件,不缓存: ${childRel}`);
      const data = await fs.readFile(childAbs);
      const stat = await fs.lstat(childAbs);
      out.push({ path: childRel, size: data.byteLength, mode: stat.mode & 0o777, sha256: sha256(data) });
    }
  };
  await walk(root, prefix);
  return out;
}

/**
 * @typedef {object} EntryManifest
 * @property {string} format
 * @property {string} package
 * @property {string} key
 * @property {string} command
 * @property {string[]} outputs
 * @property {Array<{ path: string; size: number; mode: number; sha256: string }>} files
 * @property {string} createdAt
 * @property {number} buildMs
 */

/**
 * Store one successful build. Returns false when there is nothing sound to
 * store (a declared output missing, an unexpected file type, a lost race with
 * another writer) — never throws for cache reasons, because a cache problem
 * must not fail a build that already succeeded.
 *
 * @param {{ cacheDir: string; packageName: string; key: string; pkgDir: string; outputs: readonly string[]; command: string; buildMs: number; now?: () => Date }} input
 * @returns {Promise<boolean>}
 */
export async function saveEntry(input) {
  const resolved = resolveOutputs(input.pkgDir, input.outputs);
  const dir = packageCacheDir(input.cacheDir, input.packageName);
  const target = path.join(dir, input.key);
  const tmp = path.join(dir, `.tmp-${randomUUID()}`);
  try {
    // Already stored by a concurrent build of the same content: nothing to do.
    if (await exists(target)) return false;
    /** @type {EntryManifest["files"]} */
    const files = [];
    await fs.mkdir(path.join(tmp, "files"), { recursive: true });
    for (const output of resolved) {
      const stat = await fs.stat(output.abs).catch(() => null);
      if (!stat?.isDirectory()) throw new Error(`声明的输出目录不存在: ${output.rel}`);
      files.push(...(await collectFiles(output.abs, output.rel)));
      await fs.cp(output.abs, path.join(tmp, "files", output.rel), { recursive: true, dereference: false });
    }
    /** @type {EntryManifest} */
    const manifest = {
      format: CACHE_FORMAT,
      package: input.packageName,
      key: input.key,
      command: input.command,
      outputs: resolved.map((o) => o.rel),
      files,
      createdAt: (input.now?.() ?? new Date()).toISOString(),
      buildMs: input.buildMs,
    };
    await fs.writeFile(path.join(tmp, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await fs.rename(tmp, target);
    return true;
  } catch {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    return false;
  }
}

/**
 * Restore one entry into the package, or report why it could not be used.
 *
 * @param {{ cacheDir: string; packageName: string; key: string; pkgDir: string; outputs: readonly string[] }} input
 * @returns {Promise<{ ok: true; files: number; bytes: number } | { ok: false; reason: "miss" | "corrupt" | "mismatch" }>}
 */
export async function restoreEntry(input) {
  const dir = entryDir(input.cacheDir, input.packageName, input.key);
  /** @type {EntryManifest | null} */
  let manifest = null;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(dir, "manifest.json"), "utf8"));
  } catch {
    return { ok: false, reason: "miss" };
  }
  let resolved;
  try {
    resolved = resolveOutputs(input.pkgDir, input.outputs);
  } catch {
    return { ok: false, reason: "mismatch" };
  }
  const declared = resolved.map((o) => o.rel).sort().join(",");
  if (manifest?.format !== CACHE_FORMAT || (manifest.outputs ?? []).slice().sort().join(",") !== declared) {
    return { ok: false, reason: "mismatch" };
  }

  // Read and verify EVERYTHING before touching the package: a corrupt entry
  // must leave the existing tree alone so the fallback build starts from a
  // normal state rather than from half-deleted output.
  /** @type {Array<{ abs: string; data: Buffer; mode: number }>} */
  const staged = [];
  let bytes = 0;
  for (const file of manifest.files ?? []) {
    const from = path.join(dir, "files", file.path);
    let data;
    try {
      data = await fs.readFile(from);
    } catch {
      return { ok: false, reason: "corrupt" };
    }
    if (sha256(data) !== file.sha256) return { ok: false, reason: "corrupt" };
    staged.push({ abs: path.resolve(input.pkgDir, file.path), data, mode: file.mode ?? 0o644 });
    bytes += data.byteLength;
  }

  for (const output of resolved) await fs.rm(output.abs, { recursive: true, force: true });
  for (const file of staged) {
    await fs.mkdir(path.dirname(file.abs), { recursive: true });
    await fs.writeFile(file.abs, file.data);
    await fs.chmod(file.abs, file.mode);
  }
  // An output that legitimately produced no files still has to exist.
  for (const output of resolved) await fs.mkdir(output.abs, { recursive: true });
  await touch(dir);
  return { ok: true, files: staged.length, bytes };
}

/**
 * Keep the `keep` most recently used entries of one package, drop the rest.
 * Best effort: pruning failures are never a build failure.
 *
 * @param {{ cacheDir: string; packageName: string; keep?: number }} input
 * @returns {Promise<number>} entries removed
 */
export async function pruneEntries(input) {
  const keep = Math.max(1, input.keep ?? DEFAULT_KEEP);
  const dir = packageCacheDir(input.cacheDir, input.packageName);
  /** @type {Array<{ name: string; mtime: number }>} */
  const entries = [];
  try {
    for (const name of await fs.readdir(dir)) {
      if (name.startsWith(".tmp-")) continue;
      const stat = await fs.stat(path.join(dir, name)).catch(() => null);
      if (stat?.isDirectory()) entries.push({ name, mtime: stat.mtimeMs });
    }
  } catch {
    return 0;
  }
  if (entries.length <= keep) return 0;
  entries.sort((a, b) => b.mtime - a.mtime);
  let removed = 0;
  for (const stale of entries.slice(keep)) {
    try {
      await fs.rm(path.join(dir, stale.name), { recursive: true, force: true });
      removed += 1;
    } catch {
      // keep going; a locked entry is not worth failing over
    }
  }
  return removed;
}

/** @param {string} p */
async function exists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Mark an entry as recently used, so pruning drops the genuinely cold ones. */
async function touch(dir) {
  const now = new Date();
  await fs.utimes(dir, now, now).catch(() => {});
}
