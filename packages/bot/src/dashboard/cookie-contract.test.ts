/**
 * The production login cookies, as a browser would receive them.
 *
 * `packages/web-trust/src/cookies.test.ts` proves the rule; this proves the
 * panel actually issues it, accepts only it, and cleans up after the older
 * spelling. The reason all three matter separately:
 *
 *  · A `__Host-` cookie the panel emits but does not READ is a login that
 *    silently never sticks.
 *  · A retired name the panel still reads is the sibling-domain bypass the
 *    prefix exists to close — `app-<digest>.apps.example.org` (or any other host
 *    under the registrable site) could set `octopus_sess=…; Domain=example.org`
 *    and fix a session on the panel. The prefix stops the same trick against
 *    `__Host-octopus_sess`, and nothing stops it against a name we still trust.
 *  · A retired name left lying in the jar is that trick's ammunition, so login
 *    and logout both clear it.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store/store.js";
import { DashboardServer, mintDashboardToken } from "./server.js";
import { createDashboardTestServer } from "../e2e/dashboard-test-support.js";
import { dashboardCookies } from "./web-session.js";

const NOW = "2026-08-04T10:00:00.000Z";
const PANEL_URL = "https://bot.example.org";

let dir: string;
let store: Store;
/** The production shape: TLS terminates at a proxy, the panel is on loopback. */
let tls: DashboardServer;
/** The documented development shape: plain http, no public_url. */
let plain: DashboardServer;
let tlsBase = "";
let plainBase = "";
let key = "";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "cookie-"));
  store = new Store(join(dir, "t.db"));
  store.saveUser({ username: "alice", uid: 5001, home_dir: join(dir, "alice"), created_at: NOW });
  key = mintDashboardToken(store, "alice");
  const common = { port: 0, host: "127.0.0.1", authToken: "sekrit", adminUsers: [] as string[] };
  tls = createDashboardTestServer(store, undefined, { ...common, publicUrl: PANEL_URL });
  plain = createDashboardTestServer(store, undefined, { ...common });
  await tls.start();
  await plain.start();
  tlsBase = `http://127.0.0.1:${tls.port}`;
  plainBase = `http://127.0.0.1:${plain.port}`;
});

afterAll(async () => {
  await tls.stop();
  await plain.stop();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Log in. Origin must be the CONFIGURED one for the TLS panel — that is the
 * only origin it accepts, and it is not the address the request arrives on.
 */
async function login(base: string, origin: string, token = key): Promise<string[]> {
  const res = await fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ token }),
  });
  expect(res.status, "login should redirect").toBe(303);
  return res.headers.getSetCookie();
}

const named = (cookies: string[], name: string): string | undefined =>
  cookies.find((c) => c.startsWith(`${name}=`));

describe("the production contract", () => {
  it("issues __Host-octopus_sess and __Host-octopus_csrf with the required attributes", async () => {
    const cookies = await login(tlsBase, PANEL_URL);
    const sess = named(cookies, "__Host-octopus_sess");
    const csrf = named(cookies, "__Host-octopus_csrf");
    expect(sess, "the session cookie").toBeTruthy();
    expect(csrf, "the CSRF cookie").toBeTruthy();

    expect(sess).toMatch(/^__Host-octopus_sess=[0-9a-f]{64};/);
    expect(sess).toContain("HttpOnly");
    expect(sess).toContain("Path=/");
    expect(sess).toContain("Secure");
    expect(sess).toContain("SameSite=Lax");

    // Deliberately readable: page JS echoes it into a header, which is what
    // makes a cross-site POST fail even though the cookie rides along.
    expect(csrf).toMatch(/^__Host-octopus_csrf=[0-9a-f]{64};/);
    expect(csrf).not.toContain("HttpOnly");
    expect(csrf).toContain("Secure");
  });

  it("never carries a Domain — that is the whole point of the prefix", async () => {
    const cookies = await login(tlsBase, PANEL_URL);
    for (const c of cookies) expect(c, c).not.toMatch(/;\s*Domain=/i);
  });

  it("accepts the prefixed name and nothing else", async () => {
    const cookies = await login(tlsBase, PANEL_URL);
    const id = /__Host-octopus_sess=([0-9a-f]{64})/.exec(cookies.join("\n"))![1];

    const good = await fetch(`${tlsBase}/api/overview`, { headers: { cookie: `__Host-octopus_sess=${id}` } });
    expect(good.status).toBe(200);

    // The same secret under the old name is not a credential. If it were, a
    // sibling host could set that name with a Domain and be believed.
    const old = await fetch(`${tlsBase}/api/overview`, { headers: { cookie: `octopus_sess=${id}` } });
    expect(old.status).toBe(401);
  });

  it("clears every retired name on login and on logout", async () => {
    const cookies = await login(tlsBase, PANEL_URL);
    for (const dead of ["octopus_sess", "octopus_csrf", "octopus_dash"]) {
      const cleared = named(cookies, dead);
      expect(cleared, `login should clear ${dead}`).toBeTruthy();
      expect(cleared).toContain("Max-Age=0");
    }

    const id = /__Host-octopus_sess=([0-9a-f]{64})/.exec(cookies.join("\n"))![1];
    const csrf = /__Host-octopus_csrf=([0-9a-f]{64})/.exec(cookies.join("\n"))![1];
    const out = await fetch(`${tlsBase}/logout`, {
      method: "POST",
      headers: { cookie: `__Host-octopus_sess=${id}`, "x-csrf-token": csrf, origin: PANEL_URL },
    });
    expect(out.status).toBe(200);
    const cleared = out.headers.getSetCookie();
    for (const name of ["__Host-octopus_sess", "__Host-octopus_csrf", "octopus_sess", "octopus_csrf", "octopus_dash"]) {
      const c = named(cleared, name);
      expect(c, `logout should clear ${name}`).toBeTruthy();
      expect(c).toContain("Max-Age=0");
    }
  });

  it("stops writing the shared key into a cookie nothing reads", async () => {
    // The admin key has no account, so it gets no session. It used to receive
    // `octopus_dash=<the raw bearer>`, which `identify()` has never read back:
    // a long-lived credential stored in the browser for nothing.
    const cookies = await login(tlsBase, PANEL_URL, "sekrit");
    expect(cookies.join("\n")).not.toContain("sekrit");
    const dash = named(cookies, "octopus_dash");
    expect(dash).toContain("Max-Age=0");
  });
});

describe("the documented development contract", () => {
  it("uses the unprefixed pair on plain http, because __Host- would be refused", async () => {
    // `__Host-` requires Secure, and a Secure cookie on http never comes back —
    // the browser would drop the login entirely. A different deployment, not a
    // weakened version of the production one.
    const cookies = await login(plainBase, plainBase);
    expect(named(cookies, "octopus_sess")).toMatch(/^octopus_sess=[0-9a-f]{64};/);
    expect(named(cookies, "octopus_sess")).not.toContain("Secure");
    expect(named(cookies, "__Host-octopus_sess")).toContain("Max-Age=0");
    expect(cookies.join("\n")).not.toMatch(/;\s*Domain=/i);
  });

  it("agrees with the contract function both surfaces read", () => {
    expect(dashboardCookies(PANEL_URL).names).toEqual({
      session: "__Host-octopus_sess",
      csrf: "__Host-octopus_csrf",
    });
    expect(dashboardCookies(undefined).names).toEqual({ session: "octopus_sess", csrf: "octopus_csrf" });
    expect(dashboardCookies("http://bot.example").hostPrefixed).toBe(false);
  });
});
