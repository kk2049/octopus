import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ResearchNode } from "@claude-bot/research-canvas-contract";
import { InlineEditor } from "./InlineEditor.js";
import { CanvasDocument } from "./collaboration.js";
import type { Call } from "./client.js";
const stamp = { kind: "human", owner: "tester", trigger: "tester", model: null, agent: null, run: null, at: "2026-09-25T00:00:00Z" } as const;
const node: ResearchNode = { id: "note", ref: "note:resource", schema: 1, type: "note", title: "标题", summary: "摘要", version: 1, phase: "present", archived: false, x: 0, y: 0, data: {}, created: stamp, updated: stamp };
const docs: CanvasDocument[] = [];
beforeEach(() => localStorage.clear());
afterEach(() => { for (const doc of docs.splice(0)) doc.close(); });
it("saves body to its ordinary file, changes card kind without a ref change, and keeps newer typing during save", async () => {
  let body = "原始正文", finish!: (value: unknown) => void;
  const call = vi.fn(async (action: string, params: Record<string, any> = {}) => {
    if (action === "document_read") return { revision: "body", data: { text: body } };
    if (action === "document_write") { body = params.text; return { revision: "saved" }; }
    return new Promise<unknown>(resolve => { finish = resolve; });
  });
  const doc = new CanvasDocument(call as Call, "note", "text", "body"); docs.push(doc);
  const changed = vi.fn(), close = vi.fn();
  const view = render(<InlineEditor node={node} call={call as Call} doc={doc} draftKey="inline" active close={close} changed={changed}/>);
  await waitFor(() => expect(screen.getByLabelText("卡片正文")).toBeEnabled());
  fireEvent.change(screen.getByLabelText("卡片正文"), { target: { value: "新的正文" } }); fireEvent.blur(screen.getByLabelText("卡片正文"));
  await waitFor(() => expect(body).toBe("新的正文"));
  fireEvent.change(screen.getByLabelText("卡片类型"), { target: { value: "target" } });
  fireEvent.change(screen.getByLabelText("卡片标题"), { target: { value: "第一版" } });
  await waitFor(() => expect(call.mock.calls.some(([action]) => action === "node_update")).toBe(true));
  const operation = call.mock.calls.find(([action]) => action === "node_update")![1]!;
  expect(operation.data).toEqual({ title: "第一版", cardKind: "target" });
  fireEvent.change(screen.getByLabelText("卡片标题"), { target: { value: "继续输入" } });
  finish({ node: { ...node, title: "第一版", data: { meta: { cardKind: "target" } } } });
  await waitFor(() => expect(changed).toHaveBeenCalled());
  expect(screen.getByLabelText("卡片标题")).toHaveValue("继续输入");
  view.rerender(<InlineEditor node={{ ...node, title: "外部刷新" }} call={call as Call} doc={doc} draftKey="inline" active close={close} changed={changed}/>);
  expect(screen.getByLabelText("卡片标题")).toHaveValue("继续输入");
});
it("keeps a failed metadata draft across remount and only retries the original operation explicitly", async () => {
  let fail = true;
  const call = vi.fn(async () => { if (fail) throw new Error("网络中断"); return { node: { ...node, summary: "待保存" } }; });
  const props = { node, call: call as Call, draftKey: "failed", active: true, close: vi.fn(), changed: vi.fn() };
  const view = render(<InlineEditor {...props}/>);
  fireEvent.change(screen.getByLabelText("卡片说明"), { target: { value: "待保存" } });
  await screen.findByRole("alert"); view.unmount();
  render(<InlineEditor {...props}/>);
  expect(screen.getByLabelText("卡片说明")).toHaveValue("待保存");
  fail = false; fireEvent.click(screen.getByRole("button", { name: "完成编辑" }));
  await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
  expect(call.mock.calls[1]).toEqual(call.mock.calls[0]);
});

it("focuses and grows the summary independently without writing the body", async () => {
  const call = vi.fn(async (action: string, params: Record<string, any> = {}) => action === "document_read" ? { revision: "body", data: { text: "正文保持不变" } } : { node: { ...node, ...params.data } });
  const doc = new CanvasDocument(call as Call, "note", "text", "separate"); docs.push(doc);
  render(<InlineEditor node={node} call={call as Call} doc={doc} field="summary" draftKey="summary" active close={vi.fn()} changed={vi.fn()}/>);
  const summary = screen.getByLabelText("卡片摘要");
  await waitFor(() => expect(summary).toHaveFocus());
  fireEvent.change(summary, { target: { value: "测试对象：并发写入\n核心结论：没有覆盖其他节点" } }); fireEvent.blur(summary);
  await waitFor(() => expect(call.mock.calls.find(([action]) => action === "node_update")?.[1]?.data).toEqual({ summary: "测试对象：并发写入\n核心结论：没有覆盖其他节点" }));
  expect(call.mock.calls.some(([action]) => action === "document_write")).toBe(false);
  expect(screen.getByLabelText("卡片正文")).toHaveValue("正文保持不变");
});
