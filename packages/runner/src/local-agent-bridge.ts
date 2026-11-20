/**
 * Private Runner-local MCP bridge.
 *
 * The resident Runner owns the authenticated WebSocket and a mode-0600 Unix
 * socket. Short-lived `runner.js mcp stdio` children speak standard MCP to a
 * local CLI and relay bounded JSON requests over that socket. Neither the
 * device key nor a server-minted execution credential enters the child.
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import net, { type Socket } from "node:net";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import WebSocket from "ws";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { OCTOPUS_REMOTE_ROUTING_GUIDANCE } from "./agent-routing-guidance.js";
import { localAgentBridgeErrorCode, type LocalAgentBridgeErrorCode } from "./gateway-protocol.js";
import { planRunnerReconnect } from "./gateway-reconnect.js";
import { removeStaleSocket } from "./local-socket.js";

const MAX_LINE_BYTES = 16 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 325_000;
const LEASE_CLOSE_GRACE_MS = 1_000;
const SOCKET_MARKER = "local-agent-bridge/v1";
export const LOCAL_AGENT_MCP_INSTRUCTIONS = `${OCTOPUS_REMOTE_ROUTING_GUIDANCE} `
  + "manual mode may return an approval-required message; tell the user to approve it in Octopus Dashboard. "
  + "The session tools list and message independent or historical Octopus-visible sessions across Runners. "
  + "They do not replace this client's native subagent roster or messaging: use native Codex, Claude, or OMP agent tools "
  + "for subagents of the current parent, and use Octopus session tools only for a persisted external session. "
  + "A session with input_mode=parent_owned must be contacted through its parent_resource_id. Never retry a message after "
  + "approval_required or an indeterminate result. If lease capacity is reached, report the listed runtime-side client/PID, "
  + "target and age; close a stale local Agent or its octopus MCP stdio process. Restarting the target execution Runner does "
  + "not release a lease held by the originating runtime Runner.";

/** Provider-neutral descriptor printed by the stable launcher without mutating any client config. */
export function localAgentMcpDiscovery(command: string): Record<string, unknown> {
  return {
    name: "octopus",
    transport: "stdio",
    command,
    args: [],
    clients: ["codex", "claude", "omp"],
    activation:
      "Register this stdio descriptor explicitly in the current client's MCP configuration, then reload the client if it does not hot-reload MCP servers.",
    default_injection:
      "This discovery command does not change user-level MCP or system-prompt configuration. Dashboard device policy remains authoritative.",
    native_agents:
      "Use each client's native subagent roster/messaging inside the current parent; Octopus session tools are for persisted external or cross-Runner sessions.",
  };
}

export function defaultLocalAgentBridgeSocket(home: string): string {
  return path.join(home, ".octopus", "runner", "local-agent-bridge.sock");
}

interface PendingGatewayRequest {
  socket: Socket;
  clientId: string;
  op: string;
  leaseId?: string;
  orphaned?: boolean;
  timer: NodeJS.Timeout;
}

export class RunnerLocalAgentBridgeRuntime {
  private server: net.Server | null = null;
  private gateway: WebSocket | null = null;
  private readonly pending = new Map<string, PendingGatewayRequest>();
  private readonly clients = new Set<Socket>();
  private readonly clientLeases = new Map<Socket, Set<string>>();
  private readonly clientIds = new Map<Socket, string>();

  constructor(
    readonly socketPath: string,
    private readonly options: {
      requestTimeoutMs?: number;
      development?: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      /** The native session whose CLI spawned the MCP process `pid`; the daemon's own answer, never the caller's. */
      resolveCaller?: (pid: number) => Promise<{ provider: string; sessionId: string } | null>;
    } = {},
  ) {}

