/**
 * The LayoutCoordinator: the only thing that changes layout state.
 *
 * ── The rule, and why it is a reducer ───────────────────────────────────────
 *
 * Modules never touch layout. They raise versioned intents — `open-resource/v1`,
 * focus, close — and this function answers them. The alternative is two modules
 * moving the same panel from two effects, which is the class of bug no amount of
 * care in either module can remove.
 *
 * A reducer also makes the product semantics testable without a browser, and
 * those semantics are the actual content of this file:
 *
 *  · **`moduleId + resourceKind + resourceRef` is identity.** Opening the same resource twice
 *    focuses what is already there. A second instance exists only when somebody
 *    explicitly asked for `mode: "new"` — which is also why panel ids are
 *    minted here and never derived from the resource: two panels showing one
 *    resource are two different things with two different drafts.
 *  · **Panel id is a stable React key.** Composition instances keep the id the
 *    composition gave them, for the life of the document. A reader's half-typed
 *    message survives every projection update because the subtree is never
 *    re-created — and it is deliberately NOT preserved across a close, because
 *    closing is how a person says they are done.
 *  · **Every refusal is panel-local.** A module that is not registered, a
 *    resource kind with no declared viewer, a slot the module does not accept, a
 *    read the Host denied — each becomes ONE panel in an `unavailable` state
 *    with a reason code. None of them is an exception, and none of them can
 *    empty the shell.
 *  · **Narrow screens drill in, they do not shrink.** `secondary` becomes a
 *    stack over `primary` with a way back, rather than the same pixels squeezed.
 *  · **A narrow viewport holds ONE document per family.** Opening a second
 *    resource rebinds the family's panel instead of deriving a sibling, so a
 *    phone never grows a tab strip it has no room to show (ticket #189).
 */

import {
  DEFAULT_OPEN_SLOT,
  WORKSPACE_SLOTS,
  linkComposition,
  linkResourceBindings,
  moduleAcceptsSlot,
  moduleOpensKind,
  planTemplates,
  type AgentComposition,
  type AgentModuleLock,
  type AgentModuleManifest,
  type CompositionOpenRule,
  type InstanceConfig,
  type IntentContext,
  type OpenMode,
  type OpenResourceIntent,
  type ResourceBindingPlan,
  type ResourceLink,
  type WorkspaceSlot,
} from "@claude-bot/agent-module-contract";
import type { ModuleRegistry } from "./registry.js";

/** Why a panel cannot show what it was opened for. Machine-readable on purpose. */
export type LayoutReason =
  | ""
  | "module_not_registered"
  | "no_viewer"
  | "slot_refused"
  | "denied"
  | "unavailable";

export interface LayoutPanel {
  /** Stable React key. Composition instances keep the id they were given. */
  panelId: string;
  /** The v2 template prototype whose connection family this panel inherits. */
  templatePrototypeId?: string;
  moduleId: string;
  slot: WorkspaceSlot;
  /** The opaque ref this instance was opened for; `null` for a standing panel. */
  resourceRef: string | null;
  resourceKind: string | null;
  /** Presentation only. */
  label: string;
  status: "ready" | "unavailable";
  reason: LayoutReason;
  /** A module's own bounded note for an `unavailable` state. */
  detail: string;
  /**
   * The composition instance's declared config values (decision 7). Set once
   * from the composition. Ordinary minted `panel-N` panels have none; panels
   * derived from a v2 template inherit its prototype's config.
   */
  config: InstanceConfig | null;
  /**
   * The LAST open intent's context ("jump to line 120"). Deliberately not part
   * of reuse identity: reopening the same resource with a new context focuses
   * the same panel and REPLACES this field, so a consumer treats it as "the
   * most recent instruction", not an accumulating history.
   */
  context: IntentContext | null;
  /**
   * Unsaved local work owned by this mounted panel. Presentation adapters may
   * decorate it, but only the coordinator may turn a close request into an
   * actual unmount. Optional for source compatibility with hand-built harness
   * panels; absence means clean.
   */
  dirty?: boolean;
}

export type SlotMap = Readonly<Record<WorkspaceSlot, string | null>>;

export interface LayoutState {
  panels: readonly LayoutPanel[];
  /** The panel on top in each slot. */
  active: SlotMap;
  focused: string | null;
  narrow: boolean;
  /** Narrow only: `secondary` is covering `primary`, and there is a way back. */
  drilledIn: boolean;
  /** Monotonic, so minted panel ids are deterministic and testable. */
  seq: number;
  /**
   * A close request blocked by an unsaved draft. This is semantic lifecycle
   * state, not Dockview/window state. Optional for historical hand-built test
   * states; absence means no pending request.
   */
  closePendingPanelId?: string | null;
}

export type LayoutAction =
  | { type: "open"; intent: OpenResourceIntent }
  | { type: "focus"; panelId: string }
  | { type: "close"; panelId: string }
  | { type: "set-dirty"; panelId: string; dirty: boolean }
  | { type: "discard-close"; panelId: string }
  | { type: "cancel-close"; panelId: string }
  | { type: "report"; panelId: string; reason: LayoutReason; detail?: string }
  | { type: "viewport"; narrow: boolean }
  | { type: "back" };

