/** Opt-in phone checks against the packaged App, real Dashboard and temporary project. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { chromium, webkit, type Locator } from "playwright";
import type { ResearchNode, ResearchEvidence } from "@claude-bot/research-canvas-contract";
import type { ResearchWorkspaceMcp } from "./workspace-mcp.js";

export async function browserMobileAcceptance(input: { base: string; instance: string; browser: string; cookies: string[]; artifacts: string; workspace: ResearchWorkspaceMcp }) {
  const engine = process.env.RESEARCH_TEST_WEBKIT ? "webkit" : "chromium";
  const browser = engine === "webkit" ? await webkit.launch({ executablePath: process.env.RESEARCH_TEST_WEBKIT }) : await chromium.launch({ executablePath: input.browser });
  mkdirSync(input.artifacts, { recursive: true });
  const checks: string[] = [], errors: string[] = [];
  const add = async (id: string, data: Record<string, unknown>) => (await input.workspace.platform("node_add", { request: `mobile:${id}`, data }) as { node: ResearchNode }).node;
  try {
    const note = await add("note", { type: "note", title: "手机长笔记", data: { text: Array.from({ length: 50 }, (_, i) => `第 ${i + 1} 段：保留研究过程和待验证的结论。`).join("\n\n") } });
    const file = await add("file", { type: "file", title: "手机材料.md" });
    const audio = await add("audio", { type: "audio", title: "手机会议录音" });
    const folder = await add("folder", { type: "folder", title: "手机测试子图", data: { members: [note.id, file.id, audio.id] } });
    await input.workspace.platform("edge_add", { request: "mobile:edge", source: note.id, target: file.id, label: "手机核对" });
    const report = (await input.workspace.platform("evidence_publish", { request: "mobile:report", data: { title: "手机验证报告", series: "mobile", kind: "literature", claim: "observation", conclusion: "仍待独立验收。", motivation: "验证移动阅读", goal: "所有操作可达", design: "多尺寸", execution: "隔离测试", results: "长路径 /work/" + "long-path/".repeat(20), analysis: "保留真实状态", sources: [note.id] } })).report as unknown as ResearchEvidence;
    // A small, explicitly positioned scope gives the relationship controls a
    // stable visible curve; unrelated upload/create cases may add distant nodes.
    const edgeScope = await add("edge-scope", { type: "folder", title: "手机关系验收", data: { members: [note.id, file.id] } });
    const layout = await input.workspace.platform("layout_read");
    await input.workspace.platform("layout_move", { request: "mobile:positions", revision: layout.revision, positions: { [edgeScope.id]: { x: 0, y: -400 }, [note.id]: { x: 0, y: 0 }, [file.id]: { x: 800, y: 0 } } });
    for (const viewport of [{ width: 320, height: 568 }, { width: 360, height: 780 }, { width: 390, height: 844 }, { width: 430, height: 932 }, { width: 844, height: 390 }, { width: 1440, height: 960 }]) {
      const mobile = viewport.width < 1000;
      const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 });
      await context.addCookies(input.cookies.filter(value => /^(octopus_sess|octopus_csrf)=/.test(value)).map(value => {
        const pair = value.split(";", 1)[0], index = pair.indexOf("=");
        return { name: pair.slice(0, index), value: pair.slice(index + 1), url: input.base };
      }));
      const page = await context.newPage(); page.setDefaultTimeout(12000);
      page.on("pageerror", error => errors.push(error.message));
      const press = (locator: Locator) => mobile ? locator.tap() : locator.click();
      const poll = <T>(read: () => T | Promise<T>) => expect.poll(read, { timeout: 12000 });
      const goto = async (node = "", scope = folder.id) => {
        const url = new URL("/apps/research-v2/open", input.base);
        url.searchParams.set("instance", input.instance); url.searchParams.set("researchScope", scope);
        if (node) url.searchParams.set("researchNode", node);
        await page.goto(url.href);
        await page.locator(".rv-app[data-layout-revision]:not([data-layout-revision=''])").waitFor();
        // Saved windows intentionally survive reload. Explicitly dismiss the stack
        // when the next check needs the canvas, rather than clearing storage.
        if (!node) for (let count = 0; count < 10 && await page.locator(".rv-window:visible").count(); count++) {
          await press(page.locator(".rv-window:visible").last().getByRole("button", { name: "关闭窗口", exact: true }));
        }
      };
      const reachable = async (locator: Locator) => {
        await poll(() => locator.evaluate(element => { const r = element.getBoundingClientRect(); return r.width >= 1 && r.y >= 0 && r.bottom <= innerHeight + 1 && element.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); })).toBe(true);
      };
      try {
        await goto(note.id);
        const detail = page.locator(".rv-window:visible");
        await detail.waitFor();
        await reachable(detail.getByRole("button", { name: "关闭窗口", exact: true }));
        const bounds = await detail.boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width + 1);
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height + 1);
        await press(detail.getByText("标题与节点设置", { exact: true }));
        const title = detail.getByRole("textbox", { name: "标题", exact: true });
        await title.fill("未保存的手机标题");
        if (mobile) expect(await title.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
        const body = detail.locator(".rv-window-body");
        const scroll = await body.evaluate(element => { element.scrollTop = 80; return element.scrollTop; });
        await press(detail.getByRole("button", { name: "最小化窗口", exact: true }));
        await press(page.locator(".rv-window-dock").getByRole("button", { name: /手机长笔记/ }));
        expect(await title.inputValue()).toBe("未保存的手机标题");
        await poll(() => body.evaluate(element => element.scrollTop)).toBe(scroll);
        await page.screenshot({ path: join(input.artifacts, `${engine}-detail-${viewport.width}.png`), animations: "disabled" });
        if (mobile) {
          await page.evaluate(() => { const visual = window.visualViewport!; Object.defineProperties(visual, { height: { configurable: true, value: 280 }, offsetTop: { configurable: true, value: 100 } }); visual.dispatchEvent(new Event("resize")); });
          await reachable(detail.getByRole("button", { name: "关闭窗口", exact: true }));
          await poll(async () => { const rect = await detail.boundingBox(); return rect!.y >= 99 && rect!.y + rect!.height <= 381; }).toBe(true);
          await page.evaluate(() => { const visual = window.visualViewport!; Reflect.deleteProperty(visual, "height"); Reflect.deleteProperty(visual, "offsetTop"); visual.dispatchEvent(new Event("resize")); });
        }
        await press(detail.getByRole("button", { name: "关闭窗口", exact: true }));
        if (mobile) await press(page.getByRole("button", { name: "打开研究导航", exact: true }));
        expect(await page.getByRole("searchbox", { name: "搜索研究内容" }).evaluate(element => element === document.activeElement)).toBe(false);
        await press(page.getByRole("button", { name: "资源材料", exact: true }));
        const assets = page.getByRole("region", { name: "项目资源与材料", exact: true });
        await assets.getByRole("textbox", { name: "查找项目产物" }).fill("手机材料");
        await press(assets.getByRole("button", { name: file.title, exact: true }));
        await poll(() => page.locator(".rv-workbench").isVisible()).toBe(false);
        await reachable(detail.getByRole("button", { name: "关闭窗口", exact: true }));
        await detail.getByLabel("上传文件", { exact: true }).setInputFiles({ name: `phone-${viewport.width}.md`, mimeType: "text/markdown", buffer: Buffer.from("# 手机附件\n\n小屏上传与阅读验证。") });
        await detail.getByRole("heading", { name: "手机附件", exact: true }).waitFor();
        await press(detail.getByRole("button", { name: "关闭窗口", exact: true }));
        if (mobile) await press(page.getByRole("button", { name: "打开研究导航", exact: true }));
        await press(page.getByRole("button", { name: "Agent 与审查", exact: true }));
        const workflow = page.getByRole("complementary", { name: "Agent 活动与协作", exact: true });
        await press(workflow.getByRole("button", { name: /^待处理/ }));
        await press(workflow.getByText("显式提出待审问题", { exact: true }));
        await workflow.getByRole("textbox", { name: "问题", exact: true }).fill("手机待核对问题");
        await page.locator(".rv-workbench").evaluate(element => { element.scrollTop = element.scrollHeight; });
        await reachable(page.getByRole("button", { name: "收起工作台", exact: true }));
        await press(page.getByRole("button", { name: "收起工作台", exact: true }));
        await goto(report.node, "");
        const reportView = page.getByRole("region", { name: "研究报告", exact: true });
        await reportView.getByText("本系列最新结果", { exact: true }).waitFor();
        expect(await detail.locator(".rv-window-body").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
        await page.screenshot({ path: join(input.artifacts, `${engine}-report-${viewport.width}.png`), animations: "disabled" });
        await goto(audio.id);
        await detail.getByRole("region", { name: "会议录音文件" }).waitFor();
        await reachable(detail.getByRole("button", { name: "关闭窗口", exact: true }));
        await goto();
        await press(page.getByRole("button", { name: "＋ 新建", exact: true }));
        const createTitle = page.getByRole("textbox", { name: "节点标题", exact: true });
        await createTitle.fill(`手机新增 ${engine} ${viewport.width}`);
        if (mobile) {
          await page.evaluate(() => { Object.defineProperty(window.visualViewport!, "height", { configurable: true, value: 300 }); window.visualViewport!.dispatchEvent(new Event("resize")); });
        }
        await press(page.getByRole("button", { name: "放到画布", exact: true }));
        await createTitle.waitFor({ state: "hidden" });
        await poll(async () => ((await input.workspace.platform("canvas_read")).nodes as ResearchNode[]).some(node => node.title === `手机新增 ${engine} ${viewport.width}`)).toBe(true);
        await goto("", edgeScope.id);
        await press(page.getByRole("button", { name: "适应当前层", exact: true }));
        // Establish a selected relationship for the panel geometry check. Graph
        // label placement/occlusion is independent of the panel's phone bounds.
        await page.getByRole("button", { name: "选择关系 手机长笔记 → 手机材料.md：手机核对", exact: true }).evaluate(button => (button as HTMLButtonElement).click());
        const edgePanel = page.getByRole("complementary", { name: "选中关系", exact: true });
        await reachable(edgePanel.getByRole("button", { name: "取消关系选择", exact: true }));
        await reachable(edgePanel.getByRole("button", { name: "删除关系", exact: true }));
        expect(await edgePanel.getByRole("button", { name: "删除关系", exact: true }).isEnabled()).toBe(true);
        await page.screenshot({ path: join(input.artifacts, `${engine}-relationship-${viewport.width}.png`), animations: "disabled" });
        await press(edgePanel.getByRole("button", { name: "取消关系选择", exact: true }));
        if (mobile) {
          await press(page.getByRole("article", { name: note.title, exact: true }).getByRole("heading", { name: note.title, exact: true }));
          await reachable(detail.getByRole("button", { name: "关闭窗口", exact: true }));
          await press(detail.getByRole("button", { name: "关闭窗口", exact: true }));
        }
        const neighbors = page.getByRole("button", { name: "关闭邻居预览", exact: true });
        if (await neighbors.isVisible()) await press(neighbors);
        if (engine === "chromium" && viewport.width === 390) {
          const session = await context.newCDPSession(page);
          const before = (await input.workspace.platform("layout_read")).revision;
          const zoom = await page.locator(".rv-zoom span").textContent();
          const pan = await page.locator(".rv-canvas").evaluate(element => (element as HTMLElement).style.backgroundPosition);
          const surface = await page.locator(".rv-app").boundingBox();
          const y = surface!.y + surface!.height - 160;
          await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 90, y, id: 1 }] });
          await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 115, y: y + 12, id: 1 }] });
          await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          expect((await input.workspace.platform("layout_read")).revision).toBe(before);
          expect(await page.locator(".rv-window:visible").count()).toBe(0);
          await poll(() => page.locator(".rv-canvas").evaluate(element => (element as HTMLElement).style.backgroundPosition)).not.toBe(pan);
          await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 90, y, id: 1 }] });
          await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 90, y, id: 1 }, { x: 210, y, id: 2 }] });
          await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 60, y: y + 20, id: 1 }, { x: 260, y: y + 20, id: 2 }] });
          await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          await poll(() => page.locator(".rv-zoom span").textContent()).not.toBe(zoom);
          expect((await input.workspace.platform("layout_read")).revision).toBe(before);
          await session.detach();
        }
        await page.screenshot({ path: join(input.artifacts, `${engine}-canvas-${viewport.width}.png`), animations: "disabled" });
        checks.push(`${viewport.width}x${viewport.height}: visible detail/close, minimize draft, keyboard, workbench material, file upload, review controls, report, audio, create, relationship controls${engine === "chromium" && viewport.width === 390 ? ", native pinch without layout write" : ""}`);
      } catch (error) {
        await page.screenshot({ path: join(input.artifacts, `${engine}-failure-${viewport.width}.png`), animations: "disabled" }).catch(() => {});
        writeFileSync(join(input.artifacts, `${engine}-failure.json`), JSON.stringify({ checks, viewport, error: String(error), errors }, null, 2));
        throw error;
      } finally { await context.close(); }
    }
    expect(errors).toEqual([]);
    writeFileSync(join(input.artifacts, `${engine}-mobile-acceptance.json`), JSON.stringify({ checks, errors }, null, 2));
  } finally { await browser.close(); }
}
