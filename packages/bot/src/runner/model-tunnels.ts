/**
 * Guest model tunnels (`model-tunnel/v1`, 2026-11-12).
 *
 * A guest client device (`runner_guest_profiles`) runs Claude Code or Codex on
 * the guest's own computer, so their tools act on that computer. Only the
 * model request leaves it: each TCP connection those CLIs open to the guest
 * Runner's loopback port becomes one guest WebSocket here. The broker offers
 * it to the profile's model host over that host's authenticated control
 * socket; the host dials a second WebSocket that spends the one-time secret,
 * and the two are joined as one raw, backpressured byte stream.
 *
 * The gateway never parses the HTTP inside the stream. The host's model egress
 * applies the route allowlist and injects the owner's model login on the host,
 * so the login never crosses the gateway or reaches the guest.
 *
 * Authority is server-side only. The guest presents its device token and
 * nothing else. The profile row names the host and the providers. The offer
 * carries the guest's identity and providers so the host can enforce and
 * account per guest. A guest cannot name another host, user or provider.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Duplex } from "node:stream";
import { createWebSocketStream, WebSocket } from "ws";
import type { RunnerGuestProfileRow, RunnerTokenRow } from "../store/store.js";

export const MODEL_TUNNEL_GUEST_PROTOCOL = "model-tunnel-guest/v1";
export const MODEL_TUNNEL_HOST_PROTOCOL = "model-tunnel-host/v1";
export const MODEL_EGRESS_PROTOCOL = "model-egress/v1";
/** Why a guest tunnel was refused: the guest maps it to a retryable or final HTTP status. */
export type ModelTunnelRefusal = "unauthorized" | "host_unavailable" | "capacity";

const OFFER_TIMEOUT_MS = 10_000;
/** One guest CLI keeps a few keep-alive connections; leave room for two CLIs and retries. */
export const MAX_MODEL_TUNNELS_PER_GUEST = 24;
export const MAX_MODEL_TUNNELS_PER_HOST = 96;

export interface ModelTunnelHost {
  ws: WebSocket;
  /** Whether this exact connection advertised `model-egress/v1`. */
  egress: boolean;
}

export interface ModelTunnelBrokerDeps {
  tokenRow(tokenHash: string): RunnerTokenRow | undefined;
  guestProfile(username: string, device: string): RunnerGuestProfileRow | undefined;
  /** The owner's live control connection for `device`, if any. */
  host(username: string, device: string): ModelTunnelHost | undefined;
  hashToken(token: string): string;
  log?: (fields: Record<string, unknown>, message: string) => void;
}

interface Pending {
  id: string;
  username: string;
  guest: string;
  host: string;
  tokenHash: string;
  hostWs: WebSocket;
  secretHash: Buffer;
  guestWs: WebSocket;
  guestStream: Duplex;
  timer: NodeJS.Timeout;
}

interface Active {
  username: string;
  guest: string;
  host: string;
  tokenHash: string;
  sockets: WebSocket[];
  close: () => void;
}

/**
 * Last inbound frame (data or pong) per joined socket. A slow uplink can hold
 * a pong behind a large request body, so only a long silence is a dead link.
 */
const lastHeard = new WeakMap<WebSocket, number>();
const TUNNEL_SILENT_AFTER_MS = 60_000;

export class ModelTunnelBroker {
  private readonly pending = new Map<string, Pending>();
  private readonly active = new Set<Active>();

  constructor(private readonly deps: ModelTunnelBrokerDeps) {}

  /**
   * Handle a pre-registration `register` frame. True means the frame belonged
   * to a model tunnel (accepted or refused) and the caller must stop.
   */
  handleRegister(ws: WebSocket, message: Record<string, unknown>): boolean {
    if (message.protocol === MODEL_TUNNEL_GUEST_PROTOCOL) {
      this.acceptGuest(ws, message);
      return true;
    }
    if (message.protocol === MODEL_TUNNEL_HOST_PROTOCOL) {
      this.claimHost(ws, message);
      return true;
    }
    return false;
  }

