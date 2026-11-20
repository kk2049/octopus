/**
 * The edit vocabulary: semantic commands, their inverses, and what fits on a wire.
 *
 * ── Why commands and not whole-deck snapshots ───────────────────────────────
 *
 * An App's durable state is an event log with a projection on top. A deck could
 * be stored either way, and the choice is not stylistic:
 *
 *  1. **A snapshot does not fit.** An edit reaches the trusted side as one
 *     proposal on the App's channel, and a proposal carries a handful of short
 *     string values. A 40-slide deck is tens of kilobytes; a snapshot design
 *     needs chunking or a second channel on day one, which is a transport
 *     invented for a first version.
 *  2. **A snapshot loses the same amount either way.** Under a snapshot log, one
 *     bad write replaces the whole document; under a command log it replaces one
 *     field. Decision 12 upgraded exactly one requirement — "App code written
 *     wrong must not cause large-scale data loss" — and the blast radius of a
 *     command is the property that answers it.
 *  3. **§15.5 asks for inverses.** An inverse of "the deck is now this" is "the
 *     deck was that", which is another snapshot; an inverse of `set_text` is one
 *     string. Undo becomes affordable only in the second design.
 *  4. **Two writers.** A person and an agent editing one deck produce
 *     interleaved writes. Two snapshots interleave as a silent clobber. Two
 *     commands interleave as two edits, and the ones that genuinely conflict
 *     (the same field) are visible as such.
 *
 * The projection is still a snapshot — the App's State process materialises the
 * deck and projects it whole — so a reader never replays anything. Writes are
 * commands; reads are a document. That asymmetry is the standard event-sourcing
 * answer and it is why "where does the deck live" has a boring answer here.
 *
 * ── The one command that does not fit on the wire ───────────────────────────
 *
 * `remove_slide`'s inverse has to carry the slide back, and a slide is a
 * structure with lists in it. It cannot be encoded into the flat bounded command
 * grammar without inventing chunking, and it must not be: an undo that had to
 * re-send the content it is restoring would be an undo the client could get wrong.
 *
 * So the union below is deliberately WIDER than the wire. `restore_slide` exists
 * for `applyDeckCommand` and for a trusted-side undo log; `encodeDeckCommand`
 * answers `null` for it, `readDeckCommand` refuses it, and `WireDeckCommand`
 * excludes it at the type level so a View cannot build one. The finding that
 * produced this shape is written down rather than designed around: **undo is a
 * server-side operation, not a client-replayed command.**
 */

import {
  IssueBag,
  objectAt,
  type ContractResult,
} from "@claude-bot/resource-stream-contract";
import {
  DECK_ID_PATTERN,
  DECK_LIMITS,
  DECK_REF_PATTERN,
  emptySlide,
  isDeckLayout,
  isDeckListField,
  isDeckTextField,
  isDeckTheme,
  slideIndexOf,
  type DeckDocument,
  type DeckLayout,
  type DeckSlide,
  type DeckTheme,
} from "./model.js";
import { readDeckSlide } from "./read.js";

/** Every op, in one frozen tuple. The last one is not carried on the wire. */
export const DECK_COMMAND_OPS = Object.freeze([
  "set_deck_title",
  "set_theme",
  "set_text",
  "insert_item",
  "remove_item",
  "insert_slide",
  "move_slide",
  "remove_slide",
  "restore_slide",
] as const);

export type DeckCommandOp = (typeof DECK_COMMAND_OPS)[number];

export interface SetDeckTitleCommand {
  op: "set_deck_title";
  value: string;
}

export interface SetThemeCommand {
  op: "set_theme";
  value: DeckTheme;
}

export interface SetTextCommand {
  op: "set_text";
  slide: string;
  /** A name from `DECK_TEXT_FIELDS` for this slide's layout. */
  field: string;
  /** Required for a list field, forbidden for a scalar one. */
  index?: number;
  value: string;
}

