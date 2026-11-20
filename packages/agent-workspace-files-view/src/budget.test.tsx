/**
 * A view budget is not a file limit (2026-10-20).
 *
 * The port reads files of any size. A whole-document view stops at its budget
 * and must then show what it has, say so, and offer the rest — never present
 * the leading part as the whole file, and never offer to save it.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AnyWorkspaceFilesPort } from "@claude-bot/workspace-files-contract";
import { FileViewer } from "./components/FileViewer.js";
import { MediaViewer } from "./components/MediaViewer.js";

const DIGEST = `sha256:${"c".repeat(64)}`;
const IDLE = { status: "idle", message: "", code: "", receivedBytes: 0, totalBytes: null } as const;

describe("budgeted views", () => {
  it("shows the leading text of an over-budget file with load-all and download, and no edit", async () => {
    const onLoadAll = vi.fn();
    render(
      <FileViewer
        document={{ ref: "f1", label: "huge.log", mediaType: "text/plain; charset=utf-8", sizeBytes: 40 * 1024 * 1024, digest: DIGEST }}
        label="huge.log"
        text={"first line\nsecond line\n"}
        status="refused"
        streaming={false}
        message="文件共 40.0 MiB，已载入前 16.0 MiB；可继续载入全部或下载。"
        code="too_large"
        download={IDLE}
        onDownload={() => {}}
        onReload={() => {}}
        onLoadAll={onLoadAll}
        onEdit={() => {}}
        port={{} as AnyWorkspaceFilesPort}
        markdownLocation={null}
      />,
    );
    expect(screen.getByText(/已载入前 16.0 MiB/)).toBeInTheDocument();
    expect(screen.queryByText("编辑")).toBeNull();
    expect(screen.getByRole("button", { name: /下载 huge.log/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "载入全部" }));
    expect(onLoadAll).toHaveBeenCalledTimes(1);
  });

  it("offers only the download for text past what a browser page can hold whole", () => {
    render(
      <FileViewer
        document={{ ref: "f2", label: "giant.log", mediaType: "text/plain; charset=utf-8", sizeBytes: 300 * 1024 * 1024, digest: DIGEST }}
        label="giant.log"
        text={"head\n"}
        status="refused"
        streaming={false}
        message="文件共 300.0 MiB，已载入前 16.0 MiB；整份显示会超出浏览器页面内存，完整内容请下载。"
        code="too_large"
        download={IDLE}
        onDownload={() => {}}
        onReload={() => {}}
        onLoadAll={() => {}}
        port={{} as AnyWorkspaceFilesPort}
        markdownLocation={null}
      />,
    );
    expect(screen.queryByRole("button", { name: "载入全部" })).toBeNull();
    expect(screen.getByRole("button", { name: /下载 giant.log/ })).toBeInTheDocument();
  });

  it("opens a Markdown file past the render budget as text and renders it only on request", async () => {
    const text = "# 实验记录\n" + "很长的段落，没有空行。".repeat(40_000);
    render(
      <FileViewer
        document={{ ref: "md1", label: "notes.md", mediaType: "text/plain; charset=utf-8", sizeBytes: text.length * 3, digest: DIGEST }}
        label="notes.md"
        text={text}
        status="ready"
        streaming={false}
        message=""
        code=""
        download={IDLE}
        onDownload={() => {}}
        onReload={() => {}}
        port={{} as AnyWorkspaceFilesPort}
        markdownLocation={null}
      />,
    );
    expect(screen.getByText(/渲染可能让页面卡住/)).toBeInTheDocument();
    expect(screen.queryByRole("article")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "按 Markdown 渲染" }));
    expect(screen.getByRole("article", { name: /Markdown 预览/ })).toBeInTheDocument();
  });

  it("asks before previewing an over-budget image and still offers the download", async () => {
    const onLoadAll = vi.fn();
    render(
      <MediaViewer
        status="refused"
        document={{ ref: "m1", label: "scan.png", mediaType: "image/png", sizeBytes: 300 * 1024 * 1024, digest: DIGEST }}
        url=""
        data={null}
        streaming={false}
        message="文件共 300.0 MiB，较大，没有自动预览；可继续预览或下载。"
        code="too_large"
        label="scan.png"
        onReload={() => {}}
        onLoadAll={onLoadAll}
        download={IDLE}
        onDownload={() => {}}
      />,
    );
    expect(screen.getByText(/没有自动预览/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /下载 scan.png/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "继续预览" }));
    expect(onLoadAll).toHaveBeenCalledTimes(1);
  });
});
