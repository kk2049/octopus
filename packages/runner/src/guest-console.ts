/**
 * The guest's console window (`octopus-runner guest console`, 2026-11-13).
 *
 * The guest double-clicks "Claude（Octopus）" or "Codex（Octopus）" and this
 * runs with the bundled Node. It joins the window to the agent's terminal on
 * the owner's host through one gateway tunnel (`guest-terminal.ts`), and,
 * while the window is open, answers the agent's `pc` calls on this PC:
 * PowerShell commands in the user's own session, and file copies.
 *
 * The agent and its files live on the host. Closing the window only
 * detaches: the agent keeps working, and the next window reattaches to it.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import { createWebSocketStream, WebSocket, type RawData } from "ws";
import {
  controlFrame, dataFrame, FrameDecoder, GUEST_TERMINAL_VERSION, MAX_GUEST_FILE_BYTES, watchSilence,
  type GuestAgent,
} from "./guest-terminal.js";

/** The gateway's tunnel broker predates terminals; its wire names still say "model". */
export const GUEST_TUNNEL_GUEST_PROTOCOL = "model-tunnel-guest/v1";
const REGISTER_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_CHARS = 200_000;

export interface ShellResult {
  exit_code: number;
  stdout: string;
  stderr: string;
  timed_out: boolean;
}

export interface GuestConsoleOptions {
  gatewayUrl: string;
  token: () => string;
  agent: GuestAgent;
  input?: NodeJS.ReadableStream & { setRawMode?: (on: boolean) => unknown; isTTY?: boolean };
  output?: NodeJS.WritableStream & { columns?: number; rows?: number; on(event: "resize", listener: () => void): unknown; off(event: "resize", listener: () => void): unknown };
  /** Tests replace the tunnel and the shell. */
  connect?: (gatewayUrl: string, token: string) => Promise<Duplex>;
  shell?: (command: string, timeoutMs: number) => Promise<ShellResult>;
  home?: string;
  sleep?: (ms: number) => Promise<void>;
}

type Outcome = { kind: "exit"; text: string } | { kind: "lost" };

/** Marks a console already reopened in Windows Terminal, so it never loops. */
export const IN_TERMINAL_FLAG = "--in-terminal";

/**
 * The classic Windows console's default fonts (新宋体 on a Chinese system)
 * lack the symbols both TUIs draw (❯ ⏵ ✻ ▐▛ …), which then show as boxes.
 * Windows Terminal falls back across fonts. A console that did not start in
 * it reopens itself in a new Windows Terminal window, when one is installed.
 */
export function windowsTerminalRelaunch(
  argv: readonly string[], agent: string,
  env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, node: string = process.execPath,
): { file: string; args: string[] } | undefined {
  if (platform !== "win32" || env.WT_SESSION || argv.includes(IN_TERMINAL_FLAG) || !env.LOCALAPPDATA) return undefined;
  // An app execution alias: Node cannot stat it, but it starts. Where it is
  // missing, starting it fails and the console stays where it is.
  const wt = path.win32.join(env.LOCALAPPDATA, "Microsoft", "WindowsApps", "wt.exe");
  const title = `${agent === "codex" ? "Codex" : "Claude"}（Octopus）`;
  return { file: wt, args: ["-w", "new", "new-tab", "--title", title, "--suppressApplicationTitle", node, ...argv, IN_TERMINAL_FLAG] };
}

/** Start the Windows Terminal copy; false if it could not be started (keep going here). */
export function relaunchInWindowsTerminal(plan: { file: string; args: string[] }): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(plan.file, plan.args, { detached: true, stdio: "ignore", windowsHide: false });
      child.once("spawn", () => { child.unref(); resolve(true); });
      child.once("error", () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}

