import { isResourceRef, openResource, type IntentContext } from "@claude-bot/agent-module-contract";
import type { SessionsProjection } from "@claude-bot/agent-sessions-contract";
import { readListedFileLocation } from "@claude-bot/agent-file-preview";
import { VIEW_RECOVERY_BYTES } from "@claude-bot/agent-view-react";
import {
  availableViews, dockPresentationScope, initialLayout, layoutReducer, readDockPresentation,
  type DockPresentation, type DockPresentationNode, type LayoutState, type MobileSection, type WorkspacePlan,
} from "@claude-bot/agent-view-react/workspace";
import { workspaceResolveLabelsProblem } from "@claude-bot/workspace-files-contract";

export const SESSION_PLUS_RECOVERY_VERSION = 2 as const;
export const RECOVERY_DOCUMENT_LIMIT = 16;
const MOBILE_SECTIONS: readonly MobileSection[] = ["navigation", "main", "resource", "status"];

export interface RecoveryDocument {
  panelId: string;
  moduleId: string;
  kind: string | null;
  label: string;
  ref?: string;
  /** Listing identity, never the previous instance's file/root ref. */
  file?: { root: string; labels: readonly string[] };
}
export interface SessionPlusRecovery {
  version: 2;
  documents: readonly RecoveryDocument[];
  activeSession?: string;
  mobileSection?: MobileSection;
  presentation?: DockPresentation;
}

/** Browser data is only a hint. Routes, inventory and every resource read are revalidated. */
export function readSessionPlusRecovery(
  encoded: string | null,
  plan: WorkspacePlan,
  projection: SessionsProjection,
): SessionPlusRecovery | null {
  if (!encoded || utf8Bytes(encoded) > VIEW_RECOVERY_BYTES) return null;
  let raw: unknown;
  try { raw = JSON.parse(encoded) as unknown; } catch { return null; }
  if (!isRecord(raw)) return null;
  const mobileSection = MOBILE_SECTIONS.includes(raw.mobileSection as MobileSection)
    ? raw.mobileSection as MobileSection : undefined;
  if (raw.version === 1) {
    // v1 lost runtime group identity and file contents, and mixed grid hints
    // with viewport pixels. Migrate only its front session, never its bad sizes
    // or the unrelated background session list.
    const ref = typeof raw.activeSession === "string" && isResourceRef(raw.activeSession) ? raw.activeSession : null;
    const session = projection.sessions?.find((row) => row.resourceId === ref);
    const route = ref ? availableViews(plan, { kind: "session" })[0] : undefined;
    return { version: 2, documents: session && route ? [{ panelId: "chat", moduleId: route.moduleId,
      kind: "session", ref: session.resourceId, label: session.title ?? "会话" }] : [],
      ...(session ? { activeSession: session.resourceId } : {}), ...(mobileSection ? { mobileSection } : {}) };
  }
  if (raw.version !== 2 || !hasOnlyKeys(raw, ["version", "documents", "activeSession", "mobileSection", "presentation"])
    || !Array.isArray(raw.documents) || raw.documents.length > RECOVERY_DOCUMENT_LIMIT) return null;
  const documents: RecoveryDocument[] = [];
  for (const input of raw.documents) {
    const row = readDocument(input, plan);
    if (!row || documents.some((previous) => previous.panelId === row.panelId)) return null;
    documents.push(row);
  }
  const activeSession = typeof raw.activeSession === "string" && documents.some((row) => row.kind === "session" && row.ref === raw.activeSession)
    ? raw.activeSession : undefined;
  const flowIds = dockPresentationScope(plan, initialLayout(plan)).panelIds.filter((id) => id.startsWith("__octopus-flow-"));
  const checked = raw.presentation === undefined ? null : readDockPresentation(raw.presentation, {
    panelIds: [...flowIds, ...documents.map((row) => row.panelId)],
  });
  // Without a valid topology there is no evidence that these were separate
  // foreground windows; reopening them all would resurrect background tabs.
  if (!checked?.ok) return null;
  return { version: 2, documents, ...(activeSession ? { activeSession } : {}),
    ...(mobileSection ? { mobileSection } : {}), presentation: checked.value };
}

