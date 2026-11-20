/**
 * The coordinator's semantics, without a DOM.
 *
 * Every case below is one of the six behaviours the first vertical slice has to
 * demonstrate before a real file provider exists: repeat-click reuse, explicit
 * second instance, a missing module, a resource with no declared viewer, a
 * denied read, and what a narrow screen does. They are asserted here because
 * they are RULES — the shell test then proves the rules survive being rendered.
 */

import { describe, expect, it } from "vitest";
import {
  COMPOSITION_SCHEMA,
  RESOURCE_BINDINGS_SCHEMA_V2,
  openResource,
  type AgentComposition,
  type AgentModuleManifest,
  type OpenResourceIntent,
  type ResourceLink,
} from "@claude-bot/agent-module-contract";
import { createModuleRegistry, type ModuleRegistry } from "./registry.js";
import {
  acceptsOpenIntent,
  availableViews,
  createWorkspacePlan,
  initialLayout,
  layoutReducer,
  panelsIn,
  slotHasVisibleContent,
  visibleSlots,
  type LayoutState,
  type WorkspacePlan,
} from "./layout.js";

const NOTHING = () => null;

const ROSTER: AgentModuleManifest = {
  id: "session.roster-tree/v1",
  version: "1.0.0",
  implementation: "test#Roster",
  title: "会话",
  slots: ["navigation"],
  ports: ["agent-sessions/v1"],
  opens: [],
};

