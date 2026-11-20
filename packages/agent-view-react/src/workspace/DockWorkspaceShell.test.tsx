import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState, type ReactNode } from "react";
import {
  DockviewReact,
  type DockviewApi,
  type IDockviewPanelProps,
} from "dockview-react";
import { describe, expect, it, vi } from "vitest";
import {
  COMPOSITION_SCHEMA,
  openResource,
  type AgentComposition,
  type AgentModuleManifest,
} from "@claude-bot/agent-module-contract";
import {
  DockWorkspaceShell,
  createModuleRegistry,
  createWorkspacePlan,
  initialLayout,
  layoutReducer,
  useWorkspace,
  useWorkspaceLayout,
  type MobileSection,
  type ModuleProps,
  type WorkspacePlan,
} from "./index.js";
import { defaultDockPresentation, DOCK_FLOW_PANEL_IDS, type DockPresentation } from "./dock-layout.js";
import {
  applyDockPresentationSizes,
  captureDockGroupBounds,
  dockGroupBoundsChanged,
  mergeDockPresentationGroupSizes,
  rebalanceDockPresentation,
  syncDormantGroups,
  type DockSplitGeometry,
} from "./DockWorkspaceShell.js";

function renderedGroups(node: DockPresentation["root"]): object[] {
  if (node.type === "group") return node.width && node.height ? [{ id: node.id, width: node.width, height: node.height }] : [];
  return node.children.flatMap(renderedGroups);
}

function withRenderedGroupSize(
  node: DockPresentation["root"],
  id: string,
  renderedSize: { width: number; height: number },
): DockPresentation["root"] {
  if (node.type === "group") return node.id === id ? { ...node, ...renderedSize } : node;
  return { ...node, children: node.children.map((child) => withRenderedGroupSize(child, id, renderedSize)) };
}

const NAV: AgentModuleManifest = {
  id: "dock.navigation/v1",
  version: "1.0.0",
  implementation: "test#Navigation",
  title: "导航",
  slots: ["navigation"],
  ports: [],
  opens: [],
};

const CHAT: AgentModuleManifest = {
  id: "dock.chat/v1",
  version: "1.0.0",
  implementation: "test#Chat",
  title: "对话",
  slots: ["primary"],
  ports: [],
  opens: ["chat-session"],
};

const NOTE: AgentModuleManifest = {
  id: "dock.note/v1",
  version: "1.0.0",
  implementation: "test#Note",
  title: "笔记",
  slots: ["secondary"],
  ports: [],
  opens: ["note"],
};

const ALT_NOTE: AgentModuleManifest = {
  id: "dock.alt-note/v1",
  version: "1.0.0",
  implementation: "test#AltNote",
  title: "备忘",
  slots: ["overlay"],
  ports: [],
  opens: ["alt-note"],
};

const STATUS: AgentModuleManifest = {
  id: "dock.status/v1",
  version: "1.0.0",
  implementation: "test#Status",
  title: "状态",
  slots: ["bottom"],
  ports: [],
  opens: [],
};

function Navigation() {
  const workspace = useWorkspace();
  const viewer = workspace.state.panels.find((panel) => panel.panelId === "viewer");
  return (
    <div>
      <button type="button" onClick={() => workspace.open({ kind: "note", ref: "one", label: "笔记一" })}>
        打开笔记一
      </button>
      <button type="button" onClick={() => workspace.open({ kind: "note", ref: "two", label: "笔记二" })}>
        打开笔记二
      </button>
      <button
        type="button"
        onClick={() => workspace.open({ kind: "chat-session", ref: "session-b", label: "会话二" })}
      >
        打开会话
      </button>
      <output aria-label="viewer-resource">{viewer?.resourceRef ?? "empty"}</output>
      <output aria-label="workspace-focused">{workspace.state.focused ?? "none"}</output>
    </div>
  );
}

function Chat() {
  const [draft, setDraft] = useState("");
  return <input aria-label="chat-draft" value={draft} onChange={(event) => setDraft(event.target.value)} />;
}

function Status() {
  return <output aria-label="only-status">ready</output>;
}

const NOTE_MOUNTS: string[] = [];
function Note({ panel }: ModuleProps) {
  const workspace = useWorkspace();
  const [draft, setDraft] = useState("");
  useEffect(() => {
    NOTE_MOUNTS.push(`mount:${panel.panelId}`);
    return () => { NOTE_MOUNTS.push(`unmount:${panel.panelId}`); };
  }, [panel.panelId]);
  return (
    <div>
      <input
        aria-label={`note-draft-${panel.panelId}`}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <button
        type="button"
        aria-label={`mark-dirty-${panel.panelId}`}
        onClick={() => workspace.setDirty?.(panel.panelId, true)}
      >
        标记未保存
      </button>
    </div>
  );
}

function planForDock(): WorkspacePlan {
  const registry = createModuleRegistry([
    { manifest: NAV, component: Navigation },
    { manifest: CHAT, component: Chat },
    { manifest: NOTE, component: Note },
    { manifest: STATUS, component: Status },
  ]);
  const composition: AgentComposition = {
    schema: COMPOSITION_SCHEMA,
    app: "dock-shell-test",
    instances: [
      { instance: "nav", module: NAV.id, slot: "navigation" },
      { instance: "chat", module: CHAT.id, slot: "primary" },
      { instance: "viewer", module: NOTE.id, slot: "secondary" },
      { instance: "status", module: STATUS.id, slot: "bottom" },
    ],
    open: [
      { resource: "note", module: NOTE.id, slot: "secondary" },
      { resource: "chat-session", module: CHAT.id, slot: "primary" },
    ],
  };
  return createWorkspacePlan({ composition, registry });
}

function planForSinglePanel(): WorkspacePlan {
  const registry = createModuleRegistry([{ manifest: CHAT, component: Chat }]);
  return createWorkspacePlan({
    registry,
    composition: {
      schema: COMPOSITION_SCHEMA,
      app: "dock-single-test",
      instances: [{ instance: "chat", module: CHAT.id, slot: "primary" }],
      open: [],
    },
  });
}

function planForBottomOnly(): WorkspacePlan {
  const registry = createModuleRegistry([{ manifest: STATUS, component: Status }]);
  return createWorkspacePlan({
    registry,
    composition: {
      schema: COMPOSITION_SCHEMA,
      app: "dock-bottom-only-test",
      instances: [{ instance: "status", module: STATUS.id, slot: "bottom" }],
      open: [],
    },
  });
}

function planForResourceOnly(): WorkspacePlan {
  const registry = createModuleRegistry([{ manifest: NOTE, component: Note }]);
  return createWorkspacePlan({
    registry,
    composition: {
      schema: COMPOSITION_SCHEMA,
      app: "dock-resource-only-test",
      instances: [{ instance: "viewer", module: NOTE.id, slot: "secondary" }],
      open: [{ resource: "note", module: NOTE.id, slot: "secondary" }],
    },
  });
}

