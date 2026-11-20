/**
 * The rules, once they are actually rendered.
 *
 * The reducer test proves the semantics; this proves the three properties that
 * only exist because React is involved: a panel's local state survives while it
 * is mounted, closing it runs the module's cleanup, and a module that throws
 * takes down its own panel and nothing else.
 */

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useEffect, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { COMPOSITION_SCHEMA, type AgentComposition, type AgentModuleManifest } from "@claude-bot/agent-module-contract";
import {
  WorkspaceShell,
  createModuleRegistry,
  createWorkspacePlan,
  useWorkspace,
  useWorkspaceLayout,
  type ModuleProps,
  type WorkspacePlan,
} from "./index.js";

const RELEASED: string[] = [];

const ROSTER: AgentModuleManifest = {
  id: "session.roster-tree/v1",
  version: "1.0.0",
  implementation: "test#Roster",
  title: "会话",
  slots: ["navigation"],
  ports: [],
  opens: [],
};

const NOTE: AgentModuleManifest = {
  id: "demo.note/v1",
  version: "1.0.0",
  implementation: "test#Note",
  title: "备注",
  slots: ["secondary"],
  ports: [],
  opens: ["note"],
};

const CRASHER: AgentModuleManifest = {
  id: "demo.crasher/v1",
  version: "1.0.0",
  implementation: "test#Crasher",
  title: "会崩的模块",
  slots: ["bottom"],
  ports: [],
  opens: [],
};

const STANDING: AgentModuleManifest = {
  id: "demo.standing/v1",
  version: "1.0.0",
  implementation: "test#Standing",
  title: "常驻占位",
  slots: ["secondary"],
  ports: [],
  opens: [],
};

const CONNECTED_NOTE: AgentModuleManifest = {
  ...NOTE,
  id: "demo.connected-note/v1",
  implementation: "test#ConnectedNote",
  ports: ["notes/v1"],
};

/** Raises intents; never touches layout state. */
function Roster() {
  const workspace = useWorkspace();
  return (
    <div>
      <button type="button" onClick={() => workspace.open({ kind: "note", ref: "note-1", label: "笔记一" })}>
        打开笔记一
      </button>
      <button type="button" onClick={() => workspace.open({ kind: "note", ref: "note-2", label: "笔记二" })}>
        打开笔记二
      </button>
      <button type="button" onClick={() => workspace.open({ kind: "note", ref: "note-3", label: "笔记三" })}>
        打开笔记三
      </button>
      <button type="button" onClick={() => workspace.open({ kind: "file", ref: "f", label: "main.ts" })}>
        打开文件
      </button>
      <button type="button" onClick={() => workspace.openIntent({} as never)}>
        发送坏 intent
      </button>
      <button type="button" onClick={() => workspace.focus("standing")}>
        聚焦常驻面板
      </button>
      {/*
        A cheap window into the reducer's own state, so a test can distinguish
        "the shell is showing the MRU bound as selected because presentation
        reconciled it" from "the reducer's active was actually synced back to
        MRU by the layout effect". Rendering `active.secondary` here is a read
        of reducer state, not a second copy.
      */}
      <output aria-label="active-secondary" data-testid="active-secondary">
        {workspace.state.active.secondary ?? "none"}
      </output>
    </div>
  );
}

/** Holds a draft and a subscription, so both can be observed across a close. */
function Note({ panel, workspace }: ModuleProps) {
  const [draft, setDraft] = useState("");
  useEffect(() => {
    RELEASED.push(`open:${panel.panelId}`);
    return () => {
      RELEASED.push(`released:${panel.panelId}`);
    };
  }, [panel.panelId]);
  return (
    <div data-testid={`note-${panel.panelId}`}>
      <span>{panel.label}</span>
      <input aria-label={`draft-${panel.panelId}`} value={draft} onChange={(event) => setDraft(event.target.value)} />
      <button type="button" onClick={() => workspace.close(panel.panelId)}>关闭</button>
      <button type="button" onClick={() => workspace.report(panel.panelId, "denied", "测试拒绝")}>报告拒绝</button>
    </div>
  );
}

function Crasher(): never {
  throw new Error("模块自己炸了");
}

function Standing() {
  return <div>standing-secondary</div>;
}

function ModeNewProbe() {
  const workspace = useWorkspace();
  const [accepted, setAccepted] = useState<string>("unset");
  return (
    <div>
      <button
        type="button"
        onClick={() => setAccepted(String(workspace.open(
          { kind: "note", ref: "second", label: "second" },
          { mode: "new" },
        )))}
      >
        尝试新建已连接面板
      </button>
      <output aria-label="open-result">{accepted}</output>
    </div>
  );
}

