/**
 * Runner core — transport-free logic so both the real process (index.ts) and
 * tests can drive it: dispatch one gateway RPC against the local scan home.
 */

import {
  listRecentSessions,
  listSelectedSessions,
  LIST_LIMIT_MAX,
  isForegroundTmuxSession,
  sessionListCursor,
  digestRecentSessions,
  readSession,
  searchSessions,
  searchSelectedSessions,
  decodeSessionIds,
  encodeSessionIds,
  exportSessionFile,
  exportPlainFile,
  scanSourceArg,
  type Source as ScanSource,
  type SessionScanRoot,
  type SessionRosterPriority,
} from "@claude-bot/plugin-sessions/scan";
import { createHash } from "node:crypto";
import { resolveOwnerFileLink } from "./owner-file-link.js";
import { placeSessionPath } from "./session-path-placement.js";
import { forkSessionAt, sessionAnchor, type IndexedLog } from "./session-fork.js";
import { sessionInputStage, withSessionInputPerf } from "./session-input-perf.js";
import { notSentRefusalCode, withInputAttempt } from "./input-handoff.js";
import { isAbsolute } from "node:path";
import {
  execSpillDir,
  machineExec,
  machineExecWorkspace,
  machineReadFile,
  machineWriteFile,
  machineListDir,
  machineHostInfo,
  machineAppendSession,
} from "./machine.js";
import { machineStartSession } from "./launch.js";
import { LaunchJournal } from "./launch-journal.js";
import type { RunnerSessionOperations } from "./session-operations.js";
import {
  accessOwnerFiles,
  listWorkspaceEntries,
  readWorkspaceText,
  readWorkspaceBinary,
  replaceWorkspaceText,
  replaceOwnerText,
  workspaceRelativePathProblem,
} from "./workspace-files.js";
import { listSessionWorkspaces, workspaceDisplayPath, withWorkspaceSite } from "./workspaces.js";
import type { WorkspaceJobManager } from "./workspace-jobs.js";
import type { WorkspaceDevelopmentManager } from "./workspace-development.js";
import type { DevelopmentMcpManager } from "./development-mcp.js";
import { WORKSPACE_DEVELOPMENT_METHODS } from "./workspace-development-protocol.js";
import type { WorkspaceTerminalManager } from "./workspace-terminal.js";
import { isAgentProvider, type AgentProvider, type AgentRuntimeRegistry } from "./agent-runtime.js";
import type { AgentInteractionBroker } from "./agent-interactions.js";
import type { AgentControlPlane } from "./agent-control-plane.js";
import type { CodexSessionDiscoveryCandidate } from "./codex-terminal.js";
import type { ClaudeTranslationPort } from "./claude-translation.js";
import type { CodexExecRelayCoordinator, CodexExecServerManager } from "./codex-exec-relay.js";
import type { CodexAgentRelayManager } from "./codex-agent-relay.js";
import { SessionAttachmentStore } from "./session-attachments.js";
import { sessionAttachmentWorkspace } from "./session-attachment-target.js";
import type { CodexAccountRouter } from "./codex-account-routing.js";
import { MEETING_TRANSCRIPTION_METHODS, type MeetingTranscriptionAction } from "./meeting-transcription-protocol.js";
import type { MeetingTranscriptionManager } from "./meeting-transcription.js";
import type { KnowledgeIndexManager } from "./knowledge-index.js";
import { MACHINE_LIMITS } from "./limits.js";
import { authorizedSessionCatalogSelection } from "./session-catalog.js";
import type { MacGuiAutomationController } from "./macos-gui-automation.js";
import type { SessionObservationIndex } from "./session-observation.js";

import { WorkspaceFileTransferStore } from "./file-transfer.js";

const DEFAULT_SESSION_ATTACHMENTS = new SessionAttachmentStore();
const DEFAULT_FILE_TRANSFERS = new WorkspaceFileTransferStore();

export interface RpcRequest {
  id: string;
  method: string;
  args: Record<string, unknown>;
}

export interface RpcOptions {
  capabilities?: Pick<import("./capability-manager.js").RunnerCapabilityManager, "call">;
  /** Shared device observer, never a caller-controlled selector. */
  sessionObservation?: { ordinary: SessionObservationIndex; split: SessionObservationIndex };
  sessionOperations?: RunnerSessionOperations;
  /** Internal durable dispatch correlation, never read from RPC args. */
  sessionInputOperationId?: string;
  onSessionCompletion?: (result: Record<string, unknown>) => Promise<void>;
  onSessionInput?: (input: import("./gateway-protocol.js").SessionInputReceipt) => Promise<void>;
  /** Local connection identity, never taken from a gateway RPC argument. */
  gatewaySite?: string;
  /**
   * Whether this device accepts machine operations (exec / write). Off means
   * the Runner stays a read-only investigation endpoint — the operator's
   * kill switch, independent of what the bot side would allow.
   */
  allowMachineOps?: boolean;
  /**
   * Expose only this OS account's shell, files and registered workspaces.
   * Session scanners, agent controls and private relays are refused locally.
   */
  executionOnly?: boolean;
  /** Called before each machine op so the runner logs what it was asked to do. */
  onMachineOp?: (method: string, summary: string) => void;
  /** Hook-derived process evidence and explicit takeover control. */
  agentRuntime?: AgentRuntimeRegistry;
  /** Single-use provider questions and approval requests. */
  agentInteractions?: AgentInteractionBroker;
  /** Attachment/lease/turn router for provider-native and external CLI control. */
  agentControlPlane?: AgentControlPlane;
  /** Process-local owner of opaque tmux terminal leases. */
  workspaceTerminals?: WorkspaceTerminalManager;
  workspaceJobs?: WorkspaceJobManager;
  workspaceDevelopment?: WorkspaceDevelopmentManager;
  developmentMcp?: DevelopmentMcpManager;
  /** Execution-device owner of local Codex exec-server processes. */
  codexExecServers?: CodexExecServerManager;
  /** Runtime-device opener for authenticated remote Codex environments. */
  codexExecRelay?: CodexExecRelayCoordinator;
  /** Bot-driven tunnels into this device's isolated Codex app-server (dev tickets). */
  codexAgentRelay?: CodexAgentRelayManager;
  /** Device-local session roots; never accepted from an RPC argument. */
  sessionScanRoot?: SessionScanRoot;
  /** Trusted local discovery; never supplied through the RPC arguments. */
  refreshSessionScanRoot?: () => Promise<SessionScanRoot>;
  /** Fixed isolated Codex root for trusted dev-ticket transcript reads. */
  codexAgentSessionScanRoot?: SessionScanRoot;
  /** Fixed isolated Codex root for Host-selected Sessions+ split transcripts. */
  sessionPlusSessionScanRoot?: SessionScanRoot;
  /** Device-local Codex account router; browser and RPC arguments cannot select a root. */
  codexAccountRouter?: Pick<CodexAccountRouter, "selectForNewSession" | "selectForFallback" | "roots">;
  /** An explicit active pool also governs legacy/omitted default selections. */
  requireCodexAccountSelection?: boolean;
  /** Device-private Claude translation and transcript decoration service. */
  claudeTranslations?: ClaudeTranslationPort;
  /** Multipart `/tmp` upload state; injectable so embedded runners stay isolated. */
  sessionAttachments?: SessionAttachmentStore;
  fileTransfers?: WorkspaceFileTransferStore;
  /** Fixed-root durable knowledge index manager; absent means this Runner does not advertise or accept the private protocol. */
  meetingTranscription?: Pick<MeetingTranscriptionManager, "call">;
  knowledgeIndex?: Pick<KnowledgeIndexManager, "rpcStart" | "rpcStatus" | "rpcCancel" | "rpcRead">;
  /** macOS console-session GUI controller; absent on every other platform/session. */
  guiAutomation?: Pick<
    MacGuiAutomationController,
    "requestControl" | "captureScreen" | "click" | "scroll" | "drag" | "typeText" | "keyPress" | "releaseControl"
  >;
}

