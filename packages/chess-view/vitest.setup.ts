/**
 * Test environment for the untrusted 国际象棋 View.
 *
 * `fetch` throws unless a test stubbed it — in this runtime `connect-src
 * 'none'` means any call could only be a bug or an exfiltration attempt.
 * Everything here is inert under the node environment too (the shim guards
 * itself, `cleanup` has nothing mounted), which is what lets
 * `src/pack.test.ts` share this project with a `@vitest-environment node`
 * pragma.
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
