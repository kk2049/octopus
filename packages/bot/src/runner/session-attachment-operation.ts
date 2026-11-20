import type { ArgSpec, OperationSpec } from "@claude-bot/capability-kernel";
import { MACHINE_LIMITS } from "@claude-bot/runner/limits";

/**
 * One schema for the bounded multipart upload served by both Runner devices
 * and the bot host. The Runner Object prepends its mandatory device selector;
 * the bot-host Object has no client-selectable device at all.
 */
export function sessionAttachmentOperation(device?: ArgSpec): OperationSpec {
  return {
    args: {
      ...(device ? { device } : {}),
      id: { type: "string", required: true, maxLength: MACHINE_LIMITS.sessionIdMaxBytes },
      workspace_id: { type: "string", maxLength: 64 },
      name: { type: "string", required: true, maxLength: MACHINE_LIMITS.sessionAttachmentNameMaxBytes },
      media_type: {
        type: "string",
        required: true,
        maxLength: MACHINE_LIMITS.sessionAttachmentMediaTypeMaxBytes,
      },
      chunk_index: {
        type: "number",
        required: true,
        min: 0,
        max: MACHINE_LIMITS.sessionAttachmentMaxChunks - 1,
        integer: true,
      },
      chunk_count: {
        type: "number",
        required: true,
        min: 1,
        max: MACHINE_LIMITS.sessionAttachmentMaxChunks,
        integer: true,
      },
      upload_id: { type: "string", maxLength: MACHINE_LIMITS.sessionAttachmentUploadIdMaxBytes },
      data: {
        type: "string",
        required: true,
        maxLength: MACHINE_LIMITS.sessionAttachmentChunkBase64MaxBytes,
      },
    },
    effect: "modify",
    title: "上传会话文件",
  };
}
