/** Real Dashboard, cookie/CSRF gate, portal and browser; only Feishu is a fixture. */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { Store } from "../store/store.js";
import { FeishuOAuthPortal } from "../feishu/oauth-portal.js";
import type { FeishuOAuthToken } from "../user/types.js";
import { createDashboardTestServer } from "../e2e/dashboard-test-support.js";
import { mintDashboardToken, type DashboardServer } from "./server.js";

const HAVE_BROWSER = existsSync(chromium.executablePath());
if (!HAVE_BROWSER) console.warn("Feishu browser flow skipped: install the Playwright Chromium binary in the CI Runner.");
vi.setConfig({ testTimeout: 45_000, hookTimeout: 90_000 });

describe.skipIf(!HAVE_BROWSER)("Feishu authorization in the real permissions page", () => {
  let dir: string;
  let store: Store;
  let dash: DashboardServer;
  let portal: FeishuOAuthPortal;
  let base: string;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let stored: FeishuOAuthToken;
  let token: string;
  let finish!: (value: FeishuOAuthToken) => void;
  let startGate: Promise<void> | undefined;
  let startFailure = false;
  let starts = 0;
  const saved = vi.fn();
  const oldToken = { access_token: "fixture-old", refresh_token: "fixture-refresh", expires_at: 99_999, token_type: "Bearer" };
  const freshToken = { ...oldToken, access_token: "fixture-new", refresh_token: "fixture-new-refresh" };
  const providerUrl = "https://accounts.feishu.cn/oauth/device?code=TEST-CODE";

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "feishu-oauth-browser-"));
    store = new Store(join(dir, "test.db"));
    store.saveUser({ username: "alice", uid: 5001, home_dir: join(dir, "alice"), created_at: "2026-09-25T00:00:00Z" });
    token = mintDashboardToken(store, "alice");
    portal = new FeishuOAuthPortal({
      startDeviceAuth: async () => {
        starts += 1;
        await startGate;
        if (startFailure) throw new Error("fixture provider unavailable");
        return { device_code: "fixture-device", user_code: "TEST-CODE", verification_uri: providerUrl,
          verification_uri_complete: providerUrl, expires_in: 300, interval: 1 };
      },
      pollForToken: () => new Promise<FeishuOAuthToken>((resolve) => { finish = resolve; }),
    } as never, {
      getFeishuToken: () => stored,
      saveFeishuToken: async (owner, value) => { saved(owner, value); stored = value; },
    });
    dash = createDashboardTestServer(store, undefined, {
      host: "127.0.0.1", port: 0, authToken: "fixture-admin", runnerWsPort: 9910, feishuOAuth: portal,
    });
    await dash.start();
    base = `http://127.0.0.1:${dash.port}`;
    browser = await chromium.launch();
  });

  beforeEach(async () => {
    portal.clear("alice"); stored = oldToken; starts = 0; startFailure = false; startGate = undefined; saved.mockClear();
    context = await browser.newContext();
    await context.route("https://accounts.feishu.cn/**", async (route) => {
      if (new URL(route.request().url()).searchParams.has("confirm")) {
        finish(freshToken);
        await route.fulfill({ contentType: "text/html", body: "<h1>Fixture authorization complete</h1>" });
      } else {
        await route.fulfill({ contentType: "text/html", body: '<h1>Fixture Feishu consent</h1><form method="get"><button name="confirm" value="yes">Confirm access</button></form>' });
      }
    });
    await context.route("**/__octopus/deploy", (route) => route.fulfill({ json: {
      id: null, status: "idle", http_ready: true, observed_at: Date.now(),
    } }));
    const login = await context.request.post(`${base}/login`, {
      headers: { origin: base }, data: { token }, maxRedirects: 0,
    });
    expect(login.status()).toBe(303);
    page = await context.newPage();
  });

  afterEach(async () => { await context?.close(); });
  afterAll(async () => {
    await browser?.close(); await dash?.stop(); store?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("puts the entry above tabs and completes click → consent tab → saved grant → automatic status", async () => {
    let releaseStart!: () => void;
    startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (/Refused to|Content Security Policy/i.test(message.text())) errors.push(message.text()); });
    await page.goto(`${base}/permissions?focus=feishu`);
    const card = page.getByRole("region", { name: "飞书个人连接" });
    const button = card.getByRole("button", { name: "重新授权", exact: true });
    await button.waitFor();
    const cardRect = await card.boundingBox();
    const tabsRect = await page.getByRole("tablist", { name: "权限中心分区" }).boundingBox();
    expect(cardRect!.y + cardRect!.height).toBeLessThanOrEqual(tabsRect!.y);
    const popupPromise = context.waitForEvent("page");
    const started = page.waitForResponse((r) => r.url().endsWith("/api/feishu/oauth/start"));
    await button.click();
    const popup = await popupPromise;
    expect(popup.url()).toBe("about:blank");
    expect(await button.isDisabled()).toBe(true);
    await card.getByText("正在发起飞书授权…").waitFor();
    releaseStart();
    const response = await started;
    expect(response.status()).toBe(200);
    expect(response.request().postDataJSON()).toEqual({ username: "alice", force: true });
    const payload = await response.json();
    expect(payload).toMatchObject({ state: "pending", verificationUri: providerUrl });
    expect(payload).not.toHaveProperty("access_token");
    await popup.waitForURL(providerUrl);
    expect(await popup.evaluate(() => window.opener === null)).toBe(true);
    await popup.getByRole("button", { name: "Confirm access" }).click();
    await card.getByText("● 已连接", { exact: true }).waitFor();
    expect(saved).toHaveBeenCalledExactlyOnceWith("alice", freshToken);
    expect(starts).toBe(1);
    expect(await card.getByRole("link", { name: "打开飞书授权页" }).count()).toBe(0);
    expect(errors).toEqual([]);
  });

  it("keeps a usable fallback on a narrow screen when automatic tab opening is blocked", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => { window.open = () => null; });
    await page.goto(`${base}/permissions`);
    const card = page.getByRole("region", { name: "飞书个人连接" });
    await card.getByRole("button", { name: "重新授权", exact: true }).click();
    await card.getByText("浏览器未能自动打开授权页，请点击下方链接继续。").waitFor();
    const popupPromise = context.waitForEvent("page");
    await card.getByRole("link", { name: "打开飞书授权页" }).click();
    const popup = await popupPromise;
    await popup.waitForURL(providerUrl);
    await popup.getByRole("button", { name: "Confirm access" }).click();
    await card.getByText("● 已连接", { exact: true }).waitFor();
    expect(saved).toHaveBeenCalledExactlyOnceWith("alice", freshToken);
    expect(starts).toBe(1);
  });

  it("surfaces a real API start failure locally and closes its unused tab", async () => {
    startFailure = true;
    await page.goto(`${base}/permissions`);
    const card = page.getByRole("region", { name: "飞书个人连接" });
    const popupPromise = context.waitForEvent("page");
    await card.getByRole("button", { name: "重新授权", exact: true }).click();
    const popup = await popupPromise;
    await card.getByRole("alert").getByText("飞书授权暂时无法启动，请稍后重试").waitFor();
    await vi.waitFor(() => expect(popup.isClosed()).toBe(true));
    expect(saved).not.toHaveBeenCalled();
    expect(starts).toBe(1);
    expect(await card.getByRole("button", { name: "重新授权", exact: true }).isEnabled()).toBe(true);
  });
});
