import type { CodexTokenUsage } from "./usage.js";
/**
 * `agent-sessions/v1` — the projected shape, and nothing more.
 *
 * Every field here is something a trusted coordinator copies out through an
 * explicit allow-list. That IS the contract: what reaches a sessions module is
 * declassified to it, and what is not on that list does not exist on this side.
 * There is no `owner`, no canonical path, no device root, no context id and no
 * grant — not because they are filtered here, but because they never cross.
 *
 * The types are `?`-heavy on purpose. A projection is data from another program
 * that may be older or newer than this build, so every reader treats a missing
 * field as absent rather than assuming the current shape.
 *
 * ── Why this is a package and not an interface in the view ──────────────────
 *
 * Three things need to agree about it and only one of them renders: the module
 * that draws it, the App adapter that maps a transport onto it, and any second
 * consumer (a read-only harness, a test double, eventually another App). A shape
 * that lived in the view package would make every one of those depend on React.
 */

export interface Activity {
  state?: string;
  tool?: string;
  since?: string;
  observed_at?: string;
  degraded?: boolean;
}

export interface AgentInteractionOption {
  label?: string;
  description?: string;
}

export interface AgentInteractionQuestion {
  id?: string;
  header?: string;
  prompt?: string;
  options?: AgentInteractionOption[];
  multiple?: boolean;
  allow_other?: boolean;
  secret?: boolean;
}

/** One provider-originated, single-use request currently blocking an Agent. */
export interface AgentInteraction {
  id?: string;
  provider?: CliKind | string;
  kind?: "question" | "permission" | string;
  title?: string;
  description?: string;
  tool?: string;
  detail?: string;
  questions?: AgentInteractionQuestion[];
  created_at?: string;
  expires_at?: string;
  status?: "pending" | "resolved" | string;
  resolved_at?: string;
  resolution?: {
    decision?: "allow" | "deny" | string;
    summary?: string;
  };
  capabilities?: {
    respond?: boolean;
    allow?: boolean;
    deny?: boolean;
  };
}

/** `omp_terminal` is `hook_observer`'s discovered counterpart: omp publishes
 * its own tty→session breadcrumbs, so "observed" never means a missing hook. */
export interface AgentAttachment {
  kind?: "hook_observer" | "terminal_tmux" | "claude_sdk" | "codex_app_server" | "omp_rpc" | "omp_terminal" | "legacy_exec" | "none" | string;
  state?: "attached" | "observed" | "detached" | "unknown" | string;
  transport?: "tmux" | "agent-sdk" | "app-server" | "omp-rpc" | "exec" | string;
}

export interface AgentControlLease {
  holder?: "none" | "terminal" | "protocol" | string;
  acquired_at?: string;
}

export interface AgentTurn {
  state?: "working" | "needs_input" | "idle" | "unknown" | string;
  id?: string;
  started_at?: string;
}

/** Hook-derived facts only. No pid, process group, transcript path or cwd. */
export interface AgentRuntime {
  /** Durable Runner recovery fact, independent of process liveness or input acceptance. */
  recovery?: { state: "reconnecting" | "waiting_resource" | "waiting_capacity" | "unknown";
    since?: string; retry_at?: string; attempts?: number; max_attempts?: number; deadline_at?: string };
  process_state?: "alive" | "exited" | "unknown" | string;
  turn_state?: "working" | "idle" | "needs_input" | "unknown" | string;
  control_mode?: "external_cli" | "octopus_headless" | "unknown" | string;
  observed_at?: string;
  event?: string;
  tool?: string;
  degraded?: boolean;
  attachment?: AgentAttachment;
  control_lease?: AgentControlLease;
  turn?: AgentTurn;
  capabilities?: {
    observe?: boolean;
    append_when_idle?: boolean;
    takeover?: boolean;
    interrupt?: boolean;
    steer?: boolean;
    respond?: boolean;
    terminal_append?: boolean;
    managed_resume?: boolean;
    protocol_append?: boolean;
    /**
     * Automatic cleanup of one Runner-owned Codex app-server failed after its
     * turn settled. The human may request release of that exact attachment.
     * Absent/false never authorises a generic process or shared-host restart.
     */
    release_control?: boolean;
    /**
     * `interrupt` exists, but as one stop keystroke into the person's own
     * terminal rather than a provider-level interrupt. Absent means the Host
     * made no statement (an older Runner), which is not the same as `false`.
     */
    terminal_interrupt?: boolean;
  };
  interaction?: AgentInteraction;
}

