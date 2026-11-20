/**
 * One canvas gesture, as `deck-model/v1` commands — pure functions, so the
 * mapping is a checkable value.
 *
 * ── What replaced the batch planner, and why ────────────────────────────────
 *
 * The form editor this package used to ship compiled a whole-slide draft into
 * N ordered proposals (`planSlideEdits`, worklog P6d wall 4), because a form
 * has one save button and a save is everything at once. The visual canvas has
 * no save button: editing happens in place, and every gesture — replace this
 * text, append an item, remove an item — IS one semantic command. So the
 * partial-save problem that planner existed to order away is dissolved rather
 * than reordered: the only multi-command gesture left is reordering a list
 * item, which is two `set_text`s whose every prefix leaves a valid slide (a
 * swap half-applied is a duplicated line, not a hole).
 *
 * There is no `move_item` in the command vocabulary, and these functions do
 * not pretend one exists: a reorder is emitted as the two overwrites it is.
 *
 * Every function answers `[]` for a gesture that says nothing (same value,
 * index out of range, empty append) — the caller sends nothing rather than
 * proposing a no-op for the backend to accept into the undo log.
 */

import {
  DECK_LIMITS,
  isDeckListField,
  isDeckTextField,
  type DeckSlide,
  type WireDeckCommand,
} from "@claude-bot/deck-model-contract";

/** The current value of a scalar field, in the layout's own vocabulary. */
export function scalarValue(slide: DeckSlide, field: string): string {
  if (field === "title") return slide.title;
  if (slide.layout === "title" && field === "subtitle") return slide.subtitle;
  if (slide.layout === "image-ref" && field === "caption") return slide.caption;
  if (slide.layout === "image-ref" && field === "image.ref") return slide.image.ref;
  if (slide.layout === "image-ref" && field === "image.alt") return slide.image.alt;
  return "";
}

/** The current items of a list field. Empty for a field the layout lacks. */
export function listValue(slide: DeckSlide, field: string): readonly string[] {
  if (slide.layout === "bullets" && field === "bullets") return slide.bullets;
  if (slide.layout === "two-column" && field === "left") return slide.left;
  if (slide.layout === "two-column" && field === "right") return slide.right;
  return [];
}

/** Replace one text region — a scalar, or one list item by index. */
export function replaceTextCommands(
  slide: DeckSlide,
  field: string,
  index: number | null,
  next: string,
): WireDeckCommand[] {
  if (index === null) {
    if (!isDeckTextField(slide.layout, field) || isDeckListField(slide.layout, field)) return [];
    if (scalarValue(slide, field) === next) return [];
    return [{ op: "set_text", slide: slide.id, field, value: next }];
  }
  const items = listValue(slide, field);
  if (index < 0 || index >= items.length || items[index] === next) return [];
  return [{ op: "set_text", slide: slide.id, field, index, value: next }];
}

/** Append one item at the end of a list. Nothing for empty text or a full list. */
export function appendItemCommands(slide: DeckSlide, field: string, value: string): WireDeckCommand[] {
  if (!isDeckListField(slide.layout, field) || !value) return [];
  const items = listValue(slide, field);
  if (items.length >= DECK_LIMITS.maxListItems) return [];
  return [{ op: "insert_item", slide: slide.id, field, index: items.length, value }];
}

/** Remove one item by index. */
export function removeItemCommands(slide: DeckSlide, field: string, index: number): WireDeckCommand[] {
  const items = listValue(slide, field);
  if (index < 0 || index >= items.length) return [];
  return [{ op: "remove_item", slide: slide.id, field, index }];
}

/**
 * Move one item up or down: the two `set_text`s of an adjacent swap.
 *
 * Overwrites rather than remove-and-insert, because every prefix of a pair of
 * overwrites is a valid slide of the same length — an interrupted swap shows a
 * duplicated line, not a lost one.
 */
export function swapItemCommands(slide: DeckSlide, field: string, index: number, delta: -1 | 1): WireDeckCommand[] {
  const items = listValue(slide, field);
  const to = index + delta;
  if (index < 0 || index >= items.length || to < 0 || to >= items.length) return [];
  return [
    { op: "set_text", slide: slide.id, field, index, value: items[to]! },
    { op: "set_text", slide: slide.id, field, index: to, value: items[index]! },
  ];
}
