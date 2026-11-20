import { readCodexTokenUsage, readSessionTurnConfiguration } from "@claude-bot/agent-sessions-contract";
/** Explicit disclosure allowlists for data that may enter an Agent View. */

import { isRuntimeJson, type RuntimeJson } from "@claude-bot/app-runtime";
import {
  reconcileTranscriptWindows as reconcileProjectedTranscriptWindows,
  transcriptVersionOf,
  type TranscriptWindow,
} from "@claude-bot/agent-sessions-contract";
import { BOT_HOST_DEVICE, stripSessionPath } from "../sessionhub/core.js";
import type { HubSessionSummary } from "../sessionhub/service.js";
import type { WorkspaceDirectorySnapshot } from "../workspace-files/directory-index.js";
import type { Source as ScanSource } from "@claude-bot/plugin-sessions/scan";
import { SESSION_CLI_KINDS } from "../sessionhub/core.js";

/** Full projection frames may carry only this many transcript windows. */
export const MAX_PROJECTED_TRANSCRIPTS = 8;

/** Copy declassified resource output into the bounded JSON vocabulary. */
export function runtimeJson(value: unknown): RuntimeJson {
  let copy: unknown;
  try {
    copy = JSON.parse(JSON.stringify(value));
  } catch {
    throw new Error("resource returned data that cannot cross the App projection boundary");
  }
  if (!isRuntimeJson(copy)) throw new Error("resource returned data outside the App projection limits");
  return copy;
}

/**
 * `normaliseSession` retains legacy aliases for `/sessions`; this projection
 * deliberately does not. Identity is rebound by the coordinator, and the
 * scanner's canonical cwd/path are not part of the App disclosure contract.
 */
export function publicSession(
  entry: HubSessionSummary,
  /**
   * The opaque join key for this session's directory, when the device told us
   * which registered workspace it is in and this scope could mint one.
   *
   * Omitted rather than emptied when absent, because "" would be a value a
   * consumer could compare — and two sessions whose directory is unknown must
   * not look like two sessions in the same directory.
   */
  directoryKey?: string,
): Record<string, RuntimeJson> {
  const runtime = publicRuntime(entry.runtime);
  return {
    ...(directoryKey ? { directoryKey } : {}),
    resourceId: entry.resourceId,
    ...(entry.usage ? { usage: runtimeJson(entry.usage) } : {}),
    ...(entry.stale === true ? { stale: true } : {}),
    deviceId: entry.deviceId,
    deviceLabel: entry.deviceLabel,
    ...(entry.directoryDeviceId ? { directoryDeviceId: entry.directoryDeviceId } : {}),
    cliKind: entry.cliKind,
    ...(entry.cliKind === "codex" && entry.executionMode === "exec" ? { executionMode: "exec" } : {}),
    sessionId: entry.sessionId,
    ...(entry.cliKind === "codex" && /^[a-z]$/.test(entry.accountLabel ?? "")
      ? { accountLabel: entry.accountLabel }
      : {}),
    projectLabel: entry.projectLabel ?? "",
    // A current Runner supplies a display-only ~/… path. Reject absolute or
    // otherwise unrecognised legacy values at this last boundary: canonical
    // cwd remains server-side even if an old Runner sent it to the Host.
    cwdDisplay: publicDirectory(entry),
    lastActivity: entry.lastActivity ?? "",
    sortActivity: boundedText(entry.sortActivity, 64),
    completedAt: boundedText(entry.completedAt, 64),
    status: entry.status,
    resumable: entry.resumable,
    ...(entry.parentResourceId
      ? { parentResourceId: entry.parentResourceId,
        ...(entry.inputMode === "parent_owned" ? { inputMode: entry.inputMode } : {}) }
      : {}),
    activity: publicActivity(entry.activity),
    ...(runtime ? { runtime } : {}),
    ...(Number.isFinite(entry.message_count) && Number(entry.message_count) >= 0
      ? { messageCount: Number(entry.message_count) } : {}),
    title: boundedText(entry.title, 240),
    preview: boundedText(entry.preview, 2_000),
    firstUserText: boundedText(entry.first_user_text, 2_000),
  };
}

