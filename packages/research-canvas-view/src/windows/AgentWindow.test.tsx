import { StrictMode } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResearchNode } from "@claude-bot/research-canvas-contract";
import { AgentWindow } from "./AgentWindow.js";
import { NodeWindow, type NodeWindowProps } from "./NodeWindow.js";
import type { Call } from "../client.js";
const node = {
  id: "agent-one",
  title: "研究员",
  type: "agent",
} as ResearchNode;
const history = {
  runs: [],
  messages: [],
  older: null,
  binding: { owner: "alice", resource: "shared-model", kind: "agent" },
};
beforeEach(() => localStorage.clear());
describe("personal Agent windows", () => {
  it("survives the development remount and preserves a draft without cancelling work", async () => {
    const invoke = vi.fn(async (_action: string) => history),
      call = invoke as Call;
    const view = render(
      <StrictMode>
        <AgentWindow
          node={node}
          call={call}
          epoch={0}
          storageKey="alice:project"
          runnable
          openFile={() => {}}
        />
      </StrictMode>,
    );
    await screen.findByText("alice");
    fireEvent.change(screen.getByLabelText("Agent 任务"), {
      target: { value: "尚未发送的想法" },
    });
    view.unmount();
    render(
      <AgentWindow
        node={node}
        call={call}
        epoch={0}
        storageKey="alice:project"
        runnable
        openFile={() => {}}
      />,
    );
    expect(screen.getByLabelText("Agent 任务")).toHaveValue("尚未发送的想法");
    expect(invoke.mock.calls.every((args) => args[0] !== "agent_stop")).toBe(
      true,
    );
  });
  it("keeps a newer draft if a submitted message completes late", async () => {
    let finish!: (value: unknown) => void;
    const call: Call = vi.fn(async (action: string) =>
      action === "agent_send"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : history,
    ) as Call;
    render(
      <AgentWindow
        node={node}
        call={call}
        epoch={0}
        storageKey="alice:project"
        runnable
        openFile={() => {}}
      />,
    );
    await screen.findByText("alice");
    const input = screen.getByLabelText("Agent 任务");
    fireEvent.change(input, { target: { value: "第一条" } });
    fireEvent.click(screen.getByRole("button", { name: "发送任务 ↗" }));
    fireEvent.change(input, { target: { value: "下一条还在写" } });
    await act(async () => finish({ run: { id: "one" } }));
    expect(input).toHaveValue("下一条还在写");
  });
  it("does not auto-retry a refused read on unrelated project changes", async () => {
    const invoke = vi.fn(async () => {
        throw new Error("授权已撤销");
      }),
      call = invoke as Call;
    const view = render(
      <AgentWindow
        node={node}
        call={call}
        epoch={0}
        storageKey="bob:project"
        runnable
        openFile={() => {}}
      />,
    );
    await screen.findByRole("alert");
    const count = invoke.mock.calls.length;
    view.rerender(
      <AgentWindow
        node={node}
        call={call}
        epoch={1}
        storageKey="bob:project"
        runnable
        openFile={() => {}}
      />,
    );
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(count));
    fireEvent.click(screen.getByLabelText("会话与节点设置"));
    fireEvent.click(screen.getByRole("button", { name: "刷新历史" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(count + 1));
  });
  it.each([undefined, "manual:graph-card"])(
    "reads the bound resource conversation with a different card ID (saved %s)",
    async (saved) => {
      const card = { ...node, id: "graph-card", ref: "agent:resource-id" };
      if (saved) localStorage.setItem("alice:project:conversation:graph-card", JSON.stringify(saved));
      localStorage.setItem("alice:project:draft:graph-card", JSON.stringify("尚未发送"));
      const invoke = vi.fn(async (action: string, params?: Record<string, unknown>) => {
        if (action === "resource_read") return {
          ...history, manualConversation: "manual:resource-id",
          binding: { ...history.binding, node: "resource-id", kind: "session" },
        };
        if (action === "session_read") return { transcript: params?.conversation === "manual:resource-id" ? {
          sessionId: "original-native-session", rich: true, hasMore: false,
          messages: [{ role: "assistant", timestamp: "2026-09-24T12:00:00Z", blocks: [{ type: "text", text: "原有科研会话的真实历史" }] }],
        } : null };
        throw new Error(`Unexpected action ${action}`);
      });
      render(<AgentWindow node={card} call={invoke as Call} epoch={0} storageKey="alice:project" runnable openFile={() => {}} />);
      await screen.findByText("原有科研会话的真实历史");
      expect(invoke).toHaveBeenCalledWith("session_read", expect.objectContaining({ node: "graph-card", conversation: "manual:resource-id" }));
      expect(invoke.mock.calls.filter(([action]) => action === "session_read").every(([, params]) => params?.conversation === "manual:resource-id")).toBe(true);
      expect(screen.getByLabelText("Agent 会话")).toHaveValue("manual:resource-id");
      expect(screen.getByLabelText("Agent 任务")).toHaveValue("尚未发送");
      expect(JSON.parse(localStorage.getItem("alice:project:conversation:graph-card")!)).toBe("manual:resource-id");
    },
  );
  it("keeps a selected listener when its run is absent from a history frame", async () => {
    localStorage.setItem("alice:project:conversation:graph-card", JSON.stringify("listener:existing"));
    const invoke = vi.fn(async () => ({ ...history, manualConversation: "manual:resource-id" }));
    const props = { node: { ...node, id: "graph-card", ref: "agent:resource-id" }, call: invoke as Call, storageKey: "alice:project", runnable: true, openFile: () => {} };
    const view = render(<AgentWindow {...props} epoch={0} />);
    await screen.findByText("alice");
    expect(screen.getByLabelText("Agent 会话")).toHaveValue("listener:existing");
    view.rerender(<AgentWindow {...props} epoch={1} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText("Agent 会话")).toHaveValue("listener:existing");
    expect(JSON.parse(localStorage.getItem("alice:project:conversation:graph-card")!)).toBe("listener:existing");
  });

});

it("shows native chat by default and preserves its DOM, draft and scroll when settings open", async () => {
  const stamp = { kind: "human" as const, owner: "alice", trigger: "manual", agent: null, run: null, model: null, at: "2026-09-26T12:00:00Z" };
  const agent: ResearchNode = { ...node, schema: 1, ref: "agent:resource", version: 1, archived: false, summary: "", phase: "present", x: 0, y: 0, data: {}, created: stamp, updated: stamp };
  const invoke = vi.fn(async (action: string) => {
    if (action === "resources_list") return { resources: [] };
    if (action === "resource_read") return { ...history, manualConversation: "manual:resource", binding: { ...history.binding, node: "resource", kind: "session" } };
    if (action === "session_read") return { transcript: {
      sessionId: "original", rich: true, hasMore: false, runtime: { turn_state: "idle" },
      messages: [{ role: "assistant", timestamp: stamp.at, blocks: [{ type: "text", text: "原始聊天内容一直保留" }] }],
    } };
    throw new Error(`Unexpected ${action}`);
  });
  const props: NodeWindowProps = {
    node: agent, original: agent, nodes: [agent],
    window: { id: "agent-window", node: agent.id, x: 0, y: 0, width: 570, height: 560, minimized: false, z: 1 },
    boot: { project: "project", viewer: "alice", role: "owner", epoch: 0 },
    call: invoke as Call, documentFor: () => { throw new Error("Agent does not mount a text document"); },
    editable: true, runnable: true, storageKey: "alice:project", open: () => {}, openFile: () => {}, mutate: async () => ({}),
  };
  const view = render(<div data-testid="window-scroll"><NodeWindow {...props} /></div>);
  const message = await screen.findByText("原始聊天内容一直保留");
  const input = screen.getByLabelText("Agent 任务"), menu = screen.getByLabelText("会话与节点设置");
  const scroll = screen.getByTestId("window-scroll");
  expect(message).toBeVisible();
  expect(screen.getByText("原会话 · 空闲")).toBeVisible();
  expect(screen.getByText("标题与节点设置")).not.toBeVisible();
  expect(screen.getByText("绑定项目共享资源")).not.toBeVisible();
  expect(screen.getByText("节点信息与来源")).not.toBeVisible();
  expect(screen.getByText("alice")).not.toBeVisible();
  expect(screen.queryByText("实际模型未知")).not.toBeInTheDocument();
  expect(screen.getByText("尚无本次执行记录")).not.toBeVisible();
  expect(screen.getByRole("button", { name: "发送任务 ↗" })).toBeDisabled();
  fireEvent.change(input, { target: { value: "继续写着的草稿" } });
  expect(screen.getByRole("button", { name: "发送任务 ↗" })).toBeEnabled();
  scroll.scrollTop = 120;
  expect(invoke.mock.calls.filter(([action]) => action === "resources_list")).toHaveLength(1);
  const reads = invoke.mock.calls.filter(([action]) => action === "session_read").length;
  fireEvent.click(menu);
  expect(screen.getByText("标题与节点设置")).toBeVisible();
  expect(screen.getByText("节点信息与来源")).toBeVisible();
  expect(screen.getByLabelText("会话附件")).toBeInTheDocument();
  expect(screen.getByText("原始聊天内容一直保留")).toBe(message);
  expect(input).toHaveValue("继续写着的草稿");
  expect(scroll.scrollTop).toBe(120);
  fireEvent.keyDown(menu, { key: "Escape" });
  expect(screen.getByText("标题与节点设置")).not.toBeVisible();
  expect(invoke.mock.calls.filter(([action]) => action === "session_read")).toHaveLength(reads);
  view.rerender(<div data-testid="window-scroll"><NodeWindow {...props} boot={{ ...props.boot, epoch: 1 }} /></div>);
  await waitFor(() => expect(invoke.mock.calls.filter(([action]) => action === "session_read")).toHaveLength(reads + 1));
  expect(screen.getByText("原始聊天内容一直保留")).toBe(message);
  expect(screen.getByLabelText("Agent 任务")).toBe(input);
  expect(input).toHaveValue("继续写着的草稿");
  expect(scroll.scrollTop).toBe(120);
});

it("keeps a refused send and unsent draft visible with settings closed", async () => {
  const invoke = vi.fn(async (action: string) => {
    if (action === "agent_send") throw new Error("没有项目运行权限");
    return history;
  });
  render(<AgentWindow node={node} call={invoke as Call} epoch={0} storageKey="refused:project" runnable openFile={() => {}} />);
  await screen.findByText("alice");
  const input = screen.getByLabelText("Agent 任务");
  fireEvent.change(input, { target: { value: "请检查证据" } });
  fireEvent.click(screen.getByRole("button", { name: "发送任务 ↗" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("没有项目运行权限");
  expect(screen.getByRole("alert")).toBeVisible();
  expect(input).toHaveValue("请检查证据");
  expect(screen.getByLabelText("会话与节点设置").closest("details")).not.toHaveAttribute("open");
});

it("keeps a background execution failure visible when run receipts are folded", async () => {
  const call = vi.fn(async () => ({ ...history, runs: [{
    id: "failed-run", conversation: "manual:agent-one", status: "failed", trigger: "manual",
    binding: { owner: "alice", version: 1 }, model: null, error: "Runner 拒绝本次执行",
  }] })) as Call;
  render(<AgentWindow node={node} call={call} epoch={0} storageKey="failed-run:project" runnable openFile={() => {}} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Runner 拒绝本次执行");
  expect(screen.getByRole("alert")).toBeVisible();
  expect(screen.getByText("本次执行尚无模型回执")).not.toBeVisible();
  fireEvent.click(screen.getByLabelText("会话与节点设置"));
  expect(screen.getByText("本次执行尚无模型回执")).toBeVisible();
  expect(screen.getByText("运行 failed-run")).not.toBeVisible();
});
