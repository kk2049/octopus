import { sessionInputStage } from "./session-input-perf.js";
import { queueCodexPrompt, CodexQueueError, type CodexQueueSubmission } from "./codex-native-queue.js";
import { CodexContinuationStore } from "./codex-continuation.js";
import { DEFAULT_CODEX_CONTINUATION } from "@claude-bot/agent-sessions-contract";
import { CodexDesktopSession } from "./codex-desktop.js";
import { CodexDaemonObserver, type CodexDaemonConnection } from "./codex-daemon.js";
import fs from "node:fs/promises";
import { dependencyWait, isManagedDependencyUnavailable, recoveryAction } from "./managed-execution.js";
import { withAgentExecutable, preflightAgentExecutable } from "./agent-executables.js";
/**
 * Provider-neutral Agent control plane.
 *
 * Five concepts stay separate here:
 *
 *  - provider session ref: stable logical id plus the provider's current id;
 *  - attachment: hook observer, exact tmux pane, or native provider protocol;
 *  - control lease: terminal or protocol is the sole semantic writer;
 *  - turn: one active unit that can be steered/interrupted;
 *  - interaction: delegated to the durable single-use broker.
 *
 * The legacy `control_mode` projection remains as a compatibility alias. It is
 * derived from these facts and is never consulted to decide control.
 */

import { createHash, randomUUID } from "node:crypto";
import type { AgentInteractionBroker } from "./agent-interactions.js";
import {
  LinuxProcessReader,
  type AgentProvider,
  type AgentRuntimeInspection,
  type AgentRuntimeRegistry,
  type PublicAgentRuntime,
} from "./agent-runtime.js";
import { ClaudeManagedSession, type ClaudeManagedTurnResult } from "./claude-agent-sdk.js";
import { ClaudeInputReceipt, claudeToolCallEnded, type ClaudeInputPhase } from "./claude-input-receipt.js";
import type { ClaudeOpenQuestion } from "./hook-ipc.js";
import {
  CodexManagedSession,
  type CodexAppServerTurnResult,
} from "./codex-app-server.js";
import {
  TerminalControl,
  TerminalSubmissionUnconfirmedError,
  type TmuxPaneAttachment,
} from "./terminal-control.js";
import type { CodexAppServerHost } from "./codex-app-server-host.js";
import type { CodexSplitHostSelection } from "./codex-split-hosts.js";
import {
  OmpManagedSession,
  assertOmpPermissionProfile,
  type OmpManagedTurnResult,
} from "./omp-rpc.js";
import { discoverOmpSessions, LinuxProcessLister } from "./omp-terminal.js";
import {
  discoverCodexTerminalSessions,
  type CodexSessionDiscoveryCandidate,
} from "./codex-terminal.js";
import {
  codexPermissionProfile,
} from "./codex-permissions.js";
import {
  agentPermissionProfile,
  type AgentPermissionProfile,
} from "./agent-permissions.js";
import {
  type ClaudePromptTranslation,
  type ClaudeTranslationPort,
} from "./claude-translation.js";
import {
  managedRecoveryPrompt,
  type ManagedRecoveryJournal,
  type ManagedRecoveryPlacement,
  type ManagedRecoveryRecord,
  type ManagedRecoverySpec,
} from "./managed-recovery.js";
import { CodexCapacityRetry, type CodexCapacityCheckpoint } from "./codex-capacity-retry.js";
import {
  RUNNER_MANAGED_COMPLETION_SCHEMA,
  type RunnerManagedCompletion,
  type RunnerManagedTurnUsage,
  type SessionInputReceipt,
} from "./gateway-protocol.js";
import {
  ProviderSessionRefs,
  type ProviderSessionRef,
} from "./provider-session-ref.js";
import { inputNotSent } from "./input-handoff.js";

export type AgentAttachmentKind =
  | "hook_observer"
  | "terminal_tmux"
  | "claude_sdk"
  | "codex_app_server"
  | "omp_rpc"
  | "omp_terminal"
  | "legacy_exec"
  | "none";
export type AgentControlLeaseHolder = "none" | "terminal" | "protocol";
export type AgentTurnLifecycle = "working" | "needs_input" | "idle" | "unknown";

export interface PublicAgentControlRuntime extends PublicAgentRuntime {
  recovery?: { state: "reconnecting" | "waiting_resource" | "waiting_capacity" | "unknown"; since?: string; retry_at?: string; attempts?: number; max_attempts?: number; deadline_at?: string };
  attachment: {
    kind: AgentAttachmentKind;
    state: "attached" | "observed" | "detached" | "unknown";
    transport?: "tmux" | "agent-sdk" | "app-server" | "omp-rpc" | "exec";
  };
  control_lease: {
    holder: AgentControlLeaseHolder;
    acquired_at?: string;
  };
  turn: {
    state: AgentTurnLifecycle;
    id?: string;
    started_at?: string;
  };
  capabilities: PublicAgentRuntime["capabilities"] & {
    terminal_append: boolean;
    managed_resume: boolean;
    protocol_append: boolean;
    /** Exact, settled, process-owned Codex attachment whose auto-close failed. */
    release_control: boolean;
    /**
     * `interrupt` is available, but only as ONE stop keystroke into the
     * person's own tmux pane — not a provider-level interrupt contract. A
     * consumer that words the action ("stop this turn" vs "stop the CLI") or
     * explains what survives it needs to know which of the two it has.
     */
    terminal_interrupt: boolean;
  };
}

export interface ContinueAgentSessionInput {
  /** Observe/join an already loaded native CLI only; never spawn, resume or type into a terminal. */
  nativeOnly?: boolean;
  /** Durable input admission; the returned promise still represents completion. */
  onInput?: (input: SessionInputReceipt) => Promise<void>;
  /** A racing completion must refuse this input, never start another turn. */
  steerOnly?: boolean;
  provider: AgentProvider;
  sessionId: string;
  prompt: string;
  cwd: string;
  takeover: boolean;
  /**
   * Force this turn's lane. Omitted — which is what every send from the web
   * composer does — the session keeps the lane it was started in, read from
   * its own ledger: half of a bilingual transcript arriving untranslated is
   * worse than either lane on its own.
   */
  translatePrompt?: boolean;
  /** Optional model for the new managed turn. Never applied to a terminal/TUI append or in-flight steer. */
  model?: string;
  /** Optional effort for the new managed turn. Never applied to a terminal/TUI append or in-flight steer. */
  effort?: string;
  permissionProfile?: AgentPermissionProfile;
  /**
   * Device-private absolute path of the session file. omp resumes by opening
   * an exact `.jsonl` rather than matching an id prefix, which is what keeps a
   * headless resume from ever reaching omp's interactive "re-root this
   * session?" prompt. Never projected; the caller already resolved it inside
   * the device's own scan root.
   */
  sessionPath?: string;
  /** Fresh turn-scoped loopback proxy for a previously split session. */
  remoteMcpUrl?: string;
  developmentMcpUrl?: string;
  /** Fresh Codex exec-server tunnel for a previously split session. */
  codexEnvironment?: {
    environmentId: string;
    endpoint: string;
  };
  /** Device-local account root resolved by the trusted multi-home scanner. */
  codexHome?: string;
  /** Non-secret split coordinates retained for restart recovery. */
  recoveryPlacement?: ManagedRecoveryPlacement;
}

export interface StartManagedAgentInput {
  /** Persist native identity before the first provider input is sent. */
  onPrepared?: (sessionId: string, transport: ManagedTransport) => Promise<void>;
  provider: AgentProvider;
  cwd: string;
  prompt: string;
  /**
   * Hand this Claude turn to the GPT translator before Claude sees it.
   *
   * Off unless the caller asks for it. The plain Claude lane is the one people
   * fall back to when the rest of this system is misbehaving, so nothing in it
   * may depend on a second provider being reachable: a translator outage must
   * cost a bilingual launch, never every launch.
   */
  translatePrompt?: boolean;
  model?: string;
  effort?: string;
  /** Claude session ids are preallocated for durable launch idempotency. */
  sessionId?: string;
  permissionProfile?: AgentPermissionProfile;
  /** Loopback-scoped MCP endpoint for split runtime/execution placement. */
  remoteMcpUrl?: string;
  developmentMcpUrl?: string;
  /** Codex-native remote executor registered on this app-server thread. */
  codexEnvironment?: {
    environmentId: string;
    endpoint: string;
  };
  /** Device-local account root selected by the trusted Codex account router. */
  codexHome?: string;
  /** Non-secret split coordinates retained for restart recovery. */
  recoveryPlacement?: ManagedRecoveryPlacement;
}

export interface ManagedStartResult {
  sessionId: string;
  transport: ManagedTransport;
  turnId: string;
  completion: Promise<ManagedTurnResult>;
}

export interface ManagedTurnResult {
  ok: boolean;
  resultText?: string;
  resultTextEnglish?: string;
  translationError?: string;
  newSessionId?: string;
  error?: string;
  stderr?: string;
  timedOut?: boolean;
  status?: string;
  usage?: RunnerManagedTurnUsage;
}

/** Provider-native transports this plane can hold an attachment on. */
export type ManagedTransport = "agent-sdk" | "app-server" | "omp-rpc";

/** Fresh, connection-scoped credential issued only after Runner authentication. */
export interface ManagedRecoveryScope {
  development?: { developmentId: string; token: string; endpoint: string; expiresAt: number };
  token: string;
  endpoint: string;
  expiresAt: number;
  operationId: string;
  executionDevice: string;
  workspaceId: string;
}

export interface ManagedRecoveryScopeClient {
  request(provider: AgentProvider, sessionId: string, gatewaySite?: string): Promise<ManagedRecoveryScope>;
}

export interface ManagedRecoveryRemoteHandle {
  remoteMcpUrl: string;
  developmentMcpUrl?: string;
  codexEnvironment?: {
    environmentId: string;
    endpoint: string;
  };
  close(): Promise<void>;
}

type ManagedAttachment = {
  provider: AgentProvider;
  session: ProviderSessionRef;
  cwd: string;
  transport: ManagedTransport;
  turnId: string;
  startedAt: string;
  controller: ManagedController;
  completion: Promise<ManagedTurnResult>;
  leaseHolder: "terminal" | "protocol";
  permissionProfile?: AgentPermissionProfile;
  /** Configuration this managed turn was actually opened with. */
  model?: string;
  effort?: string;
  finishRuntime?: () => Promise<void>;
  /** Set only after a settled process-owned Codex attachment failed to close. */
  releaseRequired?: boolean;
  capacityRetry?: CodexCapacityRetry;
};

type PaneProbe = {
  generation: number;
  promise: Promise<TmuxPaneAttachment | null>;
};

/**
 * How long one terminal submission stays evidence against an identical resend.
 *
 * Typing into a TUI is the one write on this plane with no receipt: tmux proves
 * bytes reached the pty, and a visible pane change proves the TUI reacted — but
 * neither proves the TUI SUBMITTED rather than parked the text in its composer.
 * So the person sees nothing happen and presses send again, and every copy
 * eventually lands at once. This window turns that second copy into a sentence
 * they can act on.
 *
 * The window alone would also refuse a legitimate second "继续", so it is paired
 * with the session's own observation clock: any new hook evidence since the
 * first copy means the CLI moved, and the resend is a new intent again.
 */
const TERMINAL_RESEND_WINDOW_MS = 120_000;
/** Bound the device-local memory; far more than one person's open sessions. */
const TERMINAL_RESEND_MAX = 64;
/** Shortest gap between two external-CLI discovery sweeps; matches the View's poll. */
const DISCOVERY_INTERVAL_MS = 2_000;
/**
 * Claude writes an accepted input to its transcript within a few hundred
 * milliseconds of Enter. The inline wait leaves room for a TUI busy redrawing;
 * after it, the same record is still looked for while the Head keeps asking
 * about an uncertain receipt (it stops after 30 minutes).
 */
const CLAUDE_TRANSCRIPT_CONFIRM_MS = 6_000;
/**
 * Claude Code's composer prompt: `❯` since 2.x, `>` inside a box before.
 * A paste is written only while one of these rows holds the cursor, empty.
 */
const CLAUDE_COMPOSER_GLYPHS = ["❯", ">"] as const;
/** Esc closes a question dialog within a frame; Claude records it at once. */
const CLAUDE_QUESTION_CLOSE_MS = 3_000;
const CLAUDE_QUESTION_CLOSE_POLL_MS = 100;
const CLAUDE_TRANSCRIPT_FOLLOW_MS = 30 * 60_000;
const CLAUDE_TRANSCRIPT_FOLLOW_POLL_MS = 3_000;

/** Which attachment a live managed transport is, for the public projection. */
const MANAGED_ATTACHMENT_KIND: Record<ManagedTransport, AgentAttachmentKind> = {
  "agent-sdk": "claude_sdk",
  "app-server": "codex_app_server",
  "omp-rpc": "omp_rpc",
};

interface TerminalSendRecord {
  at: number;
  /** The session's observation clock at the moment of the write. */
  observedAt: string;
}

export interface AgentControlPlaneOptions {
  runtime: AgentRuntimeRegistry;
  interactions: AgentInteractionBroker;
  terminal?: TerminalControl;
  now?: () => Date;
  /** Optional embedding/test deadline for one provider turn; zero disables it. */
  timeoutMs: number;
  codexHost?: CodexAppServerHost;
  /** Config-isolated app-server used only when Codex executes on another Runner. */
  codexRemoteHost?: CodexAppServerHost;
  /** Resolve only registered account/native roots to their own isolated host. */
  codexRemoteHostForHome?: (codexHome?: string) => CodexSplitHostSelection;
  /** Scan root whose omp breadcrumbs this plane may sweep. Omit to disable. */
  scanHome?: string;
  /** Test seam for the omp discovery sweep. */
  ompDiscovery?: (home: string, runtime: AgentRuntimeRegistry) => Promise<unknown>;
  /** Test seam for exact rollout-fd discovery of already-running Codex TUIs. */
  codexDiscovery?: (
    candidates: readonly CodexSessionDiscoveryCandidate[],
    runtime: AgentRuntimeRegistry,
  ) => Promise<unknown>;
  /** Tool-free GPT translation and the private bilingual transcript ledger. */
  claudeTranslations?: ClaudeTranslationPort;
  /** Durable, prompt-free description of managed turns owned by this Runner. */
  recoveryJournal?: ManagedRecoveryJournal;
  codexContinuations?: CodexContinuationStore;
  /** Authenticated Bot channel that rotates a split session's scoped bearer. */
  recoveryScopes?: ManagedRecoveryScopeClient;
  /** Rebuild the process-local MCP proxy / Codex relay from a fresh scope. */
  openRecoveryRemote?: (
    record: ManagedRecoveryRecord,
    scope: ManagedRecoveryScope,
  ) => Promise<ManagedRecoveryRemoteHandle>;
  /** Bounded operational signal; never receives prompt or credential material. */
  onRecoveryEvent?: (event: string, record: ManagedRecoveryRecord, detail?: string) => void;
  persistManagedCompletion?: (event: RunnerManagedCompletion) => Promise<void>;
  queueCodexPrompt?: typeof queueCodexPrompt;
  codexDaemon?: CodexDaemonObserver;
}

