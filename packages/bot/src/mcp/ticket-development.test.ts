import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../store/store.js";
import { PermissionService } from "../permissions/service.js";
import { SessionHubService } from "../sessionhub/service.js";
import { dispatchDevpipeTool, type DevpipeToolPort } from "../devpipe/tool-dispatch.js";
import { DEVPIPE_TOOLS, devpipeToolsForTicket } from "../devpipe/tool-contract.js";
import { McpSurface, type McpPrincipal } from "./service.js";
import { handleMcpRpc } from "./http.js";
import { decodeMcpTokenPolicy, mcpSessionExecutionPolicy, mcpTokenPolicy } from "./tokens.js";
import {
  TicketDevelopmentRegistry, type TicketDevelopmentBinding, type TicketDevelopmentCredential,
} from "./ticket-development.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function harness() {
  const store = new Store(":memory:");
  store.saveUser({ username: "alice", uid: 1, home_dir: "/x/alice", created_at: "2026-09-15" });
  const current: TicketDevelopmentBinding = { owner: "alice", ticketId: 578, turn: 4, developmentId: "development_578" };
  let now = Date.parse("2026-09-15T08:00:00Z");
  const isCurrent = vi.fn((binding: Readonly<TicketDevelopmentBinding>) =>
    binding.owner === current.owner && binding.ticketId === current.ticketId
    && binding.turn === current.turn && binding.developmentId === current.developmentId);
  const dispatch = vi.fn(async (_binding: Readonly<TicketDevelopmentBinding>, _op: string, _args: Record<string, unknown>): Promise<unknown> => ({ ok: true }));
  const hasKnowledgeConflict = vi.fn(() => false);
  const options = { hasKnowledgeConflict, store, publicUrl: "https://bot.example", dashboardPort: 9820, now: () => now, isCurrent, dispatch };
  const registry = new TicketDevelopmentRegistry(options);
  cleanups.push(() => { registry.close(); store.close(); });
  function principal(credential: TicketDevelopmentCredential): McpPrincipal {
    const row = store.listMcpTokens("alice").find((token) => credential.credential === `mcp:${token.token_hash.slice(0, 16)}`)!;
    return { owner: "alice", credential: credential.credential, policy: decodeMcpTokenPolicy(row.policy_json) };
  }
  return { store, current, options, registry, dispatch, isCurrent, principal, advance: (ms: number) => { now += ms; } };
}

