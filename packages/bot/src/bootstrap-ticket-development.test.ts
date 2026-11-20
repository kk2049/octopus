import { afterEach, expect, it, vi } from "vitest";
import { SESSION_OPERATION_PROTOCOL, type SessionOperationReceipt } from "@claude-bot/runner/gateway-protocol";
import { composeDashboardServices } from "./bootstrap-v3.js";
import type { DashboardCompositionOptions } from "./dashboard/ports.js";
import type { TicketRunnerAccess, TicketRunnerConfig } from "./devpipe/runner-ticket.js";
import { BundleHandoff } from "./devpipe/bundle-handoff.js";
import type { DevPipeline } from "./devpipe/pipeline.js";
import type { DevelopmentMcpCredential, DevelopmentTurnBinding } from "./devpipe/development-workspace.js";
import { RunnerCapabilities } from "./runner/capability.js";
import { hashRunnerToken, type RunnerTransport, type RunnerSessionRecoveryIssuer } from "./runner/gateway.js";
import { WorkspaceFilesCapabilities } from "./workspace-files/capability.js";
import { ExecutionWorkspaceCapabilities } from "./execution-workspace/capability.js";
import { decodeMcpTokenPolicy, mcpCredentialOf } from "./mcp/tokens.js";
import type { McpPrincipal } from "./mcp/service.js";
import { Store } from "./store/store.js";
import type { TicketRunnerTurn } from "./store/repositories/ticket-runner.js";

/** An explicit shared-pool configuration: two exact ticket roots, 4090 marked as the default. */
const SHARED_RUNNER_TICKETS: TicketRunnerConfig = {
  targets: { lht: { device: "aws-workbench", workspace_id: "ws_8c410918a6511e9bee1b52be", workspaces: [
    { device: "gpu-box", workspace_id: "ws_c41327ecf8889e341e712b24", label: "4090", default: true },
    { device: "aws-workbench", workspace_id: "ws_8c410918a6511e9bee1b52be", label: "aliyun · aws-env" },
  ] } },
  shared_pool: { owner: "lht", requesters: [], all_developers: true, source_devices: ["aws-workbench"],
    workspaces: [{ device: "gpu-box", workspace_id: "ws_c41327ecf8889e341e712b24" }], split_only: true,
    codex_accounts: ["@default", "account_b", "account_c", "account_d"].map((account) => ({ device: "aws-workbench", account })) },
};

