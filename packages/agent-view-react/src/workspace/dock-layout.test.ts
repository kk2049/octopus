import { describe, expect, it } from "vitest";
import {
  COMPOSITION_SCHEMA,
  type AgentComposition,
  type AgentModuleManifest,
} from "@claude-bot/agent-module-contract";
import {
  createModuleRegistry,
  createWorkspacePlan,
  initialLayout,
  type WorkspacePlan,
} from "./index.js";
import {
  DOCK_DOCUMENT_COMPONENT,
  DOCK_FLOW_COMPONENT,
  DOCK_FLOW_PANEL_IDS,
  DOCK_PRESENTATION_LIMITS,
  DEFAULT_DOCK_GROUP_IDS,
  captureDockPresentation,
  decodeDockPresentation,
  defaultDockPresentation,
  dockPresentationScope,
  encodeDockPresentation,
  materializeDockPresentation,
  projectDockLayout,
  readDockPresentation,
  type DockPresentation,
} from "./dock-layout.js";

function manifest(
  id: string,
  slots: AgentModuleManifest["slots"],
  opens: AgentModuleManifest["opens"] = [],
): AgentModuleManifest {
  return { id, version: "1.0.0", implementation: `test#${id}`, title: id, slots, ports: [], opens };
}

const NAV = manifest("test.navigation/v1", ["navigation"]);
const CHAT = manifest("test.chat/v1", ["primary"]);
const VIEWER = manifest("test.viewer/v1", ["secondary"], ["file"]);
const EDITOR = manifest("test.editor/v1", ["overlay"], ["file"]);
const OPS = manifest("test.operations/v1", ["bottom"]);

function planForDock(): WorkspacePlan {
  const registry = createModuleRegistry([NAV, CHAT, VIEWER, EDITOR, OPS].map((row) => ({
    manifest: row,
    component: () => null,
  })));
  const composition: AgentComposition = {
    schema: COMPOSITION_SCHEMA,
    app: "dock-test",
    instances: [
      { instance: "nav", module: NAV.id, slot: "navigation" },
      { instance: "chat", module: CHAT.id, slot: "primary" },
      { instance: "viewer", module: VIEWER.id, slot: "secondary" },
      { instance: "editor", module: EDITOR.id, slot: "overlay" },
      { instance: "ops", module: OPS.id, slot: "bottom" },
    ],
    open: [
      { resource: "file", module: VIEWER.id, slot: "secondary" },
      { resource: "file", module: EDITOR.id, slot: "overlay" },
    ],
  };
  return createWorkspacePlan({ composition, registry });
}

function groups(node: DockPresentation["root"]): Extract<DockPresentation["root"], { type: "group" }>[] {
  return node.type === "group" ? [node] : node.children.flatMap(groups);
}

function withGroupSizes(
  node: DockPresentation["root"],
  sizes: Readonly<Record<string, { width: number; height: number }>>,
): DockPresentation["root"] {
  if (node.type === "group") return { ...node, ...(node.id && sizes[node.id] ? sizes[node.id] : {}) };
  return { ...node, children: node.children.map((child) => withGroupSizes(child, sizes)) };
}

