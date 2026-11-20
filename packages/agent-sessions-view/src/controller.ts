/**
 * The sessions controller: the orchestration every sessions module shares.
 *
 * ── Why one controller and not one per module ───────────────────────────────
 *
 * The roster, the search box and the chat are three surfaces over ONE provider.
 * The rules that keep them coherent are not about any of them individually:
 * only one transcript read may be in flight, a workspace registry is asked for
 * one machine at a time, a finished submission changes what is worth re-reading
 * exactly once. Duplicating those in three components would produce three
 * disagreeing answers on the first slow network.
 *
 * ── The six rules, and what each one is protecting ──────────────────────────
 *
 *  · **One read at a time, and no request lost.** `readWindow` is a
 *    capability-backed read; two in flight would interleave a tail refresh with
 *    a page of history and produce a window that is neither. So a request that
 *    arrives while one is outstanding WAITS ITS TURN rather than being dropped:
 *    dropping it is how a second chat panel — which nothing else will ever ask
 *    on behalf of — sits at "loading" forever. An identical request that is
 *    already pending is deduplicated instead, because the answer already on its
 *    way IS that request's answer. The queue is a ref rather than state because
 *    the decision happens between renders.
 *  · **A missing transcript is asked for once per resource.** `ensureTranscript`
 *    is how a panel that was opened FOR a resource says it needs it — nothing
 *    else knows, since the boot path only follows the selection. Once, because a
 *    refusal is an answer: re-asking on every projection is how one denied read
 *    turns into a stream of approval cards.
 *  · **The tail extends by VISIBLE units, not by messages.** A run of tool calls
 *    folds to one row, so 200 messages can be two things on screen.
 *  · **Workspace lookups are queued one device at a time.** Each is a separate
 *    capability call to a separate machine; firing them together turns one page
 *    load into N approval prompts arriving in an order nobody chose.
 *  · **A succeeded operation is handled once.** The provider re-sends the same
 *    record as its status advances, so acting on "succeeded" without remembering
 *    which ids were handled would re-read the transcript on every later frame.
 *  · **Roster refreshes have one bounded trailing edge.** Boot, authenticated
 *    projection wakes and a person's refresh button all ask through one
 *    coordinator scoped to this Provider + port. While one capability read is
 *    in flight, any burst becomes at most one follow-up read; an unmounted
 *    Provider never pumps that follow-up.
 *
 * ── What it deliberately does not own ───────────────────────────────────────
 *
 * Panel identity, slots and focus (the workspace coordinator's), and genuinely
 * local display state — a search box's text, pending attachments, which
 * directories are expanded. A composer's text is a deliberate exception: it
 * belongs to a session across panel remounts, so this controller generation
 * owns it in a resource-local external store. That store is not controller
 * React state: one keystroke must not invalidate every module. The new-session
 * draft IS React state here because a directory row in one module prefills a
 * form in another and must survive that form's panel being closed and reopened.
 */

import type { ListedFileLocation } from "@claude-bot/agent-workspace-files-view";
import { createSessionReadScheduler } from "./read-scheduler.js";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  AGENT_PERMISSION_PROFILES,
  operationOutcomePhase,
  promptMatchKey,
  type AgentPermissionProfile,
  type AgentInteraction,
  type AgentInteractionResponse,
  type CliKind,
  type PlacementDevice,
  type RichMessage,
  type SessionOperation,
  type SessionInputReceipt,
  type SessionSummary,
  type SessionsPort,
  type SessionsProjection,
  type SessionsReply,
  type SessionsSnapshot,
  type TerminalSize,
  type TranscriptWindow,
  type WorkspaceGroup,
} from "@claude-bot/agent-sessions-contract";
import {
  base64Of,
  CHAT_ATTACHMENT_CHUNK_BYTES,
} from "./lib/attachments.js";
import {
  CLI_KINDS,
  DEFAULT_CODEX_MODEL,
  EFFORTS,
  MODELS,
  carriesTurnConfiguration,
  normalizeEffort,
} from "./lib/cli.js";
import { interactionReceiptResponse } from "./lib/interaction.js";
import type { RosterSession } from "./lib/roster.js";
import {
  createComposerDraftStore,
  NEW_SESSION_PROMPT_DRAFT_RESOURCE,
  type ComposerDraftPersistence,
  type ComposerDraftSubmission,
} from "./composer-drafts.js";
import {
  TAIL_EXTEND_CAP,
  TRANSCRIPT_PAGE,
  devicesOf,
  currentRuntimeOf,
  preferredTranscriptWindow,
  rosterOf,
  sessionNeedsReview,
  sortedSessions,
  withCustomTitle,
  tailNeedsMore,
  transcriptOf,
  workspaceMap,
} from "./lib/projection.js";

/** The one piece of cross-module form state; see the header. */
export interface NewSessionDraft {
  advanced: boolean;
  /** Agent provider host; empty means the selected execution device. */
  runtimeDevice: string;
  codexAccounts?: Record<string, string>;
  /** Opaque registered workspace selected for advanced placement. */
  workspaceId: string;
  device: string;
  directory: string;
  source: CliKind;
  /** Bilingual Claude lane; only ever true with source "claude". */
  translatePrompt: boolean;
  model: string;
  effort: string;
  permissionProfile: AgentPermissionProfile;
  prompt: string;
}

/** A successful single-use answer retained only as a compact UI receipt. */
export interface ResolvedAgentInteraction {
  interaction: AgentInteraction;
  response: AgentInteractionResponse;
}

/**
 * One send the person made, tracked from the click to the provider's answer
 * (design: frontend-interaction-stability-design.md §2 原则 2).
 *
 * The chat renders these as trailing "传递中/运行中" bubbles the moment the
 * person hits send — before any HTTP round trip — and reconciles them against
 * the operation stream by `opId`. When no authoritative copy exists, a
 * refusal keeps the entry (bounded) with the Host's sentence so the person
 * sees WHY, and restores the draft rather than losing it. The transcript
 * stays authoritative: entries live beside it, never merged into it.
 */
export interface PendingSend {
  key: string;
  resource: string;
  prompt: string;
  kind: "append" | "resume" | "takeover" | "fallback";
  /** Input acknowledgement is independent of the operation/turn terminal status. */
  input?: SessionInputReceipt;
  /**
   * `done` is a holding state between the operation succeeding and the
   * transcript actually showing the message: dropping the bubble on success
   * alone leaves a gap where the person's words are nowhere on screen.
   */
  phase: "sending" | "submitted" | "waiting_approval" | "running" | "refused" | "failed" | "uncertain" | "done";
  opId?: string;
  /** Bounded refusal/failure text; "" otherwise. */
  message: string;
  /**
   * What was authoritative when the person clicked. Only a matching user
   * message observed beyond this cursor may replace the local echo.
   */
  /** Accepted projection sequence and exclusive absolute transcript end at click time. */
  projectionSequence: number;
  absoluteMessageEnd: number | null;
  /**
   * Native commands such as Codex `/compact` create no user transcript row.
   * Only those commands may retire on operation success alone. Ordinary tmux
   * and managed messages keep their words until the authoritative copy arrives.
   */
  operationAcknowledges?: true;
  /**
   * The authoritative evidence that consumed this echo: normally one exact
   * message coordinate, or one trusted operation id when the provider moved
   * the send to a different resource. The entry remains as a bounded tombstone
   * so a second identical send cannot consume it again.
   */
  acknowledgedBy?: string;
  /** Hidden by the person, still reserved for one-to-one transcript matching. */
  dismissed?: true;
}

/**
 * One launch of a new agent, from the click to the device's answer (ticket #191).
 *
 * The form used to `void` its own receipt: `startNewSession()` proposed and
 * nobody read the reply, so a refusal wrote nothing on screen, and an ACCEPTED
 * start whose operation later failed wrote nothing either — the only surface
 * that renders operations is a module this composition does not mount. Somebody
 * pressed 启动 Agent, the form sat there unchanged, and no session appeared.
 *
 * So the launch gets the same lifecycle a chat send already had: an entry in
 * the SAME frame as the click, `opId` linking it to the operation stream, and a
 * terminal phase that carries the Host's or the device's own sentence. The
 * draft is never cleared by a refusal — a refused launch must cost a retry, not
 * a retype — and only a SUCCEEDED operation clears the instruction (that rule
 * already existed and is unchanged).
 *
 * Only the newest launch is retained: the form is one panel, and a second
 * launch is a new question about the same form.
 */
export interface PendingLaunch {
  key: string;
  device: string;
  directory: string;
  phase: "sending" | "submitted" | "running" | "succeeded" | "refused" | "failed" | "uncertain";
  prompt?: string;
  opId?: string;
  /** Trusted opaque resource of the session created by this launch. */
  newResourceId?: string;
  /** Bounded refusal/failure text; "" while nothing has gone wrong. */
  message: string;
}

/** One explicit request to release a settled Runner-owned Codex attachment. */
export interface PendingControlRelease {
  resource: string;
  phase: "sending" | "submitted" | "running" | "refused" | "failed" | "uncertain" | "done";
  opId?: string;
  /** Trusted refusal/result wording, bounded for display. */
  message: string;
}

/** An explicit stop request; confirmation does not claim the turn has ended. */
export interface PendingInterrupt {
  resource: string;
  phase: "sending" | "submitted" | "running" | "done" | "refused" | "failed" | "uncertain";
  opId?: string;
  message: string;
}

function advanceInterrupt(entry: PendingInterrupt, operations: readonly SessionOperation[]): PendingInterrupt {
  if (!entry.opId || ["done", "refused", "failed"].includes(entry.phase)) return entry;
  const operation = operations.find((row) => row.id === entry.opId);
  if (!operation) return entry;
  const outcome = operationOutcomePhase(operation.status);
  const phase: PendingInterrupt["phase"] = outcome === "succeeded" ? "done"
    : outcome ?? (entry.phase === "uncertain" ? "uncertain"
      : operation.status === "running" || operation.status === "waiting_approval" ? "running" : entry.phase);
  const message = phase === "done" ? "停止请求已确认；正在等待运行态更新。"
    : phase === "uncertain" ? "停止结果尚未确认；会话仍可继续查看。"
      : phase === "failed" || phase === "refused"
        ? String(operation.message ?? "").slice(0, 240) || "停止请求未完成。" : "";
  return phase === entry.phase && message === entry.message ? entry : { ...entry, phase, message };
}

