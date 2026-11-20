/**
 * `StandardApp` — the composition root an App does not have to write.
 *
 * ── What it replaces ────────────────────────────────────────────────────────
 *
 * Every Agent View's `App.tsx` was doing the same five things: adapt the one
 * channel onto typed ports, mount a provider per port, build a registry and a
 * plan, render `WorkspaceShell` with slot class names and a divider, and paint a
 * status line while the channel is opening. Only the FIRST of those is
 * App-specific, and even that is a table lookup once the binding plan says which
 * contracts this release needs. So the shell takes the table and does the rest,
 * and a simple App's composition root becomes a data file plus one element.
 *
 * That is convergence-plan decision 9: the platform supplies the standard
 * assembly, a simple App is pure data, and an App with bespoke chrome or a
 * private adapter still writes its own root. Session Plus deliberately keeps
 * writing its own — this shell's first consumer is `app:preview`, so the
 * property being claimed ("one line assembles a workspace") is exercised by
 * something other than the App it was extracted from.
 *
 * ── The three things it will not do ─────────────────────────────────────────
 *
 *  1. **Decide what a port is.** It never constructs one: it calls the factory
 *     the App supplied for that contract id. A shell that knew how to build a
 *     `workspace-files/v1` port would be a shell that has to be edited to add a
 *     resource type — the exact coupling the binding plan exists to remove.
 *  2. **Recover.** No retry, no reload, no reconnect, no timeout. A View that
 *     never gets a port waits forever and the TRUSTED shell is what notices —
 *     it is the side that can tell "the App is broken" from "the App was
 *     destroyed on purpose".
 *  3. **Turn a broken build into a degraded panel.** A composition that does not
 *     link, or a declared binding with no adapter, is a fatal banner naming the
 *     problem. Panel-local refusal is for things a Host decided at runtime; a
 *     plan that cannot be assembled is a release that should not have shipped.
 */

import { useEffect, useMemo, useRef, type ReactNode } from "react";
import type {
  AgentComposition,
  ResourceBindingPlan,
  WorkspaceSlot,
} from "@claude-bot/agent-module-contract";
import { useAgentView, useAgentViewStatus, useRefusal } from "../hooks.js";
import { SplitHandle } from "../ui.js";
import type { AgentViewClient, ProposalReply } from "../client.js";
import {
  WorkspaceShell,
  useWorkspaceLayout,
  type SlotChrome,
} from "../workspace/WorkspaceShell.js";
import {
  DockWorkspaceShell,
  type DockWorkspaceShellProps,
} from "../workspace/DockWorkspaceShell.js";
import { createWorkspacePlan, type LayoutPanel, type WorkspacePlan } from "../workspace/layout.js";
import { createModuleRegistry, type ModuleRegistryEntry } from "../workspace/registry.js";
import { useNarrowViewport } from "../workspace/viewport.js";
import "./standard.css";

/** Below this width the secondary slot becomes a drill-in rather than a column. */
const DEFAULT_NARROW_PX = 720;

/**
 * What a port adapter is handed.
 *
 * Exactly the three things Session Plus's own root passes today: the transport
 * (for a snapshot and a subscription), the PROVIDER's `propose` (which records
 * the Host's bounded refusal — the raw client's does not), and that refusal
 * with a way to clear it. Note what is not here: an owner, an app, a scope, an
 * instance handle. A factory could not put one in a port if it wanted to.
 */
export interface AppTransport {
  client: AgentViewClient;
  propose(action: string, params?: Record<string, string>): Promise<ProposalReply>;
  refusal: { readonly text: string; clear(): void };
}

/**
 * One wired port: how its modules read it, and how it is released.
 *
 * `provide` rather than a `Provider` component, because the provider a contract
 * needs is the contract package's own and its props are its own business. The
 * shell composes closures; it never learns a provider's shape.
 */
export interface PortAdapter {
  provide(children: ReactNode): ReactNode;
  /** Called when the transport is replaced and on unmount. Must be idempotent. */
  destroy?(): void;
}

export type PortAdapterFactory = (transport: AppTransport) => PortAdapter;

