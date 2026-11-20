import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync, writeSync, chmodSync, type BigIntStats } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { hasFreeSpace } from "./disk.js";

/** `stat` is the file version the digest was read from (dev:ino:size:mtimeNs:ctimeNs). */
interface Entry { digest: string; bytes: number; mode: number; stat?: string }
/** A file the checkpoint could not save this time; it is named, never silently missing. */
interface Unsaved { path: string; bytes: number; reason: "disk" | "changed" }
interface Checkpoint { id: string; at: string; started?: number; files: Record<string, Entry>; skipped: string[]; unsaved?: Unsaved[]; consistency: "per-file" }
const ignored = new Set([".git", "node_modules", ".research-history"]);
const WINDOW = 1024 * 1024;
/** Coarse filesystem timestamps: a file changed this close to a scan may change again without a new ctime. */
const RACY_MS = 2000;
const version = (stat: BigIntStats) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
class FileChanged extends Error {}

/**
 * Content-addressed checkpoints of ordinary workspace bytes, independent of graph
 * versions. A checkpoint has no file-count or byte total: every file is hashed and
 * copied in 1 MiB windows, an unchanged file version reuses the previous digest
 * without being read, and each new blob first checks that the volume keeps its
 * reserve. A file that cannot be saved this time (disk reserve, or it changed
 * while being read) is listed in `unsaved`; it never fails the whole checkpoint.
 */
