/**
 * The two shared-instance modes of `/apps/<id>/open` (ADR 0007 P1, slice B).
 *
 * The server decides WHICH mode a viewer gets (that decision is pinned in
 * `bot/src/dashboard/apps-shared-route.test.ts`); what this file pins is that
 * the page then asks for exactly what it renders:
 *
 *  · a full seat is a disabled fact, not a clickable failure;
 *  · joining POSTs the chosen role to the instance the server named — the page
 *    never invents or edits an instance key;
 *  · creating POSTs a role and nothing else, because the key is server-minted;
 *  · the share link is the page's own open URL — a link, not an invitation
 *    object, because knowing it while logged in IS the invite.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { useAgentViewSnapshot, usePropose } from "@claude-bot/agent-view-react";
import type { AppHostDeps } from "../session-plus/app-host.js";
import { renderPage, stubApi } from "../test-utils.js";
import { bootstrap } from "../lib/bootstrap.js";
import {
  AppOpenPage,
  loadMoreResearchProjects,
  RESEARCH_PROJECT_LOAD_MORE_ACTION,
  RESEARCH_PROJECT_NAVIGATE_ACTION,
  reloadToAvailableVersion,
  researchProjectNavigationPath,
  researchViewProjection,
} from "./AppOpenPage.js";
import type { AppOpenAppProps, AppOpenConsentProps, AppOpenInstancesProps, AppOpenJoinProps, SharedWorkspaceProps } from "../contract.js";

// Supply only the loaded module; keep the real host, runtime, provider and mount.
const moduleLoader = vi.hoisted(() => vi.fn());
vi.mock("../session-plus/app-host.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session-plus/app-host.js")>();
  return {
    ...actual,
    createAppHost: (deps: AppHostDeps) => actual.createAppHost({ ...deps, loadModule: moduleLoader }),
  };
});

function ModuleApp() {
  const [draft, setDraft] = useState("");
  const propose = usePropose();
  const projection = useAgentViewSnapshot().projection as {
    workspace_navigation?: { projects: Array<{ ref: string; title: string }>; truncated?: boolean };
  } | null;
  return <section aria-label="Loaded App module">
    <textarea aria-label="App draft" value={draft} onChange={(event) => setDraft(event.target.value)} />
    {projection?.workspace_navigation && <nav aria-label="App project navigation">
      {projection.workspace_navigation.projects.map((project) => <span key={project.ref}>{project.title}</span>)}
      {projection.workspace_navigation.truncated
        ? <button type="button" onClick={() => void propose(RESEARCH_PROJECT_LOAD_MORE_ACTION, {})}>App load more</button>
        : null}
    </nav>}
  </section>;
}

const APP = {
  stableAppId: "demo-board",
  publisher: "demo:acme",
  title: "Demo Board",
  packageDigest: "d".repeat(64),
  viewOrigin: "http://app-x.local:9821",
};
const KEY = `asi_${"a".repeat(32)}`;
const OTHER_KEY = `asi_${"b".repeat(32)}`;
const RESEARCH_APP = {
  ...APP,
  stableAppId: "research-program",
  title: "自动科研项目台",
};

function setProps(props: AppOpenAppProps | AppOpenConsentProps | AppOpenJoinProps | AppOpenInstancesProps): void {
  (bootstrap as { pageProps: unknown }).pageProps = props;
}

function stubReleaseStream(
  mode: "multi_version" | "refresh_required",
  app = APP,
): { publish(): void } {
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith("/api/app-view/stream?app=" + app.stableAppId)) {
      throw new Error("unexpected request to " + url);
    }
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        init?.signal?.addEventListener("abort", () => controller.close(), { once: true });
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }));
  return {
    publish() {
      if (!streamController) throw new Error("release stream is not connected");
      const payload = {
        current_package_digest: app.packageDigest,
        available_package_digest: "e".repeat(64),
        mode,
      };
      streamController.enqueue(new TextEncoder().encode(
        "event: release_available\ndata: " + JSON.stringify(payload) + "\n\n",
      ));
    },
  };
}

// Ant Descriptions reads breakpoints through `window.matchMedia`, which jsdom
// does not provide. The platform-shaped no-op, exactly as `vitest.setup.ts`
// installs for `ResizeObserver` — not an Ant mock.
beforeEach(() => {
  moduleLoader.mockReset().mockResolvedValue({ App: ModuleApp, styles: [] });
  vi.stubGlobal("matchMedia", (media: string) => ({
    matches: false,
    media,
    onchange: null,
    addEventListener(): void {},
    removeEventListener(): void {},
    addListener(): void {},
    removeListener(): void {},
    dispatchEvent: () => false,
  }));
});

describe("join mode", () => {
  const seats = [
    { role: "white", max: 1, observer: false, taken: 1 },
    { role: "black", max: 1, observer: false, taken: 0 },
    { role: "watcher", max: 2, observer: true, taken: 0 },
  ];

  it("offers a button per free seat and renders the full one as a disabled fact", () => {
    setProps({ mode: "join", app: APP, instanceKey: KEY, seats });
    renderPage(<AppOpenPage />);
    expect(screen.getByRole("button", { name: "已满" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "以 black 加入" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "以 watcher 加入" })).toBeEnabled();
    expect(screen.getByText(KEY)).toBeInTheDocument();
  });

  it("offers no button for a seat the creator assigns (B5)", () => {
    setProps({
      mode: "join",
      app: APP,
      instanceKey: KEY,
      seats: [
        { role: "manager", max: 8, observer: false, taken: 0, joinable: false },
        { role: "submitter", max: 64, observer: false, taken: 1, joinable: true },
      ],
    });
    renderPage(<AppOpenPage />);
    expect(screen.queryByRole("button", { name: "以 manager 加入" })).not.toBeInTheDocument();
    expect(screen.getByText("由创建者分配")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "以 submitter 加入" })).toBeEnabled();
  });

  it("POSTs the chosen role to the server-named instance", async () => {
    setProps({ mode: "join", app: APP, instanceKey: KEY, seats });
    const stub = stubApi({
      [`/api/apps/demo-board/shared-instances/${KEY}/join`]: { ok: true, instance_key: KEY, role: "black" },
    });
    renderPage(<AppOpenPage />);
    fireEvent.click(screen.getByRole("button", { name: "以 black 加入" }));
    await waitFor(() => expect(stub.calls).toHaveLength(1));
    expect(stub.calls[0].url).toBe(`/api/apps/demo-board/shared-instances/${KEY}/join`);
    expect(stub.calls[0].init?.method).toBe("POST");
    expect(JSON.parse(String(stub.calls[0].init?.body))).toEqual({ role: "black" });
  });
});

describe("instances mode", () => {
  const roles = [
    { role: "white", max: 1, observer: false },
    { role: "watcher", max: 2, observer: true },
  ];

  it("links each membership to its open URL, with a copyable share link", () => {
    setProps({
      mode: "instances",
      app: APP,
      roles,
      instances: [
        { instanceKey: KEY, createdAt: "2026-08-11T10:00:00.000Z", creator: "alice", role: "white", members: 2 },
      ],
    });
    renderPage(<AppOpenPage />);
    expect(screen.getByRole("link", { name: KEY })).toHaveAttribute(
      "href",
      `/apps/demo-board/open?instance=${KEY}`,
    );
    expect(screen.getByRole("button", { name: "复制分享链接" })).toBeInTheDocument();
  });

  it("shows research project names rather than opaque instance IDs", () => {
    setProps({ mode: "instances", app: { ...APP, stableAppId: "research-v2" }, roles,
      instances: [{ instanceKey: KEY, title: "ACC 并发控制", createdAt: "2026-09-22", creator: "alice", role: "owner", members: 2 }] });
    renderPage(<AppOpenPage />);
    expect(screen.getByRole("link", { name: "ACC 并发控制" })).toHaveAttribute("href", `/apps/research-v2/open?instance=${KEY}`);
    expect(screen.queryByText(KEY)).not.toBeInTheDocument();
  });

  it("says so when the viewer belongs to no instance yet", () => {
    setProps({ mode: "instances", app: APP, roles, instances: [] });
    renderPage(<AppOpenPage />);
    expect(screen.getByText("你还没有加入任何实例。")).toBeInTheDocument();
  });

  it("creates by POSTing a role and nothing else — the key is the server's to mint", async () => {
    setProps({ mode: "instances", app: APP, roles, instances: [] });
    const stub = stubApi({
      "/api/apps/demo-board/shared-instances": { ok: true, instance_key: KEY, role: "watcher" },
    });
    renderPage(<AppOpenPage />);
    fireEvent.click(screen.getByRole("button", { name: "以 watcher 新开（观战）" }));
    await waitFor(() => expect(stub.calls).toHaveLength(1));
    expect(stub.calls[0].url).toBe("/api/apps/demo-board/shared-instances");
    expect(stub.calls[0].init?.method).toBe("POST");
    expect(JSON.parse(String(stub.calls[0].init?.body))).toEqual({ role: "watcher" });
  });

  it("gives only a creator-marked instance the bounded member manager", async () => {
    setProps({
      mode: "instances",
      app: APP,
      roles,
      instances: [{
        instanceKey: KEY,
        createdAt: "2026-08-11T10:00:00.000Z",
        creator: "alice",
        role: "white",
        members: 2,
        manageable: true,
        memberRows: [
          { username: "alice", role: "white", joinedAt: "2026-08-11T10:00:00.000Z" },
          { username: "bob", role: "watcher", joinedAt: "2026-08-11T10:01:00.000Z" },
        ],
      }],
    });
    const stub = stubApi({
      [`/api/apps/demo-board/shared-instances/${KEY}/member-candidates`]: {
        ok: true,
        candidates: [{ username: "carol", display_name: "Carol Chen" }],
      },
      [`/api/apps/demo-board/shared-instances/${KEY}/members`]: { ok: true },
    });
    renderPage(<AppOpenPage />);
    fireEvent.click(screen.getByRole("button", { name: "管理成员" }));
    expect(screen.getByText("创建者")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "移除" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "搜索成员" }), { target: { value: "cc" } });
    fireEvent.click(await screen.findByRole("option", { name: /Carol Chen.*@carol/ }));
    fireEvent.click(screen.getByRole("button", { name: "添加 / 改角色" }));
    await waitFor(() => expect(stub.calls.some((call) => call.init?.method === "POST")).toBe(true));
    const mutation = stub.calls.find((call) => call.init?.method === "POST");
    expect(JSON.parse(String(mutation?.init?.body))).toEqual({ username: "carol", role: "white" });
  });
});

describe("research workbench presentation", () => {
  const roles = [
    { role: "owner", max: 1, observer: false },
    { role: "member", max: 64, observer: false },
    { role: "viewer", max: 64, observer: true },
  ];
  const workspace: SharedWorkspaceProps = {
    roles,
    currentInstanceKey: KEY,
    projects: [
      {
        instanceKey: KEY,
        createdAt: "2026-08-27T10:00:00.000Z",
        creator: "alice",
        role: "owner",
        members: 2,
        title: "可验证材料研究",
        manageable: true,
        memberRows: [{ username: "alice", role: "owner", joinedAt: "2026-08-27T10:00:00.000Z" }],
      },
      {
        instanceKey: OTHER_KEY,
        createdAt: "2026-08-26T10:00:00.000Z",
        creator: "bob",
        role: "viewer",
        members: 4,
        title: "旧版证据图谱",
        archived: true,
      },
    ],
  };

  it("moves project navigation into the live View while keeping collaboration controls trusted", async () => {
    setProps({ mode: "app", app: RESEARCH_APP, projection: { project: { title: "可验证材料研究" } }, instanceKey: KEY, workspace });
    stubReleaseStream("multi_version", RESEARCH_APP);
    const page = renderPage(<AppOpenPage />);
    expect(screen.queryByLabelText("科研项目导航")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("项目协作"));
    expect(screen.getByText("可信项目协作")).toBeInTheDocument();
    expect(screen.getByText(/成员、邀请、创建与 Agent 接入仍由本站复核/)).toBeInTheDocument();
    expect(screen.queryByText(KEY)).not.toBeInTheDocument();
    expect(screen.queryByText(OTHER_KEY)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Agent 接入"));
    expect(screen.getByText("Codex 第一方")).toBeInTheDocument();
    expect(screen.getByText("Codex 本地 Runner")).toBeInTheDocument();
    expect(screen.getByText("Claude Opus")).toBeInTheDocument();
    expect(screen.getByText(/当前列表不含 Fable/)).toBeInTheDocument();
    expect(screen.queryByText("本机 DSH")).not.toBeInTheDocument();
    const appModule = await screen.findByRole("region", { name: "Loaded App module" });
    const navigation = within(appModule).getByRole("navigation", { name: "App project navigation" });
    expect(within(navigation).getByText("可验证材料研究")).toBeInTheDocument();
    expect(within(navigation).getByText("旧版证据图谱")).toBeInTheDocument();
    expect(appModule.closest("[data-app-id]")).toHaveAttribute("data-app-id", RESEARCH_APP.stableAppId);
    expect(moduleLoader).toHaveBeenCalledExactlyOnceWith("/ui/apps/" + RESEARCH_APP.packageDigest + "/");
    expect(page.container.querySelector("iframe")).toBeNull();
  });

  it("declassifies only display navigation and resolves exact member refs", () => {
    const projected = researchViewProjection(
      { available: true, viewer_role: "owner" },
      workspace,
      KEY,
    ) as Record<string, unknown>;
    expect(projected.workspace_navigation).toEqual({
      current_ref: KEY,
      projects: [
        { ref: KEY, title: "可验证材料研究" },
        { ref: OTHER_KEY, title: "旧版证据图谱", archived: true },
      ],
    });
    const serialized = JSON.stringify(projected.workspace_navigation);
    expect(serialized).not.toContain("alice");
    expect(serialized).not.toContain("owner");
    expect(serialized).not.toContain("members");
    expect(researchProjectNavigationPath(RESEARCH_APP.stableAppId, workspace, KEY, {
      action: RESEARCH_PROJECT_NAVIGATE_ACTION,
      params: { project_ref: OTHER_KEY },
    })).toBe(`/apps/research-program/open?instance=${OTHER_KEY}`);
    expect(researchProjectNavigationPath(RESEARCH_APP.stableAppId, workspace, KEY, {
      action: RESEARCH_PROJECT_NAVIGATE_ACTION,
      params: { project_ref: OTHER_KEY, role: "owner" },
    })).toBeNull();
    expect(researchProjectNavigationPath(RESEARCH_APP.stableAppId, workspace, KEY, {
      action: RESEARCH_PROJECT_NAVIGATE_ACTION,
      params: { project_ref: `asi_${"z".repeat(32)}` },
    })).toBeNull();
  });

  const THIRD_KEY = `asi_${"c".repeat(32)}`;
  const FOURTH_KEY = `asi_${"d".repeat(32)}`;
  const olderWindow = {
    ok: true,
    instances: [
      // Already listed (the URL's pinned project): kept once, in its place.
      { instance_key: OTHER_KEY, title: "旧版证据图谱", created_at: "2026-08-26T10:00:00.000Z", creator: "bob", role: "viewer", members: 4, manageable: false, archived: true },
      { instance_key: THIRD_KEY, title: "更早的材料项目", created_at: "2026-08-01T10:00:00.000Z", creator: "alice", role: "owner", members: 1, manageable: true },
    ],
    next_cursor: "cursor-2",
  };
  const lastWindow = {
    ok: true,
    instances: [{ instance_key: FOURTH_KEY, title: "最早的项目", created_at: "2026-07-01T10:00:00.000Z", creator: "alice", role: "owner", members: 1, manageable: true }],
  };

  /** The App stream plus the two directory windows; anything else fails loudly. */
  function stubDirectory(): string[] {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      if (url.startsWith("/api/app-view/stream?app=research-program")) {
        const body = new ReadableStream<Uint8Array>({
          start(controller) { init?.signal?.addEventListener("abort", () => controller.close(), { once: true }); },
        });
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      const answer = url === "/api/apps/research-program/shared-instances?cursor=cursor-1" ? olderWindow
        : url === "/api/apps/research-program/shared-instances?cursor=cursor-2" ? lastWindow
        : null;
      if (!answer) throw new Error("unexpected request to " + url);
      return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
    }));
    return urls;
  }

  it("declares more projects to the View only while the trusted directory has a cursor", () => {
    const more = researchViewProjection({}, { ...workspace, nextCursor: "cursor-1" }, KEY) as { workspace_navigation: Record<string, unknown> };
    expect(more.workspace_navigation.truncated).toBe(true);
    expect(JSON.stringify(more.workspace_navigation)).not.toContain("cursor-1");
    const done = researchViewProjection({}, workspace, KEY) as { workspace_navigation: Record<string, unknown> };
    expect(done.workspace_navigation).not.toHaveProperty("truncated");
  });

  it("merges a window without repeating rows and makes its projects navigable", async () => {
    stubDirectory();
    const grown = await loadMoreResearchProjects(RESEARCH_APP.stableAppId, { ...workspace, nextCursor: "cursor-1" });
    expect(grown.projects.map((row) => row.instanceKey)).toEqual([KEY, OTHER_KEY, THIRD_KEY]);
    expect(grown.projects[2]).toMatchObject({ title: "更早的材料项目", role: "owner", members: 1, manageable: true });
    expect(grown.nextCursor).toBe("cursor-2");
    expect(researchProjectNavigationPath(RESEARCH_APP.stableAppId, grown, KEY, {
      action: RESEARCH_PROJECT_NAVIGATE_ACTION,
      params: { project_ref: THIRD_KEY },
    })).toBe(`/apps/research-program/open?instance=${THIRD_KEY}`);
    const done = await loadMoreResearchProjects(RESEARCH_APP.stableAppId, grown);
    expect(done.projects.map((row) => row.instanceKey)).toEqual([KEY, OTHER_KEY, THIRD_KEY, FOURTH_KEY]);
    expect(done).not.toHaveProperty("nextCursor");
  });

  it("appends further directory windows in the trusted rail on an explicit click until none remain", async () => {
    setProps({
      mode: "join",
      app: RESEARCH_APP,
      instanceKey: OTHER_KEY,
      workspace: { ...workspace, currentInstanceKey: OTHER_KEY, projects: workspace.projects.slice(0, 1), nextCursor: "cursor-1" },
      seats: [{ role: "member", max: 64, observer: false, taken: 0 }],
    });
    const urls = stubDirectory();
    renderPage(<AppOpenPage />);
    const rail = screen.getByRole("navigation", { name: "我的科研项目" });
    expect(within(rail).queryByText("更早的材料项目")).not.toBeInTheDocument();
    expect(urls).toHaveLength(0); // nothing is prefetched
    fireEvent.click(screen.getByRole("button", { name: "加载更多项目" }));
    await within(rail).findByText("更早的材料项目");
    expect(within(rail).getByText("旧版证据图谱")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "加载更多项目" }));
    await within(rail).findByText("最早的项目");
    expect(within(rail).getAllByRole("link")).toHaveLength(4);
    expect(screen.queryByRole("button", { name: "加载更多项目" })).not.toBeInTheDocument();
    expect(urls).toEqual([
      "/api/apps/research-program/shared-instances?cursor=cursor-1",
      "/api/apps/research-program/shared-instances?cursor=cursor-2",
    ]);
  });

  it("lets the View ask the Host for the next window and re-declares navigation over the live frame", async () => {
    setProps({
      mode: "app",
      app: RESEARCH_APP,
      projection: { project: { title: "可验证材料研究" } },
      instanceKey: KEY,
      workspace: { ...workspace, nextCursor: "cursor-1" },
    });
    const urls = stubDirectory();
    renderPage(<AppOpenPage />);
    const appModule = await screen.findByRole("region", { name: "Loaded App module" });
    const navigation = within(appModule).getByRole("navigation", { name: "App project navigation" });
    expect(within(navigation).queryByText("更早的材料项目")).not.toBeInTheDocument();
    fireEvent.click(within(navigation).getByRole("button", { name: "App load more" }));
    await within(navigation).findByText("更早的材料项目");
    expect(within(navigation).getAllByText("旧版证据图谱")).toHaveLength(1);
    // The trusted menu offers the same next window for any View version.
    fireEvent.click(screen.getByText("项目协作"));
    fireEvent.click(screen.getByRole("button", { name: "加载更多项目" }));
    await within(navigation).findByText("最早的项目");
    expect(within(navigation).queryByRole("button", { name: "App load more" })).not.toBeInTheDocument();
    expect(urls.filter((url) => url.includes("shared-instances"))).toEqual([
      "/api/apps/research-program/shared-instances?cursor=cursor-1",
      "/api/apps/research-program/shared-instances?cursor=cursor-2",
    ]);
  });

  it("keeps a URL join inside the project rail and posts only the selected role", async () => {
    const invitedWorkspace: SharedWorkspaceProps = {
      ...workspace,
      currentInstanceKey: OTHER_KEY,
      projects: workspace.projects.slice(0, 1),
    };
    setProps({
      mode: "join",
      app: RESEARCH_APP,
      instanceKey: OTHER_KEY,
      workspace: invitedWorkspace,
      seats: [
        { role: "owner", max: 1, observer: false, taken: 1 },
        { role: "member", max: 64, observer: false, taken: 1 },
      ],
    });
    const stub = stubApi({
      [`/api/apps/research-program/shared-instances/${OTHER_KEY}/join`]: { ok: true, role: "member" },
    });
    renderPage(<AppOpenPage />);
    expect(screen.getByText("受邀科研项目")).toBeInTheDocument();
    expect(screen.queryByText(OTHER_KEY)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "以 成员 加入" }));
    await waitFor(() => expect(stub.calls).toHaveLength(1));
    expect(stub.calls[0].url).toBe(`/api/apps/research-program/shared-instances/${OTHER_KEY}/join`);
    expect(JSON.parse(String(stub.calls[0].init?.body))).toEqual({ role: "member" });
  });

  it("shows an empty workbench and creates the declared Owner seat directly", async () => {
    setProps({
      mode: "instances",
      app: RESEARCH_APP,
      roles,
      instances: [],
      workspace: { roles, projects: [] },
    });
    const stub = stubApi({
      "/api/apps/research-program/shared-instances": { ok: true, instance_key: KEY, role: "owner" },
    });
    renderPage(<AppOpenPage />);
    expect(screen.getByRole("heading", { name: "自动科研工作台" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "＋ 新建科研项目" }));
    await waitFor(() => expect(stub.calls).toHaveLength(1));
    expect(JSON.parse(String(stub.calls[0].init?.body))).toEqual({ role: "owner" });
  });
});

