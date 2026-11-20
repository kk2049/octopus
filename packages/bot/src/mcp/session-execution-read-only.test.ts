import { afterEach, describe, expect, it, vi } from "vitest";
import { hashRunnerToken } from "../runner/gateway.js";
import { Store } from "../store/store.js";
import { SessionExecutionRegistry, type AssistantSessionPlacement } from "./session-execution.js";
import { decodeMcpTokenPolicy, mcpCredentialOf, mcpDocAssistantPolicy, mcpSessionExecutionPolicy } from "./tokens.js";

const WS = `ws_${"0".repeat(24)}`;
const SHARE = `shr_${"a1".repeat(12)}`;
const OTHER_SHARE = `shr_${"b2".repeat(12)}`;
const LAUNCH = `op_fda_${"1".repeat(40)}`;
const READS = ["list_session_workspaces", "list_workspace_entries", "read_workspace_text"];
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

function harness() {
  const store = new Store(":memory:");
  store.saveUser({ username: "lht", uid: 5001, home_dir: "/x/lht", created_at: "2026-10-30T00:00:00.000Z" });
  let now = Date.parse("2026-10-30T08:00:00.000Z");
  const workspaceCapabilities = { open: vi.fn(() => ({ contextId: "workspace", destroy: vi.fn() })) };
  const executionCapabilities = { open: vi.fn(() => ({ request: vi.fn(async () => ({ status: "succeeded" as const, result: {} })), destroy: vi.fn() })) };
  const workspaceFilesService = { open: vi.fn(() => ({ listRoots: vi.fn() })), closeScope: vi.fn(async () => {}) };
  /** feishu_doc_assistants, as the registry's port reads it. */
  const assistants = new Map<string, AssistantSessionPlacement>();
  const options = {
    store, dashboardPort: 9820, now: () => now,
    workspaceCapabilities: workspaceCapabilities as never, executionCapabilities: executionCapabilities as never,
    workspaceFilesService: workspaceFilesService as never,
    assistantOf: (owner: string, device: string, _source: string, sessionId: string) => assistants.get(`${owner}/${device}/${sessionId}`) ?? null,
  };
  const registries: SessionExecutionRegistry[] = [];
  const registry = (extra: Partial<typeof options> = {}) => {
    const made = new SessionExecutionRegistry({ ...options, ...extra });
    registries.push(made);
    return made;
  };
  const principalOf = (token: string) => {
    const row = store.getActiveMcpTokenByHash(hashRunnerToken(token), new Date(now).toISOString())!;
    return { owner: row.username, credential: mcpCredentialOf(row.token_hash), policy: decodeMcpTokenPolicy(row.policy_json) };
  };
  const placement = { owner: "lht", operationId: LAUNCH, runtimeDevice: "laptop", executionDevice: "laptop", workspaceId: WS,
    permissionProfile: "read_only" as const, docShare: SHARE };
  const register = (sessionId: string, live = true) => assistants.set(`lht/laptop/${sessionId}`, { docShare: SHARE, executionDevice: "laptop", workspaceId: WS, live });
  cleanup.push(() => { for (const made of registries) made.close(); store.close(); });
  return { store, registry, principalOf, placement, register, assistants, workspaceCapabilities, executionCapabilities, workspaceFilesService,
    advance: (ms: number) => { now += ms; } };
}

