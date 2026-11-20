/**
 * Pure projection and presentation codec for the optional docking shell.
 *
 * There are deliberately two models here:
 *
 * - `LayoutState` is the semantic workspace. It owns panel identity, resources,
 *   open/reuse/close and every authority-bearing decision.
 * - `DockPresentation` is a bounded, authority-free arrangement of the
 *   composition's declared document panels and the two flow surfaces.
 *
 * Dockview's own JSON is an implementation detail. It contains renderer names,
 * arbitrary params and runtime panels, so it must never become an App or Host
 * contract. The codec below copies only split topology, sizes, tab order and an
 * active surface. The default codec scope remains declaration-only; a shell
 * may explicitly include current coordinator-owned runtime panels. An App must
 * reconstruct those panels through the reducer before restoring such a tree.
 */

import type { WorkspaceSlot } from "@claude-bot/agent-module-contract";
import {
  Orientation,
  type GroupviewPanelState,
  type SerializedDockview,
  type SerializedGridObject,
} from "dockview-react";
import { isDocumentSlot, type LayoutPanel, type LayoutState, type WorkspacePlan } from "./layout.js";

type DockGroupState = SerializedDockview["grid"]["root"] extends SerializedGridObject<infer State>
  ? State
  : never;

export const DOCK_DOCUMENT_COMPONENT = "octopus-workspace-document";
export const DOCK_FLOW_COMPONENT = "octopus-workspace-flow";

export const DOCK_FLOW_PANEL_IDS = Object.freeze({
  navigation: "__octopus-flow-navigation",
  bottom: "__octopus-flow-bottom",
} as const);

export const DEFAULT_DOCK_GROUP_IDS = Object.freeze({
  navigation: "octopus-group-navigation",
  primary: "octopus-group-primary",
  resource: "octopus-group-resource",
  bottom: "octopus-group-bottom",
} as const);

export type DockFlowSlot = keyof typeof DOCK_FLOW_PANEL_IDS;
export type DefaultDockGroup = keyof typeof DEFAULT_DOCK_GROUP_IDS;

export interface DockDocumentParams {
  /** Stable semantic panel id. No resource, config or provider crosses here. */
  panelId: string;
}

export interface DockFlowParams {
  /** A closed, non-document slot. Its child panels stay in LayoutState. */
  flowSlot: DockFlowSlot;
}

export type DockProjectionItem =
  | {
      kind: "document";
      dockId: string;
      panelId: string;
      title: string;
      slot: Extract<WorkspaceSlot, "primary" | "secondary" | "overlay">;
      defaultGroup: "primary" | "resource";
      /** Mounted but absent from tabs/layout affordances until it owns a resource. */
      dormant: boolean;
      declared: boolean;
    }
  | {
      kind: "flow";
      dockId: (typeof DOCK_FLOW_PANEL_IDS)[DockFlowSlot];
      flowSlot: DockFlowSlot;
      title: string;
      defaultGroup: DockFlowSlot;
      declared: true;
    };

export interface DockProjection {
  readonly items: readonly DockProjectionItem[];
  readonly activeDockId: string | null;
}

/**
 * Project semantic panels into Dockview surfaces without changing semantics.
 * Navigation and bottom are one flow surface each; document panels remain
 * individually dockable and retain their semantic id as the Dockview id.
 */
