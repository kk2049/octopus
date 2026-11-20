/**
 * §15.5's rule, checked against this package's public surface.
 *
 * > 结构化 deck model 是事实源 … Typst/SVG/PDF 是派生物。
 * > 不得同时把 deck JSON 与生成的 `.typ` 都声明成可编辑事实源。
 *
 * Two halves of that are checkable from inside the package and are checked here:
 * there is no export that turns Typst back into a deck, and a `DeckDocument`
 * holds no second representation for a round trip to disagree about.
 *
 * The third half — that no such function exists anywhere in the source, exported
 * or not, and that nothing here reaches for a compiler — needs to READ the
 * source, and this package deliberately compiles with `types: []` and no
 * `@types/node`, like every other contract package here. So that scan lives in
 * `agent-deck-view/src/architecture.test.ts`, which is the consumer that depends
 * on the rule holding and already has a filesystem. Splitting it is the price of
 * keeping "this package cannot name a Node built-in" a COMPILER error rather
 * than a test.
 */

import { describe, expect, it } from "vitest";
import { DECK_MODEL_SCHEMA, emptyDeck, emptySlide } from "./model.js";
import * as surface from "./index.js";

describe("the deck JSON is the only editable source of truth", () => {
  it("exports nothing that reads Typst", () => {
    for (const name of Object.keys(surface)) {
      expect(name, "an export that reads Typst").not.toMatch(/^(parse|read|from|import).*[Tt]ypst/);
      expect(name, "an export that reads Typst").not.toMatch(/[Tt]ypstTo/);
    }
    // What it DOES export in that direction, so the absence above is not simply
    // the absence of a Typst feature.
    expect(Object.keys(surface)).toContain("deckToTypst");
  });

  it("keeps no second representation on the document", () => {
    const deck = emptyDeck("x");
    expect(Object.keys(deck)).toEqual(["schema", "title", "theme", "slides"]);
    expect(deck.schema).toBe(DECK_MODEL_SCHEMA);
    for (const forbidden of ["typ", "typst", "rendered", "pdf", "svg", "compiled", "diagnostics"]) {
      expect(Object.keys(deck)).not.toContain(forbidden);
    }
  });

  it("keeps no second representation on a slide either", () => {
    for (const layout of ["title", "bullets", "two-column", "image-ref"] as const) {
      const keys = Object.keys(emptySlide("s1", layout));
      expect(keys[0], layout).toBe("id");
      expect(keys[1], layout).toBe("layout");
      for (const forbidden of ["typ", "typst", "rendered", "html", "preview"]) {
        expect(keys, layout).not.toContain(forbidden);
      }
    }
  });

  it("exports a surface with no lifecycle in it", () => {
    // No `create`, `open`, `start`, `close`, `subscribe`, `watch`: this is a
    // document schema, and anything that could be started would be a runtime
    // that a browser bundle and a Node release builder cannot both hold.
    for (const name of Object.keys(surface)) {
      expect(name, `${name} looks like a runtime`).not.toMatch(/^(create|open|start|stop|close|subscribe|watch|compile|render)/);
    }
  });
});
