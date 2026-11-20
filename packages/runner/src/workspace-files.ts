/**
 * Reading files on the device that owns them.
 *
 * ── Where the authority comes from ─────────────────────────────────────────
 *
 * Registered-workspace calls get their authority from exactly one place:
 * `resolveWorkspace(home, workspace_id)`. Owner-local calls are a separate
 * operation: they accept one absolute path only after the trusted server has
 * bound the request to this owner's Runner, and the OS account is the boundary.
 * The two shapes never fall back into one another.
 *
 * That is the same division of labour `directories.ts` already uses for launch:
 * the Bot bounds the STRING so an approval card says what will happen, and the
 * device decides what is true.
 *
 * ── What "contained" means, precisely ──────────────────────────────────────
 *
 * The relative path is refused unless it is `""` or a canonical POSIX relative
 * path — no NUL, no backslash, no newline, no leading or trailing whitespace, no
 * `.` or `..` segment, no empty segment, no leading `/`, and within the byte
 * cap. Then the joined path is `realpath`-ed and the RESULT must still be inside
 * the workspace root. Deciding containment on the resolved path rather than the
 * requested one is what makes a symlink pointing at `/etc` a refusal instead of
 * a read.
 *
 * Symlinks additionally never receive a ref: a listing reports them as `other`
 * with no `relative_path`, so nothing downstream can name one. Following a
 * symlink that stays inside the workspace would not be an escape, but handing
 * out a way to address it would make "we do not traverse symlinks" a rule
 * somebody has to keep re-implementing.
 *
 * The threat model is the same one the rest of the Runner has: the authority is
 * the OS account this process runs as. These checks stop path assembly, access
 * outside the registry, and symlink escape. They do not claim to survive an
 * adversary on the same OS account rearranging directories between two syscalls.
 *
 * ── What never crosses the wire ────────────────────────────────────────────
 *
 * No canonical path, ever — not in a result, not in an error, not in a log line
 * this returns. Node's own `fs` errors carry the path they failed on, so every
 * failure here is classified by `error.code` and re-answered with a fixed code;
 * the original message is dropped rather than forwarded.
 *
 * ── Writing (2026-08-07) ───────────────────────────────────────────────────
 *
 * `replaceWorkspaceText` adds exactly one write verb, and it is a
 * compare-and-swap: the caller states the digest of the whole file it based its
 * edit on, this file verifies that digest against the OPEN DESCRIPTOR, and only
 * then replaces the content. Two properties follow, and both are the reason the
 * shape is CAS rather than "write these bytes":
 *
 *  · **A stale editor cannot silently clobber somebody else's change.** The
 *    refusal is `digest_mismatch`, and nothing is written.
 *  · **Re-running the same call is not a second edit.** Either it had not been
 *    applied (and applying it now writes the same bytes), or it had (and the
 *    digest no longer matches). That is what lets the capability layer declare
 *    this operation `retrySafe` despite it being a `modify`.
 *
 * The replacement itself is a temp file in the SAME directory, fsync'd, then
 * `rename`d over the target. `rename` within one directory is atomic, so a
 * crash, a full disk or a killed process leaves either the whole old file or
 * the whole new one — never a truncated mixture. That is the "an App writing
 * badly must not destroy data" floor, and it is the one requirement the relaxed
 * trust model (convergence plan, decision 12) explicitly raised rather than
 * dropped.
 *
 * What v1 deliberately does NOT do: create a file that does not exist, retain a
 * preimage for undo, take a lock, or preserve additional hard links to the old
 * inode. The first is a different verb; the second needs somewhere to put it;
 * the third does not survive this threat model anyway; the fourth is inherent to
 * atomic replace and is written down rather than pretended away.
 *
 * ── Windows, not totals (2026-10-20) ───────────────────────────────────────
 *
 * A listing answers one page of at most `workspaceListMaxEntries`; `after`
 * (the previous page's last `<kind>/<name>`) continues it in the same total
 * order, and the answer echoes `after` so the trusted side can tell an older
 * Runner that ignored it. A replacement larger than one call is STAGED: begin
 * creates a sibling temp file, append writes offset-addressed windows into it,
 * and commit runs the very same compare-and-swap + fsync + chmod + rename as a
 * one-call replace. Staged uploads are bounded in number and swept when idle.
 */

import { createHash, randomBytes } from "node:crypto";
import { promises as fs, type BigIntStats, type Dirent } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { MACHINE_LIMITS } from "./limits.js";
import { workspaceRelativePathProblem } from "./workspace-paths.js";
import { resolveWorkspace } from "./workspaces.js";

/** Filesystem outcomes a caller is expected to handle, not caller bugs. */
export type WorkspaceFilesRefusalCode =
  | "not_found"
  | "not_a_directory"
  | "not_a_file"
  | "not_text"
  | "too_large"
  | "outside_workspace"
  | "denied"
  /** The file is not the version the caller based its edit on. Nothing written. */
  | "digest_mismatch"
  /**
   * No staged upload has this id: it was never begun, already committed or
   * discarded, or swept after idling. The target was not touched.
   */
  | "upload_expired";

export interface WorkspaceEntryRow {
  name: string;
  kind: "file" | "directory" | "other";
  /**
   * POSIX path from the workspace root, for the TRUSTED provider to mint a
   * child ref from. Absent for `other`, which is what makes a symlink
   * unaddressable rather than merely unread.
   */
  relative_path?: string;
  size?: number;
  modified_at?: string;
}

export interface OwnerFileEntryRow {
  name: string;
  kind: "file" | "directory" | "other";
  /** Trusted-side continuation only. Never projected into the View. */
  absolute_path?: string;
  size?: number;
  modified_at?: string;
}

export type AccessOwnerFilesResult =
  | { status: "ok"; mode: "stat"; absolute_path: string; kind: "file" | "directory"; size: number }
  | {
      status: "ok";
      mode: "list";
      absolute_path: string;
      /** The cursor this page continues from, echoed when one was given. */
      after?: string;
      entries: OwnerFileEntryRow[];
      truncated: boolean;
    }
  | {
      status: "ok";
      mode: "text";
      absolute_path: string;
      size: number;
      modified_at: string;
      digest: string;
      encoding: "utf-8";
      offset: number;
      bytes: number;
      eof: boolean;
      text: string;
    }
  | {
      status: "ok";
      mode: "binary" | "download";
      absolute_path: string;
      size: number;
      modified_at: string;
      digest: string;
      encoding: "base64";
      offset: number;
      bytes: number;
      eof: boolean;
      data: string;
    }
  | WorkspaceRefused;

