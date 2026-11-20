/**
 * Bot-host bridge for a dev-ticket turn that runs on the requester's OWN
 * Runner device's Codex (#358).
 *
 * Placement: the model brain (Codex app-server, the device's own credentials)
 * runs on the Runner; the execution environment stays HERE — a loopback
 * `codex exec-server` spawned in the ticket's worktree, so every shell/file
 * tool of the remote agent operates on exactly the tree a local ticket agent
 * would see, and landing custody does not change.
 *
 * The bridge exposes two loopback ends to existing code:
 *   · `endpoint` — a 127.0.0.1 WebSocket the executor's CodexManagedSession
 *     attaches to; frames are pumped to the device over the codex_agent_*
 *     relay ("agent" channel);
 *   · `environment.execServerUrl` — the device-local endpoint the app-server
 *     connects to after `environment/add`; those frames come back on the
 *     "env" channel and are piped into the local exec-server.
 *
 * All relay calls run through the turn's RemoteCodexGrant; this module never
 * sees a device name or a credential.
 */

import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { MACHINE_LIMITS } from "@claude-bot/runner/limits";
import {
  CodexAgentRelayFrameAssembler,
  fragmentCodexAgentRelayFrame,
  type CodexAgentRelayDecodedFrame,
  type CodexAgentRelayWireFrame,
} from "@claude-bot/runner/codex-agent-relay";
import { openLocalExecServer, type ExecServerConnection } from "@claude-bot/runner/codex-exec-relay";

export type RemoteCodexCall = (op: string, args: Record<string, unknown>) => Promise<unknown>;

export interface RemoteCodexBridge {
  /** Loopback ws endpoint for CodexManagedSession's `endpoint` option. */
  endpoint: string;
  /** For CodexManagedSession's `environment` option (device-local URL). */
  environment: { environmentId: string; execServerUrl: string };
  close(): Promise<void>;
}

const BRIDGE_READ_WAIT_MS = 15_000;
const BRIDGE_LISTEN_TIMEOUT_MS = 10_000;
/** Frames the app-server sent before the executor attached; tiny in practice. */
const BRIDGE_MAX_BUFFERED_FRAMES = 256;