export interface InsertItemCommand {
  op: "insert_item";
  slide: string;
  field: string;
  /** Where it lands; `0..length` inclusive. */
  index: number;
  value: string;
}

export interface RemoveItemCommand {
  op: "remove_item";
  slide: string;
  field: string;
  index: number;
}

export interface InsertSlideCommand {
  op: "insert_slide";
  /** The new slide's id, chosen by the caller so a retry is not a second slide. */
  slide: string;
  layout: DeckLayout;
  index: number;
}

export interface MoveSlideCommand {
  op: "move_slide";
  slide: string;
  index: number;
}

export interface RemoveSlideCommand {
  op: "remove_slide";
  slide: string;
}

/** The inverse of a removal. Carries a whole slide, so it is not wire-encodable. */
export interface RestoreSlideCommand {
  op: "restore_slide";
  value: DeckSlide;
  index: number;
}

export type DeckCommand =
  | SetDeckTitleCommand
  | SetThemeCommand
  | SetTextCommand
  | InsertItemCommand
  | RemoveItemCommand
  | InsertSlideCommand
  | MoveSlideCommand
  | RemoveSlideCommand
  | RestoreSlideCommand;

/** Everything a View may build: the union minus the one that cannot cross. */
export type WireDeckCommand = Exclude<DeckCommand, RestoreSlideCommand>;

/**
 * The flat keys a command becomes on an App's proposal channel.
 *
 * Six, because that is how many distinct roles the vocabulary has — not because
 * six is a limit anybody chose. `agent-deck-view` asserts this list is within
 * what the transport carries; stating the number here and checking it there is
 * what keeps "the model fits the wire" a test rather than a memory.
 */
export const DECK_WIRE_KEYS = Object.freeze(["op", "slide", "field", "index", "value", "layout"] as const);

export interface DeckEdit {
  deck: DeckDocument;
  /**
   * The command that undoes this one, against the deck this one produced.
   *
   * May be a `restore_slide`, which is why an undo log belongs on the side that
   * holds the deck rather than in the client that asked for the edit.
   */
  inverse: DeckCommand;
}

function fail<T>(code: "schema" | "identifier" | "limit" | "field_type" | "missing_field", message: string): ContractResult<T> {
  const bag = new IssueBag();
  bag.add(code, message, "command");
  return bag.fail();
}

/** The list a field names on a slide, or null when the field is not a list. */
function listOf(slide: DeckSlide, field: string): string[] | null {
  if (slide.layout === "bullets" && field === "bullets") return slide.bullets;
  if (slide.layout === "two-column" && field === "left") return slide.left;
  if (slide.layout === "two-column" && field === "right") return slide.right;
  return null;
}

function scalarOf(slide: DeckSlide, field: string): string | null {
  if (field === "title") return slide.title;
  if (slide.layout === "title" && field === "subtitle") return slide.subtitle;
  if (slide.layout === "image-ref" && field === "caption") return slide.caption;
  if (slide.layout === "image-ref" && field === "image.ref") return slide.image.ref;
  if (slide.layout === "image-ref" && field === "image.alt") return slide.image.alt;
  return null;
}

function withScalar(slide: DeckSlide, field: string, value: string): DeckSlide {
  if (field === "title") return { ...slide, title: value };
  if (slide.layout === "title" && field === "subtitle") return { ...slide, subtitle: value };
  if (slide.layout === "image-ref" && field === "caption") return { ...slide, caption: value };
  if (slide.layout === "image-ref" && field === "image.ref") {
    return { ...slide, image: { ref: value, alt: slide.image.alt } };
  }
  if (slide.layout === "image-ref" && field === "image.alt") {
    return { ...slide, image: { ref: slide.image.ref, alt: value } };
  }
  return slide;
}

function withList(slide: DeckSlide, field: string, items: string[]): DeckSlide {
  if (slide.layout === "bullets" && field === "bullets") return { ...slide, bullets: items };
  if (slide.layout === "two-column" && field === "left") return { ...slide, left: items };
  if (slide.layout === "two-column" && field === "right") return { ...slide, right: items };
  return slide;
}