function publicDirectory(entry: HubSessionSummary): string {
  const display = boundedText(entry.cwdDisplay, 240).trim().replace(/\\/g, "/");
  const directoryDevice = entry.directoryDeviceId ?? entry.deviceId;
  if (directoryDevice !== BOT_HOST_DEVICE && (display === "~" || display.startsWith("~/"))) return display;
  return boundedText(entry.projectLabel, 240);
}

/** Bounded activity evidence used by the shared live-dot derivation. */
function publicActivity(value: unknown): Record<string, RuntimeJson> | null {
  const row = asRecord(value);
  const state = boundedText(row.state, 32);
  if (!state) return null;
  return {
    state,
    tool: boundedText(row.tool, 120),
    since: boundedText(row.since, 64),
    observed_at: boundedText(row.observed_at, 64),
    degraded: row.degraded === true,
  };
}

/** Explicitly omit process identity and local paths even if a Runner is buggy. */
export function publicRuntime(value: unknown): Record<string, RuntimeJson> | null {
  const row = asRecord(value);
  const processState = boundedText(row.process_state, 24);
  if (!processState) return null;
  const capabilities = asRecord(row.capabilities);
  const interaction = publicInteraction(row.interaction);
  const attachment = asRecord(row.attachment);
  const controlLease = asRecord(row.control_lease);
  const turn = asRecord(row.turn);
  const recovery = asRecord(row.recovery);
  return {
    process_state: processState,
    turn_state: boundedText(row.turn_state, 24),
    control_mode: boundedText(row.control_mode, 32),
    observed_at: boundedText(row.observed_at, 64),
    event: boundedText(row.event, 64),
    tool: boundedText(row.tool, 160),
    degraded: row.degraded === true,
    ...(["reconnecting", "waiting_resource", "waiting_capacity", "unknown"].includes(String(recovery.state)) ? { recovery: {
      state: String(recovery.state), since: boundedText(recovery.since, 64), retry_at: boundedText(recovery.retry_at, 64),
      ...(recovery.state === "waiting_capacity" ? {
        attempts: Number.isInteger(recovery.attempts) ? Math.max(0, Math.min(6, Number(recovery.attempts))) : 0,
        max_attempts: 6, deadline_at: boundedText(recovery.deadline_at, 64),
      } : {}),
    } } : {}),
    ...(boundedText(attachment.kind, 40) ? { attachment: {
      kind: boundedText(attachment.kind, 40),
      state: boundedText(attachment.state, 24),
      transport: boundedText(attachment.transport, 24),
    } } : {}),
    ...(boundedText(controlLease.holder, 24) ? { control_lease: {
      holder: boundedText(controlLease.holder, 24),
      acquired_at: boundedText(controlLease.acquired_at, 64),
    } } : {}),
    ...(boundedText(turn.state, 24) ? { turn: {
      state: boundedText(turn.state, 24),
      id: boundedText(turn.id, 160),
      started_at: boundedText(turn.started_at, 64),
    } } : {}),
    capabilities: {
      observe: capabilities.observe === true,
      append_when_idle: capabilities.append_when_idle === true,
      takeover: capabilities.takeover === true,
      interrupt: capabilities.interrupt === true,
      steer: capabilities.steer === true,
      respond: capabilities.respond === true,
      ...("terminal_append" in capabilities ? { terminal_append: capabilities.terminal_append === true } : {}),
      // Present only for a runtime that reported it, so an older Runner keeps
      // projecting "no opinion" instead of a manufactured `false`.
      ...("terminal_interrupt" in capabilities
        ? { terminal_interrupt: capabilities.terminal_interrupt === true }
        : {}),
      ...("managed_resume" in capabilities ? { managed_resume: capabilities.managed_resume === true } : {}),
      ...("protocol_append" in capabilities ? { protocol_append: capabilities.protocol_append === true } : {}),
    },
    ...(interaction ? { interaction } : {}),
  };
}

/**
 * Copy one blocking provider request, and only its public prompt envelope.
 *
 * Provider JSON-RPC ids, process details and canonical paths never enter this
 * object. The response target is rebound later from the trusted instance
 * projection; the View-visible id is only a single-use equality token.
 */
