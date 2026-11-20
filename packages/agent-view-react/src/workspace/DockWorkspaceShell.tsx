/**
 * Optional IDE-style presentation for the WorkspaceCoordinator.
 *
 * Dockview is an interaction engine here, never a second workspace model. Its
 * params carry one stable panel id (or one closed flow-slot name), while the
 * reducer next door remains the only owner of resource identity, open/reuse,
 * focus and close. In particular, Dockview add/remove events are not semantic
 * lifecycle events: a drag is allowed to produce both while the React panel
 * remains the same mounted instance.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  DockviewDefaultTab,
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewReactProps,
  type DockviewTheme,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
} from "dockview-react";
import type { WorkspaceSlot } from "@claude-bot/agent-module-contract";
import { AvButton } from "../controls.js";
import type { WorkspaceApi } from "./api.js";
import {
  WorkspacePanel,
  WorkspaceProvider,
  WorkspaceCloseConfirmation,
  type WorkspacePanelProps,
} from "./WorkspaceShell.js";
import {
  DOCK_DOCUMENT_COMPONENT,
  DOCK_FLOW_COMPONENT,
  DOCK_FLOW_PANEL_IDS,
  captureDockPresentation,
  defaultDockPresentation,
  dockPresentationScope,
  dockPresentationExtent,
  isDockFlowPanelId,
  materializeDockPresentation,
  panelState,
  projectDockLayout,
  readDockDocumentParams,
  readDockFlowParams,
  readDockPresentation,
  type DockPresentation,
  type DockPresentationNode,
  type DockProjection,
  type DockProjectionItem,
} from "./dock-layout.js";
import type { LayoutPanel, LayoutState, WorkspacePlan } from "./layout.js";
import "./dock-workspace.css";

type DockGroupBounds = { id: string; width: number; height: number };
type DockGroupNode = Extract<DockPresentationNode, { type: "group" }>;
type DockCommitOptions = { bounds?: readonly DockGroupBounds[]; replaceSizes?: boolean; rebalances?: readonly DockSplitGeometry[] };

/** The four layers a phone paints one of. Exported for composition labels. */
export type MobileSection = "navigation" | "main" | "resource" | "status";

function isMobileDocumentHidden(
  narrow: boolean,
  section: MobileSection,
  slot: WorkspaceSlot,
): boolean {
  if (!narrow) return false;
  if (section === "main") return slot !== "primary";
  if (section === "resource") return slot === "primary";
  return true;
}

const OCTOPUS_DOCK_THEME = Object.freeze({
  name: "octopus",
  className: "dockview-theme-octopus",
  gap: 6,
  edgeGroupCollapsedSize: 32,
  dndOverlayMounting: "absolute",
  dndPanelOverlay: "group",
  dndTabIndicator: "line",
  dndOverlayBorder: "2px solid var(--dv-active-sash-color)",
  tabAnimation: "smooth",
}) satisfies DockviewTheme;

export interface DockWorkspaceShellProps {
  plan: WorkspacePlan;
  state: LayoutState;
  api: WorkspaceApi;
  className?: string;
  /** Optional composition-owned spacing; geometry and lifecycle stay platform-owned. */
  surfaceClassName?: Partial<Record<WorkspaceSlot, string>>;
  /** Module-specific surface chrome without coupling the platform to module ids. */
  documentClassNameByModule?: Readonly<Record<string, string>>;
  /**
   * Composition-owned names for the phone section buttons.
   *
   * The platform's defaults describe SLOTS ("主区", "资源") because the kernel
   * has no idea what a composition put in them. An App that does know should
   * say so — "会话" and "文件" are the two things Session Plus is about, and a
   * button that names its content is the difference between a toolbar somebody
   * navigates and one they have to experiment with.
   */
  mobileSectionLabels?: Partial<Record<MobileSection, string>>;
  /**
   * Composition-owned landing layer when a narrow workspace first appears.
   * The choice is used only when that layer exists; drill-in resource focus and
   * later user/focus changes still win.
   */
  initialMobileSection?: MobileSection;
  /** Observe the effective phone layer so an App may checkpoint presentation. */
  onMobileSectionChange?(section: MobileSection): void;
  /**
   * The App's own chrome for the phone bar — a refresh control, a status dot.
   *
   * A ReactNode, not a callback list: what a refresh MEANS belongs to the
   * composition that owns the ports, and the kernel would only be able to
   * guess. It renders on the narrow layer only; the desktop has its own
   * standing chrome inside the modules.
   */
  mobileActions?: ReactNode;
  onPanelClosed?(panel: LayoutPanel): void;
  /**
   * Optional in-memory presentation. It is revalidated against this release's
   * declared panel inventory and used once, when Dockview starts.
   */
  initialPresentation?: DockPresentation;
  /**
   * Called with a sanitized, bounded presentation after user layout changes.
   * The shell never writes localStorage or sends this across the trust boundary.
   */
  onPresentationChange?(presentation: DockPresentation): void;
}

interface DockRenderContextValue {
  plan: WorkspacePlan;
  state: LayoutState;
  api: WorkspaceApi;
  projection: DockProjection;
  rootRef: RefObject<HTMLDivElement | null>;
  mobileSection: MobileSection;
  requestTabClose(panelId: string): void;
  surfaceClassName?: DockWorkspaceShellProps["surfaceClassName"];
  documentClassNameByModule?: DockWorkspaceShellProps["documentClassNameByModule"];
  onPanelClosed?: WorkspacePanelProps["onPanelClosed"];
}

const DockRenderContext = createContext<DockRenderContextValue | null>(null);

function useDockRenderContext(): DockRenderContextValue {
  const value = useContext(DockRenderContext);
  if (!value) throw new Error("Dockview workspace renderer requires DockWorkspaceShell");
  return value;
}

function DockDocumentSurface({ params }: IDockviewPanelProps) {
  const render = useDockRenderContext();
  const checked = readDockDocumentParams(params);
  const panel = checked
    ? render.state.panels.find((row) => row.panelId === checked.panelId)
    : undefined;
  if (!panel) return null;
  const dormant = render.projection.items.some((item) =>
    item.kind === "document" && item.panelId === panel.panelId && item.dormant,
  );
  const mobileHidden = isMobileDocumentHidden(render.state.narrow, render.mobileSection, panel.slot);
  return (
    <div
      className={[
        "av-dock-document",
        render.surfaceClassName?.[panel.slot],
        render.documentClassNameByModule?.[panel.moduleId],
      ].filter(Boolean).join(" ")}
      data-av-dock-document={panel.panelId}
      data-av-dock-slot={panel.slot}
      data-av-dock-dormant={dormant ? "1" : undefined}
      data-av-dock-mobile-hidden={mobileHidden ? "1" : undefined}
      hidden={dormant || mobileHidden || undefined}
      aria-hidden={dormant || mobileHidden || undefined}
      inert={dormant || mobileHidden || undefined}
    >
      <WorkspacePanel
        panel={panel}
        plan={render.plan}
        api={render.api}
        hidden={false}
        tabbed={false}
        onPanelClosed={render.onPanelClosed}
      />
    </div>
  );
}

function DockFlowSurface({ params }: IDockviewPanelProps) {
  const render = useDockRenderContext();
  const checked = readDockFlowParams(params);
  if (!checked) return null;
  const panels = render.state.panels.filter((panel) => panel.slot === checked.flowSlot);
  return (
    <div
      className={["av-dock-flow", render.surfaceClassName?.[checked.flowSlot]].filter(Boolean).join(" ")}
      data-av-dock-flow={checked.flowSlot}
    >
      {panels.map((panel) => (
        <WorkspacePanel
          key={panel.panelId}
          panel={panel}
          plan={render.plan}
          api={render.api}
          hidden={panel.resourceRef !== null && render.state.active[checked.flowSlot] !== panel.panelId}
          tabbed={false}
          onPanelClosed={render.onPanelClosed}
        />
      ))}
    </div>
  );
}

