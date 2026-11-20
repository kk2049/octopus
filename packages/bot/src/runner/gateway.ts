import { publicCapabilityAdvertisement } from "@claude-bot/runner/capability-protocol";
import { MEETING_TRANSCRIPTION_METHODS, readMeetingTranscriptionAdvertisement } from "@claude-bot/runner/meeting-transcription-protocol";
import { runnerDisplayName } from "./display-name.js";
import { publicModelChoices, selectSessionWindow } from "@claude-bot/agent-sessions-contract";
/**
 * RunnerGateway — the bot-side device transport for laptop Runners, and
 * nothing else.
 *
 * A WebSocket server (public port) that laptop Runners dial into with a
 * per-device token: register → heartbeat → serve session RPCs. This is a
 * device data-plane protocol, deliberately NOT MCP and NOT a chat Channel.
 *
 * SECURITY BOUNDARY (resource side: doc/tcb-reading-guide.md §3): this class has NO public method that takes a caller-stated
 * username and reaches a device. The old `rpcForUser(username, …)` and the
 * loopback HTTP server both lived here and both were, in effect, "whoever
 * holds this handle may address anybody's laptop". They are gone. The raw
 * dispatch is claimed exactly once, at boot, by the Runner Object adapter in
 * `capability.ts`; every other caller in the process goes through the
 * capability service and can therefore only reach the owner its Context was
 * derived for.
 *
 * Multi-device semantics: list/search fan out to every online device of the
 * user and merge (each summary tagged with its device); read/copy try devices
 * in turn and return the first success (a session id lives on exactly one
 * laptop).
 */

import { mergeSearchPages, sessionListCursor, subagentParentId } from "@claude-bot/plugin-sessions/scan";
import { runnerHasSessionRoster, runnerProviderAdvertisements, type RunnerProviderAdvertisement } from "./providers.js";
import type { Duplex } from "node:stream";
import type { RunnerBundleSource } from "./bundle-registry.js";
import type { ProjectionReadResult } from "./session-projection.js";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createWebSocketStream, WebSocketServer, WebSocket } from "ws";
import { ModelTunnelBroker } from "./model-tunnels.js";
import { MACHINE_LIMITS } from "@claude-bot/runner/limits";
import { WORKSPACE_DEVELOPMENT_PROTOCOL, WORKSPACE_DEVELOPMENT_LIMITS } from "@claude-bot/runner/workspace-development-protocol";
import {
  RUNNER_AGENT_BACKENDS,
  RUNNER_INVENTORY_SCHEMA,
  agentDiagnosticCode,
  publicAgentDiagnosticDetail,
  publicCodexEmailLabel,
  publicCodexQuota,
  type RunnerInventory,
} from "@claude-bot/runner/inventory";
import {
  RUNNER_GATEWAY_PROTOCOL,
  RUNNER_RECOVERY_WAKE,
  SESSION_OPERATION_PROTOCOL,
  RUNNER_MANAGED_COMPLETION_ACK,
  runnerManagedCompletionFromWire,
  runnerSystemStatusFromWire,
  type RunnerManagedCompletion,
  type RunnerSystemStatus,
  type LocalAgentBridgeErrorCode,
} from "@claude-bot/runner/gateway-protocol";
import {
  type RunnerSessionProjection,
  type RunnerSessionProjectionCommand,
  runnerSessionProjectionFromWire,
} from "@claude-bot/runner/session-projection";
import type { RunnerLocalAgentBridgeMode, Store } from "../store/store.js";
import { createLogger } from "../logger.js";

const log = createLogger("runner-gateway");

const RPC_TIMEOUT_MS = 30_000;
/** A cold 200-row roster can parse hundreds of MB; stay below the resource layer's 60s bound. */
const SESSION_LIST_TIMEOUT_MS = 55_000;
const COPY_TIMEOUT_MS = 90_000;
const MAX_WS_PAYLOAD = 32 * 1024 * 1024;
const DSH_TUNNEL_TIMEOUT_MS = 10_000;
const MAX_DSH_TUNNELS_PER_RUNNER = 16;
/**
 * Server-driven keepalive. Plaintext WS across the public internet crosses
 * NAT/firewall middleboxes that silently drop idle connections — commonly
 * at ~30s. Field evidence (octo/MBA): online → exactly +30s offline, while
 * the runner side kept a half-open zombie socket and never reconnected.
 * Protocol-level ping frames need zero cooperation from the runner build
 * (the ws stack auto-pongs), so this keeps ANY runner version alive.
 *
 * Judgement is by SILENCE DURATION, not by "did the last ping get a pong":
 * the single-strike rule (2026-07-20 → 2026-08-22) killed lht-val15-ci six
 * to eight times a day while the container ran tsc/vitest, and killed the
 * loopback dev-laptop whenever this process's own event loop stalled — the
 * sweep timer runs before the queued pong is read, so a 15 s stall on this
 * 2-vCPU host read as "the device went silent". A dead link is now declared
 * after KEEPALIVE_DEAD_AFTER_MS without any inbound frame (≈3 missed pings),
 * and a sweep that itself ran late (the stall case) pings but does not judge.
 */
const KEEPALIVE_INTERVAL_MS = 15_000;
const KEEPALIVE_DEAD_AFTER_MS = 50_000;
/** A sweep this late means the event loop stalled; that round judges nobody. */
const SWEEP_LATE_MS = KEEPALIVE_INTERVAL_MS * 2;
/** Event-loop lag sampler: one cheap timer whose drift is the stall length. */
const LAG_SAMPLE_MS = 1_000;
const LAG_WARN_MS = 2_000;
/**
 * Runner self-update. The gateway serves the independently activated
 * standalone artifact over the authenticated device socket; a Runner that
 * reports a different sha of its own entry file may ask for it once per minute.
 */
const BUNDLE_MIN_INTERVAL_MS = 60_000;
const BUNDLE_RETRY_AFTER_MS = 5 * 60_000;
/** Grace for a Runner to finish its redial after we announce a restart. */
const RESTART_RETRY_AFTER_MS = 2_000;
/** A device-presence ping must answer fast or be reported as unreachable. */
const PING_TIMEOUT_MS = 5_000;
/**
 * Machine ops (shell, file IO on the user's own box) address exactly one
 * device and may legitimately run for minutes — they do not fan out or merge
 * like the investigation ops, and they get their own longer budget.
 */
const MACHINE_METHODS: Record<string, true> = {
  invoke_runner_capability: true,
  exec_workspace: true,
  exec: true,
  read_file: true,
  write_file: true,
  list_dir: true,
  host_info: true,
  append_session: true,
  upload_session_file: true,
  start_session: true,
  get_session_operation: true,
  session_anchor: true,
  fork_session: true,
  respond_agent_interaction: true,
  list_session_workspaces: true,
  list_workspace_entries: true,
  access_owner_files: true,
  replace_owner_text: true,
  read_workspace_text: true,
  read_workspace_binary: true,
  download_workspace_file: true,
  workspace_file_transfer: true,
  replace_workspace_text: true,
  workspace_terminal: true,
  codex_agent_open: true,
  codex_agent_read: true,
  codex_agent_read_session: true,
  codex_agent_write: true,
  codex_agent_close: true,
  session_plus_list_sessions: true,
  session_plus_search_sessions: true,
  session_plus_read_session: true,
  ...Object.fromEntries(MEETING_TRANSCRIPTION_METHODS.map(method => [method, true as const])),
  knowledge_index_start: true,
  knowledge_index_status: true,
  knowledge_index_cancel: true,
  knowledge_index_read: true,
  gui_request_control: true,
  gui_capture_screen: true,
  gui_click: true,
  gui_scroll: true,
  gui_drag: true,
  gui_type_text: true,
  gui_key_press: true,
  gui_release_control: true,
};
// Derived, not restated: the longest exec plus margin for its answer to cross
// the link, so raising the exec bound cannot strand its result at the gateway.
const MACHINE_TIMEOUT_MS = MACHINE_LIMITS.execTimeoutMaxMs + 20_000;
// Append is the one machine operation that may pause for a human. The device
// first lets that interaction expire and gives the provider a final minute to
// settle; keep only this RPC alive for one more minute so its structured result
// wins over an indeterminate Runner timeout.
const APPEND_MACHINE_TIMEOUT_MS = MACHINE_LIMITS.appendTimeoutMs + 60_000;
/** Operations whose result is material a report may disclose, so it is stamped. */
const EXPORT_METHODS = new Set(["copy_session", "copy_file"]);

/** Runner-to-Runner RPCs admitted only by one live, launch-scoped verifier. */
const EXECUTION_RELAY_METHODS = new Set([
  "codex_exec_open",
  "codex_exec_read",
  "codex_exec_write",
  "codex_exec_reconnect",
  "codex_exec_close",
]);
/** Each live split environment keeps one long-poll read and at most one write in flight. */
const EXECUTION_RELAY_MAX_IN_FLIGHT = 64;
const LOCAL_AGENT_BRIDGE_MAX_IN_FLIGHT = 8;
/** Workspace leases are cheap, but stay bounded per authenticated runtime Runner. */
const LOCAL_AGENT_BRIDGE_MAX_WORKSPACE_LEASES = 32;
/** GUI leases carry live target-side consent and retain their tighter independent bound. */
const LOCAL_AGENT_BRIDGE_MAX_GUI_LEASES = 8;
const LOCAL_AGENT_BRIDGE_TOOLS = new Set([
  "list_session_workspaces",
  "list_workspace_entries",
  "read_workspace_text",
  "replace_workspace_text",
  "run_workspace_command",
]);
const LOCAL_AGENT_BRIDGE_GUI_TOOLS = new Set([
  "capture_screen",
  "click",
  "scroll",
  "drag",
  "type_text",
  "key_press",
]);

export function hashRunnerToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** New device token plaintext. Only `RunnerCapabilities` may turn this into a
 * stored credential — see `mintDeviceToken` for why the ordering matters. */
export function newRunnerTokenPlaintext(): string {
  return "rt_" + randomUUID().replace(/-/g, "");
}

interface RunnerConn {
  ws: WebSocket;
  username: string;
  device: string;
  tokenHash: string;
  inventory?: RunnerInventory;
  /** Latest bounded resource snapshot from this authenticated connection. */
  systemStatus?: RunnerSystemStatus;
  /** Wall-clock of the last inbound frame of any kind (pong, data); liveness = recency. */
  lastInboundAt: number;
  /** sha256 of the Runner's own entry file, when its build reports one. */
  bundleSha?: string;
  /** Active artifact advertised on this connection, including an opted-out client. */
  advertisedBundleSha?: string;
  lastBundleSentAt?: number;
  lastBundleRequestedAt?: number;
  selfUpdateEnabled?: boolean;
  rejectedBundleSha?: string;
  pending: Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>;
  /** Origin-side relay requests currently waiting on another owned Runner. */
  peerPending: Set<string>;
  /** Requests and scopes initiated by this exact authenticated socket. */
  localBridgePending: Set<string>;
  /** Fences asynchronous opens across disconnects and policy changes. */
  localBridgeGeneration: number;
  localBridgeLeases: Map<string, {
    mode: RunnerLocalAgentBridgeMode;
    kind: "workspace" | "gui";
    lease: RunnerLocalAgentBridgeLease;
    targetDevice: string;
    workspaceId?: string;
    clientId?: string;
    clientPid?: number;
    openedAt: number;
    lastUsedAt: number;
    lastTool?: string;
    inFlight: number;
  }>;
  /** Raw DSH streams are fixed to this authenticated device and die with it. */
  activeTunnels: Set<Duplex>;
  pendingTunnelIds: Set<string>;
  /**
   * A guest client (`runner_guest_profiles`): its owner may operate it, but it
   * initiates nothing beyond keepalive, inventory, status, self-update and
   * RPC replies. Its model traffic uses `model-tunnel/v1` sockets instead.
   */
  guest?: boolean;
}

/** Guest-initiated frames that would reach the owner's other devices, sessions or scopes. */
const GUEST_REFUSED_FRAMES = new Set([
  "peer_rpc",
  "local_agent_bridge",
  "session_recovery_scope",
  "session_projection",
  "sessions_changed",
  "managed_session_completion",
]);