export interface SessionSummary {
  usage?: CodexTokenUsage;
  shared?: boolean;
  sharedPromptAllowed?: boolean;
  resourceId: string;
  /**
   * The reporting device was absent from the latest successful roster frame,
   * so this row is the bounded last-known fact. Absent means current; this is
   * display metadata only and grants no authority over the session.
   */
  stale?: boolean;
  /**
   * Opaque equality token for this session's working directory, minted by the
   * trusted coordinator. Equal keys mean "the same real directory" across this
   * projection and a `workspace-files/v2` file projection. Absent means "not
   * promised" — a consumer must NOT fall back to comparing labels, basenames or
   * display paths, which is exactly the guess this field exists to remove.
   */
  directoryKey?: string;
  deviceId?: string;
  deviceLabel?: string;
  /**
   * Device whose registered workspace owns the navigation/archive location.
   * It may differ from deviceId when the provider process is remotely placed;
   * resource operations continue to use resourceId/deviceId.
   */
  directoryDeviceId?: string;
  cliKind?: string;
  sessionId?: string;
  /** Compact account marker (`a`/`b`) with no provider identity or path. */
  accountLabel?: string;
  projectLabel?: string;
  cwdDisplay?: string;
  lastActivity?: string;
  /**
   * Stable navigation key: max(last real user prompt, last completed agent
   * turn). Providers compute it with their cached summary; Views never scan a
   * transcript to sort.
   */
  sortActivity?: string;
  /** Last completed agent turn; absent until a terminal turn is observed. */
  completedAt?: string;
  status?: string;
  resumable?: boolean;
  /**
   * The provider declared this thread to be owned by its parent. The View may
   * observe it, but must not invent a direct-input route when this is present.
   */
  inputMode?: "parent_owned";
  /**
   * Opaque trusted resource for declared lineage, also used to fold navigation.
   * Lineage alone does not imply parent_owned input mode. Absence means no safe
   * navigation target; labels and agent paths are never substitutes.
   */
  parentResourceId?: string;
  /** Provider-declared non-interactive runs, grouped separately from parents. */
  executionMode?: "exec";
  activity?: Activity | null;
  runtime?: AgentRuntime | null;
  messageCount?: number;
  /** Provider-owned display title; absent when the CLI does not name chats. */
  title?: string;
  preview?: string;
  firstUserText?: string;
}

export interface RichBlock {
  type?: string;
  text?: string;
  tool?: string;
  input?: string;
  /** Native Codex async-question identity; display/correlation only, never authority. */
  call_id?: string;
  /** Absent means the call has no recorded result yet. */
  output?: string | null;
  is_error?: boolean;
  truncated?: boolean;
  /**
   * Which fields this page capped. Present only from a Runner that can read
   * the complete block (`readBlock`); older Runners send `truncated` alone.
   */
  truncated_fields?: Array<"text" | "input" | "output">;
  /** Device-local Claude translation; tools and thinking blocks never carry it. */
  bilingual?: { zh: string; en: string };
  /** Honest degraded state when Claude succeeded but the return translation failed. */
  translation_error?: string;
}

export interface RichMessage {
  role?: string;
  timestamp?: string;
  blocks?: RichBlock[];
  /** Pre-rich Runners sent these two instead of `blocks`. */
  text?: string;
  tool?: string;
}

/**
 * The source snapshot that produced one transcript window.
 *
 * `sequence` is comparable only while `epoch` is equal. A different epoch is
 * an explicit source-incarnation boundary (for example a Runner restart), not
 * a very large or very small sequence. This is display freshness evidence;
 * it is never a resource identity or an authority.
 */
export interface TranscriptVersion {
  epoch: string;
  sequence: number;
}

export type TranscriptVersionRelation = "older" | "same" | "newer" | "reset" | "unknown";

const TRANSCRIPT_VERSION_EPOCH = /^[A-Za-z0-9_-]{8,64}$/;

