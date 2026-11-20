import { afterEach, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { SESSION_OPERATION_PROTOCOL } from "@claude-bot/runner/gateway-protocol";
import { composeDashboardServices } from "./bootstrap-v3.js";
import { mcpFeishuDocSharePolicy, mintMcpToken, decodeMcpTokenPolicy } from "./mcp/tokens.js";
import { SessionExecutionRegistry } from "./mcp/session-execution.js";
import { RunnerCapabilities } from "./runner/capability.js";
import { hashRunnerToken, type RunnerSessionRecoveryIssuer, type RunnerTransport } from "./runner/gateway.js";
import { Store } from "./store/store.js";
import type { WorkspaceFilesCapabilities } from "./workspace-files/capability.js";
import type { ExecutionWorkspaceCapabilities } from "./execution-workspace/capability.js";
import type { UserManager } from "./user/types.js";

const WS = `ws_${"0".repeat(24)}`;
const DOC = "DocxToken1234567890abcdefg";
const ID = `op_fda_${"1".repeat(40)}`;
const SESSION = "assistant-session-1";
const RIGHTS = ["start_session", "append_session", "get_session_operation"];
afterEach(() => vi.restoreAllMocks());

/**
 * The real composition and dispatch preparer, a real Runner capability Gate,
 * and a device that answers durable receipts. The assistant's records are
 * written as `doc-assistants.ts` writes them (no Feishu call is made here).
 */
function harness(options: { sessionOnStart?: boolean } = {}) {
  const store = new Store(":memory:");
  const at = new Date().toISOString();
  store.saveUser({ username: "lht", uid: 1, home_dir: "/unused", created_at: at });
  store.saveRunnerToken(hashRunnerToken("lht-laptop"), "lht", "laptop", at);
  const frames: Array<{ operation: string; args: Record<string, unknown> }> = [];
  const caps = new RunnerCapabilities(store, {
    dispatch: async (_owner: string, operation: string, args: Record<string, unknown>) => {
      frames.push({ operation, args });
      const named = operation === "get_session_operation" || options.sessionOnStart !== false;
      return { protocol: SESSION_OPERATION_PROTOCOL, operation_id: args.operation_id, state: "running",
        ...(operation === "append_session" ? { session_id: args.id } : named ? { session_id: SESSION } : {}) };
    },
    listDevices: () => [{ device: "laptop", online: true }],
    isOnline: () => true,
  } as unknown as RunnerTransport, { extraRootAutoAllow: () => RIGHTS });
  caps.ensureAccount("lht");
  const workspaceFiles = { service: caps.service, attachToRunnerLifecycle: () => () => {},
    open: vi.fn(() => ({ contextId: "workspace", destroy: vi.fn() })), accountOperations: () => [] } as unknown as WorkspaceFilesCapabilities;
  const executionWorkspace = { open: vi.fn(() => ({ destroy() {} })) } as unknown as ExecutionWorkspaceCapabilities;
  const issue = vi.spyOn(SessionExecutionRegistry.prototype, "issue");
  let recovery: RunnerSessionRecoveryIssuer | undefined;
  const composition = composeDashboardServices(store, caps, {
    port: 0, workspaceFiles, executionWorkspace, publicUrl: "https://octopus.example",
    installSessionRecoveryIssuer: (issuer) => { recovery = issuer; return () => {}; },
    feishuDocsAddon: { tenantKey: "tenant", allowedOrigins: ["https://widget.feishu.cn"], verifyCode: async () => ({ openId: "ou_guest", tenantKey: "tenant" }) },
    userManager: { resolve: () => undefined } as unknown as UserManager,
    feishuDocsAgent: { userToken: async () => null, appToken: async () => "t-app", notify: async () => {}, componentTypeId: "blk_widget" },
  });
  // What `doc-assistants.ts` writes before it dispatches: the card, the assistant's share (active, its token minted and dropped), its row.
  store.feishuDocShareLinks.createAnchor({ id: "anc_1", owner: "lht", documentId: DOC, wikiToken: null, capabilityHash: "c".repeat(64), createdAt: 1 });
  store.feishuDocShareLinks.markPresent("anc_1", "blk_card", Date.now() + 60 * 60_000, Date.now());
  const token = mintMcpToken(store, { username: "lht", label: "飞书文档助手", policy: mcpFeishuDocSharePolicy(`shr_${"a".repeat(24)}`) });
  store.feishuDocShareLinks.createAssistantShare({ id: `shr_${"a".repeat(24)}`, anchorId: "anc_1", owner: "lht", documentId: DOC,
    label: "王同学的文档助手", rights: "write", mcpTokenHash: token.row.token_hash, createdAt: 2 });
  store.feishuDocAssistants.create({ id: ID, owner: "lht", anchorId: "anc_1", shareId: `shr_${"a".repeat(24)}`, guestOpenId: "ou_guest", guestName: "王同学",
    title: "王同学的文档助手：检查推导", device: "laptop", workspaceId: WS, createdAt: 3 });
  const grant = caps.open({ username: "lht", purpose: "doc-assistant-test", kind: "job", rights: RIGHTS, autoAllow: RIGHTS })!;
  const call = (operation: string, args: Record<string, unknown>) => grant.call(operation, { device: "laptop", ...args });
  const launch = (patch: Record<string, unknown> = {}) => call("start_session", { execution_device: "laptop", workspace_id: WS, source: "claude",
    permission_profile: "full_access", prompt: "【文档助手】……\n\n检查推导", client_request_id: ID, operation_id: ID, input_receipt: true, ...patch });
  const policyOf = (bearer: unknown) => decodeMcpTokenPolicy(store.getActiveMcpTokenByHash(hashRunnerToken(String(bearer)), new Date().toISOString())!.policy_json);
  return {
    store, frames, issue, call, launch, policyOf, recovery: () => recovery!,
    services: composition.services,
    framesOf: (operation: string) => frames.filter((frame) => frame.operation === operation).map((frame) => frame.args),
    async close() { grant.destroy(); await composition.close(); caps.service.close(); store.close(); },
  };
}

it("issues a read-only scope only for a registered launch, on its own placement, and binds it to the session its receipt names", async () => {
  const h = harness();
  try {
    await h.launch();
    const [start] = h.framesOf("start_session");
    expect(start).toMatchObject({ client_request_id: ID, execution_device: "laptop", workspace_id: WS, _octopus_execution_operation_id: ID });
    expect(start).not.toHaveProperty("_octopus_session_catalog_id");
    expect(h.issue).toHaveBeenCalledWith(expect.objectContaining({ permissionProfile: "read_only", docShare: `shr_${"a".repeat(24)}`, runtimeDevice: "laptop", executionDevice: "laptop" }));
    expect(h.policyOf(start!._octopus_execution_mcp_token)).toMatchObject({ groups: ["workspace"], sessionExecution: { permissionProfile: "read_only", operationId: ID } });
    expect(h.store.feishuDocAssistants.get(ID)).toMatchObject({ sessionId: SESSION, live: true });
    expect(h.store.getSessionExecutionBinding("lht", "laptop", "claude", SESSION, "0000-01-01T00:00:00.000Z"))
      .toMatchObject({ permission_profile: "read_only", doc_share_id: `shr_${"a".repeat(24)}`, operation_id: ID });
    // Never in the Sessions+ catalog, never in the table an older release reads.
    expect(h.store.getSessionPlusSplitSession("lht", "laptop", "claude", SESSION)).toBeUndefined();
    const raw = (h.store as unknown as { db: Database.Database }).db;
    expect(raw.prepare("SELECT COUNT(*) AS n FROM session_execution_bindings").get()).toEqual({ n: 0 });
  } finally { await h.close(); }
});

it("refuses an assistant launch off its placement, an unregistered or finished one, and leaves other same-device launches alone", async () => {
  const h = harness();
  try {
    for (const patch of [{ workspace_id: `ws_${"9".repeat(24)}` }, { execution_device: "worker" }, { source: "codex" }, { directory: "/home/lht" },
      { client_request_id: `op_fda_${"2".repeat(40)}`, operation_id: `op_fda_${"2".repeat(40)}` }]) {
      await expect(h.launch(patch), JSON.stringify(patch)).rejects.toThrow();
    }
    expect(h.framesOf("start_session")).toEqual([]);
    expect(h.issue).not.toHaveBeenCalled();
    // An ordinary local launch of the owner's is what it always was: no execution credential at all.
    await h.call("start_session", { workspace_id: WS, source: "claude", permission_profile: "full_access", prompt: "local", client_request_id: "op_fdl_local_1" });
    expect(h.framesOf("start_session")[0]).not.toHaveProperty("_octopus_execution_mcp_token");
    expect(h.issue).not.toHaveBeenCalled();
    // Ended before it was dispatched: nothing starts under its id.
    h.store.feishuDocAssistants.end(ID, Date.now());
    await expect(h.launch()).rejects.toThrow();
    expect(h.framesOf("start_session")).toHaveLength(1);
  } finally { await h.close(); }
});

it("binds the launch's scope on the first receipt read that names the session", async () => {
  const h = harness({ sessionOnStart: false });
  try {
    await h.launch();
    expect(h.store.feishuDocAssistants.get(ID)!.sessionId).toBeNull();
    expect(h.store.getSessionExecutionBinding("lht", "laptop", "claude", SESSION, "0000-01-01T00:00:00.000Z")).toBeUndefined();
    await h.call("get_session_operation", { operation_id: ID });
    expect(h.store.feishuDocAssistants.get(ID)!.sessionId).toBe(SESSION);
    expect(h.store.getSessionExecutionBinding("lht", "laptop", "claude", SESSION, "0000-01-01T00:00:00.000Z"))
      .toMatchObject({ permission_profile: "read_only", operation_id: ID });
  } finally { await h.close(); }
});

it("renews an assistant's turn as read-only whatever the append asks, recovers it while it lives, and refuses both once it ended", async () => {
  const h = harness();
  try {
    await h.launch();
    // The 24 h credential ended (expiry and release leave the same state).
    (h.issue.mock.results[0]!.value as { release(): void }).release();
    await h.call("append_session", { source: "claude", id: SESSION, prompt: "继续", operation_id: "op_fdam_1", permission_profile: "full_access" });
    const [append] = h.framesOf("append_session");
    expect(h.policyOf(append!._octopus_execution_mcp_token)).toMatchObject({ groups: ["workspace"],
      sessionExecution: { permissionProfile: "read_only", docShare: `shr_${"a".repeat(24)}`, operationId: "op_fdam_1" } });
    expect(append).toMatchObject({ execution_device: "laptop", workspace_id: WS });
    const recovered = h.recovery().issue({ owner: "lht", runtimeDevice: "laptop", source: "claude", sessionId: SESSION });
    expect(h.policyOf(recovered!.token)).toMatchObject({ sessionExecution: { permissionProfile: "read_only" } });

    // Its guest ends it: the share terminates, the scope goes, and a running turn is asked to stop.
    h.services.feishuDocsAddon!.assistants!.end({ openId: "ou_guest", username: null }, ID);
    expect(h.store.feishuDocAssistants.get(ID)).toMatchObject({ live: false, endedAt: expect.any(Number) });
    expect(h.store.getSessionExecutionBinding("lht", "laptop", "claude", SESSION, "0000-01-01T00:00:00.000Z")).toBeUndefined();
    await vi.waitFor(() => expect(h.framesOf("append_session").some((args) => args.interrupt === true)).toBe(true));
    expect(h.recovery().issue({ owner: "lht", runtimeDevice: "laptop", source: "claude", sessionId: SESSION })).toBeNull();
    await expect(h.call("append_session", { source: "claude", id: SESSION, prompt: "还在吗", operation_id: "op_fdam_2" })).rejects.toThrow();
    // A stop carries no authority and still passes, without credentials.
    await h.call("append_session", { source: "claude", id: SESSION, interrupt: true, operation_id: "op_fdam_3" });
    expect(h.framesOf("append_session").at(-1)).not.toHaveProperty("_octopus_execution_mcp_token");
  } finally { await h.close(); }
});
