import { afterEach, describe, expect, it, vi } from "vitest";
import { PermissionService } from "../permissions/service.js";
import { hashRunnerToken } from "../runner/gateway.js";
import { SessionHubService } from "../sessionhub/service.js";
import { Store } from "../store/store.js";
import { MCP_FEISHU_OPERATION_IDS, MCP_SUBJECT_ID, mcpSubjectEntry } from "./catalog.js";
import { MCP_AGENT_ACCOUNT_TOOL_GROUPS } from "./policy-contract.js";
import { McpSurface, type McpFeishuPlane, type McpPrincipal } from "./service.js";
import { SessionExecutionRegistry } from "./session-execution.js";
import { decodeMcpTokenPolicy, mcpCredentialOf, mcpTokenPolicy } from "./tokens.js";

const WORKSPACE = "ws_0123456789abcdef01234567";
const SESSION_RIGHTS = ["list_recent_sessions", "search_sessions", "read_session", "append_session"];
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

function harness() {
  const store = new Store(":memory:");
  let now = Date.now();
  for (const [index, username] of ["alice", "bob"].entries()) {
    store.saveUser({ username, uid: 5001 + index, home_dir: "/unused", created_at: new Date(now).toISOString() });
  }
  const permissions = new PermissionService({
    store,
    subjects: [mcpSubjectEntry({ workspaceComposed: () => false, crdtComposed: () => false,
      feishuComposed: () => true, feishuPrivilegedOperations: () => [] })],
    extraAccountOperations: [() => [...SESSION_RIGHTS, ...MCP_FEISHU_OPERATION_IDS]],
  });
  permissions.grant({ subjectType: "service", subjectId: MCP_SUBJECT_ID, owner: "alice",
    operations: ["calendar_primary", "calendar_create_event"], autoAllow: ["calendar_primary"],
    source: "user", createdBy: "alice" });
  let connected = true;
  const request = vi.fn(async (_slot: string, operation: string) => operation === "calendar_create_event"
    ? { status: "approval_required" as const, pendingCallId: "pending-calendar" }
    : { status: "succeeded" as const, result: { calendar_id: "alice-calendar" } });
  const destroy = vi.fn();
  const feishu: McpFeishuPlane = {
    runnable: () => new Set(MCP_FEISHU_OPERATION_IDS),
    open: vi.fn(() => connected ? { slot: "alice-feishu", capabilities: { request, result: () => null }, destroy } : null),
    openPrivileged: vi.fn(() => null),
  };
  const registry = new SessionExecutionRegistry({ store, dashboardPort: 9820, now: () => now,
    workspaceCapabilities: { open: () => ({ contextId: "workspace", destroy() {} }) } as never,
    executionCapabilities: { open: () => ({ destroy() {} }) } as never,
    workspaceFilesService: { open: () => ({}), closeScope: async () => {} } as never,
  });
  const hub = new SessionHubService({ store, permissions });
  const releaseHub = vi.spyOn(hub, "releaseCredential");
  const surface = new McpSurface({ hub, permissions, feishu, sessionExecution: registry });
  const principal = (token: string): McpPrincipal => {
    const row = store.getActiveMcpTokenByHash(hashRunnerToken(token), new Date(now).toISOString())!;
    return { owner: row.username, credential: mcpCredentialOf(row.token_hash), policy: decodeMcpTokenPolicy(row.policy_json) };
  };
  let sequence = 0;
  const issue = (profile: "manual" | "full_access" = "full_access", issuer?: string, owner = "alice") => {
    const credential = registry.issue({ owner, runtimeOwner: owner === "alice" ? "bob" : "alice",
      runtimeResourceId: "agent-runtime:0123456789abcdef0123456789abcdef",
      operationId: `managed-${++sequence}`, runtimeDevice: "model-host", executionDevice: "worker",
      workspaceId: WORKSPACE, permissionProfile: profile, ...(issuer ? { issuer } : {}) });
    return { ...credential, principal: principal(credential.token) };
  };
  cleanup.push(() => { surface.close(); permissions.close(); store.close(); });
  return { store, surface, hub, registry, feishu, request, destroy, issue, principal, releaseHub, permissions,
    disconnect: () => { connected = false; }, expire: () => { now += 25 * 60 * 60_000; } };
}