/** A validated composition plus the registry that can actually mount it. */
export interface WorkspacePlan {
  composition: AgentComposition;
  lock: AgentModuleLock;
  registry: ModuleRegistry;
  /**
   * Composition instance ids the App's resource binding plan wires to a typed
   * port — its CONNECTED surfaces.
   *
   * Empty when the App declares no plan, which is the whole of the rollback
   * story: with nothing connected, every rule below reduces to the behaviour
   * this reducer had before resource bindings existed.
   */
  connectedInstances: ReadonlySet<string>;
  /** The bounded v2 panel families, projected down to layout-owned facts. */
  templateFamilies: readonly WorkspaceTemplateFamily[];
}

/** Runtime facts needed to derive one bounded family of connected panels. */
export interface WorkspaceTemplateFamily {
  prototypeId: string;
  moduleId: string;
  slot: WorkspaceSlot;
  /** Total live panels in this family, including the standing prototype. */
  maxInstances: number;
}

/**
 * Bind a composition to a registry, and to the App's binding plan if it has one.
 *
 * The lock comes from the registry rather than from the caller: the registry IS
 * the bundle, so a lock derived from it cannot claim a module that is not there.
 * A composition that references something outside it throws here — this runs
 * once at startup, in code this build compiled, and a workspace whose plan does
 * not link is not a degraded workspace, it is a broken build.
 *
 * The binding plan is linked here too, against the same manifests, so "this
 * instance is wired to a port it never declared" is a broken build rather than a
 * panel that silently has no data.
 */
export function createWorkspacePlan(input: {
  composition: AgentComposition;
  registry: ModuleRegistry;
  /** The App's resource binding plan, when it ships one. */
  bindings?: ResourceBindingPlan;
}): WorkspacePlan {
  const lock = input.registry.lock();
  const linked = linkComposition(input.composition, lock, input.registry.manifests());
  if (!linked.ok) {
    const first = linked.issues[0];
    throw new Error(`workspace plan: ${first?.at ?? "composition"}: ${first?.message ?? "does not link"}`);
  }
  // Document slots may hold MORE THAN ONE standing instance since 2026-08-10.
  // The refusal that used to live here was written when the shell had no way
  // to choose between two standing documents in one column; the stacked-
  // document tab strip is that affordance now — every BOUND panel in a
  // document slot earns a tab, and `fallbackPanelId` keeps one active. What
  // the shell still does NOT do is give an UNBOUND standing panel beyond the
  // first any tab to reach it: such a panel is invisible until something is
  // opened into it, which is exactly the arrangement a composition wants when
  // it stands a second exclusive surface (Session Plus's document panel
  // beside its file viewer) — an empty placeholder that costs nothing and
  // shows nothing until the rail opens a document into it. A standing
  // instance is expected to be idle while unbound; that is a module-contract
  // expectation the modules in this repository already meet (an unbound panel
  // makes no capability calls), not something a plan can check.
  const connected = new Set<string>();
  const templateFamilies: WorkspaceTemplateFamily[] = [];
  if (input.bindings) {
    const wired = linkResourceBindings(input.bindings, linked.value.composition, input.registry.manifests());
    if (!wired.ok) {
      const first = wired.issues[0];
      throw new Error(`workspace plan: ${first?.at ?? "bindings"}: ${first?.message ?? "does not link"}`);
    }
    for (const row of input.bindings.connections) connected.add(row.instance);
    const templates = planTemplates(input.bindings);
    if (templates.length) {
      for (const template of templates) {
        // The binding linker above guarantees the prototype exists and sits on
        // an open route. Project only the facts the layout runtime owns; the
        // full connection family remains in the trusted release document.
        const prototype = linked.value.composition.instances.find(
          (instance) => instance.instance === template.instance,
        )!;
        templateFamilies.push(Object.freeze({
          prototypeId: template.instance,
          moduleId: prototype.module,
          slot: prototype.slot,
          maxInstances: template.maxInstances,
        }));
      }
    } else {
      // v1 has no template that could distinguish multiple connected surfaces.
      // Keep its pre-v2 runtime invariant and error text intact.
      const openableModules = new Set(linked.value.composition.open.map((rule) => rule.module));
      for (const moduleId of openableModules) {
        const connectedSurfaces = linked.value.composition.instances.filter(
          (instance) => instance.module === moduleId && connected.has(instance.instance),
        );
        if (connectedSurfaces.length > 1) {
          throw new Error(
            `workspace plan: bindings: ${moduleId} has more than one connected open surface; v1 cannot select an instance`,
          );
        }
      }
    }
  }
  return {
    composition: linked.value.composition,
    lock,
    registry: input.registry,
    connectedInstances: connected,
    templateFamilies: Object.freeze(templateFamilies),
  };
}

const EMPTY_SLOTS: SlotMap = Object.freeze({
  navigation: null,
  primary: null,
  secondary: null,
  bottom: null,
  overlay: null,
});