export function projectDockLayout(plan: WorkspacePlan, state: LayoutState): DockProjection {
  const declared = new Set(plan.composition.instances.map((row) => row.instance));
  const items: DockProjectionItem[] = [];

  for (const flowSlot of ["navigation", "bottom"] as const) {
    if (state.panels.some((panel) => panel.slot === flowSlot)) {
      items.push({
        kind: "flow",
        dockId: DOCK_FLOW_PANEL_IDS[flowSlot],
        flowSlot,
        title: flowSlot === "navigation" ? "导航" : "状态",
        defaultGroup: flowSlot,
        declared: true,
      });
    }
  }

  const documents = state.panels
    .filter((panel): panel is LayoutPanel & { slot: "primary" | "secondary" | "overlay" } =>
      isDocumentSlot(panel.slot),
    )
    .sort((left, right) => creationRank(plan, left.panelId) - creationRank(plan, right.panelId));
  for (const panel of documents) {
    items.push({
      kind: "document",
      dockId: panel.panelId,
      panelId: panel.panelId,
      title: panel.label,
      slot: panel.slot,
      defaultGroup: panel.slot === "primary" ? "primary" : "resource",
      dormant: isDockDormantDocument(plan, state, panel),
      declared: declared.has(panel.panelId),
    });
  }

  const focused = state.panels.find((panel) => panel.panelId === state.focused);
  const requestedDockId = focused
    ? focused.slot === "navigation" || focused.slot === "bottom"
      ? DOCK_FLOW_PANEL_IDS[focused.slot]
      : focused.panelId
    : null;
  const activeDockId = preferredActiveDockId(items, requestedDockId, state);
  return Object.freeze({ items: Object.freeze(items), activeDockId });
}

/**
 * Empty secondary/overlay declarations are lifecycle parking places, not
 * documents a person can identify yet. Keep their renderer mounted, but do not
 * make them consume a column or a tab while a primary work surface exists.
 * A resource-only composition still paints its first standing document so it
 * never boots to a blank workspace.
 */
export function isDockDormantDocument(
  plan: WorkspacePlan,
  state: LayoutState,
  panel: LayoutPanel,
): boolean {
  if (!isDocumentSlot(panel.slot) || panel.slot === "primary" || panel.resourceRef !== null) return false;
  if (state.panels.some((candidate) => candidate.slot === "primary")) return true;
  if (state.panels.some((candidate) =>
    (candidate.slot === "secondary" || candidate.slot === "overlay")
    && candidate.resourceRef !== null,
  )) return true;
  const firstStanding = state.panels
    .filter((candidate) =>
      (candidate.slot === "secondary" || candidate.slot === "overlay")
      && candidate.resourceRef === null,
    )
    .sort((left, right) => creationRank(plan, left.panelId) - creationRank(plan, right.panelId))[0];
  return firstStanding?.panelId !== panel.panelId;
}

function preferredActiveDockId(
  items: readonly DockProjectionItem[],
  requested: string | null,
  state: LayoutState,
): string | null {
  const available = (dockId: string | null | undefined): dockId is string => {
    if (!dockId) return false;
    const item = items.find((candidate) => candidate.dockId === dockId);
    return item !== undefined && (item.kind === "flow" || !item.dormant);
  };
  if (available(requested)) return requested;
  for (const slot of ["primary", "secondary", "overlay"] as const) {
    if (available(state.active[slot])) return state.active[slot]!;
  }
  return items.find((item) => item.kind === "flow" || !item.dormant)?.dockId ?? null;
}

function creationRank(plan: WorkspacePlan, panelId: string): number {
  const declared = plan.composition.instances.findIndex((row) => row.instance === panelId);
  if (declared >= 0) return declared;
  const minted = /^panel-(\d+)$/.exec(panelId);
  return plan.composition.instances.length + (minted ? Number(minted[1]) : Number.MAX_SAFE_INTEGER);
}

export const DOCK_PRESENTATION_VERSION = 1 as const;
export const DOCK_PRESENTATION_LIMITS = Object.freeze({
  maxBytes: 32_768,
  maxDepth: 8,
  maxNodes: 64,
  maxChildren: 16,
  maxPanels: 64,
  maxSize: 100_000,
});

export type DockPresentationNode =
  | {
      type: "group";
      /** Stable Dockview group identity; absent only on legacy checkpoints. */
      id?: string;
      panels: readonly string[];
      activePanel?: string;
      /** App-owned pixels; `size` below remains only Dockview's grid hint. */
      width?: number;
      height?: number;
      size?: number;
    }
  | {
      type: "split";
      children: readonly DockPresentationNode[];
      size?: number;
    };