export interface WorkspaceEntriesOk {
  status: "ok";
  workspace_id: string;
  /** The directory that was listed, echoed back; `""` is the workspace root. */
  relative_path: string;
  /**
   * The cursor this page continues from, echoed when one was given — so the
   * trusted side can tell this Runner from an older one that ignored it.
   */
  after?: string;
  entries: WorkspaceEntryRow[];
  /** More children follow the last entry of this page. */
  truncated: boolean;
}

export interface WorkspaceRefused {
  status: "refused";
  code: WorkspaceFilesRefusalCode;
}

export type ListWorkspaceEntriesResult = WorkspaceEntriesOk | WorkspaceRefused;

export interface WorkspaceTextOk {
  status: "ok";
  workspace_id: string;
  relative_path: string;
  /** Size of the WHOLE file, in bytes. */
  size: number;
  modified_at: string;
  /** `sha256:<64 hex>` of the whole file version this window was read from. */
  digest: string;
  encoding: "utf-8";
  /** Byte offset this window starts at. Always a UTF-8 boundary. */
  offset: number;
  /** Byte length of this window. */
  bytes: number;
  /** This window reaches the end of the file. */
  eof: boolean;
  text: string;
}

export type ReadWorkspaceTextResult = WorkspaceTextOk | WorkspaceRefused;

export interface WorkspaceBinaryOk {
  status: "ok";
  workspace_id: string;
  relative_path: string;
  size: number;
  modified_at: string;
  digest: string;
  encoding: "base64";
  offset: number;
  bytes: number;
  eof: boolean;
  data: string;
}

export type ReadWorkspaceBinaryResult = WorkspaceBinaryOk | WorkspaceRefused;

/** What a successful replace states about the file it just committed. */
export interface WorkspaceReplaceOk {
  status: "ok";
  workspace_id: string;
  relative_path: string;
  /** Size of the whole file AFTER the replace, in bytes. */
  size: number;
  modified_at: string;
  /** `sha256:<64 hex>` of the new content. */
  digest: string;
  /**
   * The digest that was verified before writing — echoed so the trusted side
   * can check that the device swapped the version it was asked to swap, rather
   * than the one that happened to be there.
   */
  previous_digest: string;
  encoding: "utf-8";
}

/** What `begin` and `append` of a staged replacement state: the bytes staged so far. */
export interface StagedTextOk {
  status: "ok";
  stage: "begin" | "append";
  upload_id: string;
  /** Bytes staged so far — the offset the next `append` must name. */
  size: number;
}

type TextReplaceOk = Omit<WorkspaceReplaceOk, "workspace_id" | "relative_path"> & {
  /** Present on a staged commit, absent on a one-call replace. */
  stage?: "commit";
  upload_id?: string;
};

export type ReplaceWorkspaceTextResult =
  | ((TextReplaceOk | StagedTextOk) & { workspace_id: string; relative_path: string })
  | WorkspaceRefused;

export type ReplaceOwnerTextResult =
  | ((TextReplaceOk | StagedTextOk) & { absolute_path: string })
  | WorkspaceRefused;

/**
 * Syntax only: no filesystem.
 *
 * Moved to `workspace-paths.ts` (a leaf) so `workspaces.ts` can check the same
 * sentence without importing this module, which imports it. Re-exported here
 * because the bot's adapter imports it from `@claude-bot/runner/workspace-files`
 * and that import must not move: one implementation, three call sites.
 */
export { workspaceRelativePathProblem };

function requireRelativePath(value: unknown): string {
  const raw = value === undefined || value === null ? "" : value;
  const problem = workspaceRelativePathProblem(raw);
  if (problem) throw new Error(problem);
  return raw as string;
}

function requireWorkspaceId(value: unknown): string {
  const id = String(value ?? "").trim();
  if (!id) throw new Error("需要 workspace_id");
  return id;
}

function requireAbsolutePath(value: unknown): string {
  if (typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > MACHINE_LIMITS.pathMaxBytes) {
    throw new Error("absolute_path 必须是有界绝对路径");
  }
  if (value.includes("\u0000") || value.includes("\n") || value.includes("\r") || !path.isAbsolute(value)) {
    throw new Error("absolute_path 必须是有界绝对路径");
  }
  return value;
}

/** The only digest form this contract speaks. Compared, never parsed. */
const CONTENT_DIGEST = /^sha256:[0-9a-f]{64}$/;

function requireContentDigest(value: unknown): string {
  const digest = String(value ?? "");
  if (!CONTENT_DIGEST.test(digest)) throw new Error("expected_digest 必须是 sha256:<64 位十六进制>");
  return digest;
}

function sha256Of(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function refused(code: WorkspaceFilesRefusalCode): WorkspaceRefused {
  return { status: "refused", code };
}

// ── Windows over a file of any size ─────────────────────────────────────────
//
// A window read must say which whole-file version it came from (`digest`), and
// a text window must know the WHOLE file is UTF-8. Both are facts about the
// entire file, so they cost one sequential pass. The pass runs once per file
// version and is remembered under the version's metadata key; every window
// after it costs O(window). A window is answered only when that key is the
// same before the facts and after the window's own read, so the bytes and the
// digest returned together always describe one version.
//
// The key is the stat-cache argument git's index makes: content does not
// change without size, mtime or ctime changing, and ctime cannot be set from
// user space. Filesystem clocks are coarse, so — exactly like racy-git — facts
// for a file modified within `RACY_WINDOW_MS` of the pass are used for that one
// answer but never remembered. Everything here decides about the open
// descriptor, never the name.

/** Everything a window answer states about the whole file. */
interface ContentFacts {
  digest: string;
  /** No NUL byte and valid UTF-8 from the first byte to the last. */
  text: boolean;
}

const SCAN_BYTES = 1024 * 1024;
const FACTS_CACHE_ENTRIES = 64;
const RACY_WINDOW_MS = 2_000;
const factsCache = new Map<string, ContentFacts>();

/** Thrown, not refused: the next pull reports the change as one failed read. */
const FILE_CHANGED = "文件在读取过程中被改动了";

function versionKey(stat: BigIntStats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

async function sameVersion(handle: FileHandle, key: string): Promise<void> {
  if (versionKey(await handle.stat({ bigint: true })) !== key) throw new Error(FILE_CHANGED);
}

/** One sequential pass: digest and the UTF-8 verdict, in O(1) memory. */
async function scanContent(handle: FileHandle): Promise<ContentFacts & { bytes: number }> {
  const hash = createHash("sha256");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const buffer = Buffer.allocUnsafe(SCAN_BYTES);
  let text = true;
  let bytes = 0;
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, bytes);
    if (bytesRead <= 0) break;
    const chunk = buffer.subarray(0, bytesRead);
    hash.update(chunk);
    if (text) {
      try {
        text = !chunk.includes(0);
        if (text) decoder.decode(chunk, { stream: true });
      } catch {
        text = false;
      }
    }
    bytes += bytesRead;
  }
  if (text) {
    // A trailing partial character is only detectable at the end.
    try { decoder.decode(); } catch { text = false; }
  }
  return { digest: `sha256:${hash.digest("hex")}`, text, bytes };
}

