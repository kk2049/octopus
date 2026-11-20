/**
 * Chats a person kept — favorites and folder members — stay in the roster
 * after they age out of the recency window.
 *
 * The App owns the keep-set: opaque resources in its durable state, merged into
 * the instance projection. The Host decodes only resources it minted for this
 * owner, asks each online device for those exact identities through the same
 * `list_recent_sessions` authority that produced the window, and remembers each
 * answer briefly so a burst of wake refreshes is not a burst of device reads.
 * The cache is display data for one open instance; it authorises nothing.
 */

import { BOT_HOST_DEVICE, decodeResourceId } from "../sessionhub/core.js";
import type { HubSessionSummary } from "../sessionhub/service.js";

/** Pins and folder members considered per refresh, in the person's own order. */
export const KEPT_SESSIONS_MAX = 256;
/** A kept chat outside the window is idle by definition; a minute-old summary is fine. */
export const KEPT_LOOKUP_TTL_MS = 60_000;

export interface KeptIdentity {
  resourceId: string;
  device: string;
  source: "claude" | "codex" | "omp";
  id: string;
}

/**
 * Favorites first, then folder members. Resources minted for another owner and
 * bot-host scan rows (whose plane has no identity selector) are skipped.
 */
export function keptIdentities(projection: unknown, owner: string): KeptIdentity[] {
  const state = projection !== null && typeof projection === "object" ? projection as Record<string, unknown> : {};
  const resources: string[] = [];
  for (const value of Array.isArray(state.pinned) ? state.pinned : []) if (typeof value === "string") resources.push(value);
  for (const folder of Array.isArray(state.sessionFolders) ? state.sessionFolders : []) {
    const sessions = folder !== null && typeof folder === "object" ? (folder as { sessions?: unknown }).sessions : undefined;
    for (const value of Array.isArray(sessions) ? sessions : []) if (typeof value === "string") resources.push(value);
  }
  const out: KeptIdentity[] = [];
  const seen = new Set<string>();
  for (const resourceId of resources) {
    if (seen.has(resourceId)) continue;
    seen.add(resourceId);
    const decoded = decodeResourceId(resourceId);
    if (!decoded || decoded.owner !== owner || !decoded.device || decoded.device === BOT_HOST_DEVICE) continue;
    out.push({ resourceId, device: decoded.device, source: decoded.cliKind, id: decoded.sessionId });
    if (out.length === KEPT_SESSIONS_MAX) break;
  }
  return out;
}

/** Per-instance memory of exact-identity answers: a row, or `null` for "the device has no such chat". */
export class KeptSessionCache {
  private readonly instances = new Map<string, Map<string, { row: HubSessionSummary | null; at: number }>>();

  fresh(instanceId: string, resourceId: string, now: number): { row: HubSessionSummary | null } | undefined {
    const entry = this.instances.get(instanceId)?.get(resourceId);
    return entry && now - entry.at < KEPT_LOOKUP_TTL_MS ? { row: entry.row } : undefined;
  }

  remember(instanceId: string, resourceId: string, row: HubSessionSummary | null, now: number): void {
    let entries = this.instances.get(instanceId);
    if (!entries) this.instances.set(instanceId, entries = new Map());
    entries.delete(resourceId);
    entries.set(resourceId, { row, at: now });
    // Kept identities are bounded per refresh; evict the oldest beyond that.
    while (entries.size > KEPT_SESSIONS_MAX) entries.delete(entries.keys().next().value!);
  }

  prune(alive: (instanceId: string) => boolean): void {
    for (const instanceId of [...this.instances.keys()]) if (!alive(instanceId)) this.instances.delete(instanceId);
  }
}