export interface StandardAppProps {
  /** `agent-composition/v1` — what is mounted and where. */
  composition: AgentComposition;
  /** The v1 or v2 resource binding plan this release ships, when any. */
  bindings?: ResourceBindingPlan;
  /** Every module the composition may name. The lock is derived from these. */
  modules: readonly ModuleRegistryEntry[];
  /**
   * Contract id → adapter, one per binding the plan declares.
   *
   * Read once per transport, keyed by the CONTRACT IDS the plan names rather
   * than by this object's identity, so an App that writes the table inline does
   * not rebuild every port on every render — which for a resource port means
   * re-opening streams. The table is expected to be a module-level constant;
   * swapping a factory for the same contract id mid-life is not observed.
   */
  adapters?: Readonly<Record<string, PortAdapterFactory>>;
  /**
   * Ports the App satisfies from its own channel — its projection and actions.
   *
   * Separate from `adapters` because these are not resource bindings: nothing in
   * the resource binding plan declares them, and no deployment provides them.
   * Keyed by contract id so the memo above has a stable key here too. Mounted
   * OUTSIDE the binding adapters, so a resource provider may read App state and
   * not the other way round.
   */
  providers?: Readonly<Record<string, PortAdapterFactory>>;
  /** Rendered above the workspace. The App's own title bar, if it wants one. */
  header?: ReactNode;
  className?: string;
  /** Per-slot class names and dividers. Merged over the defaults, slot by slot. */
  chrome?: Partial<Record<WorkspaceSlot, SlotChrome>>;
  narrowPx?: number;
  /** Label for the fixed presentation's narrow drill-out control. */
  backLabel?: string;
  onPanelClosed?(panel: LayoutPanel): void;
  /**
   * `fixed` keeps the five-slot renderer. `dock-documents` keeps navigation
   * and bottom as non-draggable flow surfaces while document panels may be
   * tabbed, split and rearranged inside their bounded presentation area.
   */
  presentation?: "fixed" | "dock-documents";
  /** Presentation-only Dock chrome. It carries no refs, providers or authority. */
  dock?: Pick<DockWorkspaceShellProps, "surfaceClassName" | "documentClassNameByModule">;
}

export function StandardApp(props: StandardAppProps) {
  const { client, propose } = useAgentView();
  const refusal = useRefusal();
  const status = useAgentViewStatus();
  const narrow = useNarrowViewport(props.narrowPx ?? DEFAULT_NARROW_PX);

  // Read the refusal through a ref so a new notice does not give the transport
  // a new identity: adapters subscribe to it, and re-subscribing on every notice
  // would restart work that is already in flight.
  const refusalRef = useRef(refusal);
  refusalRef.current = refusal;
  const transport = useMemo<AppTransport>(
    () => ({
      client,
      propose,
      refusal: {
        get text() {
          return refusalRef.current.text;
        },
        clear: () => refusalRef.current.clear(),
      },
    }),
    [client, propose],
  );

  // The plan is built from data, so a failure here is a broken build rather
  // than untrusted input — but it is reported instead of thrown, because a
  // banner naming the instance is strictly more useful than the error boundary's
  // one degraded line.
  const built = useMemo(() => buildPlan(props.composition, props.modules, props.bindings), [
    props.bindings,
    props.composition,
    props.modules,
  ]);

  const wanted = useMemo(() => {
    const own = Object.keys(props.providers ?? {}).sort();
    const bound = [...new Set((props.bindings?.bindings ?? []).map((row) => row.contract))].sort();
    return { own, bound };
  }, [props.bindings, props.providers]);

  // Keyed by the contract ids, not by the tables' identity. See `adapters`.
  const wiring = useMemo(
    () => wire(transport, wanted, props.providers, props.adapters),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see the prop docs
    [transport, wanted],
  );
  useEffect(() => () => {
    for (const adapter of wiring.adapters) adapter.destroy?.();
  }, [wiring]);

  // `||` and not `??`: both fields are "" when fine, and `"" ?? x` is "" —
  // which would have swallowed every wiring failure behind a plan that linked.
  const fatal = built.error || wiring.error;
  if (fatal) {
    return (
      <div className={rootClass(props.className)}>
        {props.header}
        <div className="av-std-fatal" role="alert">
          <strong>这个 App 的组合无法装配</strong>
          <div>{fatal}</div>
        </div>
      </div>
    );
  }

  const plan = built.plan!;
  return (
    <div className={rootClass(props.className)}>
      {props.header}
      {refusal.text ? (
        <div className="av-std-notice" role="status">
          {refusal.text}
        </div>
      ) : null}
      {status.phase === "waiting" ? (
        <div className="av-std-wait" role="status">⏳ 等待可信外层转交通道…</div>
      ) : (
        wiring.provide(
          <StandardWorkspace
            plan={plan}
            narrow={narrow}
            chrome={props.chrome}
            backLabel={props.backLabel}
            onPanelClosed={props.onPanelClosed}
            presentation={props.presentation ?? "fixed"}
            dock={props.dock}
          />,
        )
      )}
      {status.phase === "closed" ? (
        <div className="av-std-wait" role="status">⚠ 通道已关闭；可信外层可以重建这个视图。</div>
      ) : null}
    </div>
  );
}

function rootClass(className?: string): string {
  return ["av-std", className].filter(Boolean).join(" ");
}

