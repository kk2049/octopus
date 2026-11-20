/**
 * The permission centre's rules, as the browser renders them.
 *
 * These moved here from a server test that read the page's embedded script
 * source. The properties are the same and they are the ones that carry meaning
 * rather than styling: three columns that stay three, an Agent that renders
 * inside its App, a trusted service that gets no controls, and a page that does
 * no permission arithmetic of its own.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { renderPage, stubApi } from "../test-utils.js";
import { PermissionsPage } from "./PermissionsPage.js";
import { bootstrap } from "../lib/bootstrap.js";

function entry(patch: Record<string, unknown> = {}) {
  return {
    operation: "read_session",
    title: "读取会话正文",
    description: "读取一个会话的完整记录",
    risk: "读取私密内容",
    granted: true,
    effective: true,
    explanation: "已授权且账户当前持有该操作",
    ...patch,
  };
}

const SESSION_HUB = {
  id: "session-hub",
  type: "service",
  title: "会话中心",
  description: "浏览与续跑你自己设备上的会话",
  editable: true,
  enforced: true,
  grant: { source: "user" },
  permissions: {
    requestedCount: 2,
    grantedCount: 1,
    effectiveCount: 1,
    entries: [entry(), entry({ operation: "append_session", title: "续跑会话", granted: false, effective: false, alwaysApprove: true, explanation: "尚未授权" })],
  },
};

const DEV_FACTORY = {
  id: "system:dev-factory",
  type: "service",
  title: "开发工厂",
  description: "只有被授予 dev 的人能用它",
  enforced: false,
  trustedService: {
    principal: "system:dev-factory",
    boundaries: ["以 bot 进程的 OS 账号运行，并带 --dangerously-skip-permissions"],
  },
  permissions: { requestedCount: 1, grantedCount: 0, effectiveCount: 0, entries: [entry({ granted: false, effective: false })] },
};

const AGENT = {
  id: "session-hub/reader",
  type: "agent",
  title: "reader",
  description: "只读子集",
  editable: false,
  enforced: true,
  permissions: { requestedCount: 1, grantedCount: 1, effectiveCount: 0, entries: [entry({ effective: false, explanation: "device_revoked" })] },
};

const EMPTY_STUDIO = {
  version: 2,
  username: "alice",
  revision: "studio-empty",
  coverage: { complete: true, notices: [] },
  domains: [],
  resources: [],
  aliases: [],
  holders: [],
  permits: [],
  policies: [],
  emptyCell: { label: "无许可", explanation: "服务端没有投影许可" },
  appDefaults: {
    title: "新 App 默认",
    description: "下一次安装草稿",
    permits: [],
  },
};

function stub(
  subjects: unknown[],
  connectionRows: unknown[] = [],
  githubAvailable = false,
  feishuStatus: unknown = { available: false, state: "unavailable" },
) {
  return stubApi({
    "/api/connections/unbind": { ok: true },
    "/api/connections/github/start": { authorize_url: "https://github.com/login/oauth/authorize?state=fake" },
    "/api/connections": { connections: connectionRows, github_available: githubAvailable },
    "/api/permissions/devices": { devices: [] },
    "/api/permissions/web-sessions": { sessions: [] },
    "/api/permissions/audit": { records: [] },
    "/api/permissions/studio": EMPTY_STUDIO,
    "/api/permissions": { subjects },
    "/api/tentacle": { available: true, devices: [], shares: [] },
    "/api/mcp/tokens": {
      tokens: [],
      registration: {
        endpoint: "https://example.test/api/mcp",
        command: 'claude mcp add --transport http octopus https://example.test/api/mcp --header "Authorization: Bearer <mcp_token>"',
        config: { mcpServers: {} },
      },
    },
    "/api/feishu/oauth/status": feishuStatus,
    "/api/feishu/oauth/start": {
      available: true, state: "pending", userCode: "TEST-CODE",
      verificationUri: "https://accounts.feishu.cn/oauth/device?code=TEST-CODE",
      expiresAt: "2099-01-01T00:00:00Z",
    },
  });
}

describe("the permission centre", () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    (bootstrap as { pageProps: unknown }).pageProps = { owner: "alice", canEdit: true };
    vi.spyOn(window, "open").mockReturnValue(null);
  });

  it("renders requested / granted / effective as three separate columns", async () => {
    stub([SESSION_HUB]);
    renderPage(<PermissionsPage />);
    // Wait for the SUBJECT table specifically: the audit table below it renders
    // its own headers immediately, so "any columnheader" would resolve on the
    // wrong table.
    const first = (await screen.findAllByRole("columnheader", { name: "能做什么" }))[0];
    const headers = [...first.closest("tr")!.querySelectorAll("th")].map((cell) => cell.textContent);
    expect(headers).toEqual(["能做什么", "类别", "申请", "已授权", "此刻有效", "为什么"]);
  });

  it("shows the server's reason text verbatim and computes no verdict of its own", async () => {
    stub([SESSION_HUB]);
    renderPage(<PermissionsPage />);
    expect(await screen.findByText("已授权且账户当前持有该操作")).toBeInTheDocument();
    expect(screen.getByText("尚未授权")).toBeInTheDocument();
  });

  it("shows an operation that is granted but NOT effective as exactly that", async () => {
    // The lie a single tick would tell: "the laptop was revoked but the page
    // still says it may read".
    stub([{ ...SESSION_HUB, permissions: { ...SESSION_HUB.permissions, entries: [entry({ granted: true, effective: false, explanation: "device_revoked" })] } }]);
    renderPage(<PermissionsPage />);
    const row = (await screen.findByText("读取会话正文")).closest("tr")!;
    const cells = within(row).getAllByRole("cell");
    // granted column holds a checked box; effective column holds the dash.
    expect(within(cells[3]).getByRole("checkbox")).toBeChecked();
    expect(cells[4].textContent).toContain("—");
    expect(cells[5].textContent).toBe("device_revoked");
  });

  it("gives a trusted service no save or revoke control, even to an admin", async () => {
    stub([DEV_FACTORY]);
    renderPage(<PermissionsPage />);
    await screen.findByRole("heading", { name: /开发工厂/ });
    expect(screen.queryByRole("button", { name: "保存授权" })).toBeNull();
    expect(screen.queryByRole("button", { name: "全部撤销" })).toBeNull();
    expect(screen.getByText("受信系统服务")).toBeInTheDocument();
  });

  it("labels the trusted service's list as what it HAS, not a boundary", async () => {
    stub([DEV_FACTORY]);
    renderPage(<PermissionsPage />);
    expect(
      await screen.findByText(/实际权限（不受本页授权或沙箱控制）/),
    ).toBeInTheDocument();
  });

  it("still gives an enforced, user-managed subject its controls", async () => {
    stub([SESSION_HUB]);
    renderPage(<PermissionsPage />);
    expect(await screen.findByRole("button", { name: "保存授权" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "全部撤销" })).toBeInTheDocument();
  });

  it("renders an Agent inside its App and says it is a subset", async () => {
    stub([SESSION_HUB, AGENT]);
    renderPage(<PermissionsPage />);
    const app = (await screen.findByRole("heading", { name: /会话中心/ })).closest("div")!;
    expect(within(app).getByText("↳ Agent reader")).toBeInTheDocument();
    expect(within(app).getByText("只能是所属 App 的子集")).toBeInTheDocument();
  });

  it("marks an unenforced subject and withholds its controls", async () => {
    stub([{ ...SESSION_HUB, id: "app:demo", enforced: false, editable: false, grant: null }]);
    renderPage(<PermissionsPage />);
    expect(await screen.findByText(/未接入执行路径/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保存授权" })).toBeNull();
  });

  it("shows the pending diff of what SAVE would change, before it is pressed", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    stub([SESSION_HUB]);
    renderPage(<PermissionsPage />);
    await user.click(await screen.findByRole("checkbox", { name: "授权 续跑会话" }));
    await waitFor(() => expect(screen.getByText(/将要变更/)).toBeInTheDocument());
    expect(screen.getByText("+append_session")).toBeInTheDocument();
  });

  it("re-reads every panel after a grant — a stale cache would show revoked rights", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    const { calls } = stub([SESSION_HUB]);
    renderPage(<PermissionsPage />);
    await screen.findByRole("heading", { name: /会话中心/ });
    const before = calls.filter((call) => call.url.startsWith("/api/permissions?")).length;
    await user.click(await screen.findByRole("button", { name: "保存授权" }));
    // Granting changes what is EFFECTIVE, and effectiveness is the server's
    // arithmetic — so the page must ask again rather than patch what it holds.
    await waitFor(() =>
      expect(
        calls.filter((call) => call.url.startsWith("/api/permissions?")).length,
      ).toBeGreaterThan(before),
    );
    // …and the audit trail too, because a grant is an audited event.
    expect(calls.some((call) => call.url.startsWith("/api/permissions/audit"))).toBe(true);
  });

  it("re-reads after a device is revoked, because that changes every effective row", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    const { calls } = stubApi({
      "/api/permissions/devices": { devices: [{ device: "laptop", online: true, created_at: "2026-01-01" }] },
      "/api/permissions/web-sessions": { sessions: [] },
      "/api/permissions/audit": { records: [] },
      "/api/permissions/studio": EMPTY_STUDIO,
      "/api/permissions": { subjects: [SESSION_HUB] },
      "/api/connections": { connections: [], github_available: false },
      "/api/runner-delete": { ok: true },
    });
    renderPage(<PermissionsPage />);
    await user.click(screen.getByRole("tab", { name: "连接与设备" }));
    // The row's button opens a confirmation; the dialog's button is the one that
    // actually revokes. A destructive action on this page is never one click.
    await user.click(await screen.findByRole("button", { name: "吊销" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "吊销" }));
    await waitFor(() => expect(calls.some((call) => call.url === "/api/runner-delete")).toBe(true));
    await waitFor(() =>
      expect(calls.filter((call) => call.url.startsWith("/api/permissions?")).length).toBeGreaterThan(1),
    );
  });

  it("reads each panel exactly once and polls none of them", async () => {
    const { calls } = stub([SESSION_HUB]);
    renderPage(<PermissionsPage />);
    await screen.findByRole("heading", { name: /会话中心/ });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const paths = calls.map((call) => call.url.split("?")[0]);
    expect(paths.filter((path) => path === "/api/permissions")).toHaveLength(1);
    expect(paths.filter((path) => path === "/api/permissions/studio")).toHaveLength(1);
    expect(paths.filter((path) => path === "/api/permissions/devices")).toHaveLength(1);
    expect(paths.filter((path) => path === "/api/connections")).toHaveLength(1);
  });

  it("shows labels but never external ids, and confirms before unbinding", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    const { calls } = stub(
      [SESSION_HUB],
      [{
        connection_id: "opaque-process-handle",
        provider: "github",
        label: "octocat",
        created_at: "2026-08-14T00:00:00.000Z",
      }],
      true,
    );
    renderPage(<PermissionsPage />);
    await user.click(screen.getByRole("tab", { name: "连接与设备" }));
    expect(await screen.findByText("octocat")).toBeInTheDocument();
    expect(screen.queryByText("987654321")).toBeNull();
    expect(screen.getByRole("button", { name: "绑定 GitHub" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "解绑" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "解绑" }));
    await waitFor(() =>
      expect(calls.some((call) => {
        if (call.url !== "/api/connections/unbind") return false;
        return String(call.init?.body).includes("opaque-process-handle");
      })).toBe(true),
    );
  });
  it("selects all or none locally and saves only this subject's operations", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    const { calls } = stub([SESSION_HUB]);
    renderPage(<PermissionsPage />);
    await user.click(await screen.findByRole("button", { name: "全选" }));
    expect(screen.getByRole("checkbox", { name: "授权 续跑会话" })).toBeChecked();
    expect(calls.some((call) => call.init?.method === "POST")).toBe(false);
    await user.click(screen.getByRole("tab", { name: "权限树" }));
    await user.click(screen.getByRole("tab", { name: "应用授权" }));
    expect(screen.getByRole("checkbox", { name: "授权 续跑会话" })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "全不选" }));
    expect(screen.getByRole("checkbox", { name: "授权 读取会话正文" })).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "保存授权" }));
    await waitFor(() => expect(calls.some((call) => call.url === "/api/permissions/grant")).toBe(true));
    const call = calls.find((call) => call.url === "/api/permissions/grant")!;
    expect(JSON.parse(String(call.init?.body))).toEqual({ username: "alice", subject_type: "service", subject_id: "session-hub", operations: [] });
  });

  it("changes one group without selecting operations in another group", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    stub([{ ...SESSION_HUB, permissions: { ...SESSION_HUB.permissions, entries: [
      entry(), entry({ operation: "execute", title: "执行命令", risk: "执行命令", granted: false, effective: false }),
    ] } }]);
    renderPage(<PermissionsPage />);
    await user.click(await screen.findByRole("checkbox", { name: "整组授权 读取私密内容" }));
    expect(screen.getByRole("checkbox", { name: "授权 读取会话正文" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "授权 执行命令" })).not.toBeChecked();
  });

  it("opens login connections for existing OAuth return links", async () => {
    stub([SESSION_HUB]);
    renderPage(<PermissionsPage />, "/permissions#connections");
    expect(screen.getByRole("tab", { name: "连接与设备" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByRole("heading", { name: "登录连接" })).toBeVisible();
  });

  it("keeps unavailable personal OAuth visible separately from a bound Feishu login", async () => {
    const { calls } = stub([], [{ connection_id: "feishu-login", provider: "feishu", label: "Feishu login", created_at: "2026-09-22T00:00:00Z" }]);
    renderPage(<PermissionsPage />, "/permissions?view=connections");
    expect(await screen.findByText("Feishu login")).toBeVisible();
    expect(screen.getByText("飞书个人连接")).toBeVisible();
    expect(await screen.findByText("当前部署尚未启用飞书个人授权，请联系管理员配置后再连接。")).toBeVisible();
    expect(screen.getByText("飞书登录身份绑定不代表已授权访问个人日历和文档。")).toBeVisible();
    expect(screen.queryByRole("button", { name: "连接飞书" })).toBeNull();
    expect(calls.some((call) => call.url === "/api/feishu/oauth/start")).toBe(false);
  });

  it("opens the Feishu recovery destination and explicitly forces reauthorization of a saved grant", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    const { calls } = stub([], [], false, { available: true, state: "connected" });
    renderPage(<PermissionsPage />, "/permissions?focus=feishu");
    expect(screen.getByRole("tab", { name: "连接与设备" })).toHaveAttribute("aria-selected", "true");
    await user.click(await screen.findByRole("button", { name: "重新授权" }));
    expect(await screen.findByRole("link", { name: "打开飞书授权页" })).toHaveAttribute("href", "https://accounts.feishu.cn/oauth/device?code=TEST-CODE");
    const starts = calls.filter((call) => call.url === "/api/feishu/oauth/start");
    expect(starts).toHaveLength(1);
    expect(JSON.parse(String(starts[0].init?.body))).toEqual({ username: "alice", force: true });
  });

  it("keeps personal Feishu authorization above the tabs and visible in every section", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    stub([], [], false, { available: true, state: "connected" });
    renderPage(<PermissionsPage />);
    const card = await screen.findByRole("region", { name: "飞书个人连接" });
    const tabs = screen.getByRole("tablist", { name: "权限中心分区" });
    expect(card.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    for (const name of ["权限树", "连接与设备", "活动记录", "应用授权"]) {
      await user.click(screen.getByRole("tab", { name }));
      expect(within(card).getByRole("button", { name: "重新授权" })).toBeVisible();
    }
    expect(screen.getAllByRole("region", { name: "飞书个人连接" })).toHaveLength(1);
  });

  it("walks the activity record to its oldest entry with an explicit, cursor-keyed load", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    stub([SESSION_HUB]);
    // 230 events, newest first, in pages of 100 keyed by the last id seen.
    const all = Array.from({ length: 230 }, (_, index) => ({
      id: 230 - index, at: "2026-10-01T00:00:00Z", subject_id: "session-hub", operation: `op-${230 - index}`, decision: "allow",
    }));
    const audit: string[] = [];
    const stubbed = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith("/api/permissions/audit")) return stubbed(input, init);
      audit.push(url);
      const before = Number(new URL(url, "http://x").searchParams.get("before") ?? Infinity);
      const page = all.filter((row) => row.id < before);
      const records = page.slice(0, 100);
      const more = page.length > 100;
      return new Response(JSON.stringify({ records, has_more: more, ...(more ? { next_before: records.at(-1)!.id } : {}) }),
        { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    renderPage(<PermissionsPage />, "/permissions?view=activity");
    expect(await screen.findByText("op-230")).toBeInTheDocument();
    expect(screen.queryByText("op-130")).toBeNull();
    expect(screen.getByTestId("audit-paging")).toHaveTextContent("已加载 100 条；还有更早的记录。");
    // Nothing older is fetched until the person asks.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(audit).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "加载更早的记录" }));
    expect(await screen.findByText("op-130")).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "加载更早的记录" }));
    expect(await screen.findByText("op-1")).toBeInTheDocument();
    expect(screen.getByTestId("audit-paging")).toHaveTextContent("已加载全部 230 条记录。");
    expect(screen.queryByRole("button", { name: "加载更早的记录" })).toBeNull();
    expect(audit.map((url) => new URL(url, "http://x").searchParams.get("before"))).toEqual([null, "131", "31"]);
    // Every event appears exactly once.
    const rows = screen.getAllByText(/^op-\d+$/).map((cell) => cell.textContent);
    expect(new Set(rows).size).toBe(230);
  });

});
