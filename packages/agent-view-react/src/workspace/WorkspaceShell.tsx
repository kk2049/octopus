/**
 * The shell: five slots, one panel boundary each, and no layout opinions of its
 * own beyond that.
 *
 * ── What it is, deliberately ────────────────────────────────────────────────
 *
 * Not a docking library. There is no drag between arbitrary siblings, no nested
 * split tree, no persisted layout AST — React already mounts and reuses
 * components from state, and CSS Grid/Flex already places them. What a workspace
 * adds is the product semantics, and those live in the reducer next door; this
 * file paints the answer.
 *
 * The primary/secondary resize is the shell's own `SplitHandle` from the SDK.
 * That widget already ships pointer capture, arrow-key resizing (with a coarse
 * step on Shift), double-click-to-reset, the WAI-ARIA `separator` role and an
 * in-memory size map by stable key — none of which is worth reinventing per
 * shell, and none of which requires a new layout dependency to reach.
 *
 * Four properties are structural rather than stylistic:
 *
 *  1. **A panel's React key is its panel id.** That is what makes a half-typed
 *     message survive every projection update: the subtree is never re-created
 *     while the panel exists.
 *  2. **Every panel has its own error boundary.** A module that throws degrades
 *     to one line inside its own panel; the rest of the workspace — including
 *     whatever else the reader was doing — keeps rendering. The trusted outer
 *     shell's recovery is still the thing that fixes it.
 *  3. **Closing a runtime panel unmounts; closing a declared surface clears it.**
 *     In both cases the resource prop disappears and the module's effect owns
 *     releasing its stream. `onPanelClosed` observes real unmounts only.
 *  4. **The secondary column is a function of layout state, not of the DOM.**
 *     Whether it paints — and therefore whether the split handle exists at all
 *     — is decided by `slotHasVisibleContent`, so an empty standing viewer does
 *     not steal half the workspace via a `:has` selector the module happened to
 *     trigger. When empty the divider is absent from the DOM and the primary
 *     panel takes the entire main region.
 *
 * The App supplies class names and any divider it wants BETWEEN the navigation
 * rail and the columns; the divider between primary and secondary is the
 * shell's, because that split is what the reducer answers questions about.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PropsWithChildren,
  type ReactNode,
} from "react";
import type { ResourceLink, WorkspaceSlot } from "@claude-bot/agent-module-contract";
import { WORKSPACE_SLOTS, openResource, readOpenResourceIntent } from "@claude-bot/agent-module-contract";
import { AgentViewErrorBoundary } from "../ErrorBoundary.js";
import { AvButton } from "../controls.js";
import { SplitHandle } from "../ui.js";
import type { WorkspaceApi, OpenOptions } from "./api.js";
import {
  COLUMN_SLOTS,
  LAYOUT_REASON_TEXT,
  acceptsOpenIntent,
  initialLayout,
  isDocumentSlot,
  layoutReducer,
  panelsIn,
  slotHasVisibleContent,
  visibleSlots,
  type LayoutAction,
  type LayoutPanel,
  type LayoutState,
  type WorkspacePlan,
} from "./layout.js";
import "./workspace.css";

const WorkspaceContext = createContext<WorkspaceApi | null>(null);

export interface WorkspaceProviderProps extends PropsWithChildren {
  api: WorkspaceApi;
}

/** Shared context boundary for the fixed and docking renderers. */
export function WorkspaceProvider({ api, children }: WorkspaceProviderProps) {
  return <WorkspaceContext.Provider value={api}>{children}</WorkspaceContext.Provider>;
}

/**
 * The coordinator, as a hook.
 *
 * Available to any depth of a module's tree so a leaf (a link inside a
 * transcript) can raise an intent without the module threading a callback
 * through five components. It is still only the four module operations plus
 * the shell-local narrow-screen `back` control.
 */
export function useWorkspace(): WorkspaceApi {
  const api = useContext(WorkspaceContext);
  if (!api) throw new Error("useWorkspace() requires a workspace shell above it");
  return api;
}

export interface UseWorkspaceLayout {
  state: LayoutState;
  dispatch: Dispatch<LayoutAction>;
  api: WorkspaceApi;
}

