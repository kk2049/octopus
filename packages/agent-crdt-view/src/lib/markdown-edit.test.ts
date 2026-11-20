/**
 * The toolbar's text transforms, as the pure functions they are.
 *
 * Every case is phrased as (text, selection) → (text, selection) because that
 * is the whole contract: the component reads a textarea, calls one of these,
 * and writes both halves back. What matters in each assertion is the property
 * a person would notice — a toggle that nests instead of removing, a caret
 * that lands outside the markers, a numbered list that counts blank lines.
 */

import { describe, expect, it } from "vitest";
import { applyMarkdownCommand, type MarkdownEditState } from "./markdown-edit.js";

function state(text: string, start: number, end = start): MarkdownEditState {
  return { text, start, end };
}

describe("inline commands", () => {
  it("wraps a selection and keeps it selected for the next command", () => {
    const next = applyMarkdownCommand(state("hello world", 0, 5), "bold");
    expect(next).toEqual({ text: "**hello** world", start: 2, end: 7 });
  });

  it("is a toggle: pressing again unwraps rather than nesting", () => {
    const wrapped = applyMarkdownCommand(state("hello world", 0, 5), "bold");
    const back = applyMarkdownCommand(wrapped, "bold");
    expect(back.text).toBe("hello world");
    // And the selection is the plain word again.
    expect(back.text.slice(back.start, back.end)).toBe("hello");
  });

  it("unwraps when the selection includes the markers themselves", () => {
    const next = applyMarkdownCommand(state("**hello** world", 0, 9), "bold");
    expect(next.text).toBe("hello world");
  });

  it("drops a point caret between fresh markers, ready to type", () => {
    const next = applyMarkdownCommand(state("ab", 1), "italic");
    expect(next.text).toBe("a**b");
    expect(next.start).toBe(2);
    expect(next.end).toBe(2);
  });

  it("uses distinct markers for strike and inline code", () => {
    expect(applyMarkdownCommand(state("x", 0, 1), "strike").text).toBe("~~x~~");
    expect(applyMarkdownCommand(state("x", 0, 1), "code").text).toBe("`x`");
  });
});

describe("headings and quotes", () => {
  it("prefixes the whole line the caret sits in", () => {
    const next = applyMarkdownCommand(state("title\nbody", 2), "h1");
    expect(next.text).toBe("# title\nbody");
  });

  it("replaces a different heading level rather than stacking prefixes", () => {
    const next = applyMarkdownCommand(state("# title", 3), "h2");
    expect(next.text).toBe("## title");
  });

  it("toggles the same level off", () => {
    const next = applyMarkdownCommand(state("## title", 3), "h2");
    expect(next.text).toBe("title");
  });

  it("quotes every selected line, skipping blanks", () => {
    const next = applyMarkdownCommand(state("a\n\nb", 0, 4), "quote");
    expect(next.text).toBe("> a\n\n> b");
  });
});

describe("lists", () => {
  it("bullets every selected line", () => {
    const next = applyMarkdownCommand(state("one\ntwo", 0, 7), "ul");
    expect(next.text).toBe("- one\n- two");
  });

  it("numbers visible lines only, not blanks", () => {
    const next = applyMarkdownCommand(state("one\n\ntwo", 0, 8), "ol");
    expect(next.text).toBe("1. one\n\n2. two");
  });

  it("converts between list flavours in one press", () => {
    const next = applyMarkdownCommand(state("- one\n- two", 0, 11), "ol");
    expect(next.text).toBe("1. one\n2. two");
  });

  it("strips a uniform list back to plain lines", () => {
    const next = applyMarkdownCommand(state("- one\n- two", 0, 11), "ul");
    expect(next.text).toBe("one\ntwo");
  });
});

describe("blocks", () => {
  it("fences the selected lines and unfences them again", () => {
    const fenced = applyMarkdownCommand(state("const x = 1;", 0, 12), "codeblock");
    expect(fenced.text).toBe("```\nconst x = 1;\n```");
    const back = applyMarkdownCommand(fenced, "codeblock");
    expect(back.text).toBe("const x = 1;");
  });

  it("inserts a rule on its own paragraph, after the caret", () => {
    const next = applyMarkdownCommand(state("above", 5), "hr");
    expect(next.text).toBe("above\n\n---\n\n");
    expect(next.start).toBe(next.text.length);
  });
});

describe("hostile or degenerate selections", () => {
  it("clamps a selection beyond the text instead of throwing", () => {
    const next = applyMarkdownCommand(state("ab", 0, 99), "bold");
    expect(next.text).toBe("**ab**");
  });

  it("accepts a reversed selection the way a textarea can produce one", () => {
    const next = applyMarkdownCommand(state("hello", 5, 0), "bold");
    expect(next.text).toBe("**hello**");
  });

  it("works on the empty document", () => {
    expect(applyMarkdownCommand(state("", 0), "h1").text).toBe("# ");
    expect(applyMarkdownCommand(state("", 0), "hr").text).toBe("\n---\n\n");
  });
});