interface PendingDshTunnel {
  conn: RunnerConn;
  secretHash: Buffer;
  resolve: (stream: Duplex) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface TentacleConn {
  ws: WebSocket;
  username: string;
  device: string;
  tokenHash: string;
  mcpTokenHash: string;
  isAlive: boolean;
  inbound: Promise<void>;
}

export interface RunnerDeviceStatus {
  device: string;
  /** Owner-controlled presentation only; device remains the authenticated identity. */
  display_name?: string;
  online: boolean;
  /** Bounded first-party capabilities on this live connection. Presence grants no authority. */
  providers?: RunnerProviderAdvertisement[];
  created_at: string;
  last_seen_at: string | null;
  /** Last report on the current authenticated connection; absent for older Runners. */
  inventory?: RunnerInventory;
  /** Last report on the current authenticated connection; absent for older Runners. */
  system_status?: RunnerSystemStatus;
  /** The Runner build's own sha256; absent for builds that predate self-update. */
  bundle_sha?: string;
  /** Whether that build is the one this gateway serves (absent when unknown). */
  bundle_current?: boolean;
  bundle_target_sha?: string;
  bundle_update_status?: "current" | "pending" | "updating" | "retry_pending" | "disabled" | "blocked";
}

export interface GatewayOptions {
  /** Public WS port for runners; 0 = ephemeral (tests). */
  port: number;
  host?: string;
  /**
   * Dynamic content-addressed standalone Runner artifacts. The source resolves
   * its active pointer at use time, independently of the Bot checkout.
   */
  bundleSource?: RunnerBundleSource;
  /** Test seams; production intentionally uses the constants above. */
  rpcTimeoutMs?: number;
  sessionListTimeoutMs?: number;
  machineTimeoutMs?: number;
  keepaliveDeadAfterMs?: number;
  bundleRetryAfterMs?: number;
}


/**
 * The raw device transport, claimed ONCE by the Runner Object adapter.
 *
 * `dispatch` still takes an owner because the gateway indexes connections by
 * owner — but the only code that can call it receives that owner from the
 * Object's fixed binding, not from a request. Nothing else in the process can
 * obtain this interface.
 */
/** Read-only cache callback supplied by the already-authorized Object adapter. */
export type RunnerRosterRead = (device: string) => ProjectionReadResult;

export interface RunnerTransport {
  dispatch(owner: string, method: string, args: Record<string, unknown>, rosterRead?: RunnerRosterRead): Promise<unknown>;
  listDevices(owner: string): RunnerDeviceStatus[];
  isOnline(owner: string): boolean;
  /** The device is online and reported itself read-only. */
  isReadOnly?(owner: string, device: string): boolean;
  /** WebSocket-level round trip; null when the device is not connected. */
  ping(owner: string, device: string): Promise<number | null>;
  /** Token revocation must land on the live socket, not at the next reconnect. */
  disconnect(owner: string, device: string): boolean;
  /** Push persisted, owner-selected integration policy to one authenticated device. */
  setDefaultAgentInjection?(owner: string, device: string, enabled: boolean): boolean;
  /** Push the persisted target-side GUI exposure kill switch. */
  setGuiAutomationEnabled?(owner: string, device: string, enabled: boolean): boolean;
  /** Content-free authenticated device hint; data is obtained by a later capability read. */
  subscribeSessionChanges?(listener: (owner: string, device: string) => void): () => void;
  /** Post-Gate, connection-scoped byte stream to this device's advertised loopback DSH. */
  openDshTunnel(owner: string, device: string, port: number): Promise<Duplex>;
}

/**
 * A device registered (`online`) or dropped. On a registration,
 * `previousSeenAt` is the device's last proof of life before it (null when it
 * was never seen), so a listener can tell a reconnect from a return.
 */
export type RunnerPresenceListener = (owner: string, device: string, online: boolean, previousSeenAt?: string | null) => void;

/** Narrow push plane: authenticated projection data and subscription commands, never arbitrary RPC. */
export interface RunnerSessionProjectionTransport {
  subscribe(listener: (owner: string, device: string, projection: RunnerSessionProjection) => boolean): () => void;
  subscribeInvalidations(listener: (owner: string, device: string) => void): () => void;
  subscribePresence(listener: RunnerPresenceListener): () => void;
  send(owner: string, device: string, command: RunnerSessionProjectionCommand): boolean;
  listDevices(owner: string): RunnerDeviceStatus[];
}

export interface TentaclePeer {
  /** Trusted values resolved from the two credentials; never from a wire envelope. */
  username: string;
  device: string;
}

export interface TentacleCredentialVerifier {
  authenticate(token: string): { username: string; tokenHash: string } | null;
  active(credential: { username: string; tokenHash: string }): boolean;
}

export interface RunnerExecutionRelayRequest {
  owner: string;
  runtimeDevice: string;
  executionDevice: string;
  workspaceId: string;
  token: string;
  method: string;
}

export interface RunnerExecutionRelayVerifier {
  authorize(request: RunnerExecutionRelayRequest): boolean;
}

/** A live scope whose credentials remain wholly inside the bot process. */
export interface RunnerLocalAgentBridgeLease {
  call(tool: string, args: Readonly<Record<string, unknown>>): Promise<unknown>;
  /** Checked before dispatch; false means this handle cannot execute a tool. */
  isActive?(): boolean;
  /** Bounded non-authority metadata returned when the bridge opens the lease. */
  description?: Readonly<Record<string, unknown>>;
  /** The workspace the lease is bound to, when the selection named none. */
  workspaceId?: string;
  close(): void;
}

/** Identity fixed by the authenticated Runner socket, never by a bridge frame. */
export interface RunnerLocalAgentBridgeSubject {
  owner: string;
  device: string;
}

/** Untrusted target coordinates. The access controller must resolve them for the subject. */
export interface RunnerLocalAgentBridgeSelection {
  device: string;
  /** Omitted: the access controller binds the device's Home workspace. */
  workspaceId?: string;
}

/**
 * Authorization and routing seam for Runner-local agents.
 *
 * The installed implementation is owner-only. A future relationship-aware
 * implementation may return delegated targets, but it must decide from the
 * authenticated subject plus server-side grants; adding an owner claim to the
 * untrusted bridge protocol must never become an authorization mechanism.
 */
export interface RunnerLocalAgentBridgeHandler {
  registerDevelopment?(subject: Readonly<RunnerLocalAgentBridgeSubject>, proof: Readonly<Record<string, unknown>>, stillAuthorized: () => boolean): Promise<unknown>;
  listTargets(subject: Readonly<RunnerLocalAgentBridgeSubject>): Promise<unknown>;
  /** Account tools are selected by the server from this authenticated owner. */
  listAccountTools?(subject: Readonly<RunnerLocalAgentBridgeSubject>): Promise<unknown>;
  /** The handler's closed MCP policy is authoritative; the bridge never accepts an owner claim. */
  callAccount?(input: {
    subject: Readonly<RunnerLocalAgentBridgeSubject>;
    tool: string;
    args: Readonly<Record<string, unknown>>;
    mode: Exclude<RunnerLocalAgentBridgeMode, "disabled">;
    isActive(): boolean;
    /**
     * The native session whose CLI spawned the calling MCP process, as this
     * device's Runner resolved it from the process tree. It names the caller's
     * "self"; it is never an owner claim and grants nothing by itself.
     */
    caller?: { source: string; sessionId: string };
  }): Promise<unknown>;
  open(input: {
    subject: Readonly<RunnerLocalAgentBridgeSubject>;
    selection: Readonly<RunnerLocalAgentBridgeSelection>;
    mode: Exclude<RunnerLocalAgentBridgeMode, "disabled">;
  }): Promise<RunnerLocalAgentBridgeLease>;
  openGui(input: {
    subject: Readonly<RunnerLocalAgentBridgeSubject>;
    device: string;
  }): Promise<RunnerLocalAgentBridgeLease>;
}

export interface RunnerSessionRecoveryRequest {
  owner: string;
  runtimeDevice: string;
  source: "claude" | "codex" | "omp";
  sessionId: string;
}

export interface RunnerSessionRecoveryScope {
  /** Ephemeral authenticated recovery only; never persist or log this authority. */
  development?: { developmentId: string; token: string; endpoint: string; expiresAt: number };
  token: string;
  endpoint: string;
  expiresAt: number;
  operationId: string;
  executionDevice: string;
  workspaceId: string;
}

export interface RunnerSessionRecoveryIssuer {
  issue(request: RunnerSessionRecoveryRequest): RunnerSessionRecoveryScope | null;
}

export interface RunnerTentacleTransport {
  onMessage(listener: (peer: TentaclePeer, message: unknown) => void | Promise<void>): () => void;
  send(username: string, device: string, message: unknown): boolean;
  listDevices(username: string): string[];
  disconnect(username: string, device: string): boolean;
  disconnectCredential(username: string, tokenHash: string): number;
}

export class RunnerGateway {
  private wss: WebSocketServer | null = null;
  /** username → device → live connection */
  private conns = new Map<string, Map<string, RunnerConn>>();
  /** Authenticated dsh subprotocol peers; never exposed as laptop Runner RPC targets. */
  private tentacleConns = new Map<string, Map<string, TentacleConn>>();
  private wsPort = 0;
  private keepaliveTimer: NodeJS.Timeout | null = null;
  private lagTimer: NodeJS.Timeout | null = null;
  private lastSweepAt = 0;
  private transportClaimed = false;
  private tentacleTransportClaimed = false;
  private sessionProjectionTransportClaimed = false;
  private tentacleVerifier: TentacleCredentialVerifier | null = null;
  private executionRelayVerifier: RunnerExecutionRelayVerifier | null = null;
  private localAgentBridgeHandler: RunnerLocalAgentBridgeHandler | null = null;
  private sessionRecoveryIssuer: RunnerSessionRecoveryIssuer | null = null;
  private readonly tentacleListeners = new Set<(peer: TentaclePeer, message: unknown) => void | Promise<void>>();
  private readonly pendingDshTunnels = new Map<string, PendingDshTunnel>();
  /** Guest model tunnels: guest WebSocket ↔ model host WebSocket byte streams. */
  private readonly modelTunnels = new ModelTunnelBroker({
    tokenRow: (hash) => this.store.getRunnerTokenByHash(hash),
    guestProfile: (username, device) => this.store.getRunnerGuestProfile(username, device),
    host: (username, device) => {
      const conn = this.conns.get(username)?.get(device);
      if (!conn || conn.guest || conn.ws.readyState !== WebSocket.OPEN) return undefined;
      return { ws: conn.ws, egress: conn.inventory?.model_egress?.available === true };
    },
    hashToken: hashRunnerToken,
    log: (fields, message) => log.info(fields, message),
  });
  private readonly sessionChangeListeners = new Set<(owner: string, device: string) => void>();
  private readonly sessionProjectionListeners = new Set<
    (owner: string, device: string, projection: RunnerSessionProjection) => boolean
  >();
  private readonly sessionProjectionInvalidationListeners = new Set<(owner: string, device: string) => void>();
  private readonly managedCompletionListeners = new Set<
    (owner: string, device: string, completion: RunnerManagedCompletion) => void
  >();
  /** Device presence transitions, for the resource-recovery service and the like. */
  private readonly presenceListeners = new Set<RunnerPresenceListener>();

  constructor(
    private store: Store,
    private opts: GatewayOptions,
  ) {}

  /**
   * Be told when a device registers or drops. Content-free (owner + device
   * name + direction) and server-side only: this is how "the CI box is back"
   * reaches the agents that were told to wait for it.
   */
  subscribePresence(listener: RunnerPresenceListener): () => void {
    this.presenceListeners.add(listener);
    return () => this.presenceListeners.delete(listener);
  }

  private announcePresence(owner: string, device: string, online: boolean, previousSeenAt?: string | null): void {
    if (online) {
      // Wake only this account's existing peers. The hint carries no resource
      // or grant, and can only recheck an already journaled continuation.
      for (const peer of this.conns.get(owner)?.values() ?? []) {
        if (peer.device !== device && peer.ws.readyState === WebSocket.OPEN) {
          peer.ws.send(JSON.stringify({ type: RUNNER_RECOVERY_WAKE }));
        }
      }
    }
    for (const listener of [...this.presenceListeners]) {
      try {
        listener(owner, device, online, previousSeenAt);
      } catch (err) {
        log.warn({ err, owner, device, online }, "presence listener failed");
      }
    }
  }

  /** Authenticated Runner-owned turns may publish one bounded terminal fact. */
  subscribeManagedSessionCompletions(
    listener: (owner: string, device: string, completion: RunnerManagedCompletion) => void,
  ): () => void {
    this.managedCompletionListeners.add(listener);
    return () => this.managedCompletionListeners.delete(listener);
  }

  /**
   * Hand the raw transport to the ONE Runner Object adapter, at boot.
   *
   * Once-only on purpose: a second caller is either a bug or an attempt to
   * open a second door to the devices, and both should fail loudly at
   * startup rather than quietly create a bypass.
   */
  claimTransport(): RunnerTransport {
    if (this.transportClaimed) {
      throw new Error("RunnerGateway transport already claimed — there is exactly one Runner Object adapter");
    }
    this.transportClaimed = true;
    return {
      dispatch: (owner, method, args, rosterRead) => this.dispatchForOwner(owner, method, args, rosterRead),
      listDevices: (owner) => this.listDevices(owner),
      isOnline: (owner) => this.isOnline(owner),
      isReadOnly: (owner, device) => this.isReadOnly(owner, device),
      ping: (owner, device) => this.pingDevice(owner, device),
      disconnect: (owner, device) => this.disconnectDevice(owner, device),
      setDefaultAgentInjection: (owner, device, enabled) =>
        this.setDefaultAgentInjection(owner, device, enabled),
      setGuiAutomationEnabled: (owner, device, enabled) =>
        this.setGuiAutomationEnabled(owner, device, enabled),
      openDshTunnel: (owner, device, port) => this.openDshTunnel(owner, device, port),
      subscribeSessionChanges: (listener) => {
        this.sessionChangeListeners.add(listener);
        return () => this.sessionChangeListeners.delete(listener);
      },
    };
  }