/** Every visible close affordance negotiates through WorkspaceApi.close. */
function ControlledDockTab(props: IDockviewPanelHeaderProps) {
  const render = useDockRenderContext();
  const checked = readDockDocumentParams(props.params);
  const panel = checked
    ? render.state.panels.find((row) => row.panelId === checked.panelId)
    : undefined;
  const dormant = panel ? render.projection.items.some((item) =>
    item.kind === "document" && item.panelId === panel.panelId && item.dormant,
  ) : false;
  const mobileHidden = panel
    ? isMobileDocumentHidden(render.state.narrow, render.mobileSection, panel.slot)
    : false;
  const hidden = dormant || mobileHidden;
  useLayoutEffect(() => {
    if (!checked || !panel) return;
    const tabs = [...(render.rootRef.current?.querySelectorAll<HTMLElement>("[data-av-dock-tab]") ?? [])]
      .filter((candidate) => candidate.dataset.avDockTab === checked.panelId)
      .flatMap((marker) => {
        const tab = marker.closest<HTMLElement>(".dv-tab");
        return tab ? [tab] : [];
    });
    for (const tab of tabs) {
      tab.toggleAttribute("hidden", hidden);
      tab.toggleAttribute("aria-hidden", hidden);
      if (hidden) tab.setAttribute("aria-hidden", "true");
      tab.toggleAttribute("inert", hidden);
      tab.inert = hidden;
    }
    return () => {
      for (const tab of tabs) {
        tab.removeAttribute("hidden");
        tab.removeAttribute("aria-hidden");
        tab.removeAttribute("inert");
        tab.inert = false;
      }
    };
  }, [checked?.panelId, panel, hidden, render.rootRef]);
  if (!checked || !panel) {
    return <DockviewDefaultTab {...props} hideClose />;
  }
  return (
    <DockviewDefaultTab
      {...props}
      data-av-dock-tab={checked.panelId}
      data-av-dock-dormant-tab={dormant ? "1" : undefined}
      data-av-dock-mobile-hidden-tab={mobileHidden ? "1" : undefined}
      data-av-dock-slot={panel.slot}
      data-av-dirty={panel.dirty ? "1" : undefined}
      hideClose={panel.resourceRef === null}
      closeActionOverride={() => render.requestTabClose(checked.panelId)}
    />
  );
}

const DOCK_COMPONENTS = Object.freeze({
  [DOCK_DOCUMENT_COMPONENT]: DockDocumentSurface,
  [DOCK_FLOW_COMPONENT]: DockFlowSurface,
});

