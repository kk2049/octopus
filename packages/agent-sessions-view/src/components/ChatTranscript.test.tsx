/**
 * The shared chat shell, rendered exactly as a host would: classes, Markdown,
 * spinner and chip all injected. What is asserted is the behaviour both hosts
 * rely on — window arithmetic, load-earlier gating, injected renderers actually
 * being used, and the turn classes a host-side stream (the dev ticket
 * conversation) keys its styling on.
 */

import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TranscriptWindow } from "@claude-bot/agent-sessions-contract";
import {
  ChatTranscript,
  SHARED_CHAT_CLASSES,
  type ChatTranscriptClasses,
} from "./ChatTranscript.js";
import { ChatTurn } from "./TranscriptGroup.js";

const CLASSES: ChatTranscriptClasses = {
  transcript: "t-scroll",
  windowbar: "t-windowbar",
  hint: "t-hint",
  card: "t-card",
  cardLive: "t-live",
  cardHead: "t-card-head",
  cardDetail: "t-card-detail",
  label: "t-label",
  work: "t-work",
  thinking: "t-think",
  thinkingText: "t-think-text",
  turn: "t-turn",
  operationMeta: "t-meta",
  userTurn: "t-user",
  assistantTurn: "t-assistant",
  metaTurn: "t-pipe",
  pendingTurn: "t-pending",
  role: "t-role",
  userBody: "t-user-body",
  assistantBody: "t-assistant-body",
};

function shell(data: TranscriptWindow | null, over: Partial<Parameters<typeof ChatTranscript>[0]> = {}) {
  return (
    <ChatTranscript
      busy={false}
      classes={CLASSES}
      data={data}
      onLoadOlder={() => {}}
      renderAssistant={(text) => <em data-testid="md">{text}</em>}
      renderSpinner={() => <span data-testid="spin" />}
      resource="r-1"
      {...over}
    />
  );
}