  async start(): Promise<void> {
    if (process.platform === "win32") throw new Error("local agent bridge requires Unix sockets");
    await fs.mkdir(path.dirname(this.socketPath), { recursive: true, mode: 0o700 });
    await fs.chmod(path.dirname(this.socketPath), 0o700);
    await removeStaleSocket(this.socketPath);
    const server = net.createServer((socket) => this.accept(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    await fs.chmod(this.socketPath, 0o600);
  }

  attach(socket: WebSocket): void {
    this.gateway = socket;
  }

  detach(socket: WebSocket, reason = "Runner gateway connection closed"): void {
    if (this.gateway === socket) this.gateway = null;
    for (const leases of this.clientLeases.values()) leases.clear();
    for (const [id, pending] of [...this.pending]) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (!pending.orphaned) writeLine(pending.socket, { id: pending.clientId, ok: false, error: reason });
    }
  }

  handle(message: Record<string, unknown>): boolean {
    if (message.type !== "local_agent_bridge_result" || typeof message.id !== "string") return false;
    const pending = this.pending.get(message.id);
    if (!pending) return true;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if ((pending.op === "open" || pending.op === "open_gui") && message.ok === true) {
      const result = message.result && typeof message.result === "object"
        ? message.result as Record<string, unknown>
        : {};
      const leaseId = typeof result.lease_id === "string" ? result.lease_id : "";
      if (leaseId) {
        if (pending.orphaned || pending.socket.destroyed) this.releaseLease(leaseId);
        else this.clientLeases.get(pending.socket)?.add(leaseId);
      }
    } else if (pending.op === "close" && message.ok === true && pending.leaseId) {
      this.clientLeases.get(pending.socket)?.delete(pending.leaseId);
    }
    if (!pending.orphaned) {
      writeLine(pending.socket, message.ok === true
        ? { id: pending.clientId, ok: true, result: message.result }
        : { id: pending.clientId, ok: false, error: String(message.error ?? "bridge request failed"),
          ...(localAgentBridgeErrorCode(message.error_code) ? { error_code: message.error_code } : {}) });
    }
    return true;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.detach(this.gateway as WebSocket, "Runner local agent bridge stopped");
    for (const socket of this.clients) socket.destroy();
    this.clients.clear();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.unlink(this.socketPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  private accept(socket: Socket): void {
    this.clients.add(socket);
    this.clientLeases.set(socket, new Set());
    this.clientIds.set(socket, randomUUID().replace(/-/g, "").slice(0, 12));
    socket.setEncoding("utf8");
    let buffered = "";
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      if (Buffer.byteLength(buffered) > MAX_LINE_BYTES) {
        socket.destroy(new Error("local agent bridge request is too large"));
        return;
      }
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line) void this.forward(socket, line);
      }
    });
    const drop = () => {
      this.clients.delete(socket);
      const leases = this.clientLeases.get(socket);
      this.clientLeases.delete(socket);
      this.clientIds.delete(socket);
      for (const leaseId of leases ?? []) this.releaseLease(leaseId);
      for (const [id, pending] of [...this.pending]) {
        if (pending.socket !== socket) continue;
        // An open may already have created a gateway lease. Retain just enough
        // state to close it if its reply races this local client disconnect.
        if (pending.op === "open" || pending.op === "open_gui") {
          pending.orphaned = true;
          continue;
        }
        this.pending.delete(id);
        clearTimeout(pending.timer);
      }
    };
    socket.once("close", drop);
    socket.once("error", drop);
  }

  private async forward(socket: Socket, line: string): Promise<void> {
    let request: Record<string, unknown>;
    try {
      request = JSON.parse(line) as Record<string, unknown>;
    } catch {
      writeLine(socket, { id: "", ok: false, error: "invalid bridge JSON" });
      return;
    }
    const clientId = typeof request.id === "string" ? request.id : "";
    const op = typeof request.op === "string" ? request.op : "";
    if (!clientId || ![
      "list_targets", "list_account_tools", "account_call", "open", "open_gui", "call", "close", "development_register",
    ].includes(op)) {
      writeLine(socket, { id: clientId, ok: false, error: "invalid bridge request" });
      return;
    }
    const gateway = this.gateway;
    if (!gateway || gateway.readyState !== WebSocket.OPEN) {
      writeLine(socket, { id: clientId, ok: false, error: "Octopus Runner is offline", error_code: "runner_offline" });
      return;
    }
    const id = randomUUID();
    const body = bridgeRequestBody(op, request);
    const reportedPid = typeof request.client_pid === "number"
      && Number.isSafeInteger(request.client_pid)
      && request.client_pid > 0
      && request.client_pid <= 2_147_483_647
      ? request.client_pid
      : undefined;
    if (op === "account_call" && reportedPid && this.options.resolveCaller) {
      // Names the caller's own session for "self"; it confers nothing, so a failed lookup just omits it.
      const caller = await this.options.resolveCaller(reportedPid).catch(() => null);
      if (caller) body.caller_session = { source: caller.provider, session_id: caller.sessionId };
      if (this.gateway !== gateway || gateway.readyState !== WebSocket.OPEN || socket.destroyed) {
        writeLine(socket, { id: clientId, ok: false, error: "Octopus Runner is offline", error_code: "runner_offline" });
        return;
      }
    }
    if (op === "development_register") {
      try {
        if (!this.options.development) throw new Error("native development registration is unavailable on this Runner");
        body.proof = await this.options.development(request);
        if (this.gateway !== gateway || gateway.readyState !== WebSocket.OPEN || socket.destroyed) throw new Error("registration connection changed; query the original session before retrying");
      } catch (error) { writeLine(socket, { id: clientId, ok: false, error: error instanceof Error ? error.message : String(error) }); return; }
    }
    const timer = setTimeout(() => {
      const pending = this.pending.get(id);
      if (!pending) return;
      // The Gateway may finish opening a lease just after our caller-facing
      // timeout. Keep the correlation until that reply arrives so success can
      // be converted into close instead of becoming an invisible orphan.
      if (op === "open" || op === "open_gui") pending.orphaned = true;
      else this.pending.delete(id);
      writeLine(socket, { id: clientId, ok: false, error: "Octopus bridge request timed out" });
    }, this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
    this.pending.set(id, {
      socket,
      clientId,
      op,
      ...(op === "close" && typeof request.lease_id === "string" ? { leaseId: request.lease_id } : {}),
      timer,
    });
    gateway.send(JSON.stringify({
      type: "local_agent_bridge",
      id,
      client_id: this.clientIds.get(socket),
      ...(reportedPid ? { client_pid: reportedPid } : {}),
      ...body,
    }), (error) => {
      if (!error) return;
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      writeLine(socket, { id: clientId, ok: false, error: error.message });
    });
  }

  /** Best-effort cleanup for a local MCP process that vanished without closing its scopes. */
  private releaseLease(leaseId: string): void {
    const gateway = this.gateway;
    if (!gateway || gateway.readyState !== WebSocket.OPEN) return;
    gateway.send(JSON.stringify({
      type: "local_agent_bridge",
      id: randomUUID(),
      op: "close",
      lease_id: leaseId,
    }), () => undefined);
  }
}

