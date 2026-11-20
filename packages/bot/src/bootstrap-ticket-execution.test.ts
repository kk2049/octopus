import { afterEach, expect, it, vi } from "vitest";
import { SESSION_OPERATION_PROTOCOL, type SessionOperationReceipt } from "@claude-bot/runner/gateway-protocol";
import { composeDashboardServices } from "./bootstrap-v3.js";
import { SessionExecutionRegistry } from "./mcp/session-execution.js";
import { decodeMcpTokenPolicy } from "./mcp/tokens.js";
import { RunnerCapabilities } from "./runner/capability.js";
import { hashRunnerToken, type RunnerTransport } from "./runner/gateway.js";
import { Store } from "./store/store.js";
import type { TicketRunnerTurn } from "./store/repositories/ticket-runner.js";
import type { WorkspaceFilesCapabilities } from "./workspace-files/capability.js";
import type { ExecutionWorkspaceCapabilities } from "./execution-workspace/capability.js";

const WS = "ws_0123456789abcdef01234567";
const SESSION = "original-provider-session";
const RIGHTS = ["start_session", "append_session", "get_session_operation"];
afterEach(() => vi.restoreAllMocks());

function harness(requester = "alice", bindingRequester = requester) {
  const store = new Store(":memory:");
  const now = new Date().toISOString();
  for (const owner of ["alice", "bob"]) {
    store.saveUser({ username: owner, uid: owner === "alice" ? 1 : 2, home_dir: "/unused", created_at: now });
    for (const device of ["runtime", "worker"]) store.saveRunnerToken(hashRunnerToken(owner + device), owner, device, now);
  }
  const frames: Array<{ operation: string; args: Record<string, unknown> }> = [];
  const receipts = new Map<string, SessionOperationReceipt>();
  const caps = new RunnerCapabilities(store, {
    dispatch: async (_owner: string, operation: string, args: Record<string, unknown>) => {
      frames.push({ operation, args });
      if (operation === "append_session") {
        if (!args._octopus_execution_mcp_token) throw new Error("split session missing execution credentials");
        return { protocol: SESSION_OPERATION_PROTOCOL, operation_id: args.operation_id, state: "succeeded",
          session_id: args.id, result: { ok: true } };
      }
      return receipts.get(String(args.operation_id));
    },
    listDevices: () => [{ device: "runtime", online: true }, { device: "worker", online: true }],
    isOnline: () => true,
  } as unknown as RunnerTransport, { extraRootAutoAllow: () => RIGHTS });
  for (const owner of ["alice", "bob"]) caps.ensureAccount(owner);
  const workspaceOpen = vi.fn(() => ({ contextId: "workspace", destroy: vi.fn() }));
  const workspaceFiles = { service: caps.service, attachToRunnerLifecycle: () => () => {},
    open: workspaceOpen, accountOperations: () => [] } as unknown as WorkspaceFilesCapabilities;
  const executionWorkspace = { open: () => ({ destroy() {} }) } as unknown as ExecutionWorkspaceCapabilities;
  const issue = vi.spyOn(SessionExecutionRegistry.prototype, "issue");
  const compose = () => composeDashboardServices(store, caps, { port: 0, workspaceFiles, executionWorkspace });
  let composition = compose();
  const grants = ["alice", "bob"].map((username) => caps.open({ username, purpose: "ticket-test", kind: "job",
    rights: RIGHTS, autoAllow: RIGHTS })!);
  const call = (operation: string, args: Record<string, unknown>, owner = "alice") =>
    grants[owner === "alice" ? 0 : 1]!.call(operation, { ...args, device: "runtime" });
  const ticket = store.devTickets.createDevTicket({ title: "split ticket", body: "one prompt", requester,
    model: "codex-gpt-6-astra", effort: "xhigh", kind: "simple", app_id: null });
  store.devTickets.runner.bind(ticket.id, { owner: "alice", device: "runtime", executionDevice: "worker",
    workspaceId: WS, source: "codex", codexAccount: "@default",
    ...(requester !== "alice" ? { requester: bindingRequester, parentWorkspaceId: WS } : {}) });
  const start: TicketRunnerTurn = { id: "ticket-start", ticketId: ticket.id, turn: 1, method: "start_session", state: "dispatched",
    args: { source: "codex", workspace_id: WS, execution_device: "worker", client_request_id: "op_ticket_original",
      permission_profile: "full_access", prompt: "one prompt" } };
  store.devTickets.runner.save(start);
  receipts.set(start.id, { protocol: SESSION_OPERATION_PROTOCOL, operation_id: start.id, state: "running" });
  return {
    store, call, start, ticket, issue, receipts, frames, workspaceOpen,
    async launch(observe = true) {
      await expect(call("start_session", { ...start.args, operation_id: start.id })).resolves.toMatchObject({ state: "running" });
      expect(store.getSessionExecutionBinding("alice", "runtime", "codex", SESSION, "0000-01-01T00:00:00.000Z")).toBeUndefined();
      receipts.set(start.id, { protocol: SESSION_OPERATION_PROTOCOL, operation_id: start.id, state: "succeeded",
        session_id: SESSION, input: { phase: "provider_accepted", evidence: "launch_identity", at: now, session_id: SESSION } });
      if (observe) await call("get_session_operation", { operation_id: start.id });
      store.devTickets.updateDevTicket(ticket.id, { session_id: SESSION });
      store.devTickets.runner.save({ ...start, state: "finished" });
    },
    appendTurn() {
      const turn: TicketRunnerTurn = { id: "ticket-next", ticketId: ticket.id, turn: 2, method: "append_session",
        state: "dispatched", args: { source: "codex", id: SESSION, prompt: "continue once", permission_profile: "full_access" } };
      store.devTickets.runner.save(turn);
      return turn;
    },
    async restart() { await composition.close(); composition = compose(); },
    async close() {
      for (const grant of grants) grant.destroy();
      await composition.close(); caps.service.close(); store.close();
    },
  };
}

