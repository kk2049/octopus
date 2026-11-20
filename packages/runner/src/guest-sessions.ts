/**
 * Guest sessions on the owner's host (`guest-terminal/v1`, 2026-11-13).
 *
 * A guest client (a trusted friend's PC, `runner_guest_profiles`) uses the
 * owner's Claude Code or Codex. The agent runs here, in tmux, as the owner's
 * own user: no other user, no sandbox, no proxy in the model path. Claude uses
 * the owner's own login; Codex uses a Codex home the owner logged in to just
 * for guests (`guest host --codex-home`), so none of the owner's Codex
 * instructions, hooks, MCP servers or history come along. What keeps the
 * agent in its own directory is
 *
 * - a fresh HOME, TMPDIR and working directory under `<root>/guests/<device>`;
 * - a system prompt saying it may work only there;
 * - a PreToolUse guard hook (`guest-guard-script.ts`) that blocks any tool
 *   call naming a protected tree (the owner's home, research data) and ends
 *   the session;
 * - none of the owner's settings, hooks, plugins, CLAUDE.md, MCP servers or
 *   claude.ai connectors: `--setting-sources ""`, `--strict-mcp-config`,
 *   `ENABLE_CLAUDEAI_MCP_SERVERS=false`; for Codex, no plugins and no ChatGPT
 *   connectors.
 *
 * The guest's console window reaches the tmux session through a gateway
 * tunnel (`guest-terminal.ts`). While it is open, the agent can also act on
 * the guest's PC with the `pc` MCP tools, which this host relays over that
 * same tunnel from a loopback HTTPS port; nothing on any PC is reachable when
 * its console is closed.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import { createWebSocketStream, WebSocket, type RawData } from "ws";
import { agentCommand } from "./agent-executables.js";
import { GUEST_GUARD_MJS } from "./guest-guard-script.js";
import { GUEST_LAUNCHER_PY } from "./guest-launcher-script.js";
import { GUEST_PC_MCP_MJS } from "./guest-pc-mcp-script.js";
import {
  controlFrame, dataFrame, FrameDecoder, GUEST_AGENTS, GUEST_TERMINAL_VERSION, MAX_GUEST_FILE_BYTES,
  terminalSize, watchSilence, type GuestAgent, type TerminalFrame,
} from "./guest-terminal.js";
import type { GuestSessionsConfig, ModelEgressConfig, RunnerGuestProvider } from "./install-config.js";

/** The gateway's tunnel broker predates terminals; its wire names still say "model". */
export const GUEST_TUNNEL_HOST_PROTOCOL = "model-tunnel-host/v1";
/** What the gateway checks before offering a guest's tunnel to this host. */
const GUEST_HOST_PROTOCOL = "model-egress/v1";

export interface GuestIdentity {
  device: string;
  providers: RunnerGuestProvider[];
}

export interface GuestRecord {
  device: string;
  /** Authenticates this guest's `pc` MCP server to this host. */
  secret: string;
  providers: RunnerGuestProvider[];
  created_at: string;
}

export const DEFAULT_GUEST_SESSIONS_PORT = 47_830;
const CALL_TIMEOUT_MS = 15 * 60_000;
/** The document skills worth sharing; each is copied into the tools tree's plugin. */
const SHARED_SKILLS = ["pptx", "docx", "xlsx", "pdf"];
/** Trees the guard keeps the agent out of, beyond the guest's own directory. */
const PROTECTED_TREES = ["/home", "/root", "/srv/research", "/srv/research-archive"];
/**
 * Tools that reach past this machine into the owner's account: the owner's other
 * Claude sessions (registered in the shared config directory, with full access),
 * claude.ai projects, cloud routines, design systems, the owner's phone, feedback.
 */
const DENIED_TOOLS = ["ListAgents", "SendMessage", "SendToProject", "SendToProjectContext", "RemoteTrigger", "DesignSync", "PushNotification", "SendFeedback"];

const AGENT_PROVIDER: Record<GuestAgent, RunnerGuestProvider> = { claude: "anthropic", codex: "openai" };
const AGENT_NAME: Record<GuestAgent, string> = { claude: "Claude", codex: "Codex" };

function systemPrompt(home: string, workspace: string, tools: string, alsoReadable = ""): string {
  return [
    "You are working for a guest of this machine's owner. Where things are:",
    "- The user sits at their own Windows PC and sees this terminal through Octopus.",
    `- You run on the owner's server. Work only inside ${home}: your working directory is ${workspace}, and your HOME and TMPDIR are inside ${home} too.`,
    "  Never read, list, search or change anything outside it: not the owner's home (/home), not /root, not /srv/research.",
    `  One exception: the shared tools in ${tools} (your skills with their scripts, the Python and Node libraries) may be read and run, but not changed.`,
    ...(alsoReadable ? [`  ${alsoReadable}`] : []),
    "  A guard checks every tool call; one that touches those places is blocked and ends this session at once.",
    "- The `pc` MCP tools act on the user's PC: run_powershell, fetch_file (PC to here) and send_file (here to PC).",
    "  A path like C:\\... or a file the user drags into the window is on the PC: fetch it first.",
    "  Deliver finished files with send_file, usually to the Desktop or Downloads",
    "  (ask PowerShell for [Environment]::GetFolderPath('Desktop'); it may be under OneDrive),",
    "  say where they are, and open them with Start-Process when that helps.",
    "- Here you have Python 3, Node.js, LibreOffice (`soffice`, for rendering and conversion), CJK fonts, and",
    "  preinstalled document and chart libraries (python-pptx, python-docx, openpyxl, pandas, matplotlib,",
    "  reportlab, pypdf; pptxgenjs, docx, sharp). `pip install` and `npm install` work.",
  ].join("\n");
}

