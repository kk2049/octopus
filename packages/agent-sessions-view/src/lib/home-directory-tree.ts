/**
 * A display-only home-rooted tree over the workspace-files roots.
 *
 * The files plane deliberately exposes each registered workspace as an opaque
 * root. The sessions plane separately exposes that root's safe display path
 * and the equality key that proves which two rows describe the same directory.
 * This module uses that exact key to attach roots, then uses the display path
 * to build navigation parents and coalesce overlapping roots at the same safe
 * `(device, ~/path)` presentation coordinate. No display segment is ever
 * turned into a file request: opening and listing still use the trusted
 * root/entry refs. It may prefill the already-freeform new-session directory;
 * the Runner remains the authority that resolves and validates that path.
 */

import type { SessionSummary, WorkspaceGroup, WorkspaceRow } from "@claude-bot/agent-sessions-contract";
import type { WorkspaceFilesRoot, WorkspaceFilesRoots } from "@claude-bot/workspace-files-contract";
import {
  visibleRows,
  type DirectoryCache,
  type ExpandedDirectories,
  type TreeRow,
  type ListedFileLocation,
} from "@claude-bot/agent-workspace-files-view";
import { pathSegments } from "./file-link.js";

export type HomeDirectoryRow =
  | {
      type: "device";
      key: string;
      label: string;
      /** Trusted sessions-plane device id; absent for files-only scan sources. */
      terminalDevice: string | null;
      open: boolean;
      total: number;
    }
  | {
      type: "directory";
      key: string;
      label: string;
      depth: number;
      open: boolean;
      /** Present only when this display node is backed by one opaque root. */
      root: TreeRow | null;
      /** Display-only launch prefill. The Runner still validates it on submit. */
      launch: DirectoryLaunchTarget | null;
    }
  | {
      type: "files";
      row: TreeRow;
      depth: number;
      /** Present for a resolvable directory row, absent for files and redacted paths. */
      launch: DirectoryLaunchTarget | null;
    };

export interface DirectoryLaunchTarget {
  device: string;
  directory: string;
}

export interface HomeDirectoryTreeInput {
  roots: WorkspaceFilesRoots | null;
  /** Known sessions-plane Runner ids, independent of the bounded workspace cache. */
  devices?: readonly string[];
  workspacesByDevice: Readonly<Record<string, WorkspaceGroup>>;
  cache: DirectoryCache;
  expandedDirs: ExpandedDirectories;
  /** Synthetic device/home/path expansion. Opaque file refs stay in expandedDirs. */
  expanded: Readonly<Record<string, boolean>>;
  /**
   * Drop dot-prefixed entries from the listings this navigation renders.
   *
   * Only LISTED entries. A navigation segment that exists because a registered
   * workspace lives under it stays, even when the segment itself is
   * dot-prefixed: the person registered that workspace explicitly, and hiding
   * the only way to reach it would be this side overruling that decision.
   */
  hideDotEntries?: boolean;
}

interface RootLocation {
  device: string;
  deviceLabel: string;
  workspace: WorkspaceRow;
}

type RootWithKey = WorkspaceFilesRoot & { readonly directoryKey?: string };

interface DisplayNode {
  segment: string;
  path: string[];
  children: Map<string, DisplayNode>;
  roots: RootWithKey[];
}

interface DeviceTree {
  key: string;
  label: string;
  /** A trusted sessions-plane device id. Source labels are not launch ids. */
  launchDevice: string | null;
  home: DisplayNode;
  nodesByPath: Map<string, DisplayNode>;
  rootCount: number;
}

function node(segment: string, path: string[]): DisplayNode {
  return { segment, path, children: new Map(), roots: [] };
}

/**
 * Safe display segments below `~`.
 *
 * Current Runners use `~/…/name` when a root is outside the scan home. The
 * navigation renders that one deliberately opaque hop as `..`: enough to say
 * "up from home" without pretending the undisclosed ancestors are known.
 */
export function homePathSegments(display: string, fallbackLabel: string): string[] {
  const value = display.trim().replace(/\\/g, "/");
  if (value === "~") return [];
  if (value.startsWith("~/")) {
    const segments = value.slice(2).split("/")
      .filter((segment) => segment.length > 0 && segment !== ".")
      .map((segment) => segment === "…" ? ".." : segment);
    return segments.length ? segments : [fallbackLabel || "(未命名目录)"];
  }
  // Legacy/unknown displays do not become a path disclosure. Keep the root
  // reachable under the same explicit "outside home" branch.
  return ["..", fallbackLabel || "(未命名目录)"];
}

