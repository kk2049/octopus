import { DevelopmentWorkspaceService, DevelopmentWorkspaceError, type DevelopmentWorkspaceOptions,
  type DevelopmentTurnBinding, type DevelopmentMcpCredential } from "./development-workspace.js";
import { WorkspaceProvider, WorkspaceProviderUnavailable, WorkspaceProviderUnknown } from "./workspace-provider.js";
import { TicketRunnerAccess, runRunnerTicketTurn, ticketExecutionFromWire, type TicketExecution } from "./runner-ticket.js";
import { NativeDevelopmentService } from "./native-development.js";
import type { TicketRunnerBinding } from "../store/repositories/ticket-runner.js";
/**
 * DevPipeline — agent-native ticket conversations (ticket #12, refactored in
 * ticket #16 to parallel coding + serial merge).
 *
 * The previous design was a ten-status state machine (queued → speccing →
 * spec_ready → ready_to_dev → developing → gating → gated, with awaiting_reply
 * / needs_human side exits) driven by prompt sentinels. It broke exactly where
 * state machines break: at the seams. A message to a `gated` ticket had no
 * lane to pick it up and hung as "待送达" forever.
 *
 * Ticket #12 replaced the state machine with plain CONVERSATIONS. Ticket #16
 * then removed the shared coding lock: agents already have their own
 * per-ticket worktrees, so nothing but tradition made them serialise while
 * TYPING code. Only the merge step ever needed a common lock, and now that is
 * where the lock lives.
 *
 * The pipeline does two things:
 *
 *   1. Turn pump: any non-cancelled ticket with unread inbox messages gets a
 *      turn (concurrency-capped). Creation seeds the inbox with the ticket
 *      body, so "brand new" and "user replied" and "landed but user has a
 *      follow-up" are all the same trigger. FIFO by id (ticket #16 —
 *      complex-first is retired).
 *
 *      Since ticket #183 the pump is no longer the ONLY way in. A message
 *      posted while a turn is running is offered to that turn first, and the
 *      provider transport delivers it into the work in progress (right after
 *      the tool call in flight). It becomes an inbox message for the NEXT turn
 *      only when the live channel refuses it — for example a turn already on
 *      its way out. The inbox stays the fallback, never the default wait.
 *
 *   2. Tool ops: the agent drives development through two MCP tools that call
 *      back into this class (loopback HTTP + per-turn bearer token):
 *        · devpipe_submit — the merge phase, ALL of it, in one atomic call:
 *          protected-path + App-scope check → note trust-sensitive paths →
 *          acquire the merge lock (park if held,
 *          the release wakes you) → rebase the ticket branch onto the base
 *          tip (conflict? release lock, agent fixes and re-submits) → run
 *          any tests explicitly named by the agent → ff-only merge → release
 *          the lock. The full suite runs later in batched GitLab CI.
 *        · devpipe_status — read-only view of the ticket and the merge lock.
 *      There is no devpipe_claim_workspace: since #16 there is nothing to
 *      claim before typing. The agent CODES freely in its worktree and
 *      submit does the coordination.
 *
 * Statuses shrink to open / landed / cancelled. Questions, approvals and
 * failures are MESSAGES in the conversation, not states — a complex ticket
 * "waits for approval" by the agent choosing not to submit until the user
 * says go, which is prompt discipline, not machinery.
 *
 * What deliberately stays: the human lane `land()` (same door, same lock),
 * per-ticket slug extraction, `turn_started_at` liveness, worktree-per-ticket.
 */

import { readTicketFiles } from "./ticket-files.js";
import { markedReceiptTail, recoverFullReply, type TranscriptRead } from "./receipt-reply.js";
import { ticketEvidenceIdentities, verifyNewHumanEvidence } from "./knowledge-evidence.js";
import { processTicketSources, sourceCoverage, sourcePromptReminder, ticketSourcePage } from "./knowledge-sources.js";
import type { KnowledgeNextAction, SourcePage } from "../knowledge/source-workflow.js";
import { verifyLandingSpecifications } from "./knowledge-specifications.js";
import path from "node:path";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import type { Store } from "../store/store.js";
import type { DevTicketLane, DevTicketRow, TicketActorKind, TicketMessageRow } from "../store/repositories/dev-tickets.js";
import { contribBranchName, NO_FORGE_PUBLISHER, type ProposalPublishResult, type ProposalPublisher } from "./contrib-review.js";
import {
  DEV_TICKET_EFFORT_DEFAULT,
  DEV_TICKET_KINDS,
  DEV_TICKET_MODEL_DEFAULT,
  FABLE_TICKET_MODEL,
  cliFamilyForModel,
  modelIdForCli,
  normalizeCliDeliveryTicketInput,
  normalizeDevTicketInput,
  type DevTicketInput,
} from "./ticket-models.js";
import { DEV_STALL_TIMEOUT_MS, sessionTranscriptExists, type DevTurnResult, type DevTurnSpec, type TurnLimits } from "./executor.js";
import { RunnerTicketInputDelivery } from "./runner-ticket-input.js";
import { GitLabMainline } from "./gitlab-mainline.js";
import { IntegrationLeaseKeeper } from "./integration-lease.js";
import {
  createTicketWorktree,
  git,
  gitOrThrow,
  msg,
  worktreeHoldingBranch,
} from "./worktree.js";
import {
  LandGate,
  landGateRefusalMessage,
  type LandGateCandidate,
  type LandGateOutcome,
} from "./land-gate.js";
import { decodeCiRoster, encodeCiRoster, isCiRepairTicket, mergeCiRoster } from "./ci-roster.js";
import type { CiMachineTarget } from "./prompts.js";
import { SlotGate } from "./slot-gate.js";
import { ResourceRecoveryService, ResourceUnavailableError, parseUnavailable, ticketScope, ticketScopeId, type ResourceWaiter } from "../resources/recovery.js";
import { dependencyWait } from "@claude-bot/runner/managed-execution";
import type { ResourceSuspensionView } from "../resources/suspension.js";
import { ManagedExecutionSupervisor, type ExecutionLease, type ExecutionStep } from "../managed-execution/supervisor.js";
import type { ManagedExecutionRow } from "../store/repositories/managed-executions.js";
import type { RemoteGateOpener } from "./remote-gate.js";
import type { CiCommitRelation } from "./gitlab-ci.js";
import {
  associateCiRangeCommits,
  renderCiChangeHistory,
  type CiRangeCommit,
} from "./ci-change-history.js";
import { accumulateTurnCost, moduleOf, parseNumstat, turnTokenTotal } from "./ticket-cost.js";
import { BuildWarmer, buildWarmSummary, type BuildWarmJoinResult } from "./build-warm.js";
import { MCP_CONFIG_FILE } from "./mcp-config.js";
import {
  APP_TICKET_SCOPES,
  appScopeFor,
  appScopeViolations,
  appsWithReleaseChanges,
  scopeOfTicket,
  type AppTicketScope,
  type GateStep,
} from "./app-scopes.js";
import {
  encodeDeliveryApps,
  resolveDelivery,
  ticketDeliveryApps,
  ticketNeedsTrustedDeploy,
  type DeliveryPlan,
} from "./delivery.js";
import { createLogger } from "../logger.js";
import {
  CLI_REPORT_DIR,
  cliAcceptanceSpec,
  isCliReportPath,
  parseCliDeliveryReport,
  renderCliDeliveryReport,
  type LoadedCliDeliveryReport,
  type CliDeliveryReportV3,
} from "./cli-report.js";
import { PROTECTED_PATHS, tcbPathHits } from "./policy-paths.js";
import {
  buildInterjectionPrompt,
  buildIntroPrompt,
  buildTurnPrompt,
  extractSlug,
  formatInbox,
  QUEUED_NOTICE,
} from "./prompts.js";
import { defaultGate, namedGateSteps, type GateOutcome } from "./gates.js";
import {
  AppReleaseCoordinator,
  type AppHotswapApprovalView,
  type AppHotswapDecisionResult,
  type AppHotswapExecutor,
  type AppHotswapToolResult,
  type AppReleaseDrainState,
  type AppReleaseRefreshOutcome,
  type AppReleaseRefresher,
  type PendingAppReleaseDrain,
  type StagedReleaseTree,
} from "./app-releases.js";
import { RepositoryKnowledgeIndex } from "./knowledge-index.js";
import { KnowledgeGraphService } from "./knowledge-graph-service.js";
import type { KnowledgeArtifactHealth, KnowledgeArtifactService } from "./knowledge-artifact-service.js";
import {
  constraintEvidenceTests,
  formatKnowledgeContext,
  knowledgeTestFiles,
  unacknowledgedKnowledge,
} from "./landing-knowledge.js";
import type { RetrievalFeedbackCode, RetrievalSlot, RetrievalTraceId, RetrievalTraceReceiptV1 } from "../knowledge/retrieval-trace.js";
import { formatStatement, submitDigest } from "../knowledge/context-pack.js";
import type { KnowledgeSearchHit, LandingKnowledge } from "../store/repositories/knowledge.js";
import type { CodexAccountRouter } from "./codex-account-router.js";
import { openRemoteCodexBridge } from "./remote-codex.js";
import { FairWakeLock } from "./wake-lock.js";
import { runnerBundleInputsChanged } from "./runner-bundle-delivery.js";

/**
 * Ticket #192 split this file into four. The three below hold the parts with
 * no moving pieces — path policy, prompt authoring, gate selection — and are
 * re-exported here so every existing importer and test is unchanged. Prefer
 * importing from the real module in new code; these lines exist so the split
 * could be proven behaviour-neutral, not as a permanent second front door.
 */
export * from "./policy-paths.js";
export * from "./prompts.js";
export * from "./gates.js";
export * from "./app-releases.js";

/** One sentence. Detail belongs in the reply body, which nobody truncates. */
const OPEN_QUESTION_MAX = 300;

const log = createLogger("devpipe");

/** Smallest cross-provider turn that makes a resumed agent do work. */
const RESTART_CONTINUE_PROMPT = "继续执行";
const LEGACY_RESTART_WAKE_MESSAGES = {
  "⚠ bot 重启打断了上一轮。请从当前状态接着推进——已 commit 的工作与会话都在;上一轮已收到的消息可能未处理完,拿不准就先 devpipe_status 看一眼再 git log/status 复核。": true,
  "⚠ 服务重启中止了上一轮。请从当前 worktree 和会话继续;已 commit 的工作不会丢失。": true,
} as const satisfies Readonly<Record<string, true>>;

function isRestartContinuation(inbox: readonly TicketMessageRow[]): boolean {
  return inbox.length > 0 && inbox.every((message) =>
    message.author === "pipeline"
    && message.via === "pipeline"
    && (
      message.body === RESTART_CONTINUE_PROMPT
      || LEGACY_RESTART_WAKE_MESSAGES[message.body as keyof typeof LEGACY_RESTART_WAKE_MESSAGES] === true
    ));
}

/** Concurrent turns. Turns execute on Runner devices, not on the Head, so this
 * bounds only supervision fan-out; device load is bounded where it occurs
 * (container limits, per-checkout job slots). It was 2 while every turn was a
 * `claude` process on the 3.7G Head box. (Option name kept from the two-lane era.) */
export const DEFAULT_SPEC_CONCURRENCY = 16;
/** devpipe_submit calls per turn — each failed one burns a full gate run. */
export const DEFAULT_MAX_SUBMITS_PER_TURN = 3;
/**
 * Delay before the automatic one-shot turn retry (ticket #20). Claude's CLI
 * occasionally exits non-zero from transient upstream hiccups; a short sleep
 * gives the API a moment to breathe rather than falling straight through to
 * "the ticket is stuck, please reply". Exported so tests can override it.
 */
export const DEFAULT_TURN_RETRY_DELAY_MS = 3_000;
/**
 * Minimum gap between restart-only continuation launches.
 *
 * Codex app-server gives `thread/resume` 30 seconds to attach. Keeping the
 * launch gate closed for five seconds beyond that budget prevents a restart
 * burst without making one long-running recovered turn hold every ticket
 * behind it for its whole lifetime.
 */
export const DEFAULT_RESTART_CONTINUATION_PACE_MS = 35_000;
/**
 * Time from a targeted merge-lock wake until that FIFO reservation expires.
 * Agent startup is normally seconds; two minutes tolerates a slow provider
 * boundary without letting a dead turn idle the landing lane indefinitely.
 */
export const DEFAULT_MERGE_LOCK_WAKE_LEASE_MS = 2 * 60_000;
export type DevPipeEvent =
  /** A turn finished with a reply and no landing — questions, plans, chatter. */
  | { kind: "reply"; ticket: DevTicketRow; text: string }
  /** devpipe_submit passed the gates and fast-forwarded the base branch. */
  | { kind: "landed"; ticket: DevTicketRow }
  /** A review-lane submit published a candidate for a maintainer's decision. */
  | { kind: "proposed"; ticket: DevTicketRow; proposal: { id: number; branch: string; sha: string } }
  /** The CLI turn itself died (spawn failure, stall kill, non-zero exit). */
  | { kind: "turn_failed"; ticket: DevTicketRow; reason: string };

// ── tool-op result shapes (returned verbatim to the MCP server) ──

/**
 * One ticket whose branch landed on base AHEAD of ours since we forked
 * (ticket #16 T5b). Shown to the submitting agent so it has context on what
 * it just rebased onto — useful when a semantic clash blows up the gates or
 * when the rebase itself conflicts. `body_head` is the first ~120 chars of
 * the ticket body, enough to recognise "oh, THAT one".
 */
export interface LandedAheadEntry {
  id: number;
  sha: string;
  title: string;
  body_head: string;
}

export type SubmitFailure =
  | "not_holder"
  | "queued"
  | "submit_in_progress"
  | "attempts_exhausted"
  | "mid_rebase"
  | "rebase_conflict"
  | "dirty"
  | "no_commits"
  | "protected_paths"
  /** An app ticket's diff left its App's path allowlist (devpipe/app-scopes.ts). */
  | "app_scope"
  /** The agent's delivery claim is malformed or wider/narrower than the exact diff proves. */
  | "delivery_scope"
  | "knowledge_required"
  | "knowledge_context"
  | "knowledge_index"
  | "gate_failed"
  /** The thin pre-land gate (land-gate.ts) refused: tsc/lockfile/timeout. */
  | "land_gate_failed"
  /** Submit rebased concurrent landings; the agent must review and revalidate that new candidate. */
  | "base_changed_review"
  | "base_moved"
  | "merge_failed"
  | "cancelled";

export interface SubmitResult {
  knowledge_next_actions?: KnowledgeNextAction[];
  ok: boolean;
  code?: SubmitFailure;
  sha?: string;
  required_head_sha?: string;
  gate_log_tail?: string;
  files?: string[];
  /** Set on "queued": the holder or earlier FIFO reservation blocking this attempt. */
  holder?: number;
  /** Set on rebase_conflict: files with unresolved conflicts. */
  conflict_files?: string[];
  /** `git log --oneline` of the commits gained by this submit's rebase. */
  ff_commits?: string;
  /** Tickets whose commits appear in ff_commits (ticket #16 T5b). */
  landed_ahead?: LandedAheadEntry[];
  /** Explicit App-only release calls may report their publication outcome. */
  app_release?: AppReleaseRefreshOutcome;
  /**
   * Apps whose release inputs this landing changed and which are therefore
   * still serving older bytes (ticket #61). One `devpipe_app_release` call
   * settles them; the debt is durable, so it also survives the agent ignoring
   * it — the after-deploy sweep drains the same record.
   */
  app_release_owed?: string[];
  /** Final-diff delivery classification accepted by the pipeline. */
  delivery?: { mode: DeliveryPlan["mode"]; apps: string[] };
  /**
   * Set by a review-lane submit (2026-08-20): the candidate was published, not
   * landed. `status` is the proposal's first state — `ci_pending` when a forge
   * started CI, `awaiting_review` when there is none.
   */
  proposal?: { id: number; branch: string; sha: string; status: string; pipeline_url: string | null };
  message: string;
}


export interface StatusResult {
  ticket: {
    id: number;
    dev_status: string;
    deploy_status: string | null;
    /** 'direct' or 'review' — what a successful submit will do. */
    lane: string;
    branch: string | null;
    commit_sha: string | null;
  };
  lock: { held_by: number | null; reserved_for?: number | null; yours: boolean };
  base_branch: string;
  /** Commits on base not in the ticket branch / vice versa (best-effort). */
  behind_base?: number;
  ahead_of_base?: number;
  submits_left: number;
  /** Actual execution workspace facts; absent for legacy Head-local tickets. */
  development?: {
    state: "available" | "unavailable";
    device: string;
    workspace_id?: string;
    current_head_sha?: string;
    snapshot?: import("@claude-bot/runner/workspace-development-protocol").WorkspaceDevelopmentSnapshot;
    sync_required?: boolean;
    /** Null means the Runner commit is not in Head's object store; status never fetches it. */
    rebase_required?: boolean | null;
    message: string;
  };
  /** Same-turn submit lifecycle, including an MCP response that timed out client-side. */
  submit?: {
    state: "running" | "completed";
    started_at?: string;
    completed_at?: string;
    ok?: boolean;
    code?: SubmitFailure;
    message?: string;
  };
  /** Re-exposes a completed submit's refusal log when its original MCP response was lost. */
  gate_log_tail?: string;
  /** Whether the last landed sha has a warm build cache (see build-warm.ts). */
  build_warm?: string;
  message: string;
}

/** Why a human-lane landing (`land()`) was refused. Maps to HTTP status at the route. */
export type LandFailureCode =
  | "bad_branch"
  | "unknown_branch"
  | "not_ancestor"
  | "no_commits"
  | "report_missing"
  | "report_invalid"
  | "busy"
  | "gate_failed"
  /** The thin pre-land gate (land-gate.ts) refused: tsc/lockfile/timeout. */
  | "land_gate_failed"
  | "base_moved"
  | "merge_failed";

export class LandError extends Error {
  constructor(
    readonly code: LandFailureCode,
    message: string,
    readonly gateLogTail?: string,
  ) {
    super(message);
    this.name = "LandError";
  }
}

export interface LandResult {
  ok: true;
  branch: string;
  from_sha: string;
  to_sha: string;
  ticket_id: number;
  report_path: string;
  gate_log_tail: string;
  /** App releases made stale by this human/CLI landing. */
  app_release_owed?: string[];
  retrieval_receipts?: Array<{ id: string; state: "imported" | "already_imported" | "missing" | "invalid" }>;
}

export interface CliRetrievalReceiptUpload {
  id: string;
  receipt_sha256: string;
  content: string;
}

export interface CliDeliveryReconcileSummary {
  reports: number;
  processed: number;
  skipped: number;
  projected: number;
  receiptRecoveryFiles: number;
  ms: number;
}

export interface DevPipelineOpts {
  store: Store;
  /** The bot repo the worktrees hang off. */
  repoDir: string;
  worktreesDir: string;
  /** Branch gated tickets merge into (must NOT be checked out in the live tree). */
  baseBranch?: string;
  /**
   * Remote to mirror watermarks to after a fast-forward. Default `origin`;
   * null disables. Never blocks a landing and never fails one.
   */
  pushRemote?: string | null;
  /** Explicit authority cutover; absent keeps the legacy Head writer. */
  mainline?: GitLabMainline;
  /** How many turns may run at once. Default 16. */
  specConcurrency?: number;
  /** devpipe_submit attempts per turn. Default 3. */
  maxGateAttempts?: number;
  /** FIFO merge-lock wake reservation. Default 2 minutes; injectable for tests. */
  mergeLockWakeLeaseMs?: number;
  /** Wall-clock cap per turn; 0/undefined = unlimited (default). */
  turnTimeoutMs?: number;
  /** Kill a turn whose transcript stops growing for this long; 0 = disabled. Default 20 min. */
  turnStallMs?: number;
  /** Transition hook (Feishu notifications etc.). Errors are swallowed. */
  notify?: (ev: DevPipeEvent) => void;
  /** Operators whose own tickets do not earn credits backed by their own agent plans. */
  creditExcludedUsers?: readonly string[];
  /** Injectable for tests. */
  runTurn?: (cwd: string, spec: DevTurnSpec, limits?: TurnLimits) => Promise<DevTurnResult>;
  /** Optional direct-Codex account router. Absent preserves the historical process CODEX_HOME. */
  codexAccountRouter?: CodexAccountRouter;
  /**
   * Injectable for tests; default runs pnpm install + build + tsc + vitest.
   *
   * `scope` is non-null only for an app ticket, and it is passed rather than
   * looked up so the gate and the path allowlist can never disagree about which
   * App a run was trimmed for.
   */
  gate?: (worktree: string, scope?: AppTicketScope | null) => Promise<GateOutcome>;
  /**
   * Bound by the composition root that hosts Agentic Apps; see
   * `AppReleaseRefresher`. Absent = a landed app ticket says so in the
   * conversation instead of quietly not republishing.
   */
  refreshAppRelease?: AppReleaseRefresher;
  /** Exact-byte prepare/preview/activate operations for agent hot-swap approval. */
  appHotswapExecutor?: AppHotswapExecutor;
  /** Injectable for tests: the compiled MCP stdio server the CLI spawns. */
  mcpServerPath?: string;
  /** How long to wait before the auto-retry (ticket #20). Test hook. */
  turnRetryDelayMs?: number;
  /** Gap between restart-only continuation launches. Default 35s; injectable for tests. */
  restartContinuationPaceMs?: number;
  /**
   * Test hook (ticket #20): replaces `sessionTranscriptExists` when deciding
   * whether a session is already established in the CLI's on-disk transcript
   * (used to pick the short "please continue" prompt vs the full intro). The
   * default probes ~/.claude/projects/<encoded>/<id>.jsonl.
   */
  sessionExists?: (cwd: string, sessionId: string | null | undefined) => boolean;
  /**
   * The deployed run checkout (`selfhosting.run_dir`), read-only.
   *
   * Absent = this composition cannot publish an App release from the deployed
   * tree, and `devpipe_app_release` says so instead of guessing a path.
   */
  runTreeDir?: string;
  /**
   * The thin pre-land gate (land-gate.ts): incremental tsc + frozen-lockfile
   * install against the candidate tree before ANY ff, both doors. Default ON
   * (`selfhosting.land_gate: false` disables). Typecheck only by design — the
   * batched post-submit CI stays the complete verdict.
   */
  landGateEnabled?: boolean;
  /**
   * Run a CI repair ticket's own failure roster in the gate before letting it
   * land (default ON; `selfhosting.ci_roster_gate: false` disables just this
   * step). See land-gate.ts and ci-roster.ts for why this one lane gets a
   * vitest step the general landing path deliberately does not have.
   */
  ciRosterGateEnabled?: boolean;
  /**
   * Run the spec files a landing's own diff touched (plus their sibling tests)
   * in the gate before any ff, both doors (default ON;
   * `selfhosting.changed_tests_gate: false` disables just this step). The
   * measured dominant red-batch class is a landing whose own diff contains the
   * spec file that then fails in CI — see land-gate.ts.
   */
  changedTestsGateEnabled?: boolean;
  /** Default true. Tests may disable only when exercising an older orthogonal contract. */
  knowledgeCaptureEnabled?: boolean;
  /**
   * Directory for the derived knowledge graph (`<dataDir>/knowledge`). When
   * set, startup packs, `devpipe_context` and submit-time acknowledgement
   * come from the graph; when unset the 2026-08-19 whole-document FTS index
   * is used. See packages/bot/src/knowledge/CLAUDE.md.
   */
  knowledgeGraphDir?: string;
  knowledgeGraphRemoteBuild?: import("./knowledge-graph-service.js").KnowledgeGraphServiceOpts["remoteBuild"];
  /** Trusted remote-artifact composition; absent keeps graph-only retrieval. */
  knowledgeArtifactFactory?: (graph: KnowledgeGraphService) => KnowledgeArtifactService | null;
  /** Injectable for tests: replaces the gate's real install/build/tsc check. */
  landGateCheck?: (dir: string, candidate?: LandGateCandidate) => Promise<LandGateOutcome>;
  /**
   * Opens a session on the CI machine for one land-gate check (remote-gate.ts):
   * the gate's steps run there, in a pipeline-owned workspace, and fall back
   * to `_land` here when the opener returns null or the machine stops
   * answering. Absent = every check runs on this node.
   */
  landGateRemote?: RemoteGateOpener;
  landGateRemoteRequired?: boolean;
  /**
   * Post-landing build warming (build-warm.ts): after a landing ffs the base
   * branch, build the landed sha in the `_warm` worktree so the deploy that
   * follows restores from the build cache instead of rebuilding while the
   * requester waits. Default ON (`selfhosting.build_warm: false` disables).
   */
  buildWarmEnabled?: boolean;
  /** Injectable for tests: a warmer whose steps are stubbed. */
  buildWarmer?: BuildWarmer;
  /**
   * Hands an eligible development turn read/write/exec on the lht-val15 CI
   * container. Absent = the turn works on this node only and its prompt says
   * nothing about machine tools.
   */
  ciMachine?: CiMachineOpener;
  ciWorkspaceProvider?: (requester: string) => WorkspaceProvider | null;
  /** codex-runner family (#358): relay grants onto the requester's own device. */
  remoteCodex?: RemoteCodexOpener;
  /** Syncs an exact ticket commit into its isolated container worktree. */
  ciMachineSync?: CiMachineSync;
  /**
   * How many workspace syncs may run on the CI machine at once (default 1):
   * an install plus three builds per ticket, three tickets at once, was what
   * saturated the box on 2026-08-22. See `slot-gate.ts`.
   */
  ciSyncConcurrency?: number;
  /**
   * Resource waiters (2026-08-22): the pipeline registers the `dev-ticket/`
   * scope notifier and records its own syncs' unavailable answers. Absent =
   * a local durable service is used; timed probes still recover missed presence.
   */
  resourceRecovery?: ResourceRecoveryService;
  managedSupervisor?: ManagedExecutionSupervisor;
  /** Grace/pace overrides for deterministic failure-injection tests. */
  resourceWait?: { graceMs?: number; retryMs?: number; waitingRetryMs?: number };
  /** Override for the machines MCP server path (tests, unusual layouts). */
  machinesServerPath?: string;
  /**
   * Which lane a requester's tickets take (2026-08-20). Default: everybody is
   * `direct`, the historical behaviour. The composition root binds it to the
   * capability resolver so a `contribute`-only account lands through review,
   * and the pipeline re-asks at submit time so a revoked `dev` takes effect on
   * the next landing attempt.
   */
  resolveLane?: (requester: string) => DevTicketLane;
  /** The review lane's forge adapter. Default: no forge — review starts without CI. */
  proposalPublisher?: ProposalPublisher;
}



/**
 * Default location of the compiled MCP stdio server. Two layouts to cover:
 * running from source via tsx (here = …/packages/bot/src/devpipe) and running
 * the tsup bundle (the pipeline is inlined into dist/bootstrap-v3.js, so here =
 * …/packages/bot/dist). Probe rather than assume.
 */
function defaultMcpServerPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "..", "..", "dist", "devpipe", "mcp-server.js"), // src layout
    path.join(here, "devpipe", "mcp-server.js"), // bundled layout
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0]; // best guess; writeMcpConfig logs if the spawn later fails
}

/**
 * The machines MCP server, which lives in `plugins/` rather than in this
 * package. Same probe shape as above: from `packages/bot/src/devpipe` and from
 * the bundled `packages/bot/dist`, the repo root is four and three levels up.
 */
function defaultMachinesServerPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "..", "..", "..", "..", "plugins", "machines", "dist", "server.js"), // src layout
    path.join(here, "..", "..", "..", "plugins", "machines", "dist", "server.js"), // bundled layout
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0];
}

/**
 * A per-turn credential for the CI container's Runner.
 *
 * The pipeline deliberately does NOT know about RunnerCapabilities, the
 * capability kernel or the loopback: it asks a port for "a machines credential
 * for this user, for this long", and closes it when the turn ends. Everything
 * about WHICH device, WHICH rights and whether they run unsupervised is
 * decided by whoever implements this in the composition root.
 */
export interface CiMachineGrant {
  apiUrl: string;
  apiToken: string;
  /** The device + checkout the prompt should describe. */
  target: CiMachineTarget;
  /** Revokes the credential and destroys its Context. Idempotent. */
  close(): void;
}

/** Opens the grant above, or null when no Runner is online for that user. */
export type CiMachineOpener = (username: string, purpose: string) => CiMachineGrant | null;

/**
 * A per-turn relay lease onto the requester's OWN Runner device's Codex
 * (#358). Like `CiMachineGrant`, the pipeline never learns how the grant is
 * made — it asks for "this user's own Codex device", optionally pinned to the
 * device an earlier turn bound the session to, and closes it with the turn.
 */
export interface RemoteCodexLease {
  device: string;
  online: boolean;
  call: (op: string, args: Record<string, unknown>) => Promise<unknown>;
  /** Revokes the relay grant. Idempotent. */
  close: () => void;
}

/**
 * Opens the lease above; null when the user owns no usable Codex device (or,
 * with `preferredDevice`, no longer owns that exact device).
 */
export type RemoteCodexOpener = (
  username: string,
  purpose: string,
  preferredDevice?: string,
) => RemoteCodexLease | null;

export interface RemoteTicketTranscriptRead {
  maxMessages: number;
  offset?: number;
}

/**
 * The dashboard's deliberately narrow view of a remote Codex lease. It can
 * read exactly one ticket-supplied session id through the pinned device; it
 * cannot drive app-server tunnels or select another CLI namespace.
 */
export interface RemoteTicketTranscriptLease {
  device: string;
  read(input: RemoteTicketTranscriptRead): Promise<unknown>;
  close(): void;
}

/**
 * Bring one isolated CI-container workspace up to an exact ticket ref.
 *
 * The container is an ENVIRONMENT (Node, pnpm, browsers, a warm node_modules),
 * never a snapshot of the code. Left alone it drifts behind mainline within a
 * day of ordinary landings, and a repair agent that cannot check out the
 * failing sha cannot reproduce the failure — which puts it right back to
 * guessing, the thing this whole ticket exists to stop. So the pipeline owns
 * that checkout and moves it; the agent is told where it was put.
 *
 * Best-effort by contract: a failure returns `ok: false` and the turn still
 * runs, with a prompt that says the checkout may be stale. Losing the machine
 * lane is slower feedback; blocking development on it would be an outage.
 */
export type CiMachineSync = (input: {
  sourceDir: string;
  ref: string;
  ticketId: number;
  /** Whose machine this is, so the composition can pick the transport (ssh vs Runner). */
  requester: string;
  target: CiMachineTarget;
}) => Promise<CiSyncOutcome>;

export interface CiSyncOutcome {
  ok: boolean;
  sha?: string;
  checkoutDir?: string;
  detail?: string;
}

/** What `rebaseOntoBase` reports; shared by both submit lanes. */
type RebaseOutcome =
  | { kind: "read_error"; err: string }
  | { kind: "clean"; ff_commits: string; landed_ahead: LandedAheadEntry[] }
  | { kind: "conflict"; ff_commits: string; landed_ahead: LandedAheadEntry[]; conflicts: string[] };

// ── the pipeline ──

interface TurnCtx {
  ticketId: number;
  turn: number;
}

/** Exact landing facts retained until the agent turn has written its reply. */
interface LandedTurnReceipt {
  sha: string;
  deliveryMode: DeliveryPlan["mode"];
  affectedAppCount: number;
}

export interface TicketRetrievalFeedbackInput {
  trace_id: RetrievalTraceId;
  code: RetrievalFeedbackCode;
  slot?: RetrievalSlot;
  expected_record_id?: string;
}


export class DevPipeline {
  private store: Store;
  /** Caller must pass the persisted, visibility-checked ticket. */
  readTicketFiles(ticket: DevTicketRow, filePath: string, window: { offset?: number; cursor?: string } = {}) {
    return readTicketFiles(this.repoDir, this.baseBranch, ticket, filePath, window);
  }

  private repoDir: string;
  private worktreesDir: string;
  readonly baseBranch: string;
  readonly specConcurrency: number;
  private maxSubmitsPerTurn: number;
  private turnLimits: TurnLimits;
  private notifyFn: (ev: DevPipeEvent) => void;
  private runTurn: (cwd: string, spec: DevTurnSpec, limits?: TurnLimits) => Promise<DevTurnResult>;
  /** Frozen legacy fixtures only; no configuration can enable Head execution. */
  private readonly legacyTestExecution: boolean;
  private gateFn: (
    worktree: string,
    scope?: AppTicketScope | null,
    steps?: ReadonlyArray<GateStep>,
  ) => Promise<GateOutcome>;
  private mcpServerPath: string;
  private machinesServerPath: string;
  private readonly ciMachine: CiMachineOpener | null;
  private readonly ciWorkspaceProvider: ((requester: string) => WorkspaceProvider | null) | null;
  private runnerTickets: TicketRunnerAccess | null = null;
  private readonly runnerInputWake = new Map<number, () => void>();
  private readonly remoteCodex: RemoteCodexOpener | null;
  private readonly ciMachineSync: CiMachineSync | null;
  private readonly resourceRecovery: ResourceRecoveryService;
  private readonly managedSupervisor: ManagedExecutionSupervisor;
  private readonly ownsManagedSupervisor: boolean;
  private readonly managedTicketJobs = new Map<number, string>();
  private readonly managedTicketLeases = new Map<number, ExecutionLease>();
  private readonly resourceWait?: DevPipelineOpts["resourceWait"];
  private detachManagedTickets?: () => void;
  private readonly recoveryUnsubscribe: () => void;
  /** Paces workspace syncs across tickets; the machine is shared. */
  private readonly ciSyncGate: SlotGate;
  /** Active per-turn CI targets; presence is also the authorization check for ci-sync. */
  private readonly ciWorkspaces = new Map<string, CiMachineTarget>();
  /** The one sync a ticket's workspace may have in flight; `devpipe_ci_sync` joins it. */
  private readonly ciSyncInFlight = new Map<number, { sha: string; promise: Promise<CiSyncOutcome> }>();
  private turnRetryDelayMs: number;
  private sessionExistsFn: (cwd: string, sessionId: string | null | undefined) => boolean;
  private readonly codexAccountRouter: CodexAccountRouter | null;

  /** Loopback URL of the dashboard (tool endpoints); unset = tools disabled. */
  private toolApiUrl: string | null = null;

  private running = new Set<number>();
  /**
   * Restart-only continuations discovered at boot.
   *
   * A deployment can interrupt several Codex tickets together. Starting all
   * of their fresh app-server processes at once on the two-core host made the
   * 30s `thread/resume` setup budget expire for every ticket. Those RPC
   * timeouts are deliberately NOT replayed (their outcome is uncertain), so
   * prevent the cold-start burst instead: their launches are paced beyond one
   * resume budget while already-attached turns and ordinary user work may use
   * the other slots.
   */
  private restartContinuations = new Set<number>();
  private readonly restartContinuationPaceMs: number;
  private restartPaceTimer: NodeJS.Timeout | null = null;
  private scheduling = false;
  private pendingKick = false;
  /** Scheduling stays closed until every late-bound turn capability is ready. */
  private started = false;
  private stopped = false;
  /** Turns currently in flight — `stop()` waits on these. */
  private inflight = new Set<Promise<void>>();
  /** Serializes git ops on the shared repo (concurrent `worktree add` fights over index.lock). */
  private gitLock: Promise<unknown> = Promise.resolve();
  private turnSeq = 1;

