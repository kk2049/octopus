/**
 * The reader, and the property that makes the encoded form an identity.
 *
 * Two families of assertion:
 *
 *  · **Round trip is byte equality.** Not "parses to an equal object" — equal
 *    BYTES, because callers compare encoded decks (a diff, a digest, an "is this
 *    the same deck") and an encoding that reordered keys would make those
 *    comparisons wrong in a way nothing on screen shows.
 *  · **Every refusal is a value with a field name on it.** A deck is a document
 *    an agent or a person wrote; "invalid" with no `at` is a refusal nobody can
 *    act on.
 */

import { describe, expect, it } from "vitest";
import {
  DECK_LIMITS,
  DECK_MODEL_SCHEMA,
  emptyDeck,
  emptySlide,
  findSlide,
  isDeckRef,
  slideIndexOf,
  type DeckDocument,
  type DeckSlide,
} from "./model.js";
import { encodeDeck, parseDeck, readDeck, readDeckSlide } from "./read.js";

const DECK = {
  schema: DECK_MODEL_SCHEMA,
  title: "Q3 汇报",
  theme: "dark",
  slides: [
    { id: "cover", layout: "title", title: "Q3", subtitle: "工程" },
    { id: "agenda", layout: "bullets", title: "议程", bullets: ["进度", "风险"] },
    { id: "split", layout: "two-column", title: "对比", left: ["旧"], right: ["新"] },
    {
      id: "shot",
      layout: "image-ref",
      title: "截图",
      image: { ref: "wsfile:9f2c", alt: "面板" },
      caption: "上线当天",
    },
  ],
};

function accepted(value: unknown): DeckDocument {
  const read = readDeck(value);
  if (!read.ok) throw new Error(`expected ok, got ${JSON.stringify(read.issues)}`);
  return read.value;
}

function refusal(value: unknown) {
  const read = readDeck(value);
  if (read.ok) throw new Error("expected a refusal");
  return read.issues;
}

