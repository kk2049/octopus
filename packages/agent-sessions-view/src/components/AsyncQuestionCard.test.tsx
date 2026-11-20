import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PendingSend } from "../controller.js";
import { collectAsyncQuestions, type AsyncQuestionRequest } from "../lib/async-questions.js";
import { AsyncQuestionCard, AsyncQuestions } from "./AsyncQuestionCard.js";
import type { ComposerDraftPersistence } from "../composer-drafts.js";

function preferences(): ComposerDraftPersistence {
  const values = new Map<string, string>();
  const listeners = new Map<string, Set<() => void>>();
  return {
    get: (resource) => ({ text: values.get(resource) ?? "", updatedAt: 0 }),
    set: (resource, text) => { values.set(resource, text); listeners.get(resource)?.forEach((listener) => listener()); },
    subscribe: (resource, listener) => {
      const notify = () => listener({ text: values.get(resource) ?? "", updatedAt: 0 });
      const callbacks = listeners.get(resource) ?? new Set();
      listeners.set(resource, callbacks);
      callbacks.add(notify);
      return () => { callbacks.delete(notify); };
    },
  };
}

const oneQuestion = { messages: [{ role: "assistant", blocks: [{ type: "tool", tool: "request_user_input_async",
  call_id: "native", input: JSON.stringify({ questions: [{ title: "你的建议？" }] }) }] }] };

const request: AsyncQuestionRequest = { id: "call-question", answered: false, laterUserMessage: false,
  questions: [{ id: "0", prompt: "选一个方案", header: "方案", options: [{ label: "甲" }, { label: "乙" }], allow_other: true }] };
const receipt = (prompt: string, phase: PendingSend["phase"], key = "send-1"): PendingSend => ({
  key, resource: "r", prompt, phase, kind: "append", message: "", projectionSequence: 1, absoluteMessageEnd: 1,
});