describe("dock layout projection", () => {
  it("projects flow surfaces once and document panels by stable semantic id", () => {
    const plan = planForDock();
    const state = initialLayout(plan);
    const projection = projectDockLayout(plan, state);

    expect(projection.items.map((item) => [
      item.kind,
      item.dockId,
      item.defaultGroup,
      item.kind === "document" ? item.dormant : false,
    ])).toEqual([
      ["flow", DOCK_FLOW_PANEL_IDS.navigation, "navigation", false],
      ["flow", DOCK_FLOW_PANEL_IDS.bottom, "bottom", false],
      ["document", "chat", "primary", false],
      ["document", "viewer", "resource", true],
      ["document", "editor", "resource", true],
    ]);
    expect(projection.activeDockId).toBe("chat");

    const presentation = defaultDockPresentation(plan, state);
    expect(presentation.orientation).toBe("vertical");
    expect(groups(presentation.root).map((group) => group.panels)).toEqual([
      [DOCK_FLOW_PANEL_IDS.navigation],
      ["chat", "viewer", "editor"],
      [DOCK_FLOW_PANEL_IDS.bottom],
    ]);
    expect(groups(presentation.root).map((group) => group.size)).toEqual([320, 1_080, 72]);

    const materialized = materializeDockPresentation(presentation, projection);
    expect(materialized.panels.chat).toMatchObject({
      id: "chat",
      contentComponent: DOCK_DOCUMENT_COMPONENT,
      renderer: "always",
      params: { panelId: "chat" },
    });
    expect(materialized.panels[DOCK_FLOW_PANEL_IDS.navigation]).toMatchObject({
      contentComponent: DOCK_FLOW_COMPONENT,
      renderer: "always",
      params: { flowSlot: "navigation" },
    });
    expect(materialized.panels[DOCK_FLOW_PANEL_IDS.navigation]).not.toHaveProperty("minimumHeight");
    expect(materialized.panels[DOCK_FLOW_PANEL_IDS.bottom]).toMatchObject({
      contentComponent: DOCK_FLOW_COMPONENT,
      minimumHeight: 56,
      params: { flowSlot: "bottom" },
    });
    expect(JSON.stringify(materialized.panels)).not.toMatch(/resourceRef|provider|config|grant/);
  });

  it("makes a bound resource visible without changing its default document group", () => {
    const plan = planForDock();
    const initial = initialLayout(plan);
    const viewer = initial.panels.find((panel) => panel.panelId === "viewer")!;
    const state = {
      ...initial,
      panels: initial.panels.map((panel) => panel.panelId === viewer.panelId
        ? { ...panel, resourceRef: "opaque:file", resourceKind: "file", label: "readme.md" }
        : panel),
      active: { ...initial.active, secondary: viewer.panelId },
      focused: viewer.panelId,
    };
    const projection = projectDockLayout(plan, state);
    expect(projection.items.find((item) => item.dockId === "viewer")).toMatchObject({
      kind: "document",
      dormant: false,
      defaultGroup: "resource",
    });
    expect(projection.activeDockId).toBe("viewer");
    expect(groups(defaultDockPresentation(plan, state).root).map((group) => group.panels)).toEqual([
      [DOCK_FLOW_PANEL_IDS.navigation],
      ["chat", "viewer", "editor"],
      [DOCK_FLOW_PANEL_IDS.bottom],
    ]);
  });
});

