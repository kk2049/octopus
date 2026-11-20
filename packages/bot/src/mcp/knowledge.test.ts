import { describe, expect, it, vi } from "vitest";
import { Store } from "../store/store.js";
import { PermissionService } from "../permissions/service.js";
import { SessionHubService } from "../sessionhub/service.js";
import { McpSurface } from "./service.js";
import { MCP_KNOWLEDGE_OPERATION_IDS, MCP_SUBJECT_ID, mcpSubjectEntry } from "./catalog.js";
import { mcpSessionExecutionPolicy, mcpTokenPolicy } from "./tokens.js";

describe("MCP development knowledge authorization", () => {
  it("requires explicit grants and token group, rechecks revocation, and exposes no administrator approval tool", async () => {
    const store = new Store(":memory:");
    store.saveUser({ username: "alice", uid: 1, home_dir: "/x/alice", created_at: "2026-09-07" });
    const permissions = new PermissionService({ store, subjects: [mcpSubjectEntry({ workspaceComposed: () => false, crdtComposed: () => false, knowledgeComposed: () => true })], extraAccountOperations: [() => MCP_KNOWLEDGE_OPERATION_IDS] });
    const context = vi.fn(async () => ({ records: ["spec"] }));
    const sources = vi.fn(() => ({sources:[]}));
    const repair = vi.fn(async () => ({repairs:[]}));
    const annotate = vi.fn(() => ({ ok: true }));
    const resolve = vi.fn(() => ({}));
    const sessionExecution = { resolve, close: vi.fn() };
    const surface = new McpSurface({ sessionExecution: sessionExecution as never, hub: new SessionHubService({ store, permissions }), permissions, knowledge: { context, annotate, sources, repair, investigate: vi.fn() } });
    const principal = { owner: "alice", credential: "mcp:test", policy: mcpTokenPolicy({ groups: ["knowledge"] }) };
    try {
      expect(surface.listTools(principal).map((tool) => tool.name)).not.toContain("knowledge_context");
      expect(await surface.callTool(principal, "knowledge_context", { query: "知识规格" })).toMatchObject({ ok: false });
      permissions.grant({ subjectType:"service",subjectId:MCP_SUBJECT_ID,owner:"alice",operations:["read_development_knowledge","annotate_development_knowledge"],autoAllow:[],source:"user",createdBy:"alice" });
      expect(surface.listTools(principal).map(tool=>tool.name)).not.toContain("knowledge_sources");
      expect(await surface.callTool(principal,"knowledge_sources",{action:"list"})).toMatchObject({ok:false});
      permissions.grant({ subjectType: "service", subjectId: MCP_SUBJECT_ID, owner: "alice", operations: [...MCP_KNOWLEDGE_OPERATION_IDS], autoAllow: [], source: "user", createdBy: "alice" });
      expect(surface.listTools(principal).map((tool) => tool.name)).toEqual(["knowledge_sources", "knowledge_repairs", "knowledge_context", "knowledge_annotate", "knowledge_investigate"]);
      expect(await surface.callTool(principal, "knowledge_context", { query: "知识规格", subject: "requirement:1" })).toMatchObject({ ok: true });
      expect(context).toHaveBeenCalledWith("alice", "知识规格", "requirement:1");
      expect(await surface.callTool({ ...principal, policy: mcpTokenPolicy({ groups: ["sessions"] }) }, "knowledge_context", { query: "知识规格" })).toMatchObject({ ok: false });
      expect(await surface.callTool(principal, "knowledge_annotate", { subject: "requirement:1", body: "需要调查原始动机" })).toMatchObject({ ok: true });
      expect(annotate).toHaveBeenCalledWith("alice", "requirement:1", "需要调查原始动机");
      const session = { owner: "alice", credential: "mcp:session", policy: mcpSessionExecutionPolicy({ operationId: "op_test", runtimeDevice: "runner", executionDevice: "runner", workspaceId: "ws_" + "a".repeat(24), permissionProfile: "full_access" }) };
      expect(surface.listTools(session).map((tool) => tool.name)).toContain("knowledge_context");
      expect(await surface.callTool(session, "knowledge_context", { query: "知识规格" })).toMatchObject({ ok: true });
      expect(await surface.callTool(session, "read_session", {})).toMatchObject({ ok: false });
      resolve.mockReturnValueOnce(null as never);
      expect(await surface.callTool(session, "knowledge_context", { query: "知识规格" })).toMatchObject({ ok: false });
      expect(await surface.callTool(principal,"knowledge_sources",{action:"list"})).toMatchObject({ok:true});
      expect(sources).toHaveBeenCalledWith("alice","list",{action:"list"});
      expect(await surface.callTool(principal,"knowledge_sources",{action:"list",owner:"bob"})).toMatchObject({ok:false});
      expect(await surface.callTool(principal,"knowledge_sources",{action:"confirm"})).toMatchObject({ok:false});
      expect(await surface.callTool(principal,"knowledge_repairs",{action:"replay"})).toMatchObject({ok:true});
      expect(await surface.callTool(principal, "knowledge_approve", {})).toMatchObject({ ok: false });
      permissions.grant({ subjectType: "service", subjectId: MCP_SUBJECT_ID, owner: "alice", operations: [], autoAllow: [], source: "user", createdBy: "alice" });
      expect(await surface.callTool(principal,"knowledge_sources",{action:"read",id:"ks_private"})).toMatchObject({ok:false});
      expect(await surface.callTool(principal, "knowledge_annotate", { subject: "requirement:1", body: "再次追加" })).toMatchObject({ ok: false });
    } finally { surface.close(); store.close(); }
  });
});
