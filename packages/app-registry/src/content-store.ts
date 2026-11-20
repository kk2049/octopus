/**
 * Content-addressed artifact storage.
 *
 * ## Asset names never become paths
 *
 * Every file this store writes is named by a digest it computed itself:
 *
 * ```text
 * <root>/blobs/<first two hex>/<sha256>     one asset's bytes
 * <root>/releases/<packageDigest>.json      the manifest: name -> digest
 * <root>/tmp/                               staging for atomic promotion
 * ```
 *
 * A publisher chooses asset NAMES, and names appear only inside the manifest as
 * JSON strings. So "install writes to ../../etc/cron.d" is not a check that can
 * be forgotten here — there is no code path in which an attacker-chosen string
 * reaches `path.join`. (Names are still validated in `descriptor.ts`, because
 * every downstream consumer that materialises a release onto a filesystem will
 * lack this property.)
 *
 * ## Symlinks
 *
 * Paths being ours does not mean the files are: anything with write access to
 * the root could replace a blob with a symlink into somebody's private key.
 * Reads therefore open with `O_NOFOLLOW` and refuse anything that is not a
 * regular file, so a swapped blob is an error rather than a disclosure.
 *
 * ## The manifest is the completion marker
 *
 * Blobs are written first and the manifest last, each by fsync-then-rename.
 * A crash therefore leaves either no artifact or a complete one; the failure
 * mode is an unreferenced blob, which is safe and reported by reconciliation.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  chmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  constants as fsConstants,
} from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { assetNameProblem, DEFAULT_LIMITS, isSha256Hex } from "./descriptor.js";
import type { ContentCheck, ReleaseContentStore, StoredAsset, StoredAssetIdentity } from "./ports.js";

const MAX_MANIFEST_BYTES = 1024 * 1024;

/**
 * Fault injection points, so the crash-safety claims above are testable rather
 * than asserted. Production passes nothing.
 */
export type ContentFaultPoint = "after_blobs" | "before_manifest_rename" | "after_manifest_rename";

export interface FileReleaseContentStoreOptions {
  fault?: (point: ContentFaultPoint) => void;
}

interface ManifestDocument {
  format: 1;
  packageDigest: string;
  assets: Array<{ name: string; sha256: string; bytes: number }>;
}

export class FileReleaseContentStore implements ReleaseContentStore {
  readonly root: string;

  constructor(root: string, private readonly options: FileReleaseContentStoreOptions = {}) {
    this.root = assertSafeRoot(root);
    secureDir(this.root);
    secureDir(this.blobsDir);
    secureDir(this.releasesDir);
    secureDir(this.tmpDir);
  }

  private get blobsDir(): string {
    return path.join(this.root, "blobs");
  }

  private get releasesDir(): string {
    return path.join(this.root, "releases");
  }

  private get tmpDir(): string {
    return path.join(this.root, "tmp");
  }

  put(packageDigest: string, assets: readonly StoredAsset[]): void {
    assertDigest(packageDigest);
    for (const asset of assets) {
      assertDigest(asset.sha256);
      if (asset.content.byteLength !== asset.bytes || sha256Of(asset.content) !== asset.sha256) {
        // The service has already verified this. Asserting again is cheap and
        // means a future caller of this port cannot store bytes under a digest
        // that is not theirs — which would make every later read a lie.
        throw new Error(`asset content does not match its digest: ${asset.name.slice(0, 60)}`);
      }
      this.putBlob(asset);
    }
    this.options.fault?.("after_blobs");
    const manifest: ManifestDocument = {
      format: 1,
      packageDigest,
      assets: assets.map((asset) => ({ name: asset.name, sha256: asset.sha256, bytes: asset.bytes })),
    };
    this.writeAtomic(this.manifestPath(packageDigest), Buffer.from(JSON.stringify(manifest), "utf8"), [
      "before_manifest_rename",
      "after_manifest_rename",
    ]);
  }

  has(packageDigest: string): boolean {
    return this.readManifest(packageDigest) !== null;
  }

  read(packageDigest: string, name: string, expected: readonly StoredAssetIdentity[]): Uint8Array | null {
    const manifest = this.readManifest(packageDigest);
    if (!manifest) return null;
    if (!manifestMatches(manifest, expected)) return null;
    // Exact name, never a prefix or a path: a lookup in a list the manifest
    // fixed at install time cannot be talked into resolving somewhere else.
    const entry = manifest.assets.find((asset) => asset.name === name);
    if (!entry) return null;
    const content = this.readBlob(entry.sha256);
    if (!content) return null;
    if (content.byteLength !== entry.bytes || sha256Of(content) !== entry.sha256) return null;
    return content;
  }

