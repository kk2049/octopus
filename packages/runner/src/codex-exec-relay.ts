import { agentCommand } from "./agent-executables.js";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { resolveWorkspace } from "./workspaces.js";
import type { ExecutionPeerRpc } from "./peer-rpc.js";

const EXEC_SERVER_START_TIMEOUT_MS = 10_000;
const EXEC_SERVER_CONNECT_TIMEOUT_MS = 10_000;
const EXEC_RELAY_READ_WAIT_MS = 20_000;
const EXEC_RELAY_RPC_TIMEOUT_MS = 30_000;
const EXEC_RELAY_MAX_FRAME_BYTES = 16 * 1024 * 1024;
const EXEC_RELAY_MAX_QUEUED_BYTES = 32 * 1024 * 1024;
const EXEC_RELAY_MAX_TUNNELS = 32;
const SUPERSEDED = "Codex exec relay connection superseded";

interface RelayFrame {
  data: string;
  binary: boolean;
}

export interface ExecServerConnection {
  socket: WebSocket;
  close(): Promise<void>;
  /**
   * Another WebSocket to the same exec-server process. Codex resumes its
   * exec-server session over a fresh connection after a transport loss; the
   * server refuses a second `initialize` on a connection it already served.
   */
  connect?(): Promise<WebSocket>;
}

interface ExecTunnel {
  connection: ExecServerConnection;
  /** Current upstream connection; each reconnect replaces it and bumps `generation`. */
  socket: WebSocket;
  generation: number;
  reconnecting: Promise<unknown>;
  frames: RelayFrame[];
  queuedBytes: number;
  waiter: (() => void) | null;
  closed: boolean;
  error: string;
}

export interface CodexExecServerManagerOptions {
  openLocal?: (cwd: string) => Promise<ExecServerConnection>;
}

/** Execution-device owner of loopback-only Codex exec-server processes. */
export class CodexExecServerManager {
  private readonly tunnels = new Map<string, ExecTunnel>();
  private readonly openLocal: (cwd: string) => Promise<ExecServerConnection>;

  constructor(
    private readonly home: string,
    options: CodexExecServerManagerOptions = {},
  ) {
    this.openLocal = options.openLocal ?? openLocalExecServer;
  }

