/**
 * The read-only adapter between the ticket session endpoints and the shared
 * chat shell.
 *
 * `GET /api/tickets/:id/session` speaks the scanner's snake_case shape
 * (`messages` / `offset` / `total_messages` / `meta`), plus two ticket-only
 * states the scanner cannot know: "the pipeline holds a turn but nothing is on
 * disk yet" and "this ticket never entered development". The shared
 * `ChatTranscript` speaks `TranscriptWindow`. These pure functions do the
 * translation — and nothing else: no fetch, no state, so the mapping is
 * testable without a page.
 */

import {
  deriveActivity,
  type Activity,
  type RichMessage,
  type TranscriptMeta,
  type TranscriptWindow,
} from "./transcript.js";

export interface TicketExecution {
  operation_id: string;
  state: "missing" | "running" | "succeeded" | "failed" | "unknown";
  input?: { phase: string };
  observed_at: string;
}

/** What `/api/tickets/:id/session` (and its paging reads) answers with. */
export interface TicketSessionResponse {
  pending?: boolean;
  running?: boolean;
  turn_started_at?: string;
  error?: string;
  execution?: TicketExecution;
  execution_error?: string;
  transcript_notice?: string;
  messages?: RichMessage[];
  offset?: number;
  total_messages?: number;
  meta?: TranscriptMeta & { runtime?: TranscriptWindow["runtime"] };
}

/** The page's window state: a contiguous slice `[offset, offset+messages.length)`. */
export interface TicketWindow {
  messages: RichMessage[];
  offset: number;
  total: number;
  /** Provider display mode; carried from scanner metadata into the shared renderer. */
  cliKind?: string;
  runtime?: TranscriptWindow["runtime"];
}

export type NativeTicketState = "closed" | "idle" | "working" | "needs_input" | "unknown" | "unavailable";

/**
 * Display evidence only; Runner revalidates the original CLI on every write.
 * Codex state comes from polled daemon observations, which expire. A Claude
 * Code TUI is proven per read by its exact process and tmux pane; a long tool
 * call emits no hook, so the age of its last hook says nothing about liveness.
 *
 * A connected CLI is never shown as disconnected because of its turn state.
 * While it waits for a local permission or question (`needs_input`) the Runner
 * withholds its append capability, so that state is read from the live binding
 * alone; a send attempted meanwhile gets the Runner's definite "not sent".
 */
export function nativeTicketControl(runtime: TranscriptWindow["runtime"], closed: boolean, now = Date.now(),
  cliKind?: string): NativeTicketState {
  if (closed) return "closed";
  if (!runtime || runtime.degraded || runtime.process_state !== "alive" || runtime.control_mode !== "external_cli") return "unavailable";
  if (cliKind !== "claude") {
    const observed = Date.parse(runtime.observed_at ?? "");
    if (runtime.event !== "CodexDaemonObserved"
      || !Number.isFinite(observed) || now - observed > 10000 || observed > now + 1000) return "unavailable";
  }
  if (runtime.turn_state === "needs_input") return "needs_input";
  const append = cliKind === "claude" ? runtime.capabilities?.terminal_append : runtime.capabilities?.protocol_append;
  if (!append) return "unavailable";
  return runtime.turn_state === "working" ? "working" : runtime.turn_state === "idle" ? "idle" : "unknown";
}

/** Input stays enabled whenever the CLI binding is connected, whatever its turn state. */
export function nativeTicketConnected(state: NativeTicketState): boolean {
  return state === "idle" || state === "working" || state === "needs_input" || state === "unknown";
}

/**
 * Identity of the server facts that should wake a transcript read.
 *
 * `session_id` alone is insufficient: a new ticket may expose its id before
 * the pipeline sets `turn_started_at`, so the eager read sees an honest idle
 * state. Including the turn marker makes the later idle → running transition
 * perform the first real read for both Claude's preallocated ids and Codex's
 * early `thread.started` ids.
 */
export function ticketTranscriptWakeKey(
  sessionId: string | null | undefined,
  turnStartedAt: string | null | undefined,
): string {
  if (!sessionId && !turnStartedAt) return "";
  return `${sessionId ?? ""}\u0000${turnStartedAt ?? ""}`;
}

export type TicketSessionView =
  | { kind: "starting"; since?: string }
  | { kind: "idle" }
  | { kind: "error"; message: string }
  | { kind: "window"; window: TicketWindow; activity: Activity | null };

export function ticketSessionView(data: TicketSessionResponse): TicketSessionView {
  if (data.pending) {
    // A turn may well be running with nothing on disk yet — say so instead of
    // claiming the ticket has not started.
    return data.running ? { kind: "starting", since: data.turn_started_at } : { kind: "idle" };
  }
  if (data.error) return { kind: "error", message: data.error };
  const messages = data.messages ?? [];
  return {
    kind: "window",
    window: {
      messages,
      offset: data.offset ?? 0,
      total: data.total_messages ?? messages.length,
      ...(data.meta?.source ? { cliKind: data.meta.source } : {}),
      ...(data.meta?.runtime ? { runtime: data.meta.runtime } : {}),
    },
    activity: deriveActivity(data.meta, messages),
  };
}

/** The ticket window in the shape the shared chat shell renders. */
export function transcriptWindowOf(win: TicketWindow, activity: Activity | null): TranscriptWindow {
  return {
    messages: win.messages,
    offset: win.offset,
    totalMessages: win.total,
    activity,
    ...(win.cliKind ? { cliKind: win.cliKind } : {}),
    ...(win.runtime ? { runtime: win.runtime } : {}),
  };
}

/**
 * Prepend one older page. Only a page that ends exactly where the window
 * begins may merge — anything else (a raced fork, a shrunk log) would splice
 * two non-adjacent slices into one lying window, so it is dropped and the
 * button stays available for a retry.
 */
export function mergeOlder(win: TicketWindow, page: TicketSessionResponse): TicketWindow {
  const older = page.messages ?? [];
  if (!older.length) return win;
  const pageOffset = page.offset ?? win.offset - older.length;
  if (pageOffset < 0 || pageOffset + older.length !== win.offset) return win;
  return {
    messages: older.concat(win.messages),
    offset: pageOffset,
    total: page.total_messages ?? win.total,
    ...(win.cliKind || page.meta?.source ? { cliKind: win.cliKind || page.meta?.source } : {}),
    ...(win.runtime ? { runtime: win.runtime } : {}),
  };
}
