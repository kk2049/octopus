import { useState } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SessionFolder, SessionsReply } from "@claude-bot/agent-sessions-contract";
import { SESSION_DRAG_TYPE, SessionNavigator, type SessionNavigatorProps } from "./SessionNavigator.js";
import { SharedSessionsIndex } from "./DirectoryIndex.js";
import type { RosterSession } from "../lib/roster.js";

const DAY = 24 * 60 * 60 * 1000;
const AT = (msAgo: number) => new Date(Date.parse("2026-08-01T00:00:00.000Z") - msAgo).toISOString();
const OK: SessionsReply = { ok: true, result: null, message: "" };
const TMUX = { process_state: "alive", turn_state: "idle", attachment: { kind: "terminal_tmux", state: "attached", transport: "tmux" } };

function session(id: string, over: Partial<RosterSession> = {}): RosterSession {
  return {
    resourceId: id, id, sessionId: id, deviceId: "laptop", device: "laptop", cliKind: "codex",
    cwd: "~/project", cwdDisplay: "~/project", title: id, lastActivity: AT(0), ...over,
  };
}

function props(over: Partial<SessionNavigatorProps> = {}): SessionNavigatorProps {
  return {
    roster: [session("alpha", { title: "Alpha", sortActivity: AT(0) }), session("beta", { title: "Beta", sortActivity: AT(DAY) })],
    pinned: [],
    folders: [],
    selected: null,
    expanded: {},
    organize: true,
    filter: "",
    onFilter: vi.fn(),
    onSearchAll: vi.fn(),
    onSelect: vi.fn(),
    onToggle: vi.fn(),
    onRefresh: vi.fn(),
    onNewSession: vi.fn(),
    onSetPinned: vi.fn(async () => OK),
    onRename: vi.fn(async () => OK),
    onSaveFolder: vi.fn(async () => OK),
    onDeleteFolder: vi.fn(async () => OK),
    onFile: vi.fn(async () => OK),
    ...over,
  };
}

/** Keeps expansion like the module instance does, so disclosure is exercised for real. */
function Stateful(over: Partial<SessionNavigatorProps> & { initialFilter?: string }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState(over.initialFilter ?? "");
  return <SessionNavigator {...props(over)} expanded={expanded} filter={filter} onFilter={setFilter}
    onToggle={(key, open) => setExpanded((current) => ({ ...current, [key]: !open }))} />;
}

const rowIds = (surface: HTMLElement) =>
  [...surface.querySelectorAll("[data-av-session-row], [data-av-nav-missing]")]
    .map((node) => node.getAttribute("data-av-session-row") ?? `missing:${node.getAttribute("data-av-nav-missing")}`);

function transfer() {
  const data = new Map<string, string>();
  return {
    setData: (type: string, value: string) => { data.set(type, value); },
    getData: (type: string) => data.get(type) ?? "",
    get types() { return [...data.keys()]; },
    dropEffect: "none",
    effectAllowed: "all",
  };
}