const PARENT = "ws_" + "a".repeat(24), CHILD = "ws_" + "b".repeat(24);
const SID = "original-development-session";
const RIGHTS = ["start_session", "append_session", "get_session_operation"];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function harness(options: { sameDevice?: boolean; development?: boolean; failCompose?: boolean; shared?: boolean } = {}) {
  const store = new Store(":memory:");
  const at = new Date().toISOString();
  store.saveUser({ username: "alice", uid: 1, home_dir: "/unused", created_at: at });
  for (const device of ["model", "execution"]) store.saveRunnerToken(hashRunnerToken(device), "alice", device, at);
  store.grantCapability("alice", "dev", "test", at);
  const executionDevice = options.sameDevice ? "model" : "execution";
  const frames: Array<{ operation: string; args: Record<string, unknown> }> = [];
  const receipts = new Map<string, SessionOperationReceipt>();
  let online = true;
  const transport = {
    dispatch: async (_owner: string, operation: string, args: Record<string, unknown>) => {
      frames.push({ operation, args });
      if (operation === "list_session_workspaces") return { workspaces: [
        { id: PARENT, label: "registered parent" }, { id: CHILD, label: "ticket child from scoped RPC" },
      ] };
      return receipts.get(String(args.operation_id));
    },
    listDevices: () => ["model", "execution"].map((device) => ({ device, online,
      inventory: { ticket_options: { protocol: "ticket-options/v1", codex_accounts: [], workspaces: [{ id: PARENT, label: "parent" }] } } })),
    isOnline: () => online,
  } as unknown as RunnerTransport;
  const caps = new RunnerCapabilities(store, transport, { extraRootAutoAllow: () => RIGHTS });
  caps.ensureAccount("alice");
  const authorityOptions = { service: caps.service, transport, userExists: (owner: string) => Boolean(store.getUser(owner)),
    hasDevice: (owner: string) => store.listRunnerTokens(owner).length > 0 };
  const workspaceFiles = new WorkspaceFilesCapabilities(authorityOptions);
  const executionWorkspace = new ExecutionWorkspaceCapabilities(authorityOptions);
  const ticket = store.devTickets.createDevTicket({ title: "development wiring", body: "continue original session",
    requester: "alice", model: "codex-gpt-6-astra", effort: "high", kind: "simple", app_id: null });
  const development = options.development !== false;
  store.devTickets.runner.bind(ticket.id, { owner: "alice", device: "model", source: "codex", workspaceId: CHILD,
    ...(options.sameDevice ? {} : { executionDevice }) });
  if (development) store.devTickets.development.bind({ ticketId: ticket.id, owner: "alice", device: executionDevice,
    parentWorkspaceId: PARENT, worktreeWorkspaceId: CHILD, repositoryId: "test-repository",
    developmentId: "development-one", baseSha: "a".repeat(40) });
  const start: TicketRunnerTurn = { id: "start-one", ticketId: ticket.id, turn: 1, method: "start_session", state: "dispatched",
    args: { source: "codex", workspace_id: CHILD, client_request_id: "op_start_one", prompt: "one prompt",
      permission_profile: "full_access", ...(options.sameDevice ? {} : { execution_device: executionDevice }) } };
  store.devTickets.runner.save(start);
  let active = start;
  let credential: DevelopmentMcpCredential | undefined;
  let issue!: Parameters<DevPipeline["setDevelopmentWorkspaces"]>[1];
  let recovery!: RunnerSessionRecoveryIssuer;
  const offRecovery = vi.fn();
  const available = vi.fn(() => online);
  const binding = (): DevelopmentTurnBinding => ({ owner: "alice", ticketId: ticket.id, turn: active.turn, developmentId: "development-one" });
  // Pipeline custody is a narrow test port; execution/MCP registries, grants,
  // capability Gate and workspace root parsing below are the real composition.
  let runnerAccess: TicketRunnerAccess | undefined;
  const pipe = {
    setRunnerTickets: (access: TicketRunnerAccess) => { runnerAccess = access; },
    setDevelopmentWorkspaces: (_options: unknown, next: typeof issue) => { issue = next; },
    isCurrentDevelopmentTurn: (value: DevelopmentTurnBinding) => development && JSON.stringify(value) === JSON.stringify(binding()),
    developmentTurnToken: () => "trusted-turn-token",
    developmentDispatchArgs: (owner: string, _operation: string, args: Readonly<Record<string, unknown>>) =>
      credential && owner === "alice" && args.operation_id === active.id ? {
        _octopus_development_id: "development-one", _octopus_development_mcp_url: credential.endpoint,
        _octopus_development_mcp_token: credential.token,
      } : {},
    developmentRecoveryScope: (owner: string, device: string, source: string, sid: string) =>
      credential && owner === "alice" && device === "model" && source === "codex" && sid === SID
        ? { ...credential, developmentId: "development-one" } : undefined,
    developmentSessionRequired: (owner: string, device: string, source: string, sid: string) =>
      development && owner === "alice" && device === "model" && source === "codex" && sid === SID,
    toolStatus: vi.fn(async () => ({ ticket: ticket.id, turn: active.turn })),
  } as unknown as DevPipeline;
  const compositionOptions: DashboardCompositionOptions = { port: 9820, publicUrl: "https://head.example",
    devPipeline: pipe, workspaceFiles, executionWorkspace,
    ...(options.shared ? { runnerTickets: SHARED_RUNNER_TICKETS } : {}),
    developmentWorkspaces: { stateDir: "/unused", repositoryId: "test-repository", publicUrl: "https://head.example",
      bundles: new BundleHandoff(), available, call: async () => { throw new Error("unexpected development mutation"); } },
    installSessionRecoveryIssuer: (issuer) => {
      recovery = issuer;
      if (options.failCompose) { credential = issue(binding()); throw new Error("fixture composition failure"); }
      return offRecovery;
    },
  };
  if (options.failCompose) {
    expect(() => composeDashboardServices(store, caps, compositionOptions)).toThrow("fixture composition failure");
    expect(store.listMcpTokens("alice").every((row) => row.revoked_at !== null)).toBe(true);
    caps.service.close(); store.close();
    return null;
  }
  const composition = composeDashboardServices(store, caps, compositionOptions);
  const grant = caps.open({ username: "alice", purpose: "trusted-ticket", kind: "job", rights: RIGHTS, autoAllow: RIGHTS })!;
  const call = (operation: string, args: Record<string, unknown>) => grant.call(operation, { ...args, device: "model" });
  const principal = (token: unknown): McpPrincipal => {
    const hash = hashRunnerToken(String(token));
    const row = store.getActiveMcpTokenByHash(hash, new Date().toISOString())!;
    return { owner: "alice", credential: mcpCredentialOf(hash), policy: decodeMcpTokenPolicy(row.policy_json) };
  };
  cleanups.push(async () => { grant.close(); await composition.close(); caps.service.close(); store.close(); });
  return { store, ticket, frames, principal, call, composition, available, offRecovery, pipe,
    get runnerAccess() { return runnerAccess!; },
    setOnline(value: boolean) { online = value; },
    get developmentToken() { return credential!.token; },
    dropDevelopment() { credential?.release(); credential = undefined; },
    recovery: (sid = SID) => recovery.issue({ owner: "alice", runtimeDevice: "model", source: "codex", sessionId: sid }),
    async launch() {
      if (development) credential = issue(binding());
      receipts.set(start.id, { protocol: SESSION_OPERATION_PROTOCOL, operation_id: start.id, state: "running" });
      await call("start_session", { ...start.args, operation_id: start.id });
      receipts.set(start.id, { protocol: SESSION_OPERATION_PROTOCOL, operation_id: start.id, state: "succeeded",
        session_id: SID, result: { ok: true } });
      await call("get_session_operation", { operation_id: start.id });
      store.devTickets.updateDevTicket(ticket.id, { session_id: SID });
      store.devTickets.runner.save({ ...start, state: "finished" });
    },
    async append() {
      const previous = credential;
      active = { id: "append-two", ticketId: ticket.id, turn: 2, method: "append_session", state: "dispatched",
        args: { source: "codex", id: SID, prompt: "continue once", permission_profile: "full_access" } };
      store.devTickets.runner.save(active);
      credential = issue(binding()); previous?.release();
      receipts.set(active.id, { protocol: SESSION_OPERATION_PROTOCOL, operation_id: active.id, state: "succeeded",
        session_id: SID, result: { ok: true } });
      await call("append_session", { ...active.args, operation_id: active.id });
    },
  };
}

