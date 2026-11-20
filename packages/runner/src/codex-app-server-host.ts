import { closeCodexProcess, signalCodexProcess, trackCodexProcess } from "./codex-owned-process.js";
import { agentCommand } from "./agent-executables.js";
/** Local shared Codex app-server host used by Runner and opt-in remote TUIs. */

import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

export interface CodexAppServerHostOptions {
  endpointFile?: string;
  cwd?: string;
  spawnProcess?: typeof spawn;
  waitMs?: number;
  /** Only private hosts whose every consumer uses acquire() may rotate while idle. */
  replaceWhenIdle?: boolean;
  /**
   * Start with a private CODEX_HOME that persists managed thread state but
   * imports only model credentials and provider routing. User/project MCP,
   * App, plugin, skill, hook, notification, and instruction config must not
   * cross into a split-placement control plane.
   */
  isolateConfig?: boolean;
  /** Test/deployment override for the credential source. */
  sourceCodexHome?: string;
  /** Test/deployment override for the private destination. */
  isolatedCodexHome?: string;
}

export function defaultCodexAppServerEndpointFile(): string {
  const runtime = process.env.XDG_RUNTIME_DIR;
  const root = runtime && path.isAbsolute(runtime)
    ? path.join(runtime, "octopus-runner")
    : path.join(os.tmpdir(), `octopus-runner-${typeof process.getuid === "function" ? process.getuid() : "user"}`);
  return path.join(root, "codex-app-server.endpoint");
}

export class CodexAppServerHost {
  readonly endpointFile: string;
  private readonly cwd: string;
  private readonly spawnProcess: typeof spawn;
  private readonly waitMs: number;
  private readonly replaceWhenIdle: boolean;
  private executableFingerprint = "";
  private users = 0;
  private acquiring: Promise<unknown> = Promise.resolve();
  private server: ChildProcess | null = null;
  private starting: Promise<string> | null = null;
  private closing: Promise<void> | null = null;
  private generation = 0;
  private endpointValue: string | null = null;
  private stderr = "";
  private readonly sourceCodexHome: string | null;
  private readonly isolatedCodexHome: string | null;

  constructor(options: CodexAppServerHostOptions = {}) {
    this.endpointFile = options.endpointFile ?? defaultCodexAppServerEndpointFile();
    this.cwd = options.cwd ?? os.homedir();
    this.spawnProcess = options.spawnProcess ?? spawn;
    // Cold-starting `codex app-server` on a loaded host can exceed a short
    // budget; a premature verdict here surfaces as "codex fails to start".
    this.waitMs = options.waitMs ?? 15_000;
    this.replaceWhenIdle = options.replaceWhenIdle === true;
    this.sourceCodexHome = options.isolateConfig
      ? options.sourceCodexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex")
      : null;
    this.isolatedCodexHome = options.isolateConfig
      ? options.isolatedCodexHome ?? path.join(path.dirname(this.endpointFile), "codex-home")
      : null;
  }

  get endpoint(): string {
    if (!this.endpointValue) throw new Error("Codex app-server endpoint is not ready");
    return this.endpointValue;
  }

  /** Non-starting readiness probe for roster projection and launcher matching. */
  get currentEndpoint(): string | null {
    const child = this.server;
    return child && child.exitCode === null && child.signalCode === null ? this.endpointValue : null;
  }

