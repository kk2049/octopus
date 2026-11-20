/**
 * Runtime-device tunnels that let the trusted bot drive THIS device's isolated
 * Codex app-server for one dev-ticket turn (#358).
 *
 * Placement is the reverse of codex-exec-relay.ts: the model brain (Codex app
 * server, this device's own credentials via the isolated split home) runs
 * here, while the execution environment — the ticket worktree and its
 * `codex exec-server` — stays on the bot host. One tunnel therefore carries
 * two multiplexed channels:
 *
 *   · "agent": the app-server JSON-RPC WebSocket the bot's CodexManagedSession
 *     attaches to (thread/start, turn/start, turn/steer, …);
 *   · "env": a loopback WebSocket server whose frames the bot pipes into a
 *     bot-host `codex exec-server` — the app-server connects to it after the
 *     bot sends `environment/add` with this endpoint.
 *
 * The bot polls frames with a bounded long-poll RPC (same shape and bounds as
 * the exec relay); nothing here accepts a path, a CODEX_HOME or a credential
 * from RPC arguments.
 */

import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { MACHINE_LIMITS } from "./limits.js";

const AGENT_RELAY_CONNECT_TIMEOUT_MS = 15_000;
const AGENT_RELAY_READ_WAIT_MS = 20_000;
const AGENT_RELAY_MAX_QUEUED_BYTES = 32 * 1024 * 1024;
const AGENT_RELAY_MAX_TUNNELS = 4;

export type CodexAgentRelayChannel = "agent" | "env";

export interface CodexAgentRelayWireFrame {
  channel: CodexAgentRelayChannel;
  data: string;
  binary: boolean;
  frame_id?: string;
  chunk_index?: number;
  chunk_count?: number;
}

export interface CodexAgentRelayDecodedFrame {
  channel: CodexAgentRelayChannel;
  data: Buffer;
  binary: boolean;
}

interface QueuedRelayFrame extends CodexAgentRelayWireFrame {
  byteLength: number;
}

interface PendingRelayFrame {
  channel: CodexAgentRelayChannel;
  binary: boolean;
  chunkCount: number;
  chunks: Buffer[];
  byteLength: number;
}

interface AgentTunnel {
  releaseHost?: () => void;
  agentSocket: WebSocket;
  envServer: WebSocketServer;
  envSocket: WebSocket | null;
  frames: QueuedRelayFrame[];
  inbound: CodexAgentRelayFrameAssembler;
  fragmented: boolean;
  queuedBytes: number;
  waiter: (() => void) | null;
  closed: boolean;
  error: string;
}

/**
 * Split one WebSocket message into capability-sized wire records. Fragment
 * metadata is present only when needed, so small frames remain compatible with
 * the original relay protocol.
 */
export function fragmentCodexAgentRelayFrame(
  channel: CodexAgentRelayChannel,
  data: Buffer,
  binary: boolean,
): CodexAgentRelayWireFrame[] {
  if (data.byteLength > MACHINE_LIMITS.codexAgentRelayFrameMaxBytes) {
    throw new Error("Codex agent relay frame is too large");
  }
  if (data.byteLength <= MACHINE_LIMITS.codexAgentRelayChunkBytes) {
    return [{ channel, data: data.toString("base64"), binary }];
  }
  const frameId = randomUUID();
  const chunkCount = Math.ceil(data.byteLength / MACHINE_LIMITS.codexAgentRelayChunkBytes);
  return Array.from({ length: chunkCount }, (_, chunkIndex) => {
    const offset = chunkIndex * MACHINE_LIMITS.codexAgentRelayChunkBytes;
    return {
      channel,
      data: data.subarray(offset, offset + MACHINE_LIMITS.codexAgentRelayChunkBytes).toString("base64"),
      binary,
      frame_id: frameId,
      chunk_index: chunkIndex,
      chunk_count: chunkCount,
    };
  });
}

/** Restore one WebSocket message without ever accepting an unbounded partial. */
export class CodexAgentRelayFrameAssembler {
  private readonly pending = new Map<string, PendingRelayFrame>();
  private pendingBytes = 0;

