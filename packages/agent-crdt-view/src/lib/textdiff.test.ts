/**
 * Turning a textarea's value back into one edit.
 *
 * The interesting cases are the ones a naive prefix/suffix diff gets wrong:
 * an emoji next to the edit, and an edit whose result is ambiguous.
 */

import { describe, expect, it } from "vitest";
import { diffText } from "./textdiff.js";

function apply(before: string, edit: { index: number; remove: number; insert: string }): string {
  return before.slice(0, edit.index) + edit.insert + before.slice(edit.index + edit.remove);
}

describe("diffText", () => {
  it("reports nothing when nothing changed", () => {
    expect(diffText("abc", "abc")).toBeNull();
  });

  const CASES: readonly [string, string, string][] = [
    ["", "a", "typing into an empty document"],
    ["abc", "abXc", "typing in the middle"],
    ["abc", "abc!", "typing at the end"],
    ["abc", "!abc", "typing at the start"],
    ["abc", "ac", "backspace"],
    ["abc", "", "select all and delete"],
    ["hello world", "hello brave world", "pasting"],
    ["hello world", "goodbye world", "select and replace"],
    ["aaa", "aa", "deleting from a run of identical characters"],
    ["ab", "aab", "duplicating a character"],
  ];

  for (const [before, after, what] of CASES) {
    it(`round-trips: ${what}`, () => {
      const edit = diffText(before, after);
      expect(edit).not.toBeNull();
      expect(apply(before, edit!)).toBe(after);
    });
  }

  it("reports the smallest range, not the whole document", () => {
    // A whole-document replace also produces the right string — and destroys
    // every concurrent edit while doing it. So the size of the range is the
    // property, not just the result.
    const edit = diffText("the quick brown fox", "the quick brown cat")!;
    expect(edit.index).toBe(16);
    expect(edit.remove).toBe(3);
    expect(edit.insert).toBe("cat");
  });

  it("never splits a surrogate pair at the head", () => {
    // "🙂" is two UTF-16 code units. A prefix ending between them is a legal
    // index that produces half a character on every replica.
    const edit = diffText("🙂a", "🙂ba")!;
    expect(apply("🙂a", edit)).toBe("🙂ba");
    expect(edit.index % 1).toBe(0);
    expect("🙂a".slice(0, edit.index)).toBe("🙂");
  });

  it("never splits a surrogate pair at the tail", () => {
    const edit = diffText("a🙂", "ab🙂")!;
    expect(apply("a🙂", edit)).toBe("ab🙂");
    expect(edit.insert).toBe("b");
  });

  it("handles an emoji being typed and removed", () => {
    const inserted = diffText("ab", "a🙂b")!;
    expect(apply("ab", inserted)).toBe("a🙂b");
    const removed = diffText("a🙂b", "ab")!;
    expect(apply("a🙂b", removed)).toBe("ab");
  });
});
