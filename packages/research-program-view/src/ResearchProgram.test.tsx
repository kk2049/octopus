import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentViewProvider } from "@claude-bot/agent-view-react";
import { createFixtureAgentViewClient } from "@claude-bot/agent-view-preview";
import { ResearchProgram } from "./ResearchProgram.js";

function fixtureProjection(overrides: Record<string, unknown> = {}) {
  return {
    available: true,
    viewer_role: "owner",
    project: { title: "Autonomous Science", funding_label: "Grant 421", summary: "Project summary", archived: false },
    workspace_navigation: {
      current_ref: "asi_current",
      projects: [
        { ref: "asi_current", title: "Autonomous Science" },
        { ref: "asi_archtown", title: "Arch Town", archived: false },
      ],
    },
    controls: { can_configure: true, can_publish: true, can_bind: true, can_archive: true, can_reopen: false, membership_surface: "trusted_outer" },
    workspaces: [{ key: "ws-main", label: "Research workspace", updated_at: "2026-08-27T14:00:00Z" }],
    agents: [
      { key: "lead-agent", label: "Lead Agent", provider: "codex", workspace_key: "ws-main", session_key: "session-main", status: "active" },
      { key: "review-agent", label: "Background Reviewer", provider: "claude", workspace_key: "ws-main", session_key: "session-review", status: "waiting" },
    ],
    sessions: [
      { session_key: "session-main", resourceId: "session-main", agent_key: "lead-agent", workspace_key: "ws-main", cliKind: "codex", title: "Main synthesis", preview: "See reports/next.md", status: "active", lastActivity: "2026-08-27T14:00:00Z", messageCount: 41 },
      { session_key: "session-review", resourceId: "session-review", agent_key: "review-agent", workspace_key: "ws-main", cliKind: "claude", title: "Small background review", preview: "Review pending", status: "waiting", lastActivity: "2026-08-27T13:00:00Z", messageCount: 3 },
    ],
    transcripts: {
      "session-main": { sessionId: "session-main", rich: true, offset: 0, totalMessages: 1, hasMore: false, messages: [{ role: "assistant", timestamp: "2026-08-27T14:00:00Z", blocks: [{ type: "text", text: "Open reports/next.md for the next result." }] }] },
      "session-review": { sessionId: "session-review", rich: true, offset: 0, totalMessages: 1, hasMore: false, messages: [{ role: "assistant", timestamp: "2026-08-27T13:00:00Z", blocks: [{ type: "text", text: "Review is waiting." }] }] },
    },
    documents: [
      { key: "current-doc", path: "reports/current.md", title: "Current report", summary: "Current", body: "# Current report\n\n<script data-secret=\"x\">alert(1)</script>", workspace_key: "ws-main", updated_at: "2026-08-27T13:50:00Z", updated_by: "agent:test" },
      { key: "next-doc", path: "reports/next.md", title: "Next report", summary: "Next", body: "# Next result\n\nBounded evidence.", workspace_key: "ws-main", updated_at: "2026-08-27T13:40:00Z", updated_by: "agent:test" },
    ],
    lead_agent: { agent_key: "lead-agent", agent_label: "Lead Agent", session_key: "session-main", session_title: "Main synthesis", reason: "Latest", at: "2026-08-27T14:00:00Z" },
    lead_document: { document_key: "current-doc", document_title: "Current report", document_path: "reports/current.md", reason: "Canonical", at: "2026-08-27T13:50:00Z" },
    lead_agent_history: [],
    lead_document_history: [],
    activity: [],
    ...overrides,
  };
}

function mount(
  projection = fixtureProjection(),
  actions: NonNullable<Parameters<typeof createFixtureAgentViewClient>[0]>["actions"] = {},
) {
  const fixture = createFixtureAgentViewClient({ projection, actions });
  render(<AgentViewProvider client={fixture.client}><ResearchProgram /></AgentViewProvider>);
  return fixture;
}

