import { describe, expect, it } from "vitest";
import { project, projectIncremental } from "./projection.js";

const SUBMIT = { type: "report_submitted", at: "2026-08-13T08:00:00Z", by: "user:alice", data: { actor_user: "alice", id: "report-1", subject: "本周汇报", body: "正文", evidence: "- 摘录" } };

describe("report space projection", () => {
  it("gives each report its own evidence section and full thread", () => {
    const out = project([
      SUBMIT,
      { type: "report_seen", at: "1", by: "user:bob", data: { actor_user: "bob", report_id: "report-1" } },
      { type: "report_commented", at: "2", by: "user:bob", data: { actor_user: "bob", report_id: "report-1", body: "同意" } },
    ]);
    const report = out.reports[0]!;
    expect(report).toMatchObject({ id: "report-1", evidence: "- 摘录", author: "alice", seen_by: ["bob"], comments: 1 });
    expect(report.thread.map((row) => row.badge)).toEqual(["提交", "已阅", "讨论"]);
    expect(report.thread[2]).toMatchObject({ by: "bob", text: "同意" });
    expect(out.latest_id).toBe("report-1");
  });

  it("ranks status by priority: a late mark_seen cannot downgrade a decision", () => {
    const out = project([
      SUBMIT,
      { type: "report_decided", at: "1", by: "user:bob", data: { actor_user: "bob", report_id: "report-1", decision: "推进" } },
      { type: "report_seen", at: "2", by: "user:carol", data: { actor_user: "carol", report_id: "report-1" } },
    ]);
    expect(out.reports[0]).toMatchObject({ badge: "有结论", tone: "ok", decision: "推进" });
  });

  it("lets a retraction outrank everything and carry its reason", () => {
    const out = project([
      SUBMIT,
      { type: "report_decided", at: "1", by: "user:bob", data: { actor_user: "bob", report_id: "report-1", decision: "推进" } },
      { type: "report_retracted", at: "2", by: "user:alice", data: { actor_user: "alice", report_id: "report-1", reason: "数据有误" } },
    ]);
    const report = out.reports[0]!;
    expect(report).toMatchObject({ badge: "已撤回", tone: "error", status: "retracted" });
    expect(report.body).toContain("数据有误");
    expect(report.thread.at(-1)).toMatchObject({ badge: "撤回", text: "数据有误" });
  });

  it("names the report in every feed entry and counts what is unseen", () => {
    const out = project([
      SUBMIT,
      { ...SUBMIT, at: "2026-08-13T09:00:00Z", data: { ...SUBMIT.data, id: "report-2", subject: "第二份" } },
      { type: "report_commented", at: "1", by: "user:bob", data: { actor_user: "bob", report_id: "report-1", body: "x" } },
    ]);
    expect(out.feed[0]!.title).toContain("「本周汇报」");
    expect(out.reports_notice).toMatchObject({ text: expect.stringContaining("2 份") });
    expect(out.room_panel).toMatchObject({ 汇报: 2, 进行中: 2, 讨论: 1 });
    expect(out.counts).toEqual({ reports: 2 });
  });

  it("shows an agent submission as such while authorship stays the human's", () => {
    const out = project([
      { ...SUBMIT, by: "agent:report-space/mcp@alice" },
    ]);
    expect(out.reports[0]).toMatchObject({ author: "alice", submitted_via: "代理提交" });
  });
});
describe("incremental report projection", () => {
  it("matches a complete fold across a snapshot boundary", () => {
    const events = [
      SUBMIT,
      { type: "report_commented", at: "2", by: "user:bob", data: { actor_user: "bob", report_id: "report-1", body: "同意" } },
    ];
    expect(projectIncremental(project(events.slice(0, 1)), events.slice(1))).toEqual(project(events));
  });
});
