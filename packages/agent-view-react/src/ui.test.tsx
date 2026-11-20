/**
 * The presentation primitives, checked for the one thing they must never do.
 *
 * Every string these components receive is hostile twice over: the projection
 * is content the Host declassified to this package, and the package itself is
 * publisher code. The old string renderer's safety rested on every call site
 * remembering `esc()` first; these assertions exist because the property is now
 * supposed to be structural, and a structural property should be provable.
 */

import { act, render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AvTooltip } from "./controls.js";
import { describe, expect, it, vi } from "vitest";
import {
  Banner,
  DownloadAction,
  DownloadNotice,
  EmptyState,
  Markdown,
  MARKDOWN_RENDER_BUDGET_CHARS,
  ModalDialog,
  SplitHandle,
  StatusChip,
  useBrowserDownload,
  type BrowserDownloadPreparation,
} from "./ui.js";

function rect(patch: Partial<DOMRect>): DOMRect {
  return {
    x: 0, y: 0, top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0,
    toJSON: () => ({}),
    ...patch,
  } as DOMRect;
}

function DownloadProbe({
  prepare,
}: {
  prepare: (
    isCurrent: () => boolean,
    onProgress: (receivedBytes: number, totalBytes: number) => void,
    onChunk: (base64: string) => void,
  ) => Promise<BrowserDownloadPreparation<{ label: string; mediaType: string }>>;
}) {
  const download = useBrowserDownload("scope", "resource", prepare);
  return (
    <>
      <DownloadAction label="archive.bin" state={download} onDownload={download.start} />
      <DownloadNotice state={download} />
    </>
  );
}