  async execute(method: string, args: Record<string, unknown>): Promise<unknown> {
    if (method === "codex_exec_open") return await this.open(args);
    const tunnelId = boundedString(args.tunnel_id, 128);
    const tunnel = this.tunnels.get(tunnelId);
    if (!tunnel) throw new Error("Codex exec relay tunnel is unavailable");
    if (method === "codex_exec_read") return await this.read(tunnel, args);
    if (method === "codex_exec_write") return await this.write(tunnel, args);
    if (method === "codex_exec_reconnect") {
      const next = tunnel.reconnecting.then(() => this.reconnect(tunnelId, tunnel));
      tunnel.reconnecting = next.catch(() => undefined);
      return await next;
    }
    if (method === "codex_exec_close") {
      await this.closeTunnel(tunnelId, tunnel);
      return { closed: true };
    }
    throw new Error(`unknown Codex exec relay method: ${method}`);
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.tunnels].map(([id, tunnel]) => this.closeTunnel(id, tunnel)));
  }

  private async open(args: Record<string, unknown>): Promise<{ tunnel_id: string; generation: number }> {
    if (this.tunnels.size >= EXEC_RELAY_MAX_TUNNELS) throw new Error("too many live Codex exec relay tunnels");
    const workspaceId = boundedString(args.workspace_id, 64);
    if (!workspaceId) throw new Error("codex_exec_open requires workspace_id");
    const cwd = (await resolveWorkspace(this.home, workspaceId)).path;
    const connection = await this.openLocal(cwd);
    const tunnelId = randomUUID();
    const tunnel: ExecTunnel = {
      connection,
      socket: connection.socket,
      generation: 1,
      reconnecting: Promise.resolve(),
      frames: [],
      queuedBytes: 0,
      waiter: null,
      closed: false,
      error: "",
    };
    this.attach(tunnelId, tunnel, connection.socket);
    this.tunnels.set(tunnelId, tunnel);
    return { tunnel_id: tunnelId, generation: tunnel.generation };
  }

  private attach(tunnelId: string, tunnel: ExecTunnel, socket: WebSocket): void {
    socket.on("message", (data, binary) => {
      if (tunnel.socket === socket) this.acceptFrame(tunnelId, tunnel, data, binary);
    });
    socket.on("close", (_code, reason) => {
      if (tunnel.socket !== socket) return;
      tunnel.closed = true;
      tunnel.error = reason.toString();
      this.wake(tunnel);
    });
    socket.on("error", (error) => {
      if (tunnel.socket !== socket) return;
      tunnel.error = error.message;
      this.wake(tunnel);
    });
  }

  private wake(tunnel: ExecTunnel): void {
    tunnel.waiter?.();
    tunnel.waiter = null;
  }

  /**
   * Give the runtime side's new environment connection its own upstream
   * connection to the SAME exec-server process, so Codex can resume the
   * session it held before the relay transport (e.g. a Head restart) broke.
   * The old connection is closed first: the server attaches a session to one
   * connection at a time. Frames of the old generation are discarded.
   */
  private async reconnect(tunnelId: string, tunnel: ExecTunnel): Promise<{ tunnel_id: string; generation: number }> {
    if (!tunnel.connection.connect) throw new Error("Codex exec-server cannot accept another connection");
    const previous = tunnel.socket;
    tunnel.generation++;
    tunnel.frames = [];
    tunnel.queuedBytes = 0;
    tunnel.closed = true;
    tunnel.error = SUPERSEDED;
    this.wake(tunnel);
    await closeWebSocket(previous);
    const socket = await tunnel.connection.connect();
    if (this.tunnels.get(tunnelId) !== tunnel) {
      socket.terminate();
      throw new Error("Codex exec relay tunnel is unavailable");
    }
    tunnel.socket = socket;
    tunnel.closed = false;
    tunnel.error = "";
    this.attach(tunnelId, tunnel, socket);
    return { tunnel_id: tunnelId, generation: tunnel.generation };
  }

  private acceptFrame(tunnelId: string, tunnel: ExecTunnel, data: RawData, binary: boolean): void {
    if (tunnel.closed || this.tunnels.get(tunnelId) !== tunnel) return;
    const bytes = rawDataBuffer(data);
    if (bytes.byteLength > EXEC_RELAY_MAX_FRAME_BYTES
      || tunnel.queuedBytes + bytes.byteLength > EXEC_RELAY_MAX_QUEUED_BYTES) {
      tunnel.error = "Codex exec relay output exceeded its bounded queue";
      tunnel.closed = true;
      tunnel.socket.close(1009, "relay queue limit");
    } else {
      tunnel.frames.push({ data: bytes.toString("base64"), binary });
      tunnel.queuedBytes += bytes.byteLength;
    }
    tunnel.waiter?.();
    tunnel.waiter = null;
  }

  private async read(tunnel: ExecTunnel, args: Record<string, unknown>): Promise<unknown> {
    // Callers that predate reconnects send no generation and always mean the current one.
    const generation = args.generation === undefined ? tunnel.generation : Number(args.generation);
    const superseded = { frames: [], closed: true, error: SUPERSEDED };
    if (generation !== tunnel.generation) return superseded;
    if (!tunnel.frames.length && !tunnel.closed) {
      if (tunnel.waiter) throw new Error("Codex exec relay already has a pending read");
      const requested = Number(args.wait_ms ?? EXEC_RELAY_READ_WAIT_MS);
      const waitMs = Number.isFinite(requested)
        ? Math.max(0, Math.min(EXEC_RELAY_READ_WAIT_MS, Math.floor(requested)))
        : EXEC_RELAY_READ_WAIT_MS;
      const { promise, resolve } = deferred<void>();
      const timer = setTimeout(resolve, waitMs);
      timer.unref?.();
      tunnel.waiter = resolve;
      await promise;
      clearTimeout(timer);
      if (tunnel.waiter === resolve) tunnel.waiter = null;
      if (generation !== tunnel.generation) return superseded;
    }
    const frames = tunnel.frames.splice(0);
    tunnel.queuedBytes = 0;
    return {
      frames,
      closed: tunnel.closed,
      ...(tunnel.error ? { error: tunnel.error } : {}),
    };
  }

  private async write(tunnel: ExecTunnel, args: Record<string, unknown>): Promise<unknown> {
    if (args.generation !== undefined && Number(args.generation) !== tunnel.generation) throw new Error(SUPERSEDED);
    if (tunnel.closed || tunnel.socket.readyState !== WebSocket.OPEN) {
      throw new Error(tunnel.error || "Codex exec relay tunnel is closed");
    }
    const encoded = boundedString(args.data, Math.ceil(EXEC_RELAY_MAX_FRAME_BYTES * 4 / 3) + 8);
    if (!encoded) throw new Error("codex_exec_write requires frame data");
    const data = Buffer.from(encoded, "base64");
    if (data.byteLength > EXEC_RELAY_MAX_FRAME_BYTES) throw new Error("Codex exec relay frame is too large");
    const { promise, resolve, reject } = deferred<void>();
    tunnel.socket.send(data, { binary: args.binary === true }, (error) => {
      if (error) reject(error);
      else resolve();
    });
    await promise;
    return { accepted: true };
  }

  private async closeTunnel(id: string, tunnel: ExecTunnel): Promise<void> {
    if (this.tunnels.get(id) !== tunnel) return;
    this.tunnels.delete(id);
    tunnel.closed = true;
    this.wake(tunnel);
    await closeWebSocket(tunnel.socket);
    await tunnel.connection.close();
  }
}

