import { describe, expect, it } from "vitest";
import { project, projectIncremental } from "./projection.js";

const rows = [
  event("project_configured", { title: "Autonomous Science", funding_label: "Grant 421", summary: "Research summary" }, 1, "user:lht"),
  event("agent_session_published", {
    agent_key: "lead-agent", agent_label: "Lead Agent", provider: "codex",
    workspace_key: "ws-main", workspace_label: "Research workspace",
    session_key: "session-42", session_title: "Latest autonomous run", status: "active",
  }, 2, "agent:research-program/mcp@lht"),
  event("chat_message_published", {
    session_key: "session-42", role: "assistant", text: "Read `reports/current.md` for the synthesis.",
  }, 3, "agent:research-program/mcp@lht"),
  event("document_published", {
    document_key: "status-doc", path: "reports/current.md", title: "Current status",
    summary: "Today", body: "# Result\n\n<script>alert(1)</script>",
    workspace_key: "ws-main", workspace_label: "Research workspace",
  }, 4, "agent:research-program/mcp@lht"),
  event("lead_agent_set", {
    agent_key: "lead-agent", session_key: "session-42", reason: "Most current synthesis",
  }, 5, "user:lht"),
  event("lead_document_set", { document_key: "status-doc", reason: "Canonical report" }, 6, "user:lht"),
];

describe("research program projection", () => {
  it("folds project navigation, reusable transcript data and lead histories", () => {
    const view = project(rows, { viewer: { user: "lht", role: "owner" } });
    expect(view).toMatchObject({
      available: true,
      viewer_role: "owner",
      project: { title: "Autonomous Science", funding_label: "Grant 421", archived: false },
      controls: { can_configure: true, can_publish: true, can_bind: true, can_archive: true },
      lead_agent: { agent_key: "lead-agent", session_key: "session-42", by: "lht" },
      lead_document: { document_key: "status-doc", by: "lht" },
    });
    expect(view.workspaces).toEqual([expect.objectContaining({ key: "ws-main", label: "Research workspace" })]);
    expect(view.agents).toEqual([expect.objectContaining({ key: "lead-agent", session_key: "session-42" })]);
    expect(view.sessions).toEqual([expect.objectContaining({ resourceId: "session-42", messageCount: 1 })]);
    expect(view.transcripts["session-42"]).toMatchObject({
      rich: true,
      messages: [{ role: "assistant", blocks: [{ type: "text", text: "Read `reports/current.md` for the synthesis." }] }],
    });
    expect(view.documents[0].body).toContain("<script>alert(1)</script>");
    expect(view.lead_agent_history).toHaveLength(1);
    expect(view.lead_document_history).toHaveLength(1);
  });

  it("makes members mutable, viewers read-only, and archive terminal until reopened", () => {
    const member = project(rows, { viewer: { user: "researcher", role: "member" } });
    expect(member.controls).toMatchObject({ can_configure: false, can_publish: true, can_bind: true, can_archive: false });
    const viewer = project(rows, { viewer: { user: "guest", role: "viewer" } });
    expect(viewer.controls).toMatchObject({ can_publish: false, can_bind: false, can_archive: false });

    const archivedRows = [...rows, event("project_archived", { reason: "Complete" }, 7, "user:lht")];
    const archived = project(archivedRows, { viewer: { user: "lht", role: "owner" } });
    expect(archived.project.archived).toBe(true);
    expect(archived.controls).toMatchObject({ can_publish: false, can_bind: false, can_archive: false, can_reopen: true });
    const reopened = project([...archivedRows, event("project_reopened", { reason: "Renewed" }, 8, "user:lht")], {
      viewer: { user: "lht", role: "owner" },
    });
    expect(reopened.project.archived).toBe(false);
    expect(reopened.controls.can_publish).toBe(true);
  });

  it("does not declassify project state when viewer evidence is malformed", () => {
    const denied = project(rows, { viewer: { user: "", role: "owner" } });
    expect(denied.available).toBe(false);
    expect(denied.sessions).toEqual([]);
    expect(denied.documents).toEqual([]);
    expect(denied.project.title).toBe("项目访问不可用");
  });

  it("bounds every session transcript while preserving the newest messages", () => {
    const many = [rows[1], ...Array.from({ length: 245 }, (_, index) => event("chat_message_published", {
      session_key: "session-42", role: "assistant", text: `message-${index}`,
    }, index + 10, "agent:research-program/mcp@lht"))];
    const internal = project(many);
    expect(internal.transcripts["session-42"].messages).toHaveLength(240);
    expect(internal.transcripts["session-42"].messages[0].blocks[0].text).toBe("message-5");
    expect(internal.transcripts["session-42"].truncated).toBe(true);
  });
});
function event(type: string, data: Record<string, unknown>, minute: number, by: string) {
  return { type, data, at: `2026-08-27T14:${String(minute).padStart(2, "0")}:00.000Z`, by };
}

describe("incremental research program projection", () => {
  it("matches a complete viewer fold across a snapshot boundary", () => {
    const context = { viewer: { user: "lht", role: "owner" } };
    expect(projectIncremental(project(rows.slice(0, 3)), rows.slice(3), context)).toEqual(project(rows, context));
  });
});