describe("presentation primitives", () => {
  it("renders hostile field values as text, not markup", () => {
    const { container } = render(
      <div>
        <StatusChip icon="<svg onload=1>" word="ready & <b>ok</b>" tone={"boom" as never} />
        <Banner icon="<img src=x onerror=1>" title="<script>alert(1)</script>" text="A&B" />
        <EmptyState icon="<i>" title="<img src=x>" text="<b>x</b>" action={{ label: "<继续>", onSelect() {} }} />
      </div>,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(screen.getByText("ready & <b>ok</b>")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "<继续>" })).toBeInTheDocument();
    // An unknown tone falls back rather than becoming an attribute value.
    expect(container.querySelector(".av-status")!.getAttribute("data-tone")).toBe("neutral");
  });

  it("renders a shared accessible spinner only for a real busy lifecycle", () => {
    const { container } = render(<StatusChip busy word="正在同步最新内容" tone="info" />);
    const status = screen.getByRole("status", { name: "正在同步最新内容" });
    expect(status).toHaveTextContent("正在同步最新内容");
    expect(container.querySelector(".av-status .av-spin")).not.toBeNull();
  });

  it("gives the empty-state action a stable hook and calls back once", async () => {
    const onSelect = vi.fn();
    render(<EmptyState title="空" action={{ id: "new_session", label: "启动", onSelect }} />);
    const button = screen.getByRole("button", { name: "启动" });
    expect(button).toHaveAttribute("data-empty-action", "new_session");
    await userEvent.click(button);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("shows determinate byte progress and leaves a failed download explicitly retryable", async () => {
    let report!: (receivedBytes: number, totalBytes: number) => void;
    let finish!: (result: BrowserDownloadPreparation<{ label: string; mediaType: string }>) => void;
    const prepare = vi.fn((
      _isCurrent: () => boolean,
      onProgress: (receivedBytes: number, totalBytes: number) => void,
    ) => new Promise<BrowserDownloadPreparation<{ label: string; mediaType: string }>>((resolve) => {
      report = onProgress;
      finish = resolve;
    }));
    render(<DownloadProbe prepare={prepare} />);

    const button = screen.getByRole("button", { name: "下载 archive.bin" });
    await userEvent.click(button);
    expect(button).toHaveTextContent("正在连接…");
    expect(screen.getByRole("progressbar", { name: "文件下载进度" })).not.toHaveAttribute("value");

    act(() => report(1024, 4096));
    expect(button).toHaveTextContent("正在下载 25%");
    expect(screen.getByRole("progressbar", { name: "文件下载进度" })).toHaveValue(1024);
    expect(screen.getByText("1.0 KiB / 4.0 KiB · 25%")).toBeInTheDocument();

    await act(async () => {
      finish({ ok: false, document: null, message: "连接中断，请重新下载。", code: "unavailable" });
    });
    expect(button).toBeEnabled();
    expect(button).toHaveTextContent("重新下载");
    expect(screen.getByRole("alert")).toHaveTextContent("连接中断，请重新下载。");
    expect(screen.getByRole("alert")).toHaveTextContent("1.0 KiB / 4.0 KiB · 25%");
  });

  it("decodes streamed chunks into one Blob without the caller retaining them", async () => {
    const created: Blob[] = [];
    const OriginalURL = globalThis.URL;
    class DownloadURL extends OriginalURL {}
    Object.assign(DownloadURL, {
      createObjectURL: (blob: Blob) => { created.push(blob); return "blob:assembled"; },
      revokeObjectURL: () => {},
    });
    vi.stubGlobal("URL", DownloadURL);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    try {
      const prepare = vi.fn(async (
        _isCurrent: () => boolean,
        _onProgress: (receivedBytes: number, totalBytes: number) => void,
        onChunk: (base64: string) => void,
      ) => {
        onChunk("AAE=");
        onChunk("Av8=");
        return { ok: true as const, document: { label: "archive.bin", mediaType: "application/octet-stream" } };
      });
      render(<DownloadProbe prepare={prepare} />);
      await userEvent.click(screen.getByRole("button", { name: "下载 archive.bin" }));
      await waitFor(() => expect(created).toHaveLength(1));
      expect(created[0]!.type).toBe("application/octet-stream");
      // jsdom's Blob has no arrayBuffer(); FileReader reads the same bytes.
      const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(created[0]!);
      });
      expect([...new Uint8Array(bytes)]).toEqual([0, 1, 2, 255]);
      expect(click).toHaveBeenCalledTimes(1);
    } finally {
      click.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("shows Markdown past the render budget as plain text until the reader asks", async () => {
    const big = "# 标题\n" + "一行很长的日志文字，".repeat(30_000);
    render(<Markdown>{big}</Markdown>);
    expect(screen.queryByRole("heading", { name: "标题" })).toBeNull();
    expect(screen.getByRole("note")).toHaveTextContent("先以纯文本显示");
    // The plain fallback lays out one window at a time, never the whole text.
    const plain = document.querySelector(".av-markdown-plain")!;
    expect(plain.textContent!.length).toBe(MARKDOWN_RENDER_BUDGET_CHARS);
    await userEvent.click(screen.getByRole("button", { name: "继续显示" }));
    expect(document.querySelector(".av-markdown-plain")!.textContent!.length).toBe(Math.min(big.length, 2 * MARKDOWN_RENDER_BUDGET_CHARS));
    await userEvent.click(screen.getByRole("button", { name: "按 Markdown 渲染" }));
    expect(screen.getByRole("heading", { name: "标题" })).toBeInTheDocument();
  });

  it("keeps two open modals and their scoped tokens with their own App surface", () => {
    const tree = (open: boolean) => <>
      <style>{'[data-app-surface="alpha"] { --app-accent: crimson; } [data-app-surface="beta"] { --app-accent: navy; }'}</style>
      <section data-app-surface="alpha" data-testid="alpha">
        <ModalDialog open={open} title="Alpha modal" onClose={() => {}}>
          <input aria-label="Alpha draft" defaultValue="keep this draft" />
        </ModalDialog>
      </section>
      <section data-app-surface="beta" data-testid="beta">
        <ModalDialog open title="Beta modal" onClose={() => {}}>Beta content</ModalDialog>
      </section>
    </>;
    const view = render(tree(true));
    const alpha = screen.getByTestId("alpha");
    const beta = screen.getByTestId("beta");
    const first = within(alpha).getByRole("dialog", { name: "Alpha modal" });
    // rc-util deliberately returns the same "test-id" from useId in NODE_ENV
    // test, so the second aria-labelledby resolves to the first modal's title.
    // Production uses React.useId. Check each local title and portal ownership
    // here; the single-modal test below independently checks accessible naming.
    const second = within(beta).getByRole("dialog");
    expect(within(second).getByText("Beta modal")).toBeInTheDocument();
    expect(first.closest("[data-app-surface]")).toBe(alpha);
    expect(second.closest("[data-app-surface]")).toBe(beta);
    expect(getComputedStyle(alpha).getPropertyValue("--app-accent")).toBe("crimson");
    expect(getComputedStyle(beta).getPropertyValue("--app-accent")).toBe("navy");
    expect(within(alpha).queryByText("Beta content")).toBeNull();
    const draft = screen.getByRole("textbox", { name: "Alpha draft" });
    view.rerender(tree(false));
    view.rerender(tree(true));
    expect(within(alpha).getByRole("textbox", { name: "Alpha draft" })).toBe(draft);
    expect(draft).toHaveValue("keep this draft");
  });

  it("keeps tooltip content in the trigger App scope", async () => {
    render(<section data-app-surface="tips" data-testid="tips">
      <AvTooltip title="Scoped explanation" open><button>Help</button></AvTooltip>
    </section>);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.closest("[data-app-surface]")).toBe(screen.getByTestId("tips"));
  });

  it("provides a labelled modal that closes through its standard control", async () => {
    const onClose = vi.fn();
    render(
      <ModalDialog open title="目录里的会话" onClose={onClose}>
        <button type="button">会话 A</button>
      </ModalDialog>,
    );
    expect(screen.getByRole("dialog", { name: "目录里的会话" })).toContainElement(
      screen.getByRole("button", { name: "会话 A" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("Markdown", () => {
  it("delegates fenced code while retaining inline code and safe Markdown defaults", () => {
    const { container } = render(<Markdown renderCodeBlock={(children) => <section data-code-block="">{children}</section>}>
      {"```mermaid\nflowchart LR\n A --> B\n```\n\n`inline`"}
    </Markdown>);
    expect(container.querySelector("[data-code-block] code.language-mermaid")?.textContent).toContain("A --> B");
    expect(container.querySelector("p > code")?.textContent).toBe("inline");
  });

  it("never turns untrusted source into HTML", () => {
    const { container } = render(
      <Markdown>
        {"<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n正常 **粗体**"}
      </Markdown>,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
    expect(container.querySelector("strong")).toHaveTextContent("粗体");
  });

  it("drops javascript: and data: links while keeping their text", () => {
    const { container } = render(
      <Markdown>{"[点我](javascript:alert(1)) 和 [附件](data:text/html,<b>x</b>) 和 [真链接](https://example.com/a)"}</Markdown>,
    );
    const links = [...container.querySelectorAll("a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["https://example.com/a"]);
    expect(container.textContent).toContain("点我");
    expect(links[0]).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("renders GitHub tables, which the retired hand-written renderer could not", () => {
    const { container } = render(<Markdown>{"| a | b |\n| - | - |\n| 1 | 2 |"}</Markdown>);
    expect(container.querySelector("table")).toBeTruthy();
    expect(container.querySelectorAll("td")).toHaveLength(2);
  });

  it("delegates image presentation without teaching the generic renderer how to read files", () => {
    const renderImage = vi.fn((image: { alt: string }) => <span data-testid="custom-image">{image.alt}</span>);
    render(<Markdown renderImage={renderImage}>{"![像素](./pixel.png \"本地图片\")"}</Markdown>);
    expect(screen.getByTestId("custom-image")).toHaveTextContent("像素");
    expect(renderImage).toHaveBeenCalledWith({ src: "./pixel.png", alt: "像素", title: "本地图片" });
  });
});

describe("SplitHandle", () => {
  it("is an accessible separator with keyboard control over its sibling", async () => {
    function Layout() {
      return (
        <div style={{ display: "flex" }}>
          <div data-testid="pane" style={{ width: 200 }}>rail</div>
          <SplitHandle axis="x" target="prev" storageKey="test.rail" min={100} max={600} />
          <div>main</div>
        </div>
      );
    }
    const { container } = render(<Layout />);
    const handle = container.querySelector(".av-splitter") as HTMLElement;
    expect(handle).toHaveAttribute("role", "separator");
    expect(handle).toHaveAttribute("aria-orientation", "vertical");
    expect(handle).toHaveAttribute("data-av-axis", "x");
    expect(handle).toHaveAttribute("tabindex", "0");

    handle.focus();
    await userEvent.keyboard("{ArrowRight}");
    // jsdom reports 0-size boxes, so the value written is the clamped floor
    // rather than a real pixel width; what this proves is that a keyboard user
    // can drive it at all, which the retired pointer-only implementation on the
    // dashboard side could not.
    expect(handle.getAttribute("aria-valuenow")).toBe("100");
    expect((screen.getByTestId("pane") as HTMLElement).style.width).toBe("100px");
  });

  it("uses its live parent capacity while preserving the other pane's minimum", async () => {
    function Layout() {
      return (
        <div data-testid="layout" style={{ display: "flex", flexDirection: "column" }}>
          <div data-testid="upper">recent</div>
          <SplitHandle
            axis="y"
            target="prev"
            storageKey="test.dynamic-height"
            min={80}
            max={480}
            remainingMin={80}
          />
          <div>workspace</div>
        </div>
      );
    }
    const { container } = render(<Layout />);
    const layout = screen.getByTestId("layout");
    const upper = screen.getByTestId("upper");
    const handle = container.querySelector(".av-splitter") as HTMLElement;
    vi.spyOn(layout, "getBoundingClientRect").mockReturnValue(rect({ height: 810 }));
    vi.spyOn(handle, "getBoundingClientRect").mockReturnValue(rect({ height: 7 }));
    vi.spyOn(upper, "getBoundingClientRect").mockReturnValue(rect({ height: 720 }));

    handle.focus();
    await userEvent.keyboard("{ArrowDown}");

    // The former hard max was 480px. The live container instead allows the
    // recent pane to reach 723px while retaining 80px for the file index.
    expect(upper.style.height).toBe("723px");
    expect(handle).toHaveAttribute("aria-valuemax", "723");
  });
});
