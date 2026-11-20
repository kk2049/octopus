import { randomBytes } from "node:crypto";
import { resolveWorkspace } from "./workspaces.js";
import { MACHINE_LIMITS } from "./limits.js";
import { runTerminalCommand } from "./terminal-control.js";

const SESSION_PREFIX = "octopus-web-";
const TERMINAL_ID = /^term_[0-9a-f]{48}$/;
const LEASE_ID = /^lease_[0-9a-f]{48}$/;
const MAX_TERMINALS = 4;
const MAX_CAPTURE_BYTES = 128 * 1024;
const IDLE_TTL_MS = 30 * 60_000;

interface TerminalRecord {
  id: string;
  leaseId: string;
  session: string;
  pane: string;
  touchedAt: number;
}

export interface WorkspaceTerminalOptions {
  run?: (bin: string, args: string[], input?: string) => Promise<{ stdout: string }>;
  now?: () => number;
}

export type WorkspaceTerminalRequest =
  | { action: "open"; lease_id: string; workspace_id: string; cols?: number; rows?: number }
  | { action: "claim"; lease_id: string; cols?: number; rows?: number }
  | { action: "input"; lease_id: string; terminal_id: string; input: string; cols?: number; rows?: number }
  | { action: "read"; lease_id: string; terminal_id: string; cols?: number; rows?: number }
  | { action: "close"; lease_id: string; terminal_id: string };

export interface WorkspaceTerminalSnapshot {
  terminal_id: string;
  screen: string;
  closed: boolean;
}

/**
 * Device-local tmux shells. One opaque id selects one pane; canonical paths and
 * tmux ids never cross the Runner wire.
 */
export class WorkspaceTerminalManager {
  private readonly run: NonNullable<WorkspaceTerminalOptions["run"]>;
  private readonly now: NonNullable<WorkspaceTerminalOptions["now"]>;
  private readonly terminals = new Map<string, TerminalRecord>();
  private startupCleanup: Promise<void> | null = null;

  constructor(private readonly home: string, options: WorkspaceTerminalOptions = {}) {
    this.run = options.run ?? runTerminalCommand;
    this.now = options.now ?? Date.now;
  }

  async availability(): Promise<{ available: boolean; reason?: string }> {
    try {
      await this.run("tmux", ["-V"]);
      return { available: true };
    } catch {
      return { available: false, reason: "设备未安装 tmux，或 Runner 无法执行它；请安装 tmux 并确认 Runner 的 PATH 后刷新工作区。" };
    }
  }

  async execute(value: Readonly<Record<string, unknown>>): Promise<WorkspaceTerminalSnapshot> {
    await this.ensureStartupCleanup();
    await this.pruneIdle();
    const action = String(value.action ?? "");
    const leaseId = String(value.lease_id ?? "");
    if (!LEASE_ID.test(leaseId)) throw new Error("lease_id 无效");
    if (action === "open") return await this.open(value, leaseId);
    if (action === "claim") {
      const terminal = [...this.terminals.values()].find((row) => row.leaseId === leaseId);
      if (!terminal) throw new Error("这个远端终端尚未批准、已经关闭或已经过期");
      terminal.touchedAt = this.now();
      await this.resize(terminal, value.cols, value.rows);
      return await this.capture(terminal);
    }
    const id = String(value.terminal_id ?? "");
    if (!TERMINAL_ID.test(id)) throw new Error("terminal_id 无效");
    const terminal = this.terminals.get(id);
    if (!terminal) throw new Error("这个远端终端已经关闭或过期");
    if (terminal.leaseId !== leaseId) throw new Error("这个远端终端不属于当前授权通道");
    terminal.touchedAt = this.now();

    if (action === "close") {
      this.terminals.delete(id);
      await this.run("tmux", ["kill-session", "-t", terminal.session]).catch(() => {});
      return { terminal_id: id, screen: "", closed: true };
    }
    if (action !== "read" && action !== "input") throw new Error("远端终端动作无效");
    await this.resize(terminal, value.cols, value.rows);
    if (action === "input") await this.send(terminal, value.input);
    return await this.capture(terminal);
  }

