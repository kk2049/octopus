/**
 * The complete `list_recent_sessions` walk for the sessions MCP server.
 *
 * The scan layer (local) and the Runner Gateway (remote, every device after
 * one shared position) already page by the stable `[source, id]` order when a
 * string `cursor` is present and report `has_more`. This adds the one thing an
 * agent needs on top: an explicit `next_cursor`, absent exactly when nothing
 * remains. No cursor keeps the recent-activity page; when that page does not
 * hold every session its `next_cursor` starts the walk from the beginning.
 */

import { SESSION_LIST_START_CURSOR, sessionHistoryPage, sessionListCursor } from "@claude-bot/agent-sessions-contract";

interface ListResult {
  sessions?: Array<Record<string, unknown>>;
  total_found?: unknown;
  returned?: unknown;
  has_more?: unknown;
  history_supported?: unknown;
  [key: string]: unknown;
}

export function withListCursor(result: unknown, args: Readonly<Record<string, unknown>>): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const listing = result as ListResult;
  const rows = Array.isArray(listing.sessions) ? listing.sessions : [];
  const limit = Math.max(1, Math.min(500, Number(args.limit ?? 20) || 20));
  if (typeof args.cursor !== "string") {
    const incomplete = typeof listing.total_found === "number" ? listing.total_found > rows.length : rows.length >= limit;
    return incomplete ? { ...listing, next_cursor: SESSION_LIST_START_CURSOR } : listing;
  }
  // A source that ignored the cursor answered a different question; advancing
  // past its rows would skip sessions nobody returned.
  if (listing.history_supported === false || typeof listing.has_more !== "boolean") {
    throw new Error("会话来源尚不支持完整会话分页，未推进翻页位置；请更新 Runner 后用同一 cursor 重试");
  }
  const page = sessionHistoryPage(rows, sessionListCursor, limit, listing.has_more);
  return {
    ...listing,
    returned: page.sessions.length,
    sessions: page.sessions,
    ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}),
  };
}