/** One desktop request to reveal a chat's real cwd in the shared file index. */
export interface WorkspaceReveal {
  file?: { location: ListedFileLocation; scope: symbol };
  requestId: number;
  resource: string;
  phase: "pending" | "succeeded" | "refused";
  message: string;
}

/** Retained pending/refused sends across every session, oldest dropped beyond this. */
const PENDING_SENDS_MAX = 16;
/** Composer drafts kept per session; far more sessions than anyone types into. */
const DRAFTS_MAX = 32;
/** Work-group and nested-card expansion overrides kept per session transcript. */
const GROUP_OVERRIDES_MAX = 128;
/** Roster facts retained inside one View generation for already-open tabs. */
const SESSION_CACHE_MAX = 256;
/** Transcript windows retained inside one View generation; each may hold up to 800 messages. */
const TRANSCRIPT_CACHE_MAX = 8;

/** Bound inactive summaries without evicting a still-mounted chat's identity. */
function remember<K, V>(cache: Map<K, V>, key: K, value: V, limit: number, retained: (key: K) => boolean): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > limit) {
    const oldest = [...cache.keys()].find((candidate) => !retained(candidate));
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Search can disclose older sessions outside the bounded recent/history pages.
 * Prefer the current roster when the same resource also has a stale search hit. */
function projectedSession(projection: SessionsProjection | null, resource: string | null): SessionSummary | null {
  if (!resource) return null;
  return projection?.sessions?.find((row) => row.resourceId === resource)
    ?? projection?.sessionHistory?.sessions.find((row) => row.resourceId === resource)
    ?? projection?.search?.results?.find((hit) => hit.session?.resourceId === resource)?.session
    ?? null;
}

/** Per-port reads: immediate explicit intent, bounded content-free wake. */
interface RosterRefreshScope {
  port: SessionsPort;
  active: boolean;
  booted: boolean;
  inflight: boolean;
  trailing: "user" | "wake" | null;
  lastStartedAt: number;
  wakeTimer?: ReturnType<typeof setTimeout>;
  wakeBlocked: boolean;
  setBusy(busy: boolean): void;
}

const ROSTER_WAKE_INTERVAL_MS = 2_000;

function requestRosterWake(scope: RosterRefreshScope): void {
  if (!scope.active || scope.wakeBlocked) return;
  if (scope.inflight) {
    scope.trailing ??= "wake";
    return;
  }
  if (scope.wakeTimer !== undefined) return;
  const delay = ROSTER_WAKE_INTERVAL_MS - (Date.now() - scope.lastStartedAt);
  if (delay <= 0) requestRosterRefresh(scope, true);
  else scope.wakeTimer = setTimeout(() => {
    scope.wakeTimer = undefined;
    requestRosterWake(scope);
  }, delay);
}

function requestRosterRefresh(scope: RosterRefreshScope, automatic = false): void {
  if (!scope.active) return;
  if (!automatic) scope.wakeBlocked = false;
  clearTimeout(scope.wakeTimer);
  scope.wakeTimer = undefined;
  if (scope.inflight) {
    if (!automatic) scope.trailing = "user";
    else scope.trailing ??= "wake";
    return;
  }
  scope.inflight = true;
  scope.lastStartedAt = Date.now();
  scope.setBusy(true);
  void (async () => {
    let ok = false;
    try {
      ok = (await scope.port.refreshSessions()).ok;
    } catch {
      // An uncertain/refused automatic read waits for explicit intent. It must
      // not turn a continuous wake stream into repeated approval requests.
    } finally {
      scope.inflight = false;
      scope.wakeBlocked = !ok;
      const trailing = scope.trailing;
      scope.trailing = null;
      if (!scope.active) return;
      if (trailing === "user") requestRosterRefresh(scope);
      else {
        scope.setBusy(false);
        if (ok && trailing === "wake") requestRosterWake(scope);
      }
    }
  })();
}

/**
 * The words the person sent in a user transcript message. In Claude's
 * bilingual lane the block's `text` is the English Claude received and
 * `bilingual.zh` is what the person typed, which is what the echo holds.
 */
function userPromptOf(message: RichMessage | undefined): string {
  if (!message || message.role !== "user") return "";
  if (Array.isArray(message.blocks) && message.blocks.length > 0) {
    return message.blocks
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => String(block.bilingual?.zh ?? block.text))
      .join("\n")
      .trim();
  }
  return typeof message.text === "string" ? message.text.trim() : "";
}

/** Native provider commands succeed without becoming user transcript rows. */
function operationAcknowledgesNativeCommand(
  session: SessionSummary | null | undefined,
  prompt: string,
): boolean {
  return session?.cliKind === "codex" && prompt.trim() === "/compact";
}