it.each(["released", "restart", "legacy-unbound"] as const)(
  "binds the late start receipt and continues with fresh exact-placement credentials after %s",
  async (mode) => {
    const h = harness();
    try {
      await h.launch(mode !== "legacy-unbound");
      if (mode !== "legacy-unbound") {
        expect(h.store.getSessionExecutionBinding("alice", "runtime", "codex", SESSION, "0000-01-01T00:00:00.000Z"))
          .toMatchObject({ execution_device: "worker", workspace_id: WS });
        expect(h.store.getSessionPlusSplitSession("alice", "runtime", "codex", SESSION)).toBeDefined();
      }
      const original = h.issue.mock.results[0]!.value;
      const policyOf = (token: string) => decodeMcpTokenPolicy(h.store.getActiveMcpTokenByHash(
        hashRunnerToken(token), new Date().toISOString(),
      )!.policy_json);
      expect(policyOf(original.token)?.groups).toEqual(expect.arrayContaining(["sessions", "feishu", "discussions"]));
      if (mode === "released") original.release();
      else await h.restart();
      const oldUnknown: SessionOperationReceipt = { protocol: SESSION_OPERATION_PROTOCOL, operation_id: "ticket-old-unknown",
        state: "unknown", session_id: SESSION, result: { code: "unknown", error: "old receipt is retained" } };
      h.receipts.set(oldUnknown.operation_id, oldUnknown);
      const turn = h.appendTurn();
      await expect(h.call("append_session", { ...turn.args, operation_id: turn.id })).resolves.toMatchObject({ state: "succeeded" });
      const append = h.frames.find((row) => row.operation === "append_session")!.args;
      expect(append).toMatchObject({ device: "runtime", execution_device: "worker", workspace_id: WS, id: SESSION,
        _octopus_execution_operation_id: turn.id });
      expect(append._octopus_execution_mcp_token).not.toBe(original.token);
      expect(policyOf(String(append._octopus_execution_mcp_token))?.groups)
        .toEqual(expect.arrayContaining(["sessions", "feishu", "discussions"]));
      expect(Number(append._octopus_execution_expires_at)).toBeGreaterThan(Date.now());
      expect(h.store.getSessionExecutionBinding("alice", "runtime", "codex", SESSION, "0000-01-01T00:00:00.000Z"))
        .toMatchObject({ operation_id: turn.id, execution_device: "worker", workspace_id: WS });
      expect(h.store.getSessionPlusSplitSession("alice", "runtime", "codex", SESSION)).toBeDefined();
      expect(h.frames.filter((row) => row.operation === "start_session")).toHaveLength(1);
      expect(h.frames.filter((row) => row.operation === "append_session")).toHaveLength(1);
      expect(h.receipts.get(oldUnknown.operation_id)).toBe(oldUnknown);
    } finally { await h.close(); }
  },
);