export interface RpcResponse {
  type: "rpc_result";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  /** A closed set of pre-dispatch session refusals, never transport errors. */
  code?: string;
}

export type RpcHandler = (home: string, req: RpcRequest, opts: RpcOptions) => Promise<RpcResponse>;

type SharedRpcResponse = Omit<RpcResponse, "id">;

interface NormalizedListRecentSessionsArgs extends Record<string, unknown> {
  source: ScanSource | "all";
  limit: number;
  since_hours?: number;
  cursor?: string;
  primary_window?: true;
  /** Canonical `source:id` selector of exact sessions (see decodeSessionIds). */
  ids?: string;
}

/** Canonicalise the scanner selectors, including the explicit history cursor. */
function normalizedListRecentSessionsArgs(args: Readonly<Record<string, unknown>>): NormalizedListRecentSessionsArgs {
  const source = scanSourceArg(args.source);
  const limit = Math.max(1, Math.min(LIST_LIMIT_MAX, Number(args.limit ?? 20) || 20));
  const rawSince = args.since_hours != null ? Number(args.since_hours) : undefined;
  const ids = encodeSessionIds(decodeSessionIds(args.ids));
  return {
    source,
    limit,
    ...(typeof args.cursor === "string" ? { cursor: args.cursor } : {}),
    ...(args.primary_window === true ? { primary_window: true as const } : {}),
    ...(rawSince !== undefined && Number.isFinite(rawSince) ? { since_hours: rawSince } : {}),
    ...(ids ? { ids } : {}),
  };
}

function listRecentSessionsFlightKey(args: NormalizedListRecentSessionsArgs): string {
  return JSON.stringify([args.source, args.limit, args.since_hours ?? null, args.cursor ?? null, args.primary_window === true,
    args.ids ?? null]);
}

/**
 * Process-local RPC coordinator for the Runner transport.
 *
 * The Bot has already performed a separate capability Gate for every RPC that
 * reaches this object. Sharing starts only here, around the device-local pure
 * read, so it cannot substitute one caller's authority for another's. A flight
 * has no completed-value lifetime: after result or error it is removed, and a
 * later read observes the filesystem and hook/runtime evidence again.
 *
 * One coordinator is constructed with one Runner's runtime/control-plane
 * objects. Keeping the map on that instance, rather than at module scope, is
 * what prevents tests, embedded runners, or future hot-swapped runtimes from
 * joining reads across different observation authorities.
 */
export class RunnerRpcDispatcher {
  private readonly listRecentSessionsFlights = new Map<string, Promise<SharedRpcResponse>>();

  constructor(
    private readonly home: string,
    private readonly opts: RpcOptions = {},
    private readonly handler: RpcHandler = (scanHome, request, options) => handleRpc(scanHome, request, options),
  ) {}

  async handle(req: RpcRequest): Promise<RpcResponse> {
    if (req.method !== "list_recent_sessions") {
      return await this.handler(this.home, req, this.opts);
    }

    const args = normalizedListRecentSessionsArgs(req.args);
    const key = listRecentSessionsFlightKey(args);
    let flight = this.listRecentSessionsFlights.get(key);
    if (!flight) {
      const canonicalRequest: RpcRequest = { ...req, args };
      let started!: Promise<SharedRpcResponse>;
      started = Promise.resolve()
        .then(async () => {
          const { id: _requestId, ...shared } = await this.handler(this.home, canonicalRequest, this.opts);
          return shared;
        })
        .finally(() => {
          // A future implementation may replace a flight after invalidation.
          // The older promise must never delete that newer generation.
          if (this.listRecentSessionsFlights.get(key) === started) {
            this.listRecentSessionsFlights.delete(key);
          }
        });
      flight = started;
      this.listRecentSessionsFlights.set(key, flight);
    }

    const shared = await flight;
    return { ...shared, id: req.id };
  }
}

/**
 * Machine ops are gated separately from the read-only investigation ops.
 *
 * The workspace-files trio is in here, next to `read_file`/`write_file`, because
 * it touches PROJECT content — the same class of thing, merely bounded to a
 * directory the device's owner registered. `RUNNER_ALLOW_MACHINE_OPS=0` is the
 * operator's statement that this box answers session-investigation questions and
 * nothing else, and neither browsing nor editing a project is a
 * session-investigation question. (`list_session_workspaces` stays outside: it
 * enumerates opaque ids and labels and opens nothing.)
 */