export async function openRemoteCodexBridge(input: {
  call: RemoteCodexCall;
  worktree: string;
  /** Stable per-ticket label; becomes part of the Codex environment id. */
  label: string;
  /** Test seam for the local exec-server spawn. */
  openExec?: (cwd: string) => Promise<ExecServerConnection>;
}): Promise<RemoteCodexBridge> {
  const exec = await (input.openExec ?? openLocalExecServer)(input.worktree);

  let opened: Record<string, unknown>;
  try {
    opened = asObject(await input.call("codex_agent_open", {
      relay_protocol: MACHINE_LIMITS.codexAgentRelayProtocol,
    }));
  } catch (error) {
    await exec.close().catch(() => {});
    throw error;
  }
  const tunnelId = asBoundedString(opened.tunnel_id, 128);
  const environmentEndpoint = asBoundedString(opened.environment_endpoint, 64);
  const fragmented = opened.relay_protocol === MACHINE_LIMITS.codexAgentRelayProtocol;
  if (!tunnelId || !environmentEndpoint) {
    await exec.close().catch(() => {});
    await input.call("codex_agent_close", { tunnel_id: tunnelId }).catch(() => {});
    throw new Error("Runner 没有返回完整的 Codex agent 隧道信息");
  }

  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  try {
    await serverListening(server);
  } catch (error) {
    await exec.close().catch(() => {});
    await input.call("codex_agent_close", { tunnel_id: tunnelId }).catch(() => {});
    throw error;
  }

  let closed = false;
  let agentConn: WebSocket | null = null;
  const bufferedAgentFrames: Array<{ data: Buffer; binary: boolean }> = [];
  const incoming = new CodexAgentRelayFrameAssembler();
  // One serialized write chain keeps relay frame order identical to socket order.
  let writes: Promise<void> = Promise.resolve();

  const teardown = async (reason: string): Promise<void> => {
    if (closed) return;
    closed = true;
    incoming.clear();
    agentConn?.close(1011, reason.slice(0, 120));
    agentConn = null;
    await closeServer(server);
    await exec.close().catch(() => {});
    await input.call("codex_agent_close", { tunnel_id: tunnelId }).catch(() => {});
  };

  const sendFrame = (channel: "agent" | "env", data: RawData, binary: boolean): void => {
    if (closed) return;
    const bytes = rawDataBuffer(data);
    let fragments: CodexAgentRelayWireFrame[];
    try {
      fragments = fragmentCodexAgentRelayFrame(channel, bytes, binary);
      if (!fragmented && fragments.length > 1) {
        throw new Error("Runner 版本不支持有界 Codex agent 隧道分片");
      }
    } catch (error) {
      void teardown(reasonOf(error));
      return;
    }
    writes = writes.then(async () => {
      for (const fragment of fragments) {
        if (closed) return;
        await input.call("codex_agent_write", { tunnel_id: tunnelId, ...fragment });
      }
    }).catch((error) => {
      void teardown(reasonOf(error));
    });
  };

  server.on("connection", (socket) => {
    if (closed || agentConn) {
      socket.close(1008, "Codex agent bridge accepts one attachment");
      return;
    }
    agentConn = socket;
    for (const frame of bufferedAgentFrames.splice(0)) {
      if (socket.readyState === WebSocket.OPEN) socket.send(frame.data, { binary: frame.binary });
    }
    socket.on("message", (data, binary) => sendFrame("agent", data, binary));
    socket.once("close", () => {
      if (agentConn === socket) agentConn = null;
    });
    socket.on("error", () => socket.terminate());
  });

  exec.socket.on("message", (data, binary) => sendFrame("env", data, binary));
  exec.socket.once("close", () => {
    // The worktree exec-server IS the agent's hands; losing it ends the turn.
    void teardown("ticket worktree exec-server disconnected");
  });
  exec.socket.on("error", () => {
    void teardown("ticket worktree exec-server failed");
  });

  const deliverAgentFrame = (frame: { data: Buffer; binary: boolean }): void => {
    const socket = agentConn;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(frame.data, { binary: frame.binary });
      return;
    }
    if (bufferedAgentFrames.length >= BRIDGE_MAX_BUFFERED_FRAMES) {
      void teardown("Codex agent bridge buffered too many unattached frames");
      return;
    }
    bufferedAgentFrames.push(frame);
  };

  void (async () => {
    while (!closed) {
      let result: Record<string, unknown>;
      try {
        result = asObject(await input.call("codex_agent_read", {
          tunnel_id: tunnelId,
          wait_ms: BRIDGE_READ_WAIT_MS,
        }));
      } catch (error) {
        await teardown(reasonOf(error));
        return;
      }
      for (const value of asArray(result.frames)) {
        let frame: CodexAgentRelayDecodedFrame | null;
        try {
          frame = incoming.accept(asObject(value));
        } catch (error) {
          await teardown(reasonOf(error));
          return;
        }
        if (!frame) continue;
        if (frame.channel === "env") {
          if (exec.socket.readyState === WebSocket.OPEN) exec.socket.send(frame.data, { binary: frame.binary });
        } else {
          deliverAgentFrame(frame);
        }
      }
      if (result.closed === true) {
        const reason = incoming.hasPendingFrames()
          ? "Runner 侧 Codex agent 隧道在完整帧到达前结束"
          : asBoundedString(result.error, 200) || "Runner 侧 Codex app-server 连接已结束";
        await teardown(reason);
        return;
      }
    }
  })();

  const address = server.address() as AddressInfo;
  return {
    endpoint: `ws://127.0.0.1:${address.port}`,
    environment: {
      environmentId: `octopus-devpipe-${input.label.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80)}`,
      execServerUrl: environmentEndpoint,
    },
    close: () => teardown("dev turn released"),
  };
}

async function serverListening(server: WebSocketServer): Promise<void> {
  if (server.address()) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Codex agent bridge listen timed out")), BRIDGE_LISTEN_TIMEOUT_MS);
    timer.unref?.();
    server.once("listening", () => { clearTimeout(timer); resolve(); });
    server.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

async function closeServer(server: WebSocketServer): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function rawDataBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asBoundedString(value: unknown, max: number): string {
  return typeof value === "string" && value.length <= max ? value : "";
}

function reasonOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200) || "Codex agent bridge failed";
}
