import { afterEach, describe, expect, it, vi } from "vitest";
import { CapabilityService } from "@claude-bot/capability-kernel";
import { RunnerExtensionCapabilities, RUNNER_EXTENSION_OPERATIONS } from "../runner/extension-capability.js";
import { RUNNER_EXTENSION_MCP_TOOLS } from "../runner/extension-contract.js";
import type { RunnerTransport } from "../runner/gateway.js";
import { Store } from "../store/store.js";
import { PermissionService } from "../permissions/service.js";
import { SessionHubService } from "../sessionhub/service.js";
import { McpSurface } from "./service.js";
import { mcpSubjectEntry } from "./catalog.js";
import { mcpTokenPolicy, mcpSessionExecutionPolicy } from "./tokens.js";
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const store = new Store(":memory:"), kernel = new CapabilityService();
  store.saveUser({ username: "alice", uid: 1, home_dir: "/unused", created_at: "now" });
  const provider = { id: "demo", title: "Demo", version: "1", revision: "a".repeat(32), status: "ready", tools: [
    { name: "echo", description: "Echo", inputSchema: { type: "object", properties: { value: { type: "string" } } } },
  ] };
  const devices = [{ device: "compute", online: true, inventory: { capabilities: { protocol: "runner-capabilities/v1", providers: [provider] } } }];
  const dispatch = vi.fn(async (_owner: string, _operation: string, args: Record<string, unknown>) =>
    ({ status: "succeeded", request_id: args.request_id, revision: args.revision, result: { content: [{ type: "text", text: "ok" }] } }));
  const capabilities = new RunnerExtensionCapabilities({ service: kernel,
    transport: { dispatch, listDevices: (owner: string) => owner === "alice" ? devices : [] } as unknown as RunnerTransport,
    userExists: owner => !!store.getUser(owner), hasDevice: owner => owner === "alice" });
  const permissions = new PermissionService({ store, subjects: [mcpSubjectEntry({ workspaceComposed: () => false,
    crdtComposed: () => false, runnerCapabilitiesComposed: () => true })], extraAccountOperations: [owner => capabilities.accountOperations(owner)] });
  const surface = new McpSurface({ hub: new SessionHubService({ store, permissions }), permissions, runnerCapabilities: capabilities,
    sessionExecution: { resolve: () => ({}), close: vi.fn(), releaseCredential: vi.fn(), releaseOwner: vi.fn(), releaseDevice: vi.fn() } as never });
  cleanup.push(() => { surface.close(); permissions.close(); kernel.close(); store.close(); });
  const principal = { owner: "alice", credential: "test", policy: mcpTokenPolicy({ groups: ["runner_capabilities"] }) };
  const operations = Object.keys(RUNNER_EXTENSION_OPERATIONS);
  const grant = (autoAllow = operations, rights = operations) => permissions.grant({
    owner: "alice", subjectType: "service", subjectId: "mcp", operations: rights, autoAllow, source: "user", createdBy: "alice",
  });
  const ref = async () => {
    const result = await surface.callTool(principal, "runner_capability_list", {});
    if (!result.ok) throw new Error(JSON.stringify(result));
    return (result.result as { capabilities: { capability_ref: string }[] }).capabilities[0]!.capability_ref;
  };
  return { surface, kernel, capabilities, provider, devices, principal, dispatch, grant, ref, operations };
}
describe("dynamic Runner capability MCP authority", () => {
  it("retires credential scopes on Runner identity changes so later discovery can open fresh authority", async () => {
    const f = fixture(); f.grant();
    const first = await f.ref();
    f.capabilities.revokeAccount("alice");
    f.surface.releaseRunnerDevice("alice", "compute");
    expect(await f.ref()).toBe(first);
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it("requires explicit independent rights, narrows token groups and derives schemas from the contract", async () => {
    const f = fixture();
    expect(f.surface.listTools(f.principal)).toEqual([]);
    expect(await f.surface.callTool(f.principal, "runner_capability_list", {})).toMatchObject({ ok: false, code: "no_authority" });
    f.grant();
    expect(f.surface.listTools(f.principal)).toEqual(RUNNER_EXTENSION_MCP_TOOLS);
    const ref = await f.ref();
    expect(await f.surface.callTool(f.principal, "runner_capability_describe", { capability_ref: ref })).toMatchObject({ ok: true, result: { name: "echo", inputSchema: { type: "object" } } });
    for (const extra of [{ owner: "bob" }, { device: "other" }, { command: "sh" }]) expect(await f.surface.callTool(f.principal, "runner_capability_call", {
      capability_ref: ref, request_id: "one", input_json: "{}", ...extra,
    })).toMatchObject({ ok: false, code: "invalid_params" });
    expect(await f.surface.callTool({ ...f.principal, policy: mcpTokenPolicy({ groups: ["execution"] }) }, "runner_capability_list", {})).toMatchObject({ code: "unknown_tool" });
    expect(f.surface.listTools({ ...f.principal, owner: "bob" })).toEqual([]);
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it("approves a pinned call once and prevents approval from retargeting a changed provider", async () => {
    const f = fixture(); f.grant(f.operations.filter(op => op !== "invoke_runner_capability"));
    const args = { capability_ref: await f.ref(), request_id: "one", input_json: "{}" };
    expect(await f.surface.callTool(f.principal, "runner_capability_call", args)).toMatchObject({ code: "approval_required" });
    expect(await f.surface.callTool(f.principal, "runner_capability_call", args)).toMatchObject({ code: "approval_required" });
    expect(f.kernel.listPending("alice")).toHaveLength(1);
    expect((await f.kernel.approve(f.kernel.listPending("alice")[0]!.id, "alice")).status).toBe("succeeded");
    expect(await f.surface.callTool(f.principal, "runner_capability_call", args)).toMatchObject({ ok: true });
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    expect(f.dispatch).toHaveBeenCalledWith("alice", "invoke_runner_capability", expect.objectContaining({ device: "compute", provider: "demo", revision: "a".repeat(32) }));
    await f.surface.callTool(f.principal, "runner_capability_call", { ...args, request_id: "two" });
    f.provider.revision = "b".repeat(32);
    expect((await f.kernel.approve(f.kernel.listPending("alice")[0]!.id, "alice")).status).not.toBe("succeeded");
    expect(f.dispatch).toHaveBeenCalledTimes(1);
  });
  it("publishes hot additions without reconnecting MCP, including opted-in managed agents", async () => {
    const f = fixture(); f.grant();
    const scoped = { ...f.principal, credential: "session", policy: mcpSessionExecutionPolicy({
      operationId: "op-live", runtimeDevice: "runtime", executionDevice: "compute",
      workspaceId: "ws_" + "a".repeat(24), permissionProfile: "full_access",
    }, { accountTools: true }) };
    expect(f.surface.listTools(scoped).map(row => row.name)).toContain("runner_capability_list");
    f.provider.tools.push({ name: "new-tool", description: "New", inputSchema: { type: "object", properties: { value: { type: "string" } } } });
    expect(JSON.stringify(await f.surface.callTool(scoped, "runner_capability_list", {}))).toContain("new-tool");
    f.devices[0]!.online = false;
    expect(await f.surface.callTool(scoped, "runner_capability_list", {})).toMatchObject({ ok: true, result: { capabilities: [] } });
  });
  it("withholds late results on revocation and marks transport uncertainty without replay", async () => {
    const f = fixture(); f.grant();
    const args = { capability_ref: await f.ref(), request_id: "one", input_json: "{}" };
    f.dispatch.mockRejectedValueOnce(Object.assign(new Error("lost"), { code: "runner_gone" }));
    expect(await f.surface.callTool(f.principal, "runner_capability_call", args)).toMatchObject({ ok: false, code: "indeterminate" });
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    let finish!: (value: never) => void;
    f.dispatch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.surface.callTool(f.principal, "runner_capability_call", { ...args, request_id: "two" });
    await vi.waitFor(() => expect(f.dispatch).toHaveBeenCalledTimes(2));
    f.grant([], []);
    finish({ status: "succeeded", request_id: "two", revision: f.provider.revision, result: "secret" } as never);
    expect(await pending).toMatchObject({ ok: false, code: "no_authority" });
    expect(f.surface.listTools(f.principal)).toEqual([]);
  });
});
