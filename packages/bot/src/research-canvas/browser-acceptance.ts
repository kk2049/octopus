/** Opt-in real-browser acceptance against the actual HTTP fixture in open.test.ts. */
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { chromium } from "playwright";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ResearchWorkspaceMcp, WorkspaceMcpConfig } from "./workspace-mcp.js";
import { browserMobileAcceptance } from "./browser-mobile-acceptance.js";
import { browserV2Acceptance } from "./browser-v2-acceptance.js";
import { browserFeedbackAcceptance } from "./browser-feedback-acceptance.js";

export async function browserAcceptance(input: {
  base: string; instance: string; browser: string; cookies: string[]; root: string;
  artifacts: string; config: WorkspaceMcpConfig; workspace: ResearchWorkspaceMcp;
}) {
  if (process.env.RESEARCH_TEST_MOBILE_ONLY === "1") { await browserMobileAcceptance(input); return; }
  mkdirSync(input.artifacts, { recursive: true, mode: 0o700 });
  const browser = await chromium.launch({ executablePath: input.browser, headless: true });
  const errors: string[] = [];
  const client = new Client({ name: "research-acceptance", version: "1" });
  let connected = false;
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1040 } });
    await context.addCookies(input.cookies.filter(value => /^(octopus_sess|octopus_csrf)=/.test(value)).map(value => {
      const pair = value.split(";", 1)[0], index = pair.indexOf("=");
      return { name: pair.slice(0, index), value: pair.slice(index + 1), url: input.base };
    }));
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    if (process.env.RESEARCH_TEST_FEEDBACK_ONLY === "1") {
      await browserFeedbackAcceptance({ page, base: input.base, instance: input.instance, artifacts: input.artifacts, workspace: input.workspace });
      expect(errors).toEqual([]);
      return;
    }
    await page.goto(input.base + "/apps/research-v2/open?researchLayout=canvas&instance=" + input.instance);
    await page.locator(".rv-app[data-project]").waitFor();
    await page.waitForFunction(() => document.querySelector(".rv-app")?.getAttribute("data-layout-revision"));
    const graph = await input.workspace.platform("canvas_read") as { nodes: Array<{ id: string; title: string; ref: string }> };
    const note = graph.nodes.find(node => node.title === "YAML 合并后的便签")!;
    expect(note).toBeDefined();
    const card = page.locator('[data-node="' + note.id + '"]');
    const initialCard = await card.boundingBox();
    await card.locator("h3").click();
    const body = card.getByRole("textbox", { name: "卡片正文", exact: true });
    await body.fill("从真实浏览器直接保存到文件。");
    expect(await card.boundingBox()).toEqual(initialCard);
    expect(await page.locator("[data-window]").count()).toBe(0);
    await card.getByRole("combobox", { name: "卡片类型" }).selectOption("target");
    await expect.poll(async () => {
      const result = await input.workspace.invoke("ref_describe", { ref: note.ref });
      return (result.file as { text: string }).text;
    }).toBe("从真实浏览器直接保存到文件。");
    await expect.poll(async () => {
      const result = await input.workspace.platform("canvas_read") as { nodes: { id: string; data: { meta?: { cardKind?: string } } }[] };
      return result.nodes.find(n => n.id === note.id)?.data.meta?.cardKind;
    }).toBe("target");
    await page.screenshot({ path: join(input.artifacts, "inline-editor.jpg"), type: "jpeg", quality: 90 });
    await card.getByRole("button", { name: "完成编辑" }).click();
    const second = await browser.newContext({ viewport: { width: 1600, height: 1040 } });
    await second.addCookies(await context.cookies());
    const peer = await second.newPage(); peer.on("pageerror", error => errors.push(error.message));
    await peer.goto(input.base + "/apps/research-v2/open?instance=" + input.instance);
    const peerCard = peer.locator('[data-node="' + note.id + '"]'); await peerCard.waitFor();
    await peer.waitForFunction(() => document.querySelector(".rv-app")?.getAttribute("data-layout-revision"));
    const peerBefore = await peerCard.boundingBox();
    const before = await input.workspace.platform("layout_read") as { revision: string; positions: Record<string, { x: number; y: number }> };
    // Delay the first response without stopping pointer gestures or queueing UI events.
    let firstPatch = true, releaseReceipt!: () => void;
    const heldReceipt = new Promise<void>(resolve => { releaseReceipt = resolve; });
    await page.route("**/api/app-view/act?*", async route => {
      if (route.request().postDataJSON()?.action === "layout_patch" && firstPatch) {
        firstPatch = false;
        const response = await route.fetch();
        await heldReceipt;
        await route.fulfill({ response });
      } else await route.continue();
    });
    const box = (await card.boundingBox())!;
    for (let step = 0; step < 10; step++) {
      const grip = (await card.locator(".rv-card-drag:visible").boundingBox())!;
      await page.mouse.move(grip.x + 20, grip.y + grip.height / 2); await page.mouse.down();
      await page.mouse.move(grip.x + 28, grip.y + grip.height / 2 + 8); await page.mouse.up();
      expect((await card.boundingBox())!.x).toBeGreaterThan(box.x + step * 7);
      expect(await card.getByRole("textbox", { name: "卡片正文" }).count()).toBe(0);
    }
    expect(await card.locator(".rv-resize-card").isEnabled()).toBe(true);
    const movedLocally = (await card.boundingBox())!;
    expect(movedLocally.x - box.x).toBeGreaterThan(70);
    // Keep the response outstanding for at least two seconds of genuine network latency.
    await new Promise(resolve => setTimeout(resolve, 2000)); releaseReceipt();
    await expect.poll(async () => (await peerCard.boundingBox())!.x, { timeout: 20000 }).toBeGreaterThan(peerBefore!.x + 70);
    const moved = await input.workspace.platform("layout_read") as typeof before;
    await expect.poll(() => page.locator(".rv-app").getAttribute("data-layout-revision")).toBe(moved.revision);
    expect((await card.boundingBox())!.x).toBeCloseTo(movedLocally.x, 0);
    await page.unroute("**/api/app-view/act?*");
    const resizedBox = (await card.boundingBox())!;
    const handle = (await card.getByRole("button", { name: "调整 " + note.title + " 尺寸", exact: true }).boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 + 160, handle.y + handle.height / 2 + 120, { steps: 8 });
    expect((await card.boundingBox())!.width).toBeGreaterThan(resizedBox.width + 140);
    await page.mouse.up();
    await expect.poll(async () => (await input.workspace.platform("layout_read")).revision).not.toBe(moved.revision);
    const sized = await input.workspace.platform("layout_read") as typeof before;
    await expect.poll(() => peer.locator(".rv-app").getAttribute("data-layout-revision")).toBe(sized.revision);
    await expect.poll(async () => (await peerCard.boundingBox())!.width).toBeGreaterThan(resizedBox.width + 140);
    expect(await page.getByText("有变化，需要刷新", { exact: false }).count()).toBe(0);
    await page.reload(); await card.waitFor();
    await expect.poll(() => page.locator(".rv-app").getAttribute("data-layout-revision")).toBe(sized.revision);
    expect(await page.locator(".rv-app").getAttribute("data-layout")).toBe("canvas");
    await second.close();
    const arranged = await input.workspace.invoke("layout_auto", { revision: sized.revision, request: "browser-layout-auto" });
    expect(arranged.status).toBe("merged");
    const automatic = (await input.workspace.platform("layout_read") as { positions: Record<string, { pinned?: boolean; width?: number; height?: number }> }).positions[note.id];
    expect(automatic.pinned).not.toBe(true);
    expect(automatic.width).toBe((sized.positions[note.id] as { width?: number }).width);
    expect(automatic.height).toBe((sized.positions[note.id] as { height?: number }).height);
    // Host themes can give ordinary buttons a 40px minimum. Graph controls
    // must still leave room for the summary and representative child at zoom.
    const excerpt = await input.workspace.platform("node_add", {
      request: "browser-source-excerpt", data: JSON.stringify({ type: "note", title: "内部因果与完整观察", summary: "来源已归档，正文仍需独立核对。", data: { meta: {
        excerpt: "## 当前问题\n\n内部依赖支持集说明哪些派生需要修复。共同顺序仍需读源、反依赖及输出约束共同证明。",
        excerptKind: "verbatim", sourceNode: note.id, sourceRevision: "a".repeat(64), sourceAt: "2026-09-24T00:00:00Z",
        acceptanceStatus: "pending", limitation: "材料整理不能替代独立验收。",
      } } }),
    }) as { node: { id: string } };
    const agent = await input.workspace.platform("node_add", {
      request: "browser-agent-summary", data: JSON.stringify({ type: "agent", title: "内部因果理论 · Agent", summary: "原会话空闲，研究记录已归档。" }),
    }) as { node: { id: string } };
    const folder = await input.workspace.platform("node_add", {
      request: "browser-preview-folder", data: JSON.stringify({ type: "folder", title: "研究材料", summary: "论文叙事、实验结果和待验证问题。", data: { members: [note.id, excerpt.node.id, agent.node.id] } }),
    }) as { node: { id: string } };
    const branchLayout = await input.workspace.platform("layout_read");
    await input.workspace.invoke("layout_auto", { revision: branchLayout.revision, request: "browser-arrange-branch", nodes: [folder.node.id, note.id, excerpt.node.id, agent.node.id] });
    await page.goto(input.base + "/apps/research-v2/open?researchLayout=tree&researchScope=" + folder.node.id + "&instance=" + input.instance);
    const preview = page.locator('[data-node="' + folder.node.id + '"]');
    await preview.locator(".rv-child-counts").waitFor();
    expect(await preview.locator(".rv-child-counts").innerText()).toContain("2 张卡片 · 1 个 Agent");
    await page.addStyleTag({ content: "button { min-height: 40px; }" });
    while (Number((await page.locator(".rv-zoom span").textContent())?.replace("%", "")) > 75)
      await page.getByRole("button", { name: "缩小画布", exact: true }).click();
    const previewFits = await preview.evaluate(node => {
      const body = node.querySelector(".rv-card-content")!.getBoundingClientRect();
      const child = node.querySelector(".rv-child-counts")!.getBoundingClientRect();
      const summary = node.querySelector(".rv-card-summary")!.getBoundingClientRect();
      const footer = node.querySelector("footer")!.getBoundingClientRect();
      return child.bottom <= body.bottom + 1 && summary.bottom <= body.bottom + 1 && footer.bottom <= node.getBoundingClientRect().bottom;
    });
    expect(previewFits, "host theme controls must not clip folder previews").toBe(true);
    await page.goto(input.base + "/apps/research-v2/open?researchScope=&instance=" + input.instance);
    const toggled = page.locator('[data-node="' + folder.node.id + '"]'); await toggled.waitFor();
    for (let i = 0; i < 10; i++) await toggled.locator(".rv-tree-toggle").dblclick();
    expect(await page.locator("[data-window]").count()).toBe(0);
    expect(await page.getByRole("textbox", { name: "卡片标题" }).count()).toBe(0);
    await page.goto(input.base + "/apps/research-v2/open?researchScope=" + folder.node.id + "&instance=" + input.instance);
    const readable = page.locator('[data-node="' + excerpt.node.id + '"]');
    await readable.getByText("内部依赖支持集说明哪些派生需要修复。共同顺序仍需读源、反依赖及输出约束共同证明。", { exact: true }).waitFor();
    expect(await readable.evaluate(node => {
      const text = Array.from(node.querySelectorAll("p")).find(p => p.textContent?.startsWith("内部依赖支持集"))!;
      return text.getBoundingClientRect().bottom <= node.querySelector(".rv-card-content")!.getBoundingClientRect().bottom + 1;
    }), "source metadata must leave the first body paragraph visible").toBe(true);
    expect(await page.locator('[data-node="' + agent.node.id + '"]').evaluate(node => {
      const text = node.querySelector(".rv-card-summary")!, bounds = text.getBoundingClientRect();
      return bounds.height >= parseFloat(getComputedStyle(text).lineHeight) - 1 && bounds.bottom <= node.querySelector(".rv-card-content")!.getBoundingClientRect().bottom + 1;
    }), "compact agent summary must keep a readable line").toBe(true);
    // Clicking and dragging the same Agent title must be distinct gestures.
    const agentCard = page.locator('[data-node="' + agent.node.id + '"]');
    await agentCard.locator("h3").click();
    await page.locator("[data-window]:visible").waitFor();
    await page.locator("[data-window]:visible").getByRole("button", { name: "关闭窗口", exact: true }).click();
    const agentBefore = (await agentCard.boundingBox())!, agentTitle = (await agentCard.locator("h3").boundingBox())!;
    await page.mouse.move(agentTitle.x + 20, agentTitle.y + agentTitle.height / 2); await page.mouse.down();
    await page.mouse.move(agentTitle.x + 60, agentTitle.y + agentTitle.height / 2 + 24, { steps: 5 }); await page.mouse.up();
    expect((await agentCard.boundingBox())!.x).toBeGreaterThan(agentBefore.x + 30);
    expect(await page.locator("[data-window]:visible").count()).toBe(0);
    const v2Checks = await browserV2Acceptance({ page, base: input.base, instance: input.instance, artifacts: input.artifacts, workspace: input.workspace });
    await browserFeedbackAcceptance({ page, base: input.base, instance: input.instance, artifacts: input.artifacts, workspace: input.workspace });
    const state = join(input.root, "browser-state.json");
    await context.storageState({ path: state });
    const configFile = join(input.root, "workspace-mcp.json");
    writeFileSync(configFile, JSON.stringify({ ...input.config, screenshot: { base: input.base, state, browser: input.browser } }), { mode: 0o600 });
    const repository = fileURLToPath(new URL("../../../../", import.meta.url));
    const transport = new StdioClientTransport({
      command: process.execPath, args: ["--import", "tsx", join(repository, "ctl/research-workspace-mcp.ts"), configFile],
      cwd: repository, stderr: "pipe",
    });
    await client.connect(transport); connected = true;
    expect((await client.listTools()).tools.some(tool => tool.name === "graph_checkout")).toBe(true);
    const screenshot = CallToolResultSchema.parse(await client.callTool({ name: "canvas_screenshot", arguments: {} }, undefined, { timeout: 60000 }));
    expect(screenshot.isError, JSON.stringify(screenshot.structuredContent)).not.toBe(true);
    const image = screenshot.content.find(item => item.type === "image");
    expect(image?.type).toBe("image");
    if (image?.type !== "image" || typeof image.data !== "string") throw new Error("MCP did not return image content");
    expect(Buffer.from(image.data, "base64").byteLength).toBeGreaterThan(10000);
    const report = screenshot.structuredContent as { screenshot: string; graphRevision: string; layoutRevision: string; errors: string[] };
    const output = join(input.artifacts, "research-canvas.jpg");
    copyFileSync(report.screenshot, output);
    const finalLayout = await input.workspace.platform("layout_read");
    expect(report.layoutRevision).toBe(finalLayout.revision);
    expect(report.errors).toEqual([]);
    expect(errors).toEqual([]);
    writeFileSync(join(input.artifacts, "browser-acceptance.json"), JSON.stringify({
      ...report, screenshot: output, checks: ["authenticated ESM page", "MCP YAML edit", "same-footprint inline body edit and compatible card type", "ten immediate drags during delayed receipt and resize", "rapid toggle never opens details", "two clients receive shared geometry without reload", "geometry persists across reload", "manual moves remain unpinned and automatic layout preserves dimensions", "zoomed preview with host 40px buttons", "source context with visible body paragraph", "compact agent summary", "stdio MCP JPEG image", ...v2Checks],
      pageErrors: errors,
    }, null, 2), { mode: 0o600 });
    expect(image.mimeType).toBe("image/jpeg");
    expect([...readFileSync(output).subarray(0, 3)]).toEqual([255, 216, 255]);
  } finally {
    if (connected) await client.close();
    await browser.close();
  }
}
