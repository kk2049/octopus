import "@testing-library/jest-dom/vitest";
import "../agent-view-react/vitest.dom.js";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("unexpected network call"); })));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
