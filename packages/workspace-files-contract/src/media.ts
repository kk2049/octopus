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
import { WORKSPACE_FILES_DECLARATION } from "./write.js";

export const WORKSPACE_FILES_CONTRACT_V3 = "workspace-files/v3";
export const WORKSPACE_MEDIA_RESOURCE_KIND = "workspace-media";
export const WORKSPACE_MEDIA_ACTION = "open_media";
export const WORKSPACE_MEDIA_OPERATION = "read_workspace_file";
export const WORKSPACE_MEDIA_CHUNK_PAYLOAD = "workspace-files/v3#media-chunk";

export const WORKSPACE_MEDIA_TYPES = Object.freeze([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
] as const);
export type WorkspaceMediaType = (typeof WORKSPACE_MEDIA_TYPES)[number];

export const WORKSPACE_MEDIA_LIMITS = Object.freeze({
  /**
   * Largest file size this contract can describe: a representation bound, not
   * a policy (2026-10-20). Bytes travel in `chunkBytes` windows, so neither
   * side holds more than one window unless it chooses to.
   */
  maxBytes: Number.MAX_SAFE_INTEGER,
  /**
   * What an inline preview loads without asking. An image or PDF renders from
   * the whole byte string, so the browser holds all of it; past this a viewer
   * asks before loading and always offers the download.
   */
  previewBytes: 64 * 1024 * 1024,
  chunkBytes: 256 * 1024,
  maxEncodedChunkLength: 349_528,
});

export type WorkspaceMediaRefusalCode = WorkspaceFilesRefusalCode | "unsupported_media";
export const WORKSPACE_MEDIA_REFUSALS = Object.freeze([
  ...WORKSPACE_FILES_REFUSALS,
  "unsupported_media",
] as const satisfies readonly WorkspaceMediaRefusalCode[]);

export interface WorkspaceMediaDocument {
  readonly ref: string;
  readonly label: string;
  readonly mediaType: WorkspaceMediaType;
  readonly sizeBytes: number;
  readonly digest: string;
  readonly modifiedAt?: string;
}

export interface WorkspaceMediaChunk {
  readonly offset: number;
  readonly bytes: number;
  readonly data: string;
}

export type WorkspaceMediaReply<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: WorkspaceMediaRefusalCode; readonly message: string };

export interface WorkspaceMediaOpen {
  readonly document: WorkspaceMediaDocument;
  readonly stream: ResourceStream<WorkspaceMediaChunk>;
}

export interface WorkspaceMediaPort {
  openMedia(ref: string): Promise<WorkspaceMediaReply<WorkspaceMediaOpen>>;
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const DOCUMENT_FIELDS = ["ref", "label", "mediaType", "sizeBytes", "digest", "modifiedAt"] as const;
const CHUNK_FIELDS = ["offset", "bytes", "data"] as const;

export function isWorkspaceMediaType(value: unknown): value is WorkspaceMediaType {
  return typeof value === "string" && (WORKSPACE_MEDIA_TYPES as readonly string[]).includes(value);
}

/** Routing hint only; the trusted provider still identifies the content bytes. */
export function isWorkspaceMediaLabel(label: string): boolean {
  return /\.(?:png|jpe?g|gif|webp|pdf)$/i.test(label);
}

export function workspaceMediaRefusal(
  code: WorkspaceMediaRefusalCode,
  message: string,
): WorkspaceMediaReply<never> {
  const bounded = String(message ?? "").slice(0, WORKSPACE_FILES_LIMITS.maxMessageLength);
  return { ok: false, code, message: bounded || "这次媒体读取没有完成。" };
}

export function readWorkspaceMediaDocument(
  value: unknown,
  at = "document",
): ContractResult<WorkspaceMediaDocument> {
  const bag = new IssueBag();
  const row = objectAt(bag, value, at);
  if (!row) return bag.fail();
  refuseUnknownFields(bag, row, DOCUMENT_FIELDS, at);
  if (typeof row.ref !== "string" || !isResourceRef(row.ref)) {
    bag.add("identifier", "ref must be an opaque resource reference", `${at}.ref`);
  }
  const label = boundedStringAt(bag, row, "label", at, WORKSPACE_FILES_LIMITS.maxLabelLength);
  if (!isWorkspaceMediaType(row.mediaType)) bag.add("schema", "mediaType is not previewable", `${at}.mediaType`);
  const sizeBytes = boundedIntAt(bag, row, "sizeBytes", at, WORKSPACE_MEDIA_LIMITS.maxBytes);
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
      mediaType: row.mediaType as WorkspaceMediaType,
      sizeBytes: sizeBytes!,
      digest: row.digest as string,
      ...(typeof modifiedAt === "string" ? { modifiedAt } : {}),
    },
  };
}

/** Strict RFC 4648 accounting without decoding or allocating the chunk. */
export function base64ByteLength(value: string): number | null {
  if (value.length === 0) return 0;
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return null;
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

export function readWorkspaceMediaChunk(
  value: unknown,
  at = "chunk",
): ContractResult<WorkspaceMediaChunk> {
  const bag = new IssueBag();
  const row = objectAt(bag, value, at);
  if (!row) return bag.fail();
  refuseUnknownFields(bag, row, CHUNK_FIELDS, at);
  const offset = boundedIntAt(bag, row, "offset", at, WORKSPACE_MEDIA_LIMITS.maxBytes);
  const bytes = boundedIntAt(bag, row, "bytes", at, WORKSPACE_MEDIA_LIMITS.chunkBytes);
  const data = boundedStringAt(bag, row, "data", at, WORKSPACE_MEDIA_LIMITS.maxEncodedChunkLength);
  if (data !== null && bytes !== null && base64ByteLength(data) !== bytes) {
    bag.add("schema", "data length does not match bytes", `${at}.data`);
  }
  if (!bag.empty) return bag.fail();
  return { ok: true, value: { offset: offset!, bytes: bytes!, data: data! } };
}

const V3_REFUSALS = refusalVocabulary<WorkspaceMediaRefusalCode>([...WORKSPACE_MEDIA_REFUSALS], {
  fallback: "unavailable",
  maxMessageLength: WORKSPACE_FILES_LIMITS.maxMessageLength,
});

/** v2's projection and verbs, plus one streamed binary preview verb. */
export const WORKSPACE_FILES_DECLARATION_V3 = declareContract({
  contract: WORKSPACE_FILES_CONTRACT_V3,
  summary: "浏览、预览并改写已登记工作区里的文件；所有寻址都使用可信侧铸出的不透明引用。",
  refusals: V3_REFUSALS,
  actions: {
    refresh_roots: WORKSPACE_FILES_DECLARATION.byAction.refresh_roots,
    list_directory: WORKSPACE_FILES_DECLARATION.byAction.list_directory,
    open_text: WORKSPACE_FILES_DECLARATION.byAction.open_text,
    replace_text: WORKSPACE_FILES_DECLARATION.byAction.replace_text,
    open_media: {
      summary: "打开受支持的图片或 PDF；返回经内容识别的文件头，字节按有界流分块拉取",
      operation: WORKSPACE_MEDIA_OPERATION,
      params: { ref: WORKSPACE_FILES_DECLARATION.byAction.open_text.params.ref! },
    },
  },
});
