/**
 * CLI adapters — Claude Code and Codex behind the same LoopAdapter face.
 *
 * Why CLI turns at all (devpipe's reasoning, inherited): the session JSONL
 * lands in the CLI's own home, so the rich transcript (thinking, file writes,
 * subagents) exists for free and outlives any process. A page agent on the
 * claude-code adapter is a full development-grade agent — same trust model as
 * devpipe's bot-host dev agents: same OS user, visible transcript, prompt
 * discipline; its cwd is a per-agent scratch workdir so relative file ops
 * land somewhere harmless.
 *
 * Tools still go through the ONE door: a per-turn shim token resolves back to
 * this turn's callTool over loopback HTTP (shim-registry), so predicates and
 * authorship are enforced in-process exactly as for the openai loop.
 *
 * Difficulty notes live in doc/v3-probe-report.md (adapter section); the
 * juicy ones: codex won't tell you the new session id (we discover the
 * rollout file by mtime), and codex MCP config rides `-c` TOML overrides
 * where quoting is a minefield (hence tool defs travel by file, not env).
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { mintShimToken, revokeShimToken } from "./shim-registry.js";
import type { LoopAdapter, TurnRequest } from "./plane.js";

export interface BuiltCommand {
  bin: string;
  args: string[];
}

export interface CliState {
  kind: string;
  sessionId?: string;
  cwd?: string;
  /** Path of the CLI's own session JSONL — the rich-transcript source. */
  transcriptPath?: string;
}

/** Claude Code's project-dir encoding: every non-alphanumeric byte becomes "-". */
export function claudeTranscriptDir(cwd: string): string {
  return path.join(os.homedir(), ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
}

export function buildClaudeTurn(opts: {
  prompt: string;
  sessionId: string;
  resume: boolean;
  mcpConfigPath?: string;
  model?: string;
  effort?: string;
}): BuiltCommand {
  const args = [
    "-p",
    opts.prompt,
    "--output-format",
    "json",
    "--dangerously-skip-permissions",
    "--disallowed-tools",
    "Skill",
    "--disable-slash-commands",
  ];
  if (opts.resume) args.push("--resume", opts.sessionId);
  else args.push("--session-id", opts.sessionId);
  if (opts.mcpConfigPath) args.push("--mcp-config", opts.mcpConfigPath, "--strict-mcp-config");
  if (opts.model) args.push("--model", opts.model);
  if (opts.effort) args.push("--effort", opts.effort);
  return { bin: "claude", args };
}

export interface CliMcpServer {
  command: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
}

/**
 * One MCP server as Codex per-invocation `-c` TOML overrides.
 *
 * This is shared by Engine agents and trusted DevPipe agents. Claude accepts a
 * JSON config file directly; Codex needs the same typed server definition
 * translated to argv. Keeping that translation here prevents every privileged
 * caller from inventing a subtly different TOML quoting rule.
 */
export function codexMcpServerOverrides(name: string, server: CliMcpServer): string[] {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`invalid Codex MCP server name: ${name}`);
  if (!server.command.trim()) throw new Error(`Codex MCP server ${name} requires a command`);
  const prefix = `mcp_servers.${name}`;
  const args = ["-c", `${prefix}.command=${JSON.stringify(server.command)}`];
  if (server.args?.length) args.push("-c", `${prefix}.args=${JSON.stringify([...server.args])}`);
  const env = Object.entries(server.env ?? {});
  if (env.length) {
    for (const [key] of env) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`invalid environment name for ${name}: ${key}`);
    }
    const inline = env.map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join(", ");
    args.push("-c", `${prefix}.env={ ${inline} }`);
  }
  return args;
}

/** Codex per-invocation MCP wiring for the Engine's own turn shim. */
export function codexMcpOverrides(shim: { shimPath: string; url: string; token: string; toolsFile: string }): string[] {
  return codexMcpServerOverrides("v3", {
    command: "npx",
    args: ["tsx", shim.shimPath],
    env: {
      V3_SHIM_URL: shim.url,
      V3_SHIM_TOKEN: shim.token,
      V3_SHIM_TOOLS_FILE: shim.toolsFile,
    },
  });
}