/** The whole-file facts of the version `stat` describes. */
async function contentFacts(handle: FileHandle, stat: BigIntStats): Promise<ContentFacts> {
  const key = versionKey(stat);
  const cached = factsCache.get(key);
  if (cached) {
    factsCache.delete(key);
    factsCache.set(key, cached);
    return cached;
  }
  const started = Date.now();
  const scanned = await scanContent(handle);
  if (scanned.bytes !== Number(stat.size)) throw new Error(FILE_CHANGED);
  await sameVersion(handle, key);
  const facts = { digest: scanned.digest, text: scanned.text };
  const touchedMs = Number((stat.mtimeNs > stat.ctimeNs ? stat.mtimeNs : stat.ctimeNs) / 1_000_000n);
  if (touchedMs < started - RACY_WINDOW_MS) {
    factsCache.set(key, facts);
    if (factsCache.size > FACTS_CACHE_ENTRIES) factsCache.delete(factsCache.keys().next().value!);
  }
  return facts;
}

/** Positional read of `[offset, offset + length)`, clipped at end of file. */
async function readRange(handle: FileHandle, offset: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, offset + filled);
    if (bytesRead <= 0) break;
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}

interface FileWindowHeader {
  size: number;
  modified_at: string;
  digest: string;
  offset: number;
  bytes: number;
  eof: boolean;
}

type TextWindow = FileWindowHeader & { encoding: "utf-8"; text: string };
type BinaryWindow = FileWindowHeader & { encoding: "base64"; data: string };

/**
 * One UTF-8 window of an open regular file. The window never splits a
 * character; when one character is wider than `maxBytes` it overshoots by at
 * most three bytes, because an empty window would never advance.
 */
async function textWindow(handle: FileHandle, offset: number, maxBytes: number): Promise<TextWindow | WorkspaceRefused> {
  const stat = await handle.stat({ bigint: true });
  if (!stat.isFile()) return refused(stat.isDirectory() ? "not_a_directory" : "not_a_file");
  const size = Number(stat.size);
  if (offset > size) throw new Error("offset 超出了文件长度");
  const facts = await contentFacts(handle, stat);
  if (!facts.text) return refused("not_text");
  // Up to three continuation bytes past the window decide where it may end.
  const bytes = await readRange(handle, offset, Math.min(size - offset, maxBytes + 4));
  await sameVersion(handle, versionKey(stat));
  if (bytes.length !== Math.min(size - offset, maxBytes + 4)) throw new Error(FILE_CHANGED);
  if (bytes.length > 0 && isContinuation(bytes[0])) throw new Error("offset 不在 UTF-8 字符边界上");
  const limit = size - offset;
  let end = Math.min(limit, maxBytes);
  while (end > 0 && end < limit && isContinuation(bytes[end])) end -= 1;
  if (end === 0 && limit > 0) {
    end = Math.min(limit, maxBytes);
    while (end < limit && isContinuation(bytes[end])) end += 1;
  }
  return {
    size,
    modified_at: isoOrUndefined(stat.mtime) ?? new Date(0).toISOString(),
    digest: facts.digest,
    encoding: "utf-8",
    offset,
    bytes: end,
    eof: offset + end >= size,
    text: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end)),
  };
}

/** One raw window of an open regular file, base64 for transport. */
async function binaryWindow(handle: FileHandle, offset: number, maxBytes: number): Promise<BinaryWindow | WorkspaceRefused> {
  const stat = await handle.stat({ bigint: true });
  if (!stat.isFile()) return refused(stat.isDirectory() ? "not_a_directory" : "not_a_file");
  const size = Number(stat.size);
  if (offset > size) throw new Error("offset 超出了文件长度");
  const facts = await contentFacts(handle, stat);
  const length = Math.min(size - offset, maxBytes);
  const window = await readRange(handle, offset, length);
  await sameVersion(handle, versionKey(stat));
  if (window.length !== length) throw new Error(FILE_CHANGED);
  return {
    size,
    modified_at: isoOrUndefined(stat.mtime) ?? new Date(0).toISOString(),
    digest: facts.digest,
    encoding: "base64",
    offset,
    bytes: window.length,
    eof: offset + length >= size,
    data: window.toString("base64"),
  };
}

/** Run one window read on a fresh descriptor; fs failures become codes. */
async function withOpenFile<T>(
  file: string,
  read: (handle: FileHandle) => Promise<T | WorkspaceRefused>,
): Promise<T | WorkspaceRefused> {
  let handle: FileHandle | null = null;
  try {
    handle = await fs.open(file, "r");
    return await read(handle);
  } catch (error) {
    if (error instanceof Error && !(error as NodeJS.ErrnoException).code) throw error;
    return refused(classify(error));
  } finally {
    // Every path — success, refusal, throw — releases the descriptor.
    await handle?.close().catch(() => {});
  }
}

function isRefused<T extends object>(value: T | WorkspaceRefused): value is WorkspaceRefused {
  return "status" in value && value.status === "refused";
}

function windowOffset(value: unknown): number {
  return boundedInt(value, 0, MACHINE_LIMITS.workspaceFileMaxOffset, 0);
}

function windowBytes(value: unknown, max: number): number {
  return boundedInt(value, 1, max, max);
}

