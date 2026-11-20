import { render, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentViewProvider } from "@claude-bot/agent-view-react";
import { createFixtureAgentViewClient } from "@claude-bot/agent-view-preview";
import { project } from "../app/projection.js";
import { App } from "./App.js";

describe("PPT Studio View", () => {
  it("composes a visual deck, a prompt form and an honest Typst export", () => {
    const fixture = createFixtureAgentViewClient({
      projection: project([]),
      actions: { ask_presenter: { ok: true, message: "已排队" }, deck_command: { ok: true, message: "" } },
    });
    render(<AgentViewProvider client={fixture.client}><App /></AgentViewProvider>);
    const outline = document.querySelector<HTMLElement>('[data-av-panel="outline"]')!;
    const slide = document.querySelector<HTMLElement>('[data-av-panel="slide"]')!;
    const form = document.querySelector<HTMLElement>('[data-av-panel="brief"]')!;
    const typst = document.querySelector<HTMLElement>('[data-av-panel="typst"]')!;
    expect(outline.querySelectorAll(".dkv-slide")).toHaveLength(5);
    expect(slide).toHaveTextContent("PPT Studio");
    expect(within(form).getByLabelText(/^prompt/)).toBeInTheDocument();
    expect(typst).toHaveTextContent("PPT Studio");
  });
});