describe("ChatTranscript", () => {
  it("collapses Claude thoughts and tools together, preserving order and reader choices across refresh and prepend", async () => {
    const user = userEvent.setup();
    const data: TranscriptWindow = {
      cliKind: "claude", offset: 10, totalMessages: 13,
      messages: [
        { role: "user", text: "检查实现" },
        { role: "assistant", blocks: [
          { type: "tool", tool: "Read", output: "source" },
          { type: "thinking", text: "确认实现后修改" },
          { type: "tool", tool: "Edit", output: "patched" },
          { type: "thinking", text: "完成检查" },
        ] },
        { role: "assistant", text: "修改完成" },
      ],
    };
    const { container, rerender } = render(shell(data));
    const work = container.querySelector(".t-work")!;
    expect(container.querySelectorAll(".t-work")).toHaveLength(1);
    expect(work).not.toHaveAttribute("open");
    expect(screen.queryByText("确认实现后修改")).toBeNull();
    expect(screen.getByText("检查实现")).toBeVisible();
    expect(screen.getByText("修改完成")).toBeVisible();
    await user.click(work.querySelector("summary")!);
    expect(work).toHaveAttribute("open");
    expect([...work.querySelectorAll("[data-av-chat-work-kind]")].map((node) => node.getAttribute("data-av-chat-work-kind")))
      .toEqual(["tool", "thinking", "tool", "thinking"]);
    const prepended = { ...data, offset: 9, messages: [{ role: "assistant", text: "更早的回答" }, ...data.messages!] };
    rerender(shell(prepended));
    expect(container.querySelector(".t-work")).toBe(work);
    expect(work).toHaveAttribute("open");
    await user.click(work.querySelector("summary")!);
    rerender(shell({ ...prepended, messages: [...prepended.messages] }));
    expect(work).not.toHaveAttribute("open");
  });

  it.each([false, true])("keeps Claude's last process run collapsed even while busy (thinking=%s)", async (withThinking) => {
    const user = userEvent.setup();
    const data: TranscriptWindow = {
      cliKind: "claude", offset: 0, totalMessages: 1, activity: { state: "tool" },
      messages: [{ role: "assistant", blocks: [
        ...(withThinking ? [{ type: "thinking", text: "准备执行" }] : []),
        { type: "tool", tool: "Bash", input: "pwd" },
      ] }],
    };
    const { container, rerender } = render(shell(data));
    const work = container.querySelector(".t-work")!;
    expect(work).not.toHaveAttribute("open");
    expect(work).toHaveTextContent("执行中");
    await user.click(work.querySelector("summary")!);
    expect(work).toHaveAttribute("open");
    rerender(shell({ ...data, activity: { state: "idle" } }));
    expect(work).toHaveAttribute("open");
  });
  it("says how to begin when no resource is selected", () => {
    render(shell(null, { resource: null, idleText: "先选一个。" }));
    expect(screen.getByText("先选一个。")).toBeInTheDocument();
    expect(document.querySelector(".t-windowbar")).toBeNull();
  });

  it("shows the loading hint and the host's chip before the window arrives", () => {
    render(shell(null, { chip: <i data-testid="chip" />, loadingText: "读取中…" }));
    expect(screen.getByTestId("chip")).toBeInTheDocument();
    expect(screen.getByText("读取中…")).toBeInTheDocument();
  });

  it("renders the window bar arithmetic and both prose roles through injection", () => {
    render(
      shell({
        messages: [
          { role: "user", blocks: [{ type: "text", text: "问题" }] },
          { role: "assistant", blocks: [{ type: "text", text: "**回答**" }] },
        ],
        offset: 1,
        totalMessages: 3,
      }),
    );
    expect(screen.getByText("共 3 条 · 当前 2–3（尾窗 2）")).toBeInTheDocument();
    // The assistant body went through the injected renderer, verbatim.
    expect(screen.getByTestId("md")).toHaveTextContent("**回答**");
    expect(document.querySelector(".t-turn.t-user")).not.toBeNull();
    expect(document.querySelector(".t-turn.t-assistant")).not.toBeNull();
  });
  it("shows Chinese and exact Claude English as two labelled versions", () => {
    render(shell({
      messages: [
        {
          role: "user",
          blocks: [{
            type: "text",
            text: "Check the build.",
            bilingual: { zh: "检查构建。", en: "Check the build." },
          }],
        },
        {
          role: "assistant",
          blocks: [{
            type: "text",
            text: "The build passes.",
            bilingual: { zh: "构建已通过。", en: "The build passes." },
          }],
        },
      ],
    }));

    expect(screen.getAllByText("中文")).toHaveLength(2);
    expect(screen.getAllByText("English")).toHaveLength(2);
    expect(screen.getByText("检查构建。")).toBeInTheDocument();
    expect(screen.getByText("Check the build.")).toBeInTheDocument();
    expect(screen.getAllByTestId("md").map((entry) => entry.textContent))
      .toEqual(["构建已通过。", "The build passes."]);
  });


  it("uses literal text when the complete transcript host omits its renderer", () => {
    const literal = "# not a heading <script>alert(1)</script>";
    const { container } = render(shell({
      messages: [{ role: "assistant", blocks: [{ type: "text", text: literal }] }],
      offset: 0,
      totalMessages: 1,
    }, { renderAssistant: undefined }));

    expect(screen.getByText(literal)).toBeInTheDocument();
    expect(container.querySelector("h1, script")).toBeNull();
  });

  it("reveals only the final assistant prose with a fast bounded typewriter", () => {
    vi.useFakeTimers();
    try {
      const answer = "这是最后一段由 Agent 输出的扁平文本；它应该快速逐字出现，而不是在一次绘制中整块闪到读者面前。";
      const view = render(shell(null, { animateLastAssistant: true }));
      view.rerender(shell({
        messages: [
          { role: "user", blocks: [{ type: "text", text: "请给出结论" }] },
          { role: "assistant", blocks: [{ type: "text", text: answer }] },
        ],
        offset: 0,
        totalMessages: 2,
      }, { animateLastAssistant: true }));

      expect(screen.getByTestId("md").textContent).not.toBe(answer);
      expect(answer.startsWith(screen.getByTestId("md").textContent ?? "")).toBe(true);
      act(() => vi.advanceTimersByTime(2_000));
      expect(screen.getByTestId("md")).toHaveTextContent(answer);
    } finally {
      vi.useRealTimers();
    }
  });

  it("also animates a short fresh answer, but never replays links or another resource's history", () => {
    vi.useFakeTimers();
    try {
      const short = "好的，已完成。";
      const view = render(shell(null, { animateLastAssistant: true }));
      view.rerender(shell({
        messages: [{ role: "assistant", blocks: [{ type: "text", text: short }] }],
      }, { animateLastAssistant: true }));
      expect(screen.getByTestId("md").textContent).not.toBe(short);
      act(() => vi.advanceTimersByTime(500));
      expect(screen.getByTestId("md")).toHaveTextContent(short);

      const link = "结果见 https://example.test/report";
      view.rerender(shell({
        messages: [{ role: "assistant", blocks: [{ type: "text", text: link }] }],
      }, { animateLastAssistant: true, resource: "r-2" }));
      expect(screen.getByTestId("md")).toHaveTextContent(link);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ships one structural class map for both hosts", () => {
    render(
      shell(
        { messages: [{ role: "user", blocks: [{ type: "text", text: "共享气泡" }] }], offset: 0, totalMessages: 1 },
        { classes: SHARED_CHAT_CLASSES, chip: <i data-testid="shared-chip" /> },
      ),
    );
    const scroller = document.querySelector(`.${SHARED_CHAT_CLASSES.transcript}`)!;
    const content = scroller.querySelector(":scope > .av-chat-content")!;
    expect(content.firstElementChild).toHaveClass(SHARED_CHAT_CLASSES.windowbar);
    expect(content.children[1]).toBe(screen.getByTestId("shared-chip"));
    expect(document.querySelector(
      `.${SHARED_CHAT_CLASSES.turn}.${SHARED_CHAT_CLASSES.userTurn} .${SHARED_CHAT_CLASSES.userBody}`,
    )).toHaveTextContent("共享气泡");
  });

  it("enables load-earlier only when older messages exist and nothing is in flight", async () => {
    const user = userEvent.setup();
    let calls = 0;
    const { rerender } = render(
      shell(
        { messages: [{ role: "user", blocks: [{ type: "text", text: "x" }] }], offset: 5, totalMessages: 6 },
        { onLoadOlder: () => calls++ },
      ),
    );
    await user.click(screen.getByRole("button", { name: "加载更早" }));
    expect(calls).toBe(1);

    rerender(
      shell(
        { messages: [{ role: "user", blocks: [{ type: "text", text: "x" }] }], offset: 5, totalMessages: 6 },
        { onLoadOlder: () => calls++, busy: true },
      ),
    );
    expect(screen.getByRole("button", { name: "加载更早" })).toBeDisabled();

    rerender(
      shell({ messages: [{ role: "user", blocks: [{ type: "text", text: "x" }] }], offset: 0, totalMessages: 1 }),
    );
    expect(screen.getByRole("button", { name: "加载更早" })).toBeDisabled();
  });

  it("says so when the window arrived empty", () => {
    render(shell({ messages: [], offset: 0, totalMessages: 0 }, { emptyText: "(还没有内容)" }));
    expect(screen.getByText("(还没有内容)")).toBeInTheDocument();
  });

  it("renders an OMP thought-tool run as one ordered timeline with a Todo progress card", () => {
    const { container } = render(
      shell({
        cliKind: "omp",
        messages: [{
          role: "assistant",
          blocks: [
            { type: "thinking", text: "先建立清单" },
            {
              type: "tool",
              tool: "todo",
              input: JSON.stringify({
                op: "init",
                list: [{ phase: "Implementation", items: ["Inspect grouping", "Ship change"] }],
              }),
              output: [
                "Remaining items (2):",
                "  - Inspect grouping [in_progress] (Implementation)",
                "  - Ship change [pending] (Implementation)",
                "Overall: 0/2 done, 2 open.",
                'Active phase 1/1 "Implementation" (0/2).',
              ].join("\n"),
            },
            { type: "thinking", text: "清单就绪，开始实现" },
            { type: "tool", tool: "Read", input: "src/transcript.ts", output: "ok" },
          ],
        }],
        offset: 0,
        totalMessages: 1,
      }),
    );

    expect(screen.getByText("🧭 2 次思考 · 2 个工具调用")).toBeInTheDocument();
    expect([...container.querySelectorAll("[data-av-chat-work-kind]")].map(
      (node) => node.getAttribute("data-av-chat-work-kind"),
    )).toEqual(["thinking", "tool", "thinking", "tool"]);
    expect(container.querySelector(".av-chat-work-thinking")).toHaveTextContent("先建立清单");
    expect(container.querySelector(".av-chat-work-thinking-label")).toBeNull();
    expect(screen.queryByText("💭 思考")).toBeNull();
    expect(screen.getByLabelText("Todo 完成进度")).toHaveAttribute("max", "2");
    expect(screen.getByText("0/2 已完成")).toBeInTheDocument();
    expect(screen.getByText("Inspect grouping")).toBeInTheDocument();
    expect(screen.getByText("进行中")).toBeInTheDocument();
  });

  it("marks an in-flight tool with the injected spinner while the session is busy", () => {
    render(
      shell({
        messages: [{ role: "assistant", blocks: [{ type: "tool", tool: "Bash", input: "ls" }] }],
        offset: 0,
        totalMessages: 1,
        activity: { state: "tool", tool: "Bash" },
      }),
    );
    expect(screen.getByTestId("spin")).toBeInTheDocument();
  });

  it("keeps the streaming tool card's identity and user fold when its result becomes formal", () => {
    const streaming: TranscriptWindow = {
      messages: [{ role: "assistant", blocks: [{ type: "tool", tool: "Bash", input: "pnpm test" }] }],
      offset: 12,
      totalMessages: 13,
      activity: { state: "tool", tool: "Bash" },
    };
    const view = render(shell(streaming));
    const cardBefore = view.container.querySelector<HTMLDetailsElement>("details.t-card")!;
    expect(cardBefore).toHaveClass("t-live");
    fireEvent.click(cardBefore.querySelector("summary")!);
    expect(cardBefore).toHaveAttribute("open");

    view.rerender(shell({
      ...streaming,
      activity: { state: "idle" },
      messages: [{
        role: "assistant",
        blocks: [{ type: "tool", tool: "Bash", input: "pnpm test", output: "passed" }],
      }],
    }));

    const cardAfter = view.container.querySelector<HTMLDetailsElement>("details.t-card")!;
    expect(cardAfter).toBe(cardBefore);
    expect(cardAfter).toHaveAttribute("open");
    expect(cardAfter).not.toHaveClass("t-live");
    expect(screen.getByText("passed")).toBeInTheDocument();
    expect(screen.queryByTestId("spin")).toBeNull();
  });
});

describe("ChatTurn", () => {
  it("applies the meta and pending classes a host-side stream keys on", () => {
    render(
      <ChatTurn classes={CLASSES} label="⚙ pipeline" pending role="meta">
        <div>已合入</div>
      </ChatTurn>,
    );
    const turn = document.querySelector(".t-turn");
    expect(turn?.className).toContain("t-pipe");
    expect(turn?.className).toContain("t-pending");
    expect(screen.getByText("⚙ pipeline")).toBeInTheDocument();
    expect(screen.getByText("已合入")).toBeInTheDocument();
  });
});

describe("chat history while scrolling upwards", () => {
  function historyViewport(clientHeight = 600, initialHeight = 1_600) {
    const onLoadOlder = vi.fn();
    let scrollHeight = initialHeight;
    let scrollTop = 0;
    // This fixture models whole-content height, independently of row measurement.
    let props = { resource: "r-1", busy: false, onLoadOlder, virtualize: false };
    let data: TranscriptWindow = {
      offset: 600, totalMessages: 602,
      messages: [
        { role: "user", blocks: [{ type: "text", text: "当前问题" }] },
        { role: "assistant", blocks: [{ type: "text", text: "当前回答" }] },
      ],
    };
    const view = render(shell(data, props));
    const scroller = view.container.querySelector<HTMLDivElement>(".t-scroll")!;
    const writes = vi.fn((value: number) => {
      scrollTop = Math.max(0, Math.min(value, Math.max(0, scrollHeight - clientHeight)));
    });
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, get: () => clientHeight },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: { configurable: true, get: () => scrollTop, set: writes },
    });
    const update = (next: { offset?: number; busy?: boolean; resource?: string; height?: number } = {}) => {
      scrollHeight = next.height ?? scrollHeight;
      props = { ...props, busy: next.busy ?? props.busy, resource: next.resource ?? props.resource };
      const offset = next.offset ?? data.offset ?? 0;
      const added = (data.offset ?? 0) - offset;
      data = {
        ...data, offset,
        messages: added > 0 ? [
          ...Array.from({ length: added }, (_, i) => ({
            role: i % 2 === 0 ? "user" : "assistant",
            blocks: [{ type: "text" as const, text: `历史 ${offset + i}` }],
          })),
          ...(data.messages ?? []),
        ] : data.messages,
      };
      view.rerender(shell(data, props));
    };
    update(); // Measure the initial tail with browser-like scrollTop clamping.
    writes.mockClear();
    const scrollTo = (top: number) => {
      scroller.scrollTop = top;
      fireEvent.scroll(scroller);
    };
    const resize = (height: number, viewport = clientHeight) => {
      scrollHeight = height;
      clientHeight = viewport;
      // Browser clamping can emit scroll before the content ResizeObserver.
      scrollTop = Math.min(scrollTop, Math.max(0, scrollHeight - clientHeight));
      fireEvent.scroll(scroller);
    };
    return { scroller, onLoadOlder, update, scrollTo, resize, writes };
  }

  it("keeps the initial tail pinned when row measurements and viewport growth clamp scrollTop", () => {
    const h = historyViewport();
    h.resize(1_500);
    expect(h.scroller.scrollTop).toBe(900);
    expect(screen.queryByRole("button", { name: "回到最新" })).toBeNull();
    h.update({ height: 1_700 });
    expect(h.scroller.scrollTop).toBe(1_100);
    h.resize(1_700, 700);
    h.update({ height: 1_800 });
    expect(h.scroller.scrollTop).toBe(1_100);
    expect(h.onLoadOlder).not.toHaveBeenCalled();
  });

  it.each(["wheel", "touch", "pointer", "keyboard"])("preserves %s reading intent during a simultaneous height correction", (input) => {
    const h = historyViewport();
    if (input === "wheel") fireEvent.wheel(h.scroller, { deltaY: -20 });
    if (input === "touch") {
      fireEvent.touchStart(h.scroller, { touches: [{ clientY: 100 }] });
      fireEvent.touchMove(h.scroller, { touches: [{ clientY: 130 }] });
    }
    if (input === "pointer") fireEvent.pointerDown(h.scroller, { pointerType: "mouse" });
    if (input === "keyboard") fireEvent.keyDown(h.scroller, { key: "ArrowUp" });
    h.resize(1_500);
    if (input === "pointer") fireEvent.pointerUp(h.scroller, { pointerType: "mouse" });
    if (input === "touch") fireEvent.touchEnd(h.scroller, { touches: [] });
    h.update({ height: 1_700 });
    expect(h.scroller.scrollTop).toBe(900);
    expect(screen.getByRole("button", { name: "回到最新" })).toBeInTheDocument();
  });

  it.each([600, 900])("loads before reaching the top in a %ipx viewport and preserves the visible row", (height) => {
    const h = historyViewport(height);
    expect(h.onLoadOlder).not.toHaveBeenCalled();
    h.scrollTo(400);
    expect(h.onLoadOlder).not.toHaveBeenCalled();
    h.scrollTo(200);
    expect(h.onLoadOlder).toHaveBeenCalledTimes(1);
    h.scrollTo(100);
    fireEvent.wheel(h.scroller, { deltaY: -60 });
    expect(h.onLoadOlder).toHaveBeenCalledTimes(1);

    h.update({ busy: true });
    h.scrollTo(0);
    const oldRow = screen.getByText("当前问题");
    h.update({ offset: 400, height: 2_200 });
    expect(h.scroller.scrollTop).toBe(600);
    expect(screen.getByText("当前问题")).toBe(oldRow);
    h.update({ busy: false });
    expect(h.onLoadOlder).toHaveBeenCalledTimes(1);

    h.scrollTo(200);
    expect(h.onLoadOlder).toHaveBeenCalledTimes(2);
    h.update({ offset: 200, height: 2_800 });
    expect(h.scroller.scrollTop).toBe(800);
    h.scrollTo(200);
    expect(h.onLoadOlder).toHaveBeenCalledTimes(3);
    h.update({ offset: 0, height: 3_400 });
    h.scrollTo(0);
    fireEvent.wheel(h.scroller, { deltaY: -60 });
    expect(h.onLoadOlder).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("button", { name: "加载更早" })).toBeDisabled();
  });

  it("uses a phone's upward-reading touch even when a folded page cannot scroll", () => {
    const h = historyViewport(600, 300);
    expect(h.onLoadOlder).not.toHaveBeenCalled();
    fireEvent.touchStart(h.scroller, { touches: [{ clientY: 150 }] });
    fireEvent.touchMove(h.scroller, { touches: [{ clientY: 100 }] });
    expect(h.onLoadOlder).not.toHaveBeenCalled();
    fireEvent.touchMove(h.scroller, { touches: [{ clientY: 200 }] });
    expect(h.onLoadOlder).toHaveBeenCalledTimes(1);
    fireEvent.touchEnd(h.scroller, { touches: [] });
    h.update({ busy: true });
    h.update({ offset: 400, height: 500 });
    expect(h.onLoadOlder).toHaveBeenCalledTimes(1);
    // Continue only after the prior read settles; compact pages do not strand
    // a reader who has already asked to scroll beyond the current window.
    h.update({ busy: false });
    expect(h.onLoadOlder).toHaveBeenCalledTimes(2);
    h.update({ offset: 200, height: 1_300 });
    expect(h.scroller.scrollTop).toBe(700);
    expect(h.onLoadOlder).toHaveBeenCalledTimes(2);
  });

  it("does not retry a refused or unchanged cursor on scrolling, refresh, or busy settlement", () => {
    const h = historyViewport();
    h.scrollTo(150);
    h.update({ busy: true });
    h.update({ busy: false });
    h.update();
    h.scrollTo(500);
    h.scrollTo(0);
    fireEvent.wheel(h.scroller, { deltaY: -100 });
    expect(h.onLoadOlder).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "加载更早" }));
    expect(h.onLoadOlder).toHaveBeenCalledTimes(2);
    h.update({ busy: true });
    fireEvent.click(screen.getByRole("button", { name: "加载更早" }));
    expect(h.onLoadOlder).toHaveBeenCalledTimes(2);
  });

  it("waits for an existing read and cancels continuation when the reader scrolls down", () => {
    const h = historyViewport();
    h.update({ busy: true });
    h.scrollTo(150);
    expect(h.onLoadOlder).not.toHaveBeenCalled();
    h.update({ busy: false });
    expect(h.onLoadOlder).toHaveBeenCalledTimes(1);
    fireEvent.wheel(h.scroller, { deltaY: 80 });
    h.update({ offset: 400, height: 1_620 });
    expect(h.onLoadOlder).toHaveBeenCalledTimes(1);
    h.scrollTo(100);
    expect(h.onLoadOlder).toHaveBeenCalledTimes(2);
  });

  it("keeps unrelated paints and live appends from writing into upward momentum", () => {
    const h = historyViewport();
    h.scrollTo(150);
    h.writes.mockClear();
    h.update({ busy: true });
    h.update({ height: 1_700 });
    expect(h.writes).not.toHaveBeenCalled();
    expect(h.scroller.scrollTop).toBe(150);
    expect(h.onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it("forgets the previous stream's cursor and upward intent on a resource switch", () => {
    const h = historyViewport();
    h.scrollTo(150);
    expect(h.onLoadOlder).toHaveBeenCalledTimes(1);
    h.update({ resource: "r-2" });
    expect(h.scroller.scrollTop).toBe(1_000);
    expect(h.onLoadOlder).toHaveBeenCalledTimes(1);
    h.scrollTo(150);
    expect(h.onLoadOlder).toHaveBeenCalledTimes(2);
  });

  it("does not load history in a hidden panel", () => {
    const h = historyViewport(0);
    h.scrollTo(0);
    fireEvent.wheel(h.scroller, { deltaY: -100 });
    expect(h.onLoadOlder).not.toHaveBeenCalled();
  });
});


describe("bounded transcript rows", () => {
  function measuredViewport() {
    const height = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.dataset.index !== undefined ? 112 : 720;
    });
    const width = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return { x: 0, y: 0, top: 0, left: 0, bottom: this.dataset.index !== undefined ? 112 : 720, right: 800,
        width: 800, height: this.dataset.index !== undefined ? 112 : 720, toJSON() {} };
    });
    return () => { height.mockRestore(); width.mockRestore(); rect.mockRestore(); };
  }
  it("bounds 800 alternating rows and retains selected rows when scrolling away", () => {
    const restore = measuredViewport();
    try {
      const data = { offset: 0, totalMessages: 800, messages: Array.from({ length: 800 }, (_, index) => ({
        role: index % 2 ? "assistant" : "user", text: "history " + index,
      })) };
      const view = render(shell(data));
      const rows = view.container.querySelectorAll<HTMLElement>("[data-av-virtual-row]");
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.length).toBeLessThan(40);
      const selected = rows[0]!;
      const selection = document.getSelection()!;
      const range = document.createRange();
      range.selectNodeContents(selected);
      selection.removeAllRanges();
      selection.addRange(range);
      fireEvent(document, new Event("selectionchange"));
      const scroll = view.container.querySelector<HTMLElement>("[data-av-chat-transcript]")!;
      scroll.scrollTop = 50_000;
      fireEvent.scroll(scroll);
      expect(selected.isConnected).toBe(true);
      expect(view.container.querySelectorAll("[data-av-virtual-row]").length).toBeLessThan(60);
      selection.removeAllRanges();
      fireEvent(document, new Event("selectionchange"));
      view.unmount();
    } finally { restore(); }
  });
  it("searches collapsed tool records from the entire loaded window and opens the matching disclosure", async () => {
    const data: TranscriptWindow = {
      offset: 0, totalMessages: 4, messages: [
        { role: "assistant", blocks: [{ type: "tool", tool: "Read", input: "/hidden/needle.txt", output: "needle result" }] },
        { role: "user", text: "next request" },
        { role: "assistant", text: "last answer" },
        { role: "assistant", blocks: [{ type: "tool", tool: "Bash", input: "pwd", output: "/tmp" }] },
      ],
    };
    const view = render(shell(data));
    expect(view.container.querySelector("details.t-work")).not.toHaveAttribute("open");
    await userEvent.click(screen.getByRole("button", { name: "搜索已读取记录" }));
    fireEvent.change(screen.getByRole("textbox", { name: "搜索已读取记录" }), { target: { value: "needle" } });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 220)); });
    expect(screen.getByText("1 组匹配")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "下一处" }));
    expect(view.container.querySelector("details.t-work")).toHaveAttribute("open");
    expect(view.container.querySelector("details.t-card")).toHaveAttribute("open");
  });
});