export interface DockPresentation {
  version: typeof DOCK_PRESENTATION_VERSION;
  /** Viewport at capture time. Group pixels are scaled relative to this rectangle. */
  width?: number;
  height?: number;
  /** Orientation of the root; nested split orientations alternate. */
  orientation: "horizontal" | "vertical";
  root: DockPresentationNode;
  activePanel?: string;
}

export type DockPresentationReadResult =
  | { ok: true; value: DockPresentation }
  | { ok: false; reason: string };

export interface DockPresentationScope {
  /** Exactly the safe Dockview ids expected for this composition. */
  panelIds: readonly string[];
}

/**
 * Default: declared surfaces only. Opt-in runtime ids are valid only when the
 * semantic coordinator already owns them; a presentation never creates panels.
 */
export function dockPresentationScope(plan: WorkspacePlan, state: LayoutState, includeRuntime = false): DockPresentationScope {
  const projection = projectDockLayout(plan, state);
  return {
    panelIds: projection.items
      .filter((item) => includeRuntime || item.kind === "flow" || item.declared)
      .map((item) => item.dockId),
  };
}

/**
 * Create the immutable release default: navigation | focused document group,
 * then a compact status region. Resource surfaces start as document tabs, not
 * as an empty third column; a reader can drag a bound tab into a split later.
 */
export function defaultDockPresentation(plan: WorkspacePlan, state: LayoutState): DockPresentation {
  const projection = projectDockLayout(plan, state);
  const persistent = projection.items.filter((item) => item.kind === "flow" || item.declared);
  const leaf = (items: readonly DockProjectionItem[], size: number): DockPresentationNode | undefined => {
    if (!items.length) return undefined;
    const activePanel = activeInDefaultGroup(items, projection.activeDockId, state);
    return {
      type: "group",
      panels: items.map((item) => item.dockId),
      ...(activePanel ? { activePanel } : {}),
      size,
    };
  };
  const navigation = leaf(
    persistent.filter((item) => item.defaultGroup === "navigation"),
    320,
  );
  const documents = leaf(
    persistent.filter((item) => item.kind === "document"),
    1_080,
  );
  const bottom = leaf(
    persistent.filter((item) => item.defaultGroup === "bottom"),
    72,
  );

  const top = [navigation, documents].filter((node): node is DockPresentationNode => node !== undefined);
  const topNode = top.length === 0
    ? undefined
    : top.length === 1
      ? top[0]!
      : { type: "split" as const, children: top, size: 788 };
  const root = bottom
    ? topNode
      ? { type: "split" as const, children: [topNode, bottom] }
      : bottom
    : topNode;
  if (!root) {
    // A linked composition must contain at least one instance, so this is a
    // defence-in-depth fallback rather than an expected product state.
    throw new Error("dock presentation: workspace has no surfaces");
  }

  const activePanel = projection.activeDockId && persistent.some((item) => item.dockId === projection.activeDockId)
    ? projection.activeDockId
    : persistent[0]?.dockId;
  return {
    version: DOCK_PRESENTATION_VERSION,
    orientation: bottom ? "vertical" : "horizontal",
    root,
    ...(activePanel ? { activePanel } : {}),
  };
}

function activeInDefaultGroup(
  items: readonly DockProjectionItem[],
  focused: string | null,
  state: LayoutState,
): string | undefined {
  if (focused && items.some((item) => item.dockId === focused)) return focused;
  for (const item of items) {
    if (item.kind === "flow") return item.dockId;
    if (state.active[item.slot] === item.panelId) return item.dockId;
  }
  return items[0]?.dockId;
}

