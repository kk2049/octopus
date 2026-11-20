/**
 * The unified directory index: one tree per device, sessions and files joined
 * by `directoryKey` — and ONLY by `directoryKey`.
 *
 * ── What this replaces ──────────────────────────────────────────────────────
 *
 * The roster used to guess which registered workspace a directory node "is" by
 * comparing display strings, labels and basenames (`matchingWorkspace`). That
 * guess folded two directories into one row the day two projects were both
 * called `src`, and it is exactly what the opaque equality key was minted to
 * remove. This module joins where keys are EQUAL and refuses to join anywhere
 * else. Absence of a key is "no promise", rendered as an honest note — never a
 * fallback to label comparison.
 *
 * ── The three joins, spelled out ────────────────────────────────────────────
 *
 *  1. A cwd-tree node ↔ a registered workspace row: a session AT that node
 *     carries the workspace root's key. One merged row, keeping the node's
 *     resolvable display path.
 *  2. A workspace row ↔ a `workspace-files/v2` root: equal keys give the row a
 *     files-plane ref, which is what makes it EXPANDABLE into the lazy file
 *     layer (`listDirectory`, one call per directory, on first open).
 *  3. Nothing else. Deeper file-layer directories render as files; deeper
 *     session groupings render as session rows. Where sessions run deeper than
 *     the joined root, the same real directory may appear once in each layer —
 *     honest duplication is preferred over a guessed merge.
 *
 * Pure functions over projections and per-instance display state, so every
 * join rule is a unit test rather than a rendering side effect.
 */

import type { WorkspaceGroup, WorkspaceRow } from "@claude-bot/agent-sessions-contract";
import type { WorkspaceFilesRoots } from "@claude-bot/workspace-files-contract";
import type {
  DirectoryCache,
  ExpandedDirectories,
  TreeRow,
} from "@claude-bot/agent-workspace-files-view";
import { visibleRows } from "@claude-bot/agent-workspace-files-view";
import { buildDirTree, type DirNode, type RosterSession } from "./roster.js";

/** The honest words for "these keys did not join". Compared by tests. */
export const FILES_UNAVAILABLE_NOTE = "文件关联不可用";

/**
 * A cwd branch this much older than the freshest one in the index is folded.
 *
 * The index is built from session history, and history keeps directories that
 * no longer exist — a deleted worktree, a machine that was reimaged, a clone
 * somebody threw away. This side cannot ask whether a directory still exists
 * (the sessions projection makes no such claim, and a probe per row would be a
 * capability call per row), so it uses the one fact it does have: when anything
 * last happened there. Folded, not dropped — the count and the reveal are right
 * there, because "we hid some of your directories" has to be something the
 * reader can see and undo.
 *
 * The comparison is against the NEWEST activity in the index rather than
 * against the wall clock, and that is deliberate twice over: the rule stays a
 * pure function of the projection (no clock to inject, no test that ages), and
 * coming back to the panel after a two-month holiday does not fold away
 * everything you own. A branch with no parseable timestamp is never folded —
 * "we could not date this" is not evidence of staleness.
 */
export const IDLE_DIRECTORY_MS = 30 * 24 * 60 * 60 * 1000;

/** Expansion key for the idle directories folded away under one parent row. */
export function idleKeyOf(parentKey: string): string {
  return `idle:${parentKey}`;
}

export type IndexRow =
  | {
      type: "device";
      device: string;
      key: string;
      open: boolean;
      total: number;
      scanRoot: boolean;
    }
  | {
      type: "directory";
      /** The cwd-tree node key (`dev:<device>/…`); drives expansion. */
      key: string;
      device: string;
      disp: string;
      /** Resolvable launch path, or "" when the display was elided (`…`). */
      dir: string;
      depth: number;
      open: boolean;
      count: number;
      /** The registered workspace this node IS, when keys said so. */
      workspace: WorkspaceRow | null;
      /** The files-plane ref of the joined root; null means no file layer. */
      rootRef: string | null;
      /** "" or the honest absence note (a workspace joined, files did not). */
      filesNote: string;
    }
  | {
      type: "workspace";
      /** Registered workspace with no session node to merge into. */
      key: string;
      device: string;
      row: WorkspaceRow;
      depth: number;
      open: boolean;
      rootRef: string | null;
      filesNote: string;
    }
  | {
      /** One row of a lazy file layer under a joined directory/workspace. */
      type: "files";
      row: TreeRow;
      depth: number;
    }
  | {
      /**
       * The joined root LISTING's own state: loading or refused. A listing
       * with more pages ends in its own "加载更多" row among the children.
       */
      type: "files-note";
      depth: number;
      loading: boolean;
      refusal: string;
    }
  | { type: "session"; session: RosterSession; depth: number }
  | {
      /** "N sibling directories here are folded away as long-idle." */
      type: "idle-note";
      key: string;
      device: string;
      depth: number;
      hidden: number;
      open: boolean;
    }
  | {
      /** A files root no registered workspace row claimed. Still browsable. */
      type: "loose-root";
      row: TreeRow;
    };

