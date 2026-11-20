/** Read repository objects, never bot-host files. The route checks ticket visibility first. */
import { spawn } from "node:child_process";
import path from "node:path";
import type { TicketFilesResponse } from "@claude-bot/dashboard-web/contract";
import type { DevTicketRow } from "../store/repositories/dev-tickets.js";
import { git, worktreeHoldingBranch } from "./worktree.js";

/** Bytes of a file one response carries; `next_offset` continues it, so any size is readable. */
export const TICKET_FILE_WINDOW_BYTES = 1024 * 1024;
/** Entries of a directory one response carries; `next_cursor` continues it. */
export const TICKET_DIRECTORY_PAGE = 1000;
const OBJECT_TIMEOUT_MS = 60_000;

export class TicketFileError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/**
 * Stream a git command's stdout through `onChunk` until it returns true (enough
 * read) or the command ends. Memory holds what the consumer keeps, never the
 * whole object; stopping early kills the child.
 */
function streamGit(repo: string, args: string[], onChunk: (chunk: Buffer) => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: repo, stdio: ["ignore", "pipe", "ignore"] });
    let stopped = false;
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new TicketFileError(504, "读取源码超时")); }, OBJECT_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stopped) return;
      if (onChunk(chunk)) { stopped = true; child.kill("SIGKILL"); }
    });
    child.on("error", () => { clearTimeout(timer); reject(new TicketFileError(422, "源码不可用")); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (stopped || code === 0) resolve();
      else reject(new TicketFileError(422, "源码不可用"));
    });
  });
}

/** Bytes `[offset, offset + length)` of a blob, streamed. */
async function blobWindow(repo: string, blob: string, offset: number, length: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let seen = 0;
  let held = 0;
  await streamGit(repo, ["cat-file", "blob", blob], (chunk) => {
    const start = Math.max(0, offset - seen);
    const end = Math.min(chunk.length, offset + length - seen);
    if (end > start) { parts.push(chunk.subarray(start, end)); held += end - start; }
    seen += chunk.length;
    return held >= length;
  });
  return Buffer.concat(parts, held);
}

/** Length of `bytes` without a trailing incomplete UTF-8 sequence. */
function completeUtf8(bytes: Buffer): number {
  for (let back = 1; back <= Math.min(4, bytes.length); back++) {
    const byte = bytes[bytes.length - back]!;
    if ((byte & 0xc0) === 0x80) continue; // continuation byte: keep looking for the lead
    const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return need > back ? bytes.length - back : bytes.length;
  }
  return bytes.length;
}

/**
 * One window of a committed text file, cut only between UTF-8 characters.
 * Preserves whitespace (git() trims) and rejects invalid UTF-8 or NUL bytes.
 */
async function fileWindow(repo: string, blob: string, offset: number): Promise<{ text: string; size: number; next?: number }> {
  const sized = await git(repo, ["cat-file", "-s", blob], 10_000);
  const size = Number(sized.stdout);
  if (!sized.ok || !Number.isSafeInteger(size)) throw new TicketFileError(422, "源码不可用");
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > size) throw new TicketFileError(400, "offset 无效：请从 0 或上一次返回的 next_offset 继续");
  const raw = await blobWindow(repo, blob, offset, TICKET_FILE_WINDOW_BYTES);
  if (raw.length && (raw[0]! & 0xc0) === 0x80) throw new TicketFileError(400, "offset 不在字符边界：请从上一次返回的 next_offset 继续");
  const end = offset + raw.length;
  const bytes = end < size ? raw.subarray(0, completeUtf8(raw)) : raw;
  if (end < size && !bytes.length) throw new TicketFileError(422, "此文件不是可预览的 UTF-8 文本");
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\0")) throw new Error();
    const next = offset + bytes.length;
    return { text, size, ...(next < size ? { next } : {}) };
  } catch { throw new TicketFileError(422, "此文件不是可预览的 UTF-8 文本"); }
}

type DirectoryEntry = Extract<TicketFilesResponse, { kind: "directory" }>["entries"][number];

