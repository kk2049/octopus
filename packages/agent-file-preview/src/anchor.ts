/**
 * Pure anchor arithmetic for file annotations.
 *
 * An annotation records what the reader saw — `quote` plus short `prefix`
 * and `suffix` — not a position. Rebinding it to a new snapshot is a search
 * against the current text and, on ambiguity, the surrounding context. When
 * the text has drifted enough that no unique window survives, the annotation
 * is marked adrift so the reader can see it, edit it, or delete it — never
 * silently reattached to a different sentence.
 *
 * These functions do not read the DOM, do not depend on React, and do not
 * import PDF.js. They belong to the file-preview package because they are
 * consumed only by the two view-side rebinders (Markdown text, PDF text),
 * but they are file-format agnostic: `resolveAnchor` runs against any string.
 */

export interface AnchorHint {
  quote: string;
  prefix: string;
  suffix: string;
}

export type AnchorStatus = "matched" | "adrift" | "empty";

export interface AnchorResolution {
  status: AnchorStatus;
  start: number;
  end: number;
}

export const CONTEXT_CHARS = 40;

const EMPTY: AnchorResolution = Object.freeze({ status: "empty", start: 0, end: 0 });
const ADRIFT: AnchorResolution = Object.freeze({ status: "adrift", start: -1, end: -1 });

/**
 * Best-effort rebind of an anchor into `haystack`.
 *
 * Three passes, most specific first: exact `prefix + quote + suffix`, then a
 * quote uniquely surrounded on either side, then a uniquely occurring quote.
 * Any other outcome is `adrift`: multiple ambiguous matches or none at all.
 * Empty quotes are `empty` — they were never real anchors.
 */
export function resolveAnchor(haystack: string, hint: AnchorHint): AnchorResolution {
  const quote = hint.quote;
  if (!quote) return EMPTY;

  const prefixed = hint.prefix + quote + hint.suffix;
  if (prefixed !== quote) {
    const window = haystack.indexOf(prefixed);
    if (window >= 0) {
      const start = window + hint.prefix.length;
      return { status: "matched", start, end: start + quote.length };
    }
  }

  const first = haystack.indexOf(quote);
  if (first < 0) return ADRIFT;
  const second = haystack.indexOf(quote, first + 1);

  if (second < 0) {
    // The quote appears exactly once — that is enough to be sure.
    return { status: "matched", start: first, end: first + quote.length };
  }

  // Quote is ambiguous by itself; use prefix/suffix to disambiguate.
  if (hint.prefix) {
    const anchored = hint.prefix + quote;
    const via = haystack.indexOf(anchored);
    if (via >= 0 && haystack.indexOf(anchored, via + 1) < 0) {
      const start = via + hint.prefix.length;
      return { status: "matched", start, end: start + quote.length };
    }
  }
  if (hint.suffix) {
    const anchored = quote + hint.suffix;
    const via = haystack.indexOf(anchored);
    if (via >= 0 && haystack.indexOf(anchored, via + 1) < 0) {
      return { status: "matched", start: via, end: via + quote.length };
    }
  }
  return ADRIFT;
}

/**
 * Build an anchor hint from a snapshot of the text plus a selected range.
 *
 * The prefix and suffix are trimmed to `CONTEXT_CHARS` so the annotation payload
 * stays bounded no matter how large the source is.
 */
export function buildAnchorHint(text: string, start: number, end: number): AnchorHint {
  const safeStart = Math.max(0, Math.min(text.length, start));
  const safeEnd = Math.max(safeStart, Math.min(text.length, end));
  return {
    quote: text.slice(safeStart, safeEnd),
    prefix: text.slice(Math.max(0, safeStart - CONTEXT_CHARS), safeStart),
    suffix: text.slice(safeEnd, Math.min(text.length, safeEnd + CONTEXT_CHARS)),
  };
}

/**
 * Trim and cap free-form reader notes so oversized text cannot slip through
 * the App action's advertised parameter budget.
 */
export function normalizeNote(input: string, maxCodePoints = 1000): string {
  const trimmed = input.replace(/[\s]+/gu, " ").trim();
  if (!trimmed) return "";
  const codepoints = Array.from(trimmed);
  return codepoints.length <= maxCodePoints ? trimmed : codepoints.slice(0, maxCodePoints).join("");
}

const HEX = "0123456789abcdef";

/**
 * Short non-cryptographic hex fingerprint. Only used to detect that a PDF
 * has changed since an annotation was recorded; not a security primitive.
 */
export function shortHash(bytes: Uint8Array): string {
  let h1 = 0x811c9dc5 >>> 0;
  let h2 = 0x1b873593 >>> 0;
  for (let i = 0; i < bytes.length; i += 1) {
    h1 = Math.imul(h1 ^ bytes[i]!, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + bytes[i]!, 0x85ebca6b) >>> 0;
  }
  let out = "";
  for (let value of [h1, h2]) {
    for (let i = 7; i >= 0; i -= 1) out += HEX[(value >>> (i * 4)) & 0xf];
  }
  return out.slice(0, 12);
}

/**
 * A stable 128-bit-ish random id, wide enough to key annotations without a
 * server-issued sequence. Uses `crypto.randomUUID` when the sandbox provides it
 * and falls back to `crypto.getRandomValues`; both are permitted in an
 * opaque-origin frame.
 */
export function mintAnnotationId(): string {
  const g = globalThis as { crypto?: Crypto };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  g.crypto?.getRandomValues?.(bytes);
  let out = "";
  for (const byte of bytes) out += (byte + 0x100).toString(16).slice(1);
  return `${out.slice(0, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}-${out.slice(16, 20)}-${out.slice(20)}`;
}
