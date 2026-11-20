import { SESSION_ROSTER_WINDOW, parentOwnedSessionParentId, subagentParentId } from "@claude-bot/plugin-sessions/scan";

export const RUNNER_SESSION_PROJECTION_SCHEMA = "runner-session-projection/v1" as const;

/** One whole primary window: chats, automated runs and declared children. */
export const SESSION_PROJECTION_ROSTER_MAX = SESSION_ROSTER_WINDOW;
export const SESSION_PROJECTION_TRANSCRIPT_MAX_BYTES = 2 * 1024 * 1024;

export type SessionProjectionSource = "claude" | "codex" | "omp";

export interface SessionProjectionRow {
  id: string;
  source: SessionProjectionSource;
  project?: string;
  account_label?: string;
  cwd_display?: string;
  last_activity?: string;
  sort_activity?: string;
  completed_at?: string;
  started_at?: string;
  message_count?: number;
  title?: string;
  /** Complete provider-owned direct-input prohibition; never projected alone. */
  input_mode?: "parent_owned";
  /** Bounded opaque parent thread id; trusted Host later mints the resource. */
  parent_session_id?: string;
  is_subagent?: true;
  execution_mode?: "exec";
  preview?: string;
  first_user_text?: string;
  activity?: Record<string, unknown>;
  runtime?: Record<string, unknown>;
}

interface SessionProjectionBase {
  schema: typeof RUNNER_SESSION_PROJECTION_SCHEMA;
  epoch: string;
  sequence: number;
  observed_at: string;
}

export interface SessionRosterProjection extends SessionProjectionBase {
  kind: "roster_full";
  total_found: number;
  primary_window?: true;
  index_pending?: boolean;
  sessions: SessionProjectionRow[];
}

export interface SessionTranscriptProjection extends SessionProjectionBase {
  kind: "transcript";
  source: SessionProjectionSource;
  session_id: string;
  transcript: Record<string, unknown>;
}

/** Freshness evidence names the exact last content frame; it carries no new body. */
export interface SessionTranscriptCheckedProjection extends SessionProjectionBase {
  kind: "transcript_checked";
  source: SessionProjectionSource;
  session_id: string;
  content_sequence: number;
}
export type RunnerSessionProjection = SessionRosterProjection | SessionTranscriptProjection | SessionTranscriptCheckedProjection;

export interface SessionTranscriptSubscribeCommand {
  schema: typeof RUNNER_SESSION_PROJECTION_SCHEMA;
  kind: "transcript_subscribe";
  source: SessionProjectionSource;
  session_id: string;
  max_messages: number;
}

export interface SessionTranscriptUnsubscribeCommand {
  schema: typeof RUNNER_SESSION_PROJECTION_SCHEMA;
  kind: "transcript_unsubscribe";
  source: SessionProjectionSource;
  session_id: string;
}

export type RunnerSessionProjectionCommand =
  | SessionTranscriptSubscribeCommand
  | SessionTranscriptUnsubscribeCommand;

const SOURCES: Record<SessionProjectionSource, true> = { claude: true, codex: true, omp: true };
const ROW_TEXT_LIMITS = {
  id: 512,
  project: 512,
  account_label: 120,
  cwd_display: 512,
  last_activity: 64,
  sort_activity: 64,
  completed_at: 64,
  started_at: 64,
  title: 512,
  preview: 2_000,
  first_user_text: 2_000,
} as const;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedString(value: unknown, max: number, required = false): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if ((required && !text) || text.length > max) return undefined;
  return text || undefined;
}

function sourceFrom(value: unknown): SessionProjectionSource | null {
  return typeof value === "string" && SOURCES[value as SessionProjectionSource]
    ? value as SessionProjectionSource
    : null;
}

function safeInteger(value: unknown, min: number, max: number): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= min && number <= max ? number : null;
}

function jsonObject(value: unknown, maxBytes: number): Record<string, unknown> | undefined {
  if (!record(value)) return undefined;
  try {
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized, "utf8") > maxBytes) return undefined;
    const cloned = JSON.parse(serialized) as unknown;
    return record(cloned) ?? undefined;
  } catch {
    return undefined;
  }
}