const TMUX_CONF = [
  "# Octopus guest sessions: tmux only keeps the agent alive between connections.",
  "set -g prefix None",
  "unbind-key -a -T prefix",
  "unbind-key -a -T root",
  "set -g status off",
  "set -g mouse off",
  "set -s escape-time 0",
  "set -g history-limit 10000",
  "set -g default-terminal tmux-256color",
  "set -as terminal-features ',xterm-256color:RGB'",
  "# Draw on the console's main screen so its own scrollback keeps working.",
  "set -as terminal-overrides ',*:smcup@:rmcup@'",
  "set -g window-size latest",
  "set -g focus-events on",
  "set -s extended-keys on",
  "set -g set-titles on",
  "set -g set-titles-string '#{session_name} (Octopus)'",
  "set -s exit-empty on",
  "",
].join("\n");

export interface GuestSessionHostOptions {
  config: () => GuestSessionsConfig | undefined;
  /** The logins guests use: the owner's Claude config directory (where the owner's skills are too), and the guests' own Codex home. */
  logins: () => ModelEgressConfig | undefined;
  /** Runner-private directory for guest records and the loopback TLS key. */
  stateDir: string;
  log?: (message: string) => void;
  /** Start the session launcher; tests replace it. */
  spawnLauncher?: (argv: readonly string[]) => ChildProcessWithoutNullStreams;
  /** The owner's Claude Code and Codex executables; resolved from the Runner's agent paths by default. */
  claude?: () => string | undefined;
  codex?: () => string | undefined;
  /** Node for the guard hook and the `pc` MCP server. */
  node?: string;
  python?: string;
}

interface Tools {
  dir: string;
  /** A local plugin with the shared document skills, if any were found. */
  plugin?: string;
  /** The skills in that plugin (Codex finds them through links in the guest's ~/.agents/skills). */
  skills?: string[];
}

interface SessionSpec {
  home: string;
  cwd: string;
  dirs: string[];
  files: Array<{ path: string; text: string; mode?: number; create_only?: boolean }>;
  links: Array<{ path: string; target: string }>;
  env: Record<string, string>;
  nice: number;
  cols: number;
  rows: number;
  argv: string[];
}

export class GuestSessionHost {
  private readonly log: (message: string) => void;
  /** Guest records, re-read when the file changes (the CLI may purge one). */
  private recordsCache: { mtimeMs: number; rows: Map<string, GuestRecord> } = { mtimeMs: -1, rows: new Map() };
  /** Open consoles per guest device; the latest one answers PC tool calls. */
  private readonly consoles = new Map<string, TerminalSession[]>();
  private server: https.Server | null = null;
  private toolsCache: { key: string; tools: Tools } | null = null;

  constructor(private readonly options: GuestSessionHostOptions) {
    this.log = options.log ?? (() => {});
  }

  private get records(): Map<string, GuestRecord> {
    let mtimeMs = 0;
    try { mtimeMs = statSync(this.recordsFile()).mtimeMs; } catch { /* none yet */ }
    if (mtimeMs !== this.recordsCache.mtimeMs) {
      this.recordsCache = { mtimeMs, rows: new Map(readRecords(this.recordsFile()).map((record) => [record.device, record])) };
    }
    return this.recordsCache.rows;
  }

  /** Guests can use this host only with sessions configured and a login named (Claude's, Codex's or both). */
  available(): boolean {
    return Boolean(this.options.config() && this.providers().length);
  }

  /** The inventory segment the gateway checks before offering a guest's tunnel here. */
  advertisement(): { model_egress: { available: true; protocol: typeof GUEST_HOST_PROTOCOL; providers: RunnerGuestProvider[] } } | Record<string, never> {
    return this.available() ? { model_egress: { available: true, protocol: GUEST_HOST_PROTOCOL, providers: this.providers() } } : {};
  }

  private providers(): RunnerGuestProvider[] {
    const logins = this.options.logins();
    return [...(logins?.anthropic ? ["anthropic" as const] : []), ...(logins?.openai ? ["openai" as const] : [])];
  }

  get running(): boolean {
    return this.server !== null;
  }

