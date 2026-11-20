/**
 * The whole App in jsdom: real composition, real modules, fixture channel.
 *
 * These are the interactions the first release shipped broken and no test
 * caught, because every test was a pure function's: the second list click used
 * to hijack the evidence pane, per-record actions asked the reader to retype
 * ids, and a fresh workspace booted into "从左侧选择一份总结". Each is pinned
 * here end to end — composition → link → panel → module → proposal.
 */

import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AgentViewProvider } from "@claude-bot/agent-view-react";
import { createFixtureAgentViewClient } from "@claude-bot/agent-view-preview";
import { StandardApp } from "@claude-bot/agent-view-react/shell";
import { APP_DATA_CONTRACT, appDataAdapter } from "@claude-bot/agent-data-view";
import { project } from "../app/projection.js";
import { DAILY_BRIEF_COMPOSITION } from "./plan.js";
import { DAILY_BRIEF_MODULES } from "./modules.js";

const EVENTS = [
  { type: "summary_requested", at: "2026-08-12T21:00:00Z", by: "user:alice", data: { id: "request-1", period: "昨天", focus: "会议" } },
  { type: "summary_published", at: "2026-08-12T22:00:00Z", by: "agent:daily-brief/mcp@alice", data: {
    id: "summary-1", period: "昨天", headline: "昨天的总结", body: "旧正文", evidence: "- 旧摘录", request_id: "request-1",
  } },
  { type: "summary_published", at: "2026-08-13T08:00:00Z", by: "agent:daily-brief/mcp@alice", data: {
    id: "summary-2", period: "今天", headline: "今天的总结", body: "新正文", evidence: "- 新摘录", coverage: "只读了日历",
  } },
];

function mount(events: unknown[] = EVENTS) {
  const fixture = createFixtureAgentViewClient({
    projection: project(events),
    actions: {
      acknowledge_summary: () => ({ ok: true, message: "已确认" }),
      correct_summary: () => ({ ok: true, message: "已修正" }),
      request_summary: () => ({ ok: true, message: "已记录" }),
    },
  });
  const view = render(
    <AgentViewProvider client={fixture.client}>
      <StandardApp
        composition={DAILY_BRIEF_COMPOSITION}
        modules={DAILY_BRIEF_MODULES}
        providers={{ [APP_DATA_CONTRACT]: appDataAdapter }}
      />
    </AgentViewProvider>,
  );
  return { ...view, fixture };
}

const panel = (instance: string): HTMLElement =>
  document.querySelector(`[data-av-panel="${instance}"]`) as HTMLElement;

describe("daily brief, assembled", () => {
  it("mounts every declared surface", () => {
    mount();
    for (const instance of DAILY_BRIEF_COMPOSITION.instances) {
      expect(panel(instance.instance), instance.instance).not.toBeNull();
    }
  });

  it("shows the newest summary — with ITS evidence — before anything is clicked", () => {
    mount();
    const summary = panel("summary");
    expect(summary).toHaveTextContent("今天的总结");
    expect(summary).toHaveTextContent("新摘录");
    expect(summary).toHaveTextContent("证据快照");
    expect(summary).not.toHaveTextContent("旧摘录");
  });

  it("routes a history click to the same record panel, evidence following the record", async () => {
    mount();
    fireEvent.click(within(panel("history")).getByText("昨天的总结"));
    await waitFor(() => expect(panel("summary")).toHaveTextContent("旧正文"));
    const summary = panel("summary");
    expect(summary).toHaveTextContent("旧摘录");
    expect(summary).not.toHaveTextContent("新摘录");
    // The completed request is part of the record's own thread.
    expect(summary).toHaveTextContent("请求总结：会议");
  });

  it("acknowledges the open summary without anyone retyping its id", async () => {
    const { fixture } = mount();
    fireEvent.click(within(panel("summary")).getByRole("button", { name: "确认已读" }));
    const dialog = await screen.findByRole("dialog", { name: "确认已读" });
    expect(within(dialog).queryByLabelText(/总结 ID/)).not.toBeInTheDocument();
    expect(within(dialog).getByText("summary-2")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "确认" }));
    await waitFor(() =>
      expect(fixture.proposals).toEqual([{ action: "acknowledge_summary", params: { summary_id: "summary-2" } }]),
    );
  });

  it("explains an empty workspace instead of pointing at an empty list", () => {
    mount([]);
    expect(panel("status")).toHaveTextContent("还没有任何总结");
    expect(panel("summary")).toHaveTextContent("还没有总结");
  });
});