/** Defensively read the additive transcript freshness envelope. */
export function transcriptVersionOf(value: unknown): TranscriptVersion | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const version = value as Record<string, unknown>;
  return typeof version.epoch === "string"
    && TRANSCRIPT_VERSION_EPOCH.test(version.epoch)
    && typeof version.sequence === "number"
    && Number.isSafeInteger(version.sequence)
    && version.sequence >= 1
    ? { epoch: version.epoch, sequence: version.sequence }
    : null;
}

/** Compare `incoming` with `current`; different epochs form a reset boundary. */
export function compareTranscriptVersions(
  current: unknown,
  incoming: unknown,
): TranscriptVersionRelation {
  const before = transcriptVersionOf(current);
  const after = transcriptVersionOf(incoming);
  if (!before && !after) return "unknown";
  if (!before) return "newer";
  if (!after) return "older";
  if (before.epoch !== after.epoch) return "reset";
  return after.sequence < before.sequence
    ? "older"
    : after.sequence > before.sequence
      ? "newer"
      : "same";
}

export interface TranscriptWindow {
  /** Latest native turn, not unsent composer/CLI choices; null clears old facts. */
  turnConfiguration?: import("./turn-configuration.js").SessionTurnConfiguration | null;
  usage?: CodexTokenUsage;
  sessionId?: string;
  cliKind?: string;
  deviceLabel?: string;
  rich?: boolean;
  messages?: RichMessage[];
  activity?: Activity | null;
  runtime?: AgentRuntime | null;
  offset?: number | null;
  nextOffset?: number | null;
  totalMessages?: number | null;
  hasMore?: boolean;
  truncated?: boolean;
  /** Per-source freshness; optional for older Hosts and direct fallback reads. */
  version?: TranscriptVersion;
}

/**
 * Reconcile two bounded windows for one append-only transcript.
 *
 * This is shared by the trusted Host and the display cache so source-version
 * semantics cannot drift between them. It combines only overlapping/touching
 * absolute ranges, never invents a gap, and grants no identity or authority.
 */
export function reconcileTranscriptWindows(
  current: TranscriptWindow | null | undefined,
  incoming: TranscriptWindow | null | undefined,
): TranscriptWindow | null {
  if (!current) return incoming ?? null;
  if (!incoming) return current;
  const relation = compareTranscriptVersions(current.version, incoming.version);
  const currentRange = transcriptRange(current);
  const incomingRange = transcriptRange(incoming);
  if (currentRange && !incomingRange) return current;
  if (!currentRange && incomingRange) return incoming;
  if (!currentRange || !incomingRange) {
    return relation === "reset" || relation === "newer" ? incoming : current;
  }
  if (relation === "reset") return incoming;

  const clearlyRegresses = incomingRange.total < currentRange.total
    || incomingRange.end < currentRange.end;
  if (relation === "older") return extendTranscriptPrefix(current, incoming, currentRange, incomingRange);
  if (relation === "same") {
    if (incomingRange.start >= currentRange.start && incomingRange.end <= currentRange.end) return current;
    return mergeTranscriptRanges(current, incoming, currentRange, incomingRange, false);
  }
  if (relation === "newer") {
    const currentVersion = transcriptVersionOf(current.version);
    const incomingVersion = transcriptVersionOf(incoming.version);
    // A newly versioned candidate can replace legacy state. Once both sides
    // name one epoch, a larger sequence cannot justify a smaller frontier.
    if (clearlyRegresses
      && currentVersion !== null
      && incomingVersion !== null
      && currentVersion.epoch === incomingVersion.epoch) {
      // A newer shared cache may supply a requested adjacent history page.
      // Extend only its prefix; it cannot advance this window's live facts.
      if (incomingRange.total < currentRange.total || incomingRange.end !== currentRange.start) return current;
      return {
        ...extendTranscriptPrefix(current, incoming, currentRange, incomingRange),
        activity: current.activity,
        runtime: current.runtime,
      };
    }
    return mergeTranscriptRanges(current, incoming, currentRange, incomingRange, true);
  }
  return clearlyRegresses
    ? extendTranscriptPrefix(current, incoming, currentRange, incomingRange)
    : mergeTranscriptRanges(current, incoming, currentRange, incomingRange, true);
}

interface TranscriptRange {
  start: number;
  end: number;
  total: number;
}

