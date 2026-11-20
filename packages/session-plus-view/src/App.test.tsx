/**
 * The App, driven through the same direct runtime API as its Host.
 *
 * ── What this file is for, and what it is NOT ───────────────────────────────
 *
 * It covers the half of the boundary that has a non-browser equivalent: what
 * the View SENDS, what it does with what it RECEIVES, and whether hostile
 * projection content can become markup. The other half — cookies, cross-origin
 * DOM, CSP actually blocking a fetch, layout, real focus behaviour — has no
 * equivalent here and stays in `packages/bot/src/session-plus/browser.e2e.test.ts`
 * against real Chromium. Nothing below replaces a browser property with a
 * string assertion.
 *
 * ── Why it still tests behaviour after modularisation ───────────────────────
 *
 * The orchestration moved to `@claude-bot/agent-sessions-view`, and that package
 * has its own tests for the rules. These are the same tests as before because
 * they check something different: that THIS App, assembled from those modules
 * over its own transport, behaves the way the shipped release behaves. A
 * regression in the wiring would pass every unit test in every package and fail
 * here.
 *
 * Several assertions pin DOM hooks (`#composer`, `.sess`,
 * `[data-av-chat-transcript]`, `[data-av-dock-*]`, …). Those are a CONTRACT rather than styling:
 * the browser suite reads them from outside the frame, and deleting one turns
 * that suite into a batch of silent 30-second timeouts. This is the cheap guard
 * that fails first and says why.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentViewProvider,
  createAppRuntimeClient,
  type AppRuntimeReply,
  type AgentViewClient,
} from "@claude-bot/agent-view-react";
import type { SessionsProjection } from "@claude-bot/agent-sessions-contract";
import { App } from "./App.js";

const ORIGINAL_SCROLL_INTO_VIEW = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");

afterEach(() => {
  if (ORIGINAL_SCROLL_INTO_VIEW) {
    Object.defineProperty(Element.prototype, "scrollIntoView", ORIGINAL_SCROLL_INTO_VIEW);
  } else {
    Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  }
});

interface Proposal {
  rid: string;
  action: string;
  params: Record<string, string>;
  [key: string]: unknown;
}

interface Harness {
  client: AgentViewClient;
  proposals: Proposal[];
  checkpoints: string[];
  boot(projection: SessionsProjection, revision?: number, recovery?: string): Promise<void>;
  view(projection: SessionsProjection, revision?: number): Promise<void>;
  operation(record: Record<string, unknown>): Promise<void>;
  /** Answer every proposal not yet answered. */
  settle(reply?: { ok?: boolean; code?: string; message?: string }): Promise<void>;
  taken(action: string): Proposal[];
}

/** The navigator keeps every view mounted; only the selected one is accessible. */
async function showView(name: "会话列表" | "文件树" | "全文搜索"): Promise<void> {
  await userEvent.click(screen.getByRole("tab", { name }));
}

function tick(): Promise<void> {
  return act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function rect(patch: Partial<DOMRect>): DOMRect {
  return {
    x: 0, y: 0, top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0,
    toJSON: () => ({}),
    ...patch,
  } as DOMRect;
}

const ROOT_DIRECTORY_KEY = "dk1_aaaaaaaaaaaaaaaa";
const ROOT_REF = "wf_root";

function defaultProposalResult(proposal: Proposal): unknown {
  if (proposal.action === "resource.refresh_roots") {
    return {
      roots: [{
        ref: ROOT_REF,
        label: "Session Plus",
        sourceLabel: "laptop",
        directoryKey: ROOT_DIRECTORY_KEY,
      }],
      truncated: false,
    };
  }
  if (proposal.action === "resource.list_directory") {
    return {
      ref: proposal.params.ref,
      label: "Session Plus",
      directoryKey: ROOT_DIRECTORY_KEY,
      entries: [{ ref: "wf_readme", label: "README.md", kind: "file", sizeBytes: 12 }],
      truncated: false,
    };
  }
  return null;
}

function harness(resultFor: (proposal: Proposal) => unknown = defaultProposalResult): Harness {
  const proposals: Proposal[] = [];
  const checkpoints: string[] = [];
  const pending = new Map<string, (reply: AppRuntimeReply) => void>();
  let restoredRecovery: string | null = null;
  const runtime = createAppRuntimeClient({
    dispatch: (action, params) => new Promise((resolve) => {
      const rid = "proposal-" + proposals.length;
      proposals.push({ rid, action, params });
      pending.set(rid, resolve);
    }),
    onRecovery: (checkpoint) => checkpoints.push(checkpoint),
  });
  // The fixture chooses its boot checkpoint after mounting a waiting view.
  // Production gives the known browser checkpoint to the runtime constructor.
  let cachedSource: ReturnType<typeof runtime.snapshot> | null = null;
  let cachedSnapshot = runtime.snapshot();
  const client: AgentViewClient = { ...runtime, snapshot() {
    const source = runtime.snapshot();
    if (source !== cachedSource) {
      cachedSource = source;
      cachedSnapshot = { ...source, recovery: restoredRecovery };
    }
    return cachedSnapshot;
  } };
  return {
    client, proposals, checkpoints,
    async boot(projection, revision, recovery) {
      restoredRecovery = recovery ?? null;
      act(() => runtime.update(projection, revision));
      await tick();
    },
    async view(projection, revision) {
      act(() => runtime.update(projection, revision));
      await tick();
    },
    async operation(record) {
      act(() => runtime.operation(record));
      await tick();
    },
    async settle(reply) {
      await tick();
      await act(async () => {
        for (const proposal of proposals) {
          const resolve = pending.get(proposal.rid);
          if (!resolve) continue;
          pending.delete(proposal.rid);
          resolve(reply?.ok === false
            ? { ok: false, code: reply.code ?? "action_rejected", message: reply.message ?? "被拒绝" }
            : { ok: true, result: resultFor(proposal) });
        }
        await Promise.resolve();
      });
      await tick();
    },
    taken: (action) => proposals.filter((proposal) => proposal.action === action),
  };
}

function mount(h: Harness) {
  return render(
    <AgentViewProvider client={h.client}>
      <App />
    </AgentViewProvider>,
  );
}

const SESSION = {
  resourceId: "res-1",
  sessionId: "demo-codex",
  deviceId: "laptop",
  deviceLabel: "laptop",
  cliKind: "codex",
  projectLabel: "Session Plus",
  cwdDisplay: "~/projects/session-plus",
  lastActivity: new Date().toISOString(),
  status: "live",
  resumable: true,
  messageCount: 260,
  title: "调研 dsh 生态",
  firstUserText: "收敛 Session Plus 架构",
  directoryKey: ROOT_DIRECTORY_KEY,
};

const PROJECTION: SessionsProjection = {
  notice: "真实会话资源由平台能力管线提供。",
  pinned: [],
  sessions: [SESSION],
  sources: [{ kind: "runner", device: "laptop", online: true }],
};

const TRANSCRIPT = {
  transcript: {
    "res-1": {
      offset: 60,
      totalMessages: 260,
      messages: Array.from({ length: 200 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        blocks: [{ type: "text", text: `${index % 2 === 0 ? "需求" : "答复"} ${60 + index + 1}` }],
      })),
      activity: { state: "idle" },
    },
  },
};

