/**
 * The edit vocabulary, and the two properties the design rests on.
 *
 *  · **Every inverse actually inverts.** Asserted as byte equality on the
 *    canonical encoding, not as a deep-equal on an object graph, because the
 *    encoded form is what a caller stores and compares.
 *  · **Everything a View can build crosses the wire, and the one thing that
 *    cannot is refused BY NAME.** That asymmetry is the finding this package
 *    exists to record: undo is a server-side operation.
 */

import { describe, expect, it } from "vitest";
import {
  DECK_COMMAND_OPS,
  DECK_WIRE_KEYS,
  applyDeckCommand,
  deckRefProblem,
  encodeDeckCommand,
  readDeckCommand,
  type DeckCommand,
  type WireDeckCommand,
} from "./commands.js";
import { DECK_LIMITS, DECK_MODEL_SCHEMA, type DeckDocument } from "./model.js";
import { encodeDeck, readDeck } from "./read.js";

function deck(): DeckDocument {
  const read = readDeck({
    schema: DECK_MODEL_SCHEMA,
    title: "起点",
    theme: "light",
    slides: [
      { id: "cover", layout: "title", title: "封面", subtitle: "副标题" },
      { id: "agenda", layout: "bullets", title: "议程", bullets: ["一", "二", "三"] },
      { id: "split", layout: "two-column", title: "对比", left: ["旧"], right: ["新"] },
      { id: "shot", layout: "image-ref", title: "截图", image: { ref: "r1", alt: "描述" }, caption: "说明" },
    ],
  });
  if (!read.ok) throw new Error("fixture is not a deck");
  return read.value;
}