export function useWorkspaceLayout(plan: WorkspacePlan, options: {
  narrow?: boolean;
  /** Composition-owned recovery, produced through this plan's reducer before mounting modules. */
  initialState?: LayoutState;
} = {}): UseWorkspaceLayout {
  const [state, dispatch] = useReducer(
    useMemo(() => layoutReducer(plan), [plan]),
    undefined,
    () => options.initialState ?? initialLayout(plan, options),
  );
  const stateRef = useRef(state);
  stateRef.current = state;
  const open = useCallback((resource: ResourceLink, opts: OpenOptions = {}): boolean => {
    const intent = openResource(resource, opts);
    if (!intent.ok) return false;
    if (!acceptsOpenIntent(plan, stateRef.current, intent.value)) return false;
    dispatch({ type: "open", intent: intent.value });
    return true;
  }, [plan]);
  const openIntent = useCallback<WorkspaceApi["openIntent"]>((intent) => {
    const checked = readOpenResourceIntent(intent);
    if (!checked.ok) return false;
    if (!acceptsOpenIntent(plan, stateRef.current, checked.value)) return false;
    dispatch({ type: "open", intent: checked.value });
    return true;
  }, [plan]);
  const focus = useCallback((panelId: string) => dispatch({ type: "focus", panelId }), []);
  const close = useCallback((panelId: string) => dispatch({ type: "close", panelId }), []);
  const setDirty = useCallback((panelId: string, dirty: boolean) => {
    dispatch({ type: "set-dirty", panelId, dirty });
  }, []);
  const discardAndClose = useCallback((panelId: string) => {
    dispatch({ type: "discard-close", panelId });
  }, []);
  const cancelClose = useCallback((panelId: string) => {
    dispatch({ type: "cancel-close", panelId });
  }, []);
  const report = useCallback<WorkspaceApi["report"]>((panelId, reason, detail) => {
    dispatch({ type: "report", panelId, reason, detail });
  }, []);
  const back = useCallback(() => dispatch({ type: "back" }), []);
  const api = useMemo<WorkspaceApi>(
    () => ({
      state,
      open,
      openIntent,
      focus,
      close,
      setDirty,
      discardAndClose,
      cancelClose,
      report,
      back,
    }),
    [back, cancelClose, close, discardAndClose, focus, open, openIntent, report, setDirty, state],
  );
  return { state, dispatch, api };
}

export interface SlotChrome {
  className?: string;
  /** Rendered after this slot's element — a splitter for the App's own dividers. */
  divider?: ReactNode;
  /**
   * Accessible name for this slot's `role="tablist"`, used verbatim as
   * `aria-label`. Give it a localizable App-owned string; anything derived
   * from tab contents ("笔记一, 笔记二…") is wrong twice — the strip's
   * identity is a property of the SLOT, not of whichever documents happen to
   * be open right now, and rebuilding the name on every open/close would
   * make a screen reader re-announce the region for a change that did not
   * touch it. Falls back to `"打开的资源"` (the SDK-neutral name for the
   * concept "Open resources") when the App does not supply one.
   */
  tabsLabel?: string;
}

export interface WorkspaceShellProps {
  plan: WorkspacePlan;
  state: LayoutState;
  api: WorkspaceApi;
  className?: string;
  chrome?: Partial<Record<WorkspaceSlot, SlotChrome>>;
  /** Label for the narrow-screen way back out of a drill-in. */
  backLabel?: string;
  onPanelClosed?(panel: LayoutPanel): void;
}

/**
 * A stable in-memory key for the split's remembered pixel width.
 *
 * `SplitHandle` stores per key in a module-level map, which lives for as long
 * as the View bundle is loaded — the exact lifetime the ticket asks for
 * ("比例先保持 View 内存态"). One name for the whole shell is enough: this
 * package mounts one WorkspaceShell per Agent View, and a second shell inside
 * the first would be a nested workspace we do not have.
 */
const SPLIT_STORAGE_KEY = "agent-view.main-secondary";

