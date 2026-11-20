/**
 * The session picker's pure logic: a flat roster in, two views out.
 *
 * A roster arrives as one flat list and becomes the same two things every
 * Session Hub surface shows — a short "recently active" strip and a
 * device → strict-cwd directory tree whose expand state is client-side. These
 * functions are DOM-free so they can be tested as what they are: rules.
 *
 * The compression rule is the one worth reading. A chain of single-child
 * directories with no sessions of their own collapses into one labelled node,
 * so `~/a/b/c/project` does not become four rows of nothing.
 */

import type { SessionSummary } from "@claude-bot/agent-sessions-contract";

/** One roster row, after the App has mapped projection fields onto tree keys. */
export interface RosterSession extends SessionSummary {
  id: string;
  device: string;
  cwd: string;
  /** True when a completed Agent turn has not been explicitly opened. */
  needsReview?: boolean;
  /** A person's explicit name keeps this chat directly visible in navigation. */
  userNamed?: boolean;
}

export interface DirNode {
  name: string;
  key: string;
  /** What the row shows: a leading `/` for an absolute top-level segment. */
  disp: string;
  /**
   * The directory this row stands for, as a path a device could resolve.
   *
   * Built from the same display strings the roster carries, so it is `~`-rooted
   * or absolute — or it contains the `…` the Runner uses when a session's cwd
   * lies outside its scan root, in which case it is NOT resolvable and the row
   * offers no shortcut. Deliberately derived here rather than in the renderer:
   * the tree already knows how it split the segments, and re-joining them
   * somewhere else would be a second answer to the same question.
   */
  dir: string;
  sessions: RosterSession[];
  children: DirNode[];
  /** Sessions in this subtree, including children. */
  count: number;
}

export interface DeviceGroup {
  device: string;
  total: number;
  children: DirNode[];
}

interface RawNode {
  name: string;
  sessions: RosterSession[];
  kids: Record<string, RawNode>;
}

export function buildDirTree(sessions: readonly RosterSession[]): DeviceGroup[] {
  const byDevice = new Map<string, { device: string; total: number; rootKids: Record<string, RawNode> }>();
  for (const session of sessions) {
    const device = session.device || "?";
    let group = byDevice.get(device);
    if (!group) {
      group = { device, total: 0, rootKids: {} };
      byDevice.set(device, group);
    }
    group.total++;
    const cwd = String(session.cwd || session.projectLabel || "").replace(/\\/g, "/");
    let segments = cwd.split("/").filter((part) => part.length > 0);
    if (!segments.length) segments = ["(未知目录)"];
    let kids = group.rootKids;
    let node: RawNode | null = null;
    for (const segment of segments) {
      if (!kids[segment]) kids[segment] = { name: segment, sessions: [], kids: {} };
      node = kids[segment];
      kids = node.kids;
    }
    node!.sessions.push(session);
  }
  return [...byDevice.keys()].sort().map((device) => {
    const group = byDevice.get(device)!;
    return {
      device,
      total: group.total,
      children: Object.keys(group.rootKids).sort()
        .map((key) => finalizeNode(group.rootKids[key], `dev:${device}`, "", true)),
    };
  });
}

function finalizeNode(raw: RawNode, parentKey: string, parentDir: string, top: boolean): DirNode {
  let name = raw.name;
  let current = raw;
  let kidNames = Object.keys(current.kids);
  while (current.sessions.length === 0 && kidNames.length === 1) {
    current = current.kids[kidNames[0]];
    name += `/${current.name}`;
    kidNames = Object.keys(current.kids);
  }
  const key = `${parentKey}/${name}`;
  const absolute = top && name.charAt(0) !== "(" && name.charAt(0) !== "~" && !/^[A-Za-z]:/.test(name);
  const dir = parentDir ? `${parentDir}/${name}` : absolute ? `/${name}` : name;
  const children = kidNames.sort().map((k) => finalizeNode(current.kids[k], key, dir, false));
  let count = current.sessions.length;
  for (const child of children) count += child.count;
  return {
    name,
    key,
    disp: absolute ? `/${name}` : name,
    dir,
    sessions: current.sessions,
    children,
    count,
  };
}

/**
 * Can this displayed directory be handed to a device as a request?
 *
 * `…` is what the Runner substitutes when a session's cwd is outside its scan
 * root, so a row showing `~/…/project` names a real directory whose path this
 * side was deliberately not told. Offering a one-click start there would produce
 * a refusal after the approval, which is the worst place to learn it.
 */
export function isResolvableDir(dir: string): boolean {
  if (!dir || dir.includes("…")) return false;
  return dir === "~" || dir.startsWith("~/") || dir.startsWith("/");
}

/** Every ancestor key of a session id, so the tree can be opened to it. */
export function pathTo(groups: readonly DeviceGroup[], id: string): string[] {
  const keys: string[] = [];
  for (const group of groups) {
    let found = false;
    const walk = (node: DirNode): boolean => {
      let hit = node.sessions.some((session) => session.id === id);
      for (const child of node.children) if (walk(child)) hit = true;
      if (hit) keys.push(node.key);
      return hit;
    };
    for (const child of group.children) if (walk(child)) found = true;
    if (found) keys.push(`dev:${group.device}`);
  }
  return keys;
}

/**
 * Sort for the recent strip without allowing intermediate Agent output to
 * reshuffle rows. `sortActivity` is precomputed once in the scanner's
 * versioned summary cache; legacy providers fall back to `lastActivity`.
 *
 * Confirmed foreground tmux sessions lead as one group, followed by favorites
 * and then the remaining chats. A favorite tmux session stays in the tmux
 * group, so pinning cannot override that group's activity order. Each group
 * uses the same stable activity comparison. Ties keep the incoming order. When
 * the controller already supplied the right order, the linear ordered check
 * avoids another O(n log n) sort.
 */
export function sortRecentSessions<T extends SessionSummary>(
  sessions: readonly T[],
  limit: number,
  pinned: readonly string[] = [],
): T[] {
  const pinnedIds = new Set(pinned);
  const rows = sessions.map((session, index) => ({
    session,
    at: session.sortActivity || session.lastActivity || "",
    priority: isForegroundTmuxSession(session) ? 0 : pinnedIds.has(session.resourceId) ? 1 : 2,
    index,
  }));
  const compare = (a: (typeof rows)[number], b: (typeof rows)[number]): number =>
    a.priority - b.priority || b.at.localeCompare(a.at) || a.index - b.index;
  const ordered = rows.every((row, index) => index === 0 || compare(rows[index - 1], row) <= 0);
  return (ordered ? rows : rows.sort(compare))
    .slice(0, limit)
    .map((row) => row.session);
}

/** The Runner has matched the live CLI to its foreground tmux pane. */
export function isForegroundTmuxSession(session: SessionSummary): boolean {
  const runtime = session.runtime;
  return !session.stale && runtime?.process_state === "alive"
    && runtime.attachment?.kind === "terminal_tmux"
    && runtime.attachment.state === "attached"
    && runtime.attachment.transport === "tmux";
}