describe("session navigator sections", () => {
  it("shows favorites first in pin order, then folders, recent chats and collapsed automated runs", () => {
    render(<Stateful
      roster={[
        session("terminal", { title: "Terminal", runtime: TMUX, sortActivity: AT(5 * DAY) }),
        session("fresh", { title: "Fresh", sortActivity: AT(0) }),
        session("favorite", { title: "Favorite", sortActivity: AT(9 * DAY) }),
        session("run", { title: "Harness run", executionMode: "exec", sortActivity: AT(0) }),
        session("filed", { title: "Filed" }),
      ]}
      pinned={["favorite"]}
      folders={[{ id: "f_a", name: "Project A", sessions: ["filed"] }]}
    />);
    const sections = [...document.querySelectorAll("[data-av-nav-section]")].map((node) => node.getAttribute("data-av-nav-section"));
    expect(sections).toEqual(["favorites", "folders", "recent", "automated"]);
    expect(rowIds(screen.getByRole("region", { name: "收藏" }))).toEqual(["favorite"]);
    // A favorite is never ranked below a foreground terminal again.
    expect(rowIds(screen.getByRole("region", { name: "最近会话" }))).toEqual(["terminal", "fresh"]);
    expect(within(screen.getByRole("region", { name: "最近会话" })).getByText("· tmux")).toBeInTheDocument();
    const automated = screen.getByRole("region", { name: "自动化任务" });
    expect(within(automated).getByRole("button", { name: /自动化任务/ })).toHaveAttribute("aria-expanded", "false");
    expect(rowIds(automated)).toEqual([]);
    fireEvent.click(within(automated).getByRole("button", { name: /自动化任务/ }));
    expect(rowIds(automated)).toEqual(["run"]);
    // Folders start collapsed but show their count.
    const folder = document.querySelector<HTMLElement>('[data-av-nav-folder="f_a"]')!;
    expect(within(folder).getByRole("button", { name: /文件夹 Project A，1 个会话/ })).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(within(folder).getByRole("button", { name: /文件夹 Project A/ }));
    expect(rowIds(folder)).toEqual(["filed"]);
  });

  it("shows the stable activity timestamp and running or review state on each row", () => {
    render(<SessionNavigator {...props({ roster: [
      session("long-running", { sortActivity: AT(DAY), lastActivity: AT(0) }),
      session("running", { needsReview: true, runtime: { process_state: "alive", turn_state: "working" } }),
      session("completed", { needsReview: true, runtime: { process_state: "alive", turn_state: "idle" } }),
    ] })} />);
    const metadata = document.querySelector('.sess[data-id="long-running"] .m');
    expect(metadata).toHaveTextContent("7/31 08:00");
    expect(metadata).not.toHaveTextContent("2026");
    const running = document.querySelector('.sess[data-id="running"]')!;
    const completed = document.querySelector('.sess[data-id="completed"]')!;
    expect(running.querySelector("[data-av-session-live]")).toHaveAttribute("aria-label", "Agent 正在运行");
    expect(running.querySelector(".review-dot")).toBeNull();
    expect(completed.querySelector(".review-dot")).toHaveAttribute("aria-label", "运行结果待验收");
  });

  it("folds provider-declared children under the parent and keeps a pinned child directly visible", () => {
    render(<Stateful roster={[
      session("parent", { title: "Town parent" }),
      session("worker", { title: "Town worker", parentResourceId: "parent" }),
      session("pinned-worker", { title: "Important worker", parentResourceId: "parent" }),
    ]} pinned={["pinned-worker"]} />);
    const recent = screen.getByRole("region", { name: "最近会话" });
    expect(within(recent).queryByText("Town worker")).not.toBeInTheDocument();
    fireEvent.click(within(recent).getByRole("button", { name: "Town parent的子 Agent（1）" }));
    expect(within(recent).getByText("Town worker")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "收藏" })).getByText("Important worker")).toBeInTheDocument();
  });

  it("keeps a kept chat that left the frame visible and openable", () => {
    const value = props({ pinned: ["gone"], customTitles: { gone: "微信备份" } });
    render(<SessionNavigator {...value} />);
    const favorites = screen.getByRole("region", { name: "收藏" });
    expect(rowIds(favorites)).toEqual(["missing:gone"]);
    expect(within(favorites).getByText("微信备份")).toBeInTheDocument();
    expect(within(favorites).getByText(/不在当前名册/)).toBeInTheDocument();
    fireEvent.click(within(favorites).getByText("微信备份"));
    expect(value.onSelect).toHaveBeenCalledWith("gone");
  });

  it("keeps cached rows usable and the list mounted while a refresh is pending", () => {
    const value = props({ refreshing: true });
    const view = render(<SessionNavigator {...value} />);
    expect(document.querySelector("[data-av-session-navigator]")).toHaveAttribute("aria-busy", "true");
    const row = screen.getByText("Alpha");
    fireEvent.click(row);
    expect(value.onSelect).toHaveBeenCalledWith("alpha");
    view.rerender(<SessionNavigator {...value} refreshing={false} />);
    expect(screen.getByText("Alpha")).toBe(row);
    expect(document.querySelector("[data-av-session-navigator]")).not.toHaveAttribute("aria-busy");
  });
});

describe("session navigator filter", () => {
  it("narrows every section, opens collapsed ones while filtering and hands Enter to full-text search", async () => {
    const user = userEvent.setup();
    const value = { onSearchAll: vi.fn() };
    render(<Stateful {...value}
      roster={[session("run", { title: "Venmo run", executionMode: "exec" }), session("chat", { title: "Paper notes" })]}
      folders={[{ id: "f_a", name: "Papers", sessions: [] }]} />);
    await user.type(screen.getByRole("searchbox", { name: "筛选会话" }), "venmo");
    expect(rowIds(screen.getByRole("region", { name: "自动化任务" }))).toEqual(["run"]);
    expect(screen.queryByText("Paper notes")).not.toBeInTheDocument();
    expect(document.querySelector('[data-av-nav-folder="f_a"]')).toBeNull();
    await user.keyboard("{Enter}");
    expect(value.onSearchAll).toHaveBeenCalledWith("venmo");
    await user.keyboard("{Escape}");
    expect(screen.getByRole("searchbox", { name: "筛选会话" })).toHaveValue("");
    expect(screen.getByText("Paper notes")).toBeInTheDocument();
  });
});

