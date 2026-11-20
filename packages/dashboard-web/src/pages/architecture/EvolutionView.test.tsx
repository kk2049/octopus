import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderPage } from "../../test-utils.js";
import { EvolutionView } from "./EvolutionView.js";
import { nextCommitsCursor } from "./evolution.js";

const HEAD = "f".repeat(40);
const sha = (index: number) => index.toString(16).padStart(40, "0");
const commit = (index: number) => ({ sha: sha(index), date: "2026-10-01T00:00:00Z", author: "a", subject: `c${index}` });
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("commit axis windows", () => {
  it("continues from the anchored head only while the server says history continues", () => {
    expect(nextCommitsCursor({ commits: [], truncated: true, head: HEAD, next_offset: 200 })).toEqual({ head: HEAD, offset: 200 });
    expect(nextCommitsCursor({ commits: [], truncated: false, head: HEAD })).toBeNull();
    // An older server without a cursor keeps the honest "not loaded" note instead.
    expect(nextCommitsCursor({ commits: [], truncated: true })).toBeNull();
  });

  it("appends an older window on the explicit button and stops at the root commit", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      const body = url.startsWith("/api/architecture/commits")
        ? new URL(url, "http://x").searchParams.has("head")
          ? { commits: [201, 202, 203].map((index) => commit(index)), truncated: false, head: HEAD }
          : { commits: Array.from({ length: 200 }, (_, index) => commit(index + 1)), truncated: true, head: HEAD, next_offset: 200 }
        : url.startsWith("/api/architecture/snapshots")
        ? { snapshots: [] }
        : { error: "not stubbed" };
      return new Response(JSON.stringify(body), { status: body && "error" in body ? 404 : 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    renderPage(<EvolutionView />);
    await screen.findByText(/最近\s*200\s*个提交/);
    expect(screen.queryByText(/更早的历史未载入/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "载入更早的历史" }));
    await screen.findByText(/最近\s*203\s*个提交/);
    const older = urls.find((url) => url.includes("head="));
    expect(older).toBeDefined();
    const params = new URL(older!, "http://x").searchParams;
    expect(params.get("head")).toBe(HEAD);
    expect(params.get("offset")).toBe("200");
    expect(params.get("limit")).toBe("500");
    await waitFor(() => expect(screen.queryByRole("button", { name: "载入更早的历史" })).toBeNull());
    expect(urls.filter((url) => url.startsWith("/api/architecture/commits"))).toHaveLength(2);
  });
});
