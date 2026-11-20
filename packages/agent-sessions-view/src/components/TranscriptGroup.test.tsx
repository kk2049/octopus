import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TranscriptGroupView, type TranscriptGroupClasses } from "./TranscriptGroup.js";
import { findFilePaths } from "../lib/file-mentions.js";

const classes: TranscriptGroupClasses = {
  card: "card",
  cardLive: "live",
  cardHead: "head",
  cardDetail: "detail",
  label: "label",
  work: "work",
  thinking: "thinking",
  thinkingText: "thinking-text",
  turn: "turn",
  operationMeta: "note",
  role: "role",
  userBody: "user-body",
};

describe("TranscriptGroupView", () => {
  it("reads a page-capped tool output whole, one window per explicit click", async () => {
    const full = "o".repeat(30);
    const read = vi.fn(async (_anchor: string, _field: string, charOffset: number) => (charOffset === 0
      ? { text: full.slice(0, 20), totalChars: 30, nextCharOffset: 20 }
      : { text: full.slice(20), totalChars: 30 }));
    const group = {
      kind: "work" as const, key: "w:7.0", last: true, busy: false,
      entries: [{
        kind: "tool" as const, text: "Bash", anchor: "7.2", input: "cat big", detail: "oooo…", live: false,
        truncated: true, truncatedFields: ["output" as const],
      }],
    };
    const view = render(<TranscriptGroupView classes={classes} group={group} onReadFullBlock={read} expansionOverrides={{ "e:7.2": true }} />);
    // Only the capped field offers it; the input was not capped.
    expect(view.container.querySelectorAll("[data-av-chat-full-field]")).toHaveLength(1);
    expect(read).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "显示完整内容" })); });
    expect(read).toHaveBeenLastCalledWith("7.2", "output", 0);
    expect(screen.getByText(full.slice(0, 20))).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "继续读取（已显示 20/30 字符）" })); });
    expect(read).toHaveBeenLastCalledWith("7.2", "output", 20);
    expect(screen.getByText(full)).toBeInTheDocument();
    expect(view.container.querySelector("[data-av-chat-full-field]")).toBeNull();
  });

  it("keeps a capped field plain when the host or Runner cannot read blocks", () => {
    const entry = { kind: "tool" as const, text: "Bash", anchor: "1.0", input: "x", detail: "y…", live: false, truncated: true };
    const group = { kind: "work" as const, key: "w:1.0", last: true, busy: false, entries: [entry] };
    const legacy = render(<TranscriptGroupView classes={classes} group={group} onReadFullBlock={vi.fn()} expansionOverrides={{ "e:1.0": true }} />);
    expect(legacy.container.querySelector("[data-av-chat-full-field]")).toBeNull();
    legacy.unmount();
    const noHost = render(<TranscriptGroupView classes={classes}
      group={{ ...group, entries: [{ ...entry, truncatedFields: ["output" as const] }] }} expansionOverrides={{ "e:1.0": true }} />);
    expect(noHost.container.querySelector("[data-av-chat-full-field]")).toBeNull();
  });

  it("lazily mounts a historical run once and preserves visited tool nodes across folding", () => {
    const group = {
      kind: "work" as const, key: "w:10.0", last: false, busy: false,
      entries: [{ kind: "tool" as const, text: "Bash", anchor: "10.0", input: "pwd", detail: "/workspace", live: false }],
    };
    const view = render(<TranscriptGroupView classes={classes} group={group} />);
    expect(view.container.querySelector("details.card")).toBeNull();
    const summary = view.container.querySelector("details.work > summary")!;
    fireEvent.click(summary);
    const tool = view.container.querySelector("details.card")!;
    fireEvent.click(tool.querySelector("summary")!);
    expect(tool).toHaveAttribute("open");
    fireEvent.click(summary);
    expect(summary.closest("details")).not.toHaveAttribute("open");
    expect(view.container.querySelector("details.card")).toBe(tool);
    view.rerender(<TranscriptGroupView classes={classes} group={{ ...group, entries: [...group.entries] }} />);
    fireEvent.click(summary);
    expect(view.container.querySelector("details.card")).toBe(tool);
    expect(tool).toHaveAttribute("open");
  });


  it("shows every recorded tool timestamp as Beijing time inside its detail card", () => {
    const { container } = render(
      <TranscriptGroupView
        classes={classes}
        group={{
          kind: "work",
          busy: false,
          entries: [
            {
              kind: "tool",
              text: "Bash",
              at: "2026-08-24T08:30:45.000Z",
              anchor: "4.0",
              input: "pnpm test",
              detail: "passed",
              live: false,
            },
            {
              kind: "tool",
              text: "todo",
              at: "2026-08-24T16:30:45+08:00",
              anchor: "5.0",
              input: JSON.stringify({ op: "init", list: [] }),
              detail: "Overall: 0/0 done, 0 open.",
              live: false,
            },
          ],
          key: "w:tools-with-time",
          last: true,
        }}
        todoCards
      />,
    );

    const times = [...container.querySelectorAll("[data-av-chat-tool-time] time")];
    expect(times.map((node) => node.textContent)).toEqual([
      "2026/8/24 16:30:45",
      "2026/8/24 16:30:45",
    ]);
    expect(times.map((node) => node.getAttribute("datetime"))).toEqual([
      "2026-08-24T08:30:45.000Z",
      "2026-08-24T16:30:45+08:00",
    ]);
    expect(screen.getAllByText("时间（北京时间）", { exact: false })).toHaveLength(2);
  });

  it("keeps an in-flight tool group open for every host", () => {
    const spinner = vi.fn(() => <span>spinner</span>);
    const { container } = render(
      <TranscriptGroupView
        classes={classes}
        group={{
          kind: "work",
          busy: true,
          entries: [{ kind: "tool", text: "Bash", unpaired: true, anchor: "0.0", live: true }],
          key: "w:0.0",
          last: true,
        }}
        renderAssistant={(text) => text}
        renderSpinner={spinner}
      />,
    );
    expect(container.querySelector("details.work")).toHaveAttribute("open");
    expect(container.querySelector("details.card")).toHaveClass("live");
    expect(screen.getByText("spinner")).toBeInTheDocument();
    // The label is rendered as "⏳ 执行中…" (emoji + space + text) in one node,
    // so `getByText` needs the full string — an assertion on "执行中…" alone was
    // silently green until GitLab CI pipeline #15 first ran this file.
    expect(screen.getByText("⏳ 执行中…")).toBeInTheDocument();
  });

  it("delegates only Markdown presentation while retaining turn semantics", () => {
    render(
      <TranscriptGroupView
        classes={classes}
        group={{
          kind: "prose",
          role: "assistant",
          entries: [{ kind: "assistant", text: "**完成**", anchor: "0.0" }],
          key: "p:0.0",
        }}
        renderAssistant={(text) => <strong>{text}</strong>}
      />,
    );
    expect(screen.getByText("🤖 助手")).toBeInTheDocument();
    expect(screen.getByText("**完成**").tagName).toBe("STRONG");
  });

  it("fails closed to a literal React text child when the host omits Markdown", () => {
    const literal = "**完成** <img src=x onerror=alert(1)>";
    const { container } = render(
      <TranscriptGroupView
        classes={classes}
        group={{
          kind: "prose",
          role: "assistant",
          entries: [{ kind: "assistant", text: literal, anchor: "plain.0" }],
          key: "p:plain",
        }}
      />,
    );

    expect(screen.getByText(literal)).toBeInTheDocument();
    expect(container.querySelector("strong, img")).toBeNull();
  });

  it("does not reparse settled assistant Markdown when a whole projection frame is replaced", () => {
    const renderAssistant = vi.fn((text: string) => <strong>{text}</strong>);
    const group = (text: string) => ({
      kind: "prose" as const,
      role: "assistant" as const,
      entries: [{ kind: "assistant" as const, text, anchor: "7.0" }],
      key: "p:7.0",
    });
    const { rerender } = render(
      <TranscriptGroupView
        classes={classes}
        group={group("第一段")}
        renderAssistant={renderAssistant}
      />,
    );
    const initialCalls = renderAssistant.mock.calls.length;

    // The Host authors a fresh object for every projection. Equal text at the
    // same semantic anchor must retain the expensive Markdown subtree.
    rerender(
      <TranscriptGroupView
        classes={classes}
        group={group("第一段")}
        renderAssistant={renderAssistant}
      />,
    );
    expect(renderAssistant).toHaveBeenCalledTimes(initialCalls);

    // The live frontier still updates immediately when its text grows.
    rerender(
      <TranscriptGroupView
        classes={classes}
        group={group("第一段继续")}
        renderAssistant={renderAssistant}
      />,
    );
    expect(renderAssistant).toHaveBeenCalledTimes(initialCalls + 1);
  });

  it("offers a 📝 file entry as an action ONLY when a host passes the callback", async () => {
    const fileGroup = {
      kind: "work" as const,
      busy: false,
      entries: [{
        kind: "file" as const,
        text: "/home/u/proj/src/a.ts",
        input: "",
        anchor: "0.0",
        live: false,
      }],
      key: "w:0.0",
      last: false,
    };
    // Without the callback: plain text, no control — the additive default.
    const plain = render(
      <TranscriptGroupView classes={classes} group={fileGroup} renderAssistant={(text) => text} />,
    );
    fireEvent.click(plain.container.querySelector("details > summary")!);
    expect(plain.container).toHaveTextContent("/home/u/proj/src/a.ts");
    expect(plain.container.querySelector(".ev-file-open")).toBeNull();
    plain.unmount();

    const onOpenFile = vi.fn();
    const { container } = render(
      <TranscriptGroupView
        classes={classes}
        group={fileGroup}
        renderAssistant={(text) => text}
        onOpenFile={onOpenFile}
      />,
    );
    // Historical work is lazy while folded. The same ordinary expand action
    // reveals the file control before it can be clicked.
    expect(container.querySelector(".ev-file-open")).toBeNull();
    fireEvent.click(container.querySelector("details > summary")!);
    const open = container.querySelector(".ev-file-open") as HTMLButtonElement;
    expect(open).toBeTruthy();
    const details = container.querySelector("details.card") as HTMLDetailsElement;
    const wasOpen = details.open;
    open.click();
    expect(onOpenFile).toHaveBeenCalledWith("/home/u/proj/src/a.ts");
    // Opening the file must not also toggle the fold it sits inside.
    expect(details.open).toBe(wasOpen);
  });

  it("puts the files a tool call named at the top of its detail card", () => {
    const group = {
      kind: "work" as const,
      busy: false,
      entries: [{
        kind: "tool" as const,
        text: "Bash",
        anchor: "0.0",
        input: '{"command":"grep -n foo packages/bot/src/index.ts"}',
        detail: "packages/bot/src/index.ts:12: foo\nsrc/other.ts:4: foo\n",
        live: false,
      }],
      key: "w:0.0",
      last: true,
    };
    // No grammar, no strip: this package has no workspace and does not guess.
    const bare = render(
      <TranscriptGroupView classes={classes} group={group} renderAssistant={(text) => text} onOpenFile={vi.fn()} />,
    );
    expect(bare.container.querySelector("[data-av-chat-file-refs]")).toBeNull();
    bare.unmount();

    const onOpenFile = vi.fn();
    const { container } = render(
      <TranscriptGroupView
        classes={classes}
        group={group}
        renderAssistant={(text) => text}
        onOpenFile={onOpenFile}
        extractFilePaths={findFilePaths}
      />,
    );
    const strip = container.querySelector("[data-av-chat-file-refs]")!;
    expect(strip).toBeTruthy();
    const buttons = [...strip.querySelectorAll("button")];
    // Input then output, first-seen order, deduplicated across both.
    expect(buttons.map((button) => button.textContent)).toEqual([
      "packages/bot/src/index.ts",
      "src/other.ts",
    ]);
    const details = container.querySelector("details.card") as HTMLDetailsElement;
    const wasOpen = details.open;
    buttons[1]!.click();
    expect(onOpenFile).toHaveBeenCalledWith("src/other.ts");
    expect(details.open).toBe(wasOpen);
  });

  it("controls ordinary and Todo card folds from the same sticky override store", () => {
    let revision = 0;
    let overrides: Record<string, boolean> = {};
    let rerenderView: (ui: React.ReactNode) => void = () => {};
    const onToggleExpansion = (key: string, open: boolean) => {
      overrides = { ...overrides, [key]: open };
      rerenderView(view());
    };
    const view = () => (
      <TranscriptGroupView
        classes={classes}
        expansionOverrides={overrides}
        group={{
          kind: "work",
          busy: false,
          entries: [
            {
              kind: "tool",
              text: "Bash",
              anchor: "20.0",
              detail: `普通结果 ${revision}`,
              live: false,
            },
            {
              kind: "tool",
              text: "todo",
              anchor: "21.0",
              input: JSON.stringify({ op: "init", list: [] }),
              detail: `Overall: ${revision}/1 done, ${1 - revision} open.`,
              live: false,
            },
          ],
          key: "w:20.0",
          last: true,
        }}
        onToggleExpansion={onToggleExpansion}
        todoCards
      />
    );
    const rendered = render(view());
    rerenderView = rendered.rerender;
    const [ordinaryBefore, todoBefore] = [
      ...rendered.container.querySelectorAll<HTMLDetailsElement>("details.card"),
    ];

    fireEvent.click(ordinaryBefore!.querySelector("summary")!);
    fireEvent.click(todoBefore!.querySelector("summary")!);
    expect(ordinaryBefore).toHaveAttribute("open");
    expect(todoBefore).toHaveAttribute("open");

    revision = 1;
    rendered.rerender(view());
    const [ordinaryAfter, todoAfter] = [
      ...rendered.container.querySelectorAll<HTMLDetailsElement>("details.card"),
    ];
    expect(ordinaryAfter).toBe(ordinaryBefore);
    expect(todoAfter).toBe(todoBefore);
    expect(ordinaryAfter).toHaveAttribute("open");
    expect(todoAfter).toHaveAttribute("open");
  });
});