const WORKSPACE_JOB_METHODS = new Set(["workspace_job_start", "workspace_job_status", "workspace_job_cancel", "workspace_job_read", "workspace_job_artifact"]);
const KNOWLEDGE_INDEX_METHODS = new Set([
  "knowledge_index_start",
  "knowledge_index_status",
  "knowledge_index_cancel",
  "knowledge_index_read",
]);
const MACHINE_METHODS = new Set([
  ...WORKSPACE_DEVELOPMENT_METHODS,
  "exec",
  "exec_workspace",
  "read_file",
  "write_file",
  "list_dir",
  "host_info",
  "append_session",
  "upload_session_file",
  "start_session",
  "fork_session",
  "list_workspace_entries",
  "access_owner_files",
  "replace_owner_text",
  "read_workspace_text",
  "read_workspace_binary",
  "download_workspace_file",
  "workspace_file_transfer",
  "replace_workspace_text",
  "respond_agent_interaction",
  "workspace_terminal",
  "codex_exec_open",
  "codex_exec_read",
  "codex_exec_write",
  "codex_exec_reconnect",
  "codex_exec_close",
  "codex_agent_open",
  "codex_agent_read",
  "codex_agent_write",
  "codex_agent_close",
  ...KNOWLEDGE_INDEX_METHODS,
  ...WORKSPACE_JOB_METHODS,
  "gui_request_control",
  "gui_capture_screen",
  "gui_click",
  "gui_scroll",
  "gui_drag",
  "gui_type_text",
  "gui_key_press",
  "gui_release_control",
]);
/** Ops that change state; blocked outright when machine ops are disabled. */
const MACHINE_WRITE_METHODS = new Set([
  "exec",
  "exec_workspace",
  "write_file",
  "workspace_file_transfer",
  "append_session",
  "upload_session_file",
  "start_session",
  "fork_session",
  "replace_workspace_text",
  "respond_agent_interaction",
  "workspace_terminal",
  "codex_exec_open",
  "codex_exec_write",
  "codex_exec_reconnect",
  "codex_exec_close",
  "codex_agent_open",
  "codex_agent_write",
  "codex_agent_close",
  "knowledge_index_start",
  "knowledge_index_cancel",
  "gui_request_control",
  "gui_click",
  "gui_scroll",
  "gui_drag",
  "gui_type_text",
  "gui_key_press",
  "gui_release_control",
]);

/** Base RPC surface; a composed knowledge manager adds its four fixed methods. */
const EXECUTION_ONLY_METHODS = new Set([
  "upload_session_file",
  "exec",
  "exec_workspace",
  "read_file",
  "write_file",
  "list_dir",
  "host_info",
  "list_session_workspaces",
  "list_workspace_entries",
  "access_owner_files",
  "replace_owner_text",
  "read_workspace_text",
  "read_workspace_binary",
  "download_workspace_file",
  "workspace_file_transfer",
  "replace_workspace_text",
]);

/** Matches the View's full roster so workspace associations do not lose rows. */
const SESSION_WORKSPACE_ROSTER_LIMIT = 200;