it.each([false, true])("wires exact development authority, late receipts and child RPC roots (same device: %s)", async (sameDevice) => {
  const h = harness({ sameDevice })!;
  await h.launch();
  const start = h.frames.find((frame) => frame.operation === "start_session")!.args;
  const executionDevice = sameDevice ? "model" : "execution";
  expect(start).toMatchObject({ execution_device: executionDevice, workspace_id: CHILD,
    _octopus_development_id: "development-one", _octopus_development_mcp_token: h.developmentToken });
  expect(h.store.getSessionPlusSplitSession("alice", "model", "codex", SID)).toMatchObject({
    execution_device: executionDevice, workspace_id: CHILD });
  const executionPrincipal = h.principal(start._octopus_execution_mcp_token);
  const roots = await h.composition.services.mcp.callTool(executionPrincipal, "list_session_workspaces", {});
  expect(roots).toMatchObject({ ok: true });
  expect(JSON.stringify(roots)).toContain("ticket child from scoped RPC");
  expect(JSON.stringify(roots)).not.toContain("registered parent");
  expect(h.frames.some((frame) => frame.operation === "list_session_workspaces" && frame.args.device === executionDevice)).toBe(true);
  const developmentPrincipal = h.principal(h.developmentToken);
  expect(await h.composition.services.mcp.callTool(developmentPrincipal, "devpipe_status", {}))
    .toMatchObject({ ok: true, result: { ticket: h.ticket.id, turn: 1 } });
  h.setOnline(false);
  expect(h.available()).toBe(false);
  expect(h.composition.services.mcp.listTools(developmentPrincipal).some((tool) => tool.name === "devpipe_status")).toBe(true);
  h.setOnline(true);
  expect(await h.composition.services.mcp.callTool(developmentPrincipal, "devpipe_status", {})).toMatchObject({ ok: true });
  expect(h.recovery()).toMatchObject({ executionDevice, workspaceId: CHILD,
    development: { developmentId: "development-one", token: h.developmentToken } });
  expect(h.recovery("another-session")).toBeNull();
  await h.append();
  expect(h.frames.find((frame) => frame.operation === "append_session")!.args).toMatchObject({
    id: SID, execution_device: executionDevice, workspace_id: CHILD, _octopus_development_mcp_token: h.developmentToken });
  expect(h.composition.services.mcp.listTools(developmentPrincipal)).toEqual([]);
  expect(h.recovery()).toMatchObject({ development: { token: h.developmentToken } });
  const nextPrincipal = h.principal(h.developmentToken);
  h.composition.services.endOwner("alice");
  expect(h.composition.services.mcp.listTools(nextPrincipal)).toEqual([]);
  await h.composition.close();
  expect(h.offRecovery).toHaveBeenCalledOnce();
});