function planFor(): WorkspacePlan {
  const registry = createModuleRegistry([
    { manifest: ROSTER, component: Roster },
    { manifest: NOTE, component: Note },
    { manifest: CRASHER, component: Crasher },
  ]);
  const composition: AgentComposition = {
    schema: COMPOSITION_SCHEMA,
    app: "test-app",
    instances: [
      { instance: "roster", module: ROSTER.id, slot: "navigation", title: "左栏" },
      { instance: "crash", module: CRASHER.id, slot: "bottom" },
    ],
    open: [{ resource: "note", module: NOTE.id, slot: "secondary" }],
  };
  return createWorkspacePlan({ composition, registry });
}

function standingPlan(): WorkspacePlan {
  const registry = createModuleRegistry([
    { manifest: ROSTER, component: Roster },
    { manifest: NOTE, component: Note },
    { manifest: STANDING, component: Standing },
  ]);
  return createWorkspacePlan({
    registry,
    composition: {
      schema: COMPOSITION_SCHEMA,
      app: "test-app",
      instances: [
        { instance: "roster", module: ROSTER.id, slot: "navigation" },
        { instance: "standing", module: STANDING.id, slot: "secondary" },
      ],
      open: [{ resource: "note", module: NOTE.id, slot: "secondary" }],
    },
  });
}

/**
 * A plan that mirrors Session Plus's structural shape: something in primary,
 * a standing document in secondary that starts empty, an open rule that binds
 * a resource into it. This is the composition where the ticket's headline
 * scenario is visible: the two-column region collapses to one until a bound
 * resource shows up in secondary.
 */
const CHAT: AgentModuleManifest = {
  id: "demo.chat/v1",
  version: "1.0.0",
  implementation: "test#Chat",
  title: "对话",
  slots: ["primary"],
  ports: [],
  opens: [],
};

function ChatStanding() {
  return <div>chat-standing</div>;
}

function primarySecondaryPlan(): WorkspacePlan {
  const registry = createModuleRegistry([
    { manifest: ROSTER, component: Roster },
    { manifest: NOTE, component: Note },
    { manifest: STANDING, component: Standing },
    { manifest: CHAT, component: ChatStanding },
  ]);
  return createWorkspacePlan({
    registry,
    composition: {
      schema: COMPOSITION_SCHEMA,
      app: "test-app",
      instances: [
        { instance: "roster", module: ROSTER.id, slot: "navigation" },
        { instance: "chat", module: CHAT.id, slot: "primary" },
        { instance: "standing", module: STANDING.id, slot: "secondary" },
      ],
      open: [{ resource: "note", module: NOTE.id, slot: "secondary" }],
    },
  });
}

function connectedPlanForApi(): WorkspacePlan {
  const registry = createModuleRegistry([
    { manifest: ROSTER, component: ModeNewProbe },
    { manifest: CONNECTED_NOTE, component: Note },
  ]);
  return createWorkspacePlan({
    registry,
    composition: {
      schema: COMPOSITION_SCHEMA,
      app: "test-app",
      instances: [
        { instance: "probe", module: ROSTER.id, slot: "navigation" },
        { instance: "viewer", module: CONNECTED_NOTE.id, slot: "secondary" },
      ],
      open: [{ resource: "note", module: CONNECTED_NOTE.id, slot: "secondary" }],
    },
    bindings: {
      schema: "agent-resource-bindings/v1",
      app: "test-app",
      bindings: [{ binding: "notes", contract: "notes/v1" }],
      connections: [{ instance: "viewer", port: "notes/v1", binding: "notes" }],
    },
  });
}

function Workspace({ plan, onPanelClosed }: { plan: WorkspacePlan; onPanelClosed?: () => void }) {
  const { state, api } = useWorkspaceLayout(plan);
  return (
    <WorkspaceShell
      plan={plan}
      state={state}
      api={api}
      className="cols"
      chrome={{ navigation: { className: "side" }, primary: { className: "main" } }}
      onPanelClosed={onPanelClosed}
    />
  );
}

function NarrowWorkspace({ plan, onPanelClosed }: { plan: WorkspacePlan; onPanelClosed?: () => void }) {
  const { state, api } = useWorkspaceLayout(plan, { narrow: true });
  return (
    <WorkspaceShell
      plan={plan}
      state={state}
      api={api}
      backLabel="返回"
      onPanelClosed={onPanelClosed}
    />
  );
}