/** Validate an already-parsed presentation and reject unknown fields. */
export function readDockPresentation(
  input: unknown,
  scope: DockPresentationScope,
): DockPresentationReadResult {
  const allowed = new Set(scope.panelIds);
  if (allowed.size !== scope.panelIds.length || allowed.size > DOCK_PRESENTATION_LIMITS.maxPanels) {
    return { ok: false, reason: "invalid presentation scope" };
  }
  if (!isRecord(input) || !hasOnlyKeys(input, ["version", "orientation", "root", "activePanel", "width", "height"])) {
    return { ok: false, reason: "presentation must contain only known fields" };
  }
  if (input.version !== DOCK_PRESENTATION_VERSION) {
    return { ok: false, reason: "unsupported presentation version" };
  }
  if (input.orientation !== "horizontal" && input.orientation !== "vertical") {
    return { ok: false, reason: "invalid root orientation" };
  }
  const width = readSize(input.width, 1);
  const height = readSize(input.height, 1);
  if (width === null || height === null || (width === undefined) !== (height === undefined)) {
    return { ok: false, reason: "invalid presentation viewport" };
  }

  const seen = new Set<string>();
  const groupIds = new Set<string>();
  const budget = { nodes: 0 };
  const root = readNode(input.root, allowed, seen, groupIds, budget, 0);
  if (!root.ok) return root;
  if (seen.size !== allowed.size || [...allowed].some((panelId) => !seen.has(panelId))) {
    return { ok: false, reason: "presentation inventory does not match this composition" };
  }
  if (input.activePanel !== undefined && (!isSafePanelId(input.activePanel) || !allowed.has(input.activePanel))) {
    return { ok: false, reason: "active panel is not declared" };
  }
  return {
    ok: true,
    value: {
      version: DOCK_PRESENTATION_VERSION,
      orientation: input.orientation,
      ...(width && height ? { width, height } : {}),
      root: root.value,
      ...(typeof input.activePanel === "string" ? { activePanel: input.activePanel } : {}),
    },
  };
}

function readNode(
  input: unknown,
  allowed: ReadonlySet<string>,
  seen: Set<string>,
  groupIds: Set<string>,
  budget: { nodes: number },
  depth: number,
): { ok: true; value: DockPresentationNode } | { ok: false; reason: string } {
  budget.nodes += 1;
  if (budget.nodes > DOCK_PRESENTATION_LIMITS.maxNodes || depth > DOCK_PRESENTATION_LIMITS.maxDepth) {
    return { ok: false, reason: "presentation topology exceeds its bounds" };
  }
  if (!isRecord(input) || (input.type !== "group" && input.type !== "split")) {
    return { ok: false, reason: "invalid presentation node" };
  }
  const size = readSize(input.size);
  if (size === null) return { ok: false, reason: "invalid presentation size" };

  if (input.type === "group") {
    if (!hasOnlyKeys(input, ["type", "id", "panels", "activePanel", "width", "height", "size"])) {
      return { ok: false, reason: "group contains unknown fields" };
    }
    if (input.id !== undefined && (!isSafePanelId(input.id) || groupIds.has(input.id))) {
      return { ok: false, reason: "invalid presentation group id" };
    }
    if (typeof input.id === "string") groupIds.add(input.id);
    const width = readSize(input.width, 1);
    const height = readSize(input.height, 1);
    if (width === null || height === null || (width === undefined) !== (height === undefined)
      || width && input.id === undefined) {
      return { ok: false, reason: "invalid rendered group size" };
    }
    if (!Array.isArray(input.panels) || input.panels.length < 1
      || input.panels.length > DOCK_PRESENTATION_LIMITS.maxPanels) {
      return { ok: false, reason: "invalid group panel list" };
    }
    const panels: string[] = [];
    for (const panelId of input.panels) {
      if (!isSafePanelId(panelId) || !allowed.has(panelId)) {
        return { ok: false, reason: "runtime or unknown panel cannot be restored" };
      }
      if (seen.has(panelId)) return { ok: false, reason: "panel appears more than once" };
      seen.add(panelId);
      panels.push(panelId);
    }
    const flows = panels.filter(isDockFlowPanelId);
    if (flows.length && (flows.length !== 1 || panels.length !== 1)) {
      return { ok: false, reason: "a flow surface must own its group" };
    }
    if (input.activePanel !== undefined
      && (!isSafePanelId(input.activePanel) || !panels.includes(input.activePanel))) {
      return { ok: false, reason: "group active panel is not in the group" };
    }
    return {
      ok: true,
      value: {
        type: "group",
        ...(typeof input.id === "string" ? { id: input.id } : {}),
        panels,
        ...(typeof input.activePanel === "string" ? { activePanel: input.activePanel } : {}),
        ...(width && height ? { width, height } : {}),
        ...(size === undefined ? {} : { size }),
      },
    };
  }

  if (!hasOnlyKeys(input, ["type", "children", "size"])) {
    return { ok: false, reason: "split contains unknown fields" };
  }
  if (!Array.isArray(input.children) || input.children.length < 2
    || input.children.length > DOCK_PRESENTATION_LIMITS.maxChildren) {
    return { ok: false, reason: "invalid split children" };
  }
  const children: DockPresentationNode[] = [];
  for (const child of input.children) {
    const checked = readNode(child, allowed, seen, groupIds, budget, depth + 1);
    if (!checked.ok) return checked;
    children.push(checked.value);
  }
  return {
    ok: true,
    value: {
      type: "split",
      children,
      ...(size === undefined ? {} : { size }),
    },
  };
}