function publicInteraction(value: unknown): Record<string, RuntimeJson> | null {
  const row = asRecord(value);
  const id = boundedText(row.id, 128);
  const provider = SESSION_CLI_KINDS.includes(row.provider as ScanSource) ? row.provider : "";
  const kind = row.kind === "question" || row.kind === "permission" ? row.kind : "";
  const title = boundedText(row.title, 240);
  if (!id || !provider || !kind || !title) return null;
  const capabilities = asRecord(row.capabilities);
  const resolution = asRecord(row.resolution);
  const questions = records(row.questions).slice(0, 8).flatMap((raw, index) => {
    const questionId = boundedText(raw.id, 160) || `question_${index + 1}`;
    const prompt = boundedText(raw.prompt, 2_000);
    if (!prompt) return [];
    const options = records(raw.options).slice(0, 12).flatMap((option) => {
      const label = boundedText(option.label, 240);
      return label ? [{
        label,
        ...(boundedText(option.description, 1_000)
          ? { description: boundedText(option.description, 1_000) }
          : {}),
      }] : [];
    });
    return [{
      id: questionId,
      header: boundedText(raw.header, 160) || `问题 ${index + 1}`,
      prompt,
      options,
      multiple: raw.multiple === true,
      allow_other: raw.allow_other !== false,
      secret: raw.secret === true,
    }];
  });
  return {
    id,
    provider,
    kind,
    title,
    ...(boundedText(row.description, 2_000) ? { description: boundedText(row.description, 2_000) } : {}),
    ...(boundedText(row.tool, 160) ? { tool: boundedText(row.tool, 160) } : {}),
    ...(boundedText(row.detail, 12_000) ? { detail: boundedText(row.detail, 12_000) } : {}),
    ...(questions.length ? { questions } : {}),
    created_at: boundedText(row.created_at, 64),
    expires_at: boundedText(row.expires_at, 64),
    ...(boundedText(row.status, 24) ? { status: boundedText(row.status, 24) } : {}),
    ...(boundedText(row.resolved_at, 64) ? { resolved_at: boundedText(row.resolved_at, 64) } : {}),
    ...(boundedText(resolution.decision, 16) ? { resolution: {
      decision: boundedText(resolution.decision, 16),
      summary: boundedText(resolution.summary, 600),
    } } : {}),
    capabilities: {
      respond: capabilities.respond === true,
      allow: capabilities.allow === true,
      deny: capabilities.deny === true,
    },
  };
}

/**
 * Project a normalized trusted directory snapshot through the sessions plane's
 * existing disclosure limits.
 *
 * The shared snapshot deliberately retains workspace-files' wider/raw label
 * semantics. This function owns the sessions-specific 120-character trimmed
 * label plus required display path, so sharing the parser cannot change v1
 * workspace-files bytes or accidentally make a no-display root launchable.
 */
export function publicWorkspaceSnapshot(
  snapshot: WorkspaceDirectorySnapshot,
  mintRootKey?: (workspaceId: string) => string | null,
): Record<string, RuntimeJson> {
  const workspaces = snapshot.roots.flatMap((root) => {
    const label = boundedText(root.label, 120).trim();
    const display = boundedText(root.display, 240).trim();
    if (!label || !display) return [];
    const directoryKey = mintRootKey?.(root.workspaceId) ?? null;
    return [{
      id: root.workspaceId,
      label,
      display,
      ...(directoryKey ? { directoryKey } : {}),
    } as Record<string, RuntimeJson>];
  });
  return {
    device: boundedText(snapshot.device, 64), workspaces,
    ...(snapshot.terminal ? { terminal: { ...snapshot.terminal } } : {}),
  };
}

