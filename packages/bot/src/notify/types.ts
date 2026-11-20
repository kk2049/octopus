/**
 * The trusted half of `notify/v1`.
 *
 * ── What the contract forces, and what this side therefore has to hold ──────
 *
 * `notify/v1` hands a consumer an OPAQUE recipient ref and nothing else: no
 * username, no open_id, no chat id, and no way to enumerate. That is not
 * decoration — it means the mapping from "a string an App may send" to "a human
 * being on a messaging platform" exists on THIS side only, is per scope, and
 * disappears when the scope does. An App that guesses a ref gets
 * `bad_recipient`; an App that keeps one after its instance ends gets the same.
 *
 * Two seams, and they are separate on purpose:
 *
 *  · `NotifyDelivery` is HOW a message physically leaves — the deployment's
 *    Feishu path, a test double, or nothing at all. It knows a resolved target
 *    and never a ref.
 *  · `openGrant` (in the provider) is WHETHER this scope may notify anyone and
 *    WHOM. That is an authorisation question, and a provider that answered it
 *    would be a second permission model out of the consent flow's reach — the
 *    same rule `workspace-files-provider.ts` follows.
 */

/**
 * One recipient, as the trusted side knows them.
 *
 * `id` is stable and internal (`user:<name>` today). It is never minted into a
 * ref, never logged next to one, and never crosses the port.
 */
export interface NotifyTarget {
  readonly id: string;
  /** Display only, for a trusted-side audit line. Never sent to a consumer. */
  readonly label: string;
}

export type NotifyDeliveryOutcome =
  | { ok: true }
  | { ok: false; code: "unavailable" | "refused" | "rate_limited"; message: string };

/**
 * How a notification physically leaves this process.
 *
 * Deliberately card-shaped rather than "a string": every existing outbound path
 * in this bot that can reach a person who has never messaged it is a card
 * (`Router.sendCardToUser` falls back to an open_id send, and that fallback is
 * interactive-only). Modelling text as a one-line card keeps one delivery path
 * instead of two, and keeps the contract's `send_text` honest about what the
 * recipient actually sees.
 */
export interface NotifyDelivery {
  deliver(input: {
    target: NotifyTarget;
    title: string;
    lines: readonly string[];
  }): Promise<NotifyDeliveryOutcome>;
}

/**
 * What one scope was granted: whom it may notify, and through what.
 *
 * `targets` is usually exactly one — the scope's own owner — because "an App may
 * ping the person using it" is a different and much smaller ask than "an App may
 * message people". Anything wider is a deployment decision expressed here, not
 * a capability the App can discover.
 */
export interface NotifyScopeGrant {
  readonly targets: readonly NotifyTarget[];
  readonly delivery: NotifyDelivery;
  close(): void;
}