export function DockWorkspaceShell(props: DockWorkspaceShellProps) {
  const { plan, state, api } = props;
  const projection = useMemo(() => projectDockLayout(plan, state), [plan, state]);
  const scope = useMemo(() => dockPresentationScope(plan, state, true), [plan, state]);
  const [dockApi, setDockApi] = useState<DockviewApi | null>(null);
  const [presentation, setPresentation] = useState<DockPresentation | null>(null);
  const presentationRef = useRef<DockPresentation | null>(null);
  const [resetNotice, setResetNotice] = useState("");
  const initialRef = useRef(props.initialPresentation);
  const subscriptionsRef = useRef<{ dispose(): void }[]>([]);
  // Dockview 7 reports programmatic maximize/restore mutations as `user`.
  // Guard the adapter-owned phone transaction so its generic user-mutation
  // listener cannot undo the visibility change it just requested.
  const mobileMutationDepth = useRef(0);
  const latestRef = useRef({ plan, state, api, projection, scope, onChange: props.onPresentationChange });
  latestRef.current = { plan, state, api, projection, scope, onChange: props.onPresentationChange };
  const rootRef = useRef<HTMLDivElement>(null);
  const tabCloseFocus = useRef<string | null>(null);
  const dragGeometry = useRef<DockSplitGeometry | null>(null);
  const previousWideProjection = useRef<DockProjection | null>(null);
  const pointerStartBounds = useRef<readonly DockGroupBounds[] | null>(null);
  const [mobileSection, setMobileSection] = useState<MobileSection>(
    () => preferredMobileSection(declaredMobileSections(state), state.drilledIn, props.initialMobileSection),
  );
  useEffect(() => {
    props.onMobileSectionChange?.(mobileSection);
  }, [mobileSection, props.onMobileSectionChange]);
  const previousViewport = useRef({ narrow: state.narrow, drilledIn: state.drilledIn });
  const focusedIdentity = focusedPanelIdentity(state);
  const lastFocused = useRef(focusedIdentity);
  const lastUserDocument = useRef<Partial<Record<MobileSection, string>>>({});

  const requestTabClose = useCallback((panelId: string) => {
    tabCloseFocus.current = panelId;
    latestRef.current.api.close(panelId);
  }, []);

  // Dockview applies changed option callbacks through updateOptions. Keep this
  // reader stable across live content frames so it does not interrupt a sash
  // transaction; resolve the current panel state only when the menu opens.
  const getTabContextMenuItems = useCallback<NonNullable<IDockviewReactProps["getTabContextMenuItems"]>>(
    ({ panel }) => {
      const semantic = latestRef.current.state.panels.find((row) => row.panelId === panel.id);
      return !semantic || semantic.resourceRef === null
        ? []
        : [{ label: "关闭", action: () => requestTabClose(panel.id) }];
    },
    [requestTabClose],
  );

  const renderContext = useMemo<DockRenderContextValue>(() => ({
    plan,
    state,
    api,
    projection,
    rootRef,
    mobileSection,
    requestTabClose,
    surfaceClassName: props.surfaceClassName,
    documentClassNameByModule: props.documentClassNameByModule,
    onPanelClosed: props.onPanelClosed,
  }), [
    plan,
    state,
    api,
    projection,
    mobileSection,
    requestTabClose,
    props.surfaceClassName,
    props.documentClassNameByModule,
    props.onPanelClosed,
  ]);

  const commitPresentation = useCallback((
    source: DockviewApi,
    options: DockCommitOptions = {},
  ) => {
    const latest = latestRef.current;
    if (latest.state.narrow) return;
    const bounds = options.bounds ?? captureDockGroupBounds(source);
    const captured = captureDockPresentation(source.toJSON(), latest.scope);
    if (!captured.ok) return;
    const withOwnedSizes = mergeDockPresentationGroupSizes(
      withDockGroupSizes(captured.value, new Map(bounds.map(({ id, ...size }) => [id, size]))),
      presentationRef.current,
      options.replaceSizes ?? false,
    );
    const next = (options.rebalances ?? []).reduce(
      (current, geometry) => rebalanceDockPresentation(current, source, geometry),
      withOwnedSizes,
    );
    if (JSON.stringify(next) === JSON.stringify(presentationRef.current)) return;
    presentationRef.current = next;
    setPresentation(next);
    latest.onChange?.(next);
  }, []);

  const onReady = useCallback((event: DockviewReadyEvent) => {
    const latest = latestRef.current;
    const candidate = initialRef.current === undefined
      ? { ok: true as const, value: defaultDockPresentation(latest.plan, latest.state) }
      : readDockPresentation(initialRef.current, latest.scope);
    const presentation = candidate.ok
      ? candidate.value
      : defaultDockPresentation(latest.plan, latest.state);
    if (!candidate.ok) setResetNotice("布局偏好不兼容，已恢复默认布局");
    event.api.fromJSON(materializeDockPresentation(presentation, latest.projection));
    // Existing front documents already have deliberate placement. The first
    // reconciliation must not treat a restored file tab as a newly opened file.
    if (initialRef.current !== undefined && candidate.ok) previousWideProjection.current = latest.projection;
    presentationRef.current = presentation;
    setPresentation(presentation);

    subscriptionsRef.current.push(
      event.api.onDidActivePanelChange((change) => {
        if (change.origin !== "user" || !change.panel || isDockFlowPanelId(change.panel.id)) return;
        const current = latestRef.current;
        const item = current.projection.items.find((candidate) => candidate.dockId === change.panel!.id);
        if (item?.kind === "document" && item.dormant) {
          const fallback = current.projection.activeDockId
            ? event.api.getPanel(current.projection.activeDockId)
            : undefined;
          fallback?.api.setActive();
          fallback?.group.focus();
          return;
        }
        if (item?.kind === "document") lastUserDocument.current[sectionOfSlot(item.slot)] = change.panel.id;
        if (current.state.narrow && item?.kind === "document") {
          const section = item.slot === "primary" ? "main" : "resource";
          setMobileSection(section);
          if (section === "main" && current.state.drilledIn) current.api.back();
        }
        if (current.state.panels.some((panel) => panel.panelId === change.panel!.id)) {
          current.api.focus(change.panel.id);
          commitPresentation(event.api);
        }
      }),
      event.api.onDidMutateLayout((change) => {
        if (mobileMutationDepth.current > 0) return;
        if (change.origin === "user") {
          const geometry = dragGeometry.current;
          dragGeometry.current = null;
          syncDormantGroups(event.api, latestRef.current.projection);
          commitPresentation(event.api, {
            ...(geometry ? { rebalances: [geometry] } : {}),
          });
        }
      }),
      event.api.onWillDragPanel((change) => {
        if (isDockFlowPanelId(change.panel.id)) {
          change.nativeEvent.preventDefault();
          return;
        }
        dragGeometry.current = captureDockSplitGeometry(event.api, change.panel.id);
        rootRef.current?.setAttribute("data-av-dock-dragging", "");
      }),
      event.api.onWillDragGroup((change) => {
        if (change.group.panels.some((panel) => isDockFlowPanelId(panel.id))) {
          change.nativeEvent.preventDefault();
          return;
        }
        dragGeometry.current = captureDockSplitGeometry(
          event.api,
          change.group.activePanel?.id,
          change.group.id,
        );
        rootRef.current?.setAttribute("data-av-dock-dragging", "");
      }),
      event.api.onWillShowOverlay((change) => {
        if (change.group?.panels.some((panel) => isDockFlowPanelId(panel.id))) {
          change.preventDefault();
        }
      }),
    );
    setDockApi(event.api);
  }, [commitPresentation]);

  useEffect(() => () => {
    for (const disposable of subscriptionsRef.current.splice(0)) disposable.dispose();
  }, []);

  useEffect(() => {
    const finishDrag = () => {
      rootRef.current?.removeAttribute("data-av-dock-dragging");
      const finished = dragGeometry.current;
      window.setTimeout(() => {
        if (dragGeometry.current === finished) dragGeometry.current = null;
      }, 0);
    };
    window.addEventListener("dragend", finishDrag, true);
    window.addEventListener("drop", finishDrag, true);
    window.addEventListener("blur", finishDrag);
    return () => {
      window.removeEventListener("dragend", finishDrag, true);
      window.removeEventListener("drop", finishDrag, true);
      window.removeEventListener("blur", finishDrag);
    };
  }, []);

  useLayoutEffect(() => {
    if (!dockApi) return;
    const rebalances = reconcileDockLayout(
      dockApi,
      projection,
      rootRef.current,
      state.narrow,
      previousWideProjection.current,
    );
    if (!state.narrow) previousWideProjection.current = projection;
    if (!state.narrow && rebalances) {
      commitPresentation(dockApi, { rebalances });
      return;
    }
    if (!state.narrow && presentation) {
      applyDockPresentationSizes(dockApi, presentation);
      // Semantic opens/focus/close are programmatic Dock events too. Capture
      // them after reconciliation so the front tab never lags the workspace.
      commitPresentation(dockApi);
    }
  }, [commitPresentation, dockApi, presentation, projection, state.narrow]);

  useEffect(() => {
    if (!dockApi) return;
    const finishResize = () => {
      const before = pointerStartBounds.current;
      pointerStartBounds.current = null;
      if (!before) return;
      const after = captureDockGroupBounds(dockApi);
      if (dockGroupBoundsChanged(before, after)) {
        commitPresentation(dockApi, { bounds: after, replaceSizes: true });
      }
    };
    // Dockview completes its document-level pointer transaction first. The
    // same bubbling event then reaches window, where the App snapshots the
    // settled public group geometry without a timer or a private sash lookup.
    window.addEventListener("pointerup", finishResize);
    window.addEventListener("pointercancel", finishResize);
    return () => {
      window.removeEventListener("pointerup", finishResize);
      window.removeEventListener("pointercancel", finishResize);
    };
  }, [commitPresentation, dockApi]);

  useEffect(() => {
    const previous = previousViewport.current;
    if (state.narrow) {
      const available = mobileSections(projection);
      setMobileSection((current) => {
        if (!previous.narrow) {
          return preferredMobileSection(available, state.drilledIn, props.initialMobileSection);
        }
        if (state.drilledIn && !previous.drilledIn && available.resource) return "resource";
        if (!available[current]) return preferredMobileSection(available, state.drilledIn);
        // An ordinary coordinator `back` returns a drill-in to the preferred
        // root. A toolbar selection dispatches `back` too, but has already
        // selected an available navigation/status section and must not be
        // overwritten by this synchronization effect.
        if (!state.drilledIn && previous.drilledIn && current === "resource") {
          return preferredMobileSection(available, false);
        }
        return current;
      });
    }
    previousViewport.current = { narrow: state.narrow, drilledIn: state.drilledIn };
  }, [state.narrow, state.drilledIn, projection, props.initialMobileSection]);

  /**
   * On a phone, an accepted open intent is a JUMP (ticket #189).
   *
   * The coordinator focuses the panel it opened; this is the only place that
   * knows which layer that panel lives in. Without it, tapping a session in the
   * rail changed what the hidden main layer showed and left the reader looking
   * at the rail — "nothing happened", which is how the ticket describes it.
   *
   * It runs AFTER the section-synchronisation effect above, so for one commit
   * that produces both a drill-in and a focus change, the focused panel wins.
   * Only a CHANGE of semantic focus (panel or bound resource) jumps:
   * re-rendering the same focused chat must not yank a reader back out of a
   * layer they navigated to by hand.
   */
  useEffect(() => {
    const previous = lastFocused.current;
    lastFocused.current = focusedIdentity;
    if (!state.narrow || !state.focused || focusedIdentity === previous) return;
    const panel = state.panels.find((row) => row.panelId === state.focused);
    if (!panel) return;
    const section = sectionOfSlot(panel.slot);
    if (!mobileSections(projection)[section]) return;
    setMobileSection(section);
    // Leaving the resource layer by focus is the same event as leaving it by
    // the back button; the coordinator's drill-in flag must not survive it.
    if (section !== "resource" && state.drilledIn) api.back();
  }, [api, focusedIdentity, projection, state.drilledIn, state.focused, state.narrow, state.panels]);

  useLayoutEffect(() => {
    if (!dockApi) return;
    dockApi.updateOptions({ disableDnd: state.narrow });
    mobileMutationDepth.current += 1;
    try {
      if (!state.narrow) {
        if (dockApi.hasMaximizedGroup()) dockApi.exitMaximizedGroup();
        clearMobileGroupAccessibility(dockApi);
        syncDormantGroups(dockApi, projection);
        return;
      }
      const panel = mobilePanelFor(mobileSection, dockApi, projection, state);
      if (!panel) return;
      if (!panel.api.isMaximized()) {
        if (dockApi.hasMaximizedGroup()) dockApi.exitMaximizedGroup();
        // Restore semantic (not mobile) visibility before choosing the next
        // target. This preserves each split's cached desktop size.
        syncDormantGroups(dockApi, projection);
        if (!panel.group.isVisible) panel.group.api.setVisible(true);
        panel.api.setActive();
        panel.api.maximize();
      } else {
        // Projection changes can make a sibling tab dormant while this group
        // remains maximized; keep that semantic visibility in sync too.
        syncDormantGroups(dockApi, projection);
      }
      // A phone section names a panel, while Dockview maximizes its whole
      // group. Primary and resource documents deliberately share the central
      // desktop group, so switching sections must still select the requested
      // panel even when that group was already maximized.
      panel.api.setActive();
      syncMobileDocumentTabCounts(dockApi, projection, mobileSection);
      syncMobileGroupAccessibility(dockApi, panel.group, mobileSection, projection);
    } finally {
      mobileMutationDepth.current -= 1;
    }
  }, [dockApi, mobileSection, projection, state]);

  // Run close focus handoff after the phone section/maximize transaction. A
  // declared resource close can change resource -> main in the same commit;
  // focusing before that transaction would target a temporarily hidden tab.
  useLayoutEffect(() => {
    if (!dockApi) return;
    const requested = tabCloseFocus.current;
    if (!requested || state.closePendingPanelId === requested) return;
    const item = projection.items.find((candidate) => candidate.dockId === requested);
    const target = item?.kind === "document" && !item.dormant
      ? requested
      : projection.activeDockId;
    if (!target || focusDockTarget(
      rootRef.current,
      dockApi,
      projection,
      target,
      state.narrow,
      mobileSection,
    )) {
      tabCloseFocus.current = null;
    }
  }, [dockApi, mobileSection, projection, state.closePendingPanelId, state.narrow]);

  const selectMobileSection = useCallback((section: MobileSection) => {
    setMobileSection(section);
    if (section !== "resource" && latestRef.current.state.drilledIn) latestRef.current.api.back();
    const target = lastUserDocument.current[section]
      ?? semanticPanelForSection(section, latestRef.current.projection, latestRef.current.state);
    if (target) latestRef.current.api.focus(target);
  }, []);

  const onDockKeyDownCapture = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (routeVisibleTabNavigation(event)) return;
    if (dockApi && routeWorkspaceKeyboardNavigation(
      event,
      dockApi,
      event.currentTarget,
      (dockId) => {
        const current = latestRef.current;
        if (isDockFlowPanelId(dockId)) {
          const slot = dockId === DOCK_FLOW_PANEL_IDS.navigation ? "navigation" : "bottom";
          const panelId = current.state.active[slot];
          if (panelId) current.api.focus(panelId);
        } else if (current.state.panels.some((panel) => panel.panelId === dockId)) {
          current.api.focus(dockId);
        }
      },
    )) {
      commitPresentation(dockApi);
      return;
    }
    if (event.key !== "Delete" && event.key !== "Backspace") return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const dockTab = target.closest<HTMLElement>(".dv-tab");
    if (!dockTab || !event.currentTarget.contains(dockTab)) return;

    // Dockview's built-in WAI-ARIA tab handler closes a panel directly for
    // Delete/Backspace. Stop that lifecycle at capture time: every tab in this
    // adapter is coordinator-controlled, including flow and empty standing
    // surfaces which are deliberately not closeable at all.
    event.preventDefault();
    event.stopPropagation();
    const marker = dockTab.matches("[data-av-dock-tab]")
      ? dockTab
      : dockTab.querySelector<HTMLElement>("[data-av-dock-tab]");
    const panelId = marker?.dataset.avDockTab;
    if (!panelId) return;
    const current = latestRef.current;
    const panel = current.state.panels.find((row) => row.panelId === panelId);
    if (panel && panel.resourceRef !== null) requestTabClose(panelId);
  }, [commitPresentation, dockApi, requestTabClose]);

  const mobileAvailability = mobileSections(projection);
  const mobileControls = dockApi
    ? mobileSectionControls(dockApi, projection, state)
    : {};
  return (
    <WorkspaceProvider api={api}>
      <DockRenderContext.Provider value={renderContext}>
        <div
          ref={rootRef}
          className={["av-dock-workspace", props.className].filter(Boolean).join(" ")}
          data-av-dock-workspace
          data-av-narrow={state.narrow ? "1" : undefined}
          data-av-dock-mobile-section={state.narrow ? mobileSection : undefined}
          onKeyDownCapture={onDockKeyDownCapture}
          onPointerDownCapture={() => {
            if (!dockApi || latestRef.current.state.narrow) return;
            pointerStartBounds.current = captureDockGroupBounds(dockApi);
          }}
          onAuxClickCapture={(event) => {
            if (event.button !== 1 || !(event.target instanceof Element)) return;
            const dockTab = event.target.closest<HTMLElement>(".dv-tab");
            if (!dockTab || !event.currentTarget.contains(dockTab)) return;
            const marker = dockTab.querySelector<HTMLElement>("[data-av-dock-tab]");
            const panelId = marker?.dataset.avDockTab;
            const panel = panelId
              ? latestRef.current.state.panels.find((candidate) => candidate.panelId === panelId)
              : undefined;
            if (!panel || panel.resourceRef === null) return;
            event.preventDefault();
            event.stopPropagation();
            requestTabClose(panel.panelId);
          }}
        >
          {resetNotice ? <div className="av-dock-reset" role="status" data-av-dock-reset-notice>{resetNotice}</div> : null}
          {state.narrow ? (
            <MobileDockNavigation
              selected={mobileSection}
              available={mobileAvailability}
              declared={declaredMobileSections(state)}
              controls={mobileControls}
              labels={props.mobileSectionLabels}
              actions={props.mobileActions}
              onSelect={selectMobileSection}
            />
          ) : null}
          <div className="av-dock-host" data-av-dock-host>
            <DockviewReact
              components={DOCK_COMPONENTS}
              defaultTabComponent={ControlledDockTab}
              defaultRenderer="always"
              disableDnd={state.narrow}
              disableFloatingGroups
              disableTabsOverflowList
              keyboardNavigation={false}
              noPanelsOverlay="emptyGroup"
              theme={OCTOPUS_DOCK_THEME}
              getTabContextMenuItems={getTabContextMenuItems}
              onReady={onReady}
            />
          </div>
          <WorkspaceCloseConfirmation state={state} api={api} />
        </div>
      </DockRenderContext.Provider>
    </WorkspaceProvider>
  );
}

