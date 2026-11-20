import { describe, expect, it } from "vitest";
import { acknowledge_summary, correct_summary, publish_summary, request_summary } from "./actions.js";

describe("daily brief actions", () => {
  it("records a request without starting inference, minting from historical counts", () => {
    expect(request_summary({ now: "t", state: { requests: [], counts: { requests: 4, briefs: 0 } } }, { period: "today" }))
      .toMatchObject({ events: [{ type: "summary_requested", data: { id: "request-5", period: "today" } }] });
  });

  it("publishes a bounded semantic result and may name the request it answers", () => {
    const ctx = { now: "t", state: { briefs: [], requests: [{ id: "request-1", status: "pending" }], counts: { requests: 1, briefs: 0 } } };
    const out = publish_summary(ctx, { period: "today", headline: "H", body: "B", request_id: "request-1" });
    expect(out).toMatchObject({ result: { summary_id: "summary-1" } });
    expect(out.events[0]!.data).toMatchObject({ request_id: "request-1" });
  });

  it("refuses an unknown request_id and lists what is pending", () => {
    const ctx = { now: "t", state: { briefs: [], requests: [{ id: "request-1", status: "pending" }], counts: {} } };
    expect(() => publish_summary(ctx, { period: "p", headline: "H", body: "B", request_id: "request-9" }))
      .toThrow(/request-1/);
  });

  it("corrects only an existing summary and names what exists otherwise", () => {
    const state = { briefs: [{ id: "summary-1", acknowledged: false }], counts: {} };
    expect(correct_summary({ now: "t", state }, { summary_id: "summary-1", body: "b", reason: "r" }))
      .toMatchObject({ events: [{ type: "summary_corrected", data: { summary_id: "summary-1", reason: "r" } }] });
    expect(() => correct_summary({ now: "t", state }, { summary_id: "summary-9", body: "b", reason: "r" }))
      .toThrow(/summary-1/);
  });

  it("acknowledges once and refuses the second press with a sentence", () => {
    expect(acknowledge_summary({ now: "t", state: { briefs: [{ id: "summary-1", acknowledged: false }] } }, { summary_id: "summary-1" }))
      .toMatchObject({ result: { summary_id: "summary-1" } });
    expect(() => acknowledge_summary({ now: "t", state: { briefs: [{ id: "summary-1", acknowledged: true }] } }, { summary_id: "summary-1" }))
      .toThrow(/已经确认过/);
  });
});
