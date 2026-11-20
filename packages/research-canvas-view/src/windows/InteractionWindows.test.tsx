import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ResearchNode } from "@claude-bot/research-canvas-contract";
import { GroupWindow } from "./GroupWindow.js";
import type { Call } from "../client.js";
import { FolderWindow } from "./FolderWindow.js";
import { ReviewWindow } from "./ReviewWindow.js";

function makeNode(overrides: Partial<ResearchNode> = {}): ResearchNode {
  return {
    id: "node",
    title: "节点",
    type: "note",
    version: 1,
    archived: false,
    summary: "",
    data: {},
    ...overrides,
  } as ResearchNode;
}

describe("research interaction windows", () => {
  it("persists folder membership inside node data while preserving metadata", async () => {
    const mutate = vi.fn(async () => ({ ok: true }));
    const folder = makeNode({
      id: "folder",
      title: "待审查材料",
      type: "folder",
      version: 4,
      summary: "收纳",
      data: { members: [], description: "keep this" },
    });
    const candidate = makeNode({ id: "note-1", title: "题面", type: "note" });
    render(
      <FolderWindow
        node={folder}
        nodes={[folder, candidate]}
        editable
        mutate={mutate}
        open={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => expect(mutate).toHaveBeenCalledWith("node_update", {
      node: "folder",
      version: 4,
      data: { data: { members: ["note-1"], description: "keep this" } },
    }));
  });

  it("marks changed review targets stale and can reset to current versions", async () => {
    const mutate = vi.fn(async () => ({ ok: true }));
    const review = makeNode({
      id: "review",
      title: "审查",
      type: "review",
      version: 2,
      data: { targets: { "note-1": 1 }, reviewStatus: "approved" },
    });
    const target = makeNode({ id: "note-1", title: "题面", type: "note", version: 2 });
    render(
      <ReviewWindow
        node={review}
        nodes={[review, target]}
        editable
        mutate={mutate}
        open={() => {}}
      />,
    );

    expect(screen.getByText("目标已变化，需重审")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "通过审查" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "重置待审" }));
    await waitFor(() => expect(mutate).toHaveBeenCalledWith("node_update", {
      node: "review",
      version: 2,
      data: {
        data: {
          targets: { "note-1": 2 },
          reviewStatus: "pending",
          decision: { status: "pending", targets: { "note-1": 2 } },
        },
      },
    }));
  });
});



it("retries exactly the original discussion interval after a partial failure without sending a group message", async () => {
  const requests: Record<string, unknown>[] = [];
  const call = vi.fn(async (action: string, params: Record<string, unknown>) => {
    if (action === "resource_read") return { items: [{ message_id: "new", body: "Latest" }, { message_id: "old", body: "Earlier" }], has_more: false };
    if (action === "source_read") return { source: null, follow: null };
    if (action === "discussion_capture") {
      requests.push(params);
      if (requests.length === 1) throw new Error("Partial save; retry original request");
      return { minutes: { id: "minutes" } };
    }
    throw new Error("Unexpected write: " + action);
  });
  const open = vi.fn();
  render(<GroupWindow node={makeNode({ id: "discussion-group", type: "group" })} call={call as Call} runnable={false} editable storageKey="discussion-retry-test" open={open} />);
  await screen.findByText("Earlier");
  fireEvent.click(screen.getByText("保存讨论区间与纪要"));
  fireEvent.change(screen.getByLabelText("讨论首条消息"), { target: { value: "old" } });
  fireEvent.change(screen.getByLabelText("讨论末条消息"), { target: { value: "new" } });
  fireEvent.click(screen.getByRole("button", { name: "生成原始记录与纪要草稿" }));
  await screen.findByRole("alert");
  fireEvent.change(screen.getByLabelText("讨论标题"), { target: { value: "Another interval" } });
  fireEvent.click(screen.getByRole("button", { name: "重试原区间" }));
  await screen.findByRole("button", { name: "打开纪要" });
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[1]).toMatchObject({ from: "old", to: "new", title: "讨论记录" });
  fireEvent.click(screen.getByRole("button", { name: "打开纪要" }));
  expect(open).toHaveBeenCalledWith("minutes");
  expect(call.mock.calls.some(([action]) => action === "group_send")).toBe(false);
});