it("keeps ordinary same-device launches free of execution and development credentials", async () => {
  const h = harness({ sameDevice: true, development: false })!;
  await h.launch();
  const start = h.frames.find((frame) => frame.operation === "start_session")!.args;
  expect(Object.keys(start).filter((key) => key.startsWith("_octopus_"))).toEqual([]);
  expect(h.store.getSessionPlusSplitSession("alice", "model", "codex", SID)).toBeUndefined();
  expect(h.recovery()).toBeNull();
});

it("waits for current development credentials instead of downgrading a known development session on recovery", async () => {
  const h = harness({ sameDevice: true })!;
  await h.launch();
  h.dropDevelopment();
  expect(h.recovery()).toBeNull();
});

it("releases issued development authority when composition rolls back", () => {
  harness({ failCompose: true });
});


it("ends development authority when the owner loses development permission", async () => {
  const h = harness()!;
  await h.launch();
  const principal = h.principal(h.developmentToken);
  h.store.revokeCapability("alice", "dev");
  expect(h.composition.services.mcp.listTools(principal)).toEqual([]);
  expect(await h.composition.services.mcp.callTool(principal, "devpipe_status", {}))
    .toMatchObject({ ok: false, code: "no_authority" });
});


it("shares development resources with newly granted contributors and revokes them immediately", () => {
  const h = harness({ shared: true })!;
  const at = new Date().toISOString();
  h.store.saveUser({ username: "wfn", uid: 2, home_dir: "/unused", created_at: at });
  expect(h.runnerAccess.resourceOwner("wfn")).toBe("wfn");
  for (const capability of ["contribute", "dev", "deploy"] as const) {
    h.store.grantCapability("wfn", capability, "lht", at);
    expect(h.runnerAccess.resourceOwner("wfn")).toBe("lht");
    h.store.revokeCapability("wfn", capability);
    expect(h.runnerAccess.resourceOwner("wfn")).toBe("wfn");
  }
  expect(h.runnerAccess.resourceOwner("missing-user")).toBe("missing-user");
});
