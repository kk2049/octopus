/**
 * `@claude-bot/agent-view-react/workspace` — the layout kernel.
 *
 * A static module registry, two opt-in renderers for the same workspace state,
 * and the one reducer allowed to change layout semantics. Nothing here fetches, imports
 * by string, parses a URL, or knows what a MessagePort is: modules are objects
 * the build already compiled in, and a composition may only reference ids that
 * are in the lock this registry derives from those modules.
 *
 * `WorkspaceShell` remains the fixed five-slot renderer. `DockWorkspaceShell`
 * is an optional Dockview-backed presentation; it does not give modules a move
 * API and does not make the dependency's layout JSON part of the module ABI.
 */

export {
  createModuleRegistry,
  type ModuleComponent,
  type ModuleProps,
  type ModuleRegistry,
  type ModuleRegistryEntry,
} from "./registry.js";

export {
  COLUMN_SLOTS,
  LAYOUT_REASON_TEXT,
  acceptsOpenIntent,
  availableViews,
  createWorkspacePlan,
  initialLayout,
  isDocumentSlot,
  layoutReducer,
  panelsIn,
  slotHasVisibleContent,
  visibleSlots,
  type LayoutAction,
  type LayoutPanel,
  type LayoutReason,
  type LayoutState,
  type OpenCandidate,
  type SlotMap,
  type WorkspacePlan,
} from "./layout.js";

export type { OpenOptions, WorkspaceApi } from "./api.js";

export {
  WorkspaceShell,
  WorkspaceCloseConfirmation,
  WorkspacePanel,
  WorkspaceProvider,
  useWorkspace,
  useWorkspaceLayout,
  type SlotChrome,
  type UseWorkspaceLayout,
  type WorkspacePanelProps,
  type WorkspaceProviderProps,
  type WorkspaceShellProps,
} from "./WorkspaceShell.js";

export {
  DockWorkspaceShell,
  type DockWorkspaceShellProps,
  type MobileSection,
} from "./DockWorkspaceShell.js";

export {
  DOCK_PRESENTATION_LIMITS,
  DOCK_PRESENTATION_VERSION,
  decodeDockPresentation,
  defaultDockPresentation,
  dockPresentationScope,
  encodeDockPresentation,
  readDockPresentation,
  type DockPresentation,
  type DockPresentationNode,
  type DockPresentationReadResult,
  type DockPresentationScope,
} from "./dock-layout.js";

export { useNarrowViewport } from "./viewport.js";