/** Allow only the transcript envelope the shared renderer consumes. */
export function publicTranscript(
  raw: unknown,
  decoded: { device: string; cliKind: string; sessionId: string },
): Record<string, unknown> {
  const input = stripSessionPath(asRecord(raw));
  const runtime = publicRuntime(asRecord(input.meta).runtime);
  const version = transcriptVersionOf(input.projection_version);
  return {
    ...(decoded.cliKind === "codex"
      ? { turnConfiguration: readSessionTurnConfiguration(asRecord(input.meta).turn_configuration) } : {}),
    ...(readCodexTokenUsage(asRecord(input.meta).usage) ? { usage: readCodexTokenUsage(asRecord(input.meta).usage) } : {}),
    sessionId: decoded.sessionId,
    cliKind: decoded.cliKind,
    deviceLabel: decoded.device === BOT_HOST_DEVICE ? "bot 主机" : decoded.device,
    rich: input.rich === true,
    messages: Array.isArray(input.messages) ? input.messages : [],
    activity: transcriptActivity(input),
    ...(runtime ? { runtime } : {}),
    offset: finiteNumber(input.offset),
    nextOffset: finiteNumber(input.next_offset),
    totalMessages: finiteNumber(input.total_messages ?? input.total),
    hasMore: input.has_more === true,
    truncated: input.truncated === true,
    ...(version ? { version } : {}),
  };
}

/**
 * Retain transcript windows in least-to-most-recent insertion order.
 *
 * Reading or writing a resource calls this function, so the touched resource
 * is removed from its old position and appended as the newest entry. The
 * invalidation rule is deliberately just that bounded access order: evicted
 * windows are fetched again through the View's existing single-flight read.
 */
export function retainTranscripts(
  previousRaw: unknown,
  resource: string,
  data: RuntimeJson,
): Record<string, RuntimeJson> {
  const retained = Object.entries(asRecord(previousRaw))
    .filter(([key, value]) => key !== resource && isRuntimeJson(value))
    .slice(-(MAX_PROJECTED_TRANSCRIPTS - 1));
  return Object.fromEntries([...retained, [resource, data]]) as Record<string, RuntimeJson>;
}

/** Prepend one explicitly requested older page to the currently projected tail. */
export function prependTranscriptWindow(currentRaw: unknown, olderRaw: unknown): Record<string, unknown> {
  const current = asRecord(currentRaw);
  const older = asRecord(olderRaw);
  const currentMessages = Array.isArray(current.messages) ? current.messages : [];
  const olderMessages = Array.isArray(older.messages) ? older.messages : [];
  const currentOffset = windowOffset(current.offset);
  const olderOffset = windowOffset(older.offset);
  if (currentOffset === null || olderOffset === null || olderOffset + olderMessages.length !== currentOffset) {
    return older;
  }
  return reconcileTranscriptWindows(current, older);
}

/** Refresh the mutable recent tail without throwing away pages a person loaded. */
export function mergeTranscriptTail(currentRaw: unknown, tailRaw: unknown): Record<string, unknown> {
  return reconcileTranscriptWindows(currentRaw, tailRaw);
}

/**
 * Reconcile two windows for one append-only transcript.
 *
 * Absolute positions decide whether ranges can be joined; source versions
 * decide which overlap wins. A different epoch is the sole explicit lineage
 * reset and may replace a longer old transcript. Inside one epoch, a smaller
 * total/end is an obvious regression even when that stale read happened to be
 * wrapped in a later App frame.
 */
export function reconcileTranscriptWindows(
  currentRaw: unknown,
  incomingRaw: unknown,
): Record<string, unknown> {
  const current = asRecord(currentRaw);
  const incoming = asRecord(incomingRaw);
  return reconcileProjectedTranscriptWindows(
    current as TranscriptWindow,
    incoming as TranscriptWindow,
  ) as Record<string, unknown>;
}

export function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

export function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => (
        Boolean(entry) && typeof entry === "object" && !Array.isArray(entry)
      ))
    : [];
}

export function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export function boundedText(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function transcriptActivity(input: Record<string, any>): unknown {
  if (input.activity && typeof input.activity === "object" && !Array.isArray(input.activity)) return input.activity;
  const meta = asRecord(input.meta);
  return meta.activity && typeof meta.activity === "object" && !Array.isArray(meta.activity)
    ? meta.activity
    : null;
}

function finiteNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function windowOffset(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}