  /** Start the loopback HTTPS port for the guests' `pc` tools. Rejects if the port is taken. */
  async start(): Promise<void> {
    const config = this.options.config();
    if (!config || this.server) return;
    const tls = this.tlsMaterial();
    const server = https.createServer({ key: tls.key, cert: tls.cert, requestTimeout: 0, headersTimeout: 60_000 },
      (req, res) => { void this.route(req, res); });
    server.on("tlsClientError", () => undefined);
    server.on("clientError", (_error, socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.server = server;
    this.log(`guest sessions: PC tools on https://127.0.0.1:${config.port}`);
  }

  close(): void {
    this.server?.close();
    this.server = null;
    for (const sessions of this.consoles.values()) for (const session of sessions) session.close();
    this.consoles.clear();
  }

  list(): GuestRecord[] {
    return [...this.records.values()].map((record) => ({ ...record, secret: "" }));
  }

  /** End a guest's tmux server (its agents); its directory stays. */
  async stop(device: string): Promise<boolean> {
    const config = this.options.config();
    if (!config || !this.records.has(device)) return false;
    for (const session of this.consoles.get(device) ?? []) session.close();
    // Only this guest's own tmux servers: everything else here is the owner's.
    for (const agent of GUEST_AGENTS) {
      spawnSync("tmux", ["-S", guestTmuxSocket(this.home(config, device), agent), "kill-server"], { stdio: "ignore" });
    }
    return true;
  }

  /** Stop a guest and remove its directory and secret. */
  async purge(device: string): Promise<boolean> {
    const config = this.options.config();
    if (!config || !this.records.has(device)) return false;
    await this.stop(device);
    rmSync(this.home(config, device), { recursive: true, force: true });
    const rows = this.records;
    rows.delete(device);
    this.saveRecords(rows);
    return true;
  }

  /** A guest's console joined through the gateway: run (or reattach) its agent. */
  attach(stream: Duplex, guest: GuestIdentity): void {
    const session = new TerminalSession(guest.device, stream, this.log);
    let started = false;
    session.onHello = (hello) => {
      if (started) return;
      started = true;
      try {
        this.run(session, guest, hello);
      } catch (error) {
        this.log(`guest session ${guest.device} failed: ${error instanceof Error ? error.message : String(error)}`);
        session.exit(`Octopus 无法启动会话：${error instanceof Error ? error.message : String(error)}`);
      }
    };
    session.onClose = () => this.forget(session);
  }

  private run(session: TerminalSession, guest: GuestIdentity, hello: Record<string, unknown>): void {
    const config = this.options.config();
    const logins = this.options.logins();
    if (!config || !logins || !this.available()) throw new Error("这台主机没有开启访客会话");
    if (hello.v !== GUEST_TERMINAL_VERSION) throw new Error("客户端版本不匹配，请重新安装访客客户端");
    const agent: GuestAgent | undefined = hello.agent === "claude" || hello.agent === "codex" ? hello.agent : undefined;
    if (!agent) throw new Error("客户端要的 agent 这台主机不认识");
    const name = AGENT_NAME[agent];
    const loginDir = agent === "claude" ? logins.anthropic?.config_dir : logins.openai?.codex_home;
    if (!loginDir) throw new Error(`这台主机没有提供 ${name}`);
    if (!guest.providers.includes(AGENT_PROVIDER[agent])) throw new Error(`这台访客设备未获准使用 ${name}`);
    const executable = (agent === "claude" ? this.options.claude ?? ownerClaude : this.options.codex ?? ownerCodex)();
    if (!executable) throw new Error(`主机上找不到 ${agent === "claude" ? "Claude Code" : "Codex"}`);
    const record = this.record(guest);
    const tools = this.syncTools(config, logins);
    const home = this.home(config, guest.device);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    rmSync(path.join(home, ".octopus", "terminated.json"), { force: true });
    if (agent === "claude") trustWorkspace(loginDir, path.join(home, "workspace"));
    const spec = guestSessionSpec({
      agent, record, home, port: config.port, tools, executable, loginDir,
      node: this.node(), launchPrefix: config.launch_prefix ?? [], extraEnv: config.env ?? {},
      ...terminalSize(hello.cols, hello.rows),
    });
    const launcher = [this.options.python ?? "/usr/bin/python3", "-I", path.join(tools.dir, "bin", "guest-launcher.py")];
    const child = this.options.spawnLauncher?.(launcher)
      ?? spawn(launcher[0]!, launcher.slice(1), { stdio: ["pipe", "pipe", "pipe"], cwd: home });
    session.bind(child, Buffer.from(JSON.stringify(spec)), () => guardReason(home));
    const list = this.consoles.get(guest.device) ?? [];
    list.push(session);
    this.consoles.set(guest.device, list);
    this.log(`guest session ${guest.device} attached ${agent}`);
  }

  private forget(session: TerminalSession): void {
    const list = (this.consoles.get(session.device) ?? []).filter((entry) => entry !== session);
    if (list.length) this.consoles.set(session.device, list);
    else this.consoles.delete(session.device);
  }

  private record(guest: GuestIdentity): GuestRecord {
    const rows = this.records;
    let record = rows.get(guest.device);
    if (!record) {
      record = { device: guest.device, secret: randomBytes(32).toString("hex"), providers: guest.providers, created_at: new Date().toISOString() };
      rows.set(guest.device, record);
      this.saveRecords(rows);
    } else if (record.providers.join(",") !== guest.providers.join(",")) {
      record.providers = guest.providers;
      this.saveRecords(rows);
    }
    return record;
  }

  private home(config: GuestSessionsConfig, device: string): string {
    return path.join(config.root, "guests", device);
  }

  /** Refresh the shared tree: launcher, guard, `pc` server, tmux config, CA, document skills. */
  private syncTools(config: GuestSessionsConfig, logins: ModelEgressConfig): Tools {
    const key = JSON.stringify([config.root, logins.anthropic?.config_dir]);
    if (this.toolsCache?.key === key) return this.toolsCache.tools;
    const dir = path.join(config.root, "tools");
    for (const target of [config.root, dir, path.join(dir, "bin"), path.join(config.root, "guests")]) {
      mkdirSync(target, { recursive: true });
      chmodSync(target, 0o755);
    }
    writeIfChanged(path.join(dir, "bin", "guest-launcher.py"), GUEST_LAUNCHER_PY);
    writeIfChanged(path.join(dir, "bin", "guard.mjs"), GUEST_GUARD_MJS);
    writeIfChanged(path.join(dir, "bin", "pc-mcp.mjs"), GUEST_PC_MCP_MJS);
    writeIfChanged(path.join(dir, "tmux.conf"), TMUX_CONF);
    writeIfChanged(path.join(dir, "ca.pem"), this.tlsMaterial().ca);
    const plugin = syncSkillsPlugin(dir, logins.anthropic?.config_dir);
    const skills = plugin ? SHARED_SKILLS.filter((name) => existsSync(path.join(plugin, "skills", name, "SKILL.md"))) : [];
    const tools = { dir, ...(plugin ? { plugin, skills } : {}) };
    this.toolsCache = { key, tools };
    return tools;
  }

  private node(): string {
    if (this.options.node) return this.options.node;
    for (const candidate of [process.execPath, "/usr/local/bin/node", "/usr/bin/node"]) {
      if (existsSync(candidate)) return candidate;
    }
    throw new Error("主机上找不到 node");
  }

  private tlsMaterial(): { ca: string; cert: string; key: string } {
    const dir = path.join(this.options.stateDir, "guest-sessions-tls");
    const files = { ca: path.join(dir, "ca.pem"), cert: path.join(dir, "cert.pem"), key: path.join(dir, "key.pem") };
    if (!Object.values(files).every((file) => existsSync(file))) {
      const material = localTlsMaterial();
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      for (const [name, file] of Object.entries(files)) writeFileSync(file, material[name as keyof typeof material], { mode: 0o600 });
    }
    return { ca: readFileSync(files.ca, "utf8"), cert: readFileSync(files.cert, "utf8"), key: readFileSync(files.key, "utf8") };
  }

  private recordsFile(): string {
    return path.join(this.options.stateDir, "guest-sessions.json");
  }

  private saveRecords(rows: Map<string, GuestRecord>): void {
    mkdirSync(this.options.stateDir, { recursive: true, mode: 0o700 });
    const file = this.recordsFile();
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ guests: [...rows.values()] }, null, 2) + "\n", { mode: 0o600 });
    renameSync(temp, file);
    this.recordsCache = { mtimeMs: statSync(file).mtimeMs, rows };
  }

  /** The guest whose secret this request presents, if any. */
  private identify(req: IncomingMessage): GuestRecord | undefined {
    const header = String(req.headers.authorization ?? "");
    const presented = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    if (!presented) return undefined;
    const digest = createHash("sha256").update(presented).digest();
    for (const record of this.records.values()) {
      if (timingSafeEqual(digest, createHash("sha256").update(record.secret).digest())) return record;
    }
    return undefined;
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const record = this.identify(req);
    if (!record) return sendJson(res, 401, { error: "unknown guest" });
    const url = new URL(req.url ?? "/", "https://guest.invalid");
    if (!url.pathname.startsWith("/octopus/pc/")) return sendJson(res, 404, { error: "not found" });
    try {
      await this.pcCall(req, res, record, url);
    } catch (error) {
      sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** A `pc` tool call: relayed to the guest's latest open console. */
  private async pcCall(req: IncomingMessage, res: ServerResponse, record: GuestRecord, url: URL): Promise<void> {
    if (req.method !== "POST") return sendJson(res, 405, { error: "POST only" });
    const op = url.pathname.slice("/octopus/pc/".length);
    const body = await readBody(req, MAX_GUEST_FILE_BYTES);
    const session = (this.consoles.get(record.device) ?? []).filter((entry) => !entry.closed).at(-1);
    if (!session) {
      return sendJson(res, 409, { error: "The user's Octopus window on their PC is closed, so the PC cannot be reached now. Ask them to keep it open." });
    }
    if (op === "run_powershell") {
      const args = JSON.parse(body.toString("utf8") || "{}") as Record<string, unknown>;
      const seconds = Math.min(Math.max(Math.floor(Number(args.timeout_seconds) || 120), 1), 1800);
      const result = await session.call("powershell", { command: String(args.command ?? ""), timeout_ms: seconds * 1000 }, undefined, (seconds + 30) * 1000);
      return sendJson(res, 200, result.value);
    }
    if (op === "read_file") {
      const args = JSON.parse(body.toString("utf8") || "{}") as Record<string, unknown>;
      const result = await session.call("read_file", { path: String(args.pc_path ?? "") });
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": result.attachment.length,
        "x-octopus-pc-path": encodeURIComponent(String(result.value.path ?? "")),
      }).end(result.attachment);
      return;
    }
    if (op === "write_file") {
      const result = await session.call("write_file", {
        path: url.searchParams.get("pc_path") ?? "", overwrite: url.searchParams.get("overwrite") === "1",
      }, body);
      return sendJson(res, 200, { pc_path: result.value.path, bytes: body.length });
    }
    sendJson(res, 404, { error: `unknown PC operation ${op}` });
  }

}

