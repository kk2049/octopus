/**
 * The derived surface: a deck as Typst source.
 *
 * ── One direction, on purpose ───────────────────────────────────────────────
 *
 * §15.5 settles that the deck JSON is the editable truth and the `.typ` is
 * derived. This module is that arrow and there is no arrow back — no
 * `typstToDeck`, no round trip, no "reconcile the two". A parser here would be
 * the second editable source the design forbids, and the first person to fix a
 * spacing bug in the generated file would silently own a fork of their own deck.
 *
 * The function is pure and total: any deck the reader accepted produces a string.
 * Nothing is spawned, nothing is written, no binary is consulted. **Compiling is
 * somebody else's job**, and the worklog says whose.
 *
 * ── Why every piece of the author's text crosses as a string literal ────────
 *
 * Typst markup gives meaning to `#`, `[`, `]`, `*`, `_`, `` ` ``, `$`, `@`, `<`,
 * `>`, `~`, `\`, `-`, `+`, `=`, `/`, `.` and `"` — some of them only at the
 * start of a line, some only in pairs, some only next to a digit. An escape
 * table for markup mode is therefore a table whose correctness depends on
 * position, and the bug it produces is a slide that renders *almost* right.
 *
 * So the author's text never enters markup mode. It is emitted inside a Typst
 * STRING literal and handed to a function defined in the preamble. Inside a
 * string literal the grammar is tiny and positionless: a backslash, a quote, and
 * the control characters. That table is five rows long, it is written out below,
 * and `typst.test.ts` tokenises the generated document back to prove every
 * literal decodes to exactly the text that went in.
 *
 * The cost is stated rather than hidden: a string renders VERBATIM, so `*bold*`
 * in a bullet appears as `*bold*`. This version of the contract does not carry
 * inline formatting. Adding it later means adding a marked-up field TYPE to the
 * model — a decision at the schema, where a reader can refuse what it cannot
 * render — and not a looser escape table here.
 *
 * Per decision 12 this is not a containment claim about hostile App code; it is
 * the reason an author's slide about `#include` survives being a slide about
 * `#include`. The escaping happens to be total either way, because a string
 * literal is a closed context.
 */

import {
  DECK_LAYOUTS,
  type DeckDocument,
  type DeckSlide,
  type DeckTheme,
} from "./model.js";

/**
 * The whole escape table for a Typst string literal.
 *
 * Written as data so the test can assert it is exhaustive against what the
 * tokeniser understands, rather than the two drifting into agreement.
 */
export const TYPST_STRING_ESCAPES: Readonly<Record<string, string>> = Object.freeze({
  "\\": "\\\\",
  '"': '\\"',
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
});

/**
 * Escape text for the inside of a Typst string literal.
 *
 * Three cases beyond the table:
 *
 *  · **Other C0 controls and DEL** become `\u{..}`. They are legal in a JS
 *    string, meaningless in a slide, and a raw one in the output is a file some
 *    editor will normalise differently than the compiler reads it.
 *  · **Lone surrogates** become U+FFFD. A JS string may hold one; a Typst string
 *    may not, because it has no representation for a value that is not a
 *    scalar. Replacing is the only total answer — refusing here would mean a
 *    deck that reads fine cannot be exported, and emitting it raw would produce
 *    a file that is not valid UTF-8.
 *  · **Everything else, including astral characters, is emitted as itself.**
 *    Typst source is UTF-8 and an emoji in a title is an emoji in a title.
 */
export function escapeTypstString(text: string): string {
  let out = "";
  for (const ch of text) {
    const mapped = TYPST_STRING_ESCAPES[ch];
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) {
      out += `\\u{${code.toString(16)}}`;
      continue;
    }
    if (code >= 0xd800 && code <= 0xdfff) {
      // `for…of` yields an unpaired surrogate as a one-unit string; a paired
      // one has already been yielded as its combined code point.
      out += "�";
      continue;
    }
    out += ch;
  }
  return out;
}

/** A complete Typst string literal, quotes included. */
export function typstString(text: string): string {
  return `"${escapeTypstString(text)}"`;
}

/** A Typst array literal of strings. Empty is `()`; one item keeps its comma. */
function typstStringArray(items: readonly string[]): string {
  if (!items.length) return "()";
  return `(${items.map((item) => `${typstString(item)}, `).join("").trimEnd()})`;
}

export interface DeckTypstOptions {
  /**
   * Turn an opaque image ref into a Typst path, or answer `null`.
   *
   * **This is the image-resolution seam, and it is a parameter so that it has a
   * name.** This package cannot resolve a ref: it does not know whether one
   * points at a workspace file, an App-owned blob or something a deployment has
   * not built. A caller that CAN — a trusted-side render provider that has
   * already staged the files it is about to compile — supplies this and gets
   * real pictures. Everything else gets a placeholder frame that compiles with
   * no assets at all, which is the honest rendering of "there is an image here
   * and this document cannot see it".
   *
   * The returned path is escaped as a string literal like everything else, so a
   * resolver cannot inject Typst by returning one.
   */
  resolveImage?(ref: string): string | null;
}

