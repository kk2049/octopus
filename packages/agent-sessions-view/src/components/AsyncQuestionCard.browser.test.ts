// @vitest-environment node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, type Browser } from "playwright";
import { build } from "vite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { parseSessionRich } from "../../../../plugins/sessions/src/parse.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
let browser: Browser;
let html: string;
const evidenceDir = process.env.OCTOPUS_ASYNC_QUESTION_EVIDENCE_DIR;
beforeAll(async () => {
  const root = resolve(repo, "packages/agent-sessions-view");
  const entry = resolve(root, "async-question.fixture.tsx");
  const parsed = parseSessionRich("codex", JSON.stringify({ type: "response_item", payload: {
    type: "function_call", name: "functions.request_user_input_async", call_id: "browser-q",
    arguments: JSON.stringify({ questions: [{ title: "选择发布范围", options: ["仅内部", "公开"] }, { title: "补充说明" }] }),
  } }));
  const source = `
    import { createElement as h, useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { AsyncQuestions } from ${JSON.stringify(resolve(root, "src/components/AsyncQuestionCard.tsx"))};
    import ${JSON.stringify(resolve(root, "src/chat-controls.css"))};
    import ${JSON.stringify(resolve(root, "src/sessions.css"))};
    const listeners = new Set();
    const persistence = {
      get: resource => ({text: localStorage.getItem('ignored:' + resource) || '', updatedAt: 0}),
      set: (resource, text) => { localStorage.setItem('ignored:' + resource, text); listeners.forEach(listener => listener()); },
      subscribe: (_resource, listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    };
    function App() {
      const [transcript, setTranscript] = useState(${JSON.stringify({ offset: 0, messages: parsed.messages })});
      const [pending, setPending] = useState([]);
      const [count, setCount] = useState(0);
      return h('main', null,
        h('button', {onClick: () => setTranscript({...transcript, messages: [...transcript.messages]})}, '刷新投影'),
        h('button', {onClick: () => {
          setTranscript({...transcript, messages: [...transcript.messages, {role:'user', blocks:[{type:'text', text:pending[0].prompt}]}]});
          setPending([]);
        }, disabled: !pending.length}, '同步会话记录'),
        h('output', null, '发送次数：' + count),
        h(AsyncQuestions, {scope:'resource-a', persistence, transcript, canSend:true, pendingSends:pending, onSend:prompt => {
          setCount(n => n + 1);
          setPending([{key:'one', resource:'r', prompt, kind:'append', phase:'running', message:'', projectionSequence:1,
            absoluteMessageEnd:1, input:{phase:'local_queued', evidence:'local_queue', at:'now'}}]);
        }}));
    }
    createRoot(document.getElementById('root')).render(h(App));`;
  const built = await build({ configFile: false, root, logLevel: "error", esbuild: { jsx: "automatic", jsxDev: false },
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [{ name: "async-questions", resolveId: (id) => id === entry ? entry : undefined, load: (id) => id === entry ? source : undefined }],
    build: { write: false, minify: false, cssCodeSplit: false, lib: { entry, formats: ["iife"], name: "AsyncQuestionsFixture" } },
  });
  const result = Array.isArray(built) ? built[0] : built;
  if (!("output" in result)) throw new Error("missing fixture bundle");
  const js = result.output.filter((item) => item.type === "chunk").map((item) => item.code).join("\n").replace(/<\/script/gi, "<\\/script");
  const css = result.output.flatMap((item) => item.type === "asset" && item.fileName.endsWith(".css") ? [String(item.source)] : []).join("\n");
  html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>${css} *{box-sizing:border-box} body{margin:0;font:14px sans-serif} main{padding:12px;max-width:900px}</style>
    <div id="root"></div><script>${js}</script>`;
  if (evidenceDir) {
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(resolve(evidenceDir, "index.html"), html);
  }
  browser = await chromium.launch({ headless: true });
}, 120_000);
afterAll(async () => { await browser?.close(); });

it.each([390, 1440])("answers native parsed questions and reconciles after refresh at %ipx", async (width) => {
  const page = await browser.newPage({ viewport: { width, height: 850 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.route("http://async-questions.test/", (route) => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto("http://async-questions.test/");
    await page.getByLabel("仅内部", { exact: true }).check();
    await page.getByLabel("回答", { exact: true }).fill("保留人工验收");
    await page.getByRole("button", { name: "刷新投影" }).click();
    expect(await page.getByLabel("回答", { exact: true }).inputValue()).toBe("保留人工验收");
    await page.getByRole("button", { name: "发送回答", exact: true }).click();
    expect(await page.getByRole("button", { name: "发送回答", exact: true }).isDisabled()).toBe(true);
    expect(await page.locator("output").textContent()).toBe("发送次数：1");
    await page.getByText("已在本地排队，等待 Agent 接收", { exact: true }).waitFor();
    await page.getByRole("button", { name: "同步会话记录" }).click();
    await page.getByText("异步问题 · 0 组未确认", { exact: true }).waitFor();
    expect(await page.getByRole("button", { name: "发送回答", exact: true }).count()).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30_000);

it.each([390, 1440])("ignores questions without sending or reopening on refresh/reload at %ipx", async (width) => {
  const page = await browser.newPage({ viewport: { width, height: 850 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.route("http://async-questions.test/", (route) => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto("http://async-questions.test/");
    await page.getByLabel("回答", { exact: true }).fill("无需提交的草稿");
    await page.getByRole("button", { name: "忽略", exact: true }).click();
    await page.getByText("异步问题 · 0 组未确认", { exact: true }).waitFor();
    expect(await page.locator("output").textContent()).toBe("发送次数：0");
    const history = page.locator("details").filter({ has: page.locator("summary", { hasText: /^已忽略 · 1 组$/ }) }).last();
    expect(await history.getAttribute("open")).toBeNull();
    await page.getByRole("button", { name: "刷新投影" }).click();
    expect(await history.getAttribute("open")).toBeNull();
    await page.reload();
    const outer = page.locator("details").filter({ has: page.locator("summary", { hasText: /^异步问题 · 0 组未确认$/ }) });
    await outer.waitFor();
    expect(await outer.getAttribute("open")).toBeNull();
    await page.getByText("异步问题 · 0 组未确认", { exact: true }).click();
    await page.getByText("已忽略 · 1 组", { exact: true }).click();
    await page.getByText("已忽略", { exact: true }).waitFor();
    await page.getByText("查看问题", { exact: true }).click();
    await page.getByText("选择发布范围", { exact: true }).waitFor();
    expect(await page.getByRole("button", { name: "发送回答", exact: true }).count()).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (evidenceDir) await page.screenshot({ path: resolve(evidenceDir, `ignored-${width}.png`) });
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30_000);