/**
 * One console connection: decodes its frames, relays the terminal to the
 * session launcher, and carries `pc` calls to the console.
 */
class TerminalSession {
  closed = false;
  onHello: (hello: Record<string, unknown>) => void = () => {};
  onClose: () => void = () => {};
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly decoder = new FrameDecoder();
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: { value: Record<string, unknown>; attachment: Buffer }) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private stderr = "";

  constructor(readonly device: string, private readonly stream: Duplex, private readonly log: (message: string) => void) {
    stream.on("data", (chunk: Buffer) => {
      let frames: TerminalFrame[];
      try {
        frames = this.decoder.push(chunk);
      } catch {
        stream.destroy();
        return;
      }
      for (const frame of frames) this.frame(frame);
    });
    stream.once("close", () => this.close());
    stream.once("end", () => stream.destroy());
    stream.on("error", () => stream.destroy());
  }

  bind(child: ChildProcessWithoutNullStreams, spec: Buffer, guardReason: () => string | undefined = () => undefined): void {
    this.child = child;
    child.stdin.on("error", () => undefined);
    child.stdin.write(launcherFrame(3, spec));
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.closed) return;
      if (!this.stream.write(dataFrame(chunk))) {
        child.stdout.pause();
        this.stream.once("drain", () => child.stdout.resume());
      }
    });
    child.stderr.on("data", (chunk: Buffer) => { if (this.stderr.length < 4000) this.stderr += chunk.toString("utf8"); });
    child.once("exit", (code) => {
      this.child = null;
      const detail = this.stderr.trim();
      if (code === 125 || (code !== 0 && detail)) this.log(`guest session ${this.device} launcher exit ${code}: ${detail.slice(0, 500)}`);
      const guard = guardReason();
      if (guard) this.log(`guest session ${this.device} ended by the guard: ${guard}`);
      this.exit(guard ? `会话已被 Octopus 守卫结束（它试图访问工作目录以外的地方：${guard}）`
        : code === 125 ? `会话启动失败：${detail.split("\n").at(-1) ?? ""}` : "");
    });
    if (this.closed) child.stdin.end();
  }

  /** Tell the console why the session ended, then hang up. */
  exit(text: string): void {
    if (this.closed) return;
    this.stream.end(controlFrame({ t: "exit", text }));
    this.close();
  }

  call(op: string, args: Record<string, unknown>, attachment?: Buffer, timeoutMs = CALL_TIMEOUT_MS): Promise<{ value: Record<string, unknown>; attachment: Buffer }> {
    if (this.closed) return Promise.reject(new Error("the user's Octopus window closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("the PC did not answer in time"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.stream.write(controlFrame({ t: "call", id, op, args }, attachment));
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // A hung-up terminal makes tmux detach; the agent keeps running.
    this.child?.stdin.end();
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("the user's Octopus window closed"));
      this.pending.delete(id);
    }
    if (!this.stream.destroyed) this.stream.destroy();
    this.onClose();
  }

  private frame(frame: TerminalFrame): void {
    if (frame.kind === "data") {
      this.child?.stdin.write(launcherFrame(1, frame.bytes));
      return;
    }
    const message = frame.message;
    if (message.t === "hello") this.onHello(message);
    else if (message.t === "resize") {
      this.child?.stdin.write(launcherFrame(2, Buffer.from(JSON.stringify(terminalSize(message.cols, message.rows)))));
    } else if (message.t === "result" && typeof message.id === "number") {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.ok === true) {
        const value = message.value && typeof message.value === "object" ? message.value as Record<string, unknown> : {};
        entry.resolve({ value, attachment: frame.attachment });
      } else {
        entry.reject(new Error(String(message.error ?? "the PC refused the call")));
      }
    }
  }
}

