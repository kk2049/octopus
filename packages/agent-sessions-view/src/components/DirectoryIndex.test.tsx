import { readFileSync } from "node:fs";
import * as path from "node:path";
import { useState } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { DirectoryCache } from "@claude-bot/agent-workspace-files-view";
import type { WorkspaceFilesRoots } from "@claude-bot/workspace-files-contract";
import { DirectoryIndex, type DirectoryIndexProps } from "./DirectoryIndex.js";
import type { RosterSession } from "../lib/roster.js";

const DAY = 24 * 60 * 60 * 1000;

const AT = (msAgo: number) => new Date(Date.parse("2026-08-01T00:00:00.000Z") - msAgo).toISOString();
const ROOT_KEY = "dk1_aaaaaaaaaaaaaaaa";
const CHILD_KEY = "dk1_bbbbbbbbbbbbbbbb";

function rect(patch: Partial<DOMRect>): DOMRect {
  return {
    x: 0, y: 0, top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0,
    toJSON: () => ({}),
    ...patch,
  } as DOMRect;
}

function session(over: Partial<RosterSession> & { id: string; cwd: string }): RosterSession {
  return {
    resourceId: over.id,
    sessionId: over.id,
    deviceId: "laptop",
    cliKind: "codex",
    ...over,
    id: over.id,
    device: "laptop",
  };
}

const ROOTS: WorkspaceFilesRoots = {
  roots: [{
    ref: "ref_root",
    label: "项目",
    sourceLabel: "laptop",
    directoryKey: ROOT_KEY,
  }],
  truncated: false,
} as never;

const CACHE: DirectoryCache = new Map([
  ["ref_root", {
    status: "ready",
    message: "",
    code: "",
    value: {
      ref: "ref_root",
      label: "项目",
      directoryKey: ROOT_KEY,
      truncated: false,
      entries: [
        { ref: "ref_src", label: "src", kind: "directory", directoryKey: CHILD_KEY },
        { ref: "ref_readme", label: "README.md", kind: "file", sizeBytes: 12 },
      ],
    },
  } as never],
]);

function props(over: Partial<DirectoryIndexProps> = {}): DirectoryIndexProps {
  return {
    sessions: [
      session({ id: "root-session", cwd: "~/project", directoryKey: ROOT_KEY, lastActivity: AT(0) }),
      session({ id: "child-session", cwd: "~/project/src", directoryKey: CHILD_KEY, lastActivity: AT(DAY) }),
    ],
    pinned: [],
    selected: null,
    expanded: { "dev:laptop/~": true },
    workspacesByDevice: {
      laptop: {
        device: "laptop",
        workspaces: [{ id: "ws_root", label: "项目", display: "~/项目", directoryKey: ROOT_KEY }],
      },
    },
    access: [],
    roots: ROOTS,
    rootsStatus: "ready",
    rootsMessage: "",
    cache: CACHE,
    expandedDirs: new Set(["ref_root"]),
    selectedFile: null,
    showFiles: true,
    hideDotEntries: false,
    onToggleHidden: vi.fn(),
    sessionDirectory: null,
    onOpenSessions: vi.fn(),
    onCloseSessions: vi.fn(),
    onRefresh: vi.fn(),
    onSelect: vi.fn(),
    onToggle: vi.fn(),
    onToggleDir: vi.fn(),
    onLoadRoot: vi.fn(),
    onOpenFile: vi.fn(),
    onNewSession: vi.fn(),
    onOpenTerminal: vi.fn(),
    ...over,
  };
}

