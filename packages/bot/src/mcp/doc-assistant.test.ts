import { afterEach, describe, expect, it, vi } from "vitest";
import { CapabilityService } from "@claude-bot/capability-kernel";
import { ExecutionWorkspaceCapabilities } from "../execution-workspace/capability.js";
import { assistantSettingsView } from "../feishu/doc-assistants.js";
import { FeishuDocShareService } from "../feishu/doc-share.js";
import { FeishuDocsClient } from "../feishu/docs-openapi.js";
import { APP_TOKEN, FakeFeishuDocs, userToken } from "../feishu/fake-feishu-docs.helper.js";
import { PermissionService } from "../permissions/service.js";
import { hashRunnerToken, type RunnerTransport } from "../runner/gateway.js";
import { SessionHubService } from "../sessionhub/service.js";
import { Store } from "../store/store.js";
import { WorkspaceFilesCapabilities } from "../workspace-files/capability.js";
import { WorkspaceFilesService } from "../workspace-files/service.js";
import {
  MCP_EXECUTION_OPERATION_IDS, MCP_FEISHU_OPERATION_IDS, MCP_KNOWLEDGE_OPERATION_IDS, MCP_SUBJECT_ID, MCP_WORKSPACE_OPERATION_IDS, mcpSubjectEntry,
} from "./catalog.js";
import { handleMcpRpc } from "./http.js";
import { McpSurface, type McpFeishuPlane, type McpPrincipal } from "./service.js";
import { SessionExecutionRegistry } from "./session-execution.js";
import { decodeMcpTokenPolicy, mcpCredentialOf } from "./tokens.js";

const DOC = "DocxToken1234567890abcdefg";
const WS = `ws_${"0".repeat(24)}`;
const READS = ["list_session_workspaces", "list_workspace_entries", "read_workspace_text"];
const SHARED_READS = ["feishu_shared_doc_read", "feishu_shared_doc_outline", "feishu_shared_doc_block_read"];
const SHARED_WRITES = ["feishu_shared_doc_write", "feishu_shared_doc_block_update", "feishu_shared_doc_remove"];
const SESSION_RIGHTS = ["list_recent_sessions", "search_sessions", "read_session", "append_session"];
/** The card's owner, signed in on it. */
const LHT = { openId: "ou_lht", username: "lht" };
/** Every other tool the owner's account or an ordinary session credential reaches here. */
const NEVER = ["replace_workspace_text", "run_workspace_command", "session_start", "list_recent_sessions", "send_session_message",
  "feishu_calendar_primary", "feishu_doc_place", "feishu_doc_share_create", "knowledge_context", "research_canvas_read", "open_workspace_execution"];

const closers: Array<() => void> = [];
afterEach(() => { for (const close of closers.splice(0)) close(); });