describe("internally scoped ticket development MCP", () => {
  it("accepts a long CI command through the declared ticket tool without truncating it", async () => {
    const h = harness();
    const principal = h.principal(h.registry.issue(h.current));
    const tool = h.registry.listTools(principal).find((entry) => entry.name === "devpipe_ci_job")!;
    expect(tool.inputSchema.properties.command).toEqual({ type: "string" });
    const args = { action: "start", request_key: "long-script", command: `# ${"章鱼".repeat(10_000)}\nprintf done` };
    expect(await h.registry.callTool(principal, "devpipe_ci_job", args)).toMatchObject({ ok: true });
    expect(h.dispatch).toHaveBeenCalledWith(h.current, "ci-job", args);
  });

  it("uses the normal HTTP tool surface and server-owned binding without target arguments", async () => {
    const h = harness();
    const issued = h.registry.issue(h.current);
    expect(issued.endpoint).toBe("https://bot.example/api/mcp");
    const principal = h.principal(issued);
    const permissions = new PermissionService({ store: h.store, subjects: [] });
    const surface = new McpSurface({
      hub: new SessionHubService({ store: h.store, permissions }), permissions, ticketDevelopment: h.registry,
    });
    const initialized = await handleMcpRpc({ jsonrpc: "2.0", id: 0, method: "initialize" }, surface, principal);
    expect(initialized.body).toMatchObject({ result: { instructions: expect.stringContaining("本票本轮") } });
    expect(JSON.stringify(initialized.body)).not.toContain(issued.token);
    const listed = await handleMcpRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, surface, principal);
    expect(listed.body).toMatchObject({ result: { tools: devpipeToolsForTicket(false) } });
    const answer = await handleMcpRpc({
      jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "devpipe_rename", arguments: { title: "原会话修复" } },
    }, surface, principal);
    expect(answer.body).toMatchObject({ result: { structuredContent: { ok: true } } });
    expect(h.dispatch).toHaveBeenCalledWith(h.current, "rename", { title: "原会话修复" });
    expect(Object.isFrozen(h.dispatch.mock.calls[0][0])).toBe(true);
  });

  it("lists and accepts conflict tools only while the trusted ticket has a conflict", async () => {
    const h = harness();
    const principal = h.principal(h.registry.issue(h.current));
    const names = ["devpipe_conflict_read", "devpipe_conflict_resolve"];
    for (const name of names) {
      expect(DEVPIPE_TOOLS.some((tool) => tool.name === name)).toBe(true);
      expect(h.registry.listTools(principal).some((tool) => tool.name === name)).toBe(false);
      expect(await h.registry.callTool(principal, name, {})).toMatchObject({ ok: false, code: "unknown_tool" });
    }
    expect(h.dispatch).not.toHaveBeenCalled();
    h.options.hasKnowledgeConflict.mockReturnValue(true);
    for (const name of names) {
      expect(h.registry.listTools(principal).some((tool) => tool.name === name)).toBe(true);
      expect(await h.registry.callTool(principal, name, {})).toMatchObject({ ok: true });
    }
    expect(h.options.hasKnowledgeConflict).toHaveBeenCalledWith(h.current);
    expect(h.dispatch).toHaveBeenCalledTimes(2);
    h.options.hasKnowledgeConflict.mockReturnValue(false);
    expect(await h.registry.callTool(principal, names[0], {})).toMatchObject({ ok: false, code: "unknown_tool" });
    expect(h.dispatch).toHaveBeenCalledTimes(2);
  });

  it("does not expose development tools to ordinary or same-device session execution credentials", async () => {
    const h = harness();
    const permissions = new PermissionService({ store: h.store, subjects: [] });
    const surface = new McpSurface({
      hub: new SessionHubService({ store: h.store, permissions }), permissions, ticketDevelopment: h.registry,
      sessionExecution: { resolve: () => ({}), close: vi.fn() } as never,
    });
    const principals: McpPrincipal[] = [
      { owner: "alice", credential: "browser" },
      { owner: "alice", credential: "personal", policy: mcpTokenPolicy({}) },
      { owner: "alice", credential: "session", policy: mcpSessionExecutionPolicy({
        operationId: "op_1", runtimeDevice: "same-runner", executionDevice: "same-runner",
        workspaceId: "ws_" + "a".repeat(24), permissionProfile: "full_access",
      }) },
    ];
    for (const principal of principals) {
      expect(surface.listTools(principal).some((tool) => tool.name.startsWith("devpipe_"))).toBe(false);
      expect(await surface.callTool(principal, "devpipe_submit", {})).toMatchObject({ ok: false, code: "unknown_tool" });
    }
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it("refuses client target substitution and malformed arguments before any pipeline call", async () => {
    const h = harness();
    const principal = h.principal(h.registry.issue(h.current));
    for (const args of [
      { ticketId: 580 }, { ticket: 580 }, { owner: "bob" }, { token: "other" },
      { developmentId: "other" }, { turn: 5 }, [], "not an object",
    ]) {
      expect(await h.registry.callTool(principal, "devpipe_status", args)).toMatchObject({ ok: false, code: "invalid_params" });
    }
    expect(await h.registry.callTool(principal, "read_session", {})).toMatchObject({ ok: false, code: "unknown_tool" });
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it("rejects owner, ticket, turn and development mismatches without revoking the real scope", async () => {
    const h = harness();
    const principal = h.principal(h.registry.issue(h.current));
    const policy = principal.policy!;
    const scope = policy.ticketDevelopment!;
    const impostors = [
      { ...principal, owner: "bob" },
      ...[{ ticketId: 580 }, { turn: 5 }, { developmentId: "other" }].map((changed) => ({
        ...principal, policy: { ...policy, ticketDevelopment: { ...scope, ...changed } },
      })),
    ];
    for (const impostor of impostors) {
      expect(h.registry.listTools(impostor)).toEqual([]);
      expect(await h.registry.callTool(impostor, "devpipe_status", {})).toMatchObject({ ok: false, code: "no_authority" });
    }
    expect(h.registry.listTools(principal).length).toBeGreaterThan(0);
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it("checks the persisted current binding on every list and call", async () => {
    const h = harness();
    const principal = h.principal(h.registry.issue(h.current));
    expect(h.registry.listTools(principal).length).toBeGreaterThan(0);
    h.current.developmentId = "replacement";
    expect(h.registry.listTools(principal)).toEqual([]);
    expect(await h.registry.callTool(principal, "devpipe_status", {})).toMatchObject({ ok: false, code: "no_authority" });
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(() => h.registry.issue({ ...h.current, owner: "bob" })).toThrow(/失效/);
  });

  it("renews a later turn and prevents old cleanup from closing its replacement", async () => {
    const h = harness();
    const first = h.registry.issue(h.current);
    const previous = h.principal(first);
    h.current.turn++;
    const second = h.registry.renew(h.current);
    const next = h.principal(second);
    expect(second.token).not.toBe(first.token);
    expect(second.endpoint).toBe(first.endpoint);
    first.release();
    expect(h.registry.listTools(previous)).toEqual([]);
    expect(await h.registry.callTool(next, "devpipe_status", {})).toMatchObject({ ok: true });
    expect(h.dispatch).toHaveBeenCalledOnce();
    second.release();
    h.current.turn++;
    expect(h.registry.listTools(h.principal(h.registry.renew(h.current))).length).toBeGreaterThan(0);
  });

  it("fails closed after Head restart even when the old token row still authenticates", async () => {
    const h = harness();
    const first = h.registry.issue(h.current);
    const previous = h.principal(first);
    const restarted = new TicketDevelopmentRegistry(h.options);
    cleanups.push(() => restarted.close());
    expect(h.store.listMcpTokens("alice")[0].revoked_at).toBeNull();
    expect(restarted.listTools(previous)).toEqual([]);
    expect(await restarted.callTool(previous, "devpipe_status", {})).toMatchObject({ ok: false, code: "no_authority" });
    const renewed = restarted.renew(h.current);
    first.release();
    expect(restarted.listTools(h.principal(renewed)).length).toBeGreaterThan(0);
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it("honors bearer revocation and expiry before dispatch", async () => {
    const h = harness();
    const first = h.registry.issue(h.current, 1000);
    const principal = h.principal(first);
    h.advance(1000);
    expect(await h.registry.callTool(principal, "devpipe_status", {})).toMatchObject({ ok: false, code: "no_authority" });
    const next = h.registry.renew(h.current);
    const row = h.store.listMcpTokens("alice").find((token) => !token.revoked_at)!;
    h.store.revokeMcpToken("alice", row.token_hash, new Date(h.options.now()).toISOString());
    expect(h.registry.listTools(h.principal(next))).toEqual([]);
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it("does not replay a dispatched operation when its turn ends before the reply", async () => {
    const h = harness();
    const issued = h.registry.issue(h.current);
    let finish!: (result: unknown) => void;
    h.dispatch.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = h.registry.callTool(h.principal(issued), "devpipe_submit", {});
    issued.release();
    finish({ ok: true, sha: "a".repeat(40) });
    expect(await pending).toMatchObject({ ok: false, code: "unknown" });
    expect(h.dispatch).toHaveBeenCalledOnce();
  });

  it("keeps dispatch exceptions unknown instead of making an implicit retry", async () => {
    const h = harness();
    h.dispatch.mockRejectedValueOnce(new Error("transport ended"));
    expect(await h.registry.callTool(h.principal(h.registry.issue(h.current)), "devpipe_submit", {}))
      .toMatchObject({ ok: false, code: "unknown" });
    expect(h.dispatch).toHaveBeenCalledOnce();
  });

  it("uses the same operation parser as the old loopback door and the workspace sync callback", async () => {
    const h = harness();
    const toolContext = vi.fn(async () => ({ ok: true, records: [] }));
    const toolWorkspaceSync = vi.fn(async () => ({ ok: false, code: "base_moved" }));
    const pipe = { toolContext, toolWorkspaceSync } as unknown as DevpipeToolPort;
    h.dispatch.mockImplementation(async (_binding, op, args) =>
      (await dispatchDevpipeTool(pipe, "trusted-live-turn-token", op, args)).body);
    const principal = h.principal(h.registry.issue(h.current));
    expect(await h.registry.callTool(principal, "devpipe_context", { paths: ["packages/bot/src/mcp", 4], question: "q" }))
      .toMatchObject({ ok: true, result: { records: [] } });
    expect(toolContext).toHaveBeenCalledWith("trusted-live-turn-token", ["packages/bot/src/mcp"], "q");
    expect(await h.registry.callTool(principal, "devpipe_workspace_sync", {}))
      .toEqual({ ok: true, result: { ok: false, code: "base_moved" } });
    expect(toolWorkspaceSync).toHaveBeenCalledWith("trusted-live-turn-token");
  });
});