function replaceSlide(deck: DeckDocument, at: number, slide: DeckSlide): DeckDocument {
  const slides = [...deck.slides];
  slides[at] = slide;
  return { ...deck, slides };
}

function locate(deck: DeckDocument, slideId: string): ContractResult<{ at: number; slide: DeckSlide }> {
  const at = slideIndexOf(deck, slideId);
  if (at < 0) return fail("identifier", `no slide ${slideId}`);
  return { ok: true, value: { at, slide: deck.slides[at]! } };
}

function checkText(value: string): ContractResult<string> {
  if (typeof value !== "string") return fail("field_type", "value must be a string");
  if (value.length > DECK_LIMITS.maxTextLength) {
    return fail("limit", `value is longer than ${DECK_LIMITS.maxTextLength} characters`);
  }
  return { ok: true, value };
}

/**
 * Apply one command, answering with the new deck and the command that undoes it.
 *
 * Never mutates its input: an App's State process holds the previous deck while
 * it decides whether to commit, and an in-place edit would have already happened
 * by the time a refusal was returned.
 *
 * Every refusal is a value. This function is the one place the deck's rules are
 * enforced, so an App's backend is a passthrough and a preview harness is the
 * same passthrough — which is what makes "the same edit behaves the same in the
 * preview and in production" structural rather than a testing convention.
 */
