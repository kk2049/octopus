import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const dashboardCss = readFileSync(resolve(here, "tokens.css"), "utf8");
const viewCss = readFileSync(resolve(here, "../../../agent-view-react/src/styles.css"), "utf8");

// Use the production cascade: important base rules must survive Ant and later
// module styles. The small inherited adjustment models mobile text preferences,
// not full-page/pinch zoom or the native iOS keyboard (unavailable in Linux).
function fixture(css: string, adjustment: number): string {
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>
      @layer base, antd;
      @layer base { ${css} }
      @layer antd { input, textarea, select { font-size: 11px; } }
      html { font-size: 10px; --av-font-control: 12px; }
      body { font-size: 12px; -webkit-text-size-adjust: ${adjustment}%; text-size-adjust: ${adjustment}%; }
      input, textarea, select, [contenteditable] { font-size: 10px; }
      .composer { display: grid; grid-template-columns: minmax(0, 1fr) auto; }
      textarea { width: 100%; min-width: 0; }
      button { font-size: 12px; }
    </style>
    <p id="copy">正文保持读者设置</p>
    <input id="search" type="search" style="font-size: 9px">
    <select id="select"><option>选项</option></select>
    <div contenteditable="" id="empty-editor">编辑</div>
    <div contenteditable="true" id="editor">编辑</div>
    <div contenteditable="plaintext-only" id="plain-editor">编辑</div>
    <div contenteditable="false" id="readonly">只读</div>
    <div class="composer"><textarea id="composer" class="av-textarea ant-input"></textarea><button id="send">发送</button></div>`;
}

for (const engine of [chromium, webkit]) {
  describe(`${engine.name()} mobile control text`, () => {
    let browser: Browser;
    beforeAll(async () => { browser = await engine.launch({ headless: true }); });
    afterAll(async () => { await browser?.close(); });

    for (const width of [390, 844]) {
      it(`keeps editable text safe at ${width}px in the page and an opaque View`, async () => {
        const context = await browser.newContext({ viewport: { width, height: 650 }, isMobile: true, hasTouch: true });
        const page = await context.newPage();
        try {
          for (const adjustment of [50, 75, 100]) {
            await page.setContent(fixture(dashboardCss, adjustment));
            await page.evaluate((html) => {
              const iframe = document.createElement("iframe");
              iframe.setAttribute("sandbox", "allow-scripts");
              iframe.style.cssText = "width:100%;height:300px;border:0";
              iframe.srcdoc = html;
              document.body.append(iframe);
            }, fixture(viewCss, adjustment));
            const iframe = await page.locator("iframe").elementHandle();
            const frame = await iframe!.contentFrame();
            await frame!.locator("#composer").waitFor();

            for (const surface of [page, frame!]) {
              const styles = await surface.evaluate(() => {
                const read = (id: string) => {
                  const style = getComputedStyle(document.getElementById(id)!);
                  return { size: Number.parseFloat(style.fontSize), adjust: style.getPropertyValue("text-size-adjust") || style.getPropertyValue("-webkit-text-size-adjust"), zoom: style.getPropertyValue("-webkit-text-zoom") };
                };
                return {
                  controls: ["search", "empty-editor", "editor", "plain-editor", "composer"].map(read),
                  select: read("select"), copy: read("copy"), send: read("send"), readonly: read("readonly"),
                  supportsAdjust: CSS.supports("text-size-adjust", "100%") || CSS.supports("-webkit-text-size-adjust", "100%"),
                  supportsTextZoom: CSS.supports("-webkit-text-zoom", "reset"),
                };
              });
              for (const control of styles.controls) {
                expect(control.size).toBeGreaterThanOrEqual(16);
                if (styles.supportsAdjust) expect(control.adjust).toBe("100%");
                if (styles.supportsTextZoom) expect(control.zoom).toBe("reset");
              }
              if (styles.supportsAdjust) {
                expect(styles.copy.adjust).toBe(`${adjustment}%`);
                expect(styles.send.adjust).toBe(`${adjustment}%`);
              }
              const textScale = styles.supportsAdjust ? adjustment / 100 : 1;
              expect(styles.copy.size).toBe(12 * textScale);
              if (surface === page) expect(styles.select.size).toBe(10 * textScale);
              expect(styles.send.size).toBe(12 * textScale);
              expect(styles.readonly.size).toBe(10 * textScale);
              await surface.locator("#composer").fill("保留草稿");
              expect(await surface.locator("#composer").inputValue()).toBe("保留草稿");
              expect(await surface.locator("#send").evaluate((button) => {
                const rect = button.getBoundingClientRect();
                return rect.width > 0 && rect.left >= 0 && rect.right <= document.documentElement.clientWidth;
              })).toBe(true);
            }
          }
        } finally { await context.close(); }
      });
    }

    it("keeps language and style selectors compact in a foldable desktop viewport", async () => {
      const context = await browser.newContext({ viewport: { width: 980, height: 650 }, isMobile: true, hasTouch: true });
      const page = await context.newPage();
      try {
        await page.setContent(fixture(dashboardCss, 100));
        await page.addStyleTag({ content: `:root { --mobile-control-font-size: 40.21px; } #select { font-size: 13px; width: 160px; }` });
        expect(await page.locator("#select").evaluate(element => getComputedStyle(element).fontSize)).toBe("13px");
        expect(await page.locator("#composer").evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeCloseTo(40.21, 2);
        await page.locator("#select").selectOption({ label: "选项" });
      } finally { await context.close(); }
    });

    it("keeps desktop controls compact", async () => {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      try {
        for (const css of [dashboardCss, viewCss]) {
          await page.setContent(fixture(css, 100));
          expect(await page.locator("#composer").evaluate((element) => getComputedStyle(element).fontSize)).toBe("10px");
        }
      } finally { await page.close(); }
    });
  });
}
