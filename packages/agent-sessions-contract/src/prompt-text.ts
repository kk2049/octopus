/**
 * What a person's prompt looks like after a provider round trip.
 *
 * A prompt pasted into a terminal TUI comes back from the provider's own
 * transcript changed in ways that carry no meaning. Claude Code wraps a
 * multi-line paste in `<pasted_content id="…">…</pasted_content id="…">`,
 * turns tabs into spaces and adds blank lines around the paste.
 *
 * Two kinds of reader need this:
 * - a reader that SHOWS the prompt unwraps the paste (`unwrapPastedContent`);
 * - a reader that asks "is this the prompt that was sent?" compares
 *   `promptMatchKey` values.
 *
 * The Runner's input receipt, the transcript parser and the View's local echo
 * all use these two functions, so they cannot disagree about whether two texts
 * are the same prompt.
 */

/** One complete paste wrapper, with the line breaks Claude adds just inside it. */
const PASTED_CONTENT = /<pasted_content\b[^>]*>\r?\n?([\s\S]*?)\r?\n?<\/pasted_content\b[^>]*>/g;
/** Any wrapper tag, paired or not; only for matching, never for display. */
const PASTED_CONTENT_TAG = /<\/?pasted_content\b[^>]*>/g;

/** The text as the person pasted it: wrapper tags removed, their contents kept. */
export function unwrapPastedContent(text: string): string {
  return text.includes("<pasted_content") ? text.replace(PASTED_CONTENT, "$1") : text;
}

/**
 * Whitespace-insensitive identity of a prompt, ignoring paste wrappers.
 * Two prompts that differ only in whitespace count as the same prompt.
 */
export function promptMatchKey(text: string): string {
  return text.replace(PASTED_CONTENT_TAG, " ").replace(/\s+/g, " ").trim();
}
