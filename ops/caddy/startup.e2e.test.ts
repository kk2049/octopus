import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import { haveCaddy, startupFixture } from "./fixture.js";

const executablePath = process.env.OCTOPUS_TEST_CHROMIUM || chromium.executablePath();
const available = haveCaddy && existsSync(executablePath);
if (!available) console.warn("startup browser check skipped: Caddy and Chromium are required");
describe.skipIf(!available)("restart page in a real browser", () => {
  it("loads assets without Bot and returns to the same URL after recovery", async () => {
    const env = await startupFixture();
    const browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
    try {
      await env.stopBackend();
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: "zh-CN" });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (/Content Security Policy|Refused to (load|execute|apply|connect)/i.test(message.text())) errors.push(message.text());
      });
      const requests: string[] = [];
      page.on("request", (request) => requests.push(new URL(request.url()).pathname));
      const url = `${env.base}/sessions-plus?workspace=retained#current-session`;
      expect((await page.goto(url))?.status()).toBe(503);
      await page.getByRole("heading", { name: "正在连接服务" }).waitFor();
      expect(await page.locator(".spinner").evaluate((node) => getComputedStyle(node).animationName)).toBe("spin");
      await page.screenshot({ path: "/tmp/octopus-startup-loading-mobile.png" });
      await page.getByRole("button", { name: "重新连接" }).click();
      expect(requests.every((path) => ["/sessions-plus", "/__octopus/deploy", "/__octopus/ready", "/__octopus/startup/loading.js", "/__octopus/startup/loading.css"].includes(path))).toBe(true);
      await env.startBackend();
      await page.getByText("Backend response", { exact: true }).waitFor({ timeout: 15_000 });
      expect(page.url()).toBe(url);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      await env.close();
    }
  }, 40_000);

  it("does not hold a recovered navigation behind a build still in progress", async () => {
    const env = await startupFixture();
    const browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
    try {
      await env.stopBackend(); env.setDeployment("building", 523);
      const page = await browser.newPage({ locale: "zh-CN" });
      await page.goto(env.base + "/tickets");
      await page.getByRole("heading", { name: "正在连接服务" }).waitFor();
      expect(await page.locator("body").innerText()).not.toContain("正在构建");
      await env.startBackend();
      await page.getByRole("button", { name: "重新连接" }).click();
      await page.getByText("Backend response", { exact: true }).waitFor({ timeout: 10_000 });
    } finally { await browser.close(); await env.close(); }
  }, 30_000);

  it("treats an old finished deployment as an ordinary restart, not an upgrade result", async () => {
    const env = await startupFixture();
    const browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
    try {
      await env.stopBackend();
      const halfHourAgo = new Date(Date.now() - 30 * 60_000).toISOString();
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: "zh-CN" });
      await page.goto(env.base + "/tickets");
      await page.getByRole("heading", { name: "正在连接服务" }).waitFor();
      for (const status of ["succeeded", "rolled_back"]) {
        env.setDeployment(status, 393, Date.now(), halfHourAgo);
        await page.getByRole("button", { name: "重新连接" }).click();
        await page.waitForTimeout(400);
        expect(await page.getByRole("heading").textContent()).toBe("正在连接服务");
      }
      await page.screenshot({ path: process.env.OCTOPUS_STARTUP_SCREENSHOT ?? "/tmp/octopus-startup-restart.png" });
      env.setDeployment("succeeded", 394);
      await page.getByRole("heading", { name: "升级成功，正在返回" }).waitFor();
      await env.startBackend();
      await page.getByText("Backend response", { exact: true }).waitFor({ timeout: 10_000 });
    } finally { await browser.close(); await env.close(); }
  }, 40_000);

  it("keeps health-gate progress when HTTP recovers and reports rollback instead of success", async () => {
    const env = await startupFixture();
    const browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
    try {
      await env.stopBackend(); env.setDeployment("health_gate", 265);
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: "zh-CN" });
      const url = env.base + "/tickets?kept=yes#report";
      await page.goto(url);
      await page.getByRole("heading", { name: "正在启动并检查新版本" }).waitFor();
      await env.startBackend();
      await page.getByRole("button", { name: "重新连接" }).click();
      await page.waitForTimeout(400);
      expect(page.url()).toBe(url);
      expect(await page.getByRole("heading").textContent()).toBe("正在启动并检查新版本");
      env.setDeployment("rolling_back", 265);
      await page.getByRole("heading", { name: "新版本启动失败，正在恢复上一版本" }).waitFor();
      env.setDeployment("rolled_back", 265);
      await page.getByRole("heading", { name: "已恢复上一版本，本次升级未完成" }).waitFor();
      await page.getByRole("button", { name: "返回页面" }).click();
      await page.getByText("Backend response", { exact: true }).waitFor();
      expect(page.url()).toBe(url);
    } finally { await browser.close(); await env.close(); }
  }, 40_000);
});
