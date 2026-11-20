import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SessionsReply } from "@claude-bot/agent-sessions-contract";
import { RemoteTerminal, type RemoteTerminalProps } from "./RemoteTerminal.js";

const TERMINAL_ID = `term_${"a".repeat(48)}`;
const OPENED: SessionsReply = {
  ok: true,
  message: "",
  result: { terminal_id: TERMINAL_ID, screen: "$ ", closed: false },
};

function props(over: Partial<RemoteTerminalProps> = {}): RemoteTerminalProps {
  return {
    device: "val15",
    workspaces: {
      device: "val15",
      workspaces: [{ id: "ws_octopus", label: "Octopus", display: "/work/octopus" }],
    },
    refusal: "",
    onRefreshWorkspaces: vi.fn(),
    onOpen: vi.fn(async () => OPENED),
    onRead: vi.fn(async () => OPENED),
    onSend: vi.fn(async () => OPENED),
    onClose: vi.fn(async () => ({ ok: true, message: "" })),
    ...over,
  };
}

describe("device terminal tabs", () => {
  it("shows unavailable tmux before spending an opening approval", async () => {
    const value = props();
    value.workspaces!.terminal = { available: false, reason: "设备未安装 tmux，请安装后刷新。" };
    render(<RemoteTerminal {...value} />);
    expect(screen.getByText("设备未安装 tmux，请安装后刷新。")).toBeInTheDocument();
    expect(value.onOpen).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "打开终端" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "刷新工作区" }));
    expect(value.onRefreshWorkspaces).toHaveBeenCalledTimes(1);
    expect(value.onOpen).not.toHaveBeenCalled();
  });

  it("distinguishes an unqueried device from an empty workspace registry", () => {
    const value = props({ workspaces: undefined });
    render(<RemoteTerminal {...value} />);
    expect(screen.getByText(/尚未取得这台设备的工作区列表/)).toBeInTheDocument();
    expect(value.onOpen).not.toHaveBeenCalled();
  });
  it("opens the first projected workspace once and releases the lease when the tab closes", async () => {
    const value = props();
    const view = render(<RemoteTerminal {...value} />);

    await waitFor(() => expect(value.onOpen).toHaveBeenCalledWith("val15", "ws_octopus"));
    expect(await screen.findByText("快速通道已开启")).toBeInTheDocument();

    view.rerender(<RemoteTerminal {...value} />);
    expect(value.onOpen).toHaveBeenCalledTimes(1);

    view.unmount();
    expect(value.onClose).toHaveBeenCalledTimes(1);
    expect(value.onClose).toHaveBeenCalledWith("val15", TERMINAL_ID);
  });

  it("keeps a refusal in the same tab and retries only after an explicit click", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn()
      .mockResolvedValueOnce({ ok: false, code: "approval_required", message: "请先批准这次打开" })
      .mockResolvedValueOnce(OPENED);
    const value = props({ onOpen });
    render(<RemoteTerminal {...value} />);

    expect(await screen.findByText("请先批准这次打开")).toBeInTheDocument();
    expect(onOpen).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "重试打开" }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("快速通道已开启")).toBeInTheDocument();
  });

  it("waits honestly when the device has no registered workspace", async () => {
    const value = props({ workspaces: { device: "val15", workspaces: [] } });
    render(<RemoteTerminal {...value} />);

    expect(screen.getByText("这台物理机当前没有可作为起点的已登记工作区。")).toBeInTheDocument();
    expect(value.onOpen).not.toHaveBeenCalled();
  });
});
