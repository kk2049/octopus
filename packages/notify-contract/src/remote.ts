/**
 * `notify/v1` over the App's one MessagePort.
 *
 * ── How short this is, is the point ────────────────────────────────────────
 *
 * `@claude-bot/workspace-files-contract`'s equivalent is 509 lines: an `ask()`
 * that folds transport failures, a `refusalOf()` that folds codes, a
 * `streamRefusalOf()` that folds them again for streams, a stream source with
 * its own accounting, a destroyed flag re-checked after every await, a set of
 * live streams to tear down, and a per-method encoder. Every one of those is now
 * in `@claude-bot/typed-port-kit`, so what is left here is the part that is
 * actually about notifications: which action, which reader, and which field has
 * to echo the request.
 *
 * ── The echo rule is not decoration ────────────────────────────────────────
 *
 * A receipt for a DIFFERENT recipient passes `readNotifyReceipt` perfectly — it
 * is a completely valid receipt for somewhere else. A reader cannot catch that,
 * and a UI that renders "sent to ✓" from the receipt would tell a person their
 * message went to the person they chose when it did not. Only comparing against
 * what was asked finds it.
 *
 * ── No streams here ────────────────────────────────────────────────────────
 *
 * `notify/v1` is a write contract with a small, complete answer, so it never
 * touches `resource.stream_pull`. That is worth noticing rather than assuming:
 * the kit's stream half is opt-in, and a contract that does not open streams
 * carries none of it.
 */

import {
  createRemoteCall,
  type ProposalTransport,
  type RemoteMessages,
} from "@claude-bot/typed-port-kit";

import { NOTIFY_CONTRACT, NOTIFY_DECLARATION } from "./contract.js";
import { readNotifyReceipt, type NotifyCard, type NotifyReceipt } from "./projection.js";
import type { NotifyPort, NotifyReply } from "./port.js";

/**
 * The sentences this port says when something goes wrong below its own
 * vocabulary. In the product's language, because a person reads them.
 */
const MESSAGES: RemoteMessages = {
  noAnswer: "通知通道没有作答。",
  malformedAnswer: "通知通道给出了无法识别的回复。",
  refusedWithoutReason: "这条通知没有发出去。",
  closed: "这个视图的会话已经结束，请重新打开。",
};

const MALFORMED_RECEIPT = "投递回执没有通过公开契约校验。";
const WRONG_RECIPIENT = "收到的回执不是发给所请求的那个收件人的。";

/**
 * A port and the handle that ends it.
 *
 * `destroy()` belongs to the App: it is composition, and a module that could end
 * its own transport would be a module that could end a sibling's.
 */
export interface RemoteNotify {
  readonly port: NotifyPort;
  /** Refuse everything afterwards. Idempotent. */
  destroy(): void;
}

/**
 * Present a proposal transport as `notify/v1`.
 *
 * `binding` is the App-local name from its `agent-resource-bindings/v1` plan. It
 * selects among what the plan already declared; it is not authority, and the
 * trusted dispatcher resolves it against its own copy of that document.
 */
export function createRemoteNotifyPort(transport: ProposalTransport, binding: string): RemoteNotify {
  const call = createRemoteCall({
    declaration: NOTIFY_DECLARATION,
    transport,
    binding,
    invalidRequest: "invalid_request",
    closed: "scope_closed",
    messages: MESSAGES,
  });

  const echo = [{ field: "recipient", param: "recipient", message: WRONG_RECIPIENT }] as const;

  const port: NotifyPort = {
    contract: NOTIFY_CONTRACT,

    async sendText(recipient: string, body: string): Promise<NotifyReply<NotifyReceipt>> {
      return call.call({
        action: "send_text",
        params: { recipient, body },
        read: readNotifyReceipt,
        malformed: MALFORMED_RECEIPT,
        echo,
      });
    },

    async sendCard(recipient: string, card: NotifyCard): Promise<NotifyReply<NotifyReceipt>> {
      // The card travels as the `json` field the declaration describes; the kit
      // encodes it, measures the ENCODED form against the wire's parameter, and
      // refuses locally rather than sending something the far side will reject.
      return call.call({
        action: "send_card",
        params: { recipient, card },
        read: readNotifyReceipt,
        malformed: MALFORMED_RECEIPT,
        echo,
      });
    },
  };

  return { port, destroy: () => call.destroy() };
}