export async function handleRpc(home: string, req: RpcRequest, opts: RpcOptions = {}): Promise<RpcResponse> {
  const run = () => withWorkspaceSite(opts.gatewaySite ?? "primary", () => handleScopedRpc(home, req, opts));
  // The outer durable call only acknowledges registration. Time its actual
  // asynchronous dispatch, retaining the durable operation's correlation.
  return req.method === "append_session" && req.args.operation_id === undefined
    ? await withSessionInputPerf(req.id, opts.sessionInputOperationId, run)
    : await run();
}
async function handleScopedRpc(home: string, req: RpcRequest, opts: RpcOptions): Promise<RpcResponse> {
  try {
    if (req.method === "invoke_runner_capability") {
      if (!opts.allowMachineOps || !opts.capabilities) throw new Error("Runner capabilities unavailable on this site");
      opts.onMachineOp?.(req.method, String(req.args.provider));
      return { type: "rpc_result", id: req.id, ok: true, result: await opts.capabilities.call(req.args) };
    }
    if ((MEETING_TRANSCRIPTION_METHODS as readonly string[]).includes(req.method)) {
      if (!opts.allowMachineOps || !opts.meetingTranscription) throw new Error("meeting transcription is unavailable on this Runner/site");
      opts.onMachineOp?.(req.method, `job ${String(req.args.job_key ?? "").slice(0, 16)}`);
      const result = await opts.meetingTranscription.call(req.method.slice("meeting_transcription_".length) as MeetingTranscriptionAction, req.args);
      return { type: "rpc_result", id: req.id, ok: true, result };
    }
    const enabledKnowledgeMethod = opts.allowMachineOps === true && opts.knowledgeIndex
      && KNOWLEDGE_INDEX_METHODS.has(req.method);
    const enabledWorkspaceJob = opts.allowMachineOps === true && opts.workspaceJobs && WORKSPACE_JOB_METHODS.has(req.method);
    const developmentMethod = (WORKSPACE_DEVELOPMENT_METHODS as readonly string[]).includes(req.method);
    const enabledDevelopment = opts.allowMachineOps === true && opts.workspaceDevelopment && developmentMethod;
    if (opts.executionOnly && !EXECUTION_ONLY_METHODS.has(req.method) && !enabledKnowledgeMethod && !enabledWorkspaceJob && !enabledDevelopment) {
      throw new Error("该设备仅暴露执行环境，不提供 session、Agent、Codex relay、DSH 或未启用的知识索引操作");
    }
    const sessionScanRoot = (opts.executionOnly ? undefined : await sessionInputStage("refresh_roots", async () => await opts.refreshSessionScanRoot?.())) ?? opts.sessionScanRoot ?? home;
    if (MACHINE_METHODS.has(req.method)) {
      if (!opts.allowMachineOps) {
        throw new Error("该设备未开启机器操作功能 (RUNNER_ALLOW_MACHINE_OPS=0)");
      }
      if (req.method !== "workspace_file_transfer" || ["open_read", "open_write", "commit", "close"].includes(String(req.args.action))) {
        opts.onMachineOp?.(req.method, req.method === "workspace_file_transfer"
          ? String(req.args.action) + " workspace=" + String(req.args.workspace_id) + " stream=" + String(req.args.stream_id)
          : summarizeMachineOp(req));
      }
    }

    if (req.args.operation_id !== undefined && ["start_session", "append_session"].includes(req.method)) {
      if (!opts.sessionOperations || !opts.agentControlPlane) throw new Error("durable managed session operations are unavailable");
      if (req.args._octopus_launch_mode) throw new Error("durable operations require managed session control");
      const operationId = String(req.args.operation_id);
      const { operation_id: _operationId, ...args } = req.args;
      const result = await opts.sessionOperations.submit(opts.gatewaySite, operationId, req.method, args, async (complete, input) => {
        const { value: response, handedOff } = await withInputAttempt(() => handleRpc(home, { ...req, args },
          { ...opts, sessionInputOperationId: operationId, onSessionCompletion: complete, onSessionInput: args.input_receipt === true ? input : undefined }));
        // Only a refusal that may follow a transport handoff is unknown; earlier
        // refusals are definite failures the person can simply send again.
        if (!response.ok) return { ok: false, code: response.code ?? (handedOff ? "unknown" : "input_not_sent"), error: response.error };
        return response.result as Record<string, unknown>;
      });
      return { type: "rpc_result", id: req.id, ok: true, result };
    }
    let result: unknown;
    switch (req.method) {
      case "get_session_operation": {
        if (!opts.sessionOperations) throw new Error("durable session operations are unavailable");
        const credential = opts.developmentMcp?.credential(req.args);
        if (credential) await opts.developmentMcp!.renew(opts.gatewaySite, credential);
        result = await opts.sessionOperations.status(opts.gatewaySite, String(req.args.operation_id ?? ""));
        break;
      }
      case "gui_request_control":
        if (!opts.guiAutomation) throw new Error("macOS GUI automation is unavailable on this Runner");
        result = await opts.guiAutomation.requestControl(req.args);
        break;
      case "gui_capture_screen":
        if (!opts.guiAutomation) throw new Error("macOS GUI automation is unavailable on this Runner");
        result = await opts.guiAutomation.captureScreen(req.args);
        break;
      case "gui_click":
        if (!opts.guiAutomation) throw new Error("macOS GUI automation is unavailable on this Runner");
        result = await opts.guiAutomation.click(req.args);
        break;
      case "gui_scroll":
        if (!opts.guiAutomation) throw new Error("macOS GUI automation is unavailable on this Runner");
        result = await opts.guiAutomation.scroll(req.args);
        break;
      case "gui_drag":
        if (!opts.guiAutomation) throw new Error("macOS GUI automation is unavailable on this Runner");
        result = await opts.guiAutomation.drag(req.args);
        break;
      case "gui_type_text":
        if (!opts.guiAutomation) throw new Error("macOS GUI automation is unavailable on this Runner");
        result = await opts.guiAutomation.typeText(req.args);
        break;
      case "gui_key_press":
        if (!opts.guiAutomation) throw new Error("macOS GUI automation is unavailable on this Runner");
        result = await opts.guiAutomation.keyPress(req.args);
        break;
      case "gui_release_control":
        if (!opts.guiAutomation) throw new Error("macOS GUI automation is unavailable on this Runner");
        result = opts.guiAutomation.releaseControl(req.args);
        break;
      case "knowledge_index_start":
        if (!opts.knowledgeIndex) throw new Error("knowledge index jobs are unavailable on this Runner");
        result = await opts.knowledgeIndex.rpcStart(req.args);
        break;
      case "knowledge_index_status":
        if (!opts.knowledgeIndex) throw new Error("knowledge index jobs are unavailable on this Runner");
        result = await opts.knowledgeIndex.rpcStatus(req.args);
        break;
      case "knowledge_index_cancel":
        if (!opts.knowledgeIndex) throw new Error("knowledge index jobs are unavailable on this Runner");
        result = await opts.knowledgeIndex.rpcCancel(req.args);
        break;
      case "knowledge_index_read":
        if (!opts.knowledgeIndex) throw new Error("knowledge index jobs are unavailable on this Runner");
        result = await opts.knowledgeIndex.rpcRead(req.args);
        break;
      case "exec":
        result = await machineExec(req.args, execSpillDir(home));
        break;
      case "exec_workspace":
        result = await machineExecWorkspace(home, req.args);
        break;
      case "read_file":
        result = await machineReadFile(req.args);
        break;
      case "write_file":
        result = await machineWriteFile(req.args);
        break;
      case "list_dir":
        result = await machineListDir(req.args);
        break;
      case "host_info":
        result = await machineHostInfo();
        break;
      case "append_session": {
        // Split Codex starts write into the isolated home. Select that root
        // from durable launch provenance, never from caller-supplied paths or
        // execution credentials; machineAppendSession still checks placement.
        const placement = await sessionInputStage("launch_placement", () => new LaunchJournal(home).sessionPlacement(String(req.args.id ?? "").trim()));
        const appendScanRoot = placement?.source === "codex"
          ? sessionCatalogScanRoot("codex", sessionScanRoot, opts)
          : sessionScanRoot;
        const credential = opts.developmentMcp?.credential(req.args);
        if (req.args._octopus_development_id && !opts.developmentMcp) throw new Error("开发 MCP 不可用");
        const developmentMcpUrl = credential ? await opts.developmentMcp!.renew(opts.gatewaySite, credential) : undefined;
        const release = credential ? opts.developmentMcp!.retain(opts.gatewaySite, credential.developmentId) : undefined;
        try { result = await machineAppendSession(
          home,
          req.args,
          opts.agentRuntime,
          opts.agentInteractions,
          opts.agentControlPlane,
          opts.codexExecRelay,
          appendScanRoot,
          opts.codexAccountRouter,
          opts.gatewaySite,
          opts.onSessionInput,
          developmentMcpUrl,
          credential?.developmentId,
          placement?.source === "codex" ? opts.sessionObservation?.split : opts.sessionObservation?.ordinary,
        ); } finally { release?.(); }
        break;
      }
      case "upload_session_file":
        result = await (opts.sessionAttachments ?? DEFAULT_SESSION_ATTACHMENTS).accept(req.args, opts.gatewaySite ?? "",
          await sessionAttachmentWorkspace(home, req.args, sessionScanRoot, opts.executionOnly));
        break;
      case "start_session": {
        const credential = opts.developmentMcp?.credential(req.args);
        if (req.args._octopus_development_id && !opts.developmentMcp) throw new Error("开发 MCP 不可用");
        const developmentMcpUrl = credential ? await opts.developmentMcp!.renew(opts.gatewaySite, credential) : undefined;
        const release = credential ? opts.developmentMcp!.retain(opts.gatewaySite, credential.developmentId) : undefined;
        try { result = await machineStartSession(home, req.args, {
          gatewaySite: opts.gatewaySite,
          onCompletion: opts.onSessionCompletion,
          onInput: opts.onSessionInput,
          developmentId: credential?.developmentId,
          developmentMcpUrl,
          onManagedSettled: release,
          runtime: opts.agentRuntime,
          controlPlane: opts.agentControlPlane,
          codexExecRelay: opts.codexExecRelay,
          requireCodexAccountSelection: opts.requireCodexAccountSelection,
          ...(typeof sessionScanRoot === "object" && sessionScanRoot.codexHome
            ? { codexHome: sessionScanRoot.codexHome }
            : {}),
          ...(opts.codexAccountRouter
            ? { selectCodexAccount: async (slot?: string) => {
                if (!slot) return opts.codexAccountRouter!.selectForNewSession({ allowUnknown: true });
                const selected = opts.codexAccountRouter!.roots().find((account) => account.slot === slot);
                if (!selected) throw new Error("所选 Codex 账号未在此 Runner 登记");
                return selected;
              } }
            : {}),
          claudeTranslations: opts.claudeTranslations,
        }); } catch (error) { release?.(); throw error; }
        if (!(result as { ok?: boolean }).ok) release?.();
        break;
      }
      case "codex_exec_open":
      case "codex_exec_read":
      case "codex_exec_write":
      case "codex_exec_reconnect":
      case "codex_exec_close":
        if (!opts.codexExecServers) throw new Error("Codex exec-server relay is unavailable on this Runner");
        result = await opts.codexExecServers.execute(req.method, req.args);
        break;
      case "codex_agent_open":
      case "codex_agent_read":
      case "codex_agent_write":
      case "codex_agent_close":
        if (!opts.codexAgentRelay) throw new Error("Codex agent relay is unavailable on this Runner");
        result = await opts.codexAgentRelay.execute(req.method, req.args);
        break;
      case "codex_agent_read_session": {
        if (!opts.codexAgentSessionScanRoot) {
          throw new Error("Codex agent transcript root is unavailable on this Runner");
        }
        // This private protocol intentionally does not forward arbitrary scan
        // coordinates. The bot capability fixes the ticket/session identity;
        // this device fixes the isolated root and the Codex rich projection.
        const transcript = await readObservedSession(opts.codexAgentSessionScanRoot, {
          id: req.args.id,
          max_messages: req.args.max_messages,
          offset: req.args.offset,
          source: "codex",
          rich: true,
        }, opts.sessionObservation?.split);
        result = await withReadAgentRuntime(
          transcript,
          opts.agentRuntime,
          opts.agentInteractions,
          opts.agentControlPlane,
          true,
        );
        break;
      }
      case "session_plus_list_sessions": {
        const selection = await authorizedSessionCatalogSelection(home, req.args);
        const scanRoot = sessionCatalogScanRoot(selection.source, sessionScanRoot, opts);
        result = await withAgentRuntime(
          withDisplayDirectories(
            home,
            await listObservedSessions(scanRoot, { ...req.args, source: selection.source }, opts,
              selection.source === "codex" ? opts.sessionObservation?.split : opts.sessionObservation?.ordinary,
              selection.ids.map((id) => ({
              source: selection.source,
              id,
            }))),
          ),
          opts.agentRuntime,
          opts.agentInteractions,
          opts.agentControlPlane,
          opts.sessionObservation,
        );
        break;
      }
      case "session_plus_search_sessions": {
        const selection = await authorizedSessionCatalogSelection(home, req.args);
        const scanRoot = sessionCatalogScanRoot(selection.source, sessionScanRoot, opts);
        result = await searchSelectedSessions(
          scanRoot,
          { ...req.args, source: selection.source },
          selection.ids.map((id) => ({ source: selection.source, id })),
        );
        break;
      }
      case "session_plus_read_session": {
        const selection = await authorizedSessionCatalogSelection(home, req.args);
        const id = String(req.args.id ?? "").trim();
        if (!id || selection.ids.length !== 1 || selection.ids[0] !== id) {
          throw new Error("Sessions+ session catalog 未授权这个会话");
        }
        const scanRoot = sessionCatalogScanRoot(selection.source, sessionScanRoot, opts);
        const transcript = await readObservedSession(scanRoot, {
          id,
          source: selection.source,
          max_messages: req.args.max_messages,
          offset: req.args.offset,
          rich: req.args.rich,
          tool_detail: req.args.tool_detail,
        }, selection.source === "codex" ? opts.sessionObservation?.split : opts.sessionObservation?.ordinary);
        if (req.args.continuation_settings === true) {
          if (req.args.source !== "codex" || !opts.agentControlPlane) throw new Error("仅支持 Codex 自动续接设置");
          result = opts.agentControlPlane.continuationSettings("codex", String(req.args.id ?? ""));
          break;
        }
        result = await withReadAgentRuntime(
          opts.claudeTranslations
            ? await opts.claudeTranslations.decorateTranscript(transcript)
            : transcript,
          opts.agentRuntime,
          opts.agentInteractions,
          opts.agentControlPlane,
          true,
        );
        break;
      }
      case "list_session_workspaces": {
        // With `path` the call answers one question instead: which registered
        // workspace holds that path an agent wrote, and where inside it. It
        // reads a path's existence (and, for a relative path, the session's
        // metadata cwd), so it follows the roster's machine-op gate below.
        if (req.args.path !== undefined) {
          result = opts.allowMachineOps && !opts.executionOnly
            ? await placeSessionPath(home, sessionScanRoot, req.args)
            : { placement: null, reason: "unavailable" };
          break;
        }
        // Registry enumeration is intentionally available even when the local
        // machine-op kill switch is off. It exposes opaque ids + display labels
        // only; resolving an id to a canonical path happens inside start.
        //
        // The roster is what lets this device also report WHICH registered
        // workspace each session sits in (`session_directories`). With the kill
        // switch off there is no roster, so there are no associations either —
        // an honest absence rather than a guess, and the reading side omits the
        // join key instead of falling back to a label. The sessions scanner is
        // a process-local singleton keyed by this same home, so a preceding
        // roster refresh and concurrent wake calls reuse its short-lived
        // enumeration facts (and its mtime-validated summaries).
        const [workspaceListing, terminal] = await Promise.all([
          (async () => {
            const recent = opts.allowMachineOps && !opts.executionOnly
              ? asSessionRoster(await listObservedSessions(sessionScanRoot,
                { source: "all", limit: SESSION_WORKSPACE_ROSTER_LIMIT, primary_window: true }, opts, opts.sessionObservation?.ordinary))
              : { sessions: [] };
            return await listSessionWorkspaces(home, recent.sessions);
          })(),
          opts.allowMachineOps && opts.workspaceTerminals
            ? opts.workspaceTerminals.availability()
            : Promise.resolve({ available: false, reason: "这台设备未开启远端终端操作。" }),
        ]);
        result = { ...workspaceListing, terminal };
        break;
      }
      case "list_workspace_entries":
        // Both workspace-files ops resolve their root through the device's own
        // registry; neither accepts an absolute path, so `home` is the only
        // authority material that reaches them.
        result = await listWorkspaceEntries(home, req.args);
        break;
      case "access_owner_files":
        // Owner-local branch: the authenticated device binding already fixes
        // whose OS account is addressed. No workspace registry comparison is
        // performed; filesystem accessibility is the final device-side door.
        result = req.args.mode === "resolve"
          ? await resolveOwnerFileLink(home, sessionScanRoot, req.args)
          : await accessOwnerFiles(req.args);
        break;
      case "replace_owner_text":
        result = await replaceOwnerText(req.args);
        break;
      case "read_workspace_text":
        result = await readWorkspaceText(home, req.args);
        break;
      case "read_workspace_binary":
        result = await readWorkspaceBinary(home, req.args);
        break;
      case "workspace_file_transfer":
        result = await (opts.fileTransfers ?? DEFAULT_FILE_TRANSFERS).rpc(home, opts.gatewaySite ?? "primary", req.args);
        break;
      case "download_workspace_file":
        result = await readWorkspaceBinary(home, req.args);
        break;
      case "replace_workspace_text":
        // The one write verb on this path. Same authority material as the two
        // reads — the registry plus a relative path — and a compare-and-swap on
        // top, so it can only ever replace the version the caller had.
        result = await replaceWorkspaceText(home, req.args);
        break;
      case "workspace_development_prepare":
      case "workspace_development_sync":
      case "workspace_development_status":
      case "workspace_development_export":
      case "workspace_development_artifact": {
        if (!opts.workspaceDevelopment) throw new Error("workspace-development/v1 is unavailable on this Runner");
        const method = req.method.slice("workspace_development_".length) as "prepare" | "sync" | "status" | "export" | "artifact";
        result = await opts.workspaceDevelopment[method](opts.gatewaySite, req.args);
        break;
      }
      case "workspace_job_start":
      case "workspace_job_status":
      case "workspace_job_cancel":
      case "workspace_job_artifact":
      case "workspace_job_read": {
        if (!opts.workspaceJobs) throw new Error("workspace-jobs/v1 is unavailable on this Runner");
        const method = req.method === "workspace_job_start" ? "start" : req.method === "workspace_job_status" ? "status"
          : req.method === "workspace_job_cancel" ? "cancel" : req.method === "workspace_job_artifact" ? "readArtifact" : "readLog";
        result = await opts.workspaceJobs[method](opts.gatewaySite, req.args);
        break;
      }
      case "workspace_terminal":
        if (!opts.workspaceTerminals) throw new Error("远端终端服务不可用");
        result = await opts.workspaceTerminals.execute(req.args);
        break;
      case "respond_agent_interaction":
        if (!opts.agentInteractions) throw new Error("Agent interaction broker is unavailable on this Runner");
        result = await opts.agentInteractions.respond(req.args);
        await opts.agentInteractions.flush();
        break;
      case "list_recent_sessions": {
        // An exact selector answers only those chats from this device's own
        // catalog; it narrows the read the Gate authorised, never widens it.
        const selected = decodeSessionIds(req.args.ids);
        const listed = selected.length
          ? await listObservedSessions(sessionScanRoot, { source: "all", limit: selected.length }, opts,
            opts.sessionObservation?.ordinary, selected)
          : await listObservedSessions(sessionScanRoot, req.args, opts, opts.sessionObservation?.ordinary);
        result = await withAgentRuntime(
          withDisplayDirectories(home, listed),
          opts.agentRuntime,
          opts.agentInteractions,
          opts.agentControlPlane,
          opts.sessionObservation,
        );
        break;
      }
      case "digest_recent_sessions":
        result = await digestRecentSessions(sessionScanRoot, req.args);
        break;
      case "search_sessions":
        result = await searchSessions(sessionScanRoot, req.args);
        break;
      case "read_session": {
        let readScanRoot = sessionScanRoot;
        let readArgs = req.args;
        if (req.args._octopus_include_session_plus === true) {
          const placement = await new LaunchJournal(home).sessionPlacement(String(req.args.id ?? "").trim());
          if (placement?.source === "codex" && placement.source === req.args.source) {
            readScanRoot = sessionCatalogScanRoot(placement.source, sessionScanRoot, opts);
            // The trusted launch binds this exact native id, never a caller path.
            readArgs = { ...req.args, path: undefined };
          }
        }
        const transcript = await readObservedSession(readScanRoot, readArgs,
          readScanRoot === sessionScanRoot ? opts.sessionObservation?.ordinary : opts.sessionObservation?.split);
        if (req.args.continuation_settings === true) {
          if (req.args.source !== "codex" || !opts.agentControlPlane) throw new Error("仅支持 Codex 自动续接设置");
          result = opts.agentControlPlane.continuationSettings("codex", String(req.args.id ?? ""));
          break;
        }
        result = await withReadAgentRuntime(
          opts.claudeTranslations
            ? await opts.claudeTranslations.decorateTranscript(transcript)
            : transcript,
          opts.agentRuntime,
          opts.agentInteractions,
          opts.agentControlPlane,
          true,
        );
        break;
      }
      case "session_anchor":
        // Read-only, like read_session: where the last completed turn ends, in the log read_session shows.
        result = await sessionAnchor(sessionScanRoot, req.args, await indexedLog(req.args, opts.sessionObservation?.ordinary));
        break;
      case "fork_session":
        // Writes a new session file (gated as a machine write) and runs nothing.
        result = await forkSessionAt(sessionScanRoot, req.args, await indexedLog(req.args, opts.sessionObservation?.ordinary));
        break;
      case "copy_session": {
        const id = String(req.args.id ?? "").trim();
        if (!id) throw new Error("copy_session requires `id`");
        result = await exportSessionFile(sessionScanRoot, id, Number(req.args.offset ?? 0) || 0);
        break;
      }
      case "copy_file": {
        const p = String(req.args.path ?? "").trim();
        if (!p) throw new Error("copy_file requires `path`");
        result = await exportPlainFile(home, p, Number(req.args.offset ?? 0) || 0);
        break;
      }
      default:
        throw new Error(`unknown method: ${req.method}`);
    }
    return { type: "rpc_result", id: req.id, ok: true, result };
  } catch (err) {
    const code = notSentRefusalCode(err);
    return { type: "rpc_result", id: req.id, ok: false, error: err instanceof Error ? err.message : String(err),
      ...(code ? { code } : {}) };
  }
}

