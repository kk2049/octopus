/**
 * P0-8: one gate in front of every unsafe method, not one per route.
 *
 * Only `/api/capabilities/pending/*` checked CSRF and Origin. Every other
 * mutation — theme preference, token mint, token delete, session append, admin grant,
 * deploy, land — accepted a plain cookie-authenticated POST from any page on
 * the internet. The cookie rides along on a cross-site form submit by design;
 * that is the whole of CSRF, and route-by-route discipline had already missed
 * eight routes.
 *
 * The rule this file pins down: a request carrying an AMBIENT credential (a
 * browser session cookie, a legacy cookie, or the unauthenticated loopback
 * mode) must present the CSRF secret and an exact Origin before it may change
 * anything. An explicit `Authorization: Bearer` is not ambient — a cross-site
 * page cannot set that header — so scripts keep working, and they are still
 * refused for approvals, which is a separate and stricter rule.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store/store.js";
import { DashboardServer } from "./server.js";
import { createDashboardTestServer } from "../e2e/dashboard-test-support.js";
import { dashboardCookies } from "./web-session.js";

/**
 * The names, from the same function the server uses. This panel has no
 * `public_url`, so it is the plain-http development contract — the `__Host-`
 * pair is pinned in `cookie-contract.test.ts` against an https deployment.
 */
const { session: SESSION_COOKIE, csrf: CSRF_COOKIE } = dashboardCookies(undefined).names;
import { hashRunnerToken } from "../runner/gateway.js";

const NOW = "2026-07-29T00:00:00.000Z";

let dir: string;
let store: Store;
let dash: DashboardServer;
let base: string;
let session = "";
let csrf = "";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "gate-"));
  store = new Store(join(dir, "t.db"));
  store.saveUser({ username: "alice", uid: 5001, home_dir: "/x/a", created_at: NOW });
  store.saveDashboardToken(hashRunnerToken("dt_alice"), "alice", NOW);
  dash = createDashboardTestServer(store, undefined, {
    port: 0,
    host: "127.0.0.1",
    authToken: "admin-key",
    adminUsers: [],
  });
  await dash.start();
  base = `http://127.0.0.1:${dash.port}`;

  const res = await fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ token: "dt_alice" }),
  });
  const cookies = res.headers.getSetCookie();
  session = /=([0-9a-f]{64})/.exec(cookies.find((c) => c.startsWith(SESSION_COOKIE))!)![1];
  csrf = /=([0-9a-f]{64})/.exec(cookies.find((c) => c.startsWith(CSRF_COOKIE))!)![1];
});

afterAll(async () => {
  await dash.stop();
  rmSync(dir, { recursive: true, force: true });
});

const cookieHeader = (): string => `${SESSION_COOKIE}=${session}; ${CSRF_COOKIE}=${csrf}`;