describe("WorkspaceShell", () => {
  it("paints the composition's slots with the App's own class names", () => {
    render(<Workspace plan={planFor()} />);
    expect(document.querySelector(".av-workspace.cols")).toBeTruthy();
    expect(document.querySelector('.av-columns > .av-slot.side[data-av-slot="navigation"]')).toBeTruthy();
    // `bottom` is a sibling of the column row, not a member of it.
    expect(document.querySelector('.av-columns > [data-av-slot="bottom"]')).toBeNull();
    expect(document.querySelector('.av-workspace > [data-av-slot="bottom"]')).toBeTruthy();
    expect(document.querySelector('[data-av-panel="roster"][data-av-module="session.roster-tree/v1"]')).toBeTruthy();
  });

  it("contains a module that throws inside its own panel", () => {
    const onError = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<Workspace plan={planFor()} />);
    // The crashing module degrades to one line...
    expect(screen.getByText(/这个视图渲染失败了/)).toBeInTheDocument();
    // ...and everything else is still there.
    expect(screen.getByRole("button", { name: "打开笔记一" })).toBeInTheDocument();
    onError.mockRestore();
  });

  it("opens on intent, keeps a draft while mounted, and releases on close", async () => {
    RELEASED.length = 0;
    const closed = vi.fn();
    render(<Workspace plan={planFor()} onPanelClosed={closed} />);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await userEvent.click(screen.getByRole("button", { name: "打开笔记一" }));
    const panel = document.querySelector('.av-slot[data-av-slot="secondary"] .av-panel')!;
    const panelId = panel.getAttribute("data-av-panel")!;
    expect(RELEASED).toContain(`open:${panelId}`);

    await userEvent.type(screen.getByLabelText(`draft-${panelId}`), "半句话");
    // Re-opening the same resource focuses what is there; the subtree is not
    // re-created, so the half-typed line is still half-typed.
    await userEvent.click(screen.getByRole("button", { name: "打开笔记一" }));
    expect((screen.getByLabelText(`draft-${panelId}`) as HTMLInputElement).value).toBe("半句话");
    expect(document.querySelectorAll('.av-slot[data-av-slot="secondary"] .av-panel')).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(RELEASED).toContain(`released:${panelId}`);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.av-slot[data-av-slot="secondary"]')).toBeNull();
  });

  it("shows a resource with no declared viewer as a refused panel", async () => {
    render(<Workspace plan={planFor()} />);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await userEvent.click(screen.getByRole("button", { name: "打开文件" }));
    const panel = document.querySelector('[data-av-status="unavailable"][data-av-module=""]');
    expect(panel).toBeTruthy();
    expect(panel).toHaveTextContent(/没有为这类资源声明可用的视图/);
  });

  it("checks a pre-built intent at runtime instead of letting one bad module crash the shell", async () => {
    render(<Workspace plan={planFor()} />);
    const before = document.querySelectorAll(".av-panel").length;
    await userEvent.click(screen.getByRole("button", { name: "发送坏 intent" }));
    expect(document.querySelectorAll(".av-panel")).toHaveLength(before);
    expect(screen.getByRole("button", { name: "打开笔记一" })).toBeInTheDocument();
  });

  it("does not report a close when the panel merely changes status", async () => {
    const closed = vi.fn();
    render(<Workspace plan={planFor()} onPanelClosed={closed} />);
    await userEvent.click(screen.getByRole("button", { name: "打开笔记一" }));
    await userEvent.click(screen.getByRole("button", { name: "报告拒绝" }));
    expect(closed).not.toHaveBeenCalled();
    expect(screen.getByText("测试拒绝")).toBeInTheDocument();
  });

  it("does not report React StrictMode's synthetic cleanup as a panel close", async () => {
    const closed = vi.fn();
    const onError = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <StrictMode>
        <Workspace plan={planFor()} onPanelClosed={closed} />
      </StrictMode>,
    );
    await act(async () => {});
    expect(closed).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "打开笔记一" }));
    await userEvent.click(screen.getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
    onError.mockRestore();
  });

  it("keeps stacked panels mounted, painting only the active one", async () => {
    RELEASED.length = 0;
    render(<Workspace plan={planFor()} />);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await userEvent.click(screen.getByRole("button", { name: "打开笔记一" }));
    const first = document.querySelector('.av-slot[data-av-slot="secondary"] .av-panel')!.getAttribute("data-av-panel")!;
    await userEvent.type(screen.getByLabelText(`draft-${first}`), "第一份草稿");

    // A second instance of the same resource, asked for explicitly by the test's
    // own dispatch path: two panels, one painted, both mounted.
    await act(async () => {
      screen.getByRole("button", { name: "打开笔记一" }).click();
    });
    const panels = document.querySelectorAll('.av-slot[data-av-slot="secondary"] .av-panel');
    expect(panels).toHaveLength(1);
    expect((screen.getByLabelText(`draft-${first}`) as HTMLInputElement).value).toBe("第一份草稿");
    expect(RELEASED.filter((row) => row.startsWith("released:"))).toHaveLength(0);
  });

  it("paints only the active panel in a document slot, including standing surfaces", async () => {
    render(<Workspace plan={standingPlan()} />);
    expect(screen.getByText("standing-secondary")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "打开笔记一" }));
    expect(screen.getByText("standing-secondary").closest(".av-panel")).not.toBeVisible();
    // Two panels now share the slot, so the shell paints a tab strip whose
    // labels also read "笔记一". Constrain the query to the panel body itself.
    const notePanel = document.querySelector<HTMLElement>('[data-testid^="note-"]')!;
    expect(notePanel.closest(".av-panel")).toBeVisible();
  });

  it("returns false when mode:new cannot be wired by the connected v1 surface", async () => {
    const plan = connectedPlanForApi();
    render(<Workspace plan={plan} />);
    const before = document.querySelectorAll(".av-panel").length;
    await userEvent.click(screen.getByRole("button", { name: "尝试新建已连接面板" }));
    expect(screen.getByLabelText("open-result")).toHaveTextContent("false");
    expect(document.querySelectorAll(".av-panel")).toHaveLength(before);
  });

  it("does not paint the secondary column or its divider when secondary has no bound resource", async () => {
    // The ticket's headline scenario, on the composition shape that models
    // Session Plus: chat standing in primary, an empty viewer standing in
    // secondary. The main region is a single column until an intent binds
    // something into secondary — no divider in the DOM, and no card-shaped
    // half-width shadow of a viewer nobody asked for.
    render(<Workspace plan={primarySecondaryPlan()} />);
    // The main region exists (primary lives in it) but the divider is out.
    expect(document.querySelector('.av-main-region')).toBeTruthy();
    expect(document.querySelector('.av-main-region > .av-splitter')).toBeNull();
    // The standing secondary slot is still rendered so its React subtree
    // survives, but it is hidden — the flex row does not give it any space.
    const secondaryBefore = document.querySelector('.av-slot[data-av-slot="secondary"]');
    expect(secondaryBefore).toBeTruthy();
    expect(secondaryBefore!.hasAttribute('hidden')).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: "打开笔记一" }));

    // Now the divider appears — the SDK's `SplitHandle`, keyboard-operable
    // and labelled `role="separator"` with the SDK's ARIA already on it.
    const splitter = document.querySelector<HTMLElement>('.av-main-region > .av-splitter');
    expect(splitter).toBeTruthy();
    expect(splitter!.getAttribute('role')).toBe('separator');
    expect(splitter!.getAttribute('aria-orientation')).toBe('vertical');
    expect(document.querySelector('.av-slot[data-av-slot="secondary"]')!.hasAttribute('hidden')).toBe(false);
  });

  it("keeps an empty standing surface mounted alongside a single bound resource without producing a tab strip, and preserves it across an open→close cycle", async () => {
    // "One real resource plus one empty template" is the ambiguous state that
    // was producing a two-tab strip whose second tab pointed at nothing. The
    // fix: tabs count only BOUND document panels, and the standing surface
    // stays mounted so its subtree survives — it just does not earn a tab.
    RELEASED.length = 0;
    render(<Workspace plan={standingPlan()} />);
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Capture the standing panel's DOM node BEFORE the interaction so a
    // subsequent identity check proves React did not unmount and remount it
    // (the RELEASED probe is a Note-only signal — it says nothing about the
    // Standing subtree, which has no such effect).
    const standingBefore = document.querySelector('[data-av-panel="standing"]')!;
    expect(standingBefore).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "打开笔记一" }));

    // No tablist for the "standing + one bound" state.
    expect(document.querySelector('.av-slot[data-av-slot="secondary"] [role="tablist"]')).toBeNull();
    expect(document.querySelector('.av-slot[data-av-slot="secondary"]')!.getAttribute('data-av-tabs')).toBeNull();

    // Both panels are mounted; only the bound one is on top.
    const panelsMid = document.querySelectorAll('.av-slot[data-av-slot="secondary"] .av-panel');
    expect(panelsMid).toHaveLength(2);
    const standingMid = document.querySelector('[data-av-panel="standing"]');
    expect(standingMid).toBeTruthy();
    // DOM node identity: React reused the SAME element, so effects, refs, any
    // subscription the Standing module holds — none have been torn down.
    expect(standingMid).toBe(standingBefore);
    expect(standingMid!.hasAttribute('hidden')).toBe(true);
    // The Note that this test DID open has not been released either.
    expect(RELEASED.filter((row) => row.startsWith('released:'))).toHaveLength(0);

    // Now the "close" half of the transition the earlier assertion did not
    // cover. Closing the runtime note removes ONE panel; the standing
    // surface must survive that transition too, not just an idle re-render.
    await userEvent.click(screen.getByRole("button", { name: "关闭" }));
    const standingAfter = document.querySelector('[data-av-panel="standing"]');
    expect(standingAfter).toBeTruthy();
    expect(standingAfter).toBe(standingBefore);
    // The runtime panel really did go away, and its own effect cleanup ran —
    // proving the close was a real unmount (not a hidden pass-through) even
    // though the neighbouring standing survived it.
    expect(RELEASED.filter((row) => row.startsWith('released:'))).toHaveLength(1);
  });

  it("drives tabs, panel visibility and reducer sync from the same presentation active", async () => {
    // Before this fix the tablist's `aria-selected` was reconciled with the
    // bound-only candidate list while Panel `hidden` was read straight from
    // the reducer's `active` — so an `api.focus(standing)` produced a tab
    // that claimed to be selected while its panel stayed hidden and the
    // standing empty template stayed visible. The two are now driven by one
    // presentationActive computed in SlotRegion, and a layout effect syncs
    // the reducer BEFORE paint so any subsequent close-fallback sees the
    // same value the user does.
    render(<Workspace plan={standingPlan()} />);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await userEvent.click(screen.getByRole("button", { name: "打开笔记一" }));
    await userEvent.click(screen.getByRole("button", { name: "打开笔记二" }));

    const activeProbe = () => screen.getByLabelText("active-secondary").textContent;
    // Reducer state before the diverging intent: opening 笔记二 last put
    // active on its runtime panel (`panel-2`, minted after `panel-1`).
    expect(activeProbe()).toBe("panel-2");

    // Real intent onto the unbound standing panel.
    await userEvent.click(screen.getByRole("button", { name: "聚焦常驻面板" }));

    // Exactly one tab claims selection and the tab sequence.
    const tabs = document.querySelectorAll<HTMLButtonElement>('.av-slot[data-av-slot="secondary"] [role="tab"]');
    expect(tabs).toHaveLength(2);
    const selected = [...tabs].filter((tab) => tab.getAttribute('aria-selected') === 'true');
    const tabbable = [...tabs].filter((tab) => tab.getAttribute('tabindex') === '0');
    expect(selected).toHaveLength(1);
    expect(tabbable).toHaveLength(1);
    expect(selected[0]).toBe(tabbable[0]);
    // Deterministic fallback: the MRU bound candidate (last in `panels` —
    // the reducer keeps document-slot panels MRU-ordered via `focusIn`).
    expect(selected[0]!.querySelector('.av-tab-label')?.textContent).toBe('笔记二');

    // And its panel body IS visible — the same value drove the Panel
    // `hidden` prop, so ARIA is not describing a hidden surface.
    const bodyId = selected[0]!.getAttribute('aria-controls')!;
    const body = document.getElementById(bodyId)!;
    expect(body).toBeTruthy();
    expect(body.hasAttribute('hidden')).toBe(false);
    // The empty standing template is hidden (presentationActive drove it too).
    const standing = document.querySelector('[data-av-panel="standing"]');
    expect(standing).toBeTruthy();
    expect(standing!.hasAttribute('hidden')).toBe(true);

    // ── The real state proof ────────────────────────────────────────────
    //
    // Without the SlotRegion sync effect, `active.secondary` would remain
    // "standing" — the display would look right (tabs and Panel hidden are
    // both reconciled through presentationActive) but any code that reads
    // reducer state directly (close fallback, external subscribers, another
    // module) would see the divergence. The probe reads `workspace.state`
    // straight from the reducer, so this assertion FAILS if the sync effect
    // is removed. Wait rather than assert-and-hope: the effect dispatches
    // on the render after the divergence is observed, so the transition is
    // a two-render one.
    await waitFor(() => expect(activeProbe()).toBe("panel-2"));
  });

  it("labels the tab strip with a stable accessible name, App-owned when supplied, SDK default otherwise", async () => {
    // `role="tablist"` with no accessible name is unnamed to every screen
    // reader. `SlotChrome.tabsLabel` is the App-owned override; a missing
    // one falls back to the SDK's neutral "打开的资源". The name must NOT
    // be constructed from tab contents — the region identifies a slot, and
    // rebuilding the string on every open/close would make the region
    // re-announce itself for changes that did not touch it.
    render(<Workspace plan={standingPlan()} />);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await userEvent.click(screen.getByRole("button", { name: "打开笔记一" }));
    await userEvent.click(screen.getByRole("button", { name: "打开笔记二" }));
    const defaultTablist = document.querySelector('.av-slot[data-av-slot="secondary"] [role="tablist"]');
    expect(defaultTablist).toBeTruthy();
    expect(defaultTablist).toHaveAccessibleName("打开的资源");

    cleanup();

    // Same shape, App supplies its own localizable name via chrome.
    function LabeledWorkspace() {
      const plan = standingPlan();
      const { state, api } = useWorkspaceLayout(plan);
      return (
        <WorkspaceShell
          plan={plan}
          state={state}
          api={api}
          chrome={{ secondary: { tabsLabel: "会话与笔记" } }}
        />
      );
    }
    render(<LabeledWorkspace />);
    await userEvent.click(screen.getByRole("button", { name: "打开笔记一" }));
    await userEvent.click(screen.getByRole("button", { name: "打开笔记二" }));
    const namedTablist = document.querySelector('.av-slot[data-av-slot="secondary"] [role="tablist"]')!;
    expect(namedTablist).toHaveAccessibleName("会话与笔记");
    // A third open must not change the name — the region identifies the
    // slot, not whatever is inside it right now.
    await userEvent.click(screen.getByRole("button", { name: "打开笔记三" }));
    expect(namedTablist).toHaveAccessibleName("会话与笔记");
  });

  it("hands DOM focus to the surviving panel body when close 2 → 1 unmounts the tab strip", async () => {
    // A wantFocus flag inside TabList would never run its cleanup on this
    // transition — the tablist is gone. SlotRegion holds the pending handoff
    // and, when the strip has disappeared, places focus on the surviving
    // panel body (which carries `tabIndex=-1` for exactly this reason).
    render(<Workspace plan={standingPlan()} />);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await userEvent.click(screen.getByRole("button", { name: "打开笔记一" }));
    await userEvent.click(screen.getByRole("button", { name: "打开笔记二" }));

    const activeTab = document.querySelector<HTMLButtonElement>(
      '.av-slot[data-av-slot="secondary"] [role="tab"][aria-selected="true"]',
    )!;
    // Simulate a keyboard close so the focused element is the tab itself.
    activeTab.focus();
    expect(document.activeElement).toBe(activeTab);
    await userEvent.keyboard('{Delete}');

    await waitFor(() =>
      expect(document.querySelector('.av-slot[data-av-slot="secondary"] [role="tablist"]')).toBeNull(),
    );
    // The tablist is gone. Focus is now on the surviving panel body — the
    // `.av-panel` element itself, not `document.body` and not the standing
    // empty template.
    const focused = document.activeElement as HTMLElement | null;
    expect(focused).toBeTruthy();
    expect(focused!.classList.contains('av-panel')).toBe(true);
    expect(focused!.getAttribute('data-av-panel')).not.toBe('standing');
    expect(focused!.hasAttribute('hidden')).toBe(false);
  });

  it("brings tabs in the moment a second bound resource lands, and hides them again on close", async () => {
    RELEASED.length = 0;
    const closed = vi.fn();
    render(<Workspace plan={standingPlan()} onPanelClosed={closed} />);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await userEvent.click(screen.getByRole("button", { name: "打开笔记一" }));
    await userEvent.click(screen.getByRole("button", { name: "打开笔记二" }));

    // Two bound panels → tablist appears with exactly two tabs; the standing
    // panel is not one of them.
    const tabs = document.querySelectorAll('.av-slot[data-av-slot="secondary"] [role="tab"]');
    expect(tabs).toHaveLength(2);
    const tabLabels = [...tabs].map((tab) => tab.querySelector('.av-tab-label')?.textContent);
    expect(tabLabels).toContain('笔记一');
    expect(tabLabels).toContain('笔记二');
    expect(tabLabels).not.toContain('常驻占位');

    // Close one → back to a single bound panel → the tablist is gone; the
    // standing panel is still mounted; and no panel that was NOT closed fired
    // an unmount notice.
    const activeTab = [...tabs].find((tab) => tab.getAttribute('aria-selected') === 'true') as HTMLButtonElement;
    await userEvent.click(activeTab.querySelector('[data-av-tab-close]') as HTMLElement);
    await waitFor(() => expect(
      document.querySelector('.av-slot[data-av-slot="secondary"] [role="tablist"]'),
    ).toBeNull());
    expect(document.querySelector('[data-av-panel="standing"]')).toBeTruthy();
    // Exactly one release notice: the tab whose × was clicked.
    await waitFor(() =>
      expect(RELEASED.filter((row) => row.startsWith('released:'))).toHaveLength(1),
    );
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("renders a tab strip when a document slot stacks two panels and none for a single panel", async () => {
    render(<Workspace plan={planFor()} />);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await userEvent.click(screen.getByRole("button", { name: "打开笔记一" }));
    // One panel in secondary → no tablist to disambiguate.
    expect(document.querySelector('.av-slot[data-av-slot="secondary"] [role="tablist"]')).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "打开笔记二" }));
    const tablist = document.querySelector('.av-slot[data-av-slot="secondary"] [role="tablist"]')!;
    expect(tablist).toBeTruthy();
    const tabs = tablist.querySelectorAll('[role="tab"]');
    expect(tabs).toHaveLength(2);
    // Roving tabindex: the active tab is in the sequence, the inactive one is not.
    expect(tabs[0]!.getAttribute("aria-selected")).toBe("false");
    expect(tabs[0]!.getAttribute("tabindex")).toBe("-1");
    expect(tabs[1]!.getAttribute("aria-selected")).toBe("true");
    expect(tabs[1]!.getAttribute("tabindex")).toBe("0");
    // Every tab points at its tabpanel by id.
    const controls = tabs[1]!.getAttribute("aria-controls")!;
    const body = document.getElementById(controls)!;
    expect(body).toBeTruthy();
    expect(body.getAttribute("role")).toBe("tabpanel");
    expect(body.getAttribute("aria-labelledby")).toBe(tabs[1]!.id);
  });

  it("navigates and activates tabs with the WAI-ARIA keys", async () => {
    render(<Workspace plan={planFor()} />);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await userEvent.click(screen.getByRole("button", { name: "打开笔记一" }));
    await userEvent.click(screen.getByRole("button", { name: "打开笔记二" }));
    await userEvent.click(screen.getByRole("button", { name: "打开笔记三" }));

    const tablist = document.querySelector('.av-slot[data-av-slot="secondary"] [role="tablist"]')!;
    const tabs = [...tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs).toHaveLength(3);
    // The third open focused the third tab.
    tabs[2]!.focus();
    expect(document.activeElement).toBe(tabs[2]);

    // Left/Right and Home/End walk the strip but leave `aria-selected` alone
    // (manual activation).
    await userEvent.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(tabs[1]);
    expect(tabs[2]!.getAttribute("aria-selected")).toBe("true");

    await userEvent.keyboard("{Home}");
    expect(document.activeElement).toBe(tabs[0]);
    await userEvent.keyboard("{End}");
    expect(document.activeElement).toBe(tabs[2]);

    // Enter activates whatever tab is focused, moving selection to it.
    await userEvent.keyboard("{ArrowLeft}");
    await userEvent.keyboard("{Enter}");
    expect(tabs[1]!.getAttribute("aria-selected")).toBe("true");
    expect(tabs[2]!.getAttribute("aria-selected")).toBe("false");

    // Left from the first tab wraps to the last.
    tabs[0]!.focus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(tabs[2]);
  });

  it("closes a tab with Delete and hands focus deterministically to what remains", async () => {
    render(<Workspace plan={planFor()} />);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await userEvent.click(screen.getByRole("button", { name: "打开笔记一" }));
    await userEvent.click(screen.getByRole("button", { name: "打开笔记二" }));
    await userEvent.click(screen.getByRole("button", { name: "打开笔记三" }));

    const initial = document.querySelectorAll('.av-slot[data-av-slot="secondary"] [role="tab"]');
    expect(initial).toHaveLength(3);
    (initial[2] as HTMLButtonElement).focus();
    await userEvent.keyboard("{Delete}");

    const after = document.querySelectorAll<HTMLButtonElement>('.av-slot[data-av-slot="secondary"] [role="tab"]');
    expect(after).toHaveLength(2);
    // After closing the active tab, the reducer's fallback picks a survivor and
    // the shell puts DOM focus on the tab that now claims aria-selected.
    const activeTab = [...after].find((tab) => tab.getAttribute("aria-selected") === "true")!;
    expect(document.activeElement).toBe(activeTab);
  });

  it("closes a tab with the visible × affordance without also activating it", async () => {
    render(<Workspace plan={planFor()} />);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await userEvent.click(screen.getByRole("button", { name: "打开笔记一" }));
    await userEvent.click(screen.getByRole("button", { name: "打开笔记二" }));
    await userEvent.click(screen.getByRole("button", { name: "打开笔记三" }));

    const activeBefore = document.querySelector('[role="tab"][aria-selected="true"]')!;
    expect(activeBefore.textContent).toContain("笔记三");
    // Pick the inactive tab that is NOT the one that will end up active if the
    // active tab were closed — clicking × on the inactive one should leave the
    // active tab as-is regardless.
    const inactiveTabs = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      .filter((tab) => tab.getAttribute("aria-selected") === "false");
    expect(inactiveTabs).toHaveLength(2);
    const targetTab = inactiveTabs[0]!;
    const targetLabel = targetTab.querySelector('.av-tab-label')!.textContent;
    const closeIcon = targetTab.querySelector('[data-av-tab-close]') as HTMLElement;
    expect(closeIcon).toBeTruthy();

    await userEvent.click(closeIcon);
    expect(document.querySelectorAll('[role="tab"]')).toHaveLength(2);
    const remainingLabels = [...document.querySelectorAll<HTMLElement>('.av-tab-label')].map((node) => node.textContent);
    expect(remainingLabels).not.toContain(targetLabel);
    const activeAfter = document.querySelector('[role="tab"][aria-selected="true"]')!;
    expect(activeAfter.textContent).toContain("笔记三");
  });

  it("hides — never unmounts — the slots behind a narrow-screen drill-in", async () => {
    // The drill-in is a viewport decision, not a lifecycle event. Before
    // 2026-08-07 the shell simply did not render invisible slots, which
    // unmounted every panel behind the drill-in: navigation lost its scroll,
    // documents lost their drafts, and onPanelClosed fired for panels nobody
    // closed. Now every slot with panels renders on every pass and visibility
    // is carried by the `hidden` attribute alone.
    RELEASED.length = 0;
    const closed = vi.fn();
    render(<NarrowWorkspace plan={planFor()} onPanelClosed={closed} />);
    vi.spyOn(console, "error").mockImplementation(() => {});

    // Opening a note on a narrow screen drills into `secondary`.
    await userEvent.click(screen.getByRole("button", { name: "打开笔记一" }));
    const workspace = document.querySelector(".av-workspace")!;
    expect(workspace.getAttribute("data-av-drill")).toBe("1");

    // Navigation is hidden, not gone: the container carries `hidden` and the
    // roster's subtree — including its effects — is still mounted.
    const navigation = document.querySelector('.av-slot[data-av-slot="navigation"]')!;
    expect(navigation.hasAttribute("hidden")).toBe(true);
    expect(navigation.querySelector('[data-av-panel="roster"]')).toBeTruthy();

    // Type a draft into the note, then drill back out.
    const panelId = document
      .querySelector('.av-slot[data-av-slot="secondary"] .av-panel')!
      .getAttribute("data-av-panel")!;
    await userEvent.type(screen.getByLabelText(`draft-${panelId}`), "窄屏草稿");
    await userEvent.click(screen.getByRole("button", { name: /返回/ }));
    expect(workspace.getAttribute("data-av-drill")).toBeNull();

    // Now `secondary` is the hidden one — and the draft is still in it.
    const secondary = document.querySelector('.av-slot[data-av-slot="secondary"]')!;
    expect(secondary.hasAttribute("hidden")).toBe(true);
    expect((secondary.querySelector(`input[aria-label="draft-${panelId}"]`) as HTMLInputElement).value)
      .toBe("窄屏草稿");
    expect(navigation.hasAttribute("hidden")).toBe(false);

    // Drilling back in reuses the same panel, same draft.
    await userEvent.click(screen.getByRole("button", { name: "打开笔记一" }));
    expect((screen.getByLabelText(`draft-${panelId}`) as HTMLInputElement).value).toBe("窄屏草稿");

    // Nothing unmounted and nothing pretended to close, in either direction.
    expect(RELEASED.filter((row) => row.startsWith("released:"))).toHaveLength(0);
    expect(closed).not.toHaveBeenCalled();
  });
});