/** Platform defaults. A composition that knows its content should override. */
const MOBILE_SECTION_LABELS: Readonly<Record<MobileSection, string>> = Object.freeze({
  navigation: "导航",
  main: "主区",
  resource: "资源",
  status: "状态",
});

const MOBILE_SECTION_ORDER: readonly MobileSection[] = Object.freeze([
  "navigation",
  "main",
  "resource",
  "status",
]);

function MobileDockNavigation({
  selected,
  available,
  declared,
  controls,
  labels,
  actions,
  onSelect,
}: {
  selected: MobileSection;
  available: Readonly<Record<MobileSection, boolean>>;
  /** Sections this composition has any panel for; the rest are not rendered. */
  declared: Readonly<Record<MobileSection, boolean>>;
  controls: Partial<Record<MobileSection, string>>;
  labels?: Partial<Record<MobileSection, string>>;
  actions?: ReactNode;
  onSelect(section: MobileSection): void;
}) {
  // A section this release declares no panel for is not a button that happens
  // to be disabled — it is a control with no meaning, and a permanently greyed
  // one in a four-across bar reads as something broken (ticket #189: "your
  // fourth button, I'm not sure what it does"). Availability still disables:
  // "文件" exists in this App and is empty until something is opened into it.
  const rows = MOBILE_SECTION_ORDER
    .filter((section) => declared[section])
    .map((section) => [section, labels?.[section] ?? MOBILE_SECTION_LABELS[section]] as const);
  const tabsRef = useRef<HTMLDivElement>(null);
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>, section: MobileSection): void => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const enabled = rows.filter(([candidate]) => available[candidate]).map(([candidate]) => candidate);
    if (!enabled.length) return;
    const index = Math.max(0, enabled.indexOf(section));
    const next = event.key === "Home"
      ? enabled[0]!
      : event.key === "End"
        ? enabled[enabled.length - 1]!
        : enabled[(index + (event.key === "ArrowLeft" ? -1 : 1) + enabled.length) % enabled.length]!;
    event.preventDefault();
    onSelect(next);
    tabsRef.current
      ?.querySelector<HTMLButtonElement>(`[data-av-dock-mobile-target="${next}"]`)
      ?.focus();
  };
  return (
    <div className="av-dock-mobile-bar" data-av-dock-mobile-bar>
      <div
        ref={tabsRef}
        className="av-dock-mobile-tabs"
        role="tablist"
        aria-label="工作区区域"
        style={{ gridTemplateColumns: `repeat(${Math.max(1, rows.length)}, minmax(0, 1fr))` }}
      >
        {rows.map(([section, label]) => (
          <AvButton
            key={section}
            id={mobileSectionTabId(section)}
            role="tab"
            aria-selected={selected === section}
            aria-controls={controls[section]}
            tabIndex={selected === section ? 0 : -1}
            disabled={!available[section]}
            data-av-dock-mobile-target={section}
            onClick={() => onSelect(section)}
            onKeyDown={(event) => onKeyDown(event, section)}
          >
            {label}
          </AvButton>
        ))}
      </div>
      {actions ? <div className="av-dock-mobile-actions">{actions}</div> : null}
    </div>
  );
}

