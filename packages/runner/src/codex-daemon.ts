/** Observe Codex's native shared daemon without acquiring its writer lease. */
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import WebSocket from "ws";
import { CodexJsonRpcClient } from "./codex-app-server.js";
import { AgentInteractionBroker } from "./agent-interactions.js";
import { LinuxProcessReader, matchesProvider, type ProcSnapshot } from "./agent-runtime.js";
import type { PublicAgentControlRuntime } from "./agent-control-plane.js";

const exec = promisify(execFile);
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v)
  ? v as Record<string, unknown> : {};
const isDaemon = (p: ProcSnapshot) => path.basename(p.argv[0] ?? "") === "codex"
  && p.argv[1] === "app-server" && p.argv.includes("--managed-daemon");
const sameProcess = (a: ProcSnapshot, b: ProcSnapshot | null) => b?.pid === a.pid
  && b.startTicks === a.startTicks && b.bootId === a.bootId && isDaemon(b);

export interface DaemonThread {
  id: string;
  path: string;
  turnState: "idle" | "working" | "needs_input" | "unknown";
}
export interface CodexDaemonConnection {
  client: CodexJsonRpcClient;
  process: ProcSnapshot;
  loaded(): Promise<string[]>;
  thread(id: string): Promise<DaemonThread | null>;
  revalidate(): Promise<void>;
  close(): Promise<void>;
}

/** Only an absent endpoint allows legacy discovery. An unhealthy one fails closed. */
export async function openCodexDaemon(codexHome: string): Promise<CodexDaemonConnection | null> {
  if (process.platform !== "linux" || !path.isAbsolute(codexHome)) return null;
  const home = await fs.realpath(codexHome).catch(() => null);
  if (!home) return null;
  const endpoint = path.join(home, "app-server-control", "app-server-control.sock");
  const initial = await fs.stat(endpoint).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!initial) return null;
  // Codex may publish a symlink to its protected /tmp rendezvous socket.
  // Check the actual socket; never accept a world/group accessible endpoint.
  if (!initial.isSocket() || initial.uid !== process.getuid?.() || (initial.mode & 0o077)) {
    throw new Error("Codex daemon socket is not private to this user");
  }
  const socket = new WebSocket(`ws+unix:${endpoint}:/`, { handshakeTimeout: 1_500, maxPayload: 1024 * 1024 });
  const client = new CodexJsonRpcClient(socket, "", new AgentInteractionBroker());
  const request = (method: string, params: Record<string, unknown>) => client.request(method, params, 1_500);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve); socket.once("error", reject);
    });
    await request("initialize", { clientInfo: { name: "octopus_daemon_observer", version: "1" },
      capabilities: { experimentalApi: true } });
    client.notify("initialized", {});
    const diagnostic = object(await request("server/diagnostics", {}));
    const pid = object(diagnostic.process).id;
    const reader = new LinuxProcessReader();
    const processInfo = typeof pid === "number" ? await reader.read(pid) : null;
    if (!processInfo || !isDaemon(processInfo) || (await fs.stat(`/proc/${pid}`)).uid !== process.getuid?.()) {
      throw new Error("Codex endpoint is not a native local daemon");
    }
    const environment = await fs.readFile(`/proc/${pid}/environ`, "utf8");
    const declared = environment.split("\0").find((v) => v.startsWith("CODEX_HOME="))?.slice(11)
      || path.join(environment.split("\0").find((v) => v.startsWith("HOME="))?.slice(5) ?? "", ".codex");
    if (await fs.realpath(declared).catch(() => "") !== home) throw new Error("Codex daemon account changed");
    const revalidate = async () => {
      const current = await fs.stat(endpoint);
      if (current.dev !== initial.dev || current.ino !== initial.ino
        || !current.isSocket() || current.uid !== initial.uid || (current.mode & 0o077)
        || !sameProcess(processInfo, await reader.read(processInfo.pid))) throw new Error("Codex daemon identity changed");
    };
    await revalidate();
    return {
      client, process: processInfo, revalidate, close: () => client.close(),
      loaded: async () => {
        const result = object(await request("thread/loaded/list", { limit: 100 }));
        // Partial inventories cannot prove either absence or exclusive ownership.
        if (result.nextCursor || !Array.isArray(result.data) || result.data.length > 100
          || result.data.some((id) => typeof id !== "string" || !UUID.test(id))) throw new Error("Incomplete Codex daemon inventory");
        return result.data as string[];
      },
      thread: async (id) => {
        if (!UUID.test(id)) return null;
        const t = object(object(await request("thread/read", { threadId: id, includeTurns: false })).thread);
        // originator is attribution, not ownership: a real TUI can inherit the
        // first observer's client name from a shared daemon. Use the daemon's
        // loaded root-thread identity and direct-input capability instead.
        if (t.id !== id || t.threadSource !== "user"
          || t.parentThreadId || t.canAcceptDirectInput !== true || typeof t.path !== "string" || !path.isAbsolute(t.path)) return null;
        client.observeIsolatedThread(id, () => {}); // This observer never answers the TUI's tools/approvals.
        const status = object(t.status);
        const waiting = Array.isArray(status.activeFlags) && status.activeFlags.some((v) => v === "waitingOnApproval" || v === "waitingOnUserInput");
        return { id, path: t.path, turnState: waiting ? "needs_input" : status.type === "idle" ? "idle"
          : status.type === "active" ? "working" : "unknown" };
      },
    };
  } catch (error) { await client.close(); throw error; }
}

