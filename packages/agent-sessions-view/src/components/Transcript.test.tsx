/**
 * The transcript's file-link delegation: a path-shaped Markdown link becomes
 * an open request, while a real URL keeps its anchor behaviour — and none of
 * it exists at all for a host that passes no callback.
 */

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TranscriptWindow } from "@claude-bot/agent-sessions-contract";
import type { PendingSend } from "../controller.js";
import { TranscriptView, sendPhaseWord } from "./Transcript.js";

afterEach(() => vi.unstubAllGlobals());

it("copies original Markdown from the named icon button using the keyboard", async () => {
  const user = userEvent.setup();
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const text = "See /home/u/project/main.ts\n\n```ts\nconst answer = 42;\n```";
  render(<TranscriptView resource="copy" status={undefined} busy={false} onLoadOlder={() => {}}
    onOpenFileLink={() => {}} data={{ messages: [{ role: "assistant", text }] }} />);
  const button = screen.getByRole("button", { name: "复制全文" });
  expect(button).toHaveAttribute("title", "复制全文");
  button.focus();
  await user.keyboard("{Enter}");
  expect(writeText).toHaveBeenCalledExactlyOnceWith(text);
  expect(await screen.findByText("已复制")).toBeInTheDocument();
});

const WINDOW: TranscriptWindow = {
  offset: 0,
  totalMessages: 1,
  messages: [
    {
      role: "assistant",
      blocks: [
        {
          type: "text",
          text: "改动在 [入口](src/main.ts) 与 [绝对路径](/home/u/proj/lib.ts)；参考 [文档](https://example.com/doc) 和 [方案](https://acme.feishu.cn/docx/Abcdef123?from=chat)。",
        },
      ],
    },
  ],
};

function mount(onOpenFileLink?: (path: string) => void, onOpenFeishuLink?: (url: string, label: string) => boolean) {
  return render(
    <TranscriptView
      resource="res-1"
      data={WINDOW}
      status={undefined}
      busy={false}
      onLoadOlder={() => {}}
      {...(onOpenFileLink ? { onOpenFileLink } : {})}
      {...(onOpenFeishuLink ? { onOpenFeishuLink } : {})}
    />,
  );
}

