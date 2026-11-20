/**
 * The `notify/v1` provider, as the catalog installs it.
 *
 * A composition, like `workspace-files-provider.ts`: an authority the
 * DEPLOYMENT opened (`openGrant`), a delivery path the deployment already had,
 * and the contract package's own declaration for everything about the wire.
 * Nothing about permissions, recipients or message formatting is decided here.
 *
 * ── Three properties this file is responsible for ──────────────────────────
 *
 *  1. **A ref is kept, not encoded.** The map from ref to person lives in this
 *     scope's state and dies with it. Encoding `user:alice` into the ref would
 *     make the ref a CLAIM, and every layer downstream would become a checker
 *     of it. A forged ref, another scope's ref and a ref from a closed scope are
 *     therefore the same thing — a lookup miss — rather than three checks.
 *  2. **The wire is decoded by the contract, not re-parsed here.**
 *     `decodeWireParams` applies the declared types, lengths, patterns and the
 *     card's JSON schema. A second parser here would be a second opinion about
 *     what `notify/v1` accepts.
 *  3. **Sending is rate-limited per scope, and says so.** `rate_limited` means
 *     "later", not "never"; it is a bounded refusal rather than a silent drop,
 *     because a consumer that cannot tell the difference will retry for ever.
 */

import { randomBytes } from "node:crypto";
import {
  NOTIFY_CONTRACT,
  NOTIFY_DECLARATION,
  NOTIFY_LIMITS,
  readNotifyCard,
  type NotifyCard,
} from "@claude-bot/notify-contract";
import { decodeWireParams, wireActionOf } from "@claude-bot/typed-port-kit";
import { createLogger } from "../logger.js";
import type { NotifyScopeGrant, NotifyTarget } from "../notify/types.js";
import {
  resourceRefusal,
  type ResourceAnswer,
  type ResourceProviderContext,
  type ResourceProviderDefinition,
} from "./types.js";

const log = createLogger("notify-provider");

/** `resource.send_text` / `resource.send_card`, derived so it cannot drift. */
export const NOTIFY_PROPOSAL_ACTIONS: readonly string[] = Object.freeze(
  NOTIFY_DECLARATION.actionIds.map((action) => wireActionOf(action)),
);

/** Plain text arrives as a card, so give it one honest title. */
export const NOTIFY_TEXT_TITLE = "通知";

export interface NotifyProviderOptions {
  /**
   * Open this scope's authority, or return null when it holds none.
   *
   * Supplied by the composition root, and the only place "may this instance
   * notify anyone, and whom" is answered. Null also covers "this deployment has
   * no outbound channel at all" — a host with no Feishu still installs a
   * provider that satisfies the contract exactly and refuses every scope, so
   * the App's other surfaces keep working and this one says what it holds.
   */
  openGrant: (context: ResourceProviderContext) => NotifyScopeGrant | null;
  /** Messages one scope may send per window. Default 20 per 10 minutes. */
  limit?: { messages: number; windowMs: number };
  now?: () => number;
}

interface NotifyScopeState {
  grant: NotifyScopeGrant;
  /** ref → target. Minted at open; never derived from anything a caller said. */
  refs: Map<string, NotifyTarget>;
  sent: number[];
  serial: number;
  closed: boolean;
}

