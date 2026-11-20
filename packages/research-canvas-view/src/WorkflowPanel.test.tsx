import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResearchNode, WorkflowDraft, WorkflowFlag } from "@claude-bot/research-canvas-contract";
import { AgentDraft } from "./AgentDraft.js";
import { ReviewActions } from "./ReviewActions.js";
import type { Call } from "./client.js";

const stamp = { kind: "human" as const, owner: "alice", trigger: "fixture", agent: null, run: null, model: null, at: "2026-09-26T12:00:00Z" };
const agent: ResearchNode = { id: "agent", type: "agent", ref: "agent:agent", title: "研究 Agent", summary: "", schema: 1, data: {}, phase: "present", version: 1, archived: false, created: stamp, updated: stamp, x: 0, y: 0 };
const material: ResearchNode = { ...agent, id: "material", type: "note", ref: "note:material", title: "观察记录" };
const draft: WorkflowDraft = { id: "draft", title: "检查观察", agent: "agent", contexts: ["note:material"], prompt: "请核对观察", status: "draft", conversation: "draft:draft", firstRun: null, latestRun: null, version: 1, archived: false, created: stamp, updated: stamp };
const flag: WorkflowFlag = { id: "flag", version: 1, archived: false, created: stamp, updated: stamp, kind: "review", title: "观察是否可信", background: "样本少", options: [], related: ["note:material"], sources: [], agent: "agent", conversation: "draft:draft", run: "run", state: "open", answer: null, sent: [], affected: [] };

describe("explicit workflow controls", () => {
  beforeEach(() => localStorage.clear());
  it("adding a selected node and saving a draft cannot start an Agent", async () => {
    const invoke = vi.fn().mockResolvedValue({ draft });
    render(<AgentDraft nodes={[agent, material]} agents={[agent]} selected={["material"]} call={invoke as Call} storageKey="fixture" runnable onSaved={() => {}} />);
    fireEvent.click(screen.getByText("加入选中节点（1）"));
    expect(invoke).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("草稿标题"), { target: { value: "检查观察" } });
    fireEvent.click(screen.getByText("保存草稿"));
    await waitFor(() => expect(invoke).toHaveBeenCalledOnce());
    expect(invoke.mock.calls[0][0]).toBe("agent_draft_save");
    expect(invoke.mock.calls[0][1].data.contexts).toEqual(["note:material"]);
    expect(screen.getByText("启动 Agent")).toBeDisabled();
  });
  it("requires saving edited context before explicit launch", async () => {
    const invoke = vi.fn().mockResolvedValue({ draft: { ...draft, status: "started" } });
    render(<AgentDraft draft={draft} nodes={[agent, material]} agents={[agent]} call={invoke as Call} storageKey="fixture" runnable onSaved={() => {}} />);
    fireEvent.click(screen.getByText("启动 Agent"));
    await waitFor(() => expect(invoke.mock.calls[0][0]).toBe("agent_draft_start"));
    fireEvent.change(screen.getByLabelText("任务说明"), { target: { value: "修订说明" } });
    expect(screen.getByText("启动 Agent")).toBeDisabled();
  });
  it("keeps result saving separate from sending and preserves typed answers across data refreshes", async () => {
    const invoke = vi.fn().mockResolvedValue({ flag: { ...flag, version: 2, answer: { text: "增加样本", by: "alice", at: stamp.at } } });
    const onSaved = vi.fn();
    const props = { nodes: [material], call: invoke as Call, storageKey: "fixture", editable: true, runnable: true, onSaved, onOpen: vi.fn() };
    const view = render(<ReviewActions {...props} flag={flag} />);
    fireEvent.change(screen.getByLabelText("审核结果或回答"), { target: { value: "增加样本" } });
    view.rerender(<ReviewActions {...props} flag={{ ...flag, updated: { ...stamp, at: "2026-09-26T12:01:00Z" } }} />);
    expect(screen.getByLabelText("审核结果或回答")).toHaveValue("增加样本");
    expect(screen.getByText("发送结果并继续")).toBeDisabled();
    fireEvent.click(screen.getByText("保存结果"));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(invoke.mock.calls.map(call => call[0])).toEqual(["review_flag_save"]);
    view.rerender(<ReviewActions {...props} flag={onSaved.mock.calls[0][0]} />);
    fireEvent.click(screen.getByText("发送结果并继续"));
    await waitFor(() => expect(invoke.mock.calls[1][0]).toBe("review_flag_continue"));
  });
  it("preserves the request ID and answer after an uncertain delivery failure", async () => {
    const answered: WorkflowFlag = { ...flag, answer: { text: "继续核对", by: "alice", at: stamp.at } };
    const invoke = vi.fn().mockRejectedValue(new Error("连接中断"));
    render(<ReviewActions flag={answered} nodes={[material]} call={invoke as Call} storageKey="fixture" editable runnable onSaved={() => {}} onOpen={() => {}} />);
    fireEvent.click(screen.getByText("发送结果并继续"));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByText("发送结果并继续"));
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    expect(invoke.mock.calls[0][1].request).toBe(invoke.mock.calls[1][1].request);
    expect(screen.getByLabelText("审核结果或回答")).toHaveValue("继续核对");
  });
});