describe("TranscriptView file links", () => {
  it("intercepts a same-document-origin absolute URL before the browser navigates", async () => {
    const onOpenFileLink = vi.fn();
    const path = "/home/ubuntu/lht/auto-research/agentcc-case-walkthrough/r06-20260907/L2-WALKTHROUGH.md";
    const { container } = render(<TranscriptView
      resource="res-1"
      data={{ offset: 0, totalMessages: 1, messages: [{ role: "assistant", blocks: [{
        type: "text", text: `[L2 全文](${new URL(document.URL).origin}${path})`,
      }] }] }}
      status={undefined} busy={false} onLoadOlder={() => {}} onOpenFileLink={onOpenFileLink}
    />);
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    container.querySelector("a")!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(onOpenFileLink).toHaveBeenCalledExactlyOnceWith(path);
  });

  it.each([false, true])("renders Mermaid in assistant prose with file links enabled=%s", async (fileLinks) => {
    const { container } = render(<TranscriptView resource="diagram" status={undefined} busy={false} onLoadOlder={() => {}}
      {...(fileLinks ? { onOpenFileLink: vi.fn() } : {})}
      data={{ offset: 0, totalMessages: 1, messages: [{ role: "assistant", blocks: [{ type: "text", text:
        "```mermaid\nflowchart LR\n A[开始] --> B[完成]\n```\n\n```\nflowchart LR\n A --> B\n```",
      }] }] }} />);
    const image = await screen.findByRole("img", { name: "Mermaid 流程图" });
    expect(image.getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
    expect(container.querySelectorAll("[data-mermaid-diagram]")).toHaveLength(1);
    expect(container.querySelectorAll("pre")).toHaveLength(2);
    expect(container.querySelector("details code")?.textContent).toContain("A[开始] --> B[完成]");
    // Untrusted Markdown must not inject SVG; the copy control has a static icon.
    expect(container.querySelector(".av-chat-assistant-body svg")).toBeNull();
  });

  it("turns a path-shaped link into an open request, relative or absolute", async () => {
    const onOpenFileLink = vi.fn();
    const { container } = mount(onOpenFileLink);
    const anchors = [...container.querySelectorAll("a")];
    const relative = anchors.find((a) => a.textContent === "入口")!;
    const absolute = anchors.find((a) => a.textContent === "绝对路径")!;
    await userEvent.click(relative);
    await userEvent.click(absolute);
    expect(onOpenFileLink.mock.calls).toEqual([["src/main.ts"], ["/home/u/proj/lib.ts"]]);
  });

  it("routes a Feishu document URL to the Dock callback and keeps its authored label", async () => {
    const onOpenFileLink = vi.fn();
    const onOpenFeishuLink = vi.fn(() => true);
    const { container } = mount(onOpenFileLink, onOpenFeishuLink);
    await userEvent.click([...container.querySelectorAll("a")].find((a) => a.textContent === "方案")!);
    expect(onOpenFeishuLink).toHaveBeenCalledWith(
      "https://acme.feishu.cn/docx/Abcdef123?from=chat",
      "方案",
    );
    expect(onOpenFileLink).not.toHaveBeenCalled();
  });

  it("leaves a real URL to the anchor, and passes nothing through without a callback", async () => {
    const onOpenFileLink = vi.fn();
    const { container } = mount(onOpenFileLink);
    const url = [...container.querySelectorAll("a")].find((a) => a.textContent === "文档")!;
    // jsdom refuses real navigation; what matters is that OUR handler declined.
    url.addEventListener("click", (event) => event.preventDefault());
    await userEvent.click(url);
    expect(onOpenFileLink).not.toHaveBeenCalled();

    const bare = mount();
    const anchor = [...bare.container.querySelectorAll("a")].find((a) => a.textContent === "入口")!;
    anchor.addEventListener("click", (event) => event.preventDefault());
    await userEvent.click(anchor);
    // No callback, no crash, no synthetic behaviour.
    expect(onOpenFileLink).not.toHaveBeenCalled();
  });
});


describe("input acknowledgement wording", () => {
  const pending: PendingSend = {
    key: "input", resource: "res-1", prompt: "keep my words", kind: "append",
    phase: "done", message: "", projectionSequence: 1, absoluteMessageEnd: 0,
  };
  it.each([
    ["dispatched", "terminal_write", "已写入终端，等待 Agent 确认"],
    ["local_queued", "local_queue", "已在本地排队，等待 Agent 接收"],
    ["provider_accepted", "provider_ack", "✓ Agent 已接收输入"],
    ["input_observed", "native_hook", "✓ Agent 已读取输入"],
  ] as const)("distinguishes %s without inventing turn completion", (phase, evidence, expected) => {
    expect(sendPhaseWord({ ...pending, input: { phase, evidence, at: "2026-09-14T12:00:00Z" } })).toBe(expected);
  });
  it("preserves the legacy absence of an input receipt", () => {
    expect(sendPhaseWord(pending)).toBe("✓ 已送达");
  });

  it("keeps a queued receipt pending until the Agent accepts it", () => {
    const { rerender } = render(<TranscriptView resource="res-1" data={null} status={undefined} busy={false}
      onLoadOlder={() => {}} pendingSends={[{ ...pending,
        input: { phase: "local_queued", evidence: "local_queue", at: "2026-10-13T09:00:00Z" } }]} />);
    expect(screen.getByText("已在本地排队，等待 Agent 接收")).toHaveClass("ev-send-pending");
    expect(screen.getByText(/尚未收到 Agent 接收确认/)).toBeVisible();
    expect(screen.queryByText("正在等待会话记录同步")).not.toBeInTheDocument();
    rerender(<TranscriptView resource="res-1" data={null} status={undefined} busy={false}
      onLoadOlder={() => {}} pendingSends={[{ ...pending,
        input: { phase: "provider_accepted", evidence: "provider_ack", at: "2026-10-13T09:01:00Z" } }]} />);
    expect(screen.getByText("✓ Agent 已接收输入")).toHaveClass("ev-send-confirmed");
    expect(screen.getByText("正在等待会话记录同步")).toBeVisible();
  });

  it("shows an unknown terminal write as a finished outcome and keeps explicit recovery behind details", async () => {
    const onRestoreSend = vi.fn();
    const onDismissSend = vi.fn();
    const message = "结果无法确认 — 请核对本机 CLI";
    const { container, rerender } = render(<TranscriptView resource="res-1" data={null} status={undefined} busy={false}
      onLoadOlder={() => {}} onRestoreSend={onRestoreSend} onDismissSend={onDismissSend}
      pendingSends={[{ ...pending, phase: "uncertain", message,
        input: { phase: "dispatched", evidence: "terminal_write", at: "2026-09-17T07:58:00Z" } }]} />);
    // Unknown is terminal: the dispatch evidence must not turn it back into a wait.
    expect(screen.getByText("? 结果未知")).toHaveAttribute("aria-busy", "false");
    expect(screen.getByText("? 结果未知")).toHaveClass("ev-send-uncertain");
    expect(screen.queryByText("已写入终端，等待 Agent 确认")).not.toBeInTheDocument();
    expect(screen.getByText("可能已送达，不会自动重发。请先查看会话记录，确认没收到再重新发送。")).toBeVisible();
    expect(screen.getByText(message)).not.toBeVisible();
    expect(container.querySelector("details")).not.toHaveAttribute("open");
    expect(onRestoreSend).not.toHaveBeenCalled();
    expect(onDismissSend).not.toHaveBeenCalled();

    await userEvent.click(screen.getByText("查看发送详情"));
    expect(screen.getByText(message)).toBeVisible();
    expect(screen.getByText("已写入终端，但未收到 Agent 确认。")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "放回输入框" }));
    expect(onRestoreSend).toHaveBeenCalledExactlyOnceWith(pending.prompt);
    await userEvent.click(screen.getByRole("button", { name: "清除" }));
    expect(onDismissSend).toHaveBeenCalledExactlyOnceWith(pending.key);

    rerender(<TranscriptView resource="res-1" data={null} status={undefined} busy={false} onLoadOlder={() => {}}
      pendingSends={[{ ...pending, input: { phase: "input_observed", evidence: "native_hook", at: "2026-09-17T07:59:00Z" } }]} />);
    expect(screen.getByText("✓ Agent 已读取输入")).toBeVisible();
    expect(screen.queryByText("查看发送详情")).not.toBeInTheDocument();
    expect(screen.queryByText(/可能已送达/)).not.toBeInTheDocument();
  });

  it.each([undefined, { phase: "dispatched", evidence: "launch_identity", at: "2026-09-17T07:58:00Z" }] as const)(
    "does not infer terminal delivery or queueing without terminal-write evidence (%s)", (input) => {
      render(<TranscriptView resource="res-1" data={null} status={undefined} busy={false} onLoadOlder={() => {}}
        pendingSends={[{ ...pending, phase: "uncertain", ...(input ? { input } : {}) }]} />);
      expect(screen.getByText("? 结果未知")).toBeVisible();
      expect(screen.getByText("可能已送达，不会自动重发。请先查看会话记录，确认没收到再重新发送。")).toBeVisible();
      expect(screen.queryByText(/可能正在排队|已写入终端|已分派|✓ 已送达|⚠/)).not.toBeInTheDocument();
    },
  );

  it.each(["failed", "refused"] as const)("keeps %s reasons and recovery visible", (phase) => {
    render(<TranscriptView resource="res-1" data={null} status={undefined} busy={false} onLoadOlder={() => {}}
      onRestoreSend={vi.fn()} pendingSends={[{ ...pending, phase, message: "Gate 拒绝：没有写入权限" }]} />);
    expect(screen.getByText("Gate 拒绝：没有写入权限")).toBeVisible();
    expect(screen.getByRole("button", { name: "放回输入框" })).toBeVisible();
    expect(screen.queryByText("查看发送详情")).not.toBeInTheDocument();
  });
});