/** Which phone layer each workspace slot is painted in. */
function sectionOfSlot(slot: WorkspaceSlot): MobileSection {
  if (slot === "primary") return "main";
  if (slot === "secondary" || slot === "overlay") return "resource";
  if (slot === "bottom") return "status";
  return "navigation";
}

/**
 * Sections this composition has any panel for — including a standing panel
 * that is currently dormant, which is what keeps the button set stable while a
 * file is opened and closed.
 */
function declaredMobileSections(state: LayoutState): Readonly<Record<MobileSection, boolean>> {
  const declared = { navigation: false, main: false, resource: false, status: false };
  for (const panel of state.panels) declared[sectionOfSlot(panel.slot)] = true;
  return declared;
}

function reconcileDockLayout(
  dockApi: DockviewApi,
  projection: DockProjection,
  root?: HTMLElement | null,
  narrow = false,
  previousProjection: DockProjection | null = null,
): readonly DockSplitGeometry[] | null {
  const desired = new Map(projection.items.map((item) => [item.dockId, item]));

  // Semantic removal is the only reason reconciliation removes a Dockview
  // panel. Dockview's own remove/add events during a move are never observed as
  // close requests.
  for (const panel of [...dockApi.panels]) {
    if (!desired.has(panel.id)) {
      dockApi.removePanel(panel);
    }
  }

  for (const item of projection.items) {
    const existing = dockApi.getPanel(item.dockId);
    if (existing) {
      if (existing.title !== item.title) existing.api.setTitle(item.title);
      continue;
    }
    addProjectedPanel(dockApi, item, projection);
  }

  const rebalances = !narrow
    ? placeNewlyVisibleResources(dockApi, projection, previousProjection)
    : null;

  const handoffFocus = projection.items.some((item) => {
    if (item.kind !== "document" || !item.dormant || !document.activeElement) return false;
    return [...(root?.querySelectorAll<HTMLElement>("[data-av-dock-document]") ?? [])]
      .find((candidate) => candidate.dataset.avDockDocument === item.panelId)
      ?.contains(document.activeElement) === true;
  });
  // Phone visibility has one owner: the maximize transaction below. A second
  // reconcile-time owner would flash the desktop grid and can cancel maximize.
  if (!narrow) syncDormantGroups(dockApi, projection);
  if (projection.activeDockId && dockApi.activePanel?.id !== projection.activeDockId) {
    dockApi.getPanel(projection.activeDockId)?.api.setActive();
  }
  if (handoffFocus && projection.activeDockId) {
    dockApi.getPanel(projection.activeDockId)?.group.focus();
  }
  return rebalances;
}

/** Geometry captured before Dockview is allowed to mutate a user drag. */
export interface DockSplitGeometry {
  panelId?: string;
  sourceGroupId: string;
  sourceWidth: number;
  sourceHeight: number;
  /** Live pixels before Dockview redistributes sibling groups for this split. */
  groupBounds?: readonly DockGroupBounds[];
}

function captureDockSplitGeometry(
  dockApi: DockviewApi,
  panelId: string | undefined,
  sourceGroupId?: string,
): DockSplitGeometry | null {
  const source = sourceGroupId
    ? dockApi.groups.find((group) => group.id === sourceGroupId)
    : panelId
      ? dockApi.getPanel(panelId)?.group
      : undefined;
  const sourceBox = source?.api.boundingBox;
  if (!source || !sourceBox) return null;
  return {
    ...(panelId ? { panelId } : {}),
    sourceGroupId: source.id,
    sourceWidth: sourceBox.width,
    sourceHeight: sourceBox.height,
    groupBounds: captureDockGroupBounds(dockApi),
  };
}

/** Preserve the rail and split only the document rectangle in App state. */
export function rebalanceDockPresentation(
  presentation: DockPresentation,
  dockApi: DockviewApi,
  geometry: DockSplitGeometry,
): DockPresentation {
  const source = dockApi.groups.find((group) => group.id === geometry.sourceGroupId);
  const target = geometry.panelId ? dockApi.getPanel(geometry.panelId)?.group : undefined;
  const sourceBox = source?.api.boundingBox;
  const targetBox = target?.api.boundingBox;
  if (!source || !target || source.id === target.id || !sourceBox || !targetBox) return presentation;
  const horizontal = Math.abs(sourceBox.left + sourceBox.width / 2 - targetBox.left - targetBox.width / 2)
    >= Math.abs(sourceBox.top + sourceBox.height / 2 - targetBox.top - targetBox.height / 2);
  const dimension = horizontal ? "width" : "height";
  const extent = (horizontal ? geometry.sourceWidth : geometry.sourceHeight) / 2;
  if (extent <= 0) return presentation;
  const sizes = dockGroupSizes(presentation.root);
  // The first structural capture has no previous group ids/pixels to merge.
  // Use the pre-split rectangle, never the temporary three-way redistribution.
  for (const { id, width, height } of geometry.groupBounds ?? []) {
    sizes.set(id, { width, height });
  }
  for (const group of [source, target]) {
    const box = group.api.boundingBox!;
    const previous = sizes.get(group.id) ?? { width: box.width, height: box.height };
    sizes.set(group.id, { ...previous, [dimension]: Math.round(extent) });
  }
  return withDockGroupSizes(presentation, sizes);
}

/**
 * Structural captures may reflect Dockview's temporary redistribution. Keep
 * existing App-owned sizes, except when pointerup explicitly replaces the
 * rendered groups. Newly created groups take their first public API bounds.
 */