function sessionCatalogScanRoot(
  source: AgentProvider,
  ordinary: SessionScanRoot,
  opts: RpcOptions,
): SessionScanRoot {
  if (source !== "codex") return ordinary;
  if (!opts.sessionPlusSessionScanRoot) {
    throw new Error("Sessions+ split transcript root is unavailable on this Runner");
  }
  return opts.sessionPlusSessionScanRoot;
}

async function listObservedSessions(
  scan: SessionScanRoot, args: Record<string, unknown>, opts: RpcOptions,
  observation?: SessionObservationIndex, selected?: readonly { source: ScanSource; id: string }[],
): Promise<unknown> {
  if (observation) return observation.list(args, selected);
  return selected ? listSelectedSessions(scan, args, selected, foregroundRosterPriority(opts))
    : listRecentSessions(scan, args, foregroundRosterPriority(opts));
}

/** The file the session index reads for this id (see IndexedLog); undefined when it has none. */
async function indexedLog(args: Record<string, unknown>, observation?: SessionObservationIndex): Promise<IndexedLog | undefined> {
  const source = String(args.source ?? "");
  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (!observation || !id || !["codex", "claude", "omp"].includes(source)) return undefined;
  return await observation.resolve({ source: source as ScanSource, id });
}

async function readObservedSession(
  scan: SessionScanRoot, args: Record<string, unknown>, observation?: SessionObservationIndex,
): Promise<unknown> {
  const cached = await observation?.read(args);
  if (cached !== undefined) return cached;
  // An explicit open may resolve a never-before-seen historical id. Warm only
  // that exact locator; ordinary list queries never enter this fallback.
  const result = await readSession(scan, args);
  await observation?.observeRead(result);
  return result;
}

