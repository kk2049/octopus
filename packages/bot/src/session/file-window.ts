/**
 * Windowed file access for the user-memory and user-skills planes.
 *
 * Each capability call carries a bounded window (the kernel caps one call's
 * arguments at 512 KiB and its result at 8 MiB), never a whole file: reads
 * return `[offset, offset + maxBytes)` cut between UTF-8 characters with
 * `next_offset`, writes place a chunk at an offset, and listings walk in a
 * total order so a cursor resumes exactly. So a file or a directory of any
 * size is reachable, and nothing is cut without saying where to continue.
 *
 * Paths given here are already jail-resolved by `path-jail.ts`.
 */
import { constants, promises as fs } from "node:fs";
import path from "node:path";

/** Length of `bytes` without a trailing incomplete UTF-8 sequence. */
export function completeUtf8Length(bytes: Buffer): number {
  for (let back = 1; back <= Math.min(4, bytes.length); back++) {
    const byte = bytes[bytes.length - back]!;
    if ((byte & 0xc0) === 0x80) continue;
    const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return need > back ? bytes.length - back : bytes.length;
  }
  return bytes.length;
}

export interface TextWindow {
  size: number;
  offset: number;
  content: string;
  eof: boolean;
  next_offset?: number;
}

/** One window of a text file, cut only between UTF-8 characters. */
export async function readTextWindow(file: string, offset: number, maxBytes: number): Promise<TextWindow> {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset 必须是非负整数");
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("目标不是普通文件");
    if (offset > stat.size) throw new Error(`offset ${offset} 超过文件大小 ${stat.size}`);
    const length = Math.min(maxBytes, stat.size - offset);
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const { bytesRead } = await handle.read(buffer, read, length - read, offset + read);
      if (!bytesRead) break;
      read += bytesRead;
    }
    const atEnd = offset + read >= stat.size;
    const kept = atEnd ? read : completeUtf8Length(buffer.subarray(0, read)) || read;
    const next = offset + kept;
    return {
      size: stat.size,
      offset,
      content: buffer.subarray(0, kept).toString("utf8"),
      eof: next >= stat.size,
      ...(next < stat.size ? { next_offset: next } : {}),
    };
  } finally {
    await handle.close();
  }
}

/**
 * Write `content` at `offset` of an existing file and end the file there:
 * the result is `old[0, offset) + content`. Running it twice leaves the same
 * bytes as running it once, which is what makes a chunked upload retry-safe.
 * Returns the file's new size.
 */
export async function writeAtOffset(file: string, offset: number, content: string): Promise<number> {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset 必须是非负整数");
  const handle = await fs.open(file, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("目标不是普通文件");
    if (offset > stat.size) {
      throw new Error(`offset ${offset} 超过当前文件大小 ${stat.size}：分块写入请从 0 开始，每块的 offset 等于上一块返回的 size`);
    }
    const bytes = Buffer.from(content, "utf8");
    await handle.truncate(offset);
    let written = 0;
    while (written < bytes.length) {
      const { bytesWritten } = await handle.write(bytes, written, bytes.length - written, offset + written);
      written += bytesWritten;
    }
    return offset + bytes.length;
  } finally {
    await handle.close();
  }
}

/** A plain file met by a sorted walk. */
export interface WalkedFile { path: string; full: string }

/**
 * Plain files under `root` in code-unit order of their relative paths,
 * strictly after `after` when given. Directories sort as `name/`, which makes
 * the depth-first order equal the global path order, so a cursor resumes
 * exactly and whole subtrees before it are skipped unread. Symlinks are
 * neither followed nor listed.
 */
export async function* walkFilesSorted(root: string, after?: string, prefix = ""): AsyncGenerator<WalkedFile> {
  let dirents;
  try {
    dirents = await fs.readdir(path.join(root, prefix), { withFileTypes: true });
  } catch {
    return;
  }
  const keyed = dirents
    .filter((d) => d.isFile() || d.isDirectory())
    .map((d) => ({ d, key: d.isDirectory() ? `${prefix}${d.name}/` : `${prefix}${d.name}` }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const { d, key } of keyed) {
    if (d.isDirectory()) {
      // The whole subtree sorts before the cursor: skip it unread.
      if (after !== undefined && after > key && !after.startsWith(key)) continue;
      yield* walkFilesSorted(root, after, key);
    } else if (after === undefined || key > after) {
      yield { path: key, full: path.join(root, key) };
    }
  }
}