function safeSequence(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Exclusive absolute position at the click, preferring the provider's total. */
function absoluteMessageEnd(window: TranscriptWindow | null): number | null {
  if (!window) return null;
  const total = safeSequence(window.totalMessages);
  const offset = safeSequence(window.offset);
  const end = offset === null ? null : offset + (Array.isArray(window.messages) ? window.messages.length : 0);
  if (total === null) return end;
  return end === null ? total : Math.max(total, end);
}

/**
 * Hide local echoes only when a later accepted projection contains their
 * authoritative user message. A consumed message is reserved by the retained
 * tombstone, so two identical clicks require two authoritative occurrences.
 *
 * "Their message" is compared with `promptMatchKey`, the same identity the
 * Runner's input receipt uses: a terminal paste comes back wrapped and with
 * tabs turned into spaces, and an exact comparison then left the echo on screen
 * below the delivered message.
 */
function reconcileAuthoritativeSends(
  previous: readonly PendingSend[],
  projection: SessionsProjection | null,
  projectionSequence: number,
): readonly PendingSend[] {
  if (!projection || !previous.length) return previous;
  const used = new Set(previous.flatMap((entry) => entry.acknowledgedBy ? [entry.acknowledgedBy] : []));
  let changed = false;
  const next = previous.map((entry) => {
    if (entry.acknowledgedBy || projectionSequence <= entry.projectionSequence) return entry;
    const window = transcriptOf(projection, entry.resource);
    const offset = safeSequence(window?.offset), baseline = entry.absoluteMessageEnd;
    // Without absolute coordinates, a rotated legacy tail can make old text
    // look new. Retain the echo rather than guessing and hiding the words.
    if (baseline === null || offset === null || !window || !Array.isArray(window.messages)) return entry;
    const expected = promptMatchKey(entry.prompt);
    const index = window.messages.findIndex((message, index) => {
      const key = `${entry.resource}\u0000absolute:${offset + index}`;
      return offset + index >= baseline
        && !used.has(key)
        && promptMatchKey(userPromptOf(message)) === expected;
    });
    if (index < 0) return entry;
    const key = `${entry.resource}\u0000absolute:${offset + index}`;
    used.add(key);
    changed = true;
    return { ...entry, acknowledgedBy: key };
  });
  return changed ? next : previous;
}

/** Advance each local echo from the trusted operation carrying its exact opId. */
function reconcilePendingSendOperations(
  previous: readonly PendingSend[],
  operations: readonly SessionOperation[],
): readonly PendingSend[] {
  if (!previous.length || !operations.length) return previous;
  let changed = false;
  const next: PendingSend[] = [];
  for (const original of previous) {
    let entry = original;
    const operation = entry.opId
      ? operations.find((row) => String(row.id ?? "") === entry.opId)
      : undefined;
    if (!operation || entry.acknowledgedBy) {
      next.push(entry);
      continue;
    }
    const inputRank = { dispatched: 0, local_queued: 1, provider_accepted: 2, input_observed: 3 };
    if (operation.input && (!entry.input || inputRank[operation.input.phase] > inputRank[entry.input.phase]
      || (operation.input.phase === entry.input.phase && operation.input.at > entry.input.at))) {
      entry = { ...entry, input: operation.input };
      changed = true;
    }
    const status = String(operation.status ?? "");
    const outcome = operationOutcomePhase(status);
    // Delivery evidence never moves backwards on a delayed operation frame.
    // An uncertain outcome may still acquire a definitive result later.
    if (entry.phase === "done" || entry.phase === "failed" || entry.phase === "refused"
      || (entry.phase === "uncertain" && outcome === null)) {
      next.push(entry);
      continue;
    }
    if (outcome === "succeeded") {
      changed = true;
      const replacement = String(operation.newResourceId ?? "");
      const operationIsEvidence = entry.operationAcknowledges
        || Boolean(replacement && replacement !== entry.resource);
      if (operationIsEvidence) {
        // A native-command confirmation and a cross-resource handoff are both
        // one-to-one operation evidence. Neither can safely compare the
        // origin transcript cursor with a provider-normalized/rebound copy.
        const acknowledgedBy = replacement && replacement !== entry.resource
          ? `operation:${entry.opId}:replacement:${replacement}`
          : `operation:${entry.opId}:terminal`;
        next.push({ ...entry, phase: "done", message: "", acknowledgedBy });
      } else {
        next.push({ ...entry, phase: "done", message: "" });
      }
      continue;
    }
    const phase: PendingSend["phase"] = outcome ?? (entry.phase === "uncertain" ? entry.phase
      : status === "running" ? "running"
        : status === "waiting_approval" && entry.phase !== "running" ? "waiting_approval" : entry.phase);
    const message = phase === "failed" || phase === "refused" || phase === "uncertain"
      ? String(operation.message ?? "").slice(0, 240) || entry.message
      : "";
    if (phase !== entry.phase || message !== entry.message) {
      changed = true;
      next.push({ ...entry, phase, message });
    } else {
      next.push(entry);
    }
  }
  return changed ? next : previous;
}

function selectedAgentProfile(
  session: SessionSummary | null | undefined, resource: string,
  profiles: Readonly<Record<string, AgentPermissionProfile>>,
): AgentPermissionProfile | undefined {
  return CLI_KINDS.includes(session?.cliKind as CliKind)
    ? profiles[resource] ?? AGENT_PERMISSION_PROFILES.fullAccess
    : undefined;
}

type TurnWriteAction = "append" | "resume" | "takeover" | "fallback";

function selectedAgentEffort(
  session: SessionSummary | null | undefined,
  resource: string,
  efforts: Readonly<Record<string, string>>,
  action: TurnWriteAction,
): string | undefined {
  const selected = efforts[resource] ?? "";
  const cliKind = session?.cliKind as CliKind | undefined;
  return session && cliKind && carriesTurnConfiguration(session, action) && EFFORTS[cliKind].includes(selected)
    ? selected
    : undefined;
}

function selectedAgentModel(
  session: SessionSummary | null | undefined,
  resource: string,
  models: Readonly<Record<string, string>>,
  action: TurnWriteAction,
): string | undefined {
  const selected = models[resource] ?? "";
  const cliKind = session?.cliKind as CliKind | undefined;
  return session
    && cliKind
    && carriesTurnConfiguration(session, action)
    && (cliKind === "codex" ? /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(selected)
      : MODELS[cliKind].some(choice => choice.value === selected))
    ? selected
    : undefined;
}

const EMPTY_OVERRIDES: Readonly<Record<string, boolean>> = Object.freeze({});

const EMPTY_DRAFT: NewSessionDraft = {
  advanced: false,
  runtimeDevice: "",
  workspaceId: "",
  device: "",
  directory: "",
  source: "codex",
  translatePrompt: false,
  model: DEFAULT_CODEX_MODEL,
  effort: "xhigh",
  permissionProfile: AGENT_PERMISSION_PROFILES.fullAccess,
  prompt: "",
};

/** Bound retained receipts even when a page visits hundreds of sessions. */
const RESOLVED_INTERACTION_RECEIPTS_MAX = 32;

export interface SessionsController {
  openShare(shareId: string): Promise<import("@claude-bot/agent-sessions-contract").SessionsReply>;
  readonly snapshot: SessionsSnapshot;
  readonly projection: SessionsProjection | null;
  /** True once a projection has arrived over an open channel. */
  readonly ready: boolean;
  readonly phase: SessionsSnapshot["phase"];
  readonly sessions: readonly SessionSummary[];
  readonly roster: readonly RosterSession[];
  readonly devices: readonly string[];
  readonly workspaces: Readonly<Record<string, WorkspaceGroup>>;
  readonly placementDevices: readonly PlacementDevice[];
  readonly operations: readonly SessionOperation[];
  readonly refusal: string;
  readonly selected: string | null;
  readonly current: SessionSummary | null;
  /**
   * True when the selected session is missing from THIS frame's roster.
   *
   * Absence is not deletion (design §2 原则 1): a device timing out of one
   * fan-out, a 200-row cap, or a plane failure removes rows for a frame, and
   * moving the person's focus on that evidence is the "chat window jumps by
   * itself" bug. The selection stays; the UI shows a hint instead.
   */
  readonly selectedAbsent: boolean;
  readonly transcriptBusy: boolean;
  /** The roster is a progressive cache-backed frame, not yet the settled answer. */
  readonly rosterRefreshing: boolean;
  /** Whether this exact chat has an authoritative transcript read in flight or queued. */
  transcriptRefreshing(resource: string | null): boolean;
  readonly newSession: NewSessionDraft;
  /** The newest launch's lifecycle, or null when nobody has started one here. */
  readonly launch: PendingLaunch | null;
  /** Latest cross-module cwd reveal request and its visible outcome. */
  readonly workspaceReveal: WorkspaceReveal | null;

  sessionOf(resource: string | null): SessionSummary | null;
  /**
   * The `selectedAbsent` judgement for ANY session a panel shows: missing from
   * the latest SETTLED roster frame. Loading frames never flip it — they are
   * progressive disclosure, not roster authority.
   */
  sessionAbsent(resource: string | null): boolean;
  windowOf(resource: string | null): TranscriptWindow | null;
  resolvedInteractionOf(resource: string | null): ResolvedAgentInteraction | null;
  /** Pending/refused sends for one session, oldest first. */
  pendingSendsOf(resource: string | null): readonly PendingSend[];
  /** Manual Codex release lifecycle for this exact session. */
  controlReleaseOf(resource: string | null): PendingControlRelease | null;
  interruptOf(resource: string | null): PendingInterrupt | null;
  /** Drop one settled (refused/failed) send after showing it. */
  dismissSend(key: string): void;
  /** The composer draft for one session. Keyed by resource, so a focus change cannot cross-post. */
  draftOf(resource: string | null): string;
  setDraft(resource: string | null, text: string): void;
  /** Subscribe only to one session's draft; typing must not invalidate the shared controller. */
  subscribeDraft(resource: string | null, listener: () => void): () => void;
  permissionProfileOf(resource: string | null): AgentPermissionProfile;
  setPermissionProfile(resource: string | null, profile: AgentPermissionProfile): void;
  /** Optional model carried by this session's next managed turn. Empty preserves the Runner default. */
  modelOf(resource: string | null): string;
  setModel(resource: string | null, model: string): void;
  /** Optional effort carried by this session's next managed turn. Empty preserves the Runner default. */
  effortOf(resource: string | null): string;
  setEffort(resource: string | null, effort: string): void;
  /** Sticky user choice for one transcript disclosure; see AgentChat. */
  groupOverridesOf(resource: string | null): Readonly<Record<string, boolean>>;
  setGroupOverride(resource: string | null, groupKey: string, open: boolean): void;
  revealWorkspace(resource: string, file?: WorkspaceReveal["file"]): void;
  settleWorkspaceReveal(requestId: number, result: { ok: boolean; message: string }): void;
  select(resource: string): void;
  refresh(): void;
  /** First page without `cursor`; a later page with the previous page's `nextCursor`. */
  search(query: string, cursor?: string): void;
  browseSessions?: SessionsPort["browseSessions"];
  readBlock?: SessionsPort["readBlock"];
  read(resource: string | null, limit: number, offset?: number): void;
  /**
   * Open a resource's transcript if it has none — at most once per resource.
   *
   * For the panel that was opened FOR a resource: nothing else knows it exists.
   * Once, because a refusal is an answer and not a reason to ask again.
   */
  ensureTranscript(resource: string | null): void;
  /** Own the resource live lease for a mounted panel; release never interrupts its Agent. */
  retainTranscript(resource: string | null): () => void;
  loadOlder(resource: string | null): void;
  requestWorkspaces(force: boolean, device?: string): void;
  /** A live session takes an append; an idle one has to be resumed first. */
  send(resource: string | null, prompt: string): void;
  /** User-confirmed cancellation of an observed local CLI before headless resume. */
  takeover(resource: string | null, prompt: string): void;
  /** Explicitly fork a Codex thread onto another healthy configured account. */
  fallback(resource: string | null, prompt: string): void;
  /** Human-requested native stop for the current managed turn. */
  interrupt(resource: string | null): void;
  /** Human-confirmed release of a settled Codex attachment whose automatic close failed. */
  releaseControl(resource: string | null): void;
  dismissControlRelease(resource: string | null): void;
  /** Answer the exact provider request currently projected for this session. */
  respondInteraction(resource: string | null, interactionId: string, response: AgentInteractionResponse): Promise<void>;
  pin(resource: string | null): void;
  /** The port keeps idempotent favorites and folders (App-owned state). */
  readonly organize: boolean;
  /** Set favorites for several chats; resolves with the first refusal, if any. */
  setPinned(resources: readonly string[], pinned: boolean): Promise<SessionsReply>;
  saveFolder(folder: string, name: string): Promise<SessionsReply>;
  deleteFolder(folder: string): Promise<SessionsReply>;
  /** Move chats into one folder, or out of every folder with an empty id. */
  fileSessions(resources: readonly string[], folder: string): Promise<SessionsReply>;
  setTitle(resource: string | null, title: string): Promise<SessionsReply>;
  readContinuation(resource: string): Promise<SessionsReply>;
  saveContinuation(resource: string, prompt: string | null, revision: string): Promise<SessionsReply>;
  /**
   * Upload one user-selected file to this session's physical device.
   *
   * A receipt, not fire-and-forget: each file's chunks are sent in order
   * without retries, while callers may upload separate files concurrently.
   * The composer adds a chip only after the Runner returns the completed path.
   * The file remains component-owned draft state until send.
   */
  attachFile(
    resource: string | { device: string; workspaceId?: string },
    file: File,
    onProgress?: (uploadedBytes: number, totalBytes: number) => void,
  ): Promise<
    | { ok: true; attachment: { label: string; path: string; bytes: number } }
    | { ok: false; message: string }
  >;
  openTerminal(device: string, workspaceId: string, size: TerminalSize): Promise<SessionsReply>;
  readTerminal(device: string, terminalId: string, size: TerminalSize): Promise<SessionsReply>;
  sendTerminal(device: string, terminalId: string, input: string, size: TerminalSize): Promise<SessionsReply>;
  closeTerminal(device: string, terminalId: string): Promise<SessionsReply>;
  setNewSession(patch: Partial<NewSessionDraft>): void;
  /** Prefill from a directory row without discarding the rest of the draft. */
  prefillNewSession(device: string, directory: string): void;
  /**
   * Propose one launch and TRACK it. The receipt is consumed here, so the
   * caller may ignore the promise; `launch` is what the form renders.
   */
  startNewSession(prompt?: string): Promise<SessionsReply>;
  /** Drop a settled launch after showing it, so the form is usable again. */
  dismissLaunch(): void;
  clearRefusal(): void;
}

/** The App action accepts this many chats per call; larger selections are split. */
const FILE_BATCH = 64;
const UNSUPPORTED_ORGANIZE: SessionsReply = Object.freeze({
  ok: false,
  code: "unsupported",
  result: null,
  message: "当前视图不支持收藏夹与文件夹整理。",
});

export function useSessionsController(
  port: SessionsPort,
  wakeToken = 0,
  draftPersistence?: ComposerDraftPersistence,
  initialSelectedResource: string | null = null,
): SessionsController {
  const snapshot = useSyncExternalStore(port.subscribe, port.snapshot, port.snapshot);
  const projection = snapshot.projection;

  // The transport already rejects duplicate/stale numbered revisions. This
  // controller-local sequence numbers only the accepted projection objects it
  // receives, so a click can require evidence from a later accepted frame.
  const projectionClock = useRef<{ projection: SessionsProjection | null; sequence: number }>({ projection: null, sequence: 0 });
  const observeProjection = useCallback((next: SessionsProjection | null): number => {
    const previous = projectionClock.current;
    if (previous.projection === next) return previous.sequence;
    return (projectionClock.current = { projection: next, sequence: previous.sequence + 1 }).sequence;
  }, []);
  const projectionSequence = observeProjection(projection);

  const [selected, setSelected] = useState<string | null>(() => initialSelectedResource || null);
  const [transcriptRefreshingResources, setTranscriptRefreshingResources] = useState<readonly string[]>([]);
  const [newSession, setDraft] = useState<NewSessionDraft>(EMPTY_DRAFT);
  const [launch, setLaunch] = useState<PendingLaunch | null>(null);
  const launchRef = useRef<PendingLaunch | null>(launch);
  launchRef.current = launch;
  const launchDraftsByOperation = useRef(new Map<string, ComposerDraftSubmission>());
  const [resolvedInteractions, setResolvedInteractions] = useState<Record<string, ResolvedAgentInteraction>>({});
  const [pendingSends, setPendingSends] = useState<readonly PendingSend[]>([]);
  const sendScope = useMemo(() => ({ active: true }), [port]);
  useLayoutEffect(() => {
    sendScope.active = true;
    return () => { sendScope.active = false; };
  }, [sendScope]);
  const restoredSendFailures = useRef(new Set<string>());
  const [controlReleases, setControlReleases] = useState<Record<string, PendingControlRelease>>({});
  const controlReleasesRef = useRef(controlReleases);
  controlReleasesRef.current = controlReleases;
  const [interrupts, setInterrupts] = useState<Record<string, PendingInterrupt>>({});
  const interruptsRef = useRef(interrupts);
  interruptsRef.current = interrupts;
  const storeInterrupt = useCallback((entry: PendingInterrupt) => {
    const next = { ...interruptsRef.current, [entry.resource]: entry };
    for (const key of Object.keys(next).filter((key) => key !== entry.resource).slice(0, Math.max(0, Object.keys(next).length - PENDING_SENDS_MAX))) delete next[key];
    interruptsRef.current = next;
    setInterrupts(next);
  }, []);
  useEffect(() => {
    for (const entry of Object.values(interruptsRef.current)) {
      const next = advanceInterrupt(entry, snapshot.operations);
      if (next !== entry) storeInterrupt(next);
    }
  }, [snapshot.operations, storeInterrupt]);
  // Draft keystrokes are deliberately outside React controller state. The
  // store still belongs to this Provider/port generation and remains bounded,
  // but only the composer for the changed resource is notified.
  const draftStore = useMemo(
    () => createComposerDraftStore(DRAFTS_MAX, draftPersistence),
    [draftPersistence, port],
  );
  useEffect(() => () => draftStore.destroy(), [draftStore]);
  const draftOf = useCallback((resource: string | null) => draftStore.get(resource), [draftStore]);
  const setSessionDraft = useCallback((resource: string | null, text: string) => {
    draftStore.set(resource, text);
  }, [draftStore]);
  const subscribeDraft = useCallback((resource: string | null, listener: () => void) => (
    draftStore.subscribe(resource, listener)
  ), [draftStore]);
  useEffect(() => {
    const syncPrompt = (): void => {
      const prompt = draftStore.get(NEW_SESSION_PROMPT_DRAFT_RESOURCE);
      setDraft((previous) => previous.prompt === prompt ? previous : { ...previous, prompt });
    };
    syncPrompt();
    return draftStore.subscribe(NEW_SESSION_PROMPT_DRAFT_RESOURCE, syncPrompt);
  }, [draftStore]);
  const [permissionProfiles, setPermissionProfiles] = useState<Record<string, AgentPermissionProfile>>({});
  const [models, setModels] = useState<Record<string, string>>({});
  const [efforts, setEfforts] = useState<Record<string, string>>({});
  const [groupOverrides, setGroupOverrides] = useState<Record<string, Record<string, boolean>>>({});
  const [reviewOverlays, setReviewOverlays] = useState<Record<string, string>>({});
  const [workspaceReveal, setWorkspaceReveal] = useState<WorkspaceReveal | null>(null);
  const nextWorkspaceRevealSeq = useRef(0);
  const revealWorkspace = useCallback((resource: string, file?: WorkspaceReveal["file"]): void => {
    if (!resource) return;
    setWorkspaceReveal({
      requestId: ++nextWorkspaceRevealSeq.current,
      resource,
      ...(file ? { file } : {}),
      phase: "pending",
      message: file ? "正在文件索引中定位文件…" : "正在文件索引中定位真实工作目录…",
    });
  }, []);
  const settleWorkspaceReveal = useCallback((
    requestId: number,
    result: { ok: boolean; message: string },
  ): void => {
    setWorkspaceReveal((previous) => previous?.requestId === requestId
      ? {
          ...previous,
          phase: result.ok ? "succeeded" : "refused",
          message: result.message.slice(0, 240),
        }
      : previous);
  }, []);
  useEffect(() => {
    setWorkspaceReveal(null);
  }, [port]);

  // These are display caches, not stores of authority. A different port is a
  // different View generation/ref vocabulary and therefore gets fresh Maps.
  // Reads and writes still cross the Gate every time; cached data only prevents
  // an already-open tab from flashing empty while the Host rotates its smaller
  // projection window or a refresh briefly omits one device.
  const sessionCache = useMemo(() => new Map<string, SessionSummary>(), [port]);
  const transcriptCache = useMemo(() => new Map<string, TranscriptWindow>(), [port]);
  const displayedTranscript = useCallback((
    source: SessionsProjection | null,
    resource: string | null,
  ): TranscriptWindow | null => {
    if (!resource) return null;
    return preferredTranscriptWindow(
      transcriptCache.get(resource) ?? null,
      transcriptOf(source, resource),
    );
  }, [transcriptCache]);

  const [rosterRead, setRosterRead] = useState<{ port: SessionsPort; busy: boolean } | null>(null);
  const rosterRefreshScope = useMemo<RosterRefreshScope>(() => ({
    port,
    active: true,
    booted: false,
    inflight: false,
    trailing: null,
    lastStartedAt: -Infinity,
    wakeBlocked: false,
    setBusy: (busy) => setRosterRead({ port, busy }),
  }), [port]);
  const refreshSessions = useCallback((): void => {
    requestRosterRefresh(rosterRefreshScope);
  }, [rosterRefreshScope]);
  useEffect(() => {
    rosterRefreshScope.active = true;
    return () => {
      rosterRefreshScope.active = false;
      rosterRefreshScope.trailing = null;
      clearTimeout(rosterRefreshScope.wakeTimer);
      rosterRefreshScope.wakeTimer = undefined;
    };
  }, [rosterRefreshScope]);

  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected;
  const handledOperations = useRef(new Set<string>());
  const extendRef = useRef<(resource: string) => void>(() => {});
  const readScheduler = useMemo(() => createSessionReadScheduler(port, {
    busy: setTranscriptRefreshingResources,
    read: (resource) => extendRef.current(resource),
  }), [port]);
  const schedulerEffect = useRef(0);
  useLayoutEffect(() => {
    const generation = ++schedulerEffect.current;
    readScheduler.activate();
    return () => {
      readScheduler.pause();
      // StrictMode's immediate setup reuses this owner; a real replacement
      // must retire all its leases, queues and late continuations.
      queueMicrotask(() => {
        if (schedulerEffect.current !== generation) {
          // A new port has a different scheduler even if its effect already ran.
          if (currentScheduler.current !== readScheduler) readScheduler.destroy();
          return;
        }
        readScheduler.destroy();
      });
    };
  }, [readScheduler]);
  const currentScheduler = useRef(readScheduler);
  currentScheduler.current = readScheduler;
  const handledWakeToken = useRef(0);
  /**
   * The last roster row seen for the selected session, kept so a frame that
   * momentarily lacks it (device timeout, cap, plane failure) renders the same
   * chat instead of unmounting it. Absence is not deletion.
   */
  const retainedSession = useRef<SessionSummary | null>(null);
  const nextSendSeq = useRef(0);
  const nextLaunchSeq = useRef(0);

  const read = readScheduler.read;

  const maybeExtendTail = useCallback((resource: string): void => {
    // The latest snapshot, not the rendered one: this runs in the continuation
    // of a proposal, and React has not necessarily painted the projection the
    // provider sent immediately before the answer.
    const data = displayedTranscript(port.snapshot().projection, resource);
    if (!data) return;
    const messages = Array.isArray(data.messages) ? data.messages : [];
    const offset = Number(data.offset ?? 0);
    if (
      offset <= 0
      || messages.length >= TAIL_EXTEND_CAP
      || !tailNeedsMore(messages, data.cliKind)
    ) return;
    const take = Math.min(TRANSCRIPT_PAGE, offset, TAIL_EXTEND_CAP - messages.length);
    if (take > 0) read(resource, take, offset - take);
  }, [displayedTranscript, port, read]);
  extendRef.current = maybeExtendTail;

  const ensureTranscript = readScheduler.ensure;
  const retainTranscript = readScheduler.retain;
  const requestWorkspaces = useCallback(
    (force: boolean, targetDevice?: string): void => {
      const current = port.snapshot().projection;
      const map = workspaceMap(current);
      const devices = devicesOf(current);
      if (targetDevice && !devices.includes(targetDevice) && !map[targetDevice]) return;
      for (const device of targetDevice ? [targetDevice] : devices) {
        if (!force && map[device]) continue;
        readScheduler.workspace(device, force);
      }
    },
    [port, readScheduler],
  );

  // Boot, and every subsequent projection: initialise a selection from the
  // first SETTLED roster, open a transcript for it once, and learn which
  // machines have workspaces.
  //
  // A loading roster is only the fastest provider's partial answer. Selecting
  // from it made the default chat systematically differ from one opened by a
  // person: the fast local observer could win, then disappear or become
  // read-only when the complete Runner roster arrived. Wait for the semantic
  // boundary instead. After selection, the existing rule still holds: a data
  // frame may fill an empty selection, but never overrides the person's.
  useEffect(() => {
    if (!projection) return;
    const list = sortedSessions(projection);
    const rosterSettled = projection.resourceState !== "loading";
    let current = selectedRef.current;
    const firstParent = list.find((session) => !session.parentResourceId);
    if (!current && rosterSettled && firstParent) {
      current = firstParent.resourceId;
      selectedRef.current = current;
      setSelected(current);
    }
    if (!rosterRefreshScope.booted) {
      rosterRefreshScope.booted = true;
      refreshSessions();
    }
    // Retain the selected row while it is present, so an absent frame keeps
    // rendering the same chat rather than unmounting it.
    if (current) {
      const row = projectedSession(projection, current);
      if (row) retainedSession.current = row;
    }
    // The selection's transcript, through the same one-request-per-resource door
    // a panel opened for a resource uses.
    ensureTranscript(current);
    requestWorkspaces(false);
  }, [projection, rosterRefreshScope, refreshSessions, ensureTranscript, requestWorkspaces]);

  // A submission that finished changes what is worth reading. Handled once per
  // id; see the header.
  useEffect(() => {
    for (const operation of snapshot.operations) {
      const id = String(operation.id ?? "");
      const launchDraft = launchDraftsByOperation.current.get(id);
      if (launchDraft) {
        const outcome = operationOutcomePhase(operation.status);
        if (outcome === "succeeded") {
          draftStore.completeSubmission(launchDraft);
          launchDraftsByOperation.current.delete(id);
        } else if (outcome === "failed" || outcome === "refused") {
          draftStore.restoreSubmission(launchDraft);
          launchDraftsByOperation.current.delete(id);
        }
      }
      if (!id || operation.status !== "succeeded" || handledOperations.current.has(id)) continue;
      handledOperations.current.add(id);
      if (operation.operation === "start_session") {
        // Only the exact tracked launch above may clear its instruction. The
        // device and directory remain, because starting another Agent in the
        // same place is the common next step.
        refreshSessions();
      } else if (operation.newResourceId) {
        const resource = String(operation.newResourceId);
        selectedRef.current = resource;
        setSelected(resource);
        refreshSessions();
        read(resource, TRANSCRIPT_PAGE);
      } else if (operation.operation === "release_session_control") {
        // The operation receipt proves the close; refresh both runtime sources
        // so a stale capability cannot keep offering the same release again.
        refreshSessions();
        const resource = operation.resourceId || selectedRef.current;
        if (resource) read(resource, TRANSCRIPT_PAGE);
      } else {
        const resource = operation.resourceId || selectedRef.current;
        if (resource) read(resource, TRANSCRIPT_PAGE);
      }
    }
  }, [draftStore, snapshot.operations, refreshSessions, read]);

  // The launch the form is watching, advanced by the SAME operation stream and
  // the same rule (ticket #191). An accepted proposal is only the beginning of
  // a start: the device may still refuse the directory, fail to spawn the CLI,
  // or have gone away — and every one of those used to be invisible here.
  useEffect(() => {
    setLaunch((previous) => {
      if (!previous?.opId || previous.phase === "succeeded") return previous;
      const operation = snapshot.operations.find((row) => String(row.id ?? "") === previous.opId);
      if (!operation) return previous;
      const status = String(operation.status ?? "");
      const outcome = operationOutcomePhase(status);
      // The form's own `refused` is the Host refusing the proposal; a device
      // or Gate refusal of an accepted launch reads as the launch failing.
      const phase: PendingLaunch["phase"] = outcome === "refused" ? "failed"
        : outcome ?? (status === "running" || status === "waiting_approval" ? "running" : previous.phase);
      // Only a terminal failure carries a sentence. "Waiting for approval" is
      // the trusted shell's surface, not a line this form should mirror.
      const message = phase === "uncertain"
        ? "启动结果尚未确认；请核对原操作和会话列表，不要重复启动。"
        : phase === "failed"
          ? String(operation.message ?? "").slice(0, 240) || "设备报告启动失败"
          : "";
      const newResourceId = phase === "succeeded" ? String(operation.newResourceId ?? "") : "";
      return phase === previous.phase
        && message === previous.message
        && (!newResourceId || newResourceId === previous.newResourceId)
        ? previous
        : { ...previous, phase, message, ...(newResourceId ? { newResourceId } : {}) };
    });
  }, [snapshot.operations]);

  // Reconcile pending sends against the operation stream by opId: the chip the
  // coordinator advances IS the lifecycle of the bubble the person is watching.
  // Same-resource success keeps the bubble until the exact later
  // authoritative user message. Native commands and cross-resource success
  // are one-to-one operation evidence, so they seal the origin echo
  // without comparing incompatible transcript text/cursors. A failed/rejected
  // send keeps its sentence.
  useEffect(() => {
    setPendingSends((previous) => {
      const next = reconcilePendingSendOperations(previous, snapshot.operations);
      return next;
    });
  }, [snapshot.operations]);

  // A release has no transcript message to reconcile against. Its exact
  // operation row is therefore the complete authoritative lifecycle.
  useEffect(() => {
    let changed = false;
    const next = { ...controlReleasesRef.current };
    for (const [resource, entry] of Object.entries(next)) {
      if (!entry.opId) continue;
      const operation = snapshot.operations.find((row) => String(row.id ?? "") === entry.opId);
      if (!operation) continue;
      const status = String(operation.status ?? "");
      const outcome = operationOutcomePhase(status);
      const phase: PendingControlRelease["phase"] = outcome === "succeeded" ? "done"
        : outcome ?? (status === "running" || status === "waiting_approval" ? "running" : entry.phase);
      const message = phase === "done"
        ? "后台占用已释放；可以回到本机 Codex CLI 恢复这条会话。"
        : phase === "uncertain"
          ? String(operation.message ?? "").slice(0, 240) || "放锁结果未知：占用可能已经释放，不会自动重试。请先核对会话状态，再决定是否重新放锁。"
          : phase === "failed" || phase === "refused"
            ? String(operation.message ?? "").slice(0, 240) || "后台占用仍未释放。"
            : "";
      if (phase === entry.phase && message === entry.message) continue;
      next[resource] = { ...entry, phase, message };
      changed = true;
    }
    if (!changed) return;
    controlReleasesRef.current = next;
    setControlReleases(next);
  }, [snapshot.operations]);

  // A terminal operation with no authoritative transcript evidence leaves the
  // person's words visible and recoverable. If the exact later user message is
  // already authoritative, the operation's failure/refusal is lifecycle
  // metadata only: do not resurrect the consumed echo or refill the composer.
  useEffect(() => {
    const reconciled = reconcileAuthoritativeSends(
      reconcilePendingSendOperations(pendingSends, snapshot.operations), projection, projectionSequence,
    );
    const handled = restoredSendFailures.current;
    for (const key of handled) {
      if (!reconciled.some((entry) => entry.key === key)) handled.delete(key);
    }
    for (const entry of reconciled) {
      if (entry.acknowledgedBy || entry.dismissed || handled.has(entry.key)
        || (entry.phase !== "failed" && entry.phase !== "refused")) continue;
      // Also handles terminal operation frames that beat the proposal receipt.
      // Mark even when a newer draft exists: clearing that draft is not a retry.
      handled.add(entry.key);
      draftStore.setIfEmpty(entry.resource, entry.prompt);
    }
  }, [draftStore, pendingSends, projection, projectionSequence, snapshot.operations]);

  // An authoritative user message may precede the proposal reply or operation
  // success. Reconcile on every accepted projection and hide the local echo as
  // soon as the exact later message exists — never merely because the window
  // object changed.
  useEffect(() => {
    setPendingSends((previous) => {
      return reconcileAuthoritativeSends(previous, projection, projectionSequence);
    });
  }, [projection, projectionSequence]);


  // Wake carries no disclosure. Coalesce it across all devices and preserve
  // the final arrival without polling or replaying a refused capability read.
  useEffect(() => {
    if (wakeToken <= 0 || wakeToken === handledWakeToken.current) return;
    handledWakeToken.current = wakeToken;
    requestRosterWake(rosterRefreshScope);
  }, [wakeToken, rosterRefreshScope]);

  const rawSessions = useMemo(() => sortedSessions(projection), [projection]);
  const sessions = useMemo(
    () => rawSessions.map((session) => withCustomTitle(session, projection?.customTitles)),
    [projection?.customTitles, rawSessions],
  );
  useLayoutEffect(() => {
    for (const session of [...rawSessions, ...(projection?.sessionHistory?.sessions ?? [])]) {
      remember(sessionCache, session.resourceId, session, SESSION_CACHE_MAX, readScheduler.holds);
    }
    for (const hit of projection?.search?.results ?? []) {
      const session = projectedSession(projection, hit.session?.resourceId ?? null);
      if (session) remember(sessionCache, session.resourceId, session, SESSION_CACHE_MAX, readScheduler.holds);
    }
    for (const [resource, window] of Object.entries(projection?.transcript ?? {})) {
      const preferred = window
        ? preferredTranscriptWindow(transcriptCache.get(resource) ?? null, window)
        : null;
      if (preferred) {
        transcriptCache.delete(resource);
        transcriptCache.set(resource, preferred);
        while (transcriptCache.size > TRANSCRIPT_CACHE_MAX) {
          const inactive = [...transcriptCache.keys()].find((key) => !readScheduler.holds(key));
          if (!inactive) break;
          transcriptCache.delete(inactive);
        }
      }
    }
  }, [projection, rawSessions, readScheduler, sessionCache, transcriptCache]);
  const effectiveReviewedAt = useMemo(() => {
    const merged = { ...(projection?.reviewedAt ?? {}) };
    for (const [resource, completedAt] of Object.entries(reviewOverlays)) {
      const durable = Date.parse(merged[resource] ?? "");
      const optimistic = Date.parse(completedAt);
      if (!Number.isFinite(durable) || optimistic > durable) merged[resource] = completedAt;
    }
    return merged;
  }, [projection?.reviewedAt, reviewOverlays]);
  useEffect(() => {
    setReviewOverlays((previous) => {
      let changed = false;
      const next = { ...previous };
      for (const [resource, completedAt] of Object.entries(previous)) {
        if (sessionNeedsReview({ completedAt }, projection?.reviewedAt?.[resource])) continue;
        delete next[resource];
        changed = true;
      }
      return changed ? next : previous;
    });
  }, [projection?.reviewedAt]);
  const roster = useMemo(() => rosterOf(sessions, effectiveReviewedAt, projection?.customTitles, projection?.transcript),
    [effectiveReviewedAt, sessions, projection?.customTitles, projection?.transcript]);
  const workspaces = useMemo(() => workspaceMap(projection), [projection]);
  const devices = useMemo(() => devicesOf(projection), [projection]);
  const placementDevices = projection?.placement?.devices ?? [];
  const listed = projectedSession(projection, selected);
  // Absence is not deletion: an absent frame keeps the raw retained provider
  // row, then applies the current account title only at the display edge.
  const retained = selected && retainedSession.current?.resourceId === selected ? retainedSession.current : null;
  const rawCurrent = listed ?? (selected ? sessionCache.get(selected) ?? null : null) ?? retained;
  const current = rawCurrent ? withCustomTitle(rawCurrent, projection?.customTitles) : null;
  // Only a SETTLED frame may call a session absent. A `loading` frame is the
  // Host's progressive disclosure — the fastest plane's first rows while the
  // other plane is still answering — and treating it as roster authority is
  // what made the absence hint blink once per refresh.
  const rosterSettled = projection !== null && projection.resourceState !== "loading"
    && projection.rosterTruncated !== true && projection.rosterIndexPending !== true;
  const selectedAbsent = selected !== null && listed === null && rosterSettled;

  const select = useCallback(
    (resource: string): void => {
      selectedRef.current = resource;
      setSelected(resource);
      // Explicit, so it refreshes the tail rather than trusting what is cached;
      // an identical read already in flight is still only one read.
      read(resource, TRANSCRIPT_PAGE);

      const session = projectedSession(projection, resource) ?? sessionCache.get(resource) ?? null;
      if (session) retainedSession.current = session;
      if (!session || session.shared || !sessionNeedsReview(session, effectiveReviewedAt[resource])) return;
      const completedAt = session.completedAt!;
      setReviewOverlays((previous) => ({ ...previous, [resource]: completedAt }));
      void port.markReviewed(resource, completedAt).then((reply) => {
        if (reply.ok) return;
        setReviewOverlays((previous) => {
          if (previous[resource] !== completedAt) return previous;
          const next = { ...previous };
          delete next[resource];
          return next;
        });
      }).catch(() => {
        setReviewOverlays((previous) => {
          if (previous[resource] !== completedAt) return previous;
          const next = { ...previous };
          delete next[resource];
          return next;
        });
      });
    },
    [effectiveReviewedAt, port, projection, read, sessionCache],
  );

  /**
   * The shared lifecycle behind send/takeover: an entry appears in the SAME
   * frame as the click, the reply's `opId` links it to the operation stream,
   * and a refusal keeps the entry with the Host's sentence AND puts the text
   * back in that session's draft when it never became authoritative — a
   * refused send must cost a retry, not a retype. Receipts are consumed, never
   * `void`-discarded.
   */
  const trackSend = useCallback(
    (
      resource: string,
      prompt: string,
      kind: PendingSend["kind"],
      call: () => Promise<SessionsReply>,
      operationAcknowledges = false,
    ): void => {
      const key = `${resource}#${++nextSendSeq.current}`;
      const latestProjection = port.snapshot().projection;
      const latestProjectionSequence = observeProjection(latestProjection);
      const window = displayedTranscript(latestProjection, resource);
      setPendingSends((previous) => {
        const pending: PendingSend = {
          key, resource, prompt, kind, phase: "sending", message: "",
          projectionSequence: latestProjectionSequence, absoluteMessageEnd: absoluteMessageEnd(window),
          ...(operationAcknowledges ? { operationAcknowledges: true } : {}),
        };
        const next = [...previous, pending];
        const bounded = next.length > PENDING_SENDS_MAX ? next.slice(next.length - PENDING_SENDS_MAX) : next;
        return bounded;
      });
      void (async () => {
        let reply: SessionsReply;
        try {
          reply = await call();
        } catch {
          // A transport throw cannot prove whether the non-idempotent input
          // reached its destination. Do not expose exception/stack details.
          reply = { ok: false, code: "dispatch_failed", result: null, message: "连接中断，无法确认消息是否送达" };
        }
        if (!sendScope.active) return;
        if (reply.ok) {
          const result = (reply.result ?? null) as { opId?: unknown } | null;
          const opId = typeof result?.opId === "string" ? result.opId : "";
          setPendingSends((previous) => {
            // The Host joins an identical send to the operation still live
            // for it, so a second click returns the first click's opId. One
            // operation carries one message: keep its existing echo only,
            // otherwise the second bubble outlives the delivered message.
            if (opId && previous.some((entry) => entry.key !== key && entry.opId === opId)) {
              return previous.filter((entry) => entry.key !== key);
            }
            const linked = previous.map((entry): PendingSend => {
              if (entry.key !== key) return entry;
              // Acceptance is not delivery. Missing correlation must never
              // erase the message or leave a spinner that cannot settle.
              return opId ? { ...entry, phase: "submitted", opId }
                : { ...entry, phase: "uncertain", message: "请求已受理，但未收到发送结果" };
            });
            // A fast operation frame can beat its proposal receipt in transit.
            // Linking the opId must consume the operation snapshot
            // already in hand; waiting for another frame strands the overlay.
            const next = reconcilePendingSendOperations(linked, port.snapshot().operations);
            return next;
          });
          return;
        }
        const replyProjection = port.snapshot().projection;
        const replyProjectionSequence = observeProjection(replyProjection);
        setPendingSends((previous) => {
          const reconciled = reconcileAuthoritativeSends(previous, replyProjection, replyProjectionSequence);
          const next = reconciled.map((entry) => entry.key === key
            ? {
                ...entry,
                phase: reply.code === "backend_unavailable" || reply.code === "dispatch_failed"
                  ? "uncertain" as const : "refused" as const,
                message: String(reply.message ?? "").slice(0, 240) || "动作被拒绝",
              }
            : entry);
          return next;
        });
      })();
    },
    [displayedTranscript, observeProjection, port, sendScope],
  );

  const storeControlRelease = useCallback((resource: string, value: PendingControlRelease | null): void => {
    const next = { ...controlReleasesRef.current };
    if (value) next[resource] = value;
    else delete next[resource];
    const keys = Object.keys(next);
    if (keys.length > PENDING_SENDS_MAX) {
      for (const key of keys.filter((entry) => entry !== resource).slice(0, keys.length - PENDING_SENDS_MAX)) {
        delete next[key];
      }
    }
    controlReleasesRef.current = next;
    setControlReleases(next);
  }, []);

  const releaseControl = useCallback((resource: string | null): void => {
    if (!resource) return;
    const current = controlReleasesRef.current[resource];
    if (current && ["sending", "submitted", "running"].includes(current.phase)) return;
    storeControlRelease(resource, { resource, phase: "sending", message: "" });
    void port.releaseControl(resource).then((reply) => {
      if (!sendScope.active) return;
      if (!reply.ok) {
        storeControlRelease(resource, {
          resource,
          phase: "refused",
          message: String(reply.message ?? "").slice(0, 240) || "可信外层拒绝了这次放锁请求",
        });
        return;
      }
      const result = (reply.result ?? null) as { opId?: unknown } | null;
      const opId = typeof result?.opId === "string" ? result.opId : "";
      storeControlRelease(resource, opId
        ? { resource, phase: "submitted", opId, message: "" }
        : {
            resource,
            phase: "failed",
            message: "放锁请求已接收，但没有可追踪的 operation；请刷新会话状态后再判断。",
          });
    }).catch(() => {
      if (!sendScope.active) return;
      storeControlRelease(resource, {
        resource,
        phase: "failed",
        message: "放锁请求没有送达可信外层；当前仍按占用未释放处理。",
      });
    });
  }, [port, sendScope, storeControlRelease]);

  const sessionAtAction = useCallback((resource: string): SessionSummary | null => {
    const source = port.snapshot().projection;
    const row = projectedSession(source, resource) ?? sessionCache.get(resource)
      ?? (retainedSession.current?.resourceId === resource ? retainedSession.current : null);
    if (!row) return null;
    const runtime = currentRuntimeOf(row.runtime, displayedTranscript(source, resource)?.runtime);
    return runtime === row.runtime ? row : { ...row, runtime };
  }, [displayedTranscript, port, sessionCache]);

  const send = useCallback(
    (resource: string | null, prompt: string): void => {
      if (!resource || !prompt.trim()) return;
      const session = sessionAtAction(resource);
      if (session?.inputMode === "parent_owned") return;
      const operationAcknowledges = operationAcknowledgesNativeCommand(session, prompt);
      // A live session takes an append; an idle one has to be resumed first.
      // Both are execute operations, and both are approved one at a time
      // outside this frame.
      const capabilities = session?.runtime?.capabilities;
      const append = capabilities?.protocol_append === true || capabilities?.terminal_append === true
        || capabilities?.append_when_idle === true
        || (capabilities?.managed_resume !== true && session?.status === "live");
      if (append) {
        // A live terminal/native append inherits its existing policy. The
        // selected value is still carried as the fallback in case that
        // attachment ends between this projection and device execution.
        trackSend(resource, prompt, "append", () => port.append(
          resource,
          prompt,
          selectedAgentProfile(session, resource, permissionProfiles),
          selectedAgentEffort(session, resource, efforts, "append"),
          selectedAgentModel(session, resource, models, "append"),
        ), operationAcknowledges);
      } else {
        trackSend(resource, prompt, "resume", () => port.resume(
          resource,
          prompt,
          selectedAgentProfile(session, resource, permissionProfiles),
          selectedAgentEffort(session, resource, efforts, "resume"),
          selectedAgentModel(session, resource, models, "resume"),
        ), operationAcknowledges);
      }
    },
    [efforts, models, permissionProfiles, port, sessionAtAction, trackSend],
  );

  /**
   * Propose one launch and CONSUME its receipt (ticket #191).
   *
   * The old body was `port.start(...)` and nothing else: the promise went to a
   * `void` at the call site, so the Host's refusal sentence — the one thing
   * that could have explained an unchanged screen — was thrown away by the
   * View that asked for it. Every branch below ends in a phase the form can
   * render, including the two that used to be indistinguishable from success:
   * a refusal, and a transport that never answered.
   *
   * The effort is still clamped on the way out with the SAME function the form
   * renders with, so the value on the approval card is the value on screen.
   */
  const startNewSession = useCallback(async (prompt?: string): Promise<SessionsReply> => {
    const workspace = newSession.advanced
      ? workspaces[newSession.device]?.workspaces?.find((row) => row.id === newSession.workspaceId)
      : undefined;
    const request = {
      device: newSession.device,
      runtimeDevice: newSession.advanced
        ? newSession.runtimeDevice || newSession.device
        : undefined,
      directory: newSession.advanced ? "" : newSession.directory,
      ...(workspace
        ? {
            workspaceId: workspace.id,
            workspaceLabel: workspace.label,
            workspaceDisplay: workspace.display,
          }
        : {}),
      ...(newSession.source === "codex" ? { codexAccount: newSession.codexAccounts?.[newSession.advanced
        ? newSession.runtimeDevice || newSession.device : newSession.device] } : {}),
      source: newSession.source,
      // Only ever sent when it is on: an absent field is the plain lane, and
      // an older trusted side that does not know the flag reads the same thing.
      ...(newSession.translatePrompt ? { translatePrompt: true } : {}),
      model: newSession.model,
      effort: normalizeEffort(newSession.source, newSession.effort),
      permissionProfile: newSession.permissionProfile,
      prompt: prompt ?? newSession.prompt,
    };
    if (launchRef.current && ["sending", "submitted", "running", "uncertain"].includes(launchRef.current.phase)) {
      // The click already in flight IS this click's answer. Proposing again
      // would be a second launch nobody asked for.
      return { ok: false, message: "上一次启动还在提交中" };
    }
    const pending: PendingLaunch = {
      key: `launch#${++nextLaunchSeq.current}`,
      device: request.device,
      directory: request.directory,
      phase: "sending",
      prompt: request.prompt,
      message: "",
    };
    launchRef.current = pending;
    setLaunch(pending);
    const draftSubmission = draftStore.beginSubmission(NEW_SESSION_PROMPT_DRAFT_RESOURCE);
    const settle = (patch: Partial<PendingLaunch>): void => {
      const current = launchRef.current;
      // A newer launch owns the form; an old answer may not repaint it.
      if (!sendScope.active || !current || current.key !== pending.key) return;
      const next = { ...current, ...patch };
      launchRef.current = next;
      setLaunch(next);
    };
    let reply: SessionsReply;
    try {
      reply = await port.start(request);
    } catch {
      // The port's contract is that a refusal is an ANSWER, so a throw is a
      // transport fault rather than a decision. It still may not be silent.
      const message = "启动请求结果未确认；请核对原操作和会话列表，不要重复启动。";
      settle({ phase: "uncertain", message });
      return { ok: false, message };
    }
    if (!sendScope.active) return reply;
    if (!reply.ok) {
      if (reply.code !== "backend_unavailable" && reply.code !== "dispatch_failed") {
        draftStore.restoreSubmission(draftSubmission);
      }
      settle({
        phase: reply.code === "backend_unavailable" || reply.code === "dispatch_failed" ? "uncertain" : "refused",
        message: String(reply.message ?? "").slice(0, 240) || "启动请求被拒绝",
      });
      return reply;
    }
    const result = (reply.result ?? null) as { opId?: unknown } | null;
    const opId = typeof result?.opId === "string" ? result.opId : "";
    if (opId) {
      launchDraftsByOperation.current.set(opId, draftSubmission);
      // A fast provider can publish the terminal operation before the proposal
      // receipt reaches this continuation. Reconcile that exact snapshot now;
      // a later projection will take the ordinary effect path above.
      const operation = port.snapshot().operations.find((row) => String(row.id ?? "") === opId);
      const outcome = operationOutcomePhase(operation?.status);
      if (outcome === "succeeded") {
        draftStore.completeSubmission(draftSubmission);
        launchDraftsByOperation.current.delete(opId);
      } else if (outcome === "failed" || outcome === "refused") {
        draftStore.restoreSubmission(draftSubmission);
        launchDraftsByOperation.current.delete(opId);
      }
    }
    // An accepted response without an operation cannot establish delivery.
    // Keep its text visible as uncertain; never replay it automatically.
    settle(opId ? { phase: "submitted", opId, message: "" } : { phase: "uncertain", message: "请求已受理，但操作编号未返回；请核对会话列表，不要重复启动。" });
    return reply;
  }, [draftStore, newSession, port, sendScope, workspaces]);

  const setNewSession = useCallback((patch: Partial<NewSessionDraft>): void => {
    if (typeof patch.prompt === "string") {
      draftStore.set(NEW_SESSION_PROMPT_DRAFT_RESOURCE, patch.prompt);
    }
    setDraft((previous) => ({ ...previous, ...patch }));
  }, [draftStore]);

  // Derive the visible ledger in the same render that receives the transcript;
  // the effect above persists identical tombstones for later frames. Waiting
  // for that effect alone would paint one frame containing both bubbles.
  const reconciledSends = useMemo(() => reconcileAuthoritativeSends(
    pendingSends, projection, projectionSequence,
  ), [pendingSends, projection, projectionSequence]);

  return useMemo<SessionsController>(
    () => ({
      snapshot,
      projection,
      ready: snapshot.phase === "open" && projection !== null,
      phase: snapshot.phase,
      sessions,
      roster,
      devices,
      workspaces,
      placementDevices,
      openShare: (shareId: string) => port.openShare?.(shareId) ?? Promise.resolve({ ok: false, message: "当前应用未接入共享会话" }),
      operations: snapshot.operations,
      refusal: snapshot.refusal,
      selected,
      current,
      selectedAbsent,
      transcriptBusy: transcriptRefreshingResources.length > 0,
      rosterRefreshing: projection?.resourceState === "loading"
        || (rosterRead?.port === port && rosterRead.busy),
      transcriptRefreshing: (resource) => Boolean(resource && transcriptRefreshingResources.includes(resource)),
      newSession,
      launch,
      workspaceReveal,
      sessionOf: (resource) => {
        const raw = projectedSession(projection, resource)
          ?? (resource ? sessionCache.get(resource) ?? null : null)
          ?? (resource && retainedSession.current?.resourceId === resource ? retainedSession.current : null);
        return raw ? withCustomTitle(raw, projection?.customTitles) : null;
      },
      sessionAbsent: (resource) =>
        resource !== null && rosterSettled && projectedSession(projection, resource) === null,
      windowOf: (resource) =>
        displayedTranscript(projection, resource ?? null),
      resolvedInteractionOf: (resource) => resource ? resolvedInteractions[resource] ?? null : null,
      pendingSendsOf: (resource) => resource
        ? reconciledSends.filter((entry) => entry.resource === resource && !entry.acknowledgedBy && !entry.dismissed)
        : [],
      controlReleaseOf: (resource) => resource ? controlReleases[resource] ?? null : null,
      interruptOf: (resource) => resource ? interrupts[resource] ?? null : null,
      dismissSend: (key) =>
        setPendingSends((previous) => previous.map((entry) =>
          entry.key === key && ["refused", "failed", "uncertain", "done"].includes(entry.phase)
            ? { ...entry, dismissed: true } : entry)),
      draftOf,
      setDraft: setSessionDraft,
      subscribeDraft,
      permissionProfileOf: (resource) => permissionProfiles[resource ?? ""] ?? AGENT_PERMISSION_PROFILES.fullAccess,
      setPermissionProfile: (resource, profile) => {
        if (!resource) return;
        setPermissionProfiles((previous) => ({ ...previous, [resource]: profile }));
      },
      modelOf: (resource) => models[resource ?? ""] ?? "",
      setModel: (resource, model) => {
        if (!resource) return;
        setModels((previous) => ({ ...previous, [resource]: model }));
      },
      effortOf: (resource) => efforts[resource ?? ""] ?? "",
      setEffort: (resource, effort) => {
        if (!resource) return;
        setEfforts((previous) => ({ ...previous, [resource]: effort }));
      },
      groupOverridesOf: (resource) => resource ? groupOverrides[resource] ?? EMPTY_OVERRIDES : EMPTY_OVERRIDES,
      setGroupOverride: (resource, groupKey, open) => {
        if (!resource || !groupKey) return;
        setGroupOverrides((previous) => {
          const forResource = { ...(previous[resource] ?? {}) };
          forResource[groupKey] = open;
          const keys = Object.keys(forResource);
          const excess = keys.length - GROUP_OVERRIDES_MAX;
          if (excess > 0) for (const key of keys.slice(0, excess)) delete forResource[key];
          return { ...previous, [resource]: forResource };
        });
      },
      revealWorkspace,
      settleWorkspaceReveal,
      select,
      refresh: refreshSessions,
      search: (query, cursor) => void port.search(query, 15, cursor),
      browseSessions: port.browseSessions?.bind(port),
      readBlock: port.readBlock?.bind(port),
      read,
      ensureTranscript,
      retainTranscript,
      loadOlder: (resource) => {
        const data = displayedTranscript(projection, resource ?? null);
        const offset = Math.max(0, Number(data?.offset ?? 0));
        const take = Math.min(TRANSCRIPT_PAGE, offset);
        if (take > 0) read(resource ?? null, take, offset - take);
      },
      requestWorkspaces,
      send,
      takeover: (resource, prompt) => {
        const session = resource ? sessionAtAction(resource) : null;
        // An Agent started elsewhere (terminal TUI, hook-observed CLI) cannot
        // change model/effort through an ordinary send; the explicit takeover
        // that stops that exact CLI is the route where the choice applies.
        if (resource && prompt.trim() && session?.inputMode !== "parent_owned") trackSend(resource, prompt, "takeover", () => port.takeover(
          resource,
          prompt,
          selectedAgentProfile(session, resource, permissionProfiles),
          selectedAgentEffort(session, resource, efforts, "takeover"),
          selectedAgentModel(session, resource, models, "takeover"),
        ), operationAcknowledgesNativeCommand(session, prompt));
      },
      fallback: (resource, prompt) => {
        const session = resource ? sessionAtAction(resource) : null;
        if (resource && prompt.trim() && session?.inputMode !== "parent_owned") trackSend(resource, prompt, "fallback", () => port.fallback(
          resource,
          prompt,
          selectedAgentProfile(session, resource, permissionProfiles),
          selectedAgentEffort(session, resource, efforts, "fallback"),
          selectedAgentModel(session, resource, models, "fallback"),
        ));
      },
      interrupt: (resource) => {
        const session = resource ? sessionAtAction(resource) : null;
        if (!resource || session?.inputMode === "parent_owned") return;
        const previous = interruptsRef.current[resource];
        if (previous && ["sending", "submitted", "running"].includes(previous.phase)) return;
        const request: PendingInterrupt = { resource, phase: "sending", message: "" };
        storeInterrupt(request);
        void (async () => {
          let reply: SessionsReply;
          try { reply = await port.interrupt(resource); }
          catch { reply = { ok: false, code: "dispatch_failed", message: "连接中断，无法确认停止结果。" }; }
          if (!sendScope.active || interruptsRef.current[resource] !== request) return;
          const result = reply.result as { opId?: unknown } | null;
          const opId = typeof result?.opId === "string" ? result.opId : "";
          const uncertain = reply.code === "backend_unavailable" || reply.code === "dispatch_failed" || (reply.ok && !opId);
          const entry: PendingInterrupt = {
            resource,
            phase: uncertain ? "uncertain" : reply.ok ? "submitted" : "refused",
            ...(opId ? { opId } : {}),
            message: uncertain ? "停止结果尚未确认；会话仍可继续查看。"
              : reply.ok ? "" : String(reply.message ?? "").slice(0, 240) || "停止请求被拒绝。",
          };
          storeInterrupt(advanceInterrupt(entry, port.snapshot().operations));
        })();
      },
      releaseControl,
      dismissControlRelease: (resource) => {
        if (!resource) return;
        const current = controlReleasesRef.current[resource];
        if (current && ["sending", "submitted", "running"].includes(current.phase)) return;
        storeControlRelease(resource, null);
      },
      respondInteraction: async (resource, interactionId, response) => {
        if (!resource || !interactionId) throw new Error("这个 Agent 请求已经结束");
        // Capture the exact public envelope before the Host's success
        // projection clears it. That projection can arrive before the proposal
        // promise resolves and may remount a module, so component-local state
        // is not a sufficient receipt store.
        const summary = sessions.find((row) => row.resourceId === resource);
        const projected = currentRuntimeOf(
          summary?.runtime,
          displayedTranscript(projection, resource)?.runtime,
        )?.interaction;
        const reply = await port.respondInteraction(resource, interactionId, response);
        if (!sendScope.active) return;
        if (!reply.ok) throw new Error(reply.message || "回答 Agent 请求失败");
        if (projected && String(projected.id) === interactionId) {
          setResolvedInteractions((previous) => {
            const next = {
              ...previous,
              [resource]: { interaction: projected, response: interactionReceiptResponse(projected, response) },
            };
            const excess = Object.keys(next).length - RESOLVED_INTERACTION_RECEIPTS_MAX;
            if (excess > 0) {
              for (const key of Object.keys(next).filter((key) => key !== resource).slice(0, excess)) delete next[key];
            }
            return next;
          });
        }
        // The broker removed the pending interaction before acknowledging this
        // response. Refresh the authoritative roster immediately so a stale
        // transcript runtime cannot keep presenting it as unanswered.
        refreshSessions();
        read(resource, TRANSCRIPT_PAGE);
      },
      pin: (resource) => void port.pin(resource ?? ""),
      organize: Boolean(port.setPinned && port.saveFolder && port.deleteFolder && port.fileSessions),
      setPinned: async (resources, pinned) => {
        if (!port.setPinned) return UNSUPPORTED_ORGANIZE;
        // One App action per chat, in order; the first refusal stops the batch.
        let last: SessionsReply = { ok: true, code: undefined, result: null, message: "" };
        for (const resource of resources) {
          last = await port.setPinned(resource, pinned);
          if (!last.ok) break;
        }
        return last;
      },
      saveFolder: (folder, name) => port.saveFolder ? port.saveFolder(folder, name) : Promise.resolve(UNSUPPORTED_ORGANIZE),
      deleteFolder: (folder) => port.deleteFolder ? port.deleteFolder(folder) : Promise.resolve(UNSUPPORTED_ORGANIZE),
      fileSessions: async (resources, folder) => {
        if (!port.fileSessions) return UNSUPPORTED_ORGANIZE;
        let last: SessionsReply = { ok: true, code: undefined, result: null, message: "" };
        for (let start = 0; start < resources.length; start += FILE_BATCH) {
          last = await port.fileSessions(resources.slice(start, start + FILE_BATCH), folder);
          if (!last.ok) break;
        }
        return last;
      },
      readContinuation: resource => port.readContinuation?.(resource) ?? Promise.resolve({ ok: false, message: "当前页面不支持续接设置" }),
      saveContinuation: (resource, prompt, revision) => port.saveContinuation?.(resource, prompt, revision) ?? Promise.resolve({ ok: false, message: "当前页面不支持续接设置" }),
      setTitle: (resource, title) => resource
        ? port.setTitle(resource, title)
        : Promise.resolve({ ok: false, code: "invalid_resource", result: null, message: "当前没有可命名的会话。" }),
      attachFile: async (resource, file, onProgress) => {
        if (!resource) return { ok: false as const, message: "当前没有可上传文件的会话。" };
        if (!file.size) return { ok: false as const, message: "不能上传空文件。" };
        if (!Number.isSafeInteger(file.size) || file.size < 0) {
          return { ok: false as const, message: "文件大小无法准确读取。" };
        }
        const chunkCount = Math.ceil(file.size / CHAT_ATTACHMENT_CHUNK_BYTES);
        let uploadId = "";
        try {
          for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
            if (!sendScope.active) return { ok: false as const, message: "会话视图已关闭，上传已停止。" };
            const start = chunkIndex * CHAT_ATTACHMENT_CHUNK_BYTES;
            const data = base64Of(
              await file.slice(start, Math.min(file.size, start + CHAT_ATTACHMENT_CHUNK_BYTES)).arrayBuffer(),
            );
            if (!sendScope.active) return { ok: false as const, message: "会话视图已关闭，上传已停止。" };
            const reply = await port.attachFile({
              ...(typeof resource === "string" ? { resource } : resource),
              name: file.name || "upload.bin",
              mediaType: file.type || "application/octet-stream",
              chunkIndex,
              chunkCount,
              ...(uploadId ? { uploadId } : {}),
              data,
            });
            if (!sendScope.active) return { ok: false as const, message: "会话视图已关闭，上传结果未采用。" };
            if (!reply.ok) return { ok: false as const, message: reply.message || "文件上传被拒绝。" };
            const result = reply.result as {
              upload_id?: unknown;
              complete?: unknown;
              attachment?: { label?: unknown; path?: unknown; bytes?: unknown };
            } | null;
            if (!result || typeof result.upload_id !== "string" || !result.upload_id) {
              return { ok: false as const, message: "上传没有返回有效回执。" };
            }
            uploadId = result.upload_id;
            onProgress?.(Math.min(file.size, start + CHAT_ATTACHMENT_CHUNK_BYTES), file.size);
            if (chunkIndex < chunkCount - 1) {
              if (result.complete === true) return { ok: false as const, message: "上传过早结束。" };
              continue;
            }
            const stored = result.attachment;
            if (
              result.complete !== true
              || !stored
              || typeof stored.path !== "string"
              || !stored.path
            ) {
              return { ok: false as const, message: "上传没有返回文件位置。" };
            }
            return {
              ok: true as const,
              attachment: {
                label: typeof stored.label === "string" && stored.label ? stored.label : file.name || "upload.bin",
                path: stored.path,
                bytes: typeof stored.bytes === "number" ? stored.bytes : file.size,
              },
            };
          }
        } catch {
          return { ok: false as const, message: "文件读取或上传失败。" };
        }
        return { ok: false as const, message: "文件上传没有完成。" };
      },
      openTerminal: (device, workspaceId, size) => port.openTerminal(device, workspaceId, size),
      readTerminal: (device, terminalId, size) => port.readTerminal(device, terminalId, size),
      sendTerminal: (device, terminalId, input, size) => port.sendTerminal(device, terminalId, input, size),
      closeTerminal: (device, terminalId) => port.closeTerminal(device, terminalId),
      setNewSession,
      prefillNewSession: (device, directory) =>
        setDraft((previous) => ({
          ...previous,
          advanced: false,
          workspaceId: "",
          // A row's `＋` fills both; a global entry leaves whatever was last
          // typed, so switching back and forth does not throw away a
          // half-written request.
          device: device || (previous.device ? previous.device : devices.length === 1 ? devices[0] : previous.device),
          directory: directory || previous.directory,
        })),
      startNewSession,
      // Everything except the in-flight moment can be dismissed. A submitted
      // launch whose reply carried no opId can never be advanced by the
      // operation stream, so refusing to clear it would leave the form
      // permanently disabled — the person gets an explicit way out, and
      // choosing it is a choice rather than a silent second launch.
      dismissLaunch: () => setLaunch((previous) => (previous && previous.phase !== "sending" ? null : previous)),
      clearRefusal: () => port.clearRefusal(),
    }),
    [
      snapshot,
      projection,
      sessions,
      rawSessions,
      roster,
      devices,
      workspaces,
      placementDevices,
      selected,
      current,
      selectedAbsent,
      transcriptRefreshingResources,
      rosterRead,
      newSession,
      launch,
      workspaceReveal,
      revealWorkspace,
      settleWorkspaceReveal,
      startNewSession,
      setNewSession,
      resolvedInteractions,
      reconciledSends,
      controlReleases,
      interrupts,
      storeInterrupt,
      draftOf,
      setSessionDraft,
      subscribeDraft,
      permissionProfiles,
      models,
      efforts,
      groupOverrides,
      sessionCache,
      sessionAtAction,
      transcriptCache,
      displayedTranscript,
      select,
      read,
      ensureTranscript,
      retainTranscript,
      requestWorkspaces,
      send,
      trackSend,
      releaseControl,
      storeControlRelease,
      refreshSessions,
      port,
      sendScope,
    ],
  );
}
