/**
 * The escaping, proved by reading the generated file back.
 *
 * ── Why a tokeniser instead of a list of expected substrings ────────────────
 *
 * An assertion like `expect(out).toContain('\\"')` passes for an output that
 * escaped the quote AND for one that escaped it twice, or escaped it and then
 * emitted a stray one somewhere else. What actually has to be true is a property
 * of the whole document: *every* `"` in it opens or closes a string literal, and
 * every literal decodes to exactly the text that went in.
 *
 * So this file contains a small Typst string scanner. If the generator ever lets
 * a character out of a literal, the scanner either finds an unterminated string,
 * an unknown escape, or a decoded value that is not what the deck said — and all
 * three are the same bug seen from different sides.
 *
 * The hostile corpus below is not a threat model (decision 12); it is the set of
 * characters that are *meaningful to Typst*, which is exactly the set that
 * silently mangles a person's slide.
 */

import { describe, expect, it } from "vitest";
import { DECK_LAYOUTS, DECK_MODEL_SCHEMA, emptyDeck, type DeckDocument } from "./model.js";
import { readDeck } from "./read.js";
import { TYPST_STRING_ESCAPES, deckToTypst, escapeTypstString, typstString } from "./typst.js";

/**
 * Every Typst string literal in a document, decoded.
 *
 * Skips `//` comments, because the generator puts the deck's title in one and a
 * quote inside a comment is not a literal. That the comments have no newline in
 * them is asserted separately — a comment that wrapped would make the rest of
 * this scan meaningless, which is precisely why it is checked.
 */
function typstStringLiterals(source: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (ch !== '"') {
      i += 1;
      continue;
    }
    i += 1;
    let value = "";
    for (;;) {
      if (i >= source.length) throw new Error("unterminated string literal");
      const c = source[i]!;
      if (c === '"') {
        i += 1;
        break;
      }
      if (c === "\n") throw new Error("raw newline inside a string literal");
      if (c !== "\\") {
        value += c;
        i += 1;
        continue;
      }
      const next = source[i + 1];
      if (next === "\\" || next === '"') {
        value += next;
        i += 2;
        continue;
      }
      if (next === "n" || next === "r" || next === "t") {
        value += next === "n" ? "\n" : next === "r" ? "\r" : "\t";
        i += 2;
        continue;
      }
      if (next === "u" && source[i + 2] === "{") {
        const close = source.indexOf("}", i + 3);
        if (close < 0) throw new Error("unterminated \\u{}");
        const hex = source.slice(i + 3, close);
        if (!/^[0-9a-f]{1,6}$/.test(hex)) throw new Error(`bad \\u{${hex}}`);
        value += String.fromCodePoint(Number.parseInt(hex, 16));
        i = close + 1;
        continue;
      }
      throw new Error(`unknown escape \\${String(next)}`);
    }
    out.push(value);
  }
  return out;
}

/** Characters Typst gives a meaning to, plus the ones a JS string can smuggle. */
const HOSTILE = [
  '#panic("boom")',
  '"); #sys.exit(); #("',
  "back\\slash and \\\" quote",
  "[content block] and ]]",
  "$x^2 + y$",
  "@citation-key",
  "`raw block`",
  "*bold* _em_ ~nbsp~",
  "<label> and >quote",
  "= heading\n- item\n+ item\n/ term: def",
  "--- em dash ... ellipsis",
  "tab\there\r\nCRLF",
  "null:\u0000 bell:\u0007 del:\u007f",
  "emoji 🎉 中文 ünïcödé",
  "100% of 1/2 * 3",
];

function deckOf(texts: readonly string[]): DeckDocument {
  const read = readDeck({
    schema: DECK_MODEL_SCHEMA,
    title: "标题",
    theme: "light",
    slides: [
      { id: "a", layout: "title", title: texts[0] ?? "", subtitle: texts[1] ?? "" },
      { id: "b", layout: "bullets", title: texts[2] ?? "", bullets: texts.slice(3, 8) },
      { id: "c", layout: "two-column", title: texts[8] ?? "", left: texts.slice(9, 12), right: texts.slice(12, 14) },
      {
        id: "d",
        layout: "image-ref",
        title: texts[14] ?? "",
        image: { ref: "opaque-ref-1", alt: texts[0] ?? "" },
        caption: texts[1] ?? "",
      },
    ],
  });
  if (!read.ok) throw new Error(`fixture is not a deck: ${JSON.stringify(read.issues)}`);
  return read.value;
}

describe("escapeTypstString", () => {
  it("has an escape for exactly the characters a literal cannot hold raw", () => {
    expect(Object.keys(TYPST_STRING_ESCAPES).sort()).toEqual(['"', "\t", "\n", "\r", "\\"].sort());
  });

  it("round-trips every hostile string through a real literal", () => {
    for (const text of HOSTILE) {
      expect(typstStringLiterals(typstString(text)), text).toEqual([text]);
    }
  });

  it("escapes control characters rather than emitting them raw", () => {
    expect(escapeTypstString("\u0000\u0007\u001f\u007f")).toBe("\\u{0}\\u{7}\\u{1f}\\u{7f}");
  });

  it("keeps astral characters as themselves", () => {
    expect(escapeTypstString("🎉")).toBe("🎉");
    expect(typstStringLiterals(typstString("a🎉b"))).toEqual(["a🎉b"]);
  });

  it("replaces a lone surrogate, because a Typst string has no way to hold one", () => {
    // Total rather than a refusal: a deck that reads fine must always export, and
    // emitting the half raw would produce a file that is not valid UTF-8.
    expect(escapeTypstString("a\ud800b")).toBe("a�b");
    expect(escapeTypstString("\udfffx")).toBe("�x");
  });

  it("is idempotent in the sense that matters: escaping twice is not the same as escaping once", () => {
    // Stated as a guard against somebody "fixing" a double-escape bug by calling
    // this twice: the second pass escapes the backslashes the first one added.
    expect(escapeTypstString(escapeTypstString('a"b'))).not.toBe(escapeTypstString('a"b'));
  });
});