export function applyDeckCommand(deck: DeckDocument, command: DeckCommand): ContractResult<DeckEdit> {
  switch (command.op) {
    case "set_deck_title": {
      const checked = checkText(command.value);
      if (!checked.ok) return checked;
      return {
        ok: true,
        value: {
          deck: { ...deck, title: checked.value },
          inverse: { op: "set_deck_title", value: deck.title },
        },
      };
    }

    case "set_theme": {
      if (!isDeckTheme(command.value)) return fail("schema", "theme must be light or dark");
      return {
        ok: true,
        value: { deck: { ...deck, theme: command.value }, inverse: { op: "set_theme", value: deck.theme } },
      };
    }

    case "set_text": {
      const found = locate(deck, command.slide);
      if (!found.ok) return found;
      const { at, slide } = found.value;
      if (!isDeckTextField(slide.layout, command.field)) {
        return fail("schema", `${slide.layout} slides have no field ${command.field}`);
      }
      const checked = checkText(command.value);
      if (!checked.ok) return checked;
      if (isDeckListField(slide.layout, command.field)) {
        if (command.index === undefined) return fail("missing_field", `${command.field} is a list; index is required`);
        const items = listOf(slide, command.field)!;
        if (!Number.isInteger(command.index) || command.index < 0 || command.index >= items.length) {
          return fail("limit", `index ${String(command.index)} is outside ${command.field}`);
        }
        const next = [...items];
        const previous = next[command.index]!;
        next[command.index] = checked.value;
        return {
          ok: true,
          value: {
            deck: replaceSlide(deck, at, withList(slide, command.field, next)),
            inverse: { op: "set_text", slide: slide.id, field: command.field, index: command.index, value: previous },
          },
        };
      }
      // A scalar field with an index would be a caller that believes this field
      // is a list. Accepting it and ignoring the index is how a UI ends up
      // writing every bullet into the title.
      if (command.index !== undefined) return fail("schema", `${command.field} is not a list`);
      const previous = scalarOf(slide, command.field)!;
      return {
        ok: true,
        value: {
          deck: replaceSlide(deck, at, withScalar(slide, command.field, checked.value)),
          inverse: { op: "set_text", slide: slide.id, field: command.field, value: previous },
        },
      };
    }

    case "insert_item": {
      const found = locate(deck, command.slide);
      if (!found.ok) return found;
      const { at, slide } = found.value;
      if (!isDeckListField(slide.layout, command.field)) {
        return fail("schema", `${slide.layout} slides have no list ${command.field}`);
      }
      const checked = checkText(command.value);
      if (!checked.ok) return checked;
      const items = listOf(slide, command.field)!;
      if (items.length >= DECK_LIMITS.maxListItems) {
        return fail("limit", `${command.field} already holds ${DECK_LIMITS.maxListItems} items`);
      }
      if (!Number.isInteger(command.index) || command.index < 0 || command.index > items.length) {
        return fail("limit", `index ${String(command.index)} is outside ${command.field}`);
      }
      const next = [...items];
      next.splice(command.index, 0, checked.value);
      return {
        ok: true,
        value: {
          deck: replaceSlide(deck, at, withList(slide, command.field, next)),
          inverse: { op: "remove_item", slide: slide.id, field: command.field, index: command.index },
        },
      };
    }

    case "remove_item": {
      const found = locate(deck, command.slide);
      if (!found.ok) return found;
      const { at, slide } = found.value;
      if (!isDeckListField(slide.layout, command.field)) {
        return fail("schema", `${slide.layout} slides have no list ${command.field}`);
      }
      const items = listOf(slide, command.field)!;
      if (!Number.isInteger(command.index) || command.index < 0 || command.index >= items.length) {
        return fail("limit", `index ${String(command.index)} is outside ${command.field}`);
      }
      const next = [...items];
      const [removed] = next.splice(command.index, 1);
      return {
        ok: true,
        value: {
          deck: replaceSlide(deck, at, withList(slide, command.field, next)),
          inverse: { op: "insert_item", slide: slide.id, field: command.field, index: command.index, value: removed! },
        },
      };
    }

    case "insert_slide": {
      if (!DECK_ID_PATTERN.test(command.slide)) return fail("identifier", "slide id is not well formed");
      if (slideIndexOf(deck, command.slide) >= 0) return fail("identifier", `slide ${command.slide} already exists`);
      if (!isDeckLayout(command.layout)) return fail("schema", "unknown layout");
      if (deck.slides.length >= DECK_LIMITS.maxSlides) {
        return fail("limit", `a deck holds at most ${DECK_LIMITS.maxSlides} slides`);
      }
      if (!Number.isInteger(command.index) || command.index < 0 || command.index > deck.slides.length) {
        return fail("limit", `index ${String(command.index)} is outside the deck`);
      }
      const slides = [...deck.slides];
      slides.splice(command.index, 0, emptySlide(command.slide, command.layout));
      return {
        ok: true,
        value: { deck: { ...deck, slides }, inverse: { op: "remove_slide", slide: command.slide } },
      };
    }

    case "move_slide": {
      const found = locate(deck, command.slide);
      if (!found.ok) return found;
      const { at } = found.value;
      if (!Number.isInteger(command.index) || command.index < 0 || command.index >= deck.slides.length) {
        return fail("limit", `index ${String(command.index)} is outside the deck`);
      }
      const slides = [...deck.slides];
      const [moved] = slides.splice(at, 1);
      slides.splice(command.index, 0, moved!);
      return {
        ok: true,
        value: { deck: { ...deck, slides }, inverse: { op: "move_slide", slide: command.slide, index: at } },
      };
    }

    case "remove_slide": {
      const found = locate(deck, command.slide);
      if (!found.ok) return found;
      const { at, slide } = found.value;
      const slides = [...deck.slides];
      slides.splice(at, 1);
      return {
        ok: true,
        // The inverse carries the slide itself. Nothing else could restore it,
        // and this is the command the wire cannot express.
        value: { deck: { ...deck, slides }, inverse: { op: "restore_slide", value: slide, index: at } },
      };
    }

    case "restore_slide": {
      const read = readDeckSlide(command.value, "command.value");
      if (!read.ok) return { ok: false, issues: read.issues };
      if (slideIndexOf(deck, read.value.id) >= 0) return fail("identifier", `slide ${read.value.id} already exists`);
      if (deck.slides.length >= DECK_LIMITS.maxSlides) {
        return fail("limit", `a deck holds at most ${DECK_LIMITS.maxSlides} slides`);
      }
      if (!Number.isInteger(command.index) || command.index < 0 || command.index > deck.slides.length) {
        return fail("limit", `index ${String(command.index)} is outside the deck`);
      }
      const slides = [...deck.slides];
      slides.splice(command.index, 0, read.value);
      return {
        ok: true,
        value: { deck: { ...deck, slides }, inverse: { op: "remove_slide", slide: read.value.id } },
      };
    }
  }
}