export class AgentControlPlane {
  readonly codexDaemon: CodexDaemonObserver;
  private readonly queueCodexPrompt: typeof queueCodexPrompt;
  private readonly runtime: AgentRuntimeRegistry;
  private readonly interactions: AgentInteractionBroker;
  private readonly terminal: TerminalControl;
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  private readonly codexHost?: CodexAppServerHost;
  private readonly codexRemoteHost?: CodexAppServerHost;
  private readonly codexRemoteHostForHome?: AgentControlPlaneOptions["codexRemoteHostForHome"];
  private readonly claudeTranslations?: ClaudeTranslationPort;
  private readonly recoveryJournal?: ManagedRecoveryJournal;
  private readonly codexContinuations?: CodexContinuationStore;
  private readonly recoveryScopes?: ManagedRecoveryScopeClient;
  private readonly openRecoveryRemote?: AgentControlPlaneOptions["openRecoveryRemote"];
  private readonly onRecoveryEvent?: AgentControlPlaneOptions["onRecoveryEvent"];
  private readonly persistManagedCompletion?: AgentControlPlaneOptions["persistManagedCompletion"];
  private readonly managedCompletionListeners = new Set<(event: RunnerManagedCompletion) => void>();
  private readonly managedTranscriptActivityListeners = new Set<(
    provider: AgentProvider,
    sessionId: string,
    transcriptPath?: string,
  ) => void>();
  private readonly sessions: ProviderSessionRefs<ManagedAttachment>;
  private readonly opening = new Map<ProviderSessionRef | symbol, Promise<ManagedAttachment>>();
  private readonly startingControllers = new Map<ProviderSessionRef, ManagedController>();
  private readonly admissions = new Map<ProviderSessionRef, Promise<void>>();
  private readonly paneCache = new Map<number, {
    at: number;
    generation: number;
    value: TmuxPaneAttachment | null;
  }>();
  private readonly paneProbes = new Map<number, PaneProbe>();
  private nextPaneProbeGeneration = 0;
  /** In-memory fallback for embeddings that do not configure the recovery journal. */
  private readonly terminalSends = new Map<string, TerminalSendRecord>();
  private readonly scanHome?: string;
  private readonly ompDiscovery: (home: string, runtime: AgentRuntimeRegistry) => Promise<unknown>;
  private readonly codexDiscovery: (
    candidates: readonly CodexSessionDiscoveryCandidate[],
    runtime: AgentRuntimeRegistry,
  ) => Promise<unknown>;
  private discoveredAt = 0;
  private discovering: Promise<void> | undefined;
  private recoverStarted = false;
  private recoveryClosed = false;
  private recoveryFlight: Promise<{ recovered: number; unknown: number }> | null = null;
  private readonly recoveringControllers = new Map<ProviderSessionRef, AbortController>();
  private readonly bootRecoveries: ManagedRecoveryRecord[];
  private preserveRecoveries = false;

  constructor(options: AgentControlPlaneOptions) {
    this.codexDaemon = options.codexDaemon ?? new CodexDaemonObserver();
    this.queueCodexPrompt = options.queueCodexPrompt ?? queueCodexPrompt;
    this.persistManagedCompletion = options.persistManagedCompletion;
    this.runtime = options.runtime;
    this.interactions = options.interactions;
    this.terminal = options.terminal ?? new TerminalControl();
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = options.timeoutMs;
    this.codexHost = options.codexHost;
    this.codexRemoteHost = options.codexRemoteHost;
    this.codexRemoteHostForHome = options.codexRemoteHostForHome;
    this.claudeTranslations = options.claudeTranslations;
    this.recoveryJournal = options.recoveryJournal;
    this.codexContinuations = options.codexContinuations;
    this.bootRecoveries = options.recoveryJournal?.snapshot() ?? [];
    this.recoveryScopes = options.recoveryScopes;
    this.openRecoveryRemote = options.openRecoveryRemote;
    this.onRecoveryEvent = options.onRecoveryEvent;
    this.scanHome = options.scanHome;
    this.ompDiscovery = options.ompDiscovery ?? defaultOmpDiscovery;
    this.codexDiscovery = options.codexDiscovery ?? defaultCodexDiscovery;
    this.sessions = new ProviderSessionRefs<ManagedAttachment>({
      restored: [...(this.recoveryJournal?.sessionRefs() ?? []), ...(this.codexContinuations?.sessionRefs() ?? [])],
      onRename: async ({ provider, from, to, ref }) => {
        await Promise.all([
          this.runtime.renameSession(provider, from, to),
          this.recoveryJournal?.renameSession(provider, from, ref),
          provider === "codex" ? this.codexContinuations?.renamed(ref) : undefined,
        ]);
      },
    });
  }

  /**
   * A content-free terminal stream for provider-native turns owned here.
   * External CLI/tmux sends and cooperative terminal leases never enter it.
   */
  onManagedCompletion(listener: (event: RunnerManagedCompletion) => void): () => void {
    this.managedCompletionListeners.add(listener);
    return () => this.managedCompletionListeners.delete(listener);
  }

  /**
   * Content-free app-server activity for refreshing an already-authorized
   * transcript subscription. The provider payload never crosses this seam.
   */
  onManagedTranscriptActivity(
    listener: (provider: AgentProvider, sessionId: string, transcriptPath?: string) => void,
  ): () => void {
    this.managedTranscriptActivityListeners.add(listener);
    return () => this.managedTranscriptActivityListeners.delete(listener);
  }

  /** Attached provider sessions are an active set, independent of history. */
  managedSessions(): Array<{ source: AgentProvider; id: string; path?: string }> {
    return this.sessions.values().map((attachment) => {
      const path = this.managedTranscriptPath(attachment);
      return { source: attachment.provider, id: attachment.session.currentProviderId, ...(path ? { path } : {}) };
    });
  }

  private managedTranscriptPath(attachment: ManagedAttachment): string | undefined {
    return (attachment.controller instanceof CodexManagedSession ? attachment.controller.transcriptPath : undefined)
      ?? attachment.session.rolloutPath;
  }

  observedTerminalTtys(): Promise<ReadonlySet<string>> { return this.terminal.observedTtys(); }

  /**
   * Rebuild every provider-native turn the previous Runner had acknowledged.
   * The literal continuation is a NEW turn, never a replay of the original
   * prompt. Claims are durable before dispatch, so a crash inside recovery is
   * reported unknown rather than sending the continuation twice.
   */
  private recoveryWakePending = false;

  continuationSettings(provider: AgentProvider, sessionId: string) {
    if (provider !== "codex" || !this.codexContinuations) throw new Error("这个 Runner 不支持 Codex 自动续接设置");
    return this.codexContinuations.read(this.sessions.reference(provider, sessionId));
  }

  async saveContinuationSettings(provider: AgentProvider, sessionId: string, prompt: unknown, revision: unknown) {
    if (provider !== "codex" || !this.codexContinuations) throw new Error("这个 Runner 不支持 Codex 自动续接设置");
    return await this.codexContinuations.save(this.sessions.reference(provider, sessionId), prompt, revision);
  }

  private codexContinuationPrompt(session: ProviderSessionRef): string {
    return this.codexContinuations?.read(session).effectivePrompt ?? DEFAULT_CODEX_CONTINUATION;
  }

  async recoverInterrupted(wake = false): Promise<{ recovered: number; unknown: number }> {
    if (!this.recoveryJournal || this.recoveryClosed) return { recovered: 0, unknown: 0 };
    if (this.recoveryFlight) {
      this.recoveryWakePending ||= wake;
      return this.recoveryFlight;
    }
    this.recoveryFlight = (async () => {
      const total = { recovered: 0, unknown: 0 };
      do {
        this.recoveryWakePending = false;
        const result = await this.recoverPending(wake);
        total.recovered += result.recovered; total.unknown += result.unknown;
        wake = this.recoveryWakePending;
      } while (wake && !this.recoveryClosed);
      return total;
    })().finally(() => { this.recoveryFlight = null; });
    return this.recoveryFlight;
  }

  hasPendingRecovery(): boolean {
    return Boolean(this.recoveryJournal?.snapshot().some(row => row.status === "recovering"
      && (row.recoveryPhase === "preparing" || row.recoveryPhase === "waiting_resource")));
  }

  private async recoverPending(wake: boolean): Promise<{ recovered: number; unknown: number }> {
    const journal = this.recoveryJournal!;
    if (!this.recoverStarted) {
      this.recoverStarted = true;
      await journal.claimInterrupted(this.bootRecoveries);
    }
    const interrupted = journal.pendingRecovery(this.now().getTime(), wake);
    let recovered = 0;
    let unknown = 0;
    for (const record of interrupted) {
      if (this.recoveryClosed) break;
      const session = this.sessions.restore({ provider: record.provider, ...record.session });
      if (record.capacityRetry && this.now().getTime() >= Date.parse(record.capacityRetry.deadlineAt)) {
        await journal.exhaustCapacity(record, "Codex 容量自动续接已超过 30 分钟期限；请手动继续。");
        unknown++;
        this.onRecoveryEvent?.("unknown", record, "容量续接期限已耗尽。");
        this.emitManagedCompletion({ provider: record.provider, session, turnId: record.turnId! }, "failed");
        this.emitManagedTranscriptActivity(record.provider, session.currentProviderId);
        continue;
      }
      const recovering = new AbortController();
      this.recoveringControllers.set(session, recovering);
      let remote: ManagedRecoveryRemoteHandle | undefined;
      let dispatchStarted = false;
      try {
        if (record.remotePlacement) {
          if (!this.recoveryScopes || !this.openRecoveryRemote) {
            throw new Error("Runner 没有连接 split session 恢复通道");
          }
          // Bot's durable capability is bound to the stable external
          // correlation id (`session_id`), while provider resume uses the
          // renamed current id below. Never make an authorization lookup drift
          // merely because Codex minted another thread id.
          const scope = record.remotePlacement.gatewaySite
            ? await this.recoveryScopes.request(record.provider, session.logicalId, record.remotePlacement.gatewaySite)
            : await this.recoveryScopes.request(record.provider, session.logicalId);
          recovering.signal.throwIfAborted();
          if (
            scope.executionDevice !== record.remotePlacement.executionDevice
            || scope.workspaceId !== record.remotePlacement.workspaceId
          ) {
            throw new Error("Bot 返回的 split session 恢复范围与持久放置不一致");
          }
          if (scope.development?.developmentId !== record.remotePlacement.developmentId) {
            throw new Error("开发会话恢复身份缺失或不一致；等待可信开发范围恢复");
          }
          remote = await this.openRecoveryRemote(record, scope);
        }
        const prepared = await this.prepareClaudePrompt(
          record.provider,
          session.currentProviderId,
          record.cwd,
          record.provider === "codex" ? this.codexContinuationPrompt(session) : managedRecoveryPrompt(record),
          undefined,
        );
        if (recoveryAction({ desired: recovering.signal.aborted ? "cancelled" : "running", resumeOwner: "runner", coordinator: "runner",
          authorized: true, dependencyAvailable: true,
          dispatch: record.status === "recovering" && record.turnId ? "acknowledged_interrupted" : "uncertain" }) !== "resume_acknowledged"
          || !await journal.beginRecoveryDispatch(record)) {
          await remote?.close().catch(() => {});
          if (record.capacityRetry && journal.current(record.provider, session.logicalId)?.capacityResult?.ok === false) {
            unknown++;
            this.onRecoveryEvent?.("unknown", record, "容量续接次数或期限已耗尽。");
            this.emitManagedCompletion({ provider: record.provider, session, turnId: record.turnId! }, "failed");
            this.emitManagedTranscriptActivity(record.provider, session.currentProviderId);
          }
          continue;
        }
        dispatchStarted = true;
        const attachment = await this.openManaged({
          provider: record.provider,
          session,
          cwd: record.cwd,
          prompt: prepared.prompt,
          resume: true,
          recovering: true,
          recoverySignal: recovering.signal,
          ...(prepared.translation ? { claudeTranslation: prepared.translation } : {}),
          ...(record.permissionProfile ? { permissionProfile: record.permissionProfile } : {}),
          ...(record.codexHome ? { codexHome: record.codexHome } : {}),
          ...(record.model ? { model: record.model } : {}),
          ...(record.effort ? { effort: record.effort } : {}),
          ...(record.remotePlacement ? { recoveryPlacement: record.remotePlacement } : {}),
          ...(remote?.remoteMcpUrl ? { remoteMcpUrl: remote.remoteMcpUrl } : {}),
          ...(remote?.developmentMcpUrl ? { developmentMcpUrl: remote.developmentMcpUrl } : {}),
          ...(remote?.codexEnvironment ? { codexEnvironment: remote.codexEnvironment } : {}),
        });
        detachAfterSettlement(attachment.completion, () => remote?.close().catch(() => {}));
        recovered++;
        this.onRecoveryEvent?.("recovered", record);
        this.emitManagedTranscriptActivity(record.provider, session.currentProviderId);
      } catch (error) {
        await remote?.close().catch(() => {});
        if (recovering.signal.aborted) {
          if (!this.preserveRecoveries) await journal.disarm(record.provider, session);
          continue;
        }
        const detail = error instanceof Error ? error.message : String(error);
        if (!dispatchStarted && isManagedDependencyUnavailable(error)) {
          if (await journal.waitForDependency(record, detail)) {
            this.onRecoveryEvent?.("waiting_resource", record, detail);
            this.emitManagedTranscriptActivity(record.provider, session.currentProviderId);
          }
          continue;
        }
        await journal.markUnknown(record, detail);
        unknown++;
        this.onRecoveryEvent?.("unknown", record, detail);
        this.emitManagedTranscriptActivity(record.provider, session.currentProviderId);
      } finally {
        this.recoveringControllers.delete(session);
      }
    }
    return { recovered, unknown };
  }

