/**
 * The whole App in jsdom: real composition, real modules, fixture channel.
 * Pins the interactions the first release shipped broken — see daily-brief's
 * app.test for the inventory; this space adds the shared-authorship angles.
 */

import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AgentViewProvider } from "@claude-bot/agent-view-react";
import { createFixtureAgentViewClient } from "@claude-bot/agent-view-preview";
import { StandardApp } from "@claude-bot/agent-view-react/shell";
import { APP_DATA_CONTRACT, appDataAdapter } from "@claude-bot/agent-data-view";
import { project } from "../app/projection.js";
import { REPORT_SPACE_COMPOSITION } from "./plan.js";
import { REPORT_SPACE_MODULES } from "./modules.js";

const EVENTS = [
  { type: "report_submitted", at: "2026-08-12T08:00:00Z", by: "user:alice", data: {
    actor_user: "alice", id: "report-1", subject: "上周汇报", body: "旧正文", evidence: "- 旧摘录",
  } },
  { type: "report_commented", at: "2026-08-12T09:00:00Z", by: "user:bob", data: { actor_user: "bob", report_id: "report-1", body: "收到" } },
  { type: "report_submitted", at: "2026-08-13T08:00:00Z", by: "user:carol", data: {
    actor_user: "carol", id: "report-2", subject: "本周汇报", body: "新正文", evidence: "- 新摘录",
  } },
];

function mount(events: unknown[] = EVENTS) {
  const fixture = createFixtureAgentViewClient({
    projection: project(events),
    actions: {
      mark_seen: () => ({ ok: true, message: "已标记" }),
      comment_report: () => ({ ok: true, message: "已发表" }),
      submit_report: () => ({ ok: true, message: "已提交" }),
    },
  });
  const view = render(
    <AgentViewProvider client={fixture.client}>
      <StandardApp
        composition={REPORT_SPACE_COMPOSITION}
        modules={REPORT_SPACE_MODULES}
        providers={{ [APP_DATA_CONTRACT]: appDataAdapter }}
      />
    </AgentViewProvider>,
  );
  return { ...view, fixture };
}

const panel = (instance: string): HTMLElement =>
  document.querySelector(`[data-av-panel="${instance}"]`) as HTMLElement;

describe("report space, assembled", () => {
  it("mounts every declared surface and warns about unseen reports", () => {
    mount();
    for (const instance of REPORT_SPACE_COMPOSITION.instances) {
      expect(panel(instance.instance), instance.instance).not.toBeNull();
    }
    expect(panel("reports")).toHaveTextContent("还没有人标记已阅");
  });

  it("shows the newest report with ITS evidence before anything is clicked", () => {
    mount();
    const report = panel("report");
    expect(report).toHaveTextContent("本周汇报");
    expect(report).toHaveTextContent("新摘录");
    expect(report).not.toHaveTextContent("旧摘录");
  });

  it("routes a list click to the record panel, thread and evidence following the record", async () => {
    mount();
    fireEvent.click(within(panel("reports")).getByText("上周汇报"));
    await waitFor(() => expect(panel("report")).toHaveTextContent("旧正文"));
    const report = panel("report");
    expect(report).toHaveTextContent("旧摘录");
    expect(report).toHaveTextContent("收到");
    expect(report).not.toHaveTextContent("新摘录");
  });

  it("discusses the open report without retyping its id", async () => {
    const { fixture } = mount();
    fireEvent.click(within(panel("report")).getByRole("button", { name: "参与讨论" }));
    const dialog = await screen.findByRole("dialog", { name: "参与讨论" });
    expect(within(dialog).queryByLabelText(/报告 ID/)).not.toBeInTheDocument();
    expect(within(dialog).getByText("report-2")).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText(/讨论内容/), { target: { value: "同意" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "发表" }));
    await waitFor(() =>
      expect(fixture.proposals).toEqual([{ action: "comment_report", params: { report_id: "report-2", body: "同意" } }]),
    );
  });

  it("explains an empty space instead of pointing at an empty list", () => {
    mount([]);
    expect(panel("room")).toHaveTextContent("还没有汇报");
    expect(panel("report")).toHaveTextContent("发起汇报");
  });
});