describe("the file-centred index", () => {
  it.each(["codex", "claude"] as const)("folds %s children in the directory list, preserving explicit expansion", (cliKind) => {
    const parent = session({ id: "parent", cwd: "~/project", directoryKey: ROOT_KEY, title: "Town parent", cliKind });
    const child = session({ id: "worker", cwd: "~/project", directoryKey: ROOT_KEY, title: "Town worker", cliKind, parentResourceId: "parent" });
    const grandchild = session({ id: "nested", cwd: "~/project", directoryKey: ROOT_KEY, title: "Nested worker", cliKind, parentResourceId: "worker" });
    const onSelect = vi.fn();
    function Index({ rows }: { rows: RosterSession[] }) {
      const [expanded, setExpanded] = useState<Record<string, boolean>>({});
      return <DirectoryIndex {...props({
        sessions: rows, pinned: [], expanded, onSelect,
        sessionDirectory: { ref: "ref_root", label: "项目", directoryKey: ROOT_KEY },
        onToggle: (key, open) => setExpanded((current) => ({ ...current, [key]: !open })),
      })} />;
    }
    const view = render(<Index rows={[grandchild, child, parent]} />);
    const directory = screen.getByRole("dialog", { name: "「项目」下的会话" });
    for (const surface of [directory]) {
      expect(within(surface).getByText("Town parent")).toBeInTheDocument();
      expect(within(surface).queryByText("Town worker")).not.toBeInTheDocument();
      const sub = within(surface).getByRole("button", { name: "Town parent的子 Agent（1）" });
      expect(sub).toHaveAttribute("aria-expanded", "false");
      expect(sub).toHaveTextContent("Sub");
      expect(sub).not.toHaveTextContent("子 Agent");
    }
    fireEvent.click(within(directory).getByRole("button", { name: "Town parent的子 Agent（1）" }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(within(directory).getByText("Town worker")).toBeInTheDocument();
    expect(within(directory).queryByText("Nested worker")).not.toBeInTheDocument();
    view.rerender(<Index rows={[{ ...parent }, { ...child }, { ...grandchild }]} />);
    expect(within(directory).getByText("Town worker")).toBeInTheDocument();
    fireEvent.click(within(directory).getByRole("button", { name: "Town worker的子 Agent（1）" }));
    fireEvent.click(within(directory).getByText("Nested worker"));
    expect(onSelect).toHaveBeenCalledWith("nested");
  });

  it("shows named, pinned and parent-missing chats in the directory list", () => {
    const base = { cwd: "~/project", directoryKey: ROOT_KEY };
    const rows = [session({ ...base, id: "parent", title: "Research lead" }),
      session({ ...base, id: "named", title: "Town 4", parentResourceId: "parent", userNamed: true }),
      session({ ...base, id: "pinned", title: "Important worker", parentResourceId: "parent" }),
      session({ ...base, id: "orphan", title: "Available chat", parentResourceId: "missing" })];
    const input = props({ sessions: rows, pinned: ["pinned"],
      sessionDirectory: { ref: "ref_root", label: "项目", directoryKey: ROOT_KEY } });
    render(<DirectoryIndex {...input} />);
    const surface = screen.getByRole("dialog", { name: "「项目」下的会话" });
    for (const title of ["Town 4", "Important worker", "Available chat"]) expect(within(surface).getByText(title)).toBeInTheDocument();
    expect(within(surface).queryByText("父会话暂未列出")).not.toBeInTheDocument();
    fireEvent.click(within(surface).getByText("Town 4"));
    expect(input.onSelect).toHaveBeenCalledWith("named");
  });

  it("keeps independent headless runs directly visible in the directory list", () => {
    const run = session({ id: "exec-run", cwd: "~/project", directoryKey: ROOT_KEY, title: "Background run", executionMode: "exec" });
    function Index() {
      const [expanded, setExpanded] = useState<Record<string, boolean>>({});
      return <DirectoryIndex {...props({ sessions: [run], expanded,
        sessionDirectory: { ref: "ref_root", label: "项目" },
        onToggle: (key, open) => setExpanded((current) => ({ ...current, [key]: !open })),
      })} />;
    }
    render(<Index />);
    const directory = screen.getByRole("dialog", { name: "「项目」下的会话" });
    expect(within(directory).getByText("Background run")).toBeInTheDocument();
  });

  it("keeps cached sessions visible while the progressive roster is still loading", () => {
    render(<DirectoryIndex {...props({ refreshing: true })} />);
    expect(screen.queryByText("正在扫描最新会话")).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "目录索引异常" })).toBeEmptyDOMElement();
    expect(document.querySelector(".rosterpane")).toHaveAttribute("aria-busy", "true");
    expect(document.querySelector(".home-device")).toHaveTextContent("laptop");
  });

  it.each([false, true])("keeps a fixed empty status footer through healthy scans (narrow=%s)", (narrow) => {
    const input = props({ narrow });
    const view = render(<DirectoryIndex {...input} />);
    const footer = screen.getByRole("status", { name: "目录索引异常" });
    const tree = document.querySelector(".directory-file-tree");
    const file = screen.getByRole("button", { name: /README\.md/ });
    file.focus();
    for (const pending of [true, false, true, false]) {
      view.rerender(<DirectoryIndex {...input} refreshing={pending} indexPending={pending}
        rootsStatus={pending ? "loading" : "ready"} sources={[{ device: "laptop", online: true }, { device: "unknown" }]} />);
      expect(screen.getByRole("status", { name: "目录索引异常" })).toBe(footer);
      expect(footer).toBeEmptyDOMElement();
      expect(footer).not.toHaveAttribute("tabindex");
      expect(screen.queryByText(/正在扫描|正在列出工作区/)).not.toBeInTheDocument();
      expect(document.querySelector(".directory-file-tree")).toBe(tree);
      expect(file).toHaveFocus();
    }
  });

  it.each([false, true])("contains failures and recovery in the same footer (showFiles=%s)", (showFiles) => {
    const input = props({ showFiles });
    const view = render(<DirectoryIndex {...input} />);
    const footer = screen.getByRole("status", { name: "目录索引异常" });
    const tree = document.querySelector("[data-av-file-tree]");
    view.rerender(<DirectoryIndex {...input} refreshing indexPending rootsStatus="refused"
      rootsMessage="读取被拒绝：需要文件授权"
      sources={[{ device: "laptop", deviceLabel: "工作电脑", online: false },
        { device: "laptop", deviceLabel: "工作电脑", online: false },
        { device: "unknown" }]} />);
    expect(footer).toHaveTextContent("工作电脑 离线，会话列表可能不是最新。");
    expect(footer.textContent?.match(/工作电脑/g)).toHaveLength(1);
    expect(footer).toHaveAttribute("tabindex", "0");
    expect(footer.textContent).not.toContain("unknown");
    if (showFiles) expect(within(footer).getByText("读取被拒绝：需要文件授权")).toHaveAttribute("data-av-file-refusal");
    else expect(within(footer).queryByText("读取被拒绝：需要文件授权")).not.toBeInTheDocument();
    expect(document.querySelector("[data-av-file-tree]")).toBe(tree);
    expect(footer.parentElement?.lastElementChild).toBe(footer);
    view.rerender(<DirectoryIndex {...input} />);
    expect(screen.getByRole("status", { name: "目录索引异常" })).toBe(footer);
    expect(footer).toBeEmptyDOMElement();
    expect(document.querySelector("[data-av-file-tree]")).toBe(tree);
  });

  it("keeps an honest fallback when a refusal has no message", () => {
    render(<DirectoryIndex {...props({ rootsStatus: "refused" })} />);
    expect(screen.getByRole("status", { name: "目录索引异常" })).toHaveTextContent("无法列出工作区。");
  });

  it("bounds long errors inside a footer whose height does not depend on content", () => {
    const css = readFileSync(path.resolve("packages/agent-sessions-view/src/sessions.css"), "utf8");
    const footer = css.match(/\.directory-index-status\s*\{([^}]*)\}/s)?.[1] ?? "";
    expect(footer).toMatch(/flex:\s*0 0 var\(--av-control-h-md\)/);
    expect(footer).toMatch(/box-sizing:\s*border-box/);
    expect(footer).toMatch(/overflow:\s*auto/);
    expect(footer).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it("shows a home-rooted lazy file tree without session rows of its own", () => {
    render(<DirectoryIndex {...props()} />);
    expect(screen.queryByRole("heading", { name: "文件" })).not.toBeInTheDocument();
    expect(document.querySelector(".home-device")).toHaveTextContent("laptop");
    expect(screen.getByRole("treeitem", { name: /~/ })).toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: /项目/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /README\.md/ })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "最近会话" })).toBeNull();
    expect(document.querySelector('.sess[data-id="root-session"]')).toBeNull();
    const folders = [...document.querySelectorAll(".directory-file-tree .wsdir")];
    expect(folders.length).toBeGreaterThan(0);
    expect(folders.every((row) => row.querySelector(".wsglyph-folder"))).toBe(true);
    expect(document.querySelector(".directory-file-tree")?.textContent).not.toContain("📁");
  });

  it("opens a device-keyed terminal from the physical-machine row", async () => {
    const user = userEvent.setup();
    const value = props();
    render(<DirectoryIndex {...value} />);
    await user.click(screen.getByRole("button", { name: "打开 laptop 的远端终端" }));
    expect(value.onOpenTerminal).toHaveBeenCalledWith("laptop");
  });

  it("does not offer a terminal for a files-only scan source", () => {
    render(<DirectoryIndex {...props({
      sessions: [],
      workspacesByDevice: {},
      roots: {
        roots: [{ ref: "ref_scan", label: "Archive", sourceLabel: "cold-store" }],
        truncated: false,
      } as never,
    })} />);

    expect(document.querySelector(".home-device")).toHaveTextContent("cold-store");
    expect(screen.queryByRole("button", { name: "打开 cold-store 的远端终端" })).toBeNull();
    expect(screen.getByRole("button", { name: /cold-store 的终端不可用/ })).toBeDisabled();
  });

  it("keeps known Runner terminals visible before workspace replies and after cache eviction", async () => {
    const value = props({ workspacesByDevice: {}, devices: ["laptop", "empty-runner"] });
    render(<DirectoryIndex {...value} />);
    fireEvent.click(screen.getByRole("button", { name: "打开 laptop 的远端终端" }));
    expect(value.onOpenTerminal).toHaveBeenCalledWith("laptop");
    expect(screen.getByRole("button", { name: "打开 empty-runner 的远端终端" })).toBeEnabled();
  });

  it("preserves the listing lineage when the unified index opens a file", async () => {
    const user = userEvent.setup();
    const value = props();
    render(<DirectoryIndex {...value} />);
    await user.click(screen.getByRole("button", { name: /README\.md/ }));
    expect(value.onOpenFile).toHaveBeenCalledWith(
      { kind: "workspace-text", ref: "ref_readme", label: "README.md" },
      {
        rootRef: "ref_root",
        labels: ["README.md"],
        annotationRoot: "display:laptop:%E9%A1%B9%E7%9B%AE",
      },
    );
  });

  it("offers one directory action with the exact-key subtree count", async () => {
    const user = userEvent.setup();
    const value = props();
    render(<DirectoryIndex {...value} />);
    await user.click(screen.getByRole("button", { name: "查看「项目」子树下的 2 个会话" }));
    expect(value.onOpenSessions).toHaveBeenCalledWith({
      ref: "ref_root",
      label: "项目",
      directoryKey: ROOT_KEY,
    });
  });

  it("offers launch actions on every resolvable folder and blue history markers where sessions exist", () => {
    render(<DirectoryIndex {...props()} />);
    expect([...document.querySelectorAll<HTMLElement>("[data-new-directory]")]
      .map((button) => button.dataset.newDirectory))
      .toEqual(["~", "~/项目", "~/项目/src"]);
    expect(screen.getByRole("button", { name: "查看「~」子树下的 2 个会话" }))
      .toHaveClass("directory-sessions-trigger");
    expect(screen.getByRole("button", { name: "查看「项目」子树下的 2 个会话" }))
      .toHaveClass("directory-sessions-trigger");
    expect(screen.getByRole("button", { name: "查看「src」子树下的 1 个会话" }))
      .toHaveClass("directory-sessions-trigger");
  });

  it("lists shallow sessions first in a dialog and selects through the existing callback", async () => {
    const user = userEvent.setup();
    const value = props({
      sessionDirectory: { ref: "ref_root", label: "项目", directoryKey: ROOT_KEY },
    });
    render(<DirectoryIndex {...value} />);
    const dialog = screen.getByRole("dialog", { name: "「项目」下的会话" });
    expect(dialog).toHaveClass("directory-sessions-popover");
    expect(document.querySelector(".ant-modal-mask")).toBeNull();
    const depths = within(dialog).getAllByText(/当前目录|下 1 层/).map((row) => row.textContent);
    expect(depths).toEqual(["当前目录", "下 1 层"]);
    await user.click(within(dialog).getByText("child-session"));
    expect(value.onSelect).toHaveBeenCalledWith("child-session");
    expect(value.onCloseSessions).toHaveBeenCalledTimes(1);
  });

  it("repositions a bottom-anchored history panel upward and keeps a useful base height", () => {
    const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 60,
      y: 730,
      left: 60,
      right: 100,
      top: 730,
      bottom: 752,
      width: 40,
      height: 22,
      toJSON: () => ({}),
    });
    try {
      render(<DirectoryIndex {...props({
        sessionDirectory: { ref: "ref_root", label: "项目", directoryKey: ROOT_KEY },
      })} />);
      const dialog = screen.getByRole("dialog", { name: "「项目」下的会话" });
      expect(dialog).toHaveStyle({ top: "540px", minHeight: "220px", maxHeight: "220px" });
    } finally {
      bounds.mockRestore();
    }
  });

  it("does not attach an unkeyed session to a different displayed file directory", () => {
    render(<DirectoryIndex {...props({
      sessions: [session({ id: "unkeyed", cwd: "~/project" })],
    })} />);
    expect(screen.getByRole("button", { name: "查看「~」子树下的 1 个会话" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /查看「项目」子树下的.*会话/ })).toBeNull();
  });
});