describe("managed agent account tool parity", () => {
  it.each(["manual", "full_access"] as const)("shares the local bridge catalog and owner identity under %s", async profile => {
    const h = harness();
    const managed = h.issue(profile);
    const local = { owner: "alice", credential: "runner-local:laptop",
      policy: mcpTokenPolicy({ groups: MCP_AGENT_ACCOUNT_TOOL_GROUPS }) };
    const localTools = h.surface.listTools(local);
    const workspaceTools = new Set(["list_session_workspaces", "list_workspace_entries", "read_workspace_text",
      "replace_workspace_text", "run_workspace_command"]);
    expect(h.surface.listTools(managed.principal).filter(tool => !workspaceTools.has(tool.name))).toEqual(localTools);
    expect(localTools.map(tool => tool.name)).toEqual(expect.arrayContaining([
      "feishu_calendar_primary", "feishu_calendar_create_event", "list_recent_sessions", "send_session_message",
    ]));
    expect(await h.surface.callTool(local, "feishu_calendar_primary", {})).toMatchObject({ ok: true });
    expect(await h.surface.callTool(managed.principal, "feishu_calendar_primary", {})).toMatchObject({ ok: true });
    expect(h.feishu.open).toHaveBeenLastCalledWith(expect.objectContaining({ username: "alice" }));
    expect(h.feishu.open).not.toHaveBeenCalledWith(expect.objectContaining({ username: "bob" }));
    expect(await h.surface.callTool(managed.principal, "feishu_calendar_create_event", {
      calendar_id: "alice-calendar", summary: "review", start_timestamp: "1786608000", end_timestamp: "1786611600",
    })).toMatchObject({ ok: false, code: "approval_required" });
    const roster = vi.spyOn(h.hub, "roster").mockResolvedValue({ sessions: [], sources: [], returned: 0 } as never);
    expect(await h.surface.callTool(managed.principal, "list_recent_sessions", {})).toMatchObject({ ok: true });
    expect(roster).toHaveBeenCalledWith(expect.objectContaining({ username: "alice", session: false, admin: false }),
      "alice", expect.objectContaining({ includeSessionPlus: true }));
    expect(await h.surface.callTool(managed.principal, "feishu_calendar_primary", { owner: "bob" }))
      .toMatchObject({ ok: false, code: "invalid_params" });
  });

  it("preserves token attenuation, deployment ceilings and the dedicated workspace-only door", async () => {
    const h = harness();
    const narrow = h.issue("full_access", "mcp:on-demand");
    for (const name of ["feishu_calendar_primary", "list_recent_sessions"]) {
      expect(h.surface.listTools(narrow.principal).map(tool => tool.name)).not.toContain(name);
      expect(await h.surface.callTool(narrow.principal, name, {})).toMatchObject({ ok: false, code: "unknown_tool" });
    }
    const managed = h.issue();
    for (const name of ["feishu_message_send_as_bot", "app_list", "open_workspace_execution"]) {
      expect(h.surface.listTools(managed.principal).map(tool => tool.name)).not.toContain(name);
      expect((await h.surface.callTool(managed.principal, name, {})).ok).toBe(false);
    }
    const narrowed = { ...managed.principal, policy: { ...managed.principal.policy!, groups: ["workspace"] as const } };
    expect(await h.surface.callTool(narrowed, "feishu_calendar_primary", {}))
      .toMatchObject({ ok: false, code: "unknown_tool" });
    expect(h.request).not.toHaveBeenCalled();
  });

  it("does not borrow the model host's grants or fall back when OAuth is disconnected", async () => {
    const h = harness();
    const bob = h.issue("full_access", undefined, "bob");
    expect(h.surface.listTools(bob.principal).map(tool => tool.name)).not.toContain("feishu_calendar_primary");
    expect(await h.surface.callTool(bob.principal, "feishu_calendar_primary", {}))
      .toMatchObject({ ok: false, code: "no_authority" });
    const alice = h.issue();
    expect(await h.surface.callTool({ ...alice.principal, owner: "bob" }, "feishu_calendar_primary", {}))
      .toMatchObject({ ok: false, code: "no_authority" });
    h.disconnect();
    expect(await h.surface.callTool(alice.principal, "feishu_calendar_primary", {}))
      .toMatchObject({ ok: false, code: "no_authority" });
    expect(h.feishu.openPrivileged).not.toHaveBeenCalled();
    expect(h.request).not.toHaveBeenCalled();
  });

  it("retires derived grants and pending authority with the managed credential", async () => {
    const h = harness();
    const managed = h.issue();
    expect(await h.surface.callTool(managed.principal, "feishu_calendar_create_event", {
      calendar_id: "alice-calendar", summary: "review", start_timestamp: "1786608000", end_timestamp: "1786611600",
    })).toMatchObject({ ok: false, code: "approval_required" });
    managed.release();
    expect(h.destroy).toHaveBeenCalledTimes(1);
    expect(h.releaseHub).toHaveBeenCalledWith("alice", managed.credential);
    expect(h.surface.listTools(managed.principal)).toEqual([]);
    expect(await h.surface.callTool(managed.principal, "feishu_calendar_primary", {}))
      .toMatchObject({ ok: false, code: "no_authority" });
    expect(h.request).toHaveBeenCalledTimes(1);
    const expired = h.issue();
    h.expire();
    expect(h.surface.listTools(expired.principal)).toEqual([]);
    expect(await h.surface.callTool(expired.principal, "list_recent_sessions", {}))
      .toMatchObject({ ok: false, code: "no_authority" });
  });

  it("keeps account tools on exact-session recovery and releases the old grants", async () => {
    const h = harness();
    const managed = h.issue();
    managed.bindSession("codex", "thread-managed");
    await h.surface.callTool(managed.principal, "feishu_calendar_primary", {});
    const recovered = h.registry.issueRecovery({ owner: "alice", runtimeDevice: "model-host",
      source: "codex", sessionId: "thread-managed" })!;
    expect(recovered.token).not.toBe(managed.token);
    expect(h.destroy).toHaveBeenCalledTimes(1);
    expect(h.surface.listTools(managed.principal)).toEqual([]);
    const recoveredPrincipal = h.principal(recovered.token);
    expect(await h.surface.callTool(recoveredPrincipal, "feishu_calendar_primary", {}))
      .toMatchObject({ ok: true });
    h.permissions.grant({ subjectType: "service", subjectId: MCP_SUBJECT_ID, owner: "alice",
      operations: [], autoAllow: [], source: "user", createdBy: "alice" });
    expect(h.surface.listTools(recoveredPrincipal)).toEqual([]);
  });
});
