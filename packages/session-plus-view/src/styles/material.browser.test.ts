import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const assets = resolve(here, "../../../dashboard-web/dist/a");
// The host supplies Dock SDK CSS; testing only App CSS misses its material rule.
const hostCss = readdirSync(assets).filter((name) => name.endsWith(".css"))
  .map((name) => readFileSync(resolve(assets, name), "utf8")).join("\n");
const appCss = readFileSync(resolve(here, "../../dist/agent-view.css"), "utf8");
const { scope } = JSON.parse(readFileSync(resolve(here, "../../dist/agent-view.entry.json"), "utf8")) as { scope: string };

// Style regression fixtures deliberately name CSS surfaces: the browser, with
// both production bundles, must resolve the actual cascade in each theme.
const chrome = `<div class="av-dock-workspace"><div class="av-dock-host" data-material="host">
  <div class="dockview-theme-octopus"><div class="dv-tabs-and-actions-container" data-material="tabs"></div></div>
  <div data-av-dock-flow="navigation" data-material="navigation"></div>
  <div class="av-dock-mobile-bar" data-material="mobile"></div>
  <div class="composer-options-card" data-material="composer"></div>
  <div class="directory-sessions-popover" data-material="directory"></div>
  <div class="agent-interaction-card" data-material="interaction"></div>
  <div class="codex-release-dialog" data-material="release"></div>
</div></div>`;

describe("Sessions+ material browser regression", () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
  afterAll(async () => { await browser?.close(); });

  for (const theme of ["classic", "aurora", "ink", "feishu", "deepseek", "apple"]) {
    it(`${theme}: keeps App chrome free of backdrop filtering across colour schemes`, async () => {
      const page = await browser.newPage({ colorScheme: "light" });
      try {
        await page.setContent(`<!doctype html><html data-theme="${theme}"><head><style>${hostCss}\n${appCss}</style></head><body>
          <main data-app-surface="${scope}" data-av-theme="${theme}"><div class="session-plus-app">${chrome}</div><div class="directory-sessions-popover" data-material="portal"></div></main>
          <aside data-app-surface="other-app" data-av-theme="${theme}" id="other-app">${chrome}</aside>
        </body></html>`);
        for (const colorScheme of ["light", "dark"] as const) {
          await page.emulateMedia({ colorScheme });
          const filters = await page.locator("main [data-material]").evaluateAll((nodes) =>
            nodes.map((node) => ({ surface: node.getAttribute("data-material"), filter: getComputedStyle(node).backdropFilter })));
          expect(filters).toHaveLength(9);
          expect(filters.filter(({ filter }) => filter !== "none")).toEqual([]);
        }
        await page.emulateMedia({ colorScheme: "light" });
        if (theme === "apple") {
          expect(await page.locator("#other-app [data-material=host]").evaluate((node) => getComputedStyle(node).backdropFilter))
            .toContain("blur");
        }
      } finally { await page.close(); }
    });
  }
});
