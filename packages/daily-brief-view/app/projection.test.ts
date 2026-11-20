import { describe, expect, it } from "vitest";
import { project, projectIncremental } from "./projection.js";

const REQUEST = { type: "summary_requested", at: "2026-08-13T07:00:00Z", by: "user:alice", data: { id: "request-1", period: "今天", focus: "风险" } };
const PUBLISH = { type: "summary_published", at: "2026-08-13T08:00:00Z", by: "agent:daily-brief/mcp@alice", data: { id: "summary-1", period: "今天", headline: "完成", body: "正文", evidence: "- 文件 A", coverage: "只读了日历" } };

describe("daily brief projection", () => {
  it("gives each brief its own sections, thread and friendly authorship", () => {
    const out = project([REQUEST, PUBLISH, { type: "summary_acknowledged", at: "2026-08-13T09:00:00Z", by: "user:alice", data: { summary_id: "summary-1" } }]);
    const brief = out.briefs[0]!;
    expect(brief).toMatchObject({ id: "summary-1", badge: "已确认", tone: "ok", evidence: "- 文件 A", coverage: "只读了日历", published_by: "本地 Agent" });
    expect(brief.thread.map((row) => row.badge)).toEqual(["请求", "发布", "已确认"]);
    expect(brief.thread[0]).toMatchObject({ by: "alice", text: "请求总结：风险" });
    expect(out.latest_id).toBe("summary-1");
  });

  it("completes a request by explicit request_id even when the period text differs", () => {
    const out = project([
      { ...REQUEST, data: { ...REQUEST.data, period: "本周" } },
      { ...PUBLISH, data: { ...PUBLISH.data, period: "2026-08-13", request_id: "request-1" } },
    ]);
    expect(out.requests[0]).toMatchObject({ id: "request-1", badge: "已完成", summary_id: "summary-1" });
    expect(out.requests_notice).toBeNull();
  });

  it("falls back to completing the oldest pending request with the same period", () => {
    const out = project([
      REQUEST,
      { ...REQUEST, at: "2026-08-13T07:30:00Z", data: { ...REQUEST.data, id: "request-2" } },
      PUBLISH,
    ]);
    const rows = Object.fromEntries(out.requests.map((row) => [row.id, row.badge]));
    expect(rows).toEqual({ "request-1": "已完成", "request-2": "待处理" });
    expect(out.requests_notice).toMatchObject({ text: expect.stringContaining("1 条请求") });
  });

  it("keeps a correction visible: body replaced, reason in the thread, badge downgraded until acknowledged", () => {
    const out = project([PUBLISH, { type: "summary_corrected", at: "2026-08-13T08:30:00Z", by: "user:alice", data: { summary_id: "summary-1", body: "修正后", reason: "改了时间" } }]);
    const brief = out.briefs[0]!;
    expect(brief).toMatchObject({ body: "修正后", badge: "已修正", tone: "warn", corrections: 1 });
    expect(brief.thread.find((row) => row.badge === "修正")).toMatchObject({ text: "改了时间", by: "alice" });
  });

  it("does not let an acknowledgement be undone by a later correction badge", () => {
    const out = project([
      PUBLISH,
      { type: "summary_acknowledged", at: "1", by: "user:alice", data: { summary_id: "summary-1" } },
      { type: "summary_corrected", at: "2", by: "user:alice", data: { summary_id: "summary-1", body: "b", reason: "r" } },
    ]);
    expect(out.briefs[0]).toMatchObject({ badge: "已确认", tone: "ok", corrections: 1 });
  });

  it("counts historical totals for id minting and explains an empty workspace", () => {
    const empty = project([]);
    expect(empty.counts).toEqual({ requests: 0, briefs: 0 });
    expect(empty.status_panel.body).toContain("publish_summary");
    const busy = project([REQUEST, PUBLISH]);
    expect(busy.counts).toEqual({ requests: 1, briefs: 1 });
    expect(busy.status_panel.body).toBe("");
  });
});
describe("incremental daily brief projection", () => {
  it("matches a complete fold across a snapshot boundary", () => {
    const events = [REQUEST, PUBLISH];
    expect(projectIncremental(project(events.slice(0, 1)), events.slice(1))).toEqual(project(events));
  });
});
