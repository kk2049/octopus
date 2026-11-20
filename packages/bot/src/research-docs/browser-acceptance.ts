import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { chromium } from "playwright";
export async function browserAcceptance(input: {
  base: string;
  space: string;
  page: string;
  alice: string[];
  bob: string[];
  browser: string;
  artifacts: string;
}) {
  mkdirSync(input.artifacts, { recursive: true, mode: 0o700 });
  const browser = await chromium.launch({
      executablePath: input.browser,
      headless: true,
    }),
    errors: string[] = [],
    checks: string[] = [];
  const mark = (name: string) => {
    checks.push(name);
    writeFileSync(
      join(input.artifacts, "checks.json"),
      JSON.stringify({ checks, errors }, null, 2),
    );
  };
  const context = async (cookies: string[]) => {
    const c = await browser.newContext({
      viewport: { width: 1512, height: 1000 },
    });
    await c.addCookies(
      cookies
        .filter((v) => /^(octopus_sess|octopus_csrf)=/.test(v))
        .map((v) => {
          const pair = v.split(";")[0],
            i = pair.indexOf("=");
          return {
            name: pair.slice(0, i),
            value: pair.slice(i + 1),
            url: input.base,
          };
        }),
    );
    const page = await c.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    page.setDefaultTimeout(12000);
    return { c, page };
  };
  const poll = <T>(read: () => T | Promise<T>) =>
    expect.poll(read, { timeout: 20000 });
  const url =
    input.base +
    "/apps/research-docs/open?instance=" +
    input.space +
    "&doc=" +
    input.page;
  const a = await context(input.alice),
    b = await context(input.bob);
  try {
    await Promise.all([a.page.goto(url), b.page.goto(url)]);
    for (const p of [a.page, b.page])
      await p.locator(".bn-editor[contenteditable=true]").waitFor();
    mark(
      "two independently authenticated editors mount the server-created rich document",
    );
    const paragraph = (p: typeof a.page) =>
      p
        .locator(".bn-editor [data-content-type=paragraph] .bn-inline-content")
        .first();
    await Promise.all([paragraph(a.page).click(), paragraph(b.page).click()]);
    await Promise.all([
      a.page.keyboard.press("End"),
      b.page.keyboard.press("End"),
    ]);
    await Promise.all([
      a.page.keyboard.insertText(" Alice 并发贡献。"),
      b.page.keyboard.insertText(" Bob 并发贡献。"),
    ]);
    for (const p of [a.page, b.page]) {
      await poll(() => paragraph(p).textContent()).toContain("Alice 并发贡献");
      await poll(() => paragraph(p).textContent()).toContain("Bob 并发贡献");
    }
    await poll(() => a.page.locator(".rd-save").innerText()).toContain(
      "已保存",
    );
    mark(
      "concurrent rich-text edits converge through the real action and SSE transport",
    );
    await a.page.reload();
    await a.page.locator(".bn-editor").waitFor();
    await poll(() => paragraph(a.page).textContent()).toContain("Bob 并发贡献");
    await a.page
      .getByRole("button", { name: "讨论", exact: false })
      .first()
      .click();
    await a.page
      .getByRole("textbox", { name: "添加讨论", exact: true })
      .fill("需要复核实验基线与消融条件。");
    await a.page.getByRole("button", { name: "发布讨论", exact: true }).click();
    await poll(() => a.page.locator(".rd-comment").count()).toBe(2);
    await poll(() =>
      a.page
        .getByRole("textbox", { name: "添加讨论", exact: true })
        .inputValue(),
    ).toBe("");
    await a.page
      .getByRole("textbox", { name: "添加讨论", exact: true })
      .fill("未发送的私有审阅草稿");
    await a.page.getByRole("button", { name: "关闭讨论", exact: true }).click();
    await a.page
      .getByRole("button", { name: "讨论", exact: false })
      .first()
      .click();
    expect(
      await a.page
        .getByRole("textbox", { name: "添加讨论", exact: true })
        .inputValue(),
    ).toBe("未发送的私有审阅草稿");
    await a.page.screenshot({
      path: join(input.artifacts, "desktop-discussion.png"),
    });
    mark(
      "durable reload, authoritative comment authors, and private draft restoration",
    );
    await a.page.getByRole("button", { name: "关闭讨论", exact: true }).click();
    await a.page
      .locator("input[type=file]")
      .first()
      .setInputFiles({
        name: "实验参数.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("baseline=acc\nseed=42\n"),
      });
    const attachment = a.page
      .locator(".rd-resource")
      .filter({ hasText: "实验参数.txt" });
    await attachment.waitFor();
    await attachment
      .getByRole("button", { name: "打开 ↗", exact: true })
      .click();
    await a.page.getByRole("button", { name: "加载附件", exact: true }).click();
    await a.page.locator(".rd-attachment-view pre").waitFor();
    expect(
      await a.page.locator(".rd-attachment-view pre").innerText(),
    ).toContain("seed=42");
    await a.page.getByRole("button", { name: "关闭资料", exact: true }).click();
    mark(
      "uploaded local file round-trips exact bytes through scoped attachment actions",
    );
    await a.page
      .getByRole("button", { name: "新建文档", exact: false })
      .first()
      .click();
    await poll(() =>
      a.page
        .getByRole("textbox", { name: "文档标题", exact: true })
        .inputValue(),
    ).toBe("无标题文档");
    await a.page
      .getByRole("textbox", { name: "文档标题", exact: true })
      .fill("ACC · 实验记录");
    await a.page
      .getByRole("textbox", { name: "文档标题", exact: true })
      .press("Enter");
    await poll(() =>
      b.page
        .getByRole("button", { name: "ACC · 实验记录", exact: true })
        .count(),
    ).toBe(1);
    mark("new pages and title changes appear in another member's directory");
    await a.page
      .getByRole("button", { name: "ACC · 研究主页", exact: true })
      .click();
    await a.page.screenshot({
      path: join(input.artifacts, "desktop-document.png"),
    });
    await a.page.setViewportSize({ width: 390, height: 844 });
    await a.page
      .getByRole("button", { name: "打开文档目录", exact: true })
      .click();
    await a.page
      .getByRole("button", { name: "ACC · 实验记录", exact: true })
      .click();
    await poll(() =>
      a.page
        .getByRole("textbox", { name: "文档标题", exact: true })
        .inputValue(),
    ).toBe("ACC · 实验记录");
    await poll(async () => {
      const box = await a.page.locator(".rd-sidebar").boundingBox();
      return box ? box.x + box.width : 0;
    }).toBeLessThanOrEqual(1);
    await a.page.screenshot({
      path: join(input.artifacts, "mobile-document.png"),
    });
    expect(
      await a.page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 2,
      ),
    ).toBe(true);
    mark("mobile drawer navigation stays inside the viewport");
    expect(errors).toEqual([]);
  } catch (e) {
    await a.page
      .screenshot({ path: join(input.artifacts, "failure.png") })
      .catch(() => {});
    writeFileSync(
      join(input.artifacts, "failure.txt"),
      String(e) + "\n" + errors.join("\n"),
    );
    throw e;
  } finally {
    await browser.close();
  }
}
