/**
 * Test environment for the reusable sessions modules.
 *
 * `fetch` throws unless a test stubbed it. These modules are compiled into
 * untrusted, `connect-src 'none'` bundles, so a network call from one could only
 * ever be a bug or an exfiltration attempt — and jsdom's default is to do
 * nothing silently.
 */

import "@testing-library/jest-dom/vitest";
import "../agent-view-react/vitest.dom.js";
import { afterEach, beforeEach, vi } from "vitest";
import { cleanup, configure } from "@testing-library/react";

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