function applied(base: DeckDocument, command: DeckCommand) {
  const result = applyDeckCommand(base, command);
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.issues)}`);
  return result.value;
}

function refused(base: DeckDocument, command: DeckCommand) {
  const result = applyDeckCommand(base, command);
  if (result.ok) throw new Error("expected a refusal");
  return result.issues;
}

/** One of every op, for the exhaustive suites below. */
const EVERY_COMMAND: readonly DeckCommand[] = [
  { op: "set_deck_title", value: "新标题" },
  { op: "set_theme", value: "dark" },
  { op: "set_text", slide: "cover", field: "subtitle", value: "改过的副标题" },
  { op: "set_text", slide: "agenda", field: "bullets", index: 1, value: "第二条" },
  { op: "insert_item", slide: "agenda", field: "bullets", index: 0, value: "零" },
  { op: "remove_item", slide: "split", field: "left", index: 0 },
  { op: "insert_slide", slide: "new1", layout: "bullets", index: 2 },
  { op: "move_slide", slide: "cover", index: 3 },
  { op: "remove_slide", slide: "shot" },
  { op: "restore_slide", value: { id: "extra", layout: "title", title: "回来了", subtitle: "" }, index: 0 },
];

describe("applyDeckCommand", () => {
  it("covers every op in the vocabulary", () => {
    expect(new Set(EVERY_COMMAND.map((command) => command.op))).toEqual(new Set(DECK_COMMAND_OPS));
  });

  it("never mutates the deck it was given", () => {
    for (const command of EVERY_COMMAND) {
      const base = deck();
      const before = encodeDeck(base);
      applyDeckCommand(base, command);
      expect(encodeDeck(base), command.op).toBe(before);
    }
  });

  it("undoes itself: apply then apply the inverse is the identity", () => {
    for (const command of EVERY_COMMAND) {
      const base = deck();
      const before = encodeDeck(base);
      const forward = applied(base, command);
      expect(encodeDeck(forward.deck), command.op).not.toBe(before);
      const back = applied(forward.deck, forward.inverse);
      expect(encodeDeck(back.deck), `${command.op} did not invert`).toBe(before);
    }
  });

  it("moves a slide to the index asked for, and back", () => {
    const forward = applied(deck(), { op: "move_slide", slide: "cover", index: 2 });
    expect(forward.deck.slides.map((slide) => slide.id)).toEqual(["agenda", "split", "cover", "shot"]);
    expect(forward.inverse).toEqual({ op: "move_slide", slide: "cover", index: 0 });
  });

  it("inserts a slide with every field empty, at the index asked for", () => {
    const forward = applied(deck(), { op: "insert_slide", slide: "fresh", layout: "two-column", index: 1 });
    expect(forward.deck.slides.map((slide) => slide.id)).toEqual(["cover", "fresh", "agenda", "split", "shot"]);
    expect(forward.deck.slides[1]).toEqual({ id: "fresh", layout: "two-column", title: "", left: [], right: [] });
  });

  it("refuses a second slide with an id that already exists, so a retry is not a duplicate", () => {
    expect(refused(deck(), { op: "insert_slide", slide: "cover", layout: "title", index: 0 })[0]).toMatchObject({
      code: "identifier",
    });
  });

  it("refuses an edit to a slide that is not there rather than writing into a neighbour", () => {
    expect(refused(deck(), { op: "set_text", slide: "ghost", field: "title", value: "x" })[0]).toMatchObject({
      code: "identifier",
    });
  });

  it("refuses a field that the slide's layout does not have", () => {
    expect(refused(deck(), { op: "set_text", slide: "cover", field: "caption", value: "x" })[0]).toMatchObject({
      code: "schema",
    });
    expect(refused(deck(), { op: "insert_item", slide: "cover", field: "bullets", index: 0, value: "x" })[0])
      .toMatchObject({ code: "schema" });
  });

  it("refuses an index on a scalar and demands one on a list", () => {
    // Accepting an index on a scalar and ignoring it is how every bullet ends up
    // written into the title.
    expect(refused(deck(), { op: "set_text", slide: "cover", field: "title", index: 0, value: "x" })[0])
      .toMatchObject({ code: "schema" });
    expect(refused(deck(), { op: "set_text", slide: "agenda", field: "bullets", value: "x" })[0])
      .toMatchObject({ code: "missing_field" });
  });

  it("refuses an index outside the list or the deck", () => {
    expect(refused(deck(), { op: "set_text", slide: "agenda", field: "bullets", index: 9, value: "x" })[0])
      .toMatchObject({ code: "limit" });
    expect(refused(deck(), { op: "remove_item", slide: "agenda", field: "bullets", index: -1 })[0])
      .toMatchObject({ code: "limit" });
    expect(refused(deck(), { op: "move_slide", slide: "cover", index: 4 })[0]).toMatchObject({ code: "limit" });
    // …but inserting AT the end is inside, because that is where "append" is.
    expect(applyDeckCommand(deck(), { op: "insert_item", slide: "agenda", field: "bullets", index: 3, value: "四" }).ok)
      .toBe(true);
  });

  it("refuses text the wire could not carry back", () => {
    const long = "x".repeat(DECK_LIMITS.maxTextLength + 1);
    expect(refused(deck(), { op: "set_text", slide: "cover", field: "title", value: long })[0])
      .toMatchObject({ code: "limit" });
    expect(refused(deck(), { op: "set_deck_title", value: long })[0]).toMatchObject({ code: "limit" });
  });

  it("refuses a list that is already full", () => {
    let current = deck();
    while (true) {
      const next = applyDeckCommand(current, { op: "insert_item", slide: "agenda", field: "bullets", index: 0, value: "x" });
      if (!next.ok) {
        expect(next.issues[0]).toMatchObject({ code: "limit" });
        break;
      }
      current = next.value.deck;
      expect(current.slides.length).toBeLessThanOrEqual(DECK_LIMITS.maxSlides);
    }
    const full = current.slides.find((slide) => slide.id === "agenda")!;
    expect(full.layout === "bullets" && full.bullets.length).toBe(DECK_LIMITS.maxListItems);
  });

  it("refuses a restore whose payload is not a slide, and one whose id is taken", () => {
    expect(refused(deck(), { op: "restore_slide", value: { id: "x", layout: "nope" } as never, index: 0 }).length)
      .toBeGreaterThan(0);
    expect(refused(deck(), {
      op: "restore_slide",
      value: { id: "cover", layout: "title", title: "", subtitle: "" },
      index: 0,
    })[0]).toMatchObject({ code: "identifier" });
  });
});

describe("the wire", () => {
  const wireCommands = EVERY_COMMAND.filter((command) => command.op !== "restore_slide") as WireDeckCommand[];

  it("encodes every command a View can build", () => {
    for (const command of wireCommands) {
      expect(encodeDeckCommand(command), command.op).not.toBeNull();
    }
  });

  it("cannot encode the inverse of a removal — undo belongs to the side that holds the deck", () => {
    const forward = applied(deck(), { op: "remove_slide", slide: "agenda" });
    expect(forward.inverse.op).toBe("restore_slide");
    expect(encodeDeckCommand(forward.inverse)).toBeNull();
  });

  it("uses only the declared keys, and no more of them than declared", () => {
    for (const command of wireCommands) {
      const params = encodeDeckCommand(command)!;
      for (const key of Object.keys(params)) {
        expect(DECK_WIRE_KEYS as readonly string[], `${command.op}.${key}`).toContain(key);
      }
      expect(Object.keys(params).length, command.op).toBeLessThanOrEqual(DECK_WIRE_KEYS.length);
      for (const value of Object.values(params)) {
        expect(typeof value).toBe("string");
        expect(value.length).toBeLessThanOrEqual(DECK_LIMITS.maxTextLength);
      }
    }
  });

  it("round-trips every wire command through the flat form", () => {
    for (const command of wireCommands) {
      const read = readDeckCommand(encodeDeckCommand(command)!);
      expect(read.ok, `${command.op}: ${JSON.stringify(read)}`).toBe(true);
      expect((read as { ok: true; value: WireDeckCommand }).value).toEqual(command);
    }
  });

  it("refuses restore_slide by name, even from a caller that guessed the op string", () => {
    const read = readDeckCommand({ op: "restore_slide", slide: "a", index: "0" });
    expect(read.ok).toBe(false);
    expect((read as { ok: false; issues: { message: string }[] }).issues[0]!.message).toContain("restore_slide");
  });

  it("refuses a key it does not know, an op it does not know, and a missing op", () => {
    expect(readDeckCommand({ op: "remove_slide", slide: "a", sudo: "1" }).ok).toBe(false);
    expect(readDeckCommand({ op: "drop_database", slide: "a" }).ok).toBe(false);
    expect(readDeckCommand({ slide: "a" }).ok).toBe(false);
    expect(readDeckCommand("remove_slide").ok).toBe(false);
    expect(readDeckCommand(null).ok).toBe(false);
  });

  it("refuses an index that is not a decimal string", () => {
    for (const index of ["1.5", "-1", "1e3", " 1", "0x10", "99999", ""]) {
      expect(readDeckCommand({ op: "move_slide", slide: "a", index }).ok, index).toBe(false);
    }
  });

  it("refuses a malformed slide id on the wire", () => {
    expect(readDeckCommand({ op: "remove_slide", slide: "../etc" }).ok).toBe(false);
    expect(readDeckCommand({ op: "remove_slide", slide: "" }).ok).toBe(false);
  });

  it("treats an absent index on set_text as a scalar edit, not as index 0", () => {
    const read = readDeckCommand({ op: "set_text", slide: "cover", field: "title", value: "x" });
    expect(read.ok).toBe(true);
    expect((read as { ok: true; value: WireDeckCommand }).value).toEqual({
      op: "set_text",
      slide: "cover",
      field: "title",
      value: "x",
    });
  });

  it("answers rather than throws for anything at all", () => {
    for (const value of [undefined, 3, [], true, { op: 1 }, { op: "set_text" }]) {
      expect(() => readDeckCommand(value)).not.toThrow();
      expect(readDeckCommand(value).ok).toBe(false);
    }
  });
});

describe("deckRefProblem", () => {
  it("accepts absence and an opaque ref, refuses whitespace and length", () => {
    expect(deckRefProblem("")).toBeNull();
    expect(deckRefProblem("wsfile:9f2c")).toBeNull();
    expect(deckRefProblem("a b")).toBeTruthy();
    expect(deckRefProblem("x".repeat(DECK_LIMITS.maxRefLength + 1))).toBeTruthy();
  });
});