function locationsByKey(
  workspacesByDevice: Readonly<Record<string, WorkspaceGroup>>,
): Map<string, RootLocation> {
  const out = new Map<string, RootLocation>();
  for (const [device, group] of Object.entries(workspacesByDevice)) {
    for (const workspace of group.workspaces ?? []) {
      if (!workspace.directoryKey || out.has(workspace.directoryKey)) continue;
      out.set(workspace.directoryKey, {
        device,
        deviceLabel: group.deviceLabel || group.device || device,
        workspace,
      });
    }
  }
  return out;
}

function navigationKey(device: string, path: readonly string[]): string {
  return `home:${JSON.stringify([device, ...path])}`;
}

function pathKey(path: readonly string[]): string {
  return JSON.stringify(path);
}

/**
 * Turn one home-navigation coordinate into the same display path accepted by
 * the new-session form. `..` is the deliberately redacted outside-home branch,
 * not a directory name this side can safely submit.
 */
export function launchTargetForHomePath(
  device: string | null,
  path: readonly string[],
): DirectoryLaunchTarget | null {
  if (!device || path.some((segment) => segment === ".." || segment === "…")) return null;
  return { device, directory: path.length ? `~/${path.join("/")}` : "~" };
}
export interface WorkspaceRevealPlan {
  rootRef: string;
  /** Listing steps below the exact registered root, ending at the session cwd. */
  steps: readonly {
    label: string;
    /** Exact-key registered root folded into this visible coordinate, when any. */
    registeredRootRef?: string;
  }[];
  /** Synthetic home-navigation rows that must stand open before opaque rows can render. */
  expandedKeys: readonly string[];
  /** The session's own safe cwd display, never a root label guessed by this View. */
  display: string;
  showHidden: boolean;
}

export type WorkspaceRevealResult =
  | { ok: true; plan: WorkspaceRevealPlan }
  | { ok: false; message: string };

function isPathPrefix(prefix: readonly string[], target: readonly string[]): boolean {
  return prefix.length <= target.length
    && prefix.every((segment, index) => segment === target[index]);
}

/**
 * Find the registered files root that can reveal one session's real cwd.
 *
 * Both halves must agree by `directoryKey`: a display path only supplies the
 * labels to list below that exact root. The shallowest containing root wins so
 * opening the plan also exposes every intermediate directory in the left-hand
 * index. A root label, basename, or device display name never establishes the
 * association.
 */
