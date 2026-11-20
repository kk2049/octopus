/**
 * Untrusted content, rendered.
 *
 * Everything this component receives is written by somebody else: an agent, a
 * tool, a ticket author, a transcript. The retired renderer built an HTML string
 * and its safety depended on the ordering of a dozen regular expressions plus
 * every caller remembering to escape first. This one has no HTML string on the
 * path at all, and these tests are the statement of that.
 */

import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Markdown } from "./Markdown.js";

const markdownCss = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "Markdown.module.css"),
  "utf8",
);

describe("Markdown", () => {
  it("renders Mermaid fences and preserves source and ordinary code", async () => {
    const source = "flowchart LR\n A[开始] --> B[完成]";
    const { container } = render(<Markdown>{`\`\`\`mermaid\n${source}\n\`\`\`\n\n\`mermaid\`\n\n\`\`\`js\nconst x = 1;\n\`\`\``}</Markdown>);
    const image = await screen.findByRole("img", { name: "Mermaid 流程图" });
    expect(image.getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
    expect(container.querySelector("details code")?.textContent).toBe(`${source}\n`);
    expect(container.querySelector("pre > code.language-js")?.textContent).toContain("const x = 1;");
    expect(container.querySelectorAll("[data-mermaid-diagram]")).toHaveLength(1);
    expect(container.querySelector("svg")).toBeNull();
    fireEvent.error(image);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("请检查语法");
    expect(container.querySelector("details code")?.textContent).toBe(`${source}\n`);
  });

  it("debounces streaming edits, hides stale diagrams and recovers from invalid source without closing source", async () => {
    vi.useFakeTimers();
    const fenced = (text: string) => `\`\`\`mermaid\n${text}\n\`\`\``;
    const { container, rerender, unmount } = render(<Markdown>{fenced("flowchart LR\n A --> B")}</Markdown>);
    try {
      await act(async () => { vi.advanceTimersByTime(180); await vi.dynamicImportSettled(); });
      expect(screen.getByRole("img")).toBeTruthy();
      const details = container.querySelector("details")!;
      fireEvent.click(container.querySelector("summary")!);
      expect(details.open).toBe(true);
      rerender(<Markdown>{fenced("flowchart INVALID")}</Markdown>);
      expect(screen.queryByRole("img")).toBeNull();
      await act(async () => { vi.advanceTimersByTime(180); await vi.dynamicImportSettled(); });
      expect(screen.getByRole("status").textContent).toContain("请检查语法");
      rerender(<Markdown>{fenced("flowchart LR\n B --> C")}</Markdown>);
      act(() => { vi.advanceTimersByTime(100); });
      rerender(<Markdown>{fenced("flowchart LR\n D --> E")}</Markdown>);
      act(() => { vi.advanceTimersByTime(100); });
      expect(screen.queryByRole("img")).toBeNull();
      await act(async () => { vi.advanceTimersByTime(80); await vi.dynamicImportSettled(); });
      const svg = decodeURIComponent(screen.getByRole("img").getAttribute("src")!);
      expect(svg).toContain('data-id="D"');
      expect(svg).not.toContain('data-id="B"');
      expect(container.querySelector("details")).toBe(details);
      expect(details.open).toBe(true);
      rerender(<Markdown>{fenced("flowchart LR\n E --> F")}</Markdown>);
      unmount();
      expect(vi.getTimerCount()).toBe(0);
    } finally { unmount(); vi.useRealTimers(); }
  });

  it("offers an explicit per-diagram render for an oversized flowchart and keeps its source", async () => {
    const nodes = Array.from({ length: 201 }, (_, index) => ` N${index}[节点 ${index}]`).join("\n");
    const source = `flowchart TD\n${nodes}`;
    const { container } = render(<Markdown>{`\`\`\`mermaid\n${source}\n\`\`\``}</Markdown>);
    const status = await screen.findByText(/流程图过大，已保留源码/);
    expect(screen.queryByRole("img")).toBeNull();
    expect(container.querySelector("details code")?.textContent).toBe(`${source}\n`);
    fireEvent.click(within(status).getByRole("button", { name: "仍然绘制（页面可能短暂卡顿）" }));
    const image = await screen.findByRole("img", { name: "Mermaid 流程图" }, { timeout: 5_000 });
    expect(decodeURIComponent(image.getAttribute("src")!)).toContain("节点 200");
    expect(container.querySelector("svg")).toBeNull();
  });

  it("renders a script tag as text, never as an element", () => {
    const { container } = render(<Markdown>{'<script>alert(1)</script>'}</Markdown>);
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
  });

  it("renders an img onerror payload as text", () => {
    const { container } = render(<Markdown>{'<img src=x onerror="alert(1)">'}</Markdown>);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("onerror");
  });

  it("drops a javascript: link target but keeps the visible text", () => {
    const { container } = render(<Markdown>{"[click](javascript:alert(1))"}</Markdown>);
    const anchor = container.querySelector("a");
    expect(anchor?.getAttribute("href") ?? "").not.toMatch(/javascript:/i);
    expect(container.textContent).toContain("click");
  });

  it("drops a data: link target too", () => {
    const { container } = render(
      <Markdown>{"[x](data:text/html;base64,PHNjcmlwdD4pPC9zY3JpcHQ+)"}</Markdown>,
    );
    expect(container.querySelector("a")?.getAttribute("href") ?? "").not.toMatch(/^data:/i);
  });

  it("opens an http link in a new tab with the opener severed", () => {
    render(<Markdown>{"[docs](https://example.com/a)"}</Markdown>);
    const anchor = screen.getByRole("link", { name: "docs" });
    expect(anchor).toHaveAttribute("href", "https://example.com/a");
    expect(anchor).toHaveAttribute("target", "_blank");
    expect(anchor.getAttribute("rel")).toContain("noopener");
    expect(anchor.getAttribute("rel")).toContain("noreferrer");
  });

  it("renders the constructs these transcripts actually contain", () => {
    const { container } = render(
      <Markdown>{"## 标题\n\n- 一\n- 二\n\n`code`\n\n```\nfenced\n```"}</Markdown>,
    );
    expect(container.querySelector("h2")).not.toBeNull();
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector("code")?.textContent).toBe("code");
    expect(container.querySelector("pre")?.textContent).toContain("fenced");
  });

  it("keeps Markdown headings in a descending scale without shrinking below prose", () => {
    const sizes = Array.from({ length: 6 }, (_, index) => {
      const level = index + 1;
      const match = markdownCss.match(new RegExp(`--markdown-h${level}-size:\\s*([\\d.]+)em`));
      expect(match, `missing h${level} Markdown size`).not.toBeNull();
      expect(markdownCss).toContain(
        `.prose :global(h${level}) {\n  font-size: var(--markdown-h${level}-size);\n}`,
      );
      return Number(match?.[1]);
    });

    expect(sizes.at(-1)).toBeGreaterThanOrEqual(1);
    for (let index = 1; index < sizes.length; index += 1) {
      expect(sizes[index - 1]).toBeGreaterThan(sizes[index]);
    }
  });

  it("renders GFM tables, which the retired renderer did not cover at all", () => {
    const { container } = render(<Markdown>{"| a | b |\n| - | - |\n| 1 | 2 |"}</Markdown>);
    expect(container.querySelector("table")).not.toBeNull();
  });

  it("survives empty and nullish input", () => {
    expect(() => render(<Markdown>{null}</Markdown>)).not.toThrow();
    expect(() => render(<Markdown>{""}</Markdown>)).not.toThrow();
  });
});