  /** Must run synchronously before a self-update starts closing provider hosts. */
  prepareForRestart(): void {
    this.preserveRecoveries = true;
    for (const attachment of this.sessions.values()) attachment.capacityRetry?.suspend();
  }

  /**
   * Refresh discovered (non-hook) external CLIs.
   *
   * Called once per roster/transcript read rather than per session, and
   * throttled: a sweep reads a handful of breadcrumbs plus /proc, which is
   * cheap but not free, and two reads a few milliseconds apart cannot have
   * observed different terminals. A failure is swallowed — discovery makes a
   * roster richer and must never be able to make it fail.
   */
  async discover(
    codexCandidates: readonly CodexSessionDiscoveryCandidate[] = [],
    force = false,
  ): Promise<void> {
    const home = this.scanHome;
    if (!home && codexCandidates.length === 0) return;
    const now = this.now().getTime();
    // A forced write-path check waits for any roster sweep and then performs
    // its own fresh proof. It must not inherit a process table sampled before
    // the person clicked a disruptive takeover action.
    if (this.discovering) await sessionInputStage("discovery_wait", () => this.discovering!);
    if (!force && now - this.discoveredAt < DISCOVERY_INTERVAL_MS) return;
    const work = Promise.all([
      home
        ? Promise.resolve().then(() => this.ompDiscovery(home, this.runtime)).catch(() => undefined)
        : Promise.resolve(undefined),
      codexCandidates.length
        ? Promise.resolve().then(() => this.codexDiscovery(codexCandidates, this.runtime)).catch(() => undefined)
        : Promise.resolve(undefined),
    ])
      .finally(() => {
        this.discoveredAt = this.now().getTime();
        this.discovering = undefined;
      });
    this.discovering = work.then(() => undefined);
    await sessionInputStage("discovery_run", () => this.discovering!);
  }