describe("trusted-shell release availability", () => {
  it("shows server permission counts and a visible permission-centre link for resource Apps", async () => {
    const app = { ...APP, stableAppId: "research-v2", title: "自动科研 v2", resourcePermissions: { requestedCount: 13, grantedCount: 2, effectiveCount: 1 } };
    setProps({ mode: "app", app, projection: { notes: [] } });
    stubReleaseStream("multi_version", app);
    renderPage(<AppOpenPage />);
    await screen.findByRole("textbox", { name: "App draft" });
    const trustbar = screen.getByLabelText("应用可信控制栏");
    const permissionLink = within(trustbar).getAllByRole("link", { name: "权限中心" }).find(link => !link.closest("details"));
    expect(permissionLink).toHaveAttribute("href", "/permissions?view=grants");
    fireEvent.click(screen.getByText("应用信息"));
    expect(screen.getByText("申请 13 项资源权限，已授权 2 项，当前有效 1 项。")).toBeInTheDocument();
    expect(screen.queryByText("该 App 当前未申请额外的用户资源权限。")).not.toBeInTheDocument();
  });

  it("offers trust revocation only where there was a consent to revoke (O12)", async () => {
    setProps({ mode: "app", app: APP, projection: { notes: [] }, trustReason: "first_party" });
    stubReleaseStream("multi_version");
    const page = renderPage(<AppOpenPage />);
    await screen.findByRole("textbox", { name: "App draft" });
    fireEvent.click(screen.getByText("应用信息"));
    expect(screen.queryByRole("button", { name: "撤销发布者信任" })).not.toBeInTheDocument();
    page.unmount();

    setProps({ mode: "app", app: APP, projection: { notes: [] }, trustReason: "exact_release" });
    stubReleaseStream("multi_version");
    renderPage(<AppOpenPage />);
    await screen.findByRole("textbox", { name: "App draft" });
    fireEvent.click(screen.getByText("应用信息"));
    expect(screen.getByRole("button", { name: "撤销发布者信任" })).toBeInTheDocument();
  });

  it("keeps resource consent separate from publisher trust without granting on page load", () => {
    setProps({ mode: "consent", app: { ...APP, resourcePermissions: { requestedCount: 13, grantedCount: 0, effectiveCount: 0 } }, reason: "never_decided" });
    const requests = stubApi({});
    renderPage(<AppOpenPage />);
    expect(screen.getByText(/信任发布者只允许加载应用代码；资源权限需要另行授权。/)).toBeInTheDocument();
    expect(screen.getByText("申请 13 项资源权限，已授权 0 项，当前有效 0 项。")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "权限中心" })).toHaveAttribute("target", "_blank");
    expect(requests.calls).toHaveLength(0);
  });

  it("does not invent resource permission controls for an empty-contract App", () => {
    setProps({ mode: "consent", app: { ...APP, resourcePermissions: { requestedCount: 0, grantedCount: 0, effectiveCount: 0 } }, reason: "never_decided" });
    renderPage(<AppOpenPage />);
    expect(screen.getByText("该 App 当前未申请额外的用户资源权限。")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "权限中心" })).not.toBeInTheDocument();
  });

  it.each([
    ["multi_version", "可在安全位置显式刷新整个页面"],
    ["refresh_required", "继续提交前必须显式刷新整个页面"],
  ] as const)("keeps %s in trusted chrome without remounting the App or losing its draft", async (mode, ariaText) => {
    setProps({ mode: "app", app: APP, projection: { notes: [] } });
    const stream = stubReleaseStream(mode);
    const page = renderPage(<AppOpenPage />);
    const draft = await screen.findByRole("textbox", { name: "App draft" });
    fireEvent.change(draft, { target: { value: "unfinished before the release notice" } });
    expect(draft).toHaveValue("unfinished before the release notice");
    const surface = draft.closest("[data-app-id]");
    expect(surface).toHaveAttribute("data-app-id", APP.stableAppId);
    await act(async () => stream.publish());

    const trustbar = await waitFor(() => {
      const value = screen.getByLabelText("应用可信控制栏");
      expect(value).toHaveAttribute("data-version-available", mode);
      return value;
    });
    expect(screen.getByLabelText("应用版本状态")).toHaveTextContent(ariaText);
    // Shown to sighted readers too, not only announced.
    const notice = screen.getByTestId("app-version-notice");
    expect(notice).toHaveTextContent(ariaText);
    expect(notice).not.toHaveClass("srOnly");
    expect(notice).toHaveAttribute("data-mode", mode);
    expect(screen.queryByText(/第\s*\d+\s*代/u)).not.toBeInTheDocument();
    expect(document.body).toHaveAttribute("data-app-generation", "1");
    expect(screen.getByRole("textbox", { name: "App draft" })).toBe(draft);
    expect(draft).toHaveValue("unfinished before the release notice");
    expect(draft.closest("[data-app-id]")).toBe(surface);
    expect(moduleLoader).toHaveBeenCalledExactlyOnceWith("/ui/apps/" + APP.packageDigest + "/");
    expect(page.container.querySelector("iframe")).toBeNull();
    expect(trustbar).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /刷新/ })).not.toBeInTheDocument();
  });

  it("names a crashed App plainly and points at the rebuild control", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    moduleLoader.mockReset().mockResolvedValue({ App: () => { throw new Error("module render failed"); }, styles: [] });
    setProps({ mode: "app", app: APP, projection: { notes: [] } });
    stubReleaseStream("multi_version");
    renderPage(<AppOpenPage />);
    // Both the trusted status pill and the empty workspace say it.
    expect((await screen.findAllByText("已崩溃，可点 ♻ 重建")).length).toBeGreaterThan(0);
    expect(screen.queryByText(/演示/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重建 Agent View" })).toBeInTheDocument();
  });

  it("exposes only the explicit whole-page reload action for the future ticket UI", () => {
    expect(reloadToAvailableVersion).toEqual(expect.any(Function));
    expect(reloadToAvailableVersion).toHaveLength(0);
  });
});