describe("the phone layer's rail chrome (ticket #181)", () => {
  const ACCESS: DirectoryIndexProps["access"] = [
    { operation: "list_directory", title: "列出目录", effective: true, alwaysApprove: true, autoAllow: false },
    { operation: "write_file", title: "写入文件", effective: false, alwaysApprove: false, autoAllow: false },
  ];

  it("keeps only functional controls above the index on a wide viewport", () => {
    render(<DirectoryIndex {...props({ access: ACCESS })} />);
    expect(screen.getByRole("button", { name: "刷新工作区目录" })).toBeInTheDocument();
    expect(document.querySelector(".wsaccess")).toBeNull();
    expect(document.querySelector(".wsaccess-fold")).toBeNull();
    expect(document.querySelector("[data-av-session-source-note]")).toBeNull();
    // The global launch moved to the sessions view header.
    expect(screen.queryByRole("button", { name: "在任意目录启动 Agent" })).toBeNull();
  });

  it("stands the refresh down and omits standing explanations when narrow", () => {
    render(<DirectoryIndex {...props({ access: ACCESS, narrow: true })} />);
    // The rail is one screen on a phone; the index still lists at mount and on
    // every wake, so the manual copy is what gives way — the callback is not.
    expect(screen.queryByRole("button", { name: "↻" })).toBeNull();
    expect(document.querySelector(".wsaccess-fold")).toBeNull();
    expect(screen.queryByText("权限")).not.toBeInTheDocument();
    // The standing legend for ＋ / .. / 🗄 goes with them: three rows of help
    // text pushed the tree below the fold on every visit.
    expect(document.querySelector("[data-av-session-source-note]")).toBeNull();
    // What must NOT move: the rows themselves.
    expect(screen.getByRole("treeitem", { name: /项目/ })).toBeInTheDocument();
    // The dot-entry knob is NOT chrome the phone layer can trade away: a home
    // directory full of dotfiles is exactly as unbrowsable there (ticket #350).
    expect(screen.getByRole("button", { name: "隐藏 . 开头的项" })).toBeInTheDocument();
  });

  it("focuses a revealed cwd and keeps its deferred scroll inside the workspace index", async () => {
    const boxes = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("directory-file-tree")) return rect({ top: 60, bottom: 360, height: 300 });
      if (this.matches('.wsdir[data-ref="ref_root"]')) return rect({ top: 260, bottom: 290, height: 30 });
      return rect({});
    });
    try {
      render(<DirectoryIndex {...props({
        revealDirectory: { requestId: 1, ref: "ref_root" },
      })} />);
      const target = document.querySelector<HTMLElement>('.wsdir[data-ref="ref_root"]')!;
      const scroller = document.querySelector<HTMLElement>("[data-av-file-tree-rows]")!;
      await waitFor(() => {
        expect(target).toHaveFocus();
        expect(scroller.scrollTop).toBe(200);
      });
    } finally {
      boxes.mockRestore();
    }
  });

  it("waits for the phone layer to accept focus even after it has geometry", async () => {
    const boxes = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("directory-file-tree")) return rect({ top: 60, height: 300 });
      if (this.matches('.wsdir[data-ref="ref_root"]')) return rect({ top: 260, height: 30 });
      return rect({});
    });
    const nativeFocus = HTMLElement.prototype.focus;
    const focus = vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement, options) {
      if (!this.closest("[inert]")) nativeFocus.call(this, options);
    });
    try {
      render(<div data-av-dock-workspace data-av-narrow="1" data-av-dock-mobile-section="navigation" inert>
        <DirectoryIndex {...props({ revealDirectory: { requestId: 1, ref: "ref_root" } })} />
      </div>);
      const target = document.querySelector<HTMLElement>('.wsdir[data-ref="ref_root"]')!;
      await waitFor(() => expect(focus).toHaveBeenCalled());
      expect(target).not.toHaveFocus();
      document.querySelector("[data-av-dock-workspace]")!.removeAttribute("inert");
      await waitFor(() => expect(target).toHaveFocus());
      expect(document.querySelector<HTMLElement>("[data-av-file-tree-rows]")!.scrollTop).toBe(200);
    } finally {
      focus.mockRestore();
      boxes.mockRestore();
    }
  });

  it("offers the dot-entry knob on both layers and reports what the row is showing", async () => {
    const user = userEvent.setup();
    const onToggleHidden = vi.fn();
    const { rerender } = render(<DirectoryIndex {...props({ onToggleHidden })} />);
    const shown = screen.getByRole("button", { name: "隐藏 . 开头的项" });
    expect(shown).toHaveAttribute("aria-pressed", "false");
    await user.click(shown);
    expect(onToggleHidden).toHaveBeenCalledWith(false);

    rerender(<DirectoryIndex {...props({ onToggleHidden, hideDotEntries: true })} />);
    const hidden = screen.getByRole("button", { name: "显示隐藏项" });
    expect(hidden).toHaveAttribute("aria-pressed", "true");
    await user.click(hidden);
    expect(onToggleHidden).toHaveBeenLastCalledWith(true);
  });

  it("drops dot-prefixed rows from the tree while the knob is on", () => {
    const dotted: DirectoryCache = new Map([["ref_root", {
      status: "ready",
      message: "",
      code: "",
      value: {
        ref: "ref_root",
        label: "项目",
        directoryKey: ROOT_KEY,
        truncated: false,
        entries: [
          { ref: "ref_git", label: ".git", kind: "directory" },
          { ref: "ref_src", label: "src", kind: "directory", directoryKey: CHILD_KEY },
        ],
      },
    } as never]]);
    const { rerender } = render(<DirectoryIndex {...props({ cache: dotted })} />);
    expect(document.querySelector('.wsdir[data-ref="ref_git"]')).not.toBeNull();

    rerender(<DirectoryIndex {...props({ cache: dotted, hideDotEntries: true })} />);
    expect(document.querySelector('.wsdir[data-ref="ref_src"]')).not.toBeNull();
    expect(document.querySelector('.wsdir[data-ref="ref_git"]')).toBeNull();
  });

  it("omits the standing permission story from the file-centred index", () => {
    render(<DirectoryIndex {...props({ access: ACCESS, narrow: true })} />);
    expect(document.querySelectorAll(".wsaccess, .wsaccess-fold, .wsaccess-chip")).toHaveLength(0);
  });

  it("applies the same rule to the degraded session index", () => {
    render(<DirectoryIndex {...props({
      showFiles: false,
      roots: null,
      cache: new Map(),
      expandedDirs: new Set(),
      access: ACCESS,
      narrow: true,
    })} />);
    expect(screen.queryByRole("button", { name: "↻" })).toBeNull();
    expect(document.querySelector(".wsaccess-fold")).not.toBeNull();
    expect(document.querySelector(".wsaccess-fold > .wsaccess")).not.toBeNull();
  });
});

describe("the no-files degradation", () => {
  it("keeps the reusable session index when no files provider was composed", () => {
    render(<DirectoryIndex {...props({ showFiles: false, roots: null, cache: new Map(), expandedDirs: new Set() })} />);
    expect(screen.getByRole("heading", { name: "目录" })).toBeInTheDocument();
    expect(document.querySelector(".recenthead")).toBeNull();
    expect(screen.queryByRole("heading", { name: "文件" })).toBeNull();
  });

  it("still reveals long-idle directories in that degraded tree", async () => {
    const user = userEvent.setup();
    const value = props({
      showFiles: false,
      roots: null,
      cache: new Map(),
      expandedDirs: new Set(),
      sessions: [
        session({ id: "fresh", cwd: "~/now", lastActivity: AT(0) }),
        session({ id: "gone", cwd: "~/deleted-worktree", lastActivity: AT(90 * DAY) }),
      ],
    });
    render(<DirectoryIndex {...value} />);
    const reveal = screen.getByText(/还有 1 个久未活动的目录/);
    await user.click(reveal);
    expect(value.onToggle).toHaveBeenCalledWith("idle:dev:laptop/~", false);
  });
});
