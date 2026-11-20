import { createHash } from "node:crypto";
import { closeSync, constants, copyFileSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, lstatSync, statSync, unlinkSync, realpathSync, watch, writeFileSync, writeSync, type BigIntStats, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import type { ResearchNode } from "@claude-bot/research-canvas-contract";
import type { ResearchCanvasRepository } from "../store/repositories/research-canvas.js";
import { ensureFreeSpace } from "./disk.js";
import { digest, id } from "./validation.js";

interface TextFileRecord { id: string; path: string; initialized: string }
/** One bounded window of a text file; `revision` is the whole file's, so windows of different versions never mix. */
export interface ResearchTextWindow { text: string; revision: string; path: string; offset: number; next: number | null; bytes: number }
/** Bytes per `document_read` window. A body of any size is read as a sequence of these. */
export const TEXT_WINDOW_BYTES = 256 * 1024;
/**
 * What a caller that needs the whole body in one string (rules, prompts, sync,
 * older single-answer reads) loads before it refuses with a pointer to windows.
 * A budget of that consumer, not a limit on the file.
 */
export const TEXT_WHOLE_BYTES = 16 * 1024 * 1024;
/** The single answer an older View's `document_read` (no offset) can receive. */
export const TEXT_LEGACY_INLINE_BYTES = 1024 * 1024;
const mebibytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
const versionOf = (stat: BigIntStats) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
export interface ResearchTextVersion { id: string; resource: string; digest: string; at: string; bytes: number }
/**
 * Staged saves (a body larger than one `document_write` call) in flight per
 * project, and how long an abandoned one is kept. These bound the temp files a
 * project can hold, not the size of any body.
 */
export const TEXT_STAGED_MAX = 16;
export const TEXT_STAGED_IDLE_MS = 10 * 60_000;
const textTypes = new Set(["note", "task", "finding", "goal", "workgroup"]);
export const hasTextFile = (node: ResearchNode) => textTypes.has(node.type);

/** Ordinary workspace files. Saving replaces bytes; it never submits graph operations. */
export class ResearchTextFiles {
  private readonly watchers = new Map<string, FSWatcher>();
  /** Whole-file revision per file version, so a sequence of windows hashes the file once. */
  private readonly revisions = new Map<string, string>();
  constructor(
    private readonly repo: ResearchCanvasRepository,
    private readonly root: string,
    private readonly legacyText: (project: string, node: ResearchNode) => string,
    private readonly changed: (project: string) => void,
  ) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  workspace(project: string): string {
    const path = join(this.root, digest(project).slice(0, 32), "workspace");
    mkdirSync(path, { recursive: true, mode: 0o700 });
    if (!this.watchers.has(project)) {
      const watcher = watch(path, { persistent: false }, () => this.changed(project));
      watcher.on("error", () => { watcher.close(); this.watchers.delete(project); });
      this.watchers.set(project, watcher);
    }
    return path;
  }
  private blobs(project: string): string {
    const path = join(this.root, digest(project).slice(0, 32), "history");
    mkdirSync(path, { recursive: true, mode: 0o700 });
    return path;
  }
  private atomic(path: string, body: string): void {
    const temporary = path + "." + id("write");
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path);
    const parent = openSync(dirname(path), "r");
    try { fsyncSync(parent); } finally { closeSync(parent); }
  }
  private initialize(project: string, node: ResearchNode): TextFileRecord {
    if (!hasTextFile(node)) throw new Error("此资源没有独立正文文件");
    const current = this.repo.get<TextFileRecord>(project, "text-files", node.id);
    if (current) {
      if (dirname(current.path) !== this.workspace(project)) throw new Error("正文文件不属于项目工作区");
      if (existsSync(current.path) && (!lstatSync(current.path).isFile() || realpathSync(dirname(current.path)) !== dirname(current.path))) throw new Error("正文文件必须是项目工作区中的普通文件");
      return current;
    }
    const path = join(this.workspace(project), `${node.id.replace(/[^A-Za-z0-9_-]/g, "_")}-${digest(node.id).slice(0, 8)}.md`);
    // A crash after creation leaves the actual file authoritative on retry.
    if (!existsSync(path)) this.atomic(path, this.legacyText(project, node));
    const record = { id: node.id, path, initialized: new Date().toISOString() };
    this.repo.put(project, "text-files", node.id, record, 0, false);
    return record;
  }
  /** The whole body in one string, for consumers that need it so; past `budget` it refuses and names windows. */
  read(project: string, node: ResearchNode, budget = TEXT_WHOLE_BYTES): { text: string; revision: string; path: string } {
    const record = this.initialize(project, node);
    this.workspace(project);
    if (!existsSync(record.path)) throw new Error("正文文件已移除；图中的引用仍保留");
    const size = lstatSync(record.path).size;
    if (size > budget) throw new Error(`正文 ${mebibytes(size)}，超过一次整份读取的 ${mebibytes(budget)}；请带 offset 参数用 document_read 分段读取（从 0 开始，按返回的 next 继续），旧版页面请刷新`);
    const body = readFileSync(record.path, "utf8");
    return { text: body, revision: digest(body), path: record.path };
  }
  /** One window starting at `offset` (a byte offset on a character boundary, as `next` returns). */
  readWindow(project: string, node: ResearchNode, offset: number): ResearchTextWindow {
    const record = this.initialize(project, node);
    this.workspace(project);
    if (!existsSync(record.path)) throw new Error("正文文件已移除；图中的引用仍保留");
    const fd = openSync(record.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = fstatSync(fd, { bigint: true }), size = Number(before.size);
      if (!before.isFile()) throw new Error("正文文件必须是普通文件");
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > size) throw new Error("正文偏移超出文件范围");
      const revision = this.revision(fd, before);
      // Read one byte past the window to find the last character boundary inside it.
      const buffer = Buffer.alloc(Math.min(TEXT_WINDOW_BYTES + 1, size - offset)), read = this.fill(fd, buffer, offset);
      if (read.length && (read[0]! & 0xc0) === 0x80) throw new Error("正文偏移不在字符边界上；请使用返回的 next");
      let end = Math.min(TEXT_WINDOW_BYTES, read.length);
      if (offset + end < size) while (end > 0 && (read[end]! & 0xc0) === 0x80) end--;
      if (versionOf(fstatSync(fd, { bigint: true })) !== versionOf(before)) throw new Error("正文正在被修改，请重新读取");
      return { text: read.subarray(0, end).toString("utf8"), revision, path: record.path, offset, next: offset + end < size ? offset + end : null, bytes: size };
    } finally { closeSync(fd); }
  }
  /** The same value as `digest(body)` (SHA-256 of the JSON string), computed one window at a time. */
  private revision(fd: number, before: BigIntStats): string {
    const key = versionOf(before), known = this.revisions.get(key);
    if (known) return known;
    const hash = createHash("sha256").update('"'), decoder = new TextDecoder("utf-8"), buffer = Buffer.alloc(TEXT_WINDOW_BYTES);
    for (let offset = 0, n; (n = readSync(fd, buffer, 0, buffer.length, offset)) > 0; offset += n)
      hash.update(JSON.stringify(decoder.decode(buffer.subarray(0, n), { stream: true })).slice(1, -1));
    hash.update(JSON.stringify(decoder.decode()).slice(1, -1)).update('"');
    const revision = hash.digest("hex");
    if (versionOf(fstatSync(fd, { bigint: true })) !== key) throw new Error("正文正在被修改，请重新读取");
    if (this.revisions.size >= 256) this.revisions.delete(this.revisions.keys().next().value!);
    this.revisions.set(key, revision);
    return revision;
  }
  private fill(fd: number, buffer: Buffer, offset: number): Buffer {
    let filled = 0;
    for (let n; filled < buffer.length && (n = readSync(fd, buffer, filled, buffer.length - filled, offset + filled)) > 0;) filled += n;
    return buffer.subarray(0, filled);
  }
  /** Current revision without loading the body. */
  currentRevision(project: string, node: ResearchNode): string {
    return this.readWindow(project, node, 0).revision;
  }
  /** Sibling of the workspace (same filesystem, so commit is one rename), outside its watcher. */
  private staging(project: string): string {
    const path = join(this.root, digest(project).slice(0, 32), "staging");
    mkdirSync(path, { recursive: true, mode: 0o700 });
    return path;
  }
  private staged(project: string, key: string): string {
    if (!/^[a-f0-9]{32}$/.test(key)) throw new Error("分段保存的 upload 无效");
    return join(this.staging(project), key);
  }
  /**
   * Begin a staged save under `key` (derived by the caller from its actor,
   * node and token). Abandoned uploads idle past `TEXT_STAGED_IDLE_MS` are
   * swept first. A replayed begin restarts the same upload empty.
   */
  stageBegin(project: string, node: ResearchNode, key: string): void {
    this.initialize(project, node);
    const dir = this.staging(project), target = this.staged(project, key), now = Date.now();
    for (const name of readdirSync(dir)) {
      try { if (now - statSync(join(dir, name)).mtimeMs > TEXT_STAGED_IDLE_MS) unlinkSync(join(dir, name)); } catch { /* raced with another sweep */ }
    }
    if (!existsSync(target) && readdirSync(dir).length >= TEXT_STAGED_MAX) throw new Error("这个项目同时进行的分段保存过多，请稍后再试");
    closeSync(openSync(target, "w", 0o600));
  }
  /**
   * Append one window at `offset` (the bytes staged so far). A replay of a
   * window already staged is recognised and changes nothing; any other offset
   * is refused. Answers the staged size after this window.
   */
  stageAppend(project: string, key: string, offset: number, body: string): number {
    const target = this.staged(project, key);
    if (!existsSync(target)) throw new Error("分段保存已过期或尚未开始，正文没有改动；请重新保存");
    const bytes = Buffer.from(body, "utf8"), fd = openSync(target, "r+");
    try {
      const size = fstatSync(fd).size;
      if (offset < size) {
        const old = this.fill(fd, Buffer.alloc(Math.min(bytes.length, size - offset)), offset);
        if (offset + bytes.length > size || !old.equals(bytes)) throw new Error("重复的分段与已暂存的内容不一致，正文没有改动；请重新保存");
        return offset + bytes.length;
      }
      if (offset !== size) throw new Error("分段位置不连续，正文没有改动；请重新保存");
      ensureFreeSpace(dirname(target), bytes.length);
      for (let written = 0; written < bytes.length;) written += writeSync(fd, bytes, written, bytes.length - written, offset + written);
      fsyncSync(fd);
      return offset + bytes.length;
    } finally { closeSync(fd); }
  }
  /**
   * Replace the body with a staged upload of exactly `size` bytes: the old
   * version is backed up, then one rename. Never loads the body.
   */
  stageCommit(project: string, node: ResearchNode, key: string, size: number): { revision: string; path: string; bytes: number } {
    const record = this.initialize(project, node), target = this.staged(project, key);
    if (!existsSync(target)) throw new Error("分段保存已过期或尚未开始，正文没有改动；请重新保存");
    let revision: string;
    const fd = openSync(target, "r");
    try {
      fsyncSync(fd);
      const stat = fstatSync(fd, { bigint: true });
      if (Number(stat.size) !== size) throw new Error("暂存的正文长度与提交的不一致，正文没有改动；请重新保存");
      revision = this.revision(fd, stat);
    } finally { closeSync(fd); }
    this.backup(project, node, record);
    renameSync(target, record.path);
    const parent = openSync(dirname(record.path), "r");
    try { fsyncSync(parent); } finally { closeSync(parent); }
    this.changed(project);
    return { revision, path: record.path, bytes: size };
  }
  write(project: string, node: ResearchNode, body: string): { text: string; revision: string; path: string } {
    const record = this.initialize(project, node);
    this.backup(project, node, record);
    this.atomic(record.path, body);
    this.changed(project);
    return { text: body, revision: digest(body), path: record.path };
  }
  /**
   * Keeps the current bytes as a history version by copying, so a body of any size is
   * kept without loading it. The blob is named by the copy's own revision.
   */
  private backup(project: string, node: ResearchNode, record: TextFileRecord): void {
    if (!existsSync(record.path)) return;
    const blobs = this.blobs(project), temporary = join(blobs, "." + id("copy"));
    copyFileSync(record.path, temporary);
    let hash: string, bytes: number;
    const fd = openSync(temporary, "r");
    try { fsyncSync(fd); const stat = fstatSync(fd, { bigint: true }); hash = this.revision(fd, stat); bytes = Number(stat.size); } finally { closeSync(fd); }
    if (existsSync(join(blobs, hash))) unlinkSync(temporary); else renameSync(temporary, join(blobs, hash));
    const version: ResearchTextVersion = { id: id("textversion"), resource: node.id, digest: hash, at: new Date().toISOString(), bytes };
    this.repo.put(project, "text-versions", version.id, version, 0, false);
  }
  versions(project: string, resource: string, after = ""): { versions: ResearchTextVersion[]; next: string | null } {
    const rows = this.repo.list<ResearchTextVersion>(project, "text-versions", after, 101);
    return { versions: rows.slice(0, 100).filter(item => item.resource === resource), next: rows.length > 100 ? rows[99].id : null };
  }
  /** Copies a history version back into place; any size, never loaded whole. */
  restore(project: string, node: ResearchNode, version: string): { revision: string; path: string; bytes: number } {
    const saved = this.repo.get<ResearchTextVersion>(project, "text-versions", version);
    if (!saved || saved.resource !== node.id) throw new Error("文件历史版本不存在");
    const blob = join(this.blobs(project), saved.digest);
    if (!/^[a-f0-9]{64}$/.test(saved.digest) || !existsSync(blob)) throw new Error("文件历史版本内容缺失");
    const record = this.initialize(project, node), temporary = record.path + "." + id("restore");
    this.backup(project, node, record);
    copyFileSync(blob, temporary);
    const fd = openSync(temporary, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, record.path);
    const parent = openSync(dirname(record.path), "r");
    try { fsyncSync(parent); } finally { closeSync(parent); }
    this.changed(project);
    return { revision: saved.digest, path: record.path, bytes: saved.bytes };
  }
  close(): void {
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }
}
