import { selectSessionWindow } from "@claude-bot/agent-sessions-contract";
/** Trusted Host-side mechanics for Sessions+ split-session provenance. */

import { mergeSearchPages, sessionListCursor, subagentParentId, type SearchPagePart } from "@claude-bot/plugin-sessions/scan";
import { createHash } from "node:crypto";
import type { SessionPlusSplitSessionRow } from "../store/store.js";

export interface PreparedSessionCatalogEntry {
  runtimeOwner: string;
  runtimeDevice: string;
  source: "claude" | "codex" | "omp";
  sessionId: string;
  catalogId: string | null;
  executionDevice: string;
  workspaceId: string;
  workspaceLabel: string;
  workspaceDisplay: string;
}

export interface SessionCatalogSupplement {
  device: string;
  result: unknown;
  catalog: readonly PreparedSessionCatalogEntry[];
}

/** Stable across an idempotent launch replay, but meaningful only to trusted code. */
export function sessionPlusCatalogId(owner: string, operationId: string): string {
  return `spc_${createHash("sha256").update(JSON.stringify([owner, operationId])).digest("hex")}`;
}

export function preparedSessionCatalogEntry(row: SessionPlusSplitSessionRow): PreparedSessionCatalogEntry {
  return {
    runtimeOwner: row.runtime_owner,
    runtimeDevice: row.runtime_device,
    source: row.source,
    sessionId: row.session_id,
    catalogId: row.catalog_id,
    executionDevice: row.execution_device,
    workspaceId: row.workspace_id,
    workspaceLabel: row.workspace_label,
    workspaceDisplay: row.workspace_display,
  };
}

export function sessionCatalogWireEntry(row: PreparedSessionCatalogEntry): Record<string, unknown> {
  return {
    id: row.sessionId,
    ...(row.catalogId ? { catalog_id: row.catalogId } : {}),
    execution_device: row.executionDevice,
    workspace_id: row.workspaceId,
  };
}