/** One-line audit description of a machine op (goes to the runner's log). */
function summarizeMachineOp(req: RpcRequest): string {
  if (req.method === "exec") return `$ ${String(req.args.command ?? "").slice(0, 200)}`;
  if (req.method === "exec_workspace") {
    return `workspace ${String(req.args.workspace_id ?? "").slice(0, 32)}: $ ${String(req.args.command ?? "").slice(0, 200)}`;
  }
  if (req.method === "append_session") {
    if (req.args.configure_continuation === true) return `#${String(req.args.id ?? "").slice(0, 12)}: configure Codex continuation`;
    if (req.args.interrupt === true) {
      return `#${String(req.args.id ?? "").slice(0, 12)}: interrupt managed turn`;
    }
    if (req.args.release_control === true) {
      return `#${String(req.args.id ?? "").slice(0, 12)}: release settled Codex attachment`;
    }
    const profile = req.args.permission_profile ? ` [agent-fallback:${String(req.args.permission_profile)}]` : "";
    return `#${String(req.args.id ?? "").slice(0, 12)}${profile}: ${promptAudit(req.args.prompt)}`;
  }
  if (req.method === "upload_session_file") {
    return `#${String(req.args.id ?? "").slice(0, 12)}: file chunk `
      + `${String(req.args.chunk_index ?? "?")}/${String(req.args.chunk_count ?? "?")}`;
  }
  if (req.method === "start_session") {
    // Whichever of the two ways the target was named. The local log is the
    // device owner's own record of what their machine was asked to do, so it
    // says the directory when a directory is what was asked for.
    const target = req.args.directory
      ? String(req.args.directory).slice(0, 200)
      : String(req.args.workspace_id ?? "?").slice(0, 40);
    const profile = req.args.permission_profile ? ` [${String(req.args.permission_profile)}]` : "";
    return `${String(req.args.source ?? "?")}${profile} @ ${target}: ${promptAudit(req.args.prompt)}`;
  }
  if (req.method === "respond_agent_interaction") {
    return `${String(req.args.provider ?? "?")}/${String(req.args.session_id ?? "").slice(0, 12)} `
      + `${String(req.args.interaction_id ?? "").slice(0, 20)}`;
  }
  if (req.method === "workspace_terminal") {
    return `${String(req.args.action ?? "?")}:${String(req.args.terminal_id ?? req.args.workspace_id ?? "").slice(0, 64)}`;
  }
  if (req.method.startsWith("workspace_job_")) {
    return `workspace ${String(req.args.workspace_id ?? "").slice(0, 40)} job ${String(req.args.job_id ?? "").slice(0, 100)}`;
  }
  if (req.method.startsWith("knowledge_index_")) {
    return `job ${String(req.args.job_key ?? "").slice(0, 16)} ${req.method.slice("knowledge_index_".length)}`;
  }
  if (req.method === "host_info") return "";
  if (req.method === "gui_request_control") return "request local 15-minute consent";
  if (req.method === "gui_capture_screen") return "capture main display";
  if (req.method === "gui_click") {
    return `click ${String(req.args.button ?? "left")} x=${String(req.args.x ?? "?")} y=${String(req.args.y ?? "?")}`;
  }
  if (req.method === "gui_scroll") {
    return `scroll ${String(req.args.direction ?? "?")} amount=${String(req.args.amount ?? "?")}`;
  }
  if (req.method === "gui_drag") return "drag pointer between screenshot coordinates";
  if (req.method === "gui_type_text") return `type ${Buffer.byteLength(String(req.args.text ?? ""), "utf8")} bytes`;
  if (req.method === "gui_key_press") return `press ${String(req.args.key ?? "?")}`;
  if (req.method === "gui_release_control") return "release local GUI control";
  if (
    req.method === "access_owner_files"
    || req.method === "replace_owner_text"
  ) {
    const mode = req.method === "replace_owner_text"
      ? (["begin", "append", "commit"].includes(String(req.args.stage)) ? `replace-${String(req.args.stage)}` : "replace")
      : String(req.args.mode ?? "?");
    const absolute = typeof req.args.absolute_path === "string"
      && req.args.absolute_path.length <= MACHINE_LIMITS.pathMaxBytes
      && isAbsolute(req.args.absolute_path)
      && !/[\0\r\n]/.test(req.args.absolute_path)
      ? req.args.absolute_path
      : "(invalid absolute path)";
    return `${mode}:${absolute.slice(0, 200)}`;
  }
  if (
    req.method === "list_workspace_entries"
    || req.method === "read_workspace_text"
    || req.method === "read_workspace_binary"
    || req.method === "download_workspace_file"
    || req.method === "replace_workspace_text"
  ) {
    // The owner's own record of what their machine was asked for. The workspace
    // id and the relative path are what the caller named; the canonical root
    // stays out of it, here as everywhere else on this path.
    const workspace = String(req.args.workspace_id ?? "");
    const safeWorkspace = /^ws_[0-9a-f]{24}$/.test(workspace) ? workspace : "(invalid workspace id)";
    const relative = req.args.relative_path ?? "";
    const safeRelative = workspaceRelativePathProblem(relative) === null
      ? String(relative)
      : "(invalid relative path)";
    const where = `${safeWorkspace}:${safeRelative.slice(0, 200)}`;
    if (req.method !== "replace_workspace_text") return where;
    // A write says how much is about to land. The content itself is NOT logged:
    // this line exists so the machine's owner can see what was asked for, not so
    // their editor buffer ends up in a log file.
    const size = typeof req.args.text === "string" ? Buffer.byteLength(req.args.text, "utf8") : -1;
    const stage = req.args.stage;
    if (stage === "begin" || stage === "append" || stage === "commit") {
      // A staged replacement: say which step, and for a commit the total.
      const total = stage === "commit" && Number.isSafeInteger(req.args.size) ? Number(req.args.size) : size;
      return `${where} ← staged ${stage} ${total} bytes`;
    }
    return `${where} ← ${size} bytes`;
  }
  return String(req.args.path ?? "");
}