/** The session launcher's stdin framing (see guest-launcher-script.ts). */
function launcherFrame(kind: 1 | 2 | 3, payload: Buffer): Buffer {
  const head = Buffer.alloc(5);
  head.writeUInt8(kind, 0);
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

/** Why the guard ended this guest's last session, if it did. */
function guardReason(home: string): string | undefined {
  try {
    const record = JSON.parse(readFileSync(path.join(home, ".octopus", "terminated.json"), "utf8")) as { reason?: unknown };
    return typeof record.reason === "string" ? record.reason : undefined;
  } catch {
    return undefined;
  }
}

/** Skip Claude's first-run screens for this workspace, in the guests' own global state file. */
function trustWorkspace(configDir: string, workspace: string): void {
  const file = path.join(configDir, ".claude.json");
  let state: Record<string, unknown> = {};
  try { state = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>; } catch { /* first guest */ }
  const projects = (state.projects && typeof state.projects === "object" ? state.projects : {}) as Record<string, Record<string, unknown>>;
  if (state.hasCompletedOnboarding === true && projects[workspace]?.hasTrustDialogAccepted === true) return;
  projects[workspace] = { ...(projects[workspace] ?? {}), hasTrustDialogAccepted: true };
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ ...state, hasCompletedOnboarding: true, theme: state.theme ?? "dark", projects }, null, 2), { mode: 0o600 });
  renameSync(temp, file);
}

