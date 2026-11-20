import fs from "node:fs/promises";
import path from "node:path";
import { MACHINE_LIMITS } from "@claude-bot/runner/limits";
import { attachmentsRoot, ATTACHMENT_MEDIA } from "./store.js";

/** Only persisted user message references may cause a service-store read. */
function references(text: string): string[] {
  return [...text.matchAll(/`([^`\r\n]+)`/g)].map((match) => match[1]!);
}

const IMAGE_EXTENSIONS = new Map(Object.entries(ATTACHMENT_MEDIA).map(([mediaType, extension]) => [extension, mediaType]));

/** The owner sidecar of a new-format (24-hex) attachment: owner, and the declared media type. */
async function sidecarOf(absolute: string, owner: string): Promise<{ mediaType?: string }> {
  const sidecar = `${absolute}.owner.json`;
  if (!(await fs.lstat(sidecar)).isFile() || (await fs.stat(sidecar)).size > 2048) throw new Error("附件主人记录无效");
  const metadata: unknown = JSON.parse(await fs.readFile(sidecar, "utf8"));
  if (!metadata || typeof metadata !== "object" || !("owner" in metadata) || metadata.owner !== owner) {
    throw new Error("附件不属于工单主人；未发送 Agent 输入");
  }
  const mediaType = (metadata as { media_type?: unknown }).media_type;
  return typeof mediaType === "string" && mediaType.length <= MACHINE_LIMITS.sessionAttachmentMediaTypeMaxBytes ? { mediaType } : {};
}

export async function transferTicketAttachments(input: {
  home: string; owner: string; prompt: string; persistedBodies: readonly string[]; sessionId: string;
  upload(args: Record<string, unknown>): Promise<unknown>;
}): Promise<string> {
  const root = attachmentsRoot(input.home);
  const persisted = new Set(input.persistedBodies.flatMap(references));
  // Every referenced attachment is copied, one at a time and one bounded chunk
  // per Runner call; neither the count nor a file's size has a ceiling here.
  const selected = [...new Set(references(input.prompt).filter((value) => value.startsWith(`${root}${path.sep}`)))];
  let prompt = input.prompt;
  for (const absolute of selected) {
    const relative = path.relative(root, absolute);
    const match = /^(\d{4}-\d{2}-\d{2})\/(\d{6}-([0-9a-f]{8}|[0-9a-f]{24})\.([a-z0-9]{1,10}))$/.exec(relative);
    if (!match || !persisted.has(absolute)) throw new Error("附件引用不属于本工单已保存的上传正文；未发送 Agent 输入");
    // Legacy 8-hex names predate owner sidecars and were only ever images.
    const legacy = match[3]!.length === 8;
    if (legacy && !IMAGE_EXTENSIONS.has(match[4]!)) throw new Error("附件引用不属于本工单已保存的上传正文；未发送 Agent 输入");
    // Reject symlink substitution of either the dated directory or the file.
    const canonicalRoot = await fs.realpath(root);
    if (await fs.realpath(absolute) !== path.join(canonicalRoot, relative) || !(await fs.lstat(absolute)).isFile()) {
      throw new Error("附件存储路径已变化；未发送 Agent 输入");
    }
    const declared = legacy ? {} : await sidecarOf(absolute, input.owner);
    const mediaType = declared.mediaType ?? IMAGE_EXTENSIONS.get(match[4]!) ?? "application/octet-stream";
    const file = await fs.open(absolute, "r");
    let uploadId = "";
    let remotePath = "";
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size < 1) throw new Error("附件为空");
      const size = stat.size;
      const chunkSize = MACHINE_LIMITS.sessionAttachmentChunkBytes;
      const chunkCount = Math.ceil(size / chunkSize);
      const buffer = Buffer.alloc(Math.min(chunkSize, size));
      for (let chunk = 0; chunk < chunkCount; chunk += 1) {
        // Read one window at its offset: memory stays one chunk for any file size.
        const offset = chunk * chunkSize;
        const length = Math.min(chunkSize, size - offset);
        let filled = 0;
        while (filled < length) {
          const read = await file.read(buffer, filled, length - filled, offset + filled);
          if (!read.bytesRead) throw new Error("附件内容已变化");
          filled += read.bytesRead;
        }
        if (chunk === chunkCount - 1 && (await file.stat()).size !== size) throw new Error("附件内容已变化");
        const answer = await input.upload({ id: input.sessionId, name: match[2], media_type: mediaType,
          chunk_index: chunk, chunk_count: chunkCount, ...(uploadId ? { upload_id: uploadId } : {}),
          data: buffer.subarray(0, length).toString("base64") });
        const row = answer as { upload_id?: unknown; complete?: unknown; attachment?: { path?: unknown; bytes?: unknown } } | null;
        if (!row || typeof row.upload_id !== "string" || !/^[A-Za-z0-9_-]{24}$/.test(row.upload_id)
          || (uploadId && uploadId !== row.upload_id)) throw new Error("执行 Runner 返回无效附件回执；未发送 Agent 输入");
        uploadId = row.upload_id;
        if (chunk < chunkCount - 1) {
          if (row.complete === true) throw new Error("执行 Runner 提前结束附件上传");
        } else {
          const attachment = row.attachment;
          if (row.complete !== true || !attachment || typeof attachment.path !== "string"
            || (!path.isAbsolute(attachment.path) && !path.win32.isAbsolute(attachment.path))
            || attachment.path.length > MACHINE_LIMITS.pathMaxBytes || attachment.bytes !== size) {
            throw new Error("执行 Runner 没有确认完整附件；未发送 Agent 输入");
          }
          remotePath = attachment.path;
        }
      }
    } finally { await file.close(); }
    prompt = prompt.replaceAll(`\`${absolute}\``, `\`${remotePath}\``);
  }
  return prompt;
}
