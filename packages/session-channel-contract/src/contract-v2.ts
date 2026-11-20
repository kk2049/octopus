/**
 * `session-channel/v2` — v1's verbs, with a message as long as a session prompt.
 *
 * v1 caps `send.content` at 16,384 characters. That is narrower than what the
 * session behind the channel accepts — a prompt of 384 KiB of UTF-8
 * (`SESSION_PROMPT_MAX_BYTES`, `packages/runner/src/limits.ts`) — so an App
 * could not send a message the session would have taken. The bound cannot be
 * raised in place: v1's readers (the device adapter behind the private Tentacle
 * tool) check it, and a v1 adapter handed a longer message would refuse it after
 * the trusted side had promised it would fit.
 *
 * v2 changes only that:
 *
 *  · `content` takes the View wire's one oversized parameter slot
 *    (`WIRE_PARAM_LIMITS.maxDeclaredValueLength`, 384 Ki characters), so a
 *    message within the budget is never cut by the transport;
 *  · the real budget is BYTES, which a character bound cannot state:
 *    `sessionTextProblem` measures UTF-8, and the provider refuses past it with
 *    v1's `too_large` — refused, never truncated.
 *
 * Unchanged: the verbs, the operations (so a grant made for v1 covers v2 and
 * nobody re-consents), the refusal vocabulary, the receipts and the activity
 * projection. Activity paging (64 events / 64 KiB per batch, cursor) is a window
 * and stays. A device adapter serves v2 under its own private Tentacle tool,
 * `octo_session_channel_v2`, which the trusted side never lets be shared.
 */
import { WIRE_PARAM_LIMITS, declareContract } from "@claude-bot/typed-port-kit";
import {
  SESSION_CHANNEL_DECLARATION,
  SESSION_CHANNEL_LIMITS,
  SESSION_CHANNEL_REFUSALS,
  SESSION_CHANNEL_TENTACLE_TOOL,
} from "./contract.js";

export const SESSION_CHANNEL_CONTRACT_V2 = "session-channel/v2";
/** Fixed name of the private dsh adapter tool that serves v2. */
export const SESSION_CHANNEL_V2_TENTACLE_TOOL = "octo_session_channel_v2";
/** Every session-channel adapter tool: owner-bound, never shareable. */
export const SESSION_CHANNEL_TENTACLE_TOOLS: readonly string[] = Object.freeze([
  SESSION_CHANNEL_TENTACLE_TOOL,
  SESSION_CHANNEL_V2_TENTACLE_TOOL,
]);

export const SESSION_CHANNEL_V2_LIMITS = Object.freeze({
  ...SESSION_CHANNEL_LIMITS,
  /** Characters one message may carry on the wire: the wire's oversized slot. */
  maxTextLength: WIRE_PARAM_LIMITS.maxDeclaredValueLength,
  /** UTF-8 bytes one message may carry: the session prompt budget. */
  maxTextBytes: 384 * 1024,
});

const v1 = SESSION_CHANNEL_DECLARATION.byAction;

export const SESSION_CHANNEL_DECLARATION_V2 = declareContract({
  contract: SESSION_CHANNEL_CONTRACT_V2,
  summary:
    "向已由可信宿主绑定 owner 的 agent session 投递文本（最多为会话 prompt 预算 384 KiB），并以 cursor 读取有界、脱敏的 activity。",
  refusals: SESSION_CHANNEL_REFUSALS,
  actions: {
    open_session: { summary: v1.open_session.summary, operation: v1.open_session.operation, params: v1.open_session.params },
    send: {
      summary: v1.send.summary,
      operation: v1.send.operation,
      params: {
        ...v1.send.params,
        content: {
          type: "string",
          description:
            `纯文本消息，最多 ${SESSION_CHANNEL_V2_LIMITS.maxTextBytes} 字节 UTF-8（会话 prompt 预算 384 KiB）；`
            + "超过时拒绝为 too_large，不截断。",
          maxLength: SESSION_CHANNEL_V2_LIMITS.maxTextLength,
        },
      },
    },
    stop: { summary: v1.stop.summary, operation: v1.stop.operation, params: v1.stop.params },
    read_activity: { summary: v1.read_activity.summary, operation: v1.read_activity.operation, params: v1.read_activity.params },
  },
});

export type SessionChannelV2ActionId = (typeof SESSION_CHANNEL_DECLARATION_V2.actionIds)[number];

/** UTF-8 length by arithmetic (a lone surrogate encodes as U+FFFD, three bytes). */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit < 0xdc00 && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Why `content` cannot be sent, or null. The provider answers `too_large` with
 * this sentence; a sender may check first to keep the person's draft.
 */
export function sessionTextProblem(content: string): string | null {
  const bytes = utf8ByteLength(content);
  return bytes > SESSION_CHANNEL_V2_LIMITS.maxTextBytes
    ? `消息为 ${bytes} 字节（UTF-8），超过会话 prompt 预算 ${SESSION_CHANNEL_V2_LIMITS.maxTextBytes} 字节（384 KiB）；请拆成多条或改为附件`
    : null;
}