/** Group exact calls without ever mixing authenticated runtime owners/devices/providers. */
export function groupSessionCatalogEntries(
  rows: readonly PreparedSessionCatalogEntry[],
): PreparedSessionCatalogEntry[][] {
  const groups = new Map<string, PreparedSessionCatalogEntry[]>();
  for (const row of rows) {
    const key = JSON.stringify([row.runtimeOwner, row.runtimeDevice, row.source]);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/**
 * In-process trusted association, intentionally absent from JSON.
 *
 * A Runner response cannot forge this WeakMap entry. The capability adapter
 * installs it only after matching the owner-scoped Host catalog; the resource
 * projection consumes it before serialising its explicit public allowlist.
 */
const directoryPlacements = new WeakMap<object, Map<string, PreparedSessionCatalogEntry>>();

export function sessionDirectoryPlacement(
  result: object,
  session: Readonly<Record<string, unknown>>,
): PreparedSessionCatalogEntry | undefined {
  return directoryPlacements.get(result)?.get(sessionKey(session));
}

export function mergeSessionCatalogList(
  base: unknown,
  supplements: readonly SessionCatalogSupplement[],
  args: Readonly<Record<string, unknown>>,
): unknown {
  const root = record(base);
  const ordinarySessions = records(root.sessions).map((session) => ({ ...session }));
  const splitSessions: Array<Record<string, unknown>> = [];
  const returnedRows = new Map<string, PreparedSessionCatalogEntry>();
  let total = finite(root.total_found);
  let hasMore = root.has_more === true;
  let historySupported = root.history_supported !== false && (!Array.isArray(root.sessions) || typeof root.has_more === "boolean");
  const devices = strings(root.devices);
  for (const supplement of supplements) {
    const part = record(supplement.result);
    hasMore ||= part.has_more === true;
    historySupported &&= typeof part.has_more === "boolean";
    const selectedByKey = selectedCatalogRows(supplement.catalog);
    let acceptedCount = 0;
    let accepted = false;
    for (const raw of records(part.sessions)) {
      const session = { ...raw, device: supplement.device };
      const key = sessionKey(session);
      const catalogRow = selectedByKey.get(key);
      // The Runner is a data source, not the catalog authority. Even this
      // private method must not widen the Host's exact positive selection.
      if (!catalogRow) continue;
      accepted = true;
      if (!returnedRows.has(key)) acceptedCount += 1;
      splitSessions.push(session);
      returnedRows.set(key, catalogRow);
    }
    total += acceptedCount;
    if (accepted) devices.push(supplement.device);
  }
  // A provider id can exist in both ordinary and split roots after a manual
  // copy. Prefer the selectively-read split row so later exact reads address
  // the same corpus that supplied the roster summary.
  const unique = dedupeSessions([...splitSessions, ...ordinarySessions]);
  unique.sort((left, right) => activity(right).localeCompare(activity(left)));
  if (typeof args.cursor === "string") unique.sort((a, b) => sessionListCursor(a) < sessionListCursor(b) ? -1 : sessionListCursor(a) > sessionListCursor(b) ? 1 : 0);
  const limit = boundedInt(args.limit, 1, 500, 20);
  const selected = args.primary_window === true && typeof args.cursor !== "string"
    ? selectSessionWindow(unique, limit, subagentParentId) : unique.slice(0, limit);
  const result = {
    ...root,
    devices: [...new Set(devices.filter(Boolean))],
    total_found: Math.max(total, unique.length),
    ...(typeof args.cursor === "string" ? { has_more: hasMore || unique.length > limit, history_supported: historySupported } : {}),
    returned: selected.length,
    sessions: selected,
    note: selected.length ? undefined : root.note,
  };
  rememberDirectoryPlacements(result, [...returnedRows.values()]);
  return result;
}

/**
 * One page of a complete search over the ordinary roster plus exact split
 * sessions. Each child is a paged search (see plugins/sessions search.ts):
 * supplements are filtered to the Host's positive selection before the shared
 * merge, which keeps only hits every child has searched past. `failed` names
 * children whose call was rejected; they are reported, never silently skipped.
 */
export function mergeSessionCatalogSearch(
  base: unknown,
  supplements: readonly SessionCatalogSupplement[],
  args: Readonly<Record<string, unknown>>,
  failed: readonly string[] = [],
): unknown {
  const root = record(base);
  const returnedRows = new Map<string, PreparedSessionCatalogEntry>();
  const devices = strings(root.devices);
  // Split rows first: among equal positions the merge keeps input order, and
  // the dedupe below then prefers the selectively-read split row.
  const parts: SearchPagePart[] = [];
  for (const supplement of supplements) {
    const part = record(supplement.result);
    const selectedByKey = selectedCatalogRows(supplement.catalog);
    const results: Array<Record<string, unknown>> = [];
    for (const item of records(part.results)) {
      const hit = cloneSearchHit(item);
      hit.session = { ...record(hit.session), device: supplement.device };
      const catalogRow = selectedByKey.get(sessionKey(record(hit.session)));
      // The Runner is a data source, not the catalog authority.
      if (!catalogRow) continue;
      results.push(hit);
      returnedRows.set(sessionKey(record(hit.session)), catalogRow);
    }
    if (results.length) devices.push(supplement.device);
    parts.push({
      label: supplement.device,
      page: {
        ...part,
        results,
        scanned: Math.min(finite(part.scanned), supplement.catalog.length),
        total_candidates: Math.min(finite(part.total_candidates), supplement.catalog.length),
      },
    });
  }
  if (base !== undefined) parts.push({ label: "runner", page: { ...root, results: records(root.results).map(cloneSearchHit) } });
  parts.push(...failed.map((label) => ({ label })));
  const page = mergeSearchPages(parts, boundedInt(args.limit, 1, 50, 10), typeof args.cursor === "string" && args.cursor !== "");
  const seen = new Set<string>();
  const results = page.results.filter((item) => {
    const key = sessionKey(record(item.session));
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // The base page's own window facts are superseded by the merged page's.
  const { next_cursor: _next, incomplete_sources: _incomplete, ...rest } = root;
  const result = {
    ...rest,
    ...page,
    devices: [...new Set(devices.filter(Boolean))],
    returned: results.length,
    results,
  };
  for (const key of [...returnedRows.keys()]) if (!seen.has(key)) returnedRows.delete(key);
  rememberDirectoryPlacements(result, [...returnedRows.values()]);
  return result;
}

function rememberDirectoryPlacements(result: object, rows: readonly PreparedSessionCatalogEntry[]): void {
  const map = new Map<string, PreparedSessionCatalogEntry>();
  for (const row of rows) map.set(sessionKey({ device: row.runtimeDevice, source: row.source, id: row.sessionId }), row);
  directoryPlacements.set(result, map);
}

function selectedCatalogRows(
  rows: readonly PreparedSessionCatalogEntry[],
): ReadonlyMap<string, PreparedSessionCatalogEntry> {
  return new Map(rows.map((row) => [
    sessionKey({ device: row.runtimeDevice, source: row.source, id: row.sessionId }),
    row,
  ]));
}

function dedupeSessions(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = sessionKey(row);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sessionKey(row: Readonly<Record<string, unknown>>): string {
  const device = String(row.device ?? "");
  const source = String(row.source ?? "");
  const id = String(row.id ?? "");
  return device && source && id ? JSON.stringify([device, source, id]) : "";
}

function activity(row: Readonly<Record<string, unknown>>): string {
  return String(row.sort_activity ?? row.last_activity ?? "");
}

function cloneSearchHit(row: Record<string, unknown>): Record<string, unknown> {
  return { ...row, session: { ...record(row.session) } };
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function records(value: unknown): Array<Record<string, any>> {
  return Array.isArray(value) ? value.filter((row) => row && typeof row === "object" && !Array.isArray(row)) : [];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function finite(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function boundedInt(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  return Number.isInteger(number) ? Math.min(max, Math.max(min, number)) : fallback;
}
