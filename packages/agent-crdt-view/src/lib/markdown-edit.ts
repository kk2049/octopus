/**
 * Toolbar commands over a Markdown source, as pure functions.
 *
 * ── Why plain functions over (text, selection) ─────────────────────────────
 *
 * The editor surface is a textarea holding Markdown SOURCE — the platform's
 * constraints (one MessagePort, no heavy editor dependency, a CRDT that holds
 * one `Y.Text`) make that the honest storage model — and a toolbar is then a
 * set of TEXT TRANSFORMS: take the value and the selection, give back the next
 * value and the next selection. Everything interesting is testable without a
 * DOM, and the component's whole job is to read the textarea's selection,
 * call one of these, and write both halves back.
 *
 * Every command is a TOGGLE where a toggle is well-defined: pressing 加粗 on
 * text that is already bold removes the markers rather than nesting them,
 * because that is what every editor a person has used does, and "**`**text`"
 * soup is the observable failure of not doing it.
 */

export interface MarkdownEditState {
  readonly text: string;
  /** Selection start, in code units — a textarea's own coordinate system. */
  readonly start: number;
  /** Selection end. Equal to `start` when the caret is a point. */
  readonly end: number;
}

export type MarkdownCommand =
  | "bold"
  | "italic"
  | "strike"
  | "code"
  | "h1"
  | "h2"
  | "h3"
  | "ul"
  | "ol"
  | "quote"
  | "codeblock"
  | "hr";

const INLINE: Readonly<Partial<Record<MarkdownCommand, string>>> = Object.freeze({
  bold: "**",
  italic: "*",
  strike: "~~",
  code: "`",
});

const LINE_PREFIX: Readonly<Partial<Record<MarkdownCommand, string>>> = Object.freeze({
  h1: "# ",
  h2: "## ",
  h3: "### ",
  quote: "> ",
});