export interface CodexRemoteEnvironment {
  environmentId: string;
  endpoint: string;
  close(): Promise<void>;
}

export interface CodexExecRelayOpenInput {
  executionDevice: string;
  workspaceId: string;
  executionToken: string;
  operationId: string;
}

/** Runtime-device loopback proxy presented to Codex app-server as an environment. */
export class CodexExecRelayCoordinator {
  constructor(private readonly peer: ExecutionPeerRpc) {}

  async open(input: CodexExecRelayOpenInput): Promise<CodexRemoteEnvironment> {
    const context = {
      target: input.executionDevice,
      workspaceId: input.workspaceId,
      executionToken: input.executionToken,
    };
    const opened = object(await this.peer.request({
      ...context,
      method: "codex_exec_open",
      args: { workspace_id: input.workspaceId },
      timeoutMs: EXEC_RELAY_RPC_TIMEOUT_MS,
    }));
    const tunnelId = boundedString(opened.tunnel_id, 128);
    if (!tunnelId) throw new Error("execution Runner returned no Codex exec tunnel id");
    const firstGeneration = generationOf(opened);

    let closed = false;
    let attached = false;
    let active: WebSocket | null = null;
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    try {
      await websocketServerListening(server, EXEC_SERVER_CONNECT_TIMEOUT_MS);
    } catch (error) {
      await closeRemoteTunnel(this.peer, context, tunnelId);
      throw error;
    }
    server.on("connection", (socket) => {
      if (closed || active) {
        socket.close(1008, "Codex exec relay accepts one environment connection");
        return;
      }
      active = socket;
      // Codex reconnects here to resume its exec-server session after any
      // transport loss. One environment connection maps to one upstream
      // connection: a later one asks for a fresh connection to the same
      // exec-server process instead of replaying into the initialized one.
      const ready = !attached
        ? Promise.resolve(firstGeneration)
        : this.peer.request({
          ...context,
          method: "codex_exec_reconnect",
          args: { tunnel_id: tunnelId },
          timeoutMs: EXEC_RELAY_RPC_TIMEOUT_MS,
        }).then((value) => generationOf(object(value)));
      attached = true;
      ready.catch((error) => {
        if (socket.readyState === WebSocket.OPEN) socket.close(1011, safeReason(error));
      });
      let writes = Promise.resolve();
      socket.on("message", (data, binary) => {
        const bytes = rawDataBuffer(data);
        if (bytes.byteLength > EXEC_RELAY_MAX_FRAME_BYTES) {
          socket.close(1009, "Codex exec relay frame is too large");
          return;
        }
        writes = writes.then(async () => {
          const generation = await ready;
          await this.peer.request({
            ...context,
            method: "codex_exec_write",
            args: { tunnel_id: tunnelId, data: bytes.toString("base64"), binary, ...generation },
            timeoutMs: EXEC_RELAY_RPC_TIMEOUT_MS,
          });
        }).catch((error) => {
          if (socket.readyState === WebSocket.OPEN) socket.close(1011, safeReason(error));
        });
      });
      socket.once("close", () => {
        if (active === socket) active = null;
      });
      void ready.then((generation) => pumpRemoteFrames(this.peer, context, tunnelId, socket, generation), () => undefined);
    });

    const address = server.address() as AddressInfo;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      active?.close(1000, "managed Codex environment released");
      await closeWebSocketServer(server);
      await closeRemoteTunnel(this.peer, context, tunnelId);
    };
    return {
      environmentId: `octopus-${input.operationId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80)}`,
      endpoint: `ws://127.0.0.1:${address.port}`,
      close,
    };
  }
}

