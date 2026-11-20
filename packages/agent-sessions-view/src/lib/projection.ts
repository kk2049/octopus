/**
 * Reading an `agent-sessions/v1` projection: the pure part.
 *
 * Everything here takes a projection and returns a derived value. It is
 * separated from the controller because these are RULES — which sessions are
 * shown and in what order, which machines can be asked for a workspace registry,
 * when a tail is too short to read — and rules are worth testing without a React
 * tree around them.
 *
 * Every reader treats a missing field as absent. The projection comes from
 * another program that may be older or newer than this build.
 */

import {
  BOT_HOST_DEVICE,
  reconcileTranscriptWindows as reconcileProjectedTranscriptWindows,
  type AgentRuntime,
  type RichMessage,
  type SessionSummary,
  type SessionsProjection,
  type TranscriptWindow,
  type WorkspaceGroup,
} from "@claude-bot/agent-sessions-contract";
import { QUIET_MS, countUnits, entriesOf, foldsThinking } from "./transcript.js";
import { sortRecentSessions, type RosterSession } from "./roster.js";

/** One page of transcript, and the ceiling an auto-extended tail may reach. */
export const TRANSCRIPT_PAGE = 200;
export const TAIL_EXTEND_CAP = 800;
/** Below this many VISIBLE units the tail is too short to read. */
export const MIN_TAIL_UNITS = 20;

/**
 * The best name a session has.
 *
 * Shared rather than duplicated: the roster row, a search hit and the chat
 * header must agree, and three "pick the first non-empty field" chains would
 * eventually disagree about a session with only a preview.
 */
export function titleOf(
  session: {
    title?: string;
    projectLabel?: string;
    firstUserText?: string;
    preview?: string;
    sessionId?: string;
    accountLabel?: string;
  },
): string {
  return titleText(session.title)
    || titleText(session.firstUserText)
    || titleText(session.preview)
    || titleText(session.projectLabel)
    || titleText(session.sessionId)
    || "未命名会话";
}

/** A compact navigation title derived from the person's instruction. */
export function titleText(value: string | undefined, maxChars = 48): string {
  if (!value) return "";
  const meaningful = value
    .replace(/```[\s\S]*?```/g, " ")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)]|#{1,6}|>)+\s*/, "").trim())
    .find((line) => line.length > 0) ?? "";
  const compact = meaningful
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (!compact) return "";
  const sentence = compact.split(/(?<=[。！？!?])\s*/u)[0] || compact;
  const chars = Array.from(sentence);
  return chars.length <= maxChars ? sentence : `${chars.slice(0, maxChars - 1).join("")}…`;
}

export { currentRuntimeOf } from "@claude-bot/agent-sessions-contract";

/**
 * A hook's last `working` event is evidence, not a permanent process truth.
 * Timestamp-less legacy Runners retain their old behaviour because there is no
 * clock from which this View could honestly infer staleness.
 */
export function currentTurnState(
  runtime: AgentRuntime | null | undefined,
  nowMs = Date.now(),
): "working" | "needs_input" | "idle" | "unknown" {
  const declared = runtime?.turn_state || runtime?.turn?.state || "unknown";
  if (declared !== "working") {
    return declared === "needs_input" || declared === "idle" ? declared : "unknown";
  }
  const observedAt = Date.parse(String(runtime?.observed_at ?? ""));
  return Number.isFinite(observedAt) && nowMs - observedAt > QUIET_MS ? "unknown" : "working";
}

/** Favorites, foreground tmux, then other chats; stable activity within each group. */
export function sortedSessions(projection: SessionsProjection | null): SessionSummary[] {
  const sessions = projection?.sessions ?? [];
  return sortRecentSessions(sessions, sessions.length, projection?.pinned);
}

/** Apply account-owned naming only to a render value; provider rows stay cacheable raw facts. */
export function withCustomTitle(
  session: SessionSummary,
  customTitles: Readonly<Record<string, string>> | undefined,
): SessionSummary {
  const title = customTitles?.[session.resourceId];
  return title ? { ...session, title } : session;
}

