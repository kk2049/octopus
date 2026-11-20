/**
 * A `<textarea>`'s new value, as one CRDT edit.
 *
 * ── Why a diff at all ──────────────────────────────────────────────────────
 *
 * A textarea reports its whole value; a CRDT wants an operation. Replacing the
 * whole `Y.Text` on every keystroke would produce a document in which every
 * character was deleted and reinserted by whoever typed last — which converges,
 * and loses every concurrent edit while doing so. So the value has to be turned
 * back into the operation that produced it.
 *
 * ── What this heuristic gets right, and what it cannot ─────────────────────
 *
 * Common prefix and common suffix give the single contiguous range that changed.
 * That is EXACT for everything a plain textarea can do in one event: typing,
 * backspace, delete, paste, select-and-replace, cut. It is approximate only for
 * edits at two separate places in one event, which a textarea does not produce
 * (a code editor with multiple cursors does — and that is one of the reasons a
 * real editor binds to the CRDT model rather than to a value string).
 *
 * It is also biased in a way worth naming: with `aXa → aa` it reports deleting
 * the middle, and with `ab → aab` it reports inserting after the first `a`
 * rather than before the second. Both are correct edits producing the correct
 * string; when two people do this concurrently the CRDT decides the order. No
 * heuristic can recover the user's intent from a value string, which is why this
 * one is small and documented rather than clever.
 *
 * ── Surrogate pairs ────────────────────────────────────────────────────────
 *
 * JavaScript strings and `Y.Text` are both indexed in UTF-16 code units, so a
 * prefix that ends between the halves of an emoji is a legal index that splits a
 * character. Both boundaries are therefore pulled back off a lone surrogate.
 * Without that, typing next to an emoji can produce two half-characters that
 * merge into a replacement glyph on every other replica.
 */

export interface TextEdit {
  /** UTF-16 code-unit index into the current text. */
  readonly index: number;
  /** How many code units to remove. */
  readonly remove: number;
  /** What to insert at `index`, after removing. */
  readonly insert: string;
}

/** The one edit that turns `before` into `after`, or null when they are equal. */
export function diffText(before: string, after: string): TextEdit | null {
  if (before === after) return null;

  const max = Math.min(before.length, after.length);
  let head = 0;
  while (head < max && before.charCodeAt(head) === after.charCodeAt(head)) head += 1;
  // Do not end the common prefix between the halves of a surrogate pair.
  if (head > 0 && isHighSurrogate(before.charCodeAt(head - 1))) head -= 1;

  let tail = 0;
  while (
    tail < max - head
    && before.charCodeAt(before.length - 1 - tail) === after.charCodeAt(after.length - 1 - tail)
  ) {
    tail += 1;
  }
  // …nor the common suffix.
  if (tail > 0 && isLowSurrogate(before.charCodeAt(before.length - tail))) tail -= 1;

  return {
    index: head,
    remove: before.length - head - tail,
    insert: after.slice(head, after.length - tail),
  };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
