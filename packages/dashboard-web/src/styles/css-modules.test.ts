/**
 * One cascade rule, enforced: a CSS Module must not paint a background through
 * a bare `input`/`textarea` selector.
 *
 * `styles/index.css` puts the native reset and the themes in `@layer
 * dashboard-base` and Ant in `@layer antd`, and deliberately leaves page CSS
 * Modules *unlayered* so a page can still make a local adjustment without
 * fighting selector specificity. That freedom has one sharp edge, and ticket
 * #202 is what it cost:
 *
 *   Ant v6 builds every Select around `.ant-select-input`, a real
 *   `<input type="text">` positioned `absolute; inset: 0` across the whole
 *   trigger, directly over the chosen value. Ant keeps it transparent — but
 *   from inside `@layer antd`, so any unlayered rule wins regardless of
 *   specificity. `.newPane input[type="text"] { background: var(--card) }`,
 *   written for the panel's own text fields, therefore laid an opaque
 *   card-coloured panel over the selected model and effort.
 *
 * Everything else about those controls stayed correct, which is why it survived
 * three attempted fixes: the label was in the DOM, at full opacity, in the
 * right colour. `getComputedStyle` said it was visible. `toHaveTextContent`
 * passed. Selecting the row and pasting produced the text. Only the eye
 * disagreed — the value was painted, then covered.
 *
 * jsdom cannot see this: it does not compose layers, resolve `background`, or
 * paint. A static rule can, and this is that rule. Style the adapter class
 * (`.ant-input`, which only UiInput/UiTextArea carry) instead of the element.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Keep the relative directory out of `new URL(..., import.meta.url)`: Vite
// rewrites that static asset pattern to an HTTP URL in jsdom, which Node's
// filesystem APIs cannot read.
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Containers that really do render native controls, with no Ant component in
 * the subtree for a bare selector to reach into. The Agent View module demos
 * on the architecture page are plain HTML on purpose — the point of that page
 * is to show the module, not the panel's own toolkit.
 */
const NATIVE_CONTROL_CONTAINERS = new Set([
  "pages/ArchitecturePage.module.css :: .demoSearchLabel input",
  "pages/ArchitecturePage.module.css :: .demoComposer input",
  "pages/ArchitecturePage.module.css :: .demoForm input",
]);

function moduleStylesheets(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) moduleStylesheets(path, found);
    else if (path.endsWith(".module.css")) found.push(path);
  }
  return found;
}

/** A selector whose subject is the element itself, e.g. `.pane textarea`. */
const BARE_CONTROL_SUBJECT = /(^|[\s>+~])(input|textarea)(\[[^\]]*\])?$/;
const PAINTS_BACKGROUND = /(^|[\s;])background(-color)?\s*:/;

function backgroundsPaintedThroughBareControls(): string[] {
  const offenders: string[] = [];
  for (const file of moduleStylesheets(SRC)) {
    const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!PAINTS_BACKGROUND.test(rule[2]!)) continue;
      for (const selector of rule[1]!.split(",").map((part) => part.trim()).filter(Boolean)) {
        if (!BARE_CONTROL_SUBJECT.test(selector)) continue;
        offenders.push(`${relative(SRC, file).replaceAll("\\", "/")} :: ${selector}`);
      }
    }
  }
  return offenders;
}

describe("page CSS Modules against Ant's internals", () => {
  it("never paints a background through a bare input/textarea selector", () => {
    const unexpected = backgroundsPaintedThroughBareControls().filter(
      (offender) => !NATIVE_CONTROL_CONTAINERS.has(offender),
    );
    expect(unexpected).toEqual([]);
  });

  it("keeps the allowance list honest rather than growing it silently", () => {
    const offenders = new Set(backgroundsPaintedThroughBareControls());
    // An entry that no longer matches anything is a stale excuse; delete it.
    expect([...NATIVE_CONTROL_CONTAINERS].filter((entry) => !offenders.has(entry))).toEqual([]);
  });
});
