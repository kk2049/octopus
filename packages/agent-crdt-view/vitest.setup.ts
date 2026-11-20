/**
 * Test environment for the collaborative-note module.
 *
 * `fetch` throws unless a test stubbed it. This module is compiled into
 * untrusted, `connect-src 'none'` bundles, so a network call from one could only
 * ever be a bug or an exfiltration attempt — and jsdom's default is to do
 * nothing silently. It matters more here than anywhere else in the repository:
 * the ecosystem's Yjs providers (`y-websocket`, Hocuspocus) all open their own
 * socket, so a copy-pasted example would be caught here rather than at review.
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
  vi.stubGlobal(
    "WebSocket",
    class {
      constructor(url: string) {
        throw new Error(`unexpected WebSocket to ${url}`);
      }
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

configure({ asyncUtilTimeout: 5000 });