  /** The host's control socket went away: its unanswered offers fail now. */
  hostDisconnected(username: string, device: string): void {
    for (const pending of [...this.pending.values()]) {
      if (pending.username === username && pending.host === device) this.fail(pending, "模型主机已断开");
    }
  }

  /** Gateway shutdown: every pending offer and joined tunnel ends. */
  close(): void {
    for (const pending of [...this.pending.values()]) this.fail(pending, "网关正在重启");
    for (const active of [...this.active]) active.close();
  }

  /**
   * One keepalive round, run from the gateway's own sweep. A tunnel whose
   * guest credential or profile is gone closes (revocation reaches open
   * streams within one round). A socket silent for a minute (no data, no
   * pong) is a half-open link a middlebox dropped; terminating it frees the
   * per-guest slots it would otherwise hold forever.
   */
  sweep(stalled = false, now = Date.now()): void {
    for (const active of [...this.active]) {
      if (!this.deps.tokenRow(active.tokenHash) || !this.deps.guestProfile(active.username, active.guest)) {
        this.deps.log?.({ username: active.username, guest: active.guest }, "Model tunnel closed: guest revoked");
        active.close();
        continue;
      }
      if (!stalled && active.sockets.some((socket) => now - (lastHeard.get(socket) ?? now) > TUNNEL_SILENT_AFTER_MS)) {
        active.close();
        continue;
      }
      for (const socket of active.sockets) {
        try { socket.ping(); } catch { /* closing; its close handler ends the tunnel */ }
      }
    }
  }

  stats(): { pending: number; active: number } {
    return { pending: this.pending.size, active: this.active.size };
  }