/** UTF-8, decided about the WHOLE buffer. `not_text` is never a truncation. */
function isUtf8Text(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function boundedInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Classify an fs failure WITHOUT forwarding its message (it holds the path). */
function classify(error: unknown): WorkspaceFilesRefusalCode {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT" || code === "ELOOP" || code === "ENAMETOOLONG") return "not_found";
  if (code === "ENOTDIR") return "not_a_directory";
  if (code === "EISDIR") return "not_a_file";
  if (code === "EACCES" || code === "EPERM") return "denied";
  return "not_found";
}

type Resolved = { status: "ok"; canonical: string } | WorkspaceRefused;

async function resolveInside(root: string, relative: string): Promise<Resolved> {
  const target = relative === "" ? root : path.join(root, relative);
  // Lexical containment first. `..` segments are already refused, so this is
  // defence in depth rather than the only guard — but it costs one comparison
  // and it fails before any syscall touches an out-of-tree path.
  if (!inside(root, target)) return { status: "refused", code: "outside_workspace" };
  let canonical: string;
  try {
    canonical = await fs.realpath(target);
  } catch (error) {
    return { status: "refused", code: classify(error) };
  }
  // The decision is made on the RESOLVED path: a symlink out of the workspace
  // is a refusal no matter how ordinary the requested path looked.
  if (!inside(root, canonical)) return { status: "refused", code: "outside_workspace" };
  return { status: "ok", canonical };
}

function entryKind(dirent: Dirent): "file" | "directory" | "other" {
  if (dirent.isSymbolicLink()) return "other";
  if (dirent.isDirectory()) return "directory";
  if (dirent.isFile()) return "file";
  return "other";
}

/**
 * Owner-local absolute-path read. The authenticated transport already fixed
 * which account's Runner receives the call; this branch deliberately performs
 * no workspace registry lookup or containment comparison. The OS account is
 * the final accessibility check. Registered-workspace calls below keep their
 * existing confinement for future shared/workspace-scoped grants.
 */
export async function accessOwnerFiles(args: Record<string, unknown>): Promise<AccessOwnerFilesResult> {
  const mode = String(args.mode ?? "");
  if (mode !== "stat" && mode !== "list" && mode !== "text" && mode !== "binary" && mode !== "download") {
    throw new Error("access_owner_files 需要有效 mode");
  }
  const requested = requireAbsolutePath(args.absolute_path);
  let canonical: string;
  try {
    canonical = await fs.realpath(requested);
  } catch (error) {
    return refused(classify(error));
  }

  if (mode === "stat") {
    try {
      const stat = await fs.stat(canonical);
      if (!stat.isFile() && !stat.isDirectory()) return refused("not_a_file");
      return { status: "ok", mode, absolute_path: requested, kind: stat.isFile() ? "file" : "directory", size: stat.size };
    } catch (error) { return refused(classify(error)); }
  }

  if (mode === "list") {
    const limit = boundedInt(
      args.limit,
      1,
      MACHINE_LIMITS.workspaceListMaxEntries,
      MACHINE_LIMITS.workspaceListMaxEntries,
    );
    const after = listCursor(args.after);
    let dirents: Dirent[];
    try {
      dirents = await fs.readdir(canonical, { withFileTypes: true });
    } catch (error) {
      return refused(classify(error));
    }
    const { page, truncated } = listingPage(dirents, after, limit);
    const entries = await mapLimit(page, WORKSPACE_LSTAT_CONCURRENCY, async ({ dirent, kind }) => {
      const row: OwnerFileEntryRow = { name: dirent.name, kind };
      if (kind !== "other") row.absolute_path = path.join(requested, dirent.name);
      try {
        const stat = await fs.lstat(path.join(canonical, dirent.name));
        const modified = isoOrUndefined(stat.mtime);
        if (modified) row.modified_at = modified;
        if (kind === "file") row.size = stat.size;
      } catch {
        // The entry vanished after readdir; the next access answers not_found.
      }
      return row;
    });
    return {
      status: "ok",
      mode,
      absolute_path: requested,
      ...(after ? { after: after.cursor } : {}),
      entries,
      truncated,
    };
  }

  if (mode === "text") {
    const offset = windowOffset(args.offset);
    const maxBytes = windowBytes(args.max_bytes, MACHINE_LIMITS.workspaceTextChunkMaxBytes);
    const window = await withOpenFile(canonical, (handle) => textWindow(handle, offset, maxBytes));
    return isRefused(window) ? window : { status: "ok", mode, absolute_path: requested, ...window };
  }

  const offset = windowOffset(args.offset);
  const maxBytes = windowBytes(args.max_bytes, MACHINE_LIMITS.workspaceMediaChunkMaxBytes);
  const window = await withOpenFile(canonical, (handle) => binaryWindow(handle, offset, maxBytes));
  return isRefused(window) ? window : { status: "ok", mode, absolute_path: requested, ...window };
}

const KIND_RANK: Record<"file" | "directory" | "other", number> = { directory: 0, file: 1, other: 2 };

/** A listing position: what `after` names. */
interface ListCursor {
  kind: "file" | "directory" | "other";
  name: string;
  /** The argument as given, echoed back verbatim. */
  cursor: string;
}

/**
 * `after` is `<kind>/<name>` — the previous page's last row. A name cannot
 * contain `/`, so the first one separates the halves. Malformed is a caller
 * bug, never repaired into some other position.
 */
function listCursor(value: unknown): ListCursor | null {
  if (value === undefined || value === null) return null;
  const cursor = typeof value === "string" ? value : "";
  const slash = cursor.indexOf("/");
  const kind = cursor.slice(0, Math.max(slash, 0));
  const name = cursor.slice(slash + 1);
  if (
    slash <= 0
    || Buffer.byteLength(cursor, "utf8") > MACHINE_LIMITS.workspaceListCursorMaxBytes
    || (kind !== "directory" && kind !== "file" && kind !== "other")
    || !name
    || name.includes("/")
    || name.includes("\u0000")
  ) {
    throw new Error("after 必须是上一页最后一个条目的 <kind>/<name>");
  }
  return { kind, name, cursor };
}

/**
 * One page of a directory in its total order: kind rank, then name by code
 * unit. Keyset, not offset: the page holds the entries strictly after the
 * cursor, so an entry created or removed elsewhere between two pages can
 * neither repeat a row already returned nor hide one not yet returned.
 */
function listingPage(
  dirents: readonly Dirent[],
  after: ListCursor | null,
  limit: number,
): { page: Array<{ dirent: Dirent; kind: "file" | "directory" | "other" }>; truncated: boolean } {
  const sorted = dirents
    .map((dirent) => ({ dirent, kind: entryKind(dirent) }))
    .filter((row) => !after
      || KIND_RANK[row.kind] > KIND_RANK[after.kind]
      || (KIND_RANK[row.kind] === KIND_RANK[after.kind] && compareNames(row.dirent.name, after.name) > 0))
    .sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || compareNames(a.dirent.name, b.dirent.name));
  return { page: sorted.slice(0, limit), truncated: sorted.length > limit };
}