  /** Per-turn bearer tokens for the MCP loopback. Deleted at turn end, so a
   * late tool call from a killed turn fails closed. */
  private turnTokens = new Map<string, TurnCtx>();
  private developmentWorkspaces: DevelopmentWorkspaceService | null = null;
  private developmentMcpIssue: ((binding: DevelopmentTurnBinding) => DevelopmentMcpCredential) | null = null;
  private readonly parkedRunnerContexts = new Map<string, { token: string; configPath?: string }>();
  private readonly developmentCredentials = new Map<string, { binding: DevelopmentTurnBinding; credential: DevelopmentMcpCredential }>();
  /**
   * THE merge lock — exactly one submit at a time runs its rebase → gates → ff
   * phase. `FairWakeLock` owns FIFO order, one-at-a-time wakes and reservation
   * leases; the pipeline only supplies ticket eligibility and inbox delivery.
   */
  private readonly mergeLock: FairWakeLock<number, string>;
  private excludeEnsured = false;
  /** token → submit attempts spent this turn. */
  private submitCounts = new Map<string, number>();
  /**
   * One submit per turn token. A client timeout does not cancel the HTTP
   * operation, so accepting a second call would run the same worktree and gate
   * concurrently, burn another attempt, and let either call release the other's
   * merge lock.
   */
  private submitOps = new Map<string, { startedAt: number; operation: Promise<SubmitResult> }>();
  /** Latest completed result lets devpipe_status recover a response lost at the MCP boundary. */
  private submitResults = new Map<string, { completedAt: number; result: SubmitResult }>();
  /** Landing receipts awaiting the turn's final conversation record. */
  private landedTurns = new Map<string, LandedTurnReceipt>();
  /** ticketId → tool ops in flight (feeds the executor's stall-watcher hold). */
  private toolOps = new Map<number, number>();
  /**
   * Stop requests for a RUNNING turn (ticket #184), by ticket id.
   *
   * Deliberately in-memory and deliberately not a ticket column: it describes
   * one child process this process is holding, and it must not outlive it. A
   * request that survived a restart would stop the wrong turn — the next one,
   * which nobody asked to stop.
   */
  private interruptRequests = new Map<number, string>();
  /**
   * ticketId → the running turn's interjection channel (ticket #183).
   *
   * Installed with the `turn_started_at` marker, before the provider transport
   * finishes starting. Calls made in that gap stay pending until the transport
   * publishes its real channel; the row is stamped only after that channel
   * accepts it. The durable inbox remains the fallback on refusal or close.
   */
  private liveTurns = new Map<number, {
    turn: number;
    deliver: (text: string) => boolean | Promise<boolean>;
  }>();
  /** One human-lane landing at a time (see `land()`). */
  private landing = false;
  private mainlineLanding = false;
  /** The thin pre-land gate + owner of the `_land` staging worktree. */
  private readonly landGate: LandGate;
  private readonly knowledgeIndex: RepositoryKnowledgeIndex;
  private readonly knowledgeCaptureEnabled: boolean;
  private readonly knowledgeGraph: KnowledgeGraphService | null;
  private readonly knowledgeArtifact: KnowledgeArtifactService | null;

  /**
   * Post-landing build warming + owner of the `_warm` staging worktree.
   *
   * Deliberately a separate worktree and a separate queue from `landGate`: a
   * warm build must never delay the next ticket's landing gate, which is what
   * sharing `_land` would do.
   */
  private readonly buildWarmer: BuildWarmer;

  /** Where watermarks get mirrored after a fast-forward. Null = nowhere. */
  private readonly pushRemote: string | null;
  private readonly mainline?: GitLabMainline;
  private readonly integrationLeases = new Map<string, IntegrationLeaseKeeper>();
  private mainlinePoll: NodeJS.Timeout | null = null;
  private mainlineSync: Promise<void> | null = null;
  private mainlineWake = "";

  /**
   * The deployed run checkout, when this composition has one.
   *
   * Read-only here, and only ever as a SOURCE to pack an App release from: it
   * is the one tree on this host that is always installed, always built, and
   * always exactly the code the running process is. Never written, never
   * checked out — see `doc/runbooks/app-release.md`.
   */
  private readonly runTreeDir: string | null;

  /** Owns everything about turning a landed App ticket into a served release. */
  private readonly appReleases: AppReleaseCoordinator;

  /** Serialises the best-effort backup pushes. Never rejects. */
  private pushChain: Promise<void> = Promise.resolve();

  /** Which lane a requester lands through; see `DevPipelineOpts.resolveLane`. */
  private readonly resolveLane: (requester: string) => DevTicketLane;
  /** The review lane's forge. */
  private readonly proposalPublisher: ProposalPublisher;
  /** Normalized at composition; an empty set means every requester earns. */
  private readonly creditExcludedUsers: ReadonlySet<string>;

  constructor(opts: DevPipelineOpts) {
    this.store = opts.store;
    this.mainline = opts.mainline;
    this.repoDir = opts.repoDir;
    this.worktreesDir = opts.worktreesDir;
    this.baseBranch = opts.baseBranch ?? "main";
    this.knowledgeIndex = new RepositoryKnowledgeIndex(this.store, this.repoDir);
    this.knowledgeCaptureEnabled = opts.knowledgeCaptureEnabled ?? true;
    this.knowledgeGraph = opts.knowledgeGraphDir
      ? new KnowledgeGraphService({ store: this.store, repoDir: this.repoDir, baseBranch: this.baseBranch, dir: opts.knowledgeGraphDir,
        ...(opts.knowledgeGraphRemoteBuild ? { remoteBuild: opts.knowledgeGraphRemoteBuild } : {}) })
      : null;
    this.knowledgeArtifact = this.knowledgeGraph && opts.knowledgeArtifactFactory
      ? opts.knowledgeArtifactFactory(this.knowledgeGraph)
      : null;
    this.specConcurrency = Math.max(1, opts.specConcurrency ?? DEFAULT_SPEC_CONCURRENCY);
    this.maxSubmitsPerTurn = Math.max(1, opts.maxGateAttempts ?? DEFAULT_MAX_SUBMITS_PER_TURN);
    this.turnLimits = { timeoutMs: opts.turnTimeoutMs, stallMs: opts.turnStallMs ?? DEV_STALL_TIMEOUT_MS };
    this.notifyFn = opts.notify ?? (() => {});
    this.creditExcludedUsers = new Set((opts.creditExcludedUsers ?? []).map((name) => name.trim()).filter(Boolean));
    this.legacyTestExecution = process.env.VITEST === "true" && Boolean(opts.runTurn);
    if (opts.runTurn && !this.legacyTestExecution) throw new Error("Head 工单执行器已停用，请配置 Runner");
    this.runTurn = opts.runTurn ?? (async () => { throw new Error("Head 工单执行器已停用，请配置 Runner"); });
    this.codexAccountRouter = opts.codexAccountRouter ?? null;
    this.gateFn = opts.gate ?? defaultGate;
    this.mcpServerPath = opts.mcpServerPath ?? defaultMcpServerPath();
    this.machinesServerPath = opts.machinesServerPath ?? defaultMachinesServerPath();
    this.ciMachine = opts.ciMachine ?? null;
    this.remoteCodex = opts.remoteCodex ?? null;
    this.ciMachineSync = opts.ciMachineSync ?? null;
    this.ciWorkspaceProvider = opts.ciWorkspaceProvider ?? null;
    this.ciSyncGate = new SlotGate(Math.max(1, Math.floor(opts.ciSyncConcurrency ?? 1)));
    this.resourceRecovery = opts.resourceRecovery ?? new ResourceRecoveryService(this.store.resourceWaiters);
    this.mergeLock = new FairWakeLock<number, string>({
      leaseMs: Math.max(1, opts.mergeLockWakeLeaseMs ?? DEFAULT_MERGE_LOCK_WAKE_LEASE_MS),
      wake: (ticketId) => this.wakeMergeLockWaiter(ticketId),
      onWakeError: (ticketId, err) => {
        log.warn({ err: msg(err), ticket: ticketId }, "devpipe: could not wake merge-lock waiter; trying next");
        try {
          this.store.devTickets.moveMergeWaiterToTail(ticketId);
        } catch (persistErr) {
          log.error({ err: msg(persistErr), ticket: ticketId }, "devpipe: could not rotate durable merge-lock waiter");
        }
      },
      onLeaseExpired: (ticketId) => {
        log.warn({ ticket: ticketId }, "devpipe: merge-lock wake reservation expired; trying next");
        try {
          this.store.devTickets.moveMergeWaiterToTail(ticketId);
        } catch (persistErr) {
          log.error({ err: msg(persistErr), ticket: ticketId }, "devpipe: could not persist merge-lock lease rotation");
        }
        this.note(
          ticketId,
          "ℹ FIFO 合并锁唤醒租约已超时,流水线已让下一位先尝试;本票以后再次 submit 会重新排到队尾。",
        );
      },
      onEvent: (event) => {
        const level = event.type === "wake_error" || event.type === "reservation_expired" ? "warn" : "info";
        log[level]({
          merge_lock_event: event.type,
          ...event,
          holder: this.mergeLock?.holderId ?? null,
          reserved: this.mergeLock?.reservedFor ?? null,
          waiters: this.mergeLock?.waiterIds() ?? [],
        }, "devpipe: merge lock transition");
      },
    });
    // A ticket told "the machine is away" hears about its return as a
    // pipeline message: that wakes an idle ticket and is streamed into a
    // running turn, so the agent needs no new channel to learn it.
    this.recoveryUnsubscribe = this.resourceRecovery.registerScope("dev-ticket/", (waiter) => this.onResourceRecovered(waiter));
    this.managedSupervisor = opts.managedSupervisor ?? new ManagedExecutionSupervisor(this.store.managedExecutions, this.resourceRecovery);
    this.ownsManagedSupervisor = !opts.managedSupervisor;
    this.resourceWait = opts.resourceWait;
    this.turnRetryDelayMs = Math.max(0, opts.turnRetryDelayMs ?? DEFAULT_TURN_RETRY_DELAY_MS);
    this.restartContinuationPaceMs = Math.max(
      0,
      opts.restartContinuationPaceMs ?? DEFAULT_RESTART_CONTINUATION_PACE_MS,
    );
    this.pushRemote = opts.pushRemote === undefined ? "origin" : opts.pushRemote;
    this.sessionExistsFn = opts.sessionExists ?? sessionTranscriptExists;
    this.runTreeDir = opts.runTreeDir ?? null;
    this.resolveLane = opts.resolveLane ?? (() => "direct");
    this.proposalPublisher = opts.proposalPublisher ?? NO_FORGE_PUBLISHER;
    // `note` is passed bound rather than reimplemented: it stamps the current
    // turn sequence, which is turn state the coordinator deliberately lacks.
    this.appReleases = new AppReleaseCoordinator({
      store: this.store,
      repoDir: this.repoDir,
      runTreeDir: this.runTreeDir,
      baseBranch: this.baseBranch,
      note: (ticketId, body) => this.note(ticketId, body),
      noteOnce: (ticketId, body) => this.noteOnce(ticketId, body),
      refreshAppRelease: opts.refreshAppRelease ?? null,
      appHotswapExecutor: opts.appHotswapExecutor ?? null,
    });
    this.landGate = new LandGate({
      repoDir: this.repoDir,
      worktreesDir: this.worktreesDir,
      enabled: opts.landGateEnabled ?? true,
      rosterGateEnabled: opts.ciRosterGateEnabled ?? true,
      changedTestsGateEnabled: opts.changedTestsGateEnabled ?? true,
      ...(opts.landGateCheck ? { check: opts.landGateCheck } : {}),
      ...(opts.landGateRemote ? { remote: opts.landGateRemote } : {}),
      remoteRequired: opts.landGateRemoteRequired === true,
    });
    this.buildWarmer =
      opts.buildWarmer ??
      new BuildWarmer({
        repoDir: this.repoDir,
        worktreesDir: this.worktreesDir,
        enabled: opts.buildWarmEnabled ?? true,
        // Creating `_warm` takes the shared repo's index.lock once; a landing
        // must never lose that race to a cache optimisation.
        gitLock: (fn) => this.withGitLock(fn),
      });
  }

  // ── public API (panel/commands call these; every mutation kicks the pump) ──

  createTicket(input: DevTicketInput): DevTicketRow {
    if (input.model === FABLE_TICKET_MODEL) {
      throw new Error("Fable 工单必须经 lht 审批服务创建，不能直接启动");
    }
    return this.createAdmittedTicket(input);
  }

  /** The capability adapter's only entry after lht approved the frozen call. */
  createApprovedFableTicket(input: DevTicketInput): DevTicketRow {
    if (input.model !== FABLE_TICKET_MODEL) {
      throw new Error("Fable 审批入口只接受精确的 Fable 模型");
    }
    return this.createAdmittedTicket(input);
  }

  private createAdmittedTicket(input: DevTicketInput): DevTicketRow {
    if (input.parent_ticket_id != null && !this.store.devTickets.getDevTicket(input.parent_ticket_id)) {
      throw new Error(`父工单不存在: #${input.parent_ticket_id}`);
    }
    // An app ticket without a resolvable scope is refused HERE rather than at
    // submit. The scope is the entire contract of this kind — it decides both
    // the path allowlist and which tests run — so a ticket that cannot name one
    // would spend a whole turn writing code the merge phase was always going to
    // refuse.
    if (input.kind === "app" && !appScopeFor(input.app_id)) {
      throw new Error(
        `App 工单需要指定一个本仓库认识的 App(收到 ${input.app_id ? `\`${input.app_id}\`` : "空"});`
          + `可选:${APP_TICKET_SCOPES.map((s) => s.appId).join("、") || "(本构建没有可开 App 工单的 App)"}`,
      );
    }
    // The lane is the pipeline's decision, never the caller's: a body field
    // saying `lane: "direct"` from a contributor would otherwise be a one-line
    // bypass of the whole review lane.
    const normalized = normalizeDevTicketInput({ ...input, lane: this.resolveLane(input.requester) });
    if ((input.agent_source || input.workspace) && !this.runnerTickets) throw new Error("Runner 工单执行未启用");
    const configuredWorkspaces = this.runnerTickets?.config.targets[this.runnerTickets.resourceOwner(input.requester)]?.workspaces;
    const binding = this.runnerTickets && (input.agent_source || input.workspace || configuredWorkspaces)
      ? this.runnerTickets.resolve(input.requester, normalized.model, input.agent_source, input.workspace) : undefined;
    const t = this.store.devTickets.createDevTicket({ ...normalized, ...(binding ? { runner_binding: binding } : {}) });
    this.kick(); // creation seeded the inbox — the first turn starts NOW
    return t;
  }

  /**
   * Keep a ticket's persisted execution lane aligned with the requester's
   * current authority.
   *
   * The row records the decision so prompts, status and submit agree, but it
   * is not an irrevocable grant: promoting a contributor to `dev` must let an
   * existing ticket use the direct lane, while revoking `dev` must move the
   * next turn back behind review. The resolver remains the sole authority.
   */
  private reconcileLane(t: DevTicketRow): DevTicketRow {
    const lane = this.resolveLane(t.requester);
    if (t.lane === lane) return t;
    this.store.devTickets.updateDevTicket(t.id, { lane });
    log.info({ ticket: t.id, requester: t.requester, from: t.lane, to: lane }, "devpipe: ticket lane reconciled");
    return this.store.devTickets.getDevTicket(t.id)!;
  }

  /**
   * `actorKind` is how the caller authenticated the write (review 6.10); the
   * Dashboard route derives it from its identity. Omitted = `system` for the
   * pipeline/agent authors, unknown (NULL) otherwise.
   */
  postMessage(ticketId: number, author: string, via: string, body: string, actorKind?: TicketActorKind | null): TicketMessageRow {
    const t = this.store.devTickets.getDevTicket(ticketId);
    if (!t) throw new Error(`工单不存在: #${ticketId}`);
    if (t.native_binding) throw new Error("native CLI messages must use the native input endpoint");
    if (t.dev_status === "cancelled") throw new Error("工单已取消,不再接收消息");
    const row = this.store.devTickets.addTicketMessage(ticketId, author, via, body, undefined, actorKind);
    // A new human message while idle is an explicit continuation. Messages
    // typed during an in-flight stop remain queued until that stop settles.
    if (t.chat_paused && !t.turn_started_at && author !== "pipeline") {
      this.store.devTickets.updateDevTicket(ticketId, { chat_paused: 0 });
    }
    // Ticket #201: the question is answered when the person speaks. Clearing it
    // here rather than in the next turn is what makes the board stop nagging in
    // the same gesture that answered it — and it is cleared by ANY human
    // message, because "I asked something else instead" is also an answer to
    // "does this still need me".
    if (t.open_question && author !== "pipeline") {
      this.store.devTickets.updateDevTicket(ticketId, { open_question: null });
    }
    const deliveredTurn = this.legacyTestExecution && !this.runnerTickets ? this.interject(ticketId, row) : null;
    this.runnerInputWake.get(ticketId)?.();
    // Still kick: an undelivered message needs a turn, and a delivered one may
    // be sharing the ticket with older queued messages.
    this.kick();
    // `row` is the INSERT result. `interject()` stamps the database afterwards,
    // so returning it verbatim used to tell the browser "queued" even when the
    // running transport had accepted the message. Return the receipt for the
    // state reached by this request, not the stale pre-delivery snapshot.
    return deliveredTurn === null ? row : { ...row, delivered_turn: deliveredTurn };
  }

  /**
   * Offer a just-posted message to the turn running RIGHT NOW (ticket #183).
   *
   * Order matters: the row is written first, then handed to the transport, and
   * only stamped as delivered once the transport accepted it. A refusal at any
   * point therefore leaves an ordinary unread message that the next turn picks
   * up — the old behaviour — instead of a message that silently belongs to
   * nobody.
   */
  private interject(ticketId: number, row: TicketMessageRow): number | null {
    // A turn somebody just stopped (#184) is on its way out under SIGINT. Its
    // channel may still be open for a moment, but anything handed to it now
    // dies with the child — so treat a stop as a closed channel and let the
    // message wake the next turn instead.
    const live = this.interruptRequests.has(ticketId) ? undefined : this.liveTurns.get(ticketId);
    const delivery = live?.deliver(buildInterjectionPrompt([row]));
    if (delivery instanceof Promise) {
      // app-server acknowledges `turn/steer` asynchronously. Until that
      // authoritative response arrives the row honestly remains 待送达; an
      // acceptance stamps it, while a refusal leaves the ordinary inbox as
      // the fallback for the next ticket turn.
      void delivery.then((accepted) => {
        if (accepted) {
          if (this.store.devTickets.markTicketMessageDelivered(row.id, live!.turn)) {
            log.info(
              { ticket: ticketId, message: row.id, turn: live!.turn },
              "devpipe: message delivered into the running turn",
            );
          }
          return;
        }
        this.noteQueuedInterjection(ticketId, row.id);
      }).catch(() => this.noteQueuedInterjection(ticketId, row.id));
      return null;
    }
    if (delivery) {
      this.store.devTickets.markTicketMessageDelivered(row.id, live!.turn);
      log.info(
        { ticket: ticketId, message: row.id, turn: live!.turn },
        "devpipe: message delivered into the running turn",
      );
      return live!.turn;
    }
    this.noteQueuedInterjection(ticketId, row.id);
    return null;
  }

  private noteQueuedInterjection(ticketId: number, messageId: number): void {
    // Say so when the wait is real. A transport without live input, or one
    // already finishing, used to look identical to an agent ignoring the
    // message. Once per
    // turn is enough: repeating it under every message of a chatty minute
    // would bury the conversation it is trying to explain.
    const startedAt = this.store.devTickets.getDevTicket(ticketId)?.turn_started_at;
    if (startedAt && !this.hasQueuedNoticeSince(ticketId, startedAt)) {
      this.note(ticketId, QUEUED_NOTICE);
    }
    log.info(
      { ticket: ticketId, message: messageId, running: Boolean(startedAt) },
      "devpipe: message queued for the next turn",
    );
  }

  private hasQueuedNoticeSince(ticketId: number, turnStartedAt: string): boolean {
    return this.store.devTickets
      .listTicketMessages(ticketId)
      .some((m) => m.author === "pipeline" && m.body === QUEUED_NOTICE && m.created_at >= turnStartedAt);
  }

  /**
   * Append a pipeline-authored, pre-delivered line to a ticket without
   * waking a turn. Same writer as the private `note()` helper — public
   * so integration adapters (e.g. `gitlab-ci` verifying a repair) can
   * record an outcome that the human panel sees without producing an
   * inbox message the agent would need to answer. No-op on cancelled or
   * missing tickets (nothing to note against).
   */
  postPipelineNote(ticketId: number, body: string): void {
    const t = this.store.devTickets.getDevTicket(ticketId);
    if (!t || t.dev_status === "cancelled") return;
    this.note(ticketId, body);
  }

  /**
   * Everything that landed between the last green batch and this red one, with
   * the tickets behind it (#219).
   *
   * A red names a file; the cause is in the range. Handing the agent only the
   * assertion is what makes editing that file look like the obvious move, so
   * the range travels with every repair ticket — including the requester's
   * original ask and the agent's own summary for each ticket in it.
   *
   * Best-effort: a Git failure returns a short note rather than throwing, since
   * losing the history must never stop a repair ticket from being opened.
   */
  async ciChangeHistory(fromSha: string | null, toSha: string): Promise<string> {
    try {
      const range = fromSha ? `${fromSha}..${toSha}` : `${toSha}~20..${toSha}`;
      const out = await git(this.repoDir, ["log", "--no-merges", "--format=%H%x00%s", range]);
      if (!out.ok) return `(取不到 ${fromSha ?? "?"}..${toSha} 的改动历史:${out.stderr.slice(0, 200)})`;
      const commits: Array<Omit<CiRangeCommit, "ticketId">> = [];
      for (const line of out.stdout.split("\n")) {
        const [sha, subject] = line.split("\u0000");
        if (!sha) continue;
        commits.push({ sha, subject: subject ?? "" });
      }
      return renderCiChangeHistory(
        this.store,
        fromSha,
        toSha,
        associateCiRangeCommits(this.store, commits),
      );
    } catch (err) {
      return `(取改动历史时出错:${msg(err)})`;
    }
  }

  /**
   * Park a question on a ticket from OUTSIDE a turn (#219).
   *
   * The agent's own route is `devpipe_ask` / submit's `open_question`. This is
   * for the pipeline itself: when automatic repair gives up, the board has to
   * say "needs you" rather than leaving a landed-looking ticket that nobody
   * has a reason to reopen. Any human message clears it, exactly as it does
   * for an agent-asked question.
   */
  setOpenQuestion(ticketId: number, question: string): void {
    const t = this.store.devTickets.getDevTicket(ticketId);
    if (!t || t.dev_status === "cancelled") return;
    this.store.devTickets.updateDevTicket(ticketId, { open_question: question.slice(0, 300) });
  }

  /**
   * Close the question without answering it (#236).
   *
   * The question axis clears when a person speaks, which assumes the person has
   * something to say. "I am not going to answer this" is also a decision, and
   * until now the only ways to express it were to type a message — which wakes
   * the agent for a turn nobody asked for — or to cancel the ticket, which is
   * refused once it has landed. So the reader of a landed ticket had no way at
   * all to take the question off the board.
   *
   * This clears that axis and nothing else: no turn, no status change, no inbox
   * message. The dismissal is recorded as a pipeline note because the agent
   * asked in public, and a question that silently disappears leaves the next
   * reader — and the next turn's transcript — without the actual answer, which
   * is "we decided not to".
   *
   * Idempotent: a second tab, or a click that races the requester's own reply,
   * must not become an error the reader has to interpret.
   */
  dismissQuestion(ticketId: number, by?: string): DevTicketRow {
    const t = this.store.devTickets.getDevTicket(ticketId);
    if (!t) throw new Error(`工单不存在: #${ticketId}`);
    if (!t.open_question) return t;
    this.store.devTickets.updateDevTicket(ticketId, { open_question: null });
    this.note(ticketId, `🙋 ${by || t.requester} 关闭了这个未决问题(选择不回答):${t.open_question}`);
    return this.store.devTickets.getDevTicket(ticketId)!;
  }

  /**
   * Widen a repair ticket's failure roster with a newly routed red (#219).
   *
   * Union, never replace: once a second red lands in this conversation the
   * ticket owes BOTH rosters, so "fix A, break B, fix B, break A" has no point
   * in its cycle where the land gate would let it through. Returns the roster
   * now in force so the caller can tell the agent what it is accountable for.
   *
   * Only meaningful on a ticket already in the lane — an ordinary ticket that
   * happens to be the routing target keeps `ci_roster` NULL rather than
   * silently acquiring a contract its agent was never told about.
   */
  widenCiRoster(ticketId: number, files: readonly string[]): string[] {
    const t = this.store.devTickets.getDevTicket(ticketId);
    if (!t || t.dev_status === "cancelled" || !isCiRepairTicket(t)) return [];
    const merged = mergeCiRoster(t.ci_roster, files);
    if (merged.length !== decodeCiRoster(t.ci_roster).length) {
      this.store.devTickets.updateDevTicket(ticketId, { ci_roster: encodeCiRoster(merged) });
    }
    return merged;
  }

  /**
   * Compat shim for the old spec-approval door (`scripts/ops/ticket.sh
   * approve` still calls the route). Approval is a conversation act now.
   */
  approveSpec(ticketId: number, by?: string, actorKind?: TicketActorKind | null): DevTicketRow {
    const t = this.store.devTickets.getDevTicket(ticketId);
    if (!t) throw new Error(`工单不存在: #${ticketId}`);
    // Signed by whoever pressed it, not by the requester (ticket #15). The
    // panel's own /message route has always recorded the real author; these
    // two shims claimed the requester said it, so an admin nudging someone
    // else's ticket left a message in that person's name.
    this.postMessage(ticketId, by || t.requester, "web", "(按钮)方案可以,按当前讨论开始实现吧。", actorKind);
    return this.store.devTickets.getDevTicket(ticketId)!;
  }

  /** Compat shim for the old needs_human requeue button/route: a nudge message. */
  requeue(ticketId: number, by?: string, actorKind?: TicketActorKind | null): DevTicketRow {
    const t = this.store.devTickets.getDevTicket(ticketId);
    if (!t) throw new Error(`工单不存在: #${ticketId}`);
    this.store.devTickets.updateDevTicket(ticketId, { error: null });
    this.postMessage(ticketId, by || t.requester, "web", "(按钮)请继续——如果上一轮被打断或失败,从当前状态接着推进。", actorKind);
    return this.store.devTickets.getDevTicket(ticketId)!;
  }