function DockWorkspace({
  narrow = false,
  onPanelClosed,
  initialPresentation,
  onPresentationChange,
  mobileSectionLabels,
  initialMobileSection,
  mobileActions,
}: {
  narrow?: boolean;
  onPanelClosed?: (panelId: string) => void;
  initialPresentation?: DockPresentation;
  onPresentationChange?: (presentation: DockPresentation) => void;
  mobileSectionLabels?: Partial<Record<MobileSection, string>>;
  initialMobileSection?: MobileSection;
  mobileActions?: ReactNode;
}) {
  const plan = planForDock();
  const { state, dispatch, api } = useWorkspaceLayout(plan, { narrow });
  useEffect(() => dispatch({ type: "viewport", narrow }), [dispatch, narrow]);
  return (
    <div style={{ width: 1200, height: 800 }}>
      <DockWorkspaceShell
        plan={plan}
        state={state}
        api={api}
        initialPresentation={initialPresentation}
        onPresentationChange={onPresentationChange}
        onPanelClosed={(panel) => onPanelClosed?.(panel.panelId)}
        {...(mobileSectionLabels ? { mobileSectionLabels } : {})}
        {...(initialMobileSection ? { initialMobileSection } : {})}
        {...(mobileActions ? { mobileActions } : {})}
      />
    </div>
  );
}

const SPLIT_VIEWER_PRESENTATION: DockPresentation = {
  version: 1,
  orientation: "vertical",
  root: {
    type: "split",
    children: [
      {
        type: "split",
        children: [
          { type: "group", panels: [DOCK_FLOW_PANEL_IDS.navigation], size: 280 },
          { type: "group", panels: ["chat"], activePanel: "chat", size: 720 },
          { type: "group", panels: ["viewer"], activePanel: "viewer", size: 400 },
        ],
        size: 780,
      },
      { type: "group", panels: [DOCK_FLOW_PANEL_IDS.bottom], size: 120 },
    ],
  },
  activePanel: "chat",
};

function SinglePanelDockWorkspace() {
  const plan = planForSinglePanel();
  const { state, api } = useWorkspaceLayout(plan);
  return (
    <div style={{ width: 800, height: 600 }}>
      <DockWorkspaceShell plan={plan} state={state} api={api} />
    </div>
  );
}

function BottomOnlyDockWorkspace({ narrow = false }: { narrow?: boolean }) {
  const plan = planForBottomOnly();
  const { state, api } = useWorkspaceLayout(plan, { narrow });
  return (
    <div style={{ width: 800, height: 600 }}>
      <DockWorkspaceShell plan={plan} state={state} api={api} />
    </div>
  );
}

function ResourceOnlyDockWorkspace({ narrow }: { narrow: boolean }) {
  const plan = planForResourceOnly();
  const { state, dispatch, api } = useWorkspaceLayout(plan, { narrow });
  useEffect(() => dispatch({ type: "viewport", narrow }), [dispatch, narrow]);
  return (
    <div style={{ width: 800, height: 600 }}>
      <DockWorkspaceShell plan={plan} state={state} api={api} />
    </div>
  );
}

function ResourceSwapDockWorkspace() {
  const registry = createModuleRegistry([
    { manifest: NOTE, component: Note },
    { manifest: ALT_NOTE, component: Note },
  ]);
  const plan = createWorkspacePlan({
    registry,
    composition: {
      schema: COMPOSITION_SCHEMA,
      app: "dock-resource-swap-test",
      instances: [
        { instance: "viewer", module: NOTE.id, slot: "secondary" },
        { instance: "alternate", module: ALT_NOTE.id, slot: "overlay" },
      ],
      open: [
        { resource: "note", module: NOTE.id, slot: "secondary" },
        { resource: "alt-note", module: ALT_NOTE.id, slot: "overlay" },
      ],
    },
  });
  const { state, api } = useWorkspaceLayout(plan);
  return (
    <div style={{ width: 800, height: 600 }}>
      <button
        type="button"
        onClick={() => api.open({ kind: "alt-note", ref: "alternate-ref", label: "备忘一" })}
      >
        绑定备忘
      </button>
      <button type="button" onClick={() => api.close("alternate")}>清空备忘</button>
      <button
        type="button"
        onClick={() => api.open({ kind: "note", ref: "viewer-ref", label: "笔记一" })}
      >
        绑定笔记
      </button>
      <button type="button" onClick={() => api.close("viewer")}>清空笔记</button>
      <DockWorkspaceShell plan={plan} state={state} api={api} />
    </div>
  );
}