  claimSessionProjectionTransport(): RunnerSessionProjectionTransport {
    if (this.sessionProjectionTransportClaimed) {
      throw new Error("RunnerGateway session projection transport already claimed");
    }
    this.sessionProjectionTransportClaimed = true;
    return {
      subscribe: (listener) => {
        this.sessionProjectionListeners.add(listener);
        return () => this.sessionProjectionListeners.delete(listener);
      },
      subscribeInvalidations: (listener) => {
        this.sessionProjectionInvalidationListeners.add(listener);
        return () => this.sessionProjectionInvalidationListeners.delete(listener);
      },
      subscribePresence: (listener) => this.subscribePresence(listener),
      send: (owner, device, command) => {
        const conn = this.conns.get(owner)?.get(device);
        if (conn?.ws.readyState !== WebSocket.OPEN) return false;
        conn.ws.send(JSON.stringify({ type: "session_projection_command", command }));
        return true;
      },
      listDevices: (owner) => this.listDevices(owner),
    };
  }

  /**
   * Claim the authenticated dsh subprotocol once.  This is not a second door
   * to Runner RPC: it can only address connections whose rt_ device is named
   * `dsh:<instance>`, and inbound identity is supplied as a trusted closure.
   */
  claimTentacleTransport(verifier: TentacleCredentialVerifier): RunnerTentacleTransport {
    if (this.tentacleTransportClaimed) {
      throw new Error("RunnerGateway tentacle transport already claimed");
    }
    this.tentacleTransportClaimed = true;
    this.tentacleVerifier = verifier;
    return {
      onMessage: (listener) => {
        this.tentacleListeners.add(listener);
        return () => this.tentacleListeners.delete(listener);
      },
      send: (username, device, message) => {
        const conn = this.tentacleConns.get(username)?.get(device);
        if (conn?.ws.readyState !== WebSocket.OPEN) return false;
        conn.ws.send(JSON.stringify(message));
        return true;
      },
      listDevices: (username) => [...(this.tentacleConns.get(username)?.keys() ?? [])].sort(),
      disconnect: (username, device) => {
        const conn = this.tentacleConns.get(username)?.get(device);
        if (!conn) return false;
        conn.ws.close(4004, "credential revoked");
        return true;
      },
      disconnectCredential: (username, tokenHash) => {
        let disconnected = 0;
        for (const conn of this.tentacleConns.get(username)?.values() ?? []) {
          if (conn.mcpTokenHash !== tokenHash) continue;
          disconnected++;
          conn.ws.close(4004, "credential revoked");
        }
        return disconnected;
      },
    };
  }

  /**
   * Install the live launch-scope verifier used by Runner-to-Runner exec relay.
   *
   * The gateway never decodes an MCP/session credential itself. The registry
   * that minted the scope proves it is still alive and that every immutable
   * placement coordinate matches this authenticated connection.
   */
  installExecutionRelayVerifier(verifier: RunnerExecutionRelayVerifier): () => void {
    if (this.executionRelayVerifier) throw new Error("RunnerGateway execution relay verifier already installed");
    this.executionRelayVerifier = verifier;
    return () => {
      if (this.executionRelayVerifier === verifier) this.executionRelayVerifier = null;
    };
  }

  installLocalAgentBridgeHandler(handler: RunnerLocalAgentBridgeHandler): () => void {
    if (this.localAgentBridgeHandler) throw new Error("RunnerGateway local agent bridge handler already installed");
    this.localAgentBridgeHandler = handler;
    return () => {
      if (this.localAgentBridgeHandler === handler) this.localAgentBridgeHandler = null;
      for (const devices of this.conns.values()) {
        for (const conn of devices.values()) this.closeLocalBridgeLeases(conn);
      }
    };
  }

  /** Apply a dashboard policy change immediately without disturbing the Runner socket. */
  revokeLocalAgentBridge(username: string, device: string): number {
    const conn = this.conns.get(username)?.get(device);
    if (!conn) return 0;
    return this.closeLocalBridgeLeases(conn);
  }

  /** Install the bearer-rotating continuation seam for authenticated Runners. */
  installSessionRecoveryIssuer(issuer: RunnerSessionRecoveryIssuer): () => void {
    if (this.sessionRecoveryIssuer) throw new Error("RunnerGateway session recovery issuer already installed");
    this.sessionRecoveryIssuer = issuer;
    return () => {
      if (this.sessionRecoveryIssuer === issuer) this.sessionRecoveryIssuer = null;
    };
  }

  /** The actual WS port (useful when opts.port = 0 in tests). */
  get port(): number {
    return this.wsPort;
  }

  async start(): Promise<void> {
    const activeBundle = this.opts.bundleSource?.active() ?? null;
    await this.startWs();
    this.lastSweepAt = 0;
    this.keepaliveTimer = setInterval(() => this.sweepConnections(), KEEPALIVE_INTERVAL_MS);
    this.keepaliveTimer.unref?.();
    // Stall detector: a 1 s timer that fires late by exactly the length of
    // whatever blocked the loop. Logged so a keepalive failure can be told
    // apart from a network one after the fact.
    let expectedAt = Date.now() + LAG_SAMPLE_MS;
    this.lagTimer = setInterval(() => {
      const now = Date.now();
      const lag = now - expectedAt;
      expectedAt = now + LAG_SAMPLE_MS;
      if (lag > LAG_WARN_MS) {
        log.warn({ lagMs: lag, runners: this.connectionCount() }, "event loop stalled; runner keepalive judgement deferred");
      }
    }, LAG_SAMPLE_MS);
    this.lagTimer.unref?.();
    log.info(
      { bundleSha: activeBundle?.sha ?? null, bundleBytes: activeBundle?.size ?? 0 },
      `Runner gateway ready (ws :${this.wsPort})`,
    );
  }

  /** Exact active artifact the gateway would hand a Runner right now. */
  get servedBundleSha(): string | null {
    return this.opts.bundleSource?.active()?.sha ?? null;
  }

  private connectionCount(): number {
    let n = 0;
    for (const devices of this.conns.values()) n += devices.size;
    return n;
  }

  /**
   * One keepalive round: terminate connections that have been silent for
   * longer than the dead-after budget (half-open sockets a middlebox killed
   * silently), then ping the rest. terminate() — not close() — because a
   * dead peer never completes the close handshake; termination fires "close"
   * locally, which runs the normal offline cleanup and rejects in-flight RPCs.
   *
   * A round that starts late (the event loop was blocked) cannot know what
   * arrived during the block, so it pings and judges nobody.
   */
  sweepConnections(): void {
    const now = Date.now();
    const sinceLastSweep = this.lastSweepAt ? now - this.lastSweepAt : 0;
    this.lastSweepAt = now;
    const stalled = sinceLastSweep > SWEEP_LATE_MS;
    if (stalled) {
      log.warn({ ms: sinceLastSweep, runners: this.connectionCount() }, "keepalive sweep ran late (event loop stalled); not judging liveness this round");
    }
    const deadAfter = this.opts.keepaliveDeadAfterMs ?? KEEPALIVE_DEAD_AFTER_MS;
    for (const devices of this.conns.values()) {
      for (const conn of devices.values()) {
        // Backstop for revocation nobody remembered to push: a socket whose
        // token row is gone or replaced is serving a credential that no longer
        // exists. Bounded by the sweep interval, and independent of any caller
        // doing the right thing.
        if (!this.store.getRunnerTokenByHash(conn.tokenHash)) {
          log.warn(`Runner ${conn.username}/${conn.device} token revoked; closing`);
          conn.ws.close(4004, "token revoked");
          continue;
        }
        const silentMs = now - conn.lastInboundAt;
        if (!stalled && silentMs > deadAfter) {
          log.warn({ silentMs }, `Runner ${conn.username}/${conn.device} silent for ${Math.round(silentMs / 1000)}s; terminating half-open connection`);
          conn.ws.terminate();
          continue;
        }
        // Deployment can activate its artifact AFTER a device has reconnected.
        // Re-enter the existing registration/update negotiation once per new
        // artifact. Old clients understand this restart hint; opt-out clients
        // are not bounced repeatedly and still choose whether to update.
        const activeSha = this.opts.bundleSource?.active()?.sha;
        // A requested transfer is explicit opt-in. If the device never reports
        // the target build, retry negotiation after a bounded quiet interval;
        // merely advertising a build is not proof it was installed.
        const retryDue = conn.lastBundleRequestedAt !== undefined
          && now - conn.lastBundleRequestedAt >= (this.opts.bundleRetryAfterMs ?? BUNDLE_RETRY_AFTER_MS);
        if (activeSha && conn.bundleSha && (activeSha !== conn.advertisedBundleSha || retryDue)) {
          const busy = conn.pending.size || conn.peerPending.size || conn.localBridgePending.size
            || conn.activeTunnels.size || conn.pendingTunnelIds.size
            || [...conn.localBridgeLeases.values()].some((lease) => lease.inFlight > 0);
          if (activeSha === conn.bundleSha) {
            conn.advertisedBundleSha = activeSha;
          } else if (!busy && conn.ws.readyState === WebSocket.OPEN) {
            conn.advertisedBundleSha = activeSha;
            conn.ws.send(JSON.stringify({ type: "restarting", retry_after_ms: 2000 }));
            conn.ws.close(1012, retryDue ? "runner update not acknowledged" : "runner bundle activated");
            continue;
          }
        }
        try {
          conn.ws.ping();
        } catch {
          /* closing socket; the close handler cleans up */
        }
      }
    }
    this.modelTunnels.sweep(stalled);
    for (const devices of this.tentacleConns.values()) {
      for (const conn of devices.values()) {
        const mcpActive = this.tentacleVerifier?.active({
          username: conn.username,
          tokenHash: conn.mcpTokenHash,
        }) === true;
        if (!this.store.getRunnerTokenByHash(conn.tokenHash) || !mcpActive) {
          log.warn(`Tentacle ${conn.username}/${conn.device} credential revoked; closing`);
          conn.ws.close(4004, "credential revoked");
          continue;
        }
        if (!stalled && !conn.isAlive) {
          log.warn(`Tentacle ${conn.username}/${conn.device} failed keepalive; terminating`);
          conn.ws.terminate();
          continue;
        }
        conn.isAlive = false;
        conn.ws.ping();
      }
    }
  }

  async stop(): Promise<void> {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    if (this.lagTimer) {
      clearInterval(this.lagTimer);
      this.lagTimer = null;
    }
    for (const devices of this.conns.values()) {
      for (const conn of devices.values()) {
        for (const p of conn.pending.values()) {
          clearTimeout(p.timer);
          p.reject(runnerTransportError("runner_gone", "gateway shutting down"));
        }
        conn.pending.clear();
        this.closeLocalBridgeLeases(conn);
        for (const stream of conn.activeTunnels) stream.destroy();
        for (const id of [...conn.pendingTunnelIds]) {
          this.failPendingDshTunnel(id, runnerTransportError("runner_gone", "gateway shutting down"));
        }
        // Tell the device this is a restart, not a revocation or a dead link:
        // a Runner that understands the frame drops its backoff and redials
        // eagerly for the next minute instead of walking up to its ceiling.
        // Best effort, queued ahead of the close frame on the same socket.
        if (conn.ws.readyState === WebSocket.OPEN) {
          conn.ws.send(JSON.stringify({ type: "restarting", retry_after_ms: RESTART_RETRY_AFTER_MS }), () => {});
        }
        conn.ws.close(1012, "gateway restarting");
      }
    }
    this.conns.clear();
    for (const devices of this.tentacleConns.values()) {
      for (const conn of devices.values()) conn.ws.close();
    }
    this.tentacleConns.clear();
    for (const [id] of this.pendingDshTunnels) {
      this.failPendingDshTunnel(id, runnerTransportError("runner_gone", "gateway shutting down"));
    }
    this.modelTunnels.close();
    const server = this.wss;
    this.wss = null;
    if (server) await new Promise<void>((resolve) => {
      // Include unauthenticated and replaced sockets, which are absent from
      // the device map. A peer withholding its close reply cannot block deploy.
      const deadline = setTimeout(() => {
        for (const socket of server.clients) socket.terminate();
      }, 2_000);
      deadline.unref();
      for (const socket of server.clients) {
        if (socket.readyState === WebSocket.OPEN) socket.close(1012, "gateway restarting");
      }
      server.close(() => { clearTimeout(deadline); resolve(); });
    });
  }

  // ── Presence ──

  isOnline(username: string): boolean {
    return (this.conns.get(username)?.size ?? 0) > 0;
  }

  /** The device is online and reported itself read-only: it lists and reads sessions and refuses everything else. */
  isReadOnly(username: string, device: string): boolean {
    return this.conns.get(username)?.get(device)?.inventory?.read_only === true;
  }

