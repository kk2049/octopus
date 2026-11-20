import { isResourceRef } from "@claude-bot/agent-module-contract";
import {
  IssueBag,
  boundedIntAt,
  boundedStringAt,
  isResourceDigest,
  objectAt,
  refuseUnknownFields,
  type ContractResult,
  type ResourceStream,
} from "@claude-bot/resource-stream-contract";
import { declareContract, refusalVocabulary } from "@claude-bot/typed-port-kit";
import {
  WORKSPACE_FILES_LIMITS,
  WORKSPACE_FILES_REFUSALS,
  type WorkspaceFilesRefusalCode,
} from "./limits.js";
import {
  WORKSPACE_FILES_DECLARATION_V3,
  WORKSPACE_MEDIA_LIMITS,
  base64ByteLength,
  readWorkspaceMediaChunk,
  type WorkspaceMediaChunk,
} from "./media.js";

export const WORKSPACE_FILES_CONTRACT_V4 = "workspace-files/v4";
export const WORKSPACE_DOWNLOAD_ACTION = "download_file";
export const WORKSPACE_DOWNLOAD_OPERATION = "download_workspace_file";
export const WORKSPACE_DOWNLOAD_CHUNK_PAYLOAD = "workspace-files/v4#download-chunk";
export const WORKSPACE_DOWNLOAD_MEDIA_TYPE = "application/octet-stream";
export const WORKSPACE_DOWNLOAD_LIMITS = WORKSPACE_MEDIA_LIMITS;
/** One unanswered pull is a stall; progress on another chunk rearms it. */
export const WORKSPACE_DOWNLOAD_STALL_MS = 20_000;
/**
 * The open is answered after the device has made one pass over a file version
 * it has not seen before (digest), so its honest duration grows with the file.
 * The pass is remembered on the device: a second attempt starts immediately.
 */
export const WORKSPACE_DOWNLOAD_OPEN_STALL_MS = 120_000;

export interface WorkspaceDownloadDocument {
  readonly ref: string;
  readonly label: string;
  readonly mediaType: typeof WORKSPACE_DOWNLOAD_MEDIA_TYPE;
  readonly sizeBytes: number;
  readonly digest: string;
  readonly modifiedAt?: string;
}

export type WorkspaceDownloadChunk = WorkspaceMediaChunk;
export type WorkspaceDownloadReply<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: WorkspaceFilesRefusalCode; readonly message: string };

export interface WorkspaceDownloadOpen {
  readonly document: WorkspaceDownloadDocument;
  readonly stream: ResourceStream<WorkspaceDownloadChunk>;
}