async function clickNavigationAction(label: string): Promise<void> {
  const button = [...document.querySelectorAll<HTMLButtonElement>('[data-av-panel="nav"] button')]
    .find((candidate) => candidate.textContent?.trim() === label);
  if (!button) throw new Error(`navigation action not found: ${label}`);
  // Dockview's renderer="always" uses an off-layout overlay for inactive
  // groups. jsdom has no geometry, so Testing Library considers every such
  // overlay hidden even when a real browser has positioned it. The ordinary
  // DOM click still exercises the React/coordinator boundary under test.
  await act(async () => {
    button.click();
    // A navigation action may lazy-render the newly active module in
    // Dockview's always-mounted overlay. Let that promise commit inside this
    // act scope instead of leaking a false-positive React warning.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("DockWorkspaceShell", () => {
  it("loads a one-group composition through Dockview's branch-root JSON format", async () => {
    render(<SinglePanelDockWorkspace />);
    await waitFor(() => expect(document.querySelector('[data-av-dock-document="chat"]')).toBeTruthy());
    expect(screen.getByLabelText("chat-draft")).toBeInTheDocument();
    expect(document.querySelector("[data-av-dock-reset-notice]")).toBeNull();
  });

  it("loads a bottom-only composition without manufacturing an empty split", async () => {
    render(<BottomOnlyDockWorkspace />);
    await waitFor(() => expect(screen.getByLabelText("only-status")).toHaveTextContent("ready"));
    expect(document.querySelector('[data-av-dock-flow="bottom"]')).toBeTruthy();
    expect(document.querySelector("[data-av-dock-reset-notice]")).toBeNull();
  });

  it("selects the only resource when a resource-only workspace starts or becomes narrow", async () => {
    const initial = render(<ResourceOnlyDockWorkspace narrow />);
    await waitFor(() => expect(document.querySelector(
      '[data-av-dock-workspace][data-av-dock-mobile-section="resource"]',
    )).toBeTruthy());
    expect(document.querySelector('[data-av-dock-mobile-target="resource"]'))
      .toHaveAttribute("aria-selected", "true");
    initial.unmount();

    const responsive = render(<ResourceOnlyDockWorkspace narrow={false} />);
    await waitFor(() => expect(document.querySelector('[data-av-dock-document="viewer"]')).toBeTruthy());
    responsive.rerender(<ResourceOnlyDockWorkspace narrow />);
    await waitFor(() => expect(document.querySelector(
      '[data-av-dock-workspace][data-av-dock-mobile-section="resource"]',
    )).toBeTruthy());
    expect(document.querySelector('[data-av-dock-mobile-target="resource"]'))
      .toHaveAttribute("aria-selected", "true");
  });

  it("makes a bottom-only status surface reachable on a phone", async () => {
    render(<BottomOnlyDockWorkspace narrow />);
    await waitFor(() => expect(document.querySelector(
      '[data-av-dock-workspace][data-av-dock-mobile-section="status"]',
    )).toBeTruthy());
    expect(document.querySelector('[data-av-dock-mobile-target="status"]'))
      .toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("only-status")).toHaveTextContent("ready");
  });

  it("swaps the visible standing document in a resource-only workspace without remounting", async () => {
    NOTE_MOUNTS.length = 0;
    render(<ResourceSwapDockWorkspace />);
    const viewerBefore = await waitFor(() => {
      const value = document.querySelector<HTMLElement>('[data-av-dock-document="viewer"]');
      expect(value).not.toHaveAttribute("hidden");
      return value!;
    });
    const alternateBefore = document.querySelector<HTMLElement>('[data-av-dock-document="alternate"]')!;
    expect(alternateBefore).toHaveAttribute("hidden");
    expect(alternateBefore).toHaveAttribute("aria-hidden", "true");
    expect(alternateBefore).toHaveAttribute("inert");

    await userEvent.click(screen.getByRole("button", { name: "绑定备忘" }));
    await waitFor(() => expect(alternateBefore).not.toHaveAttribute("hidden"));
    expect(viewerBefore).toHaveAttribute("hidden");
    const alternateTab = document.querySelector('[data-av-dock-tab="alternate"]')?.closest<HTMLElement>(".dv-tab");
    const viewerTab = document.querySelector('[data-av-dock-tab="viewer"]')?.closest<HTMLElement>(".dv-tab");
    expect(alternateTab).not.toHaveAttribute("hidden");
    expect(viewerTab).toHaveAttribute("hidden");
    expect(NOTE_MOUNTS).not.toContain("unmount:viewer");
    expect(NOTE_MOUNTS).not.toContain("unmount:alternate");

    await userEvent.click(screen.getByRole("button", { name: "清空备忘" }));
    await waitFor(() => expect(viewerBefore).not.toHaveAttribute("hidden"));
    expect(alternateBefore).toHaveAttribute("hidden");
    expect(document.querySelector('[data-av-dock-document="viewer"]')).toBe(viewerBefore);
    expect(document.querySelector('[data-av-dock-document="alternate"]')).toBe(alternateBefore);
    expect(NOTE_MOUNTS).not.toContain("unmount:viewer");
    expect(NOTE_MOUNTS).not.toContain("unmount:alternate");

    // Document MRU order changes when the first declared surface is focused.
    // Empty resource-only fallback nevertheless follows composition order,
    // rather than making the alternate placeholder appear after close.
    await userEvent.click(screen.getByRole("button", { name: "绑定笔记" }));
    await userEvent.click(screen.getByRole("button", { name: "清空笔记" }));
    await waitFor(() => expect(viewerBefore).not.toHaveAttribute("hidden"));
    expect(alternateBefore).toHaveAttribute("hidden");
  });

  it("renders stable semantic panels and routes tab close through WorkspaceApi", async () => {
    NOTE_MOUNTS.length = 0;
    const closed = vi.fn();
    render(<DockWorkspace onPanelClosed={closed} />);

    await waitFor(() => expect(document.querySelector('[data-av-dock-document="viewer"]')).toBeTruthy());
    const dormantTab = document.querySelector('[data-av-dock-tab="viewer"]')?.closest<HTMLElement>(".dv-tab");
    expect(dormantTab).toHaveAttribute("hidden");
    expect(dormantTab).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("tab", { name: "笔记" })).not.toBeInTheDocument();
    await clickNavigationAction("打开笔记一");
    expect(screen.getByLabelText("viewer-resource")).toHaveTextContent("one");
    const visibleTab = await waitFor(() => {
      const value = document.querySelector<HTMLElement>('[data-av-dock-tab="viewer"]');
      expect(value?.closest(".dv-tab")).not.toHaveAttribute("hidden");
      return value!;
    });
    await userEvent.type(screen.getByLabelText("note-draft-viewer"), "保留草稿");

    const close = visibleTab.querySelector<HTMLElement>(".dv-default-tab-action")!;
    expect(close).toBeTruthy();
    await userEvent.click(close);

    // Declared surfaces clear in the coordinator; Dockview never removes the
    // semantic panel on its own, so its React instance and draft survive.
    await waitFor(() => expect(screen.getByLabelText("viewer-resource")).toHaveTextContent("empty"));
    expect(screen.getByLabelText("note-draft-viewer")).toHaveValue("保留草稿");
    await waitFor(() => expect(
      document.querySelector('[data-av-dock-tab="viewer"]')?.closest(".dv-tab"),
    ).toHaveAttribute("hidden"));
    expect(screen.queryByRole("tab", { name: "笔记" })).not.toBeInTheDocument();
    const chatTab = document.querySelector('[data-av-dock-tab="chat"]');
    expect(
      document.querySelector('[data-av-dock-document="chat"]')?.contains(document.activeElement)
      || chatTab?.closest(".dv-groupview")?.contains(document.activeElement),
    ).toBe(true);
    expect(dormantTab?.contains(document.activeElement)).toBe(false);
    expect(closed).not.toHaveBeenCalled();
    expect(NOTE_MOUNTS).not.toContain("unmount:viewer");
  });

  it("opens the first resource in a right group and reuses that group for later resources", async () => {
    render(<DockWorkspace />);
    const chat = await waitFor(() => {
      const value = document.querySelector<HTMLElement>('[data-av-dock-tab="chat"]');
      expect(value?.closest(".dv-groupview")).toBeTruthy();
      return value!;
    });
    const originalMainGroup = chat.closest(".dv-groupview");
    expect(originalMainGroup).toBeTruthy();

    await clickNavigationAction("打开笔记一");
    const viewer = await waitFor(() => {
      const value = document.querySelector<HTMLElement>('[data-av-dock-tab="viewer"]')!;
      expect(value.closest(".dv-groupview")).not.toBe(originalMainGroup);
      return value;
    });
    const resourceGroup = viewer.closest(".dv-groupview");
    expect(resourceGroup).toBeTruthy();

    await clickNavigationAction("打开笔记二");
    const runtime = await waitFor(() => document.querySelector<HTMLElement>('[data-av-dock-tab="panel-1"]')!);
    expect(runtime.closest(".dv-groupview")).toBe(resourceGroup);
  });

  it("keeps a restored file in the user's shared group, including subsequent file tabs", async () => {
    function RestoredWorkspace() {
      const [plan] = useState(planForDock);
      const [initial] = useState(() => {
        const intent = openResource({ kind: "note", ref: "note-1", label: "笔记一" });
        if (!intent.ok) throw new Error("invalid fixture");
        return layoutReducer(plan)(initialLayout(plan), { type: "open", intent: intent.value });
      });
      const { state, api } = useWorkspaceLayout(plan, { initialState: initial });
      return <DockWorkspaceShell plan={plan} state={state} api={api} initialPresentation={defaultDockPresentation(plan, initial)} />;
    }
    render(<RestoredWorkspace />);
    const sharedGroup = await waitFor(() => {
      const chat = document.querySelector('[data-av-dock-tab="chat"]')?.closest(".dv-groupview");
      const viewer = document.querySelector('[data-av-dock-tab="viewer"]')?.closest(".dv-groupview");
      expect(chat).toBeTruthy();
      expect(viewer).toBe(chat);
      return chat;
    });
    await clickNavigationAction("打开笔记二");
    await waitFor(() => expect(document.querySelector('[data-av-dock-tab="panel-1"]')?.closest(".dv-groupview")).toBe(sharedGroup));
  });

  it("collapses and restores an all-dormant user split without losing its placement", async () => {
    NOTE_MOUNTS.length = 0;
    render(
      <DockWorkspace
        initialPresentation={SPLIT_VIEWER_PRESENTATION}
      />,
    );
    const tab = await waitFor(() => {
      const value = document.querySelector('[data-av-dock-tab="viewer"]')?.closest<HTMLElement>(".dv-tab");
      expect(value).toHaveAttribute("hidden");
      return value!;
    });
    const group = tab.closest<HTMLElement>(".dv-groupview")!;
    expect(group).toHaveAttribute("aria-hidden", "true");
    expect(group).toHaveAttribute("inert");

    await clickNavigationAction("打开笔记一");
    await waitFor(() => expect(tab).not.toHaveAttribute("hidden"));
    expect(tab.closest(".dv-groupview")).toBe(group);
    expect(group).not.toHaveAttribute("aria-hidden");
    expect(group).not.toHaveAttribute("inert");

    await userEvent.click(tab.querySelector<HTMLElement>(".dv-default-tab-action")!);
    await waitFor(() => expect(tab).toHaveAttribute("hidden"));
    expect(tab.closest(".dv-groupview")).toBe(group);
    expect(group).toHaveAttribute("aria-hidden", "true");
    expect(NOTE_MOUNTS).not.toContain("unmount:viewer");

    const sash = document.querySelector<HTMLElement>(".dv-sash")!;
    fireEvent.pointerDown(sash);
    // Dockview tracks a sash drag on document and does not retain pointer
    // capture; the release normally lands over a panel rather than the sash.
    fireEvent.pointerUp(document.body);
  });

  it("maps a user-selected document tab back to coordinator focus", async () => {
    const closed = vi.fn();
    render(<DockWorkspace onPanelClosed={closed} />);
    await clickNavigationAction("打开笔记一");
    await clickNavigationAction("打开笔记二");

    await waitFor(() => expect(document.querySelector('[data-av-dock-tab="panel-1"]')).toBeTruthy());
    await userEvent.click(document.querySelector<HTMLElement>('[data-av-dock-tab="viewer"]')!);
    await waitFor(() => expect(screen.getByLabelText("workspace-focused")).toHaveTextContent("viewer"));

    const runtimeTab = document.querySelector<HTMLElement>('[data-av-dock-tab="panel-1"]')!;
    await userEvent.click(runtimeTab.querySelector<HTMLElement>(".dv-default-tab-action")!);
    await waitFor(() => expect(closed).toHaveBeenCalledWith("panel-1"));
    expect(document.querySelector('[data-av-dock-document="panel-1"]')).toBeNull();
  });

  it("negotiates a dirty tab close without removing or remounting it until discard", async () => {
    NOTE_MOUNTS.length = 0;
    const closed = vi.fn();
    render(<DockWorkspace onPanelClosed={closed} />);
    await clickNavigationAction("打开笔记一");
    await clickNavigationAction("打开笔记二");

    await waitFor(() => expect(document.querySelector('[data-av-dock-tab="panel-1"]')).toBeTruthy());
    const documentBefore = document.querySelector<HTMLElement>('[data-av-dock-document="panel-1"]')!;
    const draftBefore = screen.getByLabelText("note-draft-panel-1");
    await userEvent.type(draftBefore, "还没保存");
    await userEvent.click(screen.getByLabelText("mark-dirty-panel-1"));
    const runtimeTab = document.querySelector<HTMLElement>('[data-av-dock-tab="panel-1"]')!;
    await waitFor(() => expect(runtimeTab).toHaveAttribute("data-av-dirty", "1"));

    await userEvent.click(runtimeTab.querySelector<HTMLElement>(".dv-default-tab-action")!);
    expect(await screen.findByRole("alertdialog", { name: /笔记二/ })).toBeInTheDocument();
    expect(screen.getByRole("alertdialog")).toHaveTextContent("不会撤销已经提交到可信审批栏的操作");
    expect(document.querySelector('[data-av-dock-document="panel-1"]')).toBe(documentBefore);
    expect(screen.getByLabelText("note-draft-panel-1")).toBe(draftBefore);
    expect(draftBefore).toHaveValue("还没保存");
    expect(closed).not.toHaveBeenCalled();
    expect(NOTE_MOUNTS).not.toContain("unmount:panel-1");

    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(document.querySelector('[data-av-dock-document="panel-1"]')).toBe(documentBefore);
    expect(screen.getByLabelText("note-draft-panel-1")).toBe(draftBefore);
    expect(draftBefore).toHaveValue("还没保存");
    expect(closed).not.toHaveBeenCalled();
    expect(NOTE_MOUNTS).not.toContain("unmount:panel-1");

    await userEvent.click(runtimeTab.querySelector<HTMLElement>(".dv-default-tab-action")!);
    expect(await screen.findByRole("alertdialog", { name: /笔记二/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "放弃本地草稿并关闭" }));

    await waitFor(() => expect(document.querySelector('[data-av-dock-document="panel-1"]')).toBeNull());
    await waitFor(() => expect(closed).toHaveBeenCalledWith("panel-1"));
    expect(NOTE_MOUNTS).toContain("unmount:panel-1");
  });

  it("routes Dockview's Delete and Backspace shortcuts through dirty-close negotiation", async () => {
    NOTE_MOUNTS.length = 0;
    const closed = vi.fn();
    render(<DockWorkspace onPanelClosed={closed} />);
    await clickNavigationAction("打开笔记一");
    await clickNavigationAction("打开笔记二");

    await waitFor(() => expect(document.querySelector('[data-av-dock-tab="panel-1"]')).toBeTruthy());
    const documentBefore = document.querySelector<HTMLElement>('[data-av-dock-document="panel-1"]')!;
    const draftBefore = screen.getByLabelText("note-draft-panel-1");
    await userEvent.type(draftBefore, "键盘草稿");
    await userEvent.click(screen.getByLabelText("mark-dirty-panel-1"));
    const dockTab = document.querySelector<HTMLElement>('[data-av-dock-tab="panel-1"]')!
      .closest<HTMLElement>(".dv-tab")!;

    dockTab.focus();
    await userEvent.keyboard("{Delete}");
    expect(await screen.findByRole("alertdialog", { name: /笔记二/ })).toBeInTheDocument();
    expect(document.querySelector('[data-av-dock-document="panel-1"]')).toBe(documentBefore);
    expect(screen.getByLabelText("note-draft-panel-1")).toBe(draftBefore);
    expect(draftBefore).toHaveValue("键盘草稿");
    expect(closed).not.toHaveBeenCalled();
    expect(NOTE_MOUNTS).not.toContain("unmount:panel-1");

    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(document.activeElement).toBe(dockTab));
    dockTab.focus();
    await userEvent.keyboard("{Backspace}");
    expect(await screen.findByRole("alertdialog", { name: /笔记二/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "放弃本地草稿并关闭" }));
    await waitFor(() => expect(document.querySelector('[data-av-dock-document="panel-1"]')).toBeNull());
    await waitFor(() => expect(closed).toHaveBeenCalledWith("panel-1"));
  });

  it("routes middle-click close through the same dirty guard", async () => {
    const closed = vi.fn();
    render(<DockWorkspace onPanelClosed={closed} />);
    await clickNavigationAction("打开笔记一");
    await clickNavigationAction("打开笔记二");

    const dockTab = await waitFor(() => {
      const value = document.querySelector<HTMLElement>('[data-av-dock-tab="panel-1"]')
        ?.closest<HTMLElement>(".dv-tab");
      expect(value).toBeTruthy();
      return value!;
    });
    await userEvent.click(screen.getByLabelText("mark-dirty-panel-1"));
    fireEvent(dockTab, new MouseEvent("auxclick", {
      bubbles: true,
      cancelable: true,
      button: 1,
    }));

    expect(await screen.findByRole("alertdialog", { name: /笔记二/ })).toBeInTheDocument();
    expect(document.querySelector('[data-av-dock-document="panel-1"]')).toBeTruthy();
    expect(closed).not.toHaveBeenCalled();
  });

  it("hands keyboard focus to the surviving tab after a declared document closes", async () => {
    render(<DockWorkspace />);
    await clickNavigationAction("打开笔记一");

    const viewerTab = await waitFor(() => {
      const value = document.querySelector('[data-av-dock-tab="viewer"]')?.closest<HTMLElement>(".dv-tab");
      expect(value).toBeTruthy();
      return value!;
    });
    viewerTab.focus();
    await userEvent.keyboard("{Delete}");

    await waitFor(() => expect(viewerTab).toHaveAttribute("hidden"));
    const chatTab = document.querySelector('[data-av-dock-tab="chat"]')?.closest<HTMLElement>(".dv-tab");
    expect(chatTab).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(chatTab));
    expect(document.activeElement).not.toBe(document.body);
  });

  it("keeps an empty standing surface mounted but out of the tab accessibility tree", async () => {
    NOTE_MOUNTS.length = 0;
    const closed = vi.fn();
    render(<DockWorkspace onPanelClosed={closed} />);
    const documentBefore = document.querySelector<HTMLElement>('[data-av-dock-document="viewer"]')!;
    expect(documentBefore).toHaveAttribute("hidden");
    expect(documentBefore).toHaveAttribute("aria-hidden", "true");
    expect(documentBefore).toHaveAttribute("inert");
    const dormantTab = document.querySelector('[data-av-dock-tab="viewer"]')?.closest<HTMLElement>(".dv-tab");
    expect(dormantTab).toHaveAttribute("hidden");
    expect(dormantTab).toHaveAttribute("aria-hidden", "true");
    expect(dormantTab).toHaveAttribute("inert");
    expect(screen.queryByRole("tab", { name: "笔记" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "note-draft-viewer" })).not.toBeInTheDocument();
    expect(document.querySelector('[data-av-dock-document="viewer"]')).toBe(documentBefore);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(closed).not.toHaveBeenCalled();
    expect(NOTE_MOUNTS).not.toContain("unmount:viewer");
  });

  it("routes tab and group keyboard navigation around dormant surfaces", async () => {
    const changed = vi.fn();
    render(<DockWorkspace onPresentationChange={changed} />);
    await clickNavigationAction("打开笔记一");
    await clickNavigationAction("打开笔记二");
    const host = await waitFor(() => {
      const value = document.querySelector<HTMLElement>("[data-av-dock-host]");
      expect(value).toBeTruthy();
      return value!;
    });
    const viewerTab = document.querySelector('[data-av-dock-tab="viewer"]')?.closest<HTMLElement>(".dv-tab")!;
    await userEvent.click(viewerTab.querySelector<HTMLElement>(".dv-default-tab-action")!);
    await waitFor(() => expect(viewerTab).toHaveAttribute("hidden"));
    expect(screen.getByLabelText("workspace-focused")).toHaveTextContent("panel-1");
    changed.mockClear();
    fireEvent.keyDown(host, { key: "]", ctrlKey: true });
    await waitFor(() => expect(screen.getByLabelText("workspace-focused")).toHaveTextContent("panel-1"));
    fireEvent.keyDown(host, { key: "[", ctrlKey: true });
    await waitFor(() => expect(screen.getByLabelText("workspace-focused")).toHaveTextContent("panel-1"));

    fireEvent.keyDown(host, { key: "F6" });
    await waitFor(() => expect(screen.getByLabelText("workspace-focused")).toHaveTextContent("nav"));
    fireEvent.keyDown(host, { key: "F6" });
    await waitFor(() => expect(screen.getByLabelText("workspace-focused")).toHaveTextContent("chat"));
    await waitFor(() => expect(changed.mock.lastCall?.[0]).toMatchObject({ activePanel: "chat" }));
    fireEvent.keyDown(host, { key: "F6" });
    await waitFor(() => expect(screen.getByLabelText("workspace-focused")).toHaveTextContent("status"));
    fireEvent.keyDown(host, { key: "F6" });
    await waitFor(() => expect(screen.getByLabelText("workspace-focused")).toHaveTextContent("panel-1"));

    fireEvent.keyDown(host, { key: "\\", ctrlKey: true, shiftKey: true });
    expect(document.querySelector('[data-av-dock-tab="panel-1"]')?.closest(".dv-tab"))
      .toBe(document.activeElement);
    for (const init of [
      { key: "ArrowRight", ctrlKey: true, shiftKey: true },
      { key: "ArrowLeft", ctrlKey: true, shiftKey: true },
    ]) fireEvent.keyDown(host, init);
    expect(viewerTab).toHaveAttribute("hidden");
    expect(screen.getByLabelText("workspace-focused")).not.toHaveTextContent("viewer");
  });

  it("jumps to the layer an accepted open landed in", async () => {
    // Ticket #189's opening complaint. A phone paints one layer, so tapping a
    // row in the rail used to change what the HIDDEN layer showed and leave
    // the reader looking at the rail. The coordinator focuses the panel it
    // opened; this shell is the only thing that knows which layer that is.
    render(<DockWorkspace narrow />);
    await waitFor(() => expect(document.querySelector('[data-av-dock-mobile-section="main"]')).toBeTruthy());
    await userEvent.click(screen.getByRole("tab", { name: "导航" }));
    await waitFor(() => expect(
      document.querySelector('[data-av-dock-mobile-section="navigation"]'),
    ).toBeTruthy());

    await clickNavigationAction("打开笔记一");
    await waitFor(() => expect(document.querySelector('[data-av-dock-mobile-section="resource"]')).toBeTruthy());
    expect(screen.queryByRole("button", { name: /返回|回到主区/ })).toBeNull();

    // A still-open resource must not win when the reader explicitly moves
    // main -> navigation. This is the exact route used by the phone bar.
    await userEvent.click(screen.getByRole("tab", { name: "主区" }));
    await waitFor(() => expect(document.querySelector('[data-av-dock-mobile-section="main"]')).toBeTruthy());
    await userEvent.click(screen.getByRole("tab", { name: "导航" }));
    await waitFor(() => expect(
      document.querySelector('[data-av-dock-mobile-section="navigation"]'),
    ).toBeTruthy());

    // And back the other way, without finding a tab strip or a back button:
    // a session opens into the chat layer from wherever the tap happened.
    await clickNavigationAction("打开会话");
    await waitFor(() => expect(document.querySelector('[data-av-dock-mobile-section="main"]')).toBeTruthy());
    expect(screen.queryByRole("button", { name: /回到主区/ })).toBeNull();
  });

  it("honours a composition's narrow landing layer", async () => {
    render(<DockWorkspace narrow initialMobileSection="navigation" />);
    await waitFor(() => expect(
      document.querySelector('[data-av-dock-mobile-section="navigation"]'),
    ).toBeTruthy());
    expect(screen.getByRole("tab", { name: "导航" })).toHaveAttribute("aria-selected", "true");
  });

  it("jumps to main when a standing chat panel is rebound from navigation", async () => {
    render(<DockWorkspace narrow initialMobileSection="navigation" />);
    await waitFor(() => expect(
      document.querySelector('[data-av-dock-mobile-section="navigation"]'),
    ).toBeTruthy());
    expect(screen.getByLabelText("workspace-focused")).toHaveTextContent("chat");

    await clickNavigationAction("打开会话");

    await waitFor(() => expect(
      document.querySelector('[data-av-dock-mobile-section="main"]'),
    ).toBeTruthy());
    expect(screen.getByRole("tab", { name: "主区" })).toHaveAttribute("aria-selected", "true");
  });

  it("gives a phone button only to a layer this composition declares", async () => {
    // A permanently disabled control in a four-across bar reads as something
    // broken rather than as something absent — which is exactly how the ticket
    // reports the status button of an App that stands no `bottom` instance.
    const resourceOnly = render(<ResourceOnlyDockWorkspace narrow />);
    await waitFor(() => expect(document.querySelector('[data-av-dock-mobile-target="resource"]')).toBeTruthy());
    expect(document.querySelectorAll("[data-av-dock-mobile-target]")).toHaveLength(1);
    resourceOnly.unmount();

    render(
      <DockWorkspace
        narrow
        mobileSectionLabels={{ main: "会话", resource: "文件" }}
        mobileActions={<button type="button">刷新</button>}
      />,
    );
    await waitFor(() => expect(document.querySelector('[data-av-dock-mobile-target="main"]')).toBeTruthy());
    expect(document.querySelectorAll("[data-av-dock-mobile-target]")).toHaveLength(4);
    // Composition names beat slot names, and the App's own chrome rides along.
    expect(screen.getByRole("tab", { name: "会话" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "文件" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "导航" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "刷新" })).toBeInTheDocument();
  });

  it("uses a phone region switch without remounting hidden module subtrees", async () => {
    NOTE_MOUNTS.length = 0;
    const mounted = render(<DockWorkspace narrow />);
    const chatBefore = screen.getByLabelText("chat-draft");
    await userEvent.type(chatBefore, "未发出的消息");
    await userEvent.click(screen.getByRole("tab", { name: "导航" }));
    await clickNavigationAction("打开笔记一");

    await waitFor(() => expect(document.querySelector('[data-av-dock-mobile-section="resource"]')).toBeTruthy());
    const chatTab = document.querySelector('[data-av-dock-tab="chat"]')?.closest<HTMLElement>(".dv-tab")!;
    const viewerTab = document.querySelector('[data-av-dock-tab="viewer"]')?.closest<HTMLElement>(".dv-tab")!;
    expect(chatTab).toHaveAttribute("hidden");
    expect(viewerTab).not.toHaveAttribute("hidden");
    expect(viewerTab).toHaveClass("dv-active-tab");
    const resourceRegionTab = document.querySelector<HTMLElement>('[data-av-dock-mobile-target="resource"]')!;
    const resourcePanelId = resourceRegionTab.getAttribute("aria-controls");
    expect(resourcePanelId).toBeTruthy();
    expect(document.getElementById(resourcePanelId!)).toHaveAttribute(
      "aria-labelledby",
      "av-dock-mobile-tab-resource",
    );

    // ── One document per family on a phone (ticket #189) ──────────────────
    //
    // A second note used to mint `panel-1` and put a second tab in the least
    // reachable chrome a small screen has. It now REBINDS the one resource
    // panel: same panel id, same mounted subtree (so the module's own state
    // survives), a new resource, and a tab strip with nothing to show.
    await clickNavigationAction("打开笔记二");
    await waitFor(() => expect(screen.getByLabelText("viewer-resource")).toHaveTextContent("two"));
    expect(document.querySelector('[data-av-dock-document="panel-1"]')).toBeNull();
    expect(NOTE_MOUNTS).not.toContain("unmount:viewer");
    expect(document.querySelector('[data-av-dock-mobile-section="resource"]')).toBeTruthy();
    expect(chatTab).toHaveAttribute("hidden");
    await waitFor(() => expect(
      viewerTab.closest(".dv-groupview")?.getAttribute("data-av-dock-mobile-visible-tabs"),
    ).toBe("1"));

    expect(screen.queryByRole("button", { name: /回到主区/ })).toBeNull();
    await userEvent.click(screen.getByRole("tab", { name: "主区" }));
    await waitFor(() => expect(document.querySelector('[data-av-dock-mobile-section="main"]')).toBeTruthy());
    await waitFor(() => expect(chatTab).not.toHaveAttribute("hidden"));
    expect(viewerTab).toHaveAttribute("hidden");
    expect(chatTab).toHaveClass("dv-active-tab");
    const mainRegionTab = document.querySelector<HTMLElement>('[data-av-dock-mobile-target="main"]')!;
    const mainPanelId = mainRegionTab.getAttribute("aria-controls");
    expect(mainPanelId).toBeTruthy();
    expect(document.getElementById(mainPanelId!)).toHaveAttribute(
      "aria-labelledby",
      "av-dock-mobile-tab-main",
    );
    const chatAfter = screen.getByLabelText("chat-draft");
    expect(chatAfter).toBe(chatBefore);
    expect(chatAfter).toHaveValue("未发出的消息");

    await userEvent.click(document.querySelector<HTMLElement>('[data-av-dock-mobile-target="status"]')!);
    await waitFor(() => expect(document.querySelector('[data-av-dock-mobile-section="status"]')).toBeTruthy());
    expect(screen.getByLabelText("only-status")).toHaveTextContent("ready");
    await userEvent.click(document.querySelector<HTMLElement>('[data-av-dock-mobile-target="main"]')!);
    await waitFor(() => expect(document.querySelector('[data-av-dock-mobile-section="main"]')).toBeTruthy());
    expect(screen.getByLabelText("chat-draft")).toBe(chatBefore);
    expect(chatBefore).toHaveValue("未发出的消息");

    const flowContentIds = ["navigation", "status"].map((section) =>
      document.querySelector(`[data-av-dock-mobile-target="${section}"]`)?.getAttribute("aria-controls"),
    );
    expect(flowContentIds.every(Boolean)).toBe(true);
    mounted.rerender(<DockWorkspace narrow={false} />);
    await waitFor(() => expect(document.querySelector("[data-av-narrow]")).toBeNull());
    for (const contentId of flowContentIds) {
      const content = document.getElementById(contentId!);
      const activeTab = content?.closest(".dv-groupview")?.querySelector<HTMLElement>(".dv-tab.dv-active-tab");
      expect(content).toBeTruthy();
      expect(activeTab).toBeTruthy();
      expect(content?.getAttribute("aria-labelledby")).toBe(activeTab?.id);
      expect(content?.getAttribute("aria-labelledby")?.includes("av-dock-mobile-tab-")).toBe(false);
    }
  });
});

