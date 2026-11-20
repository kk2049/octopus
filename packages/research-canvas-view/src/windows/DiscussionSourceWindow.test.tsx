import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscussionSourceStatus, ResearchNode } from "@claude-bot/research-canvas-contract";
import { DiscussionSourceWindow } from "./DiscussionSourceWindow.js";
import type { Call } from "../client.js";
vi.mock("../CandidateReview.js", () => ({ CandidateReview: ({ batch, storageKey }: { batch: string; storageKey: string }) => <div data-storage-key={storageKey}>候选批次 {batch}</div> }));
const node = { id: "audio", type: "audio", title: "会议", data: {} } as ResearchNode;
const source = (patch: Partial<DiscussionSourceStatus> = {}): DiscussionSourceStatus => ({ id: "source", node: "audio", title: "会议", kind: "audio", sourceVersion: "file-v1", stage: "needs_review", progress: null, message: "末尾需要补段", createdAt: "2026-09-26T00:00:00Z", updatedAt: "2026-09-26T00:00:00Z", ...patch });
describe("discussion result lifecycle", () => {
  beforeEach(() => vi.clearAllMocks());
  it("labels an incomplete transcript as partial and keeps completeness evidence accessible", async () => {
    const open = vi.fn(), call = vi.fn(async () => ({ source: source({ transcript: { id: "partial", ref: "file:partial" }, evidence: { id: "evidence", ref: "file:evidence" },
      integrity: { complete: false, rawClosed: false, durationSeconds: 300, lastEndSeconds: 180, trailingSeconds: 120, segments: 5, tokenLimited: false, recovered: false, warnings: ["末尾未闭合"] } }) })) as Call;
    render(<DiscussionSourceWindow storageKey="rv:project:alice" node={node} call={call} editable runnable open={open} />);
    const partial = await screen.findByRole("button", { name: "打开部分转写（待审）" });
    expect(screen.queryByRole("button", { name: "打开完整转写" })).not.toBeInTheDocument();
    fireEvent.click(partial); expect(open).toHaveBeenCalledWith("partial");
    fireEvent.click(screen.getByRole("button", { name: "查看完整性证据" })); expect(open).toHaveBeenCalledWith("evidence");
  });
  it("shows one shared editable candidate batch after completion", async () => {
    const call = vi.fn(async () => ({ source: source({ stage: "completed", message: "材料已生成", batch: "batch-1", minutes: { id: "minutes", ref: "note:minutes" } }) })) as Call;
    render(<DiscussionSourceWindow storageKey="rv:project:alice" node={node} call={call} editable runnable open={() => {}} />);
    expect(await screen.findByText("候选批次 batch-1")).toHaveAttribute("data-storage-key", "rv:project:alice"); expect(screen.getByRole("button", { name: "打开可编辑纪要" })).toBeEnabled();
  });
  it("drops late source results after the selected source changes", async () => {
    let resolve!: (value: { source: DiscussionSourceStatus }) => void;
    const call = vi.fn((_, params) => params?.node === "audio" ? new Promise(value => { resolve = value; }) : Promise.resolve({ source: source({ node: "next", title: "下一份", message: "下一份材料" }) })) as Call;
    const view = render(<DiscussionSourceWindow storageKey="rv:project:alice" node={node} call={call} editable runnable open={() => {}} />);
    view.rerender(<DiscussionSourceWindow storageKey="rv:project:alice" node={{ ...node, id: "next" }} call={call} editable runnable open={() => {}} />);
    resolve({ source: source({ message: "迟到的旧来源" }) });
    await screen.findByText(/下一份材料/);
    await waitFor(() => expect(screen.queryByText("迟到的旧来源")).not.toBeInTheDocument());
  });
});
