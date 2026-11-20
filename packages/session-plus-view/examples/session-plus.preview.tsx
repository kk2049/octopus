/**
 * Sessions+ navigation preview — synthetic data shaped like a busy account.
 *
 * Run with:
 *   node_modules/.bin/tsx packages/agent-view-preview/src/cli.ts \
 *     packages/session-plus-view/examples/session-plus.preview.tsx --port 5181
 *
 * The fixture reproduces the proportions that made the old flat list hard to
 * use: a benchmark harness that spawned many `codex exec` threads, a dozen
 * foreground tmux CLIs, a few favorites and user folders. App-owned actions
 * (pin, folders) mutate the fixture projection through the preview's console
 * handle, so drag/drop and menus can be exercised without a Host. Nothing here
 * is real account data.
 */

import "../src/styles/app.css";
import { useEffect } from "react";
import { renderAgentViewThemeCss } from "@claude-bot/agent-view-build/theme-tokens";
import { App } from "../src/App.js";

// A release build replaces the theme-token placeholder with these rules; the
// preview server does not, so inject the same generated CSS here.
const themeTokens = document.createElement("style");
themeTokens.textContent = `@layer agent-view-base { ${renderAgentViewThemeCss()} }`;
document.head.append(themeTokens);

/** Apply `?theme=` through the fixture's appearance channel, as a Host would. */
function Themed({ theme }: { theme: string | null }) {
  useEffect(() => {
    if (!theme) return;
    (globalThis as { __appPreview?: { setAppearance(value: unknown): void } })
      .__appPreview?.setAppearance({ contract: "appearance/v1", theme });
  }, [theme]);
  return <App />;
}

type Row = Record<string, unknown> & { resourceId: string };

const NOW = Date.parse("2026-10-22T13:00:00Z");
const at = (minutesAgo: number): string => new Date(NOW - minutesAgo * 60_000).toISOString();
const tmux = (minutesAgo: number, working = false) => ({
  process_state: "alive",
  turn_state: working ? "working" : "idle",
  observed_at: at(Math.min(minutesAgo, 0.2)),
  attachment: { kind: "terminal_tmux", state: "attached", transport: "tmux" },
});

function chat(id: string, input: Partial<Row> & { minutesAgo: number }): Row {
  const { minutesAgo, ...rest } = input;
  return {
    resourceId: id,
    deviceId: "workstation",
    deviceLabel: "workstation",
    cliKind: "claude",
    sessionId: id,
    cwdDisplay: "~/repos/platform",
    lastActivity: at(minutesAgo),
    sortActivity: at(minutesAgo),
    status: "idle",
    resumable: true,
    messageCount: 40 + (id.length * 7) % 300,
    ...rest,
  };
}