export function buildCodexTurn(opts: {
  prompt: string;
  sessionId?: string;
  model?: string;
  effort?: string;
  mcpArgs: string[];
  /** Emit machine-readable JSONL events (needed by trusted background hosts). */
  json?: boolean;
  /** Host-level trust decision; ordinary Agentic Apps leave this off. */
  dangerouslyBypassPermissions?: boolean;
  /** Start from the Host's explicit argv instead of ambient user config. */
  ignoreUserConfig?: boolean;
}): BuiltCommand {
  const args = ["exec"];
  if (opts.json) args.push("--json");
  if (opts.sessionId) args.push("resume", opts.sessionId);
  args.push(opts.prompt, "--skip-git-repo-check");
  if (opts.dangerouslyBypassPermissions) args.push("--dangerously-bypass-approvals-and-sandbox");
  if (opts.ignoreUserConfig) args.push("--ignore-user-config");
  if (opts.model) args.push("-m", opts.model);
  if (opts.effort) args.push("-c", `model_reasoning_effort="${opts.effort}"`);
  args.push(...opts.mcpArgs);
  return { bin: "codex", args };
}

/**
 * Codex never prints the new session id; discover the rollout file it wrote.
 * Files live under ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl.
 */
export function findCodexRollout(
  sinceMs: number,
  root = path.join(os.homedir(), ".codex", "sessions"),
): { id: string; file: string } | null {
  // Holder object: TS narrowing does not survive closure mutation of a `let`.
  const best = { v: null as { file: string; mtime: number } | null };
  const walk = (dir: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 4) walk(full, depth + 1);
        continue;
      }
      if (!/^rollout-.*\.jsonl$/.test(e.name)) continue;
      let st: fs.Stats;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (st.mtimeMs < sinceMs - 2_000) continue;
      if (!best.v || st.mtimeMs > best.v.mtime) best.v = { file: full, mtime: st.mtimeMs };
    }
  };
  walk(root, 0);
  if (!best.v) return null;
  const m = /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/.exec(best.v.file);
  return m ? { id: m[1], file: best.v.file } : null;
}

/** Pure session decision: reuse only when the stored state matches this adapter. */
export function decideSession(state: CliState | null, kind: string): { fresh: boolean; sessionId?: string } {
  if (!state || state.kind !== kind || !state.sessionId) return { fresh: true };
  return { fresh: false, sessionId: state.sessionId };
}

interface RunOut {
  stdout: string;
  stderr: string;
}

function run(cmd: BuiltCommand, cwd: string, timeoutMs: number): Promise<RunOut> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      cmd.bin,
      cmd.args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        killSignal: "SIGKILL",
        env: { ...process.env, MCP_TOOL_TIMEOUT: String(10 * 60_000) },
      },
      (err, stdout, stderr) => {
        const e = err as (Error & { code?: number | string | null; killed?: boolean }) | null;
        if (e && (e as { code?: unknown }).code === "ENOENT") {
          reject(new Error(`未找到 ${cmd.bin} 命令（bot 进程 PATH 里没有它）`));
          return;
        }
        if (e) {
          const tail = String(stderr ?? "").slice(-1_500);
          reject(new Error(`${cmd.bin} 退出异常（${e.killed ? "被杀/超时" : `code ${String(e.code)}`}）: ${tail || "无 stderr"}`));
          return;
        }
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
    // codex exec waits for EOF on a piped stdin before doing ANY work
    // ("Reading additional input from stdin..."), which a terminal never
    // reproduces. Close it immediately — for claude it's a harmless no-op.
    child.stdin?.end();
  });
}

const readJson = <T>(file: string): T | null => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
};

export class CliLoop implements LoopAdapter {
  constructor(
    private kind: "claude-code" | "codex",
    private opts: { timeoutMs?: number } = {},
  ) {}

