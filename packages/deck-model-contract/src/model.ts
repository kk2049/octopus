/**
 * `deck-model/v1` — the shape of a deck, as pure data.
 *
 * ── The one decision this file exists to enforce ────────────────────────────
 *
 * §15.5 of the module-system design settles which of two documents is the
 * editable truth: **the deck JSON is, and the generated `.typ` is a derived
 * surface.** Declaring both editable is named there as a forbidden shape,
 * because a round trip through Typst cannot preserve a structure Typst does not
 * have, and the first person to edit the `.typ` silently owns a fork.
 *
 * So this file describes the deck and nothing else. There is no `typ` field, no
 * "last rendered" text, no PDF handle, no compiler diagnostic, no cursor and no
 * revision of a second representation. `typst.ts` is a one-way function out of
 * here, and the only thing it is allowed to return is a string somebody may
 * throw away.
 *
 * ── Why the layout vocabulary is closed ─────────────────────────────────────
 *
 * Four layouts, named in a frozen tuple, each with its own fixed field set. A
 * deck with a fifth layout is refused rather than rendered as a blank page,
 * for exactly the reason every other document in this repository refuses an
 * unknown field: the alternative interpretations are "a newer schema this build
 * must not guess at" and "a typo that quietly turned a slide into nothing", and
 * both deserve the same loud answer.
 *
 * A closed vocabulary is also what makes an editor possible without a schema
 * language: `agent-deck-view` derives its input controls from the layout, so
 * adding a layout here is what adds an editor there — one statement, not two.
 *
 * ── Why an image is a ref and never bytes ───────────────────────────────────
 *
 * `DeckImageRef.ref` is opaque: carried, compared, never parsed. This package
 * does not know whether it names a workspace file, an App-owned blob or
 * something a deployment has not built yet, and it must not learn — a contract
 * that could resolve a ref is a contract that has decided where images live.
 * Resolution is a deployment seam, and `deckToTypst` takes it as a parameter so
 * the seam has a name instead of a paragraph.
 *
 * ── Why every text bound is 512 ─────────────────────────────────────────────
 *
 * Not aesthetics. An edit to a deck crosses an App's proposal channel, whose
 * values are bounded. The model keeps each editable field at a stable limit of
 * 512 characters within that transport ceiling so a deck can never be READ and
 * then not be EDITABLE — the reader cannot accept a field that `set_text` cannot
 * replace.
 * `agent-deck-view` asserts this bound against the actual transport limit so a
 * future change on either side cannot make the editor fail silently.
 */

/** The schema tag every deck document carries. */
export const DECK_MODEL_SCHEMA = "deck-model/v1";

/** The whole layout vocabulary. A fifth value is a refusal, not a fallback. */
export const DECK_LAYOUTS = Object.freeze(["title", "bullets", "two-column", "image-ref"] as const);
export type DeckLayout = (typeof DECK_LAYOUTS)[number];

/** The whole theme vocabulary — §15.5's `apply_theme`, kept to a closed set. */
export const DECK_THEMES = Object.freeze(["light", "dark"] as const);
export type DeckTheme = (typeof DECK_THEMES)[number];

/**
 * Every bound a hostile or merely careless document could otherwise choose.
 *
 * `maxTextLength` is the one with a second reader: see the header. The rest are
 * sized so a whole deck stays something a browser renders in one frame and a
 * projection carries without a second channel.
 */
export const DECK_LIMITS = Object.freeze({
  maxSlides: 200,
  /** Any single editable text field. Must stay ≤ the proposal channel's value bound. */
  maxTextLength: 512,
  /** Items in one `bullets`, `left` or `right` list. */
  maxListItems: 16,
  maxIdLength: 64,
  /** An opaque image ref. Bounded printable ASCII, like every other ref here. */
  maxRefLength: 200,
});

/**
 * A slide id.
 *
 * Ids exist so an edit can address a slide WITHOUT an index. That is not a
 * convenience: an agent and a person editing the same deck produce interleaved
 * commands, and an index-addressed `set_text` that arrives after an
 * `insert_slide` writes into a different slide than the one the author was
 * looking at. An id-addressed one refuses.
 */