const interactive: Row[] = [
  chat("fx-perf", { minutesAgo: 1, title: "服务器 IO 抖动排查", cwdDisplay: "~", runtime: tmux(1, true), status: "live" }),
  chat("fx-runner", { minutesAgo: 2, title: "笔记本 Runner 自恢复", runtime: tmux(2) }),
  chat("fx-history", { minutesAgo: 3, title: "会话导航改版", runtime: tmux(3, true), status: "live" }),
  chat("fx-merge", { minutesAgo: 9, title: "模型合并实验", cwdDisplay: "~/repos/model-merge", runtime: tmux(9) }),
  chat("fx-backup", { minutesAgo: 15, cliKind: "codex", accountLabel: "a", cwdDisplay: "~", firstUserText: "把聊天记录备份到外部存储并整理成明文", messageCount: 91 }),
  chat("fx-statusline", { minutesAgo: 14, title: "终端状态栏配置", cwdDisplay: "~/work" }),
  chat("fx-ask", { minutesAgo: 21, cliKind: "codex", deviceId: "lab-observer", deviceLabel: "lab-observer", title: "实验设计与试运行", cwdDisplay: "~/…/team" }),
  chat("fx-acc-e0", { minutesAgo: 8, title: "E0 修复能力微基准", cwdDisplay: "~/research/bench/test-threads/e0-repairbench", runtime: tmux(8, true), status: "live" }),
  chat("fx-acc-e1", { minutesAgo: 8, title: "E1 学术基线对照", cwdDisplay: "~/research/bench/test-threads/e1-baselines-filtered-read", runtime: tmux(8) }),
  chat("fx-acc-e2", { minutesAgo: 40, title: "E2 分叉与补偿测试", cwdDisplay: "~/research/bench/test-threads/e2-fork-vs-saga", runtime: tmux(40) }),
  chat("fx-acc-e3", { minutesAgo: 55, title: "E3 多档难度负载", cwdDisplay: "~/research/bench/test-threads/e3-aiopslab-levels-workloads", runtime: tmux(55) }),
  chat("fx-acc-e4", { minutesAgo: 70, title: "E4 工具接入评估", cwdDisplay: "~/research/bench/test-threads/e4-toolsmith-objects", runtime: tmux(70) }),
  chat("fx-acc-d", { minutesAgo: 95, title: "D 动作块试跑", cwdDisplay: "~/research/bench/test-threads/d-action-blocks-runtime", runtime: tmux(95) }),
  chat("fx-theory", { minutesAgo: 130, title: "理论讨论", cwdDisplay: "~/research/theory", runtime: tmux(130) }),
  chat("fx-report", { minutesAgo: 160, title: "年度报告", cwdDisplay: "~/reports/annual", runtime: tmux(160) }),
  chat("fx-planner", { minutesAgo: 25, cliKind: "codex", accountLabel: "c", title: "日程助手", cwdDisplay: "~/work", messageCount: 907 }),
  chat("fx-runner-logs", { minutesAgo: 94, cliKind: "codex", title: "核查 Runner 日志", cwdDisplay: "~" }),
  chat("fx-swe", { minutesAgo: 81, cliKind: "codex", deviceId: "lab-observer", deviceLabel: "lab-observer", title: "阅读开源项目", cwdDisplay: "~/…/swe" }),
  chat("fx-ppt", { minutesAgo: 60 * 24 * 38, cliKind: "codex", deviceId: "cloud-box", deviceLabel: "cloud-box", title: "幻灯片生成", cwdDisplay: "~/slides", messageCount: 210 }),
  chat("fx-ppopp", { minutesAgo: 60 * 24 * 27, cliKind: "codex", deviceId: "cloud-box", deviceLabel: "cloud-box", title: "论文审稿", cwdDisplay: "~/papers/ppopp", messageCount: 76 }),
];

const benchmarkTasks = [
  "Reconcile the dinner-share note with incoming Venmo payments",
  "Start a workout playlist sized to today's plan",
  "Request the remaining Friends Dinner payments",
  "Archive the unread promotional emails older than a week",
  "Move tomorrow's 1:1 to the first free slot after lunch",
  "Split the grocery bill with roommates",
];

/** `codex exec` threads from a benchmark harness. Half carry the native exec mark. */
const automated: Row[] = Array.from({ length: 48 }, (_, index) => chat(`fx-run-${index}`, {
  minutesAgo: 1 + index * 0.6,
  cliKind: "codex",
  accountLabel: "b",
  cwdDisplay: `~/research/bench/test-threads/e0/runs/pilot/R${index % 6}-r${index % 4}/p1/cwd`,
  preview: `${benchmarkTasks[index % benchmarkTasks.length]}.\n\nANSWER: done`,
  messageCount: 2 + (index % 17),
  executionMode: "exec",
}));

const sessions = [...interactive.filter((row) => !["fx-ppt", "fx-ppopp"].includes(row.resourceId)), ...automated]
  .sort((a, b) => String(b.sortActivity).localeCompare(String(a.sortActivity)));

const projection: Record<string, unknown> = {
  sessions,
  rosterTruncated: true,
  sources: [
    { kind: "runner", device: "workstation", deviceLabel: "workstation", online: true },
    { kind: "runner", device: "lab-observer", deviceLabel: "lab-observer", online: true },
    { kind: "runner", device: "cloud-box", deviceLabel: "cloud-box", online: true },
  ],
  pinned: ["fx-planner", "fx-ppt", "fx-backup"],
  customTitles: { "fx-backup": "聊天记录备份" },
  reviewedAt: {},
  sessionFolders: [
    { id: "f_acc", name: "基准测试线", sessions: ["fx-acc-e0", "fx-acc-e1", "fx-acc-e2", "fx-acc-e3", "fx-acc-e4", "fx-acc-d"] },
    { id: "f_papers", name: "论文与汇报", sessions: ["fx-ppopp", "fx-report"] },
  ],
  transcript: {
    "fx-backup": {
      turnConfiguration: { model: "gpt-6-luna", effort: "high" },
      sessionId: "fx-backup", cliKind: "codex", rich: true, offset: 0, totalMessages: 3, hasMore: false,
      messages: [
        { role: "user", timestamp: at(30), blocks: [{ type: "text", text: "把聊天记录备份到外部存储并整理成明文，并在本机解码成明文。" }] },
        { role: "assistant", timestamp: at(20), blocks: [{ type: "text", text: "可以。先在设备上建立独立归档目录，再拷回本机处理。" }] },
        { role: "assistant", timestamp: at(15), blocks: [{ type: "text", text: "两个账号都纳入范围；连接恢复后核对远端状态。" }] },
      ],
    },
  },
};

