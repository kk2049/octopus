import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { ResearchNode } from "@claude-bot/research-canvas-contract";
import { CardPreview, SourceContext, childComposition } from "./CardPreview.js";
import type { Call } from "./client.js";
const stamp = { kind: "human" as const, owner: "tester", trigger: "tester", agent: null, run: null, model: null, at: "2026-09-24T00:00:00Z" };
const base = { schema: 1, phase: "present" as const, x: 0, y: 0, version: 1, archived: false, created: stamp, updated: stamp, summary: "" };

it("pins preview chunks to one file version and refuses a changed source", async () => {
  const node = { ...base, id: "figure", type: "file", title: "Source figure", summary: "", data: { meta: { previewKind: "image" } } } satisfies ResearchNode;
  const call = vi.fn().mockResolvedValueOnce({ file: { id: "v1", bytes: 4, mime: "image/png", sha256: "a" }, data: "YWE=", next: 2 })
    .mockResolvedValueOnce({ file: { id: "v2", bytes: 4, mime: "image/png", sha256: "b" }, data: "YmI=", next: null });
  render(<CardPreview node={node} nodes={[node]} children={[]} call={call as Call} documentFor={vi.fn()} open={vi.fn()} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("预览版本已变化");
  expect(call.mock.calls[1]).toEqual(["resource_read", { node: "figure", cursor: 2, version: "v1" }]);
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
});

it("shows stale source revisions separately from an author's acceptance claim", () => {
  const source = { ...base, type: "file", id: "source", title: "New results", data: { meta: { sha256: "new" } } } satisfies ResearchNode;
  const note = { ...base, type: "note", title: "Summary", id: "summary", data: { meta: { sourceNode: "source", sourceRevision: "old", acceptanceStatus: "pending" } } } satisfies ResearchNode;
  render(<SourceContext node={note} nodes={[source]} open={vi.fn()} />);
  expect(screen.getByText(/来源已更新，摘要待复核/)).toBeInTheDocument();
  expect(screen.getByText("验收：待独立验收")).toBeInTheDocument();
});

it("summarizes direct child types without listing or double-counting category labels", () => {
  const children = ["note", "task", "agent", "file", "folder"].map((type, i) => ({ ...base, id: String(i), title: "child " + i, type, data: {} })) as ResearchNode[];
  expect(childComposition(children)).toBe("2 张卡片 · 1 个 Agent · 1 份资料 · 1 个分组");
  const node = { ...base, id: "parent", type: "folder", title: "Group", data: {} } as ResearchNode;
  render(<CardPreview node={node} nodes={children} children={children} call={vi.fn() as Call} documentFor={vi.fn()} open={vi.fn()} />);
  expect(screen.getByText(/本层 · 2 张卡片/)).toBeInTheDocument();
  expect(screen.queryByText("child 0")).not.toBeInTheDocument();
});