  private async open(
    value: Readonly<Record<string, unknown>>,
    leaseId: string,
  ): Promise<WorkspaceTerminalSnapshot> {
    const existing = [...this.terminals.values()].find((row) => row.leaseId === leaseId);
    if (existing) {
      existing.touchedAt = this.now();
      await this.resize(existing, value.cols, value.rows);
      return await this.capture(existing);
    }
    if (this.terminals.size >= MAX_TERMINALS) throw new Error(`同一设备最多同时打开 ${MAX_TERMINALS} 个远端终端`);
    const workspaceId = String(value.workspace_id ?? "");
    const workspace = await resolveWorkspace(this.home, workspaceId);
    const availability = await this.availability();
    if (!availability.available) throw new Error(availability.reason);
    const id = `term_${randomBytes(24).toString("hex")}`;
    const session = `${SESSION_PREFIX}${randomBytes(12).toString("hex")}`;
    const cols = dimension(value.cols, 40, 240, 120);
    const rows = dimension(value.rows, 12, 80, 32);
    const created = await this.run("tmux", [
      "new-session",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-s",
      session,
      "-c",
      workspace.path,
      "-x",
      String(cols),
      "-y",
      String(rows),
    ]);
    const pane = created.stdout.trim();
    if (!/^%\d+$/.test(pane)) {
      await this.run("tmux", ["kill-session", "-t", session]).catch(() => {});
      throw new Error("远端终端没有返回可控制的窗格");
    }
    const terminal: TerminalRecord = { id, leaseId, session, pane, touchedAt: this.now() };
    this.terminals.set(id, terminal);
    return await this.capture(terminal);
  }

  private async send(terminal: TerminalRecord, input: unknown): Promise<void> {
    if (typeof input !== "string" || !input.trim()) throw new Error("终端输入不能为空");
    if (Buffer.byteLength(input, "utf8") > MACHINE_LIMITS.terminalInputMaxBytes) {
      throw new Error("单次终端输入不能超过 16 KiB");
    }
    const buffer = `${SESSION_PREFIX}buffer-${randomBytes(8).toString("hex")}`;
    await this.run("tmux", ["load-buffer", "-b", buffer, "-"], input);
    try {
      await this.run("tmux", ["paste-buffer", "-b", buffer, "-t", terminal.pane, "-d"]);
      await this.run("tmux", ["send-keys", "-t", terminal.pane, "C-m"]);
      // Give an interactive shell one frame to paint the prompt or first output.
      await new Promise<void>((resolve) => setTimeout(resolve, 80));
    } finally {
      await this.run("tmux", ["delete-buffer", "-b", buffer]).catch(() => {});
    }
  }

  private async resize(terminal: TerminalRecord, cols: unknown, rows: unknown): Promise<void> {
    if (cols === undefined && rows === undefined) return;
    await this.run("tmux", [
      "resize-pane",
      "-t",
      terminal.pane,
      "-x",
      String(dimension(cols, 40, 240, 120)),
      "-y",
      String(dimension(rows, 12, 80, 32)),
    ]);
  }

  private async capture(terminal: TerminalRecord): Promise<WorkspaceTerminalSnapshot> {
    try {
      const captured = await this.run("tmux", ["capture-pane", "-p", "-J", "-S", "-1000", "-t", terminal.pane]);
      return {
        terminal_id: terminal.id,
        screen: captured.stdout.slice(-MAX_CAPTURE_BYTES),
        closed: false,
      };
    } catch {
      this.terminals.delete(terminal.id);
      throw new Error("这个远端终端已经结束");
    }
  }

  private async pruneIdle(): Promise<void> {
    const cutoff = this.now() - IDLE_TTL_MS;
    const stale = [...this.terminals.values()].filter((terminal) => terminal.touchedAt < cutoff);
    for (const terminal of stale) {
      this.terminals.delete(terminal.id);
      await this.run("tmux", ["kill-session", "-t", terminal.session]).catch(() => {});
    }
  }

  private ensureStartupCleanup(): Promise<void> {
    if (!this.startupCleanup) {
      this.startupCleanup = this.run("tmux", ["list-sessions", "-F", "#{session_name}"])
        .then(async ({ stdout }) => {
          const stale = stdout.split("\n").filter((name) => name.startsWith(SESSION_PREFIX));
          await Promise.all(stale.map((name) => this.run("tmux", ["kill-session", "-t", name]).catch(() => {})));
        })
        // No tmux server yet is the normal empty state.
        .catch(() => {});
    }
    return this.startupCleanup;
  }
}

function dimension(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}