/**
 * Accessible name for the stacked-document tab strip, when the App does not
 * supply one through `SlotChrome.tabsLabel`.
 *
 * "打开的资源" — the SDK-neutral name for the concept "Open resources".
 * Every locale is expected to override with an App-owned label, but a
 * missing name is worse than a somewhat generic one: `role="tablist"` with
 * no accessible name is reported as unnamed by every screen reader.
 */
const DEFAULT_TABS_LABEL = "打开的资源";

/**
 * Pixel bounds for the resizable secondary column.
 *
 * `SplitHandle` uses pixels rather than percentages (it writes `width` to a
 * DOM sibling). An initial 50/50 arrives from the flex row itself — with
 * nothing remembered, primary and secondary are both `flex: 1` and share the
 * row equally. Once the reader drags, the widget remembers pixels; on the
 * next open of secondary the same width is re-applied. Trade-off documented
 * in the delivery notes: window resize no longer stays proportional (fixed
 * pixel width), and a double-click on the divider resets to the flex share.
 */
const MIN_SECONDARY_PX = 240;
const MAX_SECONDARY_PX = 1200;

export function WorkspaceShell(props: WorkspaceShellProps) {
  const { plan, state, api } = props;
  const visible = visibleSlots(state);
  const secondaryOccupied = slotHasVisibleContent(state, "secondary");

  const renderSlot = (slot: WorkspaceSlot, extra?: { forceHidden?: boolean }) => {
    const panels = panelsIn(state, slot);
    if (!panels.length) return null;
    return (
      <SlotRegion
        key={slot}
        slot={slot}
        panels={panels}
        active={state.active[slot]}
        plan={plan}
        api={api}
        chrome={props.chrome?.[slot]}
        // A slot outside the narrow-screen viewport is HIDDEN, not unmounted.
        // Every slot with panels renders on every pass; drill-in only decides
        // which containers carry `hidden`. Unmounting instead would throw away
        // each draft and scroll position behind the drill-in and fire
        // onPanelClosed for panels nobody closed — exactly the two lies the
        // stable-panel-key contract exists to prevent.
        hidden={extra?.forceHidden ?? !visible.includes(slot)}
        onPanelClosed={props.onPanelClosed}
      />
    );
  };

  return (
    <WorkspaceProvider api={api}>
      <div
        className={["av-workspace", props.className].filter(Boolean).join(" ")}
        data-av-narrow={state.narrow ? "1" : undefined}
        data-av-drill={state.drilledIn ? "1" : undefined}
      >
        {state.drilledIn ? (
          <AvButton className="av-drill-back" data-av-back onClick={api.back}>
            ← {props.backLabel ?? "返回"}
          </AvButton>
        ) : null}
        {/*
          Three of the five slots share a row and two are not. Putting all five
          in one flex row and asking CSS to wrap the last two produces a layout
          where the wrapped line claims half the height — so the structure says
          it instead: the columns share a row, and `bottom`/`overlay` are
          siblings of that row rather than members of it.
        */}
        <div className="av-columns">
          {renderSlot("navigation")}
          <MainRegion state={state} renderSlot={renderSlot} secondaryOccupied={secondaryOccupied} />
        </div>
        {WORKSPACE_SLOTS.filter((slot) => !COLUMN_SLOTS.includes(slot)).map((slot) => renderSlot(slot))}
        <WorkspaceCloseConfirmation state={state} api={api} />
      </div>
    </WorkspaceProvider>
  );
}

/** One dirty-close negotiation shared by every presentation adapter. */
export function WorkspaceCloseConfirmation({
  state,
  api,
}: {
  state: LayoutState;
  api: WorkspaceApi;
}) {
  const panelId = state.closePendingPanelId ?? null;
  const panel = panelId ? state.panels.find((row) => row.panelId === panelId) : undefined;
  useEffect(() => {
    if (panel) {
      document.querySelector<HTMLButtonElement>("[data-av-close-cancel]")?.focus();
    }
  }, [panel]);
  if (!panel || !panelId) return null;
  const titleId = `av-close-title-${panelId}`;
  return (
    <div
      className="av-close-shade"
      role="presentation"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          api.cancelClose?.(panelId);
        }
      }}
    >
      <div
        className="av-close-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={`${titleId}-description`}
      >
        <strong id={titleId}>要放弃“{panel.label}”的本地草稿并关闭吗？</strong>
        <p id={`${titleId}-description`}>
          这只会丢弃当前 View 的本地草稿，关闭后无法恢复；不会撤销已经提交到可信审批栏的操作。
        </p>
        <div className="av-close-actions">
          <AvButton data-av-close-cancel onClick={() => api.cancelClose?.(panelId)}>取消</AvButton>
          <AvButton className="av-close-discard" onClick={() => api.discardAndClose?.(panelId)}>
            放弃本地草稿并关闭
          </AvButton>
        </div>
      </div>
    </div>
  );
}