/**
 * The workspace as the composition describes it, before anything is opened.
 *
 * A declared instance whose module is missing from the registry becomes an
 * `unavailable` panel rather than being dropped: a composition that lists five
 * surfaces and silently renders four is the failure this state exists to make
 * visible.
 */
export function initialLayout(plan: WorkspacePlan, options: { narrow?: boolean } = {}): LayoutState {
  const panels: LayoutPanel[] = plan.composition.instances.map((instance) => {
    const entry = plan.registry.get(instance.module);
    const template = plan.templateFamilies.find((family) => family.prototypeId === instance.instance);
    return {
      panelId: instance.instance,
      ...(template ? { templatePrototypeId: template.prototypeId } : {}),
      moduleId: instance.module,
      slot: instance.slot,
      resourceRef: null,
      resourceKind: null,
      label: instance.title ?? entry?.manifest.title ?? instance.module,
      status: entry ? "ready" : "unavailable",
      reason: entry ? "" : "module_not_registered",
      detail: "",
      config: instance.config ?? null,
      context: null,
      dirty: false,
    };
  });
  const active: Record<WorkspaceSlot, string | null> = { ...EMPTY_SLOTS };
  for (const panel of panels) if (!active[panel.slot]) active[panel.slot] = panel.panelId;
  return {
    panels,
    active,
    focused: active.primary ?? panels[0]?.panelId ?? null,
    narrow: options.narrow ?? false,
    drilledIn: false,
    seq: 0,
    closePendingPanelId: null,
  };
}

interface Resolution {
  moduleId: string;
  slot: WorkspaceSlot;
  mode: OpenMode;
  reason: LayoutReason;
}

/**
 * One way this workspace can open one resource kind — a menu row, in data.
 *
 * It names a MODULE, not a panel: the panel that ends up showing the resource
 * may be a declared instance that is rebound, an already-open one that is
 * focused, or one minted here. So `title` is the manifest's, never a composition
 * instance's — an instance title describes a surface that may not exist yet, and
 * showing it in a chooser would promise which panel the click lands in.
 */
export interface OpenCandidate {
  moduleId: string;
  /** Manifest title. Presentation only. */
  title: string;
  /** Where the composition's rule puts it. An intent may still override. */
  slot: WorkspaceSlot;
  /** The composition's default for this pair; an intent may still say `new`. */
  mode: OpenMode;
}

/** An open rule paired with the implementation the registry actually holds. */
interface RoutedRule {
  rule: CompositionOpenRule;
  /** `null` when this build's registry has no such module. */
  manifest: AgentModuleManifest | null;
}

/**
 * Every rule that mentions this kind, in composition order, resolved against the
 * registry — the ONE enumeration both the chooser and the reducer read.
 *
 * Two answers to "what can open this" is the defect this function exists to make
 * impossible: an "open with…" list built from one traversal and a `resolveOpen`
 * built from another drift into a menu offering a viewer the open path refuses.
 * Order is composition order, unsorted and unranked, because `rules[0]` is the
 * documented default policy — a chooser that sorts by title would silently
 * disagree with what a plain click does.
 *
 * Nothing here asks the Host, imports by string, or reads `mediaType`: the
 * candidates are decided by the immutable release alone.
 */
function routesFor(plan: WorkspacePlan, kind: string): RoutedRule[] {
  return plan.composition.open
    .filter((rule) => rule.resource === kind)
    .map((rule) => ({ rule, manifest: plan.registry.get(rule.module)?.manifest ?? null }));
}

/**
 * Can this route actually run?
 *
 * `createWorkspacePlan` already refuses a composition whose rule names an
 * unregistered module or one whose manifest does not declare the kind, so both
 * halves are defence in depth for hand-built plans. They are checked here rather
 * than assumed because this predicate is the single place the chooser and the
 * reducer agree, and an assumption held in two places is not shared.
 */
function routeIsUsable(row: RoutedRule, kind: string): boolean {
  return row.manifest !== null && moduleOpensKind(row.manifest, kind);
}

/**
 * The bounded, ordered set of modules this release can open a resource with.
 *
 * The query face of `resolveOpen`, for an "open with…" menu or a tab strip: same
 * enumeration, same order, same allow-list, no state. `[0]` is what an intent
 * naming no view resolves to, and an empty array means this composition declares
 * no viewer for that kind — which is exactly the `no_viewer` refusal, phrased as
 * a question instead of an answer.
 *
 * Only `kind` is read. `mediaType` deliberately is not: a `workspace-files/v1`
 * listing carries no reliable MIME, so routing on it would mean guessing a
 * viewer from a file name, and a wrong guess is a panel that cannot say why it
 * is empty. Bounded because a composition's `open` list is (64 rules).
 */
export function availableViews(
  plan: WorkspacePlan,
  resource: Pick<ResourceLink, "kind">,
): readonly OpenCandidate[] {
  const candidates = routesFor(plan, resource.kind)
    .filter((row) => routeIsUsable(row, resource.kind))
    .map((row) =>
      Object.freeze({
        moduleId: row.rule.module,
        title: row.manifest!.title,
        slot: row.rule.slot,
        mode: row.rule.mode ?? "reuse",
      }),
    );
  return Object.freeze(candidates);
}

