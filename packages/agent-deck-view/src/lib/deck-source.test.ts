/**
 * Getting a deck out of a projection, and choosing an id for a new slide.
 *
 * The three-way status is the point: "missing" and "invalid" are different
 * people's mistakes and a panel that shows "empty" for both hides one of them.
 */

import { describe, expect, it } from "vitest";
import { DECK_MODEL_SCHEMA, emptyDeck } from "@claude-bot/deck-model-contract";
import { nextSlideId, readDeckSource } from "./deck-source.js";

const DECK = {
  schema: DECK_MODEL_SCHEMA,
  title: "d",
  theme: "light",
  slides: [{ id: "s1", layout: "title", title: "a", subtitle: "" }],
};

describe("readDeckSource", () => {
  it("reads a deck at a dotted path", () => {
    const read = readDeckSource({ app: { deck: DECK } }, "app.deck");
    expect(read.status).toBe("ok");
    expect(read.deck?.slides).toHaveLength(1);
  });

  it("says missing when the path resolves to nothing", () => {
    expect(readDeckSource({ deck: DECK }, "nope").status).toBe("missing");
    expect(readDeckSource(null, "deck").status).toBe("missing");
    expect(readDeckSource({ deck: null }, "deck").status).toBe("missing");
  });

  it("says invalid, with the reader's own diagnostics, when the shape is wrong", () => {
    const read = readDeckSource({ deck: { schema: "deck-model/v1", slides: [{ id: "a", layout: "video" }] } }, "deck");
    expect(read.status).toBe("invalid");
    expect(read.deck).toBeNull();
    expect(read.issues.length).toBeGreaterThan(0);
    expect(read.issues[0]!.at).toContain("deck.slides[0]");
  });

  it("says invalid rather than missing for a value that is not an object", () => {
    expect(readDeckSource({ deck: "not a deck" }, "deck").status).toBe("invalid");
    expect(readDeckSource({ deck: [] }, "deck").status).toBe("invalid");
  });
});

describe("nextSlideId", () => {
  it("picks the first unused sN", () => {
    expect(nextSlideId(emptyDeck())).toBe("s1");
    const read = readDeckSource({ deck: DECK }, "deck");
    expect(nextSlideId(read.deck!)).toBe("s2");
  });

  it("fills a gap rather than counting, so an id is never reused by accident", () => {
    const deck = readDeckSource(
      {
        deck: {
          ...DECK,
          slides: [
            { id: "s1", layout: "title" },
            { id: "s3", layout: "title" },
          ],
        },
      },
      "deck",
    ).deck!;
    expect(nextSlideId(deck)).toBe("s2");
  });

  it("is a pure function of the deck, so a retry proposes the same id", () => {
    // That is what makes a double click one loud refusal instead of two slides:
    // the contract refuses a duplicate id. A random id would have made the retry
    // a second slide nobody asked for.
    const deck = readDeckSource({ deck: DECK }, "deck").deck!;
    expect(nextSlideId(deck)).toBe(nextSlideId(deck));
  });

  it("answers something well-formed for a deck full of unrelated ids", () => {
    const deck = readDeckSource(
      { deck: { ...DECK, slides: [{ id: "cover", layout: "title" }, { id: "agenda", layout: "title" }] } },
      "deck",
    ).deck!;
    expect(nextSlideId(deck)).toBe("s1");
  });
});