function harness() {
  const store = new Store(":memory:");
  store.saveUser({ username: "lht", uid: 5001, home_dir: "/fixture/lht", created_at: "2026-10-30T00:00:00Z" });
  const clock = { now: Date.parse("2026-10-30T08:00:00.000Z") };
  // The owner granted every MCP operation there is, silently.
  const permissions = new PermissionService({ store, subjects: [mcpSubjectEntry({ workspaceComposed: () => true, crdtComposed: () => false,
    feishuComposed: () => true, feishuPrivilegedOperations: () => [] })], extraAccountOperations: [() => [...SESSION_RIGHTS, ...MCP_FEISHU_OPERATION_IDS]] });
  const everything = [...SESSION_RIGHTS, ...MCP_WORKSPACE_OPERATION_IDS, ...MCP_FEISHU_OPERATION_IDS, ...MCP_KNOWLEDGE_OPERATION_IDS, ...MCP_EXECUTION_OPERATION_IDS];
  permissions.grant({ subjectType: "service", subjectId: MCP_SUBJECT_ID, owner: "lht", operations: everything, autoAllow: everything, source: "user", createdBy: "lht" });
  // The device: what reached it, through the real capability kernel.
  const dispatched: string[] = [];
  const transport = { async dispatch(_owner: string, operation: string) {
    dispatched.push(operation);
    if (operation === "list_session_workspaces") return { workspaces: [{ id: WS, label: "ACC" }] };
    if (operation === "exec_workspace") return { exit_code: 0 };
    throw new Error(`unexpected ${operation}`);
  } } as unknown as RunnerTransport;
  const kernel = new CapabilityService();
  const shared = { service: kernel, transport, userExists: () => true, hasDevice: () => true, now: () => clock.now };
  const registry = new SessionExecutionRegistry({
    store, dashboardPort: 9820, now: () => clock.now, workspaceFilesService: new WorkspaceFilesService(),
    workspaceCapabilities: new WorkspaceFilesCapabilities(shared), executionCapabilities: new ExecutionWorkspaceCapabilities(shared),
    assistantOf: (owner, device, _source, sessionId) => {
      const row = store.feishuDocAssistants.bySession(owner, device, sessionId);
      return row ? { docShare: row.shareId, executionDevice: row.device, workspaceId: row.workspaceId, live: row.live } : null;
    },
  });
  const feishu = new FakeFeishuDocs();
  feishu.addDoc(DOC, "论文初稿", ["引言", "方法"]);
  feishu.grant(DOC, "lht", "edit");
  feishu.grant(DOC, "app", "edit");
  const ended: string[] = [];
  const shares = new FeishuDocShareService({
    links: store.feishuDocShareLinks, tokens: store, componentTypeId: "blk_widget", publicUrl: "https://octopus.example",
    docs: new FeishuDocsClient(async (owner) => userToken(owner), feishu.fetch, async () => APP_TOKEN),
    notifyOwner: async () => {}, now: () => clock.now,
    assistantScope: (caller) => registry.docShareScope(caller.owner, caller.credential),
    assistantSettings: (anchorId) => assistantSettingsView(store.feishuDocAssistants.settings(anchorId)),
    onAssistantEnded: (shareId) => { ended.push(shareId); registry.releaseDocShare(shareId); },
  });
  const feishuPlane: McpFeishuPlane = {
    runnable: () => new Set(MCP_FEISHU_OPERATION_IDS),
    open: () => ({ slot: "feishu", capabilities: { request: async () => ({ status: "succeeded" as const, result: {} }), result: () => null }, destroy() {} }),
    openPrivileged: () => null,
  };
  // Generous on purpose: a research plane that would serve any execution credential.
  const research = { list: () => [{ name: "research_canvas_read", description: "project", inputSchema: { type: "object" as const, properties: {}, additionalProperties: false as const } }],
    call: vi.fn(async () => ({ ok: true as const, result: { project: "leaked" } })) };
  const surface = new McpSurface({
    hub: new SessionHubService({ store, permissions }), permissions, feishu: feishuPlane, sessionExecution: registry,
    feishuDocs: () => ({ call: vi.fn(async () => ({})) }), feishuDocShares: () => shares, research,
    knowledge: { context: vi.fn(async () => ({})), annotate: vi.fn(), investigate: vi.fn() },
  });
  closers.push(() => { surface.close(); kernel.close(); permissions.close(); store.close(); });

  const principalOf = (token: string): McpPrincipal => {
    const row = store.getActiveMcpTokenByHash(hashRunnerToken(token), new Date(clock.now).toISOString())!;
    return { owner: row.username, credential: mcpCredentialOf(row.token_hash), policy: decodeMcpTokenPolicy(row.policy_json) };
  };
  /** The control card (placed by a first link share) and its capability. */
  const card = async () => {
    await shares.create("lht", { document: DOC, label: "张老师" });
    const anchor = store.feishuDocShareLinks.liveAnchor("lht", DOC)!;
    const capability = (feishu.records(DOC)[0].record as { octopusShare: { anchor: string } }).octopusShare.anchor;
    return { anchor, capability };
  };
  let sequence = 0;
  /** One assistant: its share, its row, and its bound read-only scope's principal. */
  const assistant = async (rights: "read" | "write" = "write") => {
    const { anchor, capability } = await card();
    // The card's owner turned assistants on, writing, with this project.
    store.feishuDocAssistants.configure(anchor.id, "write", { device: "laptop", workspaceId: WS, label: "ACC" });
    const id = `op_fda_${String(++sequence).padStart(40, "0")}`;
    const shareId = shares.openAssistantShare(anchor, `王同学${sequence}的文档助手`, rights);
    store.feishuDocAssistants.create({ id, owner: "lht", anchorId: anchor.id, shareId, guestOpenId: `ou_guest${sequence}`, guestName: "王同学",
      title: "检查推导", device: "laptop", workspaceId: WS, createdAt: clock.now });
    store.feishuDocAssistants.attach(id, "lht", `s-${sequence}`);
    const scope = registry.issue({ owner: "lht", operationId: id, runtimeDevice: "laptop", executionDevice: "laptop", workspaceId: WS, permissionProfile: "read_only", docShare: shareId });
    scope.bindSession("claude", `s-${sequence}`);
    return { id, shareId, capability, anchor, principal: principalOf(scope.token) };
  };
  return { store, surface, shares, registry, feishu, clock, dispatched, ended, research, principalOf, assistant, card };
}