/**
 * Which module shows this resource, and where.
 *
 * The composition's open rules are an ALLOW-LIST: a `view` hint that does not
 * match a rule is refused rather than looked up, because the point of routing
 * through a declaration is that a string in a projection cannot choose what runs.
 * `intent.view` and `resource.suggestedView` are read the same way — both are
 * strings that arrived from somewhere, and neither gets to name a module that no
 * rule already allows.
 */
function resolveOpen(plan: WorkspacePlan, intent: OpenResourceIntent): Resolution {
  const kind = intent.resource.kind;
  const routes = routesFor(plan, kind);
  const wanted = intent.view ?? intent.resource.suggestedView;
  const route = wanted ? routes.find((row) => row.rule.module === wanted) : routes[0];
  if (!route) {
    return {
      moduleId: wanted ?? "",
      slot: intent.slot ?? DEFAULT_OPEN_SLOT,
      mode: "reuse",
      reason: "no_viewer",
    };
  }
  const { rule, manifest } = route;
  if (!manifest) {
    return { moduleId: rule.module, slot: rule.slot, mode: "reuse", reason: "module_not_registered" };
  }
  // A rule the registry can serve but whose manifest never claimed this kind is
  // not a candidate above, so it must not be openable here either.
  if (!routeIsUsable(route, kind)) {
    return { moduleId: rule.module, slot: rule.slot, mode: "reuse", reason: "no_viewer" };
  }
  if (intent.slot && intent.slot !== rule.slot && !moduleAcceptsSlot(manifest, intent.slot)) {
    return { moduleId: rule.module, slot: rule.slot, mode: "reuse", reason: "slot_refused" };
  }
  return {
    moduleId: rule.module,
    slot: intent.slot ?? rule.slot,
    mode: intent.mode ?? rule.mode ?? "reuse",
    reason: "",
  };
}

function withActive(state: LayoutState, panels: readonly LayoutPanel[], focused: string | null): LayoutState {
  const active: Record<WorkspaceSlot, string | null> = { ...EMPTY_SLOTS };
  for (const slot of WORKSPACE_SLOTS) {
    const previous = state.active[slot];
    const stillThere = panels.some((panel) => panel.panelId === previous);
    active[slot] = stillThere ? previous : fallbackPanelId(panels, slot);
  }
  const focusedPanel = panels.some((panel) => panel.panelId === focused) ? focused : null;
  return { ...state, panels, active, focused: focusedPanel };
}

/** Most recent document in a slot, otherwise its first standing surface. */
function fallbackPanelId(panels: readonly LayoutPanel[], slot: WorkspaceSlot): string | null {
  const candidates = panels.filter((panel) => panel.slot === slot);
  const document = [...candidates].reverse().find((panel) => panel.resourceRef !== null);
  return document?.panelId ?? candidates.find((panel) => panel.resourceRef === null)?.panelId ?? null;
}

/** Slots whose standing surface is one document, not a flow of widgets. */
export function isDocumentSlot(slot: WorkspaceSlot): boolean {
  return slot === "primary" || slot === "secondary" || slot === "overlay";
}

/**
 * Whether a slot has anything worth painting right now.
 *
 * For a DOCUMENT slot (primary/secondary/overlay) that answer is derived from
 * layout state rather than the DOM: a standing declared instance whose
 * `resourceRef` is null contributes an EMPTY panel, and taking half the
 * workspace for an empty file viewer is the exact failure the ticket exists to
 * remove. So a document slot is "occupied" iff at least one panel in it has a
 * bound resource — either a runtime `panel-N` opened from an intent, or the
 * declared surface after it has been rebound. `resourceRef !== null` also
 * matches the "unavailable" panels minted from an unrouted intent, because those
 * carry the ref they refused: their loud one-line refusal is worth painting,
 * and rendering it in the slot rather than swallowing it silently is the whole
 * point of a panel-local reason.
 *
 * Flow slots (navigation/bottom) always show when they have any panels — one of
 * their standing surfaces might legitimately be a hint or a status strip with no
 * resource of its own.
 */
export function slotHasVisibleContent(state: LayoutState, slot: WorkspaceSlot): boolean {
  const panels = state.panels.filter((panel) => panel.slot === slot);
  if (!panels.length) return false;
  if (!isDocumentSlot(slot)) return true;
  return panels.some((panel) => panel.resourceRef !== null);
}

function focusIn(state: LayoutState, panel: LayoutPanel): LayoutState {
  const active = { ...state.active, [panel.slot]: panel.panelId };
  const drilledIn = state.narrow && panel.slot === "secondary" ? true : state.drilledIn;
  // Keep document panels in MRU order. `fallbackPanelId()` can then restore the
  // document the person actually came from when the top one closes, rather than
  // whichever panel happened to be created most recently. React keys remain
  // stable, so moving a keyed subtree does not erase its local draft/scroll.
  const panels = isDocumentSlot(panel.slot)
    ? [...state.panels.filter((row) => row.panelId !== panel.panelId), panel]
    : state.panels;
  return { ...state, panels, active, focused: panel.panelId, drilledIn };
}