  listDevices(username: string): RunnerDeviceStatus[] {
    const activeBundle = this.opts.bundleSource?.active() ?? null;
    const online = this.conns.get(username) ?? new Map<string, RunnerConn>();
    return this.store.listRunnerTokens(username).filter((row) => !row.device.startsWith("dsh:")).map((row) => {
      const live = online.get(row.device);
      const displayName = runnerDisplayName(this.store, username, row.device);
      return {
        device: row.device,
        ...(displayName ? { display_name: displayName } : {}),
        online: live !== undefined,
        providers: runnerProviderAdvertisements(live?.inventory),
        created_at: row.created_at,
        last_seen_at: row.last_seen_at,
        ...(live?.inventory ? { inventory: live.inventory } : {}),
        ...(live?.systemStatus ? { system_status: live.systemStatus } : {}),
        ...(live?.bundleSha ? { bundle_sha: live.bundleSha } : {}),
        ...(live?.bundleSha && activeBundle ? { bundle_current: live.bundleSha === activeBundle.sha } : {}),
        ...(live?.bundleSha && activeBundle ? {
          bundle_target_sha: activeBundle.sha,
          bundle_update_status: live.bundleSha === activeBundle.sha ? "current" as const
            : live.selfUpdateEnabled === false ? "disabled" as const
            : live.rejectedBundleSha === activeBundle.sha ? "blocked" as const
            : live.lastBundleRequestedAt === undefined ? "pending" as const
            : Date.now() - live.lastBundleRequestedAt >= (this.opts.bundleRetryAfterMs ?? BUNDLE_RETRY_AFTER_MS)
              ? "retry_pending" as const : "updating" as const,
        } : {}),
      };
    });
  }

  /**
   * Kick a device's live connection (token revocation should take effect
   * immediately, not at the next reconnect). Returns whether it was online.
   */
  disconnectDevice(username: string, device: string): boolean {
    const conn = this.conns.get(username)?.get(device);
    if (!conn) return false;
    this.closeLocalBridgeLeases(conn);
    conn.ws.close(4004, "token revoked");
    return true;
  }

  private setDefaultAgentInjection(username: string, device: string, enabled: boolean): boolean {
    const conn = this.conns.get(username)?.get(device);
    if (conn?.ws.readyState !== WebSocket.OPEN) return false;
    try {
      conn.ws.send(JSON.stringify({ type: "agent_integration_policy", default_injection: enabled }));
      return true;
    } catch {
      return false;
    }
  }

