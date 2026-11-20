/**
 * The whole App, mounted, against what its own backend projects.
 *
 * ── Why this test and not six unit tests ────────────────────────────────────
 *
 * Every module here already has its own suite in its own package. What has no
 * other home is the claim this package exists to make: that a composition, a
 * module list and ONE line of wiring produce a working workspace, with no App
 * component anywhere in the input. So this mounts the REAL `<App />` — not a
 * hand-built `StandardApp` beside it — through the same provider the released
 * entry uses, and drives it.
 *
 * ── Why the fixture is `project()` and not a literal ────────────────────────
 *
 * The projection comes from `app/projection.ts`, run over events shaped the way
 * the trusted coordinator commits them. A hand-written fixture would be a second
 * statement of what the backend emits, and the interesting failure is exactly
 * the one where the two disagree: a composition pointing at `byId` while the
 * backend renamed it projects an empty panel and nothing else.
 *
 * What is NOT simulated, and must never be: approval, capability, identity,
 * revocation, the port handshake, the fuses. Those are the Host's, and a harness
 * that pretended to model them would teach an author their App is authorised.
 */

import { describe, expect, it } from "vitest";
import { render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentViewProvider } from "@claude-bot/agent-view-react";
import { createFixtureAgentViewClient } from "@claude-bot/agent-view-preview";
import { project } from "../app/projection.js";
import { App } from "./App.js";
import { SHOWCASE_COMPOSITION } from "./plan.js";

/** An event exactly as the trusted coordinator commits it: it owns `at` and `by`. */
function noteAdded(id: string, title: string, state: string, body: string) {
  return {
    type: "note_added",
    data: { id, title, body, state },
    at: "2026-08-07T09:00:00.000Z",
    by: "user:lht",
  };
}

const EVENTS = [
  noteAdded("n1", "上上周周报", "已归档", "已经发出去了。"),
  noteAdded("n2", "周报草稿", "草稿", "## 本周\n\n- 平台收敛计划 P4\n\n> 还没发。"),
  noteAdded("n3", "部署确认清单", "待办", "1. land\n2. deploy\n3. confirm"),
];

function mount(events = EVENTS) {
  const fixture = createFixtureAgentViewClient({
    projection: project(events) as Record<string, unknown>,
    actions: { add_note: { ok: true, message: "已记下。" }, deck_command: { ok: true, message: "" } },
  });
  const view = render(
    <AgentViewProvider client={fixture.client}>
      <App />
    </AgentViewProvider>,
  );
  return { ...view, fixture };
}

