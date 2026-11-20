/** Real bundle + ticket API; run only in the isolated browser/CI environment. */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { Store } from "../store/store.js";
import type { DevPipeline } from "../devpipe/pipeline.js";
import { normalizeDevTicketInput } from "../devpipe/ticket-models.js";
import { createDashboardTestServer } from "../e2e/dashboard-test-support.js";
import { mintDashboardToken, type DashboardServer } from "./server.js";

describe.skipIf(!existsSync(chromium.executablePath()))("ticket history search in Chromium", () => {
  let store: Store;
  let dash: DashboardServer;
  let browser: Browser;
  let token: string;
  let base: string;
  let historicalId: number;

  beforeAll(async () => {
    store = new Store(":memory:");
    store.saveUser({ username: "search_tester", uid: 1, home_dir: "/unused", created_at: "2026-10-13T00:00:00Z" });
    store.grantCapability("search_tester", "dev", "test", "2026-10-13T00:00:00Z");
    token = mintDashboardToken(store, "search_tester");
    const old = store.devTickets.createDevTicket(normalizeDevTicketInput({
      title: "旧工单：文件搜索", body: "查找历史需求", requester: "search_tester",
    }));
    historicalId = old.id;
    store.devTickets.updateDevTicket(old.id, { dev_status: "cancelled" });
    store.devTickets.addTicketMessage(old.id, "search_tester", "web", "追加需求：文件搜索");
    for (let i = 0; i < 205; i++) store.devTickets.createDevTicket(normalizeDevTicketInput({
      title: `近期工单 ${i}`, body: "一般需求", requester: "search_tester",
    }));
    const pipe = {
      lockWaiterIds: () => [], mergeLockHolder: () => null,
      ticketExecutionChoices: () => undefined, usesRunnerTickets: () => false,
      readTicketExecution: async () => undefined, specConcurrency: 1, baseBranch: "v4",
    } as unknown as DevPipeline;
    dash = createDashboardTestServer(store, undefined, {
      port: 0, host: "127.0.0.1", devPipeline: pipe,
    });
    await dash.start();
    base = `http://127.0.0.1:${dash.port}`;
    browser = await chromium.launch();
  }, 60_000);
  afterAll(async () => { await browser?.close(); await dash?.stop(); store?.close(); });

  it("finds an old ticket, opens it, recovers from no matches, and fits a phone", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    try {
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error" && /Refused to|Content Security Policy/i.test(message.text())) errors.push(message.text());
      });
      page.on("response", (response) => {
        if (response.status() >= 500) errors.push(`HTTP ${response.status()}: ${new URL(response.url()).pathname}`);
      });
      // Peripheral panels do not belong to this isolated search fixture.
      await page.route("**/__octopus/deploy", (route) => route.fulfill({ json: { status: "idle", http_ready: true } }));
      await page.route("**/api/dev/quota", (route) => route.fulfill({ json: { cards: [] } }));
      await page.route("**/api/dev/system-status", (route) => route.fulfill({ json: { hosts: [] } }));
      await page.route("**/api/deploy", (route) => route.fulfill({ json: { base_branch: "v4", stable_branch: "v4-stable", recent: [] } }));
      await page.goto(`${base}/login`);
      await page.getByLabel("登录密钥").fill(token);
      await page.getByRole("button", { name: "登录", exact: true }).click();
      await page.waitForURL((url) => url.pathname !== "/login");
      await page.goto(`${base}/tickets`);
      const form = page.getByRole("search", { name: "搜索历史工单" });
      // History search starts folded in the sidebar; opening it is the user's first step.
      const searchSection = page.getByTestId("search-section");
      expect(await searchSection.getAttribute("open")).toBeNull();
      await searchSection.locator("summary").click();
      await form.waitFor();
      expect(await page.getByRole("button", { name: /旧工单：文件搜索/ }).count()).toBe(0);
      await form.getByRole("textbox", { name: "关键词" }).fill("文件搜索");
      await form.getByRole("textbox", { name: "发起人" }).fill("search_tester");
      await form.getByRole("combobox", { name: "开发状态" }).click();
      await page.getByText("已取消", { exact: true }).last().click();
      await form.getByRole("combobox", { name: "开发状态" }).press("Escape");
      await page.getByRole("listbox").waitFor({ state: "hidden" });
      await form.getByRole("button", { name: "搜索", exact: true }).click();
      const row = page.getByRole("button", { name: /旧工单：文件搜索/ });
      await row.waitFor();
      const screenshots = process.env.TICKET_SEARCH_SCREENSHOT_DIR;
      if (screenshots) {
        mkdirSync(screenshots, { recursive: true });
        await page.screenshot({ path: join(screenshots, "desktop.png") });
      }
      await row.click();
      await page.getByText(`#${historicalId} 旧工单：文件搜索`, { exact: true }).waitFor();
      await form.getByRole("textbox", { name: "关键词" }).fill("不存在的关键词");
      await form.getByRole("button", { name: "搜索", exact: true }).click();
      await page.getByText("没有匹配的工单，请调整筛选。").waitFor();
      await form.getByRole("button", { name: "清除筛选" }).click();
      await page.getByRole("button", { name: /近期工单 204/ }).waitFor();
      // Filtering does not discard the selected detail.
      expect(await page.getByText(`#${historicalId} 旧工单：文件搜索`, { exact: true }).count()).toBe(1);
      await page.setViewportSize({ width: 390, height: 844 });
      await form.getByRole("textbox", { name: "关键词" }).fill(`#${historicalId}`);
      await form.getByRole("button", { name: "搜索", exact: true }).click();
      await row.waitFor();
      await form.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await form.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      if (screenshots) await page.screenshot({ path: join(screenshots, "phone.png") });
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, 60_000);
});
