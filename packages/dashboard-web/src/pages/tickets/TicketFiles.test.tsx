import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TicketFiles } from "./TicketFiles.js";
import { api } from "../../lib/api.js";
vi.mock("../../lib/api.js", async (original) => ({ ...await original<typeof import("../../lib/api.js")>(), api: vi.fn() }));
const request = vi.mocked(api);
const file = (text: string, path = "src/a.ts") => ({ kind: "file", path, text, revision: "a".repeat(40), source: "ticket", object: "b".repeat(40), size: text.length, offset: 0 });

describe("ticket source browser", () => {
  beforeEach(() => request.mockReset());
  it("opens at the cited line, browses the parent and never replays a read on rerender", async () => {
    request.mockResolvedValue(file(Array.from({ length: 100 }, (_, n) => `line ${n + 1}`).join("\n")));
    const open = vi.fn();
    const props = { ticketId: 7, target: { path: "src/a.ts", line: 48 }, onClose: vi.fn(), onOpen: open };
    const { container, rerender } = render(<TicketFiles {...props} />);
    await screen.findByText(/aaaaaaaaaaaa/);
    expect(document.querySelector('[data-source-line="48"]')?.textContent).toContain("line 48");
    expect(request).toHaveBeenCalledTimes(1);
    rerender(<TicketFiles {...props} target={{ ...props.target }} />);
    expect(request).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "上级目录" }));
    expect(open).toHaveBeenCalledWith({ path: "src" });
    expect(container.querySelector("iframe")).toBeNull();
  });
  it("drops a late response after a different file is selected and shows refusals without retry", async () => {
    let resolveOld!: (value: unknown) => void;
    request.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    request.mockRejectedValueOnce(new Error("这不是你的工单"));
    const props = { ticketId: 7, onClose: vi.fn(), onOpen: vi.fn() };
    const { rerender } = render(<TicketFiles {...props} target={{ path: "src/old.ts" }} />);
    rerender(<TicketFiles {...props} target={{ path: "src/new.ts" }} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("这不是你的工单");
    await act(async () => { resolveOld(file("private old content")); });
    expect(screen.queryByText("private old content")).toBeNull();
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("renders directory entries and resolves Markdown links relative to the current file", async () => {
    request.mockResolvedValueOnce({ kind: "directory", path: "", revision: "a".repeat(40), source: "base", object: "c".repeat(40), total: 1, entries: [{ name: "docs", path: "docs", kind: "directory" }] });
    const open = vi.fn();
    const props = { ticketId: 7, onClose: vi.fn(), onOpen: open };
    const { rerender } = render(<TicketFiles {...props} target={{ path: "" }} />);
    fireEvent.click(await screen.findByRole("button", { name: "📁 docs" }));
    expect(open).toHaveBeenCalledWith({ path: "docs" });
    request.mockResolvedValueOnce(file("[reference](../src/a.ts:48)\n\n# Heading", "docs/readme.md"));
    rerender(<TicketFiles {...props} target={{ path: "docs/readme.md" }} />);
    fireEvent.click(await screen.findByRole("button", { name: "预览 Markdown" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Heading" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "reference" }));
    expect(open).toHaveBeenLastCalledWith({ path: "src/a.ts", line: 48 });
  });
  it("assembles a large file from its windows before showing it", async () => {
    const lines = Array.from({ length: 900 }, (_, n) => `line ${n + 1}`).join("\n");
    const cut = [0, 3000, 6000, lines.length];
    request.mockImplementation(async (url: string) => {
      const offset = Number(new URL(url, "http://x").searchParams.get("offset") ?? 0);
      const index = cut.indexOf(offset);
      const end = cut[index + 1]!;
      return { kind: "file", path: "src/big.ts", revision: "a".repeat(40), source: "ticket", object: "b".repeat(40), size: lines.length,
        text: lines.slice(offset, end), offset, ...(end < lines.length ? { next_offset: end } : {}) };
    });
    render(<TicketFiles ticketId={7} target={{ path: "src/big.ts", line: 850 }} onClose={vi.fn()} onOpen={vi.fn()} />);
    await screen.findByText(/aaaaaaaaaaaa/);
    expect(request).toHaveBeenCalledTimes(3);
    expect(String(request.mock.calls[1]![0])).toContain("offset=3000");
    expect(document.querySelector('[data-source-line="850"]')?.textContent).toContain("line 850");
    expect(screen.getByText(/\/ 900$/)).toBeTruthy();
  });
  it("refuses to assemble windows of different blobs", async () => {
    request.mockResolvedValueOnce({ kind: "file", path: "src/big.ts", revision: "a".repeat(40), source: "ticket", object: "b".repeat(40), size: 6, text: "abc", offset: 0, next_offset: 3 });
    request.mockResolvedValueOnce({ kind: "file", path: "src/big.ts", revision: "e".repeat(40), source: "ticket", object: "f".repeat(40), size: 6, text: "XYZ", offset: 3 });
    render(<TicketFiles ticketId={7} target={{ path: "src/big.ts" }} onClose={vi.fn()} onOpen={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("文件在读取期间被新的提交改动了");
    expect(screen.queryByText(/abcXYZ/)).toBeNull();
  });
  it("pages a large directory with an explicit continue button", async () => {
    const entry = (n: number) => ({ name: `f${n}`, path: `wide/f${n}`, kind: "file" });
    request.mockResolvedValueOnce({ kind: "directory", path: "wide", revision: "a".repeat(40), source: "base", object: "c".repeat(40), total: 3,
      entries: [entry(1), entry(2)], next_cursor: "f/f2", unlisted: 1 });
    render(<TicketFiles ticketId={7} target={{ path: "wide" }} onClose={vi.fn()} onOpen={vi.fn()} />);
    await screen.findByRole("button", { name: "📄 f2" });
    expect(screen.getByText("已显示 2 / 3 项")).toBeTruthy();
    expect(screen.getByText(/另有 1 项名称含控制字符或反斜杠/)).toBeTruthy();
    request.mockResolvedValueOnce({ kind: "directory", path: "wide", revision: "d".repeat(40), source: "base", object: "c".repeat(40), total: 3, entries: [entry(3)] });
    fireEvent.click(screen.getByRole("button", { name: "继续加载" }));
    await screen.findByRole("button", { name: "📄 f3" });
    expect(String(request.mock.calls[1]![0])).toContain("cursor=f%2Ff2");
    expect(screen.getAllByRole("button", { name: /📄 f\d/ })).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "继续加载" })).toBeNull();
  });
});