/** Everything the launcher needs to (re)attach the guest's Claude or Codex session. Pure; tested directly. */
export function guestSessionSpec(input: {
  agent: GuestAgent; record: GuestRecord; home: string; port: number; tools: Tools;
  /** The owner's Claude Code or Codex executable. */
  executable: string;
  /** The login the agent uses: the owner's Claude config directory, or the guests' own Codex home. */
  loginDir: string;
  node: string; launchPrefix: readonly string[]; cols: number; rows: number;
  /** Operator-chosen extras such as package mirrors; never override the session's own variables. */
  extraEnv?: Record<string, string>;
}): SessionSpec {
  const { agent, record, home, tools, loginDir } = input;
  const workspace = path.join(home, "workspace");
  const octopus = path.join(home, ".octopus");
  const socket = guestTmuxSocket(home, agent);
  const guard = guardCommand(input.node, tools.dir);
  const pcServer = path.join(tools.dir, "bin", "pc-mcp.mjs");
  const env: Record<string, string> = {
    ...input.extraEnv,
    // The shared Python is read-only; the guest's own installs land in its home.
    PIP_USER: "1", PIP_DISABLE_PIP_VERSION_CHECK: "1",
    HOME: home, USER: os.userInfo().username, LOGNAME: os.userInfo().username, SHELL: "/bin/bash",
    PATH: [path.join(tools.dir, "python", "bin"), "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
    LANG: "C.UTF-8", TERM: "xterm-256color", COLORTERM: "truecolor",
    TMPDIR: path.join(home, "tmp"),
    // The agent's own session sockets stay apart from the owner's sessions.
    XDG_RUNTIME_DIR: path.join(home, "run"),
    NODE_PATH: path.join(tools.dir, "node", "node_modules"),
    // Read by the guard hook; on a violation it ends the tmux server on this socket.
    OCTOPUS_GUEST_HOME: home,
    OCTOPUS_GUEST_PROTECTED: JSON.stringify(PROTECTED_TREES),
    OCTOPUS_GUEST_TMUX: socket,
  };
  const files: SessionSpec["files"] = [
    { path: ".octopus/pc.json", text: JSON.stringify({ endpoint: `https://127.0.0.1:${input.port}`, token: record.secret, ca_file: path.join(tools.dir, "ca.pem") }) + "\n" },
  ];
  const links: SessionSpec["links"] = [];
  let agentArgs: string[];
  if (agent === "claude") {
    Object.assign(env, {
      // The owner's own login, used directly; none of the owner's settings (--setting-sources "").
      CLAUDE_CONFIG_DIR: loginDir,
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      DISABLE_AUTOUPDATER: "1",
      // Claude's sockets, scratch and background output; its default /tmp/claude-<uid> is the owner's.
      CLAUDE_CODE_TMPDIR: path.join(home, "tmp"),
      // Artifacts would be published to the owner's claude.ai account, where the guest cannot open them.
      CLAUDE_CODE_DISABLE_ARTIFACT: "1",
      // /login and /logout rewrite the owner's credentials (signing the owner's own sessions out);
      // /feedback and /install-github-app act as the owner.
      DISABLE_LOGIN_COMMAND: "1", DISABLE_LOGOUT_COMMAND: "1", DISABLE_FEEDBACK_COMMAND: "1", DISABLE_INSTALL_GITHUB_APP_COMMAND: "1",
      // Claude's own files for this workspace: large tool results it reads back.
      OCTOPUS_GUEST_ALLOWED: JSON.stringify([tools.dir, claudeProjectDir(loginDir, workspace)]),
    });
    files.push(
      { path: ".octopus/pc-mcp.json", text: JSON.stringify({ mcpServers: { pc: { type: "stdio", command: input.node, args: [pcServer] } } }, null, 2) + "\n" },
      {
        path: ".octopus/claude-settings.json",
        text: JSON.stringify({
          // Local tools run without asking inside the guest's directory; the guard
          // ends the session on the first step outside it. The PC tools still ask.
          permissions: {
            defaultMode: "acceptEdits",
            allow: ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "NotebookEdit", "WebFetch", "WebSearch", "Skill"],
            deny: DENIED_TOOLS,
          },
          // Both default to the owner's ~/.claude, which the guard would (rightly) refuse.
          plansDirectory: ".plans",
          autoMemoryDirectory: path.join(home, "memory"),
          hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: guard, timeout: 15 }] }] },
        }, null, 2) + "\n",
      },
    );
    agentArgs = [
      input.executable,
      "--setting-sources", "",
      "--settings", path.join(octopus, "claude-settings.json"),
      "--strict-mcp-config", "--mcp-config", path.join(octopus, "pc-mcp.json"),
      ...(tools.plugin ? ["--plugin-dir", tools.plugin] : []),
      "--append-system-prompt", systemPrompt(home, workspace, tools.dir),
    ];
  } else {
    // Codex's built-in skills, and the images it generates before copying them out.
    const codexFiles = [path.join(loginDir, "skills"), path.join(loginDir, "generated_images")];
    Object.assign(env, { CODEX_HOME: loginDir, OCTOPUS_GUEST_ALLOWED: JSON.stringify([tools.dir, ...codexFiles]) });
    // The shared document skills, where Codex looks for a user's own skills.
    for (const name of tools.plugin ? tools.skills ?? [] : []) {
      links.push({ path: `.agents/skills/${name}`, target: path.join(tools.plugin!, "skills", name) });
    }
    const prompt = systemPrompt(home, workspace, tools.dir, `Codex's own files in ${codexFiles.join(" and ")} may be read too.`);
    agentArgs = [
      input.executable,
      // In this process: no shared background server that would outlive the tmux session.
      "--no-daemon",
      // Codex runs only hooks someone trusted in its UI; this one is set right here, by the host.
      "--dangerously-bypass-hook-trust",
      // Local commands run without asking (the guard watches them); the PC tools still ask.
      "--sandbox", "danger-full-access", "--ask-for-approval", "on-request",
      // No plugins, and none of the owner's ChatGPT connectors.
      "--disable", "plugins", "--disable", "remote_plugin", "--disable", "apps",
      // Its update prompt would run `npm install -g` over the owner's own Codex.
      "-c", "check_for_update_on_startup=false",
      // Every session starts at the standard tier; /fast stays a choice made inside a session.
      "-c", `service_tier=${tomlString("default")}`,
      "-c", `developer_instructions=${tomlString(prompt)}`,
      "-c", `hooks.PreToolUse=[{ matcher = "*", hooks = [{ type = "command", command = ${tomlString(guard)}, timeout = 15 }] }]`,
      "-c", `mcp_servers.pc.command=${tomlString(input.node)}`,
      "-c", `mcp_servers.pc.args=[${tomlString(pcServer)}]`,
    ];
  }
  return {
    home, cwd: workspace,
    dirs: ["workspace", "tmp", "run", "memory", ".octopus", ".cache"],
    files, links, env, nice: 10,
    cols: input.cols, rows: input.rows,
    argv: [
      "tmux", "-S", socket, "-f", path.join(tools.dir, "tmux.conf"),
      "new-session", "-A", "-s", agent, "-c", workspace, "--", ...input.launchPrefix, ...agentArgs,
    ],
  };
}

