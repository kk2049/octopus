/**
 * Reading a deck, and writing the one canonical form of it.
 *
 * ── Where the refusal machinery comes from ──────────────────────────────────
 *
 * `@claude-bot/resource-stream-contract`'s `IssueBag` and friends, which is the
 * copy `workspace-files-contract` and `typed-port-kit` already share. Its own
 * header explains why it is not `agent-module-contract`'s: that package's public
 * surface is the module ABI and widening it is its decision, not a consumer's.
 * A THIRD implementation is what `dev-conventions.md` names as the thing this
 * repository has measured the cost of, so this file adds one small helper
 * (`arrayAt`) on the shared bag rather than a second bag.
 *
 * ── Two properties worth stating because they are choices ───────────────────
 *
 *  · **Unknown fields are a refusal.** A deck is a document an agent, a person
 *    or a future version of this package may have written. A key this build does
 *    not understand is either a newer schema or a typo that turned a slide into
 *    a different slide; guessing is worse than either.
 *  · **`encode(read(text)) === text` for canonical text.** Every normaliser
 *    below constructs its result in ONE fixed field order, so `JSON.stringify`
 *    reproduces the bytes. That is what lets a caller treat the encoded form as
 *    an identity — a digest, a diff, an equality — rather than as a rendering.
 *
 * ── What the reader deliberately does not do ────────────────────────────────
 *
 * It does not reject control characters in text. A title with a newline in it is
 * a person's text, and the place that has to survive it is the Typst generator,
 * which escapes rather than filters. Stripping here would silently edit someone's
 * deck; refusing here would make a deck unopenable because of a stray tab.
 */

import {
  IssueBag,
  boundedStringAt,
  objectAt,
  refuseUnknownFields,
  type ContractResult,
} from "@claude-bot/resource-stream-contract";
import {
  DECK_ID_PATTERN,
  DECK_LIMITS,
  DECK_MODEL_SCHEMA,
  DECK_REF_PATTERN,
  isDeckLayout,
  isDeckTheme,
  type DeckDocument,
  type DeckImageRef,
  type DeckSlide,
  type DeckTheme,
} from "./model.js";

const DOCUMENT_FIELDS = Object.freeze(["schema", "title", "theme", "slides"]);

const SLIDE_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  title: Object.freeze(["id", "layout", "title", "subtitle"]),
  bullets: Object.freeze(["id", "layout", "title", "bullets"]),
  "two-column": Object.freeze(["id", "layout", "title", "left", "right"]),
  "image-ref": Object.freeze(["id", "layout", "title", "image", "caption"]),
});

const IMAGE_FIELDS = Object.freeze(["ref", "alt"]);

/**
 * An array field with its own bound.
 *
 * Not in the shared helper set because the two contracts that share it never
 * needed one. Added here on the same bag rather than beside it: the point of the
 * shared machinery is one vocabulary of issue codes and one clipping rule, and
 * both hold.
 */
function arrayAt(
  bag: IssueBag,
  row: Record<string, unknown>,
  key: string,
  at: string,
  max: number,
  options: { optional?: boolean } = {},
): unknown[] | null {
  const value = row[key];
  if (value === undefined) {
    if (!options.optional) bag.add("missing_field", `missing ${key}`, at);
    return null;
  }
  if (!Array.isArray(value)) {
    bag.add("field_type", `${key} must be an array`, at);
    return null;
  }
  if (value.length > max) {
    bag.add("limit", `${key} has more than ${max} entries`, at);
    return null;
  }
  return value;
}

/** An optional text field: absent reads as the empty string, never as a refusal. */
function textAt(bag: IssueBag, row: Record<string, unknown>, key: string, at: string): string {
  if (row[key] === undefined) return "";
  return boundedStringAt(bag, row, key, at, DECK_LIMITS.maxTextLength) ?? "";
}

function listAt(bag: IssueBag, row: Record<string, unknown>, key: string, at: string): string[] {
  const raw = arrayAt(bag, row, key, at, DECK_LIMITS.maxListItems, { optional: true });
  if (raw === null) return [];
  const out: string[] = [];
  raw.forEach((item, index) => {
    if (typeof item !== "string") {
      bag.add("field_type", `${key}[${index}] must be a string`, at);
      return;
    }
    if (item.length > DECK_LIMITS.maxTextLength) {
      bag.add("limit", `${key}[${index}] is longer than ${DECK_LIMITS.maxTextLength} characters`, at);
      return;
    }
    out.push(item);
  });
  return out;
}

function idAt(bag: IssueBag, row: Record<string, unknown>, at: string): string {
  const value = boundedStringAt(bag, row, "id", at, DECK_LIMITS.maxIdLength);
  if (value === null) return "";
  if (!DECK_ID_PATTERN.test(value)) {
    bag.add("identifier", "id must be alphanumeric with . _ or -", at);
    return "";
  }
  return value;
}