  /** Serialize only input admission, never an entire provider turn. */
  private async admit<T>(provider: AgentProvider, sessionId: string, run: (release: () => void) => Promise<T>): Promise<T> {
    const session = this.sessions.reference(provider, sessionId);
    const previous = this.admissions.get(session) ?? Promise.resolve();
    let unlock!: () => void;
    const current = new Promise<void>((resolve) => { unlock = resolve; });
    this.admissions.set(session, current);
    await sessionInputStage("admission_wait", () => previous);
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      unlock();
      if (this.admissions.get(session) === current) this.admissions.delete(session);
    };
    try { return await run(release); } finally { release(); }
  }

  async continueSession(input: ContinueAgentSessionInput): Promise<Record<string, unknown>> {
    return await this.admit(input.provider, input.sessionId, (release) => this.continueAdmittedSession(input, release));
  }

  private async continueAdmittedSession(input: ContinueAgentSessionInput, release: () => void): Promise<Record<string, unknown>> {
    const acknowledge = async (receipt: SessionInputReceipt): Promise<void> => {
      // Losing receipt storage after prompt transfer cannot authorize a resend.
      try { await sessionInputStage("input_receipt", async () => await input.onInput?.(receipt)); } catch { /* Completion remains owned even if receipt storage fails. */ } finally { release(); }
    };
    const requestedPermissionProfile = input.permissionProfile;
    const requestedModel = input.model;
    const requestedEffort = input.effort;
    const session = this.sessions.reference(input.provider, input.sessionId, input.sessionPath);
    if (input.nativeOnly) {
      if (input.takeover || input.model || input.effort || input.permissionProfile
        || input.codexEnvironment || input.remoteMcpUrl || input.developmentMcpUrl) throw new Error("native CLI input cannot change provider ownership or configuration");
      let result: Record<string, unknown> | null = null;
      if (input.provider === "codex" && input.codexHome) result = await this.appendToNativeDaemon(input, session);
      else if (input.provider === "claude") {
        // The registered TUI keeps ownership: type into its exact tmux pane,
        // never resume the session through the SDK beside it.
        const observation = await this.runtime.inspect("claude", session.currentProviderId);
        if (!this.sessions.attachment(session) && !this.startingControllers.get(session)
          && observation?.exactProcessAlive && observation.controlMode === "external_cli") {
          result = await this.appendToExternalCli(input, session, observation);
        }
      } else throw new Error("native CLI input supports Codex and Claude Code sessions");
      if (!result) throw new Error("original native CLI is unavailable; no agent was started");
      if (result.input) await acknowledge(result.input as SessionInputReceipt);
      return result;
    }
    // A normal Codex TUI may predate Runner and every installed hook. Before
    // selecting app-server, force one exact rollout-fd discovery so the first
    // browser action cannot become an accidental second writer merely because
    // the roster was sampled before that process was known.
    if (input.provider === "codex" && input.sessionPath) {
      await this.discover([{
        sessionId: session.currentProviderId,
        sessionPath: input.sessionPath,
        cwd: input.cwd,
      }], true);
    }
    const interaction = this.interactions.publicInteraction(input.provider, session.currentProviderId);
    if (interaction && interaction.status !== "resolved") {
      const error = new Error("这个会话正在等待问题或权限决定；请先处理网页请求卡或本机 CLI 提示");
      (error as Error & { code?: string }).code = "session_needs_input";
      throw error;
    }
    let already = this.sessions.attachment(session) ?? await this.opening.get(session);
    const turnEnded = () => ({ ok: false, code: "turn_not_active", session_id: session.logicalId,
      error: "当前轮次已结束，尚未发送这条消息。" });
    if (input.steerOnly && !already?.controller.turnActive) return turnEnded();
    if (already?.capacityRetry?.waiting) {
      // A human continuation supersedes the scheduled literal continuation.
      // Cancel before awaiting disk, then wait for the old attachment cleanup.
      already.capacityRetry.cancel();
      await this.recoveryJournal?.disarm(input.provider, session, already.turnId);
      await already.controller.interrupt();
      await already.completion;
      await already.controller.close();
      this.sessions.detach(session, already);
      await already.finishRuntime?.().catch(() => {});
      already = undefined;
    }
    if (already) {
      if (already.controller.turnActive) {
        const changeModel = requestedModel && requestedModel !== already.model;
        const changeEffort = requestedEffort && requestedEffort !== already.effort;
        if (changeModel || changeEffort) {
          const selection = changeModel && changeEffort ? "模型或 effort" : changeModel ? "模型" : "effort";
          const error = new Error(`当前托管轮次已经开始，不能在追加消息时更改${selection}；请等这一轮结束后再发送`);
          (error as Error & { code?: string }).code = changeModel
            ? "model_turn_active"
            : "effort_turn_active";
          throw error;
        }
        const prepared = await this.prepareClaudePrompt(
          input.provider,
          session.currentProviderId,
          input.cwd,
          input.prompt,
          input.translatePrompt,
        );
        // Translation can await. Check again at the provider dispatch boundary;
        // Codex's steer-only method also pins the native expectedTurnId.
        if (input.steerOnly && !already.controller.turnActive) return turnEnded();
        const action = input.steerOnly && (already.controller instanceof CodexManagedSession || already.controller instanceof CodexDesktopSession)
          ? (await already.controller.steer(prepared.prompt)
              ? { kind: "steered" as const } : null)
          : await dispatch(already.controller, prepared.prompt);
        if (!action) return turnEnded();
        if (action.kind !== "steered") {
          throw new Error("这个会话已有一轮 Octopus 任务在执行");
        }
        await this.recordClaudePrompt(input.provider, session.currentProviderId, prepared.translation);
        await acknowledge(this.inputReceipt(input.provider, session.currentProviderId, already.transport, "steer", already.turnId));
        return {
          ok: true,
          agent: input.provider,
          session_id: session.logicalId,
          new_session_id: session.currentProviderId,
          transport: already.transport,
          control_action: "steer",
          turn_id: already.turnId,
          cwd: input.cwd,
          duration_ms: 0,
        };
      }
      // Completion and its cleanup run in adjacent microtasks. Never dispatch
      // onto a controller whose old attachment is still briefly projected:
      // that would transfer a fresh prompt and then let the old cleanup close
      // it. Confirm the old controller released before retiring it. A failed
      // dedicated Codex close is the lock condition this ticket exposes; do
      // not hide that attachment and open a second app-server beside it.
      let closeFailed = false;
      try {
        await already.controller.close();
      } catch {
        closeFailed = true;
      }
      if (
        closeFailed
        && already.provider === "codex"
        && already.leaseHolder === "protocol"
        && already.controller instanceof CodexManagedSession
        && already.controller.ownsServerProcess
      ) {
        already.releaseRequired = true;
        const error = new Error("上一轮已经结束，但独立 Codex app-server 尚未释放；请先使用页面中的放锁动作再继续");
        (error as Error & { code?: string }).code = "release_required";
        throw error;
      }
      this.sessions.detach(session, already);
      await already.finishRuntime?.().catch(() => {});
    }

    if (input.provider === "codex" && !input.codexEnvironment && !input.remoteMcpUrl && !input.developmentMcpUrl) {
      const desktop = await CodexDesktopSession.connect(session.currentProviderId, {
        codexHome: input.codexHome, timeoutMs: this.timeoutMs,
      });
      if (desktop) {
        try {
          if (this.recoveryClosed) throw inputNotSent(new Error("Runner is stopping; Codex GUI input was not sent"));
          this.startingControllers.set(session, desktop);
          if (requestedModel || requestedEffort || input.takeover) {
            throw inputNotSent(new Error("此会话由 Codex GUI 持有；请在 GUI 中调整模型和 effort，Runner 保留其权限与所有权"));
          }
          const action = await desktop.dispatch(input.prompt);
          await this.installManagedAttachment({ provider: "codex", session, cwd: input.cwd,
            transport: "app-server", turnId: action.turnId, controller: desktop,
            completion: action.completion.then(normalizeResult), leaseHolder: "terminal" });
          await acknowledge(this.inputReceipt("codex", session.currentProviderId, "app-server",
            action.kind === "steered" ? "protocol_steer" : "protocol_send", action.turnId));
          return { ok: true, agent: "codex", session_id: session.logicalId,
            new_session_id: session.currentProviderId, transport: "app-server",
            control_action: action.kind === "steered" ? "protocol_steer" : "protocol_send",
            turn_id: action.turnId, cwd: input.cwd, duration_ms: 0 };
        } catch (error) {
          await desktop.close();
          // Once a live GUI is selected, an ambiguous acknowledgement must
          // never open a second writer or resend the input through a terminal.
          const failure = error instanceof Error ? error : new Error(String(error));
          (failure as Error & { safeFallback?: boolean }).safeFallback = false;
          throw failure;
        } finally {
          this.startingControllers.delete(session);
        }
      }
    }

    if (input.provider === "codex" && input.codexHome && !input.codexEnvironment && !input.remoteMcpUrl && !input.developmentMcpUrl) {
      const daemon = await this.appendToNativeDaemon(input, session);
      if (daemon) {
        if (daemon.input) await acknowledge(daemon.input as SessionInputReceipt);
        return daemon;
      }
    }
    const observation = await this.runtime.inspect(input.provider, session.currentProviderId);
    const continueWithSelection = async () => {
    let prepared: { prompt: string; translation?: ClaudePromptTranslation };
    if (observation?.exactProcessAlive && observation.controlMode === "external_cli") {
      // A terminal append cannot change the TUI's model/effort. Explicit takeover is
      // different: it first stops this exact CLI, then opens a new managed turn
      // below, where the selected configuration is authoritative.
      if ((requestedModel || requestedEffort) && !input.takeover) {
        const selection = requestedModel && requestedEffort ? "模型或 effort" : requestedModel ? "模型" : "effort";
        const error = new Error(`本机 tmux / 外部 CLI 不支持从 Session+ 更改${selection}；请在该 CLI 中调整，或先结束它再开启托管轮次`);
        (error as Error & { code?: string }).code = requestedModel
          ? "model_external_cli"
          : "effort_external_cli";
        throw error;
      }
      prepared = await this.prepareClaudePrompt(
        input.provider,
        session.currentProviderId,
        input.cwd,
        input.prompt,
        input.translatePrompt,
      );
      if (!input.takeover) {
        const result = await this.appendToExternalCli({ ...input, prompt: prepared.prompt }, session, observation);
        if (result.ok === true) {
          await this.recordClaudePrompt(input.provider, session.currentProviderId, prepared.translation);
        }
        if (result.input) await acknowledge(result.input as SessionInputReceipt);
        return result;
      }
      await preflightAgentExecutable(input.provider);
      await this.takeoverBeforeInput(input.provider, session.currentProviderId);
    } else if (observation?.exactProcessAlive && observation.controlMode === "octopus_headless") {
      // A DETACHED Octopus launch is still writing this session's transcript.
      // Opening a managed resume beside it would put two writers on one session
      // — which is how the same instruction ends up in the log twice. Offer the
      // one honest route instead: stop that CLI, then continue as its owner.
      if (!observation.detached) {
        const error = new Error("这个会话已有一轮 Octopus 托管轮次在执行；请先停止它，或等它结束");
        (error as Error & { code?: string }).code = "session_active";
        throw error;
      }
      if (!input.takeover) {
        const error = new Error(
          "这个会话是 Octopus 在后台启动的 CLI，它仍在运行；普通续跑会和它并发写入同一个会话。请选择“立即接管并发送”。",
        );
        (error as Error & { code?: string }).code = "session_active";
        throw error;
      }
      prepared = await this.prepareClaudePrompt(
          input.provider,
          session.currentProviderId,
        input.cwd,
        input.prompt,
        input.translatePrompt,
      );
      await preflightAgentExecutable(input.provider);
      await this.takeoverBeforeInput(input.provider, session.currentProviderId);
    } else {
      if (input.takeover && input.provider === "codex") {
        const error = new Error(
          "Runner 仍无法把这个会话精确关联到某个本机 Codex CLI；为避免中断其他进程，本次没有重发。请刷新状态，或在本机退出对应 CLI 后使用普通恢复。",
        );
        (error as Error & { code?: string }).code = "session_not_interruptible";
        throw error;
      }
      prepared = await this.prepareClaudePrompt(
        input.provider,
        session.currentProviderId,
        input.cwd,
        input.prompt,
        input.translatePrompt,
      );
    }

    const startedAt = Date.now();
    const attachment = await this.openManaged({
      provider: input.provider,
      session,
      cwd: input.cwd,
      prompt: prepared.prompt,
      resume: true,
      ...(prepared.translation ? { claudeTranslation: prepared.translation } : {}),
      ...(requestedPermissionProfile ? { permissionProfile: requestedPermissionProfile } : {}),
      ...(requestedModel ? { model: requestedModel } : {}),
      ...(requestedEffort ? { effort: requestedEffort } : {}),
      ...(input.codexHome ? { codexHome: input.codexHome } : {}),
      ...(input.recoveryPlacement ? { recoveryPlacement: input.recoveryPlacement } : {}),
      ...(input.remoteMcpUrl ? { remoteMcpUrl: input.remoteMcpUrl } : {}),
      ...(input.developmentMcpUrl ? { developmentMcpUrl: input.developmentMcpUrl } : {}),
      ...(input.codexEnvironment ? { codexEnvironment: input.codexEnvironment } : {}),
    });
    await acknowledge(this.inputReceipt(input.provider, session.currentProviderId, attachment.transport,
      input.takeover ? "takeover" : "managed_resume", attachment.turnId));
    const result = await attachment.completion;
    // Only an explicit provider result may move a managed-resume identity.
    // Controller construction alone is not evidence: a copied-history fork
    // must never masquerade as continuation of a parent-owned Codex child.
    if (result.newSessionId && result.newSessionId !== session.currentProviderId) {
      await this.sessions.rename(input.provider, session.currentProviderId, result.newSessionId);
    }
    return {
      ok: result.ok,
      agent: input.provider,
      session_id: session.logicalId,
      new_session_id: session.currentProviderId,
      ...(result.resultText ? { result_text: tail(result.resultText, 96_000) } : {}),
      ...(result.resultTextEnglish ? { result_text_english: tail(result.resultTextEnglish, 96_000) } : {}),
      ...(result.translationError ? { translation_error: result.translationError } : {}),
      exit_code: result.ok ? 0 : null,
      timed_out: result.timedOut === true,
      ...(result.stderr ? { stderr_tail: tail(result.stderr, 4_000) } : {}),
      ...(result.error ? { error: result.error } : {}),
      transport: attachment.transport,
      control_action: input.takeover ? "takeover" : "managed_resume",
      turn_id: attachment.turnId,
      cwd: input.cwd,
      duration_ms: Date.now() - startedAt,
    };
    };
    return await (input.takeover || !observation?.exactProcessAlive
      ? withAgentExecutable(input.provider, continueWithSelection)
      : continueWithSelection());
  }

  async startManaged(input: StartManagedAgentInput): Promise<ManagedStartResult> {
    const permissionProfile = agentPermissionProfile(input.provider, input.permissionProfile);
    const requestedId = input.provider === "claude" ? input.sessionId ?? randomUUID() : undefined;
    const session = requestedId ? this.sessions.reference(input.provider, requestedId) : undefined;
    // A start has no ledger to inherit a lane from, so an absent flag is a
    // plain Claude launch, not a lookup.
    const prepared = await this.prepareClaudePrompt(
      input.provider,
      "",
      input.cwd,
      input.prompt,
      input.translatePrompt === true,
    );
    const attachment = await this.openManaged({
      provider: input.provider,
      ...(session ? { session } : {}),
      cwd: input.cwd,
      prompt: prepared.prompt,
      resume: false,
      ...(input.onPrepared ? { onPrepared: input.onPrepared } : {}),
      ...(prepared.translation ? { claudeTranslation: prepared.translation } : {}),
      ...(permissionProfile ? { permissionProfile } : {}),
      ...(input.codexHome ? { codexHome: input.codexHome } : {}),
      ...(input.recoveryPlacement ? { recoveryPlacement: input.recoveryPlacement } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      ...(input.remoteMcpUrl ? { remoteMcpUrl: input.remoteMcpUrl } : {}),
      ...(input.developmentMcpUrl ? { developmentMcpUrl: input.developmentMcpUrl } : {}),
      ...(input.codexEnvironment ? { codexEnvironment: input.codexEnvironment } : {}),
    });
    return {
      sessionId: attachment.session.currentProviderId,
      transport: attachment.transport,
      turnId: attachment.turnId,
      completion: attachment.completion,
    };
  }
  /**
   * Resolve which lane this Claude turn runs in, then prepare its prompt.
   *
   * `translate` undefined means "whatever this session already is": a session
   * with ledger rows was started bilingual and stays bilingual. A new session
   * has no rows, so the default is the plain lane — the translator is reached
   * only when somebody asked for it.
   */
  private inputReceipt(provider: AgentProvider, sessionId: string, transport: string, action: string, turnId?: string): SessionInputReceipt {
    return { phase: provider === "claude" ? "local_queued" : "provider_accepted",
      evidence: provider === "claude" ? "local_queue" : "provider_ack",
      at: this.now().toISOString(), session_id: sessionId, transport, control_action: action,
      ...(turnId ? { turn_id: turnId } : {}) };
  }

  /** Stopping the exact CLI precedes opening the managed turn, so its refusal is not an input outcome. */
  private async takeoverBeforeInput(provider: AgentProvider, sessionId: string): Promise<void> {
    try {
      await this.runtime.takeover(provider, sessionId);
    } catch (error) {
      throw inputNotSent(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async prepareClaudePrompt(
    provider: AgentProvider,
    sessionId: string,
    cwd: string,
    prompt: string,
    translate: boolean | undefined,
  ): Promise<{ prompt: string; translation?: ClaudePromptTranslation }> {
    if (provider !== "claude" || !this.claudeTranslations) return { prompt };
    const bilingual = translate ?? (
      Boolean(sessionId) && await this.claudeTranslations.isBilingualSession(sessionId)
    );
    if (!bilingual) return { prompt };
    const translation = await this.claudeTranslations.translateUser(prompt, cwd);
    return { prompt: translation.en, translation };
  }

  private async recordClaudePrompt(
    provider: AgentProvider,
    sessionId: string,
    translation: ClaudePromptTranslation | undefined,
  ): Promise<void> {
    if (provider !== "claude" || !translation || !this.claudeTranslations) return;
    // Prompt ownership has already transferred. A sidecar write failure must
    // not surface as a retryable send failure and duplicate the Claude turn.
    await this.claudeTranslations.recordUser(sessionId, translation).catch(() => {});
  }

  /**
   * Stop the current turn through whatever this session actually is.
   *
   * Two shapes, two mechanisms, deliberately never merged: an attachment this
   * process drives has a provider-level interrupt, and an external CLI in the
   * person's own tmux pane gets ONE stop keystroke. Neither ends a process,
   * closes a pane or throws away a session — a stopped turn is a session you
   * can immediately type into again.
   *
   * Anything else (no pane, or a pane whose CLI is idle) is a refusal with a
   * reason. Guessing here would mean SIGINT-ing an arbitrary foreground
   * program, which is the QUIT path, not the stop path.
   */
  async interruptSession(provider: AgentProvider, sessionId: string): Promise<Record<string, unknown>> {
    return await this.admit(provider, sessionId, () => this.interruptSessionAdmitted(provider, sessionId));
  }

  /** Stop only a registered native CLI's turn; an Octopus-driven turn is not that CLI. */
  async interruptNativeCli(provider: AgentProvider, sessionId: string): Promise<Record<string, unknown>> {
    return await this.admit(provider, sessionId, async () => {
      const session = this.sessions.reference(provider, sessionId);
      const observation = await this.runtime.inspect(provider, session.currentProviderId);
      if (this.sessions.attachment(session) || this.startingControllers.get(session)
        || observation?.controlMode !== "external_cli") {
        throw new Error("this session is currently driven by Octopus, not by the registered native CLI");
      }
      return await this.interruptTerminal(provider, session);
    });
  }

  private async interruptSessionAdmitted(provider: AgentProvider, sessionId: string): Promise<Record<string, unknown>> {
    const session = this.sessions.reference(provider, sessionId);
    const attachment = this.sessions.attachment(session);
    if (!attachment) {
      const recovering = this.recoveringControllers.get(session);
      const waiting = this.recoveryJournal?.current(provider, session.logicalId)?.status === "recovering";
      if (waiting) {
        recovering?.abort();
        await this.recoveryJournal!.disarm(provider, session);
        this.emitManagedTranscriptActivity(provider, session.currentProviderId);
        await this.startingControllers.get(session)?.interrupt();
        return { ok: true, agent: provider, session_id: session.logicalId, control_action: "interrupt_recovery", duration_ms: 0 };
      }
      const starting = this.startingControllers.get(session);
      if (!starting) return await this.interruptTerminal(provider, session);
      await starting.interrupt();
      return { ok: true, agent: provider, session_id: session.logicalId,
        control_action: "interrupt_pending", duration_ms: 0 };
    }
    this.interactions.cancel(provider, session.currentProviderId);
    attachment.capacityRetry?.cancel();
    await this.recoveryJournal?.disarm(provider, session, attachment.turnId);
    await attachment.controller.interrupt();
    return {
      ok: true,
      agent: provider,
      session_id: session.logicalId,
      new_session_id: session.currentProviderId,
      transport: attachment.transport,
      control_action: "interrupt",
      turn_id: attachment.turnId,
      cwd: attachment.cwd,
      duration_ms: 0,
    };
  }

  /**
   * Retry cleanup of one settled, process-owned Codex attachment.
   *
   * This is deliberately not a generic "unlock" or host restart. The target
   * must be the exact attachment retained after automatic close failed; shared
   * app-server hosts, terminal leases, live turns and every other provider are
   * structurally outside the action.
   */
  async releaseSession(provider: AgentProvider, sessionId: string): Promise<Record<string, unknown>> {
    return await this.admit(provider, sessionId, () => this.releaseSessionAdmitted(provider, sessionId));
  }

  private async releaseSessionAdmitted(provider: AgentProvider, sessionId: string): Promise<Record<string, unknown>> {
    if (provider !== "codex") {
      const error = new Error("只有 Codex 会话可能持有可手动释放的 app-server 占用");
      (error as Error & { code?: string }).code = "release_not_supported";
      throw error;
    }
    const session = this.sessions.reference(provider, sessionId);
    const attachment = this.sessions.attachment(session);
    // The auto-close may win after the page rendered its warning. Treat that
    // race as idempotent success instead of asking the person to retry a
    // release that has already happened.
    if (!attachment) {
      return {
        ok: true,
        agent: provider,
        session_id: session.logicalId,
        new_session_id: session.currentProviderId,
        transport: "app-server",
        control_action: "release_control",
        released: false,
        message: "这份后台占用已经释放。",
        duration_ms: 0,
      };
    }
    if (
      !attachment.releaseRequired
      || attachment.leaseHolder !== "protocol"
      || !(attachment.controller instanceof CodexManagedSession)
      || !attachment.controller.ownsServerProcess
    ) {
      const error = new Error("当前会话没有可手动释放的独立 Codex 后台占用");
      (error as Error & { code?: string }).code = "release_not_available";
      throw error;
    }
    if (attachment.controller.turnActive) {
      const error = new Error("Codex 托管轮次仍在执行；请先停止或等待完成，不能把放锁当作中断");
      (error as Error & { code?: string }).code = "session_active";
      throw error;
    }
    const startedAt = Date.now();
    try {
      await attachment.controller.close();
    } catch (cause) {
      const error = new Error(`独立 Codex app-server 仍未退出：${cause instanceof Error ? cause.message : String(cause)}`);
      (error as Error & { code?: string }).code = "release_failed";
      throw error;
    }
    this.sessions.detach(session, attachment);
    await attachment.finishRuntime?.().catch(() => {});
    return {
      ok: true,
      agent: provider,
      session_id: session.logicalId,
      new_session_id: session.currentProviderId,
      transport: attachment.transport,
      control_action: "release_control",
      released: true,
      turn_id: attachment.turnId,
      cwd: attachment.cwd,
      duration_ms: Date.now() - startedAt,
    };
  }

  /** Whether a released Claude Code question could be answered in this session's terminal. */
  async claudeQuestionReachable(sessionId: string): Promise<boolean> {
    const inspection = await this.runtime.inspect("claude", sessionId);
    return Boolean(inspection?.exactProcessAlive && inspection.controlMode === "external_cli"
      && inspection.process && await this.tmuxPane(inspection.process.pid));
  }

  /**
   * Answer a question the Claude Code TUI shows as its own dialog: close the
   * dialog with one Escape, then send the answer as an ordinary prompt. The
   * transcript is the receipt for both steps, first the question's
   * tool_result, then the prompt. Neither step is repeated when its receipt
   * does not appear: a second Escape or a resent answer would act on a
   * terminal whose state is no longer known.
   */
  async answerClaudeQuestion(sessionId: string, question: ClaudeOpenQuestion, prompt: string | null): Promise<void> {
    const ended = () => claudeToolCallEnded(question.transcriptPath, question.transcriptOffset, question.toolUseId);
    const inspection = await this.runtime.inspect("claude", sessionId);
    const identity = inspection?.exactProcessAlive ? inspection.process : undefined;
    if (!identity) throw inputNotSent(new Error("Claude Code 已经退出，这个问题无法再回答"));
    if (await ended()) throw inputNotSent(new Error("这个问题已经在终端里回答或取消了"));
    const pane = await this.tmuxPaneForWrite(identity.pid);
    if (!pane) throw inputNotSent(new Error("Runner 无法证明这个 Claude Code 独占一个 tmux pane；请在它的终端里回答"));
    // Leaving copy mode was an await boundary; prove the same CLI and the same
    // open question immediately before the key.
    const current = await this.runtime.inspect("claude", sessionId);
    if (!current?.exactProcessAlive || current.process?.pid !== identity.pid
      || current.process.startTicks !== identity.startTicks || current.process.bootId !== identity.bootId) {
      throw inputNotSent(new Error("目标 Claude Code 在回答前已经退出或换成了另一个进程；没有发送任何按键"));
    }
    if (await ended()) throw inputNotSent(new Error("这个问题已经在终端里回答或取消了"));
    await this.terminal.interrupt(pane);
    let closed = false;
    for (let waited = 0; !closed && waited < CLAUDE_QUESTION_CLOSE_MS; waited += CLAUDE_QUESTION_CLOSE_POLL_MS) {
      closed = await ended();
      if (!closed) await new Promise((resolve) => setTimeout(resolve, CLAUDE_QUESTION_CLOSE_POLL_MS));
    }
    if (!closed) {
      throw new Error("已在终端按下一次 Esc，但 Claude 的会话记录里没有出现选择框关闭的记录，所以没有发送答案；请到本机 CLI 核对。");
    }
    if (!prompt) return;
    const receipt = await ClaudeInputReceipt.open(question.transcriptPath, prompt);
    try {
      await this.terminal.append(pane, prompt, receipt ? {
        confirmTimeoutMs: CLAUDE_TRANSCRIPT_CONFIRM_MS,
        confirmSubmitted: async () => Boolean(await receipt.check()),
      } : undefined);
    } catch (error) {
      if (!(error instanceof TerminalSubmissionUnconfirmedError)) throw error;
      throw new Error("选择框已关闭，答案和一次回车也已送进 tmux，但 Claude 的会话记录里还没有出现这条消息；不会自动重发，请到本机 CLI 核对。");
    }
  }

  /**
   * The external-CLI half of `interruptSession`: one Escape into the exact
   * pane the hook-observed process owns.
   *
   * `turn_state === "working"` is a precondition, not politeness. In an idle
   * TUI the same key clears whatever the person had half-typed in the
   * composer, so "stop" would silently destroy input nobody asked us to touch.
   * Unconfirmed stays unconfirmed: the pane is theirs to look at, and a second
   * press is exactly the one that would do the damage above.
   */
  private async interruptTerminal(
    provider: AgentProvider,
    session: ProviderSessionRef,
  ): Promise<Record<string, unknown>> {
    const startedAt = Date.now();
    const inspection = await this.runtime.inspect(provider, session.currentProviderId);
    const external = Boolean(inspection?.exactProcessAlive && inspection.controlMode === "external_cli");
    // A DETACHED Octopus launch (`claude -p` / `codex exec` started in the
    // background, or anything restored after a Runner restart) is the third
    // shape. It has no attachment to interrupt and no pane to type into, but
    // it is also nobody's foreground TUI: there is no draft to lose and no
    // window to leave empty, so the registry's existing SIGINT → SIGTERM stop
    // (which refuses to escalate to SIGKILL) is the right and only mechanism.
    // Same signals the takeover path already used — minus the prompt takeover
    // made mandatory, which is what forced "stop this" to be "stop this and
    // say something new".
    if (!external && inspection?.exactProcessAlive && inspection.detached) {
      await this.runtime.takeover(provider, session.currentProviderId);
      return {
        ok: true,
        agent: provider,
        session_id: session.logicalId,
        new_session_id: session.currentProviderId,
        transport: "exec",
        control_action: "detached_stop",
        confirmed: true,
        duration_ms: Date.now() - startedAt,
      };
    }
    if (!external || !inspection?.process) {
      const error = new Error("这个会话当前没有可中断的轮次：既没有 Octopus 托管 attachment，也没有在跑的本机 CLI");
      (error as Error & { code?: string }).code = "session_not_managed";
      throw error;
    }
    if (inspection.turnState !== "working") {
      const error = new Error("本机 CLI 当前没有在执行的轮次；停止键会清空 CLI 里没发出的输入，所以不发送。");
      (error as Error & { code?: string }).code = "session_not_working";
      throw error;
    }
    const pane = await this.tmuxPane(inspection.process.pid, true);
    if (!pane) {
      const error = new Error("Runner 无法证明这个 CLI 独占一个 tmux pane；请直接在该终端里按 Esc 停止它。");
      (error as Error & { code?: string }).code = "session_not_interruptible";
      throw error;
    }
    const current = await this.runtime.inspect(provider, session.currentProviderId);
    if (!current?.exactProcessAlive || current.turnState !== "working"
      || current.process?.pid !== inspection.process.pid
      || current.process?.startTicks !== inspection.process.startTicks
      || current.process?.bootId !== inspection.process.bootId) {
      throw inputNotSent(new Error("目标 CLI 在停止前已经结束或换成了另一个进程；本次没有发送停止键"));
    }
    const { confirmed } = await this.terminal.interrupt(pane);
    // The TUI visibly stopped, and Claude Code reports no hook for an
    // interrupted turn: record the end here so the session stops reading as working.
    if (confirmed) await this.runtime.observeTurnEnded(provider, session.currentProviderId,
      { unchangedSince: current.observedAt, identity: current.process });
    return {
      ok: true,
      agent: provider,
      session_id: session.logicalId,
      new_session_id: session.currentProviderId,
      transport: "tmux",
      control_action: "terminal_interrupt",
      confirmed,
      ...(confirmed ? {} : {
        message: "停止键已送达 tmux pane，但界面没有可见变化，无法确认它是否已停下；未重复发送。请到该 CLI 里确认。",
      }),
      duration_ms: Date.now() - startedAt,
    };
  }

  async publicRuntime(provider: AgentProvider, sessionId: string): Promise<PublicAgentControlRuntime | undefined> {
    const session = this.sessions.reference(provider, sessionId);
    const active = this.sessions.attachment(session);
    const recovery = this.recoveryJournal?.current(provider, session.logicalId);
    // After a restart there may be no process observation at all. Ending a
    // durable recovery is still a new lifecycle fact: omitting the runtime
    // would leave the browser's older waiting snapshot as its newest fact.
    const observed = this.runtime.publicRuntime(provider, session.currentProviderId)
      ?? (recovery?.status === "idle" ? {
        ...unknownRuntime(this.now()), turn_state: "idle" as const,
        control_mode: "octopus_headless" as const, event: "ManagedIdle",
      } : undefined);
    if (active) {
      const base = observed ?? unknownRuntime(this.now());
      const capacity = active.capacityRetry?.waiting ? active.capacityRetry.state : undefined;
      const turnActive = active.controller.turnActive || Boolean(capacity);
      const releaseControl = Boolean(
        active.releaseRequired
        && !turnActive
        && active.provider === "codex"
        && active.leaseHolder === "protocol"
        && active.controller instanceof CodexManagedSession
        && active.controller.ownsServerProcess,
      );
      return {
        ...base,
        process_state: "alive",
        turn_state: turnActive ? "working" : "idle",
        control_mode: active.leaseHolder === "terminal" ? "external_cli" : "octopus_headless",
        observed_at: this.now().toISOString(),
        event: releaseControl
          ? "ProtocolReleaseRequired"
          : active.leaseHolder === "terminal" ? "ProtocolBridge" : "ProtocolTurn",
        ...(capacity ? { recovery: capacityRuntime(capacity) } : {}),
        attachment: {
          kind: MANAGED_ATTACHMENT_KIND[active.transport],
          state: "attached",
          transport: active.transport,
        },
        control_lease: { holder: active.leaseHolder, acquired_at: active.startedAt },
        turn: { state: turnActive ? "working" : "idle", id: active.turnId, started_at: active.startedAt },
        capabilities: {
          ...base.capabilities,
          append_when_idle: false,
          takeover: false,
          interrupt: turnActive,
          steer: turnActive && !capacity,
          terminal_append: false,
          managed_resume: false,
          protocol_append: turnActive && !capacity,
          release_control: releaseControl,
          terminal_interrupt: false,
        },
      };
    }
    const daemon = provider === "codex" ? this.codexDaemon.runtime(session.currentProviderId) : undefined;
    if (daemon) {
      // The daemon owns turn/protocol facts; a hook can independently prove
      // which TUI is in tmux. In particular, socket discovery needs `ss`,
      // which is optional on minimal Linux installations. Never infer a pane
      // from a shared daemon, cwd or account: inspect this exact session PID.
      const inspection = await this.runtime.inspect(provider, session.currentProviderId);
      const pane = inspection?.exactProcessAlive && inspection.controlMode === "external_cli" && inspection.process
        ? await this.tmuxPane(inspection.process.pid)
        : null;
      return pane
        ? { ...daemon, attachment: { kind: "terminal_tmux", state: "attached", transport: "tmux" } }
        : daemon;
    }
    if (recovery?.status === "recovering" || recovery?.status === "unknown") {
      const base = observed ?? unknownRuntime(this.now());
      const manualResume = recovery.status === "unknown" && base.process_state !== "alive";
      return { ...base, turn_state: "unknown", control_mode: "octopus_headless",
        observed_at: this.now().toISOString(), event: "ManagedRecovery",
        recovery: recovery.status !== "unknown" && recovery.capacityRetry
          ? capacityRuntime(recovery.capacityRetry)
          : { state: recovery.status === "unknown" ? "unknown"
          : dependencyWait(Date.parse(recovery.unavailableSince ?? recovery.updatedAt), this.now().getTime()).state,
          ...(recovery.unavailableSince ? { since: recovery.unavailableSince } : {}),
          ...(recovery.nextRetryAt ? { retry_at: recovery.nextRetryAt } : {}) },
        attachment: { kind: "none", state: "detached" }, control_lease: { holder: "none" }, turn: { state: "unknown" },
        capabilities: { ...base.capabilities, observe: true, append_when_idle: manualResume, takeover: false,
          interrupt: recovery.status === "recovering", steer: false, terminal_append: false, managed_resume: manualResume,
          protocol_append: false, release_control: false, terminal_interrupt: false } };
    }
    if (!observed) return undefined;

    const inspection = await this.runtime.inspect(provider, session.currentProviderId);
    const external = Boolean(inspection?.exactProcessAlive && inspection.controlMode === "external_cli");
    const cooperativeProtocol = Boolean(
      external
      && provider === "codex"
      && inspection?.process?.codexRemoteEndpoint
      && inspection.process.codexRemoteEndpoint === this.codexHost?.currentEndpoint,
    );
    const nativeQueue = external && provider === "codex" && !inspection?.process?.codexRemoteEndpoint
      && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(session.currentProviderId);
    const pane = external && inspection?.process
      ? await this.tmuxPane(inspection.process.pid)
      : null;
    // A cheap status probe is allowed to miss an idle discovered omp pane.
    // Advertise an ordinary best-effort send only for that narrow case: the
    // write path force-probes tmux, revalidates the exact process identity,
    // submits once, and reports an unconfirmed/failed attempt instead of
    // replaying or silently taking ownership. Codex uses its native queue;
    // the send path validates its account, protocol and exact process again.
    const bestEffortIdleTerminal = Boolean(
      external && provider === "omp" && inspection?.turnState === "idle",
    );
    const terminalAppend = Boolean(
      !nativeQueue && inspection?.turnState !== "needs_input" && (pane || bestEffortIdleTerminal),
    );
    // Stopping a turn asks for MORE proof than appending to one, not less: the
    // pane must be the proven exclusive one (no best-effort probe stands in for
    // it) and the CLI must actually be working, because the same key in an idle
    // TUI clears the person's unsent draft. `interrupt` is otherwise `false`
    // for every observed CLI, which is the older, narrower rule this widens by
    // exactly one proven case.
    const terminalInterrupt = Boolean(pane && inspection?.turnState === "working");
    // The detached launch's stop needs no turn-state proof: it is a background
    // process, so "stop it" is unambiguous whatever the hook last reported.
    const detachedStoppable = Boolean(!external && inspection?.exactProcessAlive && inspection.detached);
    const protocolAppend = (cooperativeProtocol || nativeQueue) && inspection?.turnState !== "needs_input";
    return {
      ...observed,
      // The stop/completion can be newer than the last provider hook. Publish
      // that timestamp so a stale roster cannot win over this cleared state.
      ...(recovery?.status === "idle" && Date.parse(recovery.updatedAt) > Date.parse(observed.observed_at)
        ? { observed_at: recovery.updatedAt } : {}),
      attachment: external
        ? cooperativeProtocol
          ? { kind: "codex_app_server", state: "attached", transport: "app-server" }
          : pane
          ? { kind: "terminal_tmux", state: "attached", transport: "tmux" }
          // omp is DISCOVERED, never hook-reported. Calling that a hook
          // observer would tell an operator to go looking for a hook install
          // that does not exist and is not missing.
          : { kind: provider === "omp" ? "omp_terminal" : "hook_observer", state: "observed" }
        : observed.control_mode === "octopus_headless"
          ? { kind: "legacy_exec", state: observed.process_state === "alive" ? "attached" : "detached", transport: "exec" }
          : { kind: "none", state: "detached" },
      control_lease: { holder: external ? "terminal" : "none" },
      turn: { state: observed.turn_state },
      capabilities: {
        ...observed.capabilities,
        append_when_idle: !external && observed.process_state !== "alive",
        steer: false,
        interrupt: terminalInterrupt || detachedStoppable,
        terminal_append: terminalAppend,
        managed_resume: !external && observed.process_state !== "alive",
        protocol_append: protocolAppend,
        release_control: false,
        terminal_interrupt: terminalInterrupt,
      },
    };
  }

  async close(options: { preserveRecoveries?: boolean } = {}): Promise<void> {
    if (options.preserveRecoveries) this.prepareForRestart();
    this.recoveryClosed = true;
    if (!this.preserveRecoveries) {
      for (const attachment of this.sessions.values()) attachment.capacityRetry?.cancel();
    }
    for (const controller of this.recoveringControllers.values()) controller.abort();
    await this.recoveryFlight;
    await Promise.allSettled([...this.startingControllers.values()].map((controller) => controller.close()));
    this.startingControllers.clear();
    for (const attachment of this.sessions.values()) {
      if (this.preserveRecoveries) attachment.capacityRetry?.suspend();
      else attachment.capacityRetry?.cancel();
      if (!this.preserveRecoveries) {
        await this.recoveryJournal?.disarm(
          attachment.provider,
          attachment.session,
          attachment.turnId,
        ).catch(() => {});
      }
      await attachment.controller.close().catch(() => {});
      await attachment.finishRuntime?.().catch(() => {});
    }
    this.sessions.clearAttachments();
    await this.recoveryJournal?.flush();
    await this.codexHost?.close().catch(() => {});
  }

  private nativeCodexResult(input: ContinueAgentSessionInput, session: ProviderSessionRef,
    submitted: CodexQueueSubmission, started: number): Record<string, unknown> {
    const accepted = submitted.turnId !== undefined;
    const transport = accepted ? "app-server" : "codex-queue";
    const action = submitted.controlAction ?? "native_queue";
    return { ok: true, agent: "codex", session_id: session.logicalId, new_session_id: submitted.sessionId,
      transport, control_action: action,
      ...(accepted ? { turn_id: submitted.turnId } : { queued_submission_id: submitted.queuedSubmissionId }),
      input: { phase: accepted ? "provider_accepted" : "local_queued", evidence: accepted ? "provider_ack" : "local_queue",
        at: this.now().toISOString(), session_id: submitted.sessionId,
        ...(accepted ? { turn_id: submitted.turnId } : {}), transport, control_action: action } satisfies SessionInputReceipt,
      cwd: input.cwd, duration_ms: Date.now() - started };
  }

  private async appendToNativeDaemon(input: ContinueAgentSessionInput, session: ProviderSessionRef): Promise<Record<string, unknown> | null> {
    let connection: CodexDaemonConnection | null | undefined;
    try {
      connection = await this.codexDaemon.connect(input.codexHome!);
      if (!connection || !(await connection.loaded()).includes(session.currentProviderId)) return null;
      const thread = await connection.thread(session.currentProviderId);
      if (!thread || (input.sessionPath && await fs.realpath(thread.path) !== await fs.realpath(input.sessionPath))) {
        throw new Error("原生 daemon 会话身份不匹配或不接受独立输入；尚未发送");
      }
      if (input.takeover || input.model || input.effort) {
        throw new Error("此会话由 Codex 共享 daemon 持有；请在 CLI 调整设置，使用普通发送继续，不接管共享进程");
      }
      const current = connection;
      const started = Date.now();
      const queued = await this.queueCodexPrompt({ sessionId: session.currentProviderId, codexHome: input.codexHome!,
        prompt: input.prompt, cwd: input.cwd, client: current.client, timeoutMs: 10_000,
        beforeSubmit: async () => {
          await current.revalidate();
          const latest = await current.thread(session.currentProviderId);
          if (this.recoveryClosed || !latest || latest.path !== thread.path
            || !["idle", "working"].includes(latest.turnState)
            || !(await current.loaded()).includes(session.currentProviderId)
            || this.interactions.publicInteraction("codex", session.currentProviderId)?.status === "pending") {
            throw new Error("daemon 会话已变化或正在等待决定；尚未发送");
          }
        } });
      return this.nativeCodexResult(input, session, queued, started);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      // The native adapter classifies post-write ambiguity itself. Earlier
      // identity/setup refusals are definitive; throwing would erase that fact
      // at the durable RPC boundary and strand them as unknown.
      return { ok: false, code: failure instanceof CodexQueueError ? failure.code : "codex_input_unavailable",
        error: failure.message, session_id: session.logicalId, transport: "app-server", control_action: "native_input" };
    } finally { await connection?.close().catch(() => {}); }
  }

  private async appendToExternalCli(
    input: ContinueAgentSessionInput,
    session: ProviderSessionRef,
    observation: AgentRuntimeInspection,
  ): Promise<Record<string, unknown>> {
    if (observation.turnState === "needs_input") {
      const error = new Error("本机 CLI 正在等待问题或权限决定；请先在 CLI 或网页请求卡中处理它");
      (error as Error & { code?: string }).code = "session_needs_input";
      throw error;
    }
    const identity = observation.process;
    // An opt-in `octopus-codex` TUI is already attached to the Runner's shared
    // app-server. Rejoin that running thread and steer it through the native
    // protocol before considering terminal input. A normal Codex CLI is not
    // loaded in this server and falls through without changing ownership.
    if (input.provider === "codex" && this.codexHost && identity?.codexRemoteEndpoint) {
      const cooperative = await this.tryCooperativeCodex(input, session, identity.codexRemoteEndpoint);
      if (cooperative) return cooperative;
    }
    if (input.provider === "codex" && identity && !identity.codexRemoteEndpoint
      && input.codexHome
      && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(session.currentProviderId)) {
      // A remote TUI belongs to its server, not necessarily this local home.
      // Cooperative servers were handled above. The queue route is reserved
      // for a trusted account root and a complete provider thread UUID.
      try {
        const queueStarted = Date.now();
        const queued = await this.queueCodexPrompt({
          sessionId: session.currentProviderId, codexHome: input.codexHome,
          prompt: input.prompt, cwd: input.cwd,
          timeoutMs: this.timeoutMs > 0 ? Math.min(this.timeoutMs, 30_000) : 30_000,
          beforeSubmit: async () => {
            const current = await this.runtime.inspect("codex", session.currentProviderId);
            if (this.recoveryClosed || !current?.exactProcessAlive || current.controlMode !== "external_cli"
              || current.process?.pid !== identity.pid || current.process.startTicks !== identity.startTicks
              || current.process.bootId !== identity.bootId || current.turnState === "needs_input"
              || this.interactions.publicInteraction("codex", session.currentProviderId)?.status === "pending") {
              throw new CodexQueueError("目标 CLI 已变化或正在等待决定；尚未发送输入");
            }
          },
        });
        return this.nativeCodexResult(input, session, queued, queueStarted);
      } catch (error) {
        // An uncertain submission never grants authority for another writer.
        const failure = error instanceof Error ? error : new Error(String(error));
        if ((failure as { code?: string }).code === "unknown") return {
          ok: false, code: "unknown", error: failure.message, session_id: session.logicalId,
          transport: "codex-queue", control_action: "native_queue",
        };
        // Only an explicit method-unsupported response, received before
        // queue/add, permits the legacy pane compatibility route. Every other
        // failure remains terminal and cannot cause a duplicate send.
        if (!(failure instanceof CodexQueueError && failure.code === "codex_queue_unsupported"
          && failure.safeFallback === true)) {
          if (failure instanceof CodexQueueError) return { ok: false, code: failure.code,
            error: failure.message, session_id: session.logicalId, transport: "codex-queue", control_action: "native_queue" };
          Object.assign(failure, { safeFallback: false });
          throw failure;
        }
      }
    }
    // Everything below writes keystrokes into a TUI and gets no receipt back.
    // An identical prompt inside the resend window is treated as the person
    // asking again because the first one looked lost — answer that question
    // instead of stacking a second copy into the same composer.
    const promptHash = terminalPromptHash(input.prompt);
    const sendKey = terminalSendKey(input.provider, session.logicalId, promptHash);
    const priorSendAgeMs = this.recentTerminalSend(input.provider, session, sendKey, promptHash, observation.observedAt);
    if (priorSendAgeMs !== null) {
      const error = new Error(
        `同样的内容 ${Math.max(1, Math.round(priorSendAgeMs / 1000))} 秒前已经送进这台设备的 CLI，`
        + "没有再送一次以免同一句话重复出现。请到 CLI 里确认它是停在输入框还是已经在跑；"
        + "要让 Octopus 接手这轮，请选择“交给 Octopus 托管”。",
      );
      (error as Error & { code?: string }).code = "duplicate_terminal_send";
      throw error;
    }
    if (!identity) {
      const error = new Error("原 CLI 仍在运行，但 Runner 无法证明它独占一个可写 tmux pane；可继续在 CLI 输入，或显式选择“交给 Octopus 托管”。");
      (error as Error & { code?: string }).code = "session_active";
      throw error;
    }
    const stillSameCli = (current: AgentRuntimeInspection | undefined): current is AgentRuntimeInspection => Boolean(
      current?.exactProcessAlive && current.process?.pid === identity.pid
      && current.process.startTicks === identity.startTicks && current.process.bootId === identity.bootId,
    );
    // Copy-mode cancellation changes tmux state. Prove the process identity
    // immediately before that mutation, not only before the later paste.
    const beforePane = await this.runtime.inspect(input.provider, session.currentProviderId);
    if (beforePane?.turnState === "needs_input") throw Object.assign(new Error("本机 CLI 正在等待问题或权限决定；尚未发送输入"), { code: "session_needs_input" });
    if (!stillSameCli(beforePane)) {
      throw inputNotSent(new Error("目标 CLI 在发送前已经退出或换成了另一个进程；请刷新后重试"));
    }
    const pane = await this.tmuxPaneForWrite(identity.pid);
    if (!pane) {
      const error = new Error("原 CLI 仍在运行，但 Runner 无法证明它独占一个可写 tmux pane；可继续在 CLI 输入，或显式选择“交给 Octopus 托管”。");
      (error as Error & { code?: string }).code = "session_active";
      throw error;
    }
    // Close the pid-reuse window again after returning the pane to its live
    // tail and immediately before the actual write.
    const current = await this.runtime.inspect(input.provider, session.currentProviderId);
    if (current?.turnState === "needs_input") throw Object.assign(new Error("本机 CLI 正在等待问题或权限决定；尚未发送输入"), { code: "session_needs_input" });
    if (!stillSameCli(current)) {
      throw inputNotSent(new Error("目标 CLI 在发送前已经退出或换成了另一个进程；请刷新后重试"));
    }
    const startedAt = Date.now();
    const requireCodexHookConfirmation = input.provider === "codex" && observation.turnState === "idle";
    // Claude records each input it accepts; that record, not a pane redraw, is
    // the receipt for these keystrokes. Its end is marked before the write.
    const transcript = input.provider === "claude" && input.sessionPath && session.currentProviderId === input.sessionId
      ? await ClaudeInputReceipt.open(input.sessionPath, input.prompt) : null;
    let claudeInput: ClaudeInputPhase | null = null;
    let confirmedObservedAt = current.observedAt;
    let confirmedSessionId = session.currentProviderId;
    try {
      await this.terminal.append(pane, input.prompt, transcript ? {
        composerGlyphs: CLAUDE_COMPOSER_GLYPHS,
        confirmTimeoutMs: CLAUDE_TRANSCRIPT_CONFIRM_MS,
        confirmSubmitted: async () => Boolean(claudeInput = await transcript.check()),
      } : input.provider === "claude" ? {
        composerGlyphs: CLAUDE_COMPOSER_GLYPHS,
      } : requireCodexHookConfirmation ? {
        confirmSubmitted: async () => {
          const confirmed = await this.runtime.inspect(input.provider, session.currentProviderId);
          if (stillSameCli(confirmed) && confirmed.observedAt !== current.observedAt) {
            // A fresh device hook for the same exact CLI is stronger than a pane
            // redraw: Codex fires UserPromptSubmit (or a later lifecycle hook)
            // only after Enter crossed its composer boundary.
            confirmedObservedAt = confirmed.observedAt;
            return true;
          }
          // Codex can switch threads inside one long-lived TUI. The hook then
          // correctly removes process authority from the old session before
          // attaching it to the new one. Accept that hook as the same receipt
          // only when the runtime proves one exact-process rebound; cwd/tty
          // similarity alone is deliberately insufficient.
          const rebound = await this.runtime.reboundSession(
            input.provider,
            session.currentProviderId,
            identity,
          );
          if (!rebound) return false;
          await this.sessions.rename(input.provider, session.currentProviderId, rebound.sessionId);
          confirmedObservedAt = rebound.observedAt;
          confirmedSessionId = session.currentProviderId;
          return true;
        },
      } : undefined);
      await this.rememberTerminalSend(
        input.provider,
        session,
        sendKey,
        promptHash,
        confirmedObservedAt,
      );
    } catch (error) {
      if (!(error instanceof TerminalSubmissionUnconfirmedError)) throw error;
      // Unconfirmed means indeterminate, which is exactly when a resend is most
      // tempting and most dangerous. Remember it like a confirmed one.
      await this.rememberTerminalSend(
        input.provider,
        session,
        sendKey,
        promptHash,
        current.observedAt,
      );
      const detail = transcript
        ? "文字和一次回车已送进 tmux，但 Claude 的会话记录里还没有出现这条输入（可能停在输入框里，或 CLI 正弹出选择框）；不会自动重发。它一出现在会话记录里就会自动确认；也可以到本机 CLI 核对。"
        : requireCodexHookConfirmation
        ? "文字和一次回车已送进 tmux，但 Runner 没有收到这个 Codex 会话的新 hook，无法确认输入框里的文字是否真正提交；不会自动重发。请到本机 CLI 核对，或在确认本轮没有执行后选择“交给 Octopus 托管”。"
        : error.message;
      const controlAction = observation.turnState === "working" ? "terminal_queue" : "terminal_send";
      if (transcript && input.onInput) {
        void this.followClaudeInput(transcript, input.onInput, session.currentProviderId, controlAction);
      }
      return {
        ok: false,
        code: "unknown",
        input: { phase: "dispatched", evidence: "terminal_write", at: this.now().toISOString(),
          session_id: session.currentProviderId, transport: "tmux", control_action: "terminal_send" } satisfies SessionInputReceipt,
        error: detail,
        agent: input.provider,
        session_id: session.logicalId,
        new_session_id: session.currentProviderId,
        transport: "tmux",
        control_action: observation.turnState === "working" ? "terminal_queue" : "terminal_send",
        cwd: input.cwd,
        duration_ms: Date.now() - startedAt,
      };
    }
    return {
      ok: true,
      agent: input.provider,
      session_id: session.logicalId,
      new_session_id: confirmedSessionId,
      input: { phase: claudeInput ?? (requireCodexHookConfirmation ? "input_observed" : "dispatched"),
        evidence: claudeInput ? "transcript" : requireCodexHookConfirmation ? "native_hook" : "terminal_write", at: this.now().toISOString(),
        session_id: confirmedSessionId, transport: "tmux",
        control_action: observation.turnState === "working" ? "terminal_queue" : "terminal_send" } satisfies SessionInputReceipt,
      transport: "tmux",
      control_action: observation.turnState === "working" ? "terminal_queue" : "terminal_send",
      cwd: input.cwd,
      duration_ms: Date.now() - startedAt,
    };
  }

  /**
   * Keep looking for an unconfirmed Claude input in its transcript, and record
   * it on the original receipt once it appears — a prompt left in the composer
   * and submitted by hand later, or a TUI that took longer than the inline
   * wait. Observation only: nothing is ever sent again.
   */
  private async followClaudeInput(
    transcript: ClaudeInputReceipt,
    onInput: (receipt: SessionInputReceipt) => Promise<void>,
    sessionId: string,
    controlAction: string,
  ): Promise<void> {
    const until = this.now().getTime() + CLAUDE_TRANSCRIPT_FOLLOW_MS;
    while (!this.recoveryClosed && this.now().getTime() < until) {
      await new Promise((resolve) => setTimeout(resolve, CLAUDE_TRANSCRIPT_FOLLOW_POLL_MS).unref?.());
      const phase = await transcript.check();
      if (!phase) continue;
      await onInput({ phase, evidence: "transcript", at: this.now().toISOString(), session_id: sessionId,
        transport: "tmux", control_action: controlAction }).catch(() => {});
      return;
    }
  }

  /**
   * Age of an identical submission the device has seen NOTHING happen since.
   *
   * A changed observation clock is the CLI reacting to something, which is the
   * only cheap evidence available that the earlier copy was consumed rather
   * than parked. It re-opens the resend; an unchanged clock does not.
   */
  private recentTerminalSend(
    provider: AgentProvider,
    session: ProviderSessionRef,
    key: string,
    promptHash: string,
    observedAt: string,
  ): number | null {
    if (this.recoveryJournal) {
      return this.recoveryJournal.recentTerminalSend(
        provider,
        session,
        promptHash,
        observedAt,
        TERMINAL_RESEND_WINDOW_MS,
      );
    }
    const prior = this.terminalSends.get(key);
    if (!prior) return null;
    const age = this.now().getTime() - prior.at;
    if (age < 0 || age >= TERMINAL_RESEND_WINDOW_MS || prior.observedAt !== observedAt) {
      this.terminalSends.delete(key);
      return null;
    }
    return age;
  }

  private async rememberTerminalSend(
    provider: AgentProvider,
    session: ProviderSessionRef,
    key: string,
    promptHash: string,
    observedAt: string,
  ): Promise<void> {
    if (this.recoveryJournal) {
      // Prompt ownership has crossed the receipt-less terminal boundary. A
      // sidecar write failure must not turn this into a retryable send error.
      await this.recoveryJournal.rememberTerminalSend(
        provider,
        session,
        promptHash,
        observedAt,
        TERMINAL_RESEND_WINDOW_MS,
        TERMINAL_RESEND_MAX,
      ).catch(() => {});
      return;
    }
    const at = this.now().getTime();
    for (const [row, prior] of this.terminalSends) {
      if (at - prior.at >= TERMINAL_RESEND_WINDOW_MS) this.terminalSends.delete(row);
    }
    // Re-insert so the Map stays ordered oldest-first for the size bound.
    this.terminalSends.delete(key);
    this.terminalSends.set(key, { at, observedAt });
    while (this.terminalSends.size > TERMINAL_RESEND_MAX) {
      const oldest = this.terminalSends.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.terminalSends.delete(oldest);
    }
  }

  private async tryCooperativeCodex(
    input: ContinueAgentSessionInput,
    session: ProviderSessionRef,
    observedEndpoint: string,
  ): Promise<Record<string, unknown> | null> {
    let controller: CodexManagedSession | null = null;
    let prepared = false;
    let promptTransferred = false;
    try {
      const endpoint = await this.codexHost!.ensure();
      // Never load an ordinary standalone Codex TUI's thread into a second
      // server. Native steering is reserved for the launcher that explicitly
      // joined this exact Runner-owned endpoint.
      if (observedEndpoint !== endpoint) return null;
      const recoverySpec = this.recoverySpec(input, session);
      await this.recoveryJournal?.prepare(recoverySpec);
      prepared = true;
      controller = await CodexManagedSession.resume(session.currentProviderId, {
        cwd: input.cwd,
        interactions: this.interactions,
        timeoutMs: this.timeoutMs,
        endpoint: this.codexHost!.endpoint,
        preserveThreadPolicy: true,
        onActivity: () => this.emitManagedTranscriptActivity("codex", session.currentProviderId),
      });
      // From this point the provider request may own the prompt even when its
      // acknowledgement is lost. Never fall through to terminal injection.
      promptTransferred = true;
      const action = await controller.dispatch(input.prompt);
      try {
        await this.recoveryJournal?.activate("codex", session, action.turnId);
      } catch (error) {
        this.onRecoveryEvent?.("journal_failed", {
          version: 2,
          ...this.recoverySpec(input, session),
          status: "prepared",
          recoveryCount: 0,
          updatedAt: this.now().toISOString(),
        }, error instanceof Error ? error.message : String(error));
      }
      await this.installManagedAttachment({
        provider: "codex",
        session,
        cwd: input.cwd,
        transport: "app-server",
        turnId: action.turnId,
        controller,
        completion: action.completion.then(normalizeResult),
        leaseHolder: "terminal",
      });
      return {
        ok: true,
        agent: "codex",
        session_id: session.logicalId,
        new_session_id: session.currentProviderId,
        transport: "app-server",
        control_action: action.kind === "steered" ? "protocol_steer" : "protocol_send",
        input: this.inputReceipt("codex", session.currentProviderId, "app-server",
          action.kind === "steered" ? "protocol_steer" : "protocol_send", action.turnId),
        turn_id: action.turnId,
        cwd: input.cwd,
        duration_ms: 0,
      };
    } catch (error) {
      await controller?.close().catch(() => {});
      // Returning null here means "this route did not take the prompt", and the
      // caller answers that by typing it into the pane instead. Once the native
      // turn owns the prompt that answer would deliver it a second time.
      if (promptTransferred) {
        const value = error instanceof Error ? error : new Error(String(error));
        (value as Error & { safeFallback?: boolean }).safeFallback = false;
        throw value;
      }
      if (prepared) await this.recoveryJournal?.disarm("codex", session).catch(() => {});
      return null;
    }
  }

  private async openManaged(input: {
    onPrepared?: StartManagedAgentInput["onPrepared"];
    provider: AgentProvider;
    session?: ProviderSessionRef;
    cwd: string;
    prompt: string;
    resume: boolean;
    recovering?: boolean;
    recoverySignal?: AbortSignal;
    model?: string;
    effort?: string;
    permissionProfile?: AgentPermissionProfile;
    codexHome?: string;
    recoveryPlacement?: ManagedRecoveryPlacement;
    remoteMcpUrl?: string;
  developmentMcpUrl?: string;
    codexEnvironment?: StartManagedAgentInput["codexEnvironment"];
    claudeTranslation?: ClaudePromptTranslation;
  }): Promise<ManagedAttachment> {
    const provisional = input.session ?? Symbol(`new:${randomUUID()}`);
    const work = Promise.resolve().then(() => withAgentExecutable(input.provider, () => this.createManaged(input))).catch((error) => {
      const value = error instanceof Error ? error : new Error(String(error));
      const tagged = value as Error & { safeFallback?: boolean };
      if (tagged.safeFallback === undefined) tagged.safeFallback = true;
      throw value;
    });
    this.opening.set(provisional, work);
    try {
      return await work;
    } finally {
      this.opening.delete(provisional);
    }
  }

  private async createManaged(input: {
    onPrepared?: StartManagedAgentInput["onPrepared"];
    provider: AgentProvider;
    session?: ProviderSessionRef;
    cwd: string;
    prompt: string;
    resume: boolean;
    recovering?: boolean;
    recoverySignal?: AbortSignal;
    model?: string;
    effort?: string;
    permissionProfile?: AgentPermissionProfile;
    codexHome?: string;
    recoveryPlacement?: ManagedRecoveryPlacement;
    remoteMcpUrl?: string;
  developmentMcpUrl?: string;
    codexEnvironment?: StartManagedAgentInput["codexEnvironment"];
    claudeTranslation?: ClaudePromptTranslation;
  }): Promise<ManagedAttachment> {
    input.recoverySignal?.throwIfAborted();
    let session = input.session;
    if (input.provider === "claude" && !session) {
      session = this.sessions.reference("claude", randomUUID());
    }
    let controller: ManagedController | undefined;
    let transport: ManagedTransport | undefined;
    let returnedProviderId: string | undefined;
    let preparedEarly = false;
    let releaseHost: (() => void) | undefined;
    const onCodexActivity = (): void => {
      if (session) this.emitManagedTranscriptActivity("codex", session.currentProviderId);
    };
    try {
      if (session && !input.recovering) {
        await this.recoveryJournal?.prepare(this.recoverySpec(input, session));
        preparedEarly = true;
      }

      if (input.provider === "omp") {
        // omp's RPC transport is the whole story: it starts, resumes, steers and
        // aborts through one attachment, and it mints its own session id.
        assertOmpPermissionProfile(input.permissionProfile);
        const ompOptions = {
          cwd: input.cwd,
          interactions: this.interactions,
          timeoutMs: this.timeoutMs,
          ...(input.model ? { model: input.model } : {}),
          ...(input.effort ? { effort: input.effort } : {}),
          ...(input.permissionProfile ? { permissionProfile: input.permissionProfile } : {}),
          ...(input.remoteMcpUrl ? { remoteMcpUrl: input.remoteMcpUrl } : {}),
      ...(input.developmentMcpUrl ? { developmentMcpUrl: input.developmentMcpUrl } : {}),
        };
        if (input.resume && !session?.rolloutPath) {
          throw new Error("omp 续跑需要设备侧解析出的会话文件路径");
        }
        controller = input.resume
          ? await OmpManagedSession.resume(String(session?.rolloutPath), ompOptions)
          : await OmpManagedSession.start(ompOptions);
        returnedProviderId = controller.sessionId;
        session = session
          ? this.sessions.reference("omp", session.currentProviderId, controller.sessionFile)
          : this.sessions.reference("omp", controller.sessionId, controller.sessionFile);
        transport = "omp-rpc";
      } else if (input.provider === "claude") {
        controller = new ClaudeManagedSession({
          sessionId: session!.currentProviderId,
          cwd: input.cwd,
          interactions: this.interactions,
          timeoutMs: this.timeoutMs,
          resume: input.resume,
          permissionProfile: agentPermissionProfile("claude", input.permissionProfile),
          ...(input.model ? { model: input.model } : {}),
          ...(input.effort ? { effort: input.effort === "xhigh" ? "max" : input.effort } : {}),
          ...(input.remoteMcpUrl ? { remoteMcpUrl: input.remoteMcpUrl } : {}),
      ...(input.developmentMcpUrl ? { developmentMcpUrl: input.developmentMcpUrl } : {}),
          onBackgroundTasksChanged: async (tasks) => {
            await this.recoveryJournal?.setBackgroundTasks("claude", session!, tasks);
          },
        });
        transport = "agent-sdk";
      } else {
        // Ordinary local turns own a disposable stdio app-server. Split
        // execution remains the sole shared managed host.
        const selectedHost = input.codexEnvironment ? this.codexRemoteHostForHome?.(input.codexHome) : undefined;
        const codexHost = input.codexEnvironment ? selectedHost?.host ?? this.codexRemoteHost : undefined;
        if (input.codexEnvironment && !codexHost) {
          throw new Error("Codex split execution requires an isolated app-server host");
        }
        if (codexHost && input.codexHome && !selectedHost) {
          throw new Error("Codex 跨机器执行需要与所选账号绑定的隔离 host");
        }
        if (selectedHost) input = { ...input, codexHome: selectedHost.codexHome };
        if (codexHost) {
          // Older embeddings expose ensure only; the resident private host reserves its whole attachment.
          if (typeof codexHost.acquire === "function") releaseHost = (await codexHost.acquire()).release;
          else await codexHost.ensure();
        }
        if (input.resume && !session) throw new Error("Codex resume requires a provider session ref");
        controller = input.resume
          ? await CodexManagedSession.resume(session!.currentProviderId, {
              cwd: input.cwd,
              interactions: this.interactions,
              timeoutMs: this.timeoutMs,
              onActivity: onCodexActivity,
              ...(codexHost ? { endpoint: codexHost.endpoint } : {}),
              ...(input.remoteMcpUrl || input.developmentMcpUrl ? { config: codexSplitConfig(input.remoteMcpUrl, input.developmentMcpUrl) } : {}),
              ...(!codexHost && input.codexHome ? { codexHome: input.codexHome } : {}),
              ...(input.model ? { model: input.model } : {}),
              ...(input.effort ? { effort: input.effort } : {}),
              ...(input.codexEnvironment
                ? {
                    environment: {
                      environmentId: input.codexEnvironment.environmentId,
                      execServerUrl: input.codexEnvironment.endpoint,
                    },
                  }
                : {}),
              permissionProfile: codexPermissionProfile(input.permissionProfile),
            })
          : await CodexManagedSession.start({
              cwd: input.cwd,
              interactions: this.interactions,
              timeoutMs: this.timeoutMs,
              onActivity: onCodexActivity,
              ...(codexHost ? { endpoint: codexHost.endpoint } : {}),
              ...(input.remoteMcpUrl || input.developmentMcpUrl ? { config: codexSplitConfig(input.remoteMcpUrl, input.developmentMcpUrl) } : {}),
              ...(!codexHost && input.codexHome ? { codexHome: input.codexHome } : {}),
              ...(input.codexEnvironment
                ? {
                    environment: {
                      environmentId: input.codexEnvironment.environmentId,
                      execServerUrl: input.codexEnvironment.endpoint,
                    },
                  }
                : {}),
              ...(input.model ? { model: input.model } : {}),
              ...(input.effort ? { effort: input.effort } : {}),
              permissionProfile: codexPermissionProfile(input.permissionProfile),
            });
        // A resumed controller retains the requested identity. Only a fresh
        // start may establish its ref from the attachment id; provider-backed
        // rebound receipts flow through the single rename edge elsewhere.
        if (!input.resume) session = this.sessions.reference("codex", controller.sessionId);
        transport = "app-server";
        if (releaseHost) {
          const close = controller.close.bind(controller);
          const release = releaseHost;
          controller.close = async () => { await close(); release(); };
        }
      }

      if (!session || !controller || !transport) throw new Error("managed provider did not establish a session");
      if (returnedProviderId && returnedProviderId !== session.currentProviderId) {
        await this.sessions.rename(input.provider, session.currentProviderId, returnedProviderId);
      }
      input.recoverySignal?.throwIfAborted();
      // Re-write prepared after setup so a provider-minted id, rename lineage
      // and the original rollout path are one durable recovery record.
      await this.recoveryJournal?.prepare(this.recoverySpec(input, session), input.recovering === true);
      input.recoverySignal?.throwIfAborted();
      await input.onPrepared?.(session.currentProviderId, transport);
      input.recoverySignal?.throwIfAborted();
    } catch (error) {
      await controller?.close().catch(() => {});
      releaseHost?.();
      if (preparedEarly && session) {
        await this.recoveryJournal?.disarm(input.provider, session).catch(() => {});
      }
      const value = error instanceof Error ? error : new Error(String(error));
      // Preserve explicit provider refusals (for example parent-owned Codex
      // children); setup location alone cannot authorize a legacy CLI retry.
      (value as Error & { safeFallback?: boolean }).safeFallback ??= true;
      throw value;
    }

    if (!session || !controller || !transport) throw new Error("managed provider did not establish a session");

    let dispatchResult: Awaited<ReturnType<typeof dispatch>>;
    this.startingControllers.set(session, controller);
    try {
      input.recoverySignal?.throwIfAborted();
      dispatchResult = await dispatch(controller, input.recovering && input.provider === "codex" ? this.codexContinuationPrompt(session) : input.prompt);
    } catch (error) {
      await controller.close().catch(() => {});
      const value = error instanceof Error ? error : new Error(String(error));
      // For Codex this request may already have crossed `turn/start`; for
      // Claude, queueing the SDK message likewise transfers prompt ownership.
      (value as Error & { safeFallback?: boolean }).safeFallback = false;
      throw value;
    } finally {
      this.startingControllers.delete(session);
    }
    const turnId = dispatchResult.turnId || `turn_${randomUUID().replace(/-/g, "")}`;
    try {
      await this.recoveryJournal?.activate(input.provider, session, turnId);
    } catch (error) {
      // Prompt ownership already crossed. Keep the live turn, but leave the
      // prepared row to become `unknown` after a restart rather than claiming
      // recovery is available when the durable acknowledgement failed.
      this.onRecoveryEvent?.("journal_failed", {
        version: 2,
        ...this.recoverySpec(input, session),
        status: "prepared",
        recoveryCount: 0,
        updatedAt: this.now().toISOString(),
      }, error instanceof Error ? error.message : String(error));
    }
    await this.recordClaudePrompt(input.provider, session.currentProviderId, input.claudeTranslation);
    // Only attachments owned by this Runner enter the policy. Cooperative
    // CLI/GUI bridges and parent-owned children never reach this constructor.
    const capacityRetry = controller instanceof CodexManagedSession && input.prompt.trim() !== "/compact"
      ? new CodexCapacityRetry({
          dispatch: () => (controller as CodexManagedSession).dispatch(this.codexContinuationPrompt(session!)),
          persist: async checkpoint => this.recoveryJournal
            ? await this.recoveryJournal.setCapacityRetry(input.provider, session!, turnId, checkpoint) : true,
          changed: () => this.emitManagedTranscriptActivity(input.provider, session!.currentProviderId),
          restored: this.recoveryJournal?.current(input.provider, session.logicalId)?.capacityRetry,
          now: () => this.now().getTime(),
        }) : undefined;
    const normalizedCompletion = (capacityRetry
      ? capacityRetry.run(dispatchResult.completion as Promise<CodexAppServerTurnResult>)
      : dispatchResult.completion).then(normalizeResult);
    const completion = input.provider === "claude"
      && input.claudeTranslation
      && this.claudeTranslations
      ? normalizedCompletion.then(async (result) => {
          if (!result.ok || !result.resultText) return result;
          const translated = await this.claudeTranslations!.translateAssistant(
            session.currentProviderId,
            input.claudeTranslation!.turnId,
            result.resultText,
            input.cwd,
          );
          return translated.ok
            ? {
                ...result,
                resultText: translated.bilingual.zh,
                resultTextEnglish: translated.bilingual.en,
              }
            : {
                ...result,
                resultTextEnglish: result.resultText,
                translationError: translated.error,
              };
        })
      : normalizedCompletion;
    return await this.installManagedAttachment({
      provider: input.provider,
      session,
      cwd: input.cwd,
      transport,
      turnId,
      controller,
      completion,
      ...(capacityRetry ? { capacityRetry } : {}),
      leaseHolder: "protocol",
      permissionProfile: agentPermissionProfile(input.provider, input.permissionProfile),
      model: input.model,
      effort: input.effort,
    });
  }

  private recoverySpec(
    input: Pick<ContinueAgentSessionInput, "provider" | "cwd" | "codexHome" | "model" | "effort" | "permissionProfile" | "recoveryPlacement">,
    session: ProviderSessionRef,
  ): ManagedRecoverySpec {
    return {
      provider: input.provider,
      session: this.sessions.snapshot(session),
      cwd: input.cwd,
      ...(input.codexHome ? { codexHome: input.codexHome } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      ...(input.permissionProfile ? { permissionProfile: input.permissionProfile } : {}),
      ...(input.recoveryPlacement ? { remotePlacement: input.recoveryPlacement } : {}),
    };
  }

  private async installManagedAttachment(input: {
    provider: AgentProvider;
    session: ProviderSessionRef;
    cwd: string;
    transport: ManagedTransport;
    turnId: string;
    controller: ManagedController;
    completion: Promise<ManagedTurnResult>;
    capacityRetry?: CodexCapacityRetry;
    leaseHolder: "terminal" | "protocol";
    permissionProfile?: AgentPermissionProfile;
    model?: string;
    effort?: string;
  }): Promise<ManagedAttachment> {
    let finishRuntime: () => Promise<void>;
    try {
      finishRuntime = await this.runtime.beginHeadless(input.provider, input.session.currentProviderId);
    } catch (error) {
      await input.controller.close().catch(() => {});
      const value = error instanceof Error ? error : new Error(String(error));
      (value as Error & { safeFallback?: boolean }).safeFallback = false;
      throw value;
    }
    const attachment: ManagedAttachment = {
      ...input,
      startedAt: this.now().toISOString(),
      finishRuntime,
    };
    try {
      this.sessions.attach(input.session, attachment);
    } catch (error) {
      await input.controller.close().catch(() => {});
      await finishRuntime().catch(() => {});
      const value = error instanceof Error ? error : new Error(String(error));
      (value as Error & { safeFallback?: boolean }).safeFallback = false;
      throw value;
    }
    void input.completion.then(
      (result) => this.emitManagedCompletion(attachment, result.ok ? "succeeded" : "failed", result.usage),
      () => this.emitManagedCompletion(attachment, "failed"),
    );
    detachAfterSettlement(input.completion, async () => {
      if (this.sessions.attachment(input.session) !== attachment) return;
      if (!this.preserveRecoveries) {
        await this.recoveryJournal?.complete(
          input.provider,
          input.session,
          input.turnId,
          await input.completion.catch(() => ({ ok: false, error: "托管会话结束结果无法确认。" })),
        ).catch(() => {});
      }
      try {
        await input.controller.close();
      } catch {
        if (
          input.provider === "codex"
          && input.leaseHolder === "protocol"
          && input.controller instanceof CodexManagedSession
          && input.controller.ownsServerProcess
          && this.sessions.attachment(input.session) === attachment
        ) {
          attachment.releaseRequired = true;
          return;
        }
      }
      this.sessions.detach(input.session, attachment);
      await finishRuntime().catch(() => {});
      this.emitManagedTranscriptActivity(input.provider, input.session.currentProviderId, this.managedTranscriptPath(attachment));
    });
    return attachment;
  }

  private emitManagedCompletion(
    attachment: Pick<ManagedAttachment, "provider" | "session" | "turnId">,
    status: RunnerManagedCompletion["status"],
    usage?: RunnerManagedTurnUsage,
  ): void {
    const event: RunnerManagedCompletion = {
      schema: RUNNER_MANAGED_COMPLETION_SCHEMA,
      provider: attachment.provider,
      session_id: attachment.session.currentProviderId,
      logical_session_id: attachment.session.logicalId,
      turn_id: attachment.turnId,
      status,
      completed_at: this.now().toISOString(),
      ...(usage ? { usage } : {}),
    };
    const publish = () => {
      for (const listener of [...this.managedCompletionListeners]) {
        try {listener(event);} catch { /* One consumer cannot change the provider outcome. */ }
      }
    };
    if (this.persistManagedCompletion) void this.persistManagedCompletion(event).then(publish, publish);
    else publish();
  }

  private emitManagedTranscriptActivity(provider: AgentProvider, sessionId: string, transcriptPath?: string): void {
    const attachment = this.sessions.attachment(provider, sessionId);
    const file = transcriptPath ?? (attachment ? this.managedTranscriptPath(attachment) : undefined);
    for (const listener of [...this.managedTranscriptActivityListeners]) {
      try {
        if (file) listener(provider, sessionId, file);
        else listener(provider, sessionId);
      } catch {
        // Observation is best effort and must never change provider handling.
      }
    }
  }

  private async tmuxPane(pid: number, force = false): Promise<TmuxPaneAttachment | null> {
    const cached = this.paneCache.get(pid);
    if (!force && cached && Date.now() - cached.at < 2_000) return cached.value;
    if (!force) {
      const pending = this.paneProbes.get(pid);
      if (pending) return pending.promise;
    } else {
      // A write path asks for a fresh proof immediately before touching the
      // terminal. It must never consume either a completed observation or a
      // read-only probe that began before this force boundary. Later readers
      // may join the fresh probe because attachmentForPid itself is read-only.
      this.paneCache.delete(pid);
    }

    const generation = ++this.nextPaneProbeGeneration;
    let probe!: PaneProbe;
    const promise = this.terminal.attachmentForPid(pid, force)
      .then((value) => {
        // A force probe can replace an older read while that read is still in
        // flight. Only the newest generation for this pid may publish the 2s
        // completed cache; the older caller still receives its own snapshot.
        if (this.paneProbes.get(pid)?.generation === generation) {
          this.paneCache.set(pid, { at: Date.now(), generation, value });
        }
        return value;
      })
      .finally(() => {
        if (this.paneProbes.get(pid)?.generation === generation) this.paneProbes.delete(pid);
      });
    probe = { generation, promise };
    this.paneProbes.set(pid, probe);
    return promise;
  }

  private async tmuxPaneForWrite(pid: number): Promise<TmuxPaneAttachment | null> {
    // Copy/history-mode cancellation changes user-visible tmux state, so a
    // read-only status probe must never join this request. Invalidate both
    // completed and in-flight discovery publication, normalize only for this
    // explicit send, and leave subsequent readers to take a fresh snapshot.
    this.paneCache.delete(pid);
    this.paneProbes.delete(pid);
    try {
      return await this.terminal.writableAttachmentForPid(pid);
    } finally {
      this.paneCache.delete(pid);
    }
  }
}

function capacityRuntime(checkpoint: CodexCapacityCheckpoint): NonNullable<PublicAgentControlRuntime["recovery"]> {
  return { state: "waiting_capacity", since: checkpoint.firstFailureAt,
    ...(checkpoint.nextRetryAt ? { retry_at: checkpoint.nextRetryAt } : {}),
    attempts: checkpoint.attempts, max_attempts: 6, deadline_at: checkpoint.deadlineAt };
}

/** Every controller shape this plane can hold. */
type ManagedController = ClaudeManagedSession | CodexManagedSession | CodexDesktopSession | OmpManagedSession;

async function dispatch(
  controller: ManagedController,
  prompt: string,
): Promise<{
  kind: "started" | "steered";
  turnId: string;
  completion: Promise<ClaudeManagedTurnResult | CodexAppServerTurnResult | OmpManagedTurnResult>;
}> {
  if (controller instanceof ClaudeManagedSession) {
    const result = controller.dispatch(prompt);
    return { ...result, turnId: "" };
  }
  return await controller.dispatch(prompt);
}

function normalizeResult(
  value: ClaudeManagedTurnResult | CodexAppServerTurnResult | OmpManagedTurnResult,
): ManagedTurnResult {
  const usage = normalizeManagedUsage(value);
  return {
    ok: value.ok,
    ...(value.resultText ? { resultText: value.resultText } : {}),
    ...(value.error ? { error: value.error } : {}),
    ...(value.stderr ? { stderr: value.stderr } : {}),

    ...("newSessionId" in value && value.newSessionId ? { newSessionId: value.newSessionId } : {}),
    ...("timedOut" in value && value.timedOut ? { timedOut: true } : {}),
    ...("status" in value && value.status ? { status: value.status } : {}),
    ...(usage ? { usage } : {}),
  };
}

function normalizeManagedUsage(
  value: ClaudeManagedTurnResult | CodexAppServerTurnResult | OmpManagedTurnResult,
): RunnerManagedTurnUsage | undefined {
  if (!("usage" in value) || !value.usage) return undefined;
  const usage = value.usage as Record<string, unknown>;
  const count = (candidate: unknown): number =>
    typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0
      ? Math.round(candidate)
      : 0;
  if ("inputTokens" in usage || "cachedInputTokens" in usage || "outputTokens" in usage) {
    const cached = count(usage.cachedInputTokens);
    const input = Math.max(0, count(usage.inputTokens) - cached);
    const output = count(usage.outputTokens);
    return input || output || cached
      ? {
          ...(input ? { tokens_in: input } : {}),
          ...(output ? { tokens_out: output } : {}),
          ...(cached ? { tokens_cached: cached } : {}),
        }
      : undefined;
  }
  const input = count(usage.tokens_in);
  const output = count(usage.tokens_out);
  const cached = count(usage.tokens_cached);
  return input || output || cached
    ? {
        ...(input ? { tokens_in: input } : {}),
        ...(output ? { tokens_out: output } : {}),
        ...(cached ? { tokens_cached: cached } : {}),
      }
    : undefined;
}

/**
 * Run best-effort cleanup after either outcome without cloning a rejection
 * into an unobserved `finally()` promise. Cleanup failures are deliberately
 * consumed too: the turn's own completion remains the authoritative outcome.
 */
function detachAfterSettlement<T>(promise: Promise<T>, cleanup: () => void | Promise<void>): void {
  void promise.then(cleanup, cleanup).catch(() => {});
}

function codexSplitConfig(remoteMcpUrl?: string, developmentMcpUrl?: string): Record<string, unknown> {
  return {
    "features.apps": false,
    "features.plugins": false,
    mcp_servers: {
      ...(remoteMcpUrl ? { octopus_execution: { url: remoteMcpUrl } } : {}),
      ...(developmentMcpUrl ? { octopus_devpipe: { url: developmentMcpUrl } } : {}),
    },
  };
}

function unknownRuntime(now: Date): PublicAgentRuntime {
  return {
    process_state: "unknown",
    turn_state: "unknown",
    control_mode: "unknown",
    observed_at: now.toISOString(),
    event: "Unknown",
    degraded: true,
    capabilities: {
      observe: true,
      append_when_idle: false,
      takeover: false,
      interrupt: false,
      steer: false,
    },
  };
}

/**
 * Identity of one terminal submission. The prompt is hashed rather than kept:
 * neither the in-memory fallback nor the durable recovery sidecar can
 * reproduce what somebody typed.
 */
function terminalPromptHash(prompt: string): string {
  return createHash("sha256").update(prompt.trim(), "utf8").digest("hex");
}

function terminalSendKey(provider: AgentProvider, logicalId: string, promptHash: string): string {
  return `${provider}\0${logicalId}\0${promptHash}`;
}

function tail(value: string, max: number): string {
  return value.length > max ? `…${value.slice(-max)}` : value;
}

/**
 * Default sweep. Kept out of the class so a test can inject a deterministic
 * process table without reaching into /proc.
 */
function defaultOmpDiscovery(home: string, runtime: AgentRuntimeRegistry): Promise<unknown> {
  const reader = new LinuxProcessReader();
  return discoverOmpSessions(home, runtime, {
    lister: new LinuxProcessLister(),
    read: (pid) => reader.read(pid),
  });
}

function defaultCodexDiscovery(
  candidates: readonly CodexSessionDiscoveryCandidate[],
  runtime: AgentRuntimeRegistry,
): Promise<unknown> {
  const reader = new LinuxProcessReader();
  return discoverCodexTerminalSessions(candidates, runtime, {
    lister: new LinuxProcessLister(),
    read: (pid) => reader.read(pid),
  });
}