  private acceptGuest(ws: WebSocket, message: Record<string, unknown>): void {
    // `code` tells the guest whether retrying can help: a CLI must not keep
    // retrying a revoked device, but should ride out a host restart.
    const refuse = (code: number, kind: ModelTunnelRefusal, reason: string): void => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "error", protocol: MODEL_TUNNEL_GUEST_PROTOCOL, code: kind, message: reason }));
      }
      ws.close(code, Buffer.from(reason).subarray(0, 120).toString());
    };
    const token = typeof message.token === "string" ? message.token : "";
    const row = token ? this.deps.tokenRow(this.deps.hashToken(token)) : undefined;
    if (!row) return refuse(4003, "unauthorized", "invalid token");
    const profile = this.deps.guestProfile(row.username, row.device);
    if (!profile) return refuse(4003, "unauthorized", "this device is not a guest client");
    const host = this.deps.host(row.username, profile.model_host);
    if (!host) return refuse(4004, "host_unavailable", `模型主机 ${profile.model_host} 不在线`);
    if (!host.egress) return refuse(4004, "host_unavailable", `模型主机 ${profile.model_host} 没有开启模型出口`);
    const guestCount = this.count((entry) => entry.username === row.username && entry.guest === row.device);
    if (guestCount >= MAX_MODEL_TUNNELS_PER_GUEST) return refuse(4008, "capacity", "这台访客设备的模型连接过多");
    const hostCount = this.count((entry) => entry.username === row.username && entry.host === profile.model_host);
    if (hostCount >= MAX_MODEL_TUNNELS_PER_HOST) return refuse(4008, "capacity", "模型主机的连接已满");

    // From here on the gateway's JSON handler must not see this socket's
    // frames: buffer them in the stream (it pauses the socket when full)
    // until the host side is joined.
    ws.removeAllListeners("message");
    const guestStream = createWebSocketStream(ws, { encoding: undefined });
    guestStream.on("error", () => undefined);
    const id = randomUUID();
    const secret = randomBytes(32).toString("hex");
    const pending: Pending = {
      id,
      username: row.username,
      guest: row.device,
      host: profile.model_host,
      tokenHash: row.token_hash,
      hostWs: host.ws,
      secretHash: createHash("sha256").update(secret).digest(),
      guestWs: ws,
      guestStream,
      timer: setTimeout(() => this.fail(pending, "模型主机没有及时接通"), OFFER_TIMEOUT_MS),
    };
    this.pending.set(id, pending);
    ws.once("close", () => {
      if (this.pending.get(id) === pending) this.fail(pending, "访客已断开");
    });
    host.ws.send(JSON.stringify({
      type: "model_tunnel_open",
      tunnelId: id,
      secret,
      guest: { device: row.device, providers: profile.providers.split(",") },
    }), (error) => {
      if (error) this.fail(pending, "模型主机已断开");
    });
  }

  private claimHost(ws: WebSocket, message: Record<string, unknown>): void {
    const id = typeof message.tunnelId === "string" ? message.tunnelId : "";
    const secret = typeof message.secret === "string" ? message.secret : "";
    const pending = this.pending.get(id);
    const supplied = createHash("sha256").update(secret).digest();
    if (!pending || !timingSafeEqual(pending.secretHash, supplied)) {
      ws.close(4003, "invalid tunnel credential");
      return;
    }
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (pending.guestWs.readyState !== WebSocket.OPEN) {
      ws.close(1000, "guest closed");
      return;
    }
    ws.removeAllListeners("message");
    const hostStream = createWebSocketStream(ws, { encoding: undefined });
    hostStream.on("error", () => undefined);
    ws.send(JSON.stringify({ type: "registered", protocol: MODEL_TUNNEL_HOST_PROTOCOL, tunnelId: id }));
    pending.guestWs.send(JSON.stringify({ type: "registered", protocol: MODEL_TUNNEL_GUEST_PROTOCOL, tunnelId: id }));
    let closed = false;
    for (const socket of [pending.guestWs, ws]) {
      const heard = (): void => { lastHeard.set(socket, Date.now()); };
      heard();
      socket.on("pong", heard);
      socket.on("message", heard);
    }
    const active: Active = {
      username: pending.username,
      guest: pending.guest,
      host: pending.host,
      tokenHash: pending.tokenHash,
      sockets: [pending.guestWs, ws],
      close: () => {
        if (closed) return;
        closed = true;
        this.active.delete(active);
        pending.guestStream.destroy();
        hostStream.destroy();
        for (const socket of [pending.guestWs, ws]) {
          if (socket.readyState === WebSocket.OPEN) socket.close(1000);
          else if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
        }
      },
    };
    this.active.add(active);
    for (const stream of [pending.guestStream, hostStream]) {
      stream.once("close", active.close);
      stream.once("error", active.close);
    }
    pending.guestStream.pipe(hostStream);
    hostStream.pipe(pending.guestStream);
    this.deps.log?.({ username: pending.username, guest: pending.guest, host: pending.host }, "Model tunnel joined");
  }

  private fail(pending: Pending, reason: string): void {
    if (this.pending.get(pending.id) !== pending) return;
    this.pending.delete(pending.id);
    clearTimeout(pending.timer);
    // The error frame and close frame flush first; the buffered stream dies
    // with the socket. A socket already gone just drops its buffer.
    if (pending.guestWs.readyState === WebSocket.OPEN) {
      pending.guestWs.send(JSON.stringify({ type: "error", protocol: MODEL_TUNNEL_GUEST_PROTOCOL, code: "host_unavailable", message: reason }));
      pending.guestWs.close(4004, Buffer.from(reason).subarray(0, 120).toString());
    } else {
      pending.guestStream.destroy();
    }
  }

  private count(match: (entry: { username: string; guest: string; host: string }) => boolean): number {
    let total = 0;
    for (const entry of this.pending.values()) if (match(entry)) total++;
    for (const entry of this.active) if (match(entry)) total++;
    return total;
  }
}