/**
 * The primary/secondary region.
 *
 * The divider is a SIBLING of the two slots (that is how `SplitHandle` works —
 * it resizes an adjacent flex sibling by writing a pixel width). It is present
 * in the DOM iff BOTH sides have panels AND secondary has a bound resource:
 * an empty declared surface must not carry a divider nobody can act on, and a
 * plan with only one side of the split does not need one either.
 *
 * Narrow: the divider is out (the reducer's `visibleSlots` already answers
 * "which stack layer is on top" and a splitter between them makes no sense on
 * a phone). The slots still render — hidden via the `hidden` attribute so
 * their drafts and scroll survive the drill-in — but they no longer share a
 * row of pixels to divide.
 */
function MainRegion({
  state,
  renderSlot,
  secondaryOccupied,
}: {
  state: LayoutState;
  renderSlot: (slot: WorkspaceSlot, extra?: { forceHidden?: boolean }) => ReactNode;
  secondaryOccupied: boolean;
}) {
  const primaryPanels = panelsIn(state, "primary");
  const secondaryPanels = panelsIn(state, "secondary");
  const hasPrimary = primaryPanels.length > 0;
  const hasSecondaryPanels = secondaryPanels.length > 0;

  // Nothing lives here at all: fall through so the outer flex row simply lacks
  // this region. Any bottom/overlay slot the composition supplied still paints
  // because they are the columns row's siblings, not its children.
  if (!hasPrimary && !hasSecondaryPanels) return null;

  const dividerVisible = !state.narrow && hasPrimary && hasSecondaryPanels && secondaryOccupied;

  return (
    <div className="av-main-region">
      {renderSlot("primary")}
      {dividerVisible ? (
        <SplitHandle
          axis="x"
          // The handle sits BEFORE secondary and resizes it by pixel width.
          // Primary stays `flex: 1` and fills whatever is left, so the first
          // render — before anybody drags — is a symmetric two-column layout
          // the flex row alone produces.
          target="next"
          storageKey={SPLIT_STORAGE_KEY}
          min={MIN_SECONDARY_PX}
          max={MAX_SECONDARY_PX}
          title="拖动调整分栏宽度，双击恢复；方向键微调，按住 Shift 步进更大"
        />
      ) : null}
      {hasSecondaryPanels
        ? renderSlot(
            "secondary",
            // `forceHidden` is a one-way override: pass it only when we mean to
            // hide a slot that `visibleSlots(state)` would otherwise paint. The
            // renderer uses `??`, which does NOT fold on `false` — an explicit
            // `forceHidden: false` would force-unhide a slot the narrow drill-in
            // wants hidden, exactly the bug 2d323a2's "hide, never unmount" test
            // guards against. Only the wide-mode "secondary declared but has no
            // resource yet" case ever needs the override; everywhere else the
            // visibleSlots decision stands.
            //
            // And that case only exists to cede the row to PRIMARY: hiding an
            // empty declared viewer is what stops it stealing half the region
            // from the chat beside it. A composition whose main region holds
            // ONLY secondary has nobody to cede to — hiding its standing
            // surface would blank the whole region — so the standing panel
            // paints, exactly as it did before 1d0b312 collapsed the
            // wide-only `!hasPrimary` branch into this expression.
            !state.narrow && hasPrimary && !secondaryOccupied ? { forceHidden: true } : undefined,
          )
        : null}
    </div>
  );
}