export function notifyProvider(options: NotifyProviderOptions): ResourceProviderDefinition<NotifyScopeState> {
  const now = options.now ?? Date.now;
  const limit = options.limit ?? { messages: 20, windowMs: 10 * 60_000 };

  return {
    contract: NOTIFY_CONTRACT,
    actions: NOTIFY_PROPOSAL_ACTIONS,

    open(context: ResourceProviderContext): NotifyScopeState | null {
      const grant = options.openGrant(context);
      if (!grant) return null;
      const refs = new Map<string, NotifyTarget>();
      for (const target of grant.targets) refs.set(`nr_${randomBytes(12).toString("hex")}`, target);
      if (!refs.size) {
        // A scope that may notify nobody holds nothing. Closing the grant here
        // rather than keeping an empty scope open keeps "no authority" and "no
        // recipients" the same observable state.
        grant.close();
        return null;
      }
      return { grant, refs, sent: [], serial: 0, closed: false };
    },

    async dispatch(
      state: NotifyScopeState,
      action: string,
      params: Readonly<Record<string, string>>,
      context: ResourceProviderContext,
    ): Promise<ResourceAnswer> {
      if (state.closed) return resourceRefusal("scope_closed", "这个视图的会话已经结束，请重新打开。");
      const id = NOTIFY_DECLARATION.actionIds.find((candidate) => wireActionOf(candidate) === action);
      if (!id) return resourceRefusal("invalid_request", "这个资源不支持被请求的动作。");
      // The contract's own decoder: declared types, lengths, patterns and — for
      // `card` — the JSON schema. `binding` is the catalog's routing parameter
      // and is not part of any action's declaration.
      const decoded = decodeWireParams(NOTIFY_DECLARATION.byAction[id], withoutBinding(params));
      if (!decoded.ok) {
        const first = decoded.issues[0];
        return resourceRefusal("invalid_request", `这次通知的参数不被接受：${first?.message ?? "校验失败"}`);
      }
      const recipient = String(decoded.value.recipient ?? "");
      const target = state.refs.get(recipient);
      if (!target) return resourceRefusal("bad_recipient", "这个收件人引用不属于当前视图。");

      let card: NotifyCard;
      if (id === "send_text") {
        const body = String(decoded.value.body ?? "");
        if (!body.trim()) return resourceRefusal("invalid_request", "通知正文不能为空。");
        card = { title: NOTIFY_TEXT_TITLE, lines: splitBody(body) };
      } else {
        const read = readNotifyCard(decoded.value.card);
        if (!read.ok) {
          const first = read.issues[0];
          return resourceRefusal("invalid_request", `卡片内容不被接受：${first?.message ?? "校验失败"}`);
        }
        card = read.value;
      }

      const at = now();
      state.sent = state.sent.filter((stamp) => at - stamp < limit.windowMs);
      if (state.sent.length >= limit.messages) {
        return resourceRefusal("rate_limited", "这个视图短时间内发送得太多了，请稍后再试。");
      }
      state.sent.push(at);

      let outcome;
      try {
        outcome = await state.grant.delivery.deliver({ target, title: card.title, lines: card.lines });
      } catch (err) {
        // A throwing channel is a bug on the trusted side, and its message is
        // exactly the field that reliably carries an internal identifier out.
        log.error({ err, app: context.app, owner: context.owner }, "notify delivery threw");
        return resourceRefusal("unavailable", "通知通道暂时不可用。");
      }
      if (!outcome.ok) return resourceRefusal(outcome.code, outcome.message);

      state.serial += 1;
      return {
        ok: true,
        result: {
          recipient,
          // Bounded, opaque, and shaped for the contract's own reader
          // (`^[A-Za-z0-9_-]{8,64}$`). It identifies this acceptance, not a
          // message on any platform — echoing a platform message id back would
          // hand a consumer a handle into somebody's chat.
          deliveryId: `nd-${randomBytes(8).toString("hex")}-${state.serial}`,
          // Accepted-at, not seen-at. Nothing here knows whether it was read.
          acceptedAt: new Date(at).toISOString().replace(/\.\d+Z$/, "Z"),
        },
      };
    },

    close(state: NotifyScopeState): void {
      // Synchronous, and before anything else: on return the refs no longer
      // resolve, so a late proposal on this scope is `bad_recipient` rather
      // than a send made under an authority that has been given up.
      state.closed = true;
      state.refs.clear();
      state.grant.close();
    },
  };
}

/** The catalog's routing parameter is not part of any action's declaration. */
function withoutBinding(params: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (key === "binding") continue;
    out[key] = value;
  }
  return out;
}

/**
 * A text body as card lines.
 *
 * The contract caps a card at 3 lines of 100 characters while a text body may
 * be 512, so a long body is folded rather than refused: `send_text` promised to
 * take 512 characters, and refusing them because the transport happens to be a
 * card would be this layer's shape leaking into the contract's.
 */
export function splitBody(body: string): string[] {
  const paragraphs = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const source = paragraphs.length ? paragraphs : [body.trim()];
  const lines: string[] = [];
  for (const paragraph of source) {
    for (let at = 0; at < paragraph.length && lines.length < NOTIFY_LIMITS.maxLines; at += NOTIFY_LIMITS.maxLineLength) {
      lines.push(paragraph.slice(at, at + NOTIFY_LIMITS.maxLineLength));
    }
    if (lines.length >= NOTIFY_LIMITS.maxLines) break;
  }
  return lines.length ? lines : [""];
}
