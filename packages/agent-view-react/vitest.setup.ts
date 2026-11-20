/**
 * Test environment for the untrusted Agent View SDK.
 *
 * One job, and it is the same one the trusted bundle's setup has for the
 * opposite reason: **an un-stubbed network call is a failure**. In the panel
 * that catches a component quietly fetching in an effect. Here it catches
 * something worse — SDK code that reaches for the network at all, in a runtime
 * where `connect-src 'none'` means the call could only ever be a bug or an
 * exfiltration attempt. jsdom's default is to do nothing silently.
 */

import "@testing-library/jest-dom/vitest";
import "./vitest.dom.js";
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
  // Explicit rather than implicit: React Testing Library only auto-cleans when
  // the runner exposes globals, and this project does not.
  cleanup();
  vi.unstubAllGlobals();
});

configure({ asyncUtilTimeout: 5000 });