describe("ResearchProgram", () => {
  it("opens a bound relative Markdown document in the shared dock", async () => {
    const projection = fixtureProjection();
    projection.documents[0]!.body = "# Current report\n\n[Next evidence](next.md)";
    mount(projection);
    fireEvent.click(await screen.findByRole('link', { name: 'Next evidence' }, { timeout: 8000 }));
    // The shared Dock and streamed file viewer settle independently; allow a cold renderer.
    await screen.findByRole('heading', { name: 'Next result' }, { timeout: 8000 });
    expect(screen.getByLabelText('Markdown 预览：next.md')).toBeVisible();
  }, 30_000);

  it("owns the project picker, removes the repeated heading and exposes both navigation splitters", async () => {
    const fixture = mount(fixtureProjection(), { "research.navigate_project": { ok: true } });
    expect(screen.getByLabelText("科研项目导航")).toBeInTheDocument();
    expect(screen.getByLabelText("主导对象导航")).toBeInTheDocument();
    expect(screen.queryByText("Project summary")).not.toBeInTheDocument();
    expect(screen.getByRole("separator", { name: "拖拽调整项目导航宽度" })).toBeInTheDocument();
    expect(screen.getByRole("separator", { name: "拖拽调整主导对象导航宽度" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Arch Town/ }));
    await waitFor(() => expect(fixture.proposals).toContainEqual({
      action: "research.navigate_project",
      params: { project_ref: "asi_archtown" },
    }));
  });

  it("asks the Host for the next project window only while the directory says more exist", async () => {
    mount();
    expect(screen.queryByRole("button", { name: "加载更多项目" })).not.toBeInTheDocument();
    cleanup();
    const projection = fixtureProjection();
    const more = { ...projection, workspace_navigation: { ...projection.workspace_navigation, truncated: true } };
    const fixture = mount(more as typeof projection,
      { "research.load_more_projects": { ok: true } });
    expect(screen.queryByText(/最近的 64 个项目/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "加载更多项目" }));
    await waitFor(() => expect(fixture.proposals).toContainEqual({ action: "research.load_more_projects", params: {} }));
  });

  it("opens one Agent and one document in the shared Dock while keeping only explicit leaders in navigation", async () => {
    mount();
    expect(screen.getAllByText("Autonomous Science").length).toBeGreaterThan(0);
    expect(screen.getByText("Lead Agent")).toBeInTheDocument();
    expect(screen.queryByText("Background Reviewer")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Next report/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Current report", level: 1 })).toBeInTheDocument());
    expect(screen.getAllByText("Main synthesis").length).toBeGreaterThan(0);
    expect(document.querySelectorAll("[data-av-dock-tab]").length).toBeGreaterThanOrEqual(2);
    expect(document.querySelector("script[data-secret]")).toBeNull();
    expect(screen.getByText(/<script data-secret="x">alert\(1\)<\/script>/)).toBeInTheDocument();
  });

  it("renders historical sessions through the shared read-only chat without pretending to deliver a prompt", async () => {
    const fixture = mount();
    const composer = await screen.findByPlaceholderText("继续这个会话…");
    expect(composer).toBeDisabled();
    expect(await screen.findByText(/Open reports/)).toBeInTheDocument();
    expect(fixture.proposals.some(row => row.action === 'publish_chat_message')).toBe(false);
  });

  it("labels curated history tabs with the conversation title instead of the provider", async () => {
    mount(fixtureProjection({
      sessions: fixtureProjection().sessions.map(row => ({
        ...row,
        curated: row.session_key === "session-review",
        source_key: row.session_key,
      })),
    }));
    fireEvent.click(await screen.findByRole("button", { name: /Small background review/ }));
    await waitFor(() => expect(
      [...document.querySelectorAll('[data-av-dock-tab][data-av-dock-slot="primary"]')]
        .some(tab => tab.textContent?.includes("Small background review")),
    ).toBe(true), { timeout: 8000 });
    expect(await screen.findByText("Review is waiting.", {}, { timeout: 8000 })).toBeInTheDocument();
  }, 20_000);

  it("opens transcript document links as sibling document tabs without reading a workspace", async () => {
    mount();
    fireEvent.click(await screen.findByRole("link", { name: "reports/next.md" }, { timeout: 8000 }));
    await screen.findByRole("heading", { name: "Next result", level: 1 }, { timeout: 8000 });
    expect(document.querySelectorAll('[data-av-dock-slot="secondary"][data-av-dock-tab]').length).toBeGreaterThanOrEqual(1);
  });

  it("can open a historical Agent only after it appears in explicit lead history", async () => {
    mount(fixtureProjection({
      lead_agent_history: [{
        agent_key: "review-agent",
        agent_label: "Historical Reviewer",
        session_key: "session-review",
        session_title: "Small background review",
        reason: "User requested handoff",
        at: "2026-08-26T13:00:00Z",
      }],
    }));
    fireEvent.click(screen.getByRole("button", { name: /Historical Reviewer/ }));
    await waitFor(() => expect(screen.getAllByText("Small background review").length).toBeGreaterThan(0));
    expect(await screen.findByText("Review is waiting.", {}, { timeout: 8000 })).toBeInTheDocument();
  });

  it("never falls back to an ordinary projected session when no lead is registered", () => {
    mount(fixtureProjection({
      lead_agent: null,
      lead_agent_history: [],
    }));
    expect(screen.getByText("尚未绑定项目 Agent。")).toBeInTheDocument();
    expect(screen.queryByText("Small background review")).not.toBeInTheDocument();
  });

  it("renders a Viewer as genuinely read-only", async () => {
    mount(fixtureProjection({
      viewer_role: "viewer",
      controls: { can_configure: false, can_publish: false, can_bind: false, can_archive: false, can_reopen: false, membership_surface: "trusted_outer" },
    }));
    expect(screen.getByText("Viewer")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "项目设置" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "归档…" })).not.toBeInTheDocument();
    expect(await screen.findByPlaceholderText("继续这个会话…")).toBeDisabled();
  });
});