export const DECK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Printable ASCII with no whitespace — the same promise every ref here makes.
 *
 * Length is NOT in the pattern: it is `DECK_LIMITS.maxRefLength`, checked by the
 * reader. A second copy of the number inside a regular expression is a second
 * copy that drifts, and the failure it produces ("this ref is fine but that one
 * is not, and both are 200 characters") is the kind nobody reproduces.
 *
 * The empty string is deliberately NOT a ref. It is what an `image-ref` slide
 * carries before anyone has chosen an image, and the reader admits it as that —
 * absence — rather than as a ref that happens to name nothing.
 */
export const DECK_REF_PATTERN = /^[\x21-\x7e]+$/;

export function isDeckId(value: unknown): value is string {
  return typeof value === "string" && DECK_ID_PATTERN.test(value);
}

export function isDeckRef(value: unknown): value is string {
  return typeof value === "string" && value.length <= DECK_LIMITS.maxRefLength && DECK_REF_PATTERN.test(value);
}

export function isDeckLayout(value: unknown): value is DeckLayout {
  return typeof value === "string" && (DECK_LAYOUTS as readonly string[]).includes(value);
}

export function isDeckTheme(value: unknown): value is DeckTheme {
  return typeof value === "string" && (DECK_THEMES as readonly string[]).includes(value);
}

/** An image this deck points at. What the ref names is the deployment's business. */
export interface DeckImageRef {
  /** Opaque. Carried and compared, never parsed or joined onto a path. */
  ref: string;
  /** What a reader who cannot see the image should be told. */
  alt: string;
}

export interface DeckTitleSlide {
  id: string;
  layout: "title";
  title: string;
  subtitle: string;
}

export interface DeckBulletsSlide {
  id: string;
  layout: "bullets";
  title: string;
  bullets: string[];
}

export interface DeckTwoColumnSlide {
  id: string;
  layout: "two-column";
  title: string;
  left: string[];
  right: string[];
}

export interface DeckImageSlide {
  id: string;
  layout: "image-ref";
  title: string;
  image: DeckImageRef;
  caption: string;
}

export type DeckSlide = DeckTitleSlide | DeckBulletsSlide | DeckTwoColumnSlide | DeckImageSlide;

export interface DeckDocument {
  schema: typeof DECK_MODEL_SCHEMA;
  title: string;
  theme: DeckTheme;
  slides: DeckSlide[];
}

/**
 * Which fields of a layout hold editable text, and which of those are lists.
 *
 * One table, three consumers: the reader validates against it, `set_text`
 * addresses through it, and the editor draws inputs from it. A layout whose
 * fields were written out separately in three places is a layout that will grow
 * a field in two of them.
 *
 * `image.ref` and `image.alt` are addressed with a dot because the document
 * nests them; the dot is part of the field NAME in this vocabulary and is never
 * a path expression to evaluate.
 */
export const DECK_TEXT_FIELDS: Readonly<Record<DeckLayout, readonly string[]>> = Object.freeze({
  title: Object.freeze(["title", "subtitle"]),
  bullets: Object.freeze(["title", "bullets"]),
  "two-column": Object.freeze(["title", "left", "right"]),
  "image-ref": Object.freeze(["title", "caption", "image.ref", "image.alt"]),
});

/** The subset of the above whose values are lists addressed by index. */
export const DECK_LIST_FIELDS: Readonly<Record<DeckLayout, readonly string[]>> = Object.freeze({
  title: Object.freeze([]),
  bullets: Object.freeze(["bullets"]),
  "two-column": Object.freeze(["left", "right"]),
  "image-ref": Object.freeze([]),
});

export function isDeckTextField(layout: DeckLayout, field: string): boolean {
  return DECK_TEXT_FIELDS[layout].includes(field);
}

export function isDeckListField(layout: DeckLayout, field: string): boolean {
  return DECK_LIST_FIELDS[layout].includes(field);
}

/** The index of a slide, or -1. Callers that need a refusal check the -1. */
export function slideIndexOf(deck: DeckDocument, slideId: string): number {
  return deck.slides.findIndex((slide) => slide.id === slideId);
}

export function findSlide(deck: DeckDocument, slideId: string): DeckSlide | null {
  return deck.slides.find((slide) => slide.id === slideId) ?? null;
}

/**
 * A slide of the given layout with every field empty.
 *
 * Empty rather than sample text: a new slide that arrives with words in it is a
 * new slide somebody has to delete words out of, and "the deck now contains a
 * sentence I did not write" is the sort of thing that reaches a projector.
 */
export function emptySlide(id: string, layout: DeckLayout): DeckSlide {
  switch (layout) {
    case "title":
      return { id, layout, title: "", subtitle: "" };
    case "bullets":
      return { id, layout, title: "", bullets: [] };
    case "two-column":
      return { id, layout, title: "", left: [], right: [] };
    case "image-ref":
      return { id, layout, title: "", image: { ref: "", alt: "" }, caption: "" };
  }
}

/** A deck with no slides. The starting point an App projects before a first edit. */
export function emptyDeck(title = ""): DeckDocument {
  return { schema: DECK_MODEL_SCHEMA, title, theme: "light", slides: [] };
}
