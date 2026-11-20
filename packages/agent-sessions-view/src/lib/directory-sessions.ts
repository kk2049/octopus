/**
 * Sessions that belong to one navigation-directory subtree.
 *
 * There are deliberately two mappings here, with different meanings:
 *
 *  - opaque `directoryKey` equality joins a file resource to a session and is
 *    still the only mapping allowed to claim resource identity;
 *  - exact `(device, ~/display/path)` ancestry groups rows in the already
 *    display-only home navigator. It drives the blue history marker and never
 *    addresses a file request or grants authority.
 *
 * The second mapping is what lets overlapping registered roots render as one
 * useful folder even though each root mints its opaque keys in its own
 * namespace. Redacted `~/…` paths are excluded rather than guessed.
 */

import type { DirectoryCache, TreeRow } from "@claude-bot/agent-workspace-files-view";
import type { RosterSession } from "./roster.js";

export interface DirectorySessionMatch {
  session: RosterSession;
  /** Zero is the selected directory; one is one directory below it. */
  depth: number;
}

export interface DirectorySessionsInput {
  directory: Pick<TreeRow, "ref" | "directoryKey">;
  sessions: readonly RosterSession[];
  cache: DirectoryCache;
}

export interface NavigationDirectorySessionsInput {
  directory?: Pick<TreeRow, "ref" | "directoryKey"> | null;
  display?: { device: string; directory: string } | null;
  sessions: readonly RosterSession[];
  cache: DirectoryCache;
}

function projectedDirectoryKey(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const key = (value as { directoryKey?: unknown }).directoryKey;
  return typeof key === "string" && key ? key : undefined;
}

function directoryDepths(directory: DirectorySessionsInput["directory"], cache: DirectoryCache) {
  if (!directory.ref) return new Map<string, number>();
  const seenRefs = new Set<string>();
  const depthByKey = new Map<string, number>();
  const visit = (ref: string, key: string | undefined, depth: number): void => {
    if (seenRefs.has(ref)) return;
    seenRefs.add(ref);
    const state = cache.get(ref);
    const effectiveKey = key ?? projectedDirectoryKey(state?.value);
    if (effectiveKey) {
      const previous = depthByKey.get(effectiveKey);
      if (previous === undefined || depth < previous) depthByKey.set(effectiveKey, depth);
    }
    if (state?.status !== "ready" || !state.value) return;
    for (const entry of state.value.entries) {
      if (entry.kind !== "directory" || !entry.ref) continue;
      visit(entry.ref, projectedDirectoryKey(entry), depth + 1);
    }
  };

  visit(directory.ref, directory.directoryKey, 0);
  return depthByKey;
}

/**
 * Return exact-key matches, shallowest directory first and projection order as
 * the stable tiebreaker. Cyclic or repeated refs cannot duplicate a session.
 */
export function sessionsInDirectorySubtree({
  directory,
  sessions,
  cache,
}: DirectorySessionsInput): DirectorySessionMatch[] {
  const depthByKey = directoryDepths(directory, cache);
  const seenSessions = new Set<string>();
  const matches: Array<DirectorySessionMatch & { order: number }> = [];
  sessions.forEach((session, order) => {
    const depth = session.directoryKey ? depthByKey.get(session.directoryKey) : undefined;
    if (depth === undefined || seenSessions.has(session.resourceId)) return;
    seenSessions.add(session.resourceId);
    matches.push({ session, depth, order });
  });
  return matches
    .sort((left, right) => left.depth - right.depth || left.order - right.order)
    .map(({ session, depth }) => ({ session, depth }));
}

function homeSegments(value: string): string[] | null {
  const normalized = value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalized || normalized.includes("…")) return null;
  if (normalized === "~") return [];
  if (!normalized.startsWith("~/")) return null;
  const segments = normalized.slice(2).split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  return segments;
}

