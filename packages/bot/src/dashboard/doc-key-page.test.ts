/**
 * A Feishu document's claim page (`/doc-key#i=dsi_…`) is a public screen of
 * the Dashboard bundle, served like `/login` and `/share`: before the identity
 * gate, to a browser with no session, carrying nothing. The link's secret
 * never reaches the server in this request (it is in the fragment); the page
 * sends it to the docs add-on's same-origin claim calls, tested with their
 * route (`feishu-doc-share-route.test.ts`).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDashboardTestServer } from "../e2e/dashboard-test-support.js";
import { DOC_KEY_PATH } from "../feishu/doc-share.js";
import { Store } from "../store/store.js";
import { readBootstrapPayload } from "./app-page.js";
import type { DashboardServer } from "./server.js";

describe("the document claim page", () => {
  let dir: string;
  let store: Store;
  let dash: DashboardServer;
  let base: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "doc-key-page-"));
    store = new Store(join(dir, "t.db"));
    // The narrower composition: the page must be on the v3 surface's allowlist too.
    dash = createDashboardTestServer(store, undefined, { port: 0, host: "127.0.0.1", authToken: "admin-key", surface: "bootstrap-v3" });
    await dash.start();
    base = `http://127.0.0.1:${dash.port}`;
  });

  afterAll(async () => {
    await dash?.stop();
    store?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("is served to a browser with no session, as the bundle's own screen, with the panel's script policy", async () => {
    const res = await fetch(`${base}${DOC_KEY_PATH}`, { redirect: "manual", headers: { accept: "text/html", "sec-fetch-mode": "navigate" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("set-cookie")).toBeNull();
    const script = (res.headers.get("content-security-policy") ?? "").split(";").map((part) => part.trim()).find((part) => part.startsWith("script-src"));
    expect(script).toMatch(/^script-src 'self'/);
    expect(script).not.toMatch(/unsafe-inline|unsafe-eval/);
    const html = await res.text();
    expect(readBootstrapPayload(html)).toMatchObject({ page: "pre.docShareKey", viewer: { username: null }, pageProps: {} });
    // One module from /ui/, data blocks, nothing executable inline.
    expect([...html.matchAll(/<script(?![^>]*type="(?:application\/json|importmap)")[^>]*>/g)].every((tag) => /src="\/ui\//.test(tag[0]))).toBe(true);
  });

  it("is a page only: nothing is written there, and nothing beside it is a page", async () => {
    const post = await fetch(`${base}${DOC_KEY_PATH}`, { method: "POST", redirect: "manual", headers: { origin: base, "content-type": "application/json" }, body: "{}" });
    expect(post.status).not.toBe(200);
    for (const path of [`${DOC_KEY_PATH}/x`, `${DOC_KEY_PATH}x`]) {
      expect((await fetch(`${base}${path}`, { redirect: "manual" })).status, path).not.toBe(200);
    }
  });
});
