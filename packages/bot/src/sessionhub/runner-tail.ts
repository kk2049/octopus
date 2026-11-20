/**
 * Runner-backed transcript polling shared by Session Hub consumers.
 *
 * This is transport-agnostic: callers provide the already-authorized RPC
 * closure, and the tail only normalizes `read_session` pages into change-aware
 * snapshots. Dashboard SSE fan-out and Session Resource authority lifetimes
 * stay with their respective callers.
 */

import type { SessionActivity, Source as ScanSource } from "@claude-bot/plugin-sessions/scan";
import { transcriptVersionOf, type TranscriptVersion } from "@claude-bot/agent-sessions-contract";
import { SESSION_CLI_KINDS } from "./core.js";

/** A window into the parsed session: `messages[0]` is message #`offset`. */
export interface TailState {
  offset: number;
  total: number;
  messages: unknown[];
  /** What the agent is doing right now; undefined when the source can't say. */
  activity?: SessionActivity;
  /** Declassified provider interaction state projected by a current Runner. */
  runtime?: unknown;
  /** Materialized Runner source freshness; absent for a direct RPC fallback. */
  version?: TranscriptVersion;
}

export interface TailSource {
  /** Current parsed state, or null when provably unchanged since last call. */
  fetch(): Promise<TailState | null>;
  close(): void;
  /** Optional change hint (fs.watch); the poller still runs as fallback. */
  onHint?(cb: () => void): void;
}

/**
 * Poll the existing Runner `read_session` RPC (rich, last page).
 *
 * The injected closure owns authorization and routing. This helper changes no
 * protocol and deliberately includes activity/runtime/last-message content in
 * its fingerprint so backfills and cleared interaction cards are observable.
 */
export function openRunnerTail(
  rpc: (method: string, args: Record<string, unknown>) => Promise<unknown>,
  source: string | undefined,
  id: string,
  device?: string,
  maxMessages = 500,
): TailSource {
  let fingerprint = "";
  return {
    async fetch() {
      const boundedMax = Math.min(500, Math.max(1, Math.trunc(maxMessages) || 500));
      const args: Record<string, unknown> = { id, rich: true, max_messages: boundedMax };
      if (SESSION_CLI_KINDS.includes(source as ScanSource)) args.source = source;
      if (device) args.device = device;
      const r = (await rpc("read_session", args)) as {
        total_messages?: number;
        offset?: number;
        messages?: unknown[];
        meta?: { activity?: SessionActivity; runtime?: unknown };
        projection_version?: unknown;
      };
      const messages = r.messages ?? [];
      const last = messages[messages.length - 1];
      const activity = r.meta?.activity;
      // `null` is a real transition: it clears a question/approval that was
      // visible in the preceding frame. Omitting it would leave a stale card.
      const runtime = r.meta?.runtime ?? null;
      const version = transcriptVersionOf(r.projection_version);
      const fp = `${r.total_messages ?? 0}:${messages.length}:${JSON.stringify(activity ?? null)}:${JSON.stringify(runtime ?? null)}:${JSON.stringify(version)}:${JSON.stringify(last ?? null)}`;
      if (fp === fingerprint) return null;
      fingerprint = fp;
      return {
        offset: r.offset ?? 0,
        total: r.total_messages ?? messages.length,
        messages,
        ...(activity !== undefined ? { activity } : {}),
        runtime,
        ...(version ? { version } : {}),
      };
    },
    close() {},
  };
}
