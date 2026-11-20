/**
 * `notify/v1` — deliver one bounded message to a recipient somebody else named.
 *
 * ── What this contract is, in one sentence ─────────────────────────────────
 *
 * An App can send a notification to a recipient it was GIVEN. It cannot find
 * out who that is, cannot enumerate recipients, cannot address anybody it was
 * not handed, and cannot see anything about delivery except that the trusted
 * side accepted it.
 *
 * ── Why a recipient is an opaque ref ───────────────────────────────────────
 *
 * The alternative is "the View submits a user id / a chat id / an email and the
 * server checks it", which makes every checker the security boundary and puts a
 * directory of colleagues inside an untrusted bundle. So a recipient is a ref
 * minted by the trusted side, meaningful only to it, and the only operation
 * this package performs on one is equality. This is the same design
 * `workspace-files/v1` uses for files, for the same reason.
 *
 * The consequence is deliberate and worth stating: **v1 has no enumeration.** A
 * consumer receives refs from an App projection or from an `open-resource/v1`
 * link; it cannot ask "who can I message?". Adding that verb is a permission
 * contract change (it would disclose a colleague list), not a refactor.
 *
 * ── Why exactly two actions ────────────────────────────────────────────────
 *
 * Because two is what it takes to demonstrate the two shapes a wire parameter
 * can have — a bounded string and a bounded structured value — and this
 * contract is `@claude-bot/typed-port-kit`'s first consumer. `send_text` and
 * `send_card` are real, but the reason there is not a third is that the kit
 * would learn nothing from it.
 *
 * ── One permission token, two action ids ───────────────────────────────────
 *
 * Both actions spend `send_notification`: sending a person a card and sending
 * them a paragraph is one authorisation ("this App may deliver notifications to
 * recipients you handed it"), and a v1 card is display text with no interactive
 * element. The action ids stay separate so an approval card and an audit record
 * say which one was actually asked for — exactly the split `append_session`
 * already makes between `append` and `resume`.
 *
 * ── What this package does NOT do ──────────────────────────────────────────
 *
 * No provider, no bot-side wiring, no Feishu. Nothing here knows what a chat is,
 * what a tenant is, or that Feishu exists; a provider that satisfies this
 * contract is trusted code that lives in `packages/bot`, is written by a
 * deployer, and is reviewed and deployed like every other platform capability
 * (convergence plan, decision 2).
 */

import { ID_PATTERNS, declareContract, refusalVocabulary } from "@claude-bot/typed-port-kit";

export const NOTIFY_CONTRACT = "notify/v1";

/**
 * The numbers both halves bound themselves by.
 *
 * `maxBodyLength` is 512 because that is EXACTLY what the View wire carries in
 * one parameter. It is a real limit rather than an arbitrary one, and stating it
 * here — rather than discovering it when `createRemoteCall` refuses — is what
 * makes "this contract is serviceable over the wire" a checked fact.
 *
 * The card's bounds are chosen so that a MAXIMAL card still encodes inside
 * `maxCardEncodedLength`; `contract.test.ts` builds one and measures it, because
 * a set of per-field bounds that add up to more than the encoding allows would
 * make the largest legal card unsendable.
 */
export const NOTIFY_LIMITS = Object.freeze({
  /** An opaque recipient ref. Bounded at what `ResourceLink.ref` allows. */
  maxRecipientLength: 200,
  /** Plain text body. Exactly one wire parameter's worth. */
  maxBodyLength: 512,
  /** The card's JSON encoding, which is what actually travels. */
  maxCardEncodedLength: 512,
  maxTitleLength: 60,
  maxLines: 3,
  maxLineLength: 100,
  /** An opaque delivery id the trusted side mints. Compared, never parsed. */
  maxDeliveryIdLength: 64,
  /** Refusal text: written for a person, and it ends up in a log. */
  maxMessageLength: 200,
});

/**
 * Every way this port can say no.
 *
 * All of them RESOLVE. "You are not allowed to message that person", "somebody
 * has to approve this first" and "that channel is throttling you" are answers a
 * person needs to read, not exceptions a component has to catch.
 *
 * `rate_limited` is here even though a first provider may never emit it, because
 * adding a code later is a contract change and every real delivery channel
 * throttles. It is distinct from `unavailable` for the only reason that matters:
 * one means "try again later" and the other means "something is broken".
 */
