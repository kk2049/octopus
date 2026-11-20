/**
 * The zero-code App, assembled exactly the way `app:preview` assembles it.
 *
 * ── Why this test rather than a browser one ────────────────────────────────
 *
 * `app:preview` is a Vite dev server, a resolver alias and an entry file. Only
 * the first of those is worth a browser to check, and it is checked by looking
 * at it. What is worth checking automatically is the claim underneath: that a
 * composition, a module list and ONE line of wiring produce a working workspace
 * — with no component and no App package anywhere in the input.
 *
 * So this renders the shipped example plan through the same three pieces the
 * preview entry uses (`createFixtureAgentViewClient` → `AgentViewProvider` →
 * `StandardApp`) in jsdom, which is fast enough to run on every change. The
 * example file is therefore load-bearing rather than documentation: if it stops
 * assembling, this fails.
 *
 * (Verified once against real Chromium through the dev server as well — same
 * five panels, same routing, same generated form. That run is recorded in the
 * worklog rather than automated, because standing up a dev server per test run
 * costs more than it can catch.)
 */

import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentViewProvider } from "@claude-bot/agent-view-react";
import { createFixtureAgentViewClient } from "@claude-bot/agent-view-preview";
import { StandardApp } from "@claude-bot/agent-view-react/shell";
import plan from "../examples/inbox.preview.js";

function preview() {
  const fixture = createFixtureAgentViewClient({
    projection: plan.projection ?? null,
    operations: plan.operations,
    actions: plan.actions,
  });
  const view = render(
    <AgentViewProvider client={fixture.client}>
      <StandardApp
        composition={plan.composition}
        modules={plan.modules}
        {...(plan.providers ? { providers: plan.providers } : {})}
      />
    </AgentViewProvider>,
  );
  return { ...view, fixture };
}

describe("the example App is data plus one line of wiring", () => {
  it("mounts every declared surface", () => {
    preview();
    for (const instance of plan.composition.instances) {
      expect(
        document.querySelector(`[data-av-panel="${instance.instance}"]`),
        `${instance.instance} did not mount`,
      ).not.toBeNull();
    }
  });

  it("turns one list module into two differently-purposed panels", () => {
    preview();
    const inbox = document.querySelector('[data-av-panel="inbox"]')!;
    const archive = document.querySelector('[data-av-panel="archive"]')!;
    expect(inbox.getAttribute("data-av-module")).toBe(archive.getAttribute("data-av-module"));
    expect(inbox).toHaveTextContent("收件箱");
    expect(inbox).toHaveTextContent("周报草稿");
    expect(archive).toHaveTextContent("归档箱");
    expect(archive).toHaveTextContent("上上周周报");
    expect(archive).not.toHaveTextContent("周报草稿");
  });

  it("routes a selection to the detail panel through the composition's open rule", async () => {
    const user = userEvent.setup();
    preview();
    expect(document.querySelector('[data-av-panel="note"]')).toHaveTextContent("从左边选一条看看");
    await user.click(screen.getByText("周报草稿"));
    await waitFor(() => {
      const note = document.querySelector('[data-av-panel="note"]')!;
      // The labels come from `detailFields`, the body from `body_key`.
      expect(note).toHaveTextContent("作者");
      expect(note).toHaveTextContent("平台收敛计划 P4");
    });
  });

  it("renders the bottom strip as a facts table, with no id_key and no ref", () => {
    preview();
    const stats = document.querySelector('[data-av-panel="stats"]')!;
    expect(stats).toHaveTextContent("统计");
    expect(stats).toHaveTextContent("未读");
  });

  it("generates the compose form from the action's parameter declaration and proposes it", async () => {
    const user = userEvent.setup();
    const { fixture } = preview();
    await user.type(screen.getByLabelText(/^title/), "买牛奶");
    await user.click(screen.getByText("记下来"));
    await waitFor(() => expect(fixture.proposals).toHaveLength(1));
    expect(fixture.proposals[0]).toEqual({ action: "add_note", params: { title: "买牛奶" } });
    expect(await screen.findByText(/买牛奶/)).toBeInTheDocument();
  });
});
