/**
 * The gesture → command mapping, checked against the contract's own machinery.
 *
 * Every command a gesture produces is (1) applied with `applyDeckCommand`, so
 * the mapping is proven against the vocabulary's real semantics rather than an
 * expected-array of this file's own devising, and (2) pushed through the wire
 * codec, so no gesture can produce an edit the channel cannot carry.
 */

import { describe, expect, it } from "vitest";
import {
  DECK_LIMITS,
  DECK_MODEL_SCHEMA,
  applyDeckCommand,
  encodeDeckCommand,
  readDeckCommand,
  type DeckDocument,
  type DeckSlide,
  type WireDeckCommand,
} from "@claude-bot/deck-model-contract";
import {
  appendItemCommands,
  removeItemCommands,
  replaceTextCommands,
  swapItemCommands,
} from "./edits.js";

const BULLETS: DeckSlide = { id: "b", layout: "bullets", title: "要点", bullets: ["一", "二", "三"] };
const COVER: DeckSlide = { id: "c", layout: "title", title: "封面页", subtitle: "副题" };
const IMAGE: DeckSlide = { id: "i", layout: "image-ref", title: "图", image: { ref: "r1", alt: "替代" }, caption: "注" };

function deckWith(slide: DeckSlide): DeckDocument {
  return { schema: DECK_MODEL_SCHEMA, title: "d", theme: "light", slides: [slide] };
}

/** Apply a gesture's commands one at a time; answer every intermediate deck. */
function applyAll(slide: DeckSlide, commands: readonly WireDeckCommand[]): DeckDocument[] {
  let deck = deckWith(slide);
  const steps: DeckDocument[] = [];
  for (const command of commands) {
    const applied = applyDeckCommand(deck, command);
    expect(applied.ok, JSON.stringify(command)).toBe(true);
    deck = (applied as { ok: true; value: { deck: DeckDocument } }).value.deck;
    steps.push(deck);
  }
  return steps;
}

/** Every command a gesture emits must survive the wire, byte-identical. */
function wireSafe(commands: readonly WireDeckCommand[]): void {
  for (const command of commands) {
    const params = encodeDeckCommand(command);
    expect(params).not.toBeNull();
    const read = readDeckCommand(params!);
    expect(read.ok).toBe(true);
    expect((read as { ok: true; value: WireDeckCommand }).value).toEqual(command);
  }
}

describe("replaceTextCommands", () => {
  it("maps a scalar edit to one set_text, and applies", () => {
    const commands = replaceTextCommands(COVER, "subtitle", null, "新副题");
    expect(commands).toEqual([{ op: "set_text", slide: "c", field: "subtitle", value: "新副题" }]);
    wireSafe(commands);
    const [after] = applyAll(COVER, commands);
    expect(after!.slides[0]).toMatchObject({ subtitle: "新副题" });
  });

  it("maps a list-item edit to one indexed set_text, and applies", () => {
    const commands = replaceTextCommands(BULLETS, "bullets", 1, "新二");
    expect(commands).toEqual([{ op: "set_text", slide: "b", field: "bullets", index: 1, value: "新二" }]);
    wireSafe(commands);
    const [after] = applyAll(BULLETS, commands);
    expect(after!.slides[0]).toMatchObject({ bullets: ["一", "新二", "三"] });
  });

  it("edits the dotted image fields the property strip owns", () => {
    const commands = replaceTextCommands(IMAGE, "image.ref", null, "r2");
    expect(commands).toEqual([{ op: "set_text", slide: "i", field: "image.ref", value: "r2" }]);
    const [after] = applyAll(IMAGE, commands);
    expect(after!.slides[0]).toMatchObject({ image: { ref: "r2", alt: "替代" } });
  });

  it("says nothing for an unchanged value, an unknown field, or a dead index", () => {
    expect(replaceTextCommands(COVER, "subtitle", null, "副题")).toEqual([]);
    expect(replaceTextCommands(COVER, "caption", null, "x")).toEqual([]);
    // A list field addressed as a scalar is not a gesture, it is a bug — refuse.
    expect(replaceTextCommands(BULLETS, "bullets", null, "x")).toEqual([]);
    expect(replaceTextCommands(BULLETS, "bullets", 3, "x")).toEqual([]);
    expect(replaceTextCommands(BULLETS, "bullets", -1, "x")).toEqual([]);
    expect(replaceTextCommands(BULLETS, "bullets", 1, "二")).toEqual([]);
  });
});

describe("appendItemCommands", () => {
  it("appends at the end as one insert_item, and applies", () => {
    const commands = appendItemCommands(BULLETS, "bullets", "四");
    expect(commands).toEqual([{ op: "insert_item", slide: "b", field: "bullets", index: 3, value: "四" }]);
    wireSafe(commands);
    const [after] = applyAll(BULLETS, commands);
    expect(after!.slides[0]).toMatchObject({ bullets: ["一", "二", "三", "四"] });
  });

  it("says nothing for empty text, a non-list field, or a full list", () => {
    expect(appendItemCommands(BULLETS, "bullets", "")).toEqual([]);
    expect(appendItemCommands(BULLETS, "title", "x")).toEqual([]);
    const full: DeckSlide = {
      id: "f",
      layout: "bullets",
      title: "",
      bullets: Array.from({ length: DECK_LIMITS.maxListItems }, (_, index) => `条 ${index}`),
    };
    expect(appendItemCommands(full, "bullets", "溢出")).toEqual([]);
  });
});

describe("removeItemCommands", () => {
  it("removes by index as one remove_item, and applies", () => {
    const commands = removeItemCommands(BULLETS, "bullets", 0);
    expect(commands).toEqual([{ op: "remove_item", slide: "b", field: "bullets", index: 0 }]);
    wireSafe(commands);
    const [after] = applyAll(BULLETS, commands);
    expect(after!.slides[0]).toMatchObject({ bullets: ["二", "三"] });
  });

  it("says nothing for an index the list does not have", () => {
    expect(removeItemCommands(BULLETS, "bullets", 3)).toEqual([]);
    expect(removeItemCommands(BULLETS, "bullets", -1)).toEqual([]);
    expect(removeItemCommands(COVER, "bullets", 0)).toEqual([]);
  });
});

describe("swapItemCommands", () => {
  it("moves an item as two overwrites whose every prefix is a valid slide", () => {
    const commands = swapItemCommands(BULLETS, "bullets", 0, 1);
    expect(commands).toHaveLength(2);
    wireSafe(commands);
    const steps = applyAll(BULLETS, commands);
    // After only the FIRST command the slide is legal and the same length: an
    // interrupted swap duplicates a line, it never loses one or leaves a hole.
    expect(steps[0]!.slides[0]).toMatchObject({ bullets: ["二", "二", "三"] });
    expect(steps[1]!.slides[0]).toMatchObject({ bullets: ["二", "一", "三"] });
  });

  it("moves up as the same shape", () => {
    const steps = applyAll(BULLETS, swapItemCommands(BULLETS, "bullets", 2, -1));
    expect(steps.at(-1)!.slides[0]).toMatchObject({ bullets: ["一", "三", "二"] });
  });

  it("says nothing at either edge", () => {
    expect(swapItemCommands(BULLETS, "bullets", 0, -1)).toEqual([]);
    expect(swapItemCommands(BULLETS, "bullets", 2, 1)).toEqual([]);
    expect(swapItemCommands(BULLETS, "bullets", 5, 1)).toEqual([]);
  });
});
