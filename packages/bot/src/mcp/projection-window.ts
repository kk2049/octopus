/**
 * An App projection as MCP answers, one bounded window at a time.
 *
 * One answer carries at most `PROJECTION_WINDOW_CHARS` of JSON; the projection
 * itself has no size limit. A target that fits is answered whole. A target that
 * does not is answered as a page of its children (array elements or object
 * entries, in order, from `cursor`), each child either whole or — when it alone
 * is over the window — as its size, to be reached with a longer `path`. A string
 * over the window is answered as a character page. So every leaf is reachable by
 * `path` + `cursor`, and nothing is ever cut short and presented as whole: a
 * truncated JSON document would parse as a smaller state that never existed.
 */

import type { RuntimeJson } from "@claude-bot/app-runtime";

/** ~256 KiB of JSON — one answer's window on this surface, not a property of any App. */
export const PROJECTION_WINDOW_CHARS = 256 * 1024;

export type ProjectionWindow =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; message: string };

function chars(value: unknown): number {
  return JSON.stringify(value)?.length ?? 4;
}

/** RFC 6901 JSON Pointer lookup. `undefined` means "no such path". */
function resolve(root: RuntimeJson, path: string): RuntimeJson | undefined {
  if (path === "") return root;
  if (!path.startsWith("/")) return undefined;
  let at: RuntimeJson | undefined = root;
  for (const raw of path.slice(1).split("/")) {
    const token = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(at)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token)) return undefined;
      at = at[Number(token)];
    } else if (at !== null && typeof at === "object") {
      at = Object.prototype.hasOwnProperty.call(at, token) ? (at as Record<string, RuntimeJson>)[token] : undefined;
    } else {
      return undefined;
    }
    if (at === undefined) return undefined;
  }
  return at;
}

/**
 * The window of `projection` at `path`, starting at `cursor` (a child index for
 * a container, a character offset for a string; ignored when the target fits).
 */
export function projectionWindow(
  projection: RuntimeJson | null | undefined,
  path = "",
  cursor = 0,
  window = PROJECTION_WINDOW_CHARS,
): ProjectionWindow {
  const target = resolve(projection ?? null, path);
  if (target === undefined) return { ok: false, message: `投影中没有路径 ${JSON.stringify(path)}。` };
  const size = chars(target);
  if (size <= window) return { ok: true, value: { path, projection: target } };

  if (typeof target === "string") {
    const text = target.slice(cursor, cursor + window);
    const next = cursor + text.length;
    return {
      ok: true,
      value: {
        path,
        projection_text: { total_chars: target.length, from: cursor, text, ...(next < target.length ? { next } : {}) },
      },
    };
  }

  // Only a container can be over the window here: numbers, booleans and null
  // are a few characters each.
  const entries: Array<[string | number, RuntimeJson]> = Array.isArray(target)
    ? target.map((value, index) => [index, value])
    : Object.entries(target as Record<string, RuntimeJson>);
  const page: Array<Record<string, unknown>> = [];
  let used = 0;
  let at = cursor;
  for (; at < entries.length; at += 1) {
    const [key, value] = entries[at]!;
    let item: Record<string, unknown> = { key, value };
    if (chars(item) > window) item = { key, omitted_chars: chars(value) };
    const cost = chars(item) + 1;
    // At least one child per page, so a page always makes progress.
    if (page.length > 0 && used + cost > window) break;
    page.push(item);
    used += cost;
  }
  return {
    ok: true,
    value: {
      path,
      projection_page: {
        kind: Array.isArray(target) ? "array" : "object",
        total_chars: size,
        total: entries.length,
        from: cursor,
        entries: page,
        ...(at < entries.length ? { next: at } : {}),
      },
    },
  };
}
