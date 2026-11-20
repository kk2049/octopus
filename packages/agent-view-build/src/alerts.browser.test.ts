/// <reference lib="dom" />
/** Real SDK/runtime/CSS; only the Host's action replies are fixtures. */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderAgentViewThemeCss } from "./theme-tokens.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

async function fixtureHtml(): Promise<string> {
  const root = resolve(repo, "packages/agent-view-react");
  const entry = resolve(root, "alerts.fixture.tsx");
  const source = `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { AgentViewProvider } from './src/provider.tsx';
    import { AgentViewAlerts } from './src/alerts.tsx';
    import { createAppRuntimeClient } from './src/runtime.ts';
    import './src/styles-index.css';
    const client = createAppRuntimeClient({ projection: {}, dispatch: async () => ({
      ok: false, code: 'not_found', message: '路径不存在或不可见：aiopslab/missing.py',
    }) });
    window.failRead = () => client.propose('resource.resolve_path', {});
    window.failOperations = () => {
      for (let index = 0; index < 9; index++) client.operation({ id: 'op-' + index,
        operation: 'open_session', status: 'failed', message: '尝试 ' + index + '：' + 'long/path/'.repeat(24) });
    };
    createRoot(document.getElementById('root')).render(
      <AgentViewProvider client={client}>
        <main><h1>会话工作区</h1><textarea aria-label="草稿" defaultValue="未发送草稿" />
          <button onClick={event => { event.currentTarget.textContent = '已切换'; }}>切换会话</button></main>
        <AgentViewAlerts />
      </AgentViewProvider>);
  `;
  const result = await build({
    configFile: false, root, logLevel: "error",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    esbuild: { jsxDev: false },
    plugins: [react(), {
      name: "alerts-browser-fixture",
      resolveId: (id) => id === entry ? entry : undefined,
      load: (id) => id === entry ? source : undefined,
      transform: (code, id) => id.endsWith("/agent-view-react/src/styles-index.css")
        ? code.replace("/* @claude-bot/agent-view-build:theme-tokens */", `@layer agent-view-base { ${renderAgentViewThemeCss()} }`)
        : undefined,
    }],
    build: { write: false, minify: false, cssCodeSplit: false,
      lib: { entry, formats: ["iife"], name: "AlertsFixture" } },
  });
  const output = Array.isArray(result) ? result[0] : result;
  if (!("output" in output)) throw new Error("expected fixture output");
  const js = output.output.filter((item) => item.type === "chunk").map((item) => item.code).join("\n");
  const css = output.output.flatMap((item) => item.type === "asset" && item.fileName.endsWith(".css")
    ? [String(item.source)] : []).join("\n");
  return `<!doctype html><html data-av-theme="apple"><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <style>${css}</style><style>main{padding:300px 16px 16px}textarea{display:block;width:200px;height:80px}</style>
    <div id="root"></div><script>${js.replaceAll("</script", "<\\/script")}</script></html>`;
}

describe("non-blocking failure notifications in Chromium", () => {
  let browser: Browser;
  let html: string;
  beforeAll(async () => { html = await fixtureHtml(); browser = await chromium.launch(); }, 120_000);
  afterAll(async () => { await browser?.close(); });

  it.each([390, 1280])("keeps focus, clicks and bounded details available at %i px", async (width) => {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    page.setDefaultTimeout(5_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.setContent(html);
      const draft = page.getByRole("textbox", { name: "草稿" });
      await draft.fill("继续写");
      await page.evaluate(() => (window as unknown as { failRead(): Promise<unknown> }).failRead());
      const notice = page.getByRole("region", { name: "有操作没有成功" });
      await notice.waitFor();
      expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("草稿");
      await page.keyboard.type(" after failure");
      expect(await draft.inputValue()).toBe("继续写 after failure");
      expect(await page.getByRole("dialog").count()).toBe(0);
      expect(await page.getByRole("alertdialog").count()).toBe(0);
      const box = (await notice.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeLessThan(30);
      expect(width - box.x - box.width).toBeLessThan(30);
      expect(box.width).toBeLessThanOrEqual(340);
      expect(box.height).toBeLessThan(230);
      await page.getByRole("button", { name: "切换会话" }).click();
      expect(await page.getByRole("button", { name: "已切换" }).count()).toBe(1);
      await page.evaluate(() => (window as unknown as { failOperations(): void }).failOperations());
      await page.getByRole("button", { name: /查看详情/ }).click();
      expect(await notice.locator("[data-av-alert-kind]").count()).toBe(6);
      expect((await notice.boundingBox())!.height).toBeLessThan(420);
      expect(await notice.locator(".av-alerts").evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
      await draft.fill("展开详情后仍可输入");
      await page.getByRole("button", { name: "收起详情" }).click();
      await page.getByRole("button", { name: "知道了" }).click();
      await notice.waitFor({ state: "hidden" });
      expect(await draft.inputValue()).toBe("展开详情后仍可输入");
      expect(errors).toEqual([]);
    } catch (error) {
      console.error("[alerts browser errors]", errors);
      throw error;
    } finally {
      await page.close();
    }
  });
});