/** Bound metadata I/O while avoiding one serial lstat round trip per entry. */
export const WORKSPACE_LSTAT_CONCURRENCY = 16;

/** Bounded map that preserves the input index regardless of completion order. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        out[index] = await fn(items[index]);
      }
    }),
  );
  return out;
}

/**
 * Locale-free UTF-16 code-unit order (JavaScript's `<`), so two machines and
 * the contract's `compareWorkspaceListPositions` produce the same order.
 */
function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isoOrUndefined(value: Date): string | undefined {
  const ms = value?.getTime?.();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/**
 * List one directory inside a registered workspace.
 *
 * `limit` bounds ONE page; `truncated` says more entries follow, and `after`
 * reaches them. A listing that quietly stopped at 500 entries and looked
 * complete would be the directory-shaped version of the truncation this whole
 * path refuses to do.
 */
export async function listWorkspaceEntries(
  home: string,
  args: Record<string, unknown>,
): Promise<ListWorkspaceEntriesResult> {
  const workspaceId = requireWorkspaceId(args.workspace_id);
  const relative = requireRelativePath(args.relative_path);
  const limit = boundedInt(
    args.limit,
    1,
    MACHINE_LIMITS.workspaceListMaxEntries,
    MACHINE_LIMITS.workspaceListMaxEntries,
  );
  const after = listCursor(args.after);

  let workspace;
  try {
    workspace = await resolveWorkspace(home, workspaceId);
  } catch {
    // Registry and realpath errors contain the device's canonical paths. This
    // operation has no useful recovery detail to send across the wire, so all
    // workspace-resolution failures collapse to the same bounded answer.
    return { status: "refused", code: "not_found" };
  }
  const resolved = await resolveInside(workspace.path, relative);
  if (resolved.status === "refused") return resolved;

  let dirents: Dirent[];
  try {
    dirents = await fs.readdir(resolved.canonical, { withFileTypes: true });
  } catch (error) {
    return { status: "refused", code: classify(error) };
  }

  const { page, truncated } = listingPage(dirents, after, limit);

  const entries = await mapLimit(page, WORKSPACE_LSTAT_CONCURRENCY, async ({ dirent, kind }) => {
    const row: WorkspaceEntryRow = { name: dirent.name, kind };
    if (kind !== "other") {
      row.relative_path = relative === "" ? dirent.name : `${relative}/${dirent.name}`;
    }
    try {
      const stat = await fs.lstat(path.join(resolved.canonical, dirent.name));
      const modified = isoOrUndefined(stat.mtime);
      if (modified) row.modified_at = modified;
      if (kind === "file") row.size = stat.size;
    } catch {
      // The entry vanished between readdir and lstat. Report what readdir saw
      // rather than failing the whole listing over one row.
    }
    return row;
  });

  return {
    status: "ok",
    workspace_id: workspaceId,
    relative_path: relative,
    ...(after ? { after: after.cursor } : {}),
    entries,
    truncated,
  };
}

/**
 * Read one window of a UTF-8 text file inside a registered workspace.
 *
 * The window answers for the whole file — "is UTF-8" and the digest are facts
 * about every byte, so a binary blob whose first window happens to decode is
 * still `not_text`, and a file changed under a partly-read stream surfaces as a
 * different digest rather than a seamless mixture of two versions. Those facts
 * are computed once per file version (see `contentFacts`), so the window itself
 * costs O(window) and a file of any size can be read to its end.
 *
 * Nothing is remembered between calls except those content-addressed facts:
 * there is no server-side cursor to leak, expire or get out of step.
 */
export async function readWorkspaceText(
  home: string,
  args: Record<string, unknown>,
): Promise<ReadWorkspaceTextResult> {
  const workspaceId = requireWorkspaceId(args.workspace_id);
  const relative = requireRelativePath(args.relative_path);
  if (relative === "") throw new Error("read_workspace_text 需要 relative_path");
  const offset = windowOffset(args.offset);
  const maxBytes = windowBytes(args.max_bytes, MACHINE_LIMITS.workspaceTextChunkMaxBytes);
  const resolved = await resolveWorkspaceFile(home, workspaceId, relative);
  if (resolved.status === "refused") return resolved;
  const window = await withOpenFile(resolved.canonical, (handle) => textWindow(handle, offset, maxBytes));
  return isRefused(window)
    ? window
    : { status: "ok", workspace_id: workspaceId, relative_path: relative, ...window };
}

/** Stream a binary file of any size as independent base64 windows. */
export async function readWorkspaceBinary(
  home: string,
  args: Record<string, unknown>,
): Promise<ReadWorkspaceBinaryResult> {
  const workspaceId = requireWorkspaceId(args.workspace_id);
  const relative = requireRelativePath(args.relative_path);
  if (relative === "") throw new Error("read_workspace_binary 需要 relative_path");
  const offset = windowOffset(args.offset);
  const maxBytes = windowBytes(args.max_bytes, MACHINE_LIMITS.workspaceMediaChunkMaxBytes);
  const resolved = await resolveWorkspaceFile(home, workspaceId, relative);
  if (resolved.status === "refused") return resolved;
  const window = await withOpenFile(resolved.canonical, (handle) => binaryWindow(handle, offset, maxBytes));
  return isRefused(window)
    ? window
    : { status: "ok", workspace_id: workspaceId, relative_path: relative, ...window };
}

async function resolveWorkspaceFile(home: string, workspaceId: string, relative: string): Promise<Resolved> {
  let workspace;
  try {
    workspace = await resolveWorkspace(home, workspaceId);
  } catch {
    return refused("not_found");
  }
  return resolveInside(workspace.path, relative);
}

function isContinuation(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

/**
 * Replace the whole content of one existing UTF-8 text file, if it is still the
 * version the caller based its edit on.
 *
 * ── The order is the safety content ────────────────────────────────────────
 *
 *   1. bound the request (workspace id, relative path, digest form, new bytes);
 *   2. resolve the target inside the registered workspace, on the RESOLVED path;
 *   3. open it, and decide everything about the OPEN DESCRIPTOR: it is a plain
 *      file, it is inside the cap, it is UTF-8, and its whole-file digest is the
 *      one that was asserted. A mismatch refuses HERE, before anything exists to
 *      undo;
 *   4. write a sibling temp file, fsync it, chmod it to the target's mode, and
 *      `rename` it over the target. Every failure in this step removes the temp
 *      and leaves the original untouched.
 *
 * Step 3 and step 4 are two separate opens of the same name, so a concurrent
 * writer between them is not excluded — the same statement the read path makes.
 * What CAS buys is not mutual exclusion but the absence of SILENT loss: the
 * common case (a second editor saving a stale buffer) is refused, and the
 * uncommon one (a racing writer in the microseconds between two syscalls) is
 * outside a threat model whose authority is already "this OS account".
 */
export async function replaceWorkspaceText(
  home: string,
  args: Record<string, unknown>,
): Promise<ReplaceWorkspaceTextResult> {
  const workspaceId = requireWorkspaceId(args.workspace_id);
  const relative = requireRelativePath(args.relative_path);
  if (relative === "") throw new Error("replace_workspace_text 需要 relative_path");
  const result = await replaceTextFile(args, async () => {
    let workspace;
    try {
      workspace = await resolveWorkspace(home, workspaceId);
    } catch {
      return refused("not_found");
    }
    return resolveInside(workspace.path, relative);
  });
  return result.status === "ok"
    ? { ...result, workspace_id: workspaceId, relative_path: relative }
    : result;
}

/** Separate owner-local write; the read token never authorizes this operation. */
export async function replaceOwnerText(args: Record<string, unknown>): Promise<ReplaceOwnerTextResult> {
  const requested = requireAbsolutePath(args.absolute_path);
  const result = await replaceTextFile(args, async () => {
    try {
      // Refuse links and special files before opening: they cannot be selected
      // by the file provider, and opening a FIFO could otherwise block forever.
      const stat = await fs.lstat(requested);
      if (!stat.isFile()) return refused("not_a_file");
      return { status: "ok", canonical: await fs.realpath(requested) };
    } catch (error) {
      return refused(classify(error));
    }
  });
  return result.status === "ok" ? { ...result, absolute_path: requested } : result;
}

/**
 * One bounded CAS/atomic-replace implementation for both authority branches.
 *
 * Without `stage` it is the one-call replace it always was. With `stage` it is
 * one step of a staged replacement (see the file header) — and an older Runner
 * that does not know `stage` refuses every step as malformed: `begin`/`commit`
 * carry no `text` and `append` no `expected_digest`, so no step can ever be
 * mistaken for "replace the file with this window".
 */
async function replaceTextFile(
  args: Record<string, unknown>,
  resolve: () => Promise<Resolved>,
): Promise<TextReplaceOk | StagedTextOk | WorkspaceRefused> {
  switch (args.stage) {
    case undefined:
    case null:
      return await replaceWhole(args, resolve);
    case "begin":
      return await beginStagedText(args, resolve);
    case "append":
      return await appendStagedText(args, resolve);
    case "commit":
      return await commitStagedText(args, resolve);
    default:
      throw new Error("stage 必须是 begin、append 或 commit");
  }
}

/**
 * One window of new text, as the bytes it will be. Bounded by the per-call
 * window, and refused rather than re-encoded when it is not UTF-8: a lone
 * surrogate survives JSON but not UTF-8, and `Buffer.from` would replace it —
 * this device would then commit, and hash, bytes the caller did not send.
 */
function textWindowBytes(value: unknown): Buffer | WorkspaceRefused {
  if (typeof value !== "string") throw new Error("文本改写需要 text");
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > MACHINE_LIMITS.workspaceWriteMaxBytes) return refused("too_large");
  if (bytes.toString("utf8") !== value || !isUtf8Text(bytes)) return refused("not_text");
  return bytes;
}

async function replaceWhole(
  args: Record<string, unknown>,
  resolve: () => Promise<Resolved>,
): Promise<TextReplaceOk | WorkspaceRefused> {
  const expectedDigest = requireContentDigest(args.expected_digest);
  const next = textWindowBytes(args.text);
  if (isRefused(next)) return next;

  const resolved = await resolve();
  if (resolved.status === "refused") return resolved;
  const compared = await compareTarget(resolved.canonical, expectedDigest);
  if (isRefused(compared)) return compared;

  const temp = siblingTemp(resolved.canonical);
  try {
    // `wx` so a name collision is an error rather than a silent overwrite of
    // somebody else's temp file. 0600 until publish sets the target's mode.
    const out = await fs.open(temp, "wx", 0o600);
    try {
      await out.writeFile(next);
    } finally {
      await out.close();
    }
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    if (error instanceof Error && !(error as NodeJS.ErrnoException).code) throw error;
    return refused(classify(error));
  }
  const published = await publishTemp(temp, resolved.canonical, compared.mode);
  if (isRefused(published)) return published;
  return {
    status: "ok",
    size: next.length,
    modified_at: published.modified,
    digest: sha256Of(next),
    previous_digest: expectedDigest,
    encoding: "utf-8",
  };
}

/**
 * The compare half of the CAS, decided about the OPEN DESCRIPTOR of the target
 * as it is now: a plain file, UTF-8, and hashing to the asserted digest.
 *
 * A fresh pass, never the window cache: this verdict authorises a write, so it
 * must be about the bytes on disk now, whatever the file's size. Checked for
 * text before the digest so that "this is not a text file" is answered as
 * itself: a caller that computed a digest of a binary file elsewhere must not be
 * able to use this verb on it.
 */
async function compareTarget(canonical: string, expectedDigest: string): Promise<{ mode: number } | WorkspaceRefused> {
  let handle: FileHandle | null = null;
  try {
    // `r`, not `r+`: this step only decides, and a descriptor that could write
    // is a descriptor somebody could later be tempted to write through.
    handle = await fs.open(canonical, "r");
    const stat = await handle.stat();
    if (!stat.isFile()) return refused(stat.isDirectory() ? "not_a_directory" : "not_a_file");
    const current = await scanContent(handle);
    if (!current.text) return refused("not_text");
    if (current.digest !== expectedDigest) return refused("digest_mismatch");
    return { mode: stat.mode & 0o777 };
  } catch (error) {
    if (error instanceof Error && !(error as NodeJS.ErrnoException).code) throw error;
    return refused(classify(error));
  } finally {
    await handle?.close().catch(() => {});
  }
}

function siblingTemp(canonical: string): string {
  return path.join(path.dirname(canonical), `.${path.basename(canonical)}.${randomBytes(8).toString("hex")}.tmp`);
}

/**
 * The swap half: make the temp durable, give it the target's mode, and
 * `rename` it over the target. Every failure removes the temp and leaves the
 * original whole — nothing has been renamed over it.
 */
async function publishTemp(temp: string, canonical: string, mode: number): Promise<{ modified: string } | WorkspaceRefused> {
  let out: FileHandle | null = null;
  let modified: string;
  try {
    out = await fs.open(temp, "r+");
    // Durability BEFORE the rename: a rename that lands before the data does is
    // how an atomic replace still produces an empty file after a power loss.
    await out.sync();
    const written = await out.stat();
    modified = isoOrUndefined(written.mtime) ?? new Date().toISOString();
    await out.close();
    out = null;
    // `open`'s mode argument is masked by umask, so the mode is set explicitly:
    // a replaced file that quietly lost its executable bit is data loss of a
    // kind nobody looks for.
    await fs.chmod(temp, mode);
    await fs.rename(temp, canonical);
  } catch (error) {
    await out?.close().catch(() => {});
    await fs.rm(temp, { force: true }).catch(() => {});
    if (error instanceof Error && !(error as NodeJS.ErrnoException).code) throw error;
    return refused(classify(error));
  }

  // Best effort, and correctly so: some filesystems refuse to fsync a directory
  // and the rename is already ordered after the data on every one of them.
  try {
    const dirHandle = await fs.open(path.dirname(canonical), "r");
    await dirHandle.sync().catch(() => {});
    await dirHandle.close();
  } catch {
    // No recovery detail worth carrying: the swap itself already succeeded.
  }
  return { modified };
}

// ── Staged replacement: a file larger than one call ─────────────────────────
//
// State is one map entry per upload: the target it is bound to (canonical
// path), the digest the edit is based on, the sibling temp file and how many
// bytes it holds. Nothing else — no hasher, no decoder: commit scans the temp
// once for its digest and the UTF-8 verdict, exactly as a read would.
//
// Bounded twice: at most `STAGED_TEXT_MAX` uploads at once, and an upload idle
// for `STAGED_TEXT_IDLE_MS` is swept with its temp file. Any refusal or error in
// `append`/`commit` discards the upload (fail-stop); a retry starts over, which
// is what the CAS needs anyway.

/** Concurrent staged uploads on this Runner. */
export const STAGED_TEXT_MAX = 16;
/** An upload nobody has touched for this long is discarded with its temp file. */
export const STAGED_TEXT_IDLE_MS = 10 * 60_000;

interface StagedText {
  id: string;
  /** The canonical target. Every step must resolve to the same file. */
  target: string;
  temp: string;
  expectedDigest: string;
  size: number;
  touched: number;
  /** One step in flight per upload; the sweep never takes a busy one. */
  busy: boolean;
}

const stagedTexts = new Map<string, StagedText>();
let stagedSweep: NodeJS.Timeout | null = null;

const UPLOAD_ID = /^[0-9a-f]{32}$/;

function requireUploadId(value: unknown): string {
  const id = String(value ?? "");
  if (!UPLOAD_ID.test(id) || id.length > MACHINE_LIMITS.workspaceUploadIdMaxBytes) {
    throw new Error("upload_id 必须是 32 位十六进制");
  }
  return id;
}

function requireByteCount(value: unknown, name: string): number {
  const n = Number(value);
  if (typeof value !== "number" || !Number.isSafeInteger(n) || n < 0 || n > MACHINE_LIMITS.workspaceFileMaxOffset) {
    throw new Error(`${name} 必须是非负整数`);
  }
  return n;
}

function stagedOk(stage: "begin" | "append", entry: StagedText): StagedTextOk {
  return { status: "ok", stage, upload_id: entry.id, size: entry.size };
}

async function discardStaged(entry: StagedText): Promise<void> {
  if (stagedTexts.get(entry.id) === entry) stagedTexts.delete(entry.id);
  if (stagedTexts.size === 0 && stagedSweep) {
    clearInterval(stagedSweep);
    stagedSweep = null;
  }
  await fs.rm(entry.temp, { force: true }).catch(() => {});
}

/**
 * Discard every staged upload idle since `now - STAGED_TEXT_IDLE_MS`. Runs on a
 * timer while any upload exists; exported so a test can move the clock.
 */
export async function sweepStagedTexts(now = Date.now()): Promise<number> {
  let swept = 0;
  for (const entry of [...stagedTexts.values()]) {
    if (!entry.busy && now - entry.touched >= STAGED_TEXT_IDLE_MS) {
      await discardStaged(entry);
      swept += 1;
    }
  }
  return swept;
}

/** Diagnostics and tests: how many staged uploads this Runner holds. */
export function stagedTextCount(): number {
  return stagedTexts.size;
}

/**
 * Begin: bind an upload id to one target and the digest the edit is based on,
 * and create its empty sibling temp file. Idempotent for the same id, target
 * and digest — a retried begin answers the upload it already began.
 *
 * The cached whole-file facts answer a stale editor here, before it uploads
 * megabytes that commit would refuse. That is an early refusal, not the CAS:
 * commit rescans the target.
 */
async function beginStagedText(
  args: Record<string, unknown>,
  resolve: () => Promise<Resolved>,
): Promise<StagedTextOk | WorkspaceRefused> {
  const id = requireUploadId(args.upload_id);
  const expectedDigest = requireContentDigest(args.expected_digest);
  const resolved = await resolve();
  if (resolved.status === "refused") return resolved;

  const early = await withOpenFile(resolved.canonical, async (handle) => {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile()) return refused(stat.isDirectory() ? "not_a_directory" : "not_a_file");
    const facts = await contentFacts(handle, stat);
    if (!facts.text) return refused("not_text");
    return facts.digest === expectedDigest ? { ok: true as const } : refused("digest_mismatch");
  });
  if (isRefused(early)) return early;

  const existing = (): StagedTextOk | null => {
    const entry = stagedTexts.get(id);
    if (!entry) return null;
    if (entry.target !== resolved.canonical || entry.expectedDigest !== expectedDigest) {
      throw new Error("upload_id 已用于另一次保存");
    }
    entry.touched = Date.now();
    return stagedOk("begin", entry);
  };
  const again = existing();
  if (again) return again;
  if (stagedTexts.size >= STAGED_TEXT_MAX) {
    await sweepStagedTexts();
    const raced = existing();
    if (raced) return raced;
    if (stagedTexts.size >= STAGED_TEXT_MAX) throw new Error("这台设备上进行中的分段保存过多，请稍后再试");
  }

  // Registered BEFORE the temp exists (and busy), so a concurrent begin with
  // the same id finds this entry instead of creating a second, orphaned temp.
  const entry: StagedText = {
    id,
    target: resolved.canonical,
    temp: siblingTemp(resolved.canonical),
    expectedDigest,
    size: 0,
    touched: Date.now(),
    busy: true,
  };
  stagedTexts.set(id, entry);
  if (!stagedSweep) {
    stagedSweep = setInterval(() => void sweepStagedTexts(), 60_000);
    stagedSweep.unref?.();
  }
  try {
    const out = await fs.open(entry.temp, "wx", 0o600);
    await out.close();
  } catch (error) {
    await discardStaged(entry);
    if (error instanceof Error && !(error as NodeJS.ErrnoException).code) throw error;
    return refused(classify(error));
  } finally {
    entry.busy = false;
    entry.touched = Date.now();
  }
  return stagedOk("begin", entry);
}

