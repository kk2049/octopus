import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CapabilityService } from "@claude-bot/capability-kernel";
import { CANVAS_OPERATIONS, RESEARCH_APP, RESEARCH_PUBLISHER } from "@claude-bot/research-canvas-contract";
import { Store } from "../store/store.js";
import { PermissionService } from "../permissions/service.js";
import { IntentGrantResolver } from "../session-resource/intent-resolver.js";
import { ResearchGraph, type ResearchContext } from "./graph.js";
import { ResearchCapabilities } from "./capability.js";
import { ResearchCanvasPlane, type ResearchWorkbenchServices } from "./plane.js";
import { RESEARCH_CANVAS_DIGEST, RESEARCH_CANVAS_SUBJECT } from "./contract.js";
import type { ResearchCollaboration } from "./collaboration.js";
import type { ResearchResources } from "./resources.js";
import type { ResearchAutomation } from "./automation.js";

/** Real role checks, durable permission intents and capability kernel; no external actions. */
describe("research workbench authority at the integrated action entry", () => {
  let directory: string, store: Store, kernel: CapabilityService, graph: ResearchGraph;
  let permissions: PermissionService, capabilities: ResearchCapabilities, plane: ResearchCanvasPlane;
  const owner: ResearchContext = { project: "project", actor: { kind: "human", owner: "alice" } };
  const viewer: ResearchContext = { project: "project", actor: { kind: "human", owner: "bob" } };
  const workflow = vi.fn(async () => ({ accepted: true })), trace = vi.fn();
  const transcribe = vi.fn(), documents = vi.fn(), create = vi.fn(), sourceList = vi.fn(() => ({ sources: [] }));
  const summarize = vi.fn(async () => ({ source: null })), submit = vi.fn(async () => ({ source: { stage: "completed" } }));
  beforeEach(() => {
    vi.clearAllMocks();
    directory = mkdtempSync(join(tmpdir(), "research-entry-authority-"));
    store = new Store(join(directory, "state.db"));
    const at = new Date().toISOString();
    store.createSharedAppInstance({ app_id: RESEARCH_APP, instance_key: "project", creator: "alice", status: "open", created_at: at }, "owner");
    store.addSharedAppMember(RESEARCH_APP, "project", "bob", "viewer", 20, at);
    store.addSharedAppMember(RESEARCH_APP, "project", "carol", "editor", 20, at);
    graph = new ResearchGraph(store, directory);
    kernel = new CapabilityService();
    permissions = new PermissionService({ store, bootstrapSessionHub: false, subjects: [RESEARCH_CANVAS_SUBJECT] });
    const intents = new IntentGrantResolver(permissions, Date.now, new Map([[RESEARCH_APP, RESEARCH_PUBLISHER]]));
    capabilities = new ResearchCapabilities(kernel, graph, intents);
    const workbench = {
      workflows: { invoke: workflow, recordChange: trace }, sources: { list: sourceList },
      discussions: { create }, documents: { invoke: documents }, evidence: {}, meeting: { summarize, submit },
    } as unknown as ResearchWorkbenchServices;
    plane = new ResearchCanvasPlane(graph, {} as ResearchCollaboration, {} as ResearchResources,
      { transcribe } as unknown as ResearchAutomation, capabilities, undefined, workbench);
  });
  afterEach(() => {
    for (const username of ["alice", "bob", "carol"]) capabilities.revoke(username);
    kernel.close(); graph.close(); store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  function grant(username: string, operations: readonly string[], autoAllow: readonly string[] = operations) {
    permissions.grant({ subjectType: "app", subjectId: RESEARCH_APP, owner: username, operations, autoAllow,
      source: "config", createdBy: "fixture", contractDigest: RESEARCH_CANVAS_DIGEST, publisher: RESEARCH_PUBLISHER });
  }
  function publication(mode: string) {
    return { request: "fixture-publication", batch: "fixture-batch", version: "1", data: JSON.stringify({ mode }) };
  }
  const mutations = [
    ["audio_transcribe", { request: "fixture-transcribe", node: "audio", version: "1" }],
    ["paper_sync_run", { request: "fixture-sync", node: "document", direction: "auto", local_digest: "local", cloud_digest: "cloud" }],
    ["discussion_create", { request: "fixture-create", node: "group", title: "Fixture discussion" }],
  ] as const;

  it("allows publication with edit authority but separately checks explicit execution authority", async () => {
    grant("alice", ["edit_graph"]);
    await expect(plane.invoke(owner, "candidates_publish", publication("publish"))).resolves.toEqual({ accepted: true });
    expect(workflow).toHaveBeenCalledTimes(1);
    await expect(plane.invoke(owner, "candidates_publish", publication("publish_execute"))).rejects.toThrow("权限中心");
    expect(workflow).toHaveBeenCalledTimes(1);
    grant("alice", ["edit_graph", "run_agent"], ["edit_graph"]);
    await expect(plane.invoke(owner, "candidates_publish", publication("publish_execute"))).rejects.toThrow("权限中心");
    expect(workflow).toHaveBeenCalledTimes(1);
    grant("alice", ["edit_graph", "run_agent"]);
    await expect(plane.invoke(owner, "candidates_publish", publication("publish_execute"))).resolves.toEqual({ accepted: true });
    expect(workflow).toHaveBeenCalledTimes(2);
    expect(trace).toHaveBeenCalledTimes(2);
  });

  it("denies viewer transcription, synchronization and group creation even with every account operation", async () => {
    grant("bob", CANVAS_OPERATIONS);
    await expect(plane.invoke(viewer, "source_list", {})).resolves.toEqual({ sources: [] });
    for (const [action, params] of mutations)
      await expect(plane.invoke(viewer, action, params)).rejects.toThrow(/没有项目|仅项目管理者/);
    await expect(plane.invoke(viewer, "node_add", { request: "fixture-node", data: JSON.stringify({ type: "task", title: "Task" }) })).rejects.toThrow("没有项目编辑权限");
    await expect(plane.invoke(viewer, "cloud_document_bind", { request: "fixture-bind", node: "document", data: "{}" })).rejects.toThrow("仅项目管理者");
    expect(sourceList).toHaveBeenCalledTimes(1);
    expect(transcribe).not.toHaveBeenCalled(); expect(documents).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
  });

  it("keeps new external operations outside previously granted project operations", async () => {
    grant("alice", ["read_project", "edit_graph", "run_agent", "manage_resources"]);
    for (const [action, params] of mutations)
      await expect(plane.invoke(owner, action, params)).rejects.toThrow("权限中心");
    expect(transcribe).not.toHaveBeenCalled(); expect(documents).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
  });

  it("requires a human project owner to create a shared discussion group", async () => {
    for (const username of ["alice", "carol"]) grant(username, CANVAS_OPERATIONS);
    const params = { request: "fixture-group", node: "group", title: "Fixture discussion" };
    await expect(plane.invoke({ ...owner, actor: { kind: "human", owner: "carol" } }, "discussion_create", params)).rejects.toThrow("仅项目管理者");
    await expect(plane.invoke({ ...owner, actor: { kind: "agent", owner: "alice", agent: "agent" } }, "discussion_create", params)).rejects.toThrow("仅项目管理者");
    expect(create).not.toHaveBeenCalled();
  });
  it("separates running an existing meeting Agent from binding a new Codex source", async () => {
    grant("alice", ["run_agent"]);
    const params = { request: "summary", node: "audio", version: "file_version", selection: JSON.stringify({ kind: "agent", agent: "agent" }) };
    await expect(plane.invoke(owner, "source_summarize", params)).resolves.toEqual({ source: null });
    await expect(plane.invoke(owner, "source_summarize", { ...params, selection: JSON.stringify({ kind: "codex", resource: "source" }) })).rejects.toThrow("权限中心");
    expect(summarize).toHaveBeenCalledTimes(1);
    grant("bob", CANVAS_OPERATIONS);
    await expect(plane.invoke(viewer, "source_summarize", params)).rejects.toThrow("没有项目运行权限");
    expect(summarize).toHaveBeenCalledTimes(1);
  });
  it("allows bounded long meeting submissions through the actual tool envelope and still checks the nested operation", async () => {
    const values = { tool: "source_summary_submit", params: { request: "result", node: "audio", version: "file_version", attempt: "attempt",
      data: { minutes: "纪要".repeat(7500), candidates: [{ title: "后续事项", body: "材料".repeat(6000), summary: "目标", kind: "task", evidence: ["D1"] }] } } };
    grant("alice", ["read_project"]);
    await expect(plane.invokeTool(owner, "tools_invoke", values)).rejects.toThrow("权限中心"); expect(submit).not.toHaveBeenCalled();
    grant("alice", ["read_project", "run_agent"]);
    await expect(plane.invokeTool(owner, "tools_invoke", values)).resolves.toMatchObject({ source: { stage: "completed" } });
    expect(submit).toHaveBeenCalledTimes(1);
    await expect(plane.invokeTool(owner, "tools_invoke", { ...values, params: { ...values.params, data: { minutes: "x".repeat(210000), candidates: [] } } })).rejects.toThrow("工具参数不符合声明");
    expect(submit).toHaveBeenCalledTimes(1);
  });
});