export function planWorkspaceReveal(input: {
  session: Pick<SessionSummary, "cwdDisplay" | "deviceId" | "directoryDeviceId" | "directoryKey">;
  workspacesByDevice: Readonly<Record<string, WorkspaceGroup>>;
  roots: WorkspaceFilesRoots | null;
}): WorkspaceRevealResult {
  const roots = (input.roots?.roots ?? []) as readonly RootWithKey[];
  const device = input.session.directoryDeviceId ?? input.session.deviceId ?? "";
  if (!device || !roots.length) {
    return { ok: false, message: "当前会话没有可精确关联的文件索引根。" };
  }

  const rootByKey = new Map<string, RootWithKey>();
  for (const root of roots) {
    if (root.directoryKey && !rootByKey.has(root.directoryKey)) {
      rootByKey.set(root.directoryKey, root);
    }
  }
  const target = pathSegments(input.session.cwdDisplay ?? "");
  const workspaces = input.workspacesByDevice[device]?.workspaces ?? [];
  const candidates = workspaces.flatMap((workspace) => {
    const root = workspace.directoryKey ? rootByKey.get(workspace.directoryKey) : undefined;
    const base = pathSegments(workspace.display);
    return root && base && target && isPathPrefix(base, target)
      ? [{ root, workspace, base }]
      : [];
  }).sort((left, right) => left.base.length - right.base.length);

  let root: RootWithKey;
  let steps: WorkspaceRevealPlan["steps"];
  let navigationDevice = device;
  let navigationPath: readonly string[];
  if (candidates.length) {
    const chosen = candidates[0]!;
    root = chosen.root;
    const labels = target!.slice(chosen.base.length);
    const registeredRootsByDepth = new Map<number, string>();
    for (const candidate of candidates) {
      const depth = candidate.base.length - chosen.base.length;
      if (depth <= 0 || depth > labels.length || registeredRootsByDepth.has(depth)) continue;
      registeredRootsByDepth.set(depth, candidate.root.ref);
    }
    steps = labels.map((label, index) => {
      const registeredRootRef = registeredRootsByDepth.get(index + 1);
      return registeredRootRef ? { label, registeredRootRef } : { label };
    });
    navigationPath = homePathSegments(chosen.workspace.display, root.label);
  } else {
    const direct = input.session.directoryKey
      ? rootByKey.get(input.session.directoryKey)
      : undefined;
    if (!direct) {
      return {
        ok: false,
        message: "当前会话工作目录未与任何已登记文件根精确关联，无法安全定位。",
      };
    }
    root = direct;
    steps = [];
    const location = workspaces.find((workspace) => workspace.directoryKey === direct.directoryKey);
    if (location) {
      navigationPath = homePathSegments(location.display, direct.label);
    } else {
      navigationDevice = direct.sourceLabel || "其他来源";
      navigationPath = ["..", direct.label || "(未命名目录)"];
    }
  }

  const expandedKeys = [`home-device:${navigationDevice}`];
  for (let index = 0; index <= navigationPath.length; index += 1) {
    expandedKeys.push(navigationKey(navigationDevice, navigationPath.slice(0, index)));
  }
  return {
    ok: true,
    plan: {
      rootRef: root.ref,
      steps,
      expandedKeys: [...new Set(expandedKeys)],
      display: input.session.cwdDisplay || root.label || "当前工作目录",
      showHidden: steps.some((step) => step.label.startsWith(".")),
    },
  };
}


/** A file's listing lineage, rooted in an exact opaque root already disclosed. */
export function planFileReveal(input: {
  location: ListedFileLocation;
  workspacesByDevice: Readonly<Record<string, WorkspaceGroup>>;
  roots: WorkspaceFilesRoots | null;
}): WorkspaceRevealResult {
  const root = (input.roots?.roots as readonly RootWithKey[] | undefined)
    ?.find((candidate) => candidate.ref === input.location.rootRef);
  if (!root || !input.location.labels.length) {
    return { ok: false, message: "文件的原始目录根已不在当前索引中，请重新打开文件。" };
  }
  const location = root.directoryKey ? locationsByKey(input.workspacesByDevice).get(root.directoryKey) : undefined;
  const parents = input.location.labels.slice(0, -1);
  const hasDisplayPath = location && pathSegments(location.workspace.display) !== null;
  // Reuse the cwd plan to expose containing and overlapping registered roots.
  // Display segments choose listing labels, never an address or a permission.
  const base = location ? planWorkspaceReveal({
    roots: input.roots,
    workspacesByDevice: input.workspacesByDevice,
    session: {
      deviceId: location.device,
      directoryKey: root.directoryKey,
      cwdDisplay: hasDisplayPath ? [location.workspace.display, ...parents].join("/") : location.workspace.display,
    },
  }) : null;
  const device = root.sourceLabel || "其他来源";
  const fallbackPath = ["..", root.label || "(未命名目录)"];
  const plan: WorkspaceRevealPlan = base?.ok ? base.plan : {
    rootRef: root.ref,
    steps: [],
    expandedKeys: [`home-device:${device}`, ...fallbackPath.map((_, index) => navigationKey(device, fallbackPath.slice(0, index + 1))), navigationKey(device, [])],
    display: root.label,
    showHidden: false,
  };
  return { ok: true, plan: {
    ...plan,
    steps: base?.ok && hasDisplayPath ? plan.steps : [...plan.steps, ...parents.map((label) => ({ label }))],
    display: input.location.labels.at(-1)!,
    showHidden: plan.showHidden || input.location.labels.some((label) => label.startsWith(".")),
  } };
}