describe("Dockview renderer invariant", () => {
  it("stores the navigation and document split in presentation before one layout-effect write", () => {
    const navigationSize = vi.fn();
    const sourceSize = vi.fn();
    const targetSize = vi.fn();
    const navigation = {
      id: "navigation",
      isVisible: true,
      api: { boundingBox: { left: 0, top: 0, width: 280, height: 600 }, setSize: navigationSize },
      panels: [],
    };
    const source = {
      id: "main",
      isVisible: true,
      api: { boundingBox: { left: 286, top: 0, width: 357, height: 600 }, setSize: sourceSize },
      panels: [],
    };
    const target = {
      id: "right",
      isVisible: true,
      api: { boundingBox: { left: 649, top: 0, width: 357, height: 600 }, setSize: targetSize },
      panels: [],
    };
    const dockApi = {
      groups: [navigation, source, target],
      getPanel: (id: string) => id === DOCK_FLOW_PANEL_IDS.navigation
        ? { group: navigation }
        : id === "viewer"
          ? { group: target }
          : undefined,
    } as unknown as DockviewApi;
    const geometry: DockSplitGeometry = {
      panelId: "viewer",
      sourceGroupId: "main",
      sourceWidth: 720,
      sourceHeight: 600,
    };
    const presentation: DockPresentation = {
      version: 1,
      orientation: "horizontal",
      root: {
        type: "split",
        children: [
          {
            type: "group",
            id: "navigation",
            panels: [DOCK_FLOW_PANEL_IDS.navigation],
            width: 280,
            height: 600,
            size: 333,
          },
          { type: "group", id: "main", panels: ["chat"], size: 460 },
          { type: "group", id: "right", panels: ["viewer"], size: 260 },
        ],
      },
    };

    const next = rebalanceDockPresentation(presentation, dockApi, geometry);
    navigation.api.boundingBox.width = 333;
    applyDockPresentationSizes(dockApi, next);

    expect(renderedGroups(next.root)).toEqual([
      { id: "navigation", width: 280, height: 600 },
      { id: "main", width: 360, height: 600 },
      { id: "right", width: 360, height: 600 },
    ]);
    expect(navigationSize).toHaveBeenCalledWith({ width: 280 });
    expect(sourceSize).toHaveBeenCalledWith({ width: 360 });
    expect(targetSize).not.toHaveBeenCalled();
  });

  it("preserves live rail pixels on the first resource split before a presentation owns sizes", () => {
    const navigationSize = vi.fn();
    const mainSize = vi.fn();
    const resourceSize = vi.fn();
    // Browser regression: 317 + 927 was redistributed into three 412px groups
    // before the first presentation capture. That capture must not own the rail.
    const navigation = { id: "nav", isVisible: true,
      api: { boundingBox: { left: 0, top: 0, width: 412, height: 627 }, setSize: navigationSize } };
    const main = { id: "main", isVisible: true,
      api: { boundingBox: { left: 418, top: 0, width: 460, height: 627 }, setSize: mainSize } };
    const resource = { id: "resource", isVisible: true,
      api: { boundingBox: { left: 884, top: 0, width: 366, height: 627 }, setSize: resourceSize } };
    const dockApi = {
      groups: [navigation, main, resource],
      getPanel: (id: string) => id === "viewer" ? { group: resource } : undefined,
    } as unknown as DockviewApi;
    const captured: DockPresentation = {
      version: 1, orientation: "horizontal",
      root: { type: "split", children: [
        { type: "group", id: "nav", panels: [DOCK_FLOW_PANEL_IDS.navigation], width: 412, height: 627 },
        { type: "group", id: "main", panels: ["chat"], width: 412, height: 627 },
        { type: "group", id: "resource", panels: ["viewer"], width: 412, height: 627 },
      ] },
    };
    const next = rebalanceDockPresentation(captured, dockApi, {
      panelId: "viewer", sourceGroupId: "main", sourceWidth: 927, sourceHeight: 627,
      groupBounds: [
        { id: "nav", width: 317, height: 627 },
        { id: "main", width: 927, height: 627 },
      ],
    });
    expect(renderedGroups(next.root)).toEqual([
      { id: "nav", width: 317, height: 627 },
      { id: "main", width: 464, height: 627 },
      { id: "resource", width: 464, height: 627 },
    ]);
    applyDockPresentationSizes(dockApi, next);
    expect(navigationSize).toHaveBeenCalledWith({ width: 317 });
    expect(mainSize).toHaveBeenCalledWith({ width: 464 });
    expect(resourceSize).not.toHaveBeenCalled();
  });

  it("keeps a file sash size by group id when another document joins and groups reorder", () => {
    const setResourceSize = vi.fn();
    const setMainSize = vi.fn();
    const setNavigationSize = vi.fn();
    const groups = [
      {
        id: "resource",
        isVisible: true,
        api: { boundingBox: { left: 0, top: 0, width: 350, height: 600 }, setSize: setResourceSize },
      },
      {
        id: "main",
        isVisible: true,
        api: { boundingBox: { left: 356, top: 0, width: 350, height: 600 }, setSize: setMainSize },
      },
      {
        id: "navigation",
        isVisible: true,
        api: { boundingBox: { left: 712, top: 0, width: 350, height: 600 }, setSize: setNavigationSize },
      },
    ];
    const dockApi = { groups } as unknown as DockviewApi;
    const current: DockPresentation = {
      version: 1,
      orientation: "horizontal",
      root: {
        type: "split",
        children: [
          {
            type: "group",
            id: "navigation",
            panels: [DOCK_FLOW_PANEL_IDS.navigation],
            width: 280,
            height: 600,
          },
          { type: "group", id: "main", panels: ["chat"], width: 430, height: 600 },
          { type: "group", id: "resource", panels: ["viewer"], width: 290, height: 600 },
        ],
      },
    };
    const capturedAfterJoin: DockPresentation = {
      ...current,
      root: {
        type: "split",
        children: [
          { type: "group", id: "resource", panels: ["viewer", "editor"], width: 350, height: 600 },
          { type: "group", id: "main", panels: ["chat"], width: 350, height: 600 },
          {
            type: "group",
            id: "navigation",
            panels: [DOCK_FLOW_PANEL_IDS.navigation],
            width: 350,
            height: 600,
          },
        ],
      },
    };

    const next = mergeDockPresentationGroupSizes(capturedAfterJoin, current, false);
    applyDockPresentationSizes(dockApi, next);

    expect(renderedGroups(next.root)).toEqual([
      { id: "resource", width: 290, height: 600 },
      { id: "main", width: 430, height: 600 },
      { id: "navigation", width: 280, height: 600 },
    ]);
    expect(setResourceSize).toHaveBeenCalledWith({ width: 290 });
    expect(setMainSize).toHaveBeenCalledWith({ width: 430 });
    expect(setNavigationSize).not.toHaveBeenCalled();
  });

  it("keeps the current navigation width when a resource group becomes dormant", () => {
    const navigationSize = vi.fn(({ width }: { width: number }) => {
      navigation.api.boundingBox.width = width;
    });
    const navigation = {
      id: "navigation",
      isVisible: true,
      api: {
        boundingBox: { left: 0, top: 0, width: 320, height: 600 },
        setSize: navigationSize,
      },
      element: document.createElement("div"),
      panels: [{ id: DOCK_FLOW_PANEL_IDS.navigation }],
    };
    const main = {
      id: "main",
      isVisible: true,
      api: { boundingBox: { left: 326, top: 0, width: 540, height: 600 }, setSize: vi.fn() },
      element: document.createElement("div"),
      panels: [{ id: "chat" }],
      activePanel: { id: "chat" },
    };
    const resource = {
      id: "resource",
      isVisible: true,
      api: {
        boundingBox: { left: 872, top: 0, width: 540, height: 600 },
        setSize: vi.fn(),
        setVisible: vi.fn((visible: boolean) => {
          resource.isVisible = visible;
          // Dockview gives the newly free rectangle to an earlier sibling.
          navigation.api.boundingBox.width = 860;
        }),
      },
      element: document.createElement("div"),
      panels: [{ id: "viewer" }],
      activePanel: { id: "viewer" },
    };
    const panels = new Map([
      [DOCK_FLOW_PANEL_IDS.navigation, { group: navigation }],
      ["chat", { group: main, api: { setActive: vi.fn() } }],
      ["viewer", { group: resource, api: { setActive: vi.fn() } }],
    ]);
    const dockApi = {
      groups: [navigation, main, resource],
      activeGroup: main,
      activePanel: { id: "chat" },
      getPanel: (id: string) => panels.get(id),
      hasMaximizedGroup: () => false,
    } as unknown as DockviewApi;
    const projection = {
      items: [
        {
          kind: "flow" as const,
          dockId: DOCK_FLOW_PANEL_IDS.navigation,
          flowSlot: "navigation" as const,
          title: "导航",
          defaultGroup: "navigation" as const,
          declared: true as const,
        },
        {
          kind: "document" as const,
          dockId: "chat",
          panelId: "chat",
          title: "会话",
          slot: "primary" as const,
          defaultGroup: "primary" as const,
          dormant: false,
          declared: true,
        },
        {
          kind: "document" as const,
          dockId: "viewer",
          panelId: "viewer",
          title: "资源",
          slot: "secondary" as const,
          defaultGroup: "resource" as const,
          dormant: true,
          declared: true,
        },
      ],
      activeDockId: "chat",
    };

    syncDormantGroups(dockApi, projection);

    expect(resource.api.setVisible).toHaveBeenCalledWith(false);
    expect(navigationSize).not.toHaveBeenCalled();
    const presentation: DockPresentation = {
      version: 1,
      orientation: "horizontal",
      root: {
        type: "split",
        children: [
          { type: "group", id: "navigation", panels: [DOCK_FLOW_PANEL_IDS.navigation], size: 320 },
          { type: "group", id: "main", panels: ["chat"], size: 540 },
          { type: "group", id: "resource", panels: ["viewer"], size: 540 },
        ],
      },
    };
    applyDockPresentationSizes(dockApi, presentation);
    expect(navigationSize).toHaveBeenCalledWith({ width: 320 });
    expect(navigation.api.boundingBox.width).toBe(320);

    // A later sash gesture replaces the App-owned size. Dormancy itself still
    // never writes geometry; the same layout-effect bridge applies the update.
    navigation.api.boundingBox.width = 260;
    syncDormantGroups(dockApi, projection);
    applyDockPresentationSizes(dockApi, {
      ...presentation,
      root: withRenderedGroupSize(presentation.root, "navigation", { width: 240, height: 600 }),
    });
    expect(navigationSize).toHaveBeenLastCalledWith({ width: 240 });
    expect(navigationSize).toHaveBeenCalledTimes(2);
  });

  it("detects pointer-owned group sizes through the public Dockview geometry API", () => {
    const group = {
      id: "main",
      isVisible: true,
      api: { boundingBox: { left: 280, top: 0, width: 500, height: 600 } },
    };
    const dockApi = { groups: [group] } as unknown as DockviewApi;
    const before = captureDockGroupBounds(dockApi);
    group.api.boundingBox.width = 420;
    const after = captureDockGroupBounds(dockApi);

    expect(dockGroupBoundsChanged(before, after)).toBe(true);
    expect(after).toEqual([{ id: "main", width: 420, height: 600 }]);
    expect(JSON.stringify(after)).not.toContain("dv-");
  });

  it("keeps an always-rendered subtree mounted and does not report close across move or reorder", async () => {
    let dockApi: DockviewApi | undefined;
    let mounts = 0;
    let unmounts = 0;
    const panelClosed = vi.fn();

    function Probe({ params }: IDockviewPanelProps) {
      const panelId = String(params.panelId);
      useEffect(() => {
        mounts += 1;
        return () => {
          unmounts += 1;
          panelClosed(panelId);
        };
      }, [panelId]);
      return <div data-testid={`move-probe-${panelId}`}>{panelId}</div>;
    }

    render(
      <div style={{ width: 900, height: 600 }}>
        <DockviewReact
          components={{ probe: Probe }}
          defaultRenderer="always"
          disableFloatingGroups
          onReady={(event) => {
            dockApi = event.api;
            event.api.addPanel({
              id: "one",
              component: "probe",
              renderer: "always",
              params: { panelId: "one" },
            });
            event.api.addPanel({
              id: "two",
              component: "probe",
              renderer: "always",
              params: { panelId: "two" },
              position: { referencePanel: "one", direction: "right" },
            });
          }}
        />
      </div>,
    );
    await waitFor(() => expect(dockApi?.getPanel("two")).toBeTruthy());
    const before = screen.getByTestId("move-probe-one");
    expect(mounts).toBe(2);

    act(() => {
      const first = dockApi!.getPanel("one")!;
      const second = dockApi!.getPanel("two")!;
      first.api.moveTo({ group: second.group, position: "center" });
    });

    await waitFor(() => expect(dockApi!.getPanel("one")!.group.id).toBe(dockApi!.getPanel("two")!.group.id));
    act(() => {
      const first = dockApi!.getPanel("one")!;
      const second = dockApi!.getPanel("two")!;
      first.api.moveTo({ group: second.group, position: "center", index: 0 });
    });

    expect(screen.getByTestId("move-probe-one")).toBe(before);
    expect(mounts).toBe(2);
    expect(unmounts).toBe(0);
    expect(panelClosed).not.toHaveBeenCalled();
  });
});
