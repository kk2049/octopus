import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { transpileModule, ModuleKind, ScriptTarget } from "typescript";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => readFileSync(resolve(here, path), "utf8");
const themes = ["classic", "aurora", "ink", "feishu", "deepseek", "apple"];
const assets = resolve(here, "../../dist/a");
const dashboardCss = readdirSync(assets).filter((name) => name.endsWith(".css"))
  .map((name) => readFileSync(resolve(assets, name), "utf8")).join("\n");
const schemeScript = transpileModule(read("./color-scheme.ts"), {
  compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
}).outputText.replace(/export /g, "") + `
  initColorScheme();
  document.querySelector('#switch-mode').onclick = () =>
    chooseColorScheme(currentColorScheme() === 'dark' ? 'light' : 'dark');
  document.querySelector('#system-mode').onclick = () => chooseColorScheme('system');
`;
const dockCss = read("../app/DebugDock.module.css").replace(/:global\(([^)]+)\)/g, "$1");

// Build dashboard-web and session-plus-view before running: the host owns SDK
// CSS while the release owns App/module CSS. Exercise both production bundles.
const appCss = read("../../../session-plus-view/dist/agent-view.css");
const { scope } = JSON.parse(read("../../../session-plus-view/dist/agent-view.entry.json")) as { scope: string };

function fixture(theme: string) {
  return `<!doctype html><html data-theme="${theme}"><head><style>
    ${dashboardCss}
    @layer antd { .ant-btn { box-shadow: 0 2px 4px #000; } }
    ${dockCss}
    ${appCss}
  </style></head><body>
    <button id="switch-mode">Switch mode</button><button id="system-mode">System</button>
    <main data-app-surface="${scope}" data-av-theme="${theme}">
      <div id="app-token" style="color:var(--av-fg);background:var(--av-surface)">App</div>
      <div class="session-plus-app"><div class="av-dock-workspace"><div class="av-dock-host">
        <div class="dockview-theme-octopus"><div class="dv-groupview">
          <div class="av-panel" data-av-module="agent.chat/v1">
            <div class="command-pane"><div class="composer"><div class="composer-input-shell">
              <textarea id="draft" class="av-textarea ant-input" aria-label="继续这个会话"></textarea>
            </div><button class="primary ant-btn">发送</button></div></div>
          </div>
        </div></div>
      </div></div></div>
    </main>
    <div class="dock"><section class="panel"><strong>报告这个页面的问题</strong>
      <textarea aria-label="描述问题"></textarea><button class="ant-btn">创建工单</button>
      <div class="ant-select"><input id="select-input" style="opacity:0" aria-label="模型"></div>
    </section><button class="toggle">🐞</button></div>
  </body></html>`;
}

function luminance(rgb: string): number {
  const channels = rgb.match(/[\d.]+/g)!.slice(0, 3).map(Number);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

describe("flat surfaces and manual colour scheme browser regression", () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
  afterAll(async () => { await browser?.close(); });

  for (const theme of themes) for (const width of [1280, 390]) {
    it(`${theme}, ${width}px: paints both schemes, flat surfaces and focus without replacing inputs`, async () => {
      const page = await browser.newPage({ colorScheme: "light", viewport: { width, height: 800 } });
      try {
        await page.route("https://appearance.test/", (route) => route.fulfill({ contentType: "text/html", body: fixture(theme) }));
        await page.goto("https://appearance.test/");
        await page.addScriptTag({ content: schemeScript });
        await page.locator("#draft").fill("theme switch keeps this draft");
        await page.locator("#draft").evaluate((el) => {
          (el as HTMLTextAreaElement).setSelectionRange(2, 8);
          el.setAttribute("data-original-input", "yes");
        });
        for (const scheme of ["light", "dark", "light"] as const) {
          if (scheme !== await page.locator("html").getAttribute("data-color-scheme")) {
            await page.locator("#switch-mode").click();
          }
          // Both manual choices must win over the opposite OS preference.
          if (await page.evaluate(() => localStorage.getItem("octopus-color-scheme-v1"))) {
            await page.emulateMedia({ colorScheme: scheme === "dark" ? "light" : "dark" });
          }
          const styles = await page.evaluate(() => {
            const style = (selector: string) => getComputedStyle(document.querySelector(selector)!);
            return {
              scheme: style("html").colorScheme,
              appScheme: style("main").colorScheme,
              shadows: [...document.querySelectorAll("button, textarea, .panel, .av-dock-host, .composer")]
                .flatMap((el) => [getComputedStyle(el).boxShadow, getComputedStyle(el, "::before").boxShadow]),
              panel: style(".panel").backgroundColor,
              text: style(".panel").color,
              appPanel: style("#app-token").backgroundColor,
              appText: style("#app-token").color,
              commandImage: style(".command-pane").backgroundImage,
              commandColor: style(".command-pane").backgroundColor,
              composerBorder: style(".composer").borderTopWidth,
              composerRadius: style(".composer").borderTopLeftRadius,
              groupOverflow: style(".dv-groupview").overflow,
            };
          });
          expect(styles.scheme).toBe(scheme);
          expect(styles.appScheme).toBe(scheme);
          expect(luminance(styles.text) > luminance(styles.panel)).toBe(scheme === "dark");
          expect(luminance(styles.appText) > luminance(styles.appPanel)).toBe(scheme === "dark");
          expect(styles.shadows.every((shadow) => shadow === "none")).toBe(true);
          if (theme === "deepseek") {
            expect(styles.commandImage).toBe("none");
            expect(styles.commandColor).toBe("rgba(0, 0, 0, 0)");
            expect(styles.composerBorder).toBe("1px");
            expect(Number.parseFloat(styles.composerRadius)).toBeGreaterThan(0);
          }
          expect(["clip", "hidden"]).toContain(styles.groupOverflow);
          expect(await page.locator("#draft[data-original-input=yes]").inputValue()).toBe("theme switch keeps this draft");
          expect(await page.locator("#draft").evaluate((el) => [
            (el as HTMLTextAreaElement).selectionStart, (el as HTMLTextAreaElement).selectionEnd,
          ])).toEqual([2, 8]);
          await page.locator("#draft").focus();
          expect(await page.locator("#draft").evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("solid");
          await page.locator("#select-input").focus();
          expect(await page.locator(".ant-select").evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("solid");
        }
        // Reload uses the stored light choice even though the OS is now dark.
        await page.reload();
        await page.addScriptTag({ content: schemeScript });
        expect(await page.locator("html").getAttribute("data-color-scheme")).toBe("light");
        await page.locator("#system-mode").click();
        expect(await page.locator("html").getAttribute("data-color-scheme")).toBe("dark");
        await page.emulateMedia({ colorScheme: "light" });
        await page.waitForFunction(() => document.documentElement.dataset.colorScheme === "light");
      } finally { await page.close(); }
    });
  }
});