function SlotRegion({
  slot,
  panels,
  active,
  plan,
  api,
  chrome,
  hidden,
  onPanelClosed,
}: {
  slot: WorkspaceSlot;
  panels: readonly LayoutPanel[];
  active: string | null;
  plan: WorkspacePlan;
  api: WorkspaceApi;
  chrome?: SlotChrome;
  hidden: boolean;
  onPanelClosed?(panel: LayoutPanel): void;
}) {
  const documentSlot = isDocumentSlot(slot);
  // Only BOUND document panels earn a tab. An unbound declared surface (e.g.
  // an empty standing viewer) still lives here — it stays mounted so its
  // subtree survives — but it has nothing for a tab to identify, and pairing
  // one real resource with an empty template must not produce a two-tab
  // strip. The threshold is therefore "more than one bound document panel",
  // not "more than one panel of any kind".
  const boundDocumentPanels = documentSlot
    ? panels.filter((panel) => panel.resourceRef !== null)
    : [];
  const showTabs = documentSlot && boundDocumentPanels.length > 1;

  // The reducer keeps document panels MRU-ordered so a close can fall back to
  // the panel the reader actually came from. A tab strip must NOT inherit that
  // order: `focusIn` re-sorts on every focus, so activating a tab would MOVE
  // it to the end of the strip — reshuffling the row under the pointer, and
  // breaking both the reader's spatial memory and the WAI-ARIA expectation
  // that Left/Right/Home/End walk a stable sequence. Tabs therefore paint in
  // CREATION order, which is derivable without a second copy of state:
  // declared instances all exist from plan time in composition order, and a
  // minted panel id carries the monotonic sequence `nextPanelIdentity` gave
  // it. Presentation-only, like `presentationActive` below.
  const tabPanels = showTabs
    ? [...boundDocumentPanels].sort(
        (a, b) => creationRank(plan, a.panelId) - creationRank(plan, b.panelId),
      )
    : boundDocumentPanels;

  // ── presentationActive: one truth for the tab, the body and the pending
  // reducer sync ─────────────────────────────────────────────────────────────
  //
  // For document slots the reducer's `active` may name an unbound standing
  // panel — either because the composition initially focused one, or because
  // a module dispatched `focus` onto it. If we drove the tablist from `active`
  // and the panel body from `active` independently, we would end up saying
  // "this tab is selected" while its panel is hidden — an ARIA lie whose only
  // fix on the module's side would be to know a private tab-strip rule. So
  // this is computed ONCE per render and drives both.
  //
  // The tie-break is the MRU bound candidate (last in `panels`, because the
  // reducer's `focusIn` keeps document-slot panels MRU-ordered). Without any
  // bound panel there is nothing to promote and the reducer's `active` is
  // used verbatim — that keeps a single standing surface visible in the
  // ordinary "nothing opened yet" state.
  const activeInBound = documentSlot
    && boundDocumentPanels.some((panel) => panel.panelId === active);
  const presentationActive: string | null = documentSlot
    ? activeInBound
      ? active
      : boundDocumentPanels[boundDocumentPanels.length - 1]?.panelId ?? active
    : active;

  // Sync the reducer to the presentation BEFORE paint, so a subsequent close
  // fallback sees the same active the user does. `useLayoutEffect` runs after
  // the commit and before the browser paints; React re-renders synchronously
  // in the same cycle when the dispatched state changes. Anything that reads
  // `active` next therefore sees the value the tabs already show.
  useLayoutEffect(() => {
    if (documentSlot && presentationActive && presentationActive !== active) {
      api.focus(presentationActive);
    }
  }, [documentSlot, presentationActive, active, api]);

  // Focus handoff on close lives HERE and not in TabList because 2 → 1 makes
  // the TabList unmount entirely: a wantFocus flag inside it would never get
  // its effect fired. The SlotRegion outlives that transition, so it observes
  // "focus was inside my subtree when close was requested" and hands DOM
  // focus to the survivor after render — the new active tab if the strip is
  // still there, or the active panel body if the strip is gone.
  const containerRef = useRef<HTMLDivElement>(null);
  const wantHandoff = useRef(false);
  const requestClose = useCallback(
    (panelId: string): void => {
      const container = containerRef.current;
      const focused = document.activeElement;
      wantHandoff.current = !!(
        container
        && focused instanceof HTMLElement
        && container.contains(focused)
      );
      api.close(panelId);
    },
    [api],
  );

  useLayoutEffect(() => {
    if (!wantHandoff.current) return;
    wantHandoff.current = false;
    handoffFocus(containerRef.current, presentationActive);
  }, [presentationActive, panels]);

  return (
    <>
      <div
        ref={containerRef}
        className={["av-slot", chrome?.className].filter(Boolean).join(" ")}
        data-av-slot={slot}
        data-av-tabs={showTabs ? "1" : undefined}
        hidden={hidden || undefined}
      >
        {showTabs ? (
          <TabList
            slot={slot}
            panels={tabPanels}
            active={presentationActive}
            api={api}
            onRequestClose={requestClose}
            label={chrome?.tabsLabel ?? DEFAULT_TABS_LABEL}
          />
        ) : null}
        <div className="av-slot-body">
          {panels.map((panel) => (
            <WorkspacePanel
              key={panel.panelId}
              panel={panel}
              plan={plan}
              api={api}
              // Navigation and bottom are flow regions: several standing widgets
              // may paint together. Primary, secondary and overlay are document
              // regions: exactly the presentation-active panel paints, while
              // inactive panels stay mounted so drafts and scroll survive.
              hidden={documentSlot
                ? presentationActive !== panel.panelId
                : panel.resourceRef !== null && active !== panel.panelId}
              tabbed={showTabs && panel.resourceRef !== null}
              onPanelClosed={onPanelClosed}
            />
          ))}
        </div>
      </div>
      {hidden ? null : chrome?.divider ?? null}
    </>
  );
}

