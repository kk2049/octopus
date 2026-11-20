/**
 * Dashboard sessions/tickets SSE unstable-frontier contract.
 *
 * Parsed transcript messages are append-only at the log level but not at the
 * presentation level: a later tool-result line can complete an earlier tool
 * block. The browser therefore reports the first recently open tool as its
 * unstable frontier, and the server resends from that point.
 *
 * This is a Dashboard transport contract, not transcript presentation logic.
 * Both halves import this module so the bounded lookback and the definition of
 * an open tool cannot drift.
 */

import type { RichMessage } from "@claude-bot/agent-sessions-contract";

/** Unpaired tools older than this many messages are treated as abandoned. */
export const FRONTIER_LOOKBACK = 30;

export type FrontierMessage =
  | { blocks?: readonly ({ type?: string; output?: unknown } | null)[] }
  | null
  | undefined;

/** An absent output is open; a present `null` output is a recorded result. */
export function hasOpenTool(message: FrontierMessage): boolean {
  for (const block of message?.blocks ?? []) {
    if (block && block.type === "tool" && block.output === undefined) return true;
  }
  return false;
}

/**
 * First absolute message index that the Dashboard browser cannot yet consider
 * stable, or the end of its loaded window when every recent tool is settled.
 */
export function clientFrontier(messages: readonly RichMessage[], offset: number): number {
  const start = Math.max(0, messages.length - FRONTIER_LOOKBACK);
  for (let index = start; index < messages.length; index++) {
    if (hasOpenTool(messages[index])) return offset + index;
  }
  return offset + messages.length;
}