/** Keep the private socket from becoming an escape hatch to arbitrary Runner WS frames. */
function bridgeRequestBody(op: string, request: Record<string, unknown>): Record<string, unknown> {
  if (op === "development_register") return { op }; // never forward a caller-authored proof
  if (op === "list_targets" || op === "list_account_tools") return { op };
  if (op === "account_call") return { op, tool: request.tool, args: request.args };
  if (op === "open") return { op, device: request.device, workspace_id: request.workspace_id };
  if (op === "open_gui") return { op, device: request.device };
  if (op === "call") return { op, lease_id: request.lease_id, tool: request.tool, args: request.args };
  return { op, lease_id: request.lease_id };
}

interface BridgeReply {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  error_code?: unknown;
}

export class LocalBridgeError extends Error {
  constructor(message: string, readonly code?: LocalAgentBridgeErrorCode) {
    super(message);
    this.name = "LocalBridgeError";
  }
}

export class LocalBridgeClient {
  private socket: Socket | null = null;
  private connectingSocket: Socket | null = null;
  private connecting: Promise<Socket> | null = null;
  private closed = false;
  private readonly pending = new Map<string, {
    resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout;
  }>();
  private buffered = "";

  constructor(private readonly socketPath: string, private readonly options: {
    connectTimeoutMs?: number; retryDelayMs?: number; requestTimeoutMs?: number;
    onDisconnect?: () => void;
  } = {}) {}

  async request(op: string, fields: Record<string, unknown> = {}): Promise<unknown> {
    const deadline = Date.now() + (this.options.connectTimeoutMs ?? 30_000);
    let backoff = 1_000;
    for (;;) {
      try { return await this.requestOnce(op, fields); }
      catch (error) {
        // The resident explicitly refused before forwarding to the Gateway.
        if (!(error instanceof LocalBridgeError) || error.code !== "runner_offline"
          || this.closed || Date.now() >= deadline) throw error;
        const retry = planRunnerReconnect(backoff);
        backoff = retry.nextBackoffMs;
        await new Promise<void>((resolve) => setTimeout(resolve, this.options.retryDelayMs ?? retry.delayMs));
      }
    }
  }