function validObservedAt(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function validEpoch(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(value);
}

export function sessionProjectionRowFrom(value: unknown): SessionProjectionRow | null {
  const input = record(value);
  if (!input) return null;
  const id = boundedString(input.id, ROW_TEXT_LIMITS.id, true);
  const source = sourceFrom(input.source);
  if (!id || !source) return null;

  const row: SessionProjectionRow = { id, source };
  for (const field of [
    "project",
    "account_label",
    "cwd_display",
    "last_activity",
    "sort_activity",
    "completed_at",
    "started_at",
    "title",
    "preview",
    "first_user_text",
  ] as const) {
    const text = boundedString(input[field], ROW_TEXT_LIMITS[field]);
    if (text) row[field] = text;
  }
  if (source === "codex" && input.execution_mode === "exec") row.execution_mode = "exec";
  const lineage = { ...input, id, source };
  const parentSessionId = subagentParentId(lineage);
  if (parentSessionId) {
    row.is_subagent = true;
    if (parentOwnedSessionParentId(lineage)) row.input_mode = "parent_owned";
    row.parent_session_id = parentSessionId;
  }
  const messageCount = safeInteger(input.message_count, 0, 1_000_000);
  if (messageCount !== null) row.message_count = messageCount;
  const activity = jsonObject(input.activity, 16 * 1024);
  if (activity) row.activity = activity;
  const runtime = jsonObject(input.runtime, 16 * 1024);
  if (runtime) row.runtime = runtime;
  return row;
}

/** Remove device-local paths and retain only bounded roster fields. */
export function sessionRosterProjectionFromResult(
  result: unknown,
  epoch: string,
  sequence: number,
  observedAt = new Date().toISOString(),
): SessionRosterProjection | null {
  const input = record(result);
  if (!input || !validEpoch(epoch) || !validObservedAt(observedAt)) return null;
  const sessions = Array.isArray(input.sessions)
    ? input.sessions.slice(0, SESSION_PROJECTION_ROSTER_MAX).map(sessionProjectionRowFrom).filter((row): row is SessionProjectionRow => row !== null)
    : [];
  const totalFound = safeInteger(input.total_found, 0, 1_000_000) ?? sessions.length;
  const safeSequence = safeInteger(sequence, 1, Number.MAX_SAFE_INTEGER);
  if (safeSequence === null) return null;
  return {
    schema: RUNNER_SESSION_PROJECTION_SCHEMA,
    kind: "roster_full",
    epoch,
    sequence: safeSequence,
    observed_at: observedAt,
    total_found: Math.max(totalFound, sessions.length),
    ...(input.primary_window === true ? { primary_window: true as const, index_pending: input.index_pending === true } : {}),
    sessions,
  };
}

/** Keep the rich transcript window but remove scanner-only absolute path fields. */
export function sessionTranscriptProjectionFromResult(
  result: unknown,
  source: SessionProjectionSource,
  sessionId: string,
  epoch: string,
  sequence: number,
  observedAt = new Date().toISOString(),
): SessionTranscriptProjection | null {
  const input = record(result);
  const id = boundedString(sessionId, ROW_TEXT_LIMITS.id, true);
  const safeSequence = safeInteger(sequence, 1, Number.MAX_SAFE_INTEGER);
  if (!input || !sourceFrom(source) || !id || safeSequence === null || !validEpoch(epoch) || !validObservedAt(observedAt)) {
    return null;
  }
  const rawMeta = record(input.meta) ?? {};
  // Ownership is roster state. Do not create a second, raw transcript channel
  // for the provider parent id; the Host projects only its minted resource.
  const {
    path: _path,
    cwd: _cwd,
    input_mode: _inputMode,
    parent_session_id: _parentSessionId,
    is_subagent: _isSubagent,
    execution_mode: _executionMode,
    ...metaWithoutPaths
  } = rawMeta;
  const transcript = jsonObject({ ...input, meta: metaWithoutPaths }, SESSION_PROJECTION_TRANSCRIPT_MAX_BYTES);
  if (!transcript || transcript.rich !== true || !Array.isArray(transcript.messages)) return null;
  if (transcript.messages.length > 500) return null;
  return {
    schema: RUNNER_SESSION_PROJECTION_SCHEMA,
    kind: "transcript",
    epoch,
    sequence: safeSequence,
    observed_at: observedAt,
    source,
    session_id: id,
    transcript,
  };
}

export function runnerSessionProjectionFromWire(value: unknown): RunnerSessionProjection | null {
  const input = record(value);
  if (!input || input.schema !== RUNNER_SESSION_PROJECTION_SCHEMA || !validEpoch(input.epoch)
    || !validObservedAt(input.observed_at)) return null;
  const sequence = safeInteger(input.sequence, 1, Number.MAX_SAFE_INTEGER);
  if (sequence === null) return null;
  if (input.kind === "roster_full") {
    if (!Array.isArray(input.sessions) || input.sessions.length > SESSION_PROJECTION_ROSTER_MAX) return null;
    const sessions = input.sessions.map(sessionProjectionRowFrom);
    if (sessions.some((row) => row === null)) return null;
    const totalFound = safeInteger(input.total_found, 0, 1_000_000);
    if (totalFound === null || totalFound < sessions.length) return null;
    return {
      schema: RUNNER_SESSION_PROJECTION_SCHEMA,
      kind: "roster_full",
      epoch: input.epoch,
      sequence,
      observed_at: input.observed_at,
      total_found: totalFound,
      ...(input.primary_window === true ? { primary_window: true as const, index_pending: input.index_pending === true } : {}),
      sessions: sessions as SessionProjectionRow[],
    };
  }
  if (input.kind === "transcript_checked") {
    const source = sourceFrom(input.source);
    const sessionId = boundedString(input.session_id, ROW_TEXT_LIMITS.id, true);
    const contentSequence = safeInteger(input.content_sequence, 1, sequence - 1);
    if (!source || !sessionId || contentSequence === null) return null;
    return { schema: RUNNER_SESSION_PROJECTION_SCHEMA, kind: "transcript_checked", source,
      session_id: sessionId, epoch: input.epoch, sequence, content_sequence: contentSequence,
      observed_at: input.observed_at };
  }
  if (input.kind === "transcript") {
    const source = sourceFrom(input.source);
    const sessionId = boundedString(input.session_id, ROW_TEXT_LIMITS.id, true);
    const transcript = jsonObject(input.transcript, SESSION_PROJECTION_TRANSCRIPT_MAX_BYTES);
    if (!source || !sessionId || !transcript || transcript.rich !== true || !Array.isArray(transcript.messages)
      || transcript.messages.length > 500) return null;
    const meta = record(transcript.meta);
    if (meta && ("path" in meta || "cwd" in meta)) return null;
    return {
      schema: RUNNER_SESSION_PROJECTION_SCHEMA,
      kind: "transcript",
      epoch: input.epoch,
      sequence,
      observed_at: input.observed_at,
      source,
      session_id: sessionId,
      transcript,
    };
  }
  return null;
}

export function runnerSessionProjectionCommandFromWire(value: unknown): RunnerSessionProjectionCommand | null {
  const input = record(value);
  if (!input || input.schema !== RUNNER_SESSION_PROJECTION_SCHEMA) return null;
  const source = sourceFrom(input.source);
  const sessionId = boundedString(input.session_id, ROW_TEXT_LIMITS.id, true);
  if (!source || !sessionId) return null;
  if (input.kind === "transcript_unsubscribe") {
    return { schema: RUNNER_SESSION_PROJECTION_SCHEMA, kind: "transcript_unsubscribe", source, session_id: sessionId };
  }
  if (input.kind !== "transcript_subscribe") return null;
  const maxMessages = safeInteger(input.max_messages, 1, 500);
  if (maxMessages === null) return null;
  return {
    schema: RUNNER_SESSION_PROJECTION_SCHEMA,
    kind: "transcript_subscribe",
    source,
    session_id: sessionId,
    max_messages: maxMessages,
  };
}