/** Flatten the currently visible home-rooted navigation in display order. */
export function homeDirectoryRows(input: HomeDirectoryTreeInput): HomeDirectoryRow[] {
  const locations = locationsByKey(input.workspacesByDevice);
  const devices = new Map<string, DeviceTree>();

  // A successful sessions-plane lookup is itself the trusted statement that
  // this device belongs in the index.  Do not wait for the files plane to
  // return a root before creating its group: a freshly registered Runner has
  // an empty workspace registry, but it is still a valid launch target.  The
  // synthetic `~` row below only prefills the existing direct-directory launch
  // action; file browsing remains impossible until an opaque root is actually
  // projected by the files plane.
  for (const device of new Set([...(input.devices ?? []), ...Object.keys(input.workspacesByDevice)])) {
    if (!device) continue;
    const group = input.workspacesByDevice[device];
    const tree: DeviceTree = {
      key: device,
      label: group?.deviceLabel || group?.device || device,
      launchDevice: device,
      home: node("~", []),
      nodesByPath: new Map(),
      rootCount: 0,
    };
    tree.nodesByPath.set(pathKey([]), tree.home);
    devices.set(device, tree);
  }

  for (const root of (input.roots?.roots ?? []) as readonly RootWithKey[]) {
    const location = root.directoryKey ? locations.get(root.directoryKey) : undefined;
    const device = location?.device || root.sourceLabel || "其他来源";
    let tree = devices.get(device);
    if (!tree) {
      tree = {
        key: device,
        label: root.sourceLabel || location?.deviceLabel || device,
        launchDevice: location?.device ?? null,
        home: node("~", []),
        nodesByPath: new Map(),
        rootCount: 0,
      };
      tree.nodesByPath.set(pathKey([]), tree.home);
      devices.set(device, tree);
    }
    if (!tree.launchDevice && location) tree.launchDevice = location.device;
    tree.rootCount += 1;

    const segments = location
      ? homePathSegments(location.workspace.display, root.label)
      : ["..", root.label || "(未命名目录)"];
    let current = tree.home;
    for (const segment of segments) {
      let child = current.children.get(segment);
      if (!child) {
        child = node(segment, [...current.path, segment]);
        current.children.set(segment, child);
        tree.nodesByPath.set(pathKey(child.path), child);
      }
      current = child;
    }
    current.roots.push(root);
  }

  const out: HomeDirectoryRow[] = [];
  const emitRoot = (
    tree: DeviceTree,
    root: RootWithKey,
    label: string,
    depth: number,
    path: readonly string[],
  ): void => {
    const visible = visibleRows(
      { roots: [root], truncated: false },
      input.cache,
      input.expandedDirs,
      { hideDotEntries: input.hideDotEntries === true },
    );
    const head = visible[0];
    if (!head) return;
    const displayHead: TreeRow = {
      ...head,
      label,
      depth,
      ...(head.label !== label ? { sourceLabel: head.label } : {}),
    };
    out.push({
      type: "directory",
      key: `root:${root.ref}`,
      label,
      depth,
      open: displayHead.expanded === true,
      root: displayHead,
      launch: launchTargetForHomePath(tree.launchDevice, path),
    });
    if (!displayHead.expanded) return;
    for (const row of visible.slice(1)) {
      const adjustedDepth = depth + row.depth;
      out.push({
        type: "files",
        row: { ...row, depth: adjustedDepth },
        depth: adjustedDepth,
        launch: null,
      });
    }
  };

  /**
   * Emit one registered root's already-visible descendants while folding a
   * nested registered root into the file row at the same display coordinate.
   *
   * This is presentation de-duplication only. A folded row keeps the nested
   * root's opaque ref; no file request is ever addressed by the display path.
   *
   * ── Which of the two rows survives (ticket #350) ──────────────────────────
   *
   * A navigation node exists for two different reasons, and only one of them
   * may replace a real listing row:
   *
   *  · It carries a REGISTERED ROOT at this coordinate. Then it is the same
   *    directory addressed by a better ref — the one the person registered —
   *    and folding shows one row instead of two.
   *  · It carries no root at all and exists only because a registered
   *    workspace sits somewhere BELOW it. Then it knows nothing about this
   *    directory's real contents: it can only list registered descendants. It
   *    used to win anyway, which is how `~/lht/paper-work` rendered with just
   *    its one registered child `phd` while the sibling folders that actually
   *    exist on disk were silently absent. The real row wins now, and the
   *    registered descendants below it are folded in by this same recursion
   *    once the reader opens it.
   */
  function emitVisibleChildren(
    tree: DeviceTree,
    current: DisplayNode,
    visible: readonly TreeRow[],
    depth: number,
    consumed: Set<DisplayNode>,
  ): void {
    const labels: string[] = [];
    for (let index = 1; index < visible.length;) {
      const row = visible[index]!;
      labels.length = Math.max(0, row.depth - 1);
      labels.push(row.label);
      const displayPath = [...current.path, ...labels];
      const nested = row.kind === "directory" ? tree.nodesByPath.get(pathKey(displayPath)) : undefined;
      if (nested && nested !== current) {
        // Either way this coordinate is now represented by a row, so the
        // navigation node must not be emitted a second time below.
        consumed.add(nested);
        if (nested.roots.length) {
          let end = index + 1;
          while (end < visible.length && visible[end]!.depth > row.depth) end += 1;
          emitNode(tree, nested, depth + row.depth);
          index = end;
          continue;
        }
      }
      const adjustedDepth = depth + row.depth;
      out.push({
        type: "files",
        row: { ...row, depth: adjustedDepth },
        depth: adjustedDepth,
        launch: row.kind === "directory"
          ? launchTargetForHomePath(tree.launchDevice, displayPath)
          : null,
      });
      index += 1;
    }
  }

  function emitNode(tree: DeviceTree, current: DisplayNode, depth: number): void {
    const key = navigationKey(tree.key, current.path);
    const launch = launchTargetForHomePath(tree.launchDevice, current.path);
    // Registry writes de-duplicate canonical paths, so a safe home coordinate
    // normally has one root. If stale data repeats it, one visible row is still
    // the truthful presentation. Redacted `..` coordinates remain separate
    // because two undisclosed paths may legitimately share that display.
    const mergedRoot = current.roots.length === 1 || !current.path.includes("..")
      ? current.roots[0]
      : undefined;
    const consumed = new Set<DisplayNode>();
    if (mergedRoot) {
      const visible = visibleRows(
        { roots: [mergedRoot], truncated: false },
        input.cache,
        input.expandedDirs,
        { hideDotEntries: input.hideDotEntries === true },
      );
      const head = visible[0];
      if (!head) return;
      const displayHead: TreeRow = {
        ...head,
        label: current.segment,
        depth,
        ...(head.label !== current.segment ? { sourceLabel: head.label } : {}),
      };
      const open = displayHead.expanded === true;
      out.push({ type: "directory", key, label: current.segment, depth, open, root: displayHead, launch });
      if (!open) return;
      emitVisibleChildren(tree, current, visible, depth, consumed);
    } else {
      // Open by default, and after ticket #350 that is a rule rather than an
      // accident. A node reaching this branch carries no root, which — since
      // the fold above now yields to any real listing row — means no listing
      // covers this coordinate at all: it is a REGISTRY INDEX, its children are
      // the registered workspaces themselves, and drawing it open costs nothing
      // because there is nothing to fetch. A row backed by a real listing keeps
      // the opposite default for the same reason stated the other way: opening
      // one spends a `listDirectory` call.
      //
      // What used to look arbitrary was a node of this kind standing open in
      // the MIDDLE of a listed tree, hiding the real folder it shadowed. That
      // is gone; these two defaults no longer describe the same coordinate.
      const open = input.expanded[key] ?? true;
      out.push({ type: "directory", key, label: current.segment, depth, open, root: null, launch });
      if (!open) return;
      // Multiple roots at a redacted coordinate cannot be proven identical.
      for (const root of current.roots) emitRoot(tree, root, root.label, depth + 1, [...current.path, root.label]);
    }

    for (const child of [...current.children.values()].sort((a, b) => a.segment.localeCompare(b.segment))) {
      if (!consumed.has(child)) emitNode(tree, child, depth + 1);
    }
  }

  for (const tree of devices.values()) {
    const key = `home-device:${tree.key}`;
    const open = input.expanded[key] ?? true;
    out.push({
      type: "device",
      key,
      label: tree.label,
      terminalDevice: tree.launchDevice,
      open,
      total: tree.rootCount,
    });
    if (open) emitNode(tree, tree.home, 0);
  }
  return out;
}