export function transcriptOf(
  projection: SessionsProjection | null,
  resource: string | null,
): TranscriptWindow | null {
  if (!resource) return null;
  return projection?.transcript?.[resource] ?? null;
}

/**
 * Choose one display window without letting a later top-level frame hide
 * stronger per-resource evidence.
 *
 * The trusted Host normally reconciles pages before projecting them; this is
 * the final cache boundary for old Hosts and mixed-version releases. Compatible
 * absolute ranges may be joined so a history page extends left without hiding
 * the live tail. A reset epoch may replace the lineage, while a same-epoch
 * candidate that loses the transcript frontier is visibly older and stays out.
 */
export function preferredTranscriptWindow(
  current: TranscriptWindow | null | undefined,
  incoming: TranscriptWindow | null | undefined,
): TranscriptWindow | null {
  return reconcileProjectedTranscriptWindows(current, incoming);
}

export function workspaceMap(projection: SessionsProjection | null): Record<string, WorkspaceGroup> {
  const map = projection?.workspacesByDevice ?? {};
  const legacy = projection?.workspaces;
  if (legacy?.device && !map[legacy.device]) return { ...map, [legacy.device]: legacy };
  return map;
}

/** Devices that can be asked for a workspace registry — Runners, not scan roots. */
export function devicesOf(projection: SessionsProjection | null): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const source of projection?.sources ?? []) {
    const device = String(source.device ?? "");
    if (source.kind !== "runner" || !device || seen.has(device)) continue;
    seen.add(device);
    out.push(device);
  }
  for (const session of projection?.sessions ?? []) {
    for (const device of [session.deviceId, session.directoryDeviceId]) {
      const name = String(device ?? "");
      if (!name || name === BOT_HOST_DEVICE || seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }
  for (const row of projection?.placement?.devices ?? []) {
    const device = String(row.device ?? "");
    if (!device || seen.has(device)) continue;
    seen.add(device);
    out.push(device);
  }
  return out.sort();
}

/** Whether the latest completed turn is newer than the user's acknowledgement. */
export function sessionNeedsReview(
  session: Pick<SessionSummary, "completedAt">,
  reviewedAt: string | undefined,
): boolean {
  const completed = Date.parse(session.completedAt ?? "");
  const reviewed = Date.parse(reviewedAt ?? "");
  return Number.isFinite(completed) && (!Number.isFinite(reviewed) || completed > reviewed);
}

/** Projection rows as the roster tree wants them: identity, directory and review state. */
export function rosterOf(
  sessions: readonly SessionSummary[],
  reviewedAt: Readonly<Record<string, string>> = {},
  customTitles: Readonly<Record<string, string>> = {},
  transcripts: SessionsProjection["transcript"] = {},
): RosterSession[] {
  return sessions.map((session) => {
    const observedCount = transcripts?.[session.resourceId]?.totalMessages;
    return {
      ...session,
      ...(session.messageCount == null && typeof observedCount === "number" && Number.isSafeInteger(observedCount) && observedCount >= 0
        ? { messageCount: observedCount } : {}),
      id: session.resourceId,
      device: session.directoryDeviceId ?? session.deviceId ?? "",
      cwd: session.cwdDisplay || session.projectLabel || "(未知目录)",
      needsReview: sessionNeedsReview(session, reviewedAt[session.resourceId]),
      userNamed: Boolean(customTitles[session.resourceId]?.trim()),
    };
  });
}

/**
 * Count what remains after work runs fold, and keep extending until the tail
 * has enough visible units plus its last user turn. Claude/OMP runs also span
 * thinking blocks, matching the shared renderer's CLI-specific grouping.
 *
 * A folded run is one row, so a window of 200 messages can be two things on
 * screen. `countUnits` mirrors the renderer exactly; if they drift, "load
 * earlier" stops agreeing with what the reader sees.
 */
export function tailNeedsMore(messages: readonly RichMessage[], cliKind?: string): boolean {
  if (countUnits(entriesOf(messages), foldsThinking(cliKind)) < MIN_TAIL_UNITS) return true;
  return !messages.some((message) => message?.role === "user");
}