describe("TranscriptView minimal history chrome", () => {
  it.each(["codex", "claude", "omp"])("omits the history bars and live badge for %s while still paging", (cliKind) => {
    const onLoadOlder = vi.fn();
    const data: TranscriptWindow = {
      cliKind, offset: 10, totalMessages: 11,
      messages: [{ role: "user", text: "正文仍然可读" }],
    };
    const view = render(<TranscriptView resource="res-1" data={data}
      status={{ resource: "res-1", state: "live" }} busy={false} onLoadOlder={onLoadOlder} />);
    expect(screen.getByText("正文仍然可读")).toBeInTheDocument();
    expect(view.container.querySelector("[data-av-chat-window]")).toBeNull();
    expect(screen.queryByRole("button", { name: "加载更早" })).toBeNull();
    expect(screen.queryByRole("button", { name: "搜索已读取记录" })).toBeNull();
    expect(screen.queryByText("实时跟随")).toBeNull();
    const scroller = view.container.querySelector<HTMLElement>("[data-av-chat-transcript]")!;
    expect(scroller).toHaveAttribute("data-av-chat-offset", "10");
    expect(scroller).toHaveAttribute("data-av-chat-count", "1");
    expect(scroller).toHaveAttribute("data-av-chat-total", "11");
    Object.defineProperty(scroller, "clientHeight", { value: 600 });
    fireEvent.wheel(scroller, { deltaY: -100 });
    fireEvent.wheel(scroller, { deltaY: -100 });
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    view.rerender(<TranscriptView resource="res-1" data={{ ...data,
      totalMessages: 12, messages: [...(data.messages ?? []), { role: "user", text: "新消息继续到达" }],
    }} status={{ resource: "res-1", state: "live" }} busy={false} onLoadOlder={onLoadOlder} />);
    expect(screen.getByText("新消息继续到达")).toBeInTheDocument();
    expect(screen.queryByText("实时跟随")).toBeNull();
  });

  it.each([
    ["reconnecting", "正在重连"],
    ["paused", "实时读取已暂停；刷新可继续"],
    ["closed", "跟随已停止"],
  ] as const)("retains the %s recovery status", (state, message) => {
    render(<TranscriptView resource="res-1" data={WINDOW}
      status={{ resource: "res-1", state }} busy={false} onLoadOlder={() => {}} />);
    expect(screen.getByText(message)).toBeInTheDocument();
  });
});