it("rejects a foreign owner and mismatched session before issuing or dispatching another scope", async () => {
  const h = harness();
  try {
    await h.launch();
    const issued = h.issue.mock.calls.length;
    await expect(h.call("get_session_operation", { operation_id: h.start.id }, "bob")).rejects.toThrow(/绑定/);
    const turn = h.appendTurn();
    await expect(h.call("append_session", { ...turn.args, operation_id: turn.id }, "bob")).rejects.toThrow(/绑定/);
    await expect(h.call("append_session", { ...turn.args, id: "another-session", operation_id: turn.id })).rejects.toThrow(/绑定/);
    expect(h.issue).toHaveBeenCalledTimes(issued);
    expect(h.frames.filter((row) => row.operation === "append_session")).toHaveLength(0);
  } finally { await h.close(); }
});

it("requires current workspace authority and refuses a changed durable placement", async () => {
  const h = harness();
  try {
    await h.launch();
    const turn = h.appendTurn();
    h.workspaceOpen.mockReturnValueOnce(null as never);
    await expect(h.call("append_session", { ...turn.args, operation_id: turn.id })).rejects.toThrow(/权限/);
    expect(h.frames.filter((row) => row.operation === "append_session")).toHaveLength(0);
    expect(() => h.store.devTickets.runner.bind(h.ticket.id, { owner: "alice", device: "runtime",
      executionDevice: "another-worker", workspaceId: WS, source: "codex" })).toThrow(/不可隐式更换/);
    const binding = h.store.getSessionExecutionBinding("alice", "runtime", "codex", SESSION, "0000-01-01T00:00:00.000Z")!;
    h.store.saveSessionExecutionBinding({ ...binding, execution_device: "another-worker" });
    await expect(h.call("append_session", { ...turn.args, operation_id: turn.id })).rejects.toThrow(/执行放置/);
    expect(h.frames.filter((row) => row.operation === "append_session")).toHaveLength(0);
  } finally { await h.close(); }
});

it("continues a delegated ticket as its subscription owner while retaining the original requester", async () => {
  const h = harness("bob");
  try {
    await h.launch();
    await h.restart();
    const turn = h.appendTurn();
    await expect(h.call("append_session", { ...turn.args, operation_id: turn.id })).resolves.toMatchObject({ state: "succeeded" });
    expect(h.frames.filter(row => row.operation === "append_session")).toEqual([
      expect.objectContaining({ args: expect.objectContaining({ id: SESSION, device: "runtime", execution_device: "worker", workspace_id: WS }) }),
    ]);
    expect(h.store.devTickets.getDevTicket(h.ticket.id)?.requester).toBe("bob");
    expect(h.store.getSessionExecutionBinding("alice", "runtime", "codex", SESSION, "0000-01-01T00:00:00.000Z"))
      .toMatchObject({ owner: "alice", execution_device: "worker", workspace_id: WS });
    // The requester cannot substitute their own runtime authority for the bound owner.
    await expect(h.call("append_session", { ...turn.args, operation_id: turn.id }, "bob")).rejects.toThrow(/绑定/);
    expect(h.frames.filter(row => row.operation === "append_session")).toHaveLength(1);
  } finally { await h.close(); }
});

it("rejects a delegated binding whose recorded requester differs from the ticket", async () => {
  const h = harness("bob", "alice");
  try {
    await h.launch();
    const turn = h.appendTurn();
    await expect(h.call("append_session", { ...turn.args, operation_id: turn.id })).rejects.toThrow(/绑定/);
    expect(h.frames.filter(row => row.operation === "append_session")).toHaveLength(0);
  } finally { await h.close(); }
});
