/**
 * Browser-test environment.
 *
 * Two jobs, and both are about making the tests honest rather than convenient:
 *
 *  1. **Install the bootstrap payload before any module loads.** `lib/bootstrap`
 *     reads it at import time — deliberately, because the real document always
 *     has it — so a test that imported a page first would get a thrown error
 *     rather than a screen. `setBootstrap()` lets a test say who is asking.
 *  2. **Fail on a real network call.** `fetch` is replaced with a function that
 *     throws unless a test stubbed it. A component that quietly reaches the
 *     network in an effect is exactly the defect these tests exist to catch, and
 *     jsdom's default is to silently do nothing.
 */

import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, vi } from "vitest";
import { cleanup, configure } from "@testing-library/react";
import { BOOTSTRAP_ELEMENT_ID } from "./src/contract.js";

/** A minimal, plausible bootstrap. Individual tests override what they care about. */
export const DEFAULT_BOOTSTRAP = {
  buildId: "testbuild",
  surface: "full",
  features: [],
  viewer: { username: "alice", admin: false, dev: false, deploy: false, session: true },
  nav: [{ id: "page.sessionsPlus", path: "/sessions-plus", label: "📜 会话" }],
  pages: ["page.sessionsPlus"],
  redirects: {},
  approvals: true,
  csrfCookieNames: ["octopus_csrf"],
  themePreference: null,
  page: "page.sessionsPlus",
  pageProps: {},
};

export function setBootstrap(patch: Record<string, unknown> = {}): void {
  const node = document.createElement("script");
  node.type = "application/json";
  node.id = BOOTSTRAP_ELEMENT_ID;
  node.textContent = JSON.stringify({ ...DEFAULT_BOOTSTRAP, ...patch });
  document.head.appendChild(node);
}

// Installed before the first module evaluates so `lib/bootstrap` finds it.
setBootstrap();

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      throw new Error(`unexpected network call to ${String(input)}`);
    }),
  );
  // jsdom has no EventSource; a test that needs one installs a fake.
  if (!("EventSource" in globalThis)) {
    vi.stubGlobal("EventSource", class {
      close(): void {}
      addEventListener(): void {}
      removeEventListener(): void {}
    });
  }
  // Ant Select observes its popup trigger. Browsers provide this; jsdom does
  // not, so tests install only the platform-shaped no-op (not an Ant mock).
  if (!("ResizeObserver" in globalThis)) {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
  }
});

afterEach(async () => {
  // Explicit rather than implicit: React Testing Library only auto-cleans when
  // the runner exposes globals, and this project does not. Without it a second
  // `render()` in the same file finds the first one still in the document.
  cleanup();
  // Draft coordinators intentionally outlive component unmounts in a real
  // document. Tests are separate documents, so drop that module-global state
  // and browser storage between cases or one page test can hydrate another.
  const [{ resetBrowserDraftCoordinatorsForTests }, { resetBrowserDraftStoresForTests }] = await Promise.all([
    import("./src/lib/browser-drafts-react.js"),
    import("./src/lib/browser-drafts.js"),
  ]);
  resetBrowserDraftCoordinatorsForTests();
  resetBrowserDraftStoresForTests();
  localStorage.clear();
  vi.unstubAllGlobals();
});

// Same reason as `testTimeout` in `vitest.config.ts`: a slow box must not look
// like a broken component.
configure({ asyncUtilTimeout: 5000 });
