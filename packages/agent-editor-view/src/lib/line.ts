/**
 * Reading the one intent-context key this module understands.
 *
 * `open-resource/v1` carries `context` as an opaque, bounded string map: the
 * platform transports it and never interprets it, because its meaning belongs
 * to the resource kind rather than to the layout kernel (convergence-plan
 * decision 7). This file is `workspace-text`'s half of that agreement, and it is
 * two lines rather than a parser because a context entry is a HINT:
 *
 *  · a value that is not a positive integer is ignored, not refused. A panel
 *    that failed to open because a hint was malformed would be strictly worse
 *    than one that opens at the top of the file;
 *  · the line number is 1-based, like every editor's gutter and every compiler's
 *    error message, and is clamped to the document by the caller rather than
 *    here — this function does not know how long the file is.
 *
 * Bounded before parsing: the value arrives as a string of at most 512
 * characters, and `Number("9".repeat(400))` is a perfectly ordinary way to get
 * `Infinity` into an editor's scroll position.
 */

import type { IntentContext } from "@claude-bot/agent-module-contract";
import { EDITOR_CONTEXT_LINE } from "../manifests.js";

/** A representation bound on an untrusted intent field, not a file-size policy. */
const MAX_LINE = 1_000_000;

/**
 * The 1-based line an open intent asked for, or null.
 *
 * Null covers every uninteresting case at once: no context, no `line` key, a
 * value that is not a plain integer, zero, negative, or absurd.
 */
export function requestedLine(context: IntentContext | null | undefined): number | null {
  const raw = context?.[EDITOR_CONTEXT_LINE];
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 9) return null;
  if (!/^[0-9]+$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LINE) return null;
  return value;
}