function transcriptRange(window: TranscriptWindow): TranscriptRange | null {
  const start = Number(window.offset);
  if (!Number.isSafeInteger(start) || start < 0 || !Array.isArray(window.messages)) return null;
  const end = start + window.messages.length;
  const rawTotal = window.totalMessages;
  const declared = Number(rawTotal);
  const hasDeclared = rawTotal !== null && rawTotal !== undefined;
  if (hasDeclared && Number.isSafeInteger(declared) && declared >= 0 && declared < end) return null;
  const total = hasDeclared && Number.isSafeInteger(declared) && declared >= 0 ? declared : end;
  return { start, end, total };
}

function extendTranscriptPrefix(
  current: TranscriptWindow,
  incoming: TranscriptWindow,
  currentRange: TranscriptRange,
  incomingRange: TranscriptRange,
): TranscriptWindow {
  if (incomingRange.start >= currentRange.start || incomingRange.end < currentRange.start) return current;
  const prefixLength = currentRange.start - incomingRange.start;
  const incomingMessages = incoming.messages ?? [];
  if (prefixLength > incomingMessages.length) return current;
  return {
    ...incoming,
    ...current,
    offset: incomingRange.start,
    messages: [...incomingMessages.slice(0, prefixLength), ...(current.messages ?? [])],
    totalMessages: Math.max(currentRange.total, incomingRange.total, currentRange.end),
    hasMore: incomingRange.start > 0,
  };
}

function mergeTranscriptRanges(
  current: TranscriptWindow,
  incoming: TranscriptWindow,
  currentRange: TranscriptRange,
  incomingRange: TranscriptRange,
  incomingWins: boolean,
): TranscriptWindow {
  if (currentRange.end < incomingRange.start || incomingRange.end < currentRange.start) {
    return incomingWins ? incoming : current;
  }
  if (incomingWins && incomingRange.start <= currentRange.start && incomingRange.end >= currentRange.end) {
    return incoming;
  }
  const start = Math.min(currentRange.start, incomingRange.start);
  const end = Math.max(currentRange.end, incomingRange.end);
  const messages = new Array<RichMessage | undefined>(end - start).fill(undefined);
  const place = (offset: number, values: readonly RichMessage[]): void => {
    for (let index = 0; index < values.length; index += 1) messages[offset - start + index] = values[index];
  };
  if (incomingWins) {
    place(currentRange.start, current.messages ?? []);
    place(incomingRange.start, incoming.messages ?? []);
  } else {
    place(incomingRange.start, incoming.messages ?? []);
    place(currentRange.start, current.messages ?? []);
  }
  if (messages.some((message) => message === undefined)) return incomingWins ? incoming : current;
  const preferred = incomingWins ? incoming : current;
  const fallback = incomingWins ? current : incoming;
  return {
    ...fallback,
    ...preferred,
    offset: start,
    messages: messages as RichMessage[],
    totalMessages: Math.max(currentRange.total, incomingRange.total, end),
    hasMore: start > 0,
  };
}

export interface TranscriptStatus {
  resource?: string;
  state?: "live" | "reconnecting" | "closed" | string;
  message?: string;
}

export interface WorkspaceRow {
  id: string;
  label: string;
  display: string;
  /**
   * The same equality token for the workspace's ROOT directory. Equal to a
   * session's `directoryKey` when that session runs at the root itself, and to
   * a `workspace-files/v2` root's key when both projections describe one real
   * directory. Absent means "not promised", never "match by label instead".
   */
  directoryKey?: string;
}

export interface WorkspaceGroup {
  device?: string;
  /** Display only; device remains the stable routing identity. */
  deviceLabel?: string;
  workspaces?: WorkspaceRow[];
  /** Device readiness only; an available terminal still needs its opening approval. */
  terminal?: { available: boolean; reason?: string };
}

export interface SearchHit {
  session?: SessionSummary;
  snippet?: string;
  preview?: string;
  text?: string;
}

export interface SearchResult {
  query?: string;
  /** The cursor this page was asked with; empty/absent is the first page. */
  cursor?: string;
  results?: SearchHit[];
  /** Present while older sessions remain unsearched: ask for it to continue. */
  nextCursor?: string;
  /** False while `nextCursor` remains; absent from providers that predate paging. */
  complete?: boolean;
  /** Devices/planes this page could not search completely (failed or outdated Runner). */
  incompleteSources?: string[];
}

