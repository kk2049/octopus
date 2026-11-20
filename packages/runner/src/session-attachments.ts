import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MACHINE_LIMITS } from "./limits.js";
export { sessionAttachmentWorkspace } from "./session-attachment-target.js";

/** Keeps every RPC frame comfortably below the Runner/WebSocket ceiling. */
export const SESSION_ATTACHMENT_CHUNK_BYTES = MACHINE_LIMITS.sessionAttachmentChunkBytes;
export const SESSION_ATTACHMENT_MAX_CHUNKS = MACHINE_LIMITS.sessionAttachmentMaxChunks;
const ACTIVE_UPLOAD_MAX = 32;
// Leave room for the device and concurrent bounded writes, independent of file size.
const DISK_RESERVE_BYTES = 16 * 1024 * 1024;
const ACTIVE_UPLOAD_TTL_MS = 30 * 60 * 1000;
const UPLOAD_ID = /^[A-Za-z0-9_-]{24}$/;

interface ActiveUpload {
  directory: string;
  file: string;
  label: string;
  mediaType: string;
  sessionId: string;
  scope: string;
  destination: string;
  workspaceId?: string;
  chunkCount: number;
  nextChunk: number;
  bytes: number;
  touchedAt: number;
  writing: boolean;
  expiry?: ReturnType<typeof setTimeout>;
}

export interface SessionAttachmentStoreOptions {
  root?: string;
  now?: () => number;
}

/**
 * Device-local, bounded multipart writer for Session Plus chat attachments.
 *
 * The caller never supplies a destination. Chunk zero creates a fresh directory
 * below a locally resolved workspace (or the legacy temporary root); subsequent chunks carry only the opaque id
 * returned by that first call. Incomplete uploads are never returned as message
 * references and are pruned from both memory and disk after a bounded interval.
 */
export class SessionAttachmentStore {
  private readonly uploads = new Map<string, ActiveUpload>();
  private starting = 0;
  private readonly root: string;
  private readonly now: () => number;

  constructor(options: SessionAttachmentStoreOptions = {}) {
    this.root = options.root ?? tmpdir();
    this.now = options.now ?? Date.now;
  }

  async accept(
    args: Readonly<Record<string, unknown>>,
    /** Trusted caller scope; separates multipart state when one process serves multiple owners. */
    scope = "",
    /** Canonical workspace root resolved by this Runner, never a caller path. */
    workspace?: { id: string; path: string },
  ): Promise<Record<string, unknown>> {
    await this.prune();
    const sessionId = boundedSessionId(args.id);
    const chunkIndex = boundedInteger(args.chunk_index, "chunk_index", 0, SESSION_ATTACHMENT_MAX_CHUNKS - 1);
    const chunkCount = boundedInteger(args.chunk_count, "chunk_count", 1, SESSION_ATTACHMENT_MAX_CHUNKS);
    if (chunkIndex >= chunkCount) throw new Error("文件分块序号超出总数");
    const bytes = decodeChunk(args.data);
    const uploadId = String(args.upload_id ?? "").trim();
    const destination = workspace ? JSON.stringify([workspace.id, workspace.path]) : "temporary";

    if (chunkIndex === 0) {
      if (uploadId) throw new Error("文件首块不能携带 upload_id");
      if (this.uploads.size + this.starting >= ACTIVE_UPLOAD_MAX) throw new Error("同时上传的文件过多，请稍后重试");
      this.starting += 1;
      try {
        return await this.begin(sessionId, scope, destination, workspace?.id, workspace?.path, chunkCount, args.name, args.media_type, bytes);
      } finally {
        this.starting -= 1;
      }
    }
    if (!UPLOAD_ID.test(uploadId)) throw new Error("文件 upload_id 无效");
    return await this.continue(uploadId, sessionId, scope, destination, chunkIndex, chunkCount, bytes);
  }

  private async begin(
    sessionId: string,
    scope: string,
    destination: string,
    workspaceId: string | undefined,
    workspacePath: string | undefined,
    chunkCount: number,
    rawName: unknown,
    rawMediaType: unknown,
    bytes: Buffer,
  ): Promise<Record<string, unknown>> {
    const label = attachmentLabel(rawName);
    const mediaType = boundedMediaType(rawMediaType);
    const directory = await fs.realpath(await fs.mkdtemp(path.join(workspacePath ?? this.root, workspacePath ? ".octopus-attachment-" : "octopus-session-")));
    const file = path.join(directory, label);
    try {
      await ensureDiskSpace(directory, bytes.length);
      await fs.writeFile(file, bytes, { flag: "wx", mode: 0o600 });
    } catch (error) {
      await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }

    const uploadId = randomBytes(18).toString("base64url");
    const state: ActiveUpload = {
      directory,
      file,
      label,
      mediaType,
      sessionId,
      scope,
      destination,
      ...(workspaceId ? { workspaceId } : {}),
      chunkCount,
      nextChunk: 1,
      bytes: bytes.length,
      touchedAt: this.now(),
      writing: false,
    };
    if (chunkCount === 1) return completed(uploadId, state);
    this.uploads.set(uploadId, state);
    this.scheduleExpiry(uploadId, state);
    return { upload_id: uploadId, complete: false, received_bytes: state.bytes,
      ...(state.workspaceId ? { workspace_id: state.workspaceId } : {}) };
  }