/**
 * Pure preflight for `WorkspaceApi.open*` and the reducer.
 *
 * A connected v1 surface cannot truthfully mint a second instance because the
 * binding document has no template for it; a v2 family cannot derive beyond
 * its declared ceiling. These are semantically valid intents the layout refuses
 * without manufacturing a refusal panel, so callers need the same answer before
 * dispatch.
 */
export function acceptsOpenIntent(
  plan: WorkspacePlan,
  state: LayoutState,
  intent: OpenResourceIntent,
): boolean {
  const resolved = resolveOpen(plan, intent);
  const existing = resolved.mode === "reuse" && state.panels.some(
    (panel) =>
      panel.moduleId === resolved.moduleId
      && panel.resourceKind === intent.resource.kind
      && panel.resourceRef === intent.resource.ref,
  );
  if (existing) return true;

  // A phone reuses one panel per family, so the capacity questions below
  // simply do not arise there.
  if (narrowRebindTarget(plan, state, resolved)) return true;

  const family = templateFamilyFor(plan, resolved);
  if (family) {
    const prototype = state.panels.find((panel) => panel.panelId === family.prototypeId);
    if (!prototype) return false;
    if (
      resolved.mode === "rebind"
      && prototype.dirty
      && prototype.resourceRef !== intent.resource.ref
    ) return false;
    if (resolved.mode === "rebind") return true;
    if (resolved.mode !== "new" && prototype.resourceRef === null) return true;
    return panelsInTemplateFamily(state, family).length < family.maxInstances;
  }
  const connected = connectedSurface(plan, state, resolved);
  if (
    connected?.dirty
    && connected.resourceRef !== null
    && connected.resourceRef !== intent.resource.ref
  ) return false;
  if (resolved.mode === "new" && connected) return false;

  if (resolved.mode === "rebind") {
    const candidates = state.panels.filter(
      (panel) =>
        panel.moduleId === resolved.moduleId
        && panel.slot === resolved.slot
        && declaredInstance(plan, panel.panelId) !== undefined,
    );
    const target = candidates.find((panel) => panel.resourceRef === null) ?? candidates[0];
    if (target?.dirty && target.resourceRef !== intent.resource.ref) return false;
  }
  return true;
}

