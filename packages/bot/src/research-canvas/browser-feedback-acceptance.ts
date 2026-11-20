/** Regressions from the deployed UI, against only the temporary authorized project. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import type { Page } from "playwright";
import type { GraphSpec, LayoutSnapshot, ResearchNode } from "@claude-bot/research-canvas-contract";
import type { ResearchWorkspaceMcp } from "./workspace-mcp.js";

export async function browserFeedbackAcceptance(input: { page: Page; base: string; instance: string; artifacts: string; workspace: ResearchWorkspaceMcp }) {
  const { page, workspace } = input, checks: string[] = [];
  let stage = "create UI parent fixtures";
  const poll = <T>(read: () => T | Promise<T>) => expect.poll(read, { timeout: 12000 });
  const card = (id: string) => page.locator(`[data-node="${id}"]`);
  const layout = async () => await workspace.platform("layout_read") as unknown as LayoutSnapshot;
  const graph = async () => (await workspace.platform("graph_read")).graph as unknown as GraphSpec;
  const add = async (name: string, data: Record<string, unknown>) => (await workspace.platform("node_add", { request: `feedback:${name}`, data }) as { node: ResearchNode }).node;
  const goto = async (scope: string) => {
    const url = new URL("/apps/research-v2/open", input.base);
    url.searchParams.set("instance", input.instance); url.searchParams.set("researchScope", scope);
    await page.goto(url.href);
    await page.locator(".rv-app[data-layout-revision]:not([data-layout-revision=''])").waitFor();
    await poll(() => page.locator(".rv-app").getAttribute("data-scope")).toBe(scope);
  };
  const drag = async (id: string, dx = 55, dy = 35) => {
    const grip = (await card(id).locator(".rv-card-drag:visible").boundingBox())!;
    await page.mouse.move(grip.x + 20, grip.y + grip.height / 2); await page.mouse.down();
    await page.mouse.move(grip.x + 20 + dx, grip.y + grip.height / 2 + dy, { steps: 8 }); await page.mouse.up();
  };
  const created = async (title: string, parent: string) => {
    await page.getByRole("button", { name: "＋ 新建", exact: true }).click();
    await page.getByRole("textbox", { name: "节点标题", exact: true }).fill(title);
    await page.getByRole("button", { name: "放到画布", exact: true }).click();
    await page.getByRole("textbox", { name: "节点标题", exact: true }).waitFor({ state: "hidden" });
    await poll(async () => {
      const current = await graph(), id = Object.keys(current.nodes).find(id => current.nodes[id].label === title);
      return !!id && Object.values(current.edges).some(edge => edge.from === parent && edge.to === id && edge.relation === "contains");
    }).toBe(true);
    expect(await page.getByText("节点已创建，但连接到当前目标失败", { exact: false }).count()).toBe(0);
  };
  try {
    page.setDefaultTimeout(12000);
    const leaf = await add("leaf", { type: "note", title: "单拖应保持原位的子节点", x: 1160, y: 320 });
    const parent = await add("parent", { type: "folder", title: "单拖父节点", x: 720, y: 320, data: { members: [leaf.id] } });
    const goal = await add("goal", { type: "goal", title: "新增归属验收目标", x: 80, y: 320 });
    await workspace.platform("edge_add", { request: "feedback:goal-parent", source: goal.id, target: parent.id, label: "contains" });
    const reference = await add("reference", { type: "note", title: "只移动个人引用位置", x: 1600, y: 900 });
    await workspace.platform("edge_add", { request: "feedback:reference-edge", source: parent.id, target: reference.id, label: "references" });

    stage = "create at overview and attach to current goal";
    await goto("");
    // Select this goal so the fixture does not depend on unrelated root order.
    await page.getByRole("button", { name: "框选节点", exact: true }).click();
    await card(goal.id).locator("h3").click();
    await created("从总览新增并连接父目标", goal.id);
    checks.push(stage);
    stage = "create within focused branch and attach to scope";
    await goto(parent.id);
    await created("聚焦子图内新增节点", parent.id);
    checks.push(stage);

    for (const lostAction of ["node_add"]) {
      stage = `${lostAction} lost reply resumes the same creation after reload`;
      let dropped = false;
      await page.route("**/api/app-view/act?*", async route => {
        if (!dropped && route.request().postDataJSON()?.action === lostAction) {
          dropped = true; await route.fetch(); await route.abort("failed");
        } else await route.continue();
      });
      const title = `回执中断后恢复 ${lostAction}`;
      await page.getByRole("button", { name: "＋ 新建", exact: true }).click();
      await page.getByRole("textbox", { name: "节点标题", exact: true }).fill(title);
      await page.getByRole("button", { name: "放到画布", exact: true }).click();
      const retry = lostAction === "node_add" ? "重试确认创建" : "重试连接";
      await page.getByRole("button", { name: retry, exact: true }).waitFor();
      expect(dropped).toBe(true);
      await page.reload(); await card(parent.id).waitFor();
      await page.getByRole("button", { name: "＋ 新建", exact: true }).click();
      expect(await page.getByRole("textbox", { name: "节点标题", exact: true }).inputValue()).toBe(title);
      await page.getByRole("button", { name: retry, exact: true }).click();
      await page.getByRole("textbox", { name: "节点标题", exact: true }).waitFor({ state: "hidden" });
      await page.unroute("**/api/app-view/act?*");
      const restored = await graph(), matches = Object.keys(restored.nodes).filter(id => restored.nodes[id].label === title);
      expect(matches).toHaveLength(1);
      expect(Object.values(restored.edges).filter(edge => edge.from === parent.id && edge.to === matches[0] && edge.relation === "contains")).toHaveLength(1);
      checks.push(stage);
    }

    // Keep newly created fixture cards away from the grips/buttons under test.
    // Free-canvas creation legitimately uses the current viewport centre.
    const createdTitles = new Set(["从总览新增并连接父目标", "聚焦子图内新增节点", "回执中断后恢复 node_add"]);
    const createdIds = Object.entries((await graph()).nodes).filter(([, node]) => createdTitles.has(node.label)).map(([id]) => id);
    expect(createdIds).toHaveLength(3);
    const createdLayout = await layout();
    const spaced = await workspace.platform("layout_patch", { request: "feedback:space-created-cards", data: { base: Object.fromEntries(createdIds.map(id => [id, createdLayout.positions[id]])), edits: Object.fromEntries(createdIds.map((id, index) => [id, { position: { x: 720 + index % 2 * 400, y: 900 + Math.floor(index / 2) * 300 } }])) } });
    expect(spaced.status, JSON.stringify(spaced)).toBe("merged");

    stage = "moving a rightmost card does not rearrange reference cards";
    await goto(parent.id); await page.getByRole("button", { name: "适应当前层", exact: true }).click();
    const anchored = await card(reference.id).boundingBox(), anchorLayout = await layout();
    await drag(leaf.id, 40, 20);
    await poll(async () => (await layout()).positions[leaf.id].x).toBeGreaterThan(anchorLayout.positions[leaf.id].x);
    expect(await card(reference.id).boundingBox()).toEqual(anchored);
    checks.push(stage);
    stage = "ordinary parent drag leaves descendant and reference cards still";
    const before = await layout(), referenceBefore = await card(reference.id).boundingBox();
    await drag(parent.id);
    await poll(async () => (await layout()).positions[parent.id].x).toBeGreaterThan(before.positions[parent.id].x);
    expect((await layout()).positions[leaf.id]).toEqual(before.positions[leaf.id]);
    expect(await card(reference.id).boundingBox()).toEqual(referenceBefore);
    checks.push(stage);

    stage = "leaving explicit selection mode restores single-card dragging";
    await page.getByRole("button", { name: "框选节点", exact: true }).click();
    await card(parent.id).locator("h3").click();
    await card(leaf.id).locator("h3").click({ modifiers: ["Shift"] });
    expect(await card(leaf.id).getAttribute("aria-selected")).toBe("true");
    await page.getByRole("button", { name: "拖动画布", exact: true }).click();
    const single = await layout(); await drag(parent.id, 36, 20);
    await poll(async () => (await layout()).positions[parent.id].x).toBeGreaterThan(single.positions[parent.id].x);
    expect((await layout()).positions[leaf.id]).toEqual(single.positions[leaf.id]);
    checks.push(stage);

    stage = "explicit Shift selection moves exactly the visible chosen cards";
    await page.getByRole("button", { name: "框选节点", exact: true }).click();
    await card(parent.id).locator("h3").click();
    await card(leaf.id).locator("h3").click({ modifiers: ["Shift"] });
    const group = await layout(); await drag(parent.id, 36, 20);
    await poll(async () => (await layout()).positions[leaf.id].x).toBeGreaterThan(group.positions[leaf.id].x);
    const grouped = await layout();
    expect(grouped.positions[leaf.id].x - group.positions[leaf.id].x).toBeCloseTo(grouped.positions[parent.id].x - group.positions[parent.id].x, 4);
    expect(grouped.positions[reference.id]).toEqual(group.positions[reference.id]);
    checks.push(stage);

    stage = "collapsed selected descendants never follow a parent drag";
    await goto(goal.id);
    const expandParent = card(parent.id).getByRole("button", { name: "展开 " + parent.title, exact: true });
    if (await expandParent.count()) await expandParent.click();
    await page.getByRole("button", { name: "适应当前层", exact: true }).click();
    await page.getByRole("button", { name: "框选节点", exact: true }).click();
    await card(parent.id).locator("h3").click();
    await card(leaf.id).locator("h3").click({ modifiers: ["Shift"] });
    await card(parent.id).getByRole("button", { name: "收起 " + parent.title, exact: true }).click();
    expect(await card(leaf.id).count()).toBe(0);
    const collapsed = await layout(); await drag(parent.id, 36, 20);
    await poll(async () => (await layout()).positions[parent.id].x).toBeGreaterThan(collapsed.positions[parent.id].x);
    expect((await layout()).positions[leaf.id]).toEqual(collapsed.positions[leaf.id]);
    checks.push(stage);

    stage = "reference drag persists privately across refresh without changing graph or shared coordinates";
    await goto(parent.id);
    await page.getByRole("button", { name: "拖动画布", exact: true }).click();
    const sharedBefore = await layout(), structureBefore = await graph();
    const referenceAt = (await card(reference.id).boundingBox())!;
    await page.screenshot({ path: join(input.artifacts, "research-feedback-reference-before.png") });
    await drag(reference.id, -70, 45);
    await poll(async () => (await card(reference.id).boundingBox())!.x).toBeLessThan(referenceAt.x - 50);
    const localAfter = await card(reference.id).evaluate(element => ({ left: element.style.left, top: element.style.top }));
    await page.screenshot({ path: join(input.artifacts, "research-feedback-reference-after.png") });
    expect(await layout()).toEqual(sharedBefore);
    expect(await graph()).toEqual(structureBefore);
    const key = await page.locator(".rv-app").getAttribute("data-project");
    const readPrivatePosition = () => page.evaluate(({ key, scope, node }) => JSON.parse(localStorage.getItem(`research-v2:alice:${key}:reference-layouts`) || "{}")[scope]?.[node], { key, scope: parent.id, node: reference.id });
    const saved = await readPrivatePosition();
    expect(saved).toEqual(expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }));
    await page.reload(); await card(reference.id).waitFor();
    expect(await readPrivatePosition()).toEqual(saved);
    await page.getByRole("button", { name: "适应当前层", exact: true }).click();
    // CSS serializes fontSize/positions with rounded decimals. Allow <0.05 world
    // pixels (well below one screen pixel), while persisted coordinates stay exact.
    const referenceWorld = async () => {
      const display = await card(reference.id).evaluate(element => ({ x: parseFloat(element.style.left), y: parseFloat(element.style.top) }));
      const anchor = await card(parent.id).evaluate(element => ({ x: parseFloat(element.style.left), y: parseFloat(element.style.top), zoom: parseFloat(element.style.fontSize) / 16 }));
      return { x: sharedBefore.positions[parent.id].x + (display.x - anchor.x) / anchor.zoom, y: sharedBefore.positions[parent.id].y + (display.y - anchor.y) / anchor.zoom };
    };
    expect((await referenceWorld()).x).toBeCloseTo(saved.x, 1);
    expect((await referenceWorld()).y).toBeCloseTo(saved.y, 1);
    await goto(goal.id); await goto(parent.id);
    expect((await referenceWorld()).x).toBeCloseTo(saved.x, 1);
    expect((await referenceWorld()).y).toBeCloseTo(saved.y, 1);
    expect(await readPrivatePosition()).toEqual(saved);
    expect(await layout()).toEqual(sharedBefore);
    expect(await graph()).toEqual(structureBefore);
    await page.screenshot({ path: join(input.artifacts, "research-feedback-reference-drag.png") });
    checks.push(stage);
    writeFileSync(join(input.artifacts, "research-feedback-acceptance.json"), JSON.stringify({ checks, reference: { id: reference.id, scope: parent.id, saved, localAfter }, sharedRevision: sharedBefore.revision }, null, 2));
    return checks;
  } catch (error) {
    await page.screenshot({ path: join(input.artifacts, "research-feedback-failure.png") }).catch(() => {});
    writeFileSync(join(input.artifacts, "research-feedback-failure.json"), JSON.stringify({ stage, checks, url: page.url(), error: String(error), alerts: await page.locator('[role="alert"]').allTextContents().catch(() => []) }, null, 2));
    throw error;
  }
}
