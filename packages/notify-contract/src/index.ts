/**
 * `@claude-bot/notify-contract` — the `notify/v1` ABI.
 *
 * Deliver one bounded message to a recipient somebody else named. The consumer
 * cannot find out who that is, cannot enumerate recipients, cannot address
 * anybody it was not handed, and cannot see anything about delivery except that
 * the trusted side accepted it.
 *
 * It is written entirely with `@claude-bot/typed-port-kit` and is that kit's
 * first consumer — which is the only honest way to check a claim about how much
 * a kit saves: the declaration, the readers and the port are what a contract
 * actually has to decide, and everything else came from the kit.
 *
 * ── What is NOT here ───────────────────────────────────────────────────────
 *
 * No provider, no bot-side wiring, no Feishu, no permission plumbing. Nothing in
 * this package knows what a chat is, what a tenant is, or that Feishu exists.
 * A provider satisfying this contract is trusted code in `packages/bot`, written
 * by a deployer and reviewed and deployed like every other platform capability
 * (convergence plan, decision 2). That work is deliberately out of scope; the
 * worklog lists it.
 *
 * Its one dependency is the kit, which itself depends only on two other
 * dependency-free contract packages. There is no React, no DOM, no Node, no
 * transport implementation, and nothing that knows what a capability or an owner
 * is.
 */

export {
  NOTIFY_CONTRACT,
  NOTIFY_DECLARATION,
  NOTIFY_LIMITS,
  NOTIFY_OPERATIONS,
  NOTIFY_REFUSALS,
  type NotifyActionId,
  type NotifyRefusalCode,
} from "./contract.js";

export {
  encodeNotifyCard,
  readNotifyCard,
  readNotifyReceipt,
  type NotifyCard,
  type NotifyReceipt,
} from "./projection.js";

export {
  NOT_AUTHORISED_REFUSAL,
  notifyRefusal,
  type NotifyPort,
  type NotifyRefusal,
  type NotifyReply,
} from "./port.js";

export { createRemoteNotifyPort, type RemoteNotify } from "./remote.js";