/** The staged upload `args.upload_id` names, claimed for one step. */
async function claimStaged(
  args: Record<string, unknown>,
  resolve: () => Promise<Resolved>,
): Promise<StagedText | WorkspaceRefused> {
  const entry = stagedTexts.get(requireUploadId(args.upload_id));
  if (!entry) return refused("upload_expired");
  if (entry.busy) throw new Error("这次分段保存已有一个步骤在进行");
  entry.busy = true;
  try {
    const resolved = await resolve();
    if (resolved.status === "refused") {
      await discardStaged(entry);
      return resolved;
    }
    // Every step names its file, so an approval card says what it touches;
    // the upload stays bound to the file it began on.
    if (resolved.canonical !== entry.target) {
      await discardStaged(entry);
      throw new Error("分段保存的目标文件已经改变");
    }
    return entry;
  } catch (error) {
    entry.busy = false;
    throw error;
  }
}

/**
 * Append: write one window at `offset` into the temp file. `offset` must equal
 * the bytes staged so far; a replay of the window that ended at the staged size
 * (a retry whose first answer was lost) is recognised and changes nothing.
 */
async function appendStagedText(
  args: Record<string, unknown>,
  resolve: () => Promise<Resolved>,
): Promise<StagedTextOk | WorkspaceRefused> {
  const claimed = await claimStaged(args, resolve);
  if (isRefused(claimed)) return claimed;
  const entry = claimed;
  try {
    const offset = requireByteCount(args.offset, "offset");
    const chunk = textWindowBytes(args.text);
    if (isRefused(chunk)) {
      await discardStaged(entry);
      return chunk;
    }
    if (offset === entry.size) {
      const out = await fs.open(entry.temp, "r+");
      try {
        let written = 0;
        while (written < chunk.length) {
          const { bytesWritten } = await out.write(chunk, written, chunk.length - written, offset + written);
          if (bytesWritten <= 0) throw new Error("分段写入没有进展");
          written += bytesWritten;
        }
      } finally {
        await out.close();
      }
      entry.size += chunk.length;
    } else if (offset + chunk.length === entry.size) {
      const handle = await fs.open(entry.temp, "r");
      let same: boolean;
      try {
        same = (await readRange(handle, offset, chunk.length)).equals(chunk);
      } finally {
        await handle.close();
      }
      if (!same) throw new Error("重放的分段与已暂存的内容不一致");
    } else {
      throw new Error("offset 与已暂存的字节数不一致");
    }
    return stagedOk("append", entry);
  } catch (error) {
    await discardStaged(entry);
    if (error instanceof Error && !(error as NodeJS.ErrnoException).code) throw error;
    return refused(classify(error));
  } finally {
    entry.busy = false;
    entry.touched = Date.now();
  }
}