  accept(value: Record<string, unknown>): CodexAgentRelayDecodedFrame | null {
    const channel = value.channel === "agent" || value.channel === "env" ? value.channel : null;
    if (!channel) return this.fail();
    const binary = value.binary === true;
    const frameId = optionalBoundedString(value.frame_id, 64);
    if (frameId === null) return this.fail();

    if (!frameId) {
      if (value.chunk_index !== undefined || value.chunk_count !== undefined) return this.fail();
      const encoded = requiredBoundedString(
        value.data,
        Math.ceil(MACHINE_LIMITS.codexAgentRelayFrameMaxBytes / 3) * 4,
      );
      if (encoded === null) return this.fail();
      const data = Buffer.from(encoded, "base64");
      if (data.byteLength > MACHINE_LIMITS.codexAgentRelayFrameMaxBytes) return this.fail();
      return { channel, data, binary };
    }

    const chunkIndex = boundedInteger(value.chunk_index, 0, MACHINE_LIMITS.codexAgentRelayMaxChunks - 1);
    const chunkCount = boundedInteger(value.chunk_count, 2, MACHINE_LIMITS.codexAgentRelayMaxChunks);
    const encoded = requiredBoundedString(value.data, MACHINE_LIMITS.codexAgentRelayChunkBase64MaxBytes);
    if (chunkIndex === null || chunkCount === null || chunkIndex >= chunkCount || encoded === null) return this.fail();
    const data = Buffer.from(encoded, "base64");
    if (data.byteLength > MACHINE_LIMITS.codexAgentRelayChunkBytes
      || (chunkIndex < chunkCount - 1 && data.byteLength !== MACHINE_LIMITS.codexAgentRelayChunkBytes)) {
      return this.fail();
    }

    let frame = this.pending.get(frameId);
    if (chunkIndex === 0) {
      if (frame) return this.fail();
      frame = { channel, binary, chunkCount, chunks: [], byteLength: 0 };
      this.pending.set(frameId, frame);
    }
    if (!frame
      || frame.channel !== channel
      || frame.binary !== binary
      || frame.chunkCount !== chunkCount
      || frame.chunks.length !== chunkIndex) {
      return this.fail();
    }
    frame.chunks.push(data);
    frame.byteLength += data.byteLength;
    this.pendingBytes += data.byteLength;
    if (frame.byteLength > MACHINE_LIMITS.codexAgentRelayFrameMaxBytes
      || this.pendingBytes > AGENT_RELAY_MAX_QUEUED_BYTES) {
      return this.fail();
    }
    if (frame.chunks.length < chunkCount) return null;

    this.pending.delete(frameId);
    this.pendingBytes -= frame.byteLength;
    return { channel, data: Buffer.concat(frame.chunks, frame.byteLength), binary };
  }

  hasPendingFrames(): boolean {
    return this.pending.size > 0;
  }

  clear(): void {
    this.pending.clear();
    this.pendingBytes = 0;
  }

  private fail(): never {
    this.clear();
    throw new Error("Codex agent relay fragment sequence is invalid");
  }
}

/** The one thing this relay needs from the shared isolated app-server host. */
export interface CodexAgentRelayHost {
  ensure(): Promise<string>;
  acquire?(): Promise<{ endpoint: string; release(): void }>;
}

export interface CodexAgentRelayManagerOptions {
  /** Test seam: how an "agent" socket to the host endpoint is opened. */
  connectAgent?: (endpoint: string) => Promise<WebSocket>;
}

export class CodexAgentRelayManager {
  private readonly tunnels = new Map<string, AgentTunnel>();
  private readonly connectAgent: (endpoint: string) => Promise<WebSocket>;

  constructor(
    private readonly host: CodexAgentRelayHost,
    options: CodexAgentRelayManagerOptions = {},
  ) {
    this.connectAgent = options.connectAgent ?? openAgentSocket;
  }