describe("readDeck", () => {
  it("accepts a deck with every layout in it", () => {
    const deck = accepted(DECK);
    expect(deck.slides).toHaveLength(4);
    expect(deck.theme).toBe("dark");
    expect(slideIndexOf(deck, "split")).toBe(2);
    expect(findSlide(deck, "nope")).toBeNull();
  });

  it("fills absent optional fields with the empty string rather than refusing", () => {
    const deck = accepted({
      schema: DECK_MODEL_SCHEMA,
      slides: [{ id: "a", layout: "title" }, { id: "b", layout: "bullets" }],
    });
    expect(deck.title).toBe("");
    expect(deck.theme).toBe("light");
    expect(deck.slides[0]).toEqual({ id: "a", layout: "title", title: "", subtitle: "" });
    expect(deck.slides[1]).toEqual({ id: "b", layout: "bullets", title: "", bullets: [] });
  });

  it("round-trips canonical bytes exactly", () => {
    const first = encodeDeck(accepted(DECK));
    const again = parseDeck(first);
    expect(again.ok).toBe(true);
    expect(encodeDeck((again as { ok: true; value: DeckDocument }).value)).toBe(first);
  });

  it("puts the fields in one fixed order whatever order they arrived in", () => {
    const shuffled = {
      slides: [{ layout: "title", subtitle: "b", id: "a", title: "t" }],
      theme: "light",
      title: "x",
      schema: DECK_MODEL_SCHEMA,
    };
    expect(encodeDeck(accepted(shuffled))).toBe(encodeDeck(accepted({
      schema: DECK_MODEL_SCHEMA,
      title: "x",
      theme: "light",
      slides: [{ id: "a", layout: "title", title: "t", subtitle: "b" }],
    })));
  });

  it("encodes an empty deck as canonical bytes too", () => {
    const text = encodeDeck(emptyDeck("空"));
    expect(text.endsWith("\n")).toBe(true);
    expect(encodeDeck(accepted(JSON.parse(text)))).toBe(text);
  });

  it("refuses a field this build does not know, at document and slide level", () => {
    expect(refusal({ ...DECK, futureFlag: true })[0]).toMatchObject({ code: "unknown_field", at: "deck" });
    expect(
      refusal({ ...DECK, slides: [{ id: "a", layout: "title", notes: "hi" }] })[0],
    ).toMatchObject({ code: "unknown_field", at: "deck.slides[0]" });
    expect(
      refusal({ ...DECK, slides: [{ id: "a", layout: "image-ref", image: { ref: "r", alt: "", w: 1 } }] })[0],
    ).toMatchObject({ code: "unknown_field", at: "deck.slides[0].image" });
  });

  it("refuses a field that belongs to a different layout", () => {
    // The check is per layout, which is the whole reason the field sets are a
    // table: a union of every key would let this through and drop it silently.
    const issues = refusal({ ...DECK, slides: [{ id: "a", layout: "title", bullets: ["x"] }] });
    expect(issues[0]).toMatchObject({ code: "unknown_field" });
  });

  it("refuses an unknown layout instead of rendering a blank slide", () => {
    expect(refusal({ ...DECK, slides: [{ id: "a", layout: "video" }] })[0]).toMatchObject({ code: "schema" });
  });

  it("refuses an unknown theme", () => {
    expect(refusal({ ...DECK, theme: "midnight" })[0]).toMatchObject({ code: "schema", at: "deck" });
  });

  it("refuses a wrong schema tag", () => {
    expect(refusal({ ...DECK, schema: "deck-model/v2" })[0]).toMatchObject({ code: "schema" });
  });

  it("refuses duplicate slide ids, because an edit addresses by id", () => {
    const issues = refusal({
      ...DECK,
      slides: [{ id: "a", layout: "title" }, { id: "a", layout: "bullets" }],
    });
    expect(issues.some((issue) => issue.code === "identifier" && issue.message.includes("duplicate"))).toBe(true);
  });

  it("refuses a malformed id", () => {
    for (const id of ["", "-leading", "has space", "a/b", "x".repeat(65), "..", "a\\u0000b"]) {
      const issues = refusal({ ...DECK, slides: [{ id, layout: "title" }] });
      expect(issues.length, `id ${JSON.stringify(id)}`).toBeGreaterThan(0);
    }
  });

  it("refuses text longer than a proposal value can carry", () => {
    const long = "x".repeat(DECK_LIMITS.maxTextLength + 1);
    expect(refusal({ ...DECK, slides: [{ id: "a", layout: "title", title: long }] })[0]).toMatchObject({
      code: "limit",
    });
    expect(refusal({ ...DECK, slides: [{ id: "a", layout: "bullets", bullets: [long] }] })[0]).toMatchObject({
      code: "limit",
    });
  });

  it("refuses lists that are too long and items that are not strings", () => {
    const many = Array.from({ length: DECK_LIMITS.maxListItems + 1 }, (_, i) => `b${i}`);
    expect(refusal({ ...DECK, slides: [{ id: "a", layout: "bullets", bullets: many }] })[0]).toMatchObject({
      code: "limit",
    });
    expect(refusal({ ...DECK, slides: [{ id: "a", layout: "bullets", bullets: [1] }] })[0]).toMatchObject({
      code: "field_type",
    });
  });

  it("refuses more slides than the bound allows", () => {
    const slides = Array.from({ length: DECK_LIMITS.maxSlides + 1 }, (_, i) => ({ id: `s${i}`, layout: "title" }));
    expect(refusal({ ...DECK, slides })[0]).toMatchObject({ code: "limit" });
  });

  describe("image refs", () => {
    const withImage = (image: unknown) => ({
      ...DECK,
      slides: [{ id: "a", layout: "image-ref", image }],
    });

    it("treats the empty string as absence, not as a ref", () => {
      const deck = accepted(withImage({ ref: "", alt: "还没选" }));
      expect(deck.slides[0]).toEqual({
        id: "a",
        layout: "image-ref",
        title: "",
        image: { ref: "", alt: "还没选" },
        caption: "",
      });
      expect(isDeckRef("")).toBe(false);
    });

    it("carries an opaque ref verbatim without inspecting what it names", () => {
      for (const ref of ["wsfile:9f2c", "../../etc/passwd", "https://x/y", "%%%"]) {
        const deck = accepted(withImage({ ref, alt: "" }));
        expect((deck.slides[0] as { image: { ref: string } }).image.ref).toBe(ref);
      }
    });

    it("refuses a ref with whitespace or beyond the bound", () => {
      expect(refusal(withImage({ ref: "a b" }))[0]).toMatchObject({ code: "identifier" });
      expect(refusal(withImage({ ref: "x".repeat(DECK_LIMITS.maxRefLength + 1) }))[0]).toMatchObject({ code: "limit" });
      expect(refusal(withImage({ ref: 7 }))[0]).toMatchObject({ code: "field_type" });
    });

    it("defaults a missing image to absence", () => {
      const deck = accepted({ ...DECK, slides: [{ id: "a", layout: "image-ref" }] });
      expect(deck.slides[0]).toMatchObject({ image: { ref: "", alt: "" } });
    });
  });

  it("answers rather than throws for anything at all", () => {
    for (const value of [null, undefined, 3, "deck", [], true, { schema: 1 }, { schema: DECK_MODEL_SCHEMA, slides: 5 }]) {
      expect(() => readDeck(value)).not.toThrow();
      expect(readDeck(value).ok).toBe(false);
    }
  });

  it("bounds a diagnostic and replaces the control characters in it", () => {
    const issues = refusal({ ...DECK, [`bad\u0007key${"z".repeat(400)}`]: 1 });
    expect(issues[0]!.message.length).toBeLessThanOrEqual(160);
    expect(issues[0]!.message).toContain("\uFFFD");
    expect(issues[0]!.message).not.toContain("\u0007");
  });

  it("keeps control characters inside a person's text, because filtering edits their deck", () => {
    const deck = accepted({ ...DECK, slides: [{ id: "a", layout: "title", title: "line\nbreak\ttab" }] });
    expect(deck.slides[0]).toMatchObject({ title: "line\nbreak\ttab" });
  });

  it("refuses JSON that is not JSON without throwing", () => {
    const read = parseDeck("{not json");
    expect(read.ok).toBe(false);
  });
});

