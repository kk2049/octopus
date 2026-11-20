import "@testing-library/jest-dom/vitest";
import "../agent-view-react/vitest.dom.js";
import { afterEach, beforeEach, vi } from "vitest";
import { cleanup, configure } from "@testing-library/react";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    throw new Error(`unexpected network call to ${String(input)}`);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
configure({ asyncUtilTimeout: 5000 });
