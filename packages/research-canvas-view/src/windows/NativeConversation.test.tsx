import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { Call } from "../client.js";
import { NativeConversation } from "./NativeConversation.js";

const props = { node: "graph-card", conversation: "manual:resource", epoch: 0, runnable: false, openFile: () => {}, appendDraft: () => {}, expanded: {}, toggle: () => {} };
const frame = (text: string, turn_state = "idle") => ({ transcript: {
  sessionId: "original-session", rich: true, hasMore: false, offset: 0, totalMessages: 1, nextOffset: 1, runtime: { turn_state },
  messages: [{ role: "assistant", timestamp: "2026-09-24T12:00:00Z", blocks: [{ type: "text", text }] }],
} });

it("accepts an in-flight transcript across data wakes and coalesces follow-up reads", async () => {
  const pending: Array<(value: unknown) => void> = [];
  const invoke = vi.fn(() => new Promise(resolve => pending.push(resolve)));
  const view = render(<NativeConversation {...props} call={invoke as Call} />);
  view.rerender(<NativeConversation {...props} call={invoke as Call} epoch={1} />);
  view.rerender(<NativeConversation {...props} call={invoke as Call} epoch={2} />);
  expect(invoke).toHaveBeenCalledTimes(1);
  await act(async () => pending[0](frame("已收到的研究进展", "working")));
  expect(await screen.findByText("已收到的研究进展")).toBeVisible();
  expect(screen.getByText("原会话 · 工作中")).toBeVisible();
  await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
  await act(async () => pending[1](frame("本轮研究已经结束")));
  expect(await screen.findByText("本轮研究已经结束")).toBeVisible();
  expect(screen.getByText("原会话 · 空闲")).toBeVisible();
  expect(invoke).toHaveBeenCalledTimes(2);
});

it("drops a late transcript from the previous conversation", async () => {
  const pending: Array<(value: unknown) => void> = [];
  const invoke = vi.fn(() => new Promise(resolve => pending.push(resolve)));
  const view = render(<NativeConversation {...props} call={invoke as Call} />);
  view.rerender(<NativeConversation {...props} call={invoke as Call} conversation="listener:other" />);
  await act(async () => pending[1](frame("当前监听的结果")));
  expect(await screen.findByText("当前监听的结果")).toBeVisible();
  await act(async () => pending[0](frame("旧会话的迟到结果")));
  expect(screen.queryByText("旧会话的迟到结果")).not.toBeInTheDocument();
  expect(screen.getByText("当前监听的结果")).toBeVisible();
});

it("stops automatic reads after refusal until explicit retry", async () => {
  const invoke = vi.fn().mockRejectedValueOnce(new Error("资源授权被撤销")).mockResolvedValue(frame("重新授权后读到的历史"));
  const view = render(<NativeConversation {...props} call={invoke as Call} />);
  await screen.findByRole("alert");
  view.rerender(<NativeConversation {...props} call={invoke as Call} epoch={1} />);
  expect(invoke).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
  expect(await screen.findByText("重新授权后读到的历史")).toBeVisible();
  expect(invoke).toHaveBeenCalledTimes(2);
});
