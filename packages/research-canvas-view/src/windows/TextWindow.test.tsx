import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { ResearchNode } from "@claude-bot/research-canvas-contract";
import type { CanvasDocument } from "../collaboration.js";
import type { Call } from "../client.js";
import { TextWindow } from "./TextWindow.js";
it("copies the original node address without starting or messaging an Agent", async () => {
  const writeText = vi.fn(async (_text: string) => {}), call = vi.fn();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const state = { ready: true, pending: false, error: "", revision: 1 };
  const doc = { subscribe: () => () => {}, snapshot: () => state, sync: async () => {}, text: () => "需要继续讨论的正文" } as unknown as CanvasDocument;
  render(<TextWindow project="project" node={{ id: "note", type: "note", title: "讨论", data: {} } as ResearchNode} doc={doc} editable runnable call={call as Call} agents={[]}/>);
  fireEvent.click(screen.getByRole("button", { name: "复制节点引用" }));
  await waitFor(() => expect(writeText).toHaveBeenCalled());
  expect(new URL(writeText.mock.calls[0][0]).searchParams.get("researchNode")).toBe("note");
  expect(new URL(writeText.mock.calls[0][0]).searchParams.get("project")).toBe("project");
  expect(call).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "拉起 Agent" })).not.toBeInTheDocument();
});