  private async continue(
    uploadId: string,
    sessionId: string,
    scope: string,
    destination: string,
    chunkIndex: number,
    chunkCount: number,
    bytes: Buffer,
  ): Promise<Record<string, unknown>> {
    const state = this.uploads.get(uploadId);
    if (!state) throw new Error("文件上传已失效，请重新选择文件");
    if (state.sessionId !== sessionId) throw new Error("文件上传不属于当前会话");
    if (state.scope !== scope) throw new Error("文件上传不属于当前账户");
    if (state.destination !== destination) throw new Error("文件上传不属于当前执行工作区");
    if (state.writing) throw new Error("文件分块正在写入，请勿并发或重复上传");
    if (state.chunkCount !== chunkCount || state.nextChunk !== chunkIndex) {
      throw new Error("文件分块顺序不一致，请重新选择文件");
    }
    if (!Number.isSafeInteger(state.bytes + bytes.length)) {
      await this.discard(uploadId, state);
      throw new Error("文件字节计数无法准确表示");
    }
    state.writing = true;
    clearTimeout(state.expiry);
    try {
      await ensureDiskSpace(state.directory, bytes.length);
      if (await fs.realpath(state.directory) !== state.directory || !(await fs.lstat(state.file)).isFile()) {
        throw new Error("文件上传目录或文件已变化");
      }
      await fs.appendFile(state.file, bytes);
    } catch (error) {
      await this.discard(uploadId, state);
      throw error;
    }
    state.writing = false;
    state.bytes += bytes.length;
    state.nextChunk += 1;
    state.touchedAt = this.now();
    if (state.nextChunk === state.chunkCount) {
      this.uploads.delete(uploadId);
      return completed(uploadId, state);
    }
    this.scheduleExpiry(uploadId, state);
    return { upload_id: uploadId, complete: false, received_bytes: state.bytes,
      ...(state.workspaceId ? { workspace_id: state.workspaceId } : {}) };
  }

  private scheduleExpiry(uploadId: string, state: ActiveUpload): void {
    clearTimeout(state.expiry);
    state.expiry = setTimeout(() => { void this.discard(uploadId, state); }, ACTIVE_UPLOAD_TTL_MS);
    state.expiry.unref();
  }

  private async discard(uploadId: string, state: ActiveUpload): Promise<void> {
    clearTimeout(state.expiry);
    this.uploads.delete(uploadId);
    await fs.rm(state.directory, { recursive: true, force: true }).catch(() => undefined);
  }

  private async prune(): Promise<void> {
    const cutoff = this.now() - ACTIVE_UPLOAD_TTL_MS;
    const stale = [...this.uploads.entries()].filter(([, state]) => !state.writing && state.touchedAt < cutoff);
    await Promise.all(stale.map(async ([uploadId, state]) => this.discard(uploadId, state)));
  }
}

function completed(uploadId: string, state: ActiveUpload): Record<string, unknown> {
  return {
    upload_id: uploadId,
    complete: true,
    ...(state.workspaceId ? { workspace_id: state.workspaceId } : {}),
    attachment: {
      label: state.label,
      path: state.file,
      bytes: state.bytes,
      media_type: state.mediaType,
    },
  };
}

function boundedSessionId(value: unknown): string {
  const sessionId = String(value ?? "").trim();
  if (!sessionId || Buffer.byteLength(sessionId, "utf8") > MACHINE_LIMITS.sessionIdMaxBytes) {
    throw new Error("文件上传缺少有效会话 id");
  }
  return sessionId;
}

function boundedInteger(value: unknown, field: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error(`${field} 无效`);
  return parsed;
}

function decodeChunk(value: unknown): Buffer {
  const raw = String(value ?? "");
  if (!raw || raw.length > Math.ceil(SESSION_ATTACHMENT_CHUNK_BYTES / 3) * 4) {
    throw new Error("文件分块为空或过大");
  }
  const bytes = Buffer.from(raw, "base64");
  if (!bytes.length || bytes.length > SESSION_ATTACHMENT_CHUNK_BYTES || bytes.toString("base64") !== raw) {
    throw new Error("文件分块不是有效的 base64");
  }
  return bytes;
}

function attachmentLabel(value: unknown): string {
  const leaf = String(value ?? "").trim().split(/[\\/]/).at(-1) ?? "";
  const raw = truncateUtf8(leaf.replace(/[\u0000-\u001f]/g, ""), MACHINE_LIMITS.sessionAttachmentNameMaxBytes);
  if (!raw || /^\.+$/.test(raw)) return "upload.bin";
  return raw;
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function boundedMediaType(value: unknown): string {
  const mediaType = String(value ?? "").trim().toLowerCase();
  return mediaType && mediaType.length <= 128 ? mediaType : "application/octet-stream";
}

async function ensureDiskSpace(directory: string, bytes: number): Promise<void> {
  const info = await fs.statfs(directory, { bigint: true });
  if (info.bavail * info.bsize < BigInt(DISK_RESERVE_BYTES + ACTIVE_UPLOAD_MAX * bytes)) {
    throw new Error("设备磁盘空间不足，文件上传已停止，请释放空间后重新选择文件");
  }
}
