import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionChat } from "./SessionChat.js";
import { transcriptCopy } from "../i18n/transcript.js";

afterEach(() => vi.unstubAllGlobals());

describe("whole response copy", () => {
  const answer = "# Answer\n\n```ts\nconst ok = true;\n```\n\n[Source](https://example.com)";
  const data = { messages: [
    { role: "user" as const, text: "Question" },
    { role: "assistant" as const, blocks: [
      { type: "thinking" as const, text: "Private thought" },
      { type: "tool" as const, tool: "Read", output: "Tool output" },
      { type: "text" as const, text: answer },
      { type: "text" as const, text: "Final paragraph" },
    ] },
  ] };
  const props = { resource: "copy-test", onLoadOlder: () => {} };
  function clipboard(writeText = vi.fn().mockResolvedValue(undefined)) {
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    return writeText;
  }

  it("copies every raw prose block, preserving Markdown without tools or user text", async () => {
    const writeText = clipboard();
    render(<SessionChat {...props} data={data} />);
    expect(screen.getAllByRole("button", { name: "复制全文" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "复制全文" }));
    expect(writeText).toHaveBeenCalledExactlyOnceWith(`${answer}\n\nFinal paragraph`);
    expect(await screen.findByText("已复制")).toBeInTheDocument();
  });

  it("copies all blocks in a long virtualized response", async () => {
    const writeText = clipboard();
    const blocks = Array.from({ length: 65 }, (_, index) => ({ type: "text" as const, text: `Paragraph ${index}` }));
    render(<SessionChat {...props} data={{ messages: [{ role: "assistant", blocks }] }} />);
    fireEvent.click(screen.getByRole("button", { name: "复制全文" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith(blocks.map((block) => block.text).join("\n\n")));
  });

  it("shows failure and permits an explicit retry, including an unavailable Clipboard API", async () => {
    vi.stubGlobal("navigator", {});
    render(<SessionChat {...props} data={data} />);
    fireEvent.click(screen.getByRole("button", { name: "复制全文" }));
    expect(await screen.findByText("复制失败，请重试或选中文字复制。")).toBeInTheDocument();
    const writeText = clipboard(vi.fn().mockRejectedValueOnce(new Error("denied")).mockResolvedValue(undefined));
    fireEvent.click(screen.getByRole("button", { name: "复制全文" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "复制全文" })).toBeEnabled());
    expect(writeText).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "复制全文" }));
    expect(await screen.findByText("已复制")).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledTimes(2);
  });

  it("admits one write and discards its receipt after the response changes", async () => {
    let resolve!: () => void;
    const writeText = clipboard(vi.fn(() => new Promise<void>((done) => { resolve = done; })));
    const original = { messages: [{ role: "assistant", text: answer }] };
    const view = render(<SessionChat {...props} data={original} />);
    const button = screen.getByRole("button", { name: "复制全文" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(writeText).toHaveBeenCalledTimes(1);
    view.rerender(<SessionChat {...props} data={{ messages: [{ role: "assistant", text: "Updated response" }] }} />);
    expect(screen.getByRole("button", { name: "复制全文" })).toBe(button);
    view.rerender(<SessionChat {...props} data={original} />);
    await act(async () => resolve());
    expect(screen.queryByText("已复制")).toBeNull();
    expect(screen.getByRole("button", { name: "复制全文" })).toBeEnabled();
  });

  it("does not carry copied state to another session with identical content", async () => {
    clipboard();
    const view = render(<SessionChat {...props} data={data} />);
    fireEvent.click(screen.getByRole("button", { name: "复制全文" }));
    await screen.findByText("已复制");
    view.rerender(<SessionChat {...props} resource="another-session" data={data} />);
    expect(screen.queryByText("已复制")).toBeNull();
  });

  it("provides localized action and receipt labels", () => {
    expect(transcriptCopy("en").copyResponse).toBe("Copy response");
    for (const language of ["zh-CN", "zh-TW", "nan-TW", "en", "ja-JP"] as const) {
      const copy = transcriptCopy(language);
      expect([copy.copyResponse, copy.copyingResponse, copy.responseCopied, copy.copyResponseFailed].every(Boolean)).toBe(true);
    }
  });
});

describe("ticket SessionChat", () => {
  it("displays server-owned capacity wait and clears it on completion", () => {
    const props = { resource: "ticket-capacity", onLoadOlder: () => {} };
    const { rerender } = render(<SessionChat {...props} data={{ messages: [], runtime: { recovery: {
      state: "waiting_capacity", attempts: 2, retry_at: "2026-09-24T12:05:00Z",
    } } }} />);
    expect(screen.getByTestId("codex-capacity-wait")).toHaveTextContent("2/6");
    expect(screen.getByTestId("codex-capacity-wait")).toHaveTextContent("2026-09-24T12:05:00Z");
    rerender(<SessionChat {...props} data={{ messages: [] }} />);
    expect(screen.queryByTestId("codex-capacity-wait")).toBeNull();
  });
  it("uses the OMP timeline and expands thought bodies without redundant labels", () => {
    const { container } = render(
      <SessionChat
        busy={false}
        data={{
          cliKind: "omp",
          messages: [{
            role: "assistant",
            blocks: [
              { type: "thinking", text: "先看上下文" },
              { type: "tool", tool: "Read", input: "src/a.ts", output: "ok" },
              { type: "thinking", text: "再给结论" },
            ],
          }],
          offset: 0,
          totalMessages: 1,
        }}
        onLoadOlder={() => {}}
        resource="ticket-292"
      />,
    );

    expect(screen.getByText("🧭 2 次思考 · 1 个工具调用")).toBeInTheDocument();
    expect(screen.getByText("先看上下文")).toBeInTheDocument();
    expect(screen.getByText("再给结论")).toBeInTheDocument();
    expect(container.querySelector(".av-chat-work-thinking-label")).toBeNull();
    expect(screen.queryByText("💭 思考")).toBeNull();
  });
});
