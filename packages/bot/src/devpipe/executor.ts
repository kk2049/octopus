/**
 * The ticket-turn contract the dev pipeline still speaks.
 *
 * The Head-host executor that used to run these turns as local `claude -p` /
 * `codex` / `omp` processes is gone (retired 2026-09-15, its runtime deleted
 * 2026-10-15): production tickets run on the requester's Runner, and the
 * pipeline's `runTurn` seam only exists for its own lifecycle tests. What
 * remains here are the shapes that seam and the Runner path share, plus the
 * transcript probe the pipeline uses to decide whether a session was already
 * established.
 */

import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TurnUsage } from "./ticket-cost.js";

/** Kill a turn only when its transcript stops growing for this long. */
export const DEV_STALL_TIMEOUT_MS = 20 * 60_000;

export interface DevTurnSpec {
  prompt: string;
  /**
   * Value for the CLI's `--model` flag, passed through verbatim. New tickets
   * carry a full model id (claude-opus-5, …); tickets filed before ticket #3
   * carry a floating alias (`opus`) — the CLI accepts both. Omit = CLI default.
   */
  model?: string;
  /** high | xhigh. */
  effort?: string;
  resumeSessionId?: string;
  /** Resume the parent session under a NEW id (follow-up tickets). */
  forkSession?: boolean;
  /**
   * Pre-chosen id for a session that does NOT exist yet (`--session-id`).
   * The pipeline picks it before spawning so the panel can open the
   * transcript from second one instead of after the first turn returns —
   * that gap used to read as "工单还没进入开发" for minutes on end.
   */
  sessionId?: string;
  /** Trusted, operator-configured state root for a direct Codex account slot. */
  codexHome?: string;
  /**
   * MCP config file exposing the devpipe claim/submit tools (ticket #12).
   * Paired with --strict-mcp-config so the pipeline agent gets EXACTLY these
   * servers — not whatever ~/.claude.json accumulated on the bot host.
   */
  mcpConfigPath?: string;
  /**
   * codex-runner family (#358): opens the bridge to the requester's own Runner
   * device's Codex. The bridge presents a loopback app-server endpoint and a
   * device-local exec-server URL for the worktree environment; the pipeline
   * builds it per turn from the requester's trusted device grant.
   */
  remoteCodex?: {
    open(): Promise<{
      endpoint: string;
      environment: { environmentId: string; execServerUrl: string };
      close(): Promise<void>;
    }>;
  };
}

export interface TurnLimits {
  /** Wall-clock cap; 0/undefined = unlimited (the default — see header). */
  timeoutMs?: number;
  /** Transcript-stall kill threshold; 0 = disabled. Default DEV_STALL_TIMEOUT_MS. */
  stallMs?: number;
  /** Test hook: how often the stall watcher polls. */
  stallCheckIntervalMs?: number;
  /**
   * "The silence is accounted for" hook (ticket #12): a devpipe_submit gate
   * run can hold the CLI inside one MCP tool call for 10+ minutes, appending
   * nothing to the transcript. The pipeline knows a tool op is in flight for
   * this ticket; while this returns true the stall watcher holds its fire.
   */
  isExternallyBusy?: () => boolean;
  /**
   * Stop this turn as soon as this returns true (ticket #15). Cancelling a
   * ticket used to only flip a DB column: the agent kept running, and could
   * still claim the workspace and land code for a ticket the user had
   * already called off. Polled on its own interval so it works even when the
   * stall watcher is disabled.
   */
  shouldAbort?: () => boolean;
  /** Test hook: how long SIGINT gets before the turn is killed outright. */
  abortGraceMs?: number;
  /** Codex reports its minted id near process start; publish it immediately. */
  onSessionId?: (sessionId: string) => void;
  /**
   * Publishes this turn's interjection channel (ticket #183).
   *
   * Called with a deliver function once the turn can take a message into its
   * RUNNING work, and with null the moment it can no longer take one. The
   * function returns false when the channel closed between the two, so the
   * caller always learns whether the message actually went in and can fall
   * back to the inbox instead of losing it. Claude acknowledges the pipe
   * write synchronously; Codex acknowledges `turn/steer` asynchronously, so
   * callers must keep the durable row pending until the promise resolves.
   */
  onInterject?: (deliver: ((text: string) => boolean | Promise<boolean>) | null) => void;
  /** Test hook: how long the interjection window survives a result event. */
  interjectIdleMs?: number;
}

export interface DevTurnResult {
  ok: boolean;
  /** Session id the CLI reports — first turn: the new session; resume: same or forked id. */
  session_id?: string;
  result_text?: string;
  exit_code: number | null;
  /** Killed because shouldAbort() went true (ticket cancelled). */
  aborted?: boolean;
  /** Wall-clock cap hit (only possible when limits.timeoutMs was set). */
  timed_out: boolean;
  /** Killed by the stall watcher: transcript stopped growing for limits.stallMs. */
  stalled?: boolean;
  stderr_tail?: string;
  /** Setup-level failure (spawn or pre-turn protocol), as opposed to a failed turn. */
  error?: string;
  /**
   * Setup failed before the provider accepted a prompt, so one fresh transport
   * attempt is safe. This is deliberately narrower than `error`: a missing
   * binary or a timed-out `turn/start` must not be replayed.
   */
  retryable_error?: boolean;
  duration_ms: number;
  /**
   * What the CLI reported this turn cost. Absent when the turn died before a
   * result event, or when the CLI build does not report usage — a missing cost
   * is a missing number in the panel, never a changed turn outcome.
   */
  usage?: TurnUsage;
}

/** Claude Code's project-dir encoding: every non-alphanumeric byte becomes "-". */
export function transcriptDirFor(cwd: string): string {
  return join(homedir(), ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
}

/**
 * True when Claude Code has already materialised a session transcript for
 * this (cwd, sessionId). Used by the pipeline to tell "already introduced"
 * from "first ever" independent of whether an agent message survived to the
 * DB — a first turn that crashed *after* writing to the session file has
 * still established the intro in the CLI's context, so a follow-up should
 * `--resume` with a short prompt rather than re-injecting the whole intro
 * (ticket #20). Returns false on any I/O error, so the caller conservatively
 * treats missing files as "not yet established".
 */
export function sessionTranscriptExists(cwd: string, sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  try {
    const file = join(transcriptDirFor(cwd), `${sessionId}.jsonl`);
    return statSync(file).size > 0;
  } catch {
    return false;
  }
}