/** Directories first, then by name; the code-unit tiebreak keeps the order total for the cursor. */
function entryOrder(a: Pick<DirectoryEntry, "kind" | "name">, b: Pick<DirectoryEntry, "kind" | "name">): number {
  if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
  return a.name.localeCompare(b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

function parseCursor(cursor: string): Pick<DirectoryEntry, "kind" | "name"> {
  const match = /^(d|f)\/(.+)$/s.exec(cursor);
  if (!match) throw new TicketFileError(400, "cursor 无效：请用上一页返回的 next_cursor");
  return { kind: match[1] === "d" ? "directory" : "file", name: match[2]! };
}

/**
 * One page of a tree, streamed: the listing is read once per page and only
 * the page's entries (plus one, to know whether more follow) are kept.
 */
async function directoryPage(repo: string, tree: string, rel: string, cursor: string | undefined) {
  const after = cursor ? parseCursor(cursor) : null;
  const page: DirectoryEntry[] = [];
  let total = 0;
  let unlisted = 0;
  let pending = Buffer.alloc(0);
  const take = (record: Buffer) => {
    // `<mode> <type> <object>\t<name>`, NUL-terminated (-z): names arrive unquoted.
    const tab = record.indexOf(9);
    const head = /^(040000|100644|100755) (tree|blob) [0-9a-f]+$/.exec(record.subarray(0, tab).toString("latin1"));
    if (tab < 0 || !head) return; // symlinks and submodules are not browsable
    const name = record.subarray(tab + 1).toString("utf8");
    if (/[\x00-\x1f\x7f\\]/.test(name)) { unlisted++; return; } // cannot be addressed by this route
    const entry: DirectoryEntry = { name, path: rel ? `${rel}/${name}` : name, kind: head[2] === "tree" ? "directory" : "file" };
    total++;
    if (after && entryOrder(entry, after) <= 0) return;
    // Sorted insertion into a window of PAGE + 1.
    let lo = 0, hi = page.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (entryOrder(page[mid]!, entry) < 0) lo = mid + 1; else hi = mid; }
    if (lo > TICKET_DIRECTORY_PAGE) return;
    page.splice(lo, 0, entry);
    if (page.length > TICKET_DIRECTORY_PAGE + 1) page.pop();
  };
  await streamGit(repo, ["ls-tree", "-z", tree], (chunk) => {
    let data = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    for (let nul = data.indexOf(0); nul >= 0; nul = data.indexOf(0)) {
      take(data.subarray(0, nul));
      data = data.subarray(nul + 1);
    }
    pending = Buffer.from(data);
    return false;
  });
  const more = page.length > TICKET_DIRECTORY_PAGE;
  const entries = page.slice(0, TICKET_DIRECTORY_PAGE);
  const last = entries.at(-1);
  return { entries, total, ...(unlisted ? { unlisted } : {}),
    ...(more && last ? { next_cursor: `${last.kind === "directory" ? "d" : "f"}/${last.name}` } : {}) };
}

function relativeSourcePath(raw: string, roots: string[]): string {
  if (raw.length > 4096 || /[\x00-\x1f\x7f\\]/.test(raw)) throw new TicketFileError(400, "文件路径无效");
  let value = raw;
  if (path.isAbsolute(value)) {
    const root = roots.filter((r) => value === r || value.startsWith(`${r}/`)).sort((a, b) => b.length - a.length)[0];
    if (!root) throw new TicketFileError(403, "只能浏览本工单关联的仓库源码");
    value = value.slice(root.length).replace(/^\//, "");
  }
  const segments = value.split("/");
  if (segments.some((s) => s === ".." || s === ".git") || value.includes(":")) {
    throw new TicketFileError(400, "文件路径不能越过仓库边界");
  }
  return segments.filter((s) => s && s !== ".").join("/");
}

export async function readTicketFiles(
  repo: string, baseBranch: string,
  ticket: Pick<DevTicketRow, "worktree" | "branch" | "commit_sha" | "dev_status">,
  rawPath: string,
  window: { offset?: number; cursor?: string } = {},
): Promise<TicketFilesResponse> {
  const baseRoot = await worktreeHoldingBranch(repo, baseBranch);
  const rel = relativeSourcePath(rawPath, [repo, baseRoot, ticket.worktree].filter((r): r is string => Boolean(r)).map((r) => path.resolve(r)));
  // A requester cannot choose a revision or another ticket's branch. A deleted
  // ticket branch falls back to its recorded landing, then the visible base.
  const refs = [
    ...(ticket.dev_status === "landed" && ticket.commit_sha ? [ticket.commit_sha] : []),
    ...(ticket.branch ? [`refs/heads/${ticket.branch}`] : []),
    ...(ticket.commit_sha ? [ticket.commit_sha] : []),
    `refs/heads/${baseBranch}`,
  ];
  let revision = "";
  let source: "ticket" | "base" = "base";
  for (const ref of refs) {
    const out = await git(repo, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], 10_000);
    if (out.ok && /^[0-9a-f]{40,64}$/.test(out.stdout)) {
      revision = out.stdout;
      source = ref === `refs/heads/${baseBranch}` ? "base" : "ticket";
      break;
    }
  }
  if (!revision) throw new TicketFileError(404, "尚无可浏览的仓库版本");
  let tree = `${revision}^{tree}`;
  if (rel) {
    // literal pathspec defeats wildcard/pathspec magic; mode rejects symlinks
    // and submodules without ever following either into the filesystem.
    const entry = await git(repo, ["ls-tree", "--full-tree", revision, "--", `:(literal)${rel}`], 10_000);
    const match = /^(040000|100644|100755) (tree|blob) ([0-9a-f]{40,64})\t/.exec(entry.stdout);
    if (!entry.ok || !match) throw new TicketFileError(404, "该版本中没有可浏览的文件或目录（仅支持已提交源码）");
    if (match[2] === "blob") {
      const offset = window.offset ?? 0;
      const read = await fileWindow(repo, match[3]!, offset);
      return { kind: "file", path: rel, revision, source, object: match[3]!, text: read.text, size: read.size, offset,
        ...(read.next !== undefined ? { next_offset: read.next } : {}) };
    }
    tree = match[3]!;
  }
  try {
    const object = rel ? tree : (await git(repo, ["rev-parse", "--verify", tree], 10_000)).stdout;
    return { kind: "directory", path: rel, revision, source, object, ...await directoryPage(repo, tree, rel, window.cursor) };
  } catch (error) {
    if (error instanceof TicketFileError && error.status !== 422) throw error;
    throw new TicketFileError(422, "无法读取源码目录");
  }
}
