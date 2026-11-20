/**
 * What a consumer of `notify/v1` may construct and may see.
 *
 * ── The field list IS the boundary ─────────────────────────────────────────
 *
 * A receipt may carry the echoed recipient ref, an opaque delivery id and the
 * instant the trusted side accepted it. It may NOT carry:
 *
 *   the recipient's name, username, email, phone, avatar or presence
 *   a chat id, an open_id, a union_id, a tenant id
 *   the platform's own message id
 *   owner · credential · app · scope · instance handle
 *   grant · capability · context id · pending-call id
 *
 * Not filtered — absent. The delivery id is OURS: it names a row the trusted
 * side is holding, so a later "did that arrive?" is a question this contract
 * could answer without ever naming a platform object. Handing back the
 * platform's message id would leak a routing handle into a bundle whose whole
 * premise is that it cannot address anything directly.
 *
 * ── Why readers exist for shapes we also construct ─────────────────────────
 *
 * Because the constructing side and the reading side are different processes,
 * usually different origins, and eventually different release versions. Unknown
 * fields are refused rather than ignored, for the reason every reader in this
 * repository gives: a field this build does not understand is either a newer
 * schema or a typo that quietly turned something off.
 *
 * ── Why control characters are a refusal and not a scrub ───────────────────
 *
 * A card is text an App CONSTRUCTED, not text that arrived. Scrubbing it would
 * silently send something other than what the author wrote; refusing tells them.
 * (Refusal *messages* are the opposite case — those arrive from somebody else,
 * so `portRefusal` scrubs them.)
 */

import {
  IssueBag,
  boundedStringAt,
  canonicalJson,
  isResourceRef,
  objectAt,
  refuseUnknownFields,
  type ContractResult,
} from "@claude-bot/typed-port-kit";

import { NOTIFY_LIMITS } from "./contract.js";

/** `2026-08-07T12:34:56.000Z`. An instant, never a locale-formatted string. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** An opaque delivery id. Bounded, compared, never parsed. */
const DELIVERY_ID = /^[A-Za-z0-9_-]{8,64}$/;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** A card: a title and up to three lines. Display only; no interactive element. */
export interface NotifyCard {
  readonly title: string;
  readonly lines: readonly string[];
}

/** What the trusted side answers when it has accepted a send. */
export interface NotifyReceipt {
  /** The recipient this was for, echoed back so a caller can check it. */
  readonly recipient: string;
  /** Opaque, minted by the trusted side, meaningful only to it. */
  readonly deliveryId: string;
  /** When the trusted side accepted it. NOT when the person saw it. */
  readonly acceptedAt: string;
}

const CARD_FIELDS = ["title", "lines"] as const;
const RECEIPT_FIELDS = ["recipient", "deliveryId", "acceptedAt"] as const;

export function readNotifyCard(value: unknown, at = "card"): ContractResult<NotifyCard> {
  const bag = new IssueBag();
  const row = objectAt(bag, value, at);
  if (!row) return bag.fail();
  refuseUnknownFields(bag, row, CARD_FIELDS, at);

  const title = boundedStringAt(bag, row, "title", at, NOTIFY_LIMITS.maxTitleLength);
  if (title !== null) {
    if (title.length === 0) bag.add("schema", "title must not be empty", `${at}.title`);
    if (CONTROL_CHARACTERS.test(title)) {
      bag.add("schema", "title must not contain control characters", `${at}.title`);
    }
  }

  const list = row.lines;
  const lines: string[] = [];
  if (!Array.isArray(list)) {
    bag.add("field_type", "lines must be an array", `${at}.lines`);
  } else if (list.length > NOTIFY_LIMITS.maxLines) {
    bag.add("limit", `lines has more than ${NOTIFY_LIMITS.maxLines} entries`, `${at}.lines`);
  } else {
    for (let index = 0; index < list.length; index += 1) {
      const line = list[index];
      const where = `${at}.lines[${index}]`;
      if (typeof line !== "string") {
        bag.add("field_type", "a line must be a string", where);
      } else if (line.length > NOTIFY_LIMITS.maxLineLength) {
        bag.add("limit", `a line is longer than ${NOTIFY_LIMITS.maxLineLength} characters`, where);
      } else if (CONTROL_CHARACTERS.test(line)) {
        bag.add("schema", "a line must not contain control characters", where);
      } else {
        lines.push(line);
      }
    }
  }

  if (!bag.empty) return bag.fail();
  // Constructed in ONE fixed field order, which is what makes
  // `encode(read(x)) === x` an equality a test can assert rather than a claim
  // about a sorting function.
  return { ok: true, value: { title: title!, lines } };
}

export function readNotifyReceipt(value: unknown, at = "receipt"): ContractResult<NotifyReceipt> {
  const bag = new IssueBag();
  const row = objectAt(bag, value, at);
  if (!row) return bag.fail();
  refuseUnknownFields(bag, row, RECEIPT_FIELDS, at);

  const recipient = boundedStringAt(bag, row, "recipient", at, NOTIFY_LIMITS.maxRecipientLength);
  if (recipient !== null && !isResourceRef(recipient)) {
    bag.add("identifier", "recipient must be a bounded printable reference", `${at}.recipient`);
  }
  const deliveryId = boundedStringAt(bag, row, "deliveryId", at, NOTIFY_LIMITS.maxDeliveryIdLength);
  if (deliveryId !== null && !DELIVERY_ID.test(deliveryId)) {
    bag.add("identifier", "deliveryId must be a bounded opaque token", `${at}.deliveryId`);
  }
  if (typeof row.acceptedAt !== "string" || !ISO_INSTANT.test(row.acceptedAt)) {
    bag.add("field_type", "acceptedAt must be an ISO-8601 instant in UTC", `${at}.acceptedAt`);
  }

  if (!bag.empty) return bag.fail();
  return { ok: true, value: { recipient: recipient!, deliveryId: deliveryId!, acceptedAt: row.acceptedAt as string } };
}

/**
 * The canonical bytes of a card, as they travel in one wire parameter.
 *
 * Compact rather than indented: this is a parameter value, not a release asset
 * on disk (document-form canonical encoding stays in
 * `@claude-bot/agent-module-contract`, whose consumers write files).
 *
 * Returns null only for a card JSON cannot represent, which a card read through
 * `readNotifyCard` never is — the null branch exists because this is also
 * callable on a hand-built value.
 */
export function encodeNotifyCard(card: NotifyCard): string | null {
  return canonicalJson({ title: card.title, lines: [...card.lines] });
}
