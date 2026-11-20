import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SESSION_OPERATION_PROTOCOL, type SessionOperationReceipt } from "@claude-bot/runner/gateway-protocol";
import { Store } from "../store/store.js";
import { RunnerCapabilities, SessionReceiptQueryError } from "../runner/capability.js";
import { hashRunnerToken, type RunnerTransport } from "../runner/gateway.js";
import { messageFor, SessionOperationCoordinator, UNKNOWN_RECEIPT_OBSERVATION_MS, type OperationExecutor, type OperationIntent } from "./operations.js";

let dir: string;
let store: Store;
let caps: RunnerCapabilities;
let coordinator: SessionOperationCoordinator;
let current: SessionOperationReceipt;
const frames: Array<{ owner: string; operation: string; args: Record<string, unknown> }> = [];
let runs = 0;
const owner = { username: "alice", admin: false, session: true, credential: "browser" };
const intent: OperationIntent = { owner: "alice", resourceId: "resource-original", device: "laptop",
  cliKind: "codex", sessionId: "original-session", operation: "append_session", fingerprint: "prompt-one" };
const executor: OperationExecutor = {
  describe: () => ({ ok: true, intent }),
  prepare: (_principal, _input, id) => ({ ok: true, ticket: { ...intent, runnerOperationId: id, contextId: "context" } }),
  run: async (ticket, hooks) => { runs++; hooks?.onDispatched?.(ticket.contextId); return { ok: true, result: current, receipt: current }; },
  interpret: (result) => ({ ok: true, result }), discard: () => {}, releasePending: () => {},
};
function compose() {
  coordinator = new SessionOperationCoordinator({ store, caps, executors: { "app:session-plus": executor }, newId: () => "op_original" });
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "input-receipts-"));
  store = new Store(join(dir, "store.db"));
  store.saveUser({ username: "alice", uid: 1, home_dir: dir, created_at: new Date().toISOString() });
  store.saveUser({ username: "bob", uid: 2, home_dir: dir, created_at: new Date().toISOString() });
  store.saveRunnerToken(hashRunnerToken("rt_alice"), "alice", "laptop", new Date().toISOString());
  frames.length = 0; runs = 0;
  current = { protocol: SESSION_OPERATION_PROTOCOL, operation_id: "op_original", state: "running", session_id: "original-session" };
  caps = new RunnerCapabilities(store, { dispatch: async (owner: string, operation: string, args: Record<string, unknown>) => {
    frames.push({ owner, operation, args }); return current;
  }, listDevices: () => [{ device: "laptop", online: true }], isOnline: () => true } as unknown as RunnerTransport);
  caps.ensureAccount("alice");
  compose();
});
afterEach(() => { coordinator.close(); caps.service.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });

it("confirms provider input before turn completion and persists only display evidence", async () => {
  const accepted = await coordinator.submit("app:session-plus", owner, {});
  expect(accepted.ok).toBe(true);
  await vi.waitFor(() => expect(coordinator.get("alice", "op_original")?.status).toBe("running"));
  current = { ...current, input: { phase: "provider_accepted", evidence: "provider_ack", at: new Date().toISOString(),
    session_id: "original-session", turn_id: "original-turn", transport: "app-server" } };
  await vi.waitFor(() => expect(coordinator.get("alice", "op_original")?.status).toBe("succeeded"));
  expect(current.state).toBe("running");
  expect(coordinator.get("alice", "op_original")?.input).toMatchObject({ phase: "provider_accepted", sessionId: "original-session", turnId: "original-turn" });
  expect(store.getSessionOperation("op_original", "alice")?.runner_operation_id).toBe("op_original");
  expect(JSON.parse(store.getSessionOperation("op_original", "alice")!.input_receipt!)).toMatchObject({ phase: "provider_accepted", session_id: "original-session" });
  expect(runs).toBe(1);
  expect(frames.every((frame) => frame.owner === "alice" && frame.operation === "get_session_operation"
    && frame.args.operation_id === "op_original" && frame.args.device === "laptop")).toBe(true);
});