function promptAudit(value: unknown): string {
  const prompt = String(value ?? "");
  return `prompt bytes=${Buffer.byteLength(prompt, "utf8")} sha256=${createHash("sha256").update(prompt).digest("hex").slice(0, 12)}`;
}

export { MACHINE_WRITE_METHODS };

function asSessionRoster(value: unknown): { sessions: Array<Record<string, unknown>> } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { sessions: [] };
  const sessions = (value as { sessions?: unknown }).sessions;
  return {
    sessions: Array.isArray(sessions)
      ? sessions.filter((entry): entry is Record<string, unknown> =>
          Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
      : [],
  };
}

/** Add a non-authoritative display label while retaining cwd inside the Runner. */
function withDisplayDirectories(home: string, value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const roster = value as Record<string, unknown>;
  const sessions = asSessionRoster(value).sessions.map((entry) => ({
    ...entry,
    cwd_display: typeof entry.cwd === "string" ? workspaceDisplayPath(home, entry.cwd) : "",
  }));
  return { ...roster, sessions };
}

/** Runtime proof must participate before the scanner truncates its inventory. */
function foregroundRosterPriority(opts: RpcOptions): SessionRosterPriority | undefined {
  const control = opts.agentControlPlane;
  if (!control) return undefined;
  return async (candidates) => {
    await control.discover(codexDiscoveryCandidates(candidates.map((row) => ({ ...row }))));
    const preferred = new Set<string>();
    // Unobserved history has no terminal evidence. Avoid allocating a control
    // reference or probing processes for every old log in a large inventory.
    for (const candidate of candidates) {
      if (opts.agentRuntime && opts.agentRuntime.publicRuntime(candidate.source, candidate.id)?.process_state !== "alive") continue;
      const runtime = await control.publicRuntime(candidate.source, candidate.id);
      if (isForegroundTmuxSession({ runtime })) preferred.add(sessionListCursor(candidate));
    }
    return preferred;
  };
}