export interface SourceRow {
  kind?: string;
  device?: string;
  deviceLabel?: string;
  online?: boolean;
}
export interface AgentBackendAvailability {
  kind?: CliKind;
  available?: boolean;
  version?: string;
  reason?: string;
  /** Optional path-free detail; legacy reason remains the fallback. */
  diagnosticCode?: string;
  /** Offending local path and rule, only for the viewer's own device. */
  diagnosticPath?: string;
  diagnosticRule?: string;
  splitExecution?: boolean;
  splitExecutionReason?: string;
}

export interface CodexAccountRegistration {
  /** Account-local picker-visible model catalog; absent means discovery failed/unsupported. */
  models?: import("./providers.js").ModelChoice[];
  id: string;
  label: string;
  /** Runner-provided masked subscription email for quota presentation. */
  emailLabel?: string;
  quota?: {
    status: "available" | "unavailable";
    fetchedAt: string;
    windows: Array<{ remainingPercent: number; windowMinutes: number; resetsAt: string }>;
    creditCount?: number;
    /** Earliest expiry among available reset credits reported by the provider. */
    creditExpiresAt?: string;
  };
}

/** Bounded machine facts from one authenticated Runner connection. */
export interface PlacementDevice {
  device?: string;
  /** Display only; device remains the stable routing identity. */
  deviceLabel?: string;
  online?: boolean;
  agentBackends?: AgentBackendAvailability[];
  codexAccounts?: CodexAccountRegistration[];
  execution?: {
    platform?: string;
    arch?: string;
    shell?: boolean;
    workspaceFiles?: boolean;
    workspaceCount?: number;
    codexExecServer?: boolean;
  };
}

export interface PlacementProjection {
  devices?: PlacementDevice[];
}


/**
 * One workspace-plane operation's current standing, as the trusted side
 * computed it. The View renders these rows; it never derives a permission
 * conclusion of its own, and nothing here is an authority — the capability
 * Gate re-decides on every call.
 *
 * The rows describe the ACCOUNT's grant for this App, which is scoped to
 * (owner, operation), not to a directory. A consumer must not present them as
 * per-directory authorization, because no such authorization exists.
 */
export interface WorkspaceAccessRow {
  /** The permission token, e.g. `list_workspace_entries`. Compared, never parsed. */
  operation?: string;
  /** Human title from the trusted catalog. */
  title?: string;
  /** Would a call work right now (before any per-call approval)? */
  effective?: boolean;
  /** May run with no approval card. Never true for an always-approve token. */
  autoAllow?: boolean;
  /** Every call queues an approval card no matter what the grant says. */
  alwaysApprove?: boolean;
  /** One bounded sentence from the trusted side; render verbatim. */
  explanation?: string;
}

/**
 * One user-authored note anchored inside a workspace file preview.
 *
 * The App owns this: it does not describe file bytes or a provider resource,
 * only what the reader wrote *about* those bytes. Anchoring uses the visible
 * text (`quote` + short `prefix`/`suffix`) so the annotation still lands when
 * the underlying file drifts — the fields are display coordinates, not paths.
 * A PDF annotation additionally carries a bounded content hash so a later
 * revision can be surfaced as a version fork instead of silently reattached.
 */
export interface AnnotationTargetMarkdown {
  kind: "markdown";
  quote: string;
  prefix: string;
  suffix: string;
}

export interface AnnotationTargetPdf {
  kind: "pdf-text";
  /** 1-indexed PDF page. */
  page: number;
  quote: string;
  prefix: string;
  suffix: string;
  /** Short hex of the PDF bytes at annotation time; used to detect forks. */
  contentHash: string;
}

export type AnnotationTarget = AnnotationTargetMarkdown | AnnotationTargetPdf;

export interface FileAnnotation {
  /** Opaque view-minted id, stable across projection frames. */
  id: string;
  /** ms since epoch when the reader first saved this annotation. */
  createdAt: number;
  /** ms since epoch of the most recent edit; equals createdAt for fresh notes. */
  updatedAt: number;
  /** Bounded reader-authored text. */
  note: string;
  target: AnnotationTarget;
}

/**
 * One App-owned folder of chats, in the person's own order.
 *
 * Membership names opaque session resources only; a chat belongs to at most
 * one folder. Folders organise navigation. They are not a provider grouping,
 * a directory, a grant or a lifecycle: deleting one only returns its chats to
 * the unfiled list.
 */
