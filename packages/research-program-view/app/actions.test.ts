import { describe, expect, it } from "vitest";
import {
  archive_project,
  configure_project,
  publish_agent_update,
  publish_chat_message,
  publish_document,
  reopen_project,
  set_lead_agent,
  set_lead_document,
} from "./actions.js";

function context(overrides: Record<string, unknown> = {}) {
  return {
    now: "2026-08-27T14:00:00.000Z",
    actor: { user: "lht", kind: "user", role: "owner" },
    state: { project: { archived: false }, agents: [], sessions: [], documents: [] },
    ...overrides,
  };
}

const agentParams = {
  agent_key: "lead-agent",
  agent_label: "Lead Agent",
  provider: "codex",
  workspace_key: "ws-main",
  workspace_label: "Research workspace",
  session_key: "session-42",
  session_title: "Latest autonomous run",
  status: "active",
};

describe("research program actions", () => {
  it("lets an authorized owner maintain project identity through human or MCP actions", () => {
    expect(configure_project(context(), {
      title: "Autonomous Science",
      funding_label: "Grant 421",
      summary: "A bounded project summary.",
    }).events[0]).toMatchObject({
      type: "project_configured",
      data: { title: "Autonomous Science", funding_label: "Grant 421" },
    });
    expect(configure_project(context({ actor: { user: "lht", kind: "agent", role: "owner" } }), {
      title: "gpu-gc",
    }).events[0].data.title).toBe("gpu-gc");
    expect(() => configure_project(context({ actor: { user: "member", kind: "user", role: "member" } }), {
      title: "Member rename",
    })).toThrow("role is not allowed");
    expect(configure_project(context({
      state: { project: { archived: true }, sessions: [], documents: [] },
    }), { title: "Archived rename" }).events[0].data.title).toBe("Archived rename");
  });

  it("publishes a closed agent/workspace/session tuple without proposed attribution", () => {
    const out = publish_agent_update(context({ actor: { user: "lht", kind: "agent", role: "member" } }), agentParams);
    expect(out.result).toEqual({ agent_key: "lead-agent", session_key: "session-42" });
    expect(out.events[0]).toMatchObject({ type: "agent_session_published", data: agentParams });
    expect(out.events[0].data).not.toHaveProperty("owner");
    expect(out.events[0].data).not.toHaveProperty("by");
    expect(publish_agent_update(context(), { ...agentParams, provider: "codex-runner" }).events[0].data.provider)
      .toBe("codex-runner");
    expect(() => publish_agent_update(context(), { ...agentParams, provider: "omp" })).toThrow("provider is invalid");
    expect(() => publish_agent_update(context(), { ...agentParams, provider: "browser" })).toThrow("provider is invalid");
  });

  it("only appends messages to a registered session and keeps multiline Markdown", () => {
    const state = {
      project: { archived: false },
      sessions: [{ session_key: "session-42", agent_key: "lead-agent" }],
      documents: [],
    };
    const out = publish_chat_message(context({ state }), {
      session_key: "session-42",
      role: "assistant",
      text: "## Finding\n\nSee `reports/current.md`.",
    });
    expect(out.events[0].data.text).toContain("\n\n");
    expect(() => publish_chat_message(context({ state }), {
      session_key: "missing",
      role: "assistant",
      text: "orphan",
    })).toThrow("not registered");
  });

  it("binds leads only to candidates already folded into this project", () => {
    const state = {
      project: { archived: false },
      sessions: [{ session_key: "session-42", agent_key: "lead-agent" }],
      documents: [{ key: "status-doc" }],
    };
    expect(set_lead_agent(context({ state }), {
      agent_key: "lead-agent",
      session_key: "session-42",
      reason: "Most recent synthesis",
    }).events[0].type).toBe("lead_agent_set");
    expect(set_lead_document(context({ state }), {
      document_key: "status-doc",
      reason: "Current report",
    }).events[0].type).toBe("lead_document_set");
    expect(() => set_lead_agent(context({ state }), {
      agent_key: "other-agent",
      session_key: "session-42",
      reason: "wrong owner",
    })).toThrow("does not belong");
    expect(() => set_lead_document(context({ state }), {
      document_key: "missing",
      reason: "invented",
    })).toThrow("not published");
  });

  it("stores paths only as inert display claims", () => {
    const out = publish_document(context(), {
      document_key: "status-doc",
      path: "reports/current.md",
      title: "Current status",
      summary: "Today",
      body: "# Safe Markdown\n<script>alert(1)</script>",
      workspace_key: "ws-main",
      workspace_label: "Research workspace",
    });
    expect(out.events[0].data.path).toBe("reports/current.md");
    expect(() => publish_document(context(), {
      document_key: "status-doc",
      path: "https://attacker.invalid/report",
      title: "Current status",
      body: "body",
      workspace_key: "ws-main",
      workspace_label: "Research workspace",
    })).toThrow("plain display path");
  });

  it("freezes project mutation on archive and requires a human owner to reopen", () => {
    expect(archive_project(context(), { confirm: "确认", reason: "Grant complete" }).events[0].type)
      .toBe("project_archived");
    expect(() => archive_project(context(), { confirm: "yes", reason: "wrong token" })).toThrow("confirm is invalid");
    expect(() => publish_agent_update(context({
      state: { project: { archived: true }, sessions: [], documents: [] },
    }), agentParams)).toThrow("project is archived");
    expect(reopen_project(context({ state: { project: { archived: true }, sessions: [], documents: [] } }), {
      confirm: "确认",
      reason: "New funding round",
    }).events[0].type).toBe("project_reopened");
  });
});