describe("deckToTypst", () => {
  it("puts every author-written string inside a literal, and nothing outside one", () => {
    const deck = deckOf(HOSTILE);
    const literals = typstStringLiterals(deckToTypst(deck));
    for (const text of HOSTILE.slice(0, 15)) {
      expect(literals, JSON.stringify(text)).toContain(text);
    }
  });

  it("keeps every comment on one line, so the scan above means something", () => {
    const source = deckToTypst(deckOf(["a\nb\rc", "x"]));
    for (const line of source.split("\n")) {
      const at = line.indexOf("//");
      if (at < 0) continue;
      expect(line.slice(at)).not.toContain("\n");
    }
    // The deck title reaches a comment, and its control characters are gone.
    const titled = deckToTypst({ ...deckOf([]), title: "line\nbreak" });
    expect(titled).toContain("// deck: line break");
  });

  it("is deterministic", () => {
    const deck = deckOf(HOSTILE);
    expect(deckToTypst(deck)).toBe(deckToTypst(deck));
  });

  it("emits something for every layout in the vocabulary", () => {
    // Exhaustive over the model's own tuple, so a fifth layout added there fails
    // here rather than rendering as a blank page.
    for (const layout of DECK_LAYOUTS) {
      const read = readDeck({
        schema: DECK_MODEL_SCHEMA,
        slides: [{ id: "only", layout, title: "T" }],
      });
      expect(read.ok, layout).toBe(true);
      const source = deckToTypst((read as { ok: true; value: DeckDocument }).value);
      expect(source, layout).toContain(`// slide only · ${layout}`);
      expect(source, layout).toContain('#deck-heading("T")');
    }
  });

  it("separates slides with one weak pagebreak and never leads with one", () => {
    const source = deckToTypst(deckOf(["a", "b", "c"]));
    expect(source.match(/#pagebreak\(weak: true\)/g)).toHaveLength(3);
    expect(source.indexOf("#pagebreak")).toBeGreaterThan(source.indexOf("// slide a"));
  });

  it("says so, rather than emitting a broken document, for a deck with no slides", () => {
    const source = deckToTypst(emptyDeck("空"));
    expect(source).toContain("This deck has no slides yet.");
    expect(source).not.toContain("#pagebreak");
    expect(() => typstStringLiterals(source)).not.toThrow();
  });

  it("omits a field the author left empty instead of rendering an empty box", () => {
    const read = readDeck({ schema: DECK_MODEL_SCHEMA, slides: [{ id: "a", layout: "title", title: "T" }] });
    const source = deckToTypst((read as { ok: true; value: DeckDocument }).value);
    expect(source).not.toContain("#deck-lead");
  });

  it("changes the preamble with the theme and nothing else", () => {
    const light = deckOf(["x"]);
    const dark: DeckDocument = { ...light, theme: "dark" };
    expect(deckToTypst(light)).toContain('rgb("#ffffff")');
    expect(deckToTypst(dark)).toContain('rgb("#14161a")');
    const strip = (source: string) => source.slice(source.indexOf("// slide"));
    expect(strip(deckToTypst(light))).toBe(strip(deckToTypst(dark)));
  });

  describe("the image seam", () => {
    const withImage = (ref: string, alt: string): DeckDocument => {
      const read = readDeck({
        schema: DECK_MODEL_SCHEMA,
        slides: [{ id: "i", layout: "image-ref", title: "T", image: { ref, alt }, caption: "C" }],
      });
      if (!read.ok) throw new Error("fixture");
      return read.value;
    };

    it("renders a placeholder when nothing resolves the ref", () => {
      const source = deckToTypst(withImage("blob:abc", "一张截图"));
      expect(source).toContain('#deck-image-missing("blob:abc", "一张截图")');
      expect(source).not.toContain("#deck-image-file");
    });

    it("renders the resolver's path when a deployment supplies one", () => {
      const source = deckToTypst(withImage("blob:abc", "alt"), { resolveImage: () => "assets/abc.png" });
      expect(source).toContain('#deck-image-file("assets/abc.png")');
      expect(source).not.toContain("#deck-image-missing");
    });

    it("falls back to the placeholder when the resolver answers null", () => {
      expect(deckToTypst(withImage("blob:abc", "alt"), { resolveImage: () => null })).toContain("#deck-image-missing");
    });

    it("never asks a resolver about a slide that has no image", () => {
      const asked: string[] = [];
      deckToTypst(withImage("", "alt"), {
        resolveImage: (ref) => {
          asked.push(ref);
          return "x.png";
        },
      });
      expect(asked).toEqual([]);
    });

    it("escapes what a resolver returns, so a resolver cannot inject Typst", () => {
      const source = deckToTypst(withImage("blob:abc", "alt"), {
        resolveImage: () => 'a.png"); #panic("',
      });
      expect(typstStringLiterals(source)).toContain('a.png"); #panic("');
    });
  });
});