  private setGuiAutomationEnabled(username: string, device: string, enabled: boolean): boolean {
    const conn = this.conns.get(username)?.get(device);
    if (conn?.ws.readyState !== WebSocket.OPEN) return false;
    try {
      conn.ws.send(JSON.stringify({ type: "gui_automation_policy", enabled }));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Liveness probe that carries NO user data (entry chains:
   * doc/tcb-reading-guide.md §3): a protocol-level WebSocket ping, not `list_recent_sessions`.
   *
   * The old health check leaked a session count, which meant an admin pressing
   * "check" on somebody else's device performed a read of that person's data
   * without holding any capability for it. Presence and round-trip time are
   * all an operator needs; a user who wants to know what their own device can
   * see goes through their own read slot.
   */
  private pingDevice(username: string, device: string): Promise<number | null> {
    const conn = this.conns.get(username)?.get(device);
    if (!conn) return Promise.resolve(null);
    return new Promise((resolve) => {
      const t0 = Date.now();
      let settled = false;
      const done = (v: number | null): void => {
        if (settled) return;
        settled = true;
        conn.ws.off("pong", onPong);
        clearTimeout(timer);
        resolve(v);
      };
      const onPong = (): void => done(Date.now() - t0);
      const timer = setTimeout(() => done(null), PING_TIMEOUT_MS);
      conn.ws.on("pong", onPong);
      try {
        conn.ws.ping();
      } catch {
        done(null);
      }
    });
  }

  private openDshTunnel(username: string, device: string, port: number): Promise<Duplex> {
    const conn = this.conns.get(username)?.get(device);
    if (!conn) return Promise.reject(runnerTransportError("runner_gone", `设备 ${device} 不在线或不属于你`));
    const advertised = conn.inventory?.dsh;
    if (!advertised?.available || advertised.port !== port) {
      return Promise.reject(new Error(`设备 ${device} 未提供已验证的 DSH 端点`));
    }
    if (conn.activeTunnels.size + conn.pendingTunnelIds.size >= MAX_DSH_TUNNELS_PER_RUNNER) {
      return Promise.reject(new Error(`设备 ${device} 的 DSH 隧道已达到上限`));
    }
    const tunnelId = randomUUID();
    const secret = randomBytes(32).toString("hex");
    return new Promise<Duplex>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.failPendingDshTunnel(
          tunnelId,
          runnerTransportError("runner_timeout", `设备 ${device} 建立 DSH 隧道超时`),
        );
      }, DSH_TUNNEL_TIMEOUT_MS);
      conn.pendingTunnelIds.add(tunnelId);
      this.pendingDshTunnels.set(tunnelId, {
        conn,
        secretHash: createHash("sha256").update(secret).digest(),
        resolve,
        reject,
        timer,
      });
      conn.ws.send(JSON.stringify({ type: "dsh_tunnel_open", tunnelId, secret }), (error) => {
        if (error) this.failPendingDshTunnel(tunnelId, runnerTransportError("runner_gone", error.message));
      });
    });
  }

  private failPendingDshTunnel(tunnelId: string, error: Error): void {
    const pending = this.pendingDshTunnels.get(tunnelId);
    if (!pending) return;
    this.pendingDshTunnels.delete(tunnelId);
    pending.conn.pendingTunnelIds.delete(tunnelId);
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  // ── RPC to runners (adapter-only; see claimTransport) ──

  /**
   * Route one op to the owner's runner(s). list/search merge across devices;
   * read/copy return the first device that has the session.
   *
   * Private: the ONLY way to reach it is the transport handed to the Runner
   * Object adapter, whose `owner` comes from the Object's fixed binding.
   */
  private async dispatchForOwner(username: string, method: string, args: Record<string, unknown>, rosterRead?: RunnerRosterRead): Promise<unknown> {
    let devices = Array.from(this.conns.get(username)?.values() ?? []);
    if (devices.length === 0) {
      throw runnerTransportError("runner_offline", `用户 ${username} 当前没有在线的 Runner`);
    }

    // Machine ops act on ONE NAMED box. The name is mandatory, and it is
    // mandatory in the Object's arg schema (see `DEVICE_ARG` in
    // runner/capability.ts) so that it is part of the hash a human approves.
    // Picking "the only one online" here would pick it AFTER the approval,
    // which is a different machine than the card described whenever the online
    // set moved in between. An unnamed device is therefore a caller bug, not a
    // situation to resolve.
    if (Object.hasOwn(MACHINE_METHODS, method)) {
      const wanted = typeof args.device === "string" ? args.device.trim() : "";
      if (!wanted) {
        throw new Error(`${method} 必须指定 device(先用 machines_list 看有哪些设备)`);
      }
      const conn = this.conns.get(username)?.get(wanted);
      if (!conn) {
        const online = devices.map((d) => d.device).join(", ") || "(无)";
        throw runnerTransportError("runner_offline", `设备 ${wanted} 不在线或不属于你。当前在线: ${online}`);
      }
      const { device: _drop, ...rest } = args;
      const timeout = method === "workspace_file_transfer" ? 30_000 : this.opts.machineTimeoutMs
        ?? (method === "append_session" ? APPEND_MACHINE_TIMEOUT_MS : MACHINE_TIMEOUT_MS);
      return await this.rpcOnConn(conn, method, rest, timeout);
    }

    if (method === "list_recent_sessions" || method === "digest_recent_sessions" || method === "search_sessions") {
      const wanted = typeof args.device === "string" ? args.device : "";
      // Keep explicit device/catalog/identity reads unchanged. A native roster opt-out
      // skips only unpinned recent discovery, not that device's execution inventory.
      const recentWindow = method === "list_recent_sessions" && !wanted && args.cursor === undefined && args.ids === undefined;
      const omitted = recentWindow ? devices.filter((device) => !runnerHasSessionRoster(device.inventory)) : [];
      const targets = wanted ? devices.filter((device) => device.device === wanted)
        : devices.filter((device) => !omitted.includes(device));
      if (!targets.length && !omitted.length) throw runnerTransportError("runner_offline", "指定设备不在线或不属于你");
      const timeout = method === "list_recent_sessions"
        ? (this.opts.sessionListTimeoutMs ?? SESSION_LIST_TIMEOUT_MS)
        : (this.opts.rpcTimeoutMs ?? RPC_TIMEOUT_MS);
      const settled = await Promise.allSettled(targets.map(async (conn) => {
        // An exact selector asks for chats outside the materialized window.
        const cached = recentWindow ? rosterRead?.(conn.device) : undefined;
        return cached?.hit ? cached.result : this.rpcOnConn(conn, method, args, timeout);
      }));
      const oks = settled
        .map((s, i) => ({ s, device: targets[i].device, inventory: targets[i].inventory }))
        .filter((x): x is {
          s: PromiseFulfilledResult<unknown>;
          device: string;
          inventory: RunnerInventory | undefined;
        } => x.s.status === "fulfilled");
      if (oks.length === 0 && targets.length > 0) {
        const firstErr = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
        throw new Error(firstErr?.reason instanceof Error ? firstErr.reason.message : "所有 Runner 均未响应");
      }
      // A history page merges every device after one shared position. Dropping
      // a failed device would let the next cursor pass rows it never returned.
      const failedDevice = method === "list_recent_sessions" && typeof args.cursor === "string"
        ? settled.findIndex((s) => s.status === "rejected") : -1;
      if (failedDevice >= 0) {
        const reason = (settled[failedDevice] as PromiseRejectedResult).reason;
        throw new Error(`设备 ${targets[failedDevice]!.device} 读取失败，未推进会话翻页位置：${reason instanceof Error ? reason.message : String(reason)}`);
      }
      return method === "search_sessions"
        ? mergeSearchResults(settled.map((s, i) => ({
          device: targets[i].device,
          ...(s.status === "fulfilled" ? { result: s.value } : {}),
        })), args)
        : mergeListResults(
            [
              ...oks.map((o) => ({ device: o.device, result: o.s.value, inventory: o.inventory })),
              ...omitted.map((device) => ({ device: device.device, inventory: device.inventory,
                result: { total_found: 0, sessions: [], primary_window: true } })),
            ],
            args,
            method === "digest_recent_sessions" ? 8 : 20,
          );
    }

    // read_session / copy_session / copy_file: the caller names an id or a path
    // and does not necessarily know which machine holds it, so this asks each in
    // turn. Two properties the naive loop did not have:
    //
    //  · `device` PINS it when the caller does know. A report that discloses a
    //    file should be able to say which laptop it came off, and a path like
    //    `~/notes/plan.md` may well exist on two of them with different
    //    contents. Pinning is exact — an offline named device is an error, not
    //    a reason to ask somebody else.
    //  · without a pin the order is SORTED BY DEVICE NAME, not Map insertion
    //    order. "Whichever laptop reconnected most recently answers first" made
    //    the source of an archived file depend on WebSocket timing, so the same
    //    request could disclose different bytes on two runs.
    const pinned = typeof args.device === "string" ? args.device.trim() : "";
    const { device: _pin, ...rest } = args;
    const timeout = method === "copy_session" || method === "copy_file"
      ? COPY_TIMEOUT_MS
      : (this.opts.rpcTimeoutMs ?? RPC_TIMEOUT_MS);
    // Whoever answers, the ANSWER says which machine it was. The scanner on the
    // far side has no idea it is one of several, so this is the only place that
    // can stamp it — and a report that discloses a file should be able to name
    // the laptop it came off.
    const stamp = (result: unknown, device: string): unknown =>
      EXPORT_METHODS.has(method) && result && typeof result === "object" && !Array.isArray(result)
        ? { ...(result as Record<string, unknown>), device }
        : result;
    if (pinned) {
      const conn = this.conns.get(username)?.get(pinned);
      if (!conn) {
        const online = devices.map((d) => d.device).join(", ") || "(无)";
        throw runnerTransportError("runner_offline", `设备 ${pinned} 不在线或不属于你。当前在线: ${online}`);
      }
      return stamp(await this.rpcOnConn(conn, method, rest, timeout), conn.device);
    }
    let lastErr: Error = new Error("Runner 未响应");
    for (const conn of [...devices].sort((a, b) => a.device.localeCompare(b.device))) {
      try {
        return stamp(await this.rpcOnConn(conn, method, rest, timeout), conn.device);
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
      }
    }
    throw lastErr;
  }

  private rpcOnConn(
    conn: RunnerConn,
    method: string,
    args: Record<string, unknown>,
    timeoutMs = RPC_TIMEOUT_MS,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        reject(runnerTransportError("runner_timeout", `Runner ${conn.device} 响应超时 (${method})`));
      }, timeoutMs);
      conn.pending.set(id, { resolve, reject, timer });
      conn.ws.send(JSON.stringify({ type: "rpc", id, method, args }), (err) => {
        if (err) {
          clearTimeout(timer);
          conn.pending.delete(id);
          reject(runnerTransportError("runner_gone", err.message));
        }
      });
    });
  }

  // ── WS server (runner side) ──

  private startWs(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({
        port: this.opts.port,
        host: this.opts.host,
        maxPayload: MAX_WS_PAYLOAD,
        // Session transcripts are JSON prose — they compress ~8×, and real
        // runners dial in over residential uplinks. The ws client enables
        // permessage-deflate by default, so offering it here is enough; old
        // runner builds that don't offer it simply stay uncompressed.
        // No-context-takeover keeps per-connection zlib memory bounded on a
        // small shared host.
        perMessageDeflate: {
          threshold: 1024,
          concurrencyLimit: 4,
          serverNoContextTakeover: true,
          clientNoContextTakeover: true,
        },
      });
      this.wss = wss;
      wss.once("error", reject);
      wss.on("listening", () => {
        const addr = wss.address();
        this.wsPort = typeof addr === "object" && addr ? addr.port : this.opts.port;
        resolve();
      });
      wss.on("connection", (ws) => this.handleConnection(ws));
    });
  }

  private claimDshTunnel(ws: WebSocket, message: Record<string, unknown>): boolean {
    if (message.protocol !== "dsh-tunnel/v1") return false;
    const tunnelId = typeof message.tunnelId === "string" ? message.tunnelId : "";
    const secret = typeof message.secret === "string" ? message.secret : "";
    const pending = this.pendingDshTunnels.get(tunnelId);
    const supplied = createHash("sha256").update(secret).digest();
    if (!pending || !timingSafeEqual(pending.secretHash, supplied)) {
      ws.close(4003, "invalid tunnel credential");
      return true;
    }
    this.pendingDshTunnels.delete(tunnelId);
    pending.conn.pendingTunnelIds.delete(tunnelId);
    clearTimeout(pending.timer);
    ws.removeAllListeners("message");
    ws.send(JSON.stringify({ type: "registered", protocol: "dsh-tunnel/v1", tunnelId }));
    const stream = httpCompatibleTunnel(createWebSocketStream(ws, { encoding: undefined }));
    pending.conn.activeTunnels.add(stream);
    stream.once("close", () => pending.conn.activeTunnels.delete(stream));
    stream.once("error", () => pending.conn.activeTunnels.delete(stream));
    pending.resolve(stream);
    return true;
  }

  private handleConnection(ws: WebSocket): void {
    let conn: RunnerConn | null = null;
    let tentacle: TentacleConn | null = null;
    const authTimer = setTimeout(() => {
      if (!conn && !tentacle) ws.close(4001, "register timeout");
    }, 10_000);

    // Protocol-level pong (auto-answered by every ws client build) and any
    // data frame both prove the link is alive.
    ws.on("pong", () => {
      if (conn) conn.lastInboundAt = Date.now();
      if (tentacle) tentacle.isAlive = true;
    });

    ws.on("message", (data) => {
      if (conn) conn.lastInboundAt = Date.now();
      if (tentacle) tentacle.isAlive = true;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(data)) as Record<string, unknown>;
      } catch {
        return;
      }

      if (!conn && !tentacle) {
        if (msg.type === "register" && this.claimDshTunnel(ws, msg)) {
          clearTimeout(authTimer);
          return;
        }
        if (msg.type === "register" && this.modelTunnels.handleRegister(ws, msg)) {
          clearTimeout(authTimer);
          return;
        }
        if (msg.type !== "register" || typeof msg.token !== "string") {
          ws.close(4003, "expected register");
          return;
        }
        const row = this.store.getRunnerTokenByHash(hashRunnerToken(msg.token));
        if (!row) {
          log.warn("Runner register rejected: unknown token");
          ws.send(JSON.stringify({ type: "error", message: "invalid token" }));
          ws.close(4003, "invalid token");
          return;
        }
        if (msg.protocol === "tentacle/v1") {
          const gateToken = typeof msg.gateToken === "string" ? msg.gateToken : "";
          const principal = this.tentacleVerifier?.authenticate(gateToken) ?? null;
          if (!row.device.startsWith("dsh:") || !principal || principal.username !== row.username) {
            log.warn("Tentacle register rejected: credential mismatch or invalid dsh device");
            ws.send(JSON.stringify({ type: "error", message: "invalid tentacle credentials" }));
            ws.close(4003, "invalid tentacle credentials");
            return;
          }
          clearTimeout(authTimer);
          tentacle = {
            ws,
            username: row.username,
            device: row.device,
            tokenHash: row.token_hash,
            mcpTokenHash: principal.tokenHash,
            isAlive: true,
            inbound: Promise.resolve(),
          };
          const devices = this.tentacleConns.get(row.username) ?? new Map<string, TentacleConn>();
          devices.get(row.device)?.ws.close(4000, "replaced by new connection");
          devices.set(row.device, tentacle);
          this.tentacleConns.set(row.username, devices);
          this.store.touchRunnerToken(row.token_hash, new Date().toISOString());
          ws.send(JSON.stringify({
            type: "registered",
            protocol: "tentacle/v1",
            username: row.username,
            device: row.device,
          }));
          log.info(`Tentacle online: ${row.username}/${row.device}`);
          return;
        }
        if (msg.protocol !== undefined && msg.protocol !== RUNNER_GATEWAY_PROTOCOL) {
          ws.send(JSON.stringify({ type: "error", message: "incompatible runner gateway protocol" }));
          ws.close(4003, "incompatible runner gateway protocol");
          return;
        }
        clearTimeout(authTimer);
        const parsedInventory = runnerInventoryFrom(msg.inventory);
        const inventory = parsedInventory.inventory;
        if (msg.inventory !== undefined && parsedInventory.dropped.length) {
          log.warn({ username: row.username, device: row.device, dropped: parsedInventory.dropped.slice(0, 20) },
            inventory ? "Runner inventory segments rejected" : "Runner inventory rejected");
        }
        const bundleSha = typeof msg.bundle_sha === "string" && /^[0-9a-f]{64}$/.test(msg.bundle_sha)
          ? msg.bundle_sha
          : undefined;
        conn = {
          ws,
          username: row.username,
          device: row.device,
          tokenHash: row.token_hash,
          lastInboundAt: Date.now(),
          pending: new Map(),
          ...(inventory ? { inventory } : {}),
          ...(bundleSha ? { bundleSha } : {}),
          ...(typeof msg.self_update_enabled === "boolean" ? { selfUpdateEnabled: msg.self_update_enabled } : {}),
          ...(typeof msg.rejected_bundle_sha === "string" && /^[0-9a-f]{64}$/.test(msg.rejected_bundle_sha)
            ? { rejectedBundleSha: msg.rejected_bundle_sha } : {}),
          peerPending: new Set(),
          localBridgePending: new Set(),
          localBridgeGeneration: 0,
          localBridgeLeases: new Map(),
          activeTunnels: new Set(),
          pendingTunnelIds: new Set(),
          ...(this.store.getRunnerGuestProfile(row.username, row.device) ? { guest: true } : {}),
        };
        // One live connection per device: a reconnect replaces the old one.
        const devices = this.conns.get(row.username) ?? new Map<string, RunnerConn>();
        devices.get(row.device)?.ws.close(4000, "replaced by new connection");
        devices.set(row.device, conn);
        this.conns.set(row.username, devices);
        this.store.touchRunnerToken(row.token_hash, new Date().toISOString());
        // A Runner that reports its own build sha learns which artifact is
        // active at this moment and decides for itself whether to ask for it.
        const activeBundle = this.opts.bundleSource?.active() ?? null;
        conn.advertisedBundleSha = activeBundle?.sha;
        const updateAvailable = Boolean(activeBundle && bundleSha && bundleSha !== activeBundle.sha);
        ws.send(JSON.stringify({
          type: "registered",
          username: row.username,
          device: row.device,
          default_agent_injection:
            this.store.getRunnerDevicePolicy(row.username, row.device)?.default_agent_injection === 1,
          gui_automation_enabled:
            this.store.getRunnerDevicePolicy(row.username, row.device)?.gui_automation_enabled === 1,
          ...(activeBundle ? { bundle_sha: activeBundle.sha, update_available: updateAvailable } : {}),
        }));
        log.info(
          { bundle: bundleSha ? bundleSha.slice(0, 12) : "unreported", updateAvailable },
          `Runner online: ${row.username}/${row.device}`,
        );
        // `row` was read before this registration touched it: its last_seen_at
        // is the device's previous proof of life (every Runner ping touches it).
        this.announcePresence(row.username, row.device, true, row.last_seen_at);
        return;
      }

      if (tentacle) {
        const current = tentacle;
        const deliver = async () => {
          for (const listener of [...this.tentacleListeners]) {
            await listener({ username: current.username, device: current.device }, msg);
          }
        };
        const refused = (err: unknown) => {
            log.warn({ err, username: current.username, device: current.device }, "tentacle message refused");
            current.ws.close(1011, "tentacle handler failed");
        };
        // An application call may stay open until a message sent to this same
        // peer is acknowledged (notably tool.invoke -> tool.result). Queueing
        // that routing ACK behind the open call deadlocks both directions.
        // ACKs carry no application effect and TentacleBroker validates their
        // exact route key, so let them release the matching Promise promptly;
        // all application messages remain ordered per authenticated peer.
        if (msg.op === "delivery.ack") {
          void deliver().catch(refused);
        } else {
          current.inbound = current.inbound.then(deliver).catch(refused);
        }
        return;
      }
      // Registration establishes exactly one of the two connection kinds.
      // Keep the impossible third state closed and explicit for later edits.
      if (!conn) {
        ws.close(4003, "connection is not registered");
        return;
      }

      if (conn.guest && typeof msg.type === "string" && GUEST_REFUSED_FRAMES.has(msg.type)) {
        log.warn({ username: conn.username, device: conn.device, type: msg.type }, "guest client frame refused");
        return;
      }
      if (msg.type === "peer_rpc") {
        void this.handlePeerRpc(conn, msg);
        return;
      }
      if (msg.type === "local_agent_bridge") {
        void this.handleLocalAgentBridge(conn, msg);
        return;
      }

      if (msg.type === "session_recovery_scope") {
        this.handleSessionRecoveryScope(conn, msg);
        return;
      }

      if (msg.type === "ping") {
        this.store.touchRunnerToken(conn.tokenHash, new Date().toISOString());
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }
      if (msg.type === "bundle_request") {
        // The bundle travels over the socket the device already authenticated
        // on — no second URL, no second credential. Integrity is the sha the
        // Runner verifies before it swaps files; authenticity is the same
        // trust the device already extends to every RPC on this socket.
        const now = Date.now();
        conn.lastBundleRequestedAt = now;
        const activeBundle = this.opts.bundleSource?.active() ?? null;
        if (!activeBundle) {
          ws.send(JSON.stringify({ type: "bundle", ok: false, error: "no healthy runner bundle is active" }));
          return;
        }
        if (conn.lastBundleSentAt !== undefined && now - conn.lastBundleSentAt < BUNDLE_MIN_INTERVAL_MS) {
          ws.send(JSON.stringify({ type: "bundle", ok: false, error: "bundle already sent within the last minute" }));
          return;
        }
        conn.lastBundleSentAt = now;
        log.info({ username: conn.username, device: conn.device, sha: activeBundle.sha.slice(0, 12), bytes: activeBundle.size }, "serving active runner bundle for self-update");
        ws.send(JSON.stringify({ type: "bundle", ok: true, sha: activeBundle.sha, size: activeBundle.size, data: activeBundle.base64 }));
        return;
      }
      if (msg.type === "dsh_tunnel_result" && typeof msg.tunnelId === "string") {
        if (!msg.ok) {
          this.failPendingDshTunnel(
            msg.tunnelId,
            new Error(typeof msg.error === "string" ? msg.error : "Runner refused DSH tunnel"),
          );
        }
        return;
      }

      if (msg.type === "inventory_changed") {
        const { inventory, dropped } = runnerInventoryFrom(msg.inventory);
        if (dropped.length) {
          log.warn({ username: conn.username, device: conn.device, dropped: dropped.slice(0, 20) },
            inventory ? "Runner inventory segments rejected" : "Runner inventory update rejected");
        }
        if (!inventory) return;
        conn.inventory = inventory;
        for (const listener of [...this.sessionChangeListeners]) {
          try {
            listener(conn.username, conn.device);
          } catch (err) {
            log.warn({ err, username: conn.username, device: conn.device }, "inventory-change listener failed");
          }
        }
        return;
      }

      if (msg.type === "system_status") {
        const status = runnerSystemStatusFromWire(msg.status);
        if (!status) {
          log.warn({ username: conn.username, device: conn.device }, "Runner system status rejected");
          return;
        }
        conn.systemStatus = status;
        return;
      }

      if (msg.type === "session_projection") {
        if (this.conns.get(conn.username)?.get(conn.device) !== conn) return;
        const projection = runnerSessionProjectionFromWire(msg.projection);
        if (!projection) {
          log.warn({ username: conn.username, device: conn.device }, "Runner session projection rejected");
          return;
        }
        let accepted = false;
        for (const listener of [...this.sessionProjectionListeners]) {
          try {
            accepted = listener(conn.username, conn.device, projection) || accepted;
          } catch (err) {
            log.warn({ err, username: conn.username, device: conn.device }, "session projection listener failed");
          }
        }
        if (projection.kind === "roster_full" && (accepted || this.sessionProjectionListeners.size === 0)) {
          for (const listener of [...this.sessionChangeListeners]) {
            try {
              listener(conn.username, conn.device);
            } catch (err) {
              log.warn({ err, username: conn.username, device: conn.device }, "session-change listener failed");
            }
          }
        }
        return;
      }

      if (msg.type === "managed_session_completion") {
        if (this.conns.get(conn.username)?.get(conn.device) !== conn) return;
        const completion = runnerManagedCompletionFromWire(msg.completion);
        if (!completion) {
          log.warn({ username: conn.username, device: conn.device }, "Runner managed completion rejected");
          return;
        }
        const listeners = [...this.managedCompletionListeners];
        let handled = listeners.length > 0;
        for (const listener of listeners) {
          try {
            listener(conn.username, conn.device, completion);
          } catch (err) {
            handled = false;
            log.warn({ err, username: conn.username, device: conn.device }, "managed completion listener failed");
          }
        }
        // Every receiver handled it, so this Runner need not replay it after a
        // reconnect. Receivers stay idempotent: the acknowledgement can be lost.
        if (handled && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: RUNNER_MANAGED_COMPLETION_ACK, provider: completion.provider, turn_id: completion.turn_id }));
        }
        return;
      }

      if (msg.type === "sessions_changed") {
        for (const listener of [...this.sessionProjectionInvalidationListeners]) {
          try {
            listener(conn.username, conn.device);
          } catch (err) {
            log.warn({ err, username: conn.username, device: conn.device }, "session projection invalidation listener failed");
          }
        }
        for (const listener of [...this.sessionChangeListeners]) {
          try {
            listener(conn.username, conn.device);
          } catch (err) {
            log.warn({ err, username: conn.username, device: conn.device }, "session-change listener failed");
          }
        }
        return;
      }

      if (msg.type === "rpc_result" && typeof msg.id === "string") {
        const pending = conn.pending.get(msg.id);
        if (!pending) return;
        conn.pending.delete(msg.id);
        clearTimeout(pending.timer);
        if (msg.ok) pending.resolve(msg.result);
        else pending.reject(new Error(typeof msg.error === "string" ? msg.error : "runner error"));
      }
    });


    ws.on("close", (code, reason) => {
      clearTimeout(authTimer);
      if (tentacle) {
        const devices = this.tentacleConns.get(tentacle.username);
        if (devices?.get(tentacle.device) === tentacle) {
          devices.delete(tentacle.device);
          if (devices.size === 0) this.tentacleConns.delete(tentacle.username);
        }
        log.info(`Tentacle offline: ${tentacle.username}/${tentacle.device}`);
        return;
      }
      if (!conn) return;
      const devices = this.conns.get(conn.username);
      if (devices?.get(conn.device) === conn) {
        devices.delete(conn.device);
        if (devices.size === 0) this.conns.delete(conn.username);
      }
      for (const p of conn.pending.values()) {
        clearTimeout(p.timer);
        p.reject(runnerTransportError("runner_gone", "Runner 连接已断开"));
      }
      conn.pending.clear();
      this.closeLocalBridgeLeases(conn);
      for (const stream of conn.activeTunnels) stream.destroy();
      conn.activeTunnels.clear();
      for (const id of [...conn.pendingTunnelIds]) {
        this.failPendingDshTunnel(id, runnerTransportError("runner_gone", "Runner 连接已断开"));
      }
      if (!devices?.has(conn.device)) this.modelTunnels.hostDisconnected(conn.username, conn.device);
      const replaced = Boolean(devices?.has(conn.device));
      log.info({ owner: conn.username, device: conn.device, code, reason: diagnosticString(reason.toString()), replaced },
        replaced ? "Runner connection replaced" : `Runner offline: ${conn.username}/${conn.device}`);
      // Only the connection that still owned the slot went offline; a socket
      // replaced by a reconnect was never the device's presence.
      if (!devices?.has(conn.device)) this.announcePresence(conn.username, conn.device, false);
    });

    ws.on("error", (err) => log.warn({ err }, "Runner connection error"));
  }

  private closeLocalBridgeLeases(conn: RunnerConn): number {
    conn.localBridgeGeneration++;
    const count = conn.localBridgeLeases.size;
    for (const held of conn.localBridgeLeases.values()) {
      try { held.lease.close(); } catch { /* already closed */ }
    }
    conn.localBridgeLeases.clear();
    return count;
  }

  private localBridgeCapacityError(conn: RunnerConn, kind: "workspace" | "gui"): string {
    const now = Date.now();
    const matching = [...conn.localBridgeLeases.values()].filter((held) => held.kind === kind);
    const limit = kind === "workspace"
      ? LOCAL_AGENT_BRIDGE_MAX_WORKSPACE_LEASES
      : LOCAL_AGENT_BRIDGE_MAX_GUI_LEASES;
    const active = [...conn.localBridgeLeases.values()]
      .sort((left, right) => left.openedAt - right.openedAt)
      .map((held, index) => {
        const client = held.clientId ? ` client=${diagnosticString(held.clientId)}` : " client=unknown";
        const pid = held.clientPid ? ` reported_pid=${held.clientPid}` : "";
        const workspace = held.workspaceId ? ` workspace=${diagnosticString(held.workspaceId)}` : "";
        const lastTool = held.lastTool ? ` last_tool=${diagnosticString(held.lastTool)}` : "";
        const busy = held.inFlight > 0 ? ` in_flight=${held.inFlight}` : "";
        return `${index + 1}) ${held.kind} target=${diagnosticString(held.targetDevice)}${workspace}`
          + `${client}${pid} age=${shortDuration(now - held.openedAt)}`
          + ` idle=${shortDuration(now - held.lastUsedAt)}${lastTool}${busy}`;
      });
    return `local agent bridge ${kind} lease capacity reached (${matching.length}/${limit}; `
      + `${conn.localBridgeLeases.size} total on runtime Runner ${diagnosticString(conn.device)}). `
      + `Active leases: ${active.join("; ") || "none"}. `
      + `Release a slot by closing stale Codex/Claude/OMP clients or disconnecting their octopus MCP stdio server `
      + `on runtime Runner ${diagnosticString(conn.device)}; the local client disconnect is reclaimed automatically. `
      + "Restarting a target execution Runner does not release these runtime-side slots.";
  }

  private async handleLocalAgentBridge(conn: RunnerConn, msg: Record<string, unknown>): Promise<void> {
    const id = typeof msg.id === "string" ? msg.id : "";
    const op = typeof msg.op === "string" ? msg.op : "";
    const reply = (ok: boolean, value: unknown, errorCode?: LocalAgentBridgeErrorCode): void => {
      if (conn.ws.readyState !== WebSocket.OPEN) return;
      conn.ws.send(JSON.stringify(ok
        ? { type: "local_agent_bridge_result", id, ok: true, result: value }
        : { type: "local_agent_bridge_result", id, ok: false, error: String(value), ...(errorCode ? { error_code: errorCode } : {}) }));
    };
    if (!id || id.length > 128 || ![
      "list_targets", "list_account_tools", "account_call", "open", "open_gui", "call", "close", "development_register",
    ].includes(op)) {
      reply(false, "invalid local agent bridge request");
      return;
    }
    // Cleanup is idempotent, connection-scoped, and must not be starved by
    // calls already occupying the ordinary in-flight budget.
    if (op === "close") {
      const leaseId = typeof msg.lease_id === "string" ? msg.lease_id : "";
      const held = conn.localBridgeLeases.get(leaseId);
      if (held) {
        conn.localBridgeLeases.delete(leaseId);
        try {
          held.lease.close();
        } catch (error) {
          reply(false, error instanceof Error ? error.message : String(error));
          return;
        }
      }
      reply(true, { closed: Boolean(held) });
      return;
    }
    if (conn.localBridgePending.has(id) || conn.localBridgePending.size >= LOCAL_AGENT_BRIDGE_MAX_IN_FLIGHT) {
      reply(false, "too many or duplicate local agent bridge requests");
      return;
    }
    if (conn.ws.readyState !== WebSocket.OPEN
      || this.conns.get(conn.username)?.get(conn.device) !== conn
      || !this.store.getRunnerTokenByHash(conn.tokenHash)) {
      this.closeLocalBridgeLeases(conn);
      reply(false, "local agent bridge source credential or connection was revoked", "policy_changed");
      return;
    }
    const configured = this.store.getRunnerDevicePolicy(conn.username, conn.device)?.local_agent_bridge_mode ?? "disabled";
    if (op !== "close" && configured === "disabled") {
      this.closeLocalBridgeLeases(conn);
      reply(false, "this Runner is not authorized to expose the local Agent bridge; enable it in Dashboard overview");
      return;
    }
    const handler = this.localAgentBridgeHandler;
    if (!handler) {
      reply(false, "local agent bridge is unavailable in this deployment");
      return;
    }
    const generation = conn.localBridgeGeneration;
    const stillAuthorized = () => conn.localBridgeGeneration === generation
      && conn.ws.readyState === WebSocket.OPEN
      && Boolean(this.store.getRunnerTokenByHash(conn.tokenHash))
      && this.conns.get(conn.username)?.get(conn.device) === conn
      && this.store.getRunnerDevicePolicy(conn.username, conn.device)?.local_agent_bridge_mode === configured;
    conn.localBridgePending.add(id);
    try {
      const subject: RunnerLocalAgentBridgeSubject = { owner: conn.username, device: conn.device };
      if (op === "development_register") {
        if (!handler.registerDevelopment || !msg.proof || typeof msg.proof !== "object" || Array.isArray(msg.proof)) throw new Error("native development registration is unavailable");
        reply(true, await handler.registerDevelopment(subject, msg.proof as Record<string, unknown>, stillAuthorized)); return;
      }
      if (op === "list_targets") {
        reply(true, await handler.listTargets(subject));
        return;
      }
      if (op === "list_account_tools") {
        reply(true, handler.listAccountTools ? await handler.listAccountTools(subject) : { tools: [] });
        return;
      }
      if (op === "account_call") {
        const tool = typeof msg.tool === "string" ? msg.tool : "";
        const args = msg.args && typeof msg.args === "object" && !Array.isArray(msg.args)
          ? msg.args as Record<string, unknown>
          : {};
        if (!/^[a-z][a-z0-9_]{0,159}$/.test(tool) || !handler.callAccount) {
          reply(false, "tool is outside the Runner account capability surface");
          return;
        }
        const caller = localBridgeCaller(msg.caller_session);
        reply(true, await handler.callAccount({ subject, tool, args,
          mode: configured as Exclude<RunnerLocalAgentBridgeMode, "disabled">, isActive: stillAuthorized, ...(caller ? { caller } : {}) }));
        return;
      }
      const leaseId = typeof msg.lease_id === "string" ? msg.lease_id : "";
      if (op === "open") {
        const workspaceLeaseCount = [...conn.localBridgeLeases.values()]
          .filter((held) => held.kind === "workspace").length;
        if (workspaceLeaseCount >= LOCAL_AGENT_BRIDGE_MAX_WORKSPACE_LEASES) {
          reply(false, this.localBridgeCapacityError(conn, "workspace"));
          return;
        }
        const executionDevice = typeof msg.device === "string" ? msg.device.trim() : "";
        const workspaceId = typeof msg.workspace_id === "string" ? msg.workspace_id.trim() : "";
        if (!executionDevice || executionDevice === conn.device) {
          reply(false, "a different execution device is required");
          return;
        }
        const lease = await handler.open({
          subject,
          selection: { device: executionDevice, ...(workspaceId ? { workspaceId } : {}) },
          mode: configured as Exclude<RunnerLocalAgentBridgeMode, "disabled">,
        });
        const boundWorkspace = workspaceId || lease.workspaceId || "";
        if (!stillAuthorized() || lease.isActive?.() === false) {
          lease.close();
          reply(false, "local agent bridge authorization changed while opening", "policy_changed");
          return;
        }
        // Concurrent opens may all pass the pre-await check. Re-check before
        // publishing the new scope and immediately retire the excess one.
        if ([...conn.localBridgeLeases.values()].filter((held) => held.kind === "workspace").length
          >= LOCAL_AGENT_BRIDGE_MAX_WORKSPACE_LEASES) {
          try { lease.close(); } catch { /* capacity refusal remains authoritative */ }
          reply(false, this.localBridgeCapacityError(conn, "workspace"));
          return;
        }
        const minted = randomUUID();
        const now = Date.now();
        conn.localBridgeLeases.set(minted, {
          mode: configured,
          kind: "workspace",
          lease,
          targetDevice: executionDevice,
          workspaceId: boundWorkspace,
          ...localBridgeClientMetadata(msg),
          openedAt: now,
          lastUsedAt: now,
          inFlight: 0,
        });
        reply(true, { lease_id: minted, device: executionDevice, workspace_id: boundWorkspace, mode: configured });
        return;
      }
      if (op === "open_gui") {
        const guiLeaseCount = [...conn.localBridgeLeases.values()]
          .filter((held) => held.kind === "gui").length;
        if (guiLeaseCount >= LOCAL_AGENT_BRIDGE_MAX_GUI_LEASES) {
          reply(false, this.localBridgeCapacityError(conn, "gui"));
          return;
        }
        const targetDevice = typeof msg.device === "string" ? msg.device.trim() : "";
        if (!targetDevice || targetDevice === conn.device) {
          reply(false, "a different GUI target device is required");
          return;
        }
        const lease = await handler.openGui({ subject, device: targetDevice });
        if (!stillAuthorized()) {
          lease.close();
          reply(false, "local agent bridge authorization changed while awaiting consent", "policy_changed");
          return;
        }
        if ([...conn.localBridgeLeases.values()].filter((held) => held.kind === "gui").length
          >= LOCAL_AGENT_BRIDGE_MAX_GUI_LEASES) {
          try { lease.close(); } catch { /* capacity refusal remains authoritative */ }
          reply(false, this.localBridgeCapacityError(conn, "gui"));
          return;
        }
        const minted = randomUUID();
        const now = Date.now();
        conn.localBridgeLeases.set(minted, {
          mode: configured,
          kind: "gui",
          lease,
          targetDevice,
          ...localBridgeClientMetadata(msg),
          openedAt: now,
          lastUsedAt: now,
          inFlight: 0,
        });
        reply(true, {
          lease_id: minted,
          device: targetDevice,
          mode: configured,
          ...(lease.description ?? {}),
        });
        return;
      }
      const held = conn.localBridgeLeases.get(leaseId);
      if (!held || held.mode !== configured) {
        if (held) {
          conn.localBridgeLeases.delete(leaseId);
          held.lease.close();
        }
        reply(false, "local agent bridge lease is missing or its policy changed", held ? "policy_changed" : "lease_missing");
        return;
      }
      if (held.kind === "workspace" && held.lease.isActive?.() === false) {
        conn.localBridgeLeases.delete(leaseId);
        held.lease.close();
        reply(false, "local agent bridge execution scope ended", "lease_expired");
        return;
      }
      const tool = typeof msg.tool === "string" ? msg.tool : "";
      const args = msg.args && typeof msg.args === "object" && !Array.isArray(msg.args)
        ? msg.args as Record<string, unknown>
        : {};
      const allowed = held.kind === "gui" ? LOCAL_AGENT_BRIDGE_GUI_TOOLS : LOCAL_AGENT_BRIDGE_TOOLS;
      if (!allowed.has(tool)) {
        reply(false, "tool is outside the local agent bridge surface");
        return;
      }
      held.lastUsedAt = Date.now();
      held.lastTool = tool;
      held.inFlight++;
      try {
        reply(true, await held.lease.call(tool, args));
      } finally {
        held.inFlight--;
      }
    } catch (error) {
      reply(false, error instanceof Error ? error.message : String(error));
    } finally {
      conn.localBridgePending.delete(id);
    }
  }
  private async handlePeerRpc(conn: RunnerConn, msg: Record<string, unknown>): Promise<void> {
    const id = typeof msg.id === "string" ? msg.id : "";
    const method = typeof msg.method === "string" ? msg.method : "";
    const target = typeof msg.target === "string" ? msg.target.trim() : "";
    const workspaceId = typeof msg.workspaceId === "string" ? msg.workspaceId.trim() : "";
    const token = typeof msg.executionToken === "string" ? msg.executionToken : "";
    const args = msg.args && typeof msg.args === "object" && !Array.isArray(msg.args)
      ? msg.args as Record<string, unknown>
      : {};
    const reply = (ok: boolean, value: unknown, code?: "transport_unavailable"): void => {
      if (conn.ws.readyState !== WebSocket.OPEN) return;
      conn.ws.send(JSON.stringify(ok
        ? { type: "peer_rpc_result", id, ok: true, result: value }
        : { type: "peer_rpc_result", id, ok: false, error: String(value), ...(code ? { code } : {}) }));
    };
    if (!id || id.length > 128 || !EXECUTION_RELAY_METHODS.has(method)) {
      reply(false, "invalid execution relay request");
      return;
    }
    if (conn.peerPending.has(id)) {
      reply(false, "duplicate execution relay request");
      return;
    }
    if (conn.peerPending.size >= EXECUTION_RELAY_MAX_IN_FLIGHT) {
      reply(false, "too many execution relay requests");
      return;
    }
    const authorized = this.executionRelayVerifier?.authorize({
      owner: conn.username,
      runtimeDevice: conn.device,
      executionDevice: target,
      workspaceId,
      token,
      method,
    }) === true;
    if (!authorized) {
      reply(false, "execution relay credential is invalid, expired, or outside this placement");
      return;
    }
    const targetConn = this.conns.get(conn.username)?.get(target);
    if (!targetConn) {
      reply(false, `execution device ${target} is offline`, "transport_unavailable");
      return;
    }
    conn.peerPending.add(id);
    try {
      const forwardedArgs = method === "codex_exec_open"
        ? { ...args, workspace_id: workspaceId }
        : args;
      const result = await this.rpcOnConn(
        targetConn,
        method,
        forwardedArgs,
        this.opts.rpcTimeoutMs ?? RPC_TIMEOUT_MS,
      );
      reply(true, result);
    } catch (error) {
      reply(false, error instanceof Error ? error.message : String(error),
        error && typeof error === "object" && "code" in error
          && ["runner_offline", "runner_gone", "runner_timeout"].includes(String(error.code))
          ? "transport_unavailable" : undefined);
    } finally {
      conn.peerPending.delete(id);
    }
  }

  private handleSessionRecoveryScope(conn: RunnerConn, msg: Record<string, unknown>): void {
    const id = typeof msg.id === "string" ? msg.id : "";
    const source = typeof msg.provider === "string" ? msg.provider : "";
    const sessionId = typeof msg.sessionId === "string" ? msg.sessionId.trim() : "";
    const reply = (ok: boolean, value: unknown, code?: "transport_unavailable"): void => {
      if (conn.ws.readyState !== WebSocket.OPEN) return;
      conn.ws.send(JSON.stringify(ok
        ? { type: "session_recovery_scope_result", id, ok: true, result: value }
        : { type: "session_recovery_scope_result", id, ok: false, error: String(value), ...(code ? { code } : {}) }));
    };
    if (
      !id || id.length > 128
      || (source !== "claude" && source !== "codex" && source !== "omp")
      || !sessionId || sessionId.length > 200
    ) {
      reply(false, "invalid managed session recovery request");
      return;
    }
    if (!this.sessionRecoveryIssuer) {
      reply(false, "managed recovery service is not ready", "transport_unavailable");
      return;
    }
    try {
      const scope = this.sessionRecoveryIssuer.issue({
        owner: conn.username,
        runtimeDevice: conn.device,
        source,
        sessionId,
      });
      if (!scope) {
        reply(false, "managed session recovery scope is unavailable or expired");
        return;
      }
      reply(true, scope);
    } catch (error) {
      reply(false, error instanceof Error ? error.message : String(error),
        error && typeof error === "object" && "code" in error
          && ["runner_offline", "runner_gone", "runner_timeout"].includes(String(error.code))
          ? "transport_unavailable" : undefined);
    }
  }
}