describe("projection stream deltas", () => {
  function ProjectionApp() {
    return <output aria-label="App projection">{JSON.stringify(useAgentViewSnapshot().projection)}</output>;
  }

  it("asks for patches and hands the App the rebuilt projection", async () => {
    moduleLoader.mockResolvedValue({ App: ProjectionApp, styles: [] });
    setProps({ mode: "app", app: APP, projection: { notes: [] } });
    let headers: Headers | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith("/api/app-view/stream?app=" + APP.stableAppId)) throw new Error("unexpected request to " + url);
      headers = new Headers(init?.headers);
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode([
            "event: view",
            'data: {"type":"view","revision":3,"projection":{"notes":[{"id":"n1","text":"first"}]}}',
            "",
            "event: view-patch",
            'data: {"revision":4,"base":3,"patch":[["~",["notes"],1,1,[{"id":"n2","text":"second"}]]]}',
            "",
            "",
          ].join("\n")));
          init?.signal?.addEventListener("abort", () => controller.close(), { once: true });
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
    }));

    renderPage(<AppOpenPage />);

    await waitFor(() => expect(screen.getByLabelText("App projection")).toHaveTextContent(
      JSON.stringify({ notes: [{ id: "n1", text: "first" }, { id: "n2", text: "second" }] }),
    ));
    expect(headers?.get("x-projection-delta")).toBe("1");
  });
});