/**
 * Move DOM focus to the surviving surface after a close.
 *
 * Prefer the tab (still-mounted tablist): a tablist that lost one of three
 * tabs still owns the focus sequence. When the strip is gone entirely (2 → 1
 * bound), fall back to the active panel body — it carries `tabIndex={-1}` so
 * programmatic focus works without joining the tab sequence.
 */
function handoffFocus(container: HTMLElement | null, target: string | null): void {
  if (!container || !target) return;
  const tab = container.querySelector<HTMLButtonElement>(
    `[role="tablist"] [data-av-tab="${cssEscape(target)}"]`,
  );
  if (tab) {
    tab.focus();
    return;
  }
  const panel = container.querySelector<HTMLElement>(
    `.av-slot-body > [data-av-panel="${cssEscape(target)}"]`,
  );
  panel?.focus();
}

/**
 * WAI-ARIA tab list for stacked BOUND document panels.
 *
 * The caller passes `active` already reconciled with the bound-only panel set
 * (`SlotRegion.presentationActive`), so this component just paints. The
 * roving-tabindex invariant "exactly one tab in the sequence" holds because
 * `presentationActive` is guaranteed to be one of `panels`. Unbound standing
 * surfaces are filtered out by the caller and never appear as tabs — a tab
 * with nothing to identify is a lie about what the strip represents.
 *
 * Close is a callback into the caller (`onRequestClose`) because 2 → 1
 * unmounts the whole tablist; a wantFocus flag INSIDE it would never get its
 * cleanup effect fired. `SlotRegion` outlives the transition and hands DOM
 * focus to the survivor.
 *
 * The rule sheet: `role="tab"` buttons share a `role="tablist"` container;
 * every tab points at its `role="tabpanel"` body via `aria-controls`; only
 * the active tab is `aria-selected` and `tabindex=0`; Left/Right/Home/End
 * move focus among tabs; Enter and Space activate the focused tab (MANUAL
 * activation, so a keyboard user does not swap heavy content by accident on
 * the way to a specific tab); Delete and Backspace close it.
 *
 * The visible close affordance is an inline `<span aria-hidden="true">×</span>`:
 * a focusable close INSIDE the tab breaks ARIA (a tab may not contain another
 * interactive element), and one outside the tablist would add a second focus
 * stop between every pair of tabs. Screen reader users close a tab with Delete
 * on the focused tab; sighted mouse users click the ×.
 */
