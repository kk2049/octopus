// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { textRangeFromOffsets, textSelectionOffsets } from "./dom-selection.js";

describe("PDF text-layer DOM selection", () => {
  it("keeps a selection spanning positioned text-line nodes aligned to textContent", () => {
    const root = document.createElement("div");
    const first = document.createElement("span");
    const second = document.createElement("span");
    first.textContent = "first line selected ";
    second.textContent = "across lines remainder";
    root.append(first, document.createElement("br"), second);
    document.body.append(root);

    const range = document.createRange();
    range.setStart(first.firstChild!, 11);
    range.setEnd(second.firstChild!, 12);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    expect(textSelectionOffsets(root, selection)).toEqual({
      start: 11,
      end: 32,
      text: "selected across lines",
    });

    const rebuilt = textRangeFromOffsets(root, 11, 32);
    expect(rebuilt?.cloneContents().textContent).toBe("selected across lines");
  });

  it("refuses a range whose other boundary is outside the PDF page", () => {
    const root = document.createElement("div");
    const outside = document.createElement("div");
    root.textContent = "inside";
    outside.textContent = "outside";
    document.body.append(root, outside);
    const range = document.createRange();
    range.setStart(root.firstChild!, 0);
    range.setEnd(outside.firstChild!, 3);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    expect(textSelectionOffsets(root, selection)).toBeNull();
  });
});