describe("Session Plus Agent View", () => {
  it("wires ignored async questions to browser preferences without proposing an answer", async () => {
    const h = harness();
    const values = new Map<string, string>();
    h.client.drafts = {
      get: (key) => ({ text: values.get(key) ?? "", updatedAt: 0 }),
      set: (key, text) => { values.set(key, text); },
      subscribe: () => () => {},
    };
    const projection = { ...PROJECTION, transcript: { "res-1": { offset: 0, totalMessages: 1, messages: [{
      role: "assistant", blocks: [{ type: "tool", tool: "request_user_input_async", call_id: "async-1",
        input: JSON.stringify({ questions: [{ title: "保留哪种方案？" }] }) }],
    }] } } };
    const first = mount(h);
    await h.boot(projection);
    await h.settle();
    const before = h.proposals.length;
    await userEvent.click(screen.getByRole("button", { name: "忽略" }));
    expect(h.proposals).toHaveLength(before);
    expect(values.get("session-async-ignored:res-1")).toBe('["async-1"]');
    first.unmount();
    mount(h);
    await tick();
    expect(screen.getByText("异步问题 · 0 组未确认").closest("details")).not.toHaveAttribute("open");
    expect(screen.getByText("已忽略 · 1 组").closest("details")).not.toHaveAttribute("open");
  });

  it("opens a full-path chat URL from its session even when no roots are listed", async () => {
    const path = "/home/ubuntu/lht/auto-research/agentcc-case-walkthrough/r06-20260907/L2-WALKTHROUGH.md";
    const h = harness((proposal) => {
      if (proposal.action === "resource.refresh_roots") return {
        roots: [], truncated: true,
      };
      if (proposal.action === "resource.resolve_file_link") return {
        source: proposal.params.session, href: proposal.params.href, root: { ref: "wf_owner", label: "/", sourceLabel: "laptop" }, entry: {
        base: "wf_owner", path: path.slice(1),
        ref: "wf_walkthrough", label: "L2-WALKTHROUGH.md", kind: "file",
      } };
      return defaultProposalResult(proposal);
    });
    try {
      mount(h);
      await h.boot({ ...PROJECTION, transcript: { "res-1": {
        offset: 0, totalMessages: 1, messages: [{ role: "assistant", blocks: [{
          type: "text", text: `[L2 全文](${new URL(document.URL).origin}${path})`,
        }] }],
      } } });
      await h.settle();
      await userEvent.click(await screen.findByRole("link", { name: "L2 全文" }));
      await h.settle();
      expect(h.taken("resource.resolve_file_link").map((proposal) => proposal.params)).toEqual([{
        binding: "workspace", session: "res-1", href: path,
      }]);
      await waitFor(() => expect(h.taken("resource.open_text").map((proposal) => proposal.params.ref))
        .toEqual(["wf_walkthrough"]));
    } finally {
      h.client.destroy();
    }
  });

  it.each([
    { narrow: false, file: "报告.md", outcome: "success" },
    { narrow: true, file: "报告.pdf", outcome: "success" },
    { narrow: true, file: "报告.pdf", outcome: "missing" },
    { narrow: false, file: "报告.md", outcome: "refused" },
  ])("reveals $file from its viewer on narrow=$narrow ($outcome)", async ({ narrow, file, outcome }) => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: narrow, media: "(max-width: 720px)", onchange: null,
      addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(),
      removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    } satisfies MediaQueryList)));
    const h = harness((proposal) => {
      if (proposal.action === "resource.refresh_roots") return {
        roots: [{ ref: "wf_owner", label: "/", sourceLabel: "laptop" }], truncated: false,
      };
      if (proposal.action === "resource.resolve_file_link") return {
        source: proposal.params.session, href: proposal.params.href, root: { ref: "wf_owner", label: "/", sourceLabel: "laptop" },
        entry: { base: "wf_owner", path: `.reports/${file}`, ref: "wf_report", label: file, kind: "file" },
      };
      if (proposal.action === "resource.list_directory") return {
        ref: proposal.params.ref, label: "directory", truncated: false,
        entries: proposal.params.ref === "wf_owner"
          ? [{ ref: "wf_hidden", label: ".reports", kind: "directory" }]
          : outcome === "missing" ? [] : [{ ref: "wf_report", label: file, kind: "file" }],
      };
      return defaultProposalResult(proposal);
    });
    const boxes = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const visible = !narrow || document.querySelector("[data-av-dock-workspace]")
        ?.getAttribute("data-av-dock-mobile-section") === "navigation";
      if (visible && this.classList.contains("directory-file-tree")) return rect({ top: 60, height: 300 });
      if (visible && this.matches('.wsfile[data-ref="wf_report"]')) return rect({ top: 260, height: 30 });
      return rect({});
    });
    try {
      mount(h);
      await h.boot({ ...PROJECTION, transcript: { "res-1": {
        offset: 0, totalMessages: 1, messages: [{ role: "assistant", blocks: [{
          type: "text", text: `[打开报告](/.reports/${file})`,
        }] }],
      } } });
      await h.settle();
      if (narrow) await userEvent.click(screen.getByRole("tab", { name: "会话" }));
      await userEvent.click(await screen.findByRole("link", { name: "打开报告" }));
      await h.settle();
      await h.settle();
      const viewer = document.querySelector("#wsviewer")!;
      const documents = document.querySelectorAll("[data-av-dock-document]").length;
      const reveal = await screen.findByRole("button", { name: "在文件索引中定位此文件" });
      await userEvent.click(reveal);
      expect(reveal).toBeDisabled();
      expect(viewer).toHaveTextContent("正在文件索引中定位文件");
      expect(h.taken("resource.list_directory").map((call) => call.params.ref)).toEqual(["wf_owner"]);
      if (outcome === "refused") {
        await h.settle({ ok: false, code: "approval_required", message: "目录读取需要批准" });
      } else {
        await h.settle();
        await h.settle();
      }
      if (outcome === "success") {
        const target = document.querySelector('.wsfile[data-ref="wf_report"]')!;
        await waitFor(() => expect(target).toHaveFocus());
        expect(target.closest('[role="treeitem"]')).toHaveAttribute("aria-selected", "true");
        expect(document.querySelector<HTMLElement>("[data-av-file-tree-rows]")!.scrollTop).toBe(200);
        if (narrow) expect(document.querySelector("[data-av-dock-workspace]"))
          .toHaveAttribute("data-av-dock-mobile-section", "navigation");
        expect(viewer).toHaveTextContent("已在文件索引中定位");
      } else {
        expect(viewer).toHaveTextContent(outcome === "refused" ? "目录读取需要批准" : "此文件已不在原目录索引中");
        expect(reveal).not.toBeDisabled();
        if (narrow) expect(document.querySelector("[data-av-dock-workspace]"))
          .toHaveAttribute("data-av-dock-mobile-section", "resource");
      }
      expect(document.querySelectorAll("[data-av-dock-document]")).toHaveLength(documents);
      await h.settle();
      expect(h.taken("resource.list_directory").map((call) => call.params.ref))
        .toEqual(outcome === "refused" ? ["wf_owner"] : ["wf_owner", "wf_hidden"]);
    } finally {
      boxes.mockRestore();
      h.client.destroy();
    }
  }, 30_000);

  it("keeps a missing chat file non-blocking and preserves its attempted path", async () => {
    const h = harness((proposal) => proposal.action === "resource.refresh_roots"
      ? { roots: [{ ref: "wf_owner", label: "/", sourceLabel: "laptop" }], truncated: false }
      : defaultProposalResult(proposal));
    try {
      mount(h);
      await h.boot({ ...PROJECTION, transcript: { "res-1": {
        offset: 0, totalMessages: 1, messages: [{ role: "assistant", blocks: [{
          type: "text", text: "[missing file](/aiopslab/missing.py)",
        }] }],
      } } });
      await h.settle();
      await userEvent.click(await screen.findByRole("link", { name: "missing file" }));
      const composer = document.getElementById("composer")!;
      await userEvent.type(composer, "继续工作");
      await h.settle({ ok: false, code: "not_found", message: "路径不存在或不可见：aiopslab/missing.py" });
      await waitFor(() => expect(screen.getByRole("region", { name: "有操作没有成功" }))
        .toHaveTextContent("路径不存在或不可见：aiopslab/missing.py"));
      expect(h.taken("resource.resolve_file_link").length).toBeGreaterThan(0);
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(composer).toHaveFocus();
      await userEvent.type(composer, "，保留草稿");
      expect(composer).toHaveValue("继续工作，保留草稿");
      await userEvent.click(screen.getByRole("button", { name: /查看详情/ }));
      expect(screen.getByRole("region", { name: "有操作没有成功" }))
        .toHaveTextContent("aiopslab/missing.py");
    } finally {
      h.client.destroy();
    }
  });

  it.each([false, true])("refreshes new filesystem directories through the shared refresh path (phone=%s)", async (narrow) => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: narrow, media: "(max-width: 720px)", onchange: null,
      addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(),
      removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    } satisfies MediaQueryList)));
    let created = false;
    const h = harness((proposal) => {
      if (proposal.action === "resource.list_directory" && created) return {
        ref: proposal.params.ref, label: "Session Plus", directoryKey: ROOT_DIRECTORY_KEY,
        entries: [{ ref: "wf_new_folder", label: "r06-20260907", kind: "directory" }], truncated: false,
      };
      return defaultProposalResult(proposal);
    });
    try {
      mount(h);
      await h.boot(PROJECTION);
      await h.settle();
      await showView("文件树");
      await userEvent.click(await screen.findByRole("button", { name: /^Session Plus/ }));
      await h.settle();
      expect(await screen.findByRole("button", { name: /README.md/ })).toBeVisible();
      expect(screen.queryByRole("button", { name: "r06-20260907" })).toBeNull();
      created = true;
      const before = h.taken("resource.list_directory").length;
      await userEvent.click(screen.getByRole("button", { name: narrow ? "刷新" : "刷新工作区目录" }));
      await h.settle();
      expect(await screen.findByRole("button", { name: "r06-20260907" })).toBeVisible();
      expect(h.taken("resource.list_directory").length).toBe(before + 1);
      expect(screen.getByRole("button", { name: /^Session Plus/ }).closest('[role="treeitem"]'))
        .toHaveAttribute("aria-expanded", "true");
    } finally {
      h.client.destroy();
      vi.unstubAllGlobals();
    }
  });

  it("waits visibly until the trusted shell hands over a channel", () => {
    const h = harness();
    mount(h);
    expect(screen.getByText(/等待可信外层转交通道/)).toBeInTheDocument();
    h.client.destroy();
  });

  it("does not print projection notices above the workspace", async () => {
    const h = harness();
    mount(h);
    await h.boot(PROJECTION);
    expect(document.querySelector(".viewnotice")).toBeNull();
    expect(screen.queryByText(PROJECTION.notice!)).not.toBeInTheDocument();
    expect(screen.queryByText("Agent View")).not.toBeInTheDocument();
    h.client.destroy();
  });

  it("on boot: selects a session, opens its transcript and refreshes the roster", async () => {
    const h = harness();
    mount(h);
    await h.boot(PROJECTION);
    expect(screen.queryByRole("heading", { name: "文件" })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "会话列表" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: /最近会话/ })).toHaveAttribute("aria-expanded", "true");
    expect(document.querySelector(".detailhead .title")).toHaveTextContent("调研 dsh 生态");
    expect(h.taken("open_session")[0].params).toMatchObject({ resource: "res-1", limit: "200" });
    expect(h.taken("refresh_sessions")).toHaveLength(1);
    // One workspace lookup per device, queued — not one per render.
    expect(h.taken("refresh_workspaces").map((p) => p.params.device)).toEqual(["laptop"]);
    expect(h.taken("resource.refresh_roots")).toHaveLength(1);
    h.client.destroy();
  });

  it("migrates the legacy checkpoint to its front tab without restoring background sessions", async () => {
    const second = { ...SESSION, resourceId: "res-2", sessionId: "second", title: "第二个会话" };
    const third = { ...SESSION, resourceId: "res-3", sessionId: "third", title: "第三个会话" };
    const projection: SessionsProjection = { ...PROJECTION, sessions: [SESSION, second, third] };
    const recovery = JSON.stringify({
      version: 1,
      sessions: ["res-2", "res-3", "retired-session"],
      activeSession: "res-3",
      mobileSection: "main",
    });
    const h = harness();
    mount(h);
    await h.boot(projection, undefined, recovery);

    await waitFor(() => {
      const dockTabs = [...document.querySelectorAll("[data-av-dock-tab]")]
        .map((marker) => marker.closest<HTMLElement>(".dv-tab"));
      const tabs = dockTabs.map((tab) => tab?.textContent ?? "");
      expect(tabs.some((title) => title.includes("第二个会话"))).toBe(false);
      expect(tabs.some((title) => title.includes("第三个会话"))).toBe(true);
      expect(dockTabs.find((tab) => tab?.textContent?.includes("第三个会话"))).toHaveClass("dv-active-tab");
    });
    await waitFor(() => expect(h.checkpoints.length).toBeGreaterThan(0));
    expect(JSON.parse(h.checkpoints.at(-1)!)).toMatchObject({
      version: 2,
      documents: [expect.objectContaining({ ref: "res-3" })],
      activeSession: "res-3",
    });
    expect(JSON.stringify(h.checkpoints)).not.toContain("retired-session");
    h.client.destroy();
  }, 30_000);

  it.each([
    { narrow: false, layer: "desktop" },
    { narrow: true, layer: "phone" },
  ])("reveals an exact nested cwd in the same index on $layer by switching the navigator to its file tree", async ({ narrow }) => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: narrow,
      media: "(max-width: 720px)",
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } satisfies MediaQueryList)));
    const sessionDirectoryKey = "dk1_cccccccccccccccc";
    const homeDirectoryKey = "dk1_bbbbbbbbbbbbbbbb";
    const homeRef = "wf_home";
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: scrollIntoView,
    });
    const h = harness((proposal) => {
      if (proposal.action === "resource.refresh_roots") {
        return {
          roots: [
            {
              ref: homeRef,
              label: "ubuntu",
              sourceLabel: "laptop",
              directoryKey: homeDirectoryKey,
            },
            {
              ref: ROOT_REF,
              label: "lht",
              sourceLabel: "laptop",
              directoryKey: ROOT_DIRECTORY_KEY,
            },
          ],
          truncated: false,
        };
      }
      if (proposal.action === "resource.list_directory") {
        const byRef: Record<string, unknown> = {
          [homeRef]: {
            ref: homeRef,
            label: "ubuntu",
            directoryKey: homeDirectoryKey,
            // This is the production compatibility shape from the screenshot:
            // the upper listing can address `lht` but does not carry the v2
            // equality field that would identify its separately registered root.
            entries: [{ ref: "wf_lht_from_home", label: "lht", kind: "directory" }],
            truncated: false,
          },
          [ROOT_REF]: {
            ref: ROOT_REF,
            label: "lht",
            directoryKey: ROOT_DIRECTORY_KEY,
            entries: [{
              ref: "wf_paper_work",
              label: "paper-work",
              kind: "directory",
              directoryKey: sessionDirectoryKey,
            }],
            truncated: false,
          },
          wf_paper_work: {
            ref: "wf_paper_work",
            label: "paper-work",
            directoryKey: sessionDirectoryKey,
            entries: [{ ref: "wf_guide", label: "paragraph-by-paragraph-guide.md", kind: "file" }],
            truncated: false,
          },
        };
        return byRef[proposal.params.ref] ?? null;
      }
      return defaultProposalResult(proposal);
    });
    mount(h);
    await h.boot({
      ...PROJECTION,
      sessions: [{
        ...SESSION,
        cwdDisplay: "~/lht/paper-work",
        directoryKey: sessionDirectoryKey,
      }],
      workspacesByDevice: {
        laptop: {
          device: "laptop",
          workspaces: [
            {
              id: "ws_home",
              label: "Home",
              display: "~",
              directoryKey: homeDirectoryKey,
            },
            {
              id: "ws_lht",
              label: "lht",
              display: "~/lht",
              directoryKey: ROOT_DIRECTORY_KEY,
            },
          ],
        },
      },
    });
    await h.settle();

    if (narrow) {
      await waitFor(() => expect(document.querySelector(
        '[data-av-dock-workspace][data-av-dock-mobile-section="navigation"]',
      )).not.toBeNull());
    }
    const recent = screen.getByRole("button", { name: /最近会话/ });
    expect(recent).toHaveAttribute("aria-expanded", "true");
    const indexBody = document.querySelector(".navigation-index-body");

    if (narrow) {
      await userEvent.click(screen.getByRole("tab", { name: "会话" }));
      await waitFor(() => expect(document.querySelector(
        '[data-av-dock-workspace][data-av-dock-mobile-section="main"]',
      )).not.toBeNull());
    }
    const revealButton = await screen.findByRole("button", {
      name: "在文件索引中定位 ~/lht/paper-work",
    });
    const boxes = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const mobileSection = document.querySelector("[data-av-dock-workspace]")
        ?.getAttribute("data-av-dock-mobile-section");
      const navigationVisible = !narrow || mobileSection === "navigation";
      if (this.classList.contains("directory-file-tree")) {
        return navigationVisible
          ? rect({ top: 60, bottom: 360, height: 300 })
          : rect({});
      }
      if (this.matches('.wsdir[data-ref="wf_paper_work"]')) {
        return navigationVisible
          ? rect({ top: 260, bottom: 290, height: 30 })
          : rect({});
      }
      return rect({});
    });
    await userEvent.click(revealButton);
    // The reveal switches the navigator to its file tree; the sessions view
    // keeps its own disclosure untouched.
    expect(document.querySelector('[data-av-nav-view="files"]')).toHaveAttribute("aria-selected", "true");
    expect(recent).toHaveAttribute("aria-expanded", "true");
    expect(document.querySelector(".navigation-index-body")).toBe(indexBody);

    await h.settle();
    await h.settle();
    await h.settle();

    const target = await screen.findByRole("button", { name: "paper-work" });
    const targetRow = target.closest('[role="treeitem"]');
    const scroller = document.querySelector<HTMLElement>("[data-av-file-tree-rows]")!;
    await waitFor(() => {
      if (narrow) {
        expect(document.querySelector("[data-av-dock-workspace]"))
          .toHaveAttribute("data-av-dock-mobile-section", "navigation");
      }
      expect(target).toHaveFocus();
      expect(scroller.scrollTop).toBe(200);
    });
    expect(targetRow).toHaveAttribute("aria-expanded", "true");
    expect(targetRow).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: /paragraph-by-paragraph-guide\.md/ })).toBeVisible();
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(h.taken("resource.list_directory").map((proposal) => proposal.params.ref))
      .toEqual([homeRef, ROOT_REF, "wf_paper_work"]);
    boxes.mockRestore();
    h.client.destroy();
  }, 30_000);

  it("keeps the default chat as the reusable tab across a closed follow and roster clicks", async () => {
    const h = harness();
    mount(h);
    const second = { ...SESSION, resourceId: "res-2", sessionId: "second", title: "第二个会话" };
    const projection: SessionsProjection = { ...PROJECTION, sessions: [SESSION, second] };
    const chatDocuments = () => [...document.querySelectorAll<HTMLElement>("[data-av-dock-document]")]
      .filter((panel) => panel.querySelector('textarea[id^="composer"]'));
    await h.boot(projection);
    await waitFor(() => expect(chatDocuments()).toHaveLength(1));

    await h.view({
      ...projection,
      transcriptStatus: { resource: "res-1", state: "closed", message: "暂时断开" },
    });
    fireEvent.click(document.querySelector('.sess[data-id="res-1"]')!);
    expect(chatDocuments()).toHaveLength(1);

    fireEvent.click(document.querySelector('.sess[data-id="res-2"]')!);
    await waitFor(() => expect(chatDocuments()).toHaveLength(2));
    fireEvent.click(document.querySelector('.sess[data-id="res-1"]')!);
    expect(chatDocuments()).toHaveLength(2);
    h.client.destroy();
  }, 30_000);

  it("sends nothing that claims an identity", async () => {
    const h = harness();
    mount(h);
    await h.boot(PROJECTION);
    await h.settle();
    await userEvent.click(document.getElementById("doPin")!);
    await tick();
    for (const proposal of h.proposals) {
      expect(Object.keys(proposal).sort()).toEqual(["action", "params", "rid"]);
      for (const forbidden of ["owner", "app", "scope", "instance", "approved", "user", "credential"]) {
        expect(Object.keys(proposal.params)).not.toContain(forbidden);
      }
    }
    expect(h.taken("pin_session")[0].params).toEqual({ session: "res-1" });
    h.client.destroy();
  });

  it("marks only an explicitly opened completed turn as reviewed", async () => {
    const h = harness();
    mount(h);
    const completedAt = "2026-08-25T10:05:00Z";
    const projection: SessionsProjection = {
      ...PROJECTION,
      sessions: [{ ...SESSION, sortActivity: completedAt, completedAt, status: "idle" }],
      reviewedAt: {},
    };
    await h.boot(projection);
    await h.settle();
    expect(h.taken("review_session")).toHaveLength(0);

    const row = document.querySelector('.sess[data-id="res-1"]')!;
    expect(row.querySelector(".review-dot")).toBeTruthy();
    fireEvent.click(row);
    await tick();
    expect(h.taken("review_session").at(-1)?.params).toEqual({
      session: "res-1",
      completed_at: completedAt,
    });
    expect(row.querySelector(".review-dot")).toBeFalsy();

    await h.settle();
    await h.view({ ...projection, reviewedAt: { "res-1": completedAt } });
    expect(document.querySelector('.sess[data-id="res-1"] .review-dot')).toBeFalsy();
    h.client.destroy();
  });

  it("browses the complete device catalog and opens a chat outside the recent window", async () => {
    const h = harness();
    mount(h);
    await h.boot({ ...PROJECTION, rosterTruncated: true });
    await h.settle();
    await userEvent.click(screen.getByRole("button", { name: "全部会话" }));
    await tick();
    expect(h.taken("refresh_sessions").at(-1)?.params).toEqual({ device: "laptop", source: "all", cursor: "", limit: "100" });
    await h.settle();
    await h.view({ ...PROJECTION, rosterTruncated: true,
      sessionHistory: { device: "laptop", source: "all", cursor: "", hasMore: false, totalFound: 1500,
        sessions: [{ ...PROJECTION.sessions![0], resourceId: "older-res", sessionId: "older", title: "Older task" }] } });
    await userEvent.click(await screen.findByText("Older task"));
    await tick();
    await h.settle();
    expect(h.taken("open_session").at(-1)?.params.resource).toBe("older-res");
    expect(screen.queryByText(/当前列表中已没有这条会话/)).not.toBeInTheDocument();
    h.client.destroy();
  });

  it("sets and clears one title consistently across roster, search, header and Dock tab", async () => {
    const h = harness();
    mount(h);
    const search = {
      query: "dsh",
      results: [{ session: SESSION, snippet: "命中正文" }],
    };
    const projection: SessionsProjection = {
      ...PROJECTION,
      customTitles: { "res-1": "发布复盘" },
      search,
    };
    await h.boot(projection);
    await h.settle();
    await showView("全文搜索");
    await userEvent.type(screen.getByRole("searchbox", { name: "搜索会话正文" }), "dsh");
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    const expectTitle = (title: string): void => {
      expect(document.querySelector('.sess[data-id="res-1"]')).toHaveTextContent(title);
      expect(document.querySelector('.results .hit[data-hit="res-1"] b')).toHaveTextContent(title);
      expect(document.querySelector(".detailhead .title")).toHaveTextContent(title);
      expect(document.querySelector('[data-av-dock-tab="chat"]')?.closest(".dv-tab")).toHaveTextContent(title);
    };
    expectTitle("发布复盘");

    const input = screen.getByLabelText("会话标题");
    await userEvent.clear(input);
    await userEvent.type(input, "上线回顾");
    await userEvent.click(screen.getByRole("button", { name: "保存标题" }));
    await tick();
    expect(h.taken("set_session_title").at(-1)?.params).toEqual({ session: "res-1", title: "上线回顾" });
    expect(screen.getByRole("button", { name: "保存中…" })).toBeDisabled();
    await h.settle();
    await h.view({ ...projection, customTitles: { "res-1": "上线回顾" } });
    expectTitle("上线回顾");

    await userEvent.clear(screen.getByLabelText("会话标题"));
    await userEvent.click(screen.getByRole("button", { name: "恢复自动标题" }));
    await tick();
    expect(h.taken("set_session_title").at(-1)?.params).toEqual({ session: "res-1", title: "" });
    await h.settle();
    await h.view({ ...projection, customTitles: {} });
    expectTitle("调研 dsh 生态");
    h.client.destroy();
  });

  it("renders a projected AskUserQuestion card and proposes only its opaque response", async () => {
    const h = harness();
    mount(h);
    await h.boot({
      ...PROJECTION,
      transcript: {
        "res-1": {
          offset: 0,
          totalMessages: 1,
          messages: [{ role: "assistant", blocks: [{ type: "text", text: "请选择验收结果" }] }],
          runtime: {
            process_state: "alive",
            turn_state: "needs_input",
            control_mode: "octopus_headless",
            capabilities: { respond: true },
            interaction: {
              id: "ai_acceptance",
              provider: "claude",
              kind: "question",
              title: "Claude Code 需要你的回答",
              tool: "AskUserQuestion",
              questions: [{
                id: "acceptance",
                header: "验收结果",
                prompt: "新版 Agent adaptor 的网页提问闭环是否验收通过？",
                options: [{ label: "通过" }, { label: "不通过" }],
                multiple: false,
                allow_other: false,
                secret: false,
              }],
              capabilities: { respond: true, allow: true, deny: true },
            },
          },
        },
      },
    });
    await h.settle();
    expect(document.querySelector(".agent-interaction-card")).toHaveTextContent("网页提问闭环是否验收通过");
    await userEvent.click(screen.getByLabelText("通过"));
    await userEvent.click(screen.getByRole("button", { name: "提交回答并继续" }));
    await tick();
    const proposal = h.taken("respond_agent_interaction")[0];
    expect(proposal.params).toEqual({
      resource: "res-1",
      interaction_id: "ai_acceptance",
      response_json: JSON.stringify({ decision: "allow", answers: { acceptance: ["通过"] } }),
    });
    expect(JSON.stringify(proposal.params)).not.toContain("laptop");
    expect(JSON.stringify(proposal.params)).not.toContain("demo-codex");
    h.client.destroy();
  });

  it("renders hostile projection content as text, never as markup", async () => {
    const h = harness();
    mount(h);
    const container = document.body;
    await h.boot({
      ...PROJECTION,
      notice: "<img src=x onerror=alert(1)>",
      sessions: [{ ...SESSION, title: "<script>alert(1)</script>", firstUserText: "<script>alert(1)</script>" }],
    });
    await h.view({
      ...PROJECTION,
      sessions: [{ ...SESSION, title: "<script>alert(1)</script>", firstUserText: "<script>alert(1)</script>" }],
      transcript: {
        "res-1": {
          offset: 0,
          totalMessages: 1,
          messages: [{ role: "assistant", blocks: [{ type: "text", text: "<script>alert(2)</script>\n\n**粗体**" }] }],
        },
      },
    });
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
    expect(container.textContent).toContain("<script>alert(2)</script>");
    // Markdown still renders — the source is parsed, not stringified. Checked
    // across ALL strong elements: the chrome has its own (the document rail's
    // heading), and the first one in DOM order is not necessarily the
    // transcript's.
    const strongs = [...container.querySelectorAll("strong")].map((el) => el.textContent);
    expect(strongs).toContain("粗体");
    h.client.destroy();
  });

  it("replaces the projection wholesale instead of merging the Host's state", async () => {
    const h = harness();
    mount(h);
    await h.boot({ ...PROJECTION, pinned: ["res-1"] });
    await h.settle();
    await showView("文件树");
    await userEvent.click(screen.getByRole("button", { name: /Session Plus.*1 个会话/ }));
    expect(document.querySelector(".sess .pin")).toBeTruthy();
    await h.view({ ...PROJECTION, pinned: [] });
    expect(document.querySelector(".sess .pin")).toBeNull();
    h.client.destroy();
  });

  it("keeps the composer's value, focus and selection across a projection update", async () => {
    // The property the browser suite measures for real. Pinned here too because
    // the failure mode — a remount that silently drops what someone was typing —
    // is cheap to catch at this level and expensive to debug at the other.
    const h = harness();
    mount(h);
    await h.boot(PROJECTION);
    await h.settle();
    const composer = document.getElementById("composer") as HTMLTextAreaElement;
    await userEvent.type(composer, "继续收敛这个实现");
    composer.setSelectionRange(5, 5);
    expect(document.activeElement).toBe(composer);

    await h.view({ ...PROJECTION, notice: "刷新过了" });
    expect(document.getElementById("composer")).toBe(composer);
    expect(composer.value).toBe("继续收敛这个实现");
    expect(composer.selectionStart).toBe(5);
    expect(document.activeElement).toBe(composer);
    expect((document.getElementById("sendPrompt") as HTMLButtonElement).disabled).toBe(false);
    h.client.destroy();
  });

  it("appends to a live session, resumes an idle one, and clears the box", async () => {
    const h = harness();
    mount(h);
    await h.boot(PROJECTION);
    await h.settle();
    expect(screen.getByRole("button", { name: "发送" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /需要批准/ })).toBeNull();
    await userEvent.type(document.getElementById("composer")!, "请继续");
    await userEvent.click(screen.getByRole("button", { name: /发送/ }));
    await tick();
    expect(h.taken("append_session")[0].params).toEqual({
      resource: "res-1",
      prompt: "请继续",
      permission_profile: "full_access",
    });
    expect((document.getElementById("composer") as HTMLTextAreaElement).value).toBe("");

    await h.view({ ...PROJECTION, sessions: [{ ...SESSION, status: "idle" }] });
    await userEvent.selectOptions(screen.getByLabelText("下次托管 / 接管的 Codex 权限"), "manual");
    await userEvent.selectOptions(screen.getByLabelText("后续新轮次模型"), "gpt-5.6-terra");
    await userEvent.selectOptions(screen.getByLabelText("后续新轮次 effort"), "xhigh");
    await userEvent.type(document.getElementById("composer")!, "恢复它");
    await userEvent.click(screen.getByRole("button", { name: /发送/ }));
    await tick();
    expect(h.taken("resume_session")[0].params).toEqual({
      resource: "res-1",
      prompt: "恢复它",
      permission_profile: "manual",
      model: "gpt-5.6-terra",
      effort: "xhigh",
    });
    h.client.destroy();
  });

  it("keeps one user bubble while a stale revision is dropped, then replaces the echo on the newer transcript", async () => {
    const h = harness();
    mount(h);
    await h.boot({
      ...PROJECTION,
      transcript: { "res-1": { offset: 12, totalMessages: 12, messages: [] } },
    }, 5);
    await h.settle();
    await userEvent.type(document.getElementById("composer")!, "同一句不能双显");
    await userEvent.click(screen.getByRole("button", { name: /发送/ }));
    await tick();
    expect(document.querySelectorAll(".ev-send-pending")).toHaveLength(1);
    expect(screen.getAllByText("同一句不能双显")).toHaveLength(1);

    const authoritative = {
      ...PROJECTION,
      transcript: {
        "res-1": {
          offset: 12,
          totalMessages: 13,
          messages: [{ role: "user", blocks: [{ type: "text", text: "同一句不能双显" }] }],
        },
      },
    } satisfies SessionsProjection;
    // The SDK's monotonic guard rejects this frame, so it cannot prematurely
    // reconcile the controller's optimistic entry.
    await h.view(authoritative, 4);
    expect(document.querySelectorAll(".ev-send-pending")).toHaveLength(1);
    expect(screen.getAllByText("同一句不能双显")).toHaveLength(1);

    await h.view(authoritative, 6);
    expect(document.querySelectorAll(".ev-send-pending")).toHaveLength(0);
    // Exactly one authoritative user turn remains; there is no local duplicate.
    expect(screen.getAllByText("同一句不能双显")).toHaveLength(1);
    h.client.destroy();
  });

  it("keeps tmux input on screen through delivery confirmation and delayed output", async () => {
    const h = harness((proposal) => proposal.action === "append_session"
      ? { opId: "op-tmux-visible" } : defaultProposalResult(proposal));
    mount(h);
    const base: SessionsProjection = {
      ...PROJECTION,
      sessions: [{ ...SESSION, runtime: {
        process_state: "alive", turn_state: "idle", control_mode: "external_cli",
        attachment: { kind: "terminal_tmux", state: "attached", transport: "tmux" },
        capabilities: { terminal_append: true },
      } }],
      transcript: { "res-1": { offset: 12, totalMessages: 12, messages: [] } },
    };
    await h.boot(base, 5);
    await h.settle();
    await userEvent.type(document.getElementById("composer")!, "消息应当一直可见");
    await userEvent.click(screen.getByRole("button", { name: "发送到本机 CLI" }));
    await h.settle();
    const original = screen.getByText("消息应当一直可见");
    await h.operation({ id: "op-tmux-visible", status: "running", operation: "append_session" });
    expect(screen.getByText("正在处理发送请求…")).toBeInTheDocument();
    await h.operation({ id: "op-tmux-visible", status: "succeeded", operation: "append_session" });
    expect(screen.getByText("消息应当一直可见")).toBe(original);
    expect(screen.getByText("✓ 已送达")).toBeInTheDocument();
    expect(document.querySelector("[data-av-send-phase='done']")).toHaveAttribute("aria-busy", "false");
    await h.view({ ...base, notice: "正文还未同步" }, 6);
    expect(screen.getAllByText("消息应当一直可见")).toEqual([original]);
    const authoritative: SessionsProjection = { ...base, transcript: { "res-1": {
      offset: 12, totalMessages: 14, messages: [
        { role: "user", text: "消息应当一直可见" },
        { role: "assistant", text: "后续输出逐步到达" },
      ],
    } } };
    await h.view(authoritative, 7);
    expect(screen.getAllByText("消息应当一直可见")).toHaveLength(1);
    expect(document.querySelector("[data-av-send-phase]")).toBeNull();
    expect(await screen.findByText("后续输出逐步到达")).toBeInTheDocument();
    await h.view(base, 6);
    expect(screen.getAllByText("消息应当一直可见")).toHaveLength(1);
    expect(screen.getByText("后续输出逐步到达")).toBeInTheDocument();
    expect(h.taken("append_session")).toHaveLength(1);
    h.client.destroy();
  });

  it("shows takeover only for hook-observed capability and proposes the explicit action", async () => {
    const h = harness();
    mount(h);
    await h.boot({
      ...PROJECTION,
      sessions: [{
        ...SESSION,
        runtime: {
          process_state: "alive",
          turn_state: "working",
          control_mode: "external_cli",
          capabilities: { takeover: true, interrupt: false, steer: false },
        },
      }],
    });
    await h.settle();
    expect(screen.getByText(/本机 CLI 执行中/)).toBeInTheDocument();
    await userEvent.type(document.getElementById("composer")!, "接手这一轮");
    await userEvent.click(screen.getByRole("button", { name: /交给 Octopus 托管并发送/ }));
    await tick();
    expect(h.taken("takeover_session")[0].params).toEqual({
      resource: "res-1",
      prompt: "接手这一轮",
      permission_profile: "full_access",
    });
    h.client.destroy();
  });

  it("proposes explicit Codex account fallback without naming a slot or home", async () => {
    const h = harness();
    mount(h);
    await h.boot({
      ...PROJECTION,
      sessions: [{ ...SESSION, status: "idle", accountLabel: "a" }],
    });
    await h.settle();
    await userEvent.type(document.getElementById("composer")!, "换账号继续");
    await userEvent.click(screen.getByRole("button", { name: "换备用账号并发送" }));
    await tick();
    expect(h.taken("fallback_session")[0].params).toEqual({
      resource: "res-1",
      prompt: "换账号继续",
      permission_profile: "full_access",
    });
    expect(JSON.stringify(h.taken("fallback_session")[0])).not.toMatch(/CODEX_HOME|account[_-]?a|slot/i);
    h.client.destroy();
  });

  it.each(["codex", "claude"] as const)("opens only the trusted parent resource for a parent-owned %s child", async (cliKind) => {
    const h = harness();
    mount(h);
    await h.boot({
      ...PROJECTION,
      sessions: [
        {
          ...SESSION,
          cliKind,
          inputMode: "parent_owned",
          parentResourceId: "res-parent",
          resumable: false,
        },
        {
          ...SESSION,
          cliKind,
          resourceId: "res-parent",
          sessionId: "thread-parent",
          firstUserText: "父 Agent",
        },
      ],
    });
    await h.settle();

    // Boot selects the parent; subagents require an explicit disclosure and click.
    fireEvent.click(screen.getByRole("button", { name: /的子 Agent（1）/ }));
    fireEvent.click(document.querySelector('[data-av-session-row="res-1"]')!);
    await h.settle();
    expect(screen.getByText(`这个 ${cliKind === "claude" ? "Claude" : "Codex"} 子 Agent 由父 Agent 管理`)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "打开父 Agent" }));
    await tick();
    expect(h.taken("open_session").at(-1)?.params.resource).toBe("res-parent");
    expect(JSON.stringify(h.proposals)).not.toMatch(/thread-parent|父 Agent/);
    h.client.destroy();
  });

  it("keeps the explicit takeover door visible when an idle omp TUI has no writable pane", async () => {
    const h = harness();
    mount(h);
    await h.boot({
      ...PROJECTION,
      sessions: [{
        ...SESSION,
        cliKind: "omp",
        status: "idle",
        resumable: false,
        runtime: {
          process_state: "alive",
          turn_state: "idle",
          control_mode: "external_cli",
          attachment: { kind: "omp_terminal", state: "observed" },
          capabilities: {
            takeover: true,
            terminal_append: false,
            managed_resume: false,
            protocol_append: false,
          },
        },
      }],
    });
    await h.settle();
    const composer = document.getElementById("composer")!;
    expect(composer).toBeEnabled();
    await userEvent.type(composer, "接管这个 omp 会话");
    const takeover = screen.getByRole("button", { name: "交给 Octopus 托管并发送" });
    expect(takeover).toBeEnabled();
    await userEvent.click(takeover);
    await tick();
    expect(h.taken("takeover_session")[0].params).toEqual({
      resource: "res-1",
      prompt: "接管这个 omp 会话",
      permission_profile: "full_access",
    });
    h.client.destroy();
  });

  it("stops a managed turn through the separate native interrupt action", async () => {
    const h = harness();
    mount(h);
    await h.boot({
      ...PROJECTION,
      sessions: [{
        ...SESSION,
        runtime: {
          process_state: "alive",
          turn_state: "working",
          control_mode: "octopus_headless",
          attachment: { kind: "codex_app_server", state: "attached", transport: "app-server" },
          capabilities: { interrupt: true, protocol_append: true },
        },
      }],
    });
    await h.settle();
    // Ticket #184: standing chrome above the composer, not an entry inside
    // the phone's ⚙ sheet — the click below finds it without opening anything.
    await userEvent.click(screen.getByRole("button", { name: "⏹ 停止这一轮" }));
    await tick();
    expect(h.taken("interrupt_session")[0].params).toEqual({ resource: "res-1" });
    h.client.destroy();
  });

  it("proposes manual Codex release only after the stale attachment confirmation", async () => {
    const h = harness();
    mount(h);
    await h.boot({
      ...PROJECTION,
      sessions: [{
        ...SESSION,
        status: "idle",
        runtime: {
          process_state: "alive",
          turn_state: "idle",
          control_mode: "octopus_headless",
          attachment: { kind: "codex_app_server", state: "attached", transport: "app-server" },
          capabilities: { release_control: true, protocol_append: false },
        },
      }],
    });
    await h.settle();

    await userEvent.click(screen.getByRole("button", { name: "检查并释放占用" }));
    expect(h.taken("release_session_control")).toHaveLength(0);
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: "确认释放这份占用" }));
    await tick();
    expect(h.taken("release_session_control")[0].params).toEqual({ resource: "res-1" });
    h.client.destroy();
  });

  it("refuses to send from a source with no executable Runner", async () => {
    const h = harness();
    mount(h);
    await h.boot({ ...PROJECTION, sessions: [{ ...SESSION, deviceId: "", resumable: false }] });
    expect((document.getElementById("composer") as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.getByText("当前来源没有可执行 Runner")).toBeInTheDocument();
    h.client.destroy();
  });

  it("raises the bounded refusal the Host wrote until somebody dismisses it", async () => {
    // Ticket #191: this used to be a thin line at the top of the frame that
    // cleared itself on the NEXT proposal — so a refusal could come and go
    // without anybody seeing it. The corner notification remains until dismissed. `approval_required` is deliberately not in this surface.
    const h = harness();
    mount(h);
    await h.boot(PROJECTION);
    await h.settle();
    await userEvent.click(document.getElementById("doPin")!);
    await h.settle({ ok: false, message: "这个动作不在当前 release 的声明里" });
    await waitFor(() => {
      expect(screen.getByText("这个动作不在当前 release 的声明里")).toBeInTheDocument();
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.type(document.getElementById("composer")!, "失败后继续写");
    expect(document.getElementById("composer")).toHaveValue("失败后继续写");
    await userEvent.click(screen.getAllByRole("button", { name: "知道了" })[0]);
    await waitFor(() => expect(screen.queryByRole("region", { name: "有操作没有成功" })).toBeNull());
    h.client.destroy();
  });

  it("does not duplicate a device operation failure inside the isolated View", async () => {
    // The trusted page owns operation history. The View still consumes this
    // event for controller refresh semantics, but must not recreate the old
    // bottom status surface.
    const h = harness();
    mount(h);
    await h.boot(PROJECTION);
    await h.settle();
    await h.operation({
      id: "op-start-1",
      status: "failed",
      operation: "start_session",
      message: "目录不存在或不可进入",
    });
    await tick();
    expect(document.querySelector(".opmsg")).toBeNull();
    h.client.destroy();
  });

  it("windows a long transcript and pages backwards by explicit offset", async () => {
    const h = harness();
    mount(h);
    await h.boot(PROJECTION);
    await h.view({ ...PROJECTION, ...TRANSCRIPT });
    await h.settle();
    expect(document.querySelector("[data-av-chat-window]")).toBeNull();
    expect(screen.queryByRole("button", { name: "搜索已读取记录" })).toBeNull();
    expect(document.querySelector("[data-av-chat-transcript]")).toHaveAttribute("data-av-chat-offset", "60");
    // A 200-message tail already has plenty of visible units, so nothing
    // auto-extends: exactly one read so far.
    expect(h.taken("open_session")).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: "加载更早消息" }));
    await tick();
    expect(h.taken("open_session")[1].params).toEqual({ resource: "res-1", limit: "60", offset: "0" });
    h.client.destroy();
  });

  it("extends a too-short tail on its own, in visible units rather than messages", async () => {
    const h = harness();
    mount(h);
    await h.boot(PROJECTION);
    // Twelve folded tool calls read as ONE row, so this tail is too short even
    // though it holds twelve messages.
    await h.view({
      ...PROJECTION,
      transcript: {
        "res-1": {
          offset: 100,
          totalMessages: 112,
          messages: Array.from({ length: 12 }, () => ({
            role: "assistant",
            blocks: [{ type: "tool", tool: "Bash", output: "ok" }],
          })),
        },
      },
    });
    await h.settle();
    await tick();
    const reads = h.taken("open_session");
    expect(reads).toHaveLength(2);
    expect(reads[1].params).toMatchObject({ offset: "0", limit: "100" });
    h.client.destroy();
  });

  it("runs one transcript read at a time", async () => {
    const h = harness();
    mount(h);
    await h.boot(PROJECTION);
    await h.view({ ...PROJECTION, ...TRANSCRIPT });
    // Reading upwards during the boot read must not interleave history with a tail.
    const scroller = document.querySelector<HTMLElement>("[data-av-chat-transcript]")!;
    Object.defineProperty(scroller, "clientHeight", { value: 600 });
    fireEvent.wheel(scroller, { deltaY: -100 });
    await tick();
    expect(h.taken("open_session")).toHaveLength(1);
    h.client.destroy();
  });

  it("does not mount terminal or operation chrome in the bottom flow", async () => {
    const h = harness();
    mount(h);
    await h.boot(PROJECTION);
    await h.settle();
    await h.operation({
      id: "op-1",
      status: "waiting_approval",
      message: "等待你在可信栏批准 append_session",
      operation: "append_session",
    });
    expect(document.querySelector('[data-av-dock-flow="bottom"]')).toBeNull();
    expect(document.querySelector(".remote-terminal-panel")).toBeNull();
    expect(document.querySelector('.op[data-op="op-1"]')).toBeNull();

    await h.operation({ id: "op-1", status: "succeeded", message: "已完成", operation: "append_session" });
    expect(document.querySelector('.op[data-op="op-1"]')).toBeNull();
    h.client.destroy();
  });

  it("opens and reuses one device-keyed terminal Dock tab from the navigation row", async () => {
    const terminalId = `term_${"a".repeat(48)}`;
    const h = harness((proposal) => {
      if (proposal.action === "open_terminal") {
        return { terminal_id: terminalId, screen: "$ ", closed: false };
      }
      return defaultProposalResult(proposal);
    });
    mount(h);
    await h.boot({
      ...PROJECTION,
      workspacesByDevice: {
        laptop: {
          device: "laptop",
          workspaces: [{
            id: "ws_octopus",
            label: "Session Plus",
            display: "~/projects/session-plus",
            directoryKey: ROOT_DIRECTORY_KEY,
          }],
        },
      },
    });
    await h.settle();
    await showView("文件树");

    const open = screen.getByRole("button", { name: "打开 laptop 的远端终端" });
    await userEvent.click(open);
    await h.settle();
    expect(h.taken("open_terminal")).toHaveLength(1);
    expect(h.taken("open_terminal")[0].params).toMatchObject({
      device: "laptop",
      workspace_id: "ws_octopus",
    });
    expect(document.querySelector('[data-av-module="session.remote-terminal/v1"]'))
      .toHaveTextContent("快速通道已开启");

    await userEvent.click(open);
    await tick();
    expect(h.taken("open_terminal")).toHaveLength(1);
    expect([...document.querySelectorAll('[data-av-module="session.remote-terminal/v1"]')]).toHaveLength(1);
    h.client.destroy();
  });

  it("re-reads the transcript once when a submission finishes, not on every frame", async () => {
    const h = harness();
    mount(h);
    await h.boot(PROJECTION);
    await h.settle();
    const before = h.taken("open_session").length;
    await h.operation({ id: "op-9", status: "succeeded", operation: "append_session", message: "已完成" });
    await h.settle();
    await h.operation({ id: "op-9", status: "succeeded", operation: "append_session", message: "已完成" });
    await tick();
    expect(h.taken("open_session")).toHaveLength(before + 1);
    h.client.destroy();
  });

  it("carries a directory row's own path into the form, and proposes it verbatim", async () => {
    const h = harness();
    mount(h);
    await h.boot(PROJECTION);
    await h.view({
      ...PROJECTION,
      workspacesByDevice: {
        laptop: {
          device: "laptop",
          workspaces: [{
            id: "ws_0123456789abcdef01234567",
            label: "Session Plus",
            display: "~/projects/session-plus",
            directoryKey: ROOT_DIRECTORY_KEY,
          }],
        },
      },
    });
    await h.settle();
    const plus = document.querySelector('[data-new-directory="~/projects/session-plus"]') as HTMLElement;
    expect(plus).toBeTruthy();
    await userEvent.click(plus);

    // The form is a dock document opened by an `open-resource/v1` intent —
    // not a mode flag that hides the chat.
    expect(document.querySelector('[data-av-dock-document] [data-av-module="session.new/v1"]')).toBeTruthy();
    const chatGroup = document.querySelector('[data-av-dock-tab="chat"]')!.closest(".dv-groupview");
    expect(chatGroup).not.toBeNull();
    const launchTab = Array.from(document.querySelectorAll("[data-av-dock-tab]")).find(tab => tab.textContent?.includes("启动新的本地 Agent"));
    expect(launchTab).toBeDefined();
    expect(launchTab!.closest(".dv-groupview")).toBe(chatGroup);
    // Dock first creates the panel container, then commits its React surface.
    expect(await screen.findByRole("heading", { name: /启动新的本地 Agent/ })).toBeInTheDocument();
    expect(screen.getByText(/不是访问边界/)).toBeInTheDocument();
    expect((document.getElementById("newDirectory") as HTMLInputElement).value).toBe("~/projects/session-plus");
    expect((screen.getByRole("button", { name: "发送并启动 Agent" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByLabelText("Agent 后端")).toHaveValue("codex");
    expect(screen.getByLabelText("模型")).toHaveValue("gpt-6-astra");
    expect(screen.getByLabelText("Effort")).toHaveValue("xhigh");
    expect(screen.getByLabelText("Codex 权限")).toHaveValue("full_access");

    await userEvent.type(document.getElementById("newPrompt")!, "检查这个目录");
    await userEvent.click(screen.getByRole("button", { name: "发送并启动 Agent" }));
    await tick();
    // Seven fields, and not one of them an identity: no owner, no app, no scope,
    // no instance, no grant. The trusted Host supplies all of those itself.
    expect(h.taken("start_session")[0].params).toEqual({
      device: "laptop",
      directory: "~/projects/session-plus",
      source: "codex",
      model: "gpt-6-astra",
      effort: "xhigh",
      permission_profile: "full_access",
      prompt: "检查这个目录",
    });
    h.client.destroy();
  });

  it.each([false, true])("does not rewrite new prompt edits during typing or refresh (composing=%s)", async (composing) => {
    const h = harness();
    mount(h);
    await h.boot(PROJECTION);
    await h.settle();
    await userEvent.click(screen.getByRole("button", { name: /在任意目录启动 Agent/ }));
    const prompt = screen.getByLabelText("第一条需求") as HTMLTextAreaElement;
    await userEvent.type(prompt, "前后");
    prompt.setSelectionRange(1, 1);
    if (composing) fireEvent.compositionStart(prompt);

    // Native edits bypass React's value tracker. Observe every subsequent
    // programmatic write: restoring the final text cannot undo a cancelled IME.
    const nativeSet = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    const writes = vi.spyOn(prompt, "value", "set");
    try {
      nativeSet.call(prompt, "前ni后");
      prompt.setSelectionRange(3, 3);
      fireEvent.input(prompt, { data: "ni", inputType: "insertCompositionText", isComposing: composing });
      expect(writes).not.toHaveBeenCalled();
      await h.view({ ...PROJECTION, notice: "后台刷新" });
      expect(writes).not.toHaveBeenCalled();
      expect(screen.getByLabelText("第一条需求")).toBe(prompt);
      expect(prompt).toHaveFocus();
      expect(prompt).toHaveValue("前ni后");
      expect(prompt.selectionStart).toBe(3);
      expect(prompt.selectionEnd).toBe(3);

      nativeSet.call(prompt, "前你后");
      prompt.setSelectionRange(2, 2);
      fireEvent.input(prompt, { data: "你", inputType: "insertCompositionText", isComposing: composing });
      if (composing) fireEvent.compositionEnd(prompt, { data: "你" });
      expect(writes).not.toHaveBeenCalled();
      expect(prompt).toHaveValue("前你后");
      expect(prompt.selectionStart).toBe(2);
      expect(prompt).toHaveFocus();
    } finally {
      writes.mockRestore();
      h.client.destroy();
    }
  });

  it("reuses the open form instead of stacking a second one, and closes it on cancel", async () => {
    const h = harness();
    mount(h);
    await h.boot(PROJECTION);
    await h.settle();
    const panels = () => document.querySelectorAll('[data-av-module="session.new/v1"]');
    await userEvent.click(screen.getByRole("button", { name: /在任意目录启动 Agent/ }));
    await userEvent.type(document.getElementById("newPrompt")!, "半句话");
    await userEvent.click(screen.getByRole("button", { name: /在任意目录启动 Agent/ }));
    expect(panels()).toHaveLength(1);
    // A draft the reader typed survives, because the panel was focused rather
    // than re-created.
    expect((document.getElementById("newPrompt") as HTMLTextAreaElement).value).toBe("半句话");
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(panels()).toHaveLength(0);
    h.client.destroy();
  });

  it("starts in a directory nothing has enumerated, without waiting for anything", async () => {
    // The case the old per-row-only form could not express at all: a folder made
    // a minute ago has no session in it, so no roster row and no registry entry.
    const h = harness();
    mount(h);
    await h.boot(PROJECTION);
    await userEvent.click(screen.getByRole("button", { name: /在任意目录启动 Agent/ }));
    await userEvent.clear(document.getElementById("newDevice")!);
    await userEvent.type(document.getElementById("newDevice")!, "laptop");
    await userEvent.type(document.getElementById("newDirectory")!, "/srv/brand-new");
    await userEvent.type(document.getElementById("newPrompt")!, "开始");
    await userEvent.click(screen.getByRole("button", { name: "发送并启动 Agent" }));
    await tick();
    expect(h.taken("start_session")[0].params).toMatchObject({
      device: "laptop",
      directory: "/srv/brand-new",
      prompt: "开始",
    });
    // And it never asked for a workspace registry in order to get there.
    expect(h.taken("start_session")[0].params.workspace_id).toBeUndefined();
    h.client.destroy();
  });

  it("hands the empty launch chat over to the new session's chat once the launch succeeds", async () => {
    // Ticket #767: the launcher is an empty chat; after the first message
    // starts the Agent, the reader continues in that Agent's own chat and the
    // launch tab does not linger beside it with a stale receipt.
    const h = harness((proposal) => proposal.action === "start_session"
      ? { opId: "op-launch" }
      : defaultProposalResult(proposal));
    mount(h);
    await h.boot(PROJECTION);
    await h.settle();
    await userEvent.click(screen.getByRole("button", { name: /在任意目录启动 Agent/ }));
    expect(await screen.findByRole("heading", { name: /启动新的本地 Agent/ })).toBeInTheDocument();
    await userEvent.clear(document.getElementById("newDevice")!);
    await userEvent.type(document.getElementById("newDevice")!, "laptop");
    await userEvent.type(document.getElementById("newDirectory")!, "~/projects/fresh");
    await userEvent.type(document.getElementById("newPrompt")!, "从空聊天开始");
    await userEvent.click(screen.getByRole("button", { name: "发送并启动 Agent" }));
    await h.settle();
    expect(document.querySelector("[data-av-new-session-echo]")).toHaveTextContent("从空聊天开始");
    expect(document.querySelector('[data-launch-phase="submitted"]')).toBeTruthy();

    await h.operation({ id: "op-launch", status: "succeeded", operation: "start_session", newResourceId: "res-new" });
    await h.view({
      ...PROJECTION,
      sessions: [SESSION, { ...SESSION, resourceId: "res-new", sessionId: "fresh", title: "从空聊天开始的会话" }],
    });
    await h.settle();
    await waitFor(() => expect(screen.queryByRole("heading", { name: /启动新的本地 Agent/ })).toBeNull());
    expect(document.querySelector('[data-av-module="session.new/v1"]')).toBeNull();
    expect(screen.getAllByText("从空聊天开始的会话").length).toBeGreaterThan(0);
    h.client.destroy();
  });

  it("refuses ambiguous relative and Windows-shaped paths under the current POSIX protocol", async () => {
    const h = harness();
    mount(h);
    await h.boot(PROJECTION);
    await userEvent.click(screen.getByRole("button", { name: /在任意目录启动 Agent/ }));
    await userEvent.type(document.getElementById("newDevice")!, "laptop");
    await userEvent.type(document.getElementById("newDirectory")!, "src/app");
    await userEvent.type(document.getElementById("newPrompt")!, "开始");
    expect(screen.getByText(/请写 POSIX 绝对路径/)).toBeInTheDocument();
    expect((screen.getByRole("button", { name: "发送并启动 Agent" }) as HTMLButtonElement).disabled).toBe(true);
    expect(h.taken("start_session")).toHaveLength(0);

    await userEvent.clear(document.getElementById("newDirectory")!);
    await userEvent.type(document.getElementById("newDirectory")!, "C:\\work");
    expect(screen.getByText(/请写 POSIX 绝对路径/)).toBeInTheDocument();
    expect((screen.getByRole("button", { name: "发送并启动 Agent" }) as HTMLButtonElement).disabled).toBe(true);
    expect(h.taken("start_session")).toHaveLength(0);
    h.client.destroy();
  });

  it("submits max effort for Codex without clamping it to a lower choice", async () => {
    // Rendering and submission share one ladder, so the approval card receives
    // exactly the max value the person selected.
    const h = harness();
    mount(h);
    await h.boot(PROJECTION);
    await h.view({
      ...PROJECTION,
      workspacesByDevice: {
        laptop: {
          device: "laptop",
          workspaces: [{
            id: "ws_a",
            label: "Session Plus",
            display: "~/p",
            directoryKey: ROOT_DIRECTORY_KEY,
          }],
        },
      },
    });
    await h.settle();
    // The file root and workspace row carry the same equality key, so the
    // root's compact launch action can use the trusted workspace display path.
    await userEvent.click(document.querySelector('[data-new-directory="~/p"]') as HTMLElement);
    await userEvent.selectOptions(document.getElementById("newEffort")!, "max");
    await userEvent.selectOptions(document.getElementById("newSource")!, "codex");
    await userEvent.type(document.getElementById("newPrompt")!, "go");
    await userEvent.click(screen.getByRole("button", { name: "发送并启动 Agent" }));
    await tick();
    expect(h.taken("start_session")[0].params.effort).toBe("max");
    h.client.destroy();
  });

  it("searches on demand and opens a hit outside the recent roster", async () => {
    const h = harness();
    mount(h);
    await h.boot(PROJECTION);
    await h.settle();
    await showView("全文搜索");
    await userEvent.type(document.getElementById("search")!, "架构");
    await userEvent.click(screen.getByRole("button", { name: "搜索" }));
    await tick();
    expect(h.taken("search_sessions")[0].params).toEqual({ query: "架构", limit: "15", source: "all" });

    const older = { ...SESSION, resourceId: "search-only", title: "搜索命中的历史会话" };
    const searched = { ...PROJECTION, rosterTruncated: true,
      search: { query: "架构", results: [{ session: older, snippet: "收敛 <b>架构</b>" }] } };
    await h.view(searched);
    const hit = document.querySelector(".results .hit")!;
    const snippet = hit.querySelector(".small")!;
    expect(snippet).toHaveTextContent("收敛 <b>架构</b>");
    // The snippet is server-supplied content, so its markup stays text; the
    // `<b>` around the title is this View's own element.
    expect(snippet.querySelector("b")).toBeNull();
    expect(hit.querySelector("b")).toHaveTextContent(older.title);
    await userEvent.click(hit);
    await tick();
    expect(h.taken("open_session").some((proposal) => proposal.params.resource === older.resourceId)).toBe(true);
    const transcript = { [older.resourceId]: { offset: 0, totalMessages: 1,
      messages: [{ role: "user", blocks: [{ type: "text", text: "历史会话的真实正文" }] }] } };
    await h.view({ ...searched, transcript });
    await h.settle();
    expect(screen.getByText("历史会话的真实正文")).toBeInTheDocument();
    await userEvent.click(document.querySelector('.hit[data-hit="search-only"]')!);
    expect(screen.getAllByText("历史会话的真实正文")).toHaveLength(1);
    await userEvent.clear(document.getElementById("search")!);
    await h.view({ ...PROJECTION, rosterTruncated: true, transcript });
    await h.settle();
    expect(screen.getByText("历史会话的真实正文")).toBeInTheDocument();
    expect(h.taken("resume_session")).toHaveLength(0);
    expect(h.taken("append_session")).toHaveLength(0);
    h.client.destroy();
  });

  it("keeps the DOM hooks the real-browser boundary suite reads", async () => {
    const h = harness();
    mount(h);
    await h.boot(PROJECTION);
    await h.view({ ...PROJECTION, ...TRANSCRIPT });
    await h.settle();
    for (const selector of [
      ".cols",
      "[data-av-dock-workspace]",
      "[data-av-dock-host]",
      '[data-av-dock-flow="navigation"]',
      '[data-av-dock-document="chat"]',
      '[data-av-dock-document="file-viewer"]',
      ".command-pane",
      ".transcript#tr",
      "[data-av-chat-transcript]",
      "#composer",
      "#sendPrompt",
      "#doPin",
      "#doRefresh",
      "#railRefresh",
      "#search",
      "#doSearch",
      "#newAnywhere",
      ".directory-sessions-trigger",
    ]) {
      expect(document.querySelector(selector), `${selector} is read from outside the frame`).toBeTruthy();
    }
    // `#out` was a debug pane; the browser suite asserts it is gone.
    expect(document.querySelector("#out")).toBeNull();
    h.client.destroy();
  });

  it("shows a file tree and opens exact-key sessions from a directory marker", async () => {
    const h = harness();
    mount(h);
    await h.boot(PROJECTION);
    await h.settle();
    expect(screen.queryByRole("heading", { name: "文件" })).not.toBeInTheDocument();
    await showView("文件树");
    expect([...document.querySelectorAll(".wsdir")].some((row) => row.textContent?.includes("Session Plus")))
      .toBe(true);
    // The file tree carries no session rows of its own, only directory markers.
    expect(document.querySelectorAll(".directory-file-tree .sess")).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: /Session Plus.*1 个会话/i }));
    const dialog = screen.getByRole("dialog", { name: /Session Plus.*会话/i });
    expect(dialog).toHaveClass("directory-sessions-popover");
    expect(document.querySelector(".ant-modal-mask")).toBeNull();
    expect(dialog.querySelectorAll(".sess")).toHaveLength(1);
    h.client.destroy();
  });

  it("keeps the global new-session entry when the file tree is empty", async () => {
    const h = harness();
    mount(h);
    await h.boot({ ...PROJECTION, sessions: [], sources: [] });
    const start = screen.getByRole("button", { name: /在任意目录启动 Agent/ });
    await userEvent.click(start);
    // The form opens BESIDE the rail rather than replacing it.
    expect(screen.getByRole("heading", { name: /启动新的本地 Agent/ })).toBeInTheDocument();
    expect(document.getElementById("newDirectory")).toBeInTheDocument();
    h.client.destroy();
  });

  it("renders the standing viewer as a dock document and keeps it mounted across projection frames", async () => {
    // Declared surfaces are stable workbench documents. An unbound viewer is
    // still a real composition instance, but it carries no ResourceRef and
    // therefore performs no file operation.
    const h = harness();
    mount(h);
    await h.boot(PROJECTION);
    await h.settle();
    const viewerBefore = document.querySelector(
      '[data-av-dock-document="file-viewer"] [data-av-module="workspace.file-viewer/v1"]',
    );
    expect(viewerBefore).toBeTruthy();
    const viewerSurface = document.querySelector('[data-av-dock-document="file-viewer"]');
    expect(viewerSurface).toHaveAttribute("hidden");
    expect(viewerSurface).toHaveClass("av-dock-surface-inset");
    expect(document.querySelector('[data-av-dock-tab="file-viewer"]')?.closest(".dv-tab"))
      .toHaveAttribute("hidden");
    // Projection data does not own layout or document lifecycle, so another
    // frame cannot remount the viewer subtree.
    await h.view(PROJECTION);
    await h.settle();
    const viewerAfter = document.querySelector(
      '[data-av-dock-document="file-viewer"] [data-av-module="workspace.file-viewer/v1"]',
    );
    expect(viewerAfter).toBe(viewerBefore);
    h.client.destroy();
  });

  it("opens and closes a runtime dock document without remounting the standing viewer", async () => {
    // A runtime form and the declared viewer are separate semantic panels.
    // Dockview may arrange them together, but it cannot replace either panel
    // or turn presentation events into resource lifecycle events.
    const h = harness();
    mount(h);
    await h.boot(PROJECTION);
    await h.settle();
    const viewerBefore = document.querySelector(
      '[data-av-dock-document="file-viewer"] [data-av-module="workspace.file-viewer/v1"]',
    );
    expect(viewerBefore).toBeTruthy();

    // The real gesture creates a runtime semantic panel.
    await userEvent.click(screen.getByRole("button", { name: /在任意目录启动 Agent/ }));
    expect(await screen.findByRole("heading", { name: /启动新的本地 Agent/ })).toBeInTheDocument();

    // The viewer keeps the same mounted subtree while the form is present.
    const runtime = document.querySelector('[data-av-dock-document] [data-av-module="session.new/v1"]')
      ?.closest<HTMLElement>("[data-av-dock-document]");
    expect(runtime).toBeTruthy();
    const runtimeId = runtime!.dataset.avDockDocument!;
    expect(document.querySelector(`[data-av-dock-tab="${runtimeId}"]`)).toBeTruthy();
    const viewerDuring = document.querySelector(
      '[data-av-dock-document="file-viewer"] [data-av-module="workspace.file-viewer/v1"]',
    );
    expect(viewerDuring).toBe(viewerBefore);

    // The module asks the coordinator to close; only then does reconciliation
    // remove the Dockview document.
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: /启动新的本地 Agent/ })).toBeNull(),
    );
    const viewerAfter = document.querySelector(
      '[data-av-dock-document="file-viewer"] [data-av-module="workspace.file-viewer/v1"]',
    );
    expect(viewerAfter).toBe(viewerBefore);
    expect(document.querySelector(`[data-av-dock-document="${runtimeId}"]`)).toBeNull();
    h.client.destroy();
  });

  it("stops proposing once the trusted shell closes the channel", async () => {
    const h = harness();
    mount(h);
    await h.boot(PROJECTION);
    await h.settle();
    const before = h.proposals.length;
    h.client.destroy();
    await tick();
    await userEvent.click(screen.getByRole("button", { name: "刷新会话列表" })).catch(() => {});
    await tick();
    expect(h.proposals).toHaveLength(before);
  });
});
