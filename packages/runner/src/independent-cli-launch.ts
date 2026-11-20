import { agentCommand } from "./agent-executables.js";
/**
 * Start one provider CLI inside a device-local tmux session.
 *
 * tmux owns the child after this function returns, so replacing or restarting
 * Runner cannot terminate the turn.  The command is pasted through a private
 * tmux buffer rather than interpolated into a `tmux` argv; shell quoting is
 * still required because the pane starts at the user's login shell.
 */

import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentProvider } from "./agent-runtime.js";
import {
  AGENT_PERMISSION_PROFILES,
  type AgentPermissionProfile,
} from "./agent-permissions.js";
import { codexExecPermissionArgs } from "./codex-permissions.js";
import { runTerminalCommand } from "./terminal-control.js";

const SESSION_PREFIX = "octopus-agent-";
const COLS = "220";
const ROWS = "50";

type RunCommand = (bin: string, args: string[], input?: string) => Promise<{ stdout: string }>;

export interface IndependentCliLaunchInput {
  source: AgentProvider;
  cwd: string;
  prompt: string;
  model: string;
  effort: string;
  permissionProfile: AgentPermissionProfile;
  requestId: string;
  /** Claude alone accepts an authoritative id before process start. */
  claudeSessionId?: string;
  supervisionMs: number;
  /** Effective CODEX_HOME; trusted Runner configuration, never an RPC arg. */
  codexHome?: string;
}

export type IndependentCliLaunchResult =
  | { kind: "started"; sessionId: string; pid: number }
  | { kind: "unavailable" }
  | { kind: "failed"; error: string; pid?: number }
  | { kind: "unknown"; error: string; pid?: number };

export interface IndependentCliLaunchOptions {
  run?: RunCommand;
  wait?: (ms: number) => Promise<void>;
}

/** Exact provider CLI argv used inside the pane; never SDK/app-server/RPC. */
export function independentCliCommand(input: IndependentCliLaunchInput): { bin: string; args: string[] } {
  if (input.source === "claude") {
    if (!input.claudeSessionId) throw new Error("Claude 独立 CLI 启动缺少预分配会话 id");
    const common = [
      ...(input.model ? ["--model", input.model] : []),
      ...(input.effort ? ["--effort", input.effort] : []),
      "--session-id",
      input.claudeSessionId,
    ];
    return input.permissionProfile === AGENT_PERMISSION_PROFILES.manual
      ? {
          // Manual mode needs a real TUI so the person can attach to the pane
          // and answer a provider prompt.  It must never become `-p` plus a
          // bypass flag merely because the managed SDK path was skipped.
          bin: "claude",
          args: [...common, "--permission-mode", "manual", input.prompt],
        }
      : {
          bin: "claude",
          args: [
            "-p",
            input.prompt,
            ...common,
            "--output-format",
            "json",
            "--dangerously-skip-permissions",
          ],
        };
  }

  if (input.source === "codex") {
    const tuning = [
      ...(input.model ? ["--model", input.model] : []),
      ...(input.effort ? ["--config", `model_reasoning_effort=${JSON.stringify(input.effort)}`] : []),
    ];
    return input.permissionProfile === AGENT_PERMISSION_PROFILES.manual
      ? {
          // Interactive Codex owns its approval TUI.  Its id is normally
          // learned by the installed hook/session scanner after this RPC; a
          // missing id is indeterminate and is never auto-replayed.
          bin: "codex",
          args: [...codexExecPermissionArgs(input.permissionProfile), ...tuning, input.prompt],
        }
      : {
          bin: "codex",
          args: [
            "exec",
            "--json",
            "--skip-git-repo-check",
            ...codexExecPermissionArgs(input.permissionProfile),
            ...tuning,
            input.prompt,
          ],
        };
  }

  if (input.permissionProfile === AGENT_PERMISSION_PROFILES.manual) {
    throw new Error("omp 独立 CLI 暂不接受手动确认档");
  }
  return {
    bin: "omp",
    args: [
      "-p",
      "--mode",
      "json",
      "--cwd",
      input.cwd,
      "--auto-approve",
      ...(input.model ? ["--model", input.model] : []),
      ...(input.effort ? ["--thinking", input.effort] : []),
      input.prompt,
    ],
  };
}

