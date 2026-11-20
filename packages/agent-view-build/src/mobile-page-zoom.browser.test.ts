/// <reference lib="dom" />
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit, type Browser } from "playwright";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderAgentViewThemeCss } from "./theme-tokens.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const file = (path: string) => JSON.stringify(resolve(repo, path));
type Bundle = { js: string; css: string };

// One ordinary React root with the real Dashboard Ant provider, SDK runtime
// and App controls. The shell owns document appearance for both mounted surfaces.
async function bundle(): Promise<Bundle> {
  const root = resolve(repo, "packages/dashboard-web");
  const entry = resolve(root, "mobile-zoom.fixture.ts");
  const source = `
    import { createElement as h, useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { AgentViewProvider } from ${file("packages/agent-view-react/src/provider.tsx")};
    import { createAppRuntimeClient } from ${file("packages/agent-view-react/src/runtime.ts")};
    import { AvTextArea, AvButton } from ${file("packages/agent-view-react/src/controls.tsx")};
    import ${file("packages/agent-view-react/src/styles-index.css")};
    import { DashboardUiProvider } from ${file("packages/dashboard-web/src/ui-kit/UiProvider.tsx")};
    import { UiTextArea } from ${file("packages/dashboard-web/src/ui-kit/forms.tsx")};
    import { UiButton } from ${file("packages/dashboard-web/src/ui-kit/button.tsx")};
    import { getAppearance, initTheme, initMobileControlFont, subscribeTheme } from ${file("packages/dashboard-web/src/styles/themes.ts")};
    import ${file("packages/dashboard-web/src/styles/index.css")};
    initTheme('classic');
    initMobileControlFont();
    const client = createAppRuntimeClient({
      projection: {}, appearance: getAppearance(),
      dispatch: async () => ({ ok: true, message: '' }),
    });
    subscribeTheme((appearance) => client.updateAppearance(appearance));
    function Composer({ app = false }) {
      const [value, setValue] = useState('未发送草稿');
      const TextArea = app ? AvTextArea : UiTextArea;
      const Button = app ? AvButton : UiButton;
      const name = app ? 'app' : 'dashboard';
      return h('section', { 'data-test-surface': name },
        h('p', { className: 'copy' }, 'Small surrounding text'),
        h('div', { className: 'composer' },
          h(TextArea, { id: name + '-composer', value, onChange: (event) => setValue(event.target.value) }),
          h(Button, { className: 'send' }, 'Send')));
    }
    createRoot(document.getElementById('root')).render(h(DashboardUiProvider, null,
      h(Composer),
      h('div', { 'data-app-surface': 'mobile-zoom-fixture' },
        h(AgentViewProvider, { client, uiProvider: false, reflectAppearance: false },
          h(Composer, { app: true })))));
  `;
  const result = await build({
    configFile: false, root, logLevel: "error",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    esbuild: { jsxDev: false },
    plugins: [react(), {
      name: "mobile-zoom-fixture",
      resolveId: (id) => id === entry ? entry : undefined,
      load: (id) => id === entry ? source : undefined,
      transform: (code, id) => id.endsWith("/agent-view-react/src/styles-index.css")
        ? code.replace("/* @claude-bot/agent-view-build:theme-tokens */", `@layer agent-view-base { ${renderAgentViewThemeCss()} }`)
        : undefined,
    }],
    build: { write: false, minify: false, cssCodeSplit: false,
      lib: { entry, formats: ["iife"], name: "MobileZoomFixture" } },
  });
  const output = Array.isArray(result) ? result[0] : result;
  if (!("output" in output)) throw new Error("expected a fixture bundle");
  return {
    js: output.output.filter((item) => item.type === "chunk").map((item) => item.code).join("\n"),
    css: output.output.flatMap((item) => item.type === "asset" && item.fileName.endsWith(".css")
      ? [String(item.source)] : []).join("\n"),
  };
}

