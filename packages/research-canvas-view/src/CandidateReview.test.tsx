import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResearchNode, WorkflowBatch, WorkflowPage } from "@claude-bot/research-canvas-contract";
import { CandidateReview } from "./CandidateReview.js";
import type { Call } from "./client.js";

const stamp = { kind: "human" as const, owner: "alice", trigger: "fixture", agent: null, run: null, model: null, at: "2026-09-26T12:00:00Z" };
const agent: ResearchNode = { id: "agent-a", type: "agent", ref: "agent:agent-a", title: "Agent A", summary: "", schema: 1, data: {}, phase: "present", version: 1, archived: false, created: stamp, updated: stamp, x: 0, y: 0 };
const batch: WorkflowBatch = {
  id: "shared-batch", source: "audio:meeting", title: "共享讨论", version: 1, archived: false, created: stamp, updated: stamp, published: {},
  items: [
    { id: "edit", title: "待修订候选", kind: "task", state: "pending", summary: "", body: "核对实验", dependencies: [], evidence: [] },
    { id: "execute", title: "执行任务", kind: "task", state: "confirmed", summary: "", body: "运行实验", dependencies: [], evidence: [] },
  ],
};
const page: WorkflowPage = { drafts: [], flags: [], rules: [], executions: [], runs: [], summaries: {}, truncated: false,
  batches: [batch], agents: [agent, { ...agent, id: "agent-b", ref: "agent:agent-b", title: "Agent B" }] };

describe("candidate draft identity", () => {
  beforeEach(() => localStorage.clear());
  it("restores only the current viewer's unsent edits and execution choices for the same shared batch", async () => {
    localStorage.setItem("rv:candidates:shared-batch:items", JSON.stringify(batch.items.map(item => ({ ...item, title: "旧全局草稿" }))));
    const invoke = vi.fn().mockResolvedValue(page);
    const props = { call: invoke as Call, batch: batch.id, source: batch.source, editable: true, runnable: true, onOpen: vi.fn() };
    const view = render(<CandidateReview {...props} storageKey="rv:project:alice" />);
    const title = () => screen.getAllByLabelText("标题")[0];
    const scope = () => screen.getByLabelText("执行任务");
    const assignedAgent = () => screen.getByLabelText("执行 Agent：执行任务");
    await screen.findAllByLabelText("标题");
    expect(title()).toHaveValue("待修订候选");
    fireEvent.change(title(), { target: { value: "Alice 的未发送草稿" } });
    fireEvent.click(scope());
    fireEvent.change(assignedAgent(), { target: { value: "agent-a" } });

    // Keep the component, call and batch stable: only authenticated view identity changes.
    view.rerender(<CandidateReview {...props} storageKey="rv:project:bob" />);
    expect(title()).toHaveValue("待修订候选");
    expect(scope()).not.toBeChecked(); expect(assignedAgent()).toHaveValue("");
    fireEvent.change(title(), { target: { value: "Bob 的未发送草稿" } });
    fireEvent.change(assignedAgent(), { target: { value: "agent-b" } });

    view.rerender(<CandidateReview {...props} storageKey="rv:project:alice" />);
    expect(title()).toHaveValue("Alice 的未发送草稿");
    expect(scope()).toBeChecked(); expect(assignedAgent()).toHaveValue("agent-a");
    view.rerender(<CandidateReview {...props} storageKey="rv:project:bob" />);
    expect(title()).toHaveValue("Bob 的未发送草稿");
    expect(scope()).not.toBeChecked(); expect(assignedAgent()).toHaveValue("agent-b");
    expect(invoke.mock.calls.every(([action]) => action === "workflow_read")).toBe(true);
  });
});


it("offers the summary Agent without selecting or dispatching tasks until final confirmation", async () => {
  const invoke = vi.fn(async (action: string) => action === "workflow_read" ? page : { batch, execution: null });
  render(<CandidateReview call={invoke as Call} batch={batch.id} source={batch.source} editable runnable onOpen={vi.fn()} storageKey="meeting:alice" defaultAgent="agent-a" />);
  await screen.findAllByLabelText("标题");
  expect(screen.getByLabelText("执行 Agent：执行任务")).toHaveValue("agent-a");
  expect(screen.getByLabelText("执行任务")).not.toBeChecked();
  expect(screen.getByRole("button", { name: "确认下发 0 项任务" })).toBeDisabled();
  fireEvent.click(screen.getByLabelText("执行任务"));
  expect(invoke.mock.calls.every(([action]) => action === "workflow_read")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "确认下发 1 项任务" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("candidates_publish", expect.objectContaining({ data: { mode: "publish_execute", execution: { scope: ["execute"], agents: { execute: "agent-a" }, parallelism: 1, prompt: "" } } })));
});
