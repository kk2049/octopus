/**
 * `adoptDocumentStyles`, the repair for what a published document refuses.
 *
 * The property that actually matters — that the browser APPLIES an adopted
 * sheet under `style-src 'sha256-…'`, where it refuses the same rules as a
 * `<style>` element — is a browser fact and is measured in
 * `packages/bot/src/session-plus/browser.e2e.test.ts`. What is worth pinning
 * here is the contract this module owes its callers: adopt once, never throw,
 * and answer honestly on a platform that cannot do it.
 */

import { afterEach, describe, expect, it } from "vitest";
import { adoptDocumentStyles, resetAdoptedDocumentStylesForTests } from "./nonce.js";

const supported = typeof CSSStyleSheet === "function" && Array.isArray(document.adoptedStyleSheets);

afterEach(() => {
  resetAdoptedDocumentStylesForTests();
  if (supported) document.adoptedStyleSheets = [];
});

describe("adoptDocumentStyles", () => {
  it("refuses an empty sheet rather than adopting nothing", () => {
    expect(adoptDocumentStyles("")).toBe(false);
    if (supported) expect(document.adoptedStyleSheets.length).toBe(0);
  });

  it("adopts one distinct text once, however many surfaces ask", () => {
    const css = ".cm-scroller { display: flex; }";
    const first = adoptDocumentStyles(css);
    const second = adoptDocumentStyles(css);
    expect(first).toBe(supported);
    expect(second).toBe(supported);
    // A second EditorView mounting the same generated rules must not stack a
    // second copy on the document for the life of the tab.
    if (supported) expect(document.adoptedStyleSheets.length).toBe(1);
  });

  it("keeps different generated rules apart", () => {
    expect(adoptDocumentStyles(".a{color:red}")).toBe(supported);
    expect(adoptDocumentStyles(".b{color:blue}")).toBe(supported);
    if (supported) expect(document.adoptedStyleSheets.length).toBe(2);
  });

  it("answers false instead of throwing when the rules cannot be parsed away", () => {
    // Never an exception: this runs inside the editor's mount effect, and a
    // throw there would take out the panel rather than lose some styling.
    expect(() => adoptDocumentStyles("@@@ not css {{{")).not.toThrow();
  });
});
