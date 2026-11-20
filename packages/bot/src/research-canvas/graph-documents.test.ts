import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { Provenance, ResearchNode } from "@claude-bot/research-canvas-contract";
import { Store } from "../store/store.js";
import { ResearchGraphDocuments } from "./graph-documents.js";
import { cloneGraph } from "./graph-crdt.js";
import type { ResearchContext } from "./graph.js";
import { readGraphYaml, writeGraphYaml } from "./graph-yaml.js";
const context: ResearchContext = { project: "p", actor: { kind: "agent", owner: "alice", agent: "a", run: "turn1" } };
const stamp: Provenance = { kind: "agent", owner: "alice", agent: "a", run: "turn1", model: null, trigger: "alice", at: "2026-09-24T00:00:00Z" };
describe("durable graph snapshots and action fencing", () => {
  let root: string, store: Store, graph: ResearchGraphDocuments, now: number;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "graph-documents-")); store = new Store(join(root, "store.sqlite")); now = Date.now(); graph = new ResearchGraphDocuments(store.researchCanvas, root, () => now); });
  afterEach(() => { graph.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const snapshot = () => readGraphYaml(graph.snapshot(context).yaml);
  const apply = (request: string, next: ReturnType<typeof snapshot>) => graph.apply(context, request, writeGraphYaml(next.snapshot, next), stamp);
  function seed() { const base = snapshot(); base.nodes.a = { ref: "note:file_a", label: "A" }; apply("seed", base); }
  it("reuses read projections and causal snapshots through layout writes, then invalidates on graph edits", () => {
    seed(); const snapshot = graph.snapshot(context), initial = graph.inspect("p");
    const opened = vi.spyOn(graph, "open");
    for (let n = 0; n < 20; n++) { expect(graph.inspect("p")).toEqual(initial); expect(graph.snapshot(context).snapshot).toBe(snapshot.snapshot); }
    expect(opened).not.toHaveBeenCalled();
    graph.patchLayout(context, "move", { a: { position: { x: 40, y: 50 } } }, initial.layout.positions);
    expect(graph.snapshot(context).snapshot).toBe(snapshot.snapshot);
    expect(graph.inspect("p").layout.positions.a).toMatchObject({ x: 40, y: 50 });
    const next = readGraphYaml(snapshot.yaml); next.nodes.a.label = "Changed"; apply("rename", next);
    expect(graph.snapshot(context).snapshot).not.toBe(snapshot.snapshot);
    expect(graph.inspect("p").spec.nodes.a.label).toBe("Changed");
    expect(initial.spec.nodes.a.label).toBe("A");
  });
  it("persists edge routing outside YAML, merges independent ends, and ignores concurrently removed edges", () => {
    seed(); const initial = snapshot(); initial.nodes.b = { ref: "note:b", label: "B" }; initial.edges.ab = { from: "a", to: "b", relation: "supports" }; apply("with-edge", initial);
    const first = graph.patchLayout(context, "ports-a", {}, {}, false, undefined, { ab: { sourceSide: "top" } }, { ab: {} });
    const second = graph.patchLayout(context, "ports-b", {}, {}, false, undefined, { ab: { targetSide: "bottom" } }, { ab: {} });
    expect(second.layout.edgePorts?.ab).toEqual({ sourceSide: "top", targetSide: "bottom" });
    expect(second.conflicts).toEqual([]);
    graph.close(); graph = new ResearchGraphDocuments(store.researchCanvas, root, () => now);
    expect(graph.inspect("p").layout.edgePorts?.ab).toEqual(second.layout.edgePorts?.ab);
    expect(graph.patchLayout(context, "ports-a", {}, {}, false, undefined, { ab: { sourceSide: "top" } }, { ab: {} })).toEqual(first);
    const exported = graph.snapshot(context);
    expect(exported.graph).toEqual({ nodes: snapshot().nodes, edges: snapshot().edges });
    expect(exported.yaml).not.toContain("sourceSide");
    const removed = snapshot(); delete removed.edges.ab; apply("remove-edge", removed);
    expect(graph.patchLayout(context, "late-port", {}, {}, false, undefined, { ab: { sourceSide: "left" } }, { ab: { sourceSide: "top" } }).issues[0]?.code).toBe("concurrent_delete");
    expect(() => graph.patchLayout(context, "invalid-port", {}, {}, false, undefined, { ab: { sourceSide: "bogus" as any } }, { ab: {} })).toThrow("方向");
  });
  it("migrates legacy identity, versions, layout and resource state without destroying old rows", () => {
    const old: ResearchNode = { id: "a", schema: 1, version: 9, archived: false, type: "note", title: "旧证据", summary: "", phase: "present", x: 42, y: 72, data: { text: "正文" }, created: stamp, updated: stamp };
    store.researchCanvas.put("p", "nodes", "a", old, 0);
    expect(graph.inspect("p")).toMatchObject({ spec: { nodes: { a: { ref: "note:a", label: "旧证据" } } }, layout: { positions: { a: { x: 42, y: 72 } } } });
    expect(store.researchCanvas.get("p", "node-resources", "a")).toEqual(old);
    expect(store.researchCanvas.get("p", "graph-nodes", "a")).toMatchObject({ version: 9 });
    expect(store.researchCanvas.get("p", "nodes", "a")).toEqual(old);
  });
  it("merges edits on pre-restart causal snapshots and replays requests across turn IDs", () => {
    seed(); const a = snapshot(), b = snapshot();
    a.nodes.a.label = "A2"; b.nodes.b = { ref: "file:paper", label: "Paper" };
    apply("a", a);
    graph.close(); graph = new ResearchGraphDocuments(store.researchCanvas, root, () => now);
    const result = apply("b", b);
    expect(graph.inspect("p").spec.nodes).toEqual({ a: { ref: "note:file_a", label: "A2" }, b: { ref: "file:paper", label: "Paper" } });
    expect(graph.apply({ ...context, actor: { ...context.actor, run: "turn2" } }, "b", writeGraphYaml(b.snapshot, b), stamp)).toEqual(result);
  });
  it("recovers a persisted CRDT edit when SQL receipt storage fails", () => {
    seed(); const next = snapshot(); next.nodes.a.label = "durable";
    vi.spyOn(store.researchCanvas, "remember").mockImplementationOnce(() => { throw new Error("crash before receipt"); });
    expect(() => apply("crash", next)).toThrow("crash");
    graph.close(); graph = new ResearchGraphDocuments(store.researchCanvas, root, () => now);
    expect(apply("crash", next)).toMatchObject({ status: "merged" });
    expect(graph.inspect("p").spec.nodes.a.label).toBe("durable");
  });
  it("rejects snapshots from another owner and expired bases", () => {
    seed(); const next = snapshot(); next.nodes.a.label = "changed";
    expect(() => graph.apply({ ...context, actor: { ...context.actor, owner: "mallory" } }, "foreign", writeGraphYaml(next.snapshot, next), stamp)).toThrow("调用者");
    now += 2 * 60 * 60 * 1000 + 1;
    expect(() => apply("expired", next)).toThrow("过期");
  });
  it("fences layout gestures, preserves pinning and returns the original retry receipt", () => {
    seed(); const start = graph.inspect("p").layout, held = graph.lease(context);
    const other = { ...context, actor: { ...context.actor, agent: "b" } };
    expect(() => graph.move(other, "busy", { a: { x: 12, y: 34 } }, start.revision)).toThrow("调整布局");
    const result = graph.move(context, "move", { a: { x: 12, y: 34, pinned: true } }, start.revision, held.lease);
    graph.release(context, held.lease);
    graph.move(other, "next", { a: { x: 80, y: 90 } }, result.layout.revision);
    expect(graph.inspect("p").layout.positions.a).toEqual({ x: 80, y: 90, pinned: true });
    expect(graph.move(context, "move", { a: { x: 12, y: 34, pinned: true } }, start.revision, held.lease)).toEqual(result);
    expect(() => graph.move(context, "stale", { a: { x: 0, y: 0 } }, start.revision)).toThrow("变化");
    const renewed = graph.lease(context); now += 10_001;
    expect(() => graph.move(context, "late", { a: { x: 0, y: 0 } }, graph.inspect("p").layout.revision, renewed.lease)).toThrow("过期");
  });
  it("keeps YAML edits from moving existing nodes while placing concurrent additions", () => {
    seed(); const next = snapshot(), layout = graph.inspect("p").layout;
    graph.move(context, "position", { a: { x: 999, y: 888 } }, layout.revision);
    next.nodes.b = { ref: "note:b", label: "B" }; apply("new", next);
    const end = graph.inspect("p");
    expect(end.layout.positions.a).toEqual({ x: 999, y: 888 });
    expect(end.layout.positions.b).toBeDefined();
    expect(end.spec.nodes.a).not.toHaveProperty("x");
  });
  it("persists shared card dimensions and old coordinate-only clients cannot erase them", () => {
    seed();
    const resized = graph.move(context, "resize", { a: { x: 20, y: 30, width: 620, height: 440, pinned: true } }, graph.inspect("p").layout.revision);
    graph.move(context, "old-client", { a: { x: 40, y: 60 } }, resized.layout.revision);
    graph.close(); graph = new ResearchGraphDocuments(store.researchCanvas, root, () => now);
    expect(graph.inspect("p").layout.positions.a).toEqual({ x: 40, y: 60, width: 620, height: 440, pinned: true });
    const before = graph.inspect("p");
    expect(() => graph.move(context, "invalid-size", { a: { x: 1, y: 2, width: 12 } }, before.layout.revision)).toThrow();
    expect(graph.inspect("p")).toEqual(before);
    const yaml = graph.snapshot(context).yaml;
    for (const field of ["width:", "height:", "pinned:", "x:", "y:"]) expect(yaml).not.toContain(field);
  });
  it("rejects a decomposition cycle created only by merging concurrent valid edits", () => {
    seed(); const base = snapshot(); base.nodes.b = { ref: "goal:b", label: "B" }; apply("b", base);
    const first = snapshot(), second = snapshot();
    first.edges.ab = { from: "a", to: "b", relation: "decomposes" };
    second.edges.ba = { from: "b", to: "a", relation: "decomposes" };
    apply("first", first); const before = graph.inspect("p");
    expect(() => apply("second", second)).toThrow("目标分解不能形成循环");
    expect(graph.inspect("p")).toEqual(before);
    second.edges.ba.relation = "supports";
    expect(apply("evidence-cycle", second).status).toBe("merged");
    expect(graph.inspect("p").spec.edges.ba.relation).toBe("supports");
  });

  it("keeps the layout revision stable when a causal clone changes map iteration order", () => {
    const initial = new Y.Doc(); initial.clientID = 1;
    initial.getMap("meta").set("schema", 1);
    initial.getMap("layout").set("a", { x: 40, y: 50 });
    initial.getMap("edgePorts").set("ab", { sourceSide: "top", targetSide: "bottom" });
    const later = cloneGraph(Y.encodeStateAsUpdate(initial)); later.clientID = 2;
    later.getMap("layout").set("b", { x: 700, y: 80 });
    later.getMap("edgePorts").set("ba", { sourceSide: "left", targetSide: "right" });
    later.getMap("meta").set("layoutSequence", 5);
    const reopened = cloneGraph(Y.encodeStateAsUpdate(later));
    try {
      expect([...later.getMap("layout").keys()]).not.toEqual([...reopened.getMap("layout").keys()]);
      expect([...later.getMap("edgePorts").keys()]).not.toEqual([...reopened.getMap("edgePorts").keys()]);
      const open = vi.spyOn(graph, "open");
      open.mockReturnValueOnce(later);
      const before = graph.inspect("p").layout;
      graph.close();
      open.mockReturnValueOnce(reopened);
      expect(graph.inspect("p").layout).toEqual(before);
    } finally { initial.destroy(); later.destroy(); reopened.destroy(); }
  });
  it("merges independent nodes and geometry fields without taking a board lease", () => {
    seed(); const source = snapshot(); source.nodes.b = { ref: "note:b", label: "B" }; apply("second", source);
    const base = graph.inspect("p").layout.positions;
    const moved = graph.patchLayout(context, "patch-a", { a: { position: { x: 40, y: 50 } } }, base);
    graph.patchLayout(context, "patch-b", { b: { position: { x: 700, y: 80 } } }, base);
    const sized = graph.patchLayout(context, "size-a", { a: { size: { width: 620, height: 500 } } }, base);
    expect(sized.conflicts).toEqual([]);
    expect(sized.layout.positions).toMatchObject({ a: { x: 40, y: 50, width: 620, height: 500 }, b: { x: 700, y: 80 } });
    expect(sized.layout.sequence).toBeGreaterThan(moved.layout.sequence!);
    expect(graph.patchLayout(context, "patch-a", { a: { position: { x: 40, y: 50 } } }, base)).toEqual(moved);
    graph.close(); graph = new ResearchGraphDocuments(store.researchCanvas, root, () => now);
    expect(graph.inspect("p").layout).toEqual(sized.layout);
  });
  it("reports same-field contention, keeps the coordinate pair atomic and skips changed auto-layout targets", () => {
    seed(); const base = graph.inspect("p").layout.positions;
    graph.patchLayout(context, "first-field", { a: { position: { x: 11, y: 22 } } }, base);
    const next = graph.patchLayout(context, "second-field", { a: { position: { x: 33, y: 44 } } }, base);
    expect(next.status).toBe("merged_with_conflicts");
    expect(next.conflicts).toMatchObject([{ object: "a", field: "position", current: { x: 11, y: 22 }, effective: { x: 33, y: 44 } }]);
    const automatic = graph.patchLayout(context, "automatic", { a: { position: { x: 0, y: 0 } } }, base, true);
    expect(automatic.layout.positions.a).toMatchObject({ x: 33, y: 44 });
    const before = graph.inspect("p");
    expect(() => graph.patchLayout(context, "bad-pair", { a: { position: { x: 10 } as never } }, base)).toThrow();
    expect(graph.inspect("p")).toEqual(before);
  });
  it("does not revive removed nodes or apply an invalid field", () => {
    seed(); const base = graph.inspect("p").layout.positions;
    expect(() => graph.patchLayout(context, "bad-field", { a: { color: "red" } as never }, base)).toThrow("字段");
    const next = snapshot(); delete next.nodes.a; apply("remove", next);
    const result = graph.patchLayout(context, "late-move", { a: { position: { x: 20, y: 30 } } }, base);
    expect(result.issues).toMatchObject([{ code: "concurrent_delete" }]);
    expect(graph.inspect("p").spec.nodes.a).toBeUndefined();
  });

});
