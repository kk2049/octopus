import { describe, expect, it } from "vitest";
import { buildAnchorHint, normalizeNote, resolveAnchor, shortHash } from "./anchor.js";

describe("resolveAnchor", () => {
  it("returns empty for a blank quote", () => {
    expect(resolveAnchor("hello world", { quote: "", prefix: "", suffix: "" })).toEqual({
      status: "empty",
      start: 0,
      end: 0,
    });
  });

  it("matches exactly when the quote appears once", () => {
    const result = resolveAnchor("hello world", { quote: "world", prefix: "", suffix: "" });
    expect(result).toEqual({ status: "matched", start: 6, end: 11 });
  });

  it("uses prefix + quote + suffix to disambiguate repeated quotes", () => {
    const result = resolveAnchor(
      "the cat sat and the cat ran",
      { quote: "cat", prefix: "the ", suffix: " ran" },
    );
    expect(result).toMatchObject({ status: "matched" });
    expect("the cat sat and the cat ran".slice(result.start, result.end)).toBe("cat");
    expect(result.start).toBe(20);
  });

  it("falls back to prefix-only or suffix-only when the anchored window is ambiguous", () => {
    // "cat" appears twice; prefix "the " appears before both, but suffix " ran" only matches once.
    const result = resolveAnchor(
      "the cat sat and the cat ran",
      { quote: "cat", prefix: "", suffix: " ran" },
    );
    expect(result.status).toBe("matched");
    expect(result.start).toBe(20);
  });

  it("returns adrift when the quote is missing entirely", () => {
    const result = resolveAnchor("hello world", { quote: "kitty", prefix: "", suffix: "" });
    expect(result).toEqual({ status: "adrift", start: -1, end: -1 });
  });

  it("returns adrift when the quote is ambiguous and neither prefix nor suffix uniquifies it", () => {
    const result = resolveAnchor("cat cat cat", { quote: "cat", prefix: "", suffix: "" });
    expect(result.status).toBe("adrift");
  });
});

describe("buildAnchorHint", () => {
  it("captures short context on either side of the selection", () => {
    const text = "0123456789 QUOTE 9876543210";
    const hint = buildAnchorHint(text, text.indexOf("QUOTE"), text.indexOf("QUOTE") + "QUOTE".length);
    expect(hint.quote).toBe("QUOTE");
    expect(hint.prefix).toBe("0123456789 ");
    expect(hint.suffix).toBe(" 9876543210");
  });

  it("caps prefix and suffix at CONTEXT_CHARS", () => {
    const long = "x".repeat(100) + "MID" + "y".repeat(100);
    const start = long.indexOf("MID");
    const hint = buildAnchorHint(long, start, start + 3);
    expect(hint.prefix.length).toBeLessThanOrEqual(40);
    expect(hint.suffix.length).toBeLessThanOrEqual(40);
  });

  it("clamps out-of-range positions", () => {
    expect(buildAnchorHint("abc", -5, 100)).toEqual({ quote: "abc", prefix: "", suffix: "" });
    expect(buildAnchorHint("abc", 2, 1)).toEqual({ quote: "", prefix: "ab", suffix: "c" });
  });
});

describe("normalizeNote", () => {
  it("trims whitespace and collapses runs", () => {
    expect(normalizeNote("  hello   world  ")).toBe("hello world");
  });

  it("truncates by code point count", () => {
    const long = "abc" + "😀".repeat(1200);
    const out = normalizeNote(long, 1000);
    expect(Array.from(out).length).toBe(1000);
  });
});

describe("shortHash", () => {
  it("is stable across identical inputs", () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    expect(shortHash(bytes)).toBe(shortHash(bytes));
  });

  it("differs when a byte flips", () => {
    const a = shortHash(new Uint8Array([1, 2, 3]));
    const b = shortHash(new Uint8Array([1, 2, 4]));
    expect(a).not.toBe(b);
  });
});