describe("dock presentation codec", () => {
  it("round-trips only the bounded composition inventory", () => {
    const plan = planForDock();
    const state = initialLayout(plan);
    const scope = dockPresentationScope(plan, state);
    const projection = projectDockLayout(plan, state);
    const captured = captureDockPresentation(
      materializeDockPresentation(defaultDockPresentation(plan, state), projection),
      scope,
    );
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    const base = captured.value;
    const presentation: DockPresentation = {
      ...base,
      root: withGroupSizes(base.root, {
        [DEFAULT_DOCK_GROUP_IDS.navigation]: { width: 320, height: 788 },
        [DEFAULT_DOCK_GROUP_IDS.primary]: { width: 1_080, height: 788 },
        [DEFAULT_DOCK_GROUP_IDS.bottom]: { width: 1_400, height: 72 },
      }),
    };

    const encoded = encodeDockPresentation(presentation, scope);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(encoded.encoded).toBeTruthy();
    expect(decodeDockPresentation(encoded.encoded!, scope)).toEqual({ ok: true, value: presentation });
  });

  it("rejects runtime panels, params, unknown versions, duplicates and hostile sizes", () => {
    const plan = planForDock();
    const state = initialLayout(plan);
    const scope = dockPresentationScope(plan, state);
    const valid = defaultDockPresentation(plan, state);

    expect(readDockPresentation({ ...valid, version: 2 }, scope)).toMatchObject({ ok: false });
    expect(readDockPresentation({ ...valid, params: { resourceRef: "secret" } }, scope)).toMatchObject({ ok: false });
    expect(readDockPresentation({
      ...valid,
      root: { type: "group", panels: ["panel-1"], activePanel: "panel-1" },
    }, scope)).toMatchObject({ ok: false });
    expect(readDockPresentation({
      ...valid,
      root: { type: "group", panels: ["chat", "chat"] },
    }, { panelIds: ["chat"] })).toMatchObject({ ok: false });
    expect(readDockPresentation({
      ...valid,
      root: { type: "group", panels: ["chat"], size: DOCK_PRESENTATION_LIMITS.maxSize + 1 },
    }, { panelIds: ["chat"] })).toMatchObject({ ok: false });
    expect(readDockPresentation({
      ...valid,
      root: { type: "group", id: "", panels: ["chat"] },
    }, { panelIds: ["chat"] })).toMatchObject({ ok: false });
    expect(decodeDockPresentation("x".repeat(DOCK_PRESENTATION_LIMITS.maxBytes + 1), scope)).toMatchObject({ ok: false });
  });

  it("strips current-generation runtime panels and every Dockview param on capture", () => {
    const plan = planForDock();
    const state = initialLayout(plan);
    const projection = projectDockLayout(plan, state);
    const scope = dockPresentationScope(plan, state);
    const raw = materializeDockPresentation(defaultDockPresentation(plan, state), projection);
    const resourceLeaf = findLeaf(raw.grid.root, "viewer");
    if (!resourceLeaf || Array.isArray(resourceLeaf.data)) throw new Error("resource group missing");
    resourceLeaf.data.views.push("panel-1");
    raw.panels["panel-1"] = {
      id: "panel-1",
      contentComponent: DOCK_DOCUMENT_COMPONENT,
      renderer: "always",
      params: { panelId: "panel-1", resourceRef: "runner:/real/path", provider: "secret" },
    };

    const captured = captureDockPresentation(raw, scope);
    expect(captured.ok).toBe(true);
    expect(JSON.stringify(captured)).not.toMatch(/panel-1|runner:|provider|params/);
    if (!captured.ok) return;
    expect(groups(captured.value.root).map(({ id }) => id)).toEqual([
      DEFAULT_DOCK_GROUP_IDS.navigation,
      DEFAULT_DOCK_GROUP_IDS.primary,
      DEFAULT_DOCK_GROUP_IDS.bottom,
    ]);
    // Dockview's proportional cache remains an implementation hint. Rendered
    // pixels have their own group-keyed App state and survive topology edits.
    expect(groups(captured.value.root).map((group) => group.size)).toEqual([320, 1_080, 72]);
    expect(captured.value.root).toMatchObject({
      type: "split",
      children: [{ type: "split", size: 788 }, { type: "group", size: 72 }],
    });
  });

  it("collapses an all-dormant split without discarding its safe placement", () => {
    const plan = planForDock();
    const state = initialLayout(plan);
    const projection = projectDockLayout(plan, state);
    const legacy: DockPresentation = {
      version: 1,
      orientation: "vertical",
      root: {
        type: "split",
        children: [
          {
            type: "split",
            children: [
              { type: "group", panels: [DOCK_FLOW_PANEL_IDS.navigation], size: 260 },
              { type: "group", panels: ["chat"], activePanel: "chat", size: 680 },
              { type: "group", panels: ["viewer", "editor"], activePanel: "viewer", size: 460 },
            ],
            size: 720,
          },
          { type: "group", panels: [DOCK_FLOW_PANEL_IDS.bottom], size: 180 },
        ],
      },
      activePanel: "viewer",
    };

    const materialized = materializeDockPresentation(legacy, projection);
    const resourceLeaf = findLeaf(materialized.grid.root, "viewer");
    expect(resourceLeaf?.visible).toBe(false);
    const restored = captureDockPresentation(materialized, dockPresentationScope(plan, state));
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(groups(restored.value.root).map((group) => group.panels)).toEqual([
      [DOCK_FLOW_PANEL_IDS.navigation],
      ["chat"],
      ["viewer", "editor"],
      [DOCK_FLOW_PANEL_IDS.bottom],
    ]);
    expect(restored.value.activePanel).toBeUndefined();
  });

  it("refuses non-grid window shapes instead of persisting them", () => {
    const plan = planForDock();
    const state = initialLayout(plan);
    const projection = projectDockLayout(plan, state);
    const scope = dockPresentationScope(plan, state);
    const raw = materializeDockPresentation(defaultDockPresentation(plan, state), projection);
    raw.floatingGroups = [{
      data: { id: "float", views: ["chat"] },
      position: { left: 0, top: 0, width: 300, height: 200 },
    }];
    expect(captureDockPresentation(raw, scope)).toMatchObject({ ok: false });
  });

  it("rejects group pixels that are duplicate, unkeyed or outside the bounded codec", () => {
    const scope = { panelIds: ["chat", "viewer"] };
    const root = { type: "group", id: "main", panels: ["chat"] } as const;
    const value = {
      version: 1,
      orientation: "horizontal",
      root,
    } as const;
    expect(readDockPresentation({
      ...value,
      root: { type: "split", children: [root, { type: "group", id: "main", panels: ["viewer"] }] },
    }, scope)).toMatchObject({ ok: false });
    expect(readDockPresentation({
      ...value,
      root: { type: "group", panels: ["chat", "viewer"], width: 600, height: 500 },
    }, scope)).toMatchObject({ ok: false });
    expect(readDockPresentation({
      ...value,
      root: { ...root, panels: ["chat", "viewer"], width: 0, height: 500 },
    }, scope)).toMatchObject({ ok: false });
  });
});