describe("readDeckSlide", () => {
  it("reads one slide on its own, for a restore command", () => {
    const read = readDeckSlide({ id: "a", layout: "bullets", bullets: ["x"] });
    expect(read.ok).toBe(true);
  });

  it("names the caller's location in the refusal", () => {
    const read = readDeckSlide({ id: "a", layout: "nope" }, "undo.value");
    expect(read.ok).toBe(false);
    expect((read as { ok: false; issues: { at?: string }[] }).issues[0]!.at).toBe("undo.value");
  });
});

/** Every author-written string on a slide, flattened. Ids and layouts excluded. */
function textValuesOf(slide: DeckSlide): string[] {
  const out = [slide.title];
  if (slide.layout === "title") out.push(slide.subtitle);
  if (slide.layout === "bullets") out.push(...slide.bullets);
  if (slide.layout === "two-column") out.push(...slide.left, ...slide.right);
  if (slide.layout === "image-ref") out.push(slide.caption, slide.image.ref, slide.image.alt);
  return out;
}

describe("emptySlide", () => {
  it("produces an empty, readable slide for every layout", () => {
    for (const layout of ["title", "bullets", "two-column", "image-ref"] as const) {
      const slide = emptySlide("s1", layout);
      expect(readDeckSlide(slide).ok, layout).toBe(true);
      // No sample text: a new slide nobody has typed into must not arrive with
      // words in it, because those words end up on a projector.
      for (const value of textValuesOf(slide)) expect(value, layout).toBe("");
    }
  });
});