/**
 * Each agent of a guest has its own tmux server. A new session's command gets
 * the environment its tmux server started with, not its own launcher's, so on
 * a shared server the second agent would run with the first one's
 * (Claude without CLAUDE_CONFIG_DIR asks to log in; Codex without CODEX_HOME too).
 */
export function guestTmuxSocket(home: string, agent: GuestAgent): string {
  return path.join(home, ".octopus", `tmux-${agent}.sock`);
}

/**
 * The guard hook's command. If the guard cannot run at all, the call is
 * blocked rather than waved through: both agents block on exit 2 with a reason
 * on stderr (Codex treats an exit 2 without one as a failed hook).
 */
function guardCommand(node: string, tools: string): string {
  return `${shellQuote(node)} ${shellQuote(path.join(tools, "bin", "guard.mjs"))} || { echo "Octopus guard could not run, so this call was blocked." >&2; exit 2; }`;
}

/** A TOML basic string for a Codex `-c` value (JSON's string escapes are valid TOML). */
function tomlString(text: string): string {
  return JSON.stringify(text);
}

/** Where Claude keeps its own files for one working directory (transcripts, large tool results). */
export function claudeProjectDir(configDir: string, cwd: string): string {
  return path.join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
}

function shellQuote(text: string): string {
  return /^[\w@%+=:,./-]+$/.test(text) ? text : "'" + text.replace(/'/g, "'\\''") + "'";
}

/** The owner's Claude Code executable, as the Runner itself would start it. */
export function ownerClaude(): string | undefined {
  return ownerExecutable("claude");
}

/** The owner's Codex executable (the npm launcher script: it finds its own bundled tools). */
export function ownerCodex(): string | undefined {
  return ownerExecutable("codex");
}

function ownerExecutable(provider: "claude" | "codex"): string | undefined {
  try {
    const entry = onPath(agentCommand(provider, []).entry);
    return existsSync(entry) ? realpathSync(entry) : undefined;
  } catch {
    return undefined;
  }
}

/** The owner's document skills as a local plugin (`--plugin-dir`); the owner's other skills stay out. */
function syncSkillsPlugin(dir: string, claudeConfigDir: string | undefined): string | undefined {
  const plugin = path.join(dir, "docs-plugin");
  const found = claudeConfigDir ? findSkills(path.join(claudeConfigDir, "skills"), SHARED_SKILLS) : new Map<string, string>();
  for (const [name, source] of found) {
    const target = path.join(plugin, "skills", name);
    const seconds = (file: string) => existsSync(file) ? Math.floor(statSync(file).mtimeMs / 1000) : -1;
    if (seconds(path.join(target, "SKILL.md")) === seconds(path.join(source, "SKILL.md"))) continue;
    // Swap in a complete copy: running agents may be reading the old one.
    const fresh = `${target}.${process.pid}.new`;
    const stale = `${target}.${process.pid}.old`;
    rmSync(fresh, { recursive: true, force: true });
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(source, fresh, { recursive: true, preserveTimestamps: true, dereference: true });
    chmodTree(fresh);
    if (existsSync(target)) renameSync(target, stale);
    renameSync(fresh, target);
    rmSync(stale, { recursive: true, force: true });
  }
  if (!existsSync(path.join(plugin, "skills"))) return undefined;
  mkdirSync(path.join(plugin, ".claude-plugin"), { recursive: true });
  writeIfChanged(path.join(plugin, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "octopus-guest-docs", version: "1.0.0", description: "Document skills for Octopus guest sessions" }) + "\n");
  chmodTree(plugin);
  return plugin;
}

/** A bare command name (no configured registry) resolved through PATH. */
function onPath(command: string): string {
  if (path.isAbsolute(command)) return command;
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(dir, command);
    if (dir && existsSync(candidate)) return candidate;
  }
  return command;
}

function findSkills(root: string, names: string[]): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (dir: string, depth: number): void => {
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = path.join(dir, entry.name);
      if (names.includes(entry.name) && !found.has(entry.name) && existsSync(path.join(child, "SKILL.md"))) found.set(entry.name, child);
      else if (depth > 0) walk(child, depth - 1);
    }
  };
  walk(root, 2);
  return found;
}

function chmodTree(dir: string): void {
  chmodSync(dir, 0o755);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) chmodTree(child);
    else if (entry.isFile()) chmodSync(child, (statSync(child).mode & 0o111) ? 0o755 : 0o644);
  }
}

function writeIfChanged(file: string, text: string): void {
  try {
    if (readFileSync(file, "utf8") === text) return;
  } catch { /* missing */ }
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, text, { mode: 0o644 });
  chmodSync(temp, 0o644);
  renameSync(temp, file);
}