  async ensure(): Promise<string> {
    if (this.closing) await this.closing;
    if (this.replaceWhenIdle && this.users === 0 && this.server
      && agentCommand("codex", []).fingerprint !== this.executableFingerprint) await this.close();
    const child = this.server;
    if (child && child.exitCode === null && child.signalCode === null && this.endpointValue) {
      // Restarting a live app-server tears down every attached Codex session,
      // so a slow accept under load must not be read as death. Probe with a
      // real budget and confirm with a second probe before giving up on it.
      if (await endpointLive(this.endpointValue) || await endpointLive(this.endpointValue)) {
        return this.endpointValue;
      }
    }
    if (this.starting) return await this.starting;
    this.starting = this.startServer();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  /** Serialize reservation with idle replacement so two new clients cannot retire each other's host. */
  async acquire(): Promise<{ endpoint: string; release(): void }> {
    const operation = this.acquiring.then(async () => {
      const endpoint = await this.ensure();
      this.users++;
      let released = false;
      return { endpoint, release: () => { if (!released) { released = true; this.users--; } } };
    });
    this.acquiring = operation.catch(() => {});
    return await operation;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.generation++;
    const child = this.server;
    this.server = null;
    this.endpointValue = null;
    const closing = (async () => {
      if (child) await closeCodexProcess(child, process.platform !== "win32");
      await fs.unlink(this.endpointFile).catch(() => {});
      // Native history intentionally survives; only this process is released.
    })();
    this.closing = closing;
    return closing.finally(() => { if (this.closing === closing) this.closing = null; });
  }

  /** Process `exit` handlers cannot await; still avoid orphaning our child. */
  terminate(): void {
    this.generation++;
    const child = this.server;
    this.server = null;
    this.endpointValue = null;
    if (child && child.exitCode === null && child.signalCode === null) signalCodexProcess(child, "SIGKILL", process.platform !== "win32");
    try { unlinkSync(this.endpointFile); } catch { /* absent or already cleaned */ }
  }

  private async startServer(): Promise<string> {
    if (this.server && this.server.exitCode === null && this.server.signalCode === null) {
      await this.close();
    }
    const generation = this.generation;
    this.stderr = "";
    this.endpointValue = null;
    await preparePrivateEndpointFile(this.endpointFile);
    if (this.sourceCodexHome && this.isolatedCodexHome) {
      await prepareIsolatedCodexHome(this.sourceCodexHome, this.isolatedCodexHome);
    }

    if (generation !== this.generation) throw new Error("Codex host closed during startup");

    // Port zero lets the OS choose a free port. The app-server itself enforces
    // the loopback bind; no public listener or firewall rule is introduced.
    const command = agentCommand("codex", ["app-server", "--listen", "ws://127.0.0.1:0"],
      this.isolatedCodexHome ? { ...process.env, CODEX_HOME: this.isolatedCodexHome } : process.env);
    this.executableFingerprint = command.fingerprint;
    const child = this.spawnProcess(command.bin, command.args, {
      cwd: this.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env: command.env,
    });
    trackCodexProcess(child, process.platform !== "win32");
    this.server = child;
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-8_000);
      const match = this.stderr.match(/listening on:\s+(ws:\/\/127\.0\.0\.1:\d+)/);
      if (match?.[1]) this.endpointValue = match[1];
    });
    child.on("error", (error) => {
      this.stderr = (this.stderr + `\n${error.message}`).slice(-8_000);
    });
    child.once("exit", () => {
      if (this.server !== child) return;
      this.server = null;
      this.endpointValue = null;
      void fs.unlink(this.endpointFile).catch(() => {});
    });
    await spawned(child);

    const deadline = Date.now() + this.waitMs;
    while (Date.now() < deadline) {
      if (generation !== this.generation || this.server !== child) throw new Error("Codex host closed during startup");
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`codex app-server 提前退出：${this.stderr.trim() || String(child.exitCode ?? child.signalCode)}`);
      }
      if (this.endpointValue && await endpointLive(this.endpointValue)) {
        const endpoint = this.endpointValue;
        await writeEndpointFile(this.endpointFile, child.pid, endpoint);
        if (generation !== this.generation || this.server !== child) {
          await fs.unlink(this.endpointFile).catch(() => {});
          throw new Error("Codex host closed during startup");
        }
        return endpoint;
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    await this.close();
    throw new Error(`codex app-server 没有在 ${this.waitMs}ms 内建立本机 WebSocket：${this.stderr.trim()}`);
  }
}