function StandardWorkspace({
  plan,
  narrow,
  chrome,
  backLabel,
  onPanelClosed,
  presentation,
  dock,
}: {
  plan: WorkspacePlan;
  narrow: boolean;
  chrome?: Partial<Record<WorkspaceSlot, SlotChrome>>;
  backLabel?: string;
  onPanelClosed?(panel: LayoutPanel): void;
  presentation: "fixed" | "dock-documents";
  dock?: StandardAppProps["dock"];
}) {
  const { state, dispatch, api } = useWorkspaceLayout(plan, { narrow });
  useEffect(() => dispatch({ type: "viewport", narrow }), [dispatch, narrow]);
  const merged = useMemo(() => mergeChrome(chrome), [chrome]);
  if (presentation === "dock-documents") {
    return (
      <DockWorkspaceShell
        plan={plan}
        state={state}
        api={api}
        className="av-std-cols"
        surfaceClassName={dock?.surfaceClassName}
        documentClassNameByModule={dock?.documentClassNameByModule}
        onPanelClosed={onPanelClosed}
      />
    );
  }
  return (
    <WorkspaceShell
      plan={plan}
      state={state}
      api={api}
      className="av-std-cols"
      backLabel={backLabel}
      chrome={merged}
      onPanelClosed={onPanelClosed}
    />
  );
}

/**
 * The default chrome: a card per slot, and a keyboard-accessible splitter
 * between the navigation rail and the rest.
 *
 * An App overrides a slot by naming it; the two are merged per slot rather than
 * wholesale, so adding a divider to `secondary` does not silently drop the rail
 * class the shell was providing.
 */
const DEFAULT_CHROME: Partial<Record<WorkspaceSlot, SlotChrome>> = Object.freeze({
  navigation: {
    className: "av-std-nav",
    divider: (
      <SplitHandle
        axis="x"
        target="prev"
        storageKey="standard-app.navigation"
        min={180}
        max={620}
        title="拖动调整导航栏宽度，双击恢复"
      />
    ),
  },
  primary: { className: "av-std-main" },
  secondary: { className: "av-std-aside" },
  bottom: { className: "av-std-foot" },
  overlay: { className: "av-std-overlay" },
});

function mergeChrome(
  chrome: Partial<Record<WorkspaceSlot, SlotChrome>> | undefined,
): Partial<Record<WorkspaceSlot, SlotChrome>> {
  if (!chrome) return DEFAULT_CHROME;
  const out: Partial<Record<WorkspaceSlot, SlotChrome>> = { ...DEFAULT_CHROME };
  for (const slot of Object.keys(chrome) as WorkspaceSlot[]) {
    out[slot] = { ...DEFAULT_CHROME[slot], ...chrome[slot] };
  }
  return out;
}

interface BuiltPlan {
  plan: WorkspacePlan | null;
  error: string;
}

function buildPlan(
  composition: AgentComposition,
  modules: readonly ModuleRegistryEntry[],
  bindings: ResourceBindingPlan | undefined,
): BuiltPlan {
  try {
    const registry = createModuleRegistry([...modules]);
    const plan = createWorkspacePlan(bindings ? { composition, registry, bindings } : { composition, registry });
    return { plan, error: "" };
  } catch (error) {
    return { plan: null, error: error instanceof Error ? error.message : String(error) };
  }
}

interface Wiring {
  provide(children: ReactNode): ReactNode;
  adapters: readonly PortAdapter[];
  error: string;
}

/**
 * Instantiate one adapter per wanted contract, outermost first.
 *
 * A declared binding with no factory is FATAL rather than skipped: the modules
 * wired to it would throw out of their own provider hook one render later, and
 * "this deployment of the App supplied no adapter for workspace-files/v1" is a
 * sentence somebody can act on.
 */
function wire(
  transport: AppTransport,
  wanted: { own: readonly string[]; bound: readonly string[] },
  providers: Readonly<Record<string, PortAdapterFactory>> | undefined,
  adapters: Readonly<Record<string, PortAdapterFactory>> | undefined,
): Wiring {
  const built: PortAdapter[] = [];
  const missing: string[] = [];
  const add = (contract: string, table: Readonly<Record<string, PortAdapterFactory>> | undefined): void => {
    const factory = table && Object.prototype.hasOwnProperty.call(table, contract) ? table[contract] : undefined;
    if (!factory) {
      missing.push(contract);
      return;
    }
    built.push(factory(transport));
  };
  for (const contract of wanted.own) add(contract, providers);
  for (const contract of wanted.bound) add(contract, adapters);
  if (missing.length) {
    // Release what was already built; a half-wired workspace is not something
    // to keep around for a render that is not going to happen.
    for (const adapter of built) adapter.destroy?.();
    return {
      provide: (children) => children,
      adapters: [],
      error: `这套组合声明了 ${missing.join("、")}，但没有为它提供 adapter。`,
    };
  }
  return {
    // Reduced from the right so the FIRST adapter ends up outermost, which is
    // what makes "own ports wrap resource ports" a statement about order rather
    // than a coincidence of how the array was built.
    provide: (children) => built.reduceRight<ReactNode>((inner, adapter) => adapter.provide(inner), children),
    adapters: built,
    error: "",
  };
}
