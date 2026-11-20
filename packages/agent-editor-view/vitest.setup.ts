/**
 * Test environment for the editor module.
 *
 * Two things beyond the shared shape:
 *
 *  · `fetch` throws unless a test stubbed it. This module is compiled into an
 *    untrusted, `connect-src 'none'` bundle, so a network call from it could
 *    only ever be a bug or an exfiltration attempt — and jsdom's default is to
 *    do nothing silently.
 *  · jsdom has no layout engine, so CodeMirror's measuring path finds no
 *    `Range.getClientRects` and no `ResizeObserver`. Both are supplied as inert
 *    stubs: they let the editor mount and dispatch transactions (which is what
 *    these tests are about — the document, the caret line, the read-only
 *    reconfiguration), and they measure nothing, which is honest. Anything that
 *    depends on real geometry — scroll position, the gutter's rendered width —
 *    belongs in the browser suite and is not asserted here.
 */

import "@testing-library/jest-dom/vitest";
import "../agent-view-react/vitest.dom.js";
import { afterEach, beforeEach, vi } from "vitest";
import { cleanup, configure } from "@testing-library/react";

if (typeof Range !== "undefined" && typeof Range.prototype.getClientRects !== "function") {
  Range.prototype.getClientRects = () => ({
    length: 0,
    item: () => null,
    [Symbol.iterator]: function* () {},
  }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => ({
    x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0,
    toJSON: () => ({}),
  }) as DOMRect;
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      throw new Error(`unexpected network call to ${String(input)}`);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

configure({ asyncUtilTimeout: 5000 });
