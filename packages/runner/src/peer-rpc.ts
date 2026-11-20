import { ManagedDependencyUnavailable } from "./managed-execution.js";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { AgentProvider } from "./agent-runtime.js";
import type { ManagedRecoveryScope, ManagedRecoveryScopeClient } from "./agent-control-plane.js";

export interface PeerRpcRequest {
  target: string;
  workspaceId: string;
  executionToken: string;
  method: "codex_exec_open" | "codex_exec_read" | "codex_exec_write" | "codex_exec_reconnect" | "codex_exec_close";
  args: Record<string, unknown>;
  timeoutMs?: number;
}

export interface ExecutionPeerRpc {
  request(input: PeerRpcRequest): Promise<unknown>;
}

interface PendingPeerRpc {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

/**
 * Origin-side half of the authenticated Runner-to-Runner RPC path.
 *
 * It owns no reconnect policy. The Runner process attaches only its current
 * authenticated gateway socket; losing that socket rejects every in-flight
 * relay request so a managed provider sees the environment disconnect instead
 * of silently waiting on a stale generation.
 */
export class RunnerPeerRpcClient implements ExecutionPeerRpc, ManagedRecoveryScopeClient {
  private socket: WebSocket | null = null;
  private readonly pending = new Map<string, PendingPeerRpc>();

  attach(socket: WebSocket): void {
    if (this.socket && this.socket !== socket) this.detach(this.socket, "Runner gateway connection replaced");
    this.socket = socket;
  }

  detach(socket: WebSocket, reason = "Runner gateway connection closed"): void {
    if (this.socket !== socket) return;
    this.socket = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new ManagedDependencyUnavailable(reason));
    }
    this.pending.clear();
  }

  handle(message: Record<string, unknown>): boolean {
    if (
      message.type !== "peer_rpc_result"
      && message.type !== "session_recovery_scope_result"
    ) return false;
    if (typeof message.id !== "string") return true;
    const pending = this.pending.get(message.id);
    if (!pending) return true;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok === true) pending.resolve(message.result);
    else {
      const detail = typeof message.error === "string" ? message.error : "execution relay failed";
      pending.reject(message.code === "transport_unavailable" ? new ManagedDependencyUnavailable(detail) : new Error(detail));
    }
    return true;
  }

  /** ManagedRecoveryScopeClient's intentionally short verb. */
  async request(provider: AgentProvider, sessionId: string): Promise<ManagedRecoveryScope>;
  async request(input: PeerRpcRequest): Promise<unknown>;
  async request(
    input: PeerRpcRequest | AgentProvider,
    sessionId?: string,
  ): Promise<unknown> {
    if (typeof input !== "string") return await this.requestPeer(input);
    return await this.requestRecovery(input, String(sessionId ?? ""));
  }

  private requestPeer(input: PeerRpcRequest): Promise<unknown> {
    return this.sendRequest({
      type: "peer_rpc",
      target: input.target,
      workspaceId: input.workspaceId,
      executionToken: input.executionToken,
      method: input.method,
      args: input.args,
    }, input.timeoutMs);
  }

  private async requestRecovery(provider: AgentProvider, sessionId: string): Promise<ManagedRecoveryScope> {
    const raw = await this.sendRequest({
      type: "session_recovery_scope",
      provider,
      sessionId,
    }, 30_000);
    const row = raw && typeof raw === "object" && !Array.isArray(raw)
      ? raw as Record<string, unknown>
      : {};
    const scope: ManagedRecoveryScope = {
      token: String(row.token ?? ""),
      endpoint: String(row.endpoint ?? ""),
      expiresAt: Number(row.expiresAt),
      operationId: String(row.operationId ?? ""),
      executionDevice: String(row.executionDevice ?? ""),
      workspaceId: String(row.workspaceId ?? ""),
    };
    if (
      !scope.token.startsWith("mcp_")
      || !scope.endpoint
      || !Number.isFinite(scope.expiresAt)
      || scope.expiresAt <= Date.now()
      || !scope.operationId
      || !scope.executionDevice
      || !/^ws_[0-9a-f]{24}$/.test(scope.workspaceId)
    ) throw new Error("Bot returned an invalid managed recovery scope");
    if (row.development !== undefined) {
      const dev = row.development as Record<string, unknown>;
      if (!dev || typeof dev !== "object" || Array.isArray(dev)
        || typeof dev.developmentId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(dev.developmentId)
        || typeof dev.token !== "string" || !dev.token.startsWith("mcp_") || dev.token.length > 512
        || typeof dev.endpoint !== "string" || !dev.endpoint || dev.endpoint.length > 2048
        || typeof dev.expiresAt !== "number" || !Number.isFinite(dev.expiresAt) || dev.expiresAt <= Date.now()) {
        throw new Error("Bot returned an invalid development recovery scope");
      }
      scope.development = { developmentId: dev.developmentId, token: dev.token, endpoint: dev.endpoint, expiresAt: dev.expiresAt };
    }
    return scope;
  }

  private sendRequest(frame: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new ManagedDependencyUnavailable("Runner gateway is not connected"));
    }
    const id = randomUUID();
    const { promise, resolve, reject } = deferred<unknown>();
    const timer = setTimeout(() => {
      this.pending.delete(id);
      reject(new ManagedDependencyUnavailable(`Runner gateway request timed out (${String(frame.type)})`));
    }, timeoutMs);
    timer.unref?.();
    this.pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ ...frame, id }), (error) => {
      if (!error) return;
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      reject(new ManagedDependencyUnavailable(error.message));
    });
    return promise;
  }

  close(): void {
    const socket = this.socket;
    if (socket) this.detach(socket, "Runner peer RPC client closed");
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
