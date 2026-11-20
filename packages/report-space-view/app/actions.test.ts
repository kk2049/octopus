import { describe, expect, it } from "vitest";
import { close_report, mark_seen, retract_report, submit_report } from "./actions.js";

describe("report space actions", () => {
  it("submits with trusted authorship in domain data and mints from historical counts", () => {
    const out = submit_report(
      { now: "t", actor: { user: "alice" }, state: { reports: [], counts: { reports: 3 } } },
      { subject: "S", body: "B" },
    );
    expect(out).toMatchObject({ result: { report_id: "report-4" } });
    expect(out.events[0]!.data).toMatchObject({ actor_user: "alice" });
  });

  it("refuses acting on a closed or absent report, naming what exists", () => {
    const state = { reports: [{ id: "report-1", status: "closed", author: "alice", seen_by: [] }], counts: { reports: 1 } };
    expect(() => close_report({ now: "t", actor: { user: "bob" }, state }, { report_id: "report-1" })).toThrow(/已经关闭/);
    expect(() => close_report({ now: "t", actor: { user: "bob" }, state }, { report_id: "report-9" })).toThrow(/report-1/);
  });

  it("keeps 已阅 idempotent per member with a sentence instead of a duplicate event", () => {
    const state = { reports: [{ id: "report-1", status: "open", author: "alice", seen_by: ["bob"] }] };
    expect(mark_seen({ now: "t", actor: { user: "carol" }, state }, { report_id: "report-1" }))
      .toMatchObject({ result: { report_id: "report-1" } });
    expect(() => mark_seen({ now: "t", actor: { user: "bob" }, state }, { report_id: "report-1" }))
      .toThrow(/已经标记过/);
  });

  it("lets only the original reporter retract", () => {
    const state = { reports: [{ id: "report-1", status: "open", author: "alice", seen_by: [] }] };
    expect(retract_report({ now: "t", actor: { user: "alice" }, state }, { report_id: "report-1", reason: "r" }))
      .toMatchObject({ events: [{ type: "report_retracted" }] });
    expect(() => retract_report({ now: "t", actor: { user: "bob" }, state }, { report_id: "report-1", reason: "r" }))
      .toThrow(/提交者本人/);
  });
});