describe("session navigator organisation", () => {
  it("pins, renames and files one chat through the row menu", async () => {
    const user = userEvent.setup();
    const value = props({ folders: [{ id: "f_a", name: "Project A", sessions: [] }] });
    render(<SessionNavigator {...value} />);
    await user.click(screen.getByRole("button", { name: "Alpha 的更多操作" }));
    expect(screen.getByRole("menu", { name: "Alpha" })).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "收藏" }));
    expect(value.onSetPinned).toHaveBeenCalledWith(["alpha"], true);

    await user.click(screen.getByRole("button", { name: "Alpha 的更多操作" }));
    await user.click(screen.getByRole("menuitem", { name: /移到文件夹/ }));
    expect(screen.getByRole("menu", { name: "移到文件夹" })).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Project A" }));
    expect(value.onFile).toHaveBeenCalledWith(["alpha"], "f_a");

    await user.click(screen.getByRole("button", { name: "Alpha 的更多操作" }));
    await user.click(screen.getByRole("menuitem", { name: "重命名" }));
    const input = screen.getByRole("textbox", { name: "会话名称" });
    await user.clear(input);
    await user.type(input, "微信备份{Enter}");
    expect(value.onRename).toHaveBeenCalledWith("alpha", "微信备份");
    // Enter in the inline editor never opened the chat underneath.
    expect(value.onSelect).not.toHaveBeenCalled();
  });

  it("opens the same menu from a right-click and keeps it away from the input boxes", () => {
    render(<SessionNavigator {...props()} />);
    fireEvent.contextMenu(screen.getByText("Beta"), { clientX: 40, clientY: 50 });
    expect(screen.getByRole("menu", { name: "Beta" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("menu", { name: "Beta" }), { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("creates a folder inline and files the chats that were dropped onto the folder header", async () => {
    const user = userEvent.setup();
    const value = props();
    render(<SessionNavigator {...value} />);
    const data = transfer();
    fireEvent.dragStart(document.querySelector('[data-av-session-row="alpha"]')!, { dataTransfer: data });
    expect(JSON.parse(data.getData(SESSION_DRAG_TYPE))).toEqual(["alpha"]);
    const folders = screen.getByRole("region", { name: "文件夹" });
    fireEvent.dragOver(folders, { dataTransfer: data });
    expect(folders).toHaveClass("drop");
    fireEvent.drop(folders, { dataTransfer: data });
    const name = screen.getByRole("textbox", { name: "新文件夹名称" });
    await user.type(name, " 微信 备份 {Enter}");
    const folderId = vi.mocked(value.onSaveFolder).mock.calls[0]![0];
    expect(folderId).toMatch(/^f_[a-z0-9]{12}$/);
    expect(value.onSaveFolder).toHaveBeenCalledWith(folderId, "微信 备份");
    expect(value.onFile).toHaveBeenCalledWith(["alpha"], folderId);
  });

  it("drags a Ctrl-selected group onto a folder, favorites or back to recent", async () => {
    const value = props({
      roster: [session("a", { title: "A" }), session("b", { title: "B" }), session("c", { title: "C" })],
      folders: [{ id: "f_a", name: "Project A", sessions: [] } satisfies SessionFolder],
    });
    render(<SessionNavigator {...value} />);
    fireEvent.click(screen.getByText("A"), { ctrlKey: true });
    fireEvent.click(screen.getByText("C"), { ctrlKey: true });
    expect(value.onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole("toolbar", { name: "已选会话操作" })).toHaveTextContent("已选 2 个");
    expect(document.querySelectorAll(".sess.chosen")).toHaveLength(2);

    const data = transfer();
    fireEvent.dragStart(document.querySelector('[data-av-session-row="c"]')!, { dataTransfer: data });
    expect(JSON.parse(data.getData(SESSION_DRAG_TYPE)).sort()).toEqual(["a", "c"]);
    const folder = document.querySelector<HTMLElement>('[data-av-nav-folder="f_a"]')!;
    fireEvent.dragOver(folder, { dataTransfer: data });
    await act(async () => { fireEvent.drop(folder, { dataTransfer: data }); });
    expect(vi.mocked(value.onFile).mock.calls[0]![0].slice().sort()).toEqual(["a", "c"]);
    expect(value.onFile).toHaveBeenCalledWith(expect.any(Array), "f_a");

    const single = transfer();
    fireEvent.dragStart(document.querySelector('[data-av-session-row="b"]')!, { dataTransfer: single });
    const favorites = screen.getByRole("region", { name: "收藏" });
    fireEvent.dragOver(favorites, { dataTransfer: single });
    await act(async () => { fireEvent.drop(favorites, { dataTransfer: single }); });
    expect(value.onSetPinned).toHaveBeenCalledWith(["b"], true);

    const back = transfer();
    fireEvent.dragStart(document.querySelector('[data-av-session-row="b"]')!, { dataTransfer: back });
    await act(async () => { fireEvent.drop(screen.getByRole("region", { name: "最近会话" }), { dataTransfer: back }); });
    expect(value.onFile).toHaveBeenLastCalledWith(["b"], "");
  });

  it("selects a Shift range in display order and clears the selection with Escape", () => {
    render(<SessionNavigator {...props({
      roster: [session("a", { title: "A", sortActivity: AT(0) }), session("b", { title: "B", sortActivity: AT(1) }),
        session("c", { title: "C", sortActivity: AT(2) })],
    })} />);
    fireEvent.click(screen.getByText("A"), { ctrlKey: true });
    fireEvent.click(screen.getByText("C"), { shiftKey: true });
    expect(screen.getByRole("toolbar", { name: "已选会话操作" })).toHaveTextContent("已选 3 个");
    fireEvent.keyDown(document.querySelector("[data-av-session-navigator]")!, { key: "Escape" });
    expect(screen.queryByRole("toolbar", { name: "已选会话操作" })).not.toBeInTheDocument();
  });

  it("renames and deletes a folder from its own menu", async () => {
    const user = userEvent.setup();
    const value = props({ folders: [{ id: "f_a", name: "Old", sessions: ["alpha"] }] });
    render(<SessionNavigator {...value} />);
    await user.click(screen.getByRole("button", { name: "Old 文件夹的更多操作" }));
    await user.click(screen.getByRole("menuitem", { name: "重命名文件夹" }));
    const input = screen.getByRole("textbox", { name: "文件夹名称" });
    await user.clear(input);
    await user.type(input, "New{Enter}");
    expect(value.onSaveFolder).toHaveBeenCalledWith("f_a", "New");
    await user.click(screen.getByRole("button", { name: "Old 文件夹的更多操作" }));
    await user.click(screen.getByRole("menuitem", { name: /删除文件夹/ }));
    expect(value.onDeleteFolder).toHaveBeenCalledWith("f_a");
  });

  it("shows a refusal as one bounded notice and never retries it", async () => {
    const user = userEvent.setup();
    const onFile = vi.fn(async (): Promise<SessionsReply> => ({ ok: false, code: "handler_rejected", result: null, message: "文件夹里最多放 2000 个会话" }));
    render(<SessionNavigator {...props({ onFile, folders: [{ id: "f_a", name: "Full", sessions: [] }] })} />);
    await user.click(screen.getByRole("button", { name: "Alpha 的更多操作" }));
    await user.click(screen.getByRole("menuitem", { name: /移到文件夹/ }));
    await user.click(screen.getByRole("menuitem", { name: "Full" }));
    expect(await screen.findByText("文件夹里最多放 2000 个会话")).toHaveAttribute("data-av-nav-notice");
    expect(onFile).toHaveBeenCalledTimes(1);
  });

  it("offers no organisation to a port without it, nor to a guest", () => {
    const { rerender } = render(<SessionNavigator {...props({ organize: false })} />);
    expect(screen.queryByRole("region", { name: "文件夹" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Alpha 的更多操作" })).not.toBeInTheDocument();
    expect(document.querySelector('[data-av-session-row="alpha"]')).not.toHaveAttribute("draggable");
    rerender(<SessionNavigator {...props({ sharedOnly: true, shared: <p>shared list</p> })} />);
    expect(screen.getByText("shared list")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "在任意目录启动 Agent" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "最近会话" })).not.toBeInTheDocument();
  });
});

describe("shared sessions in the navigator", () => {
  it("opens an issued share through the owner's own resource", () => {
    const onSelect = vi.fn();
    render(<SharedSessionsIndex props={{
      sessions: [session("root-session")],
      sharedSessions: [{ shareId: "sh_one", title: "Shared project", resourceId: "root-session", tokenLimit: 1_500_000, tokensUsed: 100, expiresAt: Date.now() + DAY, revoked: false, canPrompt: true }],
      onSelect,
    }} />);
    fireEvent.click(within(screen.getByRole("region", { name: "共享会话" })).getByRole("button"));
    expect(onSelect).toHaveBeenCalledWith("root-session");
  });

  it("keeps a guest on the one shared chat", () => {
    const onSelect = vi.fn();
    const onOpenShared = vi.fn();
    render(<SharedSessionsIndex props={{
      sharedOnly: true,
      sessions: [session("one")],
      sharedSessions: [{ shareId: "sh_one", title: "Shared project", tokenLimit: 1_500_000, tokensUsed: 100, expiresAt: Date.now() + DAY, revoked: false, canPrompt: true }],
      onOpenShared,
      onSelect,
    }} />);
    fireEvent.click(within(screen.getByRole("region", { name: "共享会话" })).getByRole("button"));
    expect(onSelect).toHaveBeenCalledWith("one");
    expect(onOpenShared).not.toHaveBeenCalled();
  });
});