export interface WorkspaceDownloadPort {
  downloadFile(ref: string): Promise<WorkspaceDownloadReply<WorkspaceDownloadOpen>>;
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const DOCUMENT_FIELDS = ["ref", "label", "mediaType", "sizeBytes", "digest", "modifiedAt"] as const;

export function workspaceDownloadRefusal(
  code: WorkspaceFilesRefusalCode,
  message: string,
): WorkspaceDownloadReply<never> {
  const bounded = String(message ?? "").slice(0, WORKSPACE_FILES_LIMITS.maxMessageLength);
  return { ok: false, code, message: bounded || "这次文件下载没有完成。" };
}

export function readWorkspaceDownloadDocument(
  value: unknown,
  at = "document",
): ContractResult<WorkspaceDownloadDocument> {
  const bag = new IssueBag();
  const row = objectAt(bag, value, at);
  if (!row) return bag.fail();
  refuseUnknownFields(bag, row, DOCUMENT_FIELDS, at);
  if (typeof row.ref !== "string" || !isResourceRef(row.ref)) {
    bag.add("identifier", "ref must be an opaque resource reference", `${at}.ref`);
  }
  const label = boundedStringAt(bag, row, "label", at, WORKSPACE_FILES_LIMITS.maxLabelLength);
  if (row.mediaType !== WORKSPACE_DOWNLOAD_MEDIA_TYPE) {
    bag.add("schema", `mediaType must be ${WORKSPACE_DOWNLOAD_MEDIA_TYPE}`, `${at}.mediaType`);
  }
  const sizeBytes = boundedIntAt(bag, row, "sizeBytes", at, WORKSPACE_DOWNLOAD_LIMITS.maxBytes);
  if (!isResourceDigest(row.digest)) bag.add("identifier", "digest must be sha256:<64 hex>", `${at}.digest`);
  const modifiedAt = row.modifiedAt;
  if (modifiedAt !== undefined && (typeof modifiedAt !== "string" || !ISO_INSTANT.test(modifiedAt))) {
    bag.add("schema", "modifiedAt must be an ISO instant", `${at}.modifiedAt`);
  }
  if (!bag.empty) return bag.fail();
  return {
    ok: true,
    value: {
      ref: row.ref as string,
      label: label!,
      mediaType: WORKSPACE_DOWNLOAD_MEDIA_TYPE,
      sizeBytes: sizeBytes!,
      digest: row.digest as string,
      ...(typeof modifiedAt === "string" ? { modifiedAt } : {}),
    },
  };
}

export function readWorkspaceDownloadChunk(
  value: unknown,
  at = "chunk",
): ContractResult<WorkspaceDownloadChunk> {
  return readWorkspaceMediaChunk(value, at);
}

export type CollectedWorkspaceDownload =
  | {
      readonly ok: true;
      readonly document: WorkspaceDownloadDocument;
    }
  | {
      readonly ok: false;
      readonly document: WorkspaceDownloadDocument | null;
      readonly code: string;
      readonly message: string;
    };

const DOWNLOAD_STALLED = Symbol("workspace-download-stalled");
const DOWNLOAD_TIMERS = globalThis as unknown as {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
};

async function settleDownloadLeg<T>(
  pending: Promise<T>,
  stallMs = WORKSPACE_DOWNLOAD_STALL_MS,
): Promise<T | typeof DOWNLOAD_STALLED> {
  let watchdog: unknown = null;
  try {
    return await Promise.race([
      pending,
      new Promise<typeof DOWNLOAD_STALLED>((resolve) => {
        watchdog = DOWNLOAD_TIMERS.setTimeout(() => resolve(DOWNLOAD_STALLED), stallMs);
      }),
    ]);
  } finally {
    if (watchdog !== null) DOWNLOAD_TIMERS.clearTimeout(watchdog);
  }
}

function reportDownloadProgress(
  onProgress: (receivedBytes: number, totalBytes: number) => void,
  receivedBytes: number,
  totalBytes: number,
): void {
  // Progress is advisory presentation. A throwing consumer must not turn a
  // valid, bounded stream into an exception or skip its release path.
  try {
    onProgress(receivedBytes, totalBytes);
  } catch {
    // Intentionally ignored.
  }
}

function closeDownloadStream(stream: ResourceStream<WorkspaceDownloadChunk>): void {
  void stream.close().catch(() => undefined);
}

/**
 * Pull and validate one v4 download without choosing a browser presentation.
 *
 * Each validated chunk goes to `onChunk` in order and is not retained here, so
 * a file of any size passes through in one window of memory; the sink decides
 * where the bytes live. `ok: true` means every byte the header declared has
 * been delivered, contiguously, exactly once.
 */
export async function collectWorkspaceDownload(
  port: unknown,
  ref: string,
  onChunk: (base64: string) => void,
  isCurrent: () => boolean = () => true,
  onProgress: (receivedBytes: number, totalBytes: number) => void = () => {},
): Promise<CollectedWorkspaceDownload> {
  const downloadPort = port as Partial<WorkspaceDownloadPort>;
  if (typeof downloadPort.downloadFile !== "function") {
    return { ok: false, document: null, code: "unavailable", message: "当前工作区连接不支持文件下载。" };
  }
  const opening = Promise.resolve()
    .then(async () => await downloadPort.downloadFile!(ref))
    .catch(() => null);
  const opened = await settleDownloadLeg(opening, WORKSPACE_DOWNLOAD_OPEN_STALL_MS);
  if (opened === DOWNLOAD_STALLED) {
    // A late successful open owns a stream even though this collection no
    // longer does. Release it as soon as it finally arrives.
    void opening.then((late) => {
      if (late?.ok) closeDownloadStream(late.value.stream);
    });
    return {
      ok: false,
      document: null,
      code: "unanswered",
      message: "下载请求 2 分钟没有回应，本次已结束；设备可能仍在读取大文件，请稍后重新下载。",
    };
  }
  if (!opened) return { ok: false, document: null, code: "unavailable", message: "这次文件下载没有返回结果。" };
  if (!opened.ok) return { ok: false, document: null, code: opened.code, message: opened.message };
  const { document, stream } = opened.value;
  if (!isCurrent()) {
    closeDownloadStream(stream);
    return { ok: false, document, code: "closed", message: "文件下载已取消。" };
  }
  let received = 0;
  reportDownloadProgress(onProgress, received, document.sizeBytes);
  for (;;) {
    if (!isCurrent()) {
      closeDownloadStream(stream);
      return { ok: false, document, code: "closed", message: "文件下载已取消。" };
    }
    const read = await settleDownloadLeg(stream.next().catch(() => null));
    if (read === DOWNLOAD_STALLED) {
      closeDownloadStream(stream);
      return {
        ok: false,
        document,
        code: "stalled",
        message: "下载连续 20 秒没有收到新内容，本次已结束；请点击重新下载。",
      };
    }
    if (!isCurrent()) {
      closeDownloadStream(stream);
      return { ok: false, document, code: "closed", message: "文件下载已取消。" };
    }
    if (!read) {
      closeDownloadStream(stream);
      return {
        ok: false,
        document,
        code: "unavailable",
        message: "下载连接在传输中断开，本次没有生成不完整文件；请重新下载。",
      };
    }
    if (read.kind === "chunk") {
      const bytes = base64ByteLength(read.value.data);
      if (read.value.offset !== received || bytes !== read.value.bytes) {
        closeDownloadStream(stream);
        return { ok: false, document, code: "protocol", message: "下载分块的读取位置不连续。" };
      }
      onChunk(read.value.data);
      received += read.value.bytes;
      reportDownloadProgress(onProgress, received, document.sizeBytes);
      continue;
    }
    closeDownloadStream(stream);
    if (read.kind === "refused") return { ok: false, document, code: read.code, message: read.message };
    if (received !== document.sizeBytes) {
      return { ok: false, document, code: "incomplete", message: "下载流没有送来完整文件。" };
    }
    return { ok: true, document };
  }
}

const V4_REFUSALS = refusalVocabulary<WorkspaceFilesRefusalCode>([...WORKSPACE_FILES_REFUSALS], {
  fallback: "unavailable",
  maxMessageLength: WORKSPACE_FILES_LIMITS.maxMessageLength,
});

/** v3 plus one user-initiated, bounded download for any regular file type. */
export const WORKSPACE_FILES_DECLARATION_V4 = declareContract({
  contract: WORKSPACE_FILES_CONTRACT_V4,
  summary: "浏览、预览、下载并改写已登记工作区里的文件；所有寻址都使用可信侧铸出的不透明引用。",
  refusals: V4_REFUSALS,
  actions: {
    refresh_roots: WORKSPACE_FILES_DECLARATION_V3.byAction.refresh_roots,
    list_directory: WORKSPACE_FILES_DECLARATION_V3.byAction.list_directory,
    open_text: WORKSPACE_FILES_DECLARATION_V3.byAction.open_text,
    replace_text: WORKSPACE_FILES_DECLARATION_V3.byAction.replace_text,
    open_media: WORKSPACE_FILES_DECLARATION_V3.byAction.open_media,
    resolve_file_link: {
      summary: "按会话或文件引用定位本人文件；设备与执行位置由可信侧确定",
      operation: "access_owner_files",
      params: {
        session: { ...WORKSPACE_FILES_DECLARATION_V3.byAction.open_media.params.ref!, optional: true },
        ref: { ...WORKSPACE_FILES_DECLARATION_V3.byAction.open_media.params.ref!, optional: true },
        href: { type: "string", description: "会话中引用的本机文件路径", maxLength: 400 },
      },
    },
    download_file: {
      summary: "下载任意受支持大小的普通文件；返回下载文件头，字节按有界流分块拉取",
      operation: WORKSPACE_DOWNLOAD_OPERATION,
      params: { ref: WORKSPACE_FILES_DECLARATION_V3.byAction.open_media.params.ref! },
    },
  },
});