  /**
   * Switch the ticket kind while it is alive.
   *
   * simple↔complex is pure prompt discipline. Moving to or from `app` is not:
   * it changes the path allowlist the merge is checked against and the gate that
   * will run, so `app_id` moves with it in the same write — set on the way in
   * (refusing an App this repo cannot ticket) and CLEARED on the way out, so a
   * row never carries an app id that nothing reads.
   */
  setKind(ticketId: number, kind: string, appId?: string | null): DevTicketRow {
    const t = this.store.devTickets.getDevTicket(ticketId);
    if (!t) throw new Error(`工单不存在: #${ticketId}`);
    if (!DEV_TICKET_KINDS.has(kind)) throw new Error(`未知工单类型: ${kind}`);
    if (t.dev_status === "cancelled") throw new Error("工单已取消,不可改类型");
    if (kind === "app") {
      const wanted = appId ?? t.app_id;
      if (!appScopeFor(wanted)) {
        throw new Error(
          `App 工单需要指定一个本仓库认识的 App(收到 ${wanted ? `\`${wanted}\`` : "空"});`
            + `可选:${APP_TICKET_SCOPES.map((s) => s.appId).join("、") || "(本构建没有可开 App 工单的 App)"}`,
        );
      }
      this.store.devTickets.updateDevTicket(ticketId, { kind, app_id: wanted ?? null });
    } else {
      this.store.devTickets.updateDevTicket(ticketId, { kind, app_id: null });
    }
    this.kick();
    return this.store.devTickets.getDevTicket(ticketId)!;
  }

  /**
   * Stop the turn that is running right now, and nothing else (ticket #184).
   *
   * This is the counterpart of `cancel`, not a softer version of it. Cancel
   * ends the TICKET: the status flips, the lock is released and nothing the
   * agent does afterwards can reach the base branch. This ends one TURN and
   * changes no state at all — the ticket stays open, the branch and worktree
   * keep every commit, and `session_id` still points at a session the next
   * turn resumes. "Stop and think again" is a normal thing to want from an
   * agent that is confidently doing the wrong thing, and before this the only
   * button that did it also threw the ticket away.
   *
   * Refuses when there is no turn to stop rather than arming a request that
   * would fire at whatever starts next.
   */
  interruptTurn(ticketId: number, by?: string): DevTicketRow {
    const t = this.store.devTickets.getDevTicket(ticketId);
    if (!t) throw new Error(`工单不存在: #${ticketId}`);
    if (!t.turn_started_at && !this.ticketResourceWait(ticketId)) {
      throw new Error("当前没有正在执行的轮次，也没有等待恢复的请求可以停止");
    }
    if (this.runnerTickets) this.store.devTickets.updateDevTicket(ticketId, { chat_paused: 1 });
    if (!this.store.devTickets.runner.active(ticketId)) this.clearRunnerWait(ticketId);
    if (t.turn_started_at) this.interruptRequests.set(ticketId, by || t.requester);
    if (this.runnerTickets) {
      this.store.devTickets.updateDevTicket(ticketId, { chat_paused: 1 });
      const operation = this.store.devTickets.runner.active(ticketId);
      if (operation?.state === "prepared" && !this.running.has(ticketId)) {
        this.store.devTickets.runner.releasePrepared(operation);
        this.clearRunnerWait(ticketId);
        this.takeInterrupt(ticketId);
      } else if (operation) this.store.devTickets.runner.save({ ...operation, stopRequestedBy: by || t.requester });
    }
    this.runnerInputWake.get(ticketId)?.();
    log.info({ ticket: ticketId, by }, "devpipe: turn interrupt requested");
    return this.store.devTickets.getDevTicket(ticketId)!;
  }

  /** Resume the existing inbox/session, without asking people to resend text. */
  resumeTurn(ticketId: number, by?: string, actorKind?: TicketActorKind | null): DevTicketRow {
    const ticket = this.store.devTickets.getDevTicket(ticketId);
    if (!ticket) throw new Error(`工单不存在: #${ticketId}`);
    if (!this.runnerTickets) throw new Error("请配置 Runner 后继续工单");
    if (ticket.turn_started_at) throw new Error("正在停止或执行，请等当前轮次结束");
    if (ticket.dev_status === "cancelled") throw new Error("工单已取消");
    this.store.devTickets.updateDevTicket(ticketId, { chat_paused: 0 });
    if (!this.store.devTickets.listTicketMessages(ticketId, { undeliveredOnly: true }).length) {
      this.store.devTickets.addTicketMessage(ticketId, by || ticket.requester, "web", "继续执行。", undefined, actorKind);
    }
    this.kick();
    return this.store.devTickets.getDevTicket(ticketId)!;
  }

  completeTicket(ticketId: number, by?: string): DevTicketRow {
    if (this.running.has(ticketId)) throw new Error("本轮仍在执行，请先停止本轮或等待结束");
    return this.store.devTickets.completeTicket(ticketId, by || "admin");
  }

  cancel(ticketId: number): DevTicketRow {
    const t = this.store.devTickets.getDevTicket(ticketId);
    if (!t) throw new Error(`工单不存在: #${ticketId}`);
    if (t.dev_status !== "open") {
      throw new Error(`当前状态 ${t.dev_status} 不可取消(已合入的代码不会因取消消失)`);
    }
    this.store.devTickets.updateDevTicket(ticketId, { dev_status: "cancelled" });
    this.clearRunnerWait(ticketId);
    this.resourceRecovery.forget(ticketScope(ticketId));
    const provider = this.ciWorkspaceProvider?.(t.requester);
    if (provider) void provider.cancelTicket(ticketId).catch((error) => {
      this.note(ticketId, `远端任务取消尚未确认，原任务可能继续：${msg(error)}。恢复后查询原任务，不重播命令。`);
    });
    const lockState = this.mergeLock.cancel(ticketId);
    this.store.devTickets.forgetMergeWaiter(ticketId);
    if (lockState.held) log.info({ ticket: ticketId, why: "工单已取消" }, "devpipe: merge lock released");
    // The running turn (if any) notices via TurnLimits.shouldAbort and is
    // SIGKILLed; claim/submit refuse for a cancelled ticket either way, so
    // nothing this agent does from here on can reach the base branch.
    log.info({ ticket: ticketId, turnRunning: t.turn_started_at != null }, "devpipe: ticket cancelled");
    this.kick();
    return this.store.devTickets.getDevTicket(ticketId)!;
  }

  /** Manual deploy markers: pending → live_unverified → verified | reverted. */
  markDeploy(ticketId: number, next: "live_unverified" | "verified" | "reverted"): DevTicketRow {
    const t = this.store.devTickets.getDevTicket(ticketId);
    if (!t) throw new Error(`工单不存在: #${ticketId}`);
    const allowed: Record<string, string[]> = {
      pending: ["live_unverified"],
      live_unverified: ["verified", "reverted"],
    };
    if (!allowed[t.deploy_status ?? ""]?.includes(next)) {
      throw new Error(`部署状态 ${t.deploy_status} 不能变为 ${next}`);
    }
    this.store.devTickets.updateDevTicket(ticketId, { deploy_status: next });
    this.kick();
    return this.store.devTickets.getDevTicket(ticketId)!;
  }

  /** The human lane contributes one report-only tip; its parent is the receipt-bound implementation. */
  private async cliReportForLanding(
    from: string,
    head: string,
  ): Promise<LoadedCliDeliveryReport & { receipt_repo_sha: string }> {
    const changed = await git(this.repoDir, [
      "diff", "--name-status", "--no-renames", `${from}...${head}`, "--", `${CLI_REPORT_DIR}/`,
    ]);
    if (!changed.ok) {
      throw new LandError("report_invalid", `读取 CLI 简报变更失败: ${changed.stderr.slice(-300)}`);
    }
    const entries = changed.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [status = "", reportPath = ""] = line.split("\t", 2);
        return { status, path: reportPath };
      });
    const reportEntries = entries.filter((entry) => isCliReportPath(entry.path));
    if (reportEntries.length === 0) {
      throw new LandError(
        "report_missing",
        `CLI 落地必须在最后一个 commit 新增一份 ${CLI_REPORT_DIR}/YYYY-MM-DD-<slug>.json 简报`,
      );
    }
    if (reportEntries.length !== 1 || reportEntries[0]!.status !== "A") {
      throw new LandError(
        "report_invalid",
        "一次 CLI 落地必须恰好新增一份简报；既有简报不可修改、删除或批量复用",
      );
    }
    const reportPath = reportEntries[0]!.path;
    const introduced = await gitOrThrow(this.repoDir, [
      "log", "--diff-filter=A", "-1", "--format=%H", head, "--", reportPath,
    ]);
    if (introduced !== head) {
      throw new LandError(
        "report_invalid",
        `CLI 简报必须由分支最后一个 commit(${head.slice(0, 10)})新增，确保它描述的就是实际落地水位`,
      );
    }
    const receiptRepoSha = await gitOrThrow(this.repoDir, ["rev-parse", `${head}^`]);
    const tipPaths = (await gitOrThrow(this.repoDir, [
      "diff", "--name-only", "--no-renames", receiptRepoSha, head,
    ])).split("\n").filter(Boolean);
    if (tipPaths.length !== 1 || tipPaths[0] !== reportPath) {
      throw new LandError(
        "report_invalid",
        "分支最后一个 commit 只能新增这份 CLI 简报；实现必须先完整提交，再在独立 tip commit 写简报",
      );
    }
    try {
      const loaded = await this.readCliReport(head, reportPath);
      this.assertCliRequester(loaded);
      if (loaded.report.version === 3 && loaded.report.native_ticket_id !== undefined) {
        const native = this.store.devTickets.getDevTicket(loaded.report.native_ticket_id);
        if (!native?.native_binding || native.requester !== loaded.report.requester || (native.commit_sha && native.commit_sha !== head)) {
          throw new Error("CLI report does not match its registered native ticket");
        }
      }
      if (loaded.report.version !== 3) {
        throw new Error("新 CLI 落地必须使用 version: 3 简报并记录需求、决策、边界与 base_sha；version: 1/2 仅供历史对账");
      }
      if (loaded.report.base_sha !== from) {
        throw new Error(
          `简报 base_sha ${loaded.report.base_sha.slice(0, 10)} 与当前 ${this.baseBranch} ${from.slice(0, 10)} 不同；`
          + "先 rebase，再 amend 最后一个简报 commit",
        );
      }
      return { ...loaded, receipt_repo_sha: receiptRepoSha };
    } catch (err) {
      throw new LandError("report_invalid", `CLI 简报无效: ${msg(err)}`);
    }
  }

  private async readCliReport(ref: string, reportPath: string): Promise<LoadedCliDeliveryReport> {
    const shown = await git(this.repoDir, ["show", `${ref}:${reportPath}`]);
    if (!shown.ok) throw new Error(`无法从 ${ref.slice(0, 10)} 读取 ${reportPath}`);
    return { path: reportPath, report: parseCliDeliveryReport(shown.stdout, reportPath) };
  }

  private assertCliRequester(loaded: LoadedCliDeliveryReport): void {
    if (!this.store.getUser(loaded.report.requester)) {
      throw new Error(`requester ${loaded.report.requester} 不是已注册 Dashboard 用户，无法指派生产验收`);
    }
  }
  private importCliRetrievalEvidence(
    report: CliDeliveryReportV3,
    uploads: readonly CliRetrievalReceiptUpload[],
    receiptRepoSha: string,
    landingRef: string,
  ): NonNullable<LandResult["retrieval_receipts"]> {
    const byId = new Map<string, CliRetrievalReceiptUpload>();
    for (const upload of uploads.slice(0, 8)) {
      if (!/^kr_[0-9a-f]{32}$/u.test(upload.id) || !/^[0-9a-f]{64}$/u.test(upload.receipt_sha256)) continue;
      if (!byId.has(upload.id)) byId.set(upload.id, upload);
    }
    const stateById = new Map<string, NonNullable<LandResult["retrieval_receipts"]>[number]["state"]>();
    const candidates: Array<{ receipt: RetrievalTraceReceiptV1; receipt_sha256: string }> = [];
    for (const reference of report.retrieval.traces) {
      const upload = byId.get(reference.id);
      if (!upload) {
        stateById.set(reference.id, "missing");
        continue;
      }
      try {
        if (upload.receipt_sha256 !== reference.receipt_sha256
          || Buffer.byteLength(upload.content, "utf8") > 32 * 1024
          || createHash("sha256").update(upload.content, "utf8").digest("hex") !== reference.receipt_sha256) {
          throw new Error("receipt binding mismatch");
        }
        const parsed = JSON.parse(upload.content) as RetrievalTraceReceiptV1;
        if (parsed.envelope?.trace_id !== reference.id) throw new Error("receipt trace mismatch");
        candidates.push({ receipt: parsed, receipt_sha256: reference.receipt_sha256 });
      } catch {
        stateById.set(reference.id, "invalid");
      }
    }

    const imported = new Set<string>();
    if (candidates.length) {
      try {
        const outcomes = this.store.knowledgeRetrieval.importCliReceiptsForLanding(candidates, {
          landing_ref: landingRef,
          repo_sha: receiptRepoSha,
          context_keys: report.retrieval.context_keys,
        });
        for (const outcome of outcomes) {
          stateById.set(outcome.trace_id, outcome.state);
          imported.add(outcome.trace_id);
        }
      } catch {
        for (const candidate of candidates) stateById.set(candidate.receipt.envelope.trace_id, "invalid");
      }
    }
    for (const feedback of report.retrieval.feedback) {
      if (!feedback.trace_id || !imported.has(feedback.trace_id)) continue;
      try {
        this.store.knowledgeRetrieval.recordFeedback(feedback.trace_id, feedback.code, feedback.slot);
      } catch (err) {
        log.warn({ traceId: feedback.trace_id, err: msg(err) }, "CLI retrieval feedback import failed");
      }
    }
    return report.retrieval.traces.map((reference) => ({
      id: reference.id,
      state: stateById.get(reference.id) ?? "invalid",
    }));
  }
  private async loadCliReceiptUploads(
    report: CliDeliveryReportV3,
    knownDir?: string | null,
  ): Promise<{ uploads: CliRetrievalReceiptUpload[]; files: Map<string, string> }> {
    const uploads: CliRetrievalReceiptUpload[] = [];
    const files = new Map<string, string>();
    const dir = knownDir === undefined ? await this.cliReceiptRecoveryDir() : knownDir;
    if (!dir) return { uploads, files };
    for (const reference of report.retrieval.traces) {
      const file = path.join(dir, `${reference.id}.json`);
      try {
        const stat = await fs.lstat(file);
        if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > 32 * 1024) continue;
        const content = await fs.readFile(file, "utf8");
        if (createHash("sha256").update(content, "utf8").digest("hex") !== reference.receipt_sha256) continue;
        uploads.push({ id: reference.id, receipt_sha256: reference.receipt_sha256, content });
        files.set(reference.id, file);
      } catch {
        // The Git report is durable citation authority. An expired operational
        // receipt remains an explicit missing state and never triggers replay.
      }
    }
    return { uploads, files };
  }

  /** Resolve the private, Git-common-dir receipt inbox once per reconciliation. */
  private async cliReceiptRecoveryDir(): Promise<string | null> {
    const resolved = await git(this.repoDir, ["rev-parse", "--git-common-dir"]);
    if (!resolved.ok || !resolved.stdout) return null;
    const commonDir = path.isAbsolute(resolved.stdout) ? resolved.stdout : path.resolve(this.repoDir, resolved.stdout);
    const dir = path.join(commonDir, "octopus", "knowledge-retrieval");
    try {
      const commonReal = await fs.realpath(commonDir);
      const dirReal = await fs.realpath(dir);
      return dirReal.startsWith(`${commonReal}${path.sep}`) ? dirReal : null;
    } catch {
      return null;
    }
  }



  /**
   * Human lane, same door as the ticket lane (ticket #5): gate a buffer branch
   * (`dev/<owner>`) and fast-forward it into the base branch. The WHOLE
   * operation (gate + ff) sits inside the same global git lock the ticket
   * lane's merges use, so the two only ever queue behind each other. The gates
   * — any tests the caller named, then the thin land gate (land-gate.ts) —
   * run in the detached `_land` worktree parked at the exact sha being landed.
   */
  async land(
    branch: string,
    who: string,
    tests: readonly string[] = [],
    receiptUploads: readonly CliRetrievalReceiptUpload[] = [],
  ): Promise<LandResult> {
    let integration: IntegrationLeaseKeeper | undefined;
    if (this.mainlineLanding) throw new LandError("busy", "另一个 land 正在进行");
    this.mainlineLanding = true;
    try {
      if (this.mainline) {
        const identity = { id: `cli:${randomUUID()}`, owner: who, label: `CLI ${branch}` };
        const claim = await this.mainline.acquire(identity);
        if (!claim.acquired) {
          await this.mainline.cancel(identity);
          throw new LandError("busy", "GitLab 合入锁正在使用；本地 CLI 请通过 development 命令持久排队");
        }
        integration = new IntegrationLeaseKeeper(this.mainline, claim.lease);
      }
      if (this.mainline) await this.synchronizeMainline();
      return await this.landCandidate(branch, who, tests, receiptUploads, integration);
    } finally {
      await integration?.close().catch(error => log.warn({ err: msg(error) }, "CLI integration lease release deferred to expiry"));
      this.mainlineLanding = false;
    }
  }

  private async landCandidate(
    branch: string, who: string, tests: readonly string[], receiptUploads: readonly CliRetrievalReceiptUpload[],
    integration?: IntegrationLeaseKeeper,
  ): Promise<LandResult> {
    const b = branch.trim();
    if (!b || !/^[\w][\w./-]*$/.test(b) || b.includes("..")) {
      throw new LandError("bad_branch", `分支名不合法: ${branch}`);
    }
    if (b === this.baseBranch) throw new LandError("bad_branch", `不能 land ${this.baseBranch} 自身`);

    const headRef = await git(this.repoDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`]);
    if (!headRef.ok || !headRef.stdout) throw new LandError("unknown_branch", `分支不存在: ${b}`);
    const head = headRef.stdout;
    const from = await gitOrThrow(this.repoDir, ["rev-parse", this.baseBranch]);
    if (head === from) {
      throw new LandError("no_commits", `${b} 与 ${this.baseBranch} 是同一提交,没有要落地的内容`);
    }
    const anc = await git(this.repoDir, ["merge-base", "--is-ancestor", this.baseBranch, b]);
    if (!anc.ok) {
      throw new LandError(
        "not_ancestor",
        `${this.baseBranch} 不是 ${b} 的祖先,先 rebase 再落地: git rebase ${this.baseBranch} ${b}`,
      );
    }
    const delivery = await this.cliReportForLanding(from, head);
    let changedPaths: string[];
    try {
      changedPaths = (await gitOrThrow(this.repoDir, [
        "diff", "--name-only", "--no-renames", `${from}...${head}`,
      ])).split("\n").filter(Boolean);
    } catch (err) {
      throw new LandError("merge_failed", `读取待落地路径失败: ${msg(err)}`);
    }
    try {
      await verifyNewHumanEvidence({ repoDir: this.repoDir, from, to: head, files: changedPaths, store: this.store, owner: who });
    } catch (error) {
      throw new LandError("report_invalid", msg(error));
    }
    let cliKnowledge: LandingKnowledge | undefined;
    let cliRequiredTests: string[] = [];
    if (this.knowledgeCaptureEnabled) {
      const report = delivery.report;
      if (report.version !== 3) throw new LandError("report_invalid", "新 CLI 落地必须使用 version: 3 简报");
      try {
        await verifyLandingSpecifications({ repoDir: this.repoDir, to: head, knowledge: report, store: this.store, owner: who });
      } catch (error) { throw new LandError("report_invalid", msg(error)); }
      const ack = this.knowledgeGraph?.available() ? this.knowledgeGraph.acknowledgement(changedPaths) : null;
      if (ack) {
        cliRequiredTests = constraintEvidenceTests(ack.constraints);
        log.info(
          { report: report.title, principles: ack.principles.length, constraints: ack.constraints.length, nonGoals: ack.nonGoals.length, tests: cliRequiredTests.length },
          "land: knowledge acknowledgement set",
        );
      }
      // Retrieval receipts are optional records: present ones are imported
      // after the landing (importCliRetrievalEvidence), missing or invalid ones
      // stay explicit telemetry states and never refuse the landing.
      if (report.supersedes.some((id) => !report.changes?.some((change) => change.record_id === id))) throw new LandError("report_invalid", "取代知识需要 changes 中的完整动机和影响调查");
      const namedKeys = [...report.retrieval.context_keys, ...report.supersedes, ...(report.changes ?? []).map((change) => change.record_id)];
      const knownKeys = new Set(this.store.knowledge.getRecords(namedKeys).map((record) => record.record_key));
      const unknownKeys = namedKeys.filter((key) => !knownKeys.has(key) && !this.knowledgeGraph?.hasNode(key));
      if (unknownKeys.length) {
        throw new LandError("report_invalid", `retrieval.context_keys/supersedes 引用了不存在的知识记录:${unknownKeys.join(", ")}`);
      }
      cliKnowledge = {
        specifications: report.specifications,
        summary: report.summary,
        requirements: report.requirements,
        decisions: report.decisions,
        non_goals: report.non_goals,
        risks: report.risks,
        verification: report.verification,
        context_keys: report.retrieval.context_keys,
        supersedes: report.supersedes,
        ...(report.changes ? { changes: report.changes } : {}),
      };
    }


    if (this.landing) throw new LandError("busy", "另一个 land 正在进行,稍后再试");
    this.landing = true;
    log.info({ branch: b, head, from, who, tests: tests.length }, "land: fast-forwarding a human-lane branch");
    try {
      // Every landing MUST leave an outcome line. On 2026-08-07 a gate ran for
      // ~30 minutes and vanished without a trace: the refusal path only threw,
      // the route turned it into a 422 for a client that had already died, and
      // the log showed "gating" with no ending — indistinguishable from a hang.
      // (The whole gate phase sits inside `landLogged` for the same reason.)
      // Named tests and the thin land gate run OUTSIDE the git lock, in the
      // `_land` staging worktree pinned at `head` — with ff-only, `head` IS
      // the tree the base branch will point at, and base drift during the
      // gates is re-checked under the git lock below (`base_moved`). The
      // `withLandWorktree` chain serialises `_land` with the ticket lane's
      // gate, so neither door can re-park the tree under the other's run.
      // With nothing to run there is no worktree to make: the lock is taken
      // for the re-read and the ff, which is milliseconds.
      return await this.landLogged(b, who, async () => {
        const steps = namedGateSteps(tests);
        const namedTests = tests.map((spec) => spec.trim()).filter(Boolean);
        let gateLog: string | undefined;
        if (steps.length || this.landGate.enabled) {
          await this.landGate.withLandWorktree(head, async (landDir) => {
            // Named tests are gate steps (`named_tests`) when the gate is on;
            // the separate run exists for an operator who switched it off.
            if (steps.length && !this.landGate.enabled) {
              const outcome = await this.gateFn(landDir, null, steps);
              gateLog = outcome.log;
              if (!outcome.ok) {
                throw new LandError("gate_failed", `点名的测试未通过,${this.baseBranch} 未改动`, outcome.log);
              }
            }
            if (this.landGate.enabled) {
              const g = await this.landGate.check(landDir, {
                changedFiles: changedPaths,
                ...(cliRequiredTests.length ? { requiredTests: cliRequiredTests } : {}),
                ...(namedTests.length ? { namedTests, appScope: null } : {}),
              });
              if (!g.ok && g.refusal === "named_tests") {
                throw new LandError("gate_failed", `点名的测试未通过,${this.baseBranch} 未改动`, g.log);
              }
              if (!g.ok) {
                throw new LandError("land_gate_failed", landGateRefusalMessage(g.refusal, this.baseBranch), g.log);
              }
              gateLog = [gateLog, g.log].filter(Boolean).join("\n\n");
            }
          });
        }

        return await this.withGitLock(async () => {
          const outcome = { log: gateLog ?? "(没有点名任何测试)" };

          const nowBase = await gitOrThrow(this.repoDir, ["rev-parse", this.baseBranch]);
          if (nowBase !== from) {
            throw new LandError(
              "base_moved",
              `${this.baseBranch} 在此期间被推进(${from.slice(0, 10)} → ${nowBase.slice(0, 10)}),${b} 不再以它为祖先。请 rebase 后重试`,
              outcome.log,
            );
          }

          let to: string;
          try {
            to = await this.ffBaseTo(head, integration);
          } catch (err) {
            throw new LandError("merge_failed", `ff 合入 ${this.baseBranch} 失败: ${msg(err)}`, outcome.log);
          }
          const ticket = this.store.devTickets.createCliDeliveryTicket(normalizeCliDeliveryTicketInput({
            ...(delivery.report.version === 3 && delivery.report.native_ticket_id ? { native_ticket_id: delivery.report.native_ticket_id } : {}),
            title: delivery.report.title,
            body: renderCliDeliveryReport(delivery),
            spec: cliAcceptanceSpec(delivery.report),
            requester: delivery.report.requester,
            branch: b,
            commit_sha: to,
          }));
          const owed = appsWithReleaseChanges(changedPaths);
          const requestedAt = new Date().toISOString();
          if (cliKnowledge) {
            this.store.knowledge.recordLanding({
              ticket_id: ticket.id,
              from_sha: from,
              to_sha: to,
              base_before: from,
              tip_sha: head,
              source: "cli",
              report_path: delivery.path,
              changed_files: changedPaths,
              changed_modules: [...new Set(changedPaths.map((file) => moduleOf(file)))],
              acceptance: delivery.report.acceptance,
              knowledge: cliKnowledge,
            });
            this.refreshKnowledgeArtifacts();
          }
          const retrievalReceipts = delivery.report.version === 3
            ? this.importCliRetrievalEvidence(
                delivery.report,
                receiptUploads,
                delivery.receipt_repo_sha,
                `cli:${ticket.id}@${to}`,
              )
            : [];
          for (const candidate of owed) {
            this.store.appCatalog.recordPendingAppRelease({
              app_id: candidate.appId,
              commit_sha: to,
              ticket_id: ticket.id,
              requested_by: `cli:${who}`,
              requested_at: requestedAt,
              reason: `CLI 工单 #${ticket.id} 合入了 ${candidate.title} 的 release 输入`,
            });
          }
          if (runnerBundleInputsChanged(changedPaths)) {
            this.store.runnerArtifacts.recordPending({
              ticket_id: ticket.id,
              commit_sha: to,
              requested_by: `cli:${who}`,
              requested_at: requestedAt,
            });
            this.note(
              ticket.id,
              "🐙 本次 CLI 合入改变了 Runner 客户端 bundle，已记录为待激活；完整部署通过健康门后会从已部署 checkout 自动激活，失败时本票不会进入验收完成。",
            );
          }
          this.store.devTickets.recordCliReleaseProjection(ticket.id, to);
          if (owed.length) {
            this.note(
              ticket.id,
              `📦 本次 CLI 合入改到了 ${owed.map((candidate) => candidate.title).join("、")} 的 release 输入，已记录为待发布；当前部署的可信代码能运行新版本时，发布包就绪后自动上线，否则随下一次完整部署上线。`,
            );
          }
          log.info({ branch: b, from, to, who }, "land: base branch fast-forwarded");
          // Same reason as the ticket lane: warm what just landed without
          // delaying landing. An immediate deployment may join this exact run
          // rather than cold-build beside it.
          this.buildWarmer.schedule(to);
          return {
            ok: true,
            branch: b,
            from_sha: from,
            to_sha: to,
            ticket_id: ticket.id,
            report_path: delivery.path,
            gate_log_tail: outcome.log,
            ...(owed.length ? { app_release_owed: owed.map((candidate) => candidate.appId) } : {}),
            ...(delivery.report.version === 3 ? { retrieval_receipts: retrievalReceipts } : {}),
          };
        });
      });
    } finally {
      this.landing = false;
    }
  }

  /** The outcome logger for `land()`: success, refusal and crash each leave a line. */
  private async landLogged(branch: string, who: string, run: () => Promise<LandResult>): Promise<LandResult> {
    try {
      const result = await run();
      log.info({ branch, who, to: result.to_sha }, "land: completed");
      return result;
    } catch (err) {
      if (err instanceof LandError) {
        log.warn({ branch, who, code: err.code }, `land refused: ${err.code}`);
      } else {
        log.error({ branch, who, err: msg(err) }, "land crashed");
      }
      throw err;
    }
  }

  /** Late-bind the transition hook (the Router exists after the pipeline). */
  setNotify(fn: (ev: DevPipeEvent) => void): void {
    this.notifyFn = fn;
  }

  /** Late-bind the loopback URL of the dashboard's /api/devpipe/* routes. */
  setRunnerTickets(access: TicketRunnerAccess): void { this.runnerTickets = access; }
  private nativeDevelopment(): NativeDevelopmentService {
    return new NativeDevelopmentService({ repository: this.store.devTickets, repoDir: this.repoDir, access: () => this.runnerTickets });
  }
  registerNativeDevelopment(subject: { owner: string; device: string }, proof: Readonly<Record<string, unknown>>, stillAuthorized: () => boolean) {
    return this.nativeDevelopment().register(subject, proof, stillAuthorized);
  }
  nativeTicketInput(ticket: DevTicketRow, author: string, prompt?: string, actorKind?: TicketActorKind | null) {
    return this.nativeDevelopment().input(ticket, author, prompt, actorKind);
  }

  /** Composition supplies owner-bound transport and the MCP scope issuer; no agent SSH path. */
  setDevelopmentWorkspaces(options: Omit<DevelopmentWorkspaceOptions, "repository" | "repoDir" | "baseBranch" | "withGitLock">,
    issue: (binding: DevelopmentTurnBinding) => DevelopmentMcpCredential): void {
    this.developmentWorkspaces = new DevelopmentWorkspaceService({ ...options, repository: this.store.devTickets.development,
      repoDir: this.repoDir, baseBranch: this.baseBranch, withGitLock: (work) => this.withGitLock(work) });
    this.developmentMcpIssue = issue;
  }
  developmentTurnToken(binding: DevelopmentTurnBinding): string | null {
    const development = this.store.devTickets.development.binding(binding.ticketId);
    const ticket = this.store.devTickets.getDevTicket(binding.ticketId);
    if (!development || development.owner !== binding.owner || development.developmentId !== binding.developmentId
      || ticket?.requester !== (development.requester ?? binding.owner) || ticket.dev_status === "cancelled") return null;
    const runner = this.store.devTickets.runner.binding(binding.ticketId);
    if (runner && this.runnerTickets && !this.runnerTickets.authorized(runner)) return null;
    for (const [token, turn] of this.turnTokens) if (turn.ticketId === binding.ticketId && turn.turn === binding.turn) return token;
    return null;
  }
  isCurrentDevelopmentTurn(binding: DevelopmentTurnBinding): boolean { return this.developmentTurnToken(binding) !== null; }
  /** Called only by the existing post-Gate dispatcher. Plaintext never enters durable args. */
  developmentDispatchArgs(owner: string, operation: string, args: Readonly<Record<string, unknown>>): Record<string, string> {
    if (!["start_session", "append_session", "get_session_operation"].includes(operation)) return {};
    const id = String(args.operation_id ?? "");
    const current = this.developmentCredentials.get(id)
      ?? this.developmentCredentials.get(this.store.devTickets.runner.input(id)?.turnId ?? "");
    if (!current || current.binding.owner !== owner || !this.isCurrentDevelopmentTurn(current.binding)) return {};
    const runner = this.store.devTickets.runner.binding(current.binding.ticketId);
    if (!runner || args.device !== runner.device) return {};
    return { _octopus_development_id: current.binding.developmentId, _octopus_development_mcp_url: current.credential.endpoint,
      _octopus_development_mcp_token: current.credential.token };
  }
  developmentSessionRequired(owner: string, runtimeDevice: string, source: string, sessionId: string): boolean {
    return this.store.devTickets.development.sessionRequired(owner, runtimeDevice, source, sessionId);
  }
  /** Recovery augments only the exact live ticket scope, never a guessed session owner. */
  developmentRecoveryScope(owner: string, runtimeDevice: string, source: string, sessionId: string):
    { developmentId: string; token: string; endpoint: string; expiresAt: number } | undefined {
    for (const current of this.developmentCredentials.values()) {
      if (current.binding.owner !== owner || !this.isCurrentDevelopmentTurn(current.binding) || current.credential.expiresAt <= Date.now()) continue;
      const ticket = this.store.devTickets.getDevTicket(current.binding.ticketId);
      const runner = this.store.devTickets.runner.binding(current.binding.ticketId);
      if (ticket?.session_id === sessionId && runner?.device === runtimeDevice && runner.source === source) return {
        developmentId: current.binding.developmentId, token: current.credential.token, endpoint: current.credential.endpoint, expiresAt: current.credential.expiresAt,
      };
    }
    return undefined;
  }
  async toolWorkspaceSync(token: string): Promise<Record<string, unknown>> {
    const turn = this.turnTokens.get(token);
    if (!turn || !this.developmentWorkspaces?.binding(turn.ticketId)) return { ok: false, code: "unavailable", message: "本轮没有受管 Runner 开发工作区。" };
    if (this.submitOps.has(token)) return { ok: false, code: "submit_in_progress", message: "原提交仍在执行，不能并发同步开发工作区。" };
    try {
      const result = await this.developmentWorkspaces.sync(turn.ticketId);
      return { ok: true, ...result, knowledge_next_actions: [{reason: "context_changed", next_action: "同步基线后按最终改动路径重新调用 devpipe_context，核对变化的知识与来源。"}, ...ticketSourcePage(this.store,turn.ticketId).knowledge_next_actions], message: "已同步 refs/remotes/octopus/head；原工作区和未提交修改保持原样。请在 Runner rebase、解决冲突并完成相关验证后重新 submit。" };
    } catch (error) { return { ...this.developmentFailure(error) }; }
  }
  private developmentFailure(error: unknown): SubmitResult {
    return { ok: false, code: error instanceof DevelopmentWorkspaceError && ["dirty", "mid_rebase", "base_moved"].includes(error.code)
      ? error.code as "dirty" | "mid_rebase" | "base_moved" : "merge_failed", message: msg(error),
      ...(error instanceof DevelopmentWorkspaceError && error.requiredHeadSha ? { required_head_sha: error.requiredHeadSha } : {}) };
  }
  private async refreshDevelopmentCandidate(token: string, currentBase: boolean, submitting = false): Promise<SubmitResult | null> {
    const turn = this.turnTokens.get(token);
    if (!turn || !this.developmentWorkspaces?.binding(turn.ticketId)) return null;
    if (!submitting && this.submitOps.has(token)) return { ok: false, code: "submit_in_progress", message: "原提交仍在执行，不能替换其固定候选。" };
    const ticket = this.store.devTickets.getDevTicket(turn.ticketId);
    if (!ticket?.worktree) return { ok: false, code: "not_holder", message: "本票 Head 候选目录缺失。" };
    try { await this.developmentWorkspaces.importCandidate(turn.ticketId, ticket.worktree, currentBase); return null; }
    catch (error) { return this.developmentFailure(error); }
  }
  private async remoteBaseRefusal(ticketId: number, worktree: string): Promise<SubmitResult | null> {
    if (!this.developmentWorkspaces?.binding(ticketId)) return null;
    const base = await gitOrThrow(this.repoDir, ["rev-parse", this.baseBranch]);
    if ((await git(worktree, ["merge-base", "--is-ancestor", base, "HEAD"])).ok) return null;
    return { ok: false, code: "base_moved", required_head_sha: base,
      message: "Head 权威水位已推进，未在 Head rebase。请 devpipe_workspace_sync，在 Runner 原开发树解决冲突、复验后提交。" };
  }

  setToolApi(url: string): void {
    this.toolApiUrl = url;
    this.kick();
  }

  /**
   * Late-bind the App release refresher (the App catalog is composed after the
   * pipeline; see `AppReleaseRefresher`). Absent stays a reported state.
   */
  setAppReleaseRefresher(fn: AppReleaseRefresher): void {
    this.appReleases.setRefresher(fn);
  }

  /** Late-bind the staged deployment releases App publication may pack from. */
  setAppReleaseTrees(fn: () => Promise<StagedReleaseTree[]>): void {
    this.appReleases.setReleaseTrees(fn);
  }

  /** Late-bind the exact-candidate hot-swap operations beside the refresher. */
  setAppHotswapExecutor(fn: AppHotswapExecutor): void {
    this.appReleases.setHotswapExecutor(fn);
  }

  /** Join cache warming already scheduled for an exact deployment target. */
  joinBuildWarm(sha: string): Promise<BuildWarmJoinResult> {
    return this.buildWarmer.join(sha);
  }

  /** Read-only, privacy-bounded projection consumed by the authenticated knowledge page. */
  knowledgeArtifactHealth(): KnowledgeArtifactHealth | null {
    return this.knowledgeArtifact?.health() ?? null;
  }

  /**
   * Boot. Runner mode reattaches durable operations without replaying input.
   * The older local executor retains its interrupted-turn wake behavior.
   */
  start(): void {
    this.started = true;
    if (this.mainline) {
      this.mainlinePoll = setInterval(() => { void this.synchronizeMainline(true).catch(error =>
        log.warn({ err: msg(error) }, "GitLab authority observation unavailable")); }, 15_000);
      this.mainlinePoll.unref();
    }
    if (this.runnerTickets) this.attachManagedTickets();
    // Runner operations outlive this control plane. Historical local markers
    // are cleared without waking archived provider work on a different site.
    if (this.runnerTickets) {
      for (const ticket of this.store.devTickets.listDevTickets(10_000)) {
        if (ticket.turn_started_at && !this.store.devTickets.runner.active(ticket.id)) this.store.devTickets.finishDevTurn(ticket.id);
      }
    }
    const interrupted = this.legacyTestExecution && !this.runnerTickets
      ? this.store.devTickets.recoverInterruptedDevTurns(RESTART_CONTINUE_PROMPT) : [];
    if (interrupted.length) {
      log.info({ tickets: interrupted }, "devpipe: recovered interrupted ticket turns");
    }
    this.restartContinuations = new Set(
      this.store.devTickets.listTicketsNeedingTurn()
        .filter((ticket) => isRestartContinuation(
          this.store.devTickets.listTicketMessages(ticket.id, { undeliveredOnly: true }),
        ))
        .map((ticket) => ticket.id),
    );
    if (this.restartContinuations.size > 1) {
      log.info(
        { tickets: [...this.restartContinuations], paceMs: this.restartContinuationPaceMs },
        "devpipe: pacing cold-start ticket continuations",
      );
    }
    const restored: number[] = [];
    for (const waiter of this.store.devTickets.listMergeWaiters()) {
      const ticket = this.store.devTickets.getDevTicket(waiter.ticket_id);
      if (!ticket || ticket.dev_status === "cancelled") {
        this.store.devTickets.forgetMergeWaiter(waiter.ticket_id);
        log.info({ ticket: waiter.ticket_id }, "devpipe: discarded ineligible durable merge-lock waiter");
        continue;
      }
      restored.push(waiter.ticket_id);
    }
    if (restored.length) {
      log.info({ tickets: restored }, "devpipe: restoring durable merge-lock waiters");
      this.mergeLock.restoreWaiters(restored);
    }
    this.kick();
    void this.knowledgeArtifact?.start().catch((error) => {
      log.warn({ err: msg(error) }, "knowledge artifact service did not start");
    });
    // Ticket #15: retire the pre-#15 shared-directory token files.
    void this.sweepLegacyMcpConfigs();
    // CLI delivery reports are reconciled by the composition root before the
    // deploy watcher starts. Keeping that ordering synchronous is what lets a
    // report landed by the previous process join the deployment that restarted
    // us, instead of appearing later as an orphaned "pending" ticket.
  }

  /**
   * Import any checked-in CLI report that has no idempotent ticket row yet.
   * The composition root awaits this before starting DeployService; callers
   * doing an embedded/manual boot must preserve the same ordering.
   */
  async reconcileCliDeliveryReports(): Promise<CliDeliveryReconcileSummary> {
    const started = Date.now();
    // Recover the SQLite half of a landing interrupted between Git's ff and
    // the final projection update. Git ancestry is the authority for whether
    // the prepared exact range landed; no transcript reconstruction needed.
    for (const landing of this.store.knowledge.listPreparedLandings()) {
      const landed = await git(this.repoDir, [
        "merge-base", "--is-ancestor", landing.to_sha, this.baseBranch,
      ]);
      if (landed.ok) {
        this.store.knowledge.completeLanding(landing.ticket_id, landing.to_sha);
      } else {
        this.store.knowledge.abortLanding(landing.ticket_id, landing.to_sha);
      }
    }
    if (this.knowledgeGraph) {
      // Rebuild in the background: an existing graph.db from the previous
      // process serves until the new one is renamed into place.
      this.refreshKnowledgeArtifacts();
    } else if (this.knowledgeCaptureEnabled) {
      await this.knowledgeIndex.refresh(this.baseBranch);
    }
    const listed = await git(this.repoDir, ["ls-tree", "-r", "--name-only", this.baseBranch, "--", `${CLI_REPORT_DIR}/`]);
    if (!listed.ok) throw new Error(`无法列出 CLI 简报: ${listed.stderr.slice(-300)}`);
    const reportPaths = listed.stdout.split("\n").filter(isCliReportPath);
    // One history walk replaces three or four Git subprocesses per historical
    // report. The old loop revalidated 124 immutable reports on every boot and
    // spent ~12s before DeployService could start watching the active intent.
    const [introductionLog, versionGrep] = await Promise.all([
      git(this.repoDir, [
        "log", "--diff-filter=A", "--format=commit:%H", "--name-only",
        this.baseBranch, "--", `${CLI_REPORT_DIR}/`,
      ]),
      git(this.repoDir, [
        "grep", "-n", "-E", '"version"[[:space:]]*:[[:space:]]*[123]',
        this.baseBranch, "--", `${CLI_REPORT_DIR}/`,
      ]),
    ]);
    const introductions = cliReportIntroductionMap(introductionLog.ok ? introductionLog.stdout : "");
    const versions = cliReportVersionMap(versionGrep.stdout);
    const receiptRecoveryDir = await this.cliReceiptRecoveryDir();
    const receiptFiles = receiptRecoveryDir
      ? (await fs.readdir(receiptRecoveryDir).catch(() => []))
        .filter((name) => /^kr_[0-9a-f]{32}\.json$/u.test(name))
      : [];
    const receiptRecoveryFiles = receiptFiles.length;
    // An unrelated/expired inbox receipt must not invalidate every immutable
    // v3 projection on every boot. Inventory references in one Git read; only
    // reports naming an inbox receipt need the existing deep recovery path.
    // This is just candidate selection: mode, digest, landing and SHA checks
    // below remain the authority for importing a receipt.
    const receiptRefs = receiptRecoveryFiles > 0
      ? await git(this.repoDir, [
        "grep", "-n", "-o", "-E", "kr_[0-9a-f]{32}", this.baseBranch, "--", `${CLI_REPORT_DIR}/`,
      ])
      : null;
    const recoveryReports = receiptRefs && (receiptRefs.ok || receiptRefs.code === 1)
      ? cliReceiptRecoveryReports(receiptRefs.stdout, new Set(receiptFiles.map((file) => file.slice(0, -5))))
      : new Set(receiptRecoveryFiles > 0 ? reportPaths : []);
    let processed = 0;
    let skipped = 0;
    let projected = 0;

    for (const reportPath of reportPaths) {
      try {
        const introduced = introductions.get(reportPath) ?? await gitOrThrow(this.repoDir, [
          "log", "--diff-filter=A", "-1", "--format=%H", this.baseBranch, "--", reportPath,
        ]);
        if (!introduced) throw new Error("找不到新增该简报的 commit");
        const releaseProjection = this.store.devTickets.cliReleaseProjection(introduced);
        const existing = this.store.devTickets.findDevTicketByCommitSha(introduced)
          ?? (releaseProjection ? this.store.devTickets.getDevTicket(releaseProjection.ticket_id) : undefined);
        const version = versions.get(reportPath);
        // Unknown version means the batch inventory was incomplete. Fail
        // closed into the existing per-report validation/recovery path.
        const durableProjectionComplete = version !== undefined && existing?.kind === "cli" && (
          version === 1
          || !this.knowledgeCaptureEnabled
          || this.store.knowledge.listLandings(existing.id).length > 0
        );
        const receiptCouldRecover = version === 3 && recoveryReports.has(reportPath);
        if (durableProjectionComplete && releaseProjection && !receiptCouldRecover) {
          skipped += 1;
          continue;
        }
        processed += 1;
        const loaded = await this.readCliReport(introduced, reportPath);
        this.assertCliRequester(loaded);
        let receiptRepoSha: string | undefined;
        if (loaded.report.version === 3) {
          receiptRepoSha = await gitOrThrow(this.repoDir, ["rev-parse", `${introduced}^`]);
          const tipPaths = (await gitOrThrow(this.repoDir, [
            "diff", "--name-only", "--no-renames", receiptRepoSha, introduced,
          ])).split("\n").filter(Boolean);
          if (tipPaths.length !== 1 || tipPaths[0] !== reportPath) {
            throw new Error("v3 CLI report commit changed files other than its report");
          }
        }
        const changed = loaded.report.version !== 1 ? (await gitOrThrow(this.repoDir, [
          "diff", "--name-only", "--no-renames", `${loaded.report.base_sha}...${introduced}`,
        ])).split("\n").filter(Boolean) : [];
        const projectRelease = await this.planCliReleaseProjection(introduced, changed, existing);
        const ticket = this.store.withinTransaction(() => {
          const row = existing?.kind === "cli" ? existing : this.store.devTickets.createCliDeliveryTicket(normalizeCliDeliveryTicketInput({
            ...(loaded.report.version === 3 && loaded.report.native_ticket_id ? { native_ticket_id: loaded.report.native_ticket_id } : {}),
            title: loaded.report.title,
            body: renderCliDeliveryReport(loaded),
            spec: cliAcceptanceSpec(loaded.report),
            requester: loaded.report.requester,
            branch: this.baseBranch,
            commit_sha: introduced,
          }));
          projectRelease(row);
          return row;
        });
        if (existing?.kind !== "cli") projected += 1;
        if (this.knowledgeCaptureEnabled && loaded.report.version !== 1
          && this.store.knowledge.listLandings(ticket.id).length === 0) {
          this.store.knowledge.recordLanding({
            ticket_id: ticket.id,
            from_sha: loaded.report.base_sha,
            to_sha: introduced,
            base_before: loaded.report.base_sha,
            tip_sha: introduced,
            source: "reconcile",
            report_path: reportPath,
            changed_files: changed,
            changed_modules: [...new Set(changed.map((file) => moduleOf(file)))],
            acceptance: loaded.report.acceptance,
            knowledge: {
              ...(loaded.report.version === 3 ? { specifications: loaded.report.specifications } : {}),
              summary: loaded.report.summary,
              requirements: loaded.report.requirements,
              decisions: loaded.report.decisions,
              non_goals: loaded.report.non_goals,
              risks: loaded.report.risks,
              verification: loaded.report.verification,
              context_keys: loaded.report.version === 3 ? loaded.report.retrieval.context_keys : [],
              supersedes: loaded.report.supersedes,
            },
          });
        }
        if (loaded.report.version === 3) {
          if (!receiptRepoSha) throw new Error("v3 CLI report is missing its implementation parent");
          const recovery = await this.loadCliReceiptUploads(loaded.report, receiptRecoveryDir);
          const statuses = this.importCliRetrievalEvidence(
            loaded.report,
            recovery.uploads,
            receiptRepoSha,
            `cli:${ticket.id}@${introduced}`,
          );
          for (const status of statuses) {
            if (status.state === "imported" || status.state === "already_imported") {
              const file = recovery.files.get(status.id);
              if (file) await fs.rm(file, { force: true });
            } else {
              log.warn({ reportPath, traceId: status.id, code: `telemetry_receipt_${status.state}` }, "CLI retrieval receipt unavailable during reconciliation");
            }
          }
        }
      } catch (err) {
        log.warn({ reportPath, err: msg(err) }, "could not reconcile CLI delivery report");
      }
    }
    const summary: CliDeliveryReconcileSummary = {
      reports: reportPaths.length,
      processed,
      skipped,
      projected,
      receiptRecoveryFiles,
      ms: Date.now() - started,
    };
    log.info(summary, "devpipe: CLI delivery reconciliation complete");
    return summary;
  }

  /** Repair the interrupted/missing SQLite half once, without reviving settled debt. */
  private async planCliReleaseProjection(sha: string, changed: string[], existing?: DevTicketRow): Promise<(ticket: DevTicketRow) => void> {
    if (this.store.devTickets.cliReleaseProjection(sha)) return () => {};
    // Existing verified reports are an operator's completed acceptance, including
    // explicit rollbacks. A historical backfill must not publish them again.
    const settled = existing?.deploy_status === "verified";
    const pendingApps = this.store.appCatalog.listPendingAppReleases();
    const apps: Array<{ appId: string; title: string; previous: (typeof pendingApps)[number] | undefined; keepSummary: boolean }> = [];
    for (const app of settled ? [] : appsWithReleaseChanges(changed)) {
      const previous = pendingApps.find(row => row.app_id === app.appId);
      if (previous?.commit_sha === sha) continue;
      const keepSummary = Boolean(previous
        && !(await git(this.repoDir, ["merge-base", "--is-ancestor", previous.commit_sha, sha])).ok);
      apps.push({ ...app, previous, keepSummary });
    }
    const previousRunner = existing ? this.store.runnerArtifacts.listPending().find(row => row.ticket_id === existing.id) : undefined;
    const runner = !settled && runnerBundleInputsChanged(changed) && (!previousRunner
      || (previousRunner.commit_sha !== sha && (await git(this.repoDir, ["merge-base", "--is-ancestor", previousRunner.commit_sha, sha])).ok));
    return (ticket) => {
      if (this.store.devTickets.cliReleaseProjection(sha)) return;
      const at = new Date().toISOString();
      for (const app of apps) {
        const current = this.store.appCatalog.listPendingAppReleases().find(row => row.app_id === app.appId);
        if (current?.commit_sha !== app.previous?.commit_sha || current?.ticket_id !== app.previous?.ticket_id) {
          throw new Error("CLI 发布投影期间 App 待发布项变化；保留原记录，等待下一次对账");
        }
        const debt = { app_id: app.appId, commit_sha: sha, ticket_id: ticket.id,
          requested_by: `cli:${ticket.requester}`, requested_at: at, reason: `CLI 工单 #${ticket.id} 合入了 ${app.title} 的 release 输入` };
        if (app.keepSummary) this.store.appCatalog.recordPendingAppReleaseRevision(debt);
        else this.store.appCatalog.recordPendingAppRelease(debt);
      }
      if (runner) {
        const current = this.store.runnerArtifacts.listPending().find(row => row.ticket_id === ticket.id);
        if (current?.commit_sha !== previousRunner?.commit_sha) throw new Error("CLI 发布投影期间 Runner 待发布项变化；保留原记录，等待下一次对账");
        this.store.runnerArtifacts.recordPending({ ticket_id: ticket.id, commit_sha: sha,
          requested_by: `cli:${ticket.requester}`, requested_at: at });
      }
      this.store.devTickets.recordCliReleaseProjection(ticket.id, sha);
    };
  }


  private refreshKnowledgeArtifacts(): void {
    if (!this.knowledgeGraph) return;
    void this.knowledgeGraph.refresh()
      .catch((error) => log.warn({ err: msg(error) }, "knowledge graph refresh failed"))
      .finally(() => {
        void this.knowledgeArtifact?.kick()
          .catch((error) => log.warn({ err: msg(error) }, "knowledge artifact reconciliation failed"));
      });
  }

  /** Stop scheduling and wait for in-flight turns (tests, clean shutdown). */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.mainlinePoll) clearInterval(this.mainlinePoll);
    this.mainlinePoll = null;
    this.detachManagedTickets?.();
    this.recoveryUnsubscribe();
    if (this.restartPaceTimer) {
      clearTimeout(this.restartPaceTimer);
      this.restartPaceTimer = null;
    }
    // A warm build is pure cache work: whatever finished is already stored,
    // and the rest is not worth holding shutdown for.
    this.buildWarmer.stop();
    await this.knowledgeArtifact?.stop();
    while (this.inflight.size > 0) await Promise.all([...this.inflight]);
    for (const [id, context] of this.parkedRunnerContexts) await this.releaseRunnerContext(id, context.token, context.configPath);
    this.parkedRunnerContexts.clear();
    if (this.ownsManagedSupervisor) await this.managedSupervisor.close();
    this.mergeLock.close();
    await Promise.allSettled([...this.integrationLeases.values()].map(lease => lease.close()));
    this.integrationLeases.clear();
    this.knowledgeGraph?.close();
  }

  /** True when no turn is in flight (shutdown checks, tests). */
  idle(): boolean {
    return this.inflight.size === 0;
  }

  /** Schedule turns; deduped, never throws, never blocks the caller. */
  kick(): void {
    if (this.stopped || !this.started) return;
    if (this.scheduling) {
      this.pendingKick = true;
      return;
    }
    this.scheduling = true;
    try {
      do {
        this.pendingKick = false;
        this.pump();
      } while (this.pendingKick);
    } catch (err) {
      log.error({ err }, "dev pipeline scheduling failed");
    } finally {
      this.scheduling = false;
    }
  }

  private pump(): void {
    while (this.running.size < this.specConcurrency) {
      const resumable = this.runnerTickets
        ? this.store.devTickets.runner.activeTicketIds().flatMap((id) => { const row = this.store.devTickets.getDevTicket(id); return row ? [row] : []; })
        : [];
      const next = [...resumable, ...this.store.devTickets.listTicketsNeedingTurn()]
        .find((t) =>
          !t.native_binding && !this.running.has(t.id)
          && !this.managedTicketJobs.has(t.id)
          && !(this.restartPaceTimer && this.restartContinuations.has(t.id))
        );
      if (!next) return;
      if (this.runnerTickets) {
        this.queueManagedTicket(next);
        continue;
      }
      const restartContinuation = this.restartContinuations.delete(next.id);
      this.running.add(next.id);
      if (restartContinuation) this.paceNextRestartContinuation();
      this.track(
        this.runTicketTurn(next)
          .catch((err) => {
            log.error({ err, ticket: next.id }, "ticket turn crashed");
            this.turnFailed(next.id, `轮次异常: ${msg(err)}`);
          })
          .finally(() => {
            this.running.delete(next.id);
            this.kick();
          }),
      );
    }
  }

  /**
   * Hold only the next cold-start launch, not the full recovered turn.
   *
   * The provider handshake either succeeds or times out inside one 30-second
   * budget. Once that window plus a small settling margin has elapsed, the
   * next app-server may attach safely even if the earlier agent is still doing
   * useful work for many minutes.
   */
  private paceNextRestartContinuation(): void {
    if (this.restartContinuations.size === 0 || this.restartContinuationPaceMs === 0) return;
    this.restartPaceTimer = setTimeout(() => {
      this.restartPaceTimer = null;
      this.kick();
    }, this.restartContinuationPaceMs);
    this.restartPaceTimer.unref?.();
  }

  private track(p: Promise<void>): void {
    this.inflight.add(p);
    const clear = (): void => { this.inflight.delete(p); };
    void p.then(clear, clear);
  }

  // ── one conversation turn ──

  private async runRunnerConversation(claimed: DevTicketRow, lease: ExecutionLease): Promise<ExecutionStep> {
    const access = this.runnerTickets!;
    const repository = this.store.devTickets.runner;
    let operation = repository.active(claimed.id);
    let ticket = claimed;
    let binding = repository.binding(ticket.id);
    const parked = operation ? this.parkedRunnerContexts.get(operation.id) : undefined;
    if (operation) this.parkedRunnerContexts.delete(operation.id);
    let token = parked?.token;
    let configPath = parked?.configPath;
    let suspended = false;
    try {
      if (operation?.state === "prepared" && (this.isCancelled(ticket.id) || ticket.chat_paused)) {
        if (operation.startupTraceId) this.knowledgeGraph?.markAbandoned(operation.startupTraceId, "pack_failed");
        repository.releasePrepared(operation);
        this.clearRunnerWait(ticket.id);
        this.takeInterrupt(ticket.id);
        return { kind: "completed" };
      }
      lease.assertCurrent();
      if (!operation) {
        // A restart after domain completion may leave only this journal unsettled.
        if (!this.store.devTickets.listTicketMessages(ticket.id, { undeliveredOnly: true }).length) return { kind: "completed" };
        const target = access.target(ticket.requester);
        const family = cliFamilyForModel(ticket.model);
        if (!binding && ticket.session_id && family === "codex-runner") {
          throw new Error("历史 relay 会话保留在原 Runner；需显式迁移执行绑定后才能续跑，未新建或重播会话");
        }
        if (!binding && ticket.session_id) {
          const legacy = access.config.legacy_host;
          if (!legacy || legacy.owner !== ticket.requester || legacy.device !== target.device) {
            throw new Error("历史会话必须由原执行主人的 Runner 续跑；不能把旧 session ID 移到新的设备或账号");
          }
        }
        binding ??= !ticket.session_id && target.workspaces !== undefined
          ? access.resolve(ticket.requester, ticket.model)
          : { owner: ticket.requester, device: target.device, workspaceId: target.workspace_id,
            source: family === "codex-runner" ? "codex" : family };
        // Prove the new Runner receipt protocol through the same owner Gate
        // before consuming an inbox or sending an effectful provider request.
        const probe = await access.call(binding, "get_session_operation", { operation_id: "ticket-protocol-probe" }) as { protocol?: string; live_input?: string };
        if (probe?.protocol !== "runner-session-operation/v1") throw new Error("Runner 需要先升级可恢复会话协议；未发送任务");
        if (probe.live_input !== "steer-only/v1") throw new Error("请先升级工单会话所在 Runner：需要支持运行中续发和发送回执；尚未启动 Agent。");
        const existingDevelopment = this.developmentWorkspaces?.binding(ticket.id);
        if (this.developmentWorkspaces && (existingDevelopment || (!ticket.session_id && !repository.latest(ticket.id)))) {
          const development = await this.developmentWorkspaces.prepare(ticket.id, binding);
          const child = development.worktreeWorkspaceId!;
          if (repository.binding(ticket.id) && binding.workspaceId !== child) binding = repository.bindDevelopmentWorkspace(ticket.id, child);
          else binding = { ...binding, workspaceId: child };
        }
        // No provider input has crossed the dispatch barrier yet. A paused
        // preflight must leave its original inbox untouched.
        if (this.stopped || this.isCancelled(ticket.id) || this.store.devTickets.getDevTicket(ticket.id)?.chat_paused) return { kind: "completed" };
        this.clearRunnerWait(ticket.id);
        lease.assertCurrent();
        // A worktree failure is a setup refusal like any other below: it must
        // consume this inbox once (ticket #15), or the unread input re-selects
        // the ticket for another probe, note and notification every lap.
        ticket = this.reconcileLane(await this.requireWorktree(ticket));
        repository.bind(ticket.id, binding);
        const turn = this.turnSeq++;
        const bound = binding;
        let knowledgeContext: string | undefined;
        let startupTraceId: RetrievalTraceId | undefined;
        if (!ticket.session_id && this.knowledgeGraph) {
          try {
            const pack = await this.knowledgeGraph.startupPack(
              { title: ticket.title, body: ticket.body, spec: ticket.spec, ciRoster: decodeCiRoster(ticket.ci_roster) },
              { lane: "ticket", subject_ref: `ticket:${ticket.id}`, turn },
            );
            if (pack) {
              startupTraceId = pack.trace.envelope.trace_id;
              knowledgeContext = `${pack.text}\n\n检索追踪：${startupTraceId}`;
            }
          } catch (error) {
            log.warn({ ticket: ticket.id, err: msg(error) }, "devpipe: Runner knowledge startup pack failed");
          }
        }
        // Packing is asynchronous; cancellation must still leave the inbox
        // untouched. A restored prepared/dispatched operation skips this work.
        if (this.stopped || this.isCancelled(ticket.id) || this.store.devTickets.getDevTicket(ticket.id)?.chat_paused) {
          if (startupTraceId) this.knowledgeGraph?.markAbandoned(startupTraceId, "pack_failed");
          return { kind: "completed" };
        }
        lease.assertCurrent();
        operation = this.store.devTickets.prepareRunnerTurn(ticket.id, turn, (inbox) => {
          // Before a provider session exists, an explicit retry still needs
          // the original request. This is only reached for a new user action;
          // startup reattachment never constructs or dispatches a prompt.
          const initialInbox = ticket.session_id ? inbox : this.store.devTickets.listTicketMessages(ticket.id)
            .filter((message) => message.author !== "pipeline" && message.author !== "agent");
          const development = this.developmentWorkspaces?.binding(ticket.id);
          const ciTarget = development ? this.ciWorkspaceProvider?.(ticket.requester)?.target : undefined;
          const prompt = (ticket.session_id ? buildTurnPrompt(inbox) : buildIntroPrompt(ticket, initialInbox, {
            baseBranch: this.baseBranch, toolsAvailable: development ? Boolean(this.developmentMcpIssue) : Boolean(this.toolApiUrl), runnerExecution: true, machine: null, knowledgeContext,
            ...(development ? { developmentWorkspace: { ciDevice: ciTarget?.device, ciWorkspaceId: ciTarget?.workspaceId } } : {}),
          })) + `\n\n${sourcePromptReminder(this.store,ticket.id)}`;
          return { id: `ticket-${ticket.id}-${randomUUID()}`, ticketId: ticket.id, turn,
            ...(startupTraceId ? { startupTraceId } : {}),
            method: ticket.session_id ? "append_session" : "start_session", state: "prepared",
            args: { source: bound.source, input_receipt: true,
              ...(target.permission_profile ? { permission_profile: target.permission_profile } : {}),
              ...(ticket.session_id ? { id: ticket.session_id } : { workspace_id: bound.workspaceId, client_request_id: `op_${randomUUID()}`,
                ...(bound.executionDevice ? { execution_device: bound.executionDevice } : {}),
                ...(bound.codexAccount ? { codex_account: bound.codexAccount } : {}) }),
              model: modelIdForCli(ticket.model), effort: ticket.effort,
              prompt: this.developmentWorkspaces?.binding(ticket.id)
                ? `本轮模型来源 Runner: ${bound.device}；实际工具执行 Runner: ${bound.executionDevice ?? bound.device}；本票开发子工作区: ${bound.workspaceId}。工具当前目录就是本票持久开发树；直接开发、提交。Head 是唯一权威水位与合入者。\n基线前移时调用 devpipe_workspace_sync，然后在本 Runner 执行 git rebase refs/remotes/octopus/head 并解决冲突；禁止覆盖或重建本票工作树。\n\n${prompt}`
                : `本轮模型来源 Runner: ${bound.device}；实际工具执行 Runner: ${bound.executionDevice ?? bound.device}；已登记工作区: ${bound.workspaceId}。这是本轮实际放置，请按执行设备选择远程访问入口。\n\n${(target.instructions ?? "").replaceAll("{worktree}", ticket.worktree ?? "").replaceAll("{ticket}", String(ticket.id))}\n\n服务端 source worktree: ${ticket.worktree}\n该路径属于服务端，不能当作当前 Runner 的本地路径。\n\n${prompt}`.trim(),
            } };
        });
        if (!operation) {
          if (startupTraceId) this.knowledgeGraph?.markAbandoned(startupTraceId, "pack_failed");
          return { kind: "completed" };
        }
      }
      if (!binding) throw new Error("持久工单操作缺少 Runner 绑定，拒绝猜测执行机");
      if (operation.state === "prepared") {
        // Transfer before the provider dispatch barrier. Recovery of a
        // dispatched operation only queries its receipt and never uploads or replays.
        const bodies = this.store.devTickets.listTicketMessages(ticket.id)
          .filter((message) => message.author !== "pipeline" && message.author !== "agent")
          .map((message) => message.body);
        const prompt = await access.prepareAttachments(binding, String(operation.args.prompt ?? ""), bodies,
          ticket.session_id ?? `ticket-${ticket.id}`);
        operation = { ...operation, args: { ...operation.args, prompt } };
        repository.save(operation);
      }
      lease.assertCurrent();
      this.turnSeq = Math.max(this.turnSeq, operation.turn + 1);
      token ??= "dp_" + randomUUID().replace(/-/g, "");
      this.turnTokens.set(token, { ticketId: ticket.id, turn: operation.turn });
      // The live credential remains a private worktree file. Reattachment
      // rotates it and the ordinary recovery CLI reads the current file.
      const development = this.developmentWorkspaces?.binding(ticket.id);
      if (development) {
        if (!this.developmentMcpIssue) throw new Error("开发 MCP relay 未组成；未发送 Agent 输入");
        const scope = { owner: binding.owner, ticketId: ticket.id, turn: operation.turn, developmentId: development.developmentId };
        const current = this.developmentCredentials.get(operation.id);
        if (!current || current.credential.expiresAt <= Date.now()) {
          current?.credential.release();
          this.developmentCredentials.set(operation.id, { binding: scope, credential: this.developmentMcpIssue(scope) });
        }
      } else if (ticket.worktree) configPath = (await this.writeMcpConfig(ticket.worktree, ticket.id, token, null, ticket.model)) ?? undefined;
      const isStopped = () => this.isCancelled(ticket.id)
        || Boolean(this.store.devTickets.getDevTicket(ticket.id)?.chat_paused)
        || Boolean(repository.get(operation!.id)?.stopRequestedBy);
      const inputDelivery = new RunnerTicketInputDelivery({ turn: operation, binding, access, repository,
        unread: () => this.store.devTickets.listTicketMessages(ticket.id, { undeliveredOnly: true }),
        blocked: () => this.stopped || isStopped() || Boolean(this.store.devTickets.getDevTicket(ticket.id)?.chat_paused),
        prompt: (messages) => `${buildInterjectionPrompt(messages)}\n\n${sourcePromptReminder(this.store,ticket.id)}`,
      });
      let startupDelivered = false;
      const outcome = await runRunnerTicketTurn({ turn: operation, binding, access,
        save: (row) => {
          lease.checkpoint({ operationId: row.id }, row.state === "prepared" ? "not_sent" : "sent");
          repository.save({ ...row, ...(repository.get(row.id)?.stopRequestedBy
            ? { stopRequestedBy: repository.get(row.id)!.stopRequestedBy } : {}) });
        },
        session: (id) => this.store.devTickets.updateDevTicket(ticket.id, { session_id: id }),
        detached: () => this.stopped && (this.toolOps.get(ticket.id) ?? 0) === 0,
        cancelled: isStopped,
        observe: (receipt) => {
          this.clearRunnerWait(ticket.id);
          if (!startupDelivered && operation?.startupTraceId
            && (receipt.input?.phase === "provider_accepted" || receipt.input?.phase === "input_observed" || receipt.state === "succeeded")) {
            this.knowledgeGraph?.markDelivered(operation.startupTraceId, "ticket_prompt");
            startupDelivered = true;
          }
          if (!startupDelivered && operation?.state === "prepared" && receipt.state === "failed" && operation.startupTraceId) {
            this.knowledgeGraph?.markAbandoned(operation.startupTraceId, "pack_failed");
          }
          return inputDelivery.observe(receipt);
        },
        suspendOnUnavailable: true,
        pause: () => new Promise<void>((resolve) => {
          const done = () => { clearTimeout(timer); this.runnerInputWake.delete(ticket.id); resolve(); };
          const timer = setTimeout(done, 1_000);
          this.runnerInputWake.set(ticket.id, done);
        }),
      });
      if (outcome.detached) { lease.assertCurrent(); return { kind: "observe" }; }
      const receipt = outcome.receipt!;
      const result = receipt.result ?? {};
      const cancelled = isStopped() || Boolean(this.takeInterrupt(ticket.id));
      this.takeInterrupt(ticket.id);
      const text = cancelled ? undefined
        : await this.runnerReply(access, binding, receipt.session_id ?? this.store.devTickets.getDevTicket(ticket.id)?.session_id ?? undefined,
          result as Record<string, unknown>, ticket.id);
      const transportError = receipt.state === "unknown" ? `Runner 执行结果未知；未重播输入，请检查原会话后明确继续。${typeof result.error === "string" ? ` 原因：${result.error.slice(0, 600)}` : ""}`
        : receipt.state === "failed" && !cancelled ? String(result.error ?? "Runner 轮次失败") : undefined;
      // A remote MCP client may time out while the server-side submit is still
      // finishing. Wait for that one durable operation before deciding that a
      // successful-looking turn failed; otherwise a late landing is reported
      // as a false failure and the next reply can race a live merge.
      const activeSubmit = this.submitOps.get(token)?.operation;
      if (activeSubmit) {
        try { await activeSubmit; } catch (error) { log.warn({ ticket: ticket.id, err: msg(error) }, "devpipe: detached submit failed before Runner turn cleanup"); }
      }
      const landing = this.landedTurns.get(token);
      const landed = Boolean(landing);
      const error = landed
        ? undefined
        : transportError
          ?? (receipt.state === "succeeded" ? await this.unmergedLandingError(ticket, cancelled, false) : undefined);
      if (repository.finish(operation, { text, error, sessionId: receipt.session_id }, () => {
        this.recordTurnCost(ticket.id, operation!.id, { ok: receipt.state === "succeeded", exit_code: null,
          timed_out: false, duration_ms: typeof result.duration_ms === "number" ? result.duration_ms : 0,
          ...(result.usage && typeof result.usage === "object" ? { usage: result.usage as DevTurnResult["usage"] } : {}) });
        const slug = text ? extractSlug(text) : undefined;
        if (slug) this.store.devTickets.updateDevTicket(ticket.id, { slug });
        if (landing && !text) this.recordLandingWithoutReply(ticket.id, operation!.turn, landing);
      })) {
        const row = this.store.devTickets.getDevTicket(ticket.id)!;
        if (landed) this.notify({ kind: "landed", ticket: row });
        else if (error) this.notify({ kind: "turn_failed", ticket: row, reason: error });
        else if (text) this.notify({ kind: "reply", ticket: row, text });
        if (error) this.note(ticket.id, error);
        if (cancelled) this.note(ticket.id, "已暂停，原会话、工作区和未发送消息均已保留。点击继续即可接着处理。");
      }
      return { kind: receipt.state === "unknown" ? "unknown" : error ? "failed" : "completed", ...(error ? { detail: error } : {}) };
    } catch (error) {
      if (lease.signal.aborted) throw error;
      const unavailable = error instanceof ResourceUnavailableError ? error : null;
      if (unavailable) {
        const current = this.store.devTickets.getDevTicket(ticket.id);
        if (operation?.state === "prepared" && (current?.chat_paused || current?.dev_status === "cancelled")) {
          if (operation.startupTraceId) this.knowledgeGraph?.markAbandoned(operation.startupTraceId, "pack_failed");
          repository.releasePrepared(operation);
          this.clearRunnerWait(ticket.id);
          this.takeInterrupt(ticket.id);
        } else if (!this.stopped && (operation?.state === "dispatched"
          || (current?.dev_status !== "cancelled" && !current?.chat_paused))) {
          this.store.devTickets.updateDevTicket(ticket.id, { error: null });
          suspended = operation?.state === "dispatched";
          return { kind: "wait", dependency: unavailable.resource, detail: unavailable.detail };
        }
        // Preserve both unclaimed input and any existing operation identity.
        // Re-entry dispatches only prepared input, or queries a dispatched id.
        return { kind: "completed" };
      }
      this.clearRunnerWait(ticket.id);
      // A permanent setup refusal consumes the attempted inbox once, avoiding an
      // infinite pump. Its text remains in ticket history for an explicit retry.
      if (operation) {
        if (operation.state === "prepared" && operation.startupTraceId) this.knowledgeGraph?.markAbandoned(operation.startupTraceId, "pack_failed");
        repository.messageDelivery(operation.messageIds ?? [], operation.state === "prepared" ? "failed" : "unknown", msg(error));
        repository.finish(operation, { error: msg(error) });
      }
      else {
        const inbox = this.store.devTickets.takeTicketInbox(ticket.id, this.turnSeq++);
        repository.messageDelivery(inbox.map((row) => row.id), "failed", msg(error));
      }
      this.turnFailed(ticket.id, msg(error));
      return { kind: "failed", detail: msg(error) };
    } finally {
      this.runnerInputWake.get(ticket.id)?.();
      if (suspended && token && operation && !this.stopped) {
        // A lost observation link does not terminate the provider turn. Keep
        // its scoped tools usable and available to Runner recovery requests,
        // but an unobserved turn no longer holds the merge lock. An in-flight
        // submit keeps it until that submit settles (see submit()).
        this.parkedRunnerContexts.set(operation.id, { token, configPath });
        if (!this.submitOps.has(token)) this.releaseParkedLock(token);
      } else await this.releaseRunnerContext(operation?.id, token, configPath);
    }
  }

  /**
   * The merge lock and its GitLab lease follow a turn the Head can observe.
   * A parked turn may still call devpipe_submit later; it then queues again.
   */
  private releaseParkedLock(token: string): void {
    if ([...this.parkedRunnerContexts.values()].some((context) => context.token === token)) {
      this.releaseLock(token, "Runner 观察中断，轮次已不可见");
    }
  }

  private async releaseRunnerContext(operationId?: string, token?: string, configPath?: string): Promise<void> {
    if (token) {
      this.releaseLock(token, "Runner 工单观察结束");
      this.turnTokens.delete(token);
      this.submitCounts.delete(token);
      this.submitResults.delete(token);
      this.landedTurns.delete(token);
    }
    if (operationId) {
      const current = this.developmentCredentials.get(operationId);
      this.developmentCredentials.delete(operationId);
      current?.credential.release();
    }
    if (!this.stopped) await this.removeMcpConfig(configPath);
  }

  private async runTicketTurn(claimed: DevTicketRow): Promise<void> {
    if (this.runnerTickets) throw new Error("Runner tickets must enter through their managed execution adapter");
    if (!this.legacyTestExecution) {
      const inbox = this.store.devTickets.takeTicketInbox(claimed.id, this.turnSeq++);
      const error = "Head 工单执行器已停用。请配置本人 Runner 后明确继续；未启动本机 Agent。";
      this.store.devTickets.runner.messageDelivery(inbox.map((row) => row.id), "failed", error);
      this.turnFailed(claimed.id, error);
      return;
    }
    // DEPRECATED: frozen test fixtures below. Production never enters this
    // path; all new conversation behavior belongs to Runner session control.
    // Take the inbox FIRST (ticket #15). It used to be taken after the
    // worktree existed, so a worktree that could not be created left the
    // messages unread — and unread messages are the "run a turn" trigger, so
    // the ticket rescheduled itself forever: a note appended and a
    // notification sent every lap, holding one of the spec_concurrency slots
    // and starving every other user's ticket.
    const turn = this.turnSeq++;
    const inbox = this.store.devTickets.takeTicketInbox(claimed.id, turn);
    if (inbox.length === 0) return; // raced away
    const prepared = await this.ensureWorktree(claimed);
    if (!prepared) return;
    const t = this.reconcileLane(prepared);
    if (this.isCancelled(t.id)) {
      this.note(t.id, "ℹ 工单已取消,本轮不再开始。");
      return;
    }

    // "Already introduced" (ticket #20) means: from the CLI's point of view,
    // the intro prompt has ALREADY entered this session's context. The
    // pre-#20 signal was `hasAgentMessage`, which required the first turn to
    // survive long enough to write an agent reply row. But the CLI writes the
    // JSONL transcript incrementally: a first turn that crashed after the
    // intro was sent but before the assistant reply was flushed still left an
    // established session on disk. Falling back to `firstEver=true` in that
    // case caused a second FULL intro to land in the SAME session — the "prompt
    // 组装了一个初始启动风格的很长的prompt" complaint. Trust the transcript file
    // as the ground truth; the DB agent-message check is kept as a fallback so
    // this survives cases where the transcript dir was pruned out of band.
    // Two families mint their own session id and write outside a cwd-scoped
    // tree: Codex and omp. Everything below that used to read "is this codex"
    // is really "does this CLI let the pipeline pre-allocate and fork", which
    // only Claude does.
    const ticketMintsOwnId = cliFamilyForModel(t.model) !== "claude";
    // Claude session existence is proven by its cwd-scoped transcript. Codex
    // and omp persist the id this exact child reported instead; their
    // transcript trees are not cwd-addressable. Treat that trusted event as
    // establishment, otherwise a failed first turn gets the entire intro
    // injected again when it resumes.
    const alreadyIntroduced =
      this.hasAgentMessage(t.id)
      || (ticketMintsOwnId ? Boolean(t.session_id) : this.sessionExistsFn(t.worktree!, t.session_id));
    const spec: DevTurnSpec = { model: t.model, effort: t.effort, prompt: "" };

    // Session wiring: follow-up tickets fork the parent's session; a ticket
    // with its own session resumes it; a brand-new one gets a pre-chosen id so
    // the panel can open the transcript from second one.
    //
    // Codex (ticket #38-3) does not accept a pre-allocated session id — it
    // mints its own in the JSONL stream and executor publishes the early
    // `thread.started` id through runTurnTracked. We therefore leave
    // `sessionId` unset. The end-of-turn update remains a backstop. A codex
    // parent also has no --fork-session equivalent, so a follow-up on a codex
    // parent starts a brand-new codex session; the intro turn re-establishes
    // context (the whole conversation is still in ticket_messages).
    const parent = t.parent_ticket_id != null ? this.store.devTickets.getDevTicket(t.parent_ticket_id) : undefined;
    // Neither codex nor omp 17.x has a fork equivalent, so a follow-up on such
    // a parent starts a fresh session and its intro turn re-establishes
    // context (the whole conversation is still in ticket_messages).
    const parentCanFork = cliFamilyForModel(parent?.model) === "claude";
    const forked = Boolean(!t.session_id && parent?.session_id) && parentCanFork;
    if (forked) {
      spec.resumeSessionId = parent!.session_id!;
      spec.forkSession = true;
    } else if (t.session_id) {
      spec.resumeSessionId = t.session_id;
    } else if (!ticketMintsOwnId) {
      spec.sessionId = randomUUID();
      this.store.devTickets.updateDevTicket(t.id, { session_id: spec.sessionId });
    }
    // ticketMintsOwnId && !t.session_id: leave both unset; the CLI mints its id and
    // runTurnTracked persists it as soon as stdout reports thread.started.

    // The CI container credential is opened BEFORE the prompt is built: an
    // intro that describes machine tools the config does not carry would send
    // the agent hunting for them, and one that omits tools it DOES have wastes
    // the whole point. Both come from the same object or neither does.
    // This is no longer repair-only. Ordinary ticket agents need the same
    // compile/test feedback loop; the composition root still decides which
    // requesters own the configured device and returns null for everybody
    // else. Each successful sync below gives the ticket its own worktree.
    const machine = this.ciMachine
      ? this.ciMachine(t.requester, `dev-ticket/${t.id}`)
      : null;
    if (isCiRepairTicket(t) && !machine) {
      log.info({ ticket: t.id }, "devpipe: CI repair turn has no machine lane (runner offline or requester is not the device owner)");
    }
    // codex-runner (#358): the turn's Codex runs on the requester's own Runner
    // device. Resolve that device and its relay grant before anything else is
    // spent on this turn; there is no local fallback that would honour the
    // chosen model, so a missing lane fails the turn with a plain sentence.
    let remoteCodex: RemoteCodexLease | null = null;
    if (cliFamilyForModel(t.model) === "codex-runner") {
      const bound = t.codex_account_slot?.startsWith("runner:")
        ? t.codex_account_slot.slice("runner:".length)
        : undefined;
      remoteCodex = this.remoteCodex ? this.remoteCodex(t.requester, `dev-ticket/${t.id}`, bound) : null;
      if (!remoteCodex || (bound && remoteCodex.device !== bound)) {
        remoteCodex?.close();
        machine?.close();
        this.turnFailed(
          t.id,
          bound
            ? `本票的 Codex 会话固定在你的设备 ${bound} 上,当前无法使用该设备;恢复后回复任意消息即可继续。`
            : "这个执行选项需要你自己注册的 Runner 设备上有可用的 Codex 登录;当前没有找到这样的设备。",
        );
        return;
      }
      if (!remoteCodex.online) {
        const device = remoteCodex.device;
        remoteCodex.close();
        machine?.close();
        this.turnFailed(t.id, `你的 Runner 设备 ${device} 当前不在线;上线后回复任意消息即可继续本轮。`);
        return;
      }
      // The session's rollout state lives in that device's isolated Codex
      // home, so later turns must reuse the same device — same reasoning as
      // the account-slot pin in routeCodexTurn.
      if (!bound) {
        this.store.devTickets.updateDevTicket(t.id, { codex_account_slot: `runner:${remoteCodex.device}` });
      }
      const lease = remoteCodex;
      spec.remoteCodex = {
        open: () => openRemoteCodexBridge({
          call: lease.call,
          worktree: t.worktree!,
          label: `ticket-${t.id}`,
        }),
      };
    }
    // The container's checkout is moved to the ticket's HEAD for every turn.
    // Until 2026-08-21 the turn waited for that (a prompt saying "synced to X"
    // while the sync still ran would be a lie with a race in it); now the sync
    // runs in the background and the prompt says "syncing to X" instead — a
    // different true sentence, and the agent's first devpipe_ci_sync joins the
    // run rather than starting a second one. The per-turn token exists before
    // the sync starts so its completion can update THIS turn's record.
    const token = "dp_" + randomUUID().replace(/-/g, "");
    this.turnTokens.set(token, { ticketId: t.id, turn });
    let syncSha: string | null = null;
    if (machine && this.ciMachineSync && !this.ciWorkspaceProvider?.(t.requester)) {
      // Started here, finished whenever (2026-08-21): the agent's opening
      // minutes are reading, and a cold ticket workspace can take a few of
      // them. The prompt says "syncing to X", never "synced", and the first
      // devpipe_ci_sync joins this very run instead of starting a second one.
      const head = await git(t.worktree!, ["rev-parse", "HEAD"]);
      syncSha = head.ok && head.stdout ? head.stdout : "HEAD";
      machine.target = { ...machine.target, syncedTo: null, syncing: syncSha };
    }
    if (machine) this.ciWorkspaces.set(token, { ...machine.target });
    if (machine && syncSha) void this.startCiSync(token, t.id, t.worktree!, syncSha, t.requester, machine.target);
    // Resuming/attaching alone starts no model work in any supported backend:
    // Claude print mode needs stream input, Codex needs turn/start input, and
    // OMP RPC needs dispatch(). A literal "继续执行" is the smallest portable
    // wake; do not expand it with refreshed knowledge or the follow-up wrapper.
    const restartContinuation =
      Boolean(spec.resumeSessionId) && !forked && alreadyIntroduced && isRestartContinuation(inbox);
    let knowledgeContext: string | undefined;
    let startupTraceId: RetrievalTraceId | null = null;
    let startupTraceSettled = false;
    const freshIntro = !(spec.resumeSessionId && !forked && alreadyIntroduced);
    if (this.knowledgeGraph) {
      // Graph-backed startup pack (design §4.5 A), intro turn only: the agent
      // keeps its session and refines with devpipe_context once it knows paths.
      if (freshIntro) {
        try {
          const pack = await this.knowledgeGraph.startupPack(
            { title: t.title, body: t.body, spec: t.spec, ciRoster: decodeCiRoster(t.ci_roster) },
            { lane: "ticket", subject_ref: `ticket:${t.id}`, turn },
          );
          if (pack) {
            startupTraceId = pack.trace.envelope.trace_id;
            knowledgeContext = `${pack.text}\n\n检索追踪：${startupTraceId}`;
            this.note(
              t.id,
              `ℹ 知识启动包:${pack.included.length} 条记录;能力 ${pack.capabilities.map((m) => `${m.id}/${m.certainty}`).join(", ") || "无"};未知 ${pack.unknown.length} 项;追踪 ${startupTraceId}。动手前用 devpipe_context 按路径核对。`,
            );
          }
        } catch (err) {
          log.warn({ ticket: t.id, err: msg(err) }, "devpipe: knowledge startup pack failed");
        }
      }
    } else if (this.knowledgeCaptureEnabled && !restartContinuation) {
      try {
        await this.knowledgeIndex.refresh(this.baseBranch);
        const query = [t.title, t.body, t.spec ?? "", formatInbox(inbox)].join("\n");
        knowledgeContext = formatKnowledgeContext(this.store.knowledge.search(query));
      } catch (err) {
        log.warn({ ticket: t.id, err: msg(err) }, "devpipe: knowledge index refresh failed");
        this.note(t.id, `⚠ 系统知识索引刷新失败:${msg(err)}。本轮仍可开发,但提交会再次检查,不会静默跳过。`);
      }
    }

    spec.prompt = restartContinuation
      ? RESTART_CONTINUE_PROMPT
      : spec.resumeSessionId && !forked && alreadyIntroduced
        ? buildTurnPrompt(inbox, knowledgeContext)
        : buildIntroPrompt(t, inbox, {
            baseBranch: this.baseBranch,
            toolsAvailable: this.toolApiUrl != null,
            forkNote: await this.forkNote(t),
            machine: machine?.target ?? null,
            knowledgeContext,
          });

    if (this.ciWorkspaceProvider?.(t.requester)) {
      spec.prompt += "\n本票使用已注册 workspace job provider。先 devpipe_ci_sync 准备精确 SHA，准备成功后用 devpipe_ci_job start 运行相关编译/测试。每个任务使用稳定 request_key，通过 status/log/cancel 查询、读日志或取消。断线沿用原 key，unknown 不得重播或退回服务节点运行重任务。";
    }
    spec.mcpConfigPath = (await this.writeMcpConfig(t.worktree!, t.id, token, machine, t.model)) ?? undefined;

    let landing: LandedTurnReceipt | null = null;
    let r: DevTurnResult;
    try {
      r = await this.runTurnTracked(t.id, t.worktree!, spec, turn);
      if (
        spec.resumeSessionId && !forked && !alreadyIntroduced
        // Ticket #180: this used to read a bare `!r.ok`, which is every way a
        // turn can end badly — including the three that are NOT evidence of a
        // ghost session. `aborted` means WE killed the CLI (the ticket was
        // cancelled, or the service is shutting down); `stalled`/`timed_out`
        // mean it ran fine and ran long; `error` means it never spawned. In all
        // of those the pipeline discarded the ticket's session id and started a
        // SECOND full agent run — same turn, same message, the whole intro
        // prompt again — which is what "this ticket started executing twice"
        // was. `isCliExitFailure` keeps only the shape a ghost session actually
        // has: the CLI came up, `--resume` found nothing, it exited non-zero.
        && isCliExitFailure(r)
        // And even then, not into a cancellation or a shutdown: both arrive
        // between the two runs and both make the second one pure waste.
        && !this.isCancelled(t.id) && !this.stopped
      ) {
        // The session we meant to resume never materialised (the CLI died
        // before writing it). Start a clean one rather than parking on a ghost.
        const fresh = randomUUID();
        this.store.devTickets.updateDevTicket(t.id, { session_id: fresh });
        this.note(t.id, "⏳ 上一个会话没能恢复(可能上轮启动时就已中断),用新会话重新开始本轮...");
        r = await this.runTurnTracked(
          t.id,
          t.worktree!,
          { ...spec, prompt: this.withLostInterjections(spec.prompt, t.id, turn, inbox), resumeSessionId: undefined, sessionId: fresh },
          turn,
        );
      }
      // Ticket #20/#400: one automatic retry on a transient-looking failure.
      // A CLI can exit non-zero when its endpoint hiccups; a Codex app-server
      // can also miss initialize on a loaded post-deploy host before accepting
      // any prompt. In both cases one retry is safe; leaving the ticket in an
      // error state until the user replies is strictly worse than a 3-second
      // nap and one more shot. We
      // reuse the exact same spec so, if the session file was already
      // written, the retry `--resume`s with the short "please continue"
      // prompt — no re-injecting the intro. `isTransientFailure` deliberately
      // excludes ambiguous post-prompt RPC timeouts, generic spawn errors,
      // stalls, aborts, and any success case.
      if (isTransientFailure(r) && !this.isCancelled(t.id)) {
        const failure = r.retryable_error ? (r.error ?? "provider preflight") : `exit ${r.exit_code}`;
        log.warn({ ticket: t.id, exit: r.exit_code, error: r.error }, "devpipe: transient turn failure — retrying once");
        this.note(
          t.id,
          `⏳ 上一次执行失败(${failure}),等 ${Math.round(this.turnRetryDelayMs / 1000)}s 后自动重试一次...`,
        );
        await sleep(this.turnRetryDelayMs);
        if (!this.isCancelled(t.id)) {
          // The retry uses the current session state — if the first attempt
          // wrote the transcript, keep `resumeSessionId` intact; otherwise
          // the on-disk session id may have shifted via the fallback above.
          const fresh = this.store.devTickets.getDevTicket(t.id);
          const retrySpec: DevTurnSpec = { ...spec };
          // Codex's early `thread.started` callback is the transcript proof;
          // `sessionExistsFn` only understands Claude's cwd-scoped files.
          if (fresh?.session_id && (ticketMintsOwnId || this.sessionExistsFn(t.worktree!, fresh.session_id))) {
            retrySpec.resumeSessionId = fresh.session_id;
            retrySpec.sessionId = undefined;
            retrySpec.forkSession = false;
            retrySpec.prompt = buildTurnPrompt(inbox);
          }
          retrySpec.prompt = this.withLostInterjections(retrySpec.prompt, t.id, turn, inbox);
          r = await this.runTurnTracked(t.id, t.worktree!, retrySpec, turn);
        }
      }
      if (startupTraceId) {
        if (r.error) this.knowledgeGraph?.markAbandoned(startupTraceId, "pack_failed");
        else this.knowledgeGraph?.markDelivered(startupTraceId, "ticket_prompt");
        startupTraceSettled = true;
      }
    } finally {
      if (startupTraceId && !startupTraceSettled) this.knowledgeGraph?.markAbandoned(startupTraceId, "pack_failed");
      const activeSubmit = this.submitOps.get(token)?.operation;
      if (activeSubmit && !this.stopped && !this.isCancelled(t.id)) {
        // OMP may finish its agent turn after its MCP client timed out while the
        // bot is still running the gate. Preserve the atomic submit instead of
        // turning a client-side timeout into a ghost-lock cancellation.
        try {
          await activeSubmit;
        } catch (err) {
          log.warn({ ticket: t.id, err: msg(err) }, "devpipe: detached submit failed before turn cleanup");
        }
      }
      // Fail closed: a killed or merely-ended turn must not leave a live token
      // or the lock. A base_changed_review handoff deliberately keeps the lock
      // across the agent's same-turn review + CI revalidation, so this is also
      // the bound that prevents an abandoned review from freezing all landings.
      landing = this.landedTurns.get(token) ?? null;
      this.landedTurns.delete(token);
      if (this.mergeLock.isHolder(token) && !landing) {
        this.releaseLock(token, "轮次结束,落地未完成");
        this.note(t.id, "ℹ 轮次结束时本票仍持有合并锁(落地未完成),已自动释放。已 commit 的工作保留在票分支上。");
      }
      this.turnTokens.delete(token);
      this.submitCounts.delete(token);
      this.submitResults.delete(token);
      this.ciWorkspaces.delete(token);
      await this.removeMcpConfig(spec.mcpConfigPath);
      // Same lifetime as the config file that carried it: a turn's authority
      // over the CI container dies with the turn, however the turn ended.
      machine?.close();
      remoteCodex?.close();
    }

    // Record what the turn cost BEFORE any of the outcome branches below
    // return. A cancelled, stalled or failed turn still spent wall time and
    // tokens, and a board that only counts successful turns would understate
    // exactly the tickets that went badly — the ones worth looking at.
    const creditRef = createHash("sha256")
      .update(JSON.stringify([t.id, inbox.map((message) => message.id)]), "utf8")
      .digest("hex");
    this.recordTurnCost(t.id, creditRef, r);

    const interruptedBy = this.takeInterrupt(t.id);
    if (this.isCancelled(t.id)) {
      // Cancelled mid-turn: not an error, and not something to retry.
      this.note(t.id, "🛑 工单已取消,本轮被终止。已 commit 的工作保留在票分支上,未合入基线。");
      return;
    }
    if (landing && (!r.ok || !r.result_text)) {
      // Landing precedes the provider's final-answer event. If the CLI exits,
      // is interrupted, or otherwise loses that last event, the code is still
      // on the base branch and the ticket must not become an empty record.
      // Wait until the turn has actually ended, then check the durable rows so
      // a real reply always wins and the fallback can never duplicate it.
      this.recordLandingWithoutReply(t.id, turn, landing);
      this.store.devTickets.updateDevTicket(t.id, {
        session_id: r.session_id ?? this.store.devTickets.getDevTicket(t.id)?.session_id ?? null,
        error: null,
      });
      const row = this.store.devTickets.getDevTicket(t.id)!;
      this.notify({ kind: "landed", ticket: row });
      return;
    }
    if (r.aborted && interruptedBy) {
      // A stop, not a failure. Nothing is retried and nothing is marked wrong:
      // the ticket is open, the branch holds every commit the turn made, and
      // `session_id` still resumes — so the next message continues this
      // conversation instead of starting a second one.
      this.note(
        t.id,
        `🛑 ${interruptedBy} 停止了这一轮。已 commit 的工作、worktree 与会话都保留;`
          + "在下面回一句话(说明要改什么)即可从当前状态继续。",
      );
      return;
    }
    if (r.aborted && this.stopped) {
      // A deploy must not wait indefinitely for a conversational CLI turn.
      // runTurnTracked already put back one unread wake-up atomically with
      // clearing the liveness marker, so the next bot resumes this session.
      return;
    }
    if (r.aborted) {
      this.note(t.id, "🛑 本轮被终止。已 commit 的工作保留在票分支上,未合入基线。");
      return;
    }
    if (!r.ok || !r.result_text) {
      this.turnFailed(t.id, `轮次失败: ${this.turnError(r)}`);
      return;
    }

    const unmergedError = await this.unmergedLandingError(t, false, Boolean(landing));
    this.store.devTickets.addTicketMessage(t.id, "agent", "agent", r.result_text, turn);
    const slug = extractSlug(r.result_text);
    this.store.devTickets.updateDevTicket(t.id, {
      session_id: r.session_id ?? this.store.devTickets.getDevTicket(t.id)?.session_id ?? null,
      error: unmergedError ?? null,
      ...(slug ? { slug } : {}),
    });
    const row = this.store.devTickets.getDevTicket(t.id)!;
    if (landing) this.notify({ kind: "landed", ticket: row });
    else if (unmergedError) {
      this.note(t.id, unmergedError);
      this.notify({ kind: "turn_failed", ticket: row, reason: unmergedError });
    } else this.notify({ kind: "reply", ticket: row, text: r.result_text });
  }

  /**
   * Carry into a retry the messages the DEAD attempt had already swallowed.
   *
   * An interjection is stamped as delivered the instant the transport takes
   * it, which is correct — but if that attempt then dies, the only copy of the
   * user's words lives in a transcript nobody is resuming. The inbox cannot
   * re-flush them (they are stamped), so the retry prompt has to carry them
   * explicitly. Pipeline notes and agent replies are excluded: they are not
   * things the user is still waiting on.
   */
  private withLostInterjections(
    prompt: string,
    ticketId: number,
    turn: number,
    inbox: TicketMessageRow[],
  ): string {
    const known = new Set(inbox.map((m) => m.id));
    const lost = this.store.devTickets
      .listTicketMessagesForTurn(ticketId, turn)
      .filter((m) => !known.has(m.id) && m.author !== "pipeline" && m.author !== "agent");
    if (lost.length === 0) return prompt;
    return `${prompt}\n\n(上一次执行中途还收到过这些消息,一并处理)\n${formatInbox(lost)}`;
  }

  private hasAgentMessage(ticketId: number): boolean {
    return this.store.devTickets.listTicketMessages(ticketId).some((m) => m.author === "agent");
  }

  /**
   * Fold one finished turn into the ticket's running cost (#192).
   *
   * Accounting must never be able to fail a turn, so every error here is
   * swallowed with a log line: the worst outcome of a broken cost column is a
   * wrong number in a sidebar, and the worst outcome of letting it throw is a
   * lost turn.
   */
  private recordTurnCost(ticketId: number, creditRef: string, r: DevTurnResult): void {
    try {
      const row = this.store.devTickets.getDevTicket(ticketId);
      if (!row) return;
      const next = accumulateTurnCost(
        {
          agent_ms: row.agent_ms ?? 0,
          agent_turns: row.agent_turns ?? 0,
          tokens_in: row.tokens_in ?? 0,
          tokens_out: row.tokens_out ?? 0,
          tokens_cached: row.tokens_cached ?? 0,
        },
        // Duration last: the executor's wall-clock measurement always wins over
        // anything a CLI might start reporting under the same name.
        { ...(r.usage ?? {}), duration_ms: r.duration_ms },
      );
      this.store.devTickets.updateDevTicket(ticketId, next);
      const earned = turnTokenTotal(r.usage);
      if (earned > 0 && !this.creditExcludedUsers.has(row.requester)) {
        this.store.credits.record({
          username: row.requester,
          delta: earned,
          reason: "ticket_earn",
          refKind: "dev_ticket_turn",
          refId: `${ticketId}:${creditRef}`,
        });
      }
    } catch (err) {
      log.warn({ ticket: ticketId, err: msg(err) }, "devpipe: recording turn cost failed");
    }
  }

  /**
   * Measure what a landing actually changed, from the exact range it merged.
   *
   * `from`..`to` is the range `ffBaseTo` fast-forwarded, so this is the truth
   * rather than a reconstruction: no merge-base guessing, no interference from
   * whatever else landed in between. Same failure policy as the turn cost — a
   * missing measurement leaves the columns NULL and the merge stands.
   */
  private async recordLandDiff(ticketId: number, from: string, to: string): Promise<void> {
    try {
      const numstat = await git(this.repoDir, ["diff", "--numstat", "--no-renames", from, to]);
      if (!numstat.ok) {
        log.warn({ ticket: ticketId, err: numstat.stderr.slice(-200) }, "devpipe: land diffstat failed");
        return;
      }
      const stat = parseNumstat(numstat.stdout);
      this.store.devTickets.updateDevTicket(ticketId, {
        diff_files: stat.files,
        diff_modules: stat.modules,
        diff_added: stat.added,
        diff_removed: stat.removed,
      });
    } catch (err) {
      log.warn({ ticket: ticketId, err: msg(err) }, "devpipe: land diffstat failed");
    }
  }

  /**
   * Per-turn MCP config file; null when the loopback API is not wired up.
   *
   * Lives INSIDE the ticket's own worktree (ticket #15). It used to sit in
   * `worktreesDir` — the shared PARENT of every ticket worktree — and was
   * never deleted, so with spec_concurrency > 1 one ticket's agent could read
   * `../.mcp-ticket-<other>.json` and act as that ticket: claim the global
   * dev lock, or submit its branch. The ghost guard cannot catch that, since
   * the stolen token really is the live holder. Same-directory + 0600 + unlink
   * at turn end keeps a turn's credential inside the turn's own sandbox.
   */
  private async writeMcpConfig(
    worktree: string,
    ticketId: number,
    token: string,
    machine: CiMachineGrant | null,
    model: string | null | undefined,
  ): Promise<string | null> {
    if (!this.toolApiUrl) return null;
    const file = path.join(worktree, MCP_CONFIG_FILE);
    const knowledgeConflict = Boolean(this.store.devTickets.getDevTicket(ticketId)?.knowledge_subject_id);
    const config = {
      mcpServers: {
        devpipe: {
          command: "node",
          args: [this.mcpServerPath],
          env: {
            DEVPIPE_API: this.toolApiUrl,
            DEVPIPE_TOKEN: token,
            ...(knowledgeConflict ? { DEVPIPE_KNOWLEDGE_CONFLICT: "1" } : {}),
          },
        },
        // The configured device owner's development turns. For Claude and
        // Codex this file IS the agent's whole tool surface: the grant is
        // minted per turn, reaches one CI device, and is revoked with the file
        // below. omp additionally discovers the host's own servers, but never
        // another lane's machine grant because it only exists in this file.
        ...(machine
          ? {
              machines: {
                command: "node",
                args: [this.machinesServerPath],
                env: {
                  MACHINES_API: machine.apiUrl,
                  MACHINES_TOKEN: machine.apiToken,
                  // Tool shaping only: the capability grant remains the
                  // server-side authority and independently enforces this
                  // exact runner_device_scope.
                  MACHINES_DEVICE: machine.target.device,
                  MACHINES_AUTO_ALLOW: "1",
                },
              },
            }
          : {}),
      },
    };
    const body = JSON.stringify(config, null, 2);
    try {
      await fs.writeFile(file, body, { mode: 0o600 });
    } catch (err) {
      log.warn({ err: msg(err), ticket: ticketId }, "could not write MCP config — turn runs toolless");
      return null;
    }
    // omp has no `--mcp-config`: it DISCOVERS `<cwd>/.omp/mcp.json`. Writing a
    // second copy there is the only way to hand it the pipeline's tools, and
    // it carries the same per-turn token, so it gets the same 0600 mode, the
    // same git exclusion and the same removal when the turn ends.
    if (cliFamilyForModel(model) === "omp") {
      try {
        const ompFile = ompMcpConfigPath(worktree);
        await fs.mkdir(path.dirname(ompFile), { recursive: true });
        await fs.writeFile(ompFile, body, { mode: 0o600 });
      } catch (err) {
        log.warn({ err: msg(err), ticket: ticketId }, "could not write omp MCP config — turn runs toolless");
      }
    }
    return file;
  }



  /** Best-effort: the token is dead by now anyway, the file just lingers. */
  private async removeMcpConfig(file: string | undefined): Promise<void> {
    if (!file) return;
    await fs.rm(file, { force: true }).catch(() => {});
    // The omp copy lives beside it in the same worktree; remove it
    // unconditionally rather than re-deriving which family this turn was.
    await fs.rm(path.join(path.dirname(file), OMP_MCP_CONFIG_DIR), {
      recursive: true,
      force: true,
    }).catch(() => {});
  }

  /**
   * One-time sweep of the pre-#15 shared-directory config files. They carry
   * long-dead tokens, but they are also a map of every ticket that ever ran.
   */
  private async sweepLegacyMcpConfigs(): Promise<void> {
    try {
      const names = await fs.readdir(this.worktreesDir);
      for (const n of names) {
        if (/^\.mcp-ticket-\d+\.json$/.test(n)) {
          await fs.rm(path.join(this.worktreesDir, n), { force: true }).catch(() => {});
        }
      }
    } catch {
      // no worktrees dir yet, or unreadable — nothing to sweep
    }
  }

  // ── tool ops (called from the dashboard's /api/devpipe/* routes) ──

  /** Resolve a bearer token to its live turn; undefined = stale/invalid. */
  resolveToolToken(token: string): TurnCtx | undefined {
    return this.turnTokens.get(token);
  }

  /**
   * One workspace sync per ticket at a time, joinable (2026-08-21). Turn start
   * kicks one off without waiting for it; `devpipe_ci_sync` joins it when it
   * is about the same HEAD, or queues behind it. Never two at once: they would
   * race on the workspace's git worktree. Completion updates the turn's
   * workspace record (`ciWorkspaces`) so `devpipe_status`/the next tool call
   * see the synced sha, and a failure is noted on the ticket exactly as the
   * old blocking sync noted it.
   */
  private startCiSync(
    token: string,
    ticketId: number,
    sourceDir: string,
    sha: string,
    requester: string,
    target: CiMachineTarget,
  ): Promise<CiSyncOutcome> {
    const previous = this.ciSyncInFlight.get(ticketId)?.promise ?? Promise.resolve(null);
    const promise: Promise<CiSyncOutcome> = previous.then(() => undefined, () => undefined).then(async () => {
      if (!this.ciMachineSync) return { ok: false, detail: "本进程没有配置隔离 CI 同步" };
      const queuedAt = Date.now();
      const queued = this.ciSyncGate.inUse >= this.ciSyncGate.slots;
      if (queued) log.info({ ticket: ticketId, ahead: this.ciSyncGate.queued + this.ciSyncGate.inUse }, "devpipe: CI workspace sync queued behind other tickets");
      try {
        const synced = await this.ciSyncGate.run(() =>
          this.ciMachineSync!({ sourceDir, ref: "HEAD", ticketId, requester, target }),
        );
        log.info({ ticket: ticketId, ok: synced.ok, ms: Date.now() - queuedAt, detail: synced.detail }, "devpipe: isolated CI workspace sync");
        const ws = this.ciWorkspaces.get(token);
        if (ws) {
          this.ciWorkspaces.set(token, {
            ...ws,
            ...(synced.checkoutDir ? { checkoutDir: synced.checkoutDir } : {}),
            syncedTo: synced.ok ? (synced.sha ?? sha) : null,
            syncing: null,
          });
        }
        if (!synced.ok) {
          // A sync that died because the device is away is the same promise
          // a tool call makes: the ticket waits, and hears when it is back.
          const unavailable = parseUnavailable(synced.detail);
          if (unavailable) {
            this.resourceRecovery.note(ticketScope(ticketId), unavailable.resource, unavailable.detail);
            this.note(ticketId, `⚠ CI 工作区同步未完成:${synced.detail ?? "设备离线"} 同步会在设备恢复后由 devpipe_ci_sync 重试。`);
          } else {
            this.note(ticketId, `⚠ CI 容器检出同步失败(${synced.detail ?? "未知原因"});本轮仍可用那台机器,但它的代码可能是旧的,devpipe_ci_sync 会重试。`);
          }
        }
        return synced;
      } catch (err) {
        log.warn({ ticket: ticketId, err: msg(err) }, "devpipe: CI container base sync threw");
        const ws = this.ciWorkspaces.get(token);
        if (ws) this.ciWorkspaces.set(token, { ...ws, syncedTo: null, syncing: null });
        return { ok: false, detail: msg(err) };
      }
    });
    const entry = { sha, promise };
    this.ciSyncInFlight.set(ticketId, entry);
    const clear = (): void => {
      if (this.ciSyncInFlight.get(ticketId) === entry) this.ciSyncInFlight.delete(ticketId);
    };
    void promise.then(clear, clear);
    return promise;
  }

  /**
   * Copy the ticket branch's current committed HEAD into its isolated CI
   * workspace without taking the merge lock. Agents call this after a local
   * commit and again after submit rebases concurrent landings, then compile
   * and run the related small tests through machine_exec in that workspace.
   */
  async toolCiJob(token: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const context = this.turnTokens.get(token);
    if (!context) return { ok: false, code: "not_holder", message: "token 无效或轮次已结束。" };
    const ticket = this.store.devTickets.getDevTicket(context.ticketId);
    const provider = ticket ? this.ciWorkspaceProvider?.(ticket.requester) : null;
    if (!ticket?.worktree || !provider) return { ok: false, code: "unavailable", message: "本票没有已授权的 workspace job provider。" };
    const requestKey = String(args.request_key ?? "");
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(requestKey)) return { ok: false, code: "invalid", message: "request_key 必须是稳定的 1–80 字符任务名；重连沿用原 key。" };
    const key = `ticket:${ticket.id}:${requestKey}`;
    try {
      if (args.action === "status") return { ok: true, task: await provider.query(key) };
      if (args.action === "cancel") return { ok: true, task: await provider.cancel(key) };
      if (args.action === "log") return { ok: true, log: await provider.log(key, Number(args.offset ?? 0), Number(args.length ?? 65536)) };
      if (args.action !== "start") return { ok: false, code: "invalid", message: "action 必须为 start/status/log/cancel。" };
      if (ticket.dev_status === "cancelled") return { ok: false, code: "not_holder", message: "工单已取消，不能启动新任务。" };
      const imported = await this.refreshDevelopmentCandidate(token, false);
      if (imported) return { ...imported };
      const dirty = await git(ticket.worktree, ["status", "--porcelain", "--untracked-files=no"]);
      if (!dirty.ok || dirty.stdout.trim()) return { ok: false, code: "dirty", message: "远端任务只接受已提交的精确源码版本。" };
      const sha = await gitOrThrow(ticket.worktree, ["rev-parse", "HEAD"]);
      const task = await provider.submit({ key, workspaceKey: `ticket-${ticket.id}`, sha,
        command: String(args.command ?? ""), timeoutMs: Number(args.timeout_ms ?? 300000),
        ...(args.prepare === true || this.developmentWorkspaces?.binding(ticket.id) ? { sourceDir: ticket.worktree } : {}) });
      return { ok: true, task, message: "用同一 request_key 查询状态/日志或取消；未知状态不得换 key 自动重播。" };
    } catch (error) {
      return { ok: false, code: error instanceof WorkspaceProviderUnknown ? "unknown" : error instanceof WorkspaceProviderUnavailable ? "offline" : "failed",
        message: msg(error) };
    }
  }

  async toolCiSync(token: string): Promise<{
    ok: boolean;
    code?: "not_holder" | "unavailable" | "dirty" | "sync_failed";
    sha?: string;
    device?: string;
    checkout_dir?: string;
    message: string;
  }> {
    const ctx = this.turnTokens.get(token);
    if (!ctx) return { ok: false, code: "not_holder", message: "token 无效或轮次已结束。" };
    const t = this.store.devTickets.getDevTicket(ctx.ticketId);
    const workspace = this.ciWorkspaces.get(token);
    const imported = await this.refreshDevelopmentCandidate(token, false);
    if (imported) return { ok: false, code: imported.code === "dirty" ? "dirty" : "sync_failed", message: imported.message };
    if (t?.worktree && this.ciWorkspaceProvider?.(t.requester)) {
      const provider = this.ciWorkspaceProvider(t.requester)!;
      const sha = await gitOrThrow(t.worktree, ["rev-parse", "HEAD"]);
      const command = "pnpm install --frozen-lockfile --prefer-offline && pnpm --filter @claude-bot/runner --filter @claude-bot/plugin-sessions --filter @claude-bot/dashboard-web build";
      const requestKey = `prepare-${sha}`;
      const reply = await this.toolCiJob(token, { action: "start", request_key: requestKey, prepare: true, command, timeout_ms: 900000 });
      if (reply.ok !== true) return { ok: false, code: "sync_failed", sha, message: JSON.stringify(reply) };
      try {
        const task = await provider.wait({ key: `ticket:${t.id}:${requestKey}`, workspaceKey: `ticket-${t.id}`, sha,
          command, timeoutMs: 900000, sourceDir: t.worktree });
        return { ok: task.state === "succeeded", ...(task.state === "succeeded" ? {} : { code: "sync_failed" as const }), sha,
          message: JSON.stringify({ task, request_key: requestKey, next: "使用 devpipe_ci_job 在同一 workspace_key 上编译/测试；原任务日志按 request_key 查询。" }) };
      } catch (error) { return { ok: false, code: "sync_failed", sha, message: msg(error) }; }
    }
    if (!t?.worktree || !this.ciMachineSync || !workspace) {
      return { ok: false, code: "unavailable", message: "本轮没有可用的隔离 CI 工作区(本票请求人不拥有配置的 CI 设备,或本进程没有配置同步);按最小范围在本机验证并如实记录。" };
    }
    const dirty = await git(t.worktree, ["status", "--porcelain"]);
    const dirtyLines = dirty.stdout.split("\n").filter((l) => l.trim() && !l.endsWith(MCP_CONFIG_FILE));
    if (!dirty.ok || dirtyLines.length) {
      return {
        ok: false,
        code: "dirty",
        message: `CI 同步只接受已提交的精确 HEAD;先 commit 当前改动:\n${dirtyLines.join("\n").slice(0, 1_000)}`,
      };
    }
    const head = await git(t.worktree, ["rev-parse", "HEAD"]);
    const sha = head.ok && head.stdout ? head.stdout : "HEAD";
    // Join the run turn start kicked off when it is about this very HEAD;
    // otherwise queue behind it (two syncs of one workspace race on git).
    const inflight = this.ciSyncInFlight.get(t.id);
    let synced: CiSyncOutcome | null = null;
    if (inflight) {
      const joined = await inflight.promise;
      if (inflight.sha === sha && joined.ok) synced = joined;
    }
    if (!synced) synced = await this.startCiSync(token, t.id, t.worktree, sha, t.requester, workspace);
    if (!synced.ok) {
      return {
        ok: false,
        code: "sync_failed",
        device: workspace.device,
        checkout_dir: synced.checkoutDir ?? workspace.checkoutDir,
        message: `隔离 CI 工作区同步失败:${synced.detail ?? "未知原因"}`,
      };
    }
    const target = synced.checkoutDir ?? workspace.checkoutDir;
    this.ciWorkspaces.set(token, { ...workspace, checkoutDir: target, syncedTo: synced.sha ?? sha, syncing: null });
    return {
      ok: true,
      sha: synced.sha,
      device: workspace.device,
      checkout_dir: target,
      message: `已把本票精确 HEAD ${synced.sha?.slice(0, 12) ?? ""} 同步到设备 ${workspace.device} 的 ${target};现在调用 machine_exec(device=${workspace.device}, cwd=${target}) 编译并跑相关小测试。`,
    };
  }

  /**
   * Ticket #16: submit owns the merge lock. Coding is unlocked; the merge
   * phase is not. This function is the entire merge lifecycle for a ticket:
   *
   *   preflight (dirty / no commits / protected paths / App scope / mid-rebase)
   *   → acquire merge lock (park if held, wake on release)
   *   → rebase onto base tip (release + return rebase_conflict on conflict;
   *     on clean drift, report landed_ahead and keep the lock across same-turn
   *     semantic review + CI revalidation)
   *   → run gates while holding the lock ("test what will merge, then
   *     merge exactly that"): the tests this turn NAMED in the ticket's own
   *     worktree, then the thin land gate (land-gate.ts: incremental tsc +
   *     frozen-lockfile install) in the `_land` staging worktree at sha0
   *   → verify HEAD didn't drift during the gates
   *   → ff-merge under the git ops lock (same door as human `land`)
   *   → release the merge lock
   *
   * The merge lock is held across the whole rebase→review/revalidate→gate→ff
   * window on purpose: releasing between phases would let another submit ff
   * base to a new tip, invalidating the candidate we just rebased or tested.
   * The live turn token bounds this extended hold; turn end releases it.
   * Coding runs in parallel exactly because only this landing phase is serial.
   */
  async toolSubmit(
    token: string,
    tests: readonly string[] = [],
    openQuestion?: string,
    knowledge?: LandingKnowledge,
    retrievalFeedback: readonly TicketRetrievalFeedbackInput[] = [],
    delivery?: unknown,
  ): Promise<SubmitResult> {
    const ctx = this.turnTokens.get(token);
    if (!ctx) return { ok: false, code: "not_holder", message: "token 无效或轮次已结束。" };
    const active = this.submitOps.get(token);
    if (active) {
      const elapsedSeconds = Math.max(1, Math.round((Date.now() - active.startedAt) / 1_000));
      return {
        ok: false,
        code: "submit_in_progress",
        message:
          `本轮已有 devpipe_submit 在执行(${elapsedSeconds}s),原调用即使在 MCP 客户端超时也没有取消。`
          + "禁止重复 submit；用 devpipe_status 查看进度与最终结果。",
      };
    }

    this.submitResults.delete(token);
    const startedAt = Date.now();
    const operation = this.runSubmit(token, tests, openQuestion, knowledge, retrievalFeedback, delivery);
    this.submitOps.set(token, { startedAt, operation });
    try {
      const result = await operation;
      this.submitResults.set(token, { completedAt: Date.now(), result });
      return result;
    } finally {
      // A selected waiter can still fail a cheap preflight before acquire().
      // Do not burn the whole lease after that definitive response; declining
      // its reservation lets the next FIFO waiter run immediately.
      if (this.mergeLock.reservedFor === ctx.ticketId && !this.mergeLock.isHolder(token)) {
        this.mergeLock.cancel(ctx.ticketId);
        this.store.devTickets.forgetMergeWaiter(ctx.ticketId);
      }
      this.submitOps.delete(token);
      this.releaseParkedLock(token);
    }
  }

  private async runSubmit(
    token: string,
    tests: readonly string[] = [],
    openQuestion?: string,
    knowledge?: LandingKnowledge,
    retrievalFeedback: readonly TicketRetrievalFeedbackInput[] = [],
    delivery?: unknown,
  ): Promise<SubmitResult> {
    const ctx = this.turnTokens.get(token);
    if (!ctx) return { ok: false, code: "not_holder", message: "token 无效或轮次已结束。" };
    const stored = this.store.devTickets.getDevTicket(ctx.ticketId);
    if (!stored?.worktree || !stored.branch) return { ok: false, code: "not_holder", message: "工单缺 worktree。" };
    const t = this.reconcileLane(stored);
    if (!t.worktree || !t.branch) return { ok: false, code: "not_holder", message: "工单缺 worktree。" };
    if (t.dev_status === "cancelled") {
      return { ok: false, code: "cancelled", message: "工单已被取消,合入取消(已 commit 的工作保留在分支上)。" };
    }

    const imported = await this.refreshDevelopmentCandidate(token, true, true);
    if (imported) return imported;
    const wt = t.worktree;
    // Resolved ONCE, and used for both halves of the app-ticket trade: the path
    // allowlist below and the gate that runs after it. Reading it twice would
    // make it possible for a wide gate to authorise a narrow diff, or worse.
    const scope = scopeOfTicket(t);
    if (t.kind === "app" && !scope) {
      return {
        ok: false,
        code: "app_scope",
        message:
          `本票标着 App 工单,但 app id ${t.app_id ? `\`${t.app_id}\`` : "为空"} 在本仓库的 APP_TICKET_SCOPES 里不存在,`
          + `没有路径域也就没有可执行的门,拒绝合入。请让用户把工单类型改成普通工单(或先加一张普通工单把这个 App 登记进 devpipe/app-scopes.ts)。`,
      };
    }

    // Preflight: cheap, LOCK-FREE checks. Anything that would obviously
    // reject at the merge step is caught here so we do not queue an agent
    // just to tell them their tree is dirty.
    if (await this.inRebase(wt)) {
      return { ok: false, code: "mid_rebase", message: "worktree 还停在 rebase 中——先 --continue 到底或 --abort,再 submit。" };
    }
    const dirty = await git(wt, ["status", "--porcelain"]);
    const dirtyLines = dirty.stdout.split("\n").filter((l) => l.trim() && !l.endsWith(MCP_CONFIG_FILE));
    if (dirty.ok && dirtyLines.length) {
      return { ok: false, code: "dirty", message: `有未提交改动,先 commit 再 submit:\n${dirtyLines.join("\n").slice(0, 1_000)}` };
    }
    const ahead = await git(wt, ["rev-list", "--count", `${this.baseBranch}..HEAD`]);
    if (ahead.ok && ahead.stdout === "0") {
      return { ok: false, code: "no_commits", message: `分支上没有 ${this.baseBranch} 之外的新提交,没有可落地的内容。` };
    }
    // `--no-renames` is load-bearing for path enforcement and observability.
    // Rename
    // detection is on by default (git ≥ 2.9) and `--name-only` then prints
    // only the DESTINATION of a rename — so `git mv` of a guarded file to an
    // unguarded name would show one unguarded path and the source would be
    // invisible. Splitting renames into delete + add keeps protected/App paths
    // enforceable and trust-sensitive changes visible in the landing note.
    let changed: string[];
    try {
      changed = (await gitOrThrow(wt, ["diff", "--name-only", "--no-renames", `${this.baseBranch}...HEAD`]))
        .split("\n")
        .filter(Boolean);
    } catch (err) {
      return { ok: false, code: "merge_failed", message: `路径检查失败: ${msg(err)}` };
    }
    try {
      await verifyNewHumanEvidence({ repoDir: wt, from: this.baseBranch, to: "HEAD", files: changed, store: this.store, owner: t.requester });
    } catch (error) {
      return { ok: false, code: "knowledge_context", message: msg(error) };
    }
    const hit = changed.filter((f) => PROTECTED_PATHS.some((p) => f.startsWith(p)));
    if (hit.length) {
      return {
        ok: false,
        code: "protected_paths",
        files: hit,
        message: `改动了保护路径,拒绝合入:${hit.join(", ")}。把这些文件的改动撤掉(需要时把补丁写进 doc/ 留人工贴入),再 submit。`,
      };
    }

    // This is an annotation, not a gate. Keep the hit list through the landing
    // so the ticket can show a concise trust-boundary note after the diff has
    // actually joined mainline. Failed App-scope submissions get no such note.
    const tcbHit = tcbPathHits(changed);

    // App path-domain gate: cheap and lock-free, before any CPU is burned. It
    // names the only paths an App ticket may touch. There is no marker,
    // approval or retry that opens this gate: its narrow scope is what makes
    // App-ticket iteration safe enough to stay fast.
    if (scope) {
      const outside = appScopeViolations(changed, scope);
      if (outside.length) {
        return {
          ok: false,
          code: "app_scope",
          files: outside,
          message:
            `本票是 **App 工单**(${scope.title} / ${scope.appId}),diff 触碰了它的路径域之外的文件,拒绝合入:\n` +
            `${outside.slice(0, 40).join(", ")}${outside.length > 40 ? ` …(共 ${outside.length} 个)` : ""}\n\n` +
            `App 工单只允许改动:${scope.paths.join("、")}\n` +
            `这不是测试失败,也**没有任何标记或审批可以放行**——窄路径域本身就是 App 工单的安全边界。\n` +
            `两条路:\n` +
            `① 越界的部分本来就不该在这张票里 —— 撤掉它们(\`git rm\`/\`git checkout\`/新 commit 回退),再 submit;\n` +
            `② 这件事本来就是平台改动 —— 在回复里说清楚,请用户**另开一张普通工单**(simple/complex)来做;` +
            `本票可以只保留 App 局部的那部分,或者由用户取消。`,
        };
      }
    }

    // The requester chose no technical lane. The agent now has the final diff
    // and declares one; the pipeline independently proves every narrow claim.
    // A missing claim is accepted only as a compatibility fallback for agents
    // started before #424 (ordinary → full deploy, legacy App kind → its old
    // single-App scope). New MCP clients make the field required.
    const deliveryResolution = resolveDelivery(t, changed, delivery);
    if (!deliveryResolution.ok) {
      return {
        ok: false,
        code: "delivery_scope",
        ...(deliveryResolution.files ? { files: deliveryResolution.files } : {}),
        message:
          `${deliveryResolution.message}\n`
          + "这不是由提单人选择的工单类型，也没有审批绕过；按最终 diff 改正 delivery 声明，或把越界代码改走 full_deploy。",
      };
    }
    const currentDeliveryPlan = deliveryResolution.plan;
    // A ticket is a continuing conversation and can land more than once. A
    // later narrow diff must never erase production debt from an earlier,
    // still-unsettled landing on the same row. Carry full deploy monotonically;
    // carry App-only sets as a union until their pending releases settle.
    const priorDeliveryOutstanding = ["pending", "deploying", "live_unverified"].includes(t.deploy_status ?? "");
    let deliveryPlan = currentDeliveryPlan;
    if (priorDeliveryOutstanding && ticketNeedsTrustedDeploy(t)) {
      deliveryPlan = { ...currentDeliveryPlan, mode: "full_deploy", apps: [] };
    } else if (priorDeliveryOutstanding && currentDeliveryPlan.mode !== "full_deploy") {
      const carriedIds = new Set([
        ...ticketDeliveryApps(t),
        ...this.store.appCatalog.listPendingAppReleases()
          .filter((row) => row.ticket_id === t.id)
          .map((row) => row.app_id),
        ...currentDeliveryPlan.apps.map((app) => app.appId),
      ]);
      deliveryPlan = {
        ...currentDeliveryPlan,
        mode: carriedIds.size ? "app_releases" : currentDeliveryPlan.mode,
        apps: APP_TICKET_SCOPES.filter((app) => carriedIds.has(app.appId))
          .sort((left, right) => left.appId.localeCompare(right.appId)),
      };
    }
    const submitTests = [...new Set(
      [...tests, ...currentDeliveryPlan.tests].map((test) => test.trim()).filter(Boolean),
    )];

    // Source coverage is guidance returned with the result, never a refusal.
    const coverage = sourceCoverage(this.store,t.id,knowledge?.specifications ?? []);
    let relevantKnowledge: KnowledgeSearchHit[] = [];
    let requiredTests: string[] = [];
    let submitTraceId: RetrievalTraceId | null = null;
    if (this.knowledgeCaptureEnabled) {
      if (!knowledge) {
        return {
          ok: false,
          code: "knowledge_required",
          message:
            "落地必须携带 knowledge：summary、requirements、decisions、non_goals、risks、verification、context_keys、supersedes。"
            + "这不是事后文档；它与精确 landing range 一起写入不可变台账。",
        };
      }
      try {
        await verifyLandingSpecifications({ repoDir: wt, to: "HEAD", knowledge, store: this.store, owner: t.requester });
      } catch (error) { return { ok: false, code: "knowledge_context", message: msg(error) }; }
      const graphCheck = this.knowledgeGraph
        ? await this.knowledgeGraph.submitCheck(changed, {
            lane: "ticket",
            subject_ref: `ticket:${t.id}`,
            turn: ctx.turn,
          })
        : null;
      const graphAck = graphCheck?.acknowledgement ?? null;
      submitTraceId = graphCheck?.trace.envelope.trace_id ?? null;
      if (graphAck) {
        requiredTests = constraintEvidenceTests(graphAck.constraints);
      } else {
        try {
          await this.knowledgeIndex.refresh(this.baseBranch);
          relevantKnowledge = this.store.knowledge.search(
            [t.title, t.body, t.spec ?? "", ...changed].join("\n"),
            20,
          );
        } catch (err) {
          return {
            ok: false,
            code: "knowledge_index",
            message: `系统知识索引无法刷新,拒绝静默绕过后落地:${msg(err)}`,
          };
        }
        requiredTests = knowledgeTestFiles(relevantKnowledge);
      }
      const namedKeys = [...knowledge.context_keys, ...knowledge.supersedes, ...(knowledge.changes ?? []).map((change) => change.record_id)];
      const knownKeys = new Set(this.store.knowledge.getRecords(namedKeys).map((record) => record.record_key));
      const unknownKeys = namedKeys.filter((key) => !knownKeys.has(key) && !this.knowledgeGraph?.hasNode(key));
      if (unknownKeys.length) {
        return {
          ok: false,
          code: "knowledge_context",
          message: `knowledge 引用了不存在的记录:${unknownKeys.join(", ")}。刷新上下文后重新提交。`,
        };
      }
      const acknowledged = new Set(namedKeys);
      if (graphAck) {
        // A note, not a refusal (design §4.5 C), and only about the one thing
        // worth a reader's eye: a standing non-goal the submitted requirements
        // read like a contradiction of. The first version listed every touched
        // principle/constraint/non-goal by id — 130–160 per submit on #285/#288,
        // repeated on each retry — which no agent could act on.
        const digest = submitDigest(graphAck, {
          text: [knowledge.summary, ...knowledge.requirements, ...knowledge.decisions].join("\n"),
          acknowledged,
          ticket: t.id,
        });
        if (digest.nonGoals.length) {
          this.noteOnce(
            t.id,
            `ℹ 提交的需求/决策与 ${digest.nonGoals.length} 条现行非目标字面重叠，且未在 knowledge.context_keys/supersedes 中点名：\n`
              + digest.nonGoals.map((node) => formatStatement(node)).join("\n")
              + "\n落地未被阻断；若其中确有分歧，请在回复里说明，或在 supersedes 中点名被取代的记录。",
          );
        }
      } else {
        const missing = unacknowledgedKnowledge(relevantKnowledge, knowledge).map((hit) => hit.record_key);
        if (missing.length) {
          this.noteOnce(
            t.id,
            `ℹ 知识检索命中 ${missing.length} 条现行高置信记录未在 knowledge.context_keys/supersedes 中确认:`
              + missing.slice(0, 12).join(", ")
              + (missing.length > 12 ? ` …另 ${missing.length - 12} 条` : "")
              + "。落地未被阻断；若其中确有冲突,请在后续消息中指出来源与分歧。",
          );
        }
      }
    }

    // The review lane stops here (2026-08-20). Everything above is the same
    // verification a direct landing gets; what differs is what a verified
    // candidate BECOMES. `reconcileLane` resolved the requester's current
    // capabilities immediately before this submit, so both promotion and
    // revocation take effect on an existing ticket rather than only a new one.
    if (t.lane === "review") {
      return await this.runProposalSubmit(token, t, {
        changed,
        knowledge,
        tests: submitTests,
        openQuestion,
        delivery: deliveryPlan,
      });
    }

    // fires an unread pipeline message that will wake us for another try.
    // Queuing does NOT count against submitCounts — no gate ran.
    this.store.devTickets.rememberMergeWaiter(t.id);
    const lock = this.mergeLock.acquire(t.id, token);
    if (!lock.acquired) {
      const blocker = lock.blockedBy;
      const reason = lock.blockedByState === "holder"
        ? `正被工单 #${blocker} 占用(它正在跑门禁+合入)`
        : lock.blockedByState === "reservation"
          ? `已按 FIFO 预留给先等待的工单 #${blocker}`
          : `正在等待先排队的工单 #${blocker} 完成唤醒重试`;
      return {
        ok: false,
        code: "queued",
        holder: blocker,
        message:
          `合并锁${reason};你当前排第 ${lock.position}。把接下来的打算简要写进回复,然后结束本轮——` +
          `流水线会按等待顺序只唤醒一张票重试 submit,超时未拿锁才推进下一张。不要轮询、不要空转等待。`,
      };
    }
    this.store.devTickets.forgetMergeWaiter(t.id);
    if (lock.fresh) {
      log.info({ ticket: t.id }, "devpipe: merge lock acquired");
    }
    if (this.mainline && !this.integrationLeases.has(token)) {
      try {
        const claim = await this.mainline.acquire({ id: `ticket:${t.id}`, owner: t.requester, label: `Ticket #${t.id}` });
        if (!claim.acquired) {
          this.store.devTickets.rememberMergeWaiter(t.id);
          this.mergeLock.release(token);
          return { ok: false, code: "queued", message: `GitLab 合入锁排队第 ${claim.position}；工作区保持不变，轮到本票时会定向唤醒。` };
        }
        this.integrationLeases.set(token, new IntegrationLeaseKeeper(this.mainline, claim.lease));
        await this.synchronizeMainline();
      } catch (error) {
        this.releaseLock(token, "GitLab 合入协调不可用");
        return { ok: false, code: "merge_failed", message: msg(error) };
      }
    }

    // Attempt counter increments only once we've reached the phase that
    // burns real work (rebase + gates). A cheap preflight rejection or a
    // lock queue should not consume an attempt.
    const attempt = (this.submitCounts.get(token) ?? 0) + 1;
    this.submitCounts.set(token, attempt);
    if (attempt > this.maxSubmitsPerTurn) {
      this.releaseLock(token, "attempts exhausted");
      return {
        ok: false,
        code: "attempts_exhausted",
        message: `本轮 submit 次数已用完(${this.maxSubmitsPerTurn} 次)。把现状与失败原因写进回复结束本轮;用户回复后可以继续。`,
      };
    }

    return await this.trackToolOp(t.id, async (): Promise<SubmitResult> => {
      // Rebase onto the base tip. This is where our branch picks up
      // everyone else's landings — the merge lock guarantees no OTHER
      // submit lands during this + the gates + the ff.
      const remoteRefusal = await this.remoteBaseRefusal(t.id, wt);
      if (remoteRefusal) { this.releaseRepairLock(token, "远端开发基线已前移"); return remoteRefusal; }
      const rebased: RebaseOutcome = this.developmentWorkspaces?.binding(t.id)
        ? { kind: "clean", ff_commits: "", landed_ahead: [] } : await this.rebaseOntoBase(wt);

      if (rebased.kind === "read_error") {
        this.releaseLock(token, "rebase 读不到基线");
        return { ok: false, code: "merge_failed", message: `读不到 ${this.baseBranch} 基线(${rebased.err}),先 git status 自查再 submit。` };
      }
      if (rebased.kind === "conflict") {
        this.releaseRepairLock(token, "rebase 冲突,交由 agent 自解");
        this.note(
          t.id,
          `⚠ submit 时 rebase 到 ${this.baseBranch} 冲突,${this.repairLockMessage()},worktree 停在 rebase 进行中。冲突文件:${rebased.conflicts.join(", ") || "(见 git status)"}`,
        );
        return {
          ok: false,
          code: "rebase_conflict",
          conflict_files: rebased.conflicts,
          ff_commits: rebased.ff_commits,
          landed_ahead: rebased.landed_ahead,
          message:
            `submit 阶段 rebase 到 ${rebased.ff_commits ? "最新" : ""} ${this.baseBranch} 打到冲突,${this.repairLockMessage()},worktree 停在 rebase 进行中。你缺席期间合入的工单见 landed_ahead(标题+body 摘要)。\n\n` +
            `解决办法:读懂双方意图 → 编辑冲突文件消掉 <<<<<<< 标记 → \`git add <文件>\` → ` +
            `\`git -c core.editor=true rebase --continue\`(逐个 commit 继续到完),然后 devpipe_submit 重新走完整流程。` +
            `冲突过重时 \`git rebase --abort\` + \`git reset --hard ${this.baseBranch}\` 在新基线上重做。`,
        };
      }

      // A clean textual rebase is not a semantic review. If another ticket
      // landed since this branch forked, the candidate has changed after the
      // agent's compile/tests. Keep the merge lock while the same live turn
      // inspects those landed tickets, syncs this NEW HEAD to its CI workspace,
      // and reruns the relevant checks. The next submit is reentrant, so nobody
      // can advance base between this rebase and the reviewed ff. Turn cleanup
      // releases the lock if the agent abandons or loses the turn. This review
      // handoff is not a failed gate, so it consumes no bounded attempt.
      if (rebased.ff_commits.trim().length > 0) {
        this.submitCounts.set(token, Math.max(0, attempt - 1));
        return {
          ok: false,
          code: "base_changed_review",
          ff_commits: rebased.ff_commits,
          landed_ahead: rebased.landed_ahead,
          message:
            `你的提交已重放到最新 ${this.baseBranch},但期间有其它工单落地。本次没有合入;合并锁仍由本轮持有,其它工单不能再推进 ${this.baseBranch}。\n\n` +
            `逐项阅读 landed_ahead 的标题/body 摘要并检查与本票的共享模块、接口和行为;必要时修复并 commit。` +
            `然后调用 devpipe_ci_sync 把 rebase 后的精确 HEAD 送到隔离 CI 工作区,重新编译并跑相关小测试,最后再次 devpipe_submit。` +
            `下一次 submit 会用同一轮 token 重入这把锁并继续门禁与 ff。`,
        };
      }

      // Pin the exact commit the gates are about to verify (ticket #15).
      let sha0: string;
      try {
        sha0 = await gitOrThrow(wt, ["rev-parse", "HEAD"]);
      } catch (err) {
        this.releaseLock(token, "读不到 HEAD");
        return { ok: false, code: "merge_failed", message: `读不到当前提交: ${msg(err)}` };
      }

      // Post-submit model (2026-08-09): nothing runs here unless the agent
      // NAMED tests. The full suite moved to a background batch over the
      // watermark, because holding the merge lock for ~26 minutes made every
      // other agent's submit wait on this one, and because what actually keeps
      // a bad change off the site is the deploy's own build + health gate +
      // rollback ladder, none of which is a test.
      const steps = namedGateSteps(submitTests);
      const namedTests = submitTests;
      // Since 2026-08-21 the named tests are steps of the land gate below —
      // one install/build/tsc in `_land` (or on the CI machine) instead of a
      // second set in the ticket worktree. The ticket-worktree run is kept
      // only for an operator who switched the land gate off.
      const namedInGate = this.landGate.enabled;
      log.info(
        { ticket: t.id, attempt, sha: sha0.slice(0, 10), app: scope?.appId ?? null, tests: submitTests.length, delivery: deliveryPlan.mode, where: namedInGate ? "land-gate" : "worktree" },
        steps.length ? "devpipe: submit — running the tests this turn named" : "devpipe: submit — no tests named",
      );
      // When there is something to run it is deliberately OUTSIDE the git lock
      // and INSIDE the merge lock.
      const outcome = steps.length && !namedInGate
        ? await this.gateFn(wt, scope, steps)
        : { ok: true as const, log: "" };
      if (!outcome.ok) {
        this.releaseRepairLock(token, "点名的测试失败");
        return {
          ok: false,
          code: "gate_failed",
          gate_log_tail: outcome.log,
          ff_commits: rebased.ff_commits,
          landed_ahead: rebased.landed_ahead,
          message: `你点名的测试未通过(第 ${attempt}/${this.maxSubmitsPerTurn} 次),${this.repairLockMessage()}。修复、commit,然后再次 devpipe_submit。`,
        };
      }

      // The thin pre-land gate (land-gate.ts): incremental tsc + frozen-lockfile
      // install against `sha0` — the EXACT commit `ffBaseTo` lands below (pinned
      // above, drift-checked right after). It runs in the `_land` staging
      // worktree rather than the ticket's own tree so the gate's node_modules /
      // dist state is pipeline-owned and the incremental cache stays warm across
      // ALL landings (~30-60s; the ticket tree would pay a cold ~5 min start per
      // ticket). Same lock placement as the named gates: INSIDE the merge lock,
      // OUTSIDE the git-ops lock, so a slow check delays other landings only,
      // never coding turns; `withLandWorktree` additionally serialises `_land`
      // with the human lane. A human `land()` that ffs base mid-check still
      // surfaces as the existing `base_moved` refusal at the ff below.
      if (this.landGate.enabled) {
        // A CI repair candidate additionally has to prove the files CI named
        // are green in the tree it is about to land (ticket #219). The roster
        // is read here, under the merge lock, so a red routed into this ticket
        // mid-turn is included rather than raced past.
        const roster = decodeCiRoster(this.store.devTickets.getDevTicket(t.id)?.ci_roster);
        // The gate also reruns the spec files this landing's own diff touched
        // (`changed_tests`). `sha0` is already rebased onto the base tip, so
        // base..sha0 is exactly this ticket's contribution. A diff read
        // failure skips the step rather than refusing: it proves nothing red.
        let changedFiles: string[] | undefined;
        try {
          changedFiles = (
            await gitOrThrow(this.repoDir, ["diff", "--name-only", "--no-renames", `${this.baseBranch}...${sha0}`])
          ).split("\n").filter(Boolean);
        } catch (err) {
          log.warn({ ticket: t.id, err: msg(err) }, "devpipe: submit — could not read the landing diff for the gate");
        }
        const candidate: LandGateCandidate = {
          roster,
          ...(changedFiles ? { changedFiles } : {}),
          ...(requiredTests.length ? { requiredTests } : {}),
          ...(namedTests.length ? { namedTests, appScope: scope } : {}),
        };
        const g = await this.landGate.withLandWorktree(sha0, async (dir) => await this.landGate.check(dir, candidate));
        if (!g.ok && g.refusal === "named_tests") {
          // Same contract the ticket-worktree run had: the agent's own tests
          // were red, not the landing's thin gate.
          this.releaseRepairLock(token, "点名的测试失败");
          return {
            ok: false,
            code: "gate_failed",
            gate_log_tail: g.log,
            ff_commits: rebased.ff_commits,
            landed_ahead: rebased.landed_ahead,
            message: `你点名的测试未通过(第 ${attempt}/${this.maxSubmitsPerTurn} 次),${this.repairLockMessage()}。修复、commit,然后再次 devpipe_submit。`,
          };
        }
        if (!g.ok) {
          this.releaseRepairLock(
            token,
            g.refusal === "roster"
              ? "CI 失败清单仍未变绿"
              : g.refusal === "knowledge_tests"
                ? "知识约束的回归证据未通过"
                : g.refusal === "changed_tests"
                  ? "本次 diff 涉及的测试仍是红的"
                  : "落地门禁未通过",
          );
          return {
            ok: false,
            code: "land_gate_failed",
            gate_log_tail: g.log,
            ff_commits: rebased.ff_commits,
            landed_ahead: rebased.landed_ahead,
            message:
              landGateRefusalMessage(g.refusal, this.baseBranch) +
              `\n(第 ${attempt}/${this.maxSubmitsPerTurn} 次,${this.repairLockMessage()};在本票 worktree 修复并 commit 后再次 devpipe_submit`
              + (g.refusal === "roster" || g.refusal === "changed_tests" || g.refusal === "knowledge_tests"
                ? "——这一次先在本机把上面那几个文件跑绿。)"
                : ",不需要在本机自己跑 tsc。)"),
          };
        }
      }

      const headNow = await git(wt, ["rev-parse", "HEAD"]);
      if (headNow.ok && headNow.stdout !== sha0) {
        this.releaseLock(token, "门禁期间 HEAD 变动");
        return {
          ok: false,
          code: "gate_failed",
          gate_log_tail: outcome.log,
          ff_commits: rebased.ff_commits,
          landed_ahead: rebased.landed_ahead,
          message:
            `submit 认定要合入的是 ${sha0.slice(0, 10)},但 worktree 现在停在 ${headNow.stdout.slice(0, 10)}——` +
            `期间又有新提交。合并锁已释放。别在 submit 等待期间提交;现在再 submit 一次即可。`,
        };
      }

      let sha: string;
      // The tip the base branch sat on before this landing. Captured inside the
      // same lock as the ff so it names the exact range this ticket merged,
      // even when other tickets land immediately before and after (#192).
      let baseBefore = "";
      let landingPrepared = false;
      try {
        sha = await this.withGitLock(async () => {
          if (!this.mergeLock.isHolder(token)) throw new GhostLockError();
          if (this.isCancelled(t.id)) throw new CancelledError();
          baseBefore = await gitOrThrow(this.repoDir, ["rev-parse", this.baseBranch]);
          if (this.knowledgeCaptureEnabled) {
            this.store.knowledge.prepareLanding({
              ticket_id: t.id,
              from_sha: baseBefore,
              to_sha: sha0,
              base_before: baseBefore,
              tip_sha: sha0,
              source: "devpipe",
              changed_files: changed,
              changed_modules: [...new Set(changed.map((file) => moduleOf(file)))],
              acceptance: t.spec ? [t.spec.slice(0, 4_000)] : knowledge!.requirements,
              knowledge: { ...knowledge!, producer: { model: t.model, session_ref: t.session_id } },
            });
            landingPrepared = true;
          }
          const landedSha = await this.ffBaseTo(sha0, this.integrationLeases.get(token));
          if (landingPrepared) this.store.knowledge.completeLanding(t.id, sha0);
          return landedSha;
        });
      } catch (err) {
        // Every non-merge-happy exit here releases the lock so the next
        // submitter is not blocked by our failure.
        if (err instanceof GhostLockError) {
          return { ok: false, code: "not_holder", message: "轮次已被终止,合入取消(工作保留在分支上)。" };
        }
        if (err instanceof CancelledError) {
          this.releaseLock(token, "工单在门禁期间被取消");
          return { ok: false, code: "cancelled", message: "工单在门禁期间被取消,合入取消(工作保留在分支上)。" };
        }
        if (landingPrepared) {
          const onBase = await git(this.repoDir, ["merge-base", "--is-ancestor", sha0, this.baseBranch]);
          if (!onBase.ok) this.store.knowledge.abortLanding(t.id, sha0);
        }
        const m = msg(err);
        this.releaseLock(token, `ff 合入失败: ${m.slice(0, 80)}`);
        if (m.includes("merge --ff-only")) {
          return {
            ok: false,
            code: "base_moved",
            gate_log_tail: outcome.log,
            ff_commits: rebased.ff_commits,
            landed_ahead: rebased.landed_ahead,
            message: `门禁期间 ${this.baseBranch} 被推进(人工 land),测过的内容不再等于将合入的内容。合并锁已释放,直接再 devpipe_submit(会重新 rebase+gate+ff)。`,
          };
        }
        return { ok: false, code: "merge_failed", gate_log_tail: outcome.log, ff_commits: rebased.ff_commits, message: `ff 合入 ${this.baseBranch} 失败: ${m}` };
      }

      const owed = appsWithReleaseChanges(changed);
      this.store.devTickets.updateDevTicket(t.id, {
        dev_status: "landed",
        deploy_status: deliveryPlan.mode === "none" ? "not_needed" : "pending",
        delivery_mode: deliveryPlan.mode,
        delivery_apps: encodeDeliveryApps(deliveryPlan.apps.map((app) => app.appId)),
        commit_sha: sha,
        error: null,
        landed_at: new Date().toISOString(),
      });
      if (tcbHit.length) {
        this.note(
          t.id,
          `⚠ 本次合入触碰可信边界相关路径，已自动合入并交给 GitLab CI 后台验证。命中路径:${tcbHit.join(", ")}。完整导读:doc/tcb-reading-guide.md`,
        );
      }
      this.landedTurns.set(token, {
        sha,
        deliveryMode: deliveryPlan.mode,
        affectedAppCount: owed.length,
      });
      this.refreshKnowledgeArtifacts();
      this.releaseLock(token, "submit 落地");
      log.info({ ticket: t.id, sha }, "devpipe: submit landed");

      // Measured after the lock is released: it is a read-only diff over two
      // pinned shas, so no other landing can be delayed by it or change it.
      if (baseBefore && baseBefore !== sha) await this.recordLandDiff(t.id, baseBefore, sha);

      // The lock is already released, so this costs no other ticket anything:
      // build the landed sha now, in `_warm`, so the deploy this landing will
      // eventually be part of restores from the cache instead of rebuilding
      // while the requester watches. Failure is invisible by design — the
      // deploy then builds exactly the way it does today.
      if (deliveryPlan.mode !== "none") this.buildWarmer.schedule(sha);

      // Every affected release becomes durable debt. The deploy service drains
      // it automatically (owner decision #61) as soon as the running trusted
      // code can serve it: from a staged release that changes only App/View
      // inputs over the deployed commit, or after the next full deployment
      // passed its health gate. Trusted code itself still deploys explicitly.
      for (const candidate of owed) {
        this.store.appCatalog.recordPendingAppRelease({
          app_id: candidate.appId,
          commit_sha: sha,
          ticket_id: t.id,
          requested_by: `devpipe:ticket-${t.id}`,
          requested_at: new Date().toISOString(),
          reason: `工单 #${t.id} 合入了 ${candidate.title} 的 release 输入`,
        });
      }
      if (runnerBundleInputsChanged(changed)) {
        this.store.runnerArtifacts.recordPending({
          ticket_id: t.id,
          commit_sha: sha,
          requested_by: `devpipe:ticket-${t.id}`,
          requested_at: new Date().toISOString(),
        });
        this.note(
          t.id,
          "🐙 本次合入改变了 Runner 客户端 bundle，已记录为待激活；完整部署通过健康门后会从已部署 checkout 自动激活，失败时本票不会进入验收完成。",
        );
      }
      if (submitTraceId && knowledge) {
        this.knowledgeGraph?.markDelivered(submitTraceId, "mcp_response");
        this.knowledgeGraph?.recordReportedUse(submitTraceId, `ticket:${t.id}@${sha}`, knowledge.context_keys);
      }
      for (const feedback of retrievalFeedback.slice(0, 8)) {
        try {
          const trace = this.store.knowledgeRetrieval.getTrace(feedback.trace_id);
          if (!trace || trace.subject_ref !== `ticket:${t.id}`) continue;
          this.knowledgeGraph?.recordFeedback(feedback.trace_id, feedback.code, feedback.slot, feedback.expected_record_id);
        } catch (err) {
          log.warn({ ticket: t.id, traceId: feedback.trace_id, err: msg(err) }, "knowledge retrieval feedback ignored");
        }
      }



      // Ticket #201: a landing that still owes the requester a decision. Set
      // with the land rather than in a second call, because THIS is the moment
      // the board would otherwise start saying "done" — an agent that landed and
      // then forgot to ask has already published the wrong answer.
      const asked = typeof openQuestion === "string" ? openQuestion.trim().slice(0, OPEN_QUESTION_MAX) : "";
      if (asked) this.store.devTickets.updateDevTicket(t.id, { open_question: asked });

      return {
        ok: true,
        sha,
        knowledge_next_actions: coverage.knowledge_next_actions,
        gate_log_tail: outcome.log,
        ff_commits: rebased.ff_commits,
        landed_ahead: rebased.landed_ahead,
        ...(owed.length ? { app_release_owed: owed.map((s) => s.appId) } : {}),
        delivery: { mode: deliveryPlan.mode, apps: deliveryPlan.apps.map((app) => app.appId) },
        message:
          `✅ 已 ff 合入 ${this.baseBranch}(${sha.slice(0, 10)}),合并锁已释放;全量测试与失败修复在 GitLab CI 后台异步进行,本次合入没有自动上线。`
          + (asked
            ? `\n🙋 本票已记为**等你回复**(而不是已完成):${asked}`
            : "")
          + (tcbHit.length ? `\n⚠ 命中可信边界相关路径，已记录提示但不阻断合入:${tcbHit.join(", ")}。` : "")
          + (deliveryPlan.mode === "none"
            ? "\n📝 最终 diff 已核验为仅文档/测试证据，登记为**无需上线**；不会进入整机部署队列。"
            : owed.length
              ? `\n📦 本次合入改到了 ${owed.map((s) => s.title).join("、")} 的 release 输入:已记录为**待发布**,用户打开的仍是旧 release。`
                + (deliveryPlan.mode === "app_releases"
                  ? `系统已核验这是 App-only 影响集 [${deliveryPlan.apps.map((app) => app.appId).join(", ")}];当前部署的可信代码能运行它们时，发布包就绪后自动上线，否则随下一次完整部署上线。不需要调用发布工具。`
                  : `本票还包含需整机部署的可信代码;这些 App 随下一次完整部署(用户明确要求部署/上线时)通过健康门后自动发布。`)
              : deliveryPlan.mode === "full_deploy"
                ? "\n🚀 最终 diff 声明并登记为**整机部署**；当前只合入，尚未部署。"
                  + "\n🔒 `full_deploy` 只是交付分类，不是生产授权；执行部署前必须能指出本工单中用户明确要求改变生产的命令式原话。历史部署、上线状态描述和“上线后”措辞都不授权下一次部署。"
                : "")
          + `请在回复里总结:改了什么、为什么、上线后如何验收。`,
      };
    });
  }

  /**
   * The review lane's half of `devpipe_submit` (2026-08-20).
   *
   * Same preflight, same rebase, same named tests and the same thin land gate
   * as a direct landing — the candidate a maintainer reads has been verified
   * exactly as hard as one the pipeline would have fast-forwarded. What differs
   * is the last step: instead of `ffBaseTo` under the merge lock, the verified
   * sha is pushed to a pipeline-owned `contrib/<user>/ticket-<id>` branch, CI
   * is started on it, and a `merge_proposals` row records the candidate for
   * `ContribReviewService` to carry through CI → review → batch merge.
   *
   * No merge lock is taken: nothing here writes the base branch. The `_land`
   * worktree is still shared with landings and `withLandWorktree` serialises
   * that; a review-lane gate run can therefore delay a landing's gate but never
   * its fast-forward.
   */
  private async runProposalSubmit(
    token: string,
    t: DevTicketRow,
    ctx: {
      changed: string[];
      knowledge?: LandingKnowledge;
      tests: readonly string[];
      openQuestion?: string;
      delivery: DeliveryPlan;
    },
  ): Promise<SubmitResult> {
    const wt = t.worktree!;
    const attempt = (this.submitCounts.get(token) ?? 0) + 1;
    this.submitCounts.set(token, attempt);
    if (attempt > this.maxSubmitsPerTurn) {
      return {
        ok: false,
        code: "attempts_exhausted",
        message: `本轮 submit 次数已用完(${this.maxSubmitsPerTurn} 次)。把现状与失败原因写进回复结束本轮;用户回复后可以继续。`,
      };
    }
    return await this.trackToolOp(t.id, async (): Promise<SubmitResult> => {
      const remoteRefusal = await this.remoteBaseRefusal(t.id, wt);
      if (remoteRefusal) { this.releaseLock(token, "远端开发基线已前移"); return remoteRefusal; }
      const rebased: RebaseOutcome = this.developmentWorkspaces?.binding(t.id)
        ? { kind: "clean", ff_commits: "", landed_ahead: [] } : await this.rebaseOntoBase(wt);
      if (rebased.kind === "read_error") {
        return { ok: false, code: "merge_failed", message: `读不到 ${this.baseBranch} 基线(${rebased.err}),先 git status 自查再 submit。` };
      }
      if (rebased.kind === "conflict") {
        this.note(
          t.id,
          `⚠ submit 时 rebase 到 ${this.baseBranch} 冲突,worktree 停在 rebase 进行中。冲突文件:${rebased.conflicts.join(", ") || "(见 git status)"}`,
        );
        return {
          ok: false,
          code: "rebase_conflict",
          conflict_files: rebased.conflicts,
          ff_commits: rebased.ff_commits,
          landed_ahead: rebased.landed_ahead,
          message:
            `submit 阶段 rebase 到最新 ${this.baseBranch} 打到冲突,worktree 停在 rebase 进行中。你缺席期间合入的工单见 landed_ahead。\n\n` +
            `解决办法:读懂双方意图 → 编辑冲突文件消掉 <<<<<<< 标记 → \`git add <文件>\` → ` +
            `\`git -c core.editor=true rebase --continue\`,然后 devpipe_submit 重新走完整流程。` +
            `冲突过重时 \`git rebase --abort\` + \`git reset --hard ${this.baseBranch}\` 在新基线上重做。`,
        };
      }
      let sha0: string;
      let baseSha: string;
      try {
        sha0 = await gitOrThrow(wt, ["rev-parse", "HEAD"]);
        baseSha = await gitOrThrow(this.repoDir, ["rev-parse", this.baseBranch]);
      } catch (err) {
        return { ok: false, code: "merge_failed", message: `读不到当前提交: ${msg(err)}` };
      }
      const steps = namedGateSteps(ctx.tests);
      const outcome = steps.length
        ? await this.gateFn(wt, scopeOfTicket(t), steps)
        : { ok: true as const, log: "" };
      if (!outcome.ok) {
        return {
          ok: false,
          code: "gate_failed",
          gate_log_tail: outcome.log,
          ff_commits: rebased.ff_commits,
          landed_ahead: rebased.landed_ahead,
          message: `你点名的测试未通过(第 ${attempt}/${this.maxSubmitsPerTurn} 次)。修复、commit,然后再次 devpipe_submit。`,
        };
      }
      if (this.landGate.enabled) {
        let changedFiles: string[] | undefined;
        try {
          changedFiles = (
            await gitOrThrow(this.repoDir, ["diff", "--name-only", "--no-renames", `${this.baseBranch}...${sha0}`])
          ).split("\n").filter(Boolean);
        } catch (err) {
          log.warn({ ticket: t.id, err: msg(err) }, "devpipe: proposal — could not read the candidate diff for the gate");
        }
        const candidate: LandGateCandidate = { roster: [], ...(changedFiles ? { changedFiles } : {}) };
        const g = await this.landGate.withLandWorktree(sha0, async (dir) => await this.landGate.check(dir, candidate));
        if (!g.ok) {
          return {
            ok: false,
            code: "land_gate_failed",
            gate_log_tail: g.log,
            ff_commits: rebased.ff_commits,
            landed_ahead: rebased.landed_ahead,
            message:
              landGateRefusalMessage(g.refusal, this.baseBranch)
              + `\n(第 ${attempt}/${this.maxSubmitsPerTurn} 次;在本票 worktree 修复并 commit 后再次 devpipe_submit。)`,
          };
        }
      }
      const headNow = await git(wt, ["rev-parse", "HEAD"]);
      if (headNow.ok && headNow.stdout !== sha0) {
        return {
          ok: false,
          code: "gate_failed",
          gate_log_tail: outcome.log,
          ff_commits: rebased.ff_commits,
          landed_ahead: rebased.landed_ahead,
          message:
            `submit 认定要评审的是 ${sha0.slice(0, 10)},但 worktree 现在停在 ${headNow.stdout.slice(0, 10)}——` +
            `期间又有新提交。别在 submit 等待期间提交;现在再 submit 一次即可。`,
        };
      }
      if (this.isCancelled(t.id)) {
        return { ok: false, code: "cancelled", message: "工单在门禁期间被取消,本次不提交评审(工作保留在分支上)。" };
      }

      const branch = contribBranchName(t.requester, t.id);
      const summary = (ctx.knowledge?.summary ?? "").trim() || t.title;
      let published: ProposalPublishResult;
      try {
        published = await this.proposalPublisher.publish({
          ticketId: t.id,
          requester: t.requester,
          branch,
          sha: sha0,
          baseSha,
          title: t.title,
          summary,
        });
      } catch (err) {
        log.warn({ ticket: t.id, err: msg(err) }, "devpipe: proposal publish failed");
        return {
          ok: false,
          code: "merge_failed",
          gate_log_tail: outcome.log,
          message: `门禁已通过,但推送评审分支失败:${msg(err).slice(0, 300)}。稍后再次 devpipe_submit 重试(不消耗额外门禁)。`,
        };
      }
      const proposal = this.store.mergeProposals.create({
        ticket_id: t.id,
        requester: t.requester,
        branch,
        sha: sha0,
        base_sha: baseSha,
        summary,
        status: published.pipelineId ? "ci_pending" : "awaiting_review",
        pipeline_id: published.pipelineId,
        pipeline_url: published.pipelineUrl,
        detail: published.detail ?? null,
      });
      const asked = typeof ctx.openQuestion === "string" ? ctx.openQuestion.trim().slice(0, OPEN_QUESTION_MAX) : "";
      this.store.devTickets.updateDevTicket(t.id, { error: null, ...(asked ? { open_question: asked } : {}) });
      this.note(
        t.id,
        `📤 提案 #${proposal.id}:候选 ${sha0.slice(0, 10)}(基于 ${baseSha.slice(0, 10)})已推送到 \`${branch}\``
          + (published.pipelineUrl ? `,完整 CI 已触发:${published.pipelineUrl}` : ",未配置 CI,直接进入评审")
          + "。",
      );
      log.info({ ticket: t.id, proposal: proposal.id, sha: sha0, pipeline: published.pipelineId }, "devpipe: proposal published");
      const row = this.store.devTickets.getDevTicket(t.id) ?? t;
      this.notify({ kind: "proposed", ticket: row, proposal: { id: proposal.id, branch, sha: sha0 } });
      return {
        ok: true,
        sha: sha0,
        gate_log_tail: outcome.log,
        ff_commits: rebased.ff_commits,
        landed_ahead: rebased.landed_ahead,
        delivery: { mode: ctx.delivery.mode, apps: ctx.delivery.apps.map((app) => app.appId) },
        proposal: { id: proposal.id, branch, sha: sha0, status: proposal.status, pipeline_url: published.pipelineUrl },
        message:
          `📤 已提交评审:候选 ${sha0.slice(0, 10)} 推送到 \`${branch}\``
          + (published.pipelineUrl ? `,完整 CI 运行中(${published.pipelineUrl})。` : ",直接进入维护者评审。")
          + `本次**没有**合入 ${this.baseBranch}。CI 通过后会自动创建 MR 等待维护者审批;打回或 CI 失败会以消息形式回到本工单。`
          + (asked ? `\n🙋 本票已记为**等你回复**:${asked}` : "")
          + `\n请在回复里总结:改了什么、为什么、如何验证;只说「已提交评审」,不要说「已合入」。`,
      };
    });
  }

  /**
   * Did a batch merge actually carry a proposal into the base branch?
   *
   * Three readings, most exact first: the candidate sha is an ancestor of the
   * landed sha (merged as-is); every candidate commit matches by patch-id
   * (`git cherry`, i.e. cherry-picked without edits); or the files the
   * proposal touched are byte-identical between candidate and landing (the
   * merge agent squashed or reordered but changed nothing). Anything else is
   * reported as not applied with the evidence, so a maintainer can tell
   * "skipped" from "adapted" by reading the merge ticket.
   */
  async proposalApplied(
    proposal: { sha: string; base_sha: string },
    landedSha: string,
  ): Promise<{ applied: boolean; evidence: string }> {
    const ancestor = await git(this.repoDir, ["merge-base", "--is-ancestor", proposal.sha, landedSha]);
    if (ancestor.ok) {
      return { applied: true, evidence: `候选提交 ${proposal.sha.slice(0, 10)} 是 ${landedSha.slice(0, 10)} 的祖先` };
    }
    const cherry = await git(this.repoDir, ["cherry", landedSha, proposal.sha, proposal.base_sha]);
    if (!cherry.ok) return { applied: false, evidence: `无法比较候选与落地结果:${cherry.stderr.slice(-200)}` };
    const lines = cherry.stdout.split("\n").filter(Boolean);
    if (lines.length > 0 && lines.every((line) => line.startsWith("-"))) {
      return { applied: true, evidence: `全部 ${lines.length} 个候选提交按 patch-id 已在 ${landedSha.slice(0, 10)} 中` };
    }
    const files = await git(this.repoDir, ["diff", "--name-only", "--no-renames", `${proposal.base_sha}..${proposal.sha}`]);
    const paths = files.ok ? files.stdout.split("\n").filter(Boolean) : [];
    if (paths.length > 0) {
      const same = await git(this.repoDir, ["diff", "--quiet", proposal.sha, landedSha, "--", ...paths]);
      if (same.ok) {
        return { applied: true, evidence: `提案触及的 ${paths.length} 个文件在 ${landedSha.slice(0, 10)} 中与候选内容一致` };
      }
    }
    const missing = lines.filter((line) => line.startsWith("+")).length;
    return {
      applied: false,
      evidence: `${missing}/${lines.length} 个候选提交未按 patch-id 出现在落地结果中,且涉及文件内容与候选不一致`,
    };
  }

  /**
   * Ids of tickets whose agents are currently parked waiting for the merge
   * lock (ticket #16 T3). Public so the dashboard can annotate each row
   * with `parked_for_lock: true` — without this signal the panel misreads
   * "agent spoke, then ended its turn" as "agent is waiting for you to
   * reply", and shows a false 🙋 on a ticket that is really queued for
   * merge and will auto-wake as soon as the current lander is done.
   */
  lockWaiterIds(): number[] {
    return this.mergeLock.waiterIds();
  }

  /**
   * Ticket id currently holding the merge lock, or null if no submit is
   * mid-merge. Exposed for the dashboard's top-of-panel chip; kept as a
   * plain snapshot (no reactive stream) since the panel polls every 10s
   * and lock hold windows are minute-scale.
   */
  mergeLockHolder(): number | null {
    return this.mergeLock.holderId;
  }

  /** Exact local watermark tip used to keep the GitLab mirror from scheduling stale work. */
  async watermarkSha(): Promise<string> {
    return await gitOrThrow(this.repoDir, ["rev-parse", this.baseBranch]);
  }

  /** Git ancestry used to distinguish stale CI batches from failed fix verification. */
  async ciCommitRelation(failureSha: string, fixSha: string): Promise<CiCommitRelation> {
    if (failureSha === fixSha) return "same";
    const failureBeforeFix = await git(this.repoDir, ["merge-base", "--is-ancestor", failureSha, fixSha]);
    if (failureBeforeFix.ok) return "failure_before_fix";
    if (failureBeforeFix.code !== 1) {
      throw new Error(`无法比较 CI failure ${failureSha} 与修复 ${fixSha}: ${failureBeforeFix.stderr || failureBeforeFix.code}`);
    }
    const failureAfterFix = await git(this.repoDir, ["merge-base", "--is-ancestor", fixSha, failureSha]);
    if (failureAfterFix.ok) return "failure_after_fix";
    if (failureAfterFix.code !== 1) {
      throw new Error(`无法比较修复 ${fixSha} 与 CI failure ${failureSha}: ${failureAfterFix.stderr || failureAfterFix.code}`);
    }
    return "unrelated";
  }

  /**
   * Ticket #16 T5b: given a fork point (this ticket's last common commit
   * with base), find the dev tickets whose landing sha lies in
   * fork_point..base_tip. The result is fed back to the submitting agent
   * so "landed_ahead" is not just a list of hashes but of intents.
   */
  private async landedAheadOf(forkPoint: string): Promise<LandedAheadEntry[]> {
    const r = await git(this.repoDir, ["rev-list", `${forkPoint}..${this.baseBranch}`]);
    if (!r.ok || !r.stdout) return [];
    const shas = new Set(r.stdout.split("\n").filter(Boolean));
    if (shas.size === 0) return [];
    // Order the result by base position: closest to base HEAD first, so the
    // agent reads "the most recent lander" at the top.
    const orderedShas = r.stdout.split("\n").filter((s) => shas.has(s));
    const bySha = new Map<string, LandedAheadEntry>();
    // A single ticket may have one landing sha; scan all rows once.
    for (const t of this.store.devTickets.listDevTickets(500)) {
      if (t.commit_sha && shas.has(t.commit_sha)) {
        bySha.set(t.commit_sha, {
          id: t.id,
          sha: t.commit_sha,
          title: t.title,
          body_head: t.body.slice(0, 120),
        });
      }
    }
    const out: LandedAheadEntry[] = [];
    for (const sha of orderedShas) {
      const e = bySha.get(sha);
      if (e) out.push(e);
    }
    return out;
  }

  /**
   * `devpipe_context` (design §4.5 B): exact graph neighbourhood of paths the
   * agent has already located, plus an optional lexical question. Read-only;
   * the token only proves the caller is the live turn of one ticket.
   */
  async toolContext(
    token: string,
    paths: readonly string[],
    question?: string,
  ): Promise<{ ok: boolean; message: string; records?: number; trace_id?: RetrievalTraceId; sources?: SourcePage; knowledge_next_actions?: KnowledgeNextAction[] }> {
    const ctx = this.turnTokens.get(token);
    if (!ctx) return { ok: false, message: "token 无效或轮次已结束。" };
    const imported = await this.refreshDevelopmentCandidate(token, false);
    if (imported) return { ok: false, message: imported.message };
    if (!this.knowledgeGraph) {
      return { ok: false, message: "知识图谱尚未构建;按改动路径读取 .claude/rules 与最近的包级文档。" };
    }
    const clean = [...new Set(paths
      .map((item) => item.trim().replace(/^\.\//, "").replace(/^\/+/, ""))
      .filter((item) => item && !item.split("/").includes("..")))].slice(0, 40);
    if (!clean.length) return { ok: false, message: "paths 必须是仓库相对路径(文件或目录),不能为空。" };
    const result = await this.knowledgeGraph.pathContext(
      clean,
      question,
      { lane: "ticket", subject_ref: `ticket:${ctx.ticketId}`, turn: ctx.turn },
    );
    if (!result) return { ok: false, message: "知识图谱暂不可用。" };
    const traceId = result.trace.envelope.trace_id;
    this.knowledgeGraph.markDelivered(traceId, "mcp_response");
    const sources = ticketSourcePage(this.store,ctx.ticketId);
    return { ok: true, message: `${result.text}\n\n${ticketEvidenceIdentities(this.store, ctx.ticketId)}\n\n检索追踪：${traceId}`, records: result.included.length, trace_id: traceId, sources, knowledge_next_actions: sources.knowledge_next_actions };
  }

  async replayKnowledgeRepairs(): Promise<unknown> {
    if (!this.knowledgeGraph) throw new Error("知识图谱不可用");
    return this.knowledgeGraph.replayRepairs();
  }

  async toolSources(token: string,input: Record<string,unknown>): Promise<unknown> {
    const ctx = this.turnTokens.get(token);
    if (!ctx) return {ok:false,message:"token 无效或轮次已结束。"};
    try { return processTicketSources(this.store,ctx.ticketId,input); }
    catch (error) { return {ok:false,message:msg(error)}; }
  }

  async toolStatus(token: string): Promise<StatusResult | { message: string }> {
    const ctx = this.turnTokens.get(token);
    if (!ctx) return { message: "token 无效或轮次已结束。" };
    const t = this.store.devTickets.getDevTicket(ctx.ticketId);
    if (!t) return { message: "工单不存在。" };
    const yours = this.mergeLock.isHolder(token);
    const activeSubmit = this.submitOps.get(token);
    const completedSubmit = this.submitResults.get(token);
    let behind: number | undefined;
    let aheadN: number | undefined;
    let development: StatusResult["development"];
    const binding = this.store.devTickets.development.binding(t.id);
    if (binding) {
      // The Head candidate may be newer than this Runner worktree. Read only
      // the original bound source; status must never import, sync or rebase it.
      development = { state: "unavailable", device: binding.device, workspace_id: binding.worktreeWorkspaceId,
        message: "原 Runner 开发工作区暂不可读；没有使用 Head 候选目录替代。" };
      const service = this.developmentWorkspaces;
      if (service) {
        const [head, facts] = await Promise.allSettled([service.head(), service.facts(t.id)]);
        if (head.status === "fulfilled") development.current_head_sha = head.value;
        if (head.status === "fulfilled" && facts.status === "fulfilled" && facts.value.development) {
          const snapshot = facts.value.development;
          // Counts are meaningful only when both exact commits already exist
          // locally. A remote-only commit is unknown, never an invented zero.
          const counts = await git(this.repoDir, ["rev-list", "--left-right", "--count", `${head.value}...${snapshot.head_sha}`]);
          const match = counts.ok ? /^(\d+)\s+(\d+)$/.exec(counts.stdout.trim()) : null;
          if (match) { behind = Number(match[1]); aheadN = Number(match[2]); }
          const sync = snapshot.synced_head_sha !== head.value;
          const rebase = behind == null ? null : behind > 0;
          development = { ...development, state: "available", snapshot, sync_required: sync, rebase_required: rebase,
            message: `Runner HEAD ${snapshot.head_sha}；当前 Head ${head.value}`
              + (snapshot.conflicted ? "；原开发树有未完成的 Git 操作或冲突" : "")
              + (snapshot.dirty ? "；原开发树有未提交改动" : "")
              + (sync ? "；需要 devpipe_workspace_sync 同步权威水位" : "；已同步当前权威水位")
              + (rebase === true ? "；需要在原 Runner 工作区 rebase、解决冲突并复验"
                : rebase === null ? "；Head 尚无该 Runner 提交，提交差距和 rebase 需要未知，请在原开发树检查祖先关系" : "；Runner 提交已包含当前权威水位"),
          };
        } else {
          const error = head.status === "rejected" ? head.reason : facts.status === "rejected" ? facts.reason : "Runner 未返回开发工作区事实";
          development.message += ` ${msg(error)}`;
        }
      }
    } else if (t.worktree) {
      const b = await git(t.worktree, ["rev-list", "--count", `HEAD..${this.baseBranch}`]);
      const a = await git(t.worktree, ["rev-list", "--count", `${this.baseBranch}..HEAD`]);
      if (b.ok) behind = Number(b.stdout) || 0;
      if (a.ok) aheadN = Number(a.stdout) || 0;
    }
    const submit = activeSubmit
      ? {
          state: "running" as const,
          started_at: new Date(activeSubmit.startedAt).toISOString(),
        }
      : completedSubmit
        ? {
            state: "completed" as const,
            completed_at: new Date(completedSubmit.completedAt).toISOString(),
            ok: completedSubmit.result.ok,
            code: completedSubmit.result.code,
            message: completedSubmit.result.message,
          }
        : undefined;
    const submitMessage = activeSubmit
      ? ` · submit 执行中(${Math.max(1, Math.round((Date.now() - activeSubmit.startedAt) / 1_000))}s),禁止重复调用`
      : completedSubmit
        ? completedSubmit.result.ok
          ? " · 最近 submit 已成功"
          : ` · 最近 submit 失败(${completedSubmit.result.code ?? "unknown"}): ${completedSubmit.result.message}`
        : "";
    return {
      ticket: {
        id: t.id,
        dev_status: t.dev_status,
        deploy_status: t.deploy_status,
        lane: t.lane,
        branch: t.branch,
        commit_sha: t.commit_sha,
      },
      lock: { held_by: this.mergeLock.holderId, reserved_for: this.mergeLock.reservedFor, yours },
      base_branch: this.baseBranch,
      behind_base: behind,
      ahead_of_base: aheadN,
      ...(development ? { development } : {}),
      submits_left: Math.max(0, this.maxSubmitsPerTurn - (this.submitCounts.get(token) ?? 0)),
      submit,
      gate_log_tail: activeSubmit ? undefined : completedSubmit?.result.gate_log_tail,
      build_warm: buildWarmSummary(this.buildWarmer.status()),
      message:
        `工单 #${t.id} · ${t.dev_status}` +
        (this.mergeLock.holderId != null
          ? ` · 锁在 #${this.mergeLock.holderId}${yours ? "(你)" : ""}`
          : this.mergeLock.reservedFor != null
            ? ` · 锁已按 FIFO 预留给 #${this.mergeLock.reservedFor}`
            : " · 锁空闲") +
        (behind != null ? ` · 落后 ${this.baseBranch} ${behind} 个提交` : "") +
        (development ? ` · ${development.message}` : "") + submitMessage,
    };
  }

  /**
   * Name the ticket after the agent has read its request. Browser-created
   * tickets start with a timestamp placeholder, so every kind uses this tool.
   * Bounds mirror the MCP schema (2..60 chars).
   */
  async toolRename(token: string, title: string | undefined): Promise<{ message: string; ok: boolean }> {
    const ctx = this.turnTokens.get(token);
    if (!ctx) return { ok: false, message: "token 无效或轮次已结束。" };
    const t = this.store.devTickets.getDevTicket(ctx.ticketId);
    if (!t) return { ok: false, message: "工单不存在。" };
    const raw = typeof title === "string" ? title.trim() : "";
    if (raw.length < 2 || raw.length > 60) {
      return { ok: false, message: "标题长度必须在 2-60 字符之间。" };
    }
    // Strip low-information prefixes; the board already shows the ticket kind.
    const cleaned = raw.replace(/^(讨论|discuss|工单|ticket)\s*[：:]\s*/i, "").trim();
    const final = cleaned.length >= 2 ? cleaned : raw;
    this.store.devTickets.updateDevTicket(t.id, { title: final });
    this.note(t.id, `📝 工单已命名为「${final}」。`);
    return { ok: true, message: `已命名为「${final}」。` };
  }

  /**
   * Record that this turn is ending with something only the requester can decide.
   *
   * ── Why the agent has to say it ─────────────────────────────────────────────
   *
   * The board could not infer it. Every finished turn has `last_author = agent`,
   * and a landed ticket is a package waiting for a deploy button, so an agent
   * that shipped half the work and wrote "the other half needs your call" landed
   * in the same square as one that shipped all of it. The question then sat in a
   * transcript nobody had a reason to reopen, under a row that said done.
   *
   * ── Why it is not a status ──────────────────────────────────────────────────
   *
   * Because both things are true at once: the code really landed and really is
   * deployable, AND a person still owes an answer. Folding them into one field
   * would force a choice between showing the deploy state and showing the
   * question. So this is its own axis, and the panel renders both.
   *
   * Clearing is not the agent's to do beyond replacing its own text: the
   * question is answered when the REQUESTER speaks, and that is where it is
   * cleared. An agent that decides mid-turn it no longer needs an answer may
   * pass an empty string, which is a retraction, not an answer.
   */
  async toolAsk(token: string, question: string | undefined): Promise<{ message: string; ok: boolean }> {
    const ctx = this.turnTokens.get(token);
    if (!ctx) return { ok: false, message: "token 无效或轮次已结束。" };
    const t = this.store.devTickets.getDevTicket(ctx.ticketId);
    if (!t) return { ok: false, message: "工单不存在。" };
    const raw = typeof question === "string" ? question.trim() : "";
    if (!raw) {
      this.store.devTickets.updateDevTicket(t.id, { open_question: null });
      return { ok: true, message: "已撤回未决问题;这张工单不再显示为等你回复。" };
    }
    if (raw.length > OPEN_QUESTION_MAX) {
      return { ok: false, message: `未决问题最多 ${OPEN_QUESTION_MAX} 字符——写一句话,细节留在回复正文里。` };
    }
    this.store.devTickets.updateDevTicket(t.id, { open_question: raw });
    return {
      ok: true,
      message: "已记下这个未决问题:工单会显示为「等你回复」而不是已完成,用户回复后自动清除。",
    };
  }

  async toolConflictRead(token: string): Promise<{
    ok: boolean;
    message: string;
    subject_id?: string;
    requester?: string;
    annotations?: Array<{ id: number; actor: string; body: string; at: string }>;
  }> {
    const ctx = this.turnTokens.get(token);
    if (!ctx) return { ok: false, message: "token 无效或轮次已结束。" };
    const ticket = this.store.devTickets.getDevTicket(ctx.ticketId);
    if (!ticket) return { ok: false, message: "工单不存在。" };
    if (!ticket.knowledge_subject_id) {
      return { ok: false, message: "本工单没有绑定知识冲突，不能读取其它冲突的批注。" };
    }
    const annotations = this.store.knowledge.listAnnotations(ticket.knowledge_subject_id).map((row) => ({
      id: row.id,
      actor: row.actor,
      body: row.body,
      at: row.created_at,
    }));
    return {
      ok: true,
      subject_id: ticket.knowledge_subject_id,
      requester: ticket.requester,
      annotations,
      message: annotations.length
        ? `已读取冲突 ${ticket.knowledge_subject_id} 的 ${annotations.length} 条已保存批注。`
        : `冲突 ${ticket.knowledge_subject_id} 暂无已保存批注。`,
    };
  }

  async toolConflictResolve(
    token: string,
    note: string | undefined,
  ): Promise<{ ok: boolean; message: string; review?: { decision: string; actor: string; at: string } }> {
    const ctx = this.turnTokens.get(token);
    if (!ctx) return { ok: false, message: "token 无效或轮次已结束。" };
    const ticket = this.store.devTickets.getDevTicket(ctx.ticketId);
    if (!ticket) return { ok: false, message: "工单不存在。" };
    if (!ticket.knowledge_subject_id) {
      return { ok: false, message: "本工单没有绑定知识冲突，不能关闭其它冲突。" };
    }
    if (ticket.dev_status !== "landed" || !ticket.commit_sha) {
      return { ok: false, message: "知识修改尚未通过 devpipe_submit 合入，冲突保持打开。" };
    }
    const existing = [...this.store.knowledge.listReviews()]
      .reverse()
      .find((row) => row.subject_id === ticket.knowledge_subject_id);
    if (existing?.decision === "resolved") {
      return {
        ok: true,
        message: "冲突已经是已处理状态；没有重复写入。",
        review: { decision: existing.decision, actor: existing.actor, at: existing.created_at },
      };
    }
    const actor = `agent:ticket:${ticket.id}:requester:${ticket.requester}`.slice(0, 120);
    const row = this.store.knowledge.recordReview({
      subject_id: ticket.knowledge_subject_id,
      rule: "agent_resolution",
      decision: "resolved",
      note: String(note ?? "").trim().slice(0, 600),
      actor,
    });
    return {
      ok: true,
      message: `冲突 ${ticket.knowledge_subject_id} 已按落地工单 #${ticket.id} 标记为已处理。`,
      review: { decision: row.decision, actor: row.actor, at: row.created_at },
    };
  }

  /** `app.hot_replace`: all three inputs are assertions over the live ticket closure. */
  async toolAppHotswap(
    token: string,
    input: { app?: unknown; expected_commit?: unknown; source?: unknown } = {},
  ): Promise<AppHotswapToolResult> {
    const ctx = this.turnTokens.get(token);
    if (!ctx) return { ok: false, status: "refused", code: "invalid_token", message: "token 无效或轮次已结束。" };
    const ticket = this.store.devTickets.getDevTicket(ctx.ticketId);
    if (!ticket) return { ok: false, status: "refused", code: "unknown_ticket", message: "工单不存在。" };
    const allowedApps = ticketDeliveryApps(ticket);
    if (!allowedApps.length) {
      return {
        ok: false,
        status: "refused",
        code: "not_app_ticket",
        message: "devpipe_app_hotswap 只接受 submit 已核验为 app_releases 的工单（旧 App 工单继续兼容）。",
      };
    }
    const assertedApp = typeof input.app === "string" ? input.app.trim() : "";
    const scope = appScopeFor(assertedApp);
    if (!scope || !allowedApps.includes(assertedApp)) {
      return {
        ok: false,
        status: "refused",
        ...(allowedApps.length === 1 ? { app: allowedApps[0] } : {}),
        code: "app_assertion_failed",
        message: `App 断言不匹配:本票的精确 App 集是 [${allowedApps.join(", ")}]，收到 ${assertedApp || "(空)"}。`,
      };
    }
    if (input.source !== "landed_ticket") {
      return {
        ok: false,
        status: "refused",
        app: scope.appId,
        code: "source_assertion_failed",
        message: "source 只允许 landed_ticket；不接受路径、branch 或其它 checkout 选择权。",
      };
    }
    const expected = typeof input.expected_commit === "string" ? input.expected_commit.trim() : "";
    if (!/^[0-9a-f]{7,64}$/.test(expected) || !ticket.commit_sha?.startsWith(expected)) {
      return {
        ok: false,
        status: "refused",
        app: scope.appId,
        code: "commit_assertion_failed",
        message: `expected_commit 与本票已落地 commit 不匹配(收到 ${expected || "空"})。`,
      };
    }
    return await this.appReleases.requestHotswap(ticket, scope);
  }

  /**
   * Compatibility App release tool. It remains an application request, but no
   * agent call may activate: every exact candidate now shares the same pending
   * approval carrier as `devpipe_app_hotswap`.
   */
  async toolAppRelease(
    token: string,
    input: { app?: string } = {},
  ): Promise<{ ok: boolean; status?: string; message: string; app?: string; pending_ids?: string[] }> {
    const ctx = this.turnTokens.get(token);
    if (!ctx) return { ok: false, status: "refused", message: "token 无效或轮次已结束。" };
    const ticket = this.store.devTickets.getDevTicket(ctx.ticketId);
    if (!ticket) return { ok: false, status: "refused", message: "工单不存在。" };
    const named = typeof input.app === "string" ? input.app.trim() : "";
    let scopes: AppTicketScope[] = [];
    if (named) {
      const declared = ticketDeliveryApps(ticket);
      const ticketScope = appScopeFor(named);
      if (!ticketScope || !declared.includes(named)) {
        return {
          ok: false,
          status: "refused",
          message: `app 参数不是选择权:本票经 submit 核验的 App 集是 [${declared.join(", ") || "空"}]，不能请求 ${named}。`,
        };
      }
      scopes = [ticketScope];
    } else {
      const owed = this.store.appCatalog.listPendingAppReleases().filter((row) =>
        row.ticket_id === ticket.id && (!ticket.commit_sha || row.commit_sha === ticket.commit_sha));
      scopes = owed
        .map((row) => appScopeFor(row.app_id))
        .filter((scope): scope is AppTicketScope => Boolean(scope?.packScript));
      if (!scopes.length) {
        return {
          ok: false,
          status: "refused",
          message: "本工单没有待发布的 App release；工具不会代替本票选择其它工单或 App 的债务。",
        };
      }
    }

    const outcomes: AppHotswapToolResult[] = [];
    for (const scope of scopes) outcomes.push(await this.appReleases.requestHotswap(ticket, scope));
    const pendingIds = outcomes
      .filter((outcome): outcome is Extract<AppHotswapToolResult, { status: "approval_required" }> =>
        outcome.status === "approval_required")
      .map((outcome) => outcome.pending_id);
    return {
      ok: outcomes.every((outcome) => outcome.ok),
      status: pendingIds.length ? "approval_required" : outcomes[0]?.status,
      ...(scopes.length === 1 ? { app: scopes[0].appId } : {}),
      ...(pendingIds.length ? { pending_ids: pendingIds } : {}),
      message: outcomes.map((outcome) => outcome.message).join("\n")
        + (pendingIds.length ? "\n已返回 approval_required：agent 必须结束本轮，不得轮询、重试或自行批准。" : ""),
    };
  }

  /**
   * The four App-release entry points the rest of the process still calls on
   * the pipeline (`bootstrap-v3.ts` wires all four). Everything behind them
   * moved to `AppReleaseCoordinator` in #192; these stay as delegation so no
   * caller and no test had to change.
   */
  listAppHotswapApprovals(): AppHotswapApprovalView[] {
    return this.appReleases.listAppHotswapApprovals();
  }

  async decideAppHotswapApproval(
    id: string,
    decision: "approve" | "reject",
    actor: string,
  ): Promise<AppHotswapDecisionResult> {
    return await this.appReleases.decideAppHotswapApproval(id, decision, actor);
  }

  /** Owner decision #61: publish what the running trusted code can serve, unattended. */
  async autoPublishPendingAppReleases(): Promise<void> {
    await this.appReleases.autoPublishPendingAppReleases();
  }

  appReleaseDrainState(): AppReleaseDrainState {
    return this.appReleases.appReleaseDrainState();
  }

  async publishPendingAppReleases(actor: string): Promise<PendingAppReleaseDrain> {
    return await this.appReleases.publishPendingAppReleases(actor);
  }

  /** Drop the merge lock (idempotent per token); the coordinator wakes one FIFO waiter. */
  private releaseLock(token: string, why: string): void {
    const integration = this.integrationLeases.get(token);
    if (integration) {
      this.integrationLeases.delete(token);
      void integration.close().catch(error => log.warn({ err: msg(error) }, "integration release deferred to expiry"));
    }
    const from = this.mergeLock.holderId;
    if (from === null || !this.mergeLock.isHolder(token)) return;
    log.info({ ticket: from, why }, "devpipe: merge lock released");
    this.mergeLock.release(token);
  }

  private releaseRepairLock(token: string, why: string): void {
    if (!this.mainline) this.releaseLock(token, why);
    else log.info({ why }, "integration lease retained while the same turn repairs its candidate");
  }
  private repairLockMessage(): string {
    return this.mainline ? "本轮保留合入锁用于修复，轮次结束或租约失效后释放" : "合并锁已释放";
  }

  /** The service checkout is a fast-forward-only cache after cutover. */
  synchronizeMainline(reconcile = false): Promise<void> {
    if (!this.mainline) return Promise.resolve();
    if (this.mainlineSync) return this.mainlineSync;
    const operation = (async () => {
      const s = await this.mainline!.maintainQueue();
      const changed = await this.withGitLock(async () => {
        const local = await gitOrThrow(this.repoDir, ["rev-parse", this.baseBranch]);
        if (local === s.main) return false;
        // A publication in this process can overtake this observation while it
        // waits for the local Git lock. Never rewind the clean cache.
        if ((await git(this.repoDir, ["merge-base", "--is-ancestor", s.main, local])).ok) return false;
        await this.ffBranchTo(this.baseBranch, s.main); return true;
      });
      if (changed && reconcile) await this.reconcileCliDeliveryReports();
      const reservation = s.state.reservation;
      const wake = reservation ? `${reservation.id}:${reservation.expiresAt}` : "";
      if (wake && wake !== this.mainlineWake && /^ticket:[1-9][0-9]*$/.test(reservation!.id)) {
        this.wakeMergeLockWaiter(Number(reservation!.id.slice(7)));
      }
      this.mainlineWake = wake;
    })();
    this.mainlineSync = operation.finally(() => { this.mainlineSync = null; });
    return this.mainlineSync;
  }

  /**
   * One targeted, unread inbox message is the wake transport. Returning
   * `drop` removes tickets that cannot submit; throwing asks the coordinator
   * to rotate this waiter to the tail and try another one immediately.
   */
  private wakeMergeLockWaiter(ticketId: number): "delivered" | "drop" {
    const ticket = this.store.devTickets.getDevTicket(ticketId);
    if (!ticket || ticket.dev_status === "cancelled") {
      this.store.devTickets.forgetMergeWaiter(ticketId);
      return "drop";
    }
    this.store.devTickets.addTicketMessage(
      ticketId,
      "pipeline",
      "pipeline",
      "🔓 轮到你尝试合入了:FIFO 合并锁已为本票短暂预留,现在立即 devpipe_submit;超时后会让下一张票先走。",
    );
    this.kick();
    return "delivered";
  }

  private async trackToolOp<T>(ticketId: number, fn: () => Promise<T>): Promise<T> {
    this.toolOps.set(ticketId, (this.toolOps.get(ticketId) ?? 0) + 1);
    try {
      return await fn();
    } finally {
      const n = (this.toolOps.get(ticketId) ?? 1) - 1;
      if (n <= 0) this.toolOps.delete(ticketId);
      else this.toolOps.set(ticketId, n);
    }
  }

  // ── merge plumbing (shared by submit and the human lane) ──

  /**
   * Fast-forward the base branch onto `ref` through its dedicated worktree,
   * returning the new base sha. The path is branch-scoped: v2 historically
   * left `worktrees/_base` checked out on `staging`, and reusing that directory
   * for v3 would merge into the wrong checked-out branch. **The caller must
   * hold the git lock** — this is the one write to the shared base branch.
   */
  private async ffBaseTo(ref: string, integration?: IntegrationLeaseKeeper): Promise<string> {
    if (this.mainline) {
      if (!integration) throw new Error("GitLab mainline requires the current integration lease");
      const current = await gitOrThrow(this.repoDir, ["rev-parse", this.baseBranch]);
      await this.ffBranchTo(this.baseBranch, current); // refuse a dirty holder before publication
      const sha = await integration.publish(ref);
      try { await this.ffBranchTo(this.baseBranch, sha); }
      catch (error) { log.error({ sha, err: msg(error) }, "GitLab landing succeeded; local cache requires reconciliation"); }
      return sha;
    }
    return await this.ffBranchTo(this.baseBranch, ref);
  }

  /**
   * Fast-forward any branch through the clean worktree that holds it.
   *
   * The primary reference tree is allowed to hold the deployable watermark;
   * that makes the directory people open show the same local HEAD development
   * actually uses. Watermarks without a holder still get a branch-scoped
   * `_base-*` worktree. A dirty holder is a hard refusal: silently merging
   * around somebody's files would break the reference-tree contract.
   */
  async ffBranchTo(branch: string, ref: string): Promise<string> {
    const safe = branch.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "branch";
    const digest = createHash("sha256").update(branch).digest("hex").slice(0, 8);
    let baseDir = await worktreeHoldingBranch(this.repoDir, branch);
    if (!baseDir) {
      baseDir = path.join(this.worktreesDir, `_base-${safe.slice(0, 48)}-${digest}`);
      const add = await git(this.repoDir, ["worktree", "add", baseDir, branch]);
      if (!add.ok) {
        throw new Error(
          `无法为 ${branch} 建立或找到合并 worktree: ${add.stderr.slice(-300)}`,
        );
      }
    }
    const checkedOut = await gitOrThrow(baseDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (checkedOut !== branch) {
      throw new Error(`${baseDir} 登记为 ${branch} 的 holder,实际 checkout ${checkedOut}`);
    }
    const status = await gitOrThrow(baseDir, ["status", "--porcelain", "--untracked-files=normal"]);
    if (status !== "") {
      throw new Error(`拒绝推进 ${branch}:${baseDir} 不是干净的只读基线树`);
    }
    await gitOrThrow(baseDir, ["merge", "--ff-only", ref]);
    const head = await gitOrThrow(baseDir, ["rev-parse", "HEAD"]);
    this.backUpBranch(branch);
    return head;
  }

  /** Advance the tested rollback anchor from a provider-owned green result. */
  async recordCiGreen(stableBranch: string, sha: string): Promise<string> {
    return await this.withGitLock(async () => {
      let object = await git(this.repoDir, ["cat-file", "-e", `${sha}^{commit}`]);
      if (!object.ok && this.pushRemote) {
        await gitOrThrow(this.repoDir, ["fetch", this.pushRemote, sha]);
        object = await git(this.repoDir, ["cat-file", "-e", `${sha}^{commit}`]);
      }
      if (!object.ok) throw new Error(`CI green commit 不在本地对象库: ${sha}`);
      const covered = await git(this.repoDir, ["merge-base", "--is-ancestor", sha, this.baseBranch]);
      if (!covered.ok) throw new Error(`拒绝推进 ${stableBranch}: CI commit ${sha} 不在 ${this.baseBranch} 历史上`);
      const current = await git(this.repoDir, ["rev-parse", stableBranch]);
      if (current.ok && current.stdout === sha) return sha;
      if (current.ok) {
        const forward = await git(this.repoDir, ["merge-base", "--is-ancestor", current.stdout, sha]);
        if (!forward.ok) throw new Error(`拒绝倒退或改写 ${stableBranch}: ${current.stdout} -> ${sha}`);
      }
      return await this.ffBranchTo(stableBranch, sha);
    });
  }

  /**
   * Mirror a watermark to the remote, asynchronously and best-effort.
   *
   * ── Why this exists ────────────────────────────────────────────────────────
   *
   * On 2026-08-09 the remote had no `v4` at all: 84 commits — two days of work,
   * everything running in production — existed only in one `.git` on one
   * machine, because landing only ever fast-forwarded locally and nobody had
   * pushed by hand since the branch was renamed. That is a disk failure away
   * from total loss, and it is the kind of gap that only gets noticed by
   * somebody going looking.
   *
   * ── Why it does NOT block, and does not fail a landing ─────────────────────
   *
   * A backup is not a gate. Making the merge depend on the network would
   * reintroduce, in a new costume, exactly the thing this week removed: an
   * unrelated slow thing standing between a finished change and the base
   * branch. So the ff returns immediately and the push happens behind it.
   *
   * Pushes are chained rather than fired in parallel: two `git push` of the same
   * branch racing is a wasted round trip at best. Losing one to a process exit
   * costs nothing either — a branch push carries all of its history, so the next
   * landing's push covers whatever the last one missed.
   */
  private backUpBranch(branch: string): void {
    if (this.mainline && branch === this.baseBranch) return;
    if (!this.pushRemote) return;
    const remote = this.pushRemote;
    this.pushChain = this.pushChain
      .then(async () => {
        const r = await git(this.repoDir, ["push", remote, `${branch}:${branch}`], 30_000);
        if (r.ok) log.info({ remote, branch }, "watermark mirrored to the remote");
        // A failure is expected sometimes (no network, no key, a remote that
        // refuses) and is only ever a warning: the commit is already on the
        // branch, and the next push carries it.
        else log.warn({ remote, branch, err: r.stderr.slice(-300) }, "could not mirror the watermark — it is local only");
      })
      .catch(() => undefined);
  }

  // ── helpers ──

  /** True if the worktree is currently mid-rebase (either variant). */
  /**
   * Replay the ticket branch onto the base tip, under the git lock. Shared by
   * both submit lanes: a direct landing needs it so the ff is exact, a review
   * proposal needs it so the maintainer reads a candidate against today's base
   * rather than the base the contributor started from.
   */
  private async rebaseOntoBase(wt: string): Promise<RebaseOutcome> {
    return await this.withGitLock(async (): Promise<RebaseOutcome> => {
      const fp = await git(wt, ["merge-base", "HEAD", this.baseBranch]);
      const bh = await git(wt, ["rev-parse", this.baseBranch]);
      if (!fp.ok || !bh.ok) {
        return { kind: "read_error" as const, err: (fp.stderr || bh.stderr).slice(-200) };
      }
      if (fp.stdout === bh.stdout) return { kind: "clean" as const, ff_commits: "", landed_ahead: [] as LandedAheadEntry[] };
      const drift = await git(wt, ["log", "--oneline", `${fp.stdout}..${this.baseBranch}`]);
      const driftLog = drift.ok ? drift.stdout.slice(0, 2_000) : "(取不到提交列表)";
      const landed_ahead = await this.landedAheadOf(fp.stdout);
      let rb = await git(wt, ["rebase", this.baseBranch]);
      if (!rb.ok) {
        let conflicts = await this.listConflicts(wt);
        // A rebase can exit non-zero without any conflict entries under
        // subprocess pressure — GitLab CI runs the full suite at
        // `--maxWorkers=8` and fork/exec starvation surfaces here (pipeline
        // 49245: submit 2 in "base moved during the gate → base_moved,
        // lock released, next submit lands" returned ok=false via this
        // branch with an empty conflict list, though nothing in the test
        // creates a conflict). Distinguish: no conflicts = spurious.
        // Abort the half-applied rebase so the worktree is not left
        // mid-rebase, and try one more time before treating it as a real
        // conflict — a second failure with still no conflicts falls back
        // to `read_error`, which is the honest report ("git could not
        // finish for a non-conflict reason").
        if (conflicts.length === 0) {
          await git(wt, ["rebase", "--abort"]);
          rb = await git(wt, ["rebase", this.baseBranch]);
          if (rb.ok) return { kind: "clean" as const, ff_commits: driftLog, landed_ahead };
          conflicts = await this.listConflicts(wt);
          if (conflicts.length === 0) {
            await git(wt, ["rebase", "--abort"]);
            return { kind: "read_error" as const, err: `rebase 非冲突失败: ${rb.stderr.slice(-200)}` };
          }
        }
        return { kind: "conflict" as const, ff_commits: driftLog, landed_ahead, conflicts };
      }
      return { kind: "clean" as const, ff_commits: driftLog, landed_ahead };
    });
  }

  private async inRebase(wt: string): Promise<boolean> {
    const dir = await git(wt, ["rev-parse", "--git-dir"]);
    if (!dir.ok) return false;
    const gitDir = path.isAbsolute(dir.stdout) ? dir.stdout : path.join(wt, dir.stdout);
    for (const sub of ["rebase-merge", "rebase-apply"]) {
      try {
        await fs.stat(path.join(gitDir, sub));
        return true;
      } catch { /* not this variant */ }
    }
    return false;
  }

  /** Files with unresolved merge conflicts in the worktree. */
  private async listConflicts(wt: string): Promise<string[]> {
    const r = await git(wt, ["diff", "--name-only", "--diff-filter=U"]);
    if (!r.ok) return [];
    return r.stdout.split("\n").filter(Boolean);
  }


  /**
   * A pipeline-authored line in the ticket conversation. Stamped as delivered
   * so it is never fed back to the agent as user input — it is a note for the
   * humans reading the panel. (Wake messages deliberately do NOT use this.)
   */
  /** Fresh read — a ticket can be cancelled at any point during a turn. */
  private isCancelled(ticketId: number): boolean {
    return this.store.devTickets.getDevTicket(ticketId)?.dev_status === "cancelled";
  }

  /**
   * A provider can finish with a perfectly valid text reply after the agent
   * committed code but failed to complete devpipe_submit (for example when
   * the MCP client timed out). That is a failed development turn, not a green
   * conversation reply. Count only commits outside the current base; analysis
   * turns with no committed diff remain ordinary replies, and an explicit
   * open question still takes precedence over this diagnostic.
   */
  private async unmergedLandingError(
    ticket: DevTicketRow,
    cancelled: boolean,
    landed: boolean,
  ): Promise<string | undefined> {
    if (cancelled || landed) return undefined;
    const current = this.store.devTickets.getDevTicket(ticket.id);
    if (!current || current.open_question) return undefined;
    const development = this.developmentWorkspaces?.binding(ticket.id);
    try {
      let head: string | null = null;
      if (development && this.developmentWorkspaces) {
        const facts = await this.developmentWorkspaces.facts(ticket.id);
        head = facts.development?.head_sha ?? null;
        if (!head) return undefined;
      } else if (ticket.worktree) {
        const result = await git(ticket.worktree, ["rev-parse", "HEAD"]);
        if (!result.ok || !result.stdout) return undefined;
        head = result.stdout;
      }
      if (!head) return undefined;
      const ahead = await git(this.repoDir, ["rev-list", "--count", `${this.baseBranch}..${head}`]);
      if (!ahead.ok) return undefined;
      const count = Number.parseInt(ahead.stdout.trim(), 10);
      if (!Number.isFinite(count) || count <= 0) return undefined;
      return `❌ 本轮已结束但未合入 ${this.baseBranch}；票分支仍有 ${count} 个未合入提交。请回复“继续执行”，重新调用 devpipe_submit。`;
    } catch (error) {
      // An unavailable Runner cannot prove a pending commit. Keep that case
      // as the existing transport/unknown result instead of inventing failure.
      log.warn({ ticket: ticket.id, err: msg(error) }, "devpipe: could not verify unmerged ticket commits");
      return undefined;
    }
  }

  private queueManagedTicket(ticket: DevTicketRow): void {
    const previous = this.store.managedExecutions.active(ticket.requester, "ticket", String(ticket.id));
    const legacyWait = this.resourceRecovery.pending(`dev-ticket-launch/${ticket.id}`)[0];
    const row = previous ?? this.managedSupervisor.submit({ id: `ticket:${ticket.id}:${randomUUID()}`,
      owner: ticket.requester, source: "ticket", reference: String(ticket.id), desired: "running", resumeOwner: "head",
      observed: "preparing", dispatch: this.store.devTickets.runner.active(ticket.id)?.state === "dispatched" ? "sent" : "not_sent",
      ...(legacyWait ? { unavailableSince: legacyWait.first_seen_at, dependency: legacyWait.resource } : {}) });
    this.managedTicketJobs.set(ticket.id, row.id);
    // The common journal now owns this old durable wait; no independent timer remains.
    this.resourceRecovery.forget(`dev-ticket-launch/${ticket.id}`);
  }

  private attachManagedTickets(): void {
    this.detachManagedTickets = this.managedSupervisor.register("ticket", {
      maxConcurrent: this.specConcurrency, dependencyPolicy: this.resourceWait,
      authorized: row => {
        const ticket = this.store.devTickets.getDevTicket(Number(row.reference));
        // Actual provider/workspace grants are checked by TicketRunnerAccess for every call.
        // A paused dispatched turn still needs to query/stop its ORIGINAL operation.
        return Boolean(ticket && !ticket.native_binding && ticket.requester === row.owner && this.runnerTickets);
      },
      reconcile: async lease => {
        const id = Number(lease.row.reference);
        const ticket = this.store.devTickets.getDevTicket(id)!;
        this.managedTicketJobs.set(id, lease.row.id);
        this.managedTicketLeases.set(id, lease);
        this.running.add(id);
        let result: ExecutionStep = { kind: "unknown" };
        const work = this.runRunnerConversation(ticket, lease).then(step => { result = step; }).catch(error => {
          if (!lease.signal.aborted) throw error;
          result = { kind: "observe" }; // Shutdown preserves the domain operation and durable intent.
        }).finally(() => {
          this.managedTicketLeases.delete(id);
          this.running.delete(id);
          this.kick();
        });
        this.track(work);
        await work;
        return result;
      },
      changed: row => this.managedTicketChanged(row),
    });
  }

  private managedTicketChanged(row: ManagedExecutionRow): void {
    const id = Number(row.reference);
    if (this.store.devTickets.getDevTicket(id)?.requester !== row.owner) return;
    if (["preparing", "running", "reconnecting", "waiting_resource"].includes(row.observed) && row.desired === "running") return;
    if (this.managedTicketJobs.get(id) === row.id) this.managedTicketJobs.delete(id);
    if (row.observed === "unknown" || row.failure === "authorization_revoked") {
      const operation = this.store.devTickets.runner.active(id);
      if (operation) {
        this.store.devTickets.runner.messageDelivery(operation.messageIds ?? [], "unknown", row.detail);
        this.store.devTickets.runner.finish(operation, { error: row.detail ?? "恢复结果未知，未重发输入" });
      }
      this.store.devTickets.updateDevTicket(id, { chat_paused: 1 });
      this.turnFailed(id, row.detail ?? "恢复结果未知，未重发输入");
    }
    this.kick();
  }

  /** Public local projection; no capability RPC or private checkpoint. */
  ticketResourceWait(ticketId: number): ResourceSuspensionView | null {
    const ticket = this.store.devTickets.getDevTicket(ticketId);
    if (!ticket) return null;
    const row = this.store.managedExecutions.active(ticket.requester, "ticket", String(ticketId));
    if (!row?.dependency || !row.unavailableSince || !["reconnecting", "waiting_resource"].includes(row.observed)) return null;
    return { state: dependencyWait(Date.parse(row.unavailableSince), Date.now(), this.resourceWait).state, resource: row.dependency,
      since: row.unavailableSince, retry_at: row.nextRetryAt ?? null };
  }

  private clearRunnerWait(ticketId: number): void {
    this.resourceRecovery.forget(`dev-ticket-launch/${ticketId}`);
    const lease = this.managedTicketLeases.get(ticketId);
    if (lease) {
      lease.dependencyAvailable();
    } else if (!this.store.devTickets.runner.active(ticketId)) {
      const ticket = this.store.devTickets.getDevTicket(ticketId);
      const row = ticket && this.store.managedExecutions.active(ticket.requester, "ticket", String(ticketId));
      if (row) this.managedSupervisor.setDesired(row.owner, row.id, "cancelled");
    }
  }

  /**
   * A resource a ticket was told to wait for is back. One pipeline message
   * does both jobs: an idle ticket is woken by it (the uniform wake signal),
   * a running turn receives it as a priority interjection. Returns false —
   * keeping the waiter — only when the message could not be recorded.
   */
  private onResourceRecovered(waiter: ResourceWaiter): boolean {
    const ticketId = ticketScopeId(waiter.scope);
    if (ticketId === null) return false;
    const t = this.store.devTickets.getDevTicket(ticketId);
    // A ticket that already landed or was cancelled has nobody left to tell;
    // dropping the waiter is the right outcome, not a failure.
    if (!t || t.dev_status === "landed" || t.dev_status === "cancelled" || t.dev_status === "completed" || t.chat_paused) return true;
    const resource = waiter.resource.startsWith("runner:") ? waiter.resource.slice("runner:".length) : waiter.resource;
    try {
      this.postMessage(
        ticketId,
        "pipeline",
        "pipeline",
        `⚡ 资源已恢复:\`${resource}\` 重新在线(离线期间本票有 ${waiter.count} 次调用被拒)。` +
          "请从原会话和原工作区继续。已派发操作先查询原回执，不重放结果未知的输入。",
      );
      log.info({ ticket: ticketId, resource: waiter.resource, count: waiter.count }, "devpipe: resource recovered; ticket notified");
      return true;
    } catch (err) {
      log.warn({ err, ticket: ticketId, resource: waiter.resource }, "devpipe: could not post resource recovery");
      return false;
    }
  }

  private note(ticketId: number, body: string): void {
    try {
      this.store.devTickets.addTicketMessage(ticketId, "pipeline", "pipeline", body, this.turnSeq);
    } catch (err) {
      log.warn({ err, ticketId }, "could not record pipeline note");
    }
  }

  /**
   * A note the ticket thread gets once: a submit retried after
   * `base_changed_review`, a failed named test or a restart has nothing new
   * to say, and #288 collected the same knowledge note five times.
   */
  private noteOnce(ticketId: number, body: string): void {
    try {
      if (this.store.devTickets.listTicketMessages(ticketId).some((row) => row.via === "pipeline" && row.body === body)) return;
    } catch (err) {
      log.warn({ err, ticketId }, "could not read pipeline notes; recording anyway");
    }
    this.note(ticketId, body);
  }

  /**
   * Teach the repo to ignore the per-turn config file. Must be the SHARED
   * info/exclude: git reads a linked worktree's own $GIT_DIR/info/exclude
   * for nothing (verified — the file still shows as untracked), so a
   * per-worktree exclude would silently not work.
   */
  private async ensureRepoExclude(): Promise<void> {
    if (this.excludeEnsured) return;
    this.excludeEnsured = true;
    try {
      const common = await gitOrThrow(this.repoDir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
      const file = path.join(common, "info", "exclude");
      const current = await fs.readFile(file, "utf8").catch(() => "");
      const present = new Set(current.split("\n"));
      const missing = MCP_EXCLUDE_ENTRIES.filter((entry) => !present.has(entry));
      if (missing.length === 0) return;
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.appendFile(file, `${current && !current.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
    } catch (err) {
      log.warn({ err: msg(err) }, "could not add the devpipe config file to info/exclude");
    }
  }

  private async ensureWorktree(t: DevTicketRow): Promise<DevTicketRow | undefined> {
    try {
      return await this.requireWorktree(t);
    } catch (err) {
      this.turnFailed(t.id, msg(err));
      return undefined;
    }
  }

  private async requireWorktree(t: DevTicketRow): Promise<DevTicketRow> {
    if (t.worktree) return t;
    try {
      const { dir, branch } = await this.withGitLock(async () => {
        await this.ensureRepoExclude();
        return createTicketWorktree(this.repoDir, this.worktreesDir, t.id, t.title, this.baseBranch);
      });
      this.store.devTickets.updateDevTicket(t.id, { worktree: dir, branch });
      return this.store.devTickets.getDevTicket(t.id)!;
    } catch (err) {
      throw new Error(`worktree 创建失败: ${msg(err)}`);
    }
  }

  /** Serialize repo-level git commands across concurrent turns and landings. */
  private withGitLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.gitLock.then(fn, fn);
    this.gitLock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Run one CLI turn with the authoritative liveness marker set around it, and
   * the stall watcher told to hold fire while a devpipe tool op (a gate run
   * can take 10+ minutes of transcript silence) is in flight for this ticket.
   */
  private async runTurnTracked(
    ticketId: number,
    cwd: string,
    spec: DevTurnSpec,
    turn: number,
  ): Promise<DevTurnResult> {
    spec = await this.routeCodexTurn(ticketId, spec);
    this.store.devTickets.updateDevTicket(ticketId, { turn_started_at: new Date().toISOString() });

    type WaitingInterjection = {
      text: string;
      resolve: (accepted: boolean) => void;
    };
    const waiting = new Set<WaitingInterjection>();
    let providerDeliver: ((text: string) => boolean | Promise<boolean>) | null = null;
    let channelClosed = false;
    const closeChannel = (): void => {
      channelClosed = true;
      providerDeliver = null;
      for (const pending of waiting) pending.resolve(false);
      waiting.clear();
    };
    const deliver = (text: string): boolean | Promise<boolean> => {
      if (channelClosed) return false;
      if (providerDeliver) {
        try {
          return providerDeliver(text);
        } catch {
          return false;
        }
      }
      return new Promise<boolean>((resolve) => {
        waiting.add({ text, resolve });
      });
    };
    // The UI calls this a running turn from the same marker above. Publish a
    // deferred channel at the same time so a message typed while the provider
    // process is still starting is not prematurely assigned to another turn.
    this.liveTurns.set(ticketId, { turn, deliver });

    const limits: TurnLimits = {
      ...this.turnLimits,
      isExternallyBusy: () => (this.toolOps.get(ticketId) ?? 0) > 0,
      onInterject: (next) => {
        if (!next) {
          closeChannel();
          this.liveTurns.delete(ticketId);
          return;
        }
        providerDeliver = next;
        for (const pending of waiting) {
          try {
            Promise.resolve(next(pending.text)).then(
              pending.resolve,
              () => pending.resolve(false),
            );
          } catch {
            pending.resolve(false);
          }
        }
        waiting.clear();
      },
      // Unlike Claude, Codex and omp mint the id themselves. Their JSONL stdout
      // reports it near process start; persist it immediately so the trusted
      // ticket adapter can open the same live session module while the turn
      // runs.
      onSessionId: (sessionId) => {
        if (cliFamilyForModel(spec.model) !== "claude") {
          this.store.devTickets.updateDevTicket(ticketId, { session_id: sessionId });
        }
      },
      // Cancelling now actually stops the agent, instead of only flipping a
      // column while the CLI keeps working (ticket #15).
      // A graceful service restart does the same once the turn is outside a
      // devpipe tool operation. Its unread wake-up is queued by runTicketTurn.
      // A human pressing stop is the third abort reason, and unlike the other
      // two it is not conditional on a tool op: they asked to stop, including
      // mid-gate. What differs is only what happens afterwards — see
      // `runTicketTurn`, where this ticket stays open and resumable.
      shouldAbort: () =>
        this.isCancelled(ticketId)
        || this.interruptRequests.has(ticketId)
        || (this.stopped && (this.toolOps.get(ticketId) ?? 0) === 0),
    };
    let result: DevTurnResult | undefined;
    try {
      result = await this.runTurn(cwd, spec, limits);
      return result;
    } finally {
      closeChannel();
      this.liveTurns.delete(ticketId);
      // Let pending delivery receipts record the once-per-turn queued notice
      // while the authoritative running marker still identifies this turn.
      await Promise.resolve();
      const restartWake = this.stopped
        && !this.isCancelled(ticketId)
        && !this.interruptRequests.has(ticketId)
        && (result == null || result.aborted)
        ? RESTART_CONTINUE_PROMPT
        : undefined;
      // The wake-up and marker clear are one SQLite transaction. A second
      // crash at this boundary must not strand the established conversation.
      this.store.devTickets.finishDevTurn(ticketId, restartWake);
    }
  }

  /** Observe only this ticket's operation through its original owner/device Gate. */
  async readTicketExecution(ticket: DevTicketRow): Promise<TicketExecution | undefined> {
    if (ticket.native_binding) return this.nativeDevelopment().execution(ticket);
    if (!this.runnerTickets) return undefined;
    const repository = this.store.devTickets.runner;
    const current = this.store.devTickets.getDevTicket(ticket.id);
    if (!current) throw new Error("工单已不存在");
    const operation = repository.active(ticket.id) ?? (!current.turn_started_at ? repository.latest(ticket.id) : null);
    if (!operation) return undefined;
    const binding = repository.binding(ticket.id);
    if (!binding) throw new Error("工单运行状态缺少原始 Runner 绑定");
    let execution = ticketExecutionFromWire(
      await this.runnerTickets.call(binding, "get_session_operation", { operation_id: operation.id }), operation.id,
    );
    // The normal read still checks current grants. A missing device record cannot
    // erase a definite receipt already durably observed by this ticket.
    if (execution.state === "missing" && operation.receipt?.operation_id === operation.id
      && (operation.receipt.state === "succeeded" || operation.receipt.state === "failed")) {
      execution = ticketExecutionFromWire(operation.receipt, operation.id);
    }
    // An old completion cannot speak for a turn started while this read awaited.
    const latest = repository.latest(ticket.id);
    if (latest?.id !== operation.id
      || (latest.state === "finished" && this.store.devTickets.getDevTicket(ticket.id)?.turn_started_at)) {
      throw new Error("工单运行轮次已变化，请刷新状态");
    }
    return execution;
  }

  usesRunnerTickets(): boolean { return this.runnerTickets !== null; }
  ticketExecutionChoices(owner: string) { return this.runnerTickets?.choices(owner); }
  ticketQuotaHosts(requester: string) {
    return this.runnerTickets?.quotaHosts(requester);
  }

  /** Resolve a ticket's private Codex scan root without disclosing it in the ticket row projection. */
  codexHomeForTicket(ticket: DevTicketRow): string | null | undefined {
    if (cliFamilyForModel(ticket.model) !== "codex" || !ticket.codex_account_slot) return undefined;
    return this.codexAccountRouter?.homeForSlot(ticket.codex_account_slot) ?? null;
  }

  /** Browser-safe account marker; the private slot and CODEX_HOME stay server-side. */
  codexLabelForTicket(ticket: DevTicketRow): string | undefined {
    if (cliFamilyForModel(ticket.model) !== "codex" || !ticket.codex_account_slot) return undefined;
    return this.codexAccountRouter?.labelForSlot(ticket.codex_account_slot);
  }

  /**
   * Open a read-only transcript lease for a codex-runner ticket.
   *
   * The requester and device come only from the persisted ticket. In
   * particular, the dashboard caller cannot swap in its own username or an
   * arbitrary device, even though tickets are readable by other dev users.
   */
  /** Rich `read_session` of one ticket session through the ticket's own Runner binding. */
  private runnerTranscript(access: TicketRunnerAccess, binding: TicketRunnerBinding, sessionId: string): TranscriptRead {
    return (args) => access.call(binding, "read_session", {
      id: sessionId, source: binding.source, rich: true, _octopus_include_session_plus: true, ...args,
    });
  }

  /**
   * The reply to store for a Runner turn. A receipt keeps only the reply's
   * last 80,000 characters and marks that; the whole reply is read back from
   * the transcript so the ticket message and its slug come from all of it.
   */
  private async runnerReply(access: TicketRunnerAccess, binding: TicketRunnerBinding, sessionId: string | undefined,
    result: Record<string, unknown>, ticketId: number): Promise<string | undefined> {
    const text = typeof result.result_text === "string" ? result.result_text : undefined;
    if (!text || result.result_text_truncated !== true) return text;
    if (sessionId) {
      try {
        const whole = await recoverFullReply(this.runnerTranscript(access, binding, sessionId), text);
        if (whole !== null) return whole;
      } catch (error) {
        log.warn({ ticket: ticketId, err: msg(error) }, "devpipe: reading the whole reply from the transcript failed");
      }
    }
    return markedReceiptTail(text);
  }

  openRemoteTicketTranscript(ticket: DevTicketRow, purpose: string): RemoteTicketTranscriptLease | null {
    if (this.runnerTickets && ticket.session_id) {
      const held = this.store.devTickets.runner.binding(ticket.id);
      const legacy = this.runnerTickets.config.legacy_host;
      const family = cliFamilyForModel(ticket.model);
      if (family === "codex-runner" && !held) {
        // Old relay sessions retain their exact private namespace below.
      } else {
        const binding: TicketRunnerBinding | null = held ?? (legacy ? {
          owner: legacy.owner, device: legacy.device, workspaceId: "", source: family === "codex-runner" ? "codex" : family,
        } : null);
        if (!binding) return null;
        const read = this.runnerTranscript(this.runnerTickets, binding, ticket.session_id);
        return { device: binding.device, read: (input) => read({
          max_messages: input.maxMessages, ...(input.offset !== undefined ? { offset: input.offset } : {}),
        }), close: () => {} };
      }
    }
    if (cliFamilyForModel(ticket.model) !== "codex-runner" || !ticket.session_id || !this.remoteCodex) return null;
    const prefix = "runner:";
    const device = ticket.codex_account_slot?.startsWith(prefix)
      ? ticket.codex_account_slot.slice(prefix.length)
      : "";
    if (!device) return null;
    const remote = this.remoteCodex(ticket.requester, purpose, device);
    if (!remote || remote.device !== device) {
      remote?.close();
      return null;
    }
    return {
      device,
      read: (input) => remote.call("codex_agent_read_session", {
        id: ticket.session_id!,
        max_messages: input.maxMessages,
        ...(input.offset !== undefined ? { offset: input.offset } : {}),
      }),
      close: () => remote.close(),
    };
  }

  private async routeCodexTurn(ticketId: number, spec: DevTurnSpec): Promise<DevTurnSpec> {
    if (cliFamilyForModel(spec.model) !== "codex" || !this.codexAccountRouter) return spec;
    const ticket = this.store.devTickets.getDevTicket(ticketId);
    if (!ticket) throw new Error(`工单不存在: #${ticketId}`);
    if (ticket.codex_account_slot) {
      const codexHome = this.codexAccountRouter.homeForSlot(ticket.codex_account_slot);
      if (!codexHome) {
        throw new Error(`工单绑定的 Codex 账号槽已不在配置中: ${ticket.codex_account_slot}`);
      }
      return { ...spec, codexHome };
    }
    // A session created before slot routing must stay on the process's legacy
    // default CODEX_HOME. Binding it now would resume the id under another
    // account and either fail or, worse, collide with an unrelated transcript.
    if (spec.resumeSessionId) return spec;
    const selected = await this.codexAccountRouter.selectForNewSession();
    this.store.devTickets.updateDevTicket(ticketId, { codex_account_slot: selected.slot });
    log.info(
      {
        ticket: ticketId,
        codexSlot: selected.slot,
        remainingPercent: selected.remainingPercent,
        resetsAt: new Date(selected.resetsAt).toISOString(),
      },
      "devpipe: bound new Codex session to account slot",
    );
    return { ...spec, codexHome: selected.codexHome };
  }

  /**
   * Take the stop request for this ticket, if one is outstanding.
   *
   * Consumed rather than read: an unconsumed request would abort the retry (or
   * the fresh-session restart) that follows this turn in the same call, which
   * is a second stop nobody asked for.
   */
  private takeInterrupt(ticketId: number): string | undefined {
    const by = this.interruptRequests.get(ticketId);
    this.interruptRequests.delete(ticketId);
    return by;
  }

  /** Human-facing turn-failure text. */
  private turnError(r: DevTurnResult): string {
    if (r.error) return r.error;
    const rescue = "进度未丢:worktree 内的改动与会话都还在,在对话里回一句话即可重试";
    if (r.stalled) {
      const min = Math.round((this.turnLimits.stallMs ?? DEV_STALL_TIMEOUT_MS) / 60_000);
      return `轮次挂死(transcript ${min} 分钟无新输出),已终止进程。${rescue}`;
    }
    if (r.timed_out) {
      return `轮次超出配置的总时长上限,已终止进程。${rescue}`;
    }
    return `exit ${r.exit_code}${r.stderr_tail ? " · " + r.stderr_tail.slice(-300) : ""}`;
  }

  private async forkNote(t: DevTicketRow): Promise<string | undefined> {
    if (t.parent_ticket_id == null) return undefined;
    const parent = this.store.devTickets.getDevTicket(t.parent_ticket_id);
    let drift = "";
    if (parent?.commit_sha) {
      const r = await git(this.repoDir, ["log", "--oneline", `${parent.commit_sha}..${this.baseBranch}`]);
      if (r.ok && r.stdout) drift = `\n期间合入 ${this.baseBranch} 的变更:\n${r.stdout.slice(0, 2_000)}`;
    }
    return `这是工单 #${t.parent_ticket_id} 的后续工单(你带着父工单会话的完整上下文)。距上次会话代码已有变化,先审视变化再处理新意图。${drift}`;
  }

  /**
   * Landing precedes the provider's final answer. A turn that lands and then
   * ends without an agent reply (exit, interrupt, lost last event) still leaves
   * one durable record of what landed; a real reply for the turn always wins,
   * so this can never duplicate it.
   */
  private recordLandingWithoutReply(ticketId: number, turn: number, landing: LandedTurnReceipt): void {
    if (this.store.devTickets.listTicketMessagesForTurn(ticketId, turn).some((message) => message.author === "agent")) return;
    this.store.devTickets.addTicketMessage(
      ticketId,
      "pipeline",
      "pipeline",
      `🧾 系统合成落地记录\n\n`
        + `- 落地 SHA: \`${landing.sha}\`\n`
        + `- 交付分类: \`${landing.deliveryMode}\`\n`
        + `- 受影响 App 数: ${landing.affectedAppCount}\n\n`
        + "该轮 agent 在落地后未追加收尾消息，本记录由流水线系统合成。",
      turn,
    );
  }

  /**
   * An infrastructure failure (turn crash, spawn error). NOT a status: the
   * ticket stays open, the reason lands in `error` (the panel's red box) and
   * as a conversation note; one message from the user retries.
   */
  private turnFailed(ticketId: number, reason: string): void {
    log.warn({ ticketId, reason }, "dev ticket turn failed");
    this.store.devTickets.updateDevTicket(ticketId, { error: reason });
    this.note(ticketId, `❌ ${reason}`);
    const t = this.store.devTickets.getDevTicket(ticketId);
    if (t) this.notify({ kind: "turn_failed", ticket: t, reason });
  }

  private notify(ev: DevPipeEvent): void {
    try {
      this.notifyFn(ev);
    } catch (err) {
      log.warn({ err }, "dev pipeline notify hook failed");
    }
  }
}

/** Parse one batched `git log --name-only` into immutable report origins. */
export function cliReportIntroductionMap(output: string): Map<string, string> {
  const introduced = new Map<string, string>();
  let commit: string | null = null;
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    const header = /^commit:([0-9a-f]{40})$/u.exec(line);
    if (header) {
      commit = header[1] ?? null;
      continue;
    }
    if (commit && isCliReportPath(line) && !introduced.has(line)) introduced.set(line, commit);
  }
  return introduced;
}

/** Parse one batched `git grep -n` into report schema versions. */
export function cliReportVersionMap(output: string): Map<string, 1 | 2 | 3> {
  const versions = new Map<string, 1 | 2 | 3>();
  for (const line of output.split("\n")) {
    const start = line.indexOf(`${CLI_REPORT_DIR}/`);
    if (start < 0) continue;
    const match = /^(doc\/cli-reports\/[^:]+\.json):\d+:.*"version"\s*:\s*([123])(?!\d)/u.exec(line.slice(start));
    if (match?.[1] && match[2]) versions.set(match[1], Number(match[2]) as 1 | 2 | 3);
  }
  return versions;
}

/** Candidate selection only; the immutable report and receipt are validated later. */
export function cliReceiptRecoveryReports(output: string, inbox: ReadonlySet<string>): Set<string> {
  const reports = new Set<string>();
  for (const line of output.split("\n")) {
    const start = line.indexOf(`${CLI_REPORT_DIR}/`);
    if (start < 0) continue;
    const match = /^(doc\/cli-reports\/[^:]+\.json):\d+:(kr_[0-9a-f]{32})$/u.exec(line.slice(start));
    if (match?.[1] && match[2] && isCliReportPath(match[1]) && inbox.has(match[2])) reports.add(match[1]);
  }
  return reports;
}

/**
 * Per-turn MCP config, written inside the ticket's own worktree. Excluded
 * repo-wide (see ensureRepoExclude) so `git add -A` can never commit a live
 * loopback token, and filtered from the submit dirty-check as a backstop.
 */
export { MCP_CONFIG_FILE } from "./mcp-config.js";
/** omp discovers its project MCP servers here; same credential, same lifetime. */
export const OMP_MCP_CONFIG_DIR = ".omp";

/** Where omp looks for a project's MCP servers, inside one ticket's worktree. */
export function ompMcpConfigPath(worktree: string): string {
  return path.join(worktree, OMP_MCP_CONFIG_DIR, "mcp.json");
}

/**
 * Everything a turn's credential can live in, as `info/exclude` entries.
 *
 * Both files carry the same per-turn devpipe token. An agent running
 * `git add -A` must never be able to commit either one, so the exclusion is
 * derived from one list rather than restated per call site.
 */
export const MCP_EXCLUDE_ENTRIES: readonly string[] = [MCP_CONFIG_FILE, `${OMP_MCP_CONFIG_DIR}/`];

class GhostLockError extends Error {
  constructor() {
    super("turn no longer holds the dev lock");
  }
}

class CancelledError extends Error {
  constructor() {
    super("ticket was cancelled");
  }
}

/**
 * One conversation line describing what happened to the App's release.
 *
 * Written by the pipeline rather than by the agent because it is the evidence
 * the agent's own reply is allowed to cite: the App ticket rule says 已上线 may
 * only be claimed when this line says the activation succeeded. The two "ok but
 * nothing moved" cases are called out separately — an operator reading the
 * ticket needs to distinguish "the App changed" from "these exact bytes were
 * already what was being served".
 */
export function refreshSummary(outcome: AppReleaseRefreshOutcome): string {
  if (!outcome.ok) {
    const where =
      outcome.step === "pack" ? "打包(pack)"
        : outcome.step === "install" ? "安装(install)"
          : outcome.step === "activate" ? "激活(activate)"
            : "本组合不支持";
    return `⚠ ${outcome.appId} 的 release 刷新在**${where}**这一步被拒绝(${outcome.code}):${outcome.message}\n`
      + `代码**已经**合入基线且过了门禁——被拒的是发布,不是这次改动。不要在回复里说「已上线」。`;
  }
  if (!outcome.changed) {
    return `ℹ ${outcome.appId} 的 release 刷新完成,但 active 指针没有移动:`
      + `这次打出来的包(${outcome.hostLabel})就是当前正在服务的那一版${outcome.deduplicated ? "(而且早已安装过)" : ""}。`
      + `也就是说本次改动没有改变 release 身份。`;
  }
  const transition = outcome.coexistence === "multi_version"
    ? "已打开的旧实例仍可按原 release 继续提交,新打开使用新版本。"
    : `旧 iframe 不会被自动刷新,但下次提交会要求用户显式刷新`
      + `${outcome.coexistenceReason ? `(原因:${outcome.coexistenceReason})` : ""}。`;
  return `🚀 ${outcome.appId} 的 release 已自动刷新并激活:${outcome.hostLabel}(digest ${outcome.packageDigest.slice(0, 20)})。`
    + transition
    + `如果本次改动动了权限契约,每个用户还要在页面上重新同意一次——那不是本票能替他们做的。`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

/**
 * The CLI started, ran on its own terms, and exited non-zero.
 *
 * This is the failure shape that can prove a resumed Claude session was a
 * ghost (ticket #180). Most non-zero exits also receive the transient retry,
 * but that retry has one additional, explicitly tagged preflight case below.
 * Everything excluded here is a decision somebody already made:
 *   · `aborted` — we killed it (cancel, or service shutdown).
 *   · `stalled` / `timed_out` — it ran, and ran past a configured bound.
 *   · `error` — it never spawned or its transport setup failed.
 * Re-running any of those is not a repair, it is a second start the reader did
 * not ask for.
 */
export function isCliExitFailure(r: DevTurnResult): boolean {
  if (r.ok) return false;
  if (r.aborted || r.stalled || r.timed_out) return false;
  if (r.error) return false;
  return r.exit_code != null && r.exit_code !== 0;
}

/**
 * Ticket #20/#400: which failure modes deserve the free one-shot retry.
 *
 * Non-zero CLI exits keep their established behavior. A transport setup error
 * joins them only when its adapter proves the failure happened before a prompt
 * could be accepted. Abort/stall/whole-turn timeout always win over that tag:
 * those are explicit terminal decisions and must never start a second run.
 */
export function isTransientFailure(r: DevTurnResult): boolean {
  if (r.ok || r.aborted || r.stalled || r.timed_out) return false;
  return r.retryable_error === true || isCliExitFailure(r);
}