describe("asynchronous question card", () => {
  it("ignores without sending, retains the choice across frames and remounts, and keeps history collapsed", () => {
    const send = vi.fn();
    const persistence = preferences();
    const props = { scope: "panel-a", resource: "resource-a", transcript: oneQuestion, canSend: true, onSend: send, persistence };
    const { rerender, unmount } = render(<AsyncQuestions {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "忽略" }));
    expect(screen.getByText("异步问题 · 0 组未确认")).toBeInTheDocument();
    const history = screen.getByText("已忽略 · 1 组").closest("details")!;
    expect(history).not.toHaveAttribute("open");
    expect(screen.getByText("已忽略", { exact: true }).closest("section")).toHaveAttribute("data-av-async-question-state", "ignored");
    rerender(<AsyncQuestions {...props} transcript={JSON.parse(JSON.stringify(oneQuestion))} />);
    expect(history).not.toHaveAttribute("open");
    expect(send).not.toHaveBeenCalled();
    unmount();
    render(<AsyncQuestions {...props} scope="reopened-panel" />);
    expect(screen.getByText("异步问题 · 0 组未确认").closest("details")).not.toHaveAttribute("open");
    expect(screen.getByText("已忽略 · 1 组").closest("details")).not.toHaveAttribute("open");
  });

  it("shares ignore choices between copies of one session but not another session with the same call id", () => {
    const persistence = preferences();
    render(<>{["a", "a", "b"].map((resource, index) => <div key={index} data-testid={`copy-${index}`}>
      <AsyncQuestions scope={`panel-${index}`} resource={resource} persistence={persistence} transcript={oneQuestion} canSend={false} onSend={vi.fn()} />
    </div>)}</>);
    fireEvent.click(within(screen.getByTestId("copy-0")).getByRole("button", { name: "忽略" }));
    expect(within(screen.getByTestId("copy-1")).getByText("异步问题 · 0 组未确认")).toBeInTheDocument();
    expect(within(screen.getByTestId("copy-2")).getByText("异步问题 · 1 组未确认")).toBeInTheDocument();
  });

  it("respects manual collapse through refresh and prefers confirmed answer evidence over ignore", () => {
    const persistence = preferences();
    const props = { scope: "a", transcript: oneQuestion, canSend: true, onSend: vi.fn(), persistence };
    const { rerender } = render(<AsyncQuestions {...props} />);
    const fold = screen.getByText("异步问题 · 1 组未确认").closest("details")!;
    fold.open = false;
    fireEvent(fold, new Event("toggle"));
    rerender(<AsyncQuestions {...props} transcript={JSON.parse(JSON.stringify(oneQuestion))} />);
    expect(fold).not.toHaveAttribute("open");
    act(() => persistence.set("a", JSON.stringify(["native"])));
    const answered = { messages: [...oneQuestion.messages, { role: "user", blocks: [{ type: "text", text: '【Codex 异步问题回答：native】\n建议甲' }] }] };
    rerender(<AsyncQuestions {...props} transcript={answered} />);
    expect(screen.queryByText("已忽略 · 1 组")).toBeNull();
    expect(screen.getByText("已回答 · 1 组")).toBeInTheDocument();
    expect(fold).not.toHaveAttribute("open");
  });

  it("recovers from malformed preferences and reports persistence failure without sending", () => {
    const persistence = preferences();
    persistence.set("a", "invalid JSON");
    const send = vi.fn();
    persistence.set = () => { throw new Error("storage unavailable"); };
    render(<AsyncQuestions scope="a" transcript={oneQuestion} persistence={persistence} canSend={false} onSend={send} />);
    fireEvent.click(screen.getByRole("button", { name: "忽略" }));
    expect(screen.getByText("异步问题 · 0 组未确认")).toBeInTheDocument();
    expect(screen.getByText(/忽略状态仅在当前页面保留/)).toBeInTheDocument();
    expect(send).not.toHaveBeenCalled();
  });
  it("isolates radio groups when two sessions reuse a legacy question identity", () => {
    render(<><div data-testid="first"><AsyncQuestionCard scope="first" request={request} canSend onSend={vi.fn()} /></div>
      <div data-testid="second"><AsyncQuestionCard scope="second" request={request} canSend onSend={vi.fn()} /></div></>);
    const first = within(screen.getByTestId("first")), second = within(screen.getByTestId("second"));
    fireEvent.click(first.getByLabelText("甲"));
    fireEvent.click(second.getByLabelText("乙"));
    expect(first.getByLabelText("甲")).toBeChecked();
    expect(second.getByLabelText("乙")).toBeChecked();
  });
  it("lets the reader reach earlier pending questions without clearing an edited newer question", () => {
    const transcript = { messages: Array.from({ length: 13 }, (_, index) => ({ role: "assistant", blocks: [{
      type: "tool", tool: "request_user_input_async", call_id: `q-${index}`,
      input: JSON.stringify({ questions: [{ title: `问题-${index}` }] }),
    }] })) };
    render(<AsyncQuestions scope="r" transcript={transcript} canSend onSend={vi.fn()} />);
    expect(screen.getAllByText(/^问题-\d+$/)[0]).toHaveTextContent("问题-12");
    const field = screen.getAllByLabelText("回答").at(-1)!;
    fireEvent.change(field, { target: { value: "保留草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "显示更早的问题" }));
    expect(screen.getByText("问题-0")).toBeInTheDocument();
    expect(field).toHaveValue("保留草稿");
  });
  it("requires explicit input, preserves drafts on refresh, and locks duplicate sends until evidence arrives", () => {
    const send = vi.fn();
    const { rerender } = render(<AsyncQuestionCard request={request} canSend onSend={send} />);
    fireEvent.click(screen.getByRole("button", { name: "发送回答" }));
    expect(send).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("其他回答"), { target: { value: "自选方案" } });
    rerender(<AsyncQuestionCard request={{ ...request, laterUserMessage: true }} canSend onSend={send} />);
    expect(screen.getByLabelText("其他回答")).toHaveValue("自选方案");
    fireEvent.click(screen.getByRole("button", { name: "发送回答" }));
    expect(send).toHaveBeenCalledOnce();
    const prompt = send.mock.calls[0][0] as string;
    expect(prompt).toContain("回答：自选方案");
    expect(screen.getByRole("button", { name: "发送回答" })).toBeDisabled();
    rerender(<AsyncQuestionCard request={request} canSend onSend={send} pendingSends={[{
      ...receipt(prompt, "running"), input: { phase: "local_queued", evidence: "local_queue", at: "now" },
    }]} />);
    expect(screen.getByRole("status")).toHaveTextContent("已在本地排队");
    expect(screen.queryByText("已回答 · 会话记录已确认")).toBeNull();
    rerender(<AsyncQuestionCard request={request} canSend onSend={send} pendingSends={[receipt(prompt, "uncertain")]} />);
    expect(screen.getByRole("button", { name: "发送回答" })).toBeDisabled();
    expect(send).toHaveBeenCalledOnce();
  });
  it("preserves answers on refusal and permits one explicit retry", () => {
    const send = vi.fn();
    const { rerender } = render(<AsyncQuestionCard request={request} canSend onSend={send} />);
    fireEvent.click(screen.getByLabelText("乙"));
    fireEvent.click(screen.getByRole("button", { name: "发送回答" }));
    const prompt = send.mock.calls[0][0] as string;
    rerender(<AsyncQuestionCard request={request} canSend onSend={send}
      pendingSends={[{ ...receipt(prompt, "refused"), message: "设备离线" }]} />);
    expect(screen.getByRole("alert")).toHaveTextContent("设备离线");
    expect(screen.getByLabelText("乙")).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "发送回答" }));
    expect(send).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "发送回答" })).toBeDisabled();
  });
  it("renders read-only and malformed questions without a send path", () => {
    const send = vi.fn();
    const { rerender } = render(<AsyncQuestionCard request={request} canSend={false} onSend={send} />);
    expect(screen.getByRole("button", { name: "发送回答" })).toBeDisabled();
    rerender(<AsyncQuestionCard request={{ ...request, error: "问题内容不完整" }} canSend onSend={send} />);
    expect(screen.getByRole("button", { name: "发送回答" })).toBeDisabled();
    expect(send).not.toHaveBeenCalled();
  });
  it("closes only the correlated answered card after transcript refresh and reload", () => {
    const send = vi.fn();
    const transcript = { messages: [{ role: "assistant", blocks: [{ type: "tool", tool: "request_user_input_async",
      call_id: "native", input: JSON.stringify({ questions: [{ title: "你的建议？" }] }) }] }] };
    const { rerender, unmount } = render(<AsyncQuestions scope="resource-a" transcript={transcript} canSend onSend={send} />);
    fireEvent.change(screen.getByLabelText("回答"), { target: { value: "建议甲" } });
    fireEvent.click(screen.getByRole("button", { name: "发送回答" }));
    const answered = { messages: [...transcript.messages, { role: "user", blocks: [{ type: "text", text: send.mock.calls[0][0] }] }] };
    rerender(<AsyncQuestions scope="resource-a" transcript={answered} canSend onSend={send} />);
    expect(screen.queryByRole("button", { name: "发送回答" })).toBeNull();
    expect(collectAsyncQuestions(answered)[0].answered).toBe(true);
    unmount();
    render(<AsyncQuestions scope="resource-a" transcript={JSON.parse(JSON.stringify(answered))} canSend onSend={send} />);
    expect(screen.getByText("异步问题 · 0 组未确认")).toBeInTheDocument();
  });
});
