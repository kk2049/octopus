import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "KnowledgePage.module.css"), "utf8");
const rules = (selector: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
  .filter((match) => match[1]!.split(",").some((part) => part.trim() === selector)).map((match) => match[2]!).join("\n");

// jsdom cannot paint grid overflow. Guard the actual cause in the supplied
// screenshot: intrinsic-width queue cards must not cover the detail/Agent columns.
it("contains intrinsic long-text widths at each conflict grid boundary", () => {
  for (const selector of [".conflictWorkspace", ".conflictQueue", ".conflictQueue button", ".conflictMain", ".conflictAgent"]) {
    expect(rules(selector), selector).toMatch(/min-width:\s*0/);
  }
  expect(rules(".conflictQueue button")).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  expect(rules(".conflictQueue button")).toMatch(/overflow-wrap:\s*anywhere/);
  expect(rules(".conflictQueue button")).toMatch(/overflow:\s*hidden/);
  expect(rules(".conflictQueue b")).not.toMatch(/white-space:\s*nowrap/);
  expect(rules(".conflictWorkspaceWithAgent")).not.toMatch(/minmax\(\d+(?:px|rem)/);
});

it("keeps narrow-screen cards bounded and the detailed evidence readable", () => {
  expect(rules(".conflictQueue button")).toMatch(/flex:\s*0 0 min\(280px,\s*80vw\)/);
  expect(rules(".conflictDecision .sides")).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  expect(rules(".conflictQueue span")).toMatch(/-webkit-line-clamp:\s*3/);
});
