import { ID_PATTERNS, declareContract, refusalVocabulary } from "@claude-bot/typed-port-kit";

export const SESSION_CHANNEL_CONTRACT = "session-channel/v1";
/** Fixed name of the private dsh adapter tool carried through Tentacle. */
export const SESSION_CHANNEL_TENTACLE_TOOL = "octo_session_channel_v1";

export const SESSION_CHANNEL_LIMITS = Object.freeze({
  maxRefLength: 200,
  maxIdempotencyKeyLength: 128,
  maxTextLength: 16_384,
  maxActivityBatch: 64,
  maxActivityBytes: 64 * 1024,
  maxMessageLength: 240,
});

export const SESSION_CHANNEL_REFUSALS = refusalVocabulary(
  [
    "unavailable",
    "rejected",
    "bad_binding",
    "session_unavailable",
    "too_large",
    "no_authority",
    "scope_closed",
    "invalid_request",
    "cursor_expired",
    "busy",
  ],
  { fallback: "unavailable", maxMessageLength: SESSION_CHANNEL_LIMITS.maxMessageLength },
);

const REF = Object.freeze({
  type: "string" as const,
  description: "由可信宿主铸造的不透明引用；只能比较，不能解析或寻址。",
  maxLength: SESSION_CHANNEL_LIMITS.maxRefLength,
  pattern: ID_PATTERNS.resourceRef,
});

const IDEMPOTENCY_KEY = Object.freeze({
  type: "string" as const,
  description: "调用方稳定生成的有界幂等键；重试必须复用同一个值。",
  maxLength: SESSION_CHANNEL_LIMITS.maxIdempotencyKeyLength,
  pattern: /^[A-Za-z0-9_.:-]{1,128}$/,
});

export const SESSION_CHANNEL_DECLARATION = declareContract({
  contract: SESSION_CHANNEL_CONTRACT,
  summary: "向已由可信宿主绑定 owner 的 agent session 投递文本，并以 cursor 读取有界、脱敏的 activity。",
  refusals: SESSION_CHANNEL_REFUSALS,
  actions: {
    open_session: {
      summary: "幂等打开或恢复一个可信 binding 的 session",
      operation: "open_session_channel",
      params: {
        binding_ref: REF,
        client_conversation_ref: REF,
        idempotency_key: IDEMPOTENCY_KEY,
      },
    },
    send: {
      summary: "向既有 session 幂等投递一条纯文本消息",
      operation: "send_session_message",
      params: {
        session_ref: REF,
        client_message_id: IDEMPOTENCY_KEY,
        content: {
          type: "string",
          description: `纯文本消息，最多 ${SESSION_CHANNEL_LIMITS.maxTextLength} 个字符。`,
          maxLength: SESSION_CHANNEL_LIMITS.maxTextLength,
        },
        delivery: {
          type: "string",
          description: "followup 默认排到下一轮；steer 明确改变当前运行。",
          maxLength: 8,
          enum: ["followup", "steer"],
        },
      },
    },
    stop: {
      summary: "幂等停止当前 session 的运行",
      operation: "stop_session_channel",
      params: {
        session_ref: REF,
        request_id: IDEMPOTENCY_KEY,
        reason: { type: "string", description: "给本机 harness 的安全停止说明。", maxLength: 200 },
      },
    },
    read_activity: {
      summary: "从单调 cursor 后读取一个有界 activity 批次",
      operation: "read_session_activity",
      params: {
        session_ref: REF,
        after_cursor: {
          type: "integer",
          description: "上次已确认的单调 cursor。",
          minimum: 0,
          maximum: Number.MAX_SAFE_INTEGER,
        },
        max_events: {
          type: "integer",
          description: "本批最多事件数。",
          minimum: 1,
          maximum: SESSION_CHANNEL_LIMITS.maxActivityBatch,
        },
        max_bytes: {
          type: "integer",
          description: "本批 UTF-8 JSON 最大字节数。",
          minimum: 256,
          maximum: SESSION_CHANNEL_LIMITS.maxActivityBytes,
        },
      },
    },
  },
});

export type SessionChannelRefusalCode = (typeof SESSION_CHANNEL_REFUSALS.codes)[number];
export const SESSION_CHANNEL_OPERATIONS: readonly string[] = SESSION_CHANNEL_DECLARATION.operations;