it("recovers unknown after a Bot restart through the original receipt without another dispatch", async () => {
  await coordinator.submit("app:session-plus", owner, {});
  await vi.waitFor(() => expect(coordinator.get("alice", "op_original")?.status).toBe("running"));
  coordinator.close();
  current = { ...current, input: { phase: "input_observed", evidence: "native_hook", at: new Date().toISOString(), session_id: "original-session" } };
  compose();
  expect(coordinator.recover().unknown).toBe(1);
  await vi.waitFor(() => expect(coordinator.get("alice", "op_original")?.status).toBe("succeeded"));
  expect(runs).toBe(1);
  expect(coordinator.get("bob", "op_original")).toBeNull();
  const before = frames.length;
  await expect(caps.querySessionOperation("bob", "op_original")).rejects.toThrow(/owned durable intent/);
  expect(frames).toHaveLength(before);
});

it("observes every recoverable receipt after a restart, not only the newest 500", () => {
  coordinator.close();
  const at = new Date().toISOString();
  for (let i = 0; i < 1_201; i += 1) {
    store.createSessionOperation({ id: `op_r${i}`, owner: "alice", surface: "app:session-plus", credential: "browser",
      resource_id: "resource-original", device: "laptop", cli_kind: "codex", session_id: "original-session",
      operation: "append_session", args_hash: `fp-${i}`, pending_call_id: null, context_id: "context", status: "unknown",
      detail: null, new_session_id: null, submitted_at: at, started_at: at, finished_at: at, updated_at: at,
      runner_operation_id: `op_r${i}` });
  }
  compose();
  coordinator.recover();
  // The oldest row sits two windows below the newest; it is observed too.
  for (const id of ["op_r1200", "op_r700", "op_r0"]) {
    expect(store.managedExecutions.get("alice", `receipt:${id}`)?.reference).toBe(id);
  }
  expect(runs).toBe(0);
});

it("keeps raw terminal writes unknown and rejects receipt grant target or id rebinding", async () => {
  current = { ...current, state: "unknown", input: { phase: "dispatched", evidence: "terminal_write", at: new Date().toISOString(), session_id: "original-session" } };
  await coordinator.submit("app:session-plus", owner, {});
  await vi.waitFor(() => expect(coordinator.get("alice", "op_original")?.status).toBe("unknown"));
  expect(coordinator.get("alice", "op_original")?.input?.phase).toBe("dispatched");
  const grant = caps.open({ username: "alice", purpose: "test-exact-receipt", kind: "job", rights: ["get_session_operation"],
    metadata: { session_receipt_operation: "op_original", session_receipt_device: "laptop" } })!;
  const before = frames.length;
  await expect(grant.call("get_session_operation", { operation_id: "op_other", device: "laptop" })).rejects.toThrow(/bound/);
  await expect(grant.call("get_session_operation", { operation_id: "op_original", device: "other" })).rejects.toThrow(/bound/);
  expect(frames).toHaveLength(before);
  expect(runs).toBe(1);
  grant.destroy();
});

it("keeps unknown evidence quiet between bounded reads and accepts late confirmation without replay", async () => {
  coordinator.close();
  vi.useFakeTimers();
  compose();
  try {
    current = { ...current, state: "unknown", result: { ok: false, code: "unknown", error: "原生回执丢失，未重发" } };
    const changed = vi.fn();
    coordinator.subscribe("alice", changed);
    await coordinator.submit("app:session-plus", owner, {});
    await vi.advanceTimersByTimeAsync(10);
    expect(coordinator.get("alice", "op_original")).toMatchObject({ status: "unknown", detail: "原生回执丢失，未重发" });
    expect(frames).toHaveLength(1);
    const notifications = changed.mock.calls.length;
    await vi.advanceTimersByTimeAsync(12_000);
    expect(frames).toHaveLength(3);
    expect(changed).toHaveBeenCalledTimes(notifications);
    current = { ...current, state: "running", input: { phase: "provider_accepted", evidence: "provider_ack",
      at: new Date().toISOString(), session_id: "original-session", turn_id: "original-turn", transport: "app-server" } };
    await vi.advanceTimersByTimeAsync(5_000);
    expect(coordinator.get("alice", "op_original")).toMatchObject({ status: "succeeded", input: { phase: "provider_accepted" } });
    expect(changed).toHaveBeenCalledTimes(notifications + 1);
    expect(runs).toBe(1);
    expect(frames.every(frame => frame.operation === "get_session_operation" && frame.args.operation_id === "op_original")).toBe(true);
  } finally { coordinator.close(); vi.useRealTimers(); }
});