const panel = (instance: string): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-av-panel="${instance}"]`)!;

describe("模块演示 is data plus one line of wiring", () => {
  it("mounts every declared surface in the slot the composition names", () => {
    mount();
    for (const instance of SHOWCASE_COMPOSITION.instances) {
      const node = document.querySelector(`[data-av-slot="${instance.slot}"] [data-av-panel="${instance.instance}"]`);
      expect(node, `${instance.instance} did not mount in ${instance.slot}`).not.toBeNull();
    }
  });

  it("turns ONE list module into 收件箱 and 归档箱 by instance config alone", () => {
    mount();
    const inbox = panel("inbox");
    const archive = panel("archive");
    // Same implementation. The difference is two rows of `composition.json`.
    expect(inbox.getAttribute("data-av-module")).toBe(archive.getAttribute("data-av-module"));
    expect(inbox).toHaveTextContent("收件箱");
    expect(inbox).toHaveTextContent("周报草稿");
    expect(inbox).toHaveTextContent("部署确认清单");
    expect(inbox).not.toHaveTextContent("上上周周报");
    expect(archive).toHaveTextContent("归档箱");
    expect(archive).toHaveTextContent("上上周周报");
    expect(archive).not.toHaveTextContent("周报草稿");
  });

  it("routes a selection into the detail panel through the composition's open rule", async () => {
    const user = userEvent.setup();
    mount();
    expect(panel("note")).toHaveTextContent("从左边选一条看看");
    await user.click(within(panel("inbox")).getByText("周报草稿"));
    await waitFor(() => {
      const note = panel("note");
      // Labels come from `detailFields`, the body from the default `body_key`.
      expect(note).toHaveTextContent("状态");
      expect(note).toHaveTextContent("平台收敛计划 P4");
    });
    // `mode: "rebind"` — the SECOND open replaces the first in the declared
    // panel rather than minting an anonymous `config: null` twin beside it.
    await user.click(within(panel("archive")).getByText("上上周周报"));
    await waitFor(() => expect(panel("note")).toHaveTextContent("已经发出去了。"));
    expect(document.querySelectorAll('[data-av-slot="secondary"] .av-panel')).toHaveLength(1);
  });

  it("renders the seeded deck as a film strip: one real thumbnail per layout", () => {
    mount();
    const outline = panel("outline");
    expect(outline).toHaveTextContent("幻灯片");
    const slides = outline.querySelectorAll(".dkv-slide");
    expect(slides).toHaveLength(5);
    // Real thumbnails: the surface component with each slide's own layout.
    expect(
      [...slides].map((row) => row.querySelector(".dkv-thumb .dkv-surface")?.getAttribute("data-dkv-surface")),
    ).toEqual(["title", "bullets", "two-column", "image-ref", "title"]);
    expect(slides[0]).toHaveTextContent("模块演示");
    expect(slides[2]).toHaveTextContent("表单编辑 → 可视化编辑");
    // `command_action` is set, so the editing controls exist rather than 只读.
    expect(outline).not.toHaveTextContent("只读");
  });

  it("shows the first slide on the canvas before anything is selected", () => {
    mount();
    const canvas = panel("slide");
    expect(canvas.querySelector("[data-dkv-canvas] .dkv-surface")).not.toBeNull();
    expect(canvas).toHaveTextContent("模块演示");
    expect(canvas).toHaveTextContent("第 1 / 5 页");
  });

  it("opens a slide onto the canvas, addressing the deck and passing the slide as context", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(within(panel("outline")).getByLabelText("第 2 页：这一版展示什么"));
    // The canvas renders the slide's own text in place: the second bullet of
    // the slide the strip just opened, which proves the context (`slide`)
    // reached the module and not merely the ref (the deck).
    await waitFor(() =>
      expect(within(panel("slide")).getByText("open 规则就是路由策略，模块不改布局")).toBeInTheDocument(),
    );
    expect(panel("slide")).toHaveTextContent("第 2 / 5 页");
    // One panel in `primary`, still the declared one, still carrying its config.
    expect(document.querySelectorAll('[data-av-slot="primary"] .av-panel')).toHaveLength(1);
  });

  it("proposes one deck command for one in-place edit", async () => {
    const user = userEvent.setup();
    const { fixture } = mount();
    await user.click(within(panel("slide")).getByLabelText("编辑标题"));
    const input = within(panel("slide")).getByLabelText("标题");
    await user.clear(input);
    await user.type(input, "改过的标题{Enter}");
    await waitFor(() => expect(fixture.proposals).toHaveLength(1));
    expect(fixture.proposals[0]).toEqual({
      action: "deck_command",
      params: { op: "set_text", slide: "s1", field: "title", value: "改过的标题" },
    });
  });

  it("generates the compose form from the action's own parameter declaration", async () => {
    const user = userEvent.setup();
    const { fixture } = mount();
    const compose = panel("compose");
    expect(compose).toHaveTextContent("写一条");
    // `state` declares an enum, so it is a select rather than a text box — the
    // form is derived from the declaration, not drawn beside it.
    expect(within(compose).getByLabelText(/^state/).tagName).toBe("SELECT");
    await user.type(within(compose).getByLabelText(/^title/), "买牛奶");
    await user.click(within(compose).getByText("记下来"));
    await waitFor(() => expect(fixture.proposals).toHaveLength(1));
    expect(fixture.proposals[0]).toEqual({ action: "add_note", params: { title: "买牛奶" } });
  });

  it("keeps the Typst export a configured panel rather than an anonymous twin", async () => {
    const user = userEvent.setup();
    mount();
    // It has a declared instance, so it has a `source` and renders the deck.
    expect(panel("typst")).toHaveTextContent("模块演示");
    await user.click(within(panel("outline")).getByText("导出 Typst"));
    await waitFor(() => expect(panel("typst").closest(".av-panel")).not.toBeNull());
    // Still ONE panel of that module, and still the declared one. Without the
    // standing instance this open would mint `panel-1` with `config: null`,
    // whose `source` is "" and which renders "读不出来".
    expect(document.querySelectorAll('[data-av-module="deck.typst/v1"]')).toHaveLength(1);
    expect(panel("typst")).not.toHaveTextContent("读不出来");
  });

  it("says the projection is still arriving rather than blaming the composition", () => {
    const fixture = createFixtureAgentViewClient({ projection: null });
    render(
      <AgentViewProvider client={fixture.client}>
        <App />
      </AgentViewProvider>,
    );
    // Every config-driven module distinguishes "no projection yet" from "your
    // path is wrong", and the first paint must never be the second sentence.
    expect(panel("inbox")).toHaveTextContent("正在等待第一份投影");
    expect(panel("outline")).toHaveTextContent("正在等待第一份投影");
  });
});