/** Kernel socket peers establish a TUI/daemon link; titles/cwd are never keys. */
export function daemonTmuxPeer(daemonPid: number, rows: readonly ProcSnapshot[], tmuxPids: ReadonlySet<number>, sockets: string): boolean {
  const endpoints = new Map<string, { peer: string; pids: Set<number> }>();
  for (const line of sockets.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields[0] !== "u_str" || fields[1] !== "ESTAB" || fields.length < 8) continue;
    const inode = fields[5], peer = fields[7];
    if (!/^\d+$/.test(inode) || !/^\d+$/.test(peer)) continue;
    endpoints.set(inode, { peer, pids: new Set([...line.matchAll(/pid=(\d+),/g)].map((m) => Number(m[1]))) });
  }
  const tuis = new Set<number>();
  for (const [inode, socket] of endpoints) {
    if (!socket.pids.has(daemonPid)) continue;
    const peer = endpoints.get(socket.peer);
    if (!peer || peer.peer !== inode) continue;
    for (const pid of peer.pids) if (rows.some((p) => p.pid === pid && p.tty && matchesProvider(p, "codex"))) tuis.add(pid);
  }
  return tuis.size === 1 && tmuxPids.has([...tuis][0]);
}

interface Observation extends DaemonThread { at: number; tmux: boolean; }
export class CodexDaemonObserver {
  private observations = new Map<string, Observation>();
  constructor(readonly connect = openCodexDaemon,
    private readonly readSockets = () => exec("ss", ["-xnap"], { timeout: 1_000, maxBuffer: 1024 * 1024 }).then((r) => r.stdout)) {}

  runtime(id: string): PublicAgentControlRuntime | undefined {
    const row = this.observations.get(id);
    if (!row || Date.now() - row.at > 6_000) return;
    return {
      process_state: "alive", control_mode: "external_cli", turn_state: row.turnState,
      observed_at: new Date(row.at).toISOString(), event: "CodexDaemonObserved", degraded: false,
      attachment: row.tmux ? { kind: "terminal_tmux", state: "attached", transport: "tmux" }
        : { kind: "codex_app_server", state: "attached", transport: "app-server" },
      control_lease: { holder: "terminal" }, turn: { state: row.turnState },
      capabilities: { observe: true, append_when_idle: false, takeover: false, interrupt: false, steer: false,
        terminal_append: false, managed_resume: false, protocol_append: row.turnState === "idle" || row.turnState === "working",
        release_control: false, terminal_interrupt: false },
    };
  }

  async refresh(home: string, rows: readonly ProcSnapshot[], ttys: ReadonlySet<string>, accept: (file: string) => Promise<boolean>): Promise<DaemonThread[]> {
    const homes = new Set<string>();
    for (const p of rows.filter(isDaemon).slice(0, 16)) {
      const env = await fs.readFile(`/proc/${p.pid}/environ`, "utf8").catch(() => "");
      homes.add(env.split("\0").find((v) => v.startsWith("CODEX_HOME="))?.slice(11) || path.join(home, ".codex"));
    }
    if (!homes.size) { this.observations.clear(); return []; }
    const sockets = await this.readSockets().catch(() => "");
    const tmuxPids = new Set<number>();
    for (const p of rows.filter((p) => p.tty && matchesProvider(p, "codex"))) {
      if (ttys.has(await fs.readlink(`/proc/${p.pid}/fd/0`).catch(() => ""))) tmuxPids.add(p.pid);
    }
    const next = new Map<string, Observation>();
    const ambiguous = new Set<string>();
    const deadline = Date.now() + 5_000;
    for (const root of homes) {
      if (Date.now() >= deadline) break;
      let connection: CodexDaemonConnection | null = null;
      try {
        connection = await this.connect(root);
        if (!connection || !rows.some((p) => sameProcess(connection!.process, p))) continue;
        const loaded = await connection.loaded();
        const observed: Observation[] = [];
        for (const id of loaded) {
          if (Date.now() >= deadline) throw new Error("Codex observation budget exhausted");
          const thread = await connection.thread(id);
          if (!thread || !await accept(thread.path)) continue;
          // Display-only association: ambiguous daemon/TUI fan-out gets no tmux
          // badge. This evidence NEVER enters the signal/takeover registry.
          const tmux = loaded.length === 1 && daemonTmuxPeer(connection.process.pid, rows, tmuxPids, sockets);
          observed.push({ ...thread, tmux, at: Date.now() });
        }
        await connection.revalidate();
        for (const row of observed) {
          if (next.has(row.id)) ambiguous.add(row.id);
          if (ambiguous.has(row.id)) next.delete(row.id);
          else next.set(row.id, row);
        }
      } catch { /* Missing proof expires; never retain last-known control authority. */ }
      finally { await connection?.close(); }
    }
    this.observations = next;
    return [...next.values()];
  }
}