function imageAt(bag: IssueBag, row: Record<string, unknown>, at: string): DeckImageRef {
  const blank: DeckImageRef = { ref: "", alt: "" };
  if (row.image === undefined) return blank;
  const nested = objectAt(bag, row.image, `${at}.image`);
  if (!nested) return blank;
  refuseUnknownFields(bag, nested, IMAGE_FIELDS, `${at}.image`);
  const alt = textAt(bag, nested, "alt", `${at}.image`);
  const rawRef = nested.ref;
  if (rawRef === undefined) return { ref: "", alt };
  if (typeof rawRef !== "string") {
    bag.add("field_type", "ref must be a string", `${at}.image`);
    return { ref: "", alt };
  }
  // "" is absence — no image chosen yet — and is the only string that is not
  // required to look like a ref. Anything else is carried verbatim or refused;
  // it is never inspected for what it might name.
  if (rawRef === "") return { ref: "", alt };
  if (rawRef.length > DECK_LIMITS.maxRefLength) {
    bag.add("limit", `ref is longer than ${DECK_LIMITS.maxRefLength} characters`, `${at}.image`);
    return { ref: "", alt };
  }
  if (!DECK_REF_PATTERN.test(rawRef)) {
    bag.add("identifier", "ref must be printable ASCII with no spaces", `${at}.image`);
    return { ref: "", alt };
  }
  return { ref: rawRef, alt };
}

/**
 * One slide.
 *
 * The layout is read FIRST and everything else is read through it, so a document
 * cannot carry `bullets` on a `title` slide and have it quietly ignored — the
 * unknown-field check is per layout, which is the whole reason the field sets
 * are a table rather than a union of every key any layout uses.
 */
export function readDeckSlide(value: unknown, at = "slide"): ContractResult<DeckSlide> {
  const bag = new IssueBag();
  const row = objectAt(bag, value, at);
  if (!row) return bag.fail();
  const layout = row.layout;
  if (!isDeckLayout(layout)) {
    bag.add("schema", "layout must be title, bullets, two-column or image-ref", at);
    return bag.fail();
  }
  refuseUnknownFields(bag, row, SLIDE_FIELDS[layout]!, at);
  const id = idAt(bag, row, at);
  const title = textAt(bag, row, "title", at);
  let slide: DeckSlide;
  switch (layout) {
    case "title":
      slide = { id, layout, title, subtitle: textAt(bag, row, "subtitle", at) };
      break;
    case "bullets":
      slide = { id, layout, title, bullets: listAt(bag, row, "bullets", at) };
      break;
    case "two-column":
      slide = { id, layout, title, left: listAt(bag, row, "left", at), right: listAt(bag, row, "right", at) };
      break;
    case "image-ref":
      slide = { id, layout, title, image: imageAt(bag, row, at), caption: textAt(bag, row, "caption", at) };
      break;
  }
  if (!bag.empty) return bag.fail();
  return { ok: true, value: slide };
}

/** A whole deck. Slide ids must be unique — an edit addresses by id. */
export function readDeck(value: unknown): ContractResult<DeckDocument> {
  const bag = new IssueBag();
  const row = objectAt(bag, value, "deck");
  if (!row) return bag.fail();
  refuseUnknownFields(bag, row, DOCUMENT_FIELDS, "deck");
  if (row.schema !== DECK_MODEL_SCHEMA) {
    bag.add("schema", `schema must be ${DECK_MODEL_SCHEMA}`, "deck");
  }
  const title = textAt(bag, row, "title", "deck");
  let theme: DeckTheme = "light";
  if (row.theme !== undefined) {
    if (isDeckTheme(row.theme)) theme = row.theme;
    else bag.add("schema", "theme must be light or dark", "deck");
  }
  const rawSlides = arrayAt(bag, row, "slides", "deck", DECK_LIMITS.maxSlides, { optional: true }) ?? [];
  const slides: DeckSlide[] = [];
  const seen = new Set<string>();
  rawSlides.forEach((entry, index) => {
    const read = readDeckSlide(entry, `deck.slides[${index}]`);
    if (!read.ok) {
      for (const issue of read.issues) bag.add(issue.code, issue.message, issue.at);
      return;
    }
    if (seen.has(read.value.id)) {
      bag.add("identifier", `duplicate slide id ${read.value.id}`, `deck.slides[${index}]`);
      return;
    }
    seen.add(read.value.id);
    slides.push(read.value);
  });
  if (!bag.empty) return bag.fail();
  return { ok: true, value: { schema: DECK_MODEL_SCHEMA, title, theme, slides } };
}

/** Bytes that arrived from somewhere, without throwing at the caller. */
export function parseDeck(text: string): ContractResult<DeckDocument> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    const bag = new IssueBag();
    bag.add("schema", "not parseable as JSON", "deck");
    return bag.fail();
  }
  return readDeck(parsed);
}

/**
 * The canonical bytes of a deck: two-space indented, newline-terminated.
 *
 * Same convention as `agent-module-contract`'s `encodeCanonical`, which that
 * package does not export. One line is not worth widening a release-asset
 * package's surface for, and the property that matters is stated where it can be
 * tested: the readers above build every object in one fixed field order, so
 * `JSON.stringify` reproduces those bytes.
 */
export function encodeDeck(deck: DeckDocument): string {
  return `${JSON.stringify(deck, null, 2)}\n`;
}