/** Any heading/quote/list marker one of the block commands may need to strip. */
const BLOCK_MARKER = /^(#{1,6} |> |[-*] |\d+\. )/;

export function applyMarkdownCommand(state: MarkdownEditState, command: MarkdownCommand): MarkdownEditState {
  const inline = INLINE[command];
  if (inline !== undefined) return toggleInline(state, inline);
  const prefix = LINE_PREFIX[command];
  if (prefix !== undefined) return toggleLinePrefix(state, prefix);
  if (command === "ul") return toggleList(state, /^[-*] /, () => "- ");
  if (command === "ol") return toggleList(state, /^\d+\. /, (index) => `${index + 1}. `);
  if (command === "codeblock") return toggleCodeBlock(state);
  return insertRule(state);
}

/** Clamp an arbitrary selection into the text and put it the right way round. */
function bounds(state: MarkdownEditState): { start: number; end: number } {
  const max = state.text.length;
  const a = Math.max(0, Math.min(state.start, max));
  const b = Math.max(0, Math.min(state.end, max));
  return a <= b ? { start: a, end: b } : { start: b, end: a };
}

function toggleInline(state: MarkdownEditState, marker: string): MarkdownEditState {
  const { start, end } = bounds(state);
  const text = state.text;
  const selected = text.slice(start, end);

  // Unwrap when the selection sits exactly inside a pair of markers, or
  // itself begins and ends with them. Both spellings occur in practice —
  // double-click selects the word, drag selects markers and all.
  const before = text.slice(start - marker.length, start);
  const after = text.slice(end, end + marker.length);
  if (before === marker && after === marker) {
    return {
      text: text.slice(0, start - marker.length) + selected + text.slice(end + marker.length),
      start: start - marker.length,
      end: end - marker.length,
    };
  }
  if (
    selected.length >= marker.length * 2
    && selected.startsWith(marker)
    && selected.endsWith(marker)
  ) {
    const inner = selected.slice(marker.length, selected.length - marker.length);
    return { text: text.slice(0, start) + inner + text.slice(end), start, end: start + inner.length };
  }

  const next = text.slice(0, start) + marker + selected + marker + text.slice(end);
  // A point caret lands BETWEEN the markers, ready to type; a selection stays
  // selected so a second press can toggle back.
  return { text: next, start: start + marker.length, end: end + marker.length };
}

/** The [start, end) code-unit range of every full line the selection touches. */
function lineRange(text: string, start: number, end: number): { from: number; to: number } {
  const from = text.lastIndexOf("\n", start - 1) + 1;
  const stop = text.indexOf("\n", Math.max(end, start));
  return { from, to: stop === -1 ? text.length : stop };
}

function replaceLines(
  state: MarkdownEditState,
  transform: (lines: string[]) => string[],
): MarkdownEditState {
  const { start, end } = bounds(state);
  const { from, to } = lineRange(state.text, start, end);
  const nextLines = transform(state.text.slice(from, to).split("\n")).join("\n");
  const text = state.text.slice(0, from) + nextLines + state.text.slice(to);
  // Selecting the whole transformed block is the predictable answer: the
  // alternative — arithmetic per line to preserve a mid-word caret — buys
  // little and lands the caret inside a marker often enough to feel broken.
  return { text, start: from, end: from + nextLines.length };
}

function toggleLinePrefix(state: MarkdownEditState, prefix: string): MarkdownEditState {
  return replaceLines(state, (lines) => {
    const visible = lines.filter((line) => line.trim() !== "");
    if (visible.length === 0) {
      // Pressing a block command on an empty line BEGINS one, ready to type.
      return lines.map((line, index) => (index === lines.length - 1 ? prefix + line : line));
    }
    const allSet = visible.every((line) => line.startsWith(prefix));
    return lines.map((line) => {
      if (line.trim() === "") return line;
      if (allSet) return line.slice(prefix.length);
      return prefix + line.replace(BLOCK_MARKER, "");
    });
  });
}

const LIST_MARKER = /^([-*] |\d+\. )/;

function toggleList(
  state: MarkdownEditState,
  flavour: RegExp,
  markerFor: (index: number) => string,
): MarkdownEditState {
  return replaceLines(state, (lines) => {
    // Already a list of THIS flavour → strip; the other flavour → convert.
    const visible = lines.filter((line) => line.trim() !== "");
    const allSet = visible.length > 0 && visible.every((line) => flavour.test(line));
    let seen = -1;
    return lines.map((line) => {
      if (line.trim() === "") return line;
      if (allSet) return line.replace(LIST_MARKER, "");
      seen += 1;
      return markerFor(seen) + line.replace(BLOCK_MARKER, "");
    });
  });
}

function toggleCodeBlock(state: MarkdownEditState): MarkdownEditState {
  const { start, end } = bounds(state);
  const { from, to } = lineRange(state.text, start, end);
  const block = state.text.slice(from, to);
  const lines = block.split("\n");
  if (lines.length >= 2 && lines[0]!.startsWith("```") && lines[lines.length - 1]!.startsWith("```")) {
    const inner = lines.slice(1, -1).join("\n");
    const text = state.text.slice(0, from) + inner + state.text.slice(to);
    return { text, start: from, end: from + inner.length };
  }
  const fenced = "```\n" + block + "\n```";
  const text = state.text.slice(0, from) + fenced + state.text.slice(to);
  return { text, start: from, end: from + fenced.length };
}

function insertRule(state: MarkdownEditState): MarkdownEditState {
  const { end } = bounds(state);
  const text = state.text;
  // On its own paragraph: a rule glued to text is not a rule in Markdown.
  const needsLeadingBreak = end > 0 && text[end - 1] !== "\n";
  const insertion = `${needsLeadingBreak ? "\n" : ""}\n---\n\n`;
  const next = text.slice(0, end) + insertion + text.slice(end);
  const caret = end + insertion.length;
  return { text: next, start: caret, end: caret };
}