export interface DirectoryIndexInput {
  sessions: readonly RosterSession[];
  workspacesByDevice: Readonly<Record<string, WorkspaceGroup>>;
  /** `workspace-files` roots, possibly carrying v2 keys. Null before ready. */
  roots: WorkspaceFilesRoots | null;
  /** True once roots enumeration finished (either way): absence notes may show. */
  rootsSettled: boolean;
  cache: DirectoryCache;
  /** File-layer expansion, by opaque ref. */
  expandedDirs: ExpandedDirectories;
  /** Device / cwd-node / workspace expansion, by row key. */
  expanded: Readonly<Record<string, boolean>>;
  /**
   * The rail's files knob (ticket #61). Off means this is a SESSION index:
   * no file layer, no registered-workspace-only rows, no unclaimed roots —
   * the reader said they are not looking for files right now, and a tree that
   * kept half of them anyway would make the knob a decoration.
   */
  showFiles?: boolean;
}

function workspacesFor(map: Readonly<Record<string, WorkspaceGroup>>, device: string): WorkspaceRow[] {
  const value = map[device];
  return value && Array.isArray(value.workspaces) ? value.workspaces : [];
}

/** The key a node's own sessions vouch for, or "". Equality-only material. */
export function directKeyOf(node: Pick<DirNode, "sessions">): string {
  for (const session of node.sessions) {
    if (typeof session.directoryKey === "string" && session.directoryKey) return session.directoryKey;
  }
  return "";
}

/**
 * When anything last happened anywhere in this branch, as epoch ms.
 *
 * `0` for a branch whose sessions carry no parseable timestamp — which reads as
 * "idle since forever" and folds it away. That is the right default: a row the
 * projection cannot date is exactly the row nobody can vouch for.
 */
export function newestActivity(node: DirNode): number {
  let newest = 0;
  for (const session of node.sessions) {
    const at = session.lastActivity ? new Date(session.lastActivity).getTime() : 0;
    if (Number.isFinite(at) && at > newest) newest = at;
  }
  for (const child of node.children) {
    const at = newestActivity(child);
    if (at > newest) newest = at;
  }
  return newest;
}

interface RootLike {
  ref: string;
  label: string;
  sourceLabel: string;
  directoryKey?: string;
}

function rootsByKey(roots: WorkspaceFilesRoots | null): Map<string, RootLike> {
  const map = new Map<string, RootLike>();
  for (const root of roots?.roots ?? []) {
    const key = (root as RootLike).directoryKey;
    if (typeof key === "string" && key) map.set(key, root as RootLike);
  }
  return map;
}

/**
 * The visible file layer under one joined root ref.
 *
 * Reuses the files package's own flattening so lazy/refused/truncated rows keep
 * exactly one meaning: the head row carries the ROOT listing's own state, and
 * the rest are its visible descendants (depth starting at 1).
 */
export function fileLayer(
  rootRef: string,
  cache: DirectoryCache,
  expandedDirs: ExpandedDirectories,
): { head: TreeRow; children: TreeRow[] } {
  const expanded = new Set<string>(expandedDirs);
  expanded.add(rootRef);
  const rows = visibleRows(
    { roots: [{ ref: rootRef, label: "", sourceLabel: "" }], truncated: false },
    cache,
    expanded,
  );
  return { head: rows[0], children: rows.slice(1) };
}

/**
 * Flatten everything the reader can currently see, in order.
 *
 * Loose roots come last: a root nothing claimed still belongs to somebody's
 * machine, but WHICH device is a fact only a key join may assert.
 */
