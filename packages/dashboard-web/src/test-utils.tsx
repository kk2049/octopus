/**
 * Shared scaffolding for component tests.
 *
 * `renderPage` wraps a screen in the same providers the real app gives it, with
 * the shipped query defaults intact — a test that quietly used other retry or
 * refetch defaults would be testing a client the product does not ship.
 */

import type { ReactElement } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { render, type RenderResult } from "@testing-library/react";
import { createQueryClient } from "./lib/query.js";
import { DashboardUiProvider } from "./ui-kit/UiProvider.js";

export function renderPage(element: ReactElement, route = "/"): RenderResult {
  const client = createQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <DashboardUiProvider>
        <MemoryRouter initialEntries={[route]}>{element}</MemoryRouter>
      </DashboardUiProvider>
    </QueryClientProvider>,
  );
}

/** A `fetch` stub that answers a fixed route table and records what was asked. */
export function stubApi(routes: Record<string, unknown>): {
  calls: Array<{ url: string; init: RequestInit | undefined }>;
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const key = Object.keys(routes).find((path) => url.startsWith(path));
    if (!key) return new Response(JSON.stringify({ error: `no stub for ${url}` }), { status: 404 });
    return new Response(JSON.stringify(routes[key]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls };
}