async function post(
  path: string,
  body: unknown,
  opts: { csrf?: string | null; origin?: string | null; cookie?: string | null; bearer?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.cookie !== null) headers.cookie = opts.cookie ?? cookieHeader();
  if (opts.csrf !== null) headers["x-csrf-token"] = opts.csrf ?? csrf;
  if (opts.origin !== null) headers.origin = opts.origin ?? base;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  return await fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

/**
 * One representative route per mutation family. They differ in what they do
 * and in who may do it; what they must NOT differ in is whether a cross-site
 * page can trigger them.
 */
const MUTATIONS: Array<{ path: string; body: unknown; what: string }> = [
  { path: "/api/theme-preference", body: { theme: "ink" }, what: "theme preference" },
  { path: "/api/runner-token", body: { username: "alice", device: "l1" }, what: "token mint" },
  { path: "/api/runner-delete", body: { username: "alice", device: "l1" }, what: "token delete" },
  { path: "/api/runner-local-agent-bridge", body: { username: "alice", device: "l1", mode: "manual" }, what: "Runner initiator policy" },
  { path: "/api/runner-default-agent-injection", body: { username: "alice", device: "l1", enabled: true }, what: "Runner Agent injection policy" },
  { path: "/api/runner-gui-automation", body: { username: "alice", device: "l1", enabled: true }, what: "Runner GUI automation policy" },
  { path: "/api/sessions/append", body: { username: "alice", device: "d", id: "s", prompt: "p" }, what: "session append" },
  {
    path: "/api/sessions/interaction",
    body: { username: "alice", device: "d", provider: "codex", session_id: "s", interaction_id: "ai_1", response_json: "{\"decision\":\"deny\",\"answers\":{}}" },
    what: "agent interaction response",
  },
  { path: "/api/admin/grant", body: { username: "alice", dev: true }, what: "admin grant" },
  { path: "/api/capabilities/pending/pc_x/approve", body: {}, what: "approval" },
];

describe("every unsafe method passes the same gate", () => {
  for (const m of MUTATIONS) {
    it(`${m.what}: a cross-site POST with the session cookie is refused`, async () => {
      const res = await post(m.path, m.body, { origin: "https://evil.example", csrf: null });
      expect(res.status).toBe(403);
      expect(String(((await res.json()) as { error?: string }).error)).toMatch(/CSRF|Origin/);
    });

    it(`${m.what}: the session cookie without the CSRF header is refused`, async () => {
      const res = await post(m.path, m.body, { csrf: null });
      expect(res.status).toBe(403);
    });

    it(`${m.what}: a wrong CSRF secret is refused`, async () => {
      const res = await post(m.path, m.body, { csrf: "0".repeat(64) });
      expect(res.status).toBe(403);
    });
  }

  it("a legitimate same-origin POST with both halves is NOT refused by the gate", async () => {
    // It may still fail on its own merits (403 for a missing right, 404, 503);
    // what it must not be is a CSRF refusal.
    const res = await post("/api/theme-preference", { theme: "aurora" });
    expect(res.status).toBe(200);
  });

  it("a script bearer needs no CSRF secret, because it is not an ambient credential", async () => {
    const res = await post(
      "/api/theme-preference",
      { theme: "classic" },
      { bearer: "dt_alice", cookie: null, csrf: null, origin: null },
    );
    expect(res.status).toBe(200);
  });

  it("a bearer still cannot approve — that needs a real person on a device", async () => {
    const res = await post(
      "/api/capabilities/pending/pc_x/approve",
      {},
      { bearer: "dt_alice", cookie: null, csrf: null, origin: null },
    );
    expect(res.status).toBe(403);
    expect(String(((await res.json()) as { error?: string }).error)).toMatch(/浏览器|Bearer|令牌/);
  });

  it("a cookie holding a raw bearer is not a credential at all any more", async () => {
    // It used to be a third channel, honoured for READS so that browsers logged
    // in before sessions existed would not be thrown out. That kindness was the
    // one thing keeping this gate from being expressible as a CSRF plugin's
    // configuration — so it is gone, and a session format change logs you out,
    // which is what every framework does.
    const legacy = `octopus_dash=dt_alice`;
    const read = await fetch(`${base}/api/sessions?username=alice`, { headers: { cookie: legacy } });
    expect(read.status).toBe(401);
    const write = await post("/api/theme-preference", { theme: "ink" }, {
      cookie: legacy,
      csrf: null,
    });
    expect(write.status).toBe(401);
    // The same token presented as a header still works: it is not ambient.
    const asHeader = await fetch(`${base}/api/sessions?username=alice`, {
      headers: { authorization: "Bearer dt_alice" },
    });
    expect(asHeader.status).toBe(200);
  });

  it("the Secure cookie flag comes from configuration, not from a request header", async () => {
    // `x-forwarded-proto` is sent by the caller. Trusting it means a plaintext
    // request can claim https and get a cookie the browser never sends back —
    // and that the flag vanishes whenever a real proxy omits the header,
    // leaving the session id in cleartext.
    const plain = await fetch(`${base}/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", origin: base, "x-forwarded-proto": "https" },
      body: JSON.stringify({ token: "dt_alice" }),
    });
    liveCookiesAreNotSecure(plain.headers.getSetCookie());

    const tlsDir = mkdtempSync(join(tmpdir(), "gate-tls-"));
    const tlsStore = new Store(join(tlsDir, "t.db"));
    tlsStore.saveUser({ username: "alice", uid: 5001, home_dir: "/x/a", created_at: NOW });
    tlsStore.saveDashboardToken(hashRunnerToken("dt_alice"), "alice", NOW);
    const tls = createDashboardTestServer(tlsStore, undefined, {
      port: 0,
      host: "127.0.0.1",
      authToken: "admin-key",
      adminUsers: [],
      publicUrl: "https://bot.example.com",
    });
    await tls.start();
    try {
      const res = await fetch(`http://127.0.0.1:${tls.port}/login`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/json", origin: "https://bot.example.com" },
        body: JSON.stringify({ token: "dt_alice" }),
      });
      expect(res.headers.getSetCookie().join(";")).toContain("Secure");
    } finally {
      await tls.stop();
      tlsStore.close();
      rmSync(tlsDir, { recursive: true, force: true });
    }
  });

  it("a credential in a query string is not accepted anywhere", async () => {
    // Every URL a token appears in is written down: browser history, the Referer
    // of the next request, the access log of each hop. Ops tooling already sends
    // `Authorization: Bearer`, so nothing needs the query form.
    expect((await fetch(`${base}/api/sessions?username=alice&token=dt_alice`)).status).toBe(401);
    expect((await fetch(`${base}/api/overview?token=admin-key`)).status).toBe(401);
    const write = await fetch(`${base}/api/theme-preference?token=dt_alice`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ theme: "ink" }),
    });
    expect(write.status).toBe(401);
  });

  it("a body that is not JSON is a 400, not a silent empty body", async () => {
    const res = await fetch(`${base}/api/theme-preference`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer dt_alice" },
      body: "{oops",
    });
    expect(res.status).toBe(400);
    expect(String(((await res.json()) as { error?: string }).error)).toContain("JSON");
  });

  /**
   * P2-6: an oversized body must not run the handler.
   *
   * `body()` used to answer 413 and then return `{}`, and every caller carried on
   * with all-default parameters — on `/api/deploy` that deployed the default
   * target while the caller was told the request had been refused. The signature
   * returns null now, so the compiler enumerated the twenty call sites and each
   * one bails. `/api/theme-preference` is the observable proof: 413, and the
   * stored preference is unchanged rather than overwritten.
   */
  it("an oversized body is refused AND the handler does not run", async () => {
    const before = store.getSetting("alice", "dashboard_theme");
    const res = await fetch(`${base}/api/theme-preference`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer dt_alice" },
      body: JSON.stringify({ theme: "x".repeat(2 * 1024 * 1024) }),
    });
    expect(res.status).toBe(413);
    expect(store.getSetting("alice", "dashboard_theme")).toBe(before);
  });

  it("GET is not gated: reads carry no side effect", async () => {
    const res = await fetch(`${base}/api/sessions?username=alice`, { headers: { cookie: cookieHeader() } });
    expect(res.status).toBe(200);
  });

  it("the devpipe per-turn transport is separate and is not affected", async () => {
    // No cookie, no CSRF, no Origin — a loopback MCP subprocess has none of
    // them. It is gated by its own per-turn token instead, which is the point
    // of keeping the two transports apart.
    const res = await fetch(`${base}/api/devpipe/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "not-a-real-turn-token" }),
    });
    expect([401, 403, 404, 503]).toContain(res.status);
    expect(String(((await res.json()) as { message?: string }).message ?? "")).not.toMatch(/CSRF|Origin/);
  });
});

/**
 * Assert the LIVE cookies of a plain-http deployment carry no `Secure`.
 *
 * Not "the response contains no Secure anywhere": since deletion obeys the
 * prefix too, the same response also RETIRES `__Host-…` names, and those
 * deletions must carry `Secure` or the browser ignores them. Asserting on the
 * whole blob would therefore be asserting that the retirement is broken.
 */
function liveCookiesAreNotSecure(setCookie: string[]): void {
  const live = setCookie.filter((c) => !c.includes("Max-Age=0"));
  expect(live.length, "a login should set the live pair").toBeGreaterThan(0);
  for (const c of live) expect(c, c).not.toContain("Secure");
  // …and the retired prefixed deletions are valid, i.e. they do carry it.
  for (const c of setCookie.filter((c) => c.startsWith("__Host-"))) {
    expect(c, c).toContain("Secure");
    expect(c, c).toContain("Max-Age=0");
  }
}