describe("a read-only (document assistant) execution scope", () => {
  it("holds the three workspace reads, silently, no command grant and no write path, and resolves only as itself", async () => {
    const h = harness();
    const registry = h.registry();
    const issued = registry.issue(h.placement);
    expect(h.workspaceCapabilities.open).toHaveBeenCalledWith(expect.objectContaining({ username: "lht", rights: READS, autoAllow: READS, device: "laptop" }));
    expect(h.executionCapabilities.open).not.toHaveBeenCalled();
    const [{ backend, writable }] = h.workspaceFilesService.open.mock.calls[0] as unknown as [{ backend: Record<string, unknown>; writable: boolean }];
    expect(writable).toBe(false);
    expect(Object.keys(backend).sort()).toEqual(["listEntries", "listRoots", "readText"]);
    const principal = h.principalOf(issued.token);
    expect(principal.policy).toEqual(mcpDocAssistantPolicy({ operationId: LAUNCH, device: "laptop", workspaceId: WS, docShare: SHARE }));
    expect(registry.resolve(principal)).toMatchObject({ permissionProfile: "read_only", docShare: SHARE, executionGrant: null });
    expect(registry.docShareScope("lht", principal.credential)).toEqual({ docShare: SHARE, device: "laptop", workspaceId: WS });
    expect(registry.docShareScope("bob", principal.credential)).toBeNull();
    await expect(registry.runCommand(principal, { command: "cat ~/.ssh/id_rsa" })).resolves.toMatchObject({ ok: false, code: "no_authority" });
    expect(registry.authorizeRelay({ token: issued.token, owner: "lht", runtimeDevice: "laptop", executionDevice: "laptop", workspaceId: WS, method: "codex_exec_open" })).toBe(false);
    // The live scope answers only the policy it was minted with: no other profile or share resolves to it.
    const forged = (patch: Record<string, unknown>) => ({ ...principal, policy: { ...principal.policy!, sessionExecution: { ...principal.policy!.sessionExecution!, ...patch } } });
    expect(registry.resolve(forged({ docShare: OTHER_SHARE }))).toBeNull();
    expect(registry.resolve(forged({ permissionProfile: "full_access", docShare: undefined }))).toBeNull();
    expect(registry.resolve({ ...principal, policy: mcpSessionExecutionPolicy({ operationId: LAUNCH, runtimeDevice: "laptop", executionDevice: "laptop",
      workspaceId: WS, permissionProfile: "full_access" }) })).toBeNull();
    issued.release();
    expect(registry.docShareScope("lht", principal.credential)).toBeNull();
  });

  it("is minted only for its own device, owner-local, straight after the launch Gate, and never without its share", () => {
    const h = harness();
    const registry = h.registry();
    for (const invalid of [
      { ...h.placement, docShare: undefined },
      { ...h.placement, permissionProfile: "full_access" as const },
      { ...h.placement, executionDevice: "worker" },
      { ...h.placement, runtimeOwner: "bob", runtimeResourceId: "agent-runtime:0123456789abcdef0123456789abcdef", runtimeDevice: "host" },
      { ...h.placement, issuer: "mcp:issuer" },
      { ...h.placement, connectionBound: true },
      { ...h.placement, manualObserveAutoAllow: true },
      // The assistants' launch namespace never gets a wider scope, whatever the caller asks for.
      { ...h.placement, permissionProfile: "full_access" as const, docShare: undefined },
      { ...h.placement, permissionProfile: "manual" as const, docShare: undefined },
      { ...h.placement, operationId: "op_fdam_turn", permissionProfile: "full_access" as const, docShare: undefined },
    ]) expect(() => registry.issue(invalid), JSON.stringify(invalid)).toThrow();
    expect(h.workspaceCapabilities.open).not.toHaveBeenCalled();
    expect(h.store.listMcpTokens("lht")).toEqual([]);
  });

  it("binds only to its live assistant's session, and an assistant's session takes no other scope", () => {
    const h = harness();
    const registry = h.registry();
    const unregistered = registry.issue(h.placement);
    expect(() => unregistered.bindSession("claude", "s-assistant")).toThrow(/只读执行权限/);
    h.register("s-assistant");
    const full = registry.issue({ ...h.placement, operationId: "op_ordinary", permissionProfile: "full_access", docShare: undefined });
    expect(() => full.bindSession("claude", "s-assistant")).toThrow(/只读执行权限/);
    full.bindSession("claude", "s-ordinary");
    const otherShare = registry.issue({ ...h.placement, operationId: `${LAUNCH}x`, docShare: OTHER_SHARE });
    expect(() => otherShare.bindSession("claude", "s-assistant")).toThrow(/只读执行权限/);
    unregistered.bindSession("claude", "s-assistant");
    expect(h.store.getSessionExecutionBinding("lht", "laptop", "claude", "s-assistant", "0000-01-01T00:00:00.000Z"))
      .toMatchObject({ permission_profile: "read_only", doc_share_id: SHARE, operation_id: LAUNCH });
    // Without the assistants' record nothing read-only binds at all.
    const blind = h.registry({ assistantOf: undefined });
    expect(() => blind.issue({ ...h.placement, operationId: `${LAUNCH}y` }).bindSession("claude", "s-assistant")).toThrow(/只读执行权限/);
  });

  it("keeps its flavour through restart restore, recovery rotation and renewal, whatever the renewal asks for", () => {
    const h = harness();
    h.register("s-assistant");
    const before = h.registry();
    const issued = before.issue(h.placement);
    issued.bindSession("claude", "s-assistant");
    const oldPrincipal = h.principalOf(issued.token);
    before.close();

    // Bot restart: the scope comes back from the read-only table, as itself.
    const after = h.registry();
    expect(after.restore()).toBe(1);
    expect(after.resolve(oldPrincipal)).toMatchObject({ permissionProfile: "read_only", docShare: SHARE, executionGrant: null });
    expect(h.executionCapabilities.open).not.toHaveBeenCalled();

    // Runner restart: recovery rotates a fresh bearer of the same flavour.
    const recovered = after.issueRecovery({ owner: "lht", runtimeDevice: "laptop", source: "claude", sessionId: "s-assistant" });
    expect(decodeMcpTokenPolicy(h.store.getActiveMcpTokenByHash(hashRunnerToken(recovered!.token), "2026-10-30T08:00:00.000Z")!.policy_json))
      .toMatchObject({ groups: ["workspace"], sessionExecution: { permissionProfile: "read_only", docShare: SHARE } });
    expect(after.resolve(oldPrincipal)).toBeNull();

    // Expired: a renewal that asks for full access still gets the read-only scope of its share.
    after.releaseDocShare(SHARE);
    expect(after.dispatchForSession({ owner: "lht", runtimeDevice: "laptop", source: "claude", sessionId: "s-assistant" })).toBeNull();
    const renewed = after.renewSession({ owner: "lht", runtimeDevice: "laptop", executionDevice: "laptop", workspaceId: WS,
      operationId: "op_fdam_renew", source: "claude", sessionId: "s-assistant", permissionProfile: "full_access" });
    const renewedPolicy = decodeMcpTokenPolicy(h.store.getActiveMcpTokenByHash(hashRunnerToken(renewed.token), "2026-10-30T08:00:00.000Z")!.policy_json);
    expect(renewedPolicy).toEqual(mcpDocAssistantPolicy({ operationId: "op_fdam_renew", device: "laptop", workspaceId: WS, docShare: SHARE }));
    expect(h.executionCapabilities.open).not.toHaveBeenCalled();
    // Rows live only in the table older releases never read.
    expect(h.store.listActiveSessionExecutionBindings("2026-10-30T08:00:00.000Z").map((row) => [row.session_id, row.permission_profile, row.doc_share_id]))
      .toEqual([["s-assistant", "read_only", SHARE]]);
    // Placement never moves, and nothing else renews as read-only.
    expect(() => after.renewSession({ owner: "lht", runtimeDevice: "laptop", executionDevice: "laptop", workspaceId: `ws_${"9".repeat(24)}`,
      operationId: "op_moved", source: "claude", sessionId: "s-assistant", permissionProfile: "read_only" })).toThrow(/执行放置/);
    expect(() => after.renewSession({ owner: "lht", runtimeDevice: "laptop", executionDevice: "laptop", workspaceId: WS,
      operationId: "op_other", source: "claude", sessionId: "s-ordinary", permissionProfile: "read_only" })).toThrow(/登记的文档助手/);
  });

  it("ends with its assistant: no renewal, no recovery, and releasing its share takes the scope, token and binding at once", () => {
    const h = harness();
    h.register("s-assistant");
    const registry = h.registry();
    const issued = registry.issue(h.placement);
    issued.bindSession("claude", "s-assistant");
    const principal = h.principalOf(issued.token);
    h.register("s-assistant", false);
    expect(registry.issueRecovery({ owner: "lht", runtimeDevice: "laptop", source: "claude", sessionId: "s-assistant" })).toBeNull();
    expect(() => registry.renewSession({ owner: "lht", runtimeDevice: "laptop", executionDevice: "laptop", workspaceId: WS,
      operationId: "op_after_end", source: "claude", sessionId: "s-assistant", permissionProfile: "full_access" })).toThrow(/已经结束/);
    registry.releaseDocShare(SHARE);
    expect(registry.resolve(principal)).toBeNull();
    expect(h.store.getActiveMcpTokenByHash(hashRunnerToken(issued.token), "2026-10-30T08:00:00.000Z")).toBeUndefined();
    expect(h.store.getSessionExecutionBinding("lht", "laptop", "claude", "s-assistant", "0000-01-01T00:00:00.000Z")).toBeUndefined();
  });

  it("goes for good across bot restarts: released after a restore, released while never restored, or found ended at boot", () => {
    const AT = "2026-10-30T08:00:00.000Z";
    const stored = (store: Store) => store.getSessionExecutionBinding("lht", "laptop", "claude", "s-assistant", "0000-01-01T00:00:00.000Z");
    const launched = () => {
      const h = harness();
      h.register("s-assistant");
      const before = h.registry();
      const issued = before.issue(h.placement);
      issued.bindSession("claude", "s-assistant");
      before.close();
      const gone = () => !h.store.getActiveMcpTokenByHash(hashRunnerToken(issued.token), AT) && !stored(h.store);
      return { h, principal: h.principalOf(issued.token), gone };
    };
    // Restored (no plaintext in memory any more), then released with its assistant: token and binding go.
    const restored = launched();
    const after = restored.h.registry();
    expect(after.restore()).toBe(1);
    after.releaseDocShare(SHARE);
    expect(restored.gone()).toBe(true);
    after.close();
    expect(restored.h.registry().restore()).toBe(0);
    // Never restored in this process: the stored binding of its share still goes.
    const cold = launched();
    cold.h.registry().releaseDocShare(SHARE);
    expect(cold.gone()).toBe(true);
    // Ended while the bot was down: boot does not bring it back, and drops what was stored.
    const ended = launched();
    ended.h.register("s-assistant", false);
    const booted = ended.h.registry();
    expect(booted.restore()).toBe(0);
    expect(booted.docShareScope("lht", ended.principal.credential)).toBeNull();
    expect(ended.gone()).toBe(true);
  });

  it("revokes a restored scope's token and binding when it is released for its owner or device, plaintext or not", () => {
    const AT = "2026-10-30T08:00:00.000Z";
    for (const release of [(r: SessionExecutionRegistry) => r.releaseOwner("lht"), (r: SessionExecutionRegistry) => r.releaseDevice("lht", "laptop")]) {
      const h = harness();
      h.register("s-assistant");
      const before = h.registry();
      const issued = before.issue(h.placement);
      issued.bindSession("claude", "s-assistant");
      before.close();
      const after = h.registry();
      expect(after.restore()).toBe(1);
      release(after);
      expect(h.store.getActiveMcpTokenByHash(hashRunnerToken(issued.token), AT)).toBeUndefined();
      expect(h.store.getSessionExecutionBinding("lht", "laptop", "claude", "s-assistant", "0000-01-01T00:00:00.000Z")).toBeUndefined();
    }
  });

  it("keeps one stored binding per session: a row saved in one table replaces its twin in the other", () => {
    const h = harness();
    const AT = "2026-10-30T08:00:00.000Z";
    const row = { owner: "lht", runtime_owner: "lht", runtime_device: "laptop", runtime_resource_id: null, source: "claude" as const, session_id: "s-1",
      operation_id: "op_1", execution_device: "laptop", workspace_id: WS, token_hash: "a".repeat(64), expires_at: "2026-10-31T00:00:00.000Z",
      created_at: AT, updated_at: AT };
    const profiles = () => h.store.listActiveSessionExecutionBindings(AT).map((each) => each.permission_profile);
    h.store.saveSessionExecutionBinding({ ...row, permission_profile: "full_access" });
    h.store.saveSessionExecutionBinding({ ...row, permission_profile: "read_only", doc_share_id: SHARE });
    expect(profiles()).toEqual(["read_only"]);
    h.store.saveSessionExecutionBinding({ ...row, permission_profile: "manual" });
    expect(profiles()).toEqual(["manual"]);
  });
});
