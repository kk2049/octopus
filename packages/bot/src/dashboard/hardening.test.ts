import { appPageScriptCsp } from "./app-page.js";
/**
 * Web-tier hardening the first pass left soft.
 *
 * The Origin check trusted the request's own Host header, which is worth
 * nothing behind a proxy that forwards whatever a client sent; a session row
 * with an unparseable timestamp compared NaN and sailed through every expiry
 * test; the login credential travelled in a query string, so it landed in
 * history, referrers and every access log; and the response headers a browser
 * needs to refuse framing and sniffing were absent.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store/store.js";
import { DashboardServer, mintDashboardToken } from "./server.js";
import { createDashboardTestServer } from "../e2e/dashboard-test-support.js";
import { allowedOrigins, originOk } from "@claude-bot/web-trust";
import { WebSessionManager } from "./web-session.js";

const NOW = "2026-07-29T00:00:00.000Z";

let dir: string;
let store: Store;
let dash: DashboardServer;
let base: string;
let dt: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "hard-"));
  store = new Store(join(dir, "t.db"));
  store.saveUser({ username: "alice", uid: 5001, home_dir: "/x/a", created_at: NOW });
  dt = mintDashboardToken(store, "alice");
  dash = createDashboardTestServer(store, undefined, { port: 0, host: "127.0.0.1", authToken: "admin-secret" });
  await dash.start();
  base = `http://127.0.0.1:${dash.port}`;
});

afterAll(async () => {
  await dash.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("session timestamps fail closed", () => {
  it("an unparseable expiry is not a valid session", () => {
    const rows = new Map<string, Record<string, unknown>>();
    const fake = {
      createWebSession: (r: Record<string, unknown>) => rows.set(String(r.token_hash), r),
      getWebSession: (h: string) => rows.get(h),
      touchWebSession: () => {},
      revokeWebSession: () => {},
      pruneWebSessions: () => 0,
    } as never;
    const mgr = new WebSessionManager(fake);
    const s = mgr.issue("alice");
    expect(mgr.resolve(s.sessionId)).not.toBeNull();

    // Corrupt each timestamp in turn: every one must fail closed, not compare
    // NaN and pass.
    for (const field of ["absolute_expiry", "last_seen_at", "created_at"]) {
      const row = [...rows.values()][0] as Record<string, unknown>;
      const good = row[field];
      row[field] = "not-a-date";
      expect(mgr.resolve(s.sessionId), `field ${field}`).toBeNull();
      row[field] = good;
    }
    expect(mgr.resolve(s.sessionId)).not.toBeNull();
  });
});

describe("canonical origin", () => {
  // The allowlist is computed once at startup; a request contributes only its
  // Origin header. `originOk` has no parameter through which `Host` or
  // `x-forwarded-proto` could arrive, which is stronger than ignoring them.
  const CONFIGURED = allowedOrigins({ publicUrl: "https://panel.example.com" });
  const LOOPBACK = allowedOrigins({ loopbackPort: 9820 });

  it("never trusts the request's own Host when a public URL is configured", () => {
    expect(originOk("https://panel.example.com", CONFIGURED)).toBe(true);
    // The classic proxy trick — attacker controls Host, sets Origin to match —
    // has nowhere to land: Host is not an input.
    expect(originOk("https://evil.test", CONFIGURED)).toBe(false);
    expect(originOk("http://panel.example.com", CONFIGURED)).toBe(false);
  });

  it("without a configured public URL only the bound loopback port is accepted", () => {
    expect(originOk("http://127.0.0.1:9820", LOOPBACK)).toBe(true);
    expect(originOk("http://localhost:9820", LOOPBACK)).toBe(true);
    // Another local service on a different port is a different origin.
    expect(originOk("http://127.0.0.1:9821", LOOPBACK)).toBe(false);
    // A real hostname with no configured canonical origin is refused: there is
    // nothing trustworthy to compare against.
    expect(originOk("https://panel.example.com", LOOPBACK)).toBe(false);
  });

  it("takes two arguments, and the second one is not from the request", () => {
    expect(originOk.length).toBe(2);
  });

  it("a missing Origin is refused", () => {
    expect(originOk(undefined, LOOPBACK)).toBe(false);
  });
});

describe("login does not put a credential in a URL", () => {
  it("a token in the query string is refused; a POSTed one-time exchange works", async () => {
    const viaQuery = await fetch(`${base}/login?token=${dt}`, { redirect: "manual" });
    expect(viaQuery.status).toBe(400);
    expect(viaQuery.headers.get("set-cookie")).toBeNull();

    // The supported flow: GET /login renders a form, POST exchanges once.
    const form = await fetch(`${base}/login`);
    expect(form.status).toBe(200);
    const posted = await fetch(`${base}/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ token: dt }),
    });
    expect(posted.status).toBe(303);
    const cookie = posted.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/octopus_sess=[0-9a-f]{64}; HttpOnly/);
    expect(cookie).not.toContain(dt);
    // And the redirect target carries no credential either.
    expect(posted.headers.get("location")).not.toContain(dt);
  });
});

describe("response headers", () => {
  it("HTML responses deny framing, sniffing and referrer leakage", async () => {
    const res = await fetch(`${base}/login`);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("permissions-policy")).toMatch(/camera=\(\)/);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    // No nonce, because there is no inline executable script to admit: the
    // document ships one module from /ui/ and inert JSON data blocks. The
    // assertion is on the SCRIPT directive specifically — `style-src` keeps its
    // long-standing `unsafe-inline`, which React's `style` attributes need and
    // which cannot execute code.
    const scriptSrc = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src"));
    expect(scriptSrc).toBe(appPageScriptCsp());
    expect(csp).toContain("img-src 'self' data: blob:");
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("media-src");
    const html = await res.text();
    expect(html).toContain('<script type="module" src="/ui/');
    expect(html).not.toContain("onclick=");
  });

  it("the approval page is not framable and runs no inline script at all", async () => {
    const res = await fetch(`${base}/pending`, { headers: { authorization: `Bearer ${dt}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("script-src 'self'");
    const html = await res.text();
    // The approval surface is the one place where a script the operator did not
    // ship could turn a real human click into an approval of somebody else's
    // dangerous call. Every script element here is a module from the published
    // bundle, inert JSON data or the exact CSP-authorized module import map.
    for (const tag of html.match(/<script\b[^>]*>/g) ?? []) {
      expect(tag.includes('src="/ui/') || tag.includes('type="application/json"') || tag.includes('type="importmap"'), tag).toBe(true);
    }
  });
});

describe("request bodies are bounded before buffering", () => {
  it("an oversized body is refused without being read into memory", async () => {
    const big = "x".repeat(3 * 1024 * 1024);
    const res = await fetch(`${base}/api/theme-preference`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${dt}` },
      body: JSON.stringify({ theme: big }),
    });
    expect(res.status).toBe(413);
    // The answer arrives WITHOUT the body ever being buffered: the cap fires
    // on the declared length, and the rest is discarded rather than collected.
    expect(((await res.json()) as { error: string }).error).toContain("过大");
  });
});

/**
 * The two namespaces, and the fact that neither falls back to the other.
 *
 * A single-page app usually arrives with a wildcard "serve index.html for
 * anything unmatched" rule, and that rule is how a 403 becomes a 200 with a
 * rendered screen. This panel has no such rule: `/ui/` serves the built bundle,
 * the route table serves everything else, and an unlisted path is a 404 — the
 * same answer it has always been.
 */
