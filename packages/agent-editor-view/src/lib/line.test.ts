/**
 * Reading `context.line`, including everything that is not a line number.
 *
 * The platform bounds an intent context and never interprets it, so this is the
 * only place a `line` becomes a number — and a hint that is not one must not be
 * able to become `Infinity`, `NaN`, a negative offset or a document position in
 * a file that has none of those.
 */

import { describe, expect, it } from "vitest";
import { EDITOR_CONTEXT_LINE } from "../manifests.js";
import { requestedLine } from "./line.js";

describe("requestedLine", () => {
  it("reads a 1-based line", () => {
    expect(requestedLine({ [EDITOR_CONTEXT_LINE]: "1" })).toBe(1);
    expect(requestedLine({ [EDITOR_CONTEXT_LINE]: "120" })).toBe(120);
  });

  it("ignores everything that is not one, rather than refusing to open", () => {
    // A context is a hint. A panel that failed to open because a hint was
    // malformed would be strictly worse than one that opens at the top.
    for (const value of ["", "0", "-3", "1.5", "12abc", " 12", "1e3", "٣", "NaN", "Infinity"]) {
      expect(requestedLine({ [EDITOR_CONTEXT_LINE]: value }), value).toBeNull();
    }
    expect(requestedLine({ column: "4" })).toBeNull();
    expect(requestedLine(null)).toBeNull();
    expect(requestedLine(undefined)).toBeNull();
  });

  it("ignores an absurd line without doing arithmetic on it", () => {
    // `Number("9".repeat(400))` is `Infinity`, and an editor that scrolled there
    // would be doing arithmetic on a value nobody bounded.
    expect(requestedLine({ [EDITOR_CONTEXT_LINE]: "9".repeat(400) })).toBeNull();
    expect(requestedLine({ [EDITOR_CONTEXT_LINE]: "999999999" })).toBeNull();
    expect(requestedLine({ [EDITOR_CONTEXT_LINE]: "1000000" })).toBe(1_000_000);
  });
});