export function layoutReducer(plan: WorkspacePlan) {
  return function reduce(state: LayoutState, action: LayoutAction): LayoutState {
    switch (action.type) {
      case "open": {
        const { intent } = action;
        if (!acceptsOpenIntent(plan, state, intent)) return state;
        const resolved = resolveOpen(plan, intent);
        const existing = state.panels.find(
          (panel) =>
            panel.moduleId === resolved.moduleId
            && panel.resourceKind === intent.resource.kind
            && panel.resourceRef === intent.resource.ref,
        );
        // Failure panels obey the same reuse identity. Repeatedly clicking one
        // unavailable file should focus the explanation already on screen, not
        // manufacture an unbounded stack of identical refusals.
        //
        // Context is NOT identity: the same document at another line is the
        // same panel with a replaced instruction, so the reuse path refreshes
        // `context` before focusing.
        if (existing && resolved.mode === "reuse") {
          const refreshed = { ...existing, label: intent.resource.label, context: intent.context ?? null };
          const panels = state.panels.map((row) => (row.panelId === existing.panelId ? refreshed : row));
          return focusIn({ ...state, panels }, refreshed);
        }

        // ── A PHONE collapses the family to one document ────────────────────
        //
        // Before any of the desktop derivation rules: on a narrow viewport the
        // reader can only see one layer, so a second panel in a slot is a tab
        // they cannot reach. Rebinding the one that is already there is what
        // makes "tap a session, land in that session" true.
        const narrowTarget = narrowRebindTarget(plan, state, resolved);
        if (narrowTarget) {
          const rebound = {
            ...narrowTarget,
            ...boundTo(intent),
            status: "ready" as const,
            reason: "" as const,
            detail: "",
          };
          const panels = state.panels.map((panel) =>
            panel.panelId === narrowTarget.panelId ? rebound : panel,
          );
          return focusIn({ ...state, panels }, rebound);
        }

        // ── A v2 TEMPLATE is one bounded family of connected panels ─────────
        //
        // The standing prototype supplies the module, slot, config and trusted
        // connection family. Plain reuse binds it first, then derives a fresh
        // panel for each different resource. Explicit `new` always derives;
        // `rebind` always targets the prototype. Capacity was checked by the
        // shared preflight above, so reaching this branch never evicts a panel.
        const family = templateFamilyFor(plan, resolved);
        if (family) {
          const prototype = state.panels.find((panel) => panel.panelId === family.prototypeId);
          if (!prototype) return state;
          if (resolved.mode === "rebind" || (resolved.mode !== "new" && prototype.resourceRef === null)) {
            const rebound = {
              ...prototype,
              ...boundTo(intent),
              status: "ready" as const,
              reason: "" as const,
              detail: "",
            };
            const panels = state.panels.map((panel) =>
              panel.panelId === prototype.panelId ? rebound : panel,
            );
            return focusIn({ ...state, panels }, rebound);
          }
          const { panelId, seq } = nextPanelIdentity(state);
          const panel: LayoutPanel = {
            // Start from the prototype so the family carries layout-owned
            // metadata forward without this derivation path becoming a second
            // closed list of LayoutPanel fields. Resource-local state is
            // replaced below.
            ...prototype,
            panelId,
            ...boundTo(intent),
            status: "ready",
            reason: "",
            detail: "",
            // A new panel inherits connection/config metadata, never the
            // prototype's local draft lifecycle.
            dirty: false,
          };
          return focusIn({ ...state, seq, panels: [...state.panels, panel] }, panel);
        }

        // ── A CONNECTED surface is a single named panel, always ──────────────
        //
        // `agent-resource-bindings/v1` wires composition INSTANCES, by name. A
        // panel minted here would be anonymous — absent from the binding
        // document — and yet, because the App's provider sits above the whole
        // workspace, it would render as though it had a port. That is the one
        // shape this reducer must not produce: a surface that looks connected
        // and is not named by the document that decides what is connected.
        //
        // So a connected module gets its declared instance REBOUND, whatever it
        // was showing. Opening a second file replaces the first in that panel
        // rather than stacking beside it; the reader still gets "focus what is
        // already open" for the same file, which is the case that matters.
        //
        // v1 has no way to express a second connected instance — that needs a
        // template schema in the binding document — so `mode: "new"` on one is
        // REFUSED rather than silently downgraded to a reuse or silently
        // granted an unwired panel. `open()` returns false and the layout does
        // not move.
        const connected = connectedSurface(plan, state, resolved);
        if (connected) {
          const rebound = { ...connected, ...boundTo(intent), status: "ready" as const, reason: "" as const, detail: "" };
          const panels = state.panels.map((panel) => (panel.panelId === connected.panelId ? rebound : panel));
          return focusIn({ ...state, panels }, rebound);
        }

        // ── `mode: "rebind"`: a declared surface is THE panel for this kind ──
        //
        // The deck pressure test found (2026-08-07) that a configured declared
        // instance was only the open target ONCE: the standing path below
        // requires `resourceRef === null`, so every later open of a different
        // ref minted an anonymous `config: null` twin — an empty panel for any
        // config-driven module. The first fix rebound declared instances
        // unconditionally, and promptly broke the OTHER product shape: chat
        // keeps a panel per session so drafts survive switching. Stacking vs
        // rebinding is a per-kind product decision, so it lives where routing
        // policy already lives — the composition's open rule (`mode:
        // "rebind"`). Unbound instances win over bound ones; among bound ones
        // composition order decides, the `rules[0]` doctrine again.
        if (!resolved.reason && resolved.mode === "rebind") {
          const declared = state.panels.filter(
            (panel) =>
              panel.moduleId === resolved.moduleId
              && panel.slot === resolved.slot
              && declaredInstance(plan, panel.panelId) !== undefined,
          );
          const target = declared.find((panel) => panel.resourceRef === null) ?? declared[0];
          if (target) {
            const rebound = { ...target, ...boundTo(intent), status: "ready" as const, reason: "" as const, detail: "" };
            const panels = state.panels.map((panel) => (panel.panelId === target.panelId ? rebound : panel));
            return focusIn({ ...state, panels }, rebound);
          }
          // No declared surface to rebind — fall through to the standing/mint
          // path below with plain-reuse semantics.
        }

        if (!resolved.reason) {
          // A standing composition instance in that slot with no resource yet is
          // the panel this resource belongs in — reusing it is what keeps a
          // declared surface from being shadowed by a duplicate of itself.
          const standing = state.panels.find(
            (panel) =>
              panel.moduleId === resolved.moduleId && panel.slot === resolved.slot && panel.resourceRef === null,
          );
          if (standing && resolved.mode !== "new") {
            const rebound = {
              ...standing,
              ...boundTo(intent),
              status: "ready" as const,
              reason: "" as const,
              detail: "",
            };
            const panels = state.panels.map((panel) => panel.panelId === standing.panelId ? rebound : panel);
            return focusIn({ ...state, panels }, rebound);
          }
        }
        const { panelId, seq } = nextPanelIdentity(state);
        const panel: LayoutPanel = {
          panelId,
          moduleId: resolved.moduleId,
          slot: resolved.slot,
          ...boundTo(intent),
          status: resolved.reason ? "unavailable" : "ready",
          reason: resolved.reason,
          detail: "",
          config: null,
          dirty: false,
        };
        return focusIn({ ...state, seq, panels: [...state.panels, panel] }, panel);
      }
      case "focus": {
        const panel = state.panels.find((row) => row.panelId === action.panelId);
        return panel ? focusIn(state, panel) : state;
      }
      case "close": {
        const panel = state.panels.find((row) => row.panelId === action.panelId);
        if (!panel) return state;
        if (panel.dirty) {
          const focused = focusIn(state, panel);
          return focused.closePendingPanelId === panel.panelId
            ? focused
            : { ...focused, closePendingPanelId: panel.panelId };
        }
        return closePanel(plan, state, panel);
      }
      case "set-dirty": {
        const panel = state.panels.find((row) => row.panelId === action.panelId);
        if (!panel || Boolean(panel.dirty) === action.dirty) return state;
        const updated = { ...panel, dirty: action.dirty };
        const panels = state.panels.map((row) => row.panelId === panel.panelId ? updated : row);
        const next = { ...state, panels };
        // A save that finishes while close is waiting removes the only blocker;
        // honor the original close request instead of leaving a clean document
        // behind an obsolete discard prompt.
        return !action.dirty && state.closePendingPanelId === panel.panelId
          ? closePanel(plan, { ...next, closePendingPanelId: null }, updated)
          : next;
      }
      case "discard-close": {
        if (state.closePendingPanelId !== action.panelId) return state;
        const panel = state.panels.find((row) => row.panelId === action.panelId);
        return panel
          ? closePanel(plan, { ...state, closePendingPanelId: null }, panel)
          : { ...state, closePendingPanelId: null };
      }
      case "cancel-close": {
        return state.closePendingPanelId === action.panelId
          ? { ...state, closePendingPanelId: null }
          : state;
      }
      case "report": {
        const panels = state.panels.map((row) =>
          row.panelId === action.panelId
            ? {
                ...row,
                status: action.reason ? ("unavailable" as const) : ("ready" as const),
                reason: action.reason,
                detail: action.reason ? String(action.detail ?? "").slice(0, 200) : "",
              }
            : row,
        );
        return { ...state, panels };
      }
      case "viewport": {
        if (state.narrow === action.narrow) return state;
        return { ...state, narrow: action.narrow, drilledIn: false };
      }
      case "back":
        return state.drilledIn ? { ...state, drilledIn: false } : state;
      default:
        return state;
    }
  };
}

