/// <reference lib="dom" />
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer as createHttpServer, request as httpRequest, type Server } from "node:http";
import { createServer as createTlsServer, type Server as TlsServer } from "node:https";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { Store } from "../store/store.js";
import { UserManagerImpl } from "../user/manager.js";
import { DashboardServer } from "./server.js";
import { createDashboardTestServer } from "../e2e/dashboard-test-support.js";
import type { GithubFetcher } from "./oauth-github.js";

// Real Chromium over a local TLS proxy shares a full-suite shard with the
// other browser harnesses; the Node project's 20 s unit-test budget is not a
// product latency contract. Playwright's own waits remain bounded.
vi.setConfig({ testTimeout: 60_000 });

function toolsAvailable(): boolean {
  try {
    if (!existsSync(chromium.executablePath())) return false;
    execFileSync("openssl", ["version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

async function freePort(): Promise<number> {
  const server: Server = createHttpServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe.skipIf(!toolsAvailable())("GitHub OAuth over the production HTTPS cookie contract", () => {
  let dir: string;
  let store: Store;
  let dashboard: DashboardServer;
  let tls: TlsServer;
  let browser: Browser;
  let page: Page;
  let publicUrl: string;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "oauth-github-tls-"));
    const key = path.join(dir, "key.pem");
    const cert = path.join(dir, "cert.pem");
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", key, "-out", cert, "-days", "2",
      "-subj", "/CN=localhost",
      "-addext", "subjectAltName=DNS:localhost",
    ], { stdio: "pipe" });

    store = new Store(path.join(dir, "bot.db"));
    const users = new UserManagerImpl(store, dir);
    await users.register("browseruser", { provider: "github", externalId: "777", label: "browser-gh" });
    const githubFetcher: GithubFetcher = async (input) => {
      if (String(input) === "https://github.com/login/oauth/access_token") {
        return new Response(JSON.stringify({ access_token: "browser-access-token" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (String(input) === "https://api.github.com/user") {
        return new Response(JSON.stringify({ id: 777, login: "browser-gh" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("unexpected", { status: 500 });
    };

    const tlsPort = await freePort();
    publicUrl = `https://localhost:${tlsPort}`;
    dashboard = createDashboardTestServer(store, undefined, {
      port: 0,
      host: "127.0.0.1",
      authToken: "admin-secret",
      publicUrl,
      oauthGithub: { clientId: "client-id", clientSecret: "client-secret" },
      registration: "closed",
      userManager: users,
      githubFetcher,
    });
    await dashboard.start();

    tls = createTlsServer(
      { key: readFileSync(key), cert: readFileSync(cert) },
      (req, res) => {
        const upstream = httpRequest(
          {
            host: "127.0.0.1",
            port: dashboard.port,
            path: req.url,
            method: req.method,
            headers: req.headers,
          },
          (upstreamResponse) => {
            res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
            upstreamResponse.pipe(res);
          },
        );
        upstream.on("error", () => {
          res.writeHead(502);
          res.end("upstream");
        });
        req.pipe(upstream);
      },
    );
    await new Promise<void>((resolve) => tls.listen(tlsPort, "127.0.0.1", resolve));

    browser = await chromium.launch();
    page = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolve) => tls?.close(() => resolve()));
    await dashboard?.stop();
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("binds state to the browser, exchanges GitHub identity, and returns a live session", async () => {
    await page.goto(`${publicUrl}/login`);
    const link = page.getByRole("link", { name: "使用 GitHub 登录" });
    expect(await link.getAttribute("href")).toBe("/auth/github");

    // The browser context's request client shares its cookie jar with the
    // page. Stop at Octopus's redirect so this hermetic test never contacts
    // GitHub, then emulate the provider's callback with the issued state.
    const start = await page.context().request.get(`${publicUrl}/auth/github`, { maxRedirects: 0 });
    expect(start.status()).toBe(303);
    const authorize = new URL(start.headers().location!);
    expect(authorize.origin + authorize.pathname).toBe("https://github.com/login/oauth/authorize");
    const state = authorize.searchParams.get("state");
    expect(state).toBeTruthy();
    expect((await page.context().cookies(publicUrl)).some(
      (cookie) => cookie.name === "__Host-octopus_oauth",
    )).toBe(true);

    await page.goto(`${publicUrl}/auth/github/callback?code=browser-code&state=${encodeURIComponent(state!)}`);
    await page.waitForURL(`${publicUrl}/`);

    const cookies = await page.context().cookies(publicUrl);
    expect(cookies.some((cookie) => cookie.name === "__Host-octopus_oauth")).toBe(false);
    expect(cookies.find((cookie) => cookie.name === "__Host-octopus_sess")).toMatchObject({
      secure: true,
      httpOnly: true,
      path: "/",
    });
    const overview = await page.context().request.get(`${publicUrl}/api/overview`);
    expect(overview.status()).toBe(200);
    expect(await overview.json()).toMatchObject({ viewer: { username: "browseruser" } });
  });
});
