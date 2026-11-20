/**
 * Durable service custody for ticket attachments, retained for 14 days.
 *
 * A file of any type and any size arrives as sequential chunks
 * (`AttachmentUploads`): each request is bounded by the panel's body window,
 * the bytes are staged on the attachment volume, hashed as they arrive and
 * moved into a dated directory only when the last chunk lands. The total is
 * bounded by the volume's free space, not by a number in this file.
 *
 * Uploading does not select an Agent's execution device. At ticket dispatch,
 * runner-transfer.ts copies only this ticket's persisted attachment references
 * to its bound execution workspace and replaces the provider prompt paths.
 * Nothing in the panel serves these files back over HTTP; agents read them by
 * path, so a non-image file is data on disk, never a document a browser renders.
 * New authenticated uploads have an owner sidecar and a distinct 24-hex name;
 * legacy 8-hex files remain readable under the explicit historical policy.
 */

import { createHash, randomBytes, type Hash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/** Raster image types: the only ones a legacy upload accepted and a chip previews. */
export const ATTACHMENT_MEDIA: Readonly<Record<string, string>> = Object.freeze({
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
});

/** Dated directories older than this are removed on the next upload. */
export const ATTACHMENT_KEEP_DAYS = 14;

/** An unfinished upload idle this long is discarded; the browser sends the file again. */
export const ATTACHMENT_STAGING_TTL_MS = 30 * 60 * 1000;

/**
 * Unfinished uploads one account may hold at once. An anti-abuse bound on
 * staged state (each holds an open hash and a staging file), not a size bound:
 * the panel uploads one file at a time per composer.
 */
export const ATTACHMENT_ACTIVE_UPLOADS_PER_OWNER = 16;

/**
 * Free space every chunk write must leave on the attachment volume. The service
 * database and logs usually share it, so running it to zero would take the
 * whole service down; this is the physical bound that replaces a size cap.
 */
export const ATTACHMENT_DISK_RESERVE_BYTES = 512 * 1024 * 1024;

const STAGING_DIRECTORY = ".staging";
const UPLOAD_ID = /^[A-Za-z0-9_-]{24}$/;

export interface StoredAttachment {
  /** Display name — bounded, extension-corrected. Never a path segment. */
  label: string;
  /** Stable service-store reference; remote agents receive a transferred workspace path. */
  path: string;
  bytes: number;
  mediaType: string;
  /** SHA-256 of the assembled bytes, hex. */
  sha256: string;
}

export type AttachmentRefusalCode =
  | "unsupported_media"
  | "empty"
  | "not_base64"
  | "bad_chunk"
  | "expired"
  | "busy"
  | "size_mismatch"
  | "disk_full"
  | "write_failed";

type Refusal = { ok: false; code: AttachmentRefusalCode; message: string };

export type AttachmentResult = { ok: true; attachment: StoredAttachment } | Refusal;

export type AttachmentChunkResult =
  | { ok: true; complete: false; uploadId: string; receivedBytes: number }
  | { ok: true; complete: true; uploadId: string; attachment: StoredAttachment }
  | Refusal;

export interface AttachmentInput {
  /** The caller's display name. Advisory; the stored name is constructed here. */
  name?: unknown;
  mediaType?: unknown;
  /** base64, with or without a `data:` prefix. */
  data?: unknown;
  /** Authenticated uploader; never read from the HTTP body. */
  owner?: string;
}

export interface AttachmentChunkInput {
  /** Authenticated uploader; never read from the HTTP body. */
  owner: string;
  /** Absent on chunk 0; the id chunk 0 returned on every later chunk. */
  uploadId?: unknown;
  /** Absent means 0: a request without chunk fields is a whole file in one chunk. */
  chunkIndex?: unknown;
  /** Absent means 1. Fixed by chunk 0; every later chunk must repeat it. */
  chunkCount?: unknown;
  /** Declared total bytes (chunk 0, optional). The assembled file must match it. */
  size?: unknown;
  name?: unknown;
  mediaType?: unknown;
  data?: unknown;
}

interface AttachmentKind {
  mediaType: string;
  extension: string;
  image: boolean;
}

interface StagedUpload {
  owner: string;
  file: string;
  kind: AttachmentKind;
  label: string;
  chunkCount: number;
  nextChunk: number;
  bytes: number;
  declaredSize?: number;
  hash: Hash;
  writing: boolean;
  expiry?: ReturnType<typeof setTimeout>;
}

export function attachmentsRoot(home: string): string {
  return path.join(home, ".octopus", "attachments");
}

/** `YYYY-MM-DD` in UTC — the directory name and the retention key in one. */
function attachmentDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** Best effort by definition: retention must never fail an upload. */
async function prune(root: string, today: string): Promise<void> {
  const cutoff = new Date(`${today}T00:00:00.000Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - ATTACHMENT_KEEP_DAYS);
  const oldest = attachmentDay(cutoff);
  try {
    for (const entry of await fs.readdir(root)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(entry) || entry >= oldest) continue;
      await fs.rm(path.join(root, entry), { recursive: true, force: true });
    }
  } catch {
    // The directory may not exist yet, or may be busy. Neither is the
    // uploader's problem, and neither is worth a log line per paste.
  }
}

/** A bounded, extension-correct label. Display only; never a path segment. */
export function attachmentLabel(name: unknown, extension: string, fallback = "粘贴图片"): string {
  const raw = String(name ?? "").trim().replace(/[\u0000-\u001f\\/]/g, "").slice(0, 80);
  const stem = raw.replace(/\.[A-Za-z0-9]{1,10}$/, "");
  return `${stem || fallback}.${extension}`;
}

/**
 * What a declared type and name become on disk. A raster image keeps its
 * canonical extension; any other file keeps a bounded alphanumeric extension
 * from its name (`bin` otherwise) and a syntactically valid media type
 * (`application/octet-stream` otherwise). Neither is trusted for anything but
 * display and the Runner copy's metadata — nothing here renders the bytes.
 */
export function attachmentKind(mediaType: unknown, name: unknown): AttachmentKind {
  const declared = String(mediaType ?? "").trim().toLowerCase();
  const image = ATTACHMENT_MEDIA[declared];
  if (image) return { mediaType: declared, extension: image, image: true };
  const valid = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/.test(declared);
  const extension = /\.([A-Za-z0-9]{1,10})$/.exec(String(name ?? "").trim())?.[1]?.toLowerCase() ?? "bin";
  return { mediaType: valid ? declared : "application/octet-stream", extension, image: false };
}

function refuse(code: AttachmentRefusalCode, message: string): Refusal {
  return { ok: false, code, message };
}

/** Strict base64 → bytes; `Buffer.from` silently drops what it cannot decode. */
function decode(data: unknown): Buffer | Refusal {
  // A data URL prefix is what a browser hands you when it round-trips a blob.
  const raw = String(data ?? "").replace(/^data:[^,]*,/, "");
  if (!raw) return refuse("empty", "这次上传没有内容");
  const bytes = Buffer.from(raw, "base64");
  if (!bytes.length || bytes.toString("base64").replace(/=+$/, "") !== raw.replace(/=+$/, "")) {
    return refuse("not_base64", "这次上传的内容不是有效的 base64");
  }
  return bytes;
}

function safeInteger(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : Number.NaN;
}

async function ensureDiskSpace(directory: string, bytes: number, reserve: number): Promise<boolean> {
  const info = await fs.statfs(directory, { bigint: true });
  return info.bavail * info.bsize >= BigInt(reserve + bytes);
}

/**
 * Move one fully staged file into its dated directory with its sidecar.
 * Returns null after cleaning up both halves when any step fails.
 */
async function commit(
  root: string,
  staged: string,
  meta: { owner?: string; kind: AttachmentKind; label: string; bytes: number; sha256: string },
  now: Date,
): Promise<StoredAttachment | null> {
  const day = attachmentDay(now);
  const directory = path.join(root, day);
  const stamp = now.toISOString().slice(11, 19).replace(/:/g, "");
  const file = `${stamp}-${randomBytes(meta.owner ? 12 : 4).toString("hex")}.${meta.kind.extension}`;
  const absolute = path.join(directory, file);
  let sidecarCreated = false;
  try {
    await fs.mkdir(directory, { recursive: true });
    // The distinct new name cannot enter legacy recovery if metadata is absent.
    if (meta.owner) {
      const sidecar = await fs.open(`${absolute}.owner.json`, "wx", 0o600);
      sidecarCreated = true;
      try {
        await sidecar.writeFile(JSON.stringify({
          owner: meta.owner, media_type: meta.kind.mediaType, bytes: meta.bytes, sha256: meta.sha256,
        }));
      } finally { await sidecar.close(); }
    }
    // Same volume: link-then-unlink is atomic like a rename, so a reader never
    // sees a partial file, and unlike a rename it refuses an existing name.
    await fs.link(staged, absolute);
    await fs.rm(staged, { force: true });
  } catch {
    await fs.rm(staged, { force: true }).catch(() => {});
    if (sidecarCreated) await fs.rm(`${absolute}.owner.json`, { force: true }).catch(() => {});
    return null;
  }
  void prune(root, day);
  return { label: meta.label, path: absolute, bytes: meta.bytes, mediaType: meta.kind.mediaType, sha256: meta.sha256 };
}

/**
 * Chunked uploads: the panel's one writer for attachments of any size.
 *
 * Chunk 0 opens a staging file under `<root>/.staging/` (never a dated
 * directory, so retention and the Runner transfer cannot see it) and returns an
 * opaque upload id. Every later chunk must name that id, its owner, the same
 * `chunkCount` and exactly the next index; anything else is refused without
 * writing. The last chunk checks the declared size, then commits the file with
 * its SHA-256. Unfinished state lives in memory and on disk for at most
 * `ATTACHMENT_STAGING_TTL_MS` idle; a restart orphans it, and the next chunk 0
 * sweeps orphaned staging files by age.
 */
export class AttachmentUploads {
  private readonly uploads = new Map<string, StagedUpload>();
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private readonly reserveBytes: number;

  constructor(
    private readonly home: string,
    options: { now?: () => Date; ttlMs?: number; reserveBytes?: number } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.ttlMs = options.ttlMs ?? ATTACHMENT_STAGING_TTL_MS;
    this.reserveBytes = options.reserveBytes ?? ATTACHMENT_DISK_RESERVE_BYTES;
  }

  /** Unfinished uploads currently held (tests and diagnostics). */
  get active(): number {
    return this.uploads.size;
  }

  async accept(input: AttachmentChunkInput): Promise<AttachmentChunkResult> {
    const index = safeInteger(input.chunkIndex, 0);
    const count = safeInteger(input.chunkCount, 1);
    if (!(count >= 1 && index >= 0 && index < count)) return refuse("bad_chunk", "附件分块序号无效");
    const bytes = decode(input.data);
    if (!Buffer.isBuffer(bytes)) return bytes;
    const uploadId = String(input.uploadId ?? "");
    return index === 0
      ? uploadId ? refuse("bad_chunk", "附件首块不能携带 upload_id") : await this.begin(input, count, bytes)
      : await this.continue(input.owner, uploadId, index, count, bytes);
  }

  private async begin(input: AttachmentChunkInput, count: number, bytes: Buffer): Promise<AttachmentChunkResult> {
    const declared = safeInteger(input.size, 0);
    if (Number.isNaN(declared) || declared < 0) return refuse("bad_chunk", "附件声明的大小无效");
    let held = 0;
    for (const state of this.uploads.values()) if (state.owner === input.owner) held += 1;
    if (held >= ATTACHMENT_ACTIVE_UPLOADS_PER_OWNER) {
      return refuse("busy", `同时未完成的附件上传超过 ${ATTACHMENT_ACTIVE_UPLOADS_PER_OWNER} 个，请等当前上传完成后再添加`);
    }
    const root = attachmentsRoot(this.home);
    const staging = path.join(root, STAGING_DIRECTORY);
    const uploadId = randomBytes(18).toString("base64url");
    const file = path.join(staging, uploadId);
    const kind = attachmentKind(input.mediaType, input.name);
    const state: StagedUpload = {
      owner: input.owner,
      file,
      kind,
      label: attachmentLabel(input.name, kind.extension, kind.image ? "粘贴图片" : "附件"),
      chunkCount: count,
      nextChunk: 1,
      bytes: bytes.length,
      ...(declared ? { declaredSize: declared } : {}),
      hash: createHash("sha256").update(bytes),
      writing: false,
    };
    try {
      await fs.mkdir(staging, { recursive: true, mode: 0o700 });
      await this.sweep(staging);
      if (!(await ensureDiskSpace(staging, bytes.length, this.reserveBytes))) return this.diskFull();
      await fs.writeFile(file, bytes, { flag: "wx", mode: 0o600 });
    } catch {
      await fs.rm(file, { force: true }).catch(() => {});
      return refuse("write_failed", "附件写入失败");
    }
    if (count === 1) return await this.finish(uploadId, state);
    this.uploads.set(uploadId, state);
    this.schedule(uploadId, state);
    return { ok: true, complete: false, uploadId, receivedBytes: state.bytes };
  }

  private async continue(owner: string, uploadId: string, index: number, count: number, bytes: Buffer): Promise<AttachmentChunkResult> {
    const state = UPLOAD_ID.test(uploadId) ? this.uploads.get(uploadId) : undefined;
    // Another owner's id is indistinguishable from an expired one: no oracle.
    if (!state || state.owner !== owner) return refuse("expired", "附件上传已失效，请重新添加文件");
    if (state.writing) return refuse("busy", "附件分块正在写入，请勿并发或重复发送同一上传");
    if (state.chunkCount !== count || state.nextChunk !== index) {
      return refuse("bad_chunk", `附件分块顺序不一致：期望第 ${state.nextChunk + 1}/${state.chunkCount} 块`);
    }
    state.writing = true;
    clearTimeout(state.expiry);
    try {
      if (!(await ensureDiskSpace(path.dirname(state.file), bytes.length, this.reserveBytes))) {
        await this.discard(uploadId, state);
        return this.diskFull();
      }
      await fs.appendFile(state.file, bytes);
    } catch {
      await this.discard(uploadId, state);
      return refuse("write_failed", "附件写入失败");
    }
    state.writing = false;
    state.hash.update(bytes);
    state.bytes += bytes.length;
    state.nextChunk += 1;
    if (state.nextChunk < state.chunkCount) {
      this.schedule(uploadId, state);
      return { ok: true, complete: false, uploadId, receivedBytes: state.bytes };
    }
    this.uploads.delete(uploadId);
    return await this.finish(uploadId, state);
  }

  private async finish(uploadId: string, state: StagedUpload): Promise<AttachmentChunkResult> {
    if (state.declaredSize !== undefined && state.declaredSize !== state.bytes) {
      await fs.rm(state.file, { force: true }).catch(() => {});
      return refuse("size_mismatch", `附件拼装后为 ${state.bytes} 字节，与声明的 ${state.declaredSize} 字节不符；未保存`);
    }
    const attachment = await commit(attachmentsRoot(this.home), state.file, {
      owner: state.owner, kind: state.kind, label: state.label, bytes: state.bytes, sha256: state.hash.digest("hex"),
    }, this.now());
    return attachment ? { ok: true, complete: true, uploadId, attachment } : refuse("write_failed", "附件写入失败");
  }

  private diskFull(): Refusal {
    return refuse("disk_full", "服务端附件磁盘空间不足，上传已停止；请联系管理员释放空间");
  }

  private schedule(uploadId: string, state: StagedUpload): void {
    clearTimeout(state.expiry);
    state.expiry = setTimeout(() => { void this.discard(uploadId, state); }, this.ttlMs);
    state.expiry.unref();
  }

  private async discard(uploadId: string, state: StagedUpload): Promise<void> {
    clearTimeout(state.expiry);
    this.uploads.delete(uploadId);
    await fs.rm(state.file, { force: true }).catch(() => {});
  }

  /** Staging files left by a restart: no live upload names them and they are past the TTL. */
  private async sweep(staging: string): Promise<void> {
    const cutoff = this.now().getTime() - this.ttlMs;
    try {
      for (const entry of await fs.readdir(staging)) {
        if (this.uploads.has(entry)) continue;
        const stat = await fs.lstat(path.join(staging, entry)).catch(() => null);
        if (stat && stat.mtimeMs < cutoff) await fs.rm(path.join(staging, entry), { force: true }).catch(() => {});
      }
    } catch {
      // Best effort, like retention.
    }
  }
}

/**
 * One whole raster image in one call — the legacy Session Plus `attach_image`
 * seam, kept for rollback releases. Its size is bounded by that transport's
 * own request window; the bytes take the same staged commit as a chunked upload.
 */
export async function storeAttachment(
  home: string,
  input: AttachmentInput,
  now: Date = new Date(),
): Promise<AttachmentResult> {
  const mediaType = String(input.mediaType ?? "").toLowerCase();
  const extension = ATTACHMENT_MEDIA[mediaType];
  if (!extension) {
    return refuse("unsupported_media", "这个入口只接受 PNG / JPEG / WebP / GIF 图片");
  }
  const bytes = decode(input.data);
  if (!Buffer.isBuffer(bytes)) return bytes;
  const root = attachmentsRoot(home);
  const staging = path.join(root, STAGING_DIRECTORY);
  const staged = path.join(staging, randomBytes(18).toString("base64url"));
  try {
    await fs.mkdir(staging, { recursive: true, mode: 0o700 });
    await fs.writeFile(staged, bytes, { flag: "wx", mode: 0o600 });
  } catch {
    await fs.rm(staged, { force: true }).catch(() => {});
    return refuse("write_failed", "附件写入失败");
  }
  const attachment = await commit(root, staged, {
    ...(input.owner ? { owner: input.owner } : {}),
    kind: { mediaType, extension, image: true },
    label: attachmentLabel(input.name, extension),
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }, now);
  return attachment ? { ok: true, attachment } : refuse("write_failed", "附件写入失败");
}