/**
 * What each theme MEANS, as three colours: the page, the ink, and the faint
 * ink for placeholders.
 *
 * Exported because two renderers read it: this file's Typst preamble, and the
 * visual editor's slide surface. A second copy of these six values in a
 * stylesheet would be a second statement of what "dark" is, and the first time
 * they drifted the canvas would be a preview of a document that does not exist.
 */
export const DECK_THEME_COLOURS: Readonly<Record<DeckTheme, { page: string; ink: string; faint: string }>> =
  Object.freeze({
    light: Object.freeze({ page: "#ffffff", ink: "#161616", faint: "#8a8a8a" }),
    dark: Object.freeze({ page: "#14161a", ink: "#f2f4f8", faint: "#8f98a6" }),
  });

/**
 * The preamble.
 *
 * Every construct in it is long-stable Typst (`set page`, `set text`, `block`,
 * `text`, `list`, `grid`, `align`, `raw`, `linebreak`, `pagebreak`) and no font
 * is named — a font that is not installed is a compile the caller did not ask
 * for. The helpers exist so the per-slide output is a list of calls: that is
 * what keeps the generated file small enough for a person to read next to the
 * deck it came from.
 */
function preamble(theme: DeckTheme): string {
  const colour = DECK_THEME_COLOURS[theme];
  return [
    "// Generated from deck-model/v1 — do not edit.",
    "//",
    "// The deck JSON is the single editable source of truth; this file is a derived",
    "// surface and is replaced in full on every export. Changes made here are lost.",
    "",
    `#set page(paper: "presentation-16-9", margin: 3em, fill: rgb(${typstString(colour.page)}))`,
    `#set text(size: 24pt, fill: rgb(${typstString(colour.ink)}))`,
    "",
    "#let deck-heading(t) = block(below: 0.8em, text(size: 40pt, weight: \"bold\", t))",
    "#let deck-lead(t) = block(text(size: 28pt, style: \"italic\", t))",
    "#let deck-items(items) = if items.len() > 0 { list(..items) }",
    "#let deck-caption(t) = block(above: 0.8em, text(size: 18pt, style: \"italic\", t))",
    "#let deck-columns(a, b) = grid(",
    "  columns: (1fr, 1fr), column-gutter: 2em,",
    "  deck-items(a), deck-items(b),",
    ")",
    "#let deck-image-missing(ref, alt) = block(",
    "  width: 100%, inset: 1.5em, radius: 4pt,",
    `  stroke: 1pt + rgb(${typstString(colour.faint)}),`,
    ")[",
    "  #align(center)[",
    `    #text(size: 20pt, fill: rgb(${typstString(colour.faint)}), "图片占位")`,
    "    #linebreak()",
    "    #text(size: 18pt, alt)",
    "    #linebreak()",
    "    #raw(ref)",
    "  ]",
    "]",
    "#let deck-image-file(path) = block(width: 100%)[#image(path, width: 100%)]",
    "",
  ].join("\n");
}

function slideSource(slide: DeckSlide, options: DeckTypstOptions): string[] {
  const lines: string[] = [`// slide ${slide.id} · ${slide.layout}`];
  if (slide.title) lines.push(`#deck-heading(${typstString(slide.title)})`);
  switch (slide.layout) {
    case "title":
      if (slide.subtitle) lines.push(`#deck-lead(${typstString(slide.subtitle)})`);
      break;
    case "bullets":
      lines.push(`#deck-items(${typstStringArray(slide.bullets)})`);
      break;
    case "two-column":
      lines.push(`#deck-columns(${typstStringArray(slide.left)}, ${typstStringArray(slide.right)})`);
      break;
    case "image-ref": {
      const path = slide.image.ref ? (options.resolveImage?.(slide.image.ref) ?? null) : null;
      if (path !== null) lines.push(`#deck-image-file(${typstString(path)})`);
      else lines.push(`#deck-image-missing(${typstString(slide.image.ref)}, ${typstString(slide.image.alt)})`);
      if (slide.caption) lines.push(`#deck-caption(${typstString(slide.caption)})`);
      break;
    }
  }
  return lines;
}

/**
 * A deck as Typst source.
 *
 * Deterministic: the same deck (and the same resolver) produces the same bytes,
 * which is what lets a caller compare an export against a previous one instead
 * of diffing a rendering.
 */
export function deckToTypst(deck: DeckDocument, options: DeckTypstOptions = {}): string {
  const parts: string[] = [preamble(deck.theme)];
  if (deck.title) parts.push(`// deck: ${escapeTypstComment(deck.title)}`, "");
  if (!deck.slides.length) {
    parts.push("// This deck has no slides yet.", "");
    return parts.join("\n");
  }
  deck.slides.forEach((slide, index) => {
    if (index > 0) parts.push("#pagebreak(weak: true)", "");
    parts.push(slideSource(slide, options).join("\n"), "");
  });
  return parts.join("\n");
}

/**
 * The deck's own title appears once, as a comment, for a person reading the file.
 *
 * A comment is the one place text is NOT inside a string literal, so it gets the
 * one thing a comment can be broken by: a newline. Control characters go with
 * it, because a comment holding a carriage return is a comment whose second half
 * is source code.
 */
function escapeTypstComment(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]/g, " ");
}

/** Every layout this generator handles. Equal to the model's, by test. */
export const TYPST_SUPPORTED_LAYOUTS = DECK_LAYOUTS;