  checkManifest(packageDigest: string, expected: readonly StoredAssetIdentity[]): ContentCheck {
    const manifest = this.readManifest(packageDigest);
    if (!manifest) return { ok: false, code: "content_missing", detail: "no artifact manifest for this release" };
    if (!manifestMatches(manifest, expected)) {
      return { ok: false, code: "content_corrupt", detail: "artifact manifest does not match the catalog descriptor" };
    }
    for (const asset of manifest.assets) {
      let stat;
      try {
        stat = lstatSync(this.blobPath(asset.sha256));
      } catch {
        return { ok: false, code: "content_missing", detail: `blob for ${clip(asset.name)} is missing` };
      }
      if (!stat.isFile()) {
        return { ok: false, code: "content_corrupt", detail: `blob for ${clip(asset.name)} is not a regular file` };
      }
      if (stat.size !== asset.bytes) {
        return { ok: false, code: "content_corrupt", detail: `blob for ${clip(asset.name)} has the wrong size` };
      }
    }
    return { ok: true };
  }

  verify(packageDigest: string, expected: readonly StoredAssetIdentity[]): ContentCheck {
    const cheap = this.checkManifest(packageDigest, expected);
    if (!cheap.ok) return cheap;
    const manifest = this.readManifest(packageDigest)!;
    for (const asset of manifest.assets) {
      const content = this.readBlob(asset.sha256);
      if (!content) {
        return { ok: false, code: "content_missing", detail: `blob for ${clip(asset.name)} could not be read` };
      }
      if (sha256Of(content) !== asset.sha256) {
        return { ok: false, code: "content_corrupt", detail: `blob for ${clip(asset.name)} does not match its digest` };
      }
    }
    return { ok: true };
  }

  listStored(): string[] {
    return safeReadDir(this.releasesDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length))
      .filter((digest) => isSha256Hex(digest))
      .sort();
  }

  // ── internals ──

  private manifestPath(packageDigest: string): string {
    return path.join(this.releasesDir, `${packageDigest}.json`);
  }

  private blobPath(sha256: string): string {
    return path.join(this.blobsDir, sha256.slice(0, 2), sha256);
  }

  private putBlob(asset: StoredAsset): void {
    const target = this.blobPath(asset.sha256);
    try {
      const stat = lstatSync(target);
      // The NAME says what the bytes ought to be; it does not prove a mutable
      // filesystem entry still contains them. Hash an existing candidate even
      // when its size matches, otherwise same-length corruption survives every
      // reinstall.
      if (stat.isFile() && stat.size === asset.bytes) {
        const existing = readRegularFile(target, DEFAULT_LIMITS.maxAssetBytes);
        if (existing && sha256Of(existing) === asset.sha256) return;
      }
    } catch {
      // Not there yet.
    }
    secureDir(path.dirname(target));
    this.writeAtomic(target, Buffer.from(asset.content), []);
  }

  private readBlob(sha256: string): Uint8Array | null {
    return readRegularFile(this.blobPath(sha256), DEFAULT_LIMITS.maxAssetBytes);
  }

  private readManifest(packageDigest: string): ManifestDocument | null {
    if (!isSha256Hex(packageDigest)) return null;
    const raw = readRegularFile(this.manifestPath(packageDigest), MAX_MANIFEST_BYTES);
    if (!raw) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(raw).toString("utf8"));
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const row = parsed as Record<string, unknown>;
    if (
      row.format !== 1
      || row.packageDigest !== packageDigest
      || !Array.isArray(row.assets)
      || row.assets.length === 0
      || row.assets.length > DEFAULT_LIMITS.maxAssets
    ) return null;
    const assets: ManifestDocument["assets"] = [];
    const seen = new Set<string>();
    let total = 0;
    for (const entry of row.assets) {
      if (!entry || typeof entry !== "object") return null;
      const asset = entry as Record<string, unknown>;
      if (
        typeof asset.name !== "string"
        || assetNameProblem(asset.name) !== null
        || seen.has(asset.name)
        || !isSha256Hex(asset.sha256)
        || typeof asset.bytes !== "number"
        || !Number.isSafeInteger(asset.bytes)
        || asset.bytes < 0
        || asset.bytes > DEFAULT_LIMITS.maxAssetBytes
      ) return null;
      if (assets.length && assets[assets.length - 1]!.name >= asset.name) return null;
      seen.add(asset.name);
      total += asset.bytes;
      if (total > DEFAULT_LIMITS.maxTotalBytes) return null;
      assets.push({ name: asset.name, sha256: asset.sha256, bytes: asset.bytes });
    }
    return { format: 1, packageDigest, assets };
  }

  private writeAtomic(target: string, body: Buffer, faults: ContentFaultPoint[]): void {
    // A random staging name, not one derived from the target: two processes
    // installing the same release would otherwise pick the same temp path, and
    // the loser would unlink a file the winner is still writing into.
    const temp = path.join(this.tmpDir, `tmp-${randomBytes(12).toString("hex")}`);
    let promoted = false;
    try {
      // `wx` fails rather than truncating anything that already exists, so a
      // stale temp file from an interrupted run cannot be silently adopted.
      const fd = openSync(temp, "wx", 0o600);
      try {
        writeFileSync(fd, body);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      if (faults.includes("before_manifest_rename")) this.options.fault?.("before_manifest_rename");
      renameSync(temp, target);
      promoted = true;
      syncDir(path.dirname(target));
      if (faults.includes("after_manifest_rename")) this.options.fault?.("after_manifest_rename");
    } finally {
      if (!promoted) {
        try {
          unlinkSync(temp);
        } catch {
          // Best effort: an orphan in tmp/ is inert.
        }
      }
    }
  }
}