function findLeaf(
  node: ReturnType<typeof materializeDockPresentation>["grid"]["root"],
  panelId: string,
): ReturnType<typeof materializeDockPresentation>["grid"]["root"] | undefined {
  if (node.type === "leaf") {
    return !Array.isArray(node.data) && node.data.views.includes(panelId) ? node : undefined;
  }
  if (!Array.isArray(node.data)) return undefined;
  for (const child of node.data) {
    const found = findLeaf(child, panelId);
    if (found) return found;
  }
  return undefined;
}

it("materializes saved pixels in their captured viewport rather than an unrelated 1400px grid", () => {
  const plan = planForDock();
  const state = initialLayout(plan);
  const captured = captureDockPresentation(materializeDockPresentation(defaultDockPresentation(plan, state), projectDockLayout(plan, state)), dockPresentationScope(plan, state));
  if (!captured.ok) throw new Error(captured.reason);
  const presentation: DockPresentation = { ...captured.value, width: 1000, height: 700,
    root: withGroupSizes(captured.value.root, {
      [DEFAULT_DOCK_GROUP_IDS.navigation]: { width: 240, height: 622 },
      [DEFAULT_DOCK_GROUP_IDS.primary]: { width: 754, height: 622 },
      [DEFAULT_DOCK_GROUP_IDS.bottom]: { width: 1000, height: 72 },
    }) };
  const materialized = materializeDockPresentation(presentation, projectDockLayout(plan, state));
  expect(materialized.grid.width).toBe(1000);
  expect(materialized.grid.height).toBe(700);
  expect(findLeaf(materialized.grid.root, "chat")?.size).toBe(754);
  expect(findLeaf(materialized.grid.root, DOCK_FLOW_PANEL_IDS.navigation)?.size).toBe(240);
  expect(readDockPresentation({ ...presentation, width: NaN }, dockPresentationScope(plan, state)).ok).toBe(false);
});