/** An execution Runner that predates reconnects reports no generation; omit it then. */
function generationOf(value: Record<string, unknown>): { generation?: number } {
  return Number.isSafeInteger(value.generation) ? { generation: value.generation as number } : {};
}

async function pumpRemoteFrames(
  peer: ExecutionPeerRpc,
  context: { target: string; workspaceId: string; executionToken: string },
  tunnelId: string,
  socket: WebSocket,
  generation: { generation?: number },
): Promise<void> {
  while (socket.readyState === WebSocket.OPEN) {
    try {
      const result = object(await peer.request({
        ...context,
        method: "codex_exec_read",
        args: { tunnel_id: tunnelId, wait_ms: EXEC_RELAY_READ_WAIT_MS, ...generation },
        timeoutMs: EXEC_RELAY_RPC_TIMEOUT_MS,
      }));
      for (const value of array(result.frames)) {
        const frame = object(value);
        const encoded = boundedString(frame.data, Math.ceil(EXEC_RELAY_MAX_FRAME_BYTES * 4 / 3) + 8);
        if (!encoded) continue;
        const data = Buffer.from(encoded, "base64");
        if (data.byteLength > EXEC_RELAY_MAX_FRAME_BYTES) throw new Error("Codex exec relay frame is too large");
        if (socket.readyState === WebSocket.OPEN) socket.send(data, { binary: frame.binary === true });
      }
      if (result.closed === true) {
        socket.close(1011, safeReason(result.error || "execution environment disconnected"));
        return;
      }
    } catch (error) {
      if (socket.readyState === WebSocket.OPEN) socket.close(1011, safeReason(error));
      return;
    }
  }
}

async function closeRemoteTunnel(
  peer: ExecutionPeerRpc,
  context: { target: string; workspaceId: string; executionToken: string },
  tunnelId: string,
): Promise<void> {
  await peer.request({
    ...context,
    method: "codex_exec_close",
    args: { tunnel_id: tunnelId },
    timeoutMs: EXEC_RELAY_RPC_TIMEOUT_MS,
  }).catch(() => undefined);
}

/**
 * Spawn one loopback `codex exec-server` in `cwd` and connect to it. Exported
 * for the bot host's reverse placement (#358): there the ticket worktree is the
 * execution environment and the app-server lives on a Runner device.
 */
