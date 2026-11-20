/// <reference lib="dom" />
/**
 * The production cookie contract, exercised by a real browser over real TLS.
 *
 * ── The bug this exists to catch ────────────────────────────────────────────
 *
 * The server moved its login cookies to `__Host-octopus_sess` /
 * `__Host-octopus_csrf`; the page script that echoes the CSRF secret into a
 * header kept looking for `octopus_csrf`. Every unit test still passed — the
 * server was right, the client was right about a name that no longer existed —
 * and the only symptom would have been every mutation on the production panel
 * answering 403, including logout. Nothing short of a browser on an https page
 * can see that, because the whole failure lives in the interaction between the
 * `Secure` attribute, the prefix, and what `document.cookie` therefore contains.
 *
 * So this test runs the panel behind a self-signed TLS terminator, logs in as a
 * person would, plants a DECOY cookie under the retired name, and asserts on the
 * header the browser actually sent.
 *
 * Skips (loudly) when Chromium or openssl is missing; it is never downgraded to
 * a string assertion, because a string assertion is exactly what passed while
 * this was broken.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createHttpServer, request as httpRequest, type Server } from "node:http";
import { createServer as createTlsServer, type Server as TlsServer } from "node:https";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { Store } from "../store/store.js";
import { DashboardServer, mintDashboardToken } from "./server.js";
import { createDashboardTestServer } from "../e2e/dashboard-test-support.js";
import { dashboardCookies } from "./web-session.js";

function toolsAvailable(): { ok: boolean; why: string } {
  try {
    if (!existsSync(chromium.executablePath())) return { ok: false, why: "Chromium is not installed" };
  } catch {
    return { ok: false, why: "Chromium is not installed" };
  }
  try {
    execFileSync("openssl", ["version"], { stdio: "pipe" });
  } catch {
    return { ok: false, why: "openssl is not available to mint a test certificate" };
  }
  return { ok: true, why: "" };
}

const TOOLS = toolsAvailable();
if (!TOOLS.ok) {
  console.warn(
    `[dashboard] the HTTPS CSRF browser test is skipped: ${TOOLS.why}.\n`
      + "  Unverified while skipped: that a production (https) page sends the __Host- CSRF\n"
      + "  cookie's value in x-csrf-token, and that a decoy under the retired name is ignored.",
  );
}

const NOW = "2026-08-04T10:00:00.000Z";

// Real Chromium over a local TLS proxy shares a full-suite shard with the
// other browser harnesses; the Node project's 20 s unit-test budget is not a
// product latency contract. Playwright's narrower waits still fail first.
vi.setConfig({ testTimeout: 60_000 });

let dir: string;
let store: Store;
let dash: DashboardServer;
let tls: TlsServer;
let browser: Browser;
let page: Page;
let publicUrl = "";
let token = "";

/** A port nothing is listening on yet. */
async function freePort(): Promise<number> {
  const s: Server = createHttpServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

describe.skipIf(!TOOLS.ok)("the CSRF cookie name on a production-shaped page", () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "csrf-tls-"));
    const key = join(dir, "k.pem");
    const cert = join(dir, "c.pem");
    // A self-signed leaf for `localhost`. Playwright is told to ignore the
    // chain; what matters is that the BROWSER is on https, because that is what
    // makes `Secure` cookies (and therefore `__Host-`) work at all.
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", key, "-out", cert, "-days", "2",
      "-subj", "/CN=localhost",
      "-addext", "subjectAltName=DNS:localhost",
    ], { stdio: "pipe" });

    store = new Store(join(dir, "t.db"));
    store.saveUser({ username: "alice", uid: 5001, home_dir: join(dir, "alice"), created_at: NOW });
    token = mintDashboardToken(store, "alice");

    const tlsPort = await freePort();
    publicUrl = `https://localhost:${tlsPort}`;
    dash = createDashboardTestServer(store, undefined, {
      port: 0,
      host: "127.0.0.1",
      authToken: "sekrit",
      adminUsers: [],
      surface: "bootstrap-v3",
      sessionHubUi: "unified-v3",
      // The one input that decides Secure, the cookie NAMES and the allowed
      // Origin — all three at once, which is the point of the contract.
      publicUrl,
    });
    await dash.start();

    // A terminator, not a rewriter: the panel sees plain http on loopback and
    // decides everything from `public_url`, exactly as the documented Caddy
    // deployment does.
    tls = createTlsServer(
      { key: readFileSync(key), cert: readFileSync(cert) },
      (req, res) => {
        const up = httpRequest(
          { host: "127.0.0.1", port: dash.port, path: req.url, method: req.method, headers: req.headers },
          (upRes) => {
            res.writeHead(upRes.statusCode ?? 502, upRes.headers);
            upRes.pipe(res);
          },
        );
        up.on("error", () => {
          res.writeHead(502);
          res.end("upstream");
        });
        req.pipe(up);
      },
    );
    await new Promise<void>((r) => tls.listen(tlsPort, "127.0.0.1", () => r()));

    browser = await chromium.launch();
    page = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => tls?.close(() => r()));
    await dash?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("issues __Host- cookies to the browser and reads them back", async () => {
    await page.goto(`${publicUrl}/login`);
    await page.fill('input[type="password"]', token);
    await page.click('button[type="submit"]');
    await page.waitForURL(`${publicUrl}/`);

    const jar = await page.context().cookies(publicUrl);
    const names = jar.map((c) => c.name);
    expect(names).toContain("__Host-octopus_sess");
    expect(names).toContain("__Host-octopus_csrf");
    // The browser only stores a `__Host-` cookie when the attributes are right,
    // so its presence here IS the attribute assertion.
    const sess = jar.find((c) => c.name === "__Host-octopus_sess")!;
    expect(sess.secure).toBe(true);
    expect(sess.httpOnly).toBe(true);
    expect(sess.path).toBe("/");
    const csrf = jar.find((c) => c.name === "__Host-octopus_csrf")!;
    expect(csrf.httpOnly).toBe(false);
  });

  it("sends the live cookie in x-csrf-token, ignores a decoy, and logs out with it", async () => {
    // These were two tests while the panel patched `window.fetch` in the
    // document head: any `page.evaluate(fetch(...))` inherited the header. The
    // header now comes from the app's own API client, so the honest way to
    // exercise it is to press the control a person presses — which also means
    // the mutation under test is the one that MUST work (logout is not "clear a
    // cookie", it ends a server-side session and everything derived from it).
    const jar = await page.context().cookies(publicUrl);
    const real = jar.find((c) => c.name === "__Host-octopus_csrf")!.value;

    // What a sibling host could plant: the retired, unprefixed name. A page
    // that read it would send the wrong value and be refused.
    await page.context().addCookies([
      { name: "octopus_csrf", value: "DECOY-not-the-secret", url: publicUrl },
    ]);
    await page.goto(`${publicUrl}/permissions`);
    // Keep this exact: the page also has a distinct “除本次外全部退出” action.
    const logout = page.getByRole("button", { name: "退出", exact: true });
    await logout.waitFor({ state: "visible", timeout: 15_000 });

    // Record every request the app makes, so both halves of the rule are
    // observable: the mutation carries the secret, the polls do not.
    const sent: Array<{ method: string; url: string; csrf: string | undefined }> = [];
    page.on("request", (req) => {
      sent.push({ method: req.method(), url: req.url(), csrf: req.headers()["x-csrf-token"] });
    });

    const response = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/logout") && r.request().method() === "POST"),
      logout.click(),
    ]).then(([r]) => r);

    const mutation = sent.find((r) => r.method === "POST" && r.url.endsWith("/logout"));
    expect(mutation, "the mutation was intercepted").toBeTruthy();
    expect(mutation!.csrf).toBe(real);
    expect(mutation!.csrf).not.toBe("DECOY-not-the-secret");
    // The server accepted it: not a 403 from the mutation gate.
    expect(response.status()).toBe(200);
    // A safe method really did go without one, which is the other half of the
    // rule. The app polls its own endpoints while the page is up.
    const poll = sent.find((r) => r.method === "GET" && r.url.includes("/api/"));
    if (poll) expect(poll.csrf).toBeUndefined();

    // The deletions were accepted: a `__Host-` delete without Secure is
    // rejected by the browser, which used to leave the session in the jar.
    const after = await page.context().cookies(publicUrl);
    const names = after.map((c) => c.name);
    expect(names).not.toContain("__Host-octopus_sess");
    expect(names).not.toContain("__Host-octopus_csrf");
    // …and the RETIRED name goes too. The decoy planted above is exactly what an
    // upgraded browser (or a sibling host) would be carrying, so "logout clears
    // the live pair" would be only half of the migration.
    expect(names, "the retired decoy must be cleared as well").not.toContain("octopus_csrf");

    // And the server agrees the session is over. The request client's generic
    // Accept header receives the API-shaped 401; a real document navigation is
    // redirected to login (covered by pages.e2e).
    const reload = await page.context().request.get(`${publicUrl}/sessions`);
    expect(reload.status()).toBe(401);
    expect(await reload.json()).toMatchObject({ error: "unauthorized" });
    await page.goto(`${publicUrl}/login`);
    expect(await page.locator('input[type="password"]').count()).toBe(1);
  });

  it("agrees with the contract function the server uses", () => {
    expect(dashboardCookies(publicUrl).names).toEqual({
      session: "__Host-octopus_sess",
      csrf: "__Host-octopus_csrf",
    });
  });
});