  async runTurn(req: TurnRequest): Promise<string> {
    if (!req.shimBase) throw new Error("CLI adapter 需要 host 的 loopback 地址（shimBase）——独立测试环境未接");
    if (!req.agentDir) throw new Error("CLI adapter 需要 agentDir");
    const workdir = path.join(req.agentDir, "workdir");
    fs.mkdirSync(workdir, { recursive: true });
    const stateFile = path.join(req.agentDir, "cli.json");
    const decision = decideSession(readJson<CliState>(stateFile), this.kind);

    const inbox = req.inboxTexts.join("\n\n");
    const prompt = decision.fresh
      ? `${req.systemPrompt}\n\n——以上是你的角色与纪律。应用动作以 MCP 工具（服务器 v3）提供；先 read_state 再动手。收到的消息：\n\n${inbox}`
      : inbox;

    const token = mintShimToken((name, args) => req.callTool(name, args));
    const turnDir = fs.mkdtempSync(path.join(os.tmpdir(), "v3-cli-turn-"));
    const toolsFile = path.join(turnDir, "tools.json");
    fs.writeFileSync(toolsFile, JSON.stringify(req.tools));
    const shimPath = fileURLToPath(new URL("./mcp-shim.ts", import.meta.url));

    try {
      const extraServers = Object.fromEntries(
        (req.extraMcp ?? []).map((e) => [e.name, { command: e.command, args: e.args, env: e.env ?? {} }]),
      );
      if (this.kind === "claude-code") {
        const mcpConfigPath = path.join(turnDir, "mcp.json");
        fs.writeFileSync(
          mcpConfigPath,
          JSON.stringify({
            mcpServers: {
              v3: {
                command: "npx",
                args: ["tsx", shimPath],
                env: { V3_SHIM_URL: req.shimBase, V3_SHIM_TOKEN: token, V3_SHIM_TOOLS_FILE: toolsFile },
              },
              ...extraServers,
            },
          }),
        );
        // Observability: keep the LAST actual MCP wiring beside the agent —
        // "which servers did this turn really load" must never be a guess.
        fs.copyFileSync(mcpConfigPath, path.join(req.agentDir, "last-mcp.json"));
        const sessionId = decision.fresh ? randomUUID() : decision.sessionId!;
        const cmd = buildClaudeTurn({
          prompt,
          sessionId,
          resume: !decision.fresh,
          mcpConfigPath,
          model: req.model,
          effort: req.effort,
        });
        const out = await run(cmd, workdir, this.opts.timeoutMs ?? 300_000);
        let resultText: string | undefined;
        let reportedId: string | undefined;
        try {
          const doc = JSON.parse(out.stdout.trim()) as Record<string, unknown>;
          if (typeof doc.result === "string") resultText = doc.result;
          if (typeof doc.session_id === "string") reportedId = doc.session_id;
        } catch {
          resultText = out.stdout.trim() || undefined;
        }
        const finalId = reportedId ?? sessionId;
        const state: CliState = {
          kind: this.kind,
          sessionId: finalId,
          cwd: workdir,
          transcriptPath: path.join(claudeTranscriptDir(workdir), `${finalId}.jsonl`),
        };
        fs.writeFileSync(stateFile, JSON.stringify(state));
        return resultText ?? "（空回复）";
      }

      // codex
      const started = Date.now();
      const mcpArgs = codexMcpOverrides({ shimPath, url: req.shimBase, token, toolsFile });
      for (const [name, s] of Object.entries(extraServers)) {
        mcpArgs.push(...codexMcpServerOverrides(name, s));
      }
      const cmd = buildCodexTurn({
        prompt,
        sessionId: decision.fresh ? undefined : decision.sessionId,
        model: req.model,
        effort: req.effort,
        mcpArgs,
      });
      const out = await run(cmd, workdir, this.opts.timeoutMs ?? 300_000);
      // machine.ts lesson: some codex builds put everything on stderr.
      let resultText = out.stdout.trim();
      if (!resultText && out.stderr.trim()) resultText = "(来自 stderr) " + out.stderr.trim().slice(-2_000);
      const found = findCodexRollout(started);
      const prev = readJson<CliState>(stateFile);
      const state: CliState = {
        kind: this.kind,
        sessionId: found?.id ?? (decision.fresh ? undefined : decision.sessionId),
        cwd: workdir,
        transcriptPath: found?.file ?? (decision.fresh ? undefined : prev?.transcriptPath),
      };
      fs.writeFileSync(stateFile, JSON.stringify(state));
      if (decision.fresh && !found) {
        resultText += "\n\n（注：未能定位本轮的 codex 会话文件，下一轮将重新开会话）";
      }
      return resultText || "（空回复）";
    } finally {
      revokeShimToken(token);
      fs.rmSync(turnDir, { recursive: true, force: true });
    }
  }
}