export async function openLocalExecServer(cwd: string): Promise<ExecServerConnection> {
  const command = agentCommand("codex", ["exec-server", "--listen", "ws://127.0.0.1:0"]);
  const child = spawn(command.bin, command.args, {
    env: command.env,
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr = `${stderr}${String(chunk)}`.slice(-4_000);
  });
  let endpoint: string;
  try {
    endpoint = await execServerEndpoint(child, () => stderr);
  } catch (error) {
    terminateChild(child);
    throw error;
  }
  const connect = async (): Promise<WebSocket> => {
    const socket = new WebSocket(endpoint);
    try {
      await websocketOpen(socket, EXEC_SERVER_CONNECT_TIMEOUT_MS);
    } catch (error) {
      socket.terminate();
      throw error;
    }
    return socket;
  };
  let socket: WebSocket;
  try {
    socket = await connect();
  } catch (error) {
    terminateChild(child);
    throw error;
  }
  return {
    socket,
    connect,
    async close() {
      await closeWebSocket(socket);
      await terminateChild(child);
    },
  };
}

async function execServerEndpoint(child: ChildProcess, stderr: () => string): Promise<string> {
  const { promise, resolve, reject } = deferred<string>();
  let settled = false;
  let buffer = "";
  const done = (value: string | Error): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (value instanceof Error) reject(value);
    else resolve(value);
  };
  const timer = setTimeout(() => done(new Error(`Codex exec-server startup timed out${stderr() ? `: ${stderr()}` : ""}`)), EXEC_SERVER_START_TIMEOUT_MS);
  timer.unref?.();
  child.once("error", (error) => done(error));
  child.once("exit", (code, signal) => done(new Error(
    stderr() || `Codex exec-server exited before listening (${code ?? signal ?? "unknown"})`,
  )));
  child.stdout?.on("data", (chunk) => {
    buffer += String(chunk);
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (/^ws:\/\/127\.0\.0\.1:\d+$/.test(line)) done(line);
    }
  });
  return await promise;
}

async function websocketOpen(socket: WebSocket, timeoutMs: number): Promise<void> {
  const { promise, resolve, reject } = deferred<void>();
  const timer = setTimeout(() => reject(new Error("Codex exec-server WebSocket connect timed out")), timeoutMs);
  timer.unref?.();
  socket.once("open", () => { clearTimeout(timer); resolve(); });
  socket.once("error", (error) => { clearTimeout(timer); reject(error); });
  await promise;
}

async function websocketServerListening(server: WebSocketServer, timeoutMs: number): Promise<void> {
  if (server.address()) return;
  const { promise, resolve, reject } = deferred<void>();
  const timer = setTimeout(() => reject(new Error("Codex exec relay proxy listen timed out")), timeoutMs);
  timer.unref?.();
  server.once("listening", () => { clearTimeout(timer); resolve(); });
  server.once("error", (error) => { clearTimeout(timer); reject(error); });
  await promise;
}

async function closeWebSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  const { promise, resolve } = deferred<void>();
  const timer = setTimeout(() => { socket.terminate(); resolve(); }, 1_000);
  timer.unref?.();
  socket.once("close", () => { clearTimeout(timer); resolve(); });
  socket.close(1000, "Octopus exec relay released");
  await promise;
}

async function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  const { promise, resolve } = deferred<void>();
  server.close(() => resolve());
  await promise;
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const { promise, resolve } = deferred<void>();
  const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); resolve(); }, 1_000);
  timer.unref?.();
  child.once("exit", () => { clearTimeout(timer); resolve(); });
  child.kill("SIGTERM");
  await promise;
}

function rawDataBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function boundedString(value: unknown, max: number): string {
  return typeof value === "string" && value.length <= max ? value : "";
}

function safeReason(value: unknown): string {
  return (value instanceof Error ? value.message : String(value)).slice(0, 120) || "Codex exec relay failed";
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