/**
 * A command as flat wire values, or `null` when it does not cross.
 *
 * Answering `null` rather than throwing, and rather than encoding a slide as
 * JSON inside one bounded value: a slide that fits until it does not would fail
 * as a truncated deck rather than as an explicit refusal.
 */
export function encodeDeckCommand(command: DeckCommand): Record<string, string> | null {
  switch (command.op) {
    case "set_deck_title":
      return { op: command.op, value: command.value };
    case "set_theme":
      return { op: command.op, value: command.value };
    case "set_text": {
      const out: Record<string, string> = { op: command.op, slide: command.slide, field: command.field, value: command.value };
      if (command.index !== undefined) out.index = String(command.index);
      return out;
    }
    case "insert_item":
      return {
        op: command.op,
        slide: command.slide,
        field: command.field,
        index: String(command.index),
        value: command.value,
      };
    case "remove_item":
      return { op: command.op, slide: command.slide, field: command.field, index: String(command.index) };
    case "insert_slide":
      return { op: command.op, slide: command.slide, layout: command.layout, index: String(command.index) };
    case "move_slide":
      return { op: command.op, slide: command.slide, index: String(command.index) };
    case "remove_slide":
      return { op: command.op, slide: command.slide };
    case "restore_slide":
      return null;
  }
}

function wireString(bag: IssueBag, row: Record<string, unknown>, key: string, max: number): string | null {
  const value = row[key];
  if (typeof value !== "string") {
    bag.add(value === undefined ? "missing_field" : "field_type", `${key} must be a string`, "command");
    return null;
  }
  if (value.length > max) {
    bag.add("limit", `${key} is longer than ${max} characters`, "command");
    return null;
  }
  return value;
}

function wireIndex(bag: IssueBag, row: Record<string, unknown>, optional = false): number | undefined {
  const value = row.index;
  if (value === undefined || value === "") {
    if (!optional) bag.add("missing_field", "index is required", "command");
    return undefined;
  }
  if (typeof value !== "string" || !/^\d{1,4}$/.test(value)) {
    bag.add("field_type", "index must be a decimal string", "command");
    return undefined;
  }
  return Number.parseInt(value, 10);
}

function wireSlideId(bag: IssueBag, row: Record<string, unknown>): string | null {
  const value = wireString(bag, row, "slide", DECK_LIMITS.maxIdLength);
  if (value === null) return null;
  if (!DECK_ID_PATTERN.test(value)) {
    bag.add("identifier", "slide id is not well formed", "command");
    return null;
  }
  return value;
}

/**
 * Wire values back into a command.
 *
 * The trusted side runs this on arrival; so does the preview harness. What it
 * refuses is as much the point as what it accepts — `restore_slide` is refused
 * BY NAME, so a client that discovered the op string still cannot ask for a
 * restore it would have to supply the content of.
 */