export function mergeDockPresentationGroupSizes(
  captured: DockPresentation,
  current: DockPresentation | null,
  replaceCaptured: boolean,
): DockPresentation {
  const capturedSizes = dockGroupSizes(captured.root);
  const scaleX = current?.width && captured.width ? captured.width / current.width : 1;
  const scaleY = current?.height && captured.height ? captured.height / current.height : 1;
  const currentSizes = new Map(current ? [...dockGroupSizes(current.root)].map(([id, size]) =>
    [id, { width: Math.round(size.width * scaleX), height: Math.round(size.height * scaleY) }] as const) : []);
  const merged = replaceCaptured
    ? new Map([...currentSizes, ...capturedSizes])
    : new Map([...capturedSizes, ...currentSizes]);
  return withDockGroupSizes(captured, merged);
}

function withDockGroupSizes(
  presentation: DockPresentation,
  sizes: ReadonlyMap<string, { width: number; height: number }>,
): DockPresentation {
  const update = (node: DockPresentationNode): DockPresentationNode => node.type === "group"
    ? node.id && sizes.has(node.id) ? { ...node, ...sizes.get(node.id)! } : node
    : { ...node, children: node.children.map(update) };
  return { ...presentation, root: update(presentation.root) };
}

function dockGroupSizes(
  node: DockPresentationNode,
): Map<string, { width: number; height: number }> {
  return new Map(dockGroups(node).flatMap(({ id, width, height }) =>
    id && width && height ? [[id, { width, height }] as const] : [],
  ));
}

function dockGroups(node: DockPresentationNode): DockGroupNode[] {
  return node.type === "group" ? [node] : node.children.flatMap(dockGroups);
}

/**
 * The sole bridge from App-owned pixels back into Dockview's proportional
 * grid. It runs from the shell's layout effect after semantic reconciliation.
 */
export function applyDockPresentationSizes(
  dockApi: DockviewApi,
  presentation: DockPresentation,
): void {
  const applySplit = (
    node: DockPresentationNode,
    orientation: DockPresentation["orientation"],
  ): void => {
    if (node.type === "group") return;
    // The final child consumes the remaining split rectangle. Writing every
    // sibling would make rounding choose a different winner on each call.
    for (const child of node.children.slice(0, -1)) {
      const groupFor = (candidate: DockGroupNode) => candidate.id
        ? dockApi.groups.find((group) => group.id === candidate.id)
        : dockApi.getPanel(candidate.panels[0]!)?.group;
      const owned = dockGroups(child).find((candidate) => groupFor(candidate)?.isVisible);
      const group = owned ? groupFor(owned) : undefined;
      const box = group?.api.boundingBox;
      if (!group || !box) continue;
      const desired = dockPresentationExtent(child, orientation, orientation === "horizontal" ? "vertical" : "horizontal");
      const scale = orientation === "horizontal"
        ? presentation.width && dockApi.width > 0 ? dockApi.width / presentation.width : 1
        : presentation.height && dockApi.height > 0 ? dockApi.height / presentation.height : 1;
      const size = desired === undefined ? child.size : desired * scale;
      if (size === undefined) continue;
      const current = orientation === "horizontal" ? box.width : box.height;
      if (Math.abs(current - size) <= 0.5) continue;
      group.api.setSize(orientation === "horizontal"
        ? { width: size }
        : { height: size });
    }
    const childOrientation = orientation === "horizontal" ? "vertical" : "horizontal";
    for (const child of node.children) applySplit(child, childOrientation);
  };
  applySplit(presentation.root, presentation.orientation);
}

/** Capture live geometry only through Dockview's public group API. */
export function captureDockGroupBounds(dockApi: DockviewApi): readonly DockGroupBounds[] {
  return dockApi.groups.flatMap((group) => {
    const box = group.api.boundingBox;
    if (!group.isVisible || !box || ![box.width, box.height].every(Number.isFinite)
      || box.width <= 0 || box.height <= 0) return [];
    return [{ id: group.id, width: box.width, height: box.height }];
  });
}

/** A resize keeps group identity stable and changes at least one dimension. */
export function dockGroupBoundsChanged(
  before: readonly DockGroupBounds[],
  after: readonly DockGroupBounds[],
): boolean {
  if (before.length !== after.length) return false;
  const current = new Map(after.map((row) => [row.id, row]));
  return before.every((row) => current.has(row.id)) && before.some((row) => {
    const next = current.get(row.id)!;
    return Math.abs(row.width - next.width) > 0.5 || Math.abs(row.height - next.height) > 0.5;
  });
}

/**
 * A resource opened from the primary surface follows the familiar editor rule:
 * reuse the nearest live group on the right, otherwise split the primary
 * group's own rectangle in half. Restored/user placement wins because a panel
 * that is already outside the primary group is left untouched.
 */
function placeNewlyVisibleResources(
  dockApi: DockviewApi,
  projection: DockProjection,
  previousProjection: DockProjection | null,
): readonly DockSplitGeometry[] | null {
  let changed = false;
  const rebalances: DockSplitGeometry[] = [];
  const primaryItem = projection.items.find((item) =>
    item.kind === "document" && item.defaultGroup === "primary" && !item.dormant,
  );
  const primaryGroup = primaryItem ? dockApi.getPanel(primaryItem.dockId)?.group : undefined;
  if (!primaryGroup) return null;
  const resourcesSharePrimary = previousProjection?.items.some((item) => item.kind === "document"
    && item.defaultGroup === "resource" && !item.dormant
    && dockApi.getPanel(item.dockId)?.group.id === primaryGroup.id);

  for (const item of projection.items) {
    if (item.kind !== "document" || item.defaultGroup !== "resource" || item.dormant) continue;
    const previous = previousProjection?.items.find((candidate) => candidate.dockId === item.dockId);
    if (previous?.kind === "document" && !previous.dormant) continue;
    const panel = dockApi.getPanel(item.dockId);
    if (!panel || panel.group.id !== primaryGroup.id || resourcesSharePrimary) continue;

    const rightId = dockApi.adjacentGroupInDirection(primaryGroup, "right")?.id;
    const right = rightId ? dockApi.groups.find((group) => group.id === rightId) : undefined;
    const reusable = right?.isVisible
      && !right.panels.some((candidate) => isDockFlowPanelId(candidate.id))
      ? right
      : undefined;
    if (reusable) {
      panel.api.moveTo({ group: reusable, position: "center" });
      changed = true;
      continue;
    }

    const geometry = captureDockSplitGeometry(dockApi, panel.id, primaryGroup.id);
    panel.api.moveTo({ group: primaryGroup, position: "right" });
    changed = true;
    if (geometry) rebalances.push(geometry);
  }
  return changed ? rebalances : null;
}

/** Focus a surviving semantic tab, falling back to its visible Dock group. */
function focusDockTarget(
  root: HTMLElement | null,
  dockApi: DockviewApi,
  projection: DockProjection,
  dockId: string,
  narrow: boolean,
  mobileSection: MobileSection,
): boolean {
  const marker = [...(root?.querySelectorAll<HTMLElement>("[data-av-dock-tab]") ?? [])]
    .find((candidate) => candidate.dataset.avDockTab === dockId);
  const tab = marker?.closest<HTMLElement>(".dv-tab");
  if (isNavigableDockTab(tab)) {
    const targetSection = marker?.dataset.avDockSlot === "primary" ? "main" : "resource";
    if (narrow && targetSection !== mobileSection) return false;
    const panel = dockApi.getPanel(dockId);
    const visibleTabCount = panel
      ? mobileDocumentTabCount(panel.group, projection, targetSection)
      : 0;
    if (narrow && visibleTabCount <= 1) {
      const region = root?.querySelector<HTMLButtonElement>(
        `[data-av-dock-mobile-target="${targetSection}"]`,
      );
      region?.focus();
      return document.activeElement === region;
    }
    tab.tabIndex = 0;
    tab.focus();
    return document.activeElement === tab;
  }
  // A marker identifies a document whose tab is temporarily hidden by the
  // phone section switch. Wait for that section's next layout commit rather
  // than focusing the shared group and stranding focus on hidden content.
  if (marker) return false;
  const panel = dockApi.getPanel(dockId);
  if (!panel?.group.isVisible) return false;
  panel.group.focus();
  return true;
}