describe("the bundle namespace does not become a fallback", () => {
  it("serves the built bundle before the identity gate — the login page is in it", async () => {
    const page = await fetch(`${base}/login`);
    const html = await page.text();
    const src = /<script type="module" src="([^"]+)"><\/script>/.exec(html)?.[1];
    expect(src, "the login page references a module from /ui/").toMatch(/^\/ui\/a\//);
    // …and its stylesheet, from the REAL manifest. This is not decoration: the
    // first version read only the entry chunk's `css`, which is empty under
    // `cssCodeSplit: false`, so the panel shipped with every layout rule absent
    // while its JavaScript worked perfectly.
    const href = /<link rel="stylesheet" href="([^"]+)">/.exec(html)?.[1];
    expect(href, "the page links a stylesheet").toMatch(/^\/ui\/a\/.*\.css$/);
    const sheet = await fetch(base + href!);
    expect(sheet.status).toBe(200);
    expect(sheet.headers.get("content-type")).toContain("text/css");
    const asset = await fetch(base + src!);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("javascript");
    // Content-addressed, so a year-long cache can never serve stale bytes for a
    // name that means something else — and an already-loaded tab never has to
    // fetch a second file after a deploy.
    expect(asset.headers.get("cache-control")).toContain("immutable");
  });

  it("does not serve the app for an unknown path — a 404 stays a 404", async () => {
    const res = await fetch(`${base}/definitely-not-a-page`, {
      headers: { authorization: `Bearer ${dt}` },
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("does not serve the app under /api — an unknown API path is JSON, not HTML", async () => {
    const res = await fetch(`${base}/api/not-a-real-endpoint`, {
      headers: { authorization: `Bearer ${dt}` },
    });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("<!doctype html>");
  });

  it("404s a missing asset instead of falling through to the app", async () => {
    const res = await fetch(`${base}/ui/a/does-not-exist.js`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("<!doctype html>");
  });

  it("refuses a write to the bundle namespace", async () => {
    const res = await fetch(`${base}/ui/a/anything.js`, { method: "POST" });
    expect(res.status).toBe(405);
  });

  it("reports the running build id, so an open tab can notice a deploy", async () => {
    const res = await fetch(`${base}/login`);
    const id = res.headers.get("x-octopus-build");
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    // The document says the same thing, so the tab has something to compare to.
    expect(await res.text()).toContain(id!);
  });
});
