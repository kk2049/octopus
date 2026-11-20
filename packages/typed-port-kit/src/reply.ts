/**
 * The one reply shape every typed port answers with.
 *
 * ── Why a shape and not a convention ────────────────────────────────────────
 *
 * Three ports exist today and all three independently arrived at "a discriminated
 * union with a bounded refusal", but they arrived at three *different* spellings
 * of it: `workspace-files/v1` has `WorkspaceFilesReply<T>` with a closed code
 * union, `agent-sessions/v1` has `SessionsReply` with `result: unknown` and no
 * closed set at all, and `resource-stream/v1` spells the same idea as a terminal
 * read. The middle one is the warning: without a shared shape, the property that
 * matters — *a consumer can enumerate every way this can say no* — is optional,
 * and the first port written in a hurry loses it.
 *
 * So the code is a type parameter rather than `string`. `PortReply<T, string>`
 * compiles, and that is the point: a port that has not declared its vocabulary
 * says so in its own type signature.
 *
 * ── Why every refusal resolves ─────────────────────────────────────────────
 *
 * "You do not have permission", "somebody has to approve that first" and "that
 * file is 40 MB" are answers a person should be shown, not exceptions a component
 * must catch. A thrown error is also the one thing on these paths that reliably
 * carries a canonical path across a trust boundary, because that is what a stack
 * trace is made of.
 *
 * ── Why the envelope is frozen and the message is scrubbed ─────────────────
 *
 * The message is written by somebody else — a Host, a provider, sometimes a
 * device — and it ends up in a log and eventually in front of a person. Bounding
 * it and replacing control characters is the same rule every reader in this
 * repository already applies to diagnostics; doing it in the constructor means no
 * call site has to remember. Freezing bounds the other direction: a consumer that
 * "fixed up" a refusal in place would be editing what it was told.
 *
 * The `ok: true` envelope is frozen too, but note what that does and does not
 * promise: the ENVELOPE cannot be reshaped, `value` is whatever the reader built.
 * Deep-freezing an arbitrary payload is not something this layer can do without
 * knowing what T is.
 */

/** Bounds shared by every port built on this kit. */
export const REPLY_LIMITS = Object.freeze({
  /** Refusal text: written for a person, and it ends up in a log. */
  maxMessageLength: 200,
});

export interface PortRefusal<C extends string> {
  readonly ok: false;
  readonly code: C;
  /** Bounded, control-character free text somebody wrote for a person to read. */
  readonly message: string;
}

export interface PortValue<T> {
  readonly ok: true;
  readonly value: T;
}

export type PortReply<T, C extends string> = PortValue<T> | PortRefusal<C>;

/**
 * Scrub and bound one piece of text that came from somewhere else.
 *
 * Exported because refusal text is not the only string on these paths that gets
 * logged — a conformance report and a diagnostic detail want the same treatment,
 * and a second implementation of "make this safe to log" is exactly the kind of
 * thing that disagrees about which characters count.
 */
export function boundedMessage(value: unknown, max: number = REPLY_LIMITS.maxMessageLength): string {
  const text = typeof value === "string" ? value : "";
  const safe = text.replace(/[\u0000-\u001f\u007f]/g, "\uFFFD");
  return safe.length <= max ? safe : `${safe.slice(0, Math.max(0, max - 1))}\u2026`;
}

/** Build a refusal with its text bounded the same way everywhere. */
export function portRefusal<C extends string>(
  code: C,
  message: string,
  max: number = REPLY_LIMITS.maxMessageLength,
): PortRefusal<C> {
  return Object.freeze({ ok: false as const, code, message: boundedMessage(message, max) });
}

/** Build an accepted reply. The envelope is frozen; `value` is the reader's. */
export function portValue<T>(value: T): PortValue<T> {
  return Object.freeze({ ok: true as const, value });
}

/** Narrow a reply without repeating the discriminant at every call site. */
export function isRefusal<T, C extends string>(reply: PortReply<T, C>): reply is PortRefusal<C> {
  return reply.ok === false;
}