function readSize(input: unknown, minimum = 0): number | undefined | null {
  if (input === undefined) return undefined;
  if (typeof input !== "number" || !Number.isFinite(input) || input < minimum
    || input > DOCK_PRESENTATION_LIMITS.maxSize) return null;
  return Math.round(input);
}

/** Encode only a presentation that still matches the supplied composition. */
export function encodeDockPresentation(
  presentation: unknown,
  scope: DockPresentationScope,
): DockPresentationReadResult & { encoded?: string } {
  const checked = readDockPresentation(presentation, scope);
  if (!checked.ok) return checked;
  const encoded = JSON.stringify(checked.value);
  if (encoded.length > DOCK_PRESENTATION_LIMITS.maxBytes) {
    return { ok: false, reason: "encoded presentation is too large" };
  }
  return { ...checked, encoded };
}

/** Decode a bounded in-memory value. This function never reads browser storage. */
export function decodeDockPresentation(
  encoded: string,
  scope: DockPresentationScope,
): DockPresentationReadResult {
  if (encoded.length > DOCK_PRESENTATION_LIMITS.maxBytes) {
    return { ok: false, reason: "encoded presentation is too large" };
  }
  try {
    return readDockPresentation(JSON.parse(encoded) as unknown, scope);
  } catch {
    return { ok: false, reason: "presentation is not valid JSON" };
  }
}

/**
 * Sanitize Dockview's live implementation JSON. Unknown/runtime panels are
 * removed; declared panels and flow surfaces must all remain exactly once.
 */
export function captureDockPresentation(
  layout: SerializedDockview,
  scope: DockPresentationScope,
): DockPresentationReadResult {
  if (layout.floatingGroups?.length || layout.popoutGroups?.length || layout.edgeGroups) {
    return { ok: false, reason: "floating, popout and edge groups are not supported" };
  }
  const allowed = new Set(scope.panelIds);
  const rawBudget = { nodes: 0, invalid: false };
  const capturedRoot = captureNode(layout.grid.root, allowed, rawBudget, 0);
  if (rawBudget.invalid || !capturedRoot) {
    return { ok: false, reason: "layout contains no safe bounded surfaces" };
  }

  const activePanel = layout.activeGroup
    ? activePanelInGroup(capturedRoot, layout.activeGroup)
    : undefined;
  return readDockPresentation({
    version: DOCK_PRESENTATION_VERSION,
    ...(layout.grid.width > 0 && layout.grid.height > 0
      ? { width: layout.grid.width, height: layout.grid.height } : {}),
    orientation: layout.grid.orientation === Orientation.VERTICAL ? "vertical" : "horizontal",
    root: capturedRoot,
    ...(activePanel ? { activePanel } : {}),
  }, scope);
}