  private async requestOnce(op: string, fields: Record<string, unknown>): Promise<unknown> {
    const socket = await this.connect();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      if (socket.destroyed || this.closed) { reject(new Error("resident Runner local bridge closed")); return; }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("local bridge reply timed out; execution outcome may be unknown"));
      }, this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS + 10_000);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      // Diagnostic only: the resident Runner adds its own connection id and
      // forwards this reported child PID without using either for authority.
      socket.write(`${JSON.stringify({ id, op, ...fields, client_pid: process.pid })}\n`);
    });
  }

  close(): void {
    this.closed = true;
    this.socket?.destroy();
    this.connectingSocket?.destroy();
    this.failAll(new Error("local bridge client closed"));
  }

  private async connect(): Promise<Socket> {
    if (this.closed) throw new Error("local bridge client closed");
    if (this.socket && !this.socket.destroyed) return this.socket;
    if (!this.connecting) {
      this.connecting = this.reconnect().finally(() => { this.connecting = null; });
    }
    return await this.connecting;
  }

  private async reconnect(): Promise<Socket> {
    const deadline = Date.now() + (this.options.connectTimeoutMs ?? 30_000);
    let lastError: unknown;
    let backoff = 1_000;
    do {
      if (this.closed) throw new Error("local bridge client closed");
      try {
        const socket = await new Promise<Socket>((resolve, reject) => {
          const candidate = net.createConnection(this.socketPath);
          this.connectingSocket = candidate;
          const timer = setTimeout(() => candidate.destroy(new Error("local bridge connect timed out")), 2_000);
          candidate.once("error", reject);
          candidate.once("close", () => { clearTimeout(timer); reject(new Error("local bridge connect closed")); });
          candidate.once("connect", () => { clearTimeout(timer); resolve(candidate); });
        });
        if (this.closed) { socket.destroy(); throw new Error("local bridge client closed"); }
        this.socket = socket;
        this.connectingSocket = null;
        this.buffered = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => { if (this.socket === socket) this.receive(chunk); });
        const disconnected = () => {
          if (this.socket !== socket) return;
          this.socket = null;
          this.buffered = "";
          // Never replay a sent request: a command may have executed already.
          this.failAll(new Error("resident Runner local bridge disconnected; execution outcome may be unknown"));
          this.options.onDisconnect?.();
          socket.destroy();
        };
        socket.on("error", disconnected);
        socket.once("close", disconnected);
        return socket;
      } catch (error) {
        lastError = error;
        this.connectingSocket?.destroy();
        this.connectingSocket = null;
      }
      if (!this.closed && Date.now() < deadline) {
        const retry = planRunnerReconnect(backoff);
        backoff = retry.nextBackoffMs;
        await new Promise<void>((resolve) => setTimeout(resolve, this.options.retryDelayMs ?? retry.delayMs));
      }
    } while (!this.closed && Date.now() < deadline);
    throw new Error(`resident Runner local bridge unavailable: ${lastError instanceof Error ? lastError.message : "not connected"}`);
  }

  private receive(chunk: string): void {
    this.buffered += chunk;
    if (Buffer.byteLength(this.buffered) > MAX_LINE_BYTES) {
      this.socket?.destroy(new Error("local bridge response is too large"));
      return;
    }
    for (;;) {
      const newline = this.buffered.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffered.slice(0, newline);
      this.buffered = this.buffered.slice(newline + 1);
      if (!line) continue;
      let reply: BridgeReply;
      try { reply = JSON.parse(line) as BridgeReply; } catch { continue; }
      const pending = this.pending.get(reply.id);
      if (!pending) continue;
      this.pending.delete(reply.id);
      clearTimeout(pending.timer);
      if (reply.ok) pending.resolve(reply.result);
      else pending.reject(new LocalBridgeError(reply.error ?? "local bridge request failed", localAgentBridgeErrorCode(reply.error_code)));
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
}

export interface LocalWorkspaceLeaseState {
  leaseId: string;
  rootRef?: string;
}

export interface LocalBridgeRequester {
  request(op: string, fields?: Record<string, unknown>): Promise<unknown>;
}

interface GuiLeaseState {
  leaseId: string;
  expiresAt: string;
}

export async function runLocalAgentMcpStdio(
  socketPath: string,
  stdin: Readable = process.stdin,
  stdout: Writable = process.stdout,
): Promise<void> {
  const leases = new Map<string, LocalWorkspaceLeaseState>();
  const guiLeases = new Map<string, GuiLeaseState>();
  const bridge = new LocalBridgeClient(socketPath, {
    onDisconnect: () => { leases.clear(); guiLeases.clear(); },
  });
  const server = new Server(
    { name: "octopus-runner", version: "1.0.0" },
    {
      capabilities: { tools: {} },
      instructions: LOCAL_AGENT_MCP_INSTRUCTIONS,
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await localAgentMcpTools(socketPath, bridge) }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      const name = request.params.name;
      if (name === "octopus_list_execution_targets") return mcpToolResult(await bridge.request("list_targets"));
      if (GUI_MCP_TOOL_NAMES.has(name)) return mcpToolResult(await callGuiTool(bridge, guiLeases, name, args));
      if (LOCAL_MCP_TOOL_NAMES.has(name)) return mcpToolResult(await callRemoteTool(bridge, leases, name, args));
      return accountToolResult(await bridge.request("account_call", { tool: name, args }));
    } catch (error) {
      return {
        content: [{ type: "text", text: `Octopus operation failed: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  });
  let closing = false;
  const closed = new Promise<void>((resolve) => {
    server.onclose = () => {
      if (closing) return;
      closing = true;
      const closeRequests = [...leases.values(), ...guiLeases.values()].map((lease) =>
        bridge.request("close", { lease_id: lease.leaseId }));
      leases.clear();
      guiLeases.clear();
      void Promise.race([
        Promise.allSettled(closeRequests),
        new Promise<void>((done) => setTimeout(done, LEASE_CLOSE_GRACE_MS)),
      ]).finally(() => {
        bridge.close();
        resolve();
      });
    };
  });
  await server.connect(new StdioServerTransport(stdin, stdout));
  // The SDK transport ignores stdin EOF and the resident socket keeps the
  // event loop alive, so without this a child whose client died never exits.
  const clientGone = () => { void server.close(); };
  stdin.once("end", clientGone);
  stdin.once("close", clientGone);
  console.error(`${SOCKET_MARKER} ready`);
  await closed;
}

/**
 * Integrations stay installed while the resident Runner is stopped, and it
 * removes its socket on close. List the fixed tools at once in that case
 * instead of holding Agent startup on the reconnect budget; calls still report
 * the unavailable Runner.
 */
export async function localAgentMcpTools(
  socketPath: string,
  bridge: Pick<LocalBridgeClient, "request">,
): Promise<unknown[]> {
  const running = await fs.access(socketPath).then(() => true, () => false);
  const account = running ? await bridge.request("list_account_tools") as { tools?: unknown } | null : null;
  return [...LOCAL_AGENT_MCP_TOOLS, ...(Array.isArray(account?.tools) ? account.tools : [])];
}

export async function callGuiTool(
  bridge: Pick<LocalBridgeClient, "request">,
  leases: Map<string, GuiLeaseState>,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const device = requiredString(args.device, "device");
  if (name === "octopus_request_gui_control") {
    let existing = leases.get(device);
    if (existing && (!Number.isFinite(Date.parse(existing.expiresAt)) || Date.parse(existing.expiresAt) <= Date.now())) {
      leases.delete(device);
      await bridge.request("close", { lease_id: existing.leaseId }).catch(() => undefined);
      existing = undefined;
    }
    if (existing) return {
      granted: true,
      reused: true,
      device,
      expires_at: existing.expiresAt,
      instruction: "Capture a fresh screen before coordinate actions.",
    };
    const opened = await bridge.request("open_gui", { device }) as Record<string, unknown>;
    const leaseId = requiredString(opened.lease_id, "lease_id");
    const expiresAt = requiredString(opened.expires_at, "expires_at");
    leases.set(device, { leaseId, expiresAt });
    return {
      granted: opened.granted === true,
      device,
      expires_at: expiresAt,
      instruction: "The target Mac user approved this 15-minute lease. Capture a fresh screen before coordinate actions.",
    };
  }
  const lease = leases.get(device);
  if (!lease) throw new Error(`GUI control for ${device} is not active; call octopus_request_gui_control first`);
  if (name === "octopus_release_gui_control") {
    leases.delete(device);
    return await bridge.request("close", { lease_id: lease.leaseId });
  }
  const tool = GUI_MCP_TO_BRIDGE_TOOL[name];
  if (!tool) throw new Error(`unknown Octopus GUI tool: ${name}`);
  const forwarded = { ...args };
  delete forwarded.device;
  if (name === "octopus_gui_key_press") {
    const modifiers = Array.isArray(args.modifiers) ? args.modifiers : [];
    delete forwarded.modifiers;
    for (const modifier of ["command", "control", "option", "shift"] as const) {
      if (modifiers.includes(modifier)) forwarded[`modifier_${modifier}`] = true;
    }
  }
  try {
    return await bridge.request("call", { lease_id: lease.leaseId, tool, args: forwarded });
  } catch (error) {
    // Explicit fail-closed policy, independent of error text. The old permission
    // regex also matched a permission check inside execFile's echoed script.
    // Forget first; a failed close must neither restore authority nor hide the
    // original diagnostic. Nothing here replays the failed desktop operation.
    leases.delete(device);
    await bridge.request("close", { lease_id: lease.leaseId }).catch(() => undefined);
    throw error;
  }
}

function mcpToolResult(result: unknown) {
  const row = result && typeof result === "object" && !Array.isArray(result)
    ? result as Record<string, unknown>
    : null;
  if (
    row?.media_type === "image/jpeg"
    && typeof row.data === "string"
    && typeof row.width === "number"
    && typeof row.height === "number"
  ) {
    const { data, ...metadata } = row;
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(metadata, null, 2) },
        { type: "image" as const, mimeType: "image/jpeg", data },
      ],
    };
  }
  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
}

const ACCOUNT_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

/**
 * An account tool's outcome. Images the Gateway lifted out of an authorized
 * result (lark-cli slide screenshots) travel beside its JSON as image blocks,
 * so they are rendered rather than read as base64 text.
 */
export function accountToolResult(outcome: unknown) {
  const result = toolResult(outcome);
  const images = (outcome as { images?: unknown }).images;
  if (!Array.isArray(images) || !images.length) return mcpToolResult(result);
  const blocks = images.map((image) => {
    const { mimeType, data } = (image ?? {}) as { mimeType?: unknown; data?: unknown };
    return typeof mimeType === "string" && ACCOUNT_IMAGE_TYPES.has(mimeType)
      && typeof data === "string" && data.length > 0 && data.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(data)
      ? { type: "image" as const, mimeType, data }
      : null;
  });
  if (images.length > 16 || blocks.some((block) => !block)) {
    throw new Error("invalid_result_image: the result cannot be rendered; the call may have completed, do not replay automatically");
  }
  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }, ...blocks.map((block) => block!)] };
}

export async function callRemoteTool(
  bridge: LocalBridgeRequester,
  leases: Map<string, LocalWorkspaceLeaseState>,
  name: string,
  args: Record<string, unknown>,
  recovered = false,
): Promise<unknown> {
  const device = requiredString(args.device, "device");
  // Omitted: the server binds the device's Home workspace for this lease.
  const workspaceId = typeof args.workspace_id === "string" ? args.workspace_id.trim() : "";
  const key = leaseKey(device, workspaceId);
  const lease = await ensureLease(bridge, leases, device, workspaceId);
  try {
    if (name === "octopus_run_remote_command") {
      return toolResult(await bridge.request("call", {
        lease_id: lease.leaseId,
        tool: "run_workspace_command",
        args: {
          command: requiredString(args.command, "command"),
          ...(args.timeout_ms === undefined ? {} : { timeout_ms: args.timeout_ms }),
        },
      }));
    }
    const relativePath = cleanRelativePath(String(args.relative_path ?? ""));
    const ref = await resolveRef(bridge, lease, relativePath);
    if (name === "octopus_list_remote_entries") {
      return toolResult(await bridge.request("call", {
        lease_id: lease.leaseId,
        tool: "list_workspace_entries",
        args: { ref, ...(typeof args.after === "string" && args.after ? { after: args.after } : {}) },
      }));
    }
    if (name === "octopus_read_remote_text") {
      // One window per call; only the declared paging fields travel.
      const forwarded: Record<string, unknown> = { ref };
      for (const key of ["offset", "max_bytes"] as const) {
        if (args[key] !== undefined) forwarded[key] = args[key];
      }
      return toolResult(await bridge.request("call", {
        lease_id: lease.leaseId,
        tool: "read_workspace_text",
        args: forwarded,
      }));
    }
    if (name === "octopus_replace_remote_text") {
      // Whole text (staged by the server past one call's window), or one
      // explicit step of a staged write; the server checks which fields each
      // step needs. Only the declared fields travel.
      const forwarded: Record<string, unknown> = { ref };
      for (const key of ["expected_digest", "text", "stage", "upload", "offset", "size"] as const) {
        if (args[key] !== undefined) forwarded[key] = args[key];
      }
      if (forwarded.stage === undefined) {
        requiredString(args.expected_digest, "expected_digest");
        if (typeof args.text !== "string") throw new Error("text is required");
      }
      return toolResult(await bridge.request("call", {
        lease_id: lease.leaseId,
        tool: "replace_workspace_text",
        args: forwarded,
      }));
    }
    throw new Error(`unknown Octopus tool: ${name}`);
  } catch (error) {
    if (isDeadLeaseError(error)) {
      if (leases.get(key) === lease) leases.delete(key);
      // Typed missing/expired replies already retired the scope before dispatch.
      // Legacy errors only evict the cache; cleanup must not delay the failure.
      if (!(error instanceof LocalBridgeError)) {
        void bridge.request("close", { lease_id: lease.leaseId }).catch(() => undefined);
      }
    }
    if (!recovered && error instanceof LocalBridgeError
      && (error.code === "lease_missing" || error.code === "lease_expired")) {
      return await callRemoteTool(bridge, leases, name, args, true);
    }
    throw error;
  }
}

const openingLeases = new WeakMap<Map<string, LocalWorkspaceLeaseState>, Map<string, Promise<LocalWorkspaceLeaseState>>>();

async function ensureLease(
  bridge: LocalBridgeRequester,
  leases: Map<string, LocalWorkspaceLeaseState>,
  device: string,
  workspaceId: string,
): Promise<LocalWorkspaceLeaseState> {
  const key = leaseKey(device, workspaceId);
  const existing = leases.get(key);
  if (existing) return existing;
  let openings = openingLeases.get(leases);
  if (!openings) { openings = new Map(); openingLeases.set(leases, openings); }
  let pending = openings.get(key);
  if (!pending) {
    pending = (async () => {
      const opened = await bridge.request("open", { device, ...(workspaceId ? { workspace_id: workspaceId } : {}) }) as { lease_id?: unknown };
      const leaseId = requiredString(opened?.lease_id, "lease_id");
      const lease = { leaseId };
      leases.set(key, lease);
      return lease;
    })().finally(() => { openings.delete(key); });
    openings.set(key, pending);
  }
  return await pending;
}

async function ensureRootRef(bridge: LocalBridgeRequester, lease: LocalWorkspaceLeaseState): Promise<string> {
  if (lease.rootRef) return lease.rootRef;
  const roots = toolResult(await bridge.request("call", {
    lease_id: lease.leaseId,
    tool: "list_session_workspaces",
    args: {},
  })) as { roots?: Array<{ ref?: unknown }> };
  const rootRef = requiredString(roots?.roots?.[0]?.ref, "workspace root ref");
  lease.rootRef = rootRef;
  return rootRef;
}

async function resolveRef(
  bridge: LocalBridgeRequester,
  lease: LocalWorkspaceLeaseState,
  relativePath: string,
): Promise<string> {
  let ref = await ensureRootRef(bridge, lease);
  if (!relativePath) return ref;
  for (const label of relativePath.split("/")) {
    // Page through the directory until the label appears: a name past the
    // first page is still a name in this directory.
    let after: string | undefined;
    let entry: { label?: unknown; ref?: unknown } | undefined;
    for (;;) {
      const listed = toolResult(await bridge.request("call", {
        lease_id: lease.leaseId,
        tool: "list_workspace_entries",
        args: { ref, ...(after ? { after } : {}) },
      })) as { entries?: Array<{ label?: unknown; ref?: unknown }>; truncated?: unknown; next_after?: unknown };
      entry = listed?.entries?.find((row) => row.label === label);
      if (entry || listed?.truncated !== true || typeof listed.next_after !== "string" || listed.next_after === after) break;
      after = listed.next_after;
    }
    ref = requiredString(entry?.ref, `path segment ${label}`);
  }
  return ref;
}

function leaseKey(device: string, workspaceId: string): string {
  return JSON.stringify([device, workspaceId]);
}

function isDeadLeaseError(error: unknown): boolean {
  if (error instanceof LocalBridgeError && error.code) return error.code !== "runner_offline";
  return /no_authority|lease is missing|policy changed/i.test(error instanceof Error ? error.message : String(error));
}

function toolResult(value: unknown): unknown {
  const outcome = value as { ok?: unknown; result?: unknown; message?: unknown; code?: unknown };
  if (outcome?.ok === true) return outcome.result;
  throw new Error(`${String(outcome?.code ?? "refused")}: ${String(outcome?.message ?? "operation refused")}`);
}

function cleanRelativePath(value: string): string {
  const clean = value.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (!clean) return "";
  if (clean.startsWith("/") || clean.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("relative_path must stay inside the selected workspace");
  }
  return clean;
}

function requiredString(value: unknown, name: string): string {
  const clean = typeof value === "string" ? value.trim() : "";
  if (!clean) throw new Error(`${name} is required`);
  return clean;
}

function writeLine(socket: Socket, value: unknown): void {
  if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`);
}


const TARGET_FIELDS = {
  device: { type: "string", description: "Exact device from octopus_list_execution_targets." },
  workspace_id: { type: "string", description: "Exact workspace_id reported for that device; omit it to use the device's Home workspace." },
} as const;
const GUI_TARGET_FIELD = {
  device: { type: "string", description: "Exact GUI-enabled device from octopus_list_execution_targets." },
} as const;

export const LOCAL_AGENT_MCP_TOOLS = [
  {
    name: "octopus_list_execution_targets",
    description: "List this Octopus user's other online Runners, their registered workspaces, and any explicitly exposed Mac GUI capability.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "octopus_list_remote_entries",
    description: "List a directory in a registered workspace on another Runner, one page of up to 500 entries (directories, files, others; by name within each). When truncated=true, call again with after=next_after until truncated=false to reach every entry; concurrent additions or removals never repeat or skip an entry.",
    inputSchema: { type: "object", properties: { ...TARGET_FIELDS, relative_path: { type: "string" }, after: { type: "string", description: "next_after from the previous page; omit for the first page." } }, required: ["device"], additionalProperties: false },
  },
  {
    name: "octopus_read_remote_text",
    description: "Read a UTF-8 text file on another Runner one window at a time: text from byte offset (default 0), at most 256 KiB (max_bytes, cut between characters), with the whole file's digest (required for replacement) and size. While eof is false, call again with offset = next_offset to read a file of any size; a digest that changes between windows means the file changed, so read again from 0.",
    inputSchema: { type: "object", properties: { ...TARGET_FIELDS, relative_path: { type: "string" }, offset: { type: "integer", minimum: 0 }, max_bytes: { type: "integer", minimum: 1024, maximum: 262144 } }, required: ["device", "relative_path"], additionalProperties: false },
  },
  {
    name: "octopus_replace_remote_text",
    description: "Replace one existing remote text file using the digest from a prior read (compare-and-swap; refused without writing if the file changed). Without stage, text is the whole new content (up to 4,000,000 characters; the server stages it in windows and replaces atomically). For a larger file call stage=begin (expected_digest) to get upload, then stage=append with upload, offset (UTF-8 bytes written so far) and the next text part, then stage=commit with upload, expected_digest and the total size; nothing replaces the file before commit.",
    inputSchema: { type: "object", properties: { ...TARGET_FIELDS, relative_path: { type: "string" }, expected_digest: { type: "string" }, text: { type: "string" }, stage: { type: "string", enum: ["begin", "append", "commit"] }, upload: { type: "string" }, offset: { type: "integer", minimum: 0 }, size: { type: "integer", minimum: 0 } }, required: ["device", "relative_path"], additionalProperties: false },
  },
  {
    name: "octopus_run_remote_command",
    description: "Run a shell command inside a registered workspace on another Runner (the device's Home workspace when workspace_id is omitted). Output never stops the command: a stream over ~100 KB returns its head and tail inline (truncated=true) and its complete text at stdout_path/stderr_path on that device for about a day (each spill stops at 1 GiB, flagged by *_spill_truncated); page it with further commands, e.g. `tail -c +START FILE | head -c BYTES` (START counts from 1).",
    inputSchema: { type: "object", properties: { ...TARGET_FIELDS, command: { type: "string" }, timeout_ms: { type: "number" } }, required: ["device", "command"], additionalProperties: false },
  },
  {
    name: "octopus_request_gui_control",
    description: "Ask the user on a discovered target Mac to allow GUI control for 15 minutes. Call only after the user explicitly requested remote GUI work; never infer consent from discovery.",
    inputSchema: { type: "object", properties: GUI_TARGET_FIELD, required: ["device"], additionalProperties: false },
  },
  {
    name: "octopus_capture_screen",
    description: "Capture the target Mac's complete main display under an active local-consent lease. Returns an image whose top-left pixel coordinates are used by the GUI action tools.",
    inputSchema: { type: "object", properties: GUI_TARGET_FIELD, required: ["device"], additionalProperties: false },
  },
  {
    name: "octopus_gui_click",
    description: "Click screenshot coordinates on the target Mac. Capture a fresh screen first; do not retry after an indeterminate result.",
    inputSchema: {
      type: "object",
      properties: {
        ...GUI_TARGET_FIELD,
        x: { type: "number", minimum: 0 },
        y: { type: "number", minimum: 0 },
        button: { type: "string", enum: ["left", "right"] },
        click_count: { type: "integer", minimum: 1, maximum: 3 },
      },
      required: ["device", "x", "y"],
      additionalProperties: false,
    },
  },
  {
    name: "octopus_gui_scroll",
    description: "Scroll at screenshot coordinates on the target Mac. Capture a fresh screen first.",
    inputSchema: {
      type: "object",
      properties: {
        ...GUI_TARGET_FIELD,
        x: { type: "number", minimum: 0 },
        y: { type: "number", minimum: 0 },
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        amount: { type: "integer", minimum: 1, maximum: 20 },
      },
      required: ["device", "x", "y", "direction"],
      additionalProperties: false,
    },
  },
  {
    name: "octopus_gui_drag",
    description: "Drag between two screenshot coordinates on the target Mac. Capture a fresh screen first.",
    inputSchema: {
      type: "object",
      properties: {
        ...GUI_TARGET_FIELD,
        from_x: { type: "number", minimum: 0 },
        from_y: { type: "number", minimum: 0 },
        to_x: { type: "number", minimum: 0 },
        to_y: { type: "number", minimum: 0 },
        duration_ms: { type: "integer", minimum: 100, maximum: 3000 },
      },
      required: ["device", "from_x", "from_y", "to_x", "to_y"],
      additionalProperties: false,
    },
  },
  {
    name: "octopus_gui_type_text",
    description: "Type text into the currently focused control on the target Mac under an active consent lease.",
    inputSchema: {
      type: "object",
      properties: { ...GUI_TARGET_FIELD, text: { type: "string", maxLength: 8000 } },
      required: ["device", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "octopus_gui_key_press",
    description: "Send a named key with optional modifiers to the target Mac under an active consent lease.",
    inputSchema: {
      type: "object",
      properties: {
        ...GUI_TARGET_FIELD,
        key: { type: "string", enum: ["enter", "tab", "escape", "backspace", "delete", "space", "arrow_up", "arrow_down", "arrow_left", "arrow_right", "home", "end", "page_up", "page_down"] },
        modifiers: { type: "array", uniqueItems: true, items: { type: "string", enum: ["command", "control", "option", "shift"] } },
      },
      required: ["device", "key"],
      additionalProperties: false,
    },
  },
  {
    name: "octopus_release_gui_control",
    description: "End this Agent's GUI-control lease early and dismiss the target Mac indicator.",
    inputSchema: { type: "object", properties: GUI_TARGET_FIELD, required: ["device"], additionalProperties: false },
  },
];

const LOCAL_MCP_TOOL_NAMES = new Set(LOCAL_AGENT_MCP_TOOLS.map((tool) => tool.name));
const GUI_MCP_TO_BRIDGE_TOOL: Record<string, string> = {
  octopus_capture_screen: "capture_screen",
  octopus_gui_click: "click",
  octopus_gui_scroll: "scroll",
  octopus_gui_drag: "drag",
  octopus_gui_type_text: "type_text",
  octopus_gui_key_press: "key_press",
};
const GUI_MCP_TOOL_NAMES = new Set([
  "octopus_request_gui_control",
  ...Object.keys(GUI_MCP_TO_BRIDGE_TOOL),
  "octopus_release_gui_control",
]);