/** Mint a runtime id without colliding with legal composition instance ids. */
function nextPanelIdentity(state: LayoutState): { panelId: string; seq: number } {
  let seq = state.seq;
  let panelId: string;
  do {
    seq += 1;
    panelId = `panel-${seq}`;
  } while (state.panels.some((panel) => panel.panelId === panelId));
  return { panelId, seq };
}

/**
 * Perform a close after the dirty guard has allowed it.
 *
 * A composition instance is a declared surface, so closing clears it back to
 * its standing state. A runtime-derived panel is removed. Keeping this in one
 * helper ensures toolbar close, tab close and a docking adapter's close button
 * all have the same cleanup and focus semantics.
 */
function closePanel(plan: WorkspacePlan, state: LayoutState, panel: LayoutPanel): LayoutState {
  if (declaredInstance(plan, panel.panelId)) {
    if (panel.resourceRef === null) {
      return state.closePendingPanelId === panel.panelId
        ? { ...state, closePendingPanelId: null }
        : state;
    }
    const cleared = {
      ...panel,
      ...unbound(plan, panel),
      status: "ready" as const,
      reason: "" as const,
      detail: "",
      dirty: false,
    };
    const panels = state.panels.map((row) => row.panelId === panel.panelId ? cleared : row);
    return afterClose(
      { ...state, closePendingPanelId: state.closePendingPanelId === panel.panelId ? null : state.closePendingPanelId },
      panels,
      panel,
    );
  }
  const panels = state.panels.filter((row) => row.panelId !== panel.panelId);
  return afterClose(
    { ...state, closePendingPanelId: state.closePendingPanelId === panel.panelId ? null : state.closePendingPanelId },
    panels,
    panel,
  );
}

/** Preserve the previous document in a slot when its top panel closes. */
function afterClose(
  state: LayoutState,
  panels: readonly LayoutPanel[],
  closed: LayoutPanel,
): LayoutState {
  const wasActive = state.active[closed.slot] === closed.panelId;
  const seed = wasActive
    ? { ...state, active: { ...state.active, [closed.slot]: null } }
    : state;
  let next = withActive(seed, panels, state.focused === closed.panelId ? null : state.focused);
  if (wasActive && state.focused === closed.panelId) {
    next = { ...next, focused: next.active[closed.slot] };
  }
  if (wasActive && closed.slot === "secondary") {
    const fallback = panels.find((panel) => panel.panelId === next.active.secondary);
    next = { ...next, drilledIn: state.narrow && fallback?.resourceRef !== null && fallback !== undefined };
  }
  return next;
}

function boundTo(intent: OpenResourceIntent): Pick<LayoutPanel, "resourceRef" | "resourceKind" | "label" | "context"> {
  const { resource } = intent;
  return {
    resourceRef: resource.ref,
    resourceKind: resource.kind,
    label: resource.label,
    context: intent.context ?? null,
  };
}

/** The composition instance a panel id names, if it names one. */
function declaredInstance(plan: WorkspacePlan, panelId: string) {
  return plan.composition.instances.find((row) => row.instance === panelId);
}

/** A declared instance back in its standing, unbound state. */
function unbound(
  plan: WorkspacePlan,
  panel: LayoutPanel,
): Pick<LayoutPanel, "resourceRef" | "resourceKind" | "label" | "context"> {
  const declared = declaredInstance(plan, panel.panelId);
  const title = declared?.title ?? plan.registry.get(panel.moduleId)?.manifest.title ?? panel.moduleId;
  return { resourceRef: null, resourceKind: null, label: title, context: null };
}

