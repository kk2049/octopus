/**
 * The words a person sees for a vocabulary the contract states in English.
 *
 * A table rather than a `switch` in each component, and a table indexed by the
 * contract's own union so that adding a layout there is a compile error here
 * instead of a slide labelled `undefined`.
 *
 * Field labels are keyed by name because the vocabulary is per layout and a
 * name means the same thing in every layout that has it — `title` is 标题 on a
 * cover and on a bullet page, and pretending otherwise would be two words for
 * one field.
 */

import type { DeckLayout } from "@claude-bot/deck-model-contract";

export const LAYOUT_LABELS: Readonly<Record<DeckLayout, string>> = Object.freeze({
  title: "封面",
  bullets: "要点页",
  "two-column": "双栏",
  "image-ref": "图片页",
});

const FIELD_LABELS: Readonly<Record<string, string>> = Object.freeze({
  title: "标题",
  subtitle: "副标题",
  caption: "图注",
  "image.ref": "图片引用",
  "image.alt": "替代文字",
  bullets: "要点",
  left: "左栏",
  right: "右栏",
});

export function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

/** What a slide is called in a list when its author has not titled it. */
export const UNTITLED = "（未命名）";