/**
 * Handing one instance to an allow-listed external host, from the trusted page.
 *
 * The server decides everything that matters (`bot/src/dashboard/
 * app-external-route.test.ts`); what this file pins is that the page asks for
 * exactly what a person clicked — including that the two authorities are two
 * different requests, so "give it to my DSH" can never quietly grant an agent
 * the right to move pieces.
 */
describe("the external-host section", () => {
  const roles = [
    { role: "white", max: 1, observer: false },
    { role: "black", max: 1, observer: false },
  ];
  const instances = [
    { instanceKey: KEY, createdAt: "2026-08-17T10:00:00.000Z", creator: "alice", role: "white", members: 2 },
  ];
  const hosts = [{ id: "dsh-local", label: "本机 DSH", origin: "http://127.0.0.1:9931" }];
  const LAUNCH = "http://127.0.0.1:9931/octopus/app-launch#octopus_app_launch=xlg_" + "a".repeat(43);

  function setup(bindings: unknown[] = []) {
    setProps({ mode: "instances", app: APP, roles, instances, externalHosts: hosts });
    return stubApi({
      "/api/app-external/bindings": { ok: true, hosts, bindings },
      "/api/app-external/launch": { ok: true, launch_url: LAUNCH, authority: "human", expires_at: "2026-08-17T10:02:00.000Z" },
      "/api/app-external/revoke": { ok: true },
    });
  }

  it("is absent entirely when the deployment allows no external host", () => {
    setProps({ mode: "instances", app: APP, roles, instances });
    stubApi({});
    renderPage(<AppOpenPage />);
    expect(screen.queryByRole("button", { name: /我本人操作/ })).not.toBeInTheDocument();
  });

  it("mints a human binding, and shows the one-shot link exactly once", async () => {
    const stub = setup();
    renderPage(<AppOpenPage />);
    fireEvent.click(screen.getByRole("button", { name: "生成「我本人操作」绑定" }));
    await waitFor(() => expect(stub.calls.some((call) => call.url.startsWith("/api/app-external/launch"))).toBe(true));
    const launch = stub.calls.find((call) => call.url.startsWith("/api/app-external/launch"))!;
    expect(launch.init?.method).toBe("POST");
    expect(JSON.parse(String(launch.init?.body))).toEqual({
      instance_key: KEY,
      host: "dsh-local",
      authority: "human",
    });
    // The secret is in the fragment of a value the person can copy, and the
    // page does not put it anywhere else.
    await waitFor(() => expect(screen.getByLabelText("启动链接")).toHaveValue(LAUNCH));
    expect(screen.getByRole("link", { name: "在外部宿主中打开" })).toHaveAttribute("href", LAUNCH);
  });

  it("asks for agent authority as a SEPARATE request a person clicked", async () => {
    const stub = setup();
    renderPage(<AppOpenPage />);
    fireEvent.click(screen.getByRole("button", { name: "另外授予「Agent 提议」绑定" }));
    await waitFor(() => expect(stub.calls.some((call) => call.url.startsWith("/api/app-external/launch"))).toBe(true));
    const launch = stub.calls.find((call) => call.url.startsWith("/api/app-external/launch"))!;
    expect(JSON.parse(String(launch.init?.body)).authority).toBe("agent");
  });

  it("lists live bindings and revokes one by its public credential id", async () => {
    const stub = setup([
      {
        credential_id: "xai_live",
        instance: KEY,
        authority: "agent",
        host: "dsh-local",
        host_origin: "http://127.0.0.1:9931",
        status: "active",
        last_used_at: null,
      },
      {
        credential_id: "xai_dead",
        instance: KEY,
        authority: "human",
        host: "dsh-local",
        host_origin: "http://127.0.0.1:9931",
        status: "revoked",
        last_used_at: "2026-08-17T10:01:00.000Z",
      },
    ]);
    renderPage(<AppOpenPage />);
    await waitFor(() => expect(screen.getAllByText(/127\.0\.0\.1:9931/).length).toBeGreaterThan(0));
    // A revoked binding is history, not a button.
    expect(screen.getAllByRole("button", { name: "撤销" })).toHaveLength(1);
    expect(screen.getByText("已失效")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    await waitFor(() => expect(stub.calls.some((call) => call.url.startsWith("/api/app-external/revoke"))).toBe(true));
    const revoke = stub.calls.find((call) => call.url.startsWith("/api/app-external/revoke"))!;
    expect(JSON.parse(String(revoke.init?.body))).toEqual({ credential_id: "xai_live" });
  });
});