export async function launchIndependentCliInTmux(
  input: IndependentCliLaunchInput,
  options: IndependentCliLaunchOptions = {},
): Promise<IndependentCliLaunchResult> {
  const run = options.run ?? runTerminalCommand;
  const wait = options.wait ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  // A failed version probe is the only safe fallback point: no pane exists and
  // no prompt could have crossed.  Treat an unusable tmux the same as absent.
  try {
    await run("tmux", ["-V"]);
  } catch {
    return { kind: "unavailable" };
  }

  const codexSessionsRoot = input.codexHome ? path.join(input.codexHome, "sessions") : "";
  const priorCodexFiles = input.source === "codex"
    && input.permissionProfile === AGENT_PERMISSION_PROFILES.manual
    ? await codexRolloutFiles(codexSessionsRoot)
    : new Set<string>();

  const argv = independentCliCommand(input);
  const command = agentCommand(input.source, argv.args);
  const session = `${SESSION_PREFIX}${createHash("sha256").update(input.requestId).digest("hex").slice(0, 24)}`;
  let pane = "";
  let pid: number | undefined;
  try {
    const created = await run("tmux", [
      "new-session",
      "-d",
      "-P",
      "-F",
      "#{pane_id}\t#{pane_pid}",
      "-s",
      session,
      "-c",
      input.cwd,
      "-x",
      COLS,
      "-y",
      ROWS,
    ]);
    const [paneId, panePid] = created.stdout.trim().split("\t");
    pane = paneId ?? "";
    pid = Number(panePid);
    if (!/^%\d+$/.test(pane) || typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1) {
      throw new Error("tmux 没有返回可验证的 Agent pane");
    }
    await run("tmux", ["set-option", "-w", "-t", pane, "remain-on-exit", "on"]);
    await pasteCommand(
      run,
      pane,
      commandLine(command, input.source === "codex" ? input.codexHome : undefined, command.fingerprint === "ambient" ? undefined : command.env.PATH),
    );
  } catch (error) {
    if (pane) await run("tmux", ["kill-session", "-t", session]).catch(() => {});
    return { kind: "failed", error: safeError(error), ...(pid ? { pid } : {}) };
  }

  const knownClaudeId = input.source === "claude" ? input.claudeSessionId : undefined;
  const deadline = Date.now() + Math.max(100, input.supervisionMs);
  do {
    await wait(80);
    let screen = "";
    let status = "";
    try {
      [screen, status] = await Promise.all([
        run("tmux", ["capture-pane", "-p", "-J", "-S", "-1000", "-t", pane]).then((row) => row.stdout),
        run("tmux", ["display-message", "-p", "-t", pane, "#{pane_dead}\t#{pane_dead_status}"])
          .then((row) => row.stdout.trim()),
      ]);
    } catch {
      return {
        kind: "unknown",
        error: "独立 CLI 已提交给 tmux，但 Runner 无法继续观察它；不会自动重发。",
        pid,
      };
    }

    const [dead, exitStatus] = status.split("\t");
    if (input.source === "claude" && dead === "1" && exitStatus !== "0") {
      return {
        kind: "failed",
        error: `claude CLI 在建立会话前退出 (exit ${exitStatus || "unknown"})`,
        pid,
      };
    }

    const reported = input.source === "codex"
      ? sessionIdFromCodexScreen(screen)
        ?? await oneNewCodexSession(codexSessionsRoot, priorCodexFiles)
      : input.source === "omp" ? sessionIdFromOmpScreen(screen) : knownClaudeId;
    if (reported) return { kind: "started", sessionId: reported, pid };

    if (dead === "1") {
      return {
        kind: exitStatus === "0" ? "unknown" : "failed",
        error: exitStatus === "0"
          ? `${input.source} CLI 已结束，但没有报告可验证的会话 id；不会自动重发。`
          : `${input.source} CLI 在报告会话 id 前退出 (exit ${exitStatus || "unknown"})`,
        pid,
      };
    }
  } while (Date.now() < deadline);

  return {
    kind: "unknown",
    error: `${input.source} CLI 已在 tmux 中运行，但尚未报告会话 id；不会自动重发，请刷新会话列表核对。`,
    pid,
  };
}

function commandLine(command: { bin: string; args: string[] }, codexHome?: string, runtimePath?: string): string {
  const entries = [...(codexHome ? [`CODEX_HOME=${codexHome}`] : []), ...(runtimePath ? [`PATH=${runtimePath}`] : [])];
  const environment = entries.length ? ["env", ...entries] : [];
  return `exec ${[...environment, command.bin, ...command.args].map(shellQuote).join(" ")}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function pasteCommand(run: RunCommand, pane: string, command: string): Promise<void> {
  const buffer = `${SESSION_PREFIX}buffer-${randomBytes(8).toString("hex")}`;
  await run("tmux", ["load-buffer", "-b", buffer, "-"], command);
  try {
    await run("tmux", ["paste-buffer", "-b", buffer, "-t", pane, "-d"]);
    await run("tmux", ["send-keys", "-t", pane, "C-m"]);
  } finally {
    await run("tmux", ["delete-buffer", "-b", buffer]).catch(() => {});
  }
}

function sessionIdFromCodexScreen(screen: string): string | null {
  for (const line of screen.split("\n")) {
    const value = jsonObject(line);
    const type = String(value.type ?? "");
    if (!["thread.started", "thread_started", "session.started", "session_started"].includes(type)) continue;
    const payload = object(value.payload);
    const thread = object(value.thread);
    const id = validSessionId(value.thread_id)
      ?? validSessionId(value.session_id)
      ?? validSessionId(payload.thread_id)
      ?? validSessionId(payload.session_id)
      ?? validSessionId(thread.id);
    if (id) return id;
  }
  return null;
}

export function sessionIdFromOmpScreen(screen: string): string | null {
  for (const line of screen.split("\n")) {
    const value = jsonObject(line);
    if (value.type !== "session") continue;
    const id = validSessionId(value.id);
    if (id) return id;
  }
  return null;
}

function jsonObject(line: string): Record<string, unknown> {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 256 * 1024) return {};
  try {
    const value = JSON.parse(trimmed) as unknown;
    return object(value);
  } catch {
    return {};
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function validSessionId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{5,199}$/.test(value) ? value : null;
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(-1_000);
}

async function oneNewCodexSession(root: string, prior: ReadonlySet<string>): Promise<string | null> {
  if (!root) return null;
  const current = await codexRolloutFiles(root);
  const added = [...current].filter((file) => !prior.has(file));
  if (added.length !== 1) return null;
  return /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/
    .exec(added[0])?.[1] ?? null;
}

async function codexRolloutFiles(root: string): Promise<Set<string>> {
  const out = new Set<string>();
  if (!root) return out;
  const walk = async (directory: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(entries.map(async (entry) => {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory() && depth < 4) await walk(file, depth + 1);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) out.add(file);
    }));
  };
  await walk(root, 0);
  return out;
}
