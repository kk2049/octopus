/**
 * A second real implementation of `notify/v1`, backed by a fixture.
 *
 * It exists for the reason the workspace-files and sessions harnesses do: a
 * claim that a consumer depends on a PORT and not on a transport is only
 * checkable if there is a second thing that satisfies the port. This one has no
 * network, no message channel and no trusted side at all — it answers out of an
 * object graph, and it records what it was asked to send so a test can assert on
 * that instead of on a mock's call log.
 *
 * ── Why it is a harness entry rather than a test helper ────────────────────
 *
 * Because tests are not the only consumer that needs it: a storybook, a demo App
 * or a preview of a draft composition (`app:preview`, convergence plan decision
 * 9) would all wire it the same way. It is exported from `./harness` rather than
 * from the package root so a production bundle cannot pick it up by reaching for
 * the obvious import.
 *
 * ── The fixture speaks the CONTRACT's shapes ───────────────────────────────
 *
 * Every answer this port returns is one a consumer would get from the real one,
 * including the refusals — because `bad_recipient`, `approval_required` and
 * `too_large` are exactly the branches a component is most likely to get wrong,
 * and a harness that only ever succeeds tests the one path that was never in
 * doubt.
 *
 * ── What it deliberately does not do ───────────────────────────────────────
 *
 * It does not validate against the declaration. That is the REMOTE port's job
 * (`createRemoteCall` encodes and refuses locally), and a memory port that
 * duplicated it would be a second implementation of the bound — so a fixture can
 * be asked to send an over-long body and will answer `too_large` from its own
 * check, which is what a provider on the far side would also do.
 */

import type { ContractResult } from "@claude-bot/typed-port-kit";

import { NOTIFY_CONTRACT, NOTIFY_LIMITS, type NotifyRefusalCode } from "../contract.js";
import { encodeNotifyCard, readNotifyCard, type NotifyCard, type NotifyReceipt } from "../projection.js";
import { notifyRefusal, type NotifyPort, type NotifyReply } from "../port.js";

export interface MemoryNotifyFixture {
  /** Recipient refs this port will accept. Anything else is `bad_recipient`. */
  readonly recipients: readonly string[];
  /** Refs whose send is refused, and how. Checked before `recipients`. */
  readonly refusals?: Readonly<Record<string, { code: NotifyRefusalCode; message: string }>>;
  /** Refuse every send, whatever the recipient. For a look-but-not-send consumer. */
  readonly refuseAll?: { code: NotifyRefusalCode; message: string };
  /** Deterministic clock, so a receipt is assertable. */
  readonly now?: () => Date;
}

/** One thing this port was asked to send. */
export type MemoryNotifySend =
  | { readonly kind: "text"; readonly recipient: string; readonly body: string }
  | { readonly kind: "card"; readonly recipient: string; readonly card: NotifyCard };

export interface MemoryNotifyPort {
  readonly port: NotifyPort;
  /** Everything this port accepted, in order. Refused sends are not here. */
  readonly sent: readonly MemoryNotifySend[];
  /** Every call, accepted or not, for asserting that a refusal was even reached. */
  readonly calls: readonly { readonly method: string; readonly recipient: string }[];
}

export function createMemoryNotifyPort(fixture: MemoryNotifyFixture): MemoryNotifyPort {
  const sent: MemoryNotifySend[] = [];
  const calls: { method: string; recipient: string }[] = [];
  const known = new Set(fixture.recipients);
  const now = fixture.now ?? (() => new Date(0));
  let deliveries = 0;

  const admit = (method: string, recipient: string): NotifyReply<NotifyReceipt> | null => {
    calls.push({ method, recipient });
    if (fixture.refuseAll) return notifyRefusal(fixture.refuseAll.code, fixture.refuseAll.message);
    const scripted = ownValue(fixture.refusals, recipient);
    if (scripted) return notifyRefusal(scripted.code, scripted.message);
    if (!known.has(recipient)) return notifyRefusal("bad_recipient", "这个收件人引用不属于当前视图。");
    return null;
  };

  const receipt = (recipient: string): NotifyReply<NotifyReceipt> => {
    deliveries += 1;
    return {
      ok: true,
      value: {
        recipient,
        // Shaped like the real thing (`^[A-Za-z0-9_-]{8,64}$`) so a consumer that
        // validates a receipt is exercised rather than accidentally skipped.
        deliveryId: `memory-${String(deliveries).padStart(4, "0")}`,
        acceptedAt: now().toISOString(),
      },
    };
  };

  const port: NotifyPort = {
    contract: NOTIFY_CONTRACT,

    async sendText(recipient: string, body: string): Promise<NotifyReply<NotifyReceipt>> {
      const refusal = admit("sendText", recipient);
      if (refusal) return refusal;
      if (typeof body !== "string" || body.length === 0) {
        return notifyRefusal("invalid_request", "正文不能为空。");
      }
      if (body.length > NOTIFY_LIMITS.maxBodyLength) {
        return notifyRefusal("too_large", `正文超过了 ${NOTIFY_LIMITS.maxBodyLength} 个字符。`);
      }
      sent.push({ kind: "text", recipient, body });
      return receipt(recipient);
    },

    async sendCard(recipient: string, card: NotifyCard): Promise<NotifyReply<NotifyReceipt>> {
      const refusal = admit("sendCard", recipient);
      if (refusal) return refusal;
      // Through the contract's own reader, so a fixture cannot accept a card the
      // real provider would refuse — which is the whole value of a second
      // implementation.
      const read: ContractResult<NotifyCard> = readNotifyCard(card);
      if (!read.ok) return notifyRefusal("invalid_request", "卡片没有通过公开契约校验。");
      const encoded = encodeNotifyCard(read.value);
      if (encoded === null || encoded.length > NOTIFY_LIMITS.maxCardEncodedLength) {
        return notifyRefusal("too_large", `卡片编码后超过了 ${NOTIFY_LIMITS.maxCardEncodedLength} 个字符。`);
      }
      sent.push({ kind: "card", recipient, card: read.value });
      return receipt(recipient);
    },
  };

  return { port, sent, calls };
}

function ownValue<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return record && Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}