export class WorkspaceHistory {
  readonly root: string;
  private clock = 0;
  private readonly directory: string;
  constructor(root: string, private readonly retain = 120, private readonly now: () => number = Date.now) {
    this.root = realpathSync(root);
    if (!lstatSync(this.root).isDirectory() || retain < 2 || retain > 1000) throw new Error("Invalid workspace history configuration");
    this.directory = join(this.root, ".research-history");
    for (const path of [this.directory, join(this.directory, "blobs"), join(this.directory, "checkpoints")]) {
      if (existsSync(path) && (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())) throw new Error("History must use ordinary directories");
      mkdirSync(path, { recursive: true, mode: 0o700 });
    }
  }
  path(input: string, allowMissing = false): string {
    if (!input || isAbsolute(input) || input.includes("\0") || input.split(/[\\/]/).some(part => part === ".." || ignored.has(part))) throw new Error("Path must be inside the project workspace");
    const path = resolve(this.root, input), rel = relative(this.root, path);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Invalid workspace path");
    let current = this.root;
    for (const part of rel.split("/")) {
      current = join(current, part);
      if (!existsSync(current)) { if (!allowMissing) throw new Error("Workspace path is missing"); continue; }
      if (lstatSync(current).isSymbolicLink()) throw new Error("Symlinks cannot be followed by workspace tools");
    }
    return path;
  }
  private atomic(path: string, bytes: Uint8Array | string): void {
    const temporary = path + "." + randomUUID();
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path);
    const parent = openSync(dirname(path), "r");
    try { fsyncSync(parent); } finally { closeSync(parent); }
  }
  read(path: string, maxBytes = 196608): string {
    const target = this.path(path), stat = lstatSync(target);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("File is not ordinary text or exceeds the tool limit");
    const bytes = readFileSync(target);
    if (bytes.length > maxBytes) throw new Error("File grew beyond the tool limit");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  write(path: string, body: string): void {
    const target = this.path(path, true);
    if (Buffer.byteLength(body) > 196608) throw new Error("File exceeds the tool limit");
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    this.path(path, true);
    this.atomic(target, body);
  }
  /** `pinned` keeps a checkpoint's blobs through this prune, for a restore that copies from them next. */
  checkpoint(pinned?: Checkpoint): Checkpoint & { readBytes: number } {
    const files: Record<string, Entry> = {}, skipped: string[] = [], unsaved: Unsaved[] = [];
    const started = this.now(), previous = this.latest();
    // One operation owns one window, including when it scans thousands of tiny files.
    const buffer = Buffer.alloc(WINDOW);
    // Reuse a digest only for a file version last changed well before the previous scan began.
    const trusted = previous?.started === undefined ? 0 : previous.started - RACY_MS;
    let readBytes = 0;
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = join(directory, entry.name), rel = relative(this.root, path);
        if (ignored.has(entry.name) || entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) { skipped.push(rel); continue; }
        if (entry.isDirectory()) { walk(path); continue; }
        this.path(rel);
        const before = lstatSync(path, { bigint: true }), key = version(before), known = previous?.files[rel];
        if (known?.stat === key && Number(before.ctimeMs) < trusted && existsSync(join(this.directory, "blobs", known.digest))) {
          files[rel] = { ...known, mode: Number(before.mode) & 0o777 };
          continue;
        }
        if (!hasFreeSpace(join(this.directory, "blobs"), Number(before.size))) { unsaved.push({ path: rel, bytes: Number(before.size), reason: "disk" }); continue; }
        try {
          const saved = this.store(path, before, buffer);
          readBytes += saved.bytes;
          files[rel] = { digest: saved.digest, bytes: saved.bytes, mode: Number(before.mode) & 0o777, stat: key };
        } catch (error) {
          if (!(error instanceof FileChanged)) throw error;
          unsaved.push({ path: rel, bytes: Number(before.size), reason: "changed" });
        }
      }
    };
    walk(this.root);
    const latest = this.names().at(-1)?.split("_")[1];
    this.clock = Math.max(started, this.clock + 1, Number(latest ?? 0) + 1);
    const checkpoint: Checkpoint = { id: "cp_" + this.clock + "_" + randomUUID(), at: new Date().toISOString(), started, files, skipped, unsaved, consistency: "per-file" };
    this.atomic(join(this.directory, "checkpoints", checkpoint.id + ".json"), JSON.stringify(checkpoint));
    this.prune(pinned);
    return { ...checkpoint, readBytes };
  }
  /** Copies one file into the blob store while hashing it, one window at a time. */
  private store(path: string, before: BigIntStats, buffer: Buffer): { digest: string; bytes: number } {
    const blobs = join(this.directory, "blobs"), temporary = join(blobs, ".incoming-" + randomUUID());
    const source = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW), target = openSync(temporary, "wx", 0o600);
    const hash = createHash("sha256");
    let bytes = 0, kept = false;
    try {
      for (let n; (n = readSync(source, buffer, 0, WINDOW, bytes)) > 0; bytes += n) {
        hash.update(buffer.subarray(0, n));
        for (let written = 0; written < n;) written += writeSync(target, buffer, written, n - written);
      }
      const after = lstatSync(path, { bigint: true });
      if (version(after) !== version(before) || version(fstatSync(source, { bigint: true })) !== version(before) || BigInt(bytes) !== before.size) throw new FileChanged();
      const digest = hash.digest("hex"), blob = join(blobs, digest);
      // An existing blob is already durable. Do not flush the duplicate we discard.
      if (!existsSync(blob)) { fsyncSync(target); renameSync(temporary, blob); kept = true; this.syncDirectory(blobs); }
      return { digest, bytes };
    } finally {
      closeSync(source); closeSync(target);
      if (!kept) try { unlinkSync(temporary); } catch { /* already gone */ }
    }
  }
  private syncDirectory(path: string): void {
    const fd = openSync(path, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  private latest(): Checkpoint | undefined {
    const name = this.names().at(-1);
    return name ? this.load(name.slice(0, -5)) : undefined;
  }
  list(): Array<{ id: string; at: string; files: number; bytes: number; consistency: string }> {
    return this.names().reverse().map(name => {
      const saved = this.load(name.slice(0, -5));
      return { id: saved.id, at: saved.at, files: Object.keys(saved.files).length, bytes: Object.values(saved.files).reduce((sum, entry) => sum + entry.bytes, 0), consistency: saved.consistency };
    });
  }
  private names(): string[] { return readdirSync(join(this.directory, "checkpoints")).filter(name => /^cp_\d+_[a-f0-9-]+\.json$/.test(name)).sort(); }
  private load(id: string): Checkpoint {
    if (!/^cp_\d+_[a-f0-9-]+$/.test(id)) throw new Error("Invalid checkpoint");
    return JSON.parse(readFileSync(join(this.directory, "checkpoints", id + ".json"), "utf8")) as Checkpoint;
  }
  restore(id: string, paths?: string[]): { restored: number; removed: number; before: string } {
    const saved = this.load(id), selected = paths ?? Object.keys(saved.files);
    // Bounds an explicit argument list; a whole-checkpoint restore has no count limit.
    if (paths && paths.length > 10000) throw new Error("Too many restore paths; omit paths to restore the whole checkpoint");
    const plan = selected.map(path => {
      const entry = saved.files[path];
      if (!entry || !/^[a-f0-9]{64}$/.test(entry.digest)) throw new Error("Checkpoint file is missing or invalid");
      return { target: this.path(path, true), path, entry };
    });
    // Verify every distinct blob first, even for unchanged targets, so damaged
    // history changes nothing. Reuse the same window for verification and copies.
    const buffer = Buffer.alloc(WINDOW);
    for (const digest of new Set(plan.map(item => item.entry.digest))) this.copyBlob(digest, buffer);
    if (!hasFreeSpace(this.root, plan.reduce((sum, item) => sum + item.entry.bytes, 0))) throw new Error("Restore refused: the workspace volume cannot hold these files and keep its 1 GiB reserve");
    const before = this.checkpoint(saved), keep = new Set((saved.unsaved ?? []).map(item => item.path));
    // A whole restore removes files the checkpoint did not have, except ones it could not save.
    const removing = paths ? [] : Object.keys(before.files).filter(path => !saved.files[path] && !keep.has(path));
    // Never overwrite a file whose current bytes the before-image could not save.
    const exposed = (before.unsaved ?? []).filter(item => plan.some(entry => entry.path === item.path));
    if (exposed.length) throw new Error("Restore refused: the pre-restore checkpoint could not save " + exposed.slice(0, 5).map(item => `${item.path} (${item.reason})`).join(", ") + "; free space or stop writers and retry");
    for (const item of plan) {
      mkdirSync(dirname(item.target), { recursive: true, mode: 0o700 }); this.path(item.path, true);
      // The before-image knows the current bytes. Keep an already matching file
      // only if its permissions and version still match at the point of restore.
      const current = before.files[item.path];
      if (current?.digest === item.entry.digest && current.mode === item.entry.mode && existsSync(item.target)) {
        const stat = lstatSync(item.target, { bigint: true });
        // Recent/coarse timestamps cannot exclude another same-version write.
        // Restore also breaks hard links and strips special permission bits.
        if (Number(stat.ctimeMs) < (before.started ?? 0) - RACY_MS && current.stat === version(stat)
          && stat.nlink === 1n && (Number(stat.mode) & 0o7777) === item.entry.mode) continue;
      }
      const temporary = item.target + "." + randomUUID();
      this.copyBlob(item.entry.digest, buffer, temporary);
      renameSync(temporary, item.target); chmodSync(item.target, item.entry.mode & 0o777); this.syncDirectory(dirname(item.target));
    }
    for (const path of removing) unlinkSync(this.path(path));
    return { restored: plan.length, removed: removing.length, before: before.id };
  }
  /** Streams a blob, verifying its digest; with `to`, also writes and fsyncs a copy there. */
  private copyBlob(digest: string, buffer: Buffer, to?: string): void {
    const source = openSync(join(this.directory, "blobs", digest), constants.O_RDONLY | constants.O_NOFOLLOW);
    const target = to === undefined ? undefined : openSync(to, "wx", 0o600);
    const hash = createHash("sha256");
    let complete = false;
    try {
      for (let n, offset = 0; (n = readSync(source, buffer, 0, WINDOW, offset)) > 0; offset += n) {
        hash.update(buffer.subarray(0, n));
        if (target !== undefined) for (let written = 0; written < n;) written += writeSync(target, buffer, written, n - written);
      }
      if (hash.digest("hex") !== digest) throw new Error("Checkpoint blob failed verification");
      if (target !== undefined) fsyncSync(target);
      complete = true;
    } finally {
      closeSync(source);
      if (target !== undefined) { closeSync(target); if (!complete) try { unlinkSync(to!); } catch { /* already gone */ } }
    }
  }
  private prune(pinned?: Checkpoint): void {
    const names = this.names();
    for (const name of names.slice(0, Math.max(0, names.length - this.retain))) unlinkSync(join(this.directory, "checkpoints", name));
    const live = new Set<string>(Object.values(pinned?.files ?? {}).map(entry => entry.digest));
    for (const name of this.names()) for (const entry of Object.values(this.load(name.slice(0, -5)).files)) live.add(entry.digest);
    for (const name of readdirSync(join(this.directory, "blobs"))) if (/^[a-f0-9]{64}$/.test(name) && !live.has(name)) unlinkSync(join(this.directory, "blobs", name));
  }
}