/** Merge only the public half of hook evidence; pid/cwd/transcript stay local. */
async function withAgentRuntime(
  value: unknown,
  runtime: AgentRuntimeRegistry | undefined,
  interactions?: AgentInteractionBroker,
  controlPlane?: AgentControlPlane,
  observation?: RpcOptions["sessionObservation"],
): Promise<unknown> {
  if ((!runtime && !interactions && !controlPlane) || !value || typeof value !== "object" || Array.isArray(value)) return value;
  const rosterSessions = asSessionRoster(value).sessions;
  // Discovered (non-hook) CLIs enter the record store here, once per roster
  // read rather than once per session. The sweep is throttled and swallows its
  // own failures; a roster is never worse off for having tried.
  if (!observation) await controlPlane?.discover(codexDiscoveryCandidates(rosterSessions));
  const roster = value as Record<string, unknown>;
  const sessions = await Promise.all(rosterSessions.map(async (entry) => {
    const source = isAgentProvider(entry.source) ? entry.source : null;
    const id = typeof entry.id === "string" ? entry.id : "";
    const fresh = !observation || source && (observation.ordinary.isLive(source, id) || observation.split.isLive(source, id));
    const observed = source && id ? await publicAgentRuntime(runtime, interactions, fresh ? controlPlane : undefined, source, id) : undefined;
    return observed ? { ...entry, runtime: observed } : entry;
  }));
  return { ...roster, sessions };
}

async function withReadAgentRuntime(
  value: unknown,
  runtime: AgentRuntimeRegistry | undefined,
  interactions?: AgentInteractionBroker,
  controlPlane?: AgentControlPlane,
  watch = false,
): Promise<unknown> {
  if ((!runtime && !interactions && !controlPlane) || !value || typeof value !== "object" || Array.isArray(value)) return value;
  const row = value as Record<string, unknown>;
  const meta = row.meta && typeof row.meta === "object" && !Array.isArray(row.meta)
    ? row.meta as Record<string, unknown>
    : null;
  await controlPlane?.discover(codexDiscoveryCandidates(meta ? [meta] : []));
  const source = isAgentProvider(meta?.source) ? meta.source : null;
  const id = typeof meta?.id === "string" ? meta.id : "";
  if (watch && source && id) interactions?.watch(source, id);
  const observed = source && id ? await publicAgentRuntime(runtime, interactions, controlPlane, source, id) : undefined;
  return observed && meta ? { ...row, meta: { ...meta, runtime: observed } } : value;
}

/**
 * Device-private discovery input. `path` came from the trusted scanner and is
 * consumed before the ordinary projection allow-list removes it.
 */
function codexDiscoveryCandidates(
  sessions: readonly Record<string, unknown>[],
): CodexSessionDiscoveryCandidate[] {
  const candidates: CodexSessionDiscoveryCandidate[] = [];
  for (const session of sessions) {
    if (session.source !== "codex") continue;
    const sessionId = typeof session.id === "string" ? session.id : "";
    const sessionPath = typeof session.path === "string" ? session.path : "";
    if (!sessionId || !isAbsolute(sessionPath)) continue;
    const activity = session.activity && typeof session.activity === "object" && !Array.isArray(session.activity)
      ? session.activity as Record<string, unknown>
      : null;
    const state = String(activity?.state ?? "");
    const turnState: CodexSessionDiscoveryCandidate["turnState"] = state === "thinking" || state === "tool" || state === "responding"
      ? "working"
      : state === "idle" ? "idle" : "unknown";
    candidates.push({
      sessionId,
      sessionPath,
      turnState,
      ...(typeof session.cwd === "string" && session.cwd ? { cwd: session.cwd } : {}),
      ...(typeof activity?.tool === "string" && activity.tool ? { tool: activity.tool } : {}),
    });
  }
  return candidates;
}

async function publicAgentRuntime(
  runtime: AgentRuntimeRegistry | undefined,
  interactions: AgentInteractionBroker | undefined,
  controlPlane: AgentControlPlane | undefined,
  source: AgentProvider,
  id: string,
): Promise<Record<string, unknown> | undefined> {
  const observed = controlPlane
    ? await controlPlane.publicRuntime(source, id)
    : runtime?.publicRuntime(source, id);
  const interaction = interactions?.publicInteraction(source, id);
  const interactionPending = interaction && interaction.status !== "resolved";
  if (!observed && !interaction) return undefined;
  const base = observed ?? {
    process_state: "unknown",
    turn_state: interactionPending ? "needs_input" : "idle",
    control_mode: interactionPending ? "octopus_headless" : "unknown",
    observed_at: interaction?.created_at ?? new Date().toISOString(),
    event: interaction ? "AgentInteraction" : "Unknown",
    degraded: true,
    capabilities: {
      observe: true,
      append_when_idle: false,
      takeover: false,
      interrupt: false,
      steer: false,
    },
  };
  return {
    ...base,
    ...(interaction ? {
      ...(interactionPending ? { turn_state: "needs_input" } : {}),
      interaction,
      capabilities: { ...base.capabilities, respond: interactionPending === true },
    } : {}),
  };
}