const CHAT: AgentModuleManifest = {
  id: "agent.chat/v1",
  version: "1.0.0",
  implementation: "test#Chat",
  title: "正文",
  slots: ["primary", "secondary"],
  ports: ["agent-sessions/v1"],
  opens: ["session"],
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

/**
 * A viewer that is CONNECTED to a typed port, i.e. one the binding plan names.
 *
 * The whole difference this file has to demonstrate: an unconnected module may
 * be opened as many times as somebody clicks, while a connected one has exactly
 * the instances the binding document wired — because a panel minted at runtime
 * is not in that document and could not honestly claim a port.
 */
const FILES: AgentModuleManifest = {
  id: "workspace.file-viewer/v1",
  version: "1.0.0",
  implementation: "test#Files",
  title: "文件内容",
  slots: ["secondary", "primary"],
  ports: ["workspace-files/v1"],
  opens: ["workspace-text"],
  config: { source: { type: "string" } },
};

/** A connected v2 surface deliberately left direct, beside the template. */
const DIRECT_FILES: AgentModuleManifest = {
  id: "workspace.direct-viewer/v1",
  version: "1.0.0",
  implementation: "test#DirectFiles",
  title: "直接文件内容",
  slots: ["primary"],
  ports: ["workspace-files/v1"],
  opens: ["workspace-direct-text"],
};

function planWith(options: { modules?: AgentModuleManifest[]; composition?: Partial<AgentComposition> } = {}): WorkspacePlan {
  const registry: ModuleRegistry = createModuleRegistry(
    (options.modules ?? [ROSTER, CHAT, NOTE]).map((manifest) => ({ manifest, component: NOTHING })),
  );
  const composition: AgentComposition = {
    schema: COMPOSITION_SCHEMA,
    app: "test-app",
    instances: [
      { instance: "roster", module: ROSTER.id, slot: "navigation" },
      { instance: "chat", module: CHAT.id, slot: "primary" },
    ],
    open: [
      { resource: "session", module: CHAT.id, slot: "primary" },
      { resource: "note", module: NOTE.id, slot: "secondary" },
    ],
    ...options.composition,
  };
  return createWorkspacePlan({ composition, registry });
}

/** The same, plus a standing `viewer` instance wired to `workspace-files/v1`. */
function connectedPlan(): WorkspacePlan {
  const registry = createModuleRegistry(
    [ROSTER, CHAT, NOTE, FILES].map((manifest) => ({ manifest, component: NOTHING })),
  );
  return createWorkspacePlan({
    registry,
    composition: {
      schema: COMPOSITION_SCHEMA,
      app: "test-app",
      instances: [
        { instance: "roster", module: ROSTER.id, slot: "navigation" },
        { instance: "chat", module: CHAT.id, slot: "primary" },
        { instance: "viewer", module: FILES.id, slot: "secondary" },
      ],
      open: [
        { resource: "session", module: CHAT.id, slot: "secondary" },
        { resource: "note", module: NOTE.id, slot: "secondary" },
        { resource: "workspace-text", module: FILES.id, slot: "secondary" },
      ],
    },
    bindings: {
      schema: "agent-resource-bindings/v1",
      app: "test-app",
      bindings: [{ binding: "workspace", contract: "workspace-files/v1" }],
      connections: [{ instance: "viewer", port: "workspace-files/v1", binding: "workspace" }],
    },
  });
}

/** A v2 template family, optionally beside one ordinary connected surface. */
function templatedPlan(maxInstances = 3, includeDirect = false): WorkspacePlan {
  const modules = includeDirect ? [FILES, DIRECT_FILES] : [FILES];
  const registry = createModuleRegistry(
    modules.map((manifest) => ({ manifest, component: NOTHING })),
  );
  return createWorkspacePlan({
    registry,
    composition: {
      schema: COMPOSITION_SCHEMA,
      app: "test-app",
      instances: [
        {
          instance: "viewer",
          module: FILES.id,
          slot: "secondary",
          config: { source: "workspace" },
        },
        ...(includeDirect
          ? [{ instance: "direct", module: DIRECT_FILES.id, slot: "primary" as const }]
          : []),
      ],
      open: [
        { resource: "workspace-text", module: FILES.id, slot: "secondary" },
        ...(includeDirect
          ? [{ resource: "workspace-direct-text", module: DIRECT_FILES.id, slot: "primary" as const }]
          : []),
      ],
    },
    bindings: {
      schema: RESOURCE_BINDINGS_SCHEMA_V2,
      app: "test-app",
      bindings: [{ binding: "workspace", contract: "workspace-files/v1" }],
      connections: [
        { instance: "viewer", port: "workspace-files/v1", binding: "workspace" },
        ...(includeDirect
          ? [{ instance: "direct", port: "workspace-files/v1", binding: "workspace" }]
          : []),
      ],
      templates: [{ instance: "viewer", maxInstances }],
    },
  });
}

const FILE_1: ResourceLink = { kind: "workspace-text", ref: "wf-1", label: "a.md" };
const FILE_2: ResourceLink = { kind: "workspace-text", ref: "wf-2", label: "b.md" };
const FILE_3: ResourceLink = { kind: "workspace-text", ref: "wf-3", label: "c.md" };

function intent(resource: ResourceLink, options: Parameters<typeof openResource>[1] = {}): OpenResourceIntent {
  const built = openResource(resource, options);
  if (!built.ok) throw new Error(`test intent did not validate: ${JSON.stringify(built.issues)}`);
  return built.value;
}

const SESSION_A: ResourceLink = { kind: "session", ref: "res-a", label: "A" };
const SESSION_B: ResourceLink = { kind: "session", ref: "res-b", label: "B" };
const NOTE_1: ResourceLink = { kind: "note", ref: "note-1", label: "笔记" };
const NOTE_2: ResourceLink = { kind: "note", ref: "note-2", label: "笔记二" };

function run(plan: WorkspacePlan, state: LayoutState, ...actions: Parameters<ReturnType<typeof layoutReducer>>[1][]): LayoutState {
  const reduce = layoutReducer(plan);
  return actions.reduce((current, action) => reduce(current, action), state);
}

describe("workspace plan", () => {
  it("refuses to start when the composition references a module the bundle lacks", () => {
    expect(() =>
      planWith({
        modules: [ROSTER, CHAT],
        composition: { open: [{ resource: "note", module: NOTE.id, slot: "secondary" }] } as Partial<AgentComposition>,
      }),
    ).toThrow(/not in the module lock/);
  });

  it("refuses a placement the module's own manifest does not accept", () => {
    expect(() =>
      planWith({
        composition: {
          instances: [{ instance: "roster", module: ROSTER.id, slot: "bottom" }],
        } as Partial<AgentComposition>,
      }),
    ).toThrow(/does not accept/);
  });

  it("refuses two connected open surfaces the v1 rule cannot distinguish", () => {
    const registry = createModuleRegistry([{ manifest: FILES, component: NOTHING }]);
    expect(() => createWorkspacePlan({
      registry,
      composition: {
        schema: COMPOSITION_SCHEMA,
        app: "test-app",
        instances: [
          { instance: "viewer-a", module: FILES.id, slot: "primary" },
          { instance: "viewer-b", module: FILES.id, slot: "secondary" },
        ],
        open: [{ resource: "workspace-text", module: FILES.id, slot: "secondary" }],
      },
      bindings: {
        schema: "agent-resource-bindings/v1",
        app: "test-app",
        bindings: [{ binding: "workspace", contract: "workspace-files/v1" }],
        connections: [
          { instance: "viewer-a", port: "workspace-files/v1", binding: "workspace" },
          { instance: "viewer-b", port: "workspace-files/v1", binding: "workspace" },
        ],
      },
    })).toThrow(/exactly one connected standing instance/);
  });

  it("accepts two standing documents in one slot: the tab strip is the affordance now", () => {
    // Until 2026-08-10 this composition was refused, because the v1 shell had
    // no way to choose between two standing documents in one column. The
    // stacked-document tab strip is that way. What the relaxation does NOT
    // change: only BOUND panels earn a tab, so the second unbound standing
    // surface stays invisible (and idle) until something is opened into it.
    const plan = planWith({
      composition: {
        instances: [
          { instance: "roster", module: ROSTER.id, slot: "navigation" },
          { instance: "chat", module: CHAT.id, slot: "primary" },
          { instance: "note-a", module: NOTE.id, slot: "secondary" },
          { instance: "note-b", module: NOTE.id, slot: "secondary" },
        ],
      },
    });
    const state = initialLayout(plan);
    // The FIRST standing instance is on show; the second waits for a document.
    expect(state.active.secondary).toBe("note-a");
    const opened = layoutReducer(plan)(state, {
      type: "open",
      intent: {
        intent: "open-resource/v1",
        resource: { kind: "note", ref: "n1", label: "笔记" },
      },
    });
    // The open lands in the first unbound standing surface of that slot; the
    // second remains a placeholder, exactly as a single-standing slot behaves.
    expect(opened.panels.find((panel) => panel.panelId === "note-a")?.resourceRef).toBe("n1");
    expect(opened.panels.find((panel) => panel.panelId === "note-b")?.resourceRef).toBeNull();
    expect(opened.active.secondary).toBe("note-a");
  });
});

describe("initial layout", () => {
  it("mounts the composition's instances with their own ids as React keys", () => {
    const plan = planWith();
    const state = initialLayout(plan);
    expect(state.panels.map((panel) => panel.panelId)).toEqual(["roster", "chat"]);
    expect(state.active.navigation).toBe("roster");
    expect(state.active.primary).toBe("chat");
    expect(state.panels.every((panel) => panel.status === "ready")).toBe(true);
  });

  it("keeps a declared instance visible as unavailable when its module is missing", () => {
    // A composition that lists four surfaces and silently renders three is the
    // failure this state exists to make loud.
    const registry = createModuleRegistry([{ manifest: ROSTER, component: NOTHING }]);
    const plan: WorkspacePlan = {
      registry,
      lock: registry.lock(),
      connectedInstances: new Set(),
      templateFamilies: [],
      composition: {
        schema: COMPOSITION_SCHEMA,
        app: "test-app",
        instances: [
          { instance: "roster", module: ROSTER.id, slot: "navigation" },
          { instance: "chat", module: CHAT.id, slot: "primary" },
        ],
        open: [],
      },
    };
    const state = initialLayout(plan);
    expect(state.panels).toHaveLength(2);
    expect(state.panels[1]).toMatchObject({ status: "unavailable", reason: "module_not_registered" });
  });
});

describe("open", () => {
  it("binds a resource into the standing instance rather than shadowing it", () => {
    const plan = planWith();
    const state = run(plan, initialLayout(plan), { type: "open", intent: intent(SESSION_A) });
    expect(state.panels).toHaveLength(2);
    expect(state.panels[1]).toMatchObject({ panelId: "chat", resourceRef: "res-a", label: "A" });
  });

  it("clears a standing panel's old refusal when a new resource binds into it", () => {
    const plan = planWith();
    let state = initialLayout(plan);
    state = run(plan, state, { type: "report", panelId: "chat", reason: "denied", detail: "old" });
    state = run(plan, state, { type: "open", intent: intent(SESSION_A) });
    expect(state.panels.find((panel) => panel.panelId === "chat")).toMatchObject({
      resourceRef: SESSION_A.ref,
      status: "ready",
      reason: "",
      detail: "",
    });
  });

  it("includes resource kind in reuse identity", () => {
    const multi: AgentModuleManifest = { ...NOTE, opens: ["note", "annotation"] };
    const plan = planWith({
      modules: [ROSTER, CHAT, multi],
      composition: {
        open: [
          { resource: "note", module: multi.id, slot: "secondary" },
          { resource: "annotation", module: multi.id, slot: "secondary" },
        ],
      },
    });
    let state = initialLayout(plan);
    state = run(plan, state, { type: "open", intent: intent({ kind: "note", ref: "1", label: "note" }) });
    state = run(plan, state, { type: "open", intent: intent({ kind: "annotation", ref: "1", label: "annotation" }) });
    expect(state.panels.filter((panel) => panel.moduleId === multi.id)).toHaveLength(2);
    expect(state.active.secondary && state.panels.find((panel) => panel.panelId === state.active.secondary))
      .toMatchObject({ resourceKind: "annotation", label: "annotation" });
  });

  it("skips runtime ids already used by composition instances", () => {
    const plan = planWith({
      composition: {
        instances: [
          { instance: "panel-1", module: ROSTER.id, slot: "navigation" },
          { instance: "chat", module: CHAT.id, slot: "primary" },
        ],
      },
    });
    const state = run(plan, initialLayout(plan), { type: "open", intent: intent(NOTE_1) });
    expect(state.panels.map((panel) => panel.panelId)).toContain("panel-2");
    expect(state.seq).toBe(2);
  });

  it("focuses the panel that already shows the resource instead of opening a second", () => {
    const plan = planWith();
    let state = run(plan, initialLayout(plan), { type: "open", intent: intent(NOTE_1) });
    expect(panelsIn(state, "secondary")).toHaveLength(1);
    const first = state.panels.at(-1)!.panelId;

    state = run(plan, state, { type: "focus", panelId: "chat" }, { type: "open", intent: intent(NOTE_1) });
    expect(panelsIn(state, "secondary")).toHaveLength(1);
    expect(state.focused).toBe(first);
  });

  it("reuses module + resource identity even when a later intent asks for another accepted slot", () => {
    const plan = planWith();
    let state = run(plan, initialLayout(plan), { type: "open", intent: intent(SESSION_A) });
    expect(state.panels.find((panel) => panel.resourceRef === SESSION_A.ref)?.slot).toBe("primary");

    state = run(plan, state, {
      type: "open",
      intent: intent(SESSION_A, { slot: "secondary" }),
    });
    expect(state.panels.filter((panel) => panel.resourceRef === SESSION_A.ref)).toHaveLength(1);
    expect(state.focused).toBe("chat");
  });

  it("opens a second instance only when asked for one explicitly", () => {
    const plan = planWith();
    let state = run(plan, initialLayout(plan), { type: "open", intent: intent(NOTE_1) });
    state = run(plan, state, { type: "open", intent: intent(NOTE_1, { mode: "new" }) });
    const panels = panelsIn(state, "secondary");
    expect(panels).toHaveLength(2);
    expect(new Set(panels.map((panel) => panel.panelId)).size).toBe(2);
    expect(panels.every((panel) => panel.resourceRef === "note-1")).toBe(true);
  });

  it("makes a resource kind with no declared viewer one refused panel, not an exception", () => {
    const plan = planWith();
    let state = run(plan, initialLayout(plan), {
      type: "open",
      intent: intent({ kind: "file", ref: "f-1", label: "main.ts" }),
    });
    expect(state.panels.at(-1)).toMatchObject({ status: "unavailable", reason: "no_viewer", slot: "secondary" });
    const refused = state.panels.at(-1)!.panelId;

    state = run(plan, state, {
      type: "open",
      intent: intent({ kind: "file", ref: "f-1", label: "main.ts" }),
    });
    expect(state.panels.filter((panel) => panel.resourceRef === "f-1")).toHaveLength(1);
    expect(state.focused).toBe(refused);
  });

  it("refuses a view hint the composition did not route, rather than looking it up", () => {
    const plan = planWith();
    const state = run(plan, initialLayout(plan), {
      type: "open",
      intent: intent({ ...SESSION_A, suggestedView: NOTE.id }),
    });
    expect(state.panels.at(-1)).toMatchObject({ status: "unavailable", reason: "no_viewer" });
  });

  it("refuses a slot override the target module does not accept", () => {
    const plan = planWith();
    const state = run(plan, initialLayout(plan), {
      type: "open",
      intent: intent(NOTE_1, { slot: "navigation" }),
    });
    expect(state.panels.at(-1)).toMatchObject({ status: "unavailable", reason: "slot_refused" });
  });

  it("keeps two different resources in the same slot as two panels", () => {
    const plan = planWith();
    let state = run(plan, initialLayout(plan), { type: "open", intent: intent(SESSION_A) });
    state = run(plan, state, { type: "open", intent: intent(SESSION_B) });
    expect(panelsIn(state, "primary")).toHaveLength(2);
    expect(state.active.primary).toBe(state.panels.at(-1)!.panelId);
  });
});

describe("close and report", () => {
  it("removes the panel and hands the slot back to whatever is left", () => {
    const plan = planWith();
    // The first open binds the standing instance; the second is a real second
    // panel, and closing it must give the slot back rather than empty it.
    let state = run(plan, initialLayout(plan), { type: "open", intent: intent(SESSION_A) });
    state = run(plan, state, { type: "open", intent: intent(SESSION_B) });
    const opened = state.active.primary!;
    expect(opened).not.toBe("chat");
    state = run(plan, state, { type: "close", panelId: opened });
    expect(state.panels.some((panel) => panel.panelId === opened)).toBe(false);
    expect(state.active.primary).toBe("chat");
  });

  it("returns to the previously focused document, not merely the newest-created one", () => {
    const plan = planWith();
    let state = initialLayout(plan);
    state = run(plan, state, { type: "open", intent: intent(NOTE_1) });
    const first = state.active.secondary!;
    state = run(plan, state, {
      type: "open",
      intent: intent({ kind: "note", ref: "note-2", label: "第二份" }),
    });
    const newestBeforeFocus = state.active.secondary!;
    expect(newestBeforeFocus).not.toBe(first);

    state = run(plan, state, { type: "focus", panelId: first });
    state = run(plan, state, {
      type: "open",
      intent: intent({ kind: "note", ref: "note-3", label: "第三份" }),
    });
    const top = state.active.secondary!;
    state = run(plan, state, { type: "close", panelId: top });
    expect(state.active.secondary).toBe(first);
    expect(state.active.secondary).not.toBe(newestBeforeFocus);
  });

  it("ignores closing something that is not there", () => {
    const plan = planWith();
    const state = initialLayout(plan);
    expect(run(plan, state, { type: "close", panelId: "nope" })).toBe(state);
  });

  it("turns a denied read into a panel-local state with a machine-readable reason", () => {
    const plan = planWith();
    let state = run(plan, initialLayout(plan), { type: "open", intent: intent(NOTE_1) });
    const panelId = state.active.secondary!;
    state = run(plan, state, { type: "report", panelId, reason: "denied", detail: "这次读取没有被授权" });
    expect(state.panels.find((panel) => panel.panelId === panelId)).toMatchObject({
      status: "unavailable",
      reason: "denied",
      detail: "这次读取没有被授权",
    });
    // And it clears: a grant restored is not a new panel.
    state = run(plan, state, { type: "report", panelId, reason: "" });
    expect(state.panels.find((panel) => panel.panelId === panelId)).toMatchObject({ status: "ready", reason: "" });
  });

});

describe("slotHasVisibleContent", () => {
  it("treats an empty standing document instance as unoccupied so its slot can hide", () => {
    // The whole point of the derived visibility: a release with a standing file
    // viewer used to make secondary claim half the workspace before anybody
    // opened anything. This helper answers "should that slot paint" from
    // layout state so the shell no longer has to guess from the DOM.
    const plan = connectedPlan();
    const state = initialLayout(plan);
    expect(slotHasVisibleContent(state, "secondary")).toBe(false);
    expect(slotHasVisibleContent(state, "primary")).toBe(false);
    expect(slotHasVisibleContent(state, "navigation")).toBe(true);
  });

  it("flips to true the moment a resource binds into a document slot, and back on close", () => {
    const plan = connectedPlan();
    let state = run(plan, initialLayout(plan), { type: "open", intent: intent(FILE_1) });
    expect(slotHasVisibleContent(state, "secondary")).toBe(true);
    state = run(plan, state, { type: "close", panelId: "viewer" });
    expect(slotHasVisibleContent(state, "secondary")).toBe(false);
  });

  it("holds true while any runtime document panel still has a bound resource", () => {
    // Runtime panels come and go around a standing surface: as long as any of
    // them still owns a resource, the slot is worth painting.
    const plan = planWith();
    let state = run(plan, initialLayout(plan), { type: "open", intent: intent(NOTE_1) });
    expect(slotHasVisibleContent(state, "secondary")).toBe(true);
    state = run(plan, state, { type: "close", panelId: state.active.secondary! });
    expect(slotHasVisibleContent(state, "secondary")).toBe(false);
  });

  it("keeps a flow slot occupied by any panel, resource or not", () => {
    // Navigation widgets are hints and status strips — they legitimately live
    // without a resource of their own, so the visibility rule for their slot
    // is "does it have any panels at all".
    const plan = planWith();
    const state = initialLayout(plan);
    expect(slotHasVisibleContent(state, "navigation")).toBe(true);
  });
});

describe("narrow viewport", () => {
  it("drills into secondary and comes back, without a second layout tree", () => {
    const plan = planWith();
    let state = run(plan, initialLayout(plan), { type: "viewport", narrow: true });
    expect(visibleSlots(state)).toEqual(["navigation", "primary", "bottom", "overlay"]);

    state = run(plan, state, { type: "open", intent: intent(NOTE_1) });
    expect(state.drilledIn).toBe(true);
    expect(visibleSlots(state)).toEqual(["secondary", "bottom", "overlay"]);

    state = run(plan, state, { type: "back" });
    expect(state.drilledIn).toBe(false);
    expect(visibleSlots(state)).toContain("primary");
  });

  it("comes back out when the last secondary panel closes", () => {
    const plan = planWith();
    let state = run(plan, initialLayout(plan), { type: "viewport", narrow: true }, {
      type: "open",
      intent: intent(NOTE_1),
    });
    state = run(plan, state, { type: "close", panelId: state.active.secondary! });
    expect(state.drilledIn).toBe(false);
  });

  it("leaves the drill-in when the screen stops being narrow", () => {
    const plan = planWith();
    let state = run(plan, initialLayout(plan), { type: "viewport", narrow: true }, {
      type: "open",
      intent: intent(NOTE_1),
    });
    state = run(plan, state, { type: "viewport", narrow: false });
    expect(state.drilledIn).toBe(false);
    expect(visibleSlots(state)).toHaveLength(5);
  });

  // ── One document per family (ticket #189) ────────────────────────────────
  //
  // A phone paints ONE layer, so a second document in a slot is a tab in the
  // least reachable chrome a small screen has. The coordinator collapses the
  // family instead of asking the renderer to hide the consequence.

  it("rebinds the one document in a slot instead of stacking a second", () => {
    const plan = planWith();
    let state = run(plan, initialLayout(plan), { type: "viewport", narrow: true });
    state = run(plan, state, { type: "open", intent: intent(NOTE_1) });
    const first = state.active.secondary!;
    state = run(plan, state, { type: "open", intent: intent(NOTE_2) });
    expect(panelsIn(state, "secondary").map((panel) => panel.panelId)).toEqual([first]);
    expect(state.panels.find((panel) => panel.panelId === first)?.resourceRef).toBe("note-2");
    expect(state.focused).toBe(first);
  });

  it("keeps one chat instead of one tab per session", () => {
    const plan = planWith();
    let state = run(plan, initialLayout(plan), { type: "viewport", narrow: true });
    state = run(plan, state, { type: "open", intent: intent(SESSION_A) });
    state = run(plan, state, { type: "open", intent: intent(SESSION_B) });
    expect(panelsIn(state, "primary").map((panel) => panel.panelId)).toEqual(["chat"]);
    expect(state.panels.find((panel) => panel.panelId === "chat")?.resourceRef).toBe("res-b");
  });

  it("collapses a v2 template family to its prototype", () => {
    const plan = templatedPlan(3);
    let state = run(plan, initialLayout(plan), { type: "viewport", narrow: true });
    state = run(plan, state, { type: "open", intent: intent(FILE_1) });
    state = run(plan, state, { type: "open", intent: intent(FILE_2) });
    state = run(plan, state, { type: "open", intent: intent(FILE_3) });
    expect(state.panels.map((panel) => panel.panelId)).toEqual(["viewer"]);
    expect(state.panels[0]!.resourceRef).toBe("wf-3");
  });

  it("never takes a panel with unsaved work to make room", () => {
    // A viewport is not a reason to discard a draft. The open falls through to
    // the ordinary desktop path, which derives a sibling rather than losing it.
    const plan = templatedPlan(3);
    let state = run(plan, initialLayout(plan), { type: "viewport", narrow: true });
    state = run(plan, state, { type: "open", intent: intent(FILE_1) });
    state = run(plan, state, { type: "set-dirty", panelId: "viewer", dirty: true });
    expect(acceptsOpenIntent(plan, state, intent(FILE_2))).toBe(true);
    state = run(plan, state, { type: "open", intent: intent(FILE_2) });
    expect(state.panels).toHaveLength(2);
    expect(state.panels.find((panel) => panel.panelId === "viewer")?.resourceRef).toBe("wf-1");
  });

  it("leaves an explicit second instance alone", () => {
    // `mode: "new"` asked for a second panel in so many words. Silently
    // answering a different question is worse than a crowded tab strip.
    const plan = templatedPlan(3);
    let state = run(plan, initialLayout(plan), { type: "viewport", narrow: true });
    state = run(plan, state, { type: "open", intent: intent(FILE_1) });
    state = run(plan, state, { type: "open", intent: intent(FILE_2, { mode: "new" }) });
    expect(state.panels).toHaveLength(2);
  });

  it("changes nothing on a wide screen", () => {
    const plan = planWith();
    let state = initialLayout(plan);
    state = run(plan, state, { type: "open", intent: intent(NOTE_1) });
    state = run(plan, state, { type: "open", intent: intent(NOTE_2) });
    expect(panelsIn(state, "secondary")).toHaveLength(2);
  });
});

describe("a connected surface", () => {
  it("rebinds its one named panel instead of minting an anonymous one", () => {
    // The blocker this rule exists for. `agent-resource-bindings/v1` wires
    // composition INSTANCES by name; a `panel-N` minted at runtime is absent
    // from that document, yet the App's provider sits above the whole workspace
    // and would render it as though it had a port. Two files must therefore be
    // one panel showing the second, not two panels one of which is unwired.
    const plan = connectedPlan();
    let state = initialLayout(plan);
    expect(state.panels.map((panel) => panel.panelId)).toEqual(["roster", "chat", "viewer"]);

    state = run(plan, state, { type: "open", intent: intent(FILE_1) });
    expect(state.panels).toHaveLength(3);
    expect(state.panels.find((panel) => panel.panelId === "viewer")).toMatchObject({
      resourceRef: "wf-1",
      resourceKind: "workspace-text",
      label: "a.md",
      status: "ready",
    });

    state = run(plan, state, { type: "open", intent: intent(FILE_2) });
    // Still three panels, and no `panel-N` anywhere.
    expect(state.panels).toHaveLength(3);
    expect(state.panels.some((panel) => panel.panelId.startsWith("panel-"))).toBe(false);
    expect(state.panels.find((panel) => panel.panelId === "viewer")?.resourceRef).toBe("wf-2");
    expect(state.focused).toBe("viewer");
  });

  it("still focuses rather than reloads when the same file is opened twice", () => {
    const plan = connectedPlan();
    let state = initialLayout(plan);
    state = run(plan, state, { type: "open", intent: intent(FILE_1) });
    const before = state.panels.find((panel) => panel.panelId === "viewer");
    state = run(plan, state, { type: "focus", panelId: "chat" });
    state = run(plan, state, { type: "open", intent: intent(FILE_1) });
    expect(state.focused).toBe("viewer");
    // Identity unchanged: the panel was not rebuilt, so a reader's scroll
    // position and the stream behind it both survive.
    expect(state.panels.find((panel) => panel.panelId === "viewer")).toEqual(before);
  });

  it("refuses `mode: new`, because v1 cannot wire a second connected instance", () => {
    // Deliberately a refusal rather than a silent downgrade to reuse: granting
    // it would produce the unwired panel, and downgrading it would answer a
    // different question than the caller asked. A template schema in the
    // binding document is what would make this expressible.
    const plan = connectedPlan();
    let state = initialLayout(plan);
    state = run(plan, state, { type: "open", intent: intent(FILE_1) });
    const before = state;
    state = run(plan, state, { type: "open", intent: intent(FILE_2, { mode: "new" }) });
    expect(state).toBe(before);
  });

  it("clears back to its standing state on close, and can be reopened", () => {
    const plan = connectedPlan();
    let state = initialLayout(plan);
    state = run(plan, state, { type: "open", intent: intent(FILE_1) });
    state = run(plan, state, { type: "close", panelId: "viewer" });

    const viewer = state.panels.find((panel) => panel.panelId === "viewer");
    expect(viewer).toBeDefined();
    expect(viewer).toMatchObject({ resourceRef: null, resourceKind: null, status: "ready", reason: "" });
    // Back to the manifest's own title, not the file's name.
    expect(viewer!.label).toBe("文件内容");
    expect(state.drilledIn).toBe(false);

    // And the declared surface is still there to be rebound.
    state = run(plan, state, { type: "open", intent: intent(FILE_2) });
    expect(state.panels).toHaveLength(3);
    expect(state.panels.find((panel) => panel.panelId === "viewer")?.resourceRef).toBe("wf-2");
  });

  it("returns to the previous document when the connected viewer closes", () => {
    const plan = connectedPlan();
    let state = initialLayout(plan);
    state = run(plan, state, { type: "open", intent: intent(SESSION_A) });
    const previous = state.active.secondary!;
    expect(state.panels.find((panel) => panel.panelId === previous)?.resourceRef).toBe("res-a");

    state = run(plan, state, { type: "open", intent: intent(FILE_1) });
    expect(state.active.secondary).toBe("viewer");
    state = run(plan, state, { type: "close", panelId: "viewer" });

    expect(state.active.secondary).toBe(previous);
    expect(state.focused).toBe(previous);
    expect(state.panels.find((panel) => panel.panelId === "viewer")?.resourceRef).toBeNull();
  });

  it("leaves narrow drill-in when only a standing fallback remains", () => {
    const plan = connectedPlan();
    let state = run(plan, initialLayout(plan), { type: "viewport", narrow: true });
    state = run(plan, state, { type: "open", intent: intent(NOTE_1) });
    expect(state.drilledIn).toBe(true);
    state = run(plan, state, { type: "close", panelId: state.active.secondary! });
    expect(state.active.secondary).toBe("viewer");
    expect(state.drilledIn).toBe(false);
  });

  it("leaves an UNCONNECTED module free to open as many panels as asked", () => {
    // The other half of the rule. Chat is not in the binding plan, so a second
    // session still opens beside the first — that behaviour is unchanged, and
    // it is why the discriminator is the binding document rather than "is this
    // a composition instance".
    const plan = connectedPlan();
    let state = initialLayout(plan);
    state = run(plan, state, { type: "open", intent: intent(SESSION_A) });
    state = run(plan, state, { type: "open", intent: intent(SESSION_B) });
    const chats = state.panels.filter((panel) => panel.moduleId === CHAT.id);
    expect(chats).toHaveLength(3);
    expect(chats.filter((panel) => panel.panelId.startsWith("panel-"))).toHaveLength(2);
  });

  it("refuses a plan whose connection names a module without that port", () => {
    const registry = createModuleRegistry(
      [ROSTER, CHAT, FILES].map((manifest) => ({ manifest, component: NOTHING })),
    );
    expect(() =>
      createWorkspacePlan({
        registry,
        composition: {
          schema: COMPOSITION_SCHEMA,
          app: "test-app",
          instances: [
            { instance: "chat", module: CHAT.id, slot: "primary" },
            { instance: "viewer", module: FILES.id, slot: "secondary" },
          ],
          open: [],
        },
        bindings: {
          schema: "agent-resource-bindings/v1",
          app: "test-app",
          bindings: [{ binding: "workspace", contract: "workspace-files/v1" }],
          // `chat` declares `agent-sessions/v1`, never `workspace-files/v1`.
          connections: [{ instance: "chat", port: "workspace-files/v1", binding: "workspace" }],
        },
      }),
    ).toThrow(/does not declare/);
  });
});

describe("a v2 connected template family", () => {
  it("projects only the layout facts and tags the standing prototype", () => {
    const plan = templatedPlan(4);
    expect(plan.templateFamilies).toEqual([{
      prototypeId: "viewer",
      moduleId: FILES.id,
      slot: "secondary",
      maxInstances: 4,
    }]);
    expect(initialLayout(plan).panels.find((panel) => panel.panelId === "viewer")).toMatchObject({
      templatePrototypeId: "viewer",
      config: { source: "workspace" },
    });
  });

  it("binds the prototype first, then derives connected tabs with inherited config", () => {
    const plan = templatedPlan();
    let state = run(plan, initialLayout(plan), { type: "open", intent: intent(FILE_1) });
    expect(state.panels.find((panel) => panel.panelId === "viewer")).toMatchObject({
      resourceRef: FILE_1.ref,
      config: { source: "workspace" },
    });

    state = run(plan, state, { type: "open", intent: intent(FILE_2) });
    const derived = state.panels.find((panel) => panel.resourceRef === FILE_2.ref)!;
    expect(derived).toMatchObject({
      panelId: "panel-1",
      templatePrototypeId: "viewer",
      config: { source: "workspace" },
    });
    expect(derived.panelId).not.toContain(FILE_2.ref);
  });

  it("reuses the same ref and replaces context without consuming capacity", () => {
    const plan = templatedPlan(2);
    let state = run(plan, initialLayout(plan), {
      type: "open",
      intent: intent(FILE_1, { context: { line: "3" } }),
    });
    state = run(plan, state, { type: "open", intent: intent(FILE_2) });
    expect(state.focused).toBe("panel-1");
    state = run(plan, state, {
      type: "open",
      intent: intent(FILE_1, { context: { line: "19" } }),
    });
    expect(state.panels.filter((panel) => panel.templatePrototypeId === "viewer")).toHaveLength(2);
    expect(state.panels.find((panel) => panel.panelId === "viewer")!.context).toEqual({ line: "19" });
    expect(state.focused).toBe("viewer");
  });

  it("always derives for mode:new, even while the prototype is empty", () => {
    const plan = templatedPlan(2);
    const state = run(plan, initialLayout(plan), {
      type: "open",
      intent: intent(FILE_1, { mode: "new" }),
    });
    expect(state.panels.find((panel) => panel.panelId === "viewer")!.resourceRef).toBeNull();
    expect(state.panels.find((panel) => panel.panelId === "panel-1")).toMatchObject({
      resourceRef: FILE_1.ref,
      templatePrototypeId: "viewer",
    });
  });

  it("counts prototype plus derived panels, and fails closed without eviction", () => {
    const plan = templatedPlan(2);
    let state = run(plan, initialLayout(plan), { type: "open", intent: intent(FILE_1) });
    state = run(plan, state, { type: "open", intent: intent(FILE_2) });
    const before = state;
    const third = intent(FILE_3);
    expect(acceptsOpenIntent(plan, state, third)).toBe(false);
    state = run(plan, state, { type: "open", intent: third });
    expect(state).toBe(before);
    expect(state.panels.map((panel) => panel.resourceRef)).toEqual([FILE_1.ref, FILE_2.ref]);
  });

  it("releases capacity when a derived panel closes, while closing the prototype clears it", () => {
    const plan = templatedPlan(2);
    let state = run(plan, initialLayout(plan), { type: "open", intent: intent(FILE_1) });
    state = run(plan, state, { type: "open", intent: intent(FILE_2) });
    state = run(plan, state, { type: "close", panelId: "panel-1" });
    expect(acceptsOpenIntent(plan, state, intent(FILE_3))).toBe(true);
    state = run(plan, state, { type: "open", intent: intent(FILE_3) });
    expect(state.panels.find((panel) => panel.resourceRef === FILE_3.ref)?.panelId).toBe("panel-2");

    state = run(plan, state, { type: "close", panelId: "viewer" });
    expect(state.panels.find((panel) => panel.panelId === "viewer")).toMatchObject({
      resourceRef: null,
      templatePrototypeId: "viewer",
      config: { source: "workspace" },
    });
  });

  it("keeps an untemplated connected v2 surface on the existing direct semantics", () => {
    const plan = templatedPlan(3, true);
    const directA: ResourceLink = { kind: "workspace-direct-text", ref: "direct-1", label: "one" };
    const directB: ResourceLink = { kind: "workspace-direct-text", ref: "direct-2", label: "two" };
    let state = run(plan, initialLayout(plan), { type: "open", intent: intent(directA) });
    state = run(plan, state, { type: "open", intent: intent(directB) });
    expect(state.panels.find((panel) => panel.panelId === "direct")?.resourceRef).toBe(directB.ref);
    expect(state.panels.filter((panel) => panel.moduleId === DIRECT_FILES.id)).toHaveLength(1);
    const before = state;
    state = run(plan, state, { type: "open", intent: intent(directA, { mode: "new" }) });
    expect(state).toBe(before);
  });
});

describe("a declared instance that is not connected", () => {
  it("also survives being closed, rather than deleting a surface the release declared", () => {
    // Same rule, and it is not about resources: a composition that lists four
    // surfaces and ends up rendering three is the failure `initialLayout`
    // already refuses to produce, so `close` must not produce it either.
    const plan = planWith();
    let state = initialLayout(plan);
    state = run(plan, state, { type: "open", intent: intent(SESSION_A) });
    expect(state.panels.find((panel) => panel.panelId === "chat")?.resourceRef).toBe("res-a");
    state = run(plan, state, { type: "close", panelId: "chat" });
    expect(state.panels.map((panel) => panel.panelId)).toEqual(["roster", "chat"]);
    expect(state.panels.find((panel) => panel.panelId === "chat")?.resourceRef).toBeNull();
  });

  it("still removes a panel that was minted at runtime", () => {
    const plan = planWith();
    let state = initialLayout(plan);
    state = run(plan, state, { type: "open", intent: intent(NOTE_1) });
    const minted = state.panels.find((panel) => panel.panelId.startsWith("panel-"))!;
    state = run(plan, state, { type: "close", panelId: minted.panelId });
    expect(state.panels.some((panel) => panel.panelId === minted.panelId)).toBe(false);
  });
});

describe("instance config and intent context (decision 7)", () => {
  const LIST: AgentModuleManifest = {
    id: "demo.list/v1",
    version: "1.0.0",
    implementation: "test#List",
    title: "列表",
    slots: ["navigation"],
    ports: [],
    opens: [],
    config: { source: { type: "string", required: true }, dense: { type: "boolean" } },
  };
  const configuredPlan = () =>
    planWith({
      modules: [LIST, CHAT, NOTE],
      composition: {
        instances: [
          { instance: "inbox", module: LIST.id, slot: "navigation", config: { source: "view.inbox" } },
          { instance: "chat", module: CHAT.id, slot: "primary" },
        ],
      } as Partial<AgentComposition>,
    });

  it("hands a declared instance its config, and mints runtime panels without any", () => {
    const plan = configuredPlan();
    let state = initialLayout(plan);
    expect(state.panels.find((panel) => panel.panelId === "inbox")!.config).toEqual({ source: "view.inbox" });
    state = run(plan, state, { type: "open", intent: intent(NOTE_1) });
    const minted = state.panels.find((panel) => panel.panelId.startsWith("panel-"))!;
    // An open intent cannot invent configuration; that belongs to declared surfaces.
    expect(minted.config).toBeNull();
  });

  it("mode:'rebind' makes a declared surface THE panel for its kind, config intact", () => {
    // The deck pressure test's finding (2026-08-07): under `reuse`, a
    // configured declared surface is only the open target ONCE — every later
    // open of a different ref mints an anonymous `config: null` twin, an
    // empty panel for any config-driven module. A blanket "always rebind
    // declared instances" fix broke the OTHER product shape (chat stacks a
    // panel per session so drafts survive), so the choice belongs to the
    // composition: `mode: "rebind"` on the open rule.
    const NOTE_HOST: AgentModuleManifest = {
      ...NOTE,
      id: "demo.note-host/v1",
      implementation: "test#NoteHost",
      config: { source: { type: "string" } },
    };
    const plan = planWith({
      modules: [ROSTER, CHAT, NOTE_HOST],
      composition: {
        instances: [
          { instance: "reader", module: NOTE_HOST.id, slot: "secondary", config: { source: "view.notes" } },
          { instance: "chat", module: CHAT.id, slot: "primary" },
        ],
        open: [{ resource: "note", module: NOTE_HOST.id, slot: "secondary", mode: "rebind" }],
      } as Partial<AgentComposition>,
    });
    let state = initialLayout(plan);
    state = run(plan, state, { type: "open", intent: intent(NOTE_1) });
    expect(state.panels.find((panel) => panel.panelId === "reader")!.resourceRef).toBe(NOTE_1.ref);

    const second = { kind: "note", ref: "note-2", label: "第二篇" };
    state = run(plan, state, { type: "open", intent: intent(second) });
    const reader = state.panels.find((panel) => panel.panelId === "reader")!;
    expect(reader.resourceRef).toBe("note-2");
    expect(reader.config).toEqual({ source: "view.notes" });
    expect(state.panels.filter((panel) => panel.moduleId === NOTE_HOST.id)).toHaveLength(1);

    // Asking for a second surface explicitly still works.
    state = run(plan, state, { type: "open", intent: intent(NOTE_1, { mode: "new" }) });
    expect(state.panels.filter((panel) => panel.moduleId === NOTE_HOST.id)).toHaveLength(2);
  });

  it("refuses at plan time a config the module's declaration does not allow", () => {
    expect(() =>
      planWith({
        modules: [LIST, CHAT, NOTE],
        composition: {
          instances: [
            { instance: "inbox", module: LIST.id, slot: "navigation", config: { sort: "desc" } },
            { instance: "chat", module: CHAT.id, slot: "primary" },
          ],
        } as Partial<AgentComposition>,
      }),
    ).toThrow(/not declared|required/);
  });

  it("sets, replaces and clears context without ever making it part of reuse identity", () => {
    const plan = planWith();
    let state = initialLayout(plan);
    state = run(plan, state, { type: "open", intent: intent(NOTE_1, { context: { line: "12" } }) });
    const first = state.panels.find((panel) => panel.resourceRef === NOTE_1.ref)!;
    expect(first.context).toEqual({ line: "12" });

    // Same resource, new context: SAME panel, replaced instruction.
    state = run(plan, state, { type: "open", intent: intent(NOTE_1, { context: { line: "90" } }) });
    const again = state.panels.filter((panel) => panel.resourceRef === NOTE_1.ref);
    expect(again).toHaveLength(1);
    expect(again[0]!.panelId).toBe(first.panelId);
    expect(again[0]!.context).toEqual({ line: "90" });

    // Reopening with no context clears it — the panel reflects the LAST ask.
    state = run(plan, state, { type: "open", intent: intent(NOTE_1) });
    expect(state.panels.find((panel) => panel.panelId === first.panelId)!.context).toBeNull();
  });

  it("clears context when a declared surface is cleared back to standing", () => {
    const plan = connectedPlan();
    let state = initialLayout(plan);
    state = run(plan, state, { type: "open", intent: intent(FILE_1, { context: { line: "7" } }) });
    expect(state.panels.find((panel) => panel.panelId === "viewer")!.context).toEqual({ line: "7" });
    state = run(plan, state, { type: "close", panelId: "viewer" });
    const viewer = state.panels.find((panel) => panel.panelId === "viewer")!;
    expect(viewer.resourceRef).toBeNull();
    expect(viewer.context).toBeNull();
  });
});

describe("dirty document close lifecycle", () => {
  it("turns close into a coordinator-owned request until cancel or discard", () => {
    const plan = templatedPlan();
    let state = run(
      plan,
      initialLayout(plan),
      { type: "open", intent: intent(FILE_1) },
      { type: "set-dirty", panelId: "viewer", dirty: true },
      { type: "close", panelId: "viewer" },
    );

    expect(state.closePendingPanelId).toBe("viewer");
    expect(state.panels.find((panel) => panel.panelId === "viewer")).toMatchObject({
      resourceRef: FILE_1.ref,
      dirty: true,
    });

    state = run(plan, state, { type: "cancel-close", panelId: "viewer" });
    expect(state.closePendingPanelId).toBeNull();
    expect(state.panels.find((panel) => panel.panelId === "viewer")?.resourceRef).toBe(FILE_1.ref);

    state = run(
      plan,
      state,
      { type: "close", panelId: "viewer" },
      { type: "discard-close", panelId: "viewer" },
    );
    expect(state.closePendingPanelId).toBeNull();
    expect(state.panels.find((panel) => panel.panelId === "viewer")).toMatchObject({
      resourceRef: null,
      dirty: false,
    });
  });

  it("removes a dirty derived panel only after explicit discard", () => {
    const plan = templatedPlan();
    let state = run(
      plan,
      initialLayout(plan),
      { type: "open", intent: intent(FILE_1) },
      { type: "open", intent: intent(FILE_2) },
    );
    const derived = state.panels.find((panel) => panel.resourceRef === FILE_2.ref)!;
    state = run(
      plan,
      state,
      { type: "set-dirty", panelId: derived.panelId, dirty: true },
      { type: "close", panelId: derived.panelId },
    );
    expect(state.panels.some((panel) => panel.panelId === derived.panelId)).toBe(true);
    state = run(plan, state, { type: "discard-close", panelId: derived.panelId });
    expect(state.panels.some((panel) => panel.panelId === derived.panelId)).toBe(false);
  });

  it("honors a pending close when an in-flight save makes the panel clean", () => {
    const plan = templatedPlan();
    let state = run(
      plan,
      initialLayout(plan),
      { type: "open", intent: intent(FILE_1) },
      { type: "set-dirty", panelId: "viewer", dirty: true },
      { type: "close", panelId: "viewer" },
      { type: "set-dirty", panelId: "viewer", dirty: false },
    );
    expect(state.closePendingPanelId).toBeNull();
    expect(state.panels.find((panel) => panel.panelId === "viewer")?.resourceRef).toBeNull();
  });

  it("never inherits a prototype's dirty lifecycle into a new template panel", () => {
    const plan = templatedPlan();
    let state = run(
      plan,
      initialLayout(plan),
      { type: "open", intent: intent(FILE_1) },
      { type: "set-dirty", panelId: "viewer", dirty: true },
      { type: "open", intent: intent(FILE_2, { mode: "new" }) },
    );
    expect(state.panels.find((panel) => panel.resourceRef === FILE_2.ref)?.dirty).toBe(false);
  });

  it("refuses an open that would rebind a dirty connected surface", () => {
    const plan = connectedPlan();
    let state = run(
      plan,
      initialLayout(plan),
      { type: "open", intent: intent(FILE_1) },
      { type: "set-dirty", panelId: "viewer", dirty: true },
    );
    const second = intent(FILE_2);
    expect(acceptsOpenIntent(plan, state, second)).toBe(false);
    const next = run(plan, state, { type: "open", intent: second });
    expect(next).toBe(state);
    expect(next.panels.find((panel) => panel.panelId === "viewer")?.resourceRef).toBe(FILE_1.ref);
  });
});

/**
 * `availableViews` — the read-only query face of the same resolver.
 *
 * The property under test throughout is that there is ONE answer: anything the
 * list offers, an open intent naming it can actually run, and anything the list
 * withholds, an open intent naming it is refused for. A chooser built from a
 * second traversal would drift into offering a viewer the open path rejects,
 * which is the defect this API exists to make structurally impossible.
 */
describe("availableViews", () => {
  /** A second viewer for the SAME kind — the whole point of an open-with list. */
  const EDITOR: AgentModuleManifest = {
    id: "workspace.editor/v1",
    version: "1.0.0",
    implementation: "test#Editor",
    title: "编辑器",
    slots: ["overlay", "secondary"],
    ports: ["workspace-files/v1"],
    opens: ["workspace-text"],
  };

  /** Two viewers for `workspace-text`, viewer first, editor second. */
  function twoViewerPlan(): WorkspacePlan {
    const registry = createModuleRegistry(
      [ROSTER, CHAT, FILES, EDITOR].map((manifest) => ({ manifest, component: NOTHING })),
    );
    return createWorkspacePlan({
      registry,
      composition: {
        schema: COMPOSITION_SCHEMA,
        app: "test-app",
        instances: [
          { instance: "roster", module: ROSTER.id, slot: "navigation" },
          { instance: "chat", module: CHAT.id, slot: "primary" },
        ],
        open: [
          { resource: "session", module: CHAT.id, slot: "primary" },
          { resource: "workspace-text", module: FILES.id, slot: "secondary" },
          { resource: "workspace-text", module: EDITOR.id, slot: "overlay", mode: "rebind" },
        ],
      },
    });
  }

  /**
   * A plan `createWorkspacePlan` would refuse, built by hand.
   *
   * Both defensive branches below are unreachable through the supported
   * constructor — the linker rejects a rule naming an unregistered module and a
   * rule routing a kind no manifest declares. They are asserted anyway because
   * the predicate they exercise is the single place the chooser and the reducer
   * agree, and an agreement that only holds for well-formed input is not one.
   */
  function unlinkedPlan(modules: AgentModuleManifest[], open: AgentComposition["open"]): WorkspacePlan {
    const registry = createModuleRegistry(modules.map((manifest) => ({ manifest, component: NOTHING })));
    return {
      registry,
      lock: registry.lock(),
      connectedInstances: new Set<string>(),
      templateFamilies: [],
      composition: {
        schema: COMPOSITION_SCHEMA,
        app: "test-app",
        instances: [{ instance: "chat", module: CHAT.id, slot: "primary" }],
        open,
      },
    };
  }

  it("lists every declared viewer for a kind in composition order, with title, slot and mode", () => {
    const plan = twoViewerPlan();
    expect(availableViews(plan, { kind: "workspace-text" })).toEqual([
      { moduleId: FILES.id, title: "文件内容", slot: "secondary", mode: "reuse" },
      { moduleId: EDITOR.id, title: "编辑器", slot: "overlay", mode: "rebind" },
    ]);
    // Order is the composition's, not alphabetical and not by title: `rules[0]`
    // is the documented default policy, so a sorted chooser would silently
    // disagree with what a plain click does.
    expect(availableViews(plan, { kind: "workspace-text" }).map((row) => row.moduleId)).toEqual([
      FILES.id,
      EDITOR.id,
    ]);
  });

  it("reports the composition's default mode as `reuse` when a rule states none", () => {
    const plan = twoViewerPlan();
    expect(availableViews(plan, { kind: "session" })).toEqual([
      { moduleId: CHAT.id, title: "正文", slot: "primary", mode: "reuse" },
    ]);
  });

  it("returns nothing for a kind the composition declares no rule for", () => {
    const plan = twoViewerPlan();
    expect(availableViews(plan, { kind: "note" })).toEqual([]);
    expect(availableViews(plan, { kind: "deck" })).toEqual([]);
  });

  it("is the same answer the reducer gives: the first candidate is what a plain open resolves to", () => {
    const plan = twoViewerPlan();
    for (const resource of [SESSION_A, FILE_1]) {
      const first = availableViews(plan, resource)[0]!;
      const state = run(plan, initialLayout(plan), { type: "open", intent: intent(resource) });
      const opened = state.panels.find((panel) => panel.resourceRef === resource.ref)!;
      expect(opened.moduleId).toBe(first.moduleId);
      expect(opened.slot).toBe(first.slot);
      expect(opened.status).toBe("ready");
    }
  });

  it("is the same answer the reducer gives: every candidate opens, and only candidates open", () => {
    const plan = twoViewerPlan();
    const offered = availableViews(plan, FILE_1);
    expect(offered).toHaveLength(2);
    for (const candidate of offered) {
      const state = run(plan, initialLayout(plan), {
        type: "open",
        intent: intent(FILE_1, { view: candidate.moduleId }),
      });
      const opened = state.panels.find((panel) => panel.resourceRef === FILE_1.ref)!;
      expect(opened).toMatchObject({ moduleId: candidate.moduleId, slot: candidate.slot, status: "ready" });
    }
    // A module that is in the bundle but not routed to this kind is absent from
    // the list AND refused by the open path — not silently downgraded to the
    // default viewer, which would open something nobody asked for.
    expect(offered.some((row) => row.moduleId === CHAT.id)).toBe(false);
    const refused = run(plan, initialLayout(plan), {
      type: "open",
      intent: intent(FILE_1, { view: CHAT.id }),
    });
    expect(refused.panels.at(-1)).toMatchObject({ status: "unavailable", reason: "no_viewer" });
  });

  it("holds `suggestedView` to the same allow-list, with no fallback to the default", () => {
    const plan = twoViewerPlan();
    // Allowed: the hint selects the second candidate rather than `rules[0]`.
    const honoured = run(plan, initialLayout(plan), {
      type: "open",
      intent: intent({ ...FILE_1, suggestedView: EDITOR.id }),
    });
    expect(honoured.panels.find((panel) => panel.resourceRef === FILE_1.ref)).toMatchObject({
      moduleId: EDITOR.id,
      status: "ready",
    });

    // Not allowed: `no_viewer`, and nothing opened in the default viewer. A
    // projection string cannot choose what runs, and it cannot quietly fail
    // upward into a different module either.
    const denied = run(plan, initialLayout(plan), {
      type: "open",
      intent: intent({ ...FILE_1, suggestedView: ROSTER.id }),
    });
    expect(denied.panels.at(-1)).toMatchObject({ status: "unavailable", reason: "no_viewer" });
    expect(denied.panels.some((panel) => panel.moduleId === FILES.id)).toBe(false);
    // The hint named a real, registered module — being in the bundle is not
    // being routed, so it is absent from the list too.
    expect(availableViews(plan, FILE_1).some((row) => row.moduleId === ROSTER.id)).toBe(false);
  });

  it("never offers a module this build's registry does not hold", () => {
    const open: AgentComposition["open"] = [{ resource: "note", module: NOTE.id, slot: "secondary" }];
    expect(() =>
      planWith({ modules: [ROSTER, CHAT], composition: { open } as Partial<AgentComposition> }),
    ).toThrow(/not in the module lock|no manifest/);

    const plan = unlinkedPlan([ROSTER, CHAT], open);
    expect(availableViews(plan, { kind: "note" })).toEqual([]);
    // The reducer keeps its own, more specific reason for this case: the rule
    // exists, so "no viewer declared" would be the wrong explanation.
    const state = run(plan, initialLayout(plan), { type: "open", intent: intent(NOTE_1) });
    expect(state.panels.at(-1)).toMatchObject({ status: "unavailable", reason: "module_not_registered" });
  });

  it("never offers a module whose manifest does not declare it opens the kind", () => {
    const open: AgentComposition["open"] = [{ resource: "note", module: CHAT.id, slot: "primary" }];
    expect(() =>
      planWith({ modules: [ROSTER, CHAT], composition: { open } as Partial<AgentComposition> }),
    ).toThrow(/does not declare that it opens/);

    const plan = unlinkedPlan([ROSTER, CHAT], open);
    expect(availableViews(plan, { kind: "note" })).toEqual([]);
    const state = run(plan, initialLayout(plan), { type: "open", intent: intent(NOTE_1) });
    expect(state.panels.at(-1)).toMatchObject({ status: "unavailable", reason: "no_viewer" });
  });

  it("reads only `kind` — never `mediaType`, which a file listing cannot supply", () => {
    const plan = twoViewerPlan();
    const deckish: ResourceLink = { ...FILE_1, label: "deck.pptx", mediaType: "application/vnd.ms-powerpoint" };
    expect(availableViews(plan, deckish)).toEqual(availableViews(plan, { kind: "workspace-text" }));
  });

  it("hands back a frozen list a caller cannot turn into a second routing table", () => {
    const plan = twoViewerPlan();
    const first = availableViews(plan, FILE_1);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first[0])).toBe(true);
    expect(availableViews(plan, FILE_1)).toEqual(first);
  });
});