export function directoryIndexRows(input: DirectoryIndexInput): IndexRow[] {
  const out: IndexRow[] = [];
  const showFiles = input.showFiles !== false;
  const byKey = showFiles ? rootsByKey(input.roots) : new Map<string, RootLike>();
  const groups = buildDirTree(input.sessions);
  const grouped = new Set(groups.map((group) => group.device));
  const devices = [
    ...groups.map((group) => ({ device: group.device, children: group.children, total: group.total })),
    ...Object.keys(input.workspacesByDevice)
      .filter((device) => !grouped.has(device))
      .sort()
      .map((device) => ({ device, children: [] as DirNode[], total: 0 })),
  ];
  const claimedRootRefs = new Set<string>();
  // The freshest thing anywhere in the index, which is what "idle" is measured
  // against. A top-level walk covers every branch (each value is a subtree
  // maximum), and the memo means no branch is walked twice.
  const activityOf = new Map<DirNode, number>();
  const activityFor = (node: DirNode): number => {
    let value = activityOf.get(node);
    if (value === undefined) {
      value = newestActivity(node);
      activityOf.set(node, value);
    }
    return value;
  };
  let freshest = 0;
  for (const { children } of devices) {
    for (const child of children) freshest = Math.max(freshest, activityFor(child));
  }
  const isIdle = (node: DirNode): boolean => {
    const at = activityFor(node);
    return at > 0 && freshest - at > IDLE_DIRECTORY_MS;
  };

  // First pass: which workspace rows merge into nodes, and which roots are
  // claimed — independent of what is currently expanded, so a collapsed device
  // never re-classifies its roots as loose.
  const mergedWorkspace = new Map<string, WorkspaceRow>();
  const usedWorkspaceIds = new Map<string, Set<string>>();
  for (const { device, children } of devices) {
    const rows = workspacesFor(input.workspacesByDevice, device);
    const rowByKey = new Map<string, WorkspaceRow>();
    for (const row of rows) {
      if (row.directoryKey) {
        rowByKey.set(row.directoryKey, row);
        const root = byKey.get(row.directoryKey);
        if (root) claimedRootRefs.add(root.ref);
      }
    }
    const used = new Set<string>();
    usedWorkspaceIds.set(device, used);
    const claim = (node: DirNode): void => {
      const key = directKeyOf(node);
      const row = key ? rowByKey.get(key) : undefined;
      if (row) {
        mergedWorkspace.set(node.key, row);
        used.add(row.id);
      }
      for (const child of node.children) claim(child);
    };
    for (const child of children) claim(child);
  }

  const emitFileLayer = (rootRef: string, depth: number): void => {
    const layer = fileLayer(rootRef, input.cache, input.expandedDirs);
    // The head row is the joined directory itself — its own row already
    // rendered above — but its LISTING's state (loading / refusal) belongs to
    // the layer, so it travels as a depth-aligned note. More pages end in the
    // layer's own trailing "加载更多" row, after the last loaded child.
    if (layer.head.loading || layer.head.refusal) {
      out.push({
        type: "files-note",
        depth,
        loading: layer.head.loading === true,
        refusal: layer.head.refusal ?? "",
      });
    }
    for (const child of layer.children) {
      out.push({ type: "files", row: child, depth: depth + child.depth - 1 });
    }
  };

  const filesNoteFor = (rootRef: string | null): string => {
    if (rootRef || !showFiles) return "";
    return input.rootsSettled ? FILES_UNAVAILABLE_NOTE : "";
  };

  const emitNode = (device: string, node: DirNode, depth: number): void => {
    const workspace = mergedWorkspace.get(node.key) ?? null;
    const root = workspace?.directoryKey ? byKey.get(workspace.directoryKey) : undefined;
    const rootRef = root?.ref ?? null;
    const open = input.expanded[node.key] === true;
    out.push({
      type: "directory",
      key: node.key,
      device,
      disp: node.disp,
      dir: node.dir,
      depth,
      open,
      count: node.count,
      workspace,
      rootRef,
      filesNote: workspace ? filesNoteFor(rootRef) : "",
    });
    if (!open) return;
    if (rootRef) emitFileLayer(rootRef, depth + 1);
    emitChildren(device, node.key, node.children, depth + 1);
    for (const session of node.sessions) out.push({ type: "session", session, depth: depth + 1 });
  };

  /**
   * One level of directory rows, with the long-idle ones folded behind a count.
   *
   * Per level rather than per device: a device's tree is usually one `~` node
   * with everything under it, so a fold that only applied to the device's own
   * children would fold nothing anybody has.
   */
  const emitChildren = (device: string, parentKey: string, children: DirNode[], depth: number): void => {
    const key = idleKeyOf(parentKey);
    const open = input.expanded[key] === true;
    const idle = new Set(children.filter(isIdle));
    for (const child of children) {
      if (!open && idle.has(child)) continue;
      emitNode(device, child, depth);
    }
    if (idle.size) out.push({ type: "idle-note", key, device, depth, hidden: idle.size, open });
  };

  for (const { device, children, total } of devices) {
    // A device known only through its workspace registry has nothing to show
    // once files are off — an empty header is not wayfinding.
    if (!showFiles && !children.length) continue;
    const deviceKey = `dev:${device}`;
    // Devices start expanded: a collapsed-by-default tree hides the only thing
    // this rail is for.
    const open = input.expanded[deviceKey] ?? true;
    out.push({
      type: "device",
      device,
      key: deviceKey,
      open,
      total,
      scanRoot: device === "bot-host",
    });
    if (!open) continue;
    emitChildren(device, deviceKey, children, 0);
    if (!showFiles) continue;
    const used = usedWorkspaceIds.get(device) ?? new Set<string>();
    for (const row of workspacesFor(input.workspacesByDevice, device)) {
      if (used.has(row.id)) continue;
      const root = row.directoryKey ? byKey.get(row.directoryKey) : undefined;
      const rootRef = root?.ref ?? null;
      const key = `ws:${device}:${row.id}`;
      const openRow = input.expanded[key] === true;
      out.push({
        type: "workspace",
        key,
        device,
        row,
        depth: 0,
        open: openRow,
        rootRef,
        filesNote: filesNoteFor(rootRef),
      });
      if (openRow && rootRef) emitFileLayer(rootRef, 1);
    }
  }

  // Roots nothing claimed: still browsable, attributed to no device.
  const loose = showFiles
    ? (input.roots?.roots ?? []).filter((root) => !claimedRootRefs.has(root.ref))
    : [];
  if (loose.length) {
    const rows = visibleRows({ roots: loose, truncated: false }, input.cache, input.expandedDirs);
    for (const row of rows) out.push({ type: "loose-root", row });
  }
  return out;
}
