/**
 * Test environment for the board module. `fetch` throws unless a test stubbed
 * it: this code compiles into untrusted, `connect-src 'none'` bundles, so a
 * network call could only be a bug or an exfiltration attempt.
 */

import "@testing-library/jest-dom/vitest";
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