  async execute(method: string, args: Record<string, unknown>): Promise<unknown> {
    if (method === "codex_agent_open") return await this.open(args);
    const tunnelId = boundedString(args.tunnel_id, 128);
    const tunnel = this.tunnels.get(tunnelId);
    if (!tunnel) throw new Error("Codex agent relay tunnel is unavailable");
    if (method === "codex_agent_read") return await this.read(tunnel, args);
    if (method === "codex_agent_write") return await this.write(tunnel, args);
    if (method === "codex_agent_close") {
      await this.closeTunnel(tunnelId, tunnel);
      return { closed: true };
    }
    throw new Error(`unknown Codex agent relay method: ${method}`);
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.tunnels].map(([id, tunnel]) => this.closeTunnel(id, tunnel)));
  }

  private async open(args: Record<string, unknown>): Promise<{
    tunnel_id: string;
    environment_endpoint: string;
    relay_protocol?: string;
  }> {
    if (this.tunnels.size >= AGENT_RELAY_MAX_TUNNELS) throw new Error("too many live Codex agent relay tunnels");
    const lease = await this.host.acquire?.();
    let retained = false;
    try {
    const endpoint = lease?.endpoint ?? await this.host.ensure();
    const agentSocket = await this.connectAgent(endpoint);
    const envServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    try {
      await websocketServerListening(envServer, AGENT_RELAY_CONNECT_TIMEOUT_MS);
    } catch (error) {
      agentSocket.terminate();
      throw error;
    }
    const tunnelId = randomUUID();
    const tunnel: AgentTunnel = {
      releaseHost: lease?.release,
      agentSocket,
      envServer,
      envSocket: null,
      frames: [],
      inbound: new CodexAgentRelayFrameAssembler(),
      fragmented: args.relay_protocol === MACHINE_LIMITS.codexAgentRelayProtocol,
      queuedBytes: 0,
      waiter: null,
      closed: false,
      error: "",
    };
    agentSocket.on("message", (data, binary) => this.acceptFrame(tunnelId, tunnel, "agent", data, binary));
    agentSocket.on("close", (_code, reason) => {
      // The control connection IS the turn; losing it ends the tunnel.
      tunnel.closed = true;
      tunnel.error = tunnel.error || reason.toString();
      tunnel.waiter?.();
      tunnel.waiter = null;
    });
    agentSocket.on("error", (error) => {
      tunnel.error = error.message;
      tunnel.waiter?.();
      tunnel.waiter = null;
    });
    envServer.on("connection", (socket) => {
      // Same policy as the exec relay coordinator: one live environment
      // connection at a time, sequential reconnects allowed.
      if (tunnel.closed || tunnel.envSocket) {
        socket.close(1008, "Codex agent relay accepts one environment connection");
        return;
      }
      tunnel.envSocket = socket;
      socket.on("message", (data, binary) => this.acceptFrame(tunnelId, tunnel, "env", data, binary));
      socket.once("close", () => {
        if (tunnel.envSocket === socket) tunnel.envSocket = null;
      });
      socket.on("error", () => socket.terminate());
    });
    this.tunnels.set(tunnelId, tunnel);
    retained = true;
    const address = envServer.address() as AddressInfo;
    return {
      tunnel_id: tunnelId,
      environment_endpoint: `ws://127.0.0.1:${address.port}`,
      ...(tunnel.fragmented ? { relay_protocol: MACHINE_LIMITS.codexAgentRelayProtocol } : {}),
    };
    } finally { if (!retained) lease?.release(); }
  }

  private acceptFrame(
    tunnelId: string,
    tunnel: AgentTunnel,
    channel: CodexAgentRelayChannel,
    data: RawData,
    binary: boolean,
  ): void {
    if (tunnel.closed || this.tunnels.get(tunnelId) !== tunnel) return;
    const bytes = rawDataBuffer(data);
    if (bytes.byteLength > MACHINE_LIMITS.codexAgentRelayFrameMaxBytes
      || tunnel.queuedBytes + bytes.byteLength > AGENT_RELAY_MAX_QUEUED_BYTES) {
      tunnel.error = "Codex agent relay output exceeded its bounded queue";
      tunnel.closed = true;
      tunnel.agentSocket.close(1009, "relay queue limit");
      tunnel.envSocket?.close(1009, "relay queue limit");
    } else {
      const wireFrames = tunnel.fragmented
        ? fragmentCodexAgentRelayFrame(channel, bytes, binary)
        : [{ channel, data: bytes.toString("base64"), binary }];
      tunnel.frames.push(...wireFrames.map((frame) => ({
        ...frame,
        byteLength: Buffer.from(frame.data, "base64").byteLength,
      })));
      tunnel.queuedBytes += bytes.byteLength;
    }
    tunnel.waiter?.();
    tunnel.waiter = null;
  }

  private async read(tunnel: AgentTunnel, args: Record<string, unknown>): Promise<unknown> {
    if (!tunnel.frames.length && !tunnel.closed) {
      if (tunnel.waiter) throw new Error("Codex agent relay already has a pending read");
      const requested = Number(args.wait_ms ?? AGENT_RELAY_READ_WAIT_MS);
      const waitMs = Number.isFinite(requested)
        ? Math.max(0, Math.min(AGENT_RELAY_READ_WAIT_MS, Math.floor(requested)))
        : AGENT_RELAY_READ_WAIT_MS;
      const { promise, resolve } = deferred<void>();
      const timer = setTimeout(resolve, waitMs);
      timer.unref?.();
      tunnel.waiter = resolve;
      await promise;
      clearTimeout(timer);
      if (tunnel.waiter === resolve) tunnel.waiter = null;
    }
    const frames: CodexAgentRelayWireFrame[] = [];
    let batchBytes = 0;
    while (tunnel.frames.length) {
      const next = tunnel.frames[0];
      if (frames.length && batchBytes + next.byteLength > MACHINE_LIMITS.codexAgentRelayReadBatchBytes) break;
      tunnel.frames.shift();
      batchBytes += next.byteLength;
      const { byteLength: _byteLength, ...wire } = next;
      frames.push(wire);
    }
    tunnel.queuedBytes -= batchBytes;
    return {
      frames,
      // A closed socket may still have several bounded batches queued. The bot
      // tears down only after the last complete WebSocket message is drained.
      closed: tunnel.closed && tunnel.frames.length === 0,
      ...(tunnel.error ? { error: tunnel.error } : {}),
    };
  }

  private async write(tunnel: AgentTunnel, args: Record<string, unknown>): Promise<unknown> {
    if (tunnel.closed) throw new Error(tunnel.error || "Codex agent relay tunnel is closed");
    if (!tunnel.fragmented && args.frame_id !== undefined) {
      throw new Error("Codex agent relay fragmentation was not negotiated");
    }
    const frame = tunnel.inbound.accept(args);
    if (!frame) return { accepted: true };
    const socket = frame.channel === "agent" ? tunnel.agentSocket : tunnel.envSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error(frame.channel === "agent"
        ? "Codex agent relay control socket is closed"
        : "Codex agent relay environment is not connected");
    }
    const { promise, resolve, reject } = deferred<void>();
    socket.send(frame.data, { binary: frame.binary }, (error) => {
      if (error) reject(error);
      else resolve();
    });
    await promise;
    return { accepted: true };
  }

  private async closeTunnel(id: string, tunnel: AgentTunnel): Promise<void> {
    if (this.tunnels.get(id) !== tunnel) return;
    this.tunnels.delete(id);
    tunnel.closed = true;
    tunnel.inbound.clear();
    tunnel.waiter?.();
    tunnel.waiter = null;
    tunnel.envSocket?.close(1000, "Codex agent relay released");
    await closeWebSocketServer(tunnel.envServer);
    await closeWebSocket(tunnel.agentSocket);
    tunnel.releaseHost?.();
  }
}