/**
 * Commit: the upload is consumed whatever happens, so it can never commit
 * twice. The staged bytes must be exactly `size` and valid UTF-8; then the
 * target goes through the same compare (fresh scan against `expected_digest`)
 * and publish (fsync, chmod, rename) as a one-call replace.
 */
async function commitStagedText(
  args: Record<string, unknown>,
  resolve: () => Promise<Resolved>,
): Promise<TextReplaceOk | WorkspaceRefused> {
  const claimed = await claimStaged(args, resolve);
  if (isRefused(claimed)) return claimed;
  const entry = claimed;
  stagedTexts.delete(entry.id);
  let published = false;
  try {
    const expectedDigest = requireContentDigest(args.expected_digest);
    const size = requireByteCount(args.size, "size");
    if (expectedDigest !== entry.expectedDigest) throw new Error("commit 的 expected_digest 与 begin 不一致");
    if (size !== entry.size) throw new Error("commit 的 size 与已暂存的字节数不一致");
    const staged = await withOpenFile(entry.temp, (handle) => scanContent(handle));
    if (isRefused(staged)) return staged;
    if (staged.bytes !== entry.size) throw new Error("暂存文件的长度与已暂存的字节数不一致");
    if (!staged.text) return refused("not_text");
    const compared = await compareTarget(entry.target, expectedDigest);
    if (isRefused(compared)) return compared;
    const swap = await publishTemp(entry.temp, entry.target, compared.mode);
    if (isRefused(swap)) return swap;
    published = true;
    return {
      status: "ok",
      stage: "commit",
      upload_id: entry.id,
      size: entry.size,
      modified_at: swap.modified,
      digest: staged.digest,
      previous_digest: expectedDigest,
      encoding: "utf-8",
    };
  } finally {
    entry.busy = false;
    if (!published) await discardStaged(entry);
    else if (stagedTexts.size === 0 && stagedSweep) {
      clearInterval(stagedSweep);
      stagedSweep = null;
    }
  }
}