function captureNode(
  node: SerializedGridObject<DockGroupState>,
  allowed: ReadonlySet<string>,
  budget: { nodes: number; invalid: boolean },
  depth: number,
): DockPresentationNode | null {
  budget.nodes += 1;
  const invalid = (): null => { budget.invalid = true; return null; };
  if (budget.nodes > DOCK_PRESENTATION_LIMITS.maxNodes || depth > DOCK_PRESENTATION_LIMITS.maxDepth) return invalid();
  const size = readSize(node.size);
  if (size === null) return invalid();
  if (node.type === "leaf") {
    if (Array.isArray(node.data) || !isRecord(node.data) || !Array.isArray(node.data.views)
      || node.data.views.length > DOCK_PRESENTATION_LIMITS.maxPanels) {
      return invalid();
    }
    const panels = node.data.views.filter((panelId): panelId is string =>
      typeof panelId === "string" && allowed.has(panelId),
    );
    if (!panels.length) return null;
    const id = typeof node.data.id === "string" ? node.data.id : undefined;
    const activePanel = typeof node.data.activeView === "string" && panels.includes(node.data.activeView)
      ? node.data.activeView
      : panels[0];
    return {
      type: "group",
      ...(id ? { id } : {}),
      panels,
      ...(activePanel ? { activePanel } : {}),
      ...(size === undefined ? {} : { size }),
    };
  }
  if (!Array.isArray(node.data) || node.data.length > DOCK_PRESENTATION_LIMITS.maxChildren) {
    return invalid();
  }
  const children = node.data
    .map((child) => captureNode(child, allowed, budget, depth + 1))
    .filter((child): child is DockPresentationNode => child !== null);
  if (!children.length) return null;
  if (children.length === 1) {
    const child = children[0]!;
    return size === undefined ? child : { ...child, size };
  }
  return {
    type: "split",
    children,
    ...(size === undefined ? {} : { size }),
  };
}

function activePanelInGroup(
  node: DockPresentationNode,
  groupId: string,
): string | undefined {
  if (node.type === "group") return node.id === groupId ? node.activePanel : undefined;
  return node.children.map((child) => activePanelInGroup(child, groupId)).find(Boolean);
}

/** Turn the safe presentation back into Dockview's private load format. */
export function materializeDockPresentation(
  presentation: DockPresentation,
  projection: DockProjection,
): SerializedDockview {
  const descriptors = new Map(projection.items.map((item) => [item.dockId, item]));
  const panels: Record<string, GroupviewPanelState> = {};
  const usedGroupIds = new Set<string>();
  let groupSequence = 0;
  let activeGroup: string | undefined;

  const materializeNode = (node: DockPresentationNode, parentAxis: DockPresentation["orientation"]): SerializedGridObject<DockGroupState> => {
    const orientation = parentAxis === "horizontal" ? "vertical" : "horizontal";
    const size = dockPresentationExtent(node, parentAxis, orientation) ?? node.size;
    if (node.type === "split") {
      return {
        type: "branch",
        data: node.children.map((child) => materializeNode(child, orientation)),
        ...(size === undefined ? {} : { size }),
      };
    }
    const flow = node.panels.length === 1 && isDockFlowPanelId(node.panels[0]!);
    const visiblePanels = node.panels.filter((panelId) => {
      const item = descriptors.get(panelId);
      return item?.kind === "flow" || item?.kind === "document" && !item.dormant;
    });
    const preferred = node.id ?? preferredGroupId(node.panels, descriptors);
    let groupId = preferred;
    while (usedGroupIds.has(groupId)) groupId = `octopus-group-restored-${++groupSequence}`;
    usedGroupIds.add(groupId);

    for (const panelId of node.panels) {
      const item = descriptors.get(panelId);
      if (!item) throw new Error(`dock presentation: missing descriptor for ${panelId}`);
      panels[panelId] = panelState(item);
    }
    const requestedActive = node.activePanel && visiblePanels.includes(node.activePanel)
      ? node.activePanel
      : visiblePanels[0] ?? node.panels[0];
    if (presentation.activePanel && visiblePanels.includes(presentation.activePanel)) activeGroup = groupId;
    return {
      type: "leaf",
      data: {
        id: groupId,
        views: [...node.panels],
        activeView: requestedActive,
        ...(flow ? { hideHeader: true, locked: "no-drop-target" as const } : {}),
      },
      ...(size === undefined ? {} : { size }),
      ...(!flow && visiblePanels.length === 0 ? { visible: false } : {}),
    };
  };

  const materializedRoot = materializeNode(presentation.root, presentation.orientation === "horizontal" ? "vertical" : "horizontal");
  // Dockview's serialized grid always has a branch at its root, even when the
  // semantic presentation contains just one group. Its public JSON loader
  // rejects a leaf root; keeping that implementation detail inside this
  // adapter lets simple one-panel compositions use the same bounded codec.
  const root: SerializedGridObject<DockGroupState> = materializedRoot.type === "branch"
    ? materializedRoot
    : { type: "branch", data: [materializedRoot] };

  return {
    grid: {
      root,
      width: presentation.width ?? 1_400,
      height: presentation.height ?? 900,
      orientation: presentation.orientation === "vertical" ? Orientation.VERTICAL : Orientation.HORIZONTAL,
    },
    panels,
    ...(activeGroup ? { activeGroup } : {}),
  };
}