export function readDeckCommand(params: unknown): ContractResult<WireDeckCommand> {
  const bag = new IssueBag();
  const row = objectAt(bag, params, "command");
  if (!row) return bag.fail();
  const op = row.op;
  if (typeof op !== "string") {
    bag.add("missing_field", "op is required", "command");
    return bag.fail();
  }
  if (op === "restore_slide") {
    bag.add("schema", "restore_slide is not carried on this channel", "command");
    return bag.fail();
  }
  if (!(DECK_COMMAND_OPS as readonly string[]).includes(op)) {
    bag.add("schema", `unknown op ${op.slice(0, 40)}`, "command");
    return bag.fail();
  }
  for (const key of Object.keys(row)) {
    if (!(DECK_WIRE_KEYS as readonly string[]).includes(key)) {
      bag.add("unknown_field", `unknown key ${key.slice(0, 40)}`, "command");
    }
  }
  if (!bag.empty) return bag.fail();

  switch (op as Exclude<DeckCommandOp, "restore_slide">) {
    case "set_deck_title": {
      const value = wireString(bag, row, "value", DECK_LIMITS.maxTextLength);
      if (!bag.empty) return bag.fail();
      return { ok: true, value: { op: "set_deck_title", value: value! } };
    }
    case "set_theme": {
      const value = wireString(bag, row, "value", DECK_LIMITS.maxTextLength);
      if (value !== null && !isDeckTheme(value)) bag.add("schema", "theme must be light or dark", "command");
      if (!bag.empty) return bag.fail();
      return { ok: true, value: { op: "set_theme", value: value as DeckTheme } };
    }
    case "set_text": {
      const slide = wireSlideId(bag, row);
      const field = wireString(bag, row, "field", 40);
      const value = wireString(bag, row, "value", DECK_LIMITS.maxTextLength);
      const index = wireIndex(bag, row, true);
      if (!bag.empty) return bag.fail();
      const command: SetTextCommand = { op: "set_text", slide: slide!, field: field!, value: value! };
      if (index !== undefined) command.index = index;
      return { ok: true, value: command };
    }
    case "insert_item": {
      const slide = wireSlideId(bag, row);
      const field = wireString(bag, row, "field", 40);
      const value = wireString(bag, row, "value", DECK_LIMITS.maxTextLength);
      const index = wireIndex(bag, row);
      if (!bag.empty) return bag.fail();
      return { ok: true, value: { op: "insert_item", slide: slide!, field: field!, index: index!, value: value! } };
    }
    case "remove_item": {
      const slide = wireSlideId(bag, row);
      const field = wireString(bag, row, "field", 40);
      const index = wireIndex(bag, row);
      if (!bag.empty) return bag.fail();
      return { ok: true, value: { op: "remove_item", slide: slide!, field: field!, index: index! } };
    }
    case "insert_slide": {
      const slide = wireSlideId(bag, row);
      const layout = wireString(bag, row, "layout", 40);
      const index = wireIndex(bag, row);
      if (layout !== null && !isDeckLayout(layout)) bag.add("schema", "unknown layout", "command");
      if (!bag.empty) return bag.fail();
      return { ok: true, value: { op: "insert_slide", slide: slide!, layout: layout as DeckLayout, index: index! } };
    }
    case "move_slide": {
      const slide = wireSlideId(bag, row);
      const index = wireIndex(bag, row);
      if (!bag.empty) return bag.fail();
      return { ok: true, value: { op: "move_slide", slide: slide!, index: index! } };
    }
    case "remove_slide": {
      const slide = wireSlideId(bag, row);
      if (!bag.empty) return bag.fail();
      return { ok: true, value: { op: "remove_slide", slide: slide! } };
    }
  }
}

/**
 * Whether a ref is one this contract would carry.
 *
 * Exported because an editor needs to tell a person "that is not a ref" before
 * proposing it, and re-deriving the rule in the View is how the two answers
 * start disagreeing. It still says nothing about what the ref NAMES.
 */
export function deckRefProblem(ref: string): string | null {
  if (ref === "") return null;
  if (ref.length > DECK_LIMITS.maxRefLength) return `引用超过 ${DECK_LIMITS.maxRefLength} 个字符`;
  if (!DECK_REF_PATTERN.test(ref)) return "引用只能是不含空格的可打印 ASCII";
  return null;
}
