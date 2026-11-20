import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { viewFrameCsp } from "../../web-trust/src/frame.js";
import { escapeInlineScriptMarkup } from "../../agent-view-build/src/build.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const pathLiteral = (path: string) => JSON.stringify(resolve(repo, path));
type Fixture = { html: string; policy: string };

// Build each actual transcript adapter in its own bundle. The App stays in an
// opaque frame under the production hash policy; no Mermaid renderer is mocked.
async function fixture(view: boolean): Promise<Fixture> {
  const root = resolve(repo, view ? "packages/agent-sessions-view" : "packages/dashboard-web");
  const entry = resolve(root, "mermaid.fixture.tsx");
  const source = `
    import { createElement as h, useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { ${view ? "TranscriptView" : "SessionChat"} as Chat } from ${pathLiteral(view
      ? "packages/agent-sessions-view/src/components/Transcript.tsx"
      : "packages/dashboard-web/src/transcript/SessionChat.tsx")};
    import ${pathLiteral("packages/chat-ui-commons/src/transcript-ui.css")};
    function App() {
      const [text, setText] = useState('');
      globalThis.setDiagram = setText;
      return h(Chat, { resource: 'fixture', status: undefined, busy: false,
        onLoadOlder() {}, data: { offset: 0, totalMessages: 1,
          messages: [{ role: 'assistant', blocks: [{ type: 'text', text }] }] } });
    }
    createRoot(document.getElementById('root')).render(h(App));
  `;
  const built = await build({
    configFile: false, root, logLevel: "error",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    esbuild: { jsx: "automatic", jsxDev: false },
    plugins: [{ name: "mermaid-fixture", resolveId: (id) => id === entry ? entry : undefined,
      load: (id) => id === entry ? source : undefined }],
    build: { write: false, minify: false, cssCodeSplit: false,
      lib: { entry, formats: ["iife"], name: "MermaidFixture" } },
  });
  const output = Array.isArray(built) ? built[0] : built;
  if (!("output" in output)) throw new Error("missing fixture bundle");
  const chunks = output.output.filter((item) => item.type === "chunk");
  expect(chunks).toHaveLength(1);
  const js = escapeInlineScriptMarkup(chunks[0]!.code);
  const css = output.output.flatMap((item) => item.type === "asset" && item.fileName.endsWith(".css")
    ? [String(item.source)] : []).join("\n") + "\nbody { margin: 8px; } #root { min-width: 0; width: 100%; }";
  const sha = (text: string) => createHash("sha256").update(text).digest("base64");
  const policy = viewFrameCsp({ scriptHash: sha(js), styleHash: sha(css), frameAncestors: ["http://dashboard.test"] });
  return {
    policy,
    html: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <style>${css}</style><div id="root"></div><script>${js}</script>`,
  };
}

describe("Mermaid in both conversation surfaces", () => {
  let browser: Browser;
  let dashboard: Fixture;
  let view: Fixture;
  beforeAll(async () => {
    dashboard = await fixture(false);
    view = await fixture(true);
    browser = await chromium.launch({ headless: true });
  }, 180_000);
  afterAll(async () => { await browser?.close(); });

  it("draws real Chinese flowcharts under CSP in the trusted page and opaque View, without network or page overflow", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
    const errors: string[] = [];
    const requests: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (entry) => { if (entry.type() === "error") errors.push(entry.text()); });
    page.on("request", (request) => requests.push(request.url()));
    await page.route("http://dashboard.test/", (route) => route.fulfill({
      contentType: "text/html", body: dashboard.html,
      headers: { "Content-Security-Policy": dashboard.policy.replace("frame-src blob:", "frame-src http://view.test") },
    }));
    await page.route("http://view.test/", (route) => route.fulfill({
      contentType: "text/html", body: view.html, headers: { "Content-Security-Policy": view.policy },
    }));
    try {
      await page.goto("http://dashboard.test/");
      await page.evaluate(() => {
        const frame = document.createElement("iframe");
        frame.sandbox.add("allow-scripts");
        frame.src = "http://view.test/";
        frame.style.width = "100%";
        frame.style.height = "500px";
        frame.style.border = "0";
        document.body.append(frame);
      });
      const frame = await (await page.locator("iframe").elementHandle())!.contentFrame();
      expect(frame).not.toBeNull();
      const source = "flowchart LR\n A[当前变更与工作依赖] --> B[识别需要补充的判断]\n C[历史工单与参与证据] --> B\n B --> D[提供适用的历史材料]\n B --> E[推荐能补充判断的人]\n D --> F[记录结论与依据]\n E --> F\n F --> G[更新契约、测试和参与证据]\n G --> C";
      for (const surface of [page, frame!]) {
        await surface.waitForFunction(() => typeof (globalThis as unknown as { setDiagram?: unknown }).setDiagram === "function");
        const setDiagram = async (value: string) => surface.evaluate((text) => {
          (globalThis as unknown as { setDiagram(text: string): void }).setDiagram(text);
        }, `\`\`\`mermaid\n${value}\n\`\`\``);
        await setDiagram(source);
        const image = surface.locator("[data-mermaid-diagram] img");
        await expect.poll(() => image.evaluate((element) => {
          const image = element as HTMLImageElement;
          return image.complete && image.naturalWidth > 400 && image.naturalHeight > 50;
        }).catch(() => false), { timeout: 10_000 }).toBe(true);
        expect(await image.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThan(50);
        expect(await image.evaluate((element) => element.parentElement!.scrollWidth > element.parentElement!.clientWidth)).toBe(true);
        expect(await surface.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
        await surface.locator("[data-mermaid-diagram] summary").click();
        expect(await surface.locator("[data-mermaid-diagram] code").textContent()).toBe(`${source}\n`);
        // SVG labels and styling remain inside a browser image even if source
        // attempts to introduce executable markup or external resources.
        await setDiagram('flowchart LR\n A["<img src=https://evil.test/x onerror=alert(1)>"] --> B[安全]\n style B fill:url(https://evil.test/style)');
        await expect.poll(() => image.count(), { timeout: 10_000 }).toBe(1);
        expect(await surface.locator("[data-mermaid-diagram] svg, [data-mermaid-diagram] script, [data-mermaid-diagram] iframe").count()).toBe(0);
        await setDiagram("flowchart WRONG\n A --> B");
        await expect.poll(() => surface.locator("[data-mermaid-diagram] [role=status]").textContent(), { timeout: 10_000 }).toContain("请检查语法");
        expect(await image.count()).toBe(0);
        await setDiagram(source);
        await expect.poll(() => image.count(), { timeout: 10_000 }).toBe(1);
      }
      expect(await frame!.evaluate(() => { try { void parent.document; return false; } catch { return true; } })).toBe(true);
      expect(requests.filter((url) => !url.startsWith("data:"))).toEqual(["http://dashboard.test/", "http://view.test/"]);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30_000);
});