/** Runs until the window closes (or the device's registration is gone: exit code 1). */
export async function runGuestConsole(options: GuestConsoleOptions): Promise<number> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const connect = options.connect ?? openGuestTunnel;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const name = options.agent === "claude" ? "Claude" : "Codex";
  const say = (text: string): void => { output.write(`\r\n\x1b[0m[Octopus] ${text}\r\n`); };
  output.write(`\x1b]0;${name}（Octopus）\x07`);
  input.setRawMode?.(true);
  input.resume();
  // One listener for the whole run; keys go to the session, or to a prompt between sessions.
  let sink: ((chunk: Buffer) => void) | null = null;
  input.on("data", (chunk: Buffer | string) => sink?.(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  const waitEnter = (): Promise<void> => new Promise((resolve) => {
    sink = (chunk) => {
      if (chunk.includes(0x03)) process.exit(0);
      if (chunk.includes(0x0d) || chunk.includes(0x0a)) { sink = null; resolve(); }
    };
  });
  say(`正在连接 ${name}……`);
  let backoff = 1_000;
  for (;;) {
    let stream: Duplex;
    try {
      stream = await connect(options.gatewayUrl, options.token());
      backoff = 1_000;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if ((error as { refusal?: string }).refusal === "unauthorized") {
        say(`${message}。这台电脑在 Octopus 上的登记已失效，请联系给你安装包的人。按回车关闭。`);
        await waitEnter();
        input.setRawMode?.(false);
        return 1;
      }
      say(`暂时连不上（${message}），${Math.round(backoff / 1000)} 秒后重试。关闭窗口即可退出。`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 30_000);
      continue;
    }
    const outcome = await new Promise<Outcome>((resolve) => {
      const decoder = new FrameDecoder();
      const size = () => ({ cols: output.columns || 120, rows: output.rows || 30 });
      stream.write(controlFrame({ t: "hello", v: GUEST_TERMINAL_VERSION, agent: options.agent, ...size() }));
      sink = (chunk) => { stream.write(dataFrame(chunk)); };
      const onResize = (): void => { stream.write(controlFrame({ t: "resize", ...size() })); };
      output.on("resize", onResize);
      let exitText: string | undefined;
      stream.on("data", (chunk: Buffer) => {
        let frames;
        try {
          frames = decoder.push(chunk);
        } catch {
          stream.destroy();
          return;
        }
        for (const frame of frames) {
          if (frame.kind === "data") output.write(frame.bytes);
          else if (frame.message.t === "exit") exitText = String(frame.message.text ?? "");
          else if (frame.message.t === "call") void answer(stream, frame.message, frame.attachment, options);
        }
      });
      stream.on("error", () => stream.destroy());
      // The host hung up (a WebSocket stream ends before it closes).
      stream.once("end", () => stream.destroy());
      stream.once("close", () => {
        sink = null;
        output.off("resize", onResize);
        resolve(exitText === undefined ? { kind: "lost" } : { kind: "exit", text: exitText });
      });
    });
    if (outcome.kind === "exit") {
      say(`${outcome.text || `${name} 已退出`}。按回车开始新会话，或直接关闭窗口。`);
      await waitEnter();
      say(`正在连接 ${name}……`);
      continue;
    }
    say("连接断开，正在重连……");
    await sleep(1_000);
  }
}

/** One `pc` call from the agent, answered on this PC. */
async function answer(stream: Duplex, message: Record<string, unknown>, attachment: Buffer, options: GuestConsoleOptions): Promise<void> {
  const id = message.id;
  const args = message.args && typeof message.args === "object" ? message.args as Record<string, unknown> : {};
  const reply = (frame: Buffer): void => { if (!stream.destroyed) stream.write(frame); };
  try {
    if (message.op === "powershell") {
      const timeout = Math.min(Math.max(Number(args.timeout_ms) || 120_000, 1_000), 1_800_000);
      const value = await (options.shell ?? runPowershell)(String(args.command ?? ""), timeout);
      return reply(controlFrame({ t: "result", id, ok: true, value }));
    }
    const target = pcPath(String(args.path ?? ""), options.home ?? os.homedir());
    if (message.op === "read_file") {
      const info = await stat(target).catch(() => undefined);
      if (!info?.isFile()) throw new Error(`${target} 不是文件`);
      if (info.size > MAX_GUEST_FILE_BYTES) throw new Error(`${target} 超过 64 MiB`);
      return reply(controlFrame({ t: "result", id, ok: true, value: { path: target } }, await readFile(target)));
    }
    if (message.op === "write_file") {
      if (args.overwrite !== true && await stat(target).then(() => true, () => false)) {
        throw new Error(`${target} already exists on the PC; pass overwrite: true to replace it`);
      }
      await mkdir(path.dirname(target), { recursive: true });
      const temp = `${target}.octopus-${process.pid}`;
      await writeFile(temp, attachment);
      await rename(temp, target);
      return reply(controlFrame({ t: "result", id, ok: true, value: { path: target } }));
    }
    throw new Error(`unknown operation ${String(message.op)}`);
  } catch (error) {
    reply(controlFrame({ t: "result", id, ok: false, error: error instanceof Error ? error.message : String(error) }));
  }
}

/** Absolute paths as given; relative ones, `~` and `%VAR%` resolved against the user's home. */
export function pcPath(raw: string, home: string): string {
  const value = raw.trim();
  if (!value) throw new Error("path is required");
  const expanded = value
    .replace(/^~(?=$|[\\/])/, home)
    .replace(/%([A-Za-z0-9_]+)%/g, (whole, name: string) => process.env[name] ?? whole);
  return path.resolve(home, expanded);
}

/**
 * Windows PowerShell 5.1 in the user's own session. The script travels as
 * -EncodedCommand (no quoting), output is forced to UTF-8 (a Chinese system
 * would otherwise answer in GBK), and a timeout kills the whole tree.
 */
export function runPowershell(command: string, timeoutMs: number): Promise<ShellResult> {
  const script = [
    "$ProgressPreference = 'SilentlyContinue'",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "$OutputEncoding = [Console]::OutputEncoding",
    command,
  ].join("\n");
  return new Promise((resolve) => {
    const child = spawn("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64"),
    ], { cwd: os.homedir(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const out = { stdout: "", stderr: "" };
    let timedOut = false;
    for (const key of ["stdout", "stderr"] as const) {
      child[key].setEncoding("utf8");
      child[key].on("data", (chunk: string) => { out[key] = keepEnds(out[key] + chunk); });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ exit_code: -1, stdout: out.stdout, stderr: `${out.stderr}${error.message}`, timed_out: timedOut });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ exit_code: code ?? -1, stdout: out.stdout, stderr: out.stderr, timed_out: timedOut });
    });
  });
}

