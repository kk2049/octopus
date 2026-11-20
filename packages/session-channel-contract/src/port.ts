import type { ContractBound, PortReply } from "@claude-bot/typed-port-kit";
import { SESSION_CHANNEL_CONTRACT, type SessionChannelRefusalCode } from "./contract.js";
import type { SESSION_CHANNEL_CONTRACT_V2 } from "./contract-v2.js";
import type { SessionActivityBatch, SessionOpenReceipt, SessionSendReceipt, SessionStopReceipt } from "./projection.js";

export type SessionChannelReply<T> = PortReply<T, SessionChannelRefusalCode>;

export interface SessionChannelPort extends ContractBound<typeof SESSION_CHANNEL_CONTRACT> {
  open(bindingRef: string, clientConversationRef: string, idempotencyKey: string): Promise<SessionChannelReply<SessionOpenReceipt>>;
  send(sessionRef: string, clientMessageId: string, content: string, delivery: "followup" | "steer"): Promise<SessionChannelReply<SessionSendReceipt>>;
  stop(sessionRef: string, requestId: string, reason: string): Promise<SessionChannelReply<SessionStopReceipt>>;
  readActivity(sessionRef: string, afterCursor: number, maxEvents: number, maxBytes: number): Promise<SessionChannelReply<SessionActivityBatch>>;
}

/** v2: the same methods; `send` takes a message up to the session prompt budget. */
export interface SessionChannelPortV2
  extends Omit<SessionChannelPort, "contract">, ContractBound<typeof SESSION_CHANNEL_CONTRACT_V2> {}
