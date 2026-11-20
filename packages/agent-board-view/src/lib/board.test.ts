/**
 * The readers never throw and never invent: every malformed shape is a status
 * or a skipped entry, because a projection is the one input a generic module
 * has and it is authored by someone else's backend.
 */

import { describe, expect, it } from "vitest";
import { BOARD_LIMITS, cellKey, readBoard, readHighlightSet } from "./board.js";

describe("readBoard", () => {
  it("reads a well-formed board and keys cells by position", () => {
    const out = readBoard({
      rows: 3,
      cols: 4,
      cells: [
        { r: 0, c: 0, glyph: "●", label: "甲", tone: "info" },
        { r: 2, c: 3, glyph: "○" },
      ],
    });
    expect(out.status).toBe("ok");
    expect(out.rows).toBe(3);
    expect(out.cols).toBe(4);
    expect(out.cells.get("0,0")).toEqual({ glyph: "●", label: "甲", tone: "info" });
    // Label falls back to the glyph; tone to neutral.
    expect(out.cells.get("2,3")).toEqual({ glyph: "○", label: "○", tone: "neutral" });
  });

  it("separates a missing path from a malformed value", () => {
    expect(readBoard(undefined).status).toBe("missing");
    for (const bad of [null, "board", 7, [], { rows: 3 }, { rows: "3", cols: 3 }, { rows: 0, cols: 3 }, { rows: 2.5, cols: 3 }]) {
      expect(readBoard(bad).status, JSON.stringify(bad)).toBe("malformed");
    }
  });

  it("refuses an oversized board instead of clamping it", () => {
    expect(readBoard({ rows: BOARD_LIMITS.maxRows + 1, cols: 3 }).status).toBe("too_large");
    expect(readBoard({ rows: BOARD_LIMITS.maxRows, cols: BOARD_LIMITS.maxCols }).status).toBe("ok");
  });

  it("treats absent cells as an empty board, and non-array cells as malformed", () => {
    expect(readBoard({ rows: 2, cols: 2 })).toMatchObject({ status: "ok", cells: new Map() });
    expect(readBoard({ rows: 2, cols: 2, cells: {} }).status).toBe("malformed");
  });

  it("skips out-of-range and unreadable cell entries; a later duplicate wins", () => {
    const out = readBoard({
      rows: 2,
      cols: 2,
      cells: [
        { r: -1, c: 0 }, { r: 0, c: 9 }, { r: "0", c: 0 }, null, "x", 42,
        { r: 1, c: 1, glyph: "a" },
        { r: 1, c: 1, glyph: "b" },
      ],
    });
    expect(out.status).toBe("ok");
    expect([...out.cells.keys()]).toEqual(["1,1"]);
    expect(out.cells.get("1,1")!.glyph).toBe("b");
  });

  it("clips glyphs and labels, ignores unknown fields and unknown tones", () => {
    const out = readBoard({
      rows: 1,
      cols: 1,
      extra: { anything: true },
      cells: [{ r: 0, c: 0, glyph: "g".repeat(99), label: "l".repeat(999), tone: "purple", side: "?" }],
    });
    const cell = out.cells.get("0,0")!;
    expect(cell.glyph).toHaveLength(BOARD_LIMITS.maxGlyph);
    expect(cell.label).toHaveLength(BOARD_LIMITS.maxLabel);
    expect(cell.tone).toBe("neutral");
  });
});

describe("readHighlightSet", () => {
  it("accepts {r,c} entries and \"r,c\" strings, in range only", () => {
    const out = readHighlightSet([{ r: 1, c: 2 }, "0,1", " 2 , 0 ", "9,9", { r: 5, c: 0 }, "x", null, 3], 3, 3);
    expect([...out].sort()).toEqual(["0,1", "1,2", "2,0"]);
  });

  it("answers empty for anything that is not an array", () => {
    for (const bad of [undefined, null, "0,0", { r: 0, c: 0 }, 5]) {
      expect(readHighlightSet(bad, 3, 3).size, JSON.stringify(bad)).toBe(0);
    }
  });
});

describe("cellKey", () => {
  it("is the wire spelling", () => {
    expect(cellKey(3, 4)).toBe("3,4");
  });
});
