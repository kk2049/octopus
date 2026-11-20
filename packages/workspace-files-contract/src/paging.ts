/**
 * Reaching every entry of a directory and every root of a scope, one bounded
 * page at a time (2026-10-20).
 *
 * `maxEntries` and `maxRoots` bound ONE answer — one proposal reply, one Gate
 * result, one port message. They used to be the whole listing too, because
 * nothing could ask for "the rest". Now a listing is a keyset walk:
 *
 *   listDirectory(ref)                  → page 1, truncated = true
 *   listDirectory(ref, after = cursor)  → the entries strictly after it
 *
 * ── Why the cursor is the last row and not an offset ───────────────────────
 *
 * A directory changes while somebody pages through it. An offset counts rows,
 * so one file created before the cursor shifts every later row by one and the
 * next page silently repeats or skips. A keyset cursor names a POSITION in the
 * listing's total order — "after (file, `b.txt`)" — so an entry added or
 * removed anywhere else can neither repeat a row already shown nor hide one not
 * yet shown. Every entry that exists for the whole walk is seen exactly once.
 *
 * ── Why no reply field is needed (and therefore no new contract version) ────
 *
 * Every reader of a listing refuses unknown fields, so a reply-side cursor
 * would have made each installed App bundle refuse every listing. It is not
 * needed: the order is stated here, and both halves of the cursor — kind and
 * label — are already projected on every row. `truncated` already says "more
 * entries follow the last one". So the reply is byte-identical, and the only
 * addition is an optional REQUEST parameter that installed bundles never send.
 *
 * The same property makes the answer self-verifying: every row of a continued
 * page must sort strictly after the cursor. A provider that ignored the cursor
 * (an older Host) answers page 1 again, and its first row fails that check —
 * which the remote client turns into a refusal rather than repeated rows.
 *
 * ── The order ──────────────────────────────────────────────────────────────
 *
 * Directories, then files, then everything unaddressable; within a kind, by
 * UTF-16 code unit — JavaScript's `<` on strings. Locale-free, so two machines
 * and two readers agree. The device sorts with exactly this comparator.
 */

import { WORKSPACE_FILES_LIMITS, isWorkspaceEntryKind, type WorkspaceEntryKind } from "./limits.js";

/** The listing's total order: kind rank first. */
export const WORKSPACE_ENTRY_KIND_RANK: Readonly<Record<WorkspaceEntryKind, number>> = Object.freeze({
  directory: 0,
  file: 1,
  other: 2,
});

/** One position in a listing: what a cursor names. */
export interface WorkspaceListPosition {
  readonly kind: WorkspaceEntryKind;
  readonly label: string;
}

/** The proposal parameter that carries a cursor. Shared by listings and roots. */
export const RESOURCE_PAGE_PARAM = "after";

/**
 * `directory/` + a label of at most `maxLabelLength` characters. A POSIX name
 * cannot contain `/`, so the first one separates the two halves unambiguously.
 */
export const WORKSPACE_LIST_CURSOR_MAX_LENGTH = "directory/".length + WORKSPACE_FILES_LIMITS.maxLabelLength;

/** Negative, zero or positive, as `Array.prototype.sort` expects. */
export function compareWorkspaceListPositions(a: WorkspaceListPosition, b: WorkspaceListPosition): number {
  const rank = WORKSPACE_ENTRY_KIND_RANK[a.kind] - WORKSPACE_ENTRY_KIND_RANK[b.kind];
  if (rank !== 0) return rank;
  return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
}

/** The cursor that continues a listing after `entry`: the entry itself. */
export function workspaceListCursor(entry: WorkspaceListPosition): string {
  return `${entry.kind}/${entry.label}`;
}

/** Parse a cursor, or null when it is not one. Never repaired. */
export function readWorkspaceListCursor(value: unknown): WorkspaceListPosition | null {
  if (typeof value !== "string" || value.length > WORKSPACE_LIST_CURSOR_MAX_LENGTH) return null;
  const slash = value.indexOf("/");
  if (slash <= 0) return null;
  const kind = value.slice(0, slash);
  const label = value.slice(slash + 1);
  if (!isWorkspaceEntryKind(kind)) return null;
  if (
    label.length === 0
    || label.length > WORKSPACE_FILES_LIMITS.maxLabelLength
    || label.includes("/")
    || label.includes("\u0000")
  ) {
    return null;
  }
  return { kind, label };
}

/** The cursor for the page after `entries`, or null for an empty page. */
export function workspaceListCursorAfter(entries: readonly WorkspaceListPosition[]): string | null {
  const last = entries.at(-1);
  return last ? workspaceListCursor(last) : null;
}