async function openAgentSocket(endpoint: string): Promise<WebSocket> {
  if (!/^ws:\/\/127\.0\.0\.1:\d+$/.test(endpoint)) {
    throw new Error("refusing non-loopback Codex app-server endpoint");
  }
  const socket = new WebSocket(endpoint);
  const { promise, resolve, reject } = deferred<void>();
  const timer = setTimeout(() => {
    socket.terminate();
    reject(new Error("Codex app-server WebSocket connect timed out"));
  }, AGENT_RELAY_CONNECT_TIMEOUT_MS);
  timer.unref?.();
  socket.once("open", () => { clearTimeout(timer); resolve(); });
  socket.once("error", (error) => { clearTimeout(timer); reject(error); });
  await promise;
  return socket;
}

async function websocketServerListening(server: WebSocketServer, timeoutMs: number): Promise<void> {
  if (server.address()) return;
  const { promise, resolve, reject } = deferred<void>();
  const timer = setTimeout(() => reject(new Error("Codex agent relay listen timed out")), timeoutMs);
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
  socket.close(1000, "Codex agent relay released");
  await promise;
}

async function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  const { promise, resolve } = deferred<void>();
  server.close(() => resolve());
  await promise;
}

function rawDataBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

function boundedString(value: unknown, max: number): string {
  return typeof value === "string" && value.length <= max ? value : "";
}

function optionalBoundedString(value: unknown, max: number): string | null {
  return value === undefined || value === null
    ? ""
    : typeof value === "string" && value.length <= max ? value : null;
}

function requiredBoundedString(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length <= max ? value : null;
}

function boundedInteger(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : null;
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