function localBridgeClientMetadata(msg: Readonly<Record<string, unknown>>): {
  clientId?: string;
  clientPid?: number;
} {
  const clientId = typeof msg.client_id === "string" && /^[a-zA-Z0-9_-]{1,32}$/.test(msg.client_id)
    ? msg.client_id
    : undefined;
  const clientPid = typeof msg.client_pid === "number"
    && Number.isSafeInteger(msg.client_pid)
    && msg.client_pid > 0
    && msg.client_pid <= 2_147_483_647
    ? msg.client_pid
    : undefined;
  return {
    ...(clientId ? { clientId } : {}),
    ...(clientPid ? { clientPid } : {}),
  };
}

function diagnosticString(value: string): string {
  const bounded = value.length > 96 ? `${value.slice(0, 93)}...` : value;
  return JSON.stringify(bounded);
}

function shortDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}


type ParsedRunnerInventory = { inventory?: RunnerInventory; dropped: string[] };

/**
 * Validate a device report one segment at a time. `schema` and `execution` are
 * the core every consumer reads; without them there is no inventory. Any other
 * segment, and each backend entry, is dropped on its own with a named reason,
 * so one malformed or newer field cannot take a device's backends away.
 */
function runnerInventoryFrom(value: unknown): ParsedRunnerInventory {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { dropped: ["inventory"] };
  const row = value as Record<string, unknown>;
  if (row.schema !== RUNNER_INVENTORY_SCHEMA) return { dropped: ["schema"] };
  const execution = inventoryExecutionFrom(row.execution);
  if (!execution) return { dropped: ["execution"] };
  const dropped: string[] = [];
  const segment = <T>(name: string, read: (raw: unknown) => T | undefined): T | undefined => {
    if (row[name] === undefined) return undefined;
    const parsed = read(row[name]);
    if (parsed === undefined) dropped.push(name);
    return parsed;
  };
  const agentBackends: RunnerInventory["agent_backends"] = [];
  if (!Array.isArray(row.agent_backends)) dropped.push("agent_backends");
  else {
    // Room for kinds a newer Runner may add, without unbounded work.
    row.agent_backends.slice(0, 16).forEach((item, index) => {
      const backend = inventoryBackendFrom(item);
      if (!backend || agentBackends.some((seen) => seen.kind === backend.kind)) dropped.push(`agent_backends[${index}]`);
      else agentBackends.push(backend);
    });
    if (row.agent_backends.length > 16) dropped.push("agent_backends[16+]");
  }
  const sessionRoster = segment("session_roster", (raw) => typeof raw === "boolean" ? raw : undefined);
  const sessionOperations = segment("session_operations", (raw) => isRecord(raw)
    && raw.protocol === SESSION_OPERATION_PROTOCOL ? { protocol: SESSION_OPERATION_PROTOCOL } : undefined);
  const readOnly = segment("read_only", (raw) => raw === true ? true as const : undefined);
  const capabilities = segment("capabilities", publicCapabilityAdvertisement);
  const ticketOptions = segment("ticket_options", inventoryTicketOptionsFrom);
  const workspaceDevelopment = segment("workspace_development", (raw): RunnerInventory["workspace_development"] => {
    if (!isRecord(raw)) return undefined;
    const reason = raw.reason;
    if (raw.protocol !== WORKSPACE_DEVELOPMENT_PROTOCOL || typeof raw.available !== "boolean"
      || raw.max_bundle_bytes !== WORKSPACE_DEVELOPMENT_LIMITS.bundleBytes
      || raw.max_artifact_chunk_bytes !== WORKSPACE_DEVELOPMENT_LIMITS.artifactChunkBytes
      || (reason !== undefined && reason !== "disabled" && reason !== "machine_ops_disabled"
        && reason !== "unsupported_platform" && reason !== "git_unavailable" && reason !== "timeout_unavailable")
      || (raw.available && reason !== undefined)) return undefined;
    return {
      protocol: WORKSPACE_DEVELOPMENT_PROTOCOL, available: raw.available,
      ...(reason ? { reason } : {}),
      max_bundle_bytes: WORKSPACE_DEVELOPMENT_LIMITS.bundleBytes,
      max_artifact_chunk_bytes: WORKSPACE_DEVELOPMENT_LIMITS.artifactChunkBytes,
    };
  });
  const workspaceJobs = segment("workspace_jobs", (raw): RunnerInventory["workspace_jobs"] => isRecord(raw)
    && raw.protocol === "workspace-jobs/v1" && raw.concurrency === 1 && raw.max_log_chunk_bytes === 65536
    ? { protocol: "workspace-jobs/v1", concurrency: 1, max_log_chunk_bytes: 65536 } : undefined);
  const meetingTranscription = segment("meeting_transcription_jobs", readMeetingTranscriptionAdvertisement);
  const knowledgeIndexJobs = segment("knowledge_index_jobs", (raw): RunnerInventory["knowledge_index_jobs"] => isRecord(raw)
    && raw.protocol === "knowledge-index-jobs/v1" && raw.concurrency === 1 && raw.max_chunk_bytes === 1024 * 1024
    ? { protocol: "knowledge-index-jobs/v1", concurrency: 1, max_chunk_bytes: 1024 * 1024 } : undefined);
  const dsh = segment("dsh", (raw): RunnerInventory["dsh"] => {
    if (!isRecord(raw) || typeof raw.available !== "boolean") return undefined;
    const port = raw.port === undefined ? undefined : Number(raw.port);
    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65_535)) return undefined;
    if (raw.available && port === undefined) return undefined;
    return { available: raw.available, ...(port !== undefined ? { port } : {}) };
  });
  const localMcp = segment("local_mcp", (raw): RunnerInventory["local_mcp"] => {
    if (!isRecord(raw) || typeof raw.available !== "boolean" || raw.protocol !== "runner-local-mcp/v1"
      || !Array.isArray(raw.clients)
      || raw.clients.some((client) => typeof client !== "string" || !(RUNNER_AGENT_BACKENDS as readonly string[]).includes(client))) {
      return undefined;
    }
    return {
      available: raw.available,
      protocol: "runner-local-mcp/v1",
      clients: [...new Set(raw.clients)] as NonNullable<RunnerInventory["local_mcp"]>["clients"],
    };
  });
  const modelEgress = segment("model_egress", (raw): RunnerInventory["model_egress"] => {
    if (!isRecord(raw) || typeof raw.available !== "boolean" || raw.protocol !== "model-egress/v1"
      || !Array.isArray(raw.providers) || raw.providers.length > 4
      || raw.providers.some((provider) => provider !== "anthropic" && provider !== "openai")) return undefined;
    return {
      available: raw.available,
      protocol: "model-egress/v1",
      providers: [...new Set(raw.providers as Array<"anthropic" | "openai">)],
    };
  });
  const guiAutomation = segment("gui_automation", (raw): RunnerInventory["gui_automation"] => isRecord(raw)
    && raw.available === true && raw.protocol === "runner-macos-gui/v1" && raw.consent_ttl_seconds === 900
    && execution.platform === "darwin"
    ? { available: true, protocol: "runner-macos-gui/v1", consent_ttl_seconds: 900 } : undefined);
  return { dropped, inventory: {
    schema: RUNNER_INVENTORY_SCHEMA,
    ...(capabilities ? { capabilities } : {}),
    ...(sessionRoster !== undefined ? { session_roster: sessionRoster } : {}),
    ...(sessionOperations ? { session_operations: sessionOperations } : {}),
    ...(readOnly ? { read_only: readOnly } : {}),
    agent_backends: agentBackends,
    execution,
    ...(isRecord(row.file_transfer) && row.file_transfer.protocol === "workspace-file-transfer/v1"
      && execution.workspace_files ? { file_transfer: { protocol: "workspace-file-transfer/v1" as const } } : {}),
    ...(knowledgeIndexJobs ? { knowledge_index_jobs: knowledgeIndexJobs } : {}),
    ...(meetingTranscription ? { meeting_transcription_jobs: meetingTranscription } : {}),
    ...(workspaceJobs ? { workspace_jobs: workspaceJobs } : {}),
    ...(workspaceDevelopment ? { workspace_development: workspaceDevelopment } : {}),
    ...(ticketOptions ? { ticket_options: ticketOptions } : {}),
    ...(dsh ? { dsh } : {}),
    ...(localMcp ? { local_mcp: localMcp } : {}),
    ...(guiAutomation ? { gui_automation: guiAutomation } : {}),
    ...(modelEgress ? { model_egress: modelEgress } : {}),
  } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function inventoryExecutionFrom(raw: unknown): RunnerInventory["execution"] | undefined {
  if (!isRecord(raw)) return undefined;
  const platform = typeof raw.platform === "string" ? raw.platform : "";
  const arch = typeof raw.arch === "string" ? raw.arch : "";
  const workspaceCount = Number(raw.workspace_count);
  if (
    !platform || platform.length > 32 || !arch || arch.length > 32
    || typeof raw.shell !== "boolean"
    || typeof raw.workspace_files !== "boolean"
    || (raw.codex_exec_server !== undefined && typeof raw.codex_exec_server !== "boolean")
    || (raw.read_only_scope !== undefined && typeof raw.read_only_scope !== "boolean")
    || !Number.isInteger(workspaceCount)
    || workspaceCount < 0
    || workspaceCount > 10_000
  ) return undefined;
  return {
    platform,
    arch,
    shell: raw.shell,
    workspace_files: raw.workspace_files,
    workspace_count: workspaceCount,
    codex_exec_server: raw.codex_exec_server === true,
    // Only a Runner that says so may host a Feishu document assistant.
    ...(raw.read_only_scope === true ? { read_only_scope: true as const } : {}),
  };
}

function inventoryBackendFrom(item: unknown): RunnerInventory["agent_backends"][number] | undefined {
  if (!isRecord(item)) return undefined;
  const kind = typeof item.kind === "string" ? item.kind : "";
  if (!(RUNNER_AGENT_BACKENDS as readonly string[]).includes(kind)
    || typeof item.available !== "boolean"
    || (item.split_execution !== undefined && typeof item.split_execution !== "boolean")
    || (item.split_execution_reason !== undefined && item.split_execution_reason !== "local_tools_unfilterable")
    || (item.version !== undefined && (typeof item.version !== "string" || item.version.length > 120))
    || (item.reason !== undefined && item.reason !== "command_unavailable" && item.reason !== "probe_failed"
      && item.reason !== "authentication_unavailable")) return undefined;
  const diagnostic = agentDiagnosticCode(item.diagnostic_code);
  const diagnosticDetail = publicAgentDiagnosticDetail(item.diagnostic_detail);
  return {
    kind: kind as RunnerInventory["agent_backends"][number]["kind"],
    available: item.available,
    split_execution: item.split_execution === true,
    ...(item.split_execution_reason ? { split_execution_reason: "local_tools_unfilterable" as const } : {}),
    ...(item.version ? { version: item.version as string } : {}),
    ...(diagnostic ? { diagnostic_code: diagnostic } : {}),
    ...(diagnosticDetail ? { diagnostic_detail: diagnosticDetail } : {}),
    ...(item.reason ? { reason: item.reason as "command_unavailable" | "probe_failed" | "authentication_unavailable" } : {}),
  };
}

function inventoryTicketOptionsFrom(raw: unknown): RunnerInventory["ticket_options"] | undefined {
  if (!isRecord(raw)) return undefined;
  const options = raw as unknown as NonNullable<RunnerInventory["ticket_options"]>;
  if (options.protocol !== "ticket-options/v1" || !Array.isArray(options.codex_accounts)
    || !Array.isArray(options.workspaces) || options.codex_accounts.length > 27 || options.workspaces.length > 100) return undefined;
  const valid = (rows: Array<{ id: string; label: string }>, id: RegExp) => rows.every((item) => item
    && typeof item.id === "string" && id.test(item.id) && typeof item.label === "string" && item.label.length <= 120)
    && new Set(rows.map((item) => item.id)).size === rows.length;
  if (!valid(options.codex_accounts, /^(?:@default|[A-Za-z0-9_-]{1,32})$/) || !valid(options.workspaces, /^ws_[0-9a-f]{24}$/)) return undefined;
  // Validate the additive provider segment independently for old/malformed peers.
  const claudeAccounts = Array.isArray(options.claude_accounts) && options.claude_accounts.length <= 1
    && valid(options.claude_accounts, /^@default$/) ? options.claude_accounts : undefined;
  return { protocol: "ticket-options/v1",
    codex_accounts: options.codex_accounts.map(({ id, label, emailLabel, quota, models }) => ({
      id, label,
      ...(publicModelChoices(models) ? { models: publicModelChoices(models) } : {}),
      ...(publicCodexEmailLabel(emailLabel) ? { emailLabel: publicCodexEmailLabel(emailLabel) } : {}),
      ...(publicCodexQuota(quota) ? { quota: publicCodexQuota(quota) } : {}),
    })),
    ...(claudeAccounts ? { claude_accounts: claudeAccounts.map(({ id, quota }) => ({
      id, label: "Claude",
      ...(publicCodexQuota(quota) ? { quota: publicCodexQuota(quota) } : {}),
    })) } : {}),
    workspaces: options.workspaces.map(({ id, label }) => ({ id, label })) };
}

/**
 * `runner_offline` = the named device (or any device of the owner) is not
 * connected, so nothing was sent; `runner_gone` / `runner_timeout` = it was
 * sent and the answer is unknown. Callers treat the two classes differently
 * (dispatch.ts), so they must never share a code.
 */
function runnerTransportError(code: "runner_timeout" | "runner_gone" | "runner_offline", message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

// ── Multi-device merges ──

interface DeviceResult {
  device: string;
  result: unknown;
  inventory?: RunnerInventory;
}

function mergeListResults(parts: DeviceResult[], args: Record<string, unknown>, defaultLimit = 20): unknown {
  // 500 matches the scan layer's LIST_LIMIT_MAX (dashboard tree pulls the full roster).
  const limit = Math.max(1, Math.min(500, Number(args.limit ?? defaultLimit) || defaultLimit));
  const sessions: Array<Record<string, unknown>> = [];
  let total = 0;
  let hasMore = false;
  let historySupported = true;
  for (const { device, result } of parts) {
    const r = result as { has_more?: boolean; total_found?: number; sessions?: Array<Record<string, unknown>> };
    total += r.total_found ?? 0;
    hasMore ||= r.has_more === true;
    historySupported &&= typeof r.has_more === "boolean";
    for (const s of r.sessions ?? []) sessions.push({ ...s, device });
  }
  sessions.sort((a, b) => (String(b.last_activity ?? "") < String(a.last_activity ?? "") ? -1 : 1));
  if (typeof args.cursor === "string") sessions.sort((a, b) => sessionListCursor(a) < sessionListCursor(b) ? -1 : sessionListCursor(a) > sessionListCursor(b) ? 1 : 0);
  const primaryWindow = args.primary_window === true && typeof args.cursor !== "string";
  const selected = primaryWindow ? selectSessionWindow(sessions, limit, subagentParentId) : sessions.slice(0, limit);
  return {
    devices: parts.map((p) => p.device),
    runner_inventory: parts.flatMap((part) => part.inventory
      ? [{ device: part.device, online: true, inventory: part.inventory }]
      : []),
    total_found: total,
    ...(typeof args.cursor === "string" ? { has_more: hasMore || sessions.length > limit, history_supported: historySupported } : {}),
    ...(primaryWindow ? { primary_window: parts.every((part) => (part.result as Record<string, unknown>).primary_window === true),
      index_pending: parts.some((part) => (part.result as Record<string, unknown>).index_pending === true) } : {}),
    returned: selected.length,
    sessions: selected,
    note: total === 0 ? "No Claude/Codex sessions found on any online device." : undefined,
  };
}

/**
 * One page of a complete multi-device search. Every device receives the same
 * cursor (positions are device-independent); the shared merge keeps only hits
 * every device has searched past, so paging never skips a device's range. A
 * device that failed or predates paging is named in `incomplete_sources`.
 */
function mergeSearchResults(parts: Array<{ device: string; result?: unknown }>, args: Record<string, unknown>): unknown {
  const limit = Math.max(1, Math.min(50, Number(args.limit ?? 10) || 10));
  const page = mergeSearchPages(parts.map(({ device, result }) => ({
    label: device,
    ...(result === undefined ? {} : { page: stampSearchDevice(result, device) }),
  })), limit, typeof args.cursor === "string" && args.cursor !== "");
  return {
    devices: parts.filter((part) => part.result !== undefined).map((part) => part.device),
    ...page,
    returned: page.results.length,
  };
}

function stampSearchDevice(result: unknown, device: string): unknown {
  if (!isRecord(result) || !Array.isArray(result.results)) return result;
  return {
    ...result,
    results: result.results.map((item) => isRecord(item)
      ? { ...item, session: { ...(isRecord(item.session) ? item.session : {}), device } }
      : item),
  };
}

function httpCompatibleTunnel(stream: Duplex): Duplex {
  let timer: NodeJS.Timeout | undefined;
  let timeoutMs = 0;
  const arm = (): void => {
    clearTimeout(timer);
    timer = timeoutMs > 0
      ? setTimeout(() => stream.emit("timeout"), timeoutMs)
      : undefined;
    timer?.unref();
  };
  const socket = stream as Duplex & {
    setTimeout(ms: number, callback?: () => void): Duplex;
    setNoDelay(enable?: boolean): Duplex;
    setKeepAlive(enable?: boolean, initialDelay?: number): Duplex;
    ref(): Duplex;
    unref(): Duplex;
  };
  socket.setTimeout = (ms, callback) => {
    timeoutMs = Math.max(0, ms);
    if (callback) stream.once("timeout", callback);
    arm();
    return stream;
  };
  socket.setNoDelay = () => stream;
  socket.setKeepAlive = () => stream;
  socket.ref = () => stream;
  socket.unref = () => stream;
  stream.on("data", arm);
  stream.on("drain", arm);
  stream.once("close", () => {
    clearTimeout(timer);
    timer = undefined;
  });
  return stream;
}

/** The Runner-resolved calling session of one local bridge frame; anything malformed is simply absent. */
export function localBridgeCaller(value: unknown): { source: string; sessionId: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const source = row.source;
  const sessionId = row.session_id;
  if ((source !== "claude" && source !== "codex" && source !== "omp") || typeof sessionId !== "string"
    || !/^[A-Za-z0-9._:-]{1,200}$/.test(sessionId)) return undefined;
  return { source, sessionId };
}