function readRecords(file: string): GuestRecord[] {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as { guests?: unknown };
    return Array.isArray(value.guests) ? value.guests.filter((row): row is GuestRecord =>
      Boolean(row) && typeof row.device === "string" && typeof row.secret === "string" && row.secret.length >= 32
      && Array.isArray(row.providers)).map((row) => ({
        device: row.device, secret: row.secret, providers: row.providers, created_at: String(row.created_at ?? ""),
      })) : [];
  } catch {
    return [];
  }
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        reject(new Error("request too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.once("end", () => resolve(Buffer.concat(chunks)));
    req.once("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  if (res.headersSent) { res.destroy(); return; }
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) }).end(body);
}

/**
 * A fresh local CA and a 127.0.0.1/localhost server certificate. Only guest
 * sessions on this host trust the CA, and the certificate only serves
 * loopback. The CA key is discarded: nothing else can ever be signed by it.
 */
export function localTlsMaterial(): { ca: string; cert: string; key: string } {
  const work = path.join(os.tmpdir(), `octopus-guest-tls-${process.pid}-${Date.now()}`);
  mkdirSync(work, { recursive: true, mode: 0o700 });
  const openssl = (args: string[]): void => {
    const result = spawnSync("openssl", args, { cwd: work, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`openssl ${args[0]} 失败：${result.stderr}`);
  };
  try {
    const ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"];
    openssl(["req", "-x509", ...ec, "-days", "3650", "-subj", "/CN=Octopus Guest Local CA",
      "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign",
      "-keyout", "ca.key", "-out", "ca.pem"]);
    openssl(["req", ...ec, "-subj", "/CN=127.0.0.1", "-keyout", "leaf.key", "-out", "leaf.csr"]);
    writeFileSync(path.join(work, "leaf.ext"), "subjectAltName=IP:127.0.0.1,DNS:localhost\n"
      + "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n");
    openssl(["x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial",
      "-days", "3650", "-extfile", "leaf.ext", "-out", "leaf.pem"]);
    const read = (name: string) => readFileSync(path.join(work, name), "utf8");
    return { ca: read("ca.pem"), cert: read("leaf.pem"), key: read("leaf.key") };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Where a guest tunnel ends on this host. */
export interface GuestTunnelSink {
  available(): boolean;
  attach(stream: Duplex, guest: GuestIdentity): void;
}

const TUNNEL_REGISTER_TIMEOUT_MS = 10_000;
const MAX_HOST_TUNNELS = 128;

/**
 * Device side of one site's guest tunnels: the control socket delivers an
 * offer, a second outbound WebSocket spends its secret, and the joined
 * stream goes to the sink. A host without sessions lets every offer time out.
 */
export class RunnerGuestTunnelRuntime {
  private readonly active = new Set<WebSocket>();

  constructor(
    private readonly gatewayUrl: string,
    private readonly sink: GuestTunnelSink,
    private readonly log: (message: string) => void = () => {},
  ) {}

  handle(message: Record<string, unknown>): boolean {
    if (message.type !== "model_tunnel_open") return false;
    const tunnelId = typeof message.tunnelId === "string" ? message.tunnelId : "";
    const secret = typeof message.secret === "string" ? message.secret : "";
    const guest = guestFrom(message.guest);
    if (!/^[0-9a-f-]{36}$/.test(tunnelId) || !/^[0-9a-f]{64}$/.test(secret) || !guest) return true;
    if (!this.sink.available() || this.active.size >= MAX_HOST_TUNNELS) return true;
    void this.open(tunnelId, secret, guest).catch((error) => {
      this.log(`guest tunnel ${tunnelId} for ${guest.device} failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    return true;
  }

  disconnect(): void {
    for (const socket of this.active) socket.terminate();
    this.active.clear();
  }

  private async open(tunnelId: string, secret: string, guest: GuestIdentity): Promise<void> {
    const tunnel = new WebSocket(this.gatewayUrl, { perMessageDeflate: false, handshakeTimeout: TUNNEL_REGISTER_TIMEOUT_MS });
    this.active.add(tunnel);
    tunnel.once("close", () => this.active.delete(tunnel));
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("guest tunnel registration timeout")), TUNNEL_REGISTER_TIMEOUT_MS);
        const fail = (error: Error): void => { clearTimeout(timer); reject(error); };
        const onMessage = (data: RawData, isBinary: boolean): void => {
          if (isBinary) return;
          let value: Record<string, unknown>;
          try { value = JSON.parse(String(data)) as Record<string, unknown>; } catch { return; }
          if (value.type !== "registered" || value.protocol !== GUEST_TUNNEL_HOST_PROTOCOL || value.tunnelId !== tunnelId) return;
          clearTimeout(timer);
          tunnel.off("message", onMessage);
          tunnel.off("error", fail);
          resolve();
        };
        tunnel.once("open", () => tunnel.send(JSON.stringify({
          type: "register", protocol: GUEST_TUNNEL_HOST_PROTOCOL, tunnelId, secret,
        })));
        tunnel.on("message", onMessage);
        tunnel.once("error", fail);
        tunnel.once("close", () => fail(new Error("gateway closed the tunnel")));
      });
    } catch (error) {
      tunnel.terminate();
      throw error;
    }
    const stream = createWebSocketStream(tunnel, { encoding: undefined });
    stream.on("error", () => tunnel.terminate());
    watchSilence(tunnel);
    this.sink.attach(stream, guest);
  }
}

function guestFrom(value: unknown): GuestIdentity | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const device = typeof row.device === "string" ? row.device : "";
  const providers = Array.isArray(row.providers)
    ? row.providers.filter((provider): provider is RunnerGuestProvider => provider === "anthropic" || provider === "openai")
    : [];
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(device) || !providers.length) return undefined;
  return { device, providers: [...new Set(providers)] };
}
