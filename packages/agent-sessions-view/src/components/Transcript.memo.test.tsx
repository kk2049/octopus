import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { TranscriptWindow } from "@claude-bot/agent-sessions-contract";

const markdownRenders = vi.hoisted(() => vi.fn());

vi.mock("@claude-bot/agent-view-react/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@claude-bot/agent-view-react/ui")>();
  return {
    ...actual,
    Markdown: ({ children }: { children: ReactNode }) => {
      markdownRenders();
      return <>{children}</>;
    },
  };
});

import { TranscriptView } from "./Transcript.js";

function transcript(text: string): TranscriptWindow {
  return {
    offset: 1,
    totalMessages: 2,
    hasMore: true,
    messages: [{ role: "assistant", text }],
  };
}

describe("TranscriptView projection isolation", () => {
  it("does not redraw unchanged messages for fresh wrapper props", () => {
    const data = transcript("stable body");
    const oldLoad = vi.fn();
    const latestLoad = vi.fn();
    const view = render(
      <TranscriptView
        resource="res-1"
        data={data}
        status={{ resource: "res-1", state: "live" }}
        busy={false}
        pendingSends={[]}
        onLoadOlder={oldLoad}
        onOpenFileLink={() => {}}
        onToggleGroup={() => {}}
      />,
    );
    const firstRenderCount = markdownRenders.mock.calls.length;
    expect(firstRenderCount).toBeGreaterThan(0);

    view.rerender(
      <TranscriptView
        resource="res-1"
        data={data}
        status={{ resource: "res-1", state: "live" }}
        busy={false}
        pendingSends={[]}
        onLoadOlder={latestLoad}
        onOpenFileLink={() => {}}
        onToggleGroup={() => {}}
      />,
    );
    expect(markdownRenders).toHaveBeenCalledTimes(firstRenderCount);
    const scroller = view.container.querySelector<HTMLElement>("[data-av-chat-transcript]")!;
    Object.defineProperty(scroller, "clientHeight", { value: 600 });
    fireEvent.wheel(scroller, { deltaY: -100 });
    expect(oldLoad).not.toHaveBeenCalled();
    expect(latestLoad).toHaveBeenCalledTimes(1);

    view.rerender(
      <TranscriptView
        resource="res-1"
        data={transcript("new authoritative body")}
        status={{ resource: "res-1", state: "live" }}
        busy={false}
        pendingSends={[]}
        onLoadOlder={() => {}}
      />,
    );
    expect(screen.getByText("new authoritative body")).toBeInTheDocument();
  });
});
