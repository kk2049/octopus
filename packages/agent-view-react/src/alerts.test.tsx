/**
 * The failure surface (ticket #191), driven through a real MessagePort.
 *
 * The property under test is a negative one and it is the whole point of the
 * component: after any of these frames, there is no state of this View in which
 * a person is looking at an unchanged screen with no explanation. So the tests
 * are written as "the Host said no / the device failed → somebody has to
 * read a non-blocking notification", plus the three cases where a notification would be WRONG —
 * an approval request, a stale backlog, and an accepted action.
 */

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { MSG } from "@claude-bot/web-trust/frame-protocol";
import type { AgentViewClient } from "./client.js";
import { directHarness, type DirectTestHost } from "./runtime.test-support.js";
import { AgentViewProvider } from "./provider.js";
import { usePropose } from "./hooks.js";
import { AgentViewAlerts } from "./alerts.js";

const connected = directHarness;

function tick(): Promise<void> {
  return act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function App({ action = "start_session" }: { action?: string }) {
  const propose = usePropose();
  return (
    <div>
      <button type="button" onClick={() => void propose(action, { device: "laptop" })}>start</button>
      <textarea aria-label="草稿" />
      <AgentViewAlerts />
    </div>
  );
}

function mount(client: AgentViewClient, action?: string) {
  return render(
    <AgentViewProvider client={client}>
      <App action={action} />
    </AgentViewProvider>,
  );
}

/** Answer the last proposal the View sent, the way the trusted Host would. */
function answering(host: DirectTestHost): { rid(): string } {
  let rid = "";
  host.onmessage = (event) => {
    const msg = event.data as Record<string, unknown>;
    if (msg.t === MSG.propose) rid = String(msg.rid);
  };
  return { rid: () => rid };
}

describe("AgentViewAlerts", () => {
  it("says nothing while nothing has failed", async () => {
    const { client, host } = connected();
    mount(client);
    host.postMessage({ t: MSG.boot, projection: {} });
    await tick();
    expect(screen.queryByRole("region", { name: "有操作没有成功" })).toBeNull();
    client.destroy();
  });

  it("raises the Host's own sentence when a proposal is refused", async () => {
    const { client, host } = connected();
    const answer = answering(host);
    mount(client);
    host.postMessage({ t: MSG.boot, projection: {} });
    await tick();
    await userEvent.click(screen.getByRole("button", { name: "start" }));
    await tick();
    host.postMessage({
      t: MSG.result,
      rid: answer.rid(),
      ok: false,
      code: "action_rejected",
      result: { message: "设备、目录或 CLI 选择无效" },
    });
    await waitFor(() => expect(screen.getByText("设备、目录或 CLI 选择无效")).toBeInTheDocument());
    expect(screen.getByText("start_session")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "知道了" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "有操作没有成功" })).toBeNull());
    client.destroy();
  });

  it("raises an operation that failed AFTER the proposal was accepted", async () => {
    // Ticket #191's actual shape: the click worked, the screen did not change,
    // and the failure arrived later on the operation stream with nothing
    // mounted to render it.
    const { client, host } = connected();
    mount(client);
    host.postMessage({ t: MSG.boot, projection: {} });
    await tick();
    host.postMessage({ t: MSG.op, operation: { id: "op-1", status: "running", operation: "start_session" } });
    await tick();
    expect(screen.queryByRole("region", { name: "有操作没有成功" })).toBeNull();

    host.postMessage({
      t: MSG.op,
      operation: { id: "op-1", status: "failed", operation: "start_session", message: "目录不存在" },
    });
    await waitFor(() => expect(screen.getByText("目录不存在")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "知道了" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "有操作没有成功" })).toBeNull());
    // The Host re-sends the same record as its status advances; a dismissed
    // failure must not come back on the next identical frame.
    host.postMessage({
      t: MSG.op,
      operation: { id: "op-1", status: "failed", operation: "start_session", message: "目录不存在" },
    });
    await tick();
    expect(screen.queryByRole("region", { name: "有操作没有成功" })).toBeNull();
    client.destroy();
  });

  it("stays quiet for approval_required: a pending human decision is not a failure", async () => {
    const { client, host } = connected();
    const answer = answering(host);
    mount(client);
    host.postMessage({ t: MSG.boot, projection: {} });
    await tick();
    await userEvent.click(screen.getByRole("button", { name: "start" }));
    await tick();
    host.postMessage({
      t: MSG.result,
      rid: answer.rid(),
      ok: false,
      code: "approval_required",
      result: { message: "已生成一张待批准卡" },
    });
    await tick();
    expect(screen.queryByText("已生成一张待批准卡")).toBeNull();
    client.destroy();
  });

  it.each([
    ["resource.open_text", "not_text", false],
    ["resource.open_text", "too_large", false],
    ["resource.open_text", "unavailable", true],
    ["start_session", "not_text", true],
  ])("keeps file fallback usable without hiding other refusals: %s/%s", async (action, code, visible) => {
    const { client, host } = connected();
    const answer = answering(host);
    mount(client, action);
    host.postMessage({ t: MSG.boot, projection: {} });
    await tick();
    await userEvent.click(screen.getByRole("button", { name: "start" }));
    await tick();
    host.postMessage({ t: MSG.result, rid: answer.rid(), ok: false, code, result: { message: "文件预览说明" } });
    await tick();
    expect(screen.queryByRole("region", { name: "有操作没有成功" }) !== null).toBe(visible);
    client.destroy();
  });

  it("treats a failure that predates the first render as history, not news", async () => {
    const { client, host } = connected();
    host.postMessage({
      t: MSG.op,
      operation: { id: "op-old", status: "failed", operation: "append_session", message: "上一次的失败" },
    });
    // Before any render: the client accumulates operations on its own, which is
    // exactly the case this rule is about. MessagePort delivery and timers are
    // separate task sources, so a zero-delay timer does not prove that the
    // operation reached the client first (notably on the independent Runner).
    await waitFor(() =>
      expect(client.snapshot().operations.some((operation) => operation.id === "op-old")).toBe(true),
    );
    mount(client);
    await tick();
    expect(screen.queryByText("上一次的失败")).toBeNull();
    // A NEW failure still speaks.
    host.postMessage({
      t: MSG.op,
      operation: { id: "op-new", status: "failed", operation: "append_session", message: "这一次的失败" },
    });
    await waitFor(() => expect(screen.getByText("这一次的失败")).toBeInTheDocument());
    client.destroy();
  });

  it.each(["resource.resolve_path", "resource.list_directory", "resource.open_text", "append_session", "set_session_favorite", "open_terminal"])(
    "keeps typing and other actions available after %s fails", async (action) => {
      const { client, host } = connected();
      const answer = answering(host);
      mount(client, action);
      host.postMessage({ t: MSG.boot, projection: {} });
      await tick();
      await userEvent.click(screen.getByRole("button", { name: "start" }));
      await tick();
      const draft = screen.getByRole("textbox", { name: "草稿" });
      await userEvent.type(draft, "继续");
      host.postMessage({ t: MSG.result, rid: answer.rid(), ok: false, code: "unavailable",
        result: { message: "路径不存在或不可见：aiopslab" } });
      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("路径不存在或不可见：aiopslab"));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.queryByRole("alertdialog")).toBeNull();
      expect(draft).toHaveFocus();
      await userEvent.type(draft, "输入");
      expect(draft).toHaveValue("继续输入");
      const refusedRid = answer.rid();
      await userEvent.click(screen.getByRole("button", { name: /查看详情/ }));
      await userEvent.click(screen.getByRole("button", { name: "收起详情" }));
      await userEvent.click(screen.getByRole("button", { name: "知道了" }));
      await tick();
      expect(answer.rid()).toBe(refusedRid);
      await userEvent.click(screen.getByRole("button", { name: "start" }));
      await tick();
      expect(answer.rid()).not.toBe(refusedRid);
      client.destroy();
    },
  );

  it("bounds what it renders when many things fail at once", async () => {
    const { client, host } = connected();
    mount(client);
    host.postMessage({ t: MSG.boot, projection: {} });
    await tick();
    for (let index = 0; index < 9; index += 1) {
      host.postMessage({
        t: MSG.op,
        operation: { id: `op-${index}`, status: "failed", operation: "open_session", message: `第 ${index} 条` },
      });
    }
    await waitFor(() => expect(screen.getByRole("button", { name: "查看详情（9）" })).toBeInTheDocument());
    expect(document.querySelectorAll("[data-av-alert-kind]")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "查看详情（9）" }));
    expect(screen.getByText("还有 3 条同样没有成功。")).toBeInTheDocument();
    expect(document.querySelectorAll("[data-av-alert-kind]")).toHaveLength(6);
    client.destroy();
  });
});