function readDocument(input: unknown, plan: WorkspacePlan): RecoveryDocument | null {
  if (!isRecord(input) || !hasOnlyKeys(input, ["panelId", "moduleId", "kind", "ref", "label", "file"])
    || typeof input.panelId !== "string" || !/^[\w-]{1,96}$/.test(input.panelId)
    || input.panelId.startsWith("__octopus-flow-")
    || typeof input.moduleId !== "string" || typeof input.label !== "string" || input.label.length > 512) return null;
  if (input.kind === null) {
    const declared = plan.composition.instances.find((row) => row.instance === input.panelId && row.module === input.moduleId);
    return declared && declared.slot === "primary" && input.ref === undefined && input.file === undefined
      ? { panelId: input.panelId, moduleId: input.moduleId, kind: null, label: input.label } : null;
  }
  if (typeof input.kind !== "string") return null;
  const fileKind = input.kind === "workspace-text" || input.kind === "workspace-media";
  let file: RecoveryDocument["file"];
  if (fileKind) {
    if (input.ref !== undefined || !isRecord(input.file) || !hasOnlyKeys(input.file, ["root", "labels"])
      || typeof input.file.root !== "string" || !input.file.root || input.file.root.length > 512
      || !Array.isArray(input.file.labels) || workspaceResolveLabelsProblem(input.file.labels) !== null) return null;
    file = { root: input.file.root, labels: input.file.labels as string[] };
  } else if (input.file !== undefined || typeof input.ref !== "string" || !isResourceRef(input.ref)) return null;
  const ref = file ? "recovery-file" : input.ref as string;
  if (!availableViews(plan, { kind: input.kind }).some((route) => route.moduleId === input.moduleId)) return null;
  return { panelId: input.panelId, moduleId: input.moduleId, kind: input.kind, label: input.label,
    ...(file ? { file } : { ref }) };
}

/** Keep exactly the front document of each group, including derived panels. */
export function encodeSessionPlusRecovery(input: {
  state: LayoutState;
  presentation: DockPresentation;
  mobileSection?: MobileSection;
}): string | null {
  const documents: RecoveryDocument[] = [];
  const presentation = mapRecoveryPresentation(input.presentation, (group) => {
    const front = group.activePanel ?? group.panels[0];
    if (!front) return null;
    if (front.startsWith("__octopus-flow-")) return { ...group, panels: [front], activePanel: front };
    const panel = input.state.panels.find((row) => row.panelId === front);
    if (!panel || (!panel.resourceRef && panel.slot !== "primary")) return null;
    const row: RecoveryDocument = { panelId: front, moduleId: panel.moduleId,
      kind: panel.resourceKind, label: panel.label.slice(0, 512) };
    if (panel.resourceKind === "workspace-text" || panel.resourceKind === "workspace-media") {
      const location = readListedFileLocation(panel.context);
      if (!location?.annotationRoot) return null;
      row.file = { root: location.annotationRoot, labels: location.labels };
    } else if (panel.resourceRef) row.ref = panel.resourceRef;
    documents.push(row);
    return { ...group, panels: [front], activePanel: front };
  });
  if (!presentation || documents.length > RECOVERY_DOCUMENT_LIMIT) return null;
  const active = documents.find((row) => row.panelId === presentation.activePanel && row.kind === "session")
    ?? documents.find((row) => row.kind === "session" && row.panelId === input.state.active.primary)
    ?? documents.find((row) => row.kind === "session");
  const value: SessionPlusRecovery = { version: 2, documents, presentation,
    ...(active?.ref ? { activeSession: active.ref } : {}),
    ...(input.mobileSection ? { mobileSection: input.mobileSection } : {}) };
  const encoded = JSON.stringify(value);
  return utf8Bytes(encoded) <= VIEW_RECOVERY_BYTES ? encoded : null;
}

export interface ResolvedRecoveryDocument extends RecoveryDocument { context?: IntentContext }

