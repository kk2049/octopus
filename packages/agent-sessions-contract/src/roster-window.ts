/** Main conversations and their navigation attachments have separate budgets. */
export const SESSION_PRIMARY_WINDOW = 200;
export const SESSION_CHILD_WINDOW = 300;
/**
 * Provider-declared non-interactive runs (`codex exec` and its forks) have a
 * budget of their own. A harness can spawn hundreds of them an hour; sharing
 * the primary budget let such a burst evict every chat a person talks to.
 */
export const SESSION_AUTOMATED_WINDOW = 100;
export const SESSION_ROSTER_WINDOW = SESSION_PRIMARY_WINDOW + SESSION_AUTOMATED_WINDOW + SESSION_CHILD_WINDOW;

/** Same confirmed foreground evidence used by the recent-chat View. */
export function isForegroundTmuxSession(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const row = value as { stale?: unknown; runtime?: { process_state?: unknown; attachment?: {
    kind?: unknown; state?: unknown; transport?: unknown;
  } } };
  return !row.stale && row.runtime?.process_state === "alive"
    && row.runtime.attachment?.kind === "terminal_tmux"
    && row.runtime.attachment.state === "attached"
    && row.runtime.attachment.transport === "tmux";
}

/**
 * The provider declared that no person drove this chat: the Scanner's
 * `execution_mode` (device rows) or the Host's `executionMode` (public rows).
 * It is native log metadata, never a guess from a path, title or prompt.
 */
export function isAutomatedSession(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const row = value as { execution_mode?: unknown; executionMode?: unknown };
  return row.execution_mode === "exec" || row.executionMode === "exec";
}

export interface SessionWindowOptions<T> {
  /** Rows with their own budget; defaults to the provider exec declaration. */
  automated?: (row: T) => boolean;
  /** Rows a person kept (favorites, folders): always selected, never counted. */
  kept?: (row: T) => boolean;
}

/**
 * Activity order within each priority tier; uncertain lineage is a primary.
 *
 * Three independent budgets — primary chats, automated runs and declared
 * children — so no class of row can crowd another out. Rows a person kept
 * bypass every budget: truncation decides what is recent, not what exists.
 */
export function selectSessionWindow<T>(
  rows: readonly T[],
  limit: number,
  parentOf: (row: T) => string | null | undefined,
  priority: (row: T) => boolean = isForegroundTmuxSession,
  options: SessionWindowOptions<T> = {},
): T[] {
  const automatedOf = options.automated ?? isAutomatedSession;
  const keptOf = options.kept;
  const primary: T[] = [];
  const automated: T[] = [];
  const children: T[] = [];
  const count = Math.max(1, Math.min(SESSION_PRIMARY_WINDOW, Math.floor(limit) || SESSION_PRIMARY_WINDOW));
  const automatedCount = Math.min(SESSION_AUTOMATED_WINDOW, count);
  const preferred: T[] = [];
  const remaining: T[] = [];
  for (const row of rows) (priority(row) ? preferred : remaining).push(row);
  const used = { primary: 0, automated: 0, children: 0 };
  for (const row of [...preferred, ...remaining]) {
    const kept = keptOf?.(row) === true;
    const [list, budget, tier] = parentOf(row)
      ? [children, SESSION_CHILD_WINDOW, "children" as const]
      : automatedOf(row)
        ? [automated, automatedCount, "automated" as const]
        : [primary, count, "primary" as const];
    if (kept) list.push(row);
    else if (used[tier] < budget) {
      used[tier] += 1;
      list.push(row);
    }
  }
  // A legacy bounded consumer still receives the primary rows first.
  return [...primary, ...automated, ...children];
}

/**
 * A row's position in the complete roster walk: `[source, id]`, the order the
 * Scanner, Runner index, Gateway and catalog merges already page by with
 * `key > cursor`. Activity never moves a page boundary in this order.
 */
export function sessionListCursor(row: { source?: unknown; id?: unknown }): string {
  return JSON.stringify([String(row.source ?? ""), String(row.id ?? "")]);
}

/** Sorts before every real `[source, id]` position: page one of the complete walk. */
export const SESSION_LIST_START_CURSOR = sessionListCursor({});

/**
 * One page of the complete walk from rows that each source already returned
 * after the same cursor (each source returns at most `limit` rows).
 *
 * When more rows exist, the page ends before its last position group: copies
 * of one session on two devices share a position, and a merge window that cut
 * one copy off would otherwise be skipped by the next `key > cursor` page. A
 * page that is one group long keeps it, so a walk always advances.
 * `nextCursor` is absent exactly when nothing remains after this page.
 */
export function sessionHistoryPage<T>(
  rows: readonly T[],
  positionOf: (row: T) => string,
  limit: number,
  sourceHasMore: boolean,
): { sessions: T[]; nextCursor?: string } {
  const ordered = [...rows].sort((a, b) => {
    const left = positionOf(a);
    const right = positionOf(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const window = Math.max(1, Math.floor(limit) || 1);
  let sessions = ordered.slice(0, window);
  if (!sessions.length || (!sourceHasMore && ordered.length <= window)) return { sessions };
  const last = positionOf(sessions.at(-1)!);
  const whole = sessions.filter((row) => positionOf(row) !== last);
  if (whole.length) sessions = whole;
  return { sessions, nextCursor: positionOf(sessions.at(-1)!) };
}

/**
 * The bounded identity selector a trusted caller may add to a roster read:
 * `source:id` pairs, comma separated. It only narrows a read the Gate already
 * authorised; a device answers from its own catalog and ignores unknown ids.
 */
export const SESSION_IDS_MAX = 64;

export function encodeSessionIds(rows: readonly { source: string; id: string }[]): string {
  return rows.slice(0, SESSION_IDS_MAX).map((row) => `${row.source}:${row.id}`).join(",");
}

/** Total: malformed entries are dropped, never widened. */
export function decodeSessionIds(value: unknown): Array<{ source: "claude" | "codex" | "omp"; id: string }> {
  if (typeof value !== "string" || !value) return [];
  const out: Array<{ source: "claude" | "codex" | "omp"; id: string }> = [];
  const seen = new Set<string>();
  for (const part of value.split(",")) {
    const separator = part.indexOf(":");
    const source = part.slice(0, separator);
    const id = part.slice(separator + 1).trim();
    if (separator < 1 || (source !== "claude" && source !== "codex" && source !== "omp")) continue;
    if (!/^[A-Za-z0-9_.-]{1,200}$/.test(id) || seen.has(`${source}:${id}`)) continue;
    seen.add(`${source}:${id}`);
    out.push({ source, id });
    if (out.length === SESSION_IDS_MAX) break;
  }
  return out;
}
