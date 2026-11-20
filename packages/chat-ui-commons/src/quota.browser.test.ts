import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { build } from "vite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { renderAgentViewThemeCss } from "../../agent-view-build/src/theme-tokens.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const path = (file: string) => JSON.stringify(resolve(repo, file));
let browser: Browser;
let html: string;

beforeAll(async () => {
  const root = resolve(repo, "packages/dashboard-web");
  const entry = resolve(root, "quota.fixture.tsx");
  const source = `
    import { createElement as h, useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
    import { QuotaChips } from ${path("packages/dashboard-web/src/app/Quota.tsx")};
    import { TicketExecutionFields, useTicketExecution } from ${path("packages/dashboard-web/src/ui/TicketExecutionFields.tsx")};
    import { DashboardUiProvider as UiProvider } from ${path("packages/dashboard-web/src/ui-kit/UiProvider.tsx")};
    import { NewSession } from ${path("packages/agent-sessions-view/src/components/NewSession.tsx")};
    import ${path("packages/dashboard-web/src/styles/index.css")};
    import ${path("packages/agent-view-react/src/styles-index.css")};
    import ${path("packages/agent-sessions-view/src/sessions.css")};
    const quota = { status: 'available', fetchedAt: new Date().toISOString(), windows: [
      { remainingPercent: 42, windowMinutes: 300, resetsAt: new Date(Date.now()+3600000).toISOString() },
      { remainingPercent: 19, windowMinutes: 10080, resetsAt: new Date(Date.now()+259200000).toISOString() }
    ] };
    const accounts = [{id:'account_a',label:'codexa',quota}, {id:'account_b',label:'codexb',quota}];
    const options = { sources: accounts.map(a=>({id:a.id,device:'aws',source:'codex',label:'AWS · '+a.label,available:true,quota})),
      workspaces:[{id:'ws',device:'aws',label:'AWS',available:true}],source_default:'account_a',workspace_default:'ws'};
    const client = new QueryClient({defaultOptions:{queries:{staleTime:Infinity}}});
    client.setQueryData(['dev','quota'],{cards:[],codexHosts:[{key:'aws',device:'aws',label:'AWS',online:true,accounts}]});
    function App() {
      const selection = useTicketExecution(options,'codex','test');
      const [account,setAccount] = useState('account_a');
      const noop = () => {};
      return h(UiProvider,null,h(QueryClientProvider,{client},
        h('section',{'aria-label':'status'},h(QuotaChips)),
        h('section',{'aria-label':'ticket'},h(TicketExecutionFields,{selection,idPrefix:'fixture',wrapLabels:true})),
        h('section',{'aria-label':'session','data-app-surface':''},h(NewSession,{
          devices:['aws'],placementDevices:[{device:'aws',online:true,codexAccounts:accounts}],workspaces:{},advanced:false,
          runtimeDevice:'',workspaceId:'',device:'aws',directory:'~/project',source:'codex',translatePrompt:false,
          codexAccount:account,onCodexAccount:setAccount,model:'',effort:'high',permissionProfile:'full-access',prompt:'',
          onAdvanced:noop,onRuntimeDevice:noop,onWorkspace:noop,onDevice:noop,onDirectory:noop,onSource:noop,onModel:noop,
          onEffort:noop,onPermissionProfile:noop,onPrompt:noop,onCancel:noop,onStart:noop
        }))));
    }
    createRoot(document.getElementById('root')).render(h(App));`;
  const built = await build({ configFile: false, root, logLevel: "error",
    esbuild: { jsx: "automatic", jsxDev: false },
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [{
      name: "quota-fixture",
      resolveId: (id) => id === entry ? entry : undefined,
      load: (id) => id === entry ? source : undefined,
      transform: (code, id) => id.endsWith("/agent-view-react/src/styles-index.css")
        ? code.replace("/* @claude-bot/agent-view-build:theme-tokens */", `@layer agent-view-base { ${renderAgentViewThemeCss()} }`)
        : undefined,
    }],
    build: { write: false, minify: false, cssCodeSplit: false, lib: { entry, formats: ["iife"], name: "QuotaFixture" } },
  });
  const result = Array.isArray(built) ? built[0] : built;
  if (!("output" in result)) throw new Error("missing fixture bundle");
  const js = result.output.filter((item) => item.type === "chunk").map((item) => item.code).join("\n").replace(/<\/script/gi, "<\\/script");
  const css = result.output.flatMap((item) => item.type === "asset" && item.fileName.endsWith(".css") ? [String(item.source)] : []).join("\n");
  html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <script id="octopus-bootstrap" type="application/json">{"viewer":{"username":"test"},"csrfCookieNames":[],"themePreference":null}</script>
    <style>${css}\nbody { margin: 0; } section { padding: 12px; min-width: 0; } #root { width: 100%; }
      /* NewSession fills a flex Dock panel in the application. */
      section[aria-label="session"] { display: flex; height: 650px; }</style>
    <div id="root"></div><script>${js}</script>`;
  browser = await chromium.launch({ headless: true });
}, 120_000);
afterAll(async () => { await browser?.close(); });

it.each([390, 1280])("renders quota rings and selectable accounts without overflow at %ipx", async (width) => {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(5_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.setContent(html);
    const session = page.locator('section[aria-label="session"]');
    const settings = session.getByLabel("更多启动设置", { exact: true });
    await settings.waitFor();
    expect(await page.locator('section[aria-label="status"] svg').count()).toBe(4);
    await page.getByRole("combobox", { name: "Agent 来源", exact: true }).click();
    const choice = page.getByRole("option", { name: /AWS · codexb/ });
    expect(await choice.locator("svg").count()).toBe(2);
    await choice.click();
    expect(await page.locator('section[aria-label="ticket"]').innerText()).toContain("codexb");
    // Account choices live behind the launch composer's settings card (#767).
    await settings.click();
    const accounts = session.getByRole("radiogroup", { name: "Codex 账号 · aws" });
    await accounts.waitFor();
    expect(await accounts.locator("svg").count()).toBe(4);
    const card = await session.locator(".composer-options-card").boundingBox();
    const surface = await session.locator(".new-session-entry").boundingBox();
    expect(card!.x).toBeGreaterThanOrEqual(surface!.x);
    expect(card!.x + card!.width).toBeLessThanOrEqual(surface!.x + surface!.width);
    await page.getByRole("radio", { name: /codexb/ }).check();
    expect(await page.getByRole("radio", { name: /codexb/ }).isChecked()).toBe(true);
    expect(await session.innerText()).toContain("账号 codexb");
    const radio = await page.getByRole("radio", { name: /codexb/ }).boundingBox();
    expect(radio!.width).toBe(16);
    expect(radio!.height).toBe(16);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } catch (error) {
    const bounds = await page.locator('.new-session-chat, .composer-options-card, input[value="account_b"]').evaluateAll(
      (elements) => elements.map((element) => ({ className: element.className, rect: element.getBoundingClientRect().toJSON() })),
    );
    throw new Error(`${String(error)}; bounds: ${JSON.stringify(bounds)}; browser errors: ${errors.join("; ")}; body: ${(await page.locator("body").innerText()).slice(0, 2000)}`);
  } finally {
    const screenshotDir = process.env.QUOTA_BROWSER_SCREENSHOT_DIR;
    if (screenshotDir) await page.screenshot({ path: resolve(screenshotDir, `quota-${width}.png`), fullPage: true });
    await page.close();
  }
}, 30_000);
