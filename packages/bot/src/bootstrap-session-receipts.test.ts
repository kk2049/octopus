import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SESSION_OPERATION_PROTOCOL, type SessionOperationReceipt } from "@claude-bot/runner/gateway-protocol";
import { composeDashboardServices } from "./bootstrap-v3.js";
import { SessionExecutionRegistry } from "./mcp/session-execution.js";
import { RunnerCapabilities } from "./runner/capability.js";
import { hashRunnerToken, type RunnerTransport } from "./runner/gateway.js";
import { Store } from "./store/store.js";
import type { WorkspaceFilesCapabilities } from "./workspace-files/capability.js";
import type { ExecutionWorkspaceCapabilities } from "./execution-workspace/capability.js";

afterEach(() => vi.restoreAllMocks());

it.each([false, true])("retains and binds the original split credential after late identity (lost response=%s)", async (lostResponse) => {
  const dir = mkdtempSync(join(tmpdir(), "split-input-binding-"));
  const store = new Store(join(dir, "store.db"));
  const now = new Date().toISOString();
  store.saveUser({ username: "alice", uid: 1, home_dir: dir, created_at: now });
  store.saveRunnerToken(hashRunnerToken("rt_runtime"), "alice", "runtime", now);
  store.saveRunnerToken(hashRunnerToken("rt_worker"), "alice", "worker", now);
  let startFrames = 0;
  let receipt: SessionOperationReceipt = { protocol: SESSION_OPERATION_PROTOCOL, operation_id: "op_split_receipt", state: "running" };
  const caps = new RunnerCapabilities(store, {
    dispatch: async (_owner: string, operation: string) => {
      if (operation === "start_session") { startFrames++; if (lostResponse) throw new Error("response link lost"); }
      return receipt;
    }, listDevices: () => [{ device: "runtime", online: true }, { device: "worker", online: true }], isOnline: () => true,
  } as unknown as RunnerTransport, { extraRootAutoAllow: () => ["start_session"] });
  caps.ensureAccount("alice");
  const release = vi.fn();
  const bindSession = vi.fn();
  vi.spyOn(SessionExecutionRegistry.prototype, "issue").mockReturnValue({ credential: "credential-original", token: "mcp_original",
    endpoint: "http://127.0.0.1:9999/api/mcp", expiresAt: Date.now() + 60_000, release, bindSession });
  const workspaceFiles = { service: caps.service, attachToRunnerLifecycle: () => () => {}, open: () => null, accountOperations: () => [] } as unknown as WorkspaceFilesCapabilities;
  const composition = composeDashboardServices(store, caps, { port: 0, workspaceFiles,
    executionWorkspace: {} as ExecutionWorkspaceCapabilities });
  const grant = caps.open({ username: "alice", purpose: "test-start", kind: "job", rights: ["start_session"], autoAllow: ["start_session"] })!;
  try {
    store.createSessionOperation({ id: "op_split_receipt", owner: "alice", surface: "app:session-plus", credential: "browser",
      resource_id: "launch-resource", device: "runtime", cli_kind: "codex", session_id: "", operation: "start_session",
      args_hash: "prompt", pending_call_id: null, context_id: String(grant.contextId), status: "running", detail: null,
      new_session_id: null, submitted_at: now, started_at: now, finished_at: null, updated_at: now,
      runner_operation_id: "op_split_receipt", runner_receipt_target: JSON.stringify({ owner: "alice" }) });
    const result = grant.call("start_session", { device: "runtime", execution_device: "worker",
      workspace_id: "ws_0123456789abcdef01234567", source: "codex", prompt: "one prompt", client_request_id: "op_split_receipt",
      operation_id: "op_split_receipt", input_receipt: true });
    if (lostResponse) await expect(result).rejects.toThrow();
    else await expect(result).resolves.toMatchObject({ state: "running" });
    expect(release).not.toHaveBeenCalled();
    expect(bindSession).not.toHaveBeenCalled();
    receipt = { ...receipt, session_id: "original-provider-session", input: { phase: "provider_accepted", evidence: "provider_ack",
      at: new Date().toISOString(), session_id: "original-provider-session", transport: "app-server" } };
    composition.services.operations.list("alice");
    await vi.waitFor(() => expect(bindSession).toHaveBeenCalledWith("codex", "original-provider-session"));
    expect(bindSession).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
    expect(startFrames).toBe(1);
    expect(store.getSessionPlusSplitSession("alice", "runtime", "codex", "original-provider-session"))
      .toMatchObject({ execution_device: "worker", workspace_id: "ws_0123456789abcdef01234567" });
  } finally {
    grant.destroy(); await composition.close(); caps.service.close(); store.close(); rmSync(dir, { recursive: true, force: true });
  }
});
