import { Sha256 } from "./sha256.js";
import { toBase64 } from "./collaboration.js";
import type { Call } from "./client.js";

/** What an upload reads from: a File, or anything that slices like one. */
export interface ByteSource { readonly size: number; slice(start: number, end: number): Pick<Blob, "arrayBuffer"> }

export { WHOLE_FILE_PREVIEW_BYTES, WHOLE_TEXT_BYTES } from "./budgets.js";

/** One hashing window. The page holds this much of the file at a time, never all of it. */
export const HASH_WINDOW_BYTES = 4 * 1024 * 1024;
/** One `file_chunk` window, as the contract's 48 000 base64 characters allow. */
export const UPLOAD_CHUNK_BYTES = 32_000;

export async function readSlice(source: ByteSource, offset: number, length: number): Promise<Uint8Array<ArrayBuffer>> {
  const end = Math.min(source.size, offset + length);
  const bytes = new Uint8Array(await source.slice(offset, end).arrayBuffer());
  if (bytes.length !== end - offset) throw new Error("文件读取不完整；如果文件在上传期间被修改，请重新选择");
  return bytes;
}

/** The file's SHA-256 in one sequential pass of bounded windows; `null` once `keepGoing` turns false. */
export async function sha256Of(source: ByteSource, keepGoing: () => boolean = () => true): Promise<string | null> {
  const hash = new Sha256();
  for (let offset = 0; offset < source.size; offset += HASH_WINDOW_BYTES) {
    if (!keepGoing()) return null;
    hash.update(await readSlice(source, offset, HASH_WINDOW_BYTES));
  }
  return keepGoing() ? hash.hex() : null;
}

/**
 * Sends `file_chunk` windows from `from` to the end, reading each window from the
 * source just before it is sent. Returns false when `keepGoing` stopped it.
 */
export async function sendChunks(call: Call, upload: string, source: ByteSource, from: number,
  keepGoing: () => boolean, progress: (received: number) => void): Promise<boolean> {
  for (let offset = from; offset < source.size; offset += UPLOAD_CHUNK_BYTES) {
    if (!keepGoing()) return false;
    const bytes = await readSlice(source, offset, UPLOAD_CHUNK_BYTES);
    if (!keepGoing()) return false;
    await call("file_chunk", { upload, offset, data: toBase64(bytes) });
    if (!keepGoing()) return false;
    progress(offset + bytes.length);
  }
  return keepGoing();
}

/**
 * Collects downloaded windows into a Blob, folding them every 16 MiB so the
 * page does not keep tens of thousands of small arrays alive until the end.
 */
export class BlobCollector {
  private readonly parts: Blob[] = [];
  private pending: Uint8Array<ArrayBuffer>[] = [];
  private pendingBytes = 0;
  size = 0;
  add(bytes: Uint8Array<ArrayBuffer>): void {
    this.pending.push(bytes); this.pendingBytes += bytes.length; this.size += bytes.length;
    if (this.pendingBytes >= 16 * 1024 * 1024) { this.parts.push(new Blob(this.pending)); this.pending = []; this.pendingBytes = 0; }
  }
  blob(type: string): Blob { return new Blob([...this.parts, ...this.pending], { type }); }
}