// ── helpers ──

function manifestMatches(manifest: ManifestDocument, expected: readonly StoredAssetIdentity[]): boolean {
  if (manifest.assets.length !== expected.length) return false;
  return manifest.assets.every((asset, index) => {
    const wanted = expected[index];
    return Boolean(
      wanted
      && asset.name === wanted.name
      && asset.sha256 === wanted.sha256
      && asset.bytes === wanted.bytes
    );
  });
}

function sha256Of(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function assertDigest(value: string): void {
  if (!isSha256Hex(value)) throw new Error(`not a sha256 hex digest: ${clip(String(value))}`);
}

function clip(value: string): string {
  const safe = value.replace(/[\x00-\x1f\x7f]/g, "�");
  return safe.length <= 60 ? safe : `${safe.slice(0, 59)}…`;
}

/**
 * Refuse a root that is somebody else's whole world.
 *
 * The store never deletes anything, so this is not guarding a destructive
 * operation today. It guards the next one: a root that is `$HOME`, a relative
 * path resolved against whatever the process's cwd happens to be, or a string
 * still containing `~` or an unexpanded `$VAR` is a configuration mistake, and
 * the moment to notice it is before an artifact tree is created inside it.
 */
export function assertSafeRoot(root: string): string {
  if (typeof root !== "string" || root.trim().length === 0) {
    throw new Error("content store root must be a non-empty path");
  }
  if (!path.isAbsolute(root)) {
    throw new Error(`content store root must be absolute, got ${clip(root)}`);
  }
  if (root.includes("~") || root.includes("$")) {
    throw new Error(`content store root looks unexpanded: ${clip(root)}`);
  }
  const resolved = path.resolve(root);
  if (resolved !== root && `${resolved}/` !== root) {
    throw new Error(`content store root must already be normalised: ${clip(root)}`);
  }
  if (resolved === path.parse(resolved).root) {
    throw new Error("content store root must not be the filesystem root");
  }
  if (resolved === path.resolve(homedir())) {
    throw new Error("content store root must not be the home directory itself");
  }
  return resolved;
}

function secureDir(dir: string): void {
  // Walk one component at a time. mkdir({recursive:true}) follows an existing
  // symlink in any parent and could place blobs outside the configured root.
  const filesystemRoot = path.parse(dir).root;
  let current = filesystemRoot;
  for (const component of path.relative(filesystemRoot, dir).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`content store directory is not a real directory: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(current, { mode: 0o700 });
    }
  }
  // `mode` is ignored when the directory already exists, so re-assert it:
  // restoring a backup with a permissive mode must not quietly publish an
  // artifact tree.
  chmodSync(dir, 0o700);
}

/**
 * Read a file that must be a regular file we own the name of.
 *
 * `O_NOFOLLOW` makes a symlink an error rather than a redirect; the `fstat`
 * closes the remaining gap in which the entry could be a fifo or a device.
 */
function readRegularFile(file: string, maxBytes: number): Uint8Array | null {
  let fd: number;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > maxBytes) return null;
    const buffer = Buffer.allocUnsafe(stat.size);
    let read = 0;
    while (read < stat.size) {
      const n = readSync(fd, buffer, read, stat.size - read, read);
      if (n <= 0) break;
      read += n;
    }
    if (read !== stat.size) return null;
    return new Uint8Array(buffer);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

function syncDir(dir: string): void {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function safeReadDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
