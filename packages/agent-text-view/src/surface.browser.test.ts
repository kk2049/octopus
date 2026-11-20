// @vitest-environment node
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const appDist = resolve(root, "packages/session-plus-view/dist");
const hostAssets = resolve(root, "packages/dashboard-web/dist/a");

// Mount the real shared component against both production CSS bundles. This
// catches the host's input/button defaults as well as CodeMirror's runtime CSS.
// The release and Dashboard must be built before running this browser suite.
describe("text selection and search in Sessions+ CSS", () => {
  let browser: Browser;
  let js: string;
  let css: string;
  let scope: string;

  beforeAll(async () => {
    scope = JSON.parse(readFileSync(resolve(appDist, "agent-view.entry.json"), "utf8")).scope;
    css = readdirSync(hostAssets).filter((name) => name.endsWith(".css"))
      .map((name) => readFileSync(resolve(hostAssets, name), "utf8")).join("\n")
      + readFileSync(resolve(appDist, "agent-view.css"), "utf8");
    const fixture = resolve(here, "virtual-text-surface-fixture.ts");
    const result = await build({
      configFile: false,
      root: resolve(here, ".."),
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
      logLevel: "error",
      plugins: [{
        name: "text-surface-browser-fixture",
        resolveId: (id) => id === fixture ? id : null,
        load(id) {
          if (id.endsWith(".css")) return ""; // Use the actual release CSS above.
          if (id !== fixture) return null;
          return `
            import { createElement } from "react";
            import { createRoot } from "react-dom/client";
            import { CodeMirrorTextSurface } from "./components/CodeMirrorTextSurface.tsx";
            createRoot(document.getElementById("mount")).render(createElement(CodeMirrorTextSurface, {
              doc: "alpha beta\\nsecond alpha\\n", docKey: "fixture", readOnly: false,
              line: null, lineToken: "", ariaLabel: "文件编辑器"
            }));
          `;
        },
      }],
      esbuild: { jsx: "automatic", jsxDev: false },
      build: {
        write: false,
        minify: false,
        lib: { entry: fixture, name: "TextSurfaceFixture", formats: ["iife"] },
      },
    });
    const outputs = Array.isArray(result) ? result : [result];
    js = outputs.flatMap((output) => "output" in output ? output.output : [])
      .filter((output) => output.type === "chunk").map((chunk) => chunk.code).join("\n");
    browser = await chromium.launch({ headless: true });
  }, 120_000);

  afterAll(async () => { await browser?.close(); });

  for (const theme of ["classic", "aurora", "ink", "feishu", "deepseek", "apple"]) {
    it(`${theme}: has visible selections and an unclipped keyboard search at every panel width`, async () => {
      const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
      page.setDefaultTimeout(5_000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      try {
        await page.setContent(`<!doctype html><html data-theme="${theme}"><head><style>${css}</style></head><body>
          <main data-app-surface="${scope}" data-av-theme="${theme}" style="width:900px;height:700px">
            <div class="session-plus-app" id="mount" style="height:100%"></div>
          </main></body></html>`);
        await page.addScriptTag({ content: js });
        const content = page.getByRole("textbox", { name: "文件编辑器" });
        await content.waitFor().catch((error) => {
          throw new Error(`Text surface did not mount: ${errors.join("; ") || String(error)}`);
        });
        await content.click();
        await page.keyboard.press("Control+Home");
        for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowRight");
        expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("alpha");
        expect(await page.locator(".cm-selectionMatch, .cm-searchMatch, .cm-search").count()).toBe(0);

        for (const colorScheme of ["light", "dark"] as const) {
          await page.emulateMedia({ colorScheme });
          await page.locator("html").evaluate((node, scheme) => node.setAttribute("data-color-scheme", scheme), colorScheme);
          const contrast = await page.locator(".cm-line").first().evaluate((line) => {
            const selection = getComputedStyle(line, "::selection");
            const surface = getComputedStyle(line.closest(".cm-editor")!);
            const luminance = (rgb: string) => {
              const channels = rgb.match(/[\d.]+/g)!.slice(0, 3).map((value) => {
                const s = Number(value) / 255;
                return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
              });
              return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
            };
            const ratio = (a: string, b: string) => {
              const [bright, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
              return (bright + 0.05) / (dark + 0.05);
            };
            return {
              text: ratio(selection.color, selection.backgroundColor),
              area: ratio(surface.backgroundColor, selection.backgroundColor),
            };
          });
          expect(contrast.text).toBeGreaterThanOrEqual(4.5);
          expect(contrast.area).toBeGreaterThanOrEqual(3);
        }

        await page.keyboard.press("Control+f");
        const search = page.getByRole("textbox", { name: "查找内容" });
        expect(await search.inputValue()).toBe("alpha");
        await page.waitForFunction(() => document.querySelectorAll(".cm-searchMatch").length === 2);
        await search.press("Enter");
        expect(await page.locator(".cm-searchMatch-selected").textContent()).toBe("alpha");
        const screenshotDir = process.env.TEXT_SURFACE_SCREENSHOT_DIR;
        for (const width of [900, 480, 320]) {
          await page.locator("main").evaluate((node, value) => { node.style.width = `${value}px`; }, width);
          const layout = await page.locator(".cm-search").evaluate((panel) => {
            const rect = panel.getBoundingClientRect();
            const children = [...panel.children].filter((child) => child.tagName !== "BR");
            const boxes = children.map((child) => child.getBoundingClientRect());
            return {
              clipped: boxes.some((box) => box.left < rect.left || box.right > rect.right + 1),
              overlaps: boxes.some((box, i) => boxes.slice(i + 1).some((other) =>
                Math.min(box.right, other.right) - Math.max(box.left, other.left) > 1
                && Math.min(box.bottom, other.bottom) - Math.max(box.top, other.top) > 1)),
              textClipped: children.some((child) => child.scrollWidth > child.clientWidth + 1),
            };
          });
          expect(layout).toEqual({ clipped: false, overlaps: false, textClipped: false });
          if (screenshotDir && theme === "classic") {
            mkdirSync(screenshotDir, { recursive: true });
            await page.screenshot({ path: resolve(screenshotDir, `search-${width}.png`) });
          }
        }
        await page.getByRole("textbox", { name: "替换为" }).fill("changed");
        // The native panel commits on keyup/change, just as normal typing does.
        await page.getByRole("textbox", { name: "替换为" }).press("Tab");
        await page.getByRole("button", { name: "全部替换", exact: true }).click();
        expect(await content.textContent()).toBe("changed betasecond changed");
        await search.press("Escape");
        expect(await page.locator(".cm-search, .cm-searchMatch, .cm-selectionMatch").count()).toBe(0);
        expect(await content.evaluate((node) => node === document.activeElement)).toBe(true);
      } finally {
        await page.close();
      }
    }, 30_000);
  }
});