export const NOTIFY_REFUSALS = refusalVocabulary(
  [
    /** The delivery backend is unreachable, or it failed. The fallback. */
    "unavailable",
    /** The trusted side declined this send. Policy, not a fault. */
    "refused",
    /** The ref was never minted here, belongs to another scope, or has expired. */
    "bad_recipient",
    /** A body or card exceeded a declared bound. Never a silent truncation. */
    "too_large",
    /** A human has to approve this send first. */
    "approval_required",
    /** No authority is bound for this contract. */
    "no_authority",
    /** The instance this port belonged to has ended. */
    "scope_closed",
    /** The request itself was malformed. */
    "invalid_request",
    /** The delivery channel is throttling. Later, not never. */
    "rate_limited",
  ],
  { fallback: "unavailable", maxMessageLength: NOTIFY_LIMITS.maxMessageLength },
);

export type NotifyRefusalCode = (typeof NOTIFY_REFUSALS.codes)[number];

/**
 * The nested shape of a card, for the MCP face.
 *
 * Written out rather than derived from the reader, because the reader is
 * imperative and this is data. The two are kept in step by `contract.test.ts`,
 * which builds the maximal card this schema permits and puts it through the
 * reader — a divergence shows up as a value that one accepts and the other does
 * not, which is the only failure mode that matters here.
 */
const CARD_SCHEMA = Object.freeze({
  type: "object",
  properties: Object.freeze({
    title: Object.freeze({ type: "string", maxLength: NOTIFY_LIMITS.maxTitleLength, description: "卡片标题" }),
    lines: Object.freeze({
      type: "array",
      maxItems: NOTIFY_LIMITS.maxLines,
      items: Object.freeze({ type: "string", maxLength: NOTIFY_LIMITS.maxLineLength }),
      description: "正文行，按顺序展示",
    }),
  }),
  required: Object.freeze(["title", "lines"]),
  additionalProperties: false,
});

const RECIPIENT = Object.freeze({
  type: "string" as const,
  description: "收件人引用：由可信侧铸出、只对它有意义的不透明串。不是用户名、邮箱或群 id。",
  maxLength: NOTIFY_LIMITS.maxRecipientLength,
  pattern: ID_PATTERNS.resourceRef,
});

/**
 * The declaration. One source; the wire encoder, the MCP face and the
 * conformance harness are all derived from it.
 */
export const NOTIFY_DECLARATION = declareContract({
  contract: NOTIFY_CONTRACT,
  summary: "把一条有界通知投递给一个由可信侧铸出来的收件人引用。它说不出收件人是谁，也列不出有哪些收件人。",
  refusals: NOTIFY_REFUSALS,
  actions: {
    send_text: {
      summary: "给一个收件人发一段纯文本",
      operation: "send_notification",
      params: {
        recipient: RECIPIENT,
        body: {
          type: "string",
          description: `正文纯文本，最多 ${NOTIFY_LIMITS.maxBodyLength} 个字符。不是 Markdown，也不会被当作 HTML。`,
          maxLength: NOTIFY_LIMITS.maxBodyLength,
        },
      },
    },
    send_card: {
      summary: "给一个收件人发一张结构化卡片（标题 + 若干行）",
      operation: "send_notification",
      params: {
        recipient: RECIPIENT,
        card: {
          type: "json",
          description: `卡片内容：一个标题加最多 ${NOTIFY_LIMITS.maxLines} 行正文。纯展示，没有交互元素。`,
          // The bound is on the ENCODED form, because escaping is what makes a
          // card of individually legal strings exceed the wire's parameter.
          maxLength: NOTIFY_LIMITS.maxCardEncodedLength,
          schema: CARD_SCHEMA,
        },
      },
    },
  },
});

export type NotifyActionId = (typeof NOTIFY_DECLARATION.actionIds)[number];

/**
 * Which permission token each action spends.
 *
 * Derived rather than written a second time. It is here so a consumer can SAY
 * what a composition requests without being able to grant it; granting remains
 * the trusted Host's catalog's job, and nothing in this package can do it.
 */
export const NOTIFY_OPERATIONS: readonly string[] = NOTIFY_DECLARATION.operations;
