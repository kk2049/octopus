/**
 * The narrow surface a `notify/v1` consumer is written against.
 *
 * Two named methods, and the reason it is two named methods rather than one
 * `call(action, params)` is the reason every port in this family gives: a single
 * generic method is how a component ends up naming an operation the App never
 * meant to expose. What a consumer may ask for IS this interface.
 *
 * Every method resolves. "You may not message that person", "somebody has to
 * approve this first" and "that channel is throttling" are all answers a person
 * should be shown, not exceptions a component must catch — and a thrown error is
 * the one thing on this path that reliably carries an internal identifier across
 * the boundary.
 *
 * What is deliberately absent: no `listRecipients`, no `whoAmI`, no delivery
 * status subscription, no read receipt. The first is a permission contract
 * change (it discloses a colleague list); the second could only invent an
 * identity; the last two are a second, stateful contract.
 */

import type { ContractBound, PortRefusal, PortReply } from "@claude-bot/typed-port-kit";

import { NOTIFY_CONTRACT, NOTIFY_REFUSALS, type NotifyRefusalCode } from "./contract.js";
import type { NotifyCard, NotifyReceipt } from "./projection.js";

export type NotifyReply<T> = PortReply<T, NotifyRefusalCode>;
export type NotifyRefusal = PortRefusal<NotifyRefusalCode>;

export interface NotifyPort extends ContractBound<typeof NOTIFY_CONTRACT> {
  /** Send plain text to one recipient this port was handed a ref for. */
  sendText(recipient: string, body: string): Promise<NotifyReply<NotifyReceipt>>;
  /** Send a display-only card to one recipient this port was handed a ref for. */
  sendCard(recipient: string, card: NotifyCard): Promise<NotifyReply<NotifyReceipt>>;
}

/** Build a refusal with its text bounded the same way everywhere. */
export function notifyRefusal(code: NotifyRefusalCode, message: string): NotifyRefusal {
  return NOTIFY_REFUSALS.refuse(code, message);
}

/**
 * A port that may look but not send.
 *
 * Not a different interface — the same one, with both methods refusing. A
 * consumer that is not authorised to send therefore reuses its components
 * unchanged and discovers the limit the way it discovers every other limit: a
 * bounded refusal from the other side. `agent-sessions/v1`'s `READ_ONLY_REFUSAL`
 * is the precedent.
 */
export const NOT_AUTHORISED_REFUSAL: NotifyRefusal = notifyRefusal(
  "no_authority",
  "这个视图没有被授予任何通知投递 operation。",
);
