import { uiText } from "../i18n/ui-text.js";
/**
 * Pasted files, as mail-style attachments on a composer.
 *
 * ── The shape, and why it is this one ───────────────────────────────────────
 *
 * A screenshot is already on the clipboard when somebody decides to report
 * something. Everything downstream of that — a file manager, a shell, an
 * absolute path typed by hand — is why the picture usually did not make it
 * into the ticket. So Ctrl+V is the whole gesture: the file uploads, a chip
 * appears above the box with its name and an ✕, and the body the agent
 * receives grows one line saying where the file is.
 *
 * The REF IS PART OF THE BODY, not a side channel. An agent reads a ticket as
 * text; an attachment it is not told about is an attachment it will not open.
 * The line is composed at send time from the chips that are still there, which
 * is what makes removing a chip actually remove the picture from the brief
 * rather than only from the strip.
 *
 * Any file type and any size: the bytes go up as sequential chunks of
 * `ATTACHMENT_CHUNK_BYTES`, each one request inside the panel's default body
 * window. Only a raster image gets a local preview link; every other file is a
 * plain label, so a pasted `.html` never becomes a document in this origin.
 *
 * ── What this module does not do ────────────────────────────────────────────
 *
 * It does not delete anything on the server. Removing a chip is a decision
 * about THIS draft; the file keeps its dated directory and the retention rule
 * the route owns. A delete verb here would be a second authority over a path
 * the browser was handed, for no benefit a person would notice.
 */

import { ATTACHMENT_CHUNK_BYTES } from "../contract.js";
import { api } from "./api.js";

/** What one accepted upload is, from the composer's point of view. */
export interface Attachment {
  /** Stable per draft, so React keys and removal do not depend on the path. */
  id: string;
  /** Display name — the server's, extension-corrected. */
  label: string;
  /** Absolute path on the bot host. This is what the agent is told to read. */
  path: string;
  bytes: number;
  mediaType: string;
  /** Object URL for a raster image's local preview, revoked with the chip; "" otherwise. */
  previewUrl: string;
}

/** Raster types a chip may preview from the local file. Everything else is a label. */
const PREVIEWABLE = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export function isPreviewableImage(type: string): boolean {
  return PREVIEWABLE.has(type);
}

/** Every file on a clipboard event. Empty means "not our paste". */
export function filesFromClipboard(data: DataTransfer | null): File[] {
  if (!data) return [];
  const out: File[] = [];
  for (const item of [...data.items]) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) out.push(file);
  }
  return out;
}

function base64Of(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  // Chunked: `String.fromCharCode(...bytes)` on a megabyte-sized array is a
  // call with a million arguments, which is a stack overflow, not a conversion.
  for (let at = 0; at < bytes.length; at += 8192) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 8192));
  }
  return btoa(binary);
}

function readBlob(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(uiText("读不出这个文件")));
    reader.onabort = () => reject(new Error(uiText("文件读取已取消")));
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) resolve(reader.result);
      else reject(new Error(uiText("文件读取没有返回字节")));
    };
    reader.readAsArrayBuffer(blob);
  });
}

interface UploadAnswer {
  complete?: boolean;
  upload_id?: string;
  attachment?: { label?: string; path?: string; bytes?: number; media_type?: string };
}

export interface UploadOptions {
  /** Called after each accepted chunk with the bytes the server holds so far. */
  onProgress?(sent: number, total: number): void;
  /** Checked before every chunk; false stops the upload (its staging expires server-side). */
  current?(): boolean;
}

let sequence = 0;

/**
 * Upload one file, chunk by chunk, and return the chip for it.
 *
 * Only one chunk is in memory at a time. Rejections propagate: the caller
 * shows the server's own sentence next to the composer. Nothing here retries —
 * a refused chunk is an answer, and the person adds the file again.
 */
export async function uploadAttachment(file: File, options: UploadOptions = {}): Promise<Attachment> {
  const total = file.size;
  const chunkCount = Math.max(1, Math.ceil(total / ATTACHMENT_CHUNK_BYTES));
  let uploadId = "";
  let answer: UploadAnswer = {};
  for (let index = 0; index < chunkCount; index += 1) {
    if (options.current && !options.current()) throw new Error(uiText("附件草稿已变化，请重新发送。"));
    const start = index * ATTACHMENT_CHUNK_BYTES;
    const data = base64Of(await readBlob(file.slice(start, start + ATTACHMENT_CHUNK_BYTES)));
    answer = await api<UploadAnswer>("/api/attachments", {
      method: "POST",
      json: {
        chunk_index: index,
        chunk_count: chunkCount,
        ...(index === 0 ? { name: file.name || "", media_type: file.type, size: total } : { upload_id: uploadId }),
        data,
      },
    });
    if (index < chunkCount - 1) {
      if (!answer.upload_id || answer.complete) throw new Error(uiText("上传没有返回文件位置"));
      uploadId = answer.upload_id;
    }
    options.onProgress?.(Math.min(total, start + ATTACHMENT_CHUNK_BYTES), total);
  }
  const stored = answer.attachment;
  if (!stored?.path) throw new Error(uiText("上传没有返回文件位置"));
  const mediaType = stored.media_type || file.type;
  sequence += 1;
  return {
    id: `att-${sequence}`,
    label: stored.label || file.name || "附件",
    path: stored.path,
    bytes: stored.bytes ?? total,
    mediaType,
    previewUrl: isPreviewableImage(mediaType) && isPreviewableImage(file.type) ? URL.createObjectURL(file) : "",
  };
}

/**
 * The lines appended to the body for the attachments still on the draft.
 *
 * Deliberately plain and absolute: an agent on this host opens a path, and a
 * sentence naming the paths is the smallest thing that works in a ticket body,
 * a discussion message and a chat append alike.
 */
export function attachmentRefBlock(attachments: readonly Attachment[]): string {
  if (!attachments.length) return "";
  const lines = attachments.map((item) => `- ${item.label} — \`${item.path}\``);
  return ["", "---", `**附件（${attachments.length} 个，直接读这些绝对路径）**`, ...lines].join("\n");
}

/** Body + refs, in the one order every composer should send them. */
export function withAttachments(body: string, attachments: readonly Attachment[]): string {
  const refs = attachmentRefBlock(attachments);
  return refs ? `${body.trim()}\n${refs}` : body.trim();
}

/** Release one chip's preview. Safe to call twice. */
export function releaseAttachment(attachment: Attachment): void {
  if (!attachment.previewUrl) return;
  try {
    URL.revokeObjectURL(attachment.previewUrl);
  } catch {
    // A preview URL that was never minted (a test double) is not a failure.
  }
}
