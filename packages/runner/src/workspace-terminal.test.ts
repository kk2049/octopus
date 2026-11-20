import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addWorkspace } from "./workspaces.js";
import { WorkspaceTerminalManager } from "./workspace-terminal.js";
import { runTerminalCommand } from "./terminal-control.js";
import { handleRpc } from "./core.js";
const LEASE = `lease_${"a".repeat(48)}`;

const homes: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("WorkspaceTerminalManager", () => {
  it("reports missing tmux before opening, through the workspace RPC, without creating a shell", async () => {
    const home = mkdtempSync(join(tmpdir(), "runner-terminal-"));
    homes.push(home);
    const workspace = await addWorkspace(home, home, "Home");
    const run = vi.fn(async () => { throw new Error("tmux could not start"); });
    const terminals = new WorkspaceTerminalManager(home, { run });
    const reply = await handleRpc(home, { id: "ready", method: "list_session_workspaces", args: {} },
      { allowMachineOps: true, executionOnly: true, workspaceTerminals: terminals });
    expect(reply).toMatchObject({ ok: true, result: {
      terminal: { available: false, reason: expect.stringContaining("未安装 tmux") },
    } });
    await expect(terminals.execute({ action: "open", lease_id: LEASE, workspace_id: workspace.id }))
      .rejects.toThrow("未安装 tmux");
    expect(run.mock.calls.every((call) => !JSON.stringify(call).includes("new-session"))).toBe(true);

    run.mockClear();
    const disabled = await handleRpc(home, { id: "disabled", method: "list_session_workspaces", args: {} },
      { allowMachineOps: false, workspaceTerminals: terminals });
    expect(disabled).toMatchObject({ ok: true, result: { terminal: { available: false, reason: "这台设备未开启远端终端操作。" } } });
    expect(run).not.toHaveBeenCalled();
  });

  it.skipIf(spawnSync("tmux", ["-V"]).status !== 0)("opens, writes, claims and closes a real isolated tmux shell", async () => {
    const home = mkdtempSync(join(tmpdir(), "runner-terminal-"));
    homes.push(home);
    const workspace = await addWorkspace(home, home, "Home");
    const socket = `octopus-test-${process.pid}-${Date.now()}`;
    const run = (bin: string, args: string[], input?: string) =>
      runTerminalCommand(bin, ["-L", socket, "-f", "/dev/null", ...args], input);
    const terminal = new WorkspaceTerminalManager(home, { run });
    try {
      await expect(terminal.availability()).resolves.toEqual({ available: true });
      const opened = await terminal.execute({ action: "open", lease_id: LEASE, workspace_id: workspace.id });
      const sent = await terminal.execute({ action: "input", lease_id: LEASE,
        terminal_id: opened.terminal_id, input: "printf '\\157\\143\\164\\157\\160\\165\\163\\055\\164\\145\\162\\155\\151\\156\\141\\154\\055\\157\\153\\n'" });
      expect(sent.closed).toBe(false);
      await vi.waitFor(async () => {
        const claimed = await terminal.execute({ action: "claim", lease_id: LEASE });
        expect(claimed.terminal_id).toBe(opened.terminal_id);
        expect(claimed.screen).toContain("octopus-terminal-ok");
      });
      await expect(terminal.execute({ action: "close", lease_id: LEASE, terminal_id: opened.terminal_id }))
        .resolves.toMatchObject({ closed: true });
      await expect(terminal.execute({ action: "claim", lease_id: LEASE })).rejects.toThrow("已经关闭");
    } finally {
      await run("tmux", ["kill-server"]).catch(() => {});
    }
  });

  it("opens one opaque workspace shell and carries later input without another path", async () => {
    const home = mkdtempSync(join(tmpdir(), "runner-terminal-"));
    homes.push(home);
    const root = join(home, "project");
    mkdirSync(root, { recursive: true });
    const workspace = await addWorkspace(home, root, "Project");
    let screen = "$ ";
    const run = vi.fn(async (_bin: string, args: string[], input?: string) => {
      if (args[0] === "list-sessions") return { stdout: "octopus-web-stale\nunrelated\n" };
      if (args[0] === "new-session") return { stdout: "%1\n" };
      if (args[0] === "load-buffer") {
        screen += input;
        return { stdout: "" };
      }
      if (args[0] === "capture-pane") return { stdout: screen };
      return { stdout: "" };
    });
    const terminal = new WorkspaceTerminalManager(home, { run });

    const opened = await terminal.execute({
      action: "open",
      lease_id: LEASE,
      workspace_id: workspace.id,
      cols: 100,
      rows: 28,
    });
    expect(opened).toMatchObject({ closed: false, screen: "$ " });
    expect(opened.terminal_id).toMatch(/^term_[0-9a-f]{48}$/);
    expect(run).toHaveBeenCalledWith("tmux", expect.arrayContaining(["new-session", "-c", root, "-x", "100", "-y", "28"]));
    expect(run).toHaveBeenCalledWith("tmux", ["kill-session", "-t", "octopus-web-stale"]);

    await expect(terminal.execute({ action: "claim", lease_id: LEASE }))
      .resolves.toEqual(opened);
    await expect(terminal.execute({
      action: "read",
      lease_id: `lease_${"b".repeat(48)}`,
      terminal_id: opened.terminal_id,
    })).rejects.toThrow("不属于当前授权通道");

    const command = "printf 'a;b'";
    const result = await terminal.execute({
      action: "input",
      lease_id: LEASE,
      terminal_id: opened.terminal_id,
      input: command,
    });
    expect(result.screen).toContain(command);
    expect(run).toHaveBeenCalledWith("tmux", expect.arrayContaining(["load-buffer"]), command);
    expect(run).toHaveBeenCalledWith("tmux", ["send-keys", "-t", "%1", "C-m"]);
    expect(run.mock.calls.filter(([, args]) => args[0] === "new-session")).toHaveLength(1);

    await expect(terminal.execute({ action: "close", lease_id: LEASE, terminal_id: opened.terminal_id }))
      .resolves.toEqual({ terminal_id: opened.terminal_id, screen: "", closed: true });
    await expect(terminal.execute({ action: "read", lease_id: LEASE, terminal_id: opened.terminal_id }))
      .rejects.toThrow("已经关闭或过期");
  });

  it("expires an idle shell before accepting another command", async () => {
    const home = mkdtempSync(join(tmpdir(), "runner-terminal-"));
    homes.push(home);
    const root = join(home, "project");
    mkdirSync(root, { recursive: true });
    const workspace = await addWorkspace(home, root, "Project");
    let now = 1_000;
    const run = vi.fn(async (_bin: string, args: string[]) => {
      if (args[0] === "new-session") return { stdout: "%2\n" };
      if (args[0] === "capture-pane") return { stdout: "$ " };
      return { stdout: "" };
    });
    const terminal = new WorkspaceTerminalManager(home, { run, now: () => now });
    const opened = await terminal.execute({ action: "open", lease_id: LEASE, workspace_id: workspace.id });

    now += 30 * 60_000 + 1;
    await expect(terminal.execute({ action: "read", lease_id: LEASE, terminal_id: opened.terminal_id }))
      .rejects.toThrow("已经关闭或过期");
    expect(run).toHaveBeenCalledWith("tmux", ["kill-session", "-t", expect.stringMatching(/^octopus-web-/)]);
  });
});