describe("ticket Markdown file links", () => {
  it("preserves chat images while source previews suppress automatic image reads", () => {
    const { rerender } = render(<Markdown onOpenFile={vi.fn()}>{"![diagram](/attachments/diagram.png)"}</Markdown>);
    expect(screen.getByRole("img", { name: "diagram" }).getAttribute("src")).toBe("/attachments/diagram.png");
    rerender(<Markdown disableImages>{"![diagram](/attachments/diagram.png)"}</Markdown>);
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("opens authored, plain and inline-code references with line numbers while retaining external links and code", () => {
    const open = vi.fn();
    const source = `[code](${location.origin}/home/ubuntu/lht/octopus/src/a.ts:48)\n\n\`src/b.ts:19:3\`\n\nsrc/c.ts:27\n\n[external](https://example.com/a.ts)\n\n\`\`\`ts\nsrc/d.ts\n\`\`\``;
    render(<Markdown onOpenFile={open}>{source}</Markdown>);
    for (const name of ["code", "src/b.ts:19:3", "src/c.ts:27"]) fireEvent.click(screen.getByRole("button", { name }));
    expect(open.mock.calls).toEqual([[{ path: "/home/ubuntu/lht/octopus/src/a.ts", line: 48 }], [{ path: "src/b.ts", line: 19 }], [{ path: "src/c.ts", line: 27 }]]);
    expect(screen.getByRole("link", { name: "external" }).getAttribute("href")).toBe("https://example.com/a.ts");
    expect(screen.queryByRole("button", { name: "src/d.ts" })).toBeNull();
  });
  it("keeps raw HTML and unsafe URLs inert with file browsing enabled", () => {
    const open = vi.fn();
    const { container } = render(<Markdown onOpenFile={open} disableImages>{'<script>alert(1)</script>\n\n![remote](https://example.com/tracker.png)\n\n![capability](/api/session?owner=alice)\n\n[x](javascript:alert(1))\n\n[bad](data:text/html,test)'}</Markdown>);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("[href^='javascript:'], [href^='data:']")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });
});