function clearMobileGroupAccessibility(dockApi: DockviewApi): void {
  for (const group of dockApi.groups) {
    group.element.removeAttribute("data-av-dock-mobile-hidden");
    group.element.removeAttribute("data-av-dock-mobile-visible-tabs");
    group.element.removeAttribute("aria-hidden");
    group.element.removeAttribute("inert");
    group.element.inert = false;
    restoreDockGroupLabel(group);
  }
}

function syncMobileDocumentTabCounts(
  dockApi: DockviewApi,
  projection: DockProjection,
  section: MobileSection,
): void {
  for (const group of dockApi.groups) {
    group.element.dataset.avDockMobileVisibleTabs = String(
      mobileDocumentTabCount(group, projection, section),
    );
  }
}

function mobileDocumentTabCount(
  group: DockviewApi["groups"][number],
  projection: DockProjection,
  section: MobileSection,
): number {
  const items = new Map(projection.items.map((item) => [item.dockId, item]));
  return group.panels.filter((panel) => {
    const item = items.get(panel.id);
    if (item?.kind !== "document" || item.dormant) return false;
    return section === "main"
      ? item.slot === "primary"
      : section === "resource"
        ? item.slot === "secondary" || item.slot === "overlay"
        : false;
  }).length;
}

function syncMobileGroupAccessibility(
  dockApi: DockviewApi,
  target: DockviewApi["groups"][number],
  section: MobileSection,
  projection: DockProjection,
): void {
  for (const group of dockApi.groups) {
    const hidden = group !== target;
    group.element.toggleAttribute("data-av-dock-mobile-hidden", hidden);
    if (hidden) group.element.setAttribute("aria-hidden", "true");
    else group.element.removeAttribute("aria-hidden");
    group.element.toggleAttribute("inert", hidden);
    group.element.inert = hidden;
  }
  const content = target.element.querySelector<HTMLElement>(".dv-content-container");
  const visibleTabs = section === "main" || section === "resource"
    ? mobileDocumentTabCount(target, projection, section)
    : 1;
  if (content && visibleTabs <= 1) {
    if (content.dataset.avDockDesktopLabelledby === undefined) {
      content.dataset.avDockDesktopLabelledby = content.getAttribute("aria-labelledby") ?? "";
    }
    content.setAttribute("aria-labelledby", mobileSectionTabId(section));
  } else {
    restoreDockGroupLabel(target);
  }
}

function restoreDockGroupLabel(group: DockviewApi["groups"][number]): void {
  const content = group.element.querySelector<HTMLElement>(".dv-content-container");
  if (!content) return;
  const activeTab = [...group.element.querySelectorAll<HTMLElement>(".dv-tab.dv-active-tab")]
    .find((tab) => tab.getAttribute("aria-controls") === content.id);
  const labelledBy = activeTab?.id || content.dataset.avDockDesktopLabelledby;
  if (labelledBy) content.setAttribute("aria-labelledby", labelledBy);
  else content.removeAttribute("aria-labelledby");
  delete content.dataset.avDockDesktopLabelledby;
}

function addProjectedPanel(
  dockApi: DockviewApi,
  item: DockProjectionItem,
  projection: DockProjection,
): void {
  const state = panelState(item);
  const referenceGroup = findDefaultGroup(dockApi, item, projection);
  dockApi.addPanel({
    id: state.id,
    component: state.contentComponent!,
    title: state.title,
    params: state.params,
    renderer: "always",
    inactive: item.kind === "document" && item.dormant,
    ...(referenceGroup ? { position: { referenceGroup } } : {}),
  });
}

function findDefaultGroup(
  dockApi: DockviewApi,
  item: DockProjectionItem,
  projection: DockProjection,
) {
  for (const candidate of projection.items) {
    if (candidate.dockId === item.dockId || candidate.defaultGroup !== item.defaultGroup) continue;
    const panel = dockApi.getPanel(candidate.dockId);
    if (panel) return panel.group;
  }
  if (item.kind === "document") {
    const primary = projection.items.find((candidate) =>
      candidate.kind === "document" && !candidate.dormant && candidate.defaultGroup === "primary",
    );
    const panel = primary ? dockApi.getPanel(primary.dockId) : undefined;
    if (panel) return panel.group;
  }
  return undefined;
}

/**
 * Dormancy is derived from semantic resource occupancy. Keep each panel in the
 * group and index chosen by the person, hide only its unidentified tab, and
 * collapse a group only when every document in it is dormant. The enclosing
 * layout effect reapplies App-owned presentation sizes after that visibility
 * mutation; this helper never writes a competing size.
 *
 * Exported from this module for a focused adapter test; it is not part of the
 * package entry-point API.
 */
export function syncDormantGroups(dockApi: DockviewApi, projection: DockProjection): void {
  const desired = new Map(projection.items.map((item) => [item.dockId, item]));
  for (const group of dockApi.groups) {
    const documents = group.panels.flatMap((panel) => {
      const item = desired.get(panel.id);
      return item?.kind === "document" ? [item] : [];
    });
    if (!documents.length) continue;
    const visible = documents.filter((item) => !item.dormant);
    const allDormant = documents.length === group.panels.length && visible.length === 0;
    group.element.dataset.avDockVisibleTabs = String(visible.length);
    if (allDormant) group.element.setAttribute("aria-hidden", "true");
    else group.element.removeAttribute("aria-hidden");
    group.element.toggleAttribute("inert", allDormant);
    group.element.inert = allDormant;
    // `maximize()` temporarily marks every non-target group invisible. Do not
    // mistake that geometry for semantic dormancy and immediately reveal the
    // rest of the grid again. Outside maximize, this adapter is still the only
    // owner of all-dormant group visibility.
    if (allDormant && group.isVisible) {
      group.api.setVisible(false);
    } else if (!allDormant && !group.isVisible && !dockApi.hasMaximizedGroup()) {
      group.api.setVisible(true);
    }

    const activeItem = group.activePanel ? desired.get(group.activePanel.id) : undefined;
    if (!allDormant && activeItem?.kind === "document" && activeItem.dormant) {
      dockApi.getPanel(visible[0]!.dockId)?.api.setActive();
    }
  }
  const activeItem = dockApi.activePanel ? desired.get(dockApi.activePanel.id) : undefined;
  if (!dockApi.activeGroup?.isVisible
    || activeItem?.kind === "document" && activeItem.dormant) {
    const fallback = projection.activeDockId
      ? dockApi.getPanel(projection.activeDockId)
      : dockApi.groups.find((group) => group.isVisible)?.activePanel;
    fallback?.api.setActive();
  }
}

/** Keep Dockview's tablist model while excluding unidentified hidden tabs. */
function routeVisibleTabNavigation(event: ReactKeyboardEvent<HTMLDivElement>): boolean {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return false;
  const target = event.target;
  if (!(target instanceof HTMLElement)) return false;
  const current = target.closest<HTMLElement>(".dv-tab");
  const group = current?.closest<HTMLElement>(".dv-groupview");
  if (!current || !group) return false;
  const all = [...group.querySelectorAll<HTMLElement>(".dv-tab")];
  const visible = all.filter(isNavigableDockTab);
  if (all.length === visible.length || !visible.includes(current)) return false;
  const currentIndex = visible.indexOf(current);
  const nextIndex = event.key === "Home"
    ? 0
    : event.key === "End"
      ? visible.length - 1
      : Math.max(0, Math.min(
          visible.length - 1,
          currentIndex + (event.key === "ArrowLeft" ? -1 : 1),
        ));
  event.preventDefault();
  event.stopPropagation();
  visible.forEach((tab, index) => { tab.tabIndex = index === nextIndex ? 0 : -1; });
  visible[nextIndex]?.focus();
  return true;
}

