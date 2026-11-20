import { afterEach, expect, it, vi } from "vitest";
import { SESSION_OPERATION_PROTOCOL } from "@claude-bot/runner/gateway-protocol";
import { composeDashboardServices } from "./bootstrap-v3.js";
import { SessionExecutionRegistry } from "./mcp/session-execution.js";
import { RunnerCapabilities } from "./runner/capability.js";
import { hashRunnerToken, type RunnerTransport } from "./runner/gateway.js";
import { Store } from "./store/store.js";
import type { WorkspaceFilesCapabilities } from "./workspace-files/capability.js";
import type { ExecutionWorkspaceCapabilities } from "./execution-workspace/capability.js";

const WS = "ws_0123456789abcdef01234567";
const SESSION = "sessions-plus-split-thread";
const RIGHTS = ["start_session", "append_session"];
afterEach(() => vi.restoreAllMocks());

function harness() {
  const store = new Store(":memory:");
  const now = new Date().toISOString();
  store.saveUser({ username: "alice", uid: 1, home_dir: "/unused", created_at: now });
  for (const device of ["runtime", "worker"]) store.saveRunnerToken(hashRunnerToken(`alice${device}`), "alice", device, now);
  const frames: Array<{ operation: string; args: Record<string, unknown> }> = [];
  const caps = new RunnerCapabilities(store, {
    dispatch: async (_owner: string, operation: string, args: Record<string, unknown>) => {
      frames.push({ operation, args });
      if (operation === "start_session") return { ok: true, session_id: SESSION };
      return { protocol: SESSION_OPERATION_PROTOCOL, operation_id: args.operation_id, state: "succeeded",
        session_id: args.id, result: { ok: true } };
    },
    listDevices: () => [{ device: "runtime", online: true }, { device: "worker", online: true }],
    isOnline: () => true,
  } as unknown as RunnerTransport, { extraRootAutoAllow: () => RIGHTS });
  caps.ensureAccount("alice");
  const workspaceFiles = { service: caps.service, attachToRunnerLifecycle: () => () => {},
    open: vi.fn(() => ({ contextId: "workspace", destroy: vi.fn() })), accountOperations: () => [] } as unknown as WorkspaceFilesCapabilities;
  const executionWorkspace = { open: () => ({ destroy() {} }) } as unknown as ExecutionWorkspaceCapabilities;
  const issue = vi.spyOn(SessionExecutionRegistry.prototype, "issue");
  const composition = composeDashboardServices(store, caps, { port: 0, workspaceFiles, executionWorkspace });
  const grant = caps.open({ username: "alice", purpose: "sessions-plus-test", kind: "job", rights: RIGHTS, autoAllow: RIGHTS })!;
  const call = (operation: string, args: Record<string, unknown>) => grant.call(operation, { ...args, device: "runtime" });
  return {
    store, frames, issue, call,
    async launch() {
      await call("start_session", { source: "codex", workspace_id: WS, execution_device: "worker",
        client_request_id: "op_sessions_plus_split", permission_profile: "full_access", prompt: "first task" });
      expect(store.getSessionPlusSplitSession("alice", "runtime", "codex", SESSION))
        .toMatchObject({ runtime_owner: "alice", runtime_resource_id: null, execution_device: "worker", workspace_id: WS });
      return issue.mock.results[0]!.value as { token: string; release(): void };
    },
    appends: () => frames.filter((frame) => frame.operation === "append_session").map((frame) => frame.args),
    async close() { grant.destroy(); await composition.close(); caps.service.close(); store.close(); },
  };
}

it("renews an ordinary Sessions+ split session from its launch placement after the credential ends", async () => {
  const h = harness();
  try {
    const original = await h.launch();
    // The 24 h scope has ended (expiry and release leave the same state): no live scope, token revoked.
    original.release();
    await h.call("append_session", { source: "codex", id: SESSION, prompt: "continue", operation_id: "op_after_expiry" });
    const [append] = h.appends();
    expect(append).toMatchObject({ id: SESSION, execution_device: "worker", workspace_id: WS,
      _octopus_execution_operation_id: "op_after_expiry" });
    expect(append!._octopus_execution_mcp_token).toMatch(/^mcp_/);
    expect(append!._octopus_execution_mcp_token).not.toBe(original.token);
    expect(Number(append!._octopus_execution_expires_at)).toBeGreaterThan(Date.now() + 23 * 60 * 60_000);
    expect(h.store.getSessionExecutionBinding("alice", "runtime", "codex", SESSION, "0000-01-01T00:00:00.000Z"))
      .toMatchObject({ operation_id: "op_after_expiry", execution_device: "worker", workspace_id: WS });
    // A live scope is reused, not re-issued, for the next message.
    const issued = h.issue.mock.calls.length;
    await h.call("append_session", { source: "codex", id: SESSION, prompt: "again", operation_id: "op_next" });
    expect(h.issue.mock.calls.length).toBe(issued);
    expect(h.appends()[1]).toMatchObject({ _octopus_execution_mcp_token: append!._octopus_execution_mcp_token });
  } finally { await h.close(); }
});

it("renews neither a shared runtime placement nor a prompt-free control", async () => {
  const h = harness();
  try {
    const original = await h.launch();
    original.release();
    const issued = h.issue.mock.calls.length;
    await h.call("append_session", { source: "codex", id: SESSION, interrupt: true });
    expect(h.issue.mock.calls.length).toBe(issued);
    const at = new Date().toISOString();
    h.store.saveSessionPlusSplitSession({ owner: "alice", runtime_owner: "lht", runtime_device: "runtime",
      runtime_resource_id: "agent-runtime:0123456789abcdef0123456789abcdef", source: "codex", session_id: "shared-thread",
      catalog_id: `spc_${"c".repeat(64)}`, execution_device: "worker", workspace_id: WS, workspace_label: "",
      workspace_display: "", created_at: at, updated_at: at });
    await h.call("append_session", { source: "codex", id: "shared-thread", prompt: "continue", operation_id: "op_shared" });
    expect(h.issue.mock.calls.length).toBe(issued);
    expect(h.appends().every((args) => args._octopus_execution_mcp_token === undefined)).toBe(true);
  } finally { await h.close(); }
});
