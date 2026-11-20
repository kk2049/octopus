/**
 * What one ticket cost, in the four units that predict whether this system is
 * getting harder to change: agent wall time, tokens, blast radius (modules and
 * files), and churn (lines added/removed).
 *
 * The point is not accounting. A ticket list that shows "3 files / 1 module"
 * beside "简单任务" is fine; one that shows "53 files / 14 modules" beside the
 * same words is the coupling signal, visible before anyone has to go read a
 * diff. Both numbers already exist at the moments this module is called from —
 * the CLI reports its usage at the end of every turn, and the landing knows the
 * exact commit range it fast-forwarded — so nothing here re-derives or samples.
 *
 * Everything is a pure function over data the pipeline already holds, so the
 * accounting is testable without a database, a git repository or a CLI.
 */

/** Per-ticket totals, accumulated across every turn and one landing. */
export interface TicketCost {
  /** Summed wall time of the agent's turns, milliseconds. */
  agent_ms: number;
  /** How many turns it took. Two cheap turns and one huge one read alike otherwise. */
  agent_turns: number;
  /** Fresh (uncached) input tokens. */
  tokens_in: number;
  /** Output tokens, including reasoning where the CLI reports it. */
  tokens_out: number;
  /** Cache-read input tokens — cheap, but they show how much context is re-read. */
  tokens_cached: number;
}

export const EMPTY_TICKET_COST: TicketCost = {
  agent_ms: 0,
  agent_turns: 0,
  tokens_in: 0,
  tokens_out: 0,
  tokens_cached: 0,
};

/** What one turn reported. Every field optional: CLIs differ and versions move. */
export interface TurnUsage {
  duration_ms?: number;
  tokens_in?: number;
  tokens_out?: number;
  tokens_cached?: number;
}

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/** The token unit used by both ticket earnings and shared-runtime spending. */
export function turnTokenTotal(turn: TurnUsage | null | undefined): number {
  return nonNegative(turn?.tokens_in) + nonNegative(turn?.tokens_out) + nonNegative(turn?.tokens_cached);
}

/**
 * Fold one turn into the running total.
 *
 * A turn always counts, even when the CLI reported no usage: "we spent a turn
 * and learned nothing measurable" is itself worth seeing in the list.
 */
export function accumulateTurnCost(prev: TicketCost | null | undefined, turn: TurnUsage): TicketCost {
  const base = prev ?? EMPTY_TICKET_COST;
  return {
    agent_ms: base.agent_ms + nonNegative(turn.duration_ms),
    agent_turns: base.agent_turns + 1,
    tokens_in: base.tokens_in + nonNegative(turn.tokens_in),
    tokens_out: base.tokens_out + nonNegative(turn.tokens_out),
    tokens_cached: base.tokens_cached + nonNegative(turn.tokens_cached),
  };
}

/** Blast radius and churn of the commit range a landing fast-forwarded. */
export interface LandDiffStat {
  files: number;
  /** Distinct top-level modules. `packages/<x>/…` counts as `<x>`. */
  modules: number;
  /** Module names, so the panel can name them rather than only count them. */
  moduleNames: string[];
  added: number;
  removed: number;
}

export const EMPTY_LAND_DIFF: LandDiffStat = { files: 0, modules: 0, moduleNames: [], added: 0, removed: 0 };

/**
 * Which module a path belongs to.
 *
 * `packages/<name>` is the real unit in this workspace — a change spanning
 * `packages/bot` and `packages/dashboard-web` crossed a boundary, while one
 * touching six files inside `packages/bot` did not. Everything else collapses
 * to its top directory so `doc/`, `config/` and root files stay countable
 * without pretending each is a package.
 */
export function moduleOf(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 0) return "(root)";
  if (parts[0] === "packages" && parts.length > 1) return parts[1];
  if (parts.length === 1) return "(root)";
  return parts[0];
}

/**
 * Parse `git diff --numstat`. Binary files report `-\t-\t<path>`: they count
 * as touched files but contribute no lines, which is exactly right — a 400 KB
 * PNG is not 400 000 lines of churn.
 */
export function parseNumstat(output: string): LandDiffStat {
  const modules = new Set<string>();
  let files = 0;
  let added = 0;
  let removed = 0;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const match = /^(-|\d+)\t(-|\d+)\t(.+)$/.exec(line);
    if (!match) continue;
    // `--no-renames` keeps this a plain path; without it git writes
    // `old => new`, and counting that as one file is still correct.
    const path = match[3].trim();
    if (!path) continue;
    files += 1;
    modules.add(moduleOf(path));
    if (match[1] !== "-") added += Number(match[1]);
    if (match[2] !== "-") removed += Number(match[2]);
  }
  const moduleNames = [...modules].sort();
  return { files, modules: moduleNames.length, moduleNames, added, removed };
}
