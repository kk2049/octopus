import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "styles.css"), "utf8");

describe("Agent View mobile compatibility CSS", () => {
  it("keeps focused phone controls at a non-zooming size and a touchable height", () => {
    expect(CSS).toMatch(
      /@media \(max-width: 720px\), \(hover: none\) and \(pointer: coarse\)[\s\S]*font-size: max\(16px, var\(--av-font-control\), var\(--mobile-control-font-size, 16px\)\) !important/,
    );
    expect(CSS).toMatch(/@media \(max-width: 720px\)[\s\S]*min-height: var\(--av-touch-target\)/);
  });
});
