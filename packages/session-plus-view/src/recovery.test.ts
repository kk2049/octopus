import { describe, expect, it } from "vitest";
import { openResource } from "@claude-bot/agent-module-contract";
import type { SessionsProjection } from "@claude-bot/agent-sessions-contract";
import { createModuleRegistry, createWorkspacePlan, initialLayout, layoutReducer, readDockPresentation, dockPresentationScope,
  type DockPresentation, type LayoutState } from "@claude-bot/agent-view-react/workspace";
import { SESSION_PLUS_COMPOSITION, SESSION_PLUS_MANIFESTS, SESSION_PLUS_RESOURCE_BINDINGS } from "./plan.js";
import { encodeSessionPlusRecovery, readSessionPlusRecovery, restoreSessionPlusLayout, mapRecoveryPresentation } from "./recovery.js";

const plan = createWorkspacePlan({ composition: SESSION_PLUS_COMPOSITION, bindings: SESSION_PLUS_RESOURCE_BINDINGS,
  registry: createModuleRegistry(SESSION_PLUS_MANIFESTS.map((manifest) => ({ manifest, component: () => null }))) });
const projection = { pinned: [], sources: [], sessions: [{ resourceId: "res-1", title: "first" }, { resourceId: "res-2", title: "front" }] } as SessionsProjection;
const nav = "__octopus-flow-navigation";
const group = (id: string, panels: string[], width = 400) => ({ type: "group" as const, id, panels, activePanel: panels.at(-1), width, height: 600 });
function opened(): LayoutState {
  let state = initialLayout(plan);
  for (const ref of ["res-1", "res-2", "res-3"]) {
    const intent = openResource({ kind: "session", ref, label: ref });
    if (!intent.ok) throw new Error("invalid fixture");
    state = layoutReducer(plan)(state, { type: "open", intent: intent.value });
  }
  return state;
}

describe("Sessions+ front-window recovery", () => {
  it("restores runtime-only groups and only the front tab in each, remapping ids before the Dock mounts", () => {
    const state = opened();
    const chats = state.panels.filter((row) => row.resourceKind === "session");
    const presentation: DockPresentation = { version: 1, width: 1100, height: 600, orientation: "horizontal",
      root: { type: "split", children: [group("nav", [nav], 280), group("one", [chats[0]!.panelId, chats[1]!.panelId]),
        group("two", [chats[2]!.panelId])] }, activePanel: chats[2]!.panelId };
    const encoded = encodeSessionPlusRecovery({ state, presentation })!;
    expect(encoded).not.toContain("res-1");
    const recovery = readSessionPlusRecovery(encoded, plan, projection)!;
    expect(recovery.documents.map((row) => row.ref)).toEqual(["res-2", "res-3"]);
    const restored = restoreSessionPlusLayout(plan, recovery, recovery.documents, false);
    expect(restored.state.panels.filter((row) => row.resourceRef).map((row) => row.resourceRef)).toEqual(["res-2", "res-3"]);
    expect(restored.presentation?.root).toMatchObject({ children: [ { width: 280 }, { id: "one", panels: expect.arrayContaining(["chat"]) },
      { id: "two", panels: ["panel-1"] } ] });
    expect(restored.presentation?.activePanel).toBe("panel-1");
    expect(readDockPresentation(restored.presentation, dockPresentationScope(plan, restored.state, true)).ok).toBe(true);
  });

  it("migrates only the active legacy session and discards legacy ambiguous sizes", () => {
    const recovery = readSessionPlusRecovery(JSON.stringify({ version: 1, sessions: ["res-1", "res-2"], activeSession: "res-2",
      mobileSection: "main", presentation: { broken: true } }), plan, projection)!;
    expect(recovery.documents.map((row) => row.ref)).toEqual(["res-2"]);
    expect(recovery.presentation).toBeUndefined();
    expect(recovery.mobileSection).toBe("main");
  });

  it("serializes file listing identity without keeping expiring file/root refs or draft text", () => {
    let state = opened();
    const intent = openResource({ kind: "workspace-text", ref: "wf_old", label: "note.md" }, { context: {
      workspace_root_ref: "wf_old_root", workspace_file_labels: "docs/note.md", workspace_annotation_root: "display:laptop:project",
    } });
    if (!intent.ok) throw new Error("invalid fixture");
    state = layoutReducer(plan)(state, { type: "open", intent: intent.value });
    const encoded = encodeSessionPlusRecovery({ state, presentation: { version: 1, orientation: "horizontal",
      root: { type: "split", children: [group("nav", [nav]), group("file", [state.focused!])] } } })!;
    expect(encoded).not.toContain("wf_old");
    const recovery = readSessionPlusRecovery(encoded, plan, projection)!;
    expect(recovery.documents).toHaveLength(1);
    expect(recovery.documents[0]?.file).toEqual({ root: "display:laptop:project", labels: ["docs", "note.md"] });
    const restored = restoreSessionPlusLayout(plan, recovery, [{ ...recovery.documents[0]!, ref: "wf_current" }], false);
    expect(restored.state.panels.find((row) => row.resourceKind === "workspace-text")?.resourceRef).toBe("wf_current");
  });

  it("rejects forged modules, duplicate ids, invalid paths, bad versions and oversized checkpoints", () => {
    const document = { panelId: "chat", moduleId: "agent.chat/v1", kind: "session", ref: "res-1", label: "chat" };
    for (const value of [
      { version: 3, documents: [] }, { version: 2, documents: [document, document] },
      { version: 2, documents: [{ ...document, moduleId: "unknown/v1" }] },
      { version: 2, documents: [{ ...document, kind: "workspace-text", ref: undefined, file: { root: "root", labels: ["..", "secret"] } }] },
      { version: 2, documents: Array(17).fill(document) },
    ]) expect(readSessionPlusRecovery(JSON.stringify(value), plan, projection)).toBeNull();
    expect(readSessionPlusRecovery("x".repeat(100_000), plan, projection)).toBeNull();
  });

  it("preserves split axes when a missing resource removes a nested branch", () => {
    const presentation: DockPresentation = { version: 1, orientation: "horizontal", root: { type: "split", children: [
      group("nav", [nav]), { type: "split", children: [group("gone", ["gone"]),
        { type: "split", children: [group("a", ["a"]), group("b", ["b"])] }] },
    ] } };
    expect(mapRecoveryPresentation(presentation, (node) => node.id === "gone" ? null : node)?.root)
      .toMatchObject({ type: "split", children: [{ id: "nav" }, { id: "a" }, { id: "b" }] });
  });
});
