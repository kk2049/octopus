import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { build } from "vite";
import { afterAll, beforeAll, expect, it } from "vitest";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const path = (file: string) => JSON.stringify(resolve(repo, file));
let browser: Browser;
let html: string;

beforeAll(async () => {
  const root = resolve(repo, "packages/dashboard-web");
  const entry = resolve(root, "ticket-chat.fixture.tsx");
  const source = `
    import { createElement as h, useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { SessionChat } from ${path("packages/dashboard-web/src/transcript/SessionChat.tsx")};
    import { ticketChatReceipts } from ${path("packages/dashboard-web/src/pages/tickets/chat-receipts.ts")};
    import { SendReceipt, SHARED_CHAT_CLASSES } from ${path("packages/chat-ui-commons/src/transcript-ui.ts")};
    import ${path("packages/chat-ui-commons/src/transcript-ui.css")};
    const row = {id:1, author:'lht', via:'web', body:'QUEUED INPUT', created_at:'2026-09-16T06:00:01Z', delivered_turn:null};
    function App() {
      const [phase, setPhase] = useState(0);
      const [longRun, setLongRun] = useState(false);
      const [receiptMode, setReceiptMode] = useState(false);
      const [restored, setRestored] = useState(0);
      const [dismissed, setDismissed] = useState(0);
      if (receiptMode) return h('main', null,
        h(SendReceipt, { classes: SHARED_CHAT_CLASSES,
          entry: { prompt: 'TMUX INPUT', phase: 'uncertain', message: '结果无法确认 — 请核对本机 CLI',
            input: { phase: 'dispatched', evidence: 'terminal_write', at: '2026-09-17T07:58:00Z' } },
          onRestore: () => setRestored(n => n + 1), onDismiss: () => setDismissed(n => n + 1) }),
        h(SendReceipt, { classes: SHARED_CHAT_CLASSES, entry: { prompt: 'REFUSED INPUT', phase: 'refused', message: 'Gate 拒绝' } }),
        h('output', null, 'restored=' + restored + ', dismissed=' + dismissed));
      const messages = Array.from({length:60},(_,i)=>({role:longRun?'user':i%2?'assistant':'user',
        timestamp:'2026-09-16T06:00:00Z', text: i%2?'ANSWER '+i:'USER '+i+' '+('这是保持右对齐的多行用户消息。'.repeat(18))}));
      messages.push({role:'user',timestamp:'2026-09-16T06:00:00Z',text:'SHORT USER'});
      if (phase>=1) messages.push({role:'assistant',timestamp:'2026-09-16T06:00:02Z',text:'NEW ANSWER'});
      if (phase>=3) messages.push({role:'user',timestamp:'2026-09-16T06:00:03Z',text:row.body});
      const win = {messages,offset:0,total:messages.length};
      const inbox = [{...row, ...(phase>=2?{delivery_input:JSON.stringify({phase:'provider_accepted',evidence:'provider_ack'})}:{})}];
      const receipts = ticketChatReceipts(inbox,[],win).rows;
      return h('main',null,
        h('nav',null,h('button',{onClick:()=>setPhase(p=>p+1)},'advance'),h('button',{onClick:()=>setLongRun(r=>!r)},'long run'),
          h('button',{onClick:()=>setReceiptMode(true)},'uncertain send')),
        h(SessionChat,{resource:'603',data:{messages,offset:0,totalMessages:messages.length},onLoadOlder:()=>{},
          tail:receipts.map(r=>h('div',{key:r.key,'data-ticket-input':r.key},h(SendReceipt,{entry:r.receipt,classes:SHARED_CHAT_CLASSES})))}));
    }
    createRoot(document.getElementById('root')).render(h(App));`;
  const built = await build({ configFile: false, root, logLevel: "error",
    esbuild: { jsx: "automatic", jsxDev: false },
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [{ name: "ticket-chat-fixture", resolveId: (id) => id === entry ? entry : undefined, load: (id) => id === entry ? source : undefined }],
    build: { write: false, minify: false, cssCodeSplit: false, lib: { entry, formats: ["iife"], name: "TicketChatFixture" } },
  });
  const result = Array.isArray(built) ? built[0] : built;
  if (!("output" in result)) throw new Error("missing fixture bundle");
  const js = result.output.filter((item) => item.type === "chunk").map((item) => item.code).join("\n").replace(/<\/script/gi, "<\\/script");
  const css = result.output.flatMap((item) => item.type === "asset" && item.fileName.endsWith(".css") ? [String(item.source)] : []).join("\n");
  html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <script id="octopus-bootstrap" type="application/json">{"viewer":{"username":"test"},"csrfCookieNames":[]}</script>
    <style>${css}\n*{box-sizing:border-box}body{margin:0;font:14px/1.6 sans-serif;--user-bg:#e6f0ff;--muted:#64748b;--card:white;--line:#ddd}
    main{height:100dvh;display:flex;flex-direction:column;padding:12px;min-width:0}
    .av-chat-transcript{--av-chat-user-max-width:min(560px,82%)}
    </style><div id="root"></div><script>${js}</script>`;
  browser = await chromium.launch({ headless: true });
}, 120_000);
afterAll(async () => { await browser?.close(); });

it.each([390, 1440])("aligns virtualized user messages and settles inline input at %ipx", async (width) => {
  const page = await browser.newPage({ viewport: { width, height: 850 } });
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.setContent(html);
    const pending = page.locator("[data-ticket-input]");
    await pending.waitFor();
    await expect.poll(() => page.locator("[data-av-virtual-list]").count()).toBeGreaterThan(0);
    // Compare actual pixel geometry after virtual measurement, not CSS text.
    await expect.poll(async () => page.locator(".av-chat-user-body").evaluateAll((nodes) => {
      const rights = nodes.map((node) => node.getBoundingClientRect().right);
      return Math.max(...rights) - Math.min(...rights);
    })).toBeLessThan(2);
    expect(await page.locator(".ev-send-pending").evaluate((node) => getComputedStyle(node).animationName)).toBe("ev-send-breathe");
    await page.getByRole("button", { name: "advance", exact: true }).click();
    await expect.poll(async () => {
      const answer = await page.getByText("NEW ANSWER", { exact: true }).boundingBox();
      const bubble = await pending.boundingBox();
      return Boolean(answer && bubble && bubble.y >= answer.y + answer.height);
    }).toBe(true);
    await page.getByRole("button", { name: "advance", exact: true }).click();
    await page.locator('[data-av-send-phase="done"]').waitFor();
    expect(await page.locator(".ev-send-pending").count()).toBe(0);
    await page.getByRole("button", { name: "advance", exact: true }).click();
    await pending.waitFor({ state: "detached" });
    expect(await page.getByText("QUEUED INPUT", { exact: true }).count()).toBe(1);
    await page.getByRole("button", { name: "long run", exact: true }).click();
    await expect.poll(async () => page.locator(".av-chat-user-body").evaluateAll((nodes) => {
      const rights = nodes.map((node) => node.getBoundingClientRect().right);
      return Math.max(...rights) - Math.min(...rights);
    })).toBeLessThan(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30_000);

it.each([390, 1440])("shows an unknown terminal write as a finished, neutral outcome with details accessible at %ipx", async (width) => {
  const page = await browser.newPage({ viewport: { width, height: 850 }, reducedMotion: "reduce" });
  try {
    await page.setContent(html);
    await page.getByRole("button", { name: "uncertain send" }).click();
    const label = page.getByText("? 结果未知", { exact: true });
    await label.waitFor();
    const note = page.getByText("可能已送达，不会自动重发。请先查看会话记录，确认没收到再重新发送。", { exact: true });
    expect(await note.isVisible()).toBe(true);
    expect(await label.evaluate((node) => getComputedStyle(node).color)).toBe("rgb(100, 116, 139)");
    expect(await note.evaluate((node) => getComputedStyle(node).color)).toBe("rgb(100, 116, 139)");
    expect(await label.evaluate((node) => getComputedStyle(node).animationName)).toBe("none");
    expect(await page.getByText("Gate 拒绝", { exact: true }).evaluate((node) => getComputedStyle(node).color)).toBe("rgb(185, 28, 28)");
    const original = page.getByText("结果无法确认 — 请核对本机 CLI", { exact: true });
    expect(await original.isVisible()).toBe(false);
    expect(await page.getByRole("button", { name: "放回输入框" }).count()).toBe(0);
    expect(await page.locator("output").textContent()).toBe("restored=0, dismissed=0");

    await page.getByText("查看发送详情", { exact: true }).focus();
    await page.keyboard.press("Enter");
    expect(await original.isVisible()).toBe(true);
    await page.getByRole("button", { name: "放回输入框" }).click();
    await page.getByRole("button", { name: "清除", exact: true }).click();
    expect(await page.locator("output").textContent()).toBe("restored=1, dismissed=1");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await page.close(); }
}, 30_000);
