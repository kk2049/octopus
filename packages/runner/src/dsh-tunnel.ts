import { request } from "node:http";
import net from "node:net";
import { createWebSocketStream, WebSocket, type RawData } from "ws";

const DEFAULT_DSH_PORT = 9931;
const CONNECT_TIMEOUT_MS = 5_000;
const MAX_TUNNELS = 16;

export interface RunnerDshTunnelSettings {
  enabled: boolean;
  port: number;
}

export function runnerDshTunnelSettings(
  env: Readonly<Record<string, string | undefined>> = process.env,
): RunnerDshTunnelSettings {
  const enabled = env.OCTOPUS_RUNNER_DSH_TUNNEL === "1";
  const rawPort = env.OCTOPUS_RUNNER_DSH_PORT ?? String(DEFAULT_DSH_PORT);
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("OCTOPUS_RUNNER_DSH_PORT must be 1..65535");
  }
  return { enabled, port };
}

export async function probeLocalDsh(
  settings: RunnerDshTunnelSettings,
  timeoutMs = 2_000,
): Promise<{ available: boolean; port?: number }> {
  if (!settings.enabled) return { available: false };
  const available = await new Promise<boolean>((resolve) => {
    const req = request({
      host: "127.0.0.1",
      port: settings.port,
      path: "/healthz",
      method: "GET",
      timeout: timeoutMs,
      headers: { host: `127.0.0.1:${settings.port}`, connection: "close" },
    }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.once("timeout", () => { req.destroy(); resolve(false); });
    req.once("error", () => resolve(false));
    req.end();
  });
  return available ? { available: true, port: settings.port } : { available: false };
}

/**
 * Device-side half of a connection-scoped reverse tunnel.
 *
 * The authenticated Runner control socket receives a one-time offer. A second
 * outbound WebSocket spends that offer and then becomes a raw, backpressured
 * byte stream to the loopback-only DSH listener. The public side can never name
 * another host or port: both are fixed by this Runner's local configuration.
 */
export class RunnerDshTunnelRuntime {
  private readonly active = new Set<net.Socket>();

  constructor(
    private readonly gatewayUrl: string,
    private readonly settings: RunnerDshTunnelSettings,
    private readonly log: (message: string) => void = () => {},
  ) {}

  handle(control: WebSocket, message: Record<string, unknown>): boolean {
    if (message.type !== "dsh_tunnel_open") return false;
    const tunnelId = typeof message.tunnelId === "string" ? message.tunnelId : "";
    const secret = typeof message.secret === "string" ? message.secret : "";
    if (!/^[0-9a-f-]{36}$/.test(tunnelId) || !/^[0-9a-f]{64}$/.test(secret)) {
      this.reply(control, tunnelId, false, "invalid tunnel offer");
      return true;
    }
    if (!this.settings.enabled) {
      this.reply(control, tunnelId, false, "DSH forwarding is disabled on this Runner");
      return true;
    }
    if (this.active.size >= MAX_TUNNELS) {
      this.reply(control, tunnelId, false, "DSH tunnel limit reached");
      return true;
    }
    void this.open(control, tunnelId, secret);
    return true;
  }

  disconnect(): void {
    for (const socket of this.active) socket.destroy();
    this.active.clear();
  }

  private async open(control: WebSocket, tunnelId: string, secret: string): Promise<void> {
    let local: net.Socket | null = null;
    let tunnel: WebSocket | null = null;
    try {
      local = await connectLoopback(this.settings.port);
      this.active.add(local);
      tunnel = new WebSocket(this.gatewayUrl, { perMessageDeflate: false, handshakeTimeout: CONNECT_TIMEOUT_MS });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("DSH tunnel registration timeout")), CONNECT_TIMEOUT_MS);
        const fail = (error: Error): void => { clearTimeout(timer); reject(error); };
        const onMessage = (data: RawData, isBinary: boolean): void => {
          if (isBinary) return;
          let value: Record<string, unknown>;
          try { value = JSON.parse(String(data)) as Record<string, unknown>; } catch { return; }
          if (value.type !== "registered" || value.protocol !== "dsh-tunnel/v1" || value.tunnelId !== tunnelId) return;
          clearTimeout(timer);
          tunnel!.off("message", onMessage);
          tunnel!.off("error", fail);
          resolve();
        };
        tunnel!.once("open", () => tunnel!.send(JSON.stringify({
          type: "register",
          protocol: "dsh-tunnel/v1",
          tunnelId,
          secret,
        })));
        tunnel!.on("message", onMessage);
        tunnel!.once("error", fail);
      });
      const stream = createWebSocketStream(tunnel, { encoding: undefined });
      const close = (): void => {
        local?.destroy();
        stream.destroy();
        tunnel?.close();
      };
      local.once("error", close);
      local.once("close", close);
      stream.once("error", close);
      stream.once("close", close);
      local.pipe(stream).pipe(local);
      this.log(`DSH tunnel ${tunnelId} connected to loopback:${this.settings.port}`);
    } catch (error) {
      local?.destroy();
      tunnel?.close();
      this.reply(control, tunnelId, false, error instanceof Error ? error.message : String(error));
    } finally {
      if (local) local.once("close", () => this.active.delete(local!));
    }
  }

  private reply(control: WebSocket, tunnelId: string, ok: boolean, error?: string): void {
    if (control.readyState !== WebSocket.OPEN) return;
    control.send(JSON.stringify({ type: "dsh_tunnel_result", tunnelId, ok, ...(error ? { error } : {}) }));
  }
}

function connectLoopback(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const timer = setTimeout(() => socket.destroy(new Error("DSH loopback connection timeout")), CONNECT_TIMEOUT_MS);
    socket.once("connect", () => { clearTimeout(timer); socket.off("error", reject); resolve(socket); });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}
