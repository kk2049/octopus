/// <reference lib="dom" />
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import { chromium, webkit, type Browser } from "playwright";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scopeAppCss } from "./scope-css.js";
import { renderAgentViewThemeCss } from "./theme-tokens.js";
import { discoverPresentationGroups, measurePresentation, presentationFailures, type PresentationGroup } from "./presentation-audit.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const file = (path: string) => JSON.stringify(resolve(repo, path));
const themes = ["classic", "aurora", "ink", "feishu", "deepseek", "apple"];
const cssFiles = execFileSync("git", ["ls-files", "packages/*/src/*.css"], { cwd: repo, encoding: "utf8" }).trim().split("\n");
let html: string;

// Real adapters and Markdown renderers, with production cascade/scoping. No
// service, credentials, business mutations or synthetic Ant DOM are involved.
async function gallery(): Promise<string> {
  const root = resolve(repo, "packages/dashboard-web");
  const entry = resolve(root, "presentation-audit.fixture.tsx");
  const source = `
    import { createRoot } from "react-dom/client";
    import { DashboardUiProvider } from ${file("packages/dashboard-web/src/ui-kit/UiProvider.tsx")};
    import { UiInput, UiPasswordInput, UiSelect, UiButton } from ${file("packages/dashboard-web/src/ui-kit/primitives.tsx")};
    import { Markdown } from ${file("packages/dashboard-web/src/ui/Markdown.tsx")};
    import { Markdown as AppMarkdown } from ${file("packages/agent-view-react/src/ui.tsx")};
    import { AvInput, AvButton, AvTextArea } from ${file("packages/agent-view-react/src/controls.tsx")};
    import { initTheme, applyTheme, initMobileControlFont } from ${file("packages/dashboard-web/src/styles/themes.ts")};
    import ${file("packages/dashboard-web/src/styles/index.css")};
    import ${file("packages/agent-view-react/src/styles-index.css")};
    import ${file("packages/chat-ui-commons/src/transcript-ui.css")};
    import ${file("packages/agent-sessions-view/src/sessions.css")};
    initTheme("classic");
    initMobileControlFont();
    window.auditTheme = theme => {
      applyTheme(theme);
      document.querySelector("[data-app-surface]").setAttribute("data-av-theme", theme);
    };
    const prose = "普通正文 [网页链接](https://example.test/) [文件链接](/workspace/example.ts)\\n\\n连续正文\\n\\n## 标题\\n\\n### 小标题";
    createRoot(document.getElementById("root")).render(
      <DashboardUiProvider>
        <main>
          <div className="audit-controls">
            <UiButton>操作一</UiButton><UiButton tone="primary">操作二</UiButton>
            <UiInput aria-label="名称" value="字段内容" readOnly />
            <UiPasswordInput aria-label="密码" defaultValue="example" />
            <UiSelect aria-label="模型" value="one" options={[{value:"one",label:"选项一"}]} />
          </div>
          <div className="audit-prose"><Markdown onOpenFile={() => {}}>{prose}</Markdown></div>
          <div data-app-surface="audit" data-av-theme="classic">
            <div className="audit-app-controls">
              <AvButton>操作一</AvButton><AvButton tone="primary">操作二</AvButton>
              <AvInput aria-label="App名称" defaultValue="字段内容" />
            </div>
            <AppMarkdown>{prose}</AppMarkdown>
            <div className="audit-session-list">
              <div className="sess"><div className="t">同类会话标题</div><div className="m">同类会话说明</div></div>
              <div className="directory-session"><div className="sess"><div className="t">同类会话标题</div><div className="m">同类会话说明</div></div></div>
            </div>
            <div className="tools"><AvInput aria-label="搜索会话" /><AvButton>搜索</AvButton></div>
            <div className="wsrow"><span>目录</span><AvButton className="directory-sessions-trigger">3</AvButton></div>
            <AvTextArea aria-label="App输入" defaultValue="保留草稿" />
            <div className="audit-native-controls"><input aria-label="只读输入" defaultValue="可复制文字" readOnly />
              <select aria-label="原生选择"><option>选项</option></select></div>
          </div>
          <div className="av-chat-transcript">
            <details className="av-chat-todo-card av-chat-card" open><summary className="av-chat-card-head">
              <span className="av-chat-todo-title">任务进度</span><span className="av-chat-todo-count">1 / 3</span>
            </summary></details>
          </div>
        </main>
      </DashboardUiProvider>);
  `;
  const result = await build({
    configFile: false, root, logLevel: "error",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    esbuild: { jsx: "automatic", jsxDev: false },
    plugins: [{
      name: "presentation-gallery", enforce: "pre",
      resolveId: id => id === entry ? entry : undefined,
      load: id => id === entry ? source : undefined,
      transform: (code, id) => id.endsWith("/agent-view-react/src/styles-index.css")
        ? code.replace("/* @claude-bot/agent-view-build:theme-tokens */", `@layer agent-view-base { ${renderAgentViewThemeCss()} }`) : undefined,
    }],
    css: { postcss: { plugins: [{
      postcssPlugin: "presentation-scope",
      Once(root) {
        const path = root.source?.input.file ?? "";
        if (path.includes("/agent-view-react/") || path.includes("/agent-sessions-view/")) scopeAppCss(root);
      },
    }] } },
    build: { write: false, minify: false, cssCodeSplit: false, lib: { entry, formats: ["iife"], name: "PresentationGallery" } },
  });
  const output = Array.isArray(result) ? result[0] : result;
  if (!("output" in output)) throw new Error("expected gallery bundle");
  const js = output.output.filter(item => item.type === "chunk").map(item => item.code).join("\n");
  const css = output.output.flatMap(item => item.type === "asset" && item.fileName.endsWith(".css") ? [String(item.source)] : []).join("\n");
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>${css}</style><style>
      body { overflow:auto; } #root { height:auto; }
      main { padding:16px; min-width:0; }
      .audit-controls, .audit-app-controls { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
      .audit-controls > input, .audit-controls > .ant-input-affix-wrapper { width:140px; }
      [data-app-surface] { font:14px/1.6 var(--av-font); margin-top:16px; }
      .audit-app-controls > input { width:140px; }
      .audit-prose, .av-prose { margin:16px 0; }
      .audit-session-list { max-width:400px; }
      .tools { max-width:400px; }
    </style>
    <script type="application/json" id="octopus-bootstrap">{"viewer":{},"pageProps":{}}</script>
    <div id="root"></div><script>${js.replaceAll("</script", "<\\/script")}</script>`;
}

beforeAll(async () => { html = await gallery(); }, 120_000);

for (const engine of [chromium, webkit]) describe(engine.name(), () => {
  let browser: Browser;
  beforeAll(async () => { browser = await engine.launch(); });
  afterAll(async () => { await browser?.close(); });

  it("audits typography declaration syntax across every tracked frontend stylesheet", async () => {
    const declarations: Array<{ file: string; line: number; selector: string; property: string; value: string }> = [];
    for (const path of cssFiles) {
      postcss.parse(readFileSync(resolve(repo, path), "utf8"), { from: path }).walkDecls(declaration => {
        if (!["font", "font-size", "font-family", "line-height", "align-items", "vertical-align"].includes(declaration.prop)) return;
        declarations.push({ file: path, line: declaration.source?.start?.line ?? 0,
          selector: declaration.parent?.type === "rule" ? declaration.parent.selector : "",
          property: declaration.prop, value: declaration.value });
      });
    }
    const page = await browser.newPage();
    try {
      const invalid = await page.evaluate(rows => rows.filter(row => !CSS.supports(row.property, row.value)), declarations);
      expect(invalid).toEqual([]);
      console.info(`Presentation inventory: ${cssFiles.length} CSS files, ${declarations.length} declarations (${engine.name()})`);
    } finally { await page.close(); }
  });


  it("discovers repeated text roles without flattening headings, captions or editable fields", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<style>
        .card h2 { font-size:20px } .card p { font-size:14px }
        .card small { font-size:11px } .card:nth-child(2) p { font-size:12px }
      </style><main><section class="card"><h2>Title</h2><p>First body</p><small>Caption</small><input></section>
        <section class="card"><h2>Title</h2><p>Second body</p><small>Caption</small><input></section></main>`);
      const groups = await page.evaluate(discoverPresentationGroups, "main");
      expect(groups.length).toBeGreaterThanOrEqual(3);
      const failures = presentationFailures(await page.evaluate(measurePresentation, groups));
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain("P||.fontSize");
      expect(groups.some(group => group.name.includes("INPUT"))).toBe(false);
    } finally { await page.close(); }
  });

  for (const width of [390, 844, 1440]) it(`checks semantic peers in all themes at ${width}px`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, isMobile: width < 1000, hasTouch: width < 1000, reducedMotion: "reduce" });
    page.setDefaultTimeout(5_000);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
      await page.setContent(html);
      await page.locator(".audit-controls .ant-select").waitFor();
      const groups: PresentationGroup[] = [
        { name: "dashboard field heights", selector: ".audit-controls > :is(button, input, .ant-input-affix-wrapper, .ant-select)", typography: false, sameHeight: true },
        { name: "dashboard labels", selector: ".audit-controls .ant-btn > span:not(.ant-btn-icon), .audit-controls .ant-select-content" },
        { name: "dashboard actions", selector: ".audit-controls button.ant-btn", sameHeight: true, align: "center-y" },
        { name: "dashboard body and inline links", selector: ".audit-prose p, .audit-prose p > a, .audit-prose p > button" },
        { name: "app actions", selector: ".audit-app-controls button.ant-btn", sameHeight: true, align: "center-y" },
        { name: "session titles", selector: ".audit-session-list .sess .t", align: "left" },
        { name: "session captions", selector: ".audit-session-list .sess .m", align: "left" },
      ];
      if (width === 1440) groups.push(
        { name: "dashboard control row", selector: ".audit-controls > :is(button, input, .ant-input-affix-wrapper, .ant-select)", sameHeight: true, align: "center-y" },
        { name: "app control row", selector: ".audit-app-controls > :is(button, input)", sameHeight: true, align: "center-y" },
      );
      for (const theme of themes) {
        await page.evaluate(id => (window as unknown as { auditTheme: (value: string) => void }).auditTheme(id), theme);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        // Theme CSS and Ant token insertion commit separately. Assert the settled
        // result with a bounded wait, including the selected label inside Ant.
        await expect.poll(async () => presentationFailures(await page.evaluate(measurePresentation, groups)),
          { message: theme, timeout: 2_000 }).toEqual([]);
        const measurements = await page.evaluate(() => ({
          heading: getComputedStyle(document.querySelector(".audit-prose h2")!).fontSize,
          body: getComputedStyle(document.querySelector(".audit-prose p")!).fontSize,
          inlineMinHeight: getComputedStyle(document.querySelector(".audit-prose p > button")!).minHeight,
          inlineWhiteSpace: getComputedStyle(document.querySelector(".audit-prose p > button")!).whiteSpace,
          input: parseFloat(getComputedStyle(document.querySelector("[data-app-surface] textarea")!).fontSize),
          nativeInputs: Array.from(document.querySelectorAll(".audit-native-controls > *")).map(node => parseFloat(getComputedStyle(node).fontSize)),
          clippedInputs: Array.from(document.querySelectorAll(".audit-controls > input, .audit-controls > .ant-input-affix-wrapper > input, .audit-app-controls > input")).flatMap(node => {
            const css = getComputedStyle(node);
            const required = ["lineHeight", "paddingTop", "paddingBottom", "borderTopWidth", "borderBottomWidth"]
              .reduce((sum, property) => sum + parseFloat(css[property as keyof CSSStyleDeclaration] as string), 0);
            const actual = node.getBoundingClientRect().height;
            return required > actual + 1 ? [{ field: node.getAttribute("aria-label"), required, actual }] : [];
          }),
          directoryCount: document.querySelector(".directory-sessions-trigger")!.getBoundingClientRect().height,
          compactHeight: parseFloat(getComputedStyle(document.querySelector("[data-app-surface]")!).getPropertyValue("--av-control-h-compact")),
          todo: getComputedStyle(document.querySelector(".av-chat-todo-count")!).fontSize,
          font: getComputedStyle(document.querySelector("[data-app-surface]")!).getPropertyValue("--av-font"),
          overflow: document.documentElement.scrollWidth > innerWidth,
        }));
        expect(parseFloat(measurements.heading)).toBeGreaterThan(parseFloat(measurements.body));
        expect(measurements.inlineMinHeight).toBe("0px");
        expect(measurements.inlineWhiteSpace).not.toBe("nowrap");
        expect(measurements.font.trim()).not.toBe("");
        expect(measurements.todo).toBe("11px");
        expect(measurements.clippedInputs, `${theme} at ${width}px`).toEqual([]);
        expect(measurements.directoryCount).toBeCloseTo(measurements.compactHeight, 0);
        if (width < 1000) for (const size of [measurements.input, ...measurements.nativeInputs]) expect(size).toBeGreaterThanOrEqual(16);
        expect(measurements.overflow).toBe(false);
      }
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);
});