/** A subtree's extent, rather than the first leaf's size, owns a parent split. */
export function dockPresentationExtent(
  node: DockPresentationNode,
  axis: DockPresentation["orientation"],
  orientation: DockPresentation["orientation"],
): number | undefined {
  if (node.type === "group") return axis === "horizontal" ? node.width : node.height;
  const extents = node.children.map((child) => dockPresentationExtent(child, axis,
    orientation === "horizontal" ? "vertical" : "horizontal"));
  if (extents.some((size) => size === undefined)) return undefined;
  const sizes = extents as number[];
  return axis === orientation ? sizes.reduce((sum, size) => sum + size, 0) + 6 * (sizes.length - 1) : Math.max(...sizes);
}

function preferredGroupId(
  panels: readonly string[],
  descriptors: ReadonlyMap<string, DockProjectionItem>,
): string {
  const first = descriptors.get(panels[0]!);
  if (first?.kind === "flow") return DEFAULT_DOCK_GROUP_IDS[first.defaultGroup];
  const groups = new Set(panels.map((panelId) => descriptors.get(panelId)?.defaultGroup));
  if (groups.has("primary")) return DEFAULT_DOCK_GROUP_IDS.primary;
  if (groups.size === 1 && groups.has("resource")) return DEFAULT_DOCK_GROUP_IDS.resource;
  return "octopus-group-restored";
}

export function panelState(item: DockProjectionItem): GroupviewPanelState {
  return item.kind === "flow"
    ? {
        id: item.dockId,
        contentComponent: DOCK_FLOW_COMPONENT,
        title: item.title,
        renderer: "always",
        // Dockview's generic group minimum is 100px. A bottom flow is a
        // compact status rail on desktop (and a maximized region on phone),
        // so retaining that default would reserve an empty fifth of a short
        // workbench. It remains scrollable and user-resizable when populated.
        ...(item.flowSlot === "bottom" ? { minimumHeight: 56 } : {}),
        params: { flowSlot: item.flowSlot } satisfies DockFlowParams,
      }
    : {
        id: item.dockId,
        contentComponent: DOCK_DOCUMENT_COMPONENT,
        title: item.title,
        renderer: "always",
        params: { panelId: item.panelId } satisfies DockDocumentParams,
      };
}

export function isDockFlowPanelId(value: string): value is (typeof DOCK_FLOW_PANEL_IDS)[DockFlowSlot] {
  return value === DOCK_FLOW_PANEL_IDS.navigation || value === DOCK_FLOW_PANEL_IDS.bottom;
}

export function readDockDocumentParams(input: unknown): DockDocumentParams | null {
  return isRecord(input) && hasOnlyKeys(input, ["panelId"]) && isSafePanelId(input.panelId)
    ? { panelId: input.panelId }
    : null;
}

export function readDockFlowParams(input: unknown): DockFlowParams | null {
  return isRecord(input) && hasOnlyKeys(input, ["flowSlot"])
    && (input.flowSlot === "navigation" || input.flowSlot === "bottom")
    ? { flowSlot: input.flowSlot }
    : null;
}

function isSafePanelId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 96;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}
