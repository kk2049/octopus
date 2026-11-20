import { afterEach, describe, expect, it, vi } from "vitest";
import { PermissionService } from "../permissions/service.js";
import { SessionHubService } from "../sessionhub/service.js";
import { Store } from "../store/store.js";
import { mcpSubjectEntry } from "./catalog.js";
import { MCP_AGENT_ACCOUNT_TOOL_GROUPS } from "./policy-contract.js";
import { McpSurface, type McpFeishuDocsPlane, type McpPrincipal } from "./service.js";
import { mcpTokenPolicy } from "./tokens.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

function harness(plane: McpFeishuDocsPlane | null) {
  const store = new Store(":memory:");
  store.saveUser({ username: "alice", uid: 5001, home_dir: "/unused", created_at: new Date().toISOString() });
  const permissions = new PermissionService({ store, subjects: [mcpSubjectEntry({ workspaceComposed: () => false, crdtComposed: () => false, feishuComposed: () => false, feishuPrivilegedOperations: () => [] })] });
  const hub = new SessionHubService({ store, permissions });
  const surface = new McpSurface({ hub, permissions, feishuDocs: () => plane });
  cleanup.push(() => { surface.close(); permissions.close(); store.close(); });
  return surface;
}
const local: McpPrincipal = { owner: "alice", credential: "runner-local:laptop", policy: mcpTokenPolicy({ groups: MCP_AGENT_ACCOUNT_TOOL_GROUPS }),
  caller: { device: "laptop", source: "claude", sessionId: "11111111-2222-4333-8444-555555555555" } };

describe("Feishu Docs agent tools", () => {
  it("are listed for the owner's agents and hidden by a token that lacks their groups", async () => {
    const surface = harness({ call: vi.fn() });
    expect(surface.listTools(local).map((tool) => tool.name)).toEqual(expect.arrayContaining(["feishu_doc_place", "feishu_doc_board", "feishu_doc_remove", "session_start"]));
    const narrow: McpPrincipal = { owner: "alice", credential: "mcp:x", policy: mcpTokenPolicy({ groups: ["memory"] }) };
    expect(surface.listTools(narrow).map((tool) => tool.name)).not.toContain("feishu_doc_place");
    expect(await surface.callTool(narrow, "feishu_doc_place", { document: "x" })).toMatchObject({ ok: false, code: "unknown_tool" });
  });

  it("pass the tool, the owner, the checked arguments whole and the transport's caller session — never an argument-borne identity", async () => {
    const call = vi.fn(async (tool: string) => tool === "session_start" ? { state: "started" } : { card: { block: "blk" } });
    const surface = harness({ call });
    expect(await surface.callTool(local, "feishu_doc_place", { document: "https://t.feishu.cn/docx/AbCdEfGhIjKlMnOpQrStUvWxYz1", after: "A0｜", position: "start" }))
      .toEqual({ ok: true, result: { card: { block: "blk" } } });
    expect(call).toHaveBeenCalledWith("feishu_doc_place", "alice", { document: "https://t.feishu.cn/docx/AbCdEfGhIjKlMnOpQrStUvWxYz1", after: "A0｜", position: "start" }, local.caller);
    expect(await surface.callTool(local, "feishu_doc_place", { document: "x", owner: "bob" })).toMatchObject({ ok: false, code: "invalid_params" });
    expect(await surface.callTool(local, "feishu_doc_board", { html: "<p>ok</p>", board: "bd_1" })).toMatchObject({ ok: true });
    expect(call).toHaveBeenCalledWith("feishu_doc_board", "alice", { html: "<p>ok</p>", board: "bd_1" }, local.caller);
    expect(await surface.callTool(local, "feishu_doc_remove", { document: "x" })).toMatchObject({ ok: false, code: "invalid_params" });
    expect(await surface.callTool(local, "session_start", { prompt: "p", directory: "~/x", effort: "max" })).toMatchObject({ ok: true });
    expect(call).toHaveBeenCalledWith("session_start", "alice", { prompt: "p", directory: "~/x", effort: "max" }, local.caller);
    expect(await surface.callTool(local, "session_start", { prompt: "p", directory: "~/x", effort: "turbo" })).toMatchObject({ ok: false, code: "invalid_params" });
  });

  it("turn a refusal into a readable tool error, and vanish when the docs add-on is not composed", async () => {
    const surface = harness({ call: vi.fn(async () => { throw new Error("你没有这篇文档的编辑权限"); }) });
    expect(await surface.callTool(local, "feishu_doc_place", { document: "x" })).toEqual({ ok: false, code: "refused", message: "你没有这篇文档的编辑权限" });
    const bare = harness(null);
    expect(bare.listTools(local).map((tool) => tool.name)).not.toContain("feishu_doc_place");
    expect(await bare.callTool(local, "feishu_doc_place", { document: "x" })).toMatchObject({ ok: false, code: "unknown_tool" });
  });
});