function isNavigableDockTab(tab: HTMLElement | null | undefined): tab is HTMLElement {
  if (!tab || tab.hidden || tab.inert || tab.getAttribute("aria-hidden") === "true") return false;
  const marker = tab.querySelector<HTMLElement>("[data-av-dock-tab]");
  return marker?.dataset.avDockDormantTab !== "1"
    && marker?.dataset.avDockMobileHiddenTab !== "1";
}

/**
 * Dockview's opt-in accessibility service listens at `document` capture and
 * cannot filter collapsed semantic groups. The shell therefore owns the same
 * bounded shortcuts over the public API while Dockview's native tablist still
 * owns ordinary Arrow/Home/End behavior.
 */
function routeWorkspaceKeyboardNavigation(
  event: ReactKeyboardEvent<HTMLDivElement>,
  dockApi: DockviewApi,
  root: HTMLElement,
  focusSemantic: (dockId: string) => void,
): boolean {
  const sequential = event.key === "F6" && !event.ctrlKey && !event.altKey && !event.metaKey;
  const spatial = event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey
    && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key);
  const switchTab = event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey
    && (event.key === "]" || event.key === "[");
  const focusTabs = event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey
    && event.key === "\\";
  if (!sequential && !spatial && !switchTab && !focusTabs) return false;

  const visible = dockApi.groups.filter((group) => group.isVisible);
  if (!visible.length) return false;
  const current = dockApi.activeGroup && visible.includes(dockApi.activeGroup)
    ? dockApi.activeGroup
    : visible[0]!;
  if (switchTab) {
    const panels = current.panels.filter((panel) => {
      const marker = [...root.querySelectorAll<HTMLElement>("[data-av-dock-tab]")]
        .find((candidate) => candidate.dataset.avDockTab === panel.id);
      return isNavigableDockTab(marker?.closest<HTMLElement>(".dv-tab"));
    });
    if (!panels.length) return false;
    const index = Math.max(0, panels.indexOf(current.activePanel ?? panels[0]!));
    const direction = event.key === "[" ? -1 : 1;
    const target = panels[(index + direction + panels.length) % panels.length]!;
    event.preventDefault();
    event.stopPropagation();
    target.api.setActive();
    target.group.focus();
    focusSemantic(target.id);
    return true;
  }
  if (focusTabs) {
    const activeId = current.activePanel?.id;
    const marker = activeId
      ? [...root.querySelectorAll<HTMLElement>("[data-av-dock-tab]")]
        .find((candidate) => candidate.dataset.avDockTab === activeId)
      : undefined;
    const tab = marker?.closest<HTMLElement>(".dv-tab");
    if (!isNavigableDockTab(tab)) return false;
    event.preventDefault();
    event.stopPropagation();
    tab.tabIndex = 0;
    tab.focus();
    return true;
  }
  let target;
  if (sequential) {
    const direction = event.shiftKey ? -1 : 1;
    const index = visible.indexOf(current);
    target = visible[(index + direction + visible.length) % visible.length];
  } else {
    target = nearestVisibleGroup(current, visible, event.key) ?? current;
  }
  event.preventDefault();
  event.stopPropagation();
  target?.activePanel?.api.setActive();
  target?.focus();
  if (target?.activePanel) focusSemantic(target.activePanel.id);
  return true;
}

function nearestVisibleGroup(
  current: DockviewApi["groups"][number],
  groups: readonly DockviewApi["groups"][number][],
  key: string,
) {
  const box = current.api.boundingBox;
  if (!box) return undefined;
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  const candidates = groups.flatMap((group) => {
    if (group === current || !group.api.boundingBox) return [];
    const other = group.api.boundingBox;
    const dx = other.left + other.width / 2 - x;
    const dy = other.top + other.height / 2 - y;
    const forward = key === "ArrowLeft" ? dx < 0
      : key === "ArrowRight" ? dx > 0
        : key === "ArrowUp" ? dy < 0 : dy > 0;
    if (!forward) return [];
    const primary = key === "ArrowLeft" || key === "ArrowRight" ? Math.abs(dx) : Math.abs(dy);
    const cross = key === "ArrowLeft" || key === "ArrowRight" ? Math.abs(dy) : Math.abs(dx);
    return [{ group, score: primary + cross * 0.35 }];
  });
  candidates.sort((left, right) => left.score - right.score);
  return candidates[0]?.group;
}

/** A standing panel can keep its id while an accepted open rebinds its resource. */
function focusedPanelIdentity(state: LayoutState): string | null {
  if (!state.focused) return null;
  const panel = state.panels.find((candidate) => candidate.panelId === state.focused);
  if (!panel) return state.focused;
  return [panel.panelId, panel.slot, panel.resourceKind ?? "", panel.resourceRef ?? ""].join("\u0000");
}

function mobileSectionTabId(section: MobileSection): string {
  return `av-dock-mobile-tab-${section}`;
}

function mobileSectionControls(
  dockApi: DockviewApi,
  projection: DockProjection,
  state: LayoutState,
): Partial<Record<MobileSection, string>> {
  const controls: Partial<Record<MobileSection, string>> = {};
  for (const section of ["navigation", "main", "resource", "status"] as const) {
    const panel = mobilePanelFor(section, dockApi, projection, state);
    const id = panel?.group.element.querySelector<HTMLElement>(".dv-content-container")?.id;
    if (id) controls[section] = id;
  }
  return controls;
}

function preferredMobileSection(
  available: Readonly<Record<MobileSection, boolean>>,
  drilledIn: boolean,
  preferred?: MobileSection,
): MobileSection {
  if (drilledIn && available.resource) return "resource";
  if (preferred && available[preferred]) return preferred;
  for (const section of ["main", "navigation", "resource", "status"] as const) {
    if (available[section]) return section;
  }
  // A linked composition is non-empty and every workspace slot maps above.
  // Keep a total return for defence-in-depth hand-built states.
  return "main";
}

function mobileSections(
  projection: DockProjection,
): Readonly<Record<MobileSection, boolean>> {
  return {
    navigation: projection.items.some((item) => item.kind === "flow" && item.flowSlot === "navigation"),
    main: projection.items.some((item) => item.kind === "document" && item.slot === "primary"),
    resource: projection.items.some((item) =>
      item.kind === "document"
      && !item.dormant
      && (item.slot === "secondary" || item.slot === "overlay"),
    ),
    status: projection.items.some((item) => item.kind === "flow" && item.flowSlot === "bottom"),
  };
}

function semanticPanelForSection(
  section: MobileSection,
  projection: DockProjection,
  state: LayoutState,
): string | undefined {
  if (section === "navigation") return state.active.navigation ?? undefined;
  if (section === "status") return state.active.bottom ?? undefined;
  const slots = section === "main" ? ["primary"] as const : ["secondary", "overlay"] as const;
  for (const slot of slots) {
    const active = state.active[slot];
    if (active && projection.items.some((item) =>
      item.kind === "document" && !item.dormant && item.panelId === active,
    )) return active;
  }
  for (const item of projection.items) {
    if (item.kind !== "document" || item.dormant) continue;
    if (section === "main" ? item.slot === "primary" : item.slot === "secondary" || item.slot === "overlay") {
      return item.panelId;
    }
  }
  return undefined;
}

function mobilePanelFor(
  section: MobileSection,
  dockApi: DockviewApi,
  projection: DockProjection,
  state: LayoutState,
) {
  const dockId = section === "navigation"
    ? DOCK_FLOW_PANEL_IDS.navigation
    : section === "status"
      ? DOCK_FLOW_PANEL_IDS.bottom
      : semanticPanelForSection(section, projection, state);
  return dockId ? dockApi.getPanel(dockId) : undefined;
}