/** Keep the first and last part of a long output. */
function keepEnds(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  const half = MAX_OUTPUT_CHARS / 2;
  return `${text.slice(0, half)}\n[... output truncated ...]\n${text.slice(-half)}`;
}

/**
 * One outbound WebSocket to the gateway, authenticated with this device's
 * token. Once the gateway joins it to the owner's host, it is a byte stream.
 */
export function openGuestTunnel(gatewayUrl: string, token: string): Promise<Duplex> {
  const ws = new WebSocket(gatewayUrl, {
    // The guest's line is often a home connection; terminal output compresses well.
    perMessageDeflate: { threshold: 1024 },
    handshakeTimeout: REGISTER_TIMEOUT_MS,
  });
  return new Promise<Duplex>((resolve, reject) => {
    let settled = false;
    const done = (error: Error | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.off("message", onMessage);
      if (error) {
        ws.terminate();
        reject(error);
        return;
      }
      const stream = createWebSocketStream(ws, { encoding: undefined });
      stream.on("error", () => ws.terminate());
      watchSilence(ws);
      resolve(stream);
    };
    const timer = setTimeout(() => done(new Error("连接 Octopus 超时")), REGISTER_TIMEOUT_MS);
    const onMessage = (data: RawData, isBinary: boolean): void => {
      if (isBinary) return;
      let value: Record<string, unknown>;
      try { value = JSON.parse(String(data)) as Record<string, unknown>; } catch { return; }
      if (value.type === "registered" && value.protocol === GUEST_TUNNEL_GUEST_PROTOCOL) done(null);
      else if (value.type === "error") {
        done(Object.assign(new Error(String(value.message ?? "Octopus 拒绝了连接")),
          typeof value.code === "string" ? { refusal: value.code } : {}));
      }
    };
    ws.on("message", onMessage);
    ws.once("open", () => ws.send(JSON.stringify({ type: "register", protocol: GUEST_TUNNEL_GUEST_PROTOCOL, token })));
    ws.once("error", (error) => done(new Error(`无法连接 Octopus：${error.message}`)));
    ws.once("close", (code, reason) => done(new Error(reason.toString() || `Octopus 关闭了连接 (${code})`)));
  });
}