/**
 * The one panel a narrow viewport reuses for this route, or null.
 *
 * ── Why this is a reducer rule and not a paint (ticket #189) ────────────────
 *
 * A phone shows ONE layer at a time, so every extra document in a slot becomes
 * a tab in the least reachable chrome a small screen has. Hiding those tabs
 * would leave the panels alive, subscribed and reachable by focus — a second
 * layout model quietly disagreeing with the first. So the coordinator collapses
 * the family instead: one agent, one file, and a tab strip that has nothing to
 * show rather than one that is hidden.
 *
 * Two things it deliberately will not do:
 *
 *  · it never touches an explicit `mode: "new"`, which asked for a second
 *    instance in so many words;
 *  · it never takes a panel with unsaved work. A dirty editor keeps its
 *    resource and the open falls through to the ordinary desktop path, because
 *    a viewport is not a reason to discard a draft.
 *
 * Preference order: the family's still-unbound prototype, then the slot's
 * active panel (what the person is looking at), then any clean member.
 */
function narrowRebindTarget(
  plan: WorkspacePlan,
  state: LayoutState,
  resolved: Resolution,
): LayoutPanel | null {
  if (!state.narrow || resolved.reason || resolved.mode === "new") return null;
  if (!isDocumentSlot(resolved.slot)) return null;
  const family = templateFamilyFor(plan, resolved);
  const candidates = family
    ? panelsInTemplateFamily(state, family)
    : state.panels.filter(
      (panel) => panel.moduleId === resolved.moduleId && panel.slot === resolved.slot,
    );
  const active = state.active[resolved.slot];
  return candidates.find((panel) => panel.resourceRef === null && !panel.dirty)
    ?? candidates.find((panel) => panel.panelId === active && !panel.dirty)
    ?? candidates.find((panel) => !panel.dirty)
    ?? null;
}

/** The one v2 template family that owns this resolved open route. */
function templateFamilyFor(
  plan: WorkspacePlan,
  resolved: Resolution,
): WorkspaceTemplateFamily | null {
  if (resolved.reason) return null;
  return plan.templateFamilies.find(
    (family) => family.moduleId === resolved.moduleId && family.slot === resolved.slot,
  ) ?? null;
}

/** Live panels in a family. The tagged standing prototype counts while empty. */
function panelsInTemplateFamily(
  state: LayoutState,
  family: WorkspaceTemplateFamily,
): readonly LayoutPanel[] {
  return state.panels.filter((panel) => panel.templatePrototypeId === family.prototypeId);
}

/**
 * The connected panel this open belongs in, or null.
 *
 * "Connected" means the App's binding plan names this composition instance, so
 * it is the only panel of that module that can honestly claim a typed port.
 * Preference order is the resolved slot first — that is where the composition
 * said this kind opens — then any slot, because a plan that wired the instance
 * somewhere else is still a plan that wired exactly one.
 *
 * Null for every module the plan does not connect, which leaves the ordinary
 * standing-reuse and mint-a-panel behaviour exactly as it was.
 */
function connectedSurface(
  plan: WorkspacePlan,
  state: LayoutState,
  resolved: Resolution,
): LayoutPanel | null {
  if (resolved.reason) return null;
  if (!plan.connectedInstances.size) return null;
  const candidates = state.panels.filter(
    (panel) => panel.moduleId === resolved.moduleId && plan.connectedInstances.has(panel.panelId),
  );
  if (!candidates.length) return null;
  return candidates.find((panel) => panel.slot === resolved.slot) ?? candidates[0]!;
}

/**
 * The three slots that share a row.
 *
 * `bottom` and `overlay` are deliberately not columns: a status strip under the
 * whole workspace and a floating layer over it are different structures, and
 * expressing them as flex items that wrap is how a status strip ends up claiming
 * half the height.
 */
export const COLUMN_SLOTS: readonly WorkspaceSlot[] = Object.freeze(["navigation", "primary", "secondary"]);

/** Panels in one slot, in creation order. */
export function panelsIn(state: LayoutState, slot: WorkspaceSlot): LayoutPanel[] {
  return state.panels.filter((panel) => panel.slot === slot);
}

/** Which slots this narrow/wide state actually paints. */
export function visibleSlots(state: LayoutState): WorkspaceSlot[] {
  if (!state.narrow) return [...WORKSPACE_SLOTS];
  return state.drilledIn
    ? ["secondary", "bottom", "overlay"]
    : ["navigation", "primary", "bottom", "overlay"];
}

/** Human text for a panel that cannot show what it was opened for. */
export const LAYOUT_REASON_TEXT: Readonly<Record<Exclude<LayoutReason, "">, string>> = Object.freeze({
  module_not_registered: "这个 release 里没有这个模块",
  no_viewer: "当前组合没有为这类资源声明可用的视图",
  slot_refused: "这个模块不接受被放进请求的位置",
  denied: "这次读取没有被授权",
  unavailable: "这个模块暂时不可用",
});
