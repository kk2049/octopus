import type { AttachmentInfo, Call } from "@claude-bot/research-docs-contract";
import { decode, encode } from "./session.js";
export async function uploadFile(
  call: Call,
  doc: string,
  file: File,
  onProgress: (p: number) => void,
  request: string = crypto.randomUUID(),
) {
  // Any size: each 32 000-byte block is read from the File just before it is sent.
  if (file.size < 1) throw new Error("请选择非空文件");
  let offset = 0,
    info: AttachmentInfo | undefined;
  while (offset < file.size) {
    const chunk = new Uint8Array(
      await file.slice(offset, offset + 32000).arrayBuffer(),
    );
    const result = await call<{
      file: AttachmentInfo;
      next: number;
      complete: boolean;
    }>("upload", {
      doc,
      request,
      name: file.name,
      media: file.type || "application/octet-stream",
      size: file.size,
      offset,
      data: encode(chunk),
    });
    if (result.next <= offset || result.next > file.size)
      throw new Error("上传回执异常，请保留文件重试");
    offset = result.next;
    info = result.file;
    onProgress(Math.round((offset / file.size) * 100));
  }
  return info!;
}
/**
 * What an automatic (editor-embedded) preview loads before it stops and asks,
 * the shared viewers' media budget. An explicit "加载附件" passes no budget.
 */
export const ATTACHMENT_PREVIEW_BYTES = 64 * 1024 * 1024;
export async function readAttachment(
  call: Call,
  doc: string,
  file: string,
  signal?: AbortSignal,
  budget = Number.POSITIVE_INFINITY,
) {
  // Windows are folded into Blob parts every 16 MiB rather than kept as
  // thousands of small arrays; the attachment itself has no total.
  const parts: Blob[] = [];
  let pending: Uint8Array<ArrayBuffer>[] = [],
    pendingBytes = 0;
  let offset: number | null = 0,
    info: AttachmentInfo | undefined,
    total = 0;
  while (offset !== null) {
    if (signal?.aborted) throw new Error("读取已取消");
    const part: { file: AttachmentInfo; data: string; next: number | null } =
      await call<{ file: AttachmentInfo; data: string; next: number | null }>(
        "attachment",
        { doc, file, offset },
      );
    if (signal?.aborted) throw new Error("读取已取消");
    if (
      part.file.id !== file ||
      !Number.isSafeInteger(part.file.size) ||
      (part.next !== null && part.next <= offset)
    )
      throw new Error("附件回执异常");
    if (part.file.size > budget)
      throw new AttachmentOverBudget(part.file.size, budget);
    const bytes = decode(part.data);
    total += bytes.length;
    if (total > part.file.size) throw new Error("附件数据超出声明大小");
    pending.push(bytes);
    pendingBytes += bytes.length;
    if (pendingBytes >= 16 * 1024 * 1024) {
      parts.push(new Blob(pending));
      pending = [];
      pendingBytes = 0;
    }
    info = part.file;
    offset = part.next;
  }
  if (!info || total !== info.size) throw new Error("附件尚未完整读取");
  return {
    file: info,
    blob: new Blob([...parts, ...pending], { type: info.media }),
  };
}
export class AttachmentOverBudget extends Error {
  constructor(
    readonly size: number,
    readonly budget: number,
  ) {
    super(
      `附件 ${(size / 1024 / 1024).toFixed(1)} MiB，超过编辑器自动预览的 ${(budget / 1024 / 1024).toFixed(0)} MiB；请在附件卡片中点击“加载附件”后查看或下载`,
    );
  }
}