function documentHtml(built: Bundle, zoom = 1): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=${390 / zoom},initial-scale=${zoom}">
    <style>${built.css}</style><style>
      #root { height:auto; flex:none; } .copy { font-size: 12px; }
      .composer { display:grid; grid-template-columns:minmax(0,1fr) auto; }
      textarea { width:100%; min-width:0; }
      [data-app-surface] { width:60%; min-height:260px; flex-shrink:0; }
    </style>
    <script type="application/json" id="octopus-bootstrap">{"viewer":{},"pageProps":{}}</script>
    <div id="root"></div>
    <script>${built.js.replaceAll("</script", "<\\/script")}</script>`;
}

describe("mobile page zoom with real controls and a mounted App", () => {
  let built: Bundle;
  beforeAll(async () => { built = await bundle(); }, 120_000);

  for (const engine of [chromium, webkit]) {
    describe(engine.name(), () => {
      let browser: Browser;
      beforeAll(async () => { browser = await engine.launch(); });
      afterAll(async () => { await browser?.close(); });

      it("compensates 50/75% page scaling at boot and live while retaining the draft", async () => {
        const page = await browser.newPage({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true });
        page.setDefaultTimeout(5_000);
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        try {
          // A wider layout viewport is scaled into the same physical phone.
          // Production never changes this metadata. Native iOS focus animation
          // remains a device check; here we assert the post-scale font floor.
          await page.setContent(documentHtml(built, 0.5));
          const appComposer = page.locator("#app-composer");
          await appComposer.waitFor();
          expect(await page.locator("iframe").count()).toBe(0);
          const input = await appComposer.elementHandle();
          const dashboardInput = await page.locator("#dashboard-composer").elementHandle();
          await page.locator("#dashboard-composer").fill("dashboard draft");
          await appComposer.fill("still editing");
          for (const zoom of [0.5, 0.75, 1, 0.5]) {
            await page.evaluate((scale) => {
              document.querySelector('meta[name="viewport"]')!.setAttribute("content", `width=${390 / scale},initial-scale=${scale}`);
              window.dispatchEvent(new Event("resize"));
            }, zoom);
            for (const name of ["dashboard", "app"]) {
              const surface = page.locator(`[data-test-surface="${name}"]`);
              await expect.poll(async () => Number.parseFloat(await surface.locator("textarea").evaluate((element) => getComputedStyle(element).fontSize)) * zoom).toBeGreaterThanOrEqual(16);
              await expect.poll(async () => Number.parseFloat(await surface.locator("textarea").evaluate((element) => getComputedStyle(element).fontSize)) * zoom).toBeLessThanOrEqual(18);
              expect(await surface.locator(".copy").evaluate((element) => getComputedStyle(element).fontSize)).toBe("12px");
              const send = await surface.locator(".send").boundingBox();
              expect(send!.x).toBeGreaterThanOrEqual(0);
              expect((send!.x + send!.width) * zoom).toBeLessThanOrEqual(390);
            }
            expect(await input!.evaluate((element) => element === document.getElementById("app-composer"))).toBe(true);
            expect(await dashboardInput!.evaluate((element) => element === document.getElementById("dashboard-composer"))).toBe(true);
            expect(await appComposer.inputValue()).toBe("still editing");
            expect(await page.locator("#dashboard-composer").inputValue()).toBe("dashboard draft");
          }
          expect(errors).toEqual([]);
        } catch (error) {
          const metrics = await Promise.all(page.frames().map((frame) => frame.evaluate(() => ({
            url: location.href, layout: document.documentElement.clientWidth, outer: outerWidth,
            touch: matchMedia("(hover: none) and (pointer: coarse)").matches,
            control: document.documentElement.style.getPropertyValue("--mobile-control-font-size"),
            fonts: Array.from(document.querySelectorAll("textarea")).map((node) => ({ id: node.id, font: getComputedStyle(node).fontSize })),
          }))));
          throw new Error(`Browser errors: ${JSON.stringify(errors)}; metrics: ${JSON.stringify(metrics)}`, { cause: error });
        } finally { await page.close(); }
      }, 30_000);
    });
  }
});