export interface SessionFolder {
  /** Opaque View-minted id, stable across frames. */
  id: string;
  /** Bounded plain text. */
  name: string;
  /** Opaque session resources, in filing order. */
  sessions: string[];
}

export interface SessionsProjection {
  sharedSessions?: import("./usage.js").SharedSessionSummary[];
  sharedAccess?: import("./usage.js").SharedSessionSummary;
  sharingAvailable?: boolean;
  notice?: string;
  /** App-owned durable state. The provider does not own it; the App does. */
  pinned?: string[];
  /** App-owned folders in display order. */
  sessionFolders?: SessionFolder[];
  /** App-owned titles keyed by opaque session resource; empty titles are omitted. */
  customTitles?: Record<string, string>;
  /**
   * App-owned acknowledgement keyed by opaque session resource. The value is
   * the latest completed turn the user explicitly opened.
   */
  reviewedAt?: Record<string, string>;
  /**
   * App-owned file annotations keyed by an opaque per-file key the App itself
   * mints from the listing lineage. Empty arrays are omitted so consumers can
   * treat presence as "there is something to show". The provider never owns
   * these; they persist through the App event stream alongside pins/titles.
   */
  fileAnnotations?: Record<string, FileAnnotation[]>;
  sessions?: SessionSummary[];
  sources?: SourceRow[];
  /** Live Runner inventory used only to choose a launch topology; never authority. */
  placement?: PlacementProjection;
  search?: SearchResult;
  /** One explicit, bounded page of the full device catalog; independent of recent rows. */
  sessionHistory?: {
    device: string;
    source: string;
    cursor: string;
    nextCursor?: string;
    hasMore: boolean;
    totalFound: number;
    sessions: SessionSummary[];
  };
  /** A recent window is not evidence that an older session disappeared. */
  rosterTruncated?: boolean;
  /** Device discovery/backfill is progressing; cached primary chats remain usable. */
  rosterIndexPending?: boolean;
  transcript?: Record<string, TranscriptWindow>;
  /** Live-read state belongs to each resource independently of focus. */
  transcriptStatuses?: Record<string, TranscriptStatus>;
  /** @deprecated Compatibility with older hosts; new hosts publish transcriptStatuses. */
  transcriptStatus?: TranscriptStatus;
  workspacesByDevice?: Record<string, WorkspaceGroup>;
  /** The most recent single-device answer; kept for older coordinators. */
  workspaces?: WorkspaceGroup;
  /**
   * The workspace file plane's operation standing for this account+App.
   * Account-wide (the same on every device); absent when the coordinator did
   * not compute it, which a consumer shows as "unknown", never as "granted".
   */
  workspaceAccess?: WorkspaceAccessRow[];
  resourceState?: string;
}

/**
 * The CLI kinds a sessions module offers when starting something new.
 *
 * Product names and per-CLI presentation facts (model suggestions, whether a
 * manual permission profile is even implementable) deliberately live in the
 * view's `lib/cli.ts`, not here: this file is the data ABI, and provider
 * knowledge in it would be the same budget mistake permissions already avoid.
 * The effort ladders are the exception, in `providers.ts`: the Host and the
 * Runner enforce them too, so they have one shared definition.
 */
export const SESSION_CLI_KINDS = ["claude", "codex", "omp"] as const;
export type CliKind = (typeof SESSION_CLI_KINDS)[number];

/** The device name a scan-root source reports; never a Runner. */
export const BOT_HOST_DEVICE = "bot-host";

/**
 * Pick the newest runtime fact without reviving an interaction from an older
 * transcript. The roster wins ties and timestamps we cannot compare.
 */
export function currentRuntimeOf<T extends { observed_at?: unknown }>(
  roster: T | null | undefined,
  transcript: T | null | undefined,
): T | undefined {
  if (!roster) return transcript ?? undefined;
  if (!transcript) return roster;
  const rosterAt = Date.parse(String(roster.observed_at ?? ""));
  const transcriptAt = Date.parse(String(transcript.observed_at ?? ""));
  return Number.isFinite(transcriptAt) && Number.isFinite(rosterAt) && transcriptAt > rosterAt
    ? transcript
    : roster;
}