const names = (surface: McpSurface, principal: McpPrincipal) => surface.listTools(principal).map((tool) => tool.name);

describe("a Feishu document assistant over MCP", () => {
  it("lists only its three workspace reads and its own share's tools, whatever the owner granted, and nothing else is callable", async () => {
    const h = harness();
    // The owner's grants are live: an ordinary session credential of theirs reaches far more.
    const ordinary = h.registry.issue({ owner: "lht", operationId: "op_ordinary", runtimeDevice: "laptop", executionDevice: "laptop", workspaceId: WS, permissionProfile: "full_access" });
    expect(names(h.surface, h.principalOf(ordinary.token))).toEqual(expect.arrayContaining(["replace_workspace_text", "run_workspace_command", "research_canvas_read",
      "feishu_calendar_primary", "list_recent_sessions"]));

    const writer = await h.assistant("write");
    expect(names(h.surface, writer.principal)).toEqual([...READS, ...SHARED_READS, ...SHARED_WRITES]);
    for (const name of NEVER) expect(await h.surface.callTool(writer.principal, name, {}), name).toMatchObject({ ok: false, code: "unknown_tool" });
    expect(h.research.call).not.toHaveBeenCalled();
    expect(h.dispatched).not.toContain("exec_workspace");

    // The reads go to the device through the scope's own read-only grant; the document, as the app.
    expect(await h.surface.callTool(writer.principal, "list_session_workspaces", {})).toMatchObject({ ok: true, result: { roots: [expect.objectContaining({ label: "ACC" })] } });
    expect(h.dispatched).toEqual(["list_session_workspaces"]);
    const asked = h.feishu.requests.length;
    const read = await h.surface.callTool(writer.principal, "feishu_shared_doc_read", {});
    expect(read).toMatchObject({ ok: true, result: { document: { id: DOC } } });
    expect(new Set(h.feishu.requests.slice(asked).map((request) => request.as))).toEqual(new Set(["app"]));
    expect(h.feishu.documentsTouched()).toEqual(new Set([DOC]));

    const reader = await h.assistant("read");
    expect(names(h.surface, reader.principal)).toEqual([...READS, ...SHARED_READS]);
    expect(await h.surface.callTool(reader.principal, "feishu_shared_doc_write", { markdown: "x" })).toMatchObject({ ok: false, code: "unknown_tool" });

    const init = await handleMcpRpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, h.surface, writer.principal);
    expect((init.body as { result: { instructions: string } }).result.instructions).toContain("飞书文档助手");
  });

  it("stops every tool while its share is paused or its card is gone, and ends with its share", async () => {
    const h = harness();
    const { principal, shareId, capability } = await h.assistant();
    await h.shares.act(LHT, capability, shareId, "pause");
    expect(names(h.surface, principal)).toEqual([]);
    expect(await h.surface.callTool(principal, "list_session_workspaces", {})).toMatchObject({ ok: false, code: "no_authority", message: expect.stringContaining("暂停") });
    expect(await h.surface.callTool(principal, "feishu_shared_doc_read", {})).toMatchObject({ ok: false, code: "no_authority" });
    await h.shares.act(LHT, capability, shareId, "resume");
    expect(names(h.surface, principal)).toHaveLength(9);

    const anchorId = h.store.feishuDocShareLinks.share(shareId)!.anchorId;
    h.store.feishuDocShareLinks.markMissing(anchorId, h.clock.now);
    expect(names(h.surface, principal)).toEqual([]);
    expect(await h.surface.callTool(principal, "read_workspace_text", { ref: "x" })).toMatchObject({ ok: false, code: "no_authority", message: expect.stringContaining("控制卡片") });
    h.store.feishuDocShareLinks.markPresent(anchorId, "blk", h.clock.now + 60_000, h.clock.now);
    expect(names(h.surface, principal)).toHaveLength(9);

    // Terminated (here by the owner's agent): the assistant ends, and its scope with it, so its bearer resolves nothing.
    h.shares.update("lht", shareId, "terminate");
    expect(h.ended).toEqual([shareId]);
    expect(h.registry.resolve(principal)).toBeNull();
    expect(names(h.surface, principal)).toEqual([]);
    expect(await h.surface.callTool(principal, "list_session_workspaces", {})).toMatchObject({ ok: false, code: "no_authority" });
  });

  it("looks for its card again once the card's lease runs out, project reads included, and stops when the card is gone", async () => {
    const h = harness();
    const { principal, shareId } = await h.assistant();
    const anchorId = h.store.feishuDocShareLinks.share(shareId)!.anchorId;
    const card = h.feishu.records(DOC).find((each) => (each.record as { octopusShare?: unknown }).octopusShare)!;
    // Past the lease with the card in its document: a project read looks, and renews the lease.
    h.store.feishuDocShareLinks.markPresent(anchorId, card.id, h.clock.now - 1, h.clock.now - 1);
    expect(await h.surface.callTool(principal, "list_session_workspaces", {})).toMatchObject({ ok: true });
    expect(h.store.feishuDocShareLinks.anchor(anchorId)).toMatchObject({ state: "present", leaseUntil: expect.any(Number) });
    expect(h.store.feishuDocShareLinks.anchor(anchorId)!.leaseUntil).toBeGreaterThan(h.clock.now);
    // Past it again with the card deleted: an assistant that only reads its project stops too.
    h.feishu.delete(DOC, card.id);
    h.store.feishuDocShareLinks.markPresent(anchorId, card.id, h.clock.now - 1, h.clock.now - 1);
    expect(await h.surface.callTool(principal, "read_workspace_text", { ref: "x" })).toMatchObject({ ok: false, code: "no_authority", message: expect.stringContaining("控制卡片") });
    expect(h.store.feishuDocShareLinks.anchor(anchorId)!.state).toBe("missing");
    expect(names(h.surface, principal)).toEqual([]);
  });

  it("stops at every use once the card's settings no longer admit it, whether or not anything ended it", async () => {
    const h = harness();
    const { principal, anchor } = await h.assistant();
    const read = () => h.surface.callTool(principal, "list_session_workspaces", {});
    expect(await read()).toMatchObject({ ok: true });
    // Straight in the store, as if no end reached this assistant: off; narrowed below its share's rights; another project.
    for (const [rights, workspaceId, words] of [[null, WS, "关闭"], ["read", WS, "只读"], ["write", `ws_${"1".repeat(24)}`, "别的项目"]] as const) {
      h.store.feishuDocAssistants.configure(anchor.id, rights, { device: "laptop", workspaceId, label: "x" });
      expect(names(h.surface, principal), String(rights)).toEqual([]);
      expect(await read(), String(rights)).toMatchObject({ ok: false, code: "no_authority", message: expect.stringContaining(words) });
    }
    h.store.feishuDocAssistants.configure(anchor.id, "write", { device: "laptop", workspaceId: WS, label: "ACC" });
    expect(await read()).toMatchObject({ ok: true });
  });

  it("stops when its share's token is revoked from the token list, and ends on the next look at it", async () => {
    const h = harness();
    const { principal, shareId, capability } = await h.assistant();
    h.store.revokeMcpToken("lht", h.store.feishuDocShareLinks.share(shareId)!.mcpTokenHash!, new Date(h.clock.now).toISOString());
    expect(names(h.surface, principal)).toEqual([]);
    expect(await h.surface.callTool(principal, "list_session_workspaces", {})).toMatchObject({ ok: false, code: "no_authority", message: expect.stringContaining("终止") });
    await expect(h.shares.act(LHT, capability, shareId, "pause")).rejects.toThrow();
    expect(h.ended).toEqual([shareId]);
    expect(h.registry.resolve(principal)).toBeNull();
  });

  it("never lets a link token and an assistant reach each other's shares, nor one assistant another's", async () => {
    const h = harness();
    const first = await h.assistant();
    const second = await h.assistant();
    const created = await h.shares.create("lht", { document: DOC, label: "李老师" }) as { share_id: string };
    const { command } = await h.shares.reveal(LHT, first.capability, created.share_id);
    const link = h.principalOf(/Bearer (mcp_[0-9a-f]+)"$/.exec(command)![1]);
    const before = h.feishu.requests.length;

    // A link token naming an assistant's share — even with that share's own (discarded) token's credential — gets nothing.
    const assistantShare = h.store.feishuDocShareLinks.share(first.shareId)!;
    for (const credential of [link.credential, mcpCredentialOf(assistantShare.mcpTokenHash!)]) {
      const forged: McpPrincipal = { owner: "lht", credential, policy: decodeMcpTokenPolicy(JSON.stringify({ schema: "mcp-token-policy/v1", groups: [], feishuDocShare: { shareId: first.shareId } })) };
      expect(names(h.surface, forged)).toEqual([]);
      expect(await h.surface.callTool(forged, "feishu_shared_doc_read", {})).toMatchObject({ ok: false, code: "unknown_tool" });
    }
    // An assistant's live scope presented for a link share, or for another assistant's share, is no caller of it.
    for (const shareId of [created.share_id, second.shareId]) {
      expect(h.shares.toolNames({ shareId, owner: "lht", credential: first.principal.credential, via: "assistant" })).toEqual([]);
      await expect(h.shares.call({ shareId, owner: "lht", credential: first.principal.credential, via: "assistant" }, "feishu_shared_doc_read", {}))
        .rejects.toMatchObject({ status: 403 });
      const forged = { ...first.principal, policy: { ...first.principal.policy!, sessionExecution: { ...first.principal.policy!.sessionExecution!, docShare: shareId } } };
      expect(names(h.surface, forged)).toEqual([]);
      expect(await h.surface.callTool(forged, "feishu_shared_doc_read", {})).toMatchObject({ ok: false, code: "no_authority" });
    }
    // Not even as a link caller (no `via`) with the assistant's credential.
    expect(h.shares.toolNames({ shareId: first.shareId, owner: "lht", credential: first.principal.credential })).toEqual([]);
    expect(h.feishu.requests.length).toBe(before);
    // Each still reaches its own.
    expect(await h.surface.callTool(link, "feishu_shared_doc_outline", {})).toMatchObject({ ok: true });
    expect(await h.surface.callTool(second.principal, "feishu_shared_doc_outline", {})).toMatchObject({ ok: true });
  });
});
