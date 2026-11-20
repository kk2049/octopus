import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ViewEntry } from "../lib/transcript.js";
import { Transcript } from "./Transcript.js";

describe("Transcript fold ownership", () => {
  it("keeps a fold override attached to its message anchor across a prepend", () => {
    const work: ViewEntry = {
      kind: "tool",
      text: "Bash",
      input: "pwd",
      detail: "/workspace",
      anchor: "10.0",
    };
    const answer: ViewEntry = { kind: "assistant", text: "done", anchor: "11.0" };
    const view = render(<Transcript entries={[work, answer]} />);
    const summary = screen.getByText(/1 个工具调用/).closest("summary")!;
    const details = summary.closest("details")!;
    expect(details).toHaveAttribute("open");

    const toolBefore = view.container.querySelector<HTMLDetailsElement>(
      'details[data-av-chat-work-kind="tool"]',
    )!;
    fireEvent.click(toolBefore.querySelector("summary")!);
    expect(toolBefore).toHaveAttribute("open");

    fireEvent.click(summary);
    expect(details).not.toHaveAttribute("open");

    const earlier: ViewEntry = { kind: "user", text: "start", anchor: "9.0" };
    view.rerender(<Transcript entries={[earlier, work, answer]} />);

    expect(screen.getByText(/1 个工具调用/).closest("details")).not.toHaveAttribute("open");
    const toolAfter = view.container.querySelector<HTMLDetailsElement>(
      'details[data-av-chat-work-kind="tool"]',
    )!;
    expect(toolAfter).toBe(toolBefore);
    expect(toolAfter).toHaveAttribute("open");
  });
});