type PreviewHandle = {
  client: { snapshot(): { projection: Record<string, unknown> | null } };
  setProjection(next: Record<string, unknown>): void;
};

function mutate(change: (current: Record<string, unknown>) => Record<string, unknown>): void {
  const handle = (globalThis as { __appPreview?: PreviewHandle }).__appPreview;
  const current = handle?.client.snapshot().projection;
  if (handle && current) handle.setProjection(change(current));
}

const list = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
type Folder = { id: string; name: string; sessions: string[] };
const folders = (value: unknown): Folder[] => Array.isArray(value) ? value as Folder[] : [];

const ok = { ok: true, result: null };

export default {
  kind: "custom" as const,
  app: "session-plus",
  title: "Sessions+ 导航",
  projection,
  actions: {
    refresh_sessions: ok,
    refresh_workspaces: ok,
    open_session: ok,
    close_session: ok,
    review_session: ok,
    search_sessions: (params: Record<string, string>) => {
      const query = (params.query ?? "").trim();
      mutate((current) => ({
        ...current,
        search: {
          query,
          cursor: params.cursor ?? "",
          complete: true,
          results: [...interactive, ...automated]
            .filter((row) => JSON.stringify(row).includes(query))
            .slice(0, 8)
            .map((session) => ({ session, snippet: `…${query}…` })),
        },
      }));
      return ok;
    },
    pin_session: (params: Record<string, string>) => {
      mutate((current) => {
        const pinned = list(current.pinned).filter((id) => id !== params.session);
        const wanted = params.pinned === undefined ? !list(current.pinned).includes(params.session ?? "") : params.pinned === "true";
        return { ...current, pinned: wanted ? [...pinned, params.session ?? ""] : pinned };
      });
      return ok;
    },
    set_session_title: (params: Record<string, string>) => {
      mutate((current) => {
        const titles = { ...(current.customTitles as Record<string, string> | undefined) };
        const title = (params.title ?? "").trim();
        if (title) titles[params.session ?? ""] = title;
        else delete titles[params.session ?? ""];
        return { ...current, customTitles: titles };
      });
      return ok;
    },
    save_session_folder: (params: Record<string, string>) => {
      mutate((current) => {
        const existing = folders(current.sessionFolders);
        const name = (params.name ?? "").trim();
        const next = existing.some((folder) => folder.id === params.folder)
          ? existing.map((folder) => folder.id === params.folder ? { ...folder, name } : folder)
          : [...existing, { id: params.folder ?? "", name, sessions: [] }];
        return { ...current, sessionFolders: next };
      });
      return ok;
    },
    delete_session_folder: (params: Record<string, string>) => {
      mutate((current) => ({
        ...current,
        sessionFolders: folders(current.sessionFolders).filter((folder) => folder.id !== params.folder),
      }));
      return ok;
    },
    file_sessions: (params: Record<string, string>) => {
      const moving = (params.sessions ?? "").split(",").filter(Boolean);
      mutate((current) => ({
        ...current,
        sessionFolders: folders(current.sessionFolders).map((folder) => ({
          ...folder,
          sessions: folder.id === params.folder
            ? [...folder.sessions.filter((id) => !moving.includes(id)), ...moving]
            : folder.sessions.filter((id) => !moving.includes(id)),
        })),
      }));
      return ok;
    },
  },
  render: () => {
    // `?theme=apple` (or any Dashboard theme id) previews that appearance.
    const theme = new URLSearchParams(globalThis.location?.search ?? "").get("theme");
    return <Themed theme={theme} />;
  },
};