function TabList({
  slot,
  panels,
  active,
  api,
  onRequestClose,
  label,
}: {
  slot: WorkspaceSlot;
  panels: readonly LayoutPanel[];
  active: string | null;
  api: WorkspaceApi;
  onRequestClose(panelId: string): void;
  /**
   * Accessible name for the region — used verbatim as `aria-label`. Comes from
   * `SlotChrome.tabsLabel` when the App supplies one, from a SDK default
   * otherwise. Deliberately NOT constructed from tab contents: the tablist
   * identifies a slot, not the labels of whichever documents happen to be
   * open, and a name that rebuilt on every open/close would make screen
   * readers re-announce the region for changes it did not touch.
   */
  label: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  const focusButton = useCallback((panelId: string): void => {
    const container = containerRef.current;
    if (!container) return;
    const button = container.querySelector<HTMLButtonElement>(`[data-av-tab="${cssEscape(panelId)}"]`);
    button?.focus();
  }, []);

  const orderedIndex = useCallback(
    (panelId: string): number => panels.findIndex((panel) => panel.panelId === panelId),
    [panels],
  );

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>, panelId: string): void => {
    const key = event.key;
    if (key === "ArrowLeft" || key === "ArrowRight") {
      event.preventDefault();
      const index = orderedIndex(panelId);
      const step = key === "ArrowLeft" ? -1 : 1;
      const next = panels[(index + step + panels.length) % panels.length];
      if (next) focusButton(next.panelId);
      return;
    }
    if (key === "Home") {
      event.preventDefault();
      const first = panels[0];
      if (first) focusButton(first.panelId);
      return;
    }
    if (key === "End") {
      event.preventDefault();
      const last = panels[panels.length - 1];
      if (last) focusButton(last.panelId);
      return;
    }
    if (key === "Enter" || key === " ") {
      event.preventDefault();
      api.focus(panelId);
      return;
    }
    if (key === "Delete" || key === "Backspace") {
      event.preventDefault();
      onRequestClose(panelId);
      return;
    }
  };

  const onClickTab = (event: ReactMouseEvent<HTMLElement>, panelId: string): void => {
    // The close × is a `<span>` inside the tab; a click that started there
    // bubbles here, but the close handler ran first and dispatched. Guard by
    // consulting the target so a tab click does not both close and activate.
    if ((event.target as HTMLElement).closest("[data-av-tab-close]")) return;
    api.focus(panelId);
  };

  const onClickClose = (event: ReactMouseEvent<HTMLElement>, panelId: string): void => {
    event.stopPropagation();
    onRequestClose(panelId);
  };

  return (
    <div
      ref={containerRef}
      className="av-tablist"
      role="tablist"
      aria-orientation="horizontal"
      aria-label={label}
      data-av-slot={slot}
    >
      {panels.map((panel) => {
        const isActive = panel.panelId === active;
        const tabId = tabDomId(slot, panel.panelId);
        const bodyId = tabPanelDomId(slot, panel.panelId);
        return (
          <AvButton
            key={panel.panelId}
            role="tab"
            id={tabId}
            data-av-tab={panel.panelId}
            data-av-tab-active={isActive ? "1" : undefined}
            data-av-dirty={panel.dirty ? "1" : undefined}
            aria-selected={isActive}
            aria-label={panel.dirty ? `${panel.label}，未保存` : panel.label}
            aria-controls={bodyId}
            tabIndex={isActive ? 0 : -1}
            className={["av-tab", isActive ? "active" : ""].filter(Boolean).join(" ")}
            onClick={(event) => onClickTab(event, panel.panelId)}
            onKeyDown={(event) => onKeyDown(event, panel.panelId)}
            title={panel.label}
          >
            {panel.dirty ? <span className="av-tab-dirty" aria-hidden="true">●</span> : null}
            <span className="av-tab-label">{panel.label}</span>
            <span
              className="av-tab-close"
              data-av-tab-close
              aria-hidden="true"
              onClick={(event) => onClickClose(event, panel.panelId)}
            >
              ×
            </span>
          </AvButton>
        );
      })}
    </div>
  );
}

export interface WorkspacePanelProps {
  panel: LayoutPanel;
  plan: WorkspacePlan;
  api: WorkspaceApi;
  hidden: boolean;
  tabbed: boolean;
  onPanelClosed?(panel: LayoutPanel): void;
}