it("settles a definitive native input refusal as failed instead of querying an unknown forever", async () => {
  current = { ...current, state: "failed", result: { ok: false, code: "turn_not_active", error: "当前轮次已结束，尚未发送" } };
  await coordinator.submit("app:session-plus", owner, {});
  await vi.waitFor(() => expect(coordinator.get("alice", "op_original")).toMatchObject({ status: "failed", detail: "当前轮次已结束，尚未发送" }));
  expect(frames).toEqual([]);
  expect(runs).toBe(1);
});

it.each([false, true])("publishes connection-wait clearance even when the receipt stays unknown (restart=%s)", async restart => {
  coordinator.close();
  vi.useFakeTimers();
  compose();
  const query = vi.spyOn(caps, "querySessionOperation").mockRejectedValue(new SessionReceiptQueryError("transport_unavailable", "offline"));
  try {
    current = { ...current, state: "unknown" };
    const changed = vi.fn();
    coordinator.subscribe("alice", changed);
    await coordinator.submit("app:session-plus", owner, {});
    await vi.advanceTimersByTimeAsync(10);
    expect(changed.mock.lastCall?.[0]).toMatchObject({ status: "unknown", recovery: { state: "reconnecting" } });
    if (restart) {
      coordinator.close(); compose();
      coordinator.subscribe("alice", changed);
      coordinator.recover();
    }
    query.mockResolvedValue(current);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(coordinator.get("alice", "op_original")?.status).toBe("unknown");
    expect(changed.mock.lastCall?.[0]).not.toHaveProperty("recovery");
    expect(runs).toBe(1);
  } finally { query.mockRestore(); coordinator.close(); vi.useRealTimers(); }
});

it("ends an unknown receipt's observation after the bounded window and says how to check", async () => {
  coordinator.close();
  vi.useFakeTimers();
  compose();
  try {
    current = { ...current, state: "unknown", result: { ok: false, code: "unknown", error: "原生回执丢失，未重发" } };
    await coordinator.submit("app:session-plus", owner, {});
    await vi.advanceTimersByTimeAsync(10);
    expect(coordinator.get("alice", "op_original")).toMatchObject({ status: "unknown", live: false });
    await vi.advanceTimersByTimeAsync(UNKNOWN_RECEIPT_OBSERVATION_MS + 120_000);
    const view = coordinator.get("alice", "op_original")!;
    expect(view).toMatchObject({ status: "unknown", live: false });
    expect(view.detail).toContain("原生回执丢失");
    expect(view.detail).toContain("已停止查询原回执");
    expect(view.message).toContain("请查看会话记录");
    expect(view.message).not.toContain("接管");
    // Backoff from 5 s to one query a minute, instead of every 5 s forever.
    const polled = frames.length;
    expect(polled).toBeGreaterThan(10);
    expect(polled).toBeLessThan(80);
    await vi.advanceTimersByTimeAsync(2 * UNKNOWN_RECEIPT_OBSERVATION_MS);
    expect(frames).toHaveLength(polled);
    // A restart re-attaches the same durable observation, which stays settled.
    coordinator.close(); compose();
    coordinator.recover();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(frames).toHaveLength(polled);
    expect(runs).toBe(1);
  } finally { coordinator.close(); vi.useRealTimers(); }
});

it("words failed and unknown records by what the person can actually do", () => {
  const append = { operation: "append_session", cli_kind: "codex" };
  expect(messageFor("failed", { ...append, detail: "这个会话已有一轮 Octopus 托管轮次在执行；请先停止它，或等它结束" }))
    .toBe("续跑失败：这个会话已有一轮 Octopus 托管轮次在执行；请先停止它，或等它结束");
  expect(messageFor("failed", append)).toBe("续跑失败");
  const managed = messageFor("unknown", { ...append, input_receipt: null });
  expect(managed).toContain("请查看会话记录");
  expect(managed).not.toContain("接管");
  expect(messageFor("unknown", { operation: "start_session", cli_kind: "claude" })).toContain("可重新发起");
  const terminal = messageFor("unknown", { ...append, input_receipt: JSON.stringify({ phase: "dispatched",
    evidence: "terminal_write", at: "2026-10-15T00:00:00.000Z", transport: "tmux" }) });
  expect(terminal).toContain("本机 CLI");
  expect(terminal).toContain("交给 Octopus 托管");
});
