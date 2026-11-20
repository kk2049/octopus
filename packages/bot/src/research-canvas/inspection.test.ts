import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ResearchNode } from "@claude-bot/research-canvas-contract";
import { Store } from "../store/store.js";
import { ResearchGraph, type ResearchContext } from "./graph.js";
import { ResearchCollaboration } from "./collaboration.js";
import { ResearchCanvasInspection } from "./inspection.js";

describe("trusted canvas inspection and mutation warnings", () => {
  let root: string, store: Store, graph: ResearchGraph, collaboration: ResearchCollaboration, inspection: ResearchCanvasInspection;
  const human: ResearchContext = { project: "project", actor: { kind: "human", owner: "alice" } };
  const agent: ResearchContext = { project: "project", actor: { kind: "agent", owner: "alice", agent: "mcp", run: "turn" } };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "research-inspection-"));
    store = new Store(join(root, "store.sqlite"));
    store.createSharedAppInstance({ app_id: "research-v2", instance_key: "project", creator: "alice", status: "open", created_at: new Date().toISOString() }, "owner");
    graph = new ResearchGraph(store, root);
    collaboration = new ResearchCollaboration(graph, join(root, "crdt"), () => {});
    inspection = new ResearchCanvasInspection(graph, collaboration);
  });
  afterEach(() => { collaboration.close(); graph.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const add = (name: string, x: number) => (graph.mutate(human, "node_add", { request: name, data: JSON.stringify({ type: "task", title: name, x }) }) as { node: ResearchNode });

  it("reads only an authorized instance and loses access immediately on membership revocation", () => {
    add("first", 0);
    expect(inspection.inspect(agent, {}, true)).toMatchObject({ project: "project", kind: "structure-preview", layout: "canvas" });
    expect(() => inspection.inspect({ ...agent, project: "other" }, {})).toThrow("项目不存在");
    store.removeSharedAppMember("research-v2", "project", "alice");
    expect(() => inspection.inspect(agent, {})).toThrow("成员权限已撤销");
  });
  it("diagnoses the effective shared layout after an Agent move", () => {
    const a = add("first", 0).node, b = add("second", 400).node;
    const before = graph.documents.inspect("project").layout;
    graph.documents.move(agent, "layout", { [a.id]: { x: 0, y: 0 }, [b.id]: { x: 0, y: 0 } }, before.revision);
    expect(inspection.inspect(agent, { layout: "canvas" })).toMatchObject({ warnings: [{ code: "node_overlap" }] });
    expect([...graph.records("project", "proposals")]).toEqual([]);
  });
  it("ordinary writes warn about overlapping nodes on the default free canvas", () => {
    add("first", 0);
    const second = add("second", 0);
    expect(inspection.receipt(agent, "node_add", {}, second)).toMatchObject({ warnings: [{ code: "node_overlap" }], layoutDiagnostics: { reports: [{ layout: "canvas" }] } });
    expect(inspection.inspect(agent, { layout: "canvas" })).toMatchObject({ warnings: [{ code: "node_overlap" }] });
  });
});