/**
 * Shared module boundary used by both shells.
 *
 * Keeping this renderer in one place is what makes local error containment and
 * the real-unmount close notification independent of the chosen presentation
 * engine. A docking move may re-parent the engine's container, but it must keep
 * this React subtree mounted under the same stable `panelId`.
 */
export function WorkspacePanel({
  panel,
  plan,
  api,
  hidden,
  tabbed,
  onPanelClosed,
}: WorkspacePanelProps) {
  // The close notification. Keep the latest values in a ref so ordinary panel
  // updates (focus, a denial, a new label) do not run an effect cleanup and lie
  // that the panel closed. The generation also filters React StrictMode's
  // development-only setup -> cleanup -> setup probe: the replacement setup
  // advances it before the queued notice runs, while a real unmount does not.
  const closeNotice = useRef({ panel, onPanelClosed });
  const closeGeneration = useRef(0);
  closeNotice.current = { panel, onPanelClosed };
  useEffect(() => {
    const generation = ++closeGeneration.current;
    return () => queueMicrotask(() => {
      if (closeGeneration.current === generation) {
        closeNotice.current.onPanelClosed?.(closeNotice.current.panel);
      }
    });
  }, []);

  const entry = plan.registry.get(panel.moduleId);
  const Component = entry?.component;
  const unavailable = panel.status === "unavailable" || !Component;
  const domProps = tabbed
    ? {
        role: "tabpanel",
        id: tabPanelDomId(panel.slot, panel.panelId),
        "aria-labelledby": tabDomId(panel.slot, panel.panelId),
      }
    : {};
  return (
    <div
      className="av-panel"
      data-av-panel={panel.panelId}
      data-av-module={panel.moduleId}
      data-av-status={unavailable ? "unavailable" : "ready"}
      hidden={hidden || undefined}
      // Programmatically focusable but not in the tab sequence: the SlotRegion
      // uses this when the tab strip disappears (2 → 1 bound close) to place
      // focus on the surviving panel body without inventing a keyboard trap.
      tabIndex={-1}
      {...domProps}
    >
      {unavailable ? (
        <div className="av-panel-unavailable" role="note">
          <strong>{panel.label}</strong>
          <span>
            {" · "}
            {LAYOUT_REASON_TEXT[panel.reason || "unavailable"] ?? LAYOUT_REASON_TEXT.unavailable}
          </span>
          {panel.detail ? <div className="av-panel-detail">{panel.detail}</div> : null}
        </div>
      ) : (
        <AgentViewErrorBoundary>
          <Component panel={panel} workspace={api} />
        </AgentViewErrorBoundary>
      )}
    </div>
  );
}

/**
 * Where a panel sits in creation order.
 *
 * Declared instances come first, in composition order — `initialLayout` mints
 * them all before any runtime panel exists. Minted panels follow, by the
 * monotonic sequence embedded in the `panel-N` id `nextPanelIdentity` gave
 * them (that function skips any id a composition instance already holds, so a
 * non-declared id always matches the pattern). Array position cannot answer
 * this: the reducer keeps document slots MRU-sorted for the close fallback.
 */
function creationRank(plan: WorkspacePlan, panelId: string): number {
  const declared = plan.composition.instances.findIndex((row) => row.instance === panelId);
  if (declared >= 0) return declared;
  const minted = /^panel-(\d+)$/.exec(panelId);
  return plan.composition.instances.length + (minted ? Number(minted[1]) : Number.MAX_SAFE_INTEGER);
}

function tabDomId(slot: WorkspaceSlot, panelId: string): string {
  return `av-tab-${slot}-${panelId}`;
}

function tabPanelDomId(slot: WorkspaceSlot, panelId: string): string {
  return `av-tabpanel-${slot}-${panelId}`;
}

/**
 * A small subset of CSS.escape adequate for panel ids we ourselves mint. The
 * runtime `panel-N` and declared instance ids come from the composition, which
 * is validated at plan time to be simple identifiers.
 */
function cssEscape(value: string): string {
  return value.replace(/(["\\])/g, "\\$1");
}