export async function prepareIsolatedCodexHome(source: string, destination: string): Promise<void> {
  if (path.resolve(source) === path.resolve(destination)) {
    throw new Error("isolated Codex home must differ from its credential source");
  }
  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  await fs.chmod(destination, 0o700);
  // Split hosts also serve other users' shared tickets: the owner's
  // instructions (often a link to their personal AGENTS.md) must never load here.
  await Promise.all([
    "config.toml",
    "managed_config.toml",
    "rules",
    "skills",
    "plugins",
    "prompts",
    "AGENTS.md",
    "AGENTS.override.md",
  ].map((name) => fs.rm(path.join(destination, name), { recursive: true, force: true })));
  try {
    const sourceAuth = path.join(source, "auth.json");
    const stat = await fs.stat(sourceAuth);
    if (!stat.isFile()) throw new Error("Codex auth source is not a regular file");
    const destinationAuth = path.join(destination, "auth.json");
    await fs.copyFile(sourceAuth, destinationAuth);
    await fs.chmod(destinationAuth, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // A logged-out source must not leave a previously copied login active on
    // the next isolated host startup. Native session history still survives.
    await fs.rm(path.join(destination, "auth.json"), { force: true });
  }
  await copyCodexProviderRouting(source, destination);
}

/**
 * Copy the machine-level route to the user's model endpoint without importing
 * the rest of their Codex control plane. Custom providers may carry static or
 * command-backed credentials; those are model credentials executed on the
 * owner's Runner, while MCP/apps/hooks/instructions remain outside the split
 * home.
 *
 * Keep the original TOML bytes for supported entries so quoted provider ids,
 * inline maps, and multiline provider values retain Codex's own parsing
 * semantics. A malformed projection fails Codex startup plainly; it can never
 * fall back to loading the source config wholesale.
 */
async function copyCodexProviderRouting(source: string, destination: string): Promise<void> {
  const sourceConfig = path.join(source, "config.toml");
  try {
    const stat = await fs.stat(sourceConfig);
    if (!stat.isFile()) throw new Error("Codex config source is not a regular file");
    const projected = projectCodexProviderRouting(await fs.readFile(sourceConfig, "utf8"));
    if (!projected) return;
    const destinationConfig = path.join(destination, "config.toml");
    await fs.writeFile(destinationConfig, projected, { mode: 0o600 });
    await fs.chmod(destinationConfig, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

const CODEX_ROUTE_KEYS = new Set([
  "chatgpt_base_url",
  "cli_auth_credentials_store",
  "experimental_realtime_ws_base_url",
  "forced_chatgpt_workspace_id",
  "forced_login_method",
  "model_provider",
  "openai_base_url",
]);

function projectCodexProviderRouting(config: string): string {
  const output: string[] = [];
  let table: "provider" | "other" | null = null;

  for (const line of config.replaceAll("\r\n", "\n").split("\n")) {
    const header = tomlTableHeader(line);
    if (header !== null) {
      table = isModelProviderTable(header) ? "provider" : "other";
      if (table === "provider") output.push(line);
      continue;
    }
    if (table === "provider") {
      output.push(line);
      continue;
    }
    if (table !== null) continue;

    const key = line.match(/^\s*([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)\s*=/)?.[1];
    if (key && (CODEX_ROUTE_KEYS.has(key) || key.startsWith("model_providers."))) {
      output.push(line);
    }
  }

  while (output[0]?.trim() === "") output.shift();
  while (output.at(-1)?.trim() === "") output.pop();
  return output.length > 0 ? `${output.join("\n")}\n` : "";
}

function tomlTableHeader(line: string): string | null {
  const match = line.match(/^\s*(?:\[\[([^\]]+)\]\]|\[([^\]]+)\])\s*(?:#.*)?$/);
  return (match?.[1] ?? match?.[2])?.trim() ?? null;
}

function isModelProviderTable(header: string): boolean {
  return /^(?:model_providers|["']model_providers["'])(?:\.|$)/.test(header);
}

async function preparePrivateEndpointFile(file: string): Promise<void> {
  const root = path.dirname(file);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.chmod(root, 0o700);
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile()) throw new Error(`refusing to replace non-file Codex endpoint: ${file}`);
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error(`refusing to replace Codex endpoint owned by another uid: ${file}`);
    }
    await fs.unlink(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function writeEndpointFile(file: string, pid: number | undefined, endpoint: string): Promise<void> {
  if (!pid) throw new Error("codex app-server did not expose a process id");
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${pid} ${endpoint}\n`, { mode: 0o600 });
  await fs.rename(temp, file);
  await fs.chmod(file, 0o600);
}

// A dead endpoint fails fast (connection refused); only a wedged or heavily
// loaded server runs into this budget. Keep it generous enough that host load
// alone cannot fail a liveness probe — a false "dead" verdict restarts the
// server and kills every attached session, which costs far more than waiting.
const PROBE_TIMEOUT_MS = 1_500;

async function endpointLive(endpoint: string): Promise<boolean> {
  if (!/^ws:\/\/127\.0\.0\.1:\d+$/.test(endpoint)) return false;
  return await new Promise<boolean>((resolve) => {
    const socket = new WebSocket(endpoint);
    const timer = setTimeout(() => { socket.terminate(); resolve(false); }, PROBE_TIMEOUT_MS);
    timer.unref?.();
    socket.once("open", () => { clearTimeout(timer); socket.close(); resolve(true); });
    socket.once("error", () => { clearTimeout(timer); resolve(false); });
  });
}

async function spawned(child: ChildProcess): Promise<void> {
  if (child.pid) return;
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}