/** Recreate semantic panels first, then remap the safe topology to their new ids. */
export function restoreSessionPlusLayout(
  plan: WorkspacePlan,
  recovery: SessionPlusRecovery | null,
  resolved: readonly ResolvedRecoveryDocument[],
  narrow: boolean,
): { state: LayoutState; presentation?: DockPresentation } {
  const reduce = layoutReducer(plan);
  let state = initialLayout(plan, { narrow: false });
  const mapping = new Map<string, string>();
  for (const row of resolved) {
    if (row.kind === null) {
      if (state.panels.some((panel) => panel.panelId === row.panelId)) mapping.set(row.panelId, row.panelId);
      continue;
    }
    if (!row.ref) continue;
    const duplicate = state.panels.some((panel) => panel.moduleId === row.moduleId && panel.resourceRef === row.ref);
    const intent = openResource({ kind: row.kind, ref: row.ref, label: row.label }, {
      view: row.moduleId, mode: duplicate ? "new" : "reuse", ...(row.context ? { context: row.context } : {}),
    });
    if (!intent.ok) continue;
    const next = reduce(state, { type: "open", intent: intent.value });
    if (next === state || !next.focused) continue;
    const panel = next.panels.find((candidate) => candidate.panelId === next.focused);
    if (panel?.resourceRef !== row.ref || panel.moduleId !== row.moduleId) continue;
    mapping.set(row.panelId, panel.panelId);
    state = next;
  }
  let presentation = recovery?.presentation && mapRecoveryPresentation(recovery.presentation, (group) => {
    const id = group.panels[0]!;
    const mapped = id.startsWith("__octopus-flow-") ? id : mapping.get(id);
    return mapped ? { ...group, panels: [mapped], activePanel: mapped } : null;
  }, mapping);
  if (presentation) {
    // Standing prototypes remain mounted and dormant; park them behind a
    // restored front tab. They never inherit a background resource from disk.
    const used = new Set<string>();
    visitGroups(presentation.root, (group) => group.panels.forEach((id) => used.add(id)));
    const missing = dockPresentationScope(plan, state, true).panelIds.filter((id) => !used.has(id));
    let parked = false;
    presentation = mapRecoveryPresentation(presentation, (group) => {
      if (parked || group.panels[0]?.startsWith("__octopus-flow-")) return group;
      parked = true;
      return { ...group, panels: [...group.panels, ...missing] };
    });
    const checked = presentation && readDockPresentation(presentation, dockPresentationScope(plan, state, true));
    if (!checked?.ok) presentation = null;
  }
  const requestedFocus = presentation?.activePanel
    ?? state.panels.find((row) => row.resourceRef === recovery?.activeSession)?.panelId;
  const focus = requestedFocus?.startsWith("__octopus-flow-")
    ? state.panels.find((row) => row.slot === requestedFocus.slice("__octopus-flow-".length))?.panelId : requestedFocus;
  if (focus && state.panels.some((row) => row.panelId === focus)) state = reduce(state, { type: "focus", panelId: focus });
  state = reduce(state, { type: "viewport", narrow });
  return { state, ...(presentation ? { presentation } : {}) };
}

type Group = Extract<DockPresentationNode, { type: "group" }>;
/** Prune without changing alternating split axes when an intermediate branch disappears. */
export function mapRecoveryPresentation(
  presentation: DockPresentation,
  map: (group: Group) => Group | null,
  ids?: ReadonlyMap<string, string>,
): DockPresentation | null {
  type Oriented = { node: DockPresentationNode; orientation: DockPresentation["orientation"] };
  const walk = (node: DockPresentationNode, orientation: Oriented["orientation"]): Oriented | null => {
    if (node.type === "group") { const result = map(node); return result ? { node: result, orientation } : null; }
    const children = node.children.flatMap((child) => {
      const result = walk(child, orientation === "horizontal" ? "vertical" : "horizontal");
      return !result ? [] : result.node.type === "split" && result.orientation === orientation
        ? result.node.children : [result.node];
    });
    if (!children.length) return null;
    if (children.length === 1) {
      const child = children[0]!;
      return { node: { ...child, ...(node.size === undefined ? {} : { size: node.size }) },
        orientation: child.type === "split" ? (orientation === "horizontal" ? "vertical" : "horizontal") : orientation };
    }
    return { node: { ...node, children }, orientation };
  };
  const result = walk(presentation.root, presentation.orientation);
  if (!result) return null;
  const all = new Set<string>();
  visitGroups(result.node, (group) => group.panels.forEach((id) => all.add(id)));
  const active = presentation.activePanel && (ids?.get(presentation.activePanel) ?? presentation.activePanel);
  const { activePanel: _active, ...rest } = presentation;
  return { ...rest, root: result.node, orientation: result.orientation,
    ...(active && all.has(active) ? { activePanel: active } : {}) };
}

function visitGroups(node: DockPresentationNode, visit: (group: Group) => void): void {
  if (node.type === "group") visit(node); else node.children.forEach((child) => visitGroups(child, visit));
}
function utf8Bytes(value: string): number { return new TextEncoder().encode(value).length; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).every((key) => keys.includes(key)); }