/** Display-only history grouping for one resolvable home-directory row. */
export function sessionsInDisplayDirectorySubtree(
  display: { device: string; directory: string },
  sessions: readonly RosterSession[],
): DirectorySessionMatch[] {
  const parent = homeSegments(display.directory);
  if (!display.device || !parent) return [];
  const matches: Array<DirectorySessionMatch & { order: number }> = [];
  sessions.forEach((session, order) => {
    if (session.device !== display.device) return;
    const child = homeSegments(session.cwd);
    if (!child || child.length < parent.length) return;
    if (parent.some((segment, index) => child[index] !== segment)) return;
    matches.push({ session, depth: child.length - parent.length, order });
  });
  return matches
    .sort((left, right) => left.depth - right.depth || left.order - right.order)
    .map(({ session, depth }) => ({ session, depth }));
}

/**
 * Merge exact resource joins with display-only navigation grouping. A session
 * seen through both routes is one row, at the shallowest proven/displayed
 * depth, with original projection order as the stable tiebreaker.
 */
export function sessionsInNavigationDirectory({ sessions, cache, ...target }: NavigationDirectorySessionsInput): DirectorySessionMatch[] {
  return createDirectorySessionsIndex(sessions, cache).matches(target);
}

type NavigationTarget = Omit<NavigationDirectorySessionsInput, "sessions" | "cache">;
type OrderedMatch = DirectorySessionMatch & { order: number };

/** One index per immutable roster/listing generation, shared by all directory
 * rows. Lookups visit listed descendants and matching buckets, not the entire
 * roster. Query memoization lives only as long as this index, never globally. */
export function createDirectorySessionsIndex(sessions: readonly RosterSession[], cache: DirectoryCache) {
  const byKey = new Map<string, Array<{ session: RosterSession; order: number }>>();
  const byHome = new Map<string, OrderedMatch[]>();
  const resourceOrder = new Map<string, number>();
  const homeKey = (device: string, segments: readonly string[]) => JSON.stringify([device, segments]);
  sessions.forEach((session, order) => {
    resourceOrder.set(session.resourceId, order);
    if (session.directoryKey) {
      const bucket = byKey.get(session.directoryKey) ?? [];
      bucket.push({ session, order });
      byKey.set(session.directoryKey, bucket);
    }
    const segments = homeSegments(session.cwd);
    if (!session.device || !segments) return;
    for (let depth = 0; depth <= segments.length; depth += 1) {
      const key = homeKey(session.device, segments.slice(0, depth));
      const bucket = byHome.get(key) ?? [];
      bucket.push({ session, order, depth: segments.length - depth });
      byHome.set(key, bucket);
    }
  });
  const memo = new Map<string, DirectorySessionMatch[]>();
  return {
    matches({ directory, display }: NavigationTarget): DirectorySessionMatch[] {
      const segments = display ? homeSegments(display.directory) : null;
      const displayKey = display?.device && segments ? homeKey(display.device, segments) : null;
      const queryKey = JSON.stringify([directory?.ref, directory?.directoryKey, displayKey]);
      const cached = memo.get(queryKey);
      if (cached) return cached;
      const exact = new Map<string, OrderedMatch>();
      if (directory) {
        for (const [key, depth] of directoryDepths(directory, cache)) {
          for (const { session, order } of byKey.get(key) ?? []) {
            const previous = exact.get(session.resourceId);
            // Retain the first matching projection row, as the original scan
            // did, even if a duplicate resource advertises another key.
            if (!previous || order < previous.order) exact.set(session.resourceId, { session, depth, order });
          }
        }
      }
      const bySession = new Map<string, DirectorySessionMatch>(exact);
      for (const candidate of displayKey ? byHome.get(displayKey) ?? [] : []) {
        const previous = bySession.get(candidate.session.resourceId);
        if (!previous || candidate.depth < previous.depth) bySession.set(candidate.session.resourceId, candidate);
      }
      const matches = [...bySession.values()]
        .sort((left, right) => left.depth - right.depth
          || resourceOrder.get(left.session.resourceId)! - resourceOrder.get(right.session.resourceId)!)
        .map(({ session, depth }) => ({ session, depth }));
      memo.set(queryKey, matches);
      return matches;
    },
  };
}
