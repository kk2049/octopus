import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { siteOperationId } from "./gateway-sites.js";
import { RunnerSessionOperations } from "./session-operations.js";

const servers: http.Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))); });

async function executionMcp(): Promise<{ url: string; methods: string[] }> {
  const methods: string[] = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      methods.push(request.method ?? "");
      if (request.method === "DELETE") {
        response.writeHead(204).end();
        return;
      }
      const parsed = body ? JSON.parse(body) as { id?: unknown; method?: unknown } : {};
      response.writeHead(200, { "content-type": "application/json" });
      response.end(parsed.method === "initialize"
        ? JSON.stringify({
            jsonrpc: "2.0",
            id: parsed.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: "octopus", version: "1.0.0" },
            },
          })
        : JSON.stringify({
            jsonrpc: "2.0",
            id: parsed.id,
            result: { tools: [{ name: "run_workspace_command" }] },
          }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no port");
  return { url: `http://127.0.0.1:${address.port}/api/mcp`, methods };
}

const homes: string[] = [];
async function fixture() {
  const home = await mkdtemp(path.join(tmpdir(), "session-operations-"));
  homes.push(home);
  return { home, journal: new RunnerSessionOperations(home) };
}
afterEach(async () => { await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))); });

describe("durable Runner session receipts", () => {
  it("observes the exact recovered capacity turn after restart without redispatching input", async () => {
    const { home, journal } = await fixture();
    const run = vi.fn(async (_complete, input) => {
      await input({ phase: "provider_accepted", evidence: "provider_ack", at: new Date().toISOString(),
        session_id: "capacity-thread", turn_id: "original-turn", transport: "app-server" });
      return { ok: true, session_id: "capacity-thread" };
    });
    await journal.submit("site-a", "capacity-op", "start_session", { source: "codex", prompt: "once" }, run);
    await vi.waitFor(async () => expect((await journal.status("site-a", "capacity-op")).input?.turn_id).toBe("original-turn"));
    let state: "running" | "failed" = "running";
    const resolve = vi.fn((sessionId: string, turnId: string) => {
      expect([sessionId, turnId]).toEqual(["capacity-thread", "original-turn"]);
      return { state, ...(state === "failed" ? { result: { ok: false, error: "capacity exhausted" } } : {}) };
    });
    const next = new RunnerSessionOperations(home, resolve);
    expect(await next.status("site-a", "capacity-op")).toMatchObject({ state: "running" });
    expect(await next.status("site-b", "capacity-op")).toMatchObject({ state: "missing" });
    state = "failed";
    expect(await next.status("site-a", "capacity-op")).toMatchObject({ state: "failed", result: { error: "capacity exhausted" } });
    expect(await new RunnerSessionOperations(home).status("site-a", "capacity-op")).toMatchObject({ state: "failed" });
    expect(run).toHaveBeenCalledOnce();
  });
  it.each(["succeeded", "unknown"])("retains queue %s after restart without another submission", async state => {
    const { home, journal } = await fixture();
    const args = { id: "queue-thread", source: "codex", prompt: "once" };
    const input = { phase: "local_queued", evidence: "local_queue", at: new Date().toISOString(),
      session_id: "queue-thread", transport: "codex-queue" };
    const run = vi.fn(async () => state === "succeeded"
      ? { ok: true, queued_submission_id: "queue-1", input }
      : { ok: false, code: "unknown" });
    await journal.submit("ali", "queue-op", "append_session", args, run);
    await vi.waitFor(async () => expect(await journal.status("ali", "queue-op")).toMatchObject({ state }));
    const restarted = new RunnerSessionOperations(home);
    await restarted.submit("ali", "queue-op", "append_session", args, run);
    expect(run).toHaveBeenCalledOnce();
    if (state === "succeeded") expect(await restarted.status("ali", "queue-op")).toMatchObject({ input,
      result: { queued_submission_id: "queue-1" } });
  });

  it("joins duplicate append submissions while running and after settlement", async () => {
    const { journal } = await fixture();
    let resolve!: (value: Record<string, unknown>) => void;
    const run = vi.fn(() => new Promise<Record<string, unknown>>((done) => { resolve = done; }));
    const args = { id: "session-1", source: "codex", prompt: "one effect" };
    await Promise.all(Array.from({ length: 8 }, () => journal.submit("ali", "op-1", "append_session", args, run)));
    expect(run).toHaveBeenCalledTimes(1);
    expect(await journal.status("ali", "op-1")).toMatchObject({ state: "running", session_id: "session-1" });
    resolve({ ok: true, result_text: "done" });
    await vi.waitFor(async () => expect(await journal.status("ali", "op-1")).toMatchObject({ state: "succeeded", result: { result_text: "done" } }));
    await journal.submit("ali", "op-1", "append_session", args, run);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("never restarts a claimed operation after a resident crash and retains results", async () => {
    const { home, journal } = await fixture();
    const run = vi.fn(async () => ({ ok: true, session_id: "original" }));
    await journal.submit("ali", "op-2", "start_session", { prompt: "task" }, run);
    await vi.waitFor(async () => expect(await journal.status("ali", "op-2")).toMatchObject({ session_id: "original" }));
    const restarted = new RunnerSessionOperations(home);
    expect(await restarted.status("ali", "op-2")).toMatchObject({ state: "unknown" });
    await restarted.submit("ali", "op-2", "start_session", { prompt: "task" }, run);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("separates sites and refuses rebinding a request id", async () => {
    const { journal } = await fixture();
    await journal.submit("old", "same", "append_session", { prompt: "old task" }, async () => ({ ok: true }));
    expect(await journal.status("ali", "same")).toMatchObject({ state: "missing" });
    await expect(journal.submit("old", "same", "append_session", { prompt: "different task" }, async () => ({ ok: true }))).rejects.toThrow("different request");
    await vi.waitFor(async () => expect(await journal.status("old", "same")).toMatchObject({ state: "succeeded" }));
  });
  it("keeps early completion when the launch acknowledgement arrives later", async () => {
    const { journal } = await fixture();
    await journal.submit("ali", "race", "start_session", {}, async (complete) => {
      await complete({ ok: true, session_id: "session-race", result_text: "finished" });
      return { ok: true, session_id: "session-race" };
    });
    await vi.waitFor(async () => expect(await journal.status("ali", "race")).toMatchObject({ state: "succeeded", result: { result_text: "finished" } }));
  });
});

it("ordinary RPC launch returns a durable receipt and old launch replies remain compatible", async () => {
  const { handleRpc } = await import("./core.js");
  const { addWorkspace } = await import("./workspaces.js");
  const { home, journal } = await fixture();
  const workspace = await addWorkspace(home, home, "test");
  let done!: (value: Record<string, unknown>) => void;
  const completion = new Promise<Record<string, unknown>>((resolve) => { done = resolve; });
  const startManaged = vi.fn(async () => ({ sessionId: "native-session", transport: "app-server", completion }));
  const options = { allowMachineOps: true, gatewaySite: "ali", sessionOperations: journal,
    agentControlPlane: { startManaged } as never };
  const args = { source: "codex", workspace_id: workspace.id, client_request_id: "ticket-launch-test", prompt: "one task", operation_id: "rpc-turn" };
  const first = await handleRpc(home, { id: "one", method: "start_session", args }, options);
  expect(first).toMatchObject({ ok: true, result: { protocol: "runner-session-operation/v1", state: "running" } });
  await vi.waitFor(() => expect(startManaged).toHaveBeenCalledTimes(1));
  await handleRpc(home, { id: "two", method: "start_session", args }, options);
  done({ ok: true, resultText: "native answer" });
  await vi.waitFor(async () => expect(await journal.status("ali", "rpc-turn")).toMatchObject({ state: "succeeded", session_id: "native-session", result: { result_text: "native answer" } }));
  expect(startManaged).toHaveBeenCalledTimes(1);
  const { operation_id: _operationId, ...legacyArgs } = args;
  const legacy = await handleRpc(home, { id: "old", method: "start_session", args: legacyArgs }, options);
  expect(legacy).toMatchObject({ ok: true, result: { ok: true, session_id: "native-session" } });
  expect(startManaged).toHaveBeenCalledTimes(1);
  expect(await handleRpc(home, { id: "other-site", method: "get_session_operation", args: { operation_id: "rpc-turn" } }, { ...options, gatewaySite: "old" })).toMatchObject({ ok: true, result: { state: "missing" } });
});

it("retains split tools while awaiting acceptance and recovers the saved answer after observer loss", async () => {
  const { handleRpc } = await import("./core.js");
  const { LaunchJournal } = await import("./launch-journal.js");
  const { home, journal } = await fixture();
  const mcp = await executionMcp();
  const closeEnvironment = vi.fn(async () => {});
  let accept!: () => void;
  const acceptance = new Promise<void>((resolve) => { accept = resolve; });
  let finish!: (result: { ok: boolean; resultText: string }) => void;
  const completion = new Promise<{ ok: boolean; resultText: string }>((resolve) => { finish = resolve; });
  const startManaged = vi.fn(async (input: { onPrepared: (id: string, transport: "app-server") => Promise<void> }) => {
    await input.onPrepared("late-native", "app-server");
    await acceptance;
    return { sessionId: "late-native", turnId: "late-turn", transport: "app-server", completion };
  });
  const options = { allowMachineOps: true, gatewaySite: "ali", sessionOperations: journal,
    sessionScanRoot: { home, codexHome: path.join(home, ".codex") },
    agentControlPlane: { startManaged } as never,
    codexExecRelay: { open: async () => ({ environmentId: "remote", endpoint: "ws://127.0.0.1:32123", close: closeEnvironment }) } as never };
  const args = { source: "codex", workspace_id: "ws_aaaaaaaaaaaaaaaaaaaaaaaa", client_request_id: "op_late_native",
    operation_id: "late-turn-op", prompt: "one input", execution_device: "4090",
    _octopus_execution_mcp_url: mcp.url, _octopus_execution_mcp_token: "mcp_private_test_only" };
  await handleRpc(home, { id: "first", method: "start_session", args }, options);
  await vi.waitFor(async () => {
    const receipt = await journal.status("ali", args.operation_id);
    expect(receipt, JSON.stringify(receipt)).toMatchObject({ state: "running", session_id: "late-native" });
  });
  expect((await journal.status("ali", args.operation_id)).input).toBeUndefined();
  expect(closeEnvironment).not.toHaveBeenCalled();
  expect(mcp.methods).not.toContain("DELETE");
  await handleRpc(home, { id: "duplicate", method: "start_session", args }, options);
  expect(startManaged).toHaveBeenCalledOnce();
  // A new resident may read identity, but cannot claim provider acceptance.
  const restarted = new RunnerSessionOperations(home);
  expect(await restarted.status("ali", args.operation_id)).toMatchObject({ state: "unknown", session_id: "late-native" });
  accept();
  const launchId = siteOperationId("ali", args.client_request_id);
  await vi.waitFor(async () => expect((await new LaunchJournal(home).read(launchId))?.started).toBeDefined());
  expect(closeEnvironment).not.toHaveBeenCalled();
  // Simulate loss of the operation observer after the atomic completion
  // journal write. Only the exact launch can recover the original answer.
  await new LaunchJournal(home).markManagedCompleted(launchId, { ok: true, resultText: "saved native answer", durationMs: 55_000 });
  expect(await restarted.status("ali", args.operation_id)).toMatchObject({ state: "succeeded", session_id: "late-native",
    result: { result_text: "saved native answer", duration_ms: 55_000 } });
  finish({ ok: true, resultText: "saved native answer" });
  await vi.waitFor(() => expect(closeEnvironment).toHaveBeenCalledOnce());
  expect(startManaged).toHaveBeenCalledOnce();
});


it("persists input before completion and does not downgrade it after a failed turn", async () => {
  const { home, journal } = await fixture();
  let complete!: (value: Record<string, unknown>) => void;
  const completion = new Promise<Record<string, unknown>>((resolve) => { complete = resolve; });
  const input = { phase: "provider_accepted", evidence: "provider_ack", at: "2026-09-14T12:00:00.000Z", session_id: "same-session", turn_id: "same-turn" } as const;
  await journal.submit("ali", "input-before-complete", "append_session", { id: "same-session" }, async (_done, admitted) => {
    await admitted(input);
    return await completion;
  });
  await vi.waitFor(async () => expect(await journal.status("ali", "input-before-complete")).toMatchObject({ state: "running", input }));
  expect(await new RunnerSessionOperations(home).status("ali", "input-before-complete")).toMatchObject({ state: "unknown", input });
  complete({ ok: false, error: "provider turn failed later" });
  await vi.waitFor(async () => expect(await journal.status("ali", "input-before-complete")).toMatchObject({ state: "failed", input }));
});

it("keeps an unconfirmed terminal write unknown and never runs it twice", async () => {
  const { journal } = await fixture();
  const input = { phase: "dispatched", evidence: "terminal_write", at: "2026-09-14T12:00:00.000Z", session_id: "terminal-session" } as const;
  const run = vi.fn(async () => ({ ok: false, code: "unknown", control_action: "terminal_send", error: "no hook", input }));
  await journal.submit("ali", "terminal-unknown", "append_session", { id: "terminal-session" }, run);
  await vi.waitFor(async () => expect(await journal.status("ali", "terminal-unknown")).toMatchObject({ state: "unknown", input, result: { code: "unknown", control_action: "terminal_send" } }));
  await journal.submit("ali", "terminal-unknown", "append_session", { id: "terminal-session" }, run);
  expect(run).toHaveBeenCalledTimes(1);
});


it.each([undefined, "@default", "pool-b"])("passes split ticket account %s to the account-aware control plane exactly once", async (account) => {
  const { handleRpc } = await import("./core.js");
  const { LaunchJournal } = await import("./launch-journal.js");
  const { home, journal } = await fixture();
  const mcp = await executionMcp();
  const closeEnvironment = vi.fn(async () => {});
  let complete!: (result: { ok: boolean; resultText: string }) => void;
  const completion = new Promise<{ ok: boolean; resultText: string }>((resolve) => { complete = resolve; });
  const startManaged = vi.fn(async (input: { codexHome?: string; codexEnvironment?: unknown }) => {
    expect(input.codexEnvironment).toEqual({ environmentId: "remote-test", endpoint: "ws://127.0.0.1:32123" });
    return { sessionId: "split-ticket-native", transport: "app-server", completion };
  });
  const selectAccount = vi.fn(async () => ({ slot: "unused", label: "unused", codexHome: "/must-not-auto-select" }));
  const openEnvironment = vi.fn(async () => ({ environmentId: "remote-test", endpoint: "ws://127.0.0.1:32123", close: closeEnvironment }));
  const options = { allowMachineOps: true, gatewaySite: "ali", sessionOperations: journal,
    sessionScanRoot: { home, codexHome: path.join(home, ".codex") },
    agentControlPlane: { startManaged } as never,
    codexAccountRouter: { selectForNewSession: selectAccount, roots: () => [{ slot: "pool-b", label: "b", codexHome: "/private/account-b" }] } as never,
    codexExecRelay: { open: openEnvironment } as never };
  const args = { source: "codex", workspace_id: "ws_aaaaaaaaaaaaaaaaaaaaaaaa", client_request_id: "op_split_ticket_launch", operation_id: "split-ticket-turn",
    prompt: "one ticket", model: "gpt-6-astra", effort: "xhigh", permission_profile: "full_access",
    execution_device: "gpu-box", _octopus_execution_mcp_url: mcp.url, _octopus_execution_mcp_token: "mcp_split_test_secret",
    ...(account ? { codex_account: account } : {}) };
  await handleRpc(home, { id: "first", method: "start_session", args }, options);
  await vi.waitFor(async () => {
    const receipt = await journal.status("ali", args.operation_id);
    expect(startManaged, JSON.stringify(receipt)).toHaveBeenCalledOnce();
  });
  expect(selectAccount).not.toHaveBeenCalled();
  if (account === "pool-b") {
    expect(startManaged.mock.calls[0]![0].codexHome).toBe("/private/account-b");
  } else {
    expect(startManaged.mock.calls[0]![0]).not.toHaveProperty("codexHome");
  }
  complete({ ok: true, resultText: "ticket finished" });
  await vi.waitFor(async () => expect(await journal.status("ali", args.operation_id)).toMatchObject({ state: "succeeded", session_id: "split-ticket-native", result: { result_text: "ticket finished" } }));
  await vi.waitFor(() => expect(closeEnvironment).toHaveBeenCalledOnce());
  await vi.waitFor(async () => expect((await new LaunchJournal(home).read(siteOperationId("ali", "op_split_ticket_launch")))?.exit).toBeDefined());
  await handleRpc(home, { id: "duplicate", method: "start_session", args }, options);
  expect(startManaged).toHaveBeenCalledOnce();
  expect(openEnvironment).toHaveBeenCalledOnce();
});

it.each([true, false, undefined])("classifies a durable start refusal only with explicit pre-input evidence: %s", async (safeFallback) => {
  const { handleRpc } = await import("./core.js");
  const { addWorkspace } = await import("./workspaces.js");
  const { home, journal } = await fixture();
  const workspace = await addWorkspace(home, home, "test");
  const startManaged = vi.fn(async () => { throw Object.assign(new Error("original startup error"), { safeFallback }); });
  const options = { allowMachineOps: true, sessionOperations: journal, agentControlPlane: { startManaged } as never };
  const args = { source: "codex", workspace_id: workspace.id, client_request_id: "op_refused_launch", operation_id: "refused-turn", prompt: "one task" };
  await handleRpc(home, { id: "first", method: "start_session", args }, options);
  const expectedState = safeFallback === true ? "failed" : "unknown";
  await vi.waitFor(async () => expect(await journal.status(undefined, args.operation_id)).toMatchObject({ state: expectedState, result: { error: expect.stringContaining("original startup error") } }));
  const restarted = new RunnerSessionOperations(home);
  expect(await restarted.status(undefined, args.operation_id)).toMatchObject({ state: expectedState });
  await handleRpc(home, { id: "duplicate", method: "start_session", args }, { ...options, sessionOperations: restarted });
  expect(startManaged).toHaveBeenCalledOnce();
});

it("records a start refused during validation as failed with its reason and never launches it", async () => {
  const { handleRpc } = await import("./core.js");
  const { home, journal } = await fixture();
  const startManaged = vi.fn();
  const options = { allowMachineOps: true, sessionOperations: journal, agentControlPlane: { startManaged } as never };
  const args = { source: "codex", workspace_id: "ws_ffffffffffffffffffffffff", client_request_id: "op_unknown_workspace",
    operation_id: "unknown-workspace", prompt: "one task", input_receipt: true };
  await handleRpc(home, { id: "first", method: "start_session", args }, options);
  await vi.waitFor(async () => expect(await journal.status(undefined, args.operation_id)).toMatchObject({
    state: "failed", result: { ok: false, code: "input_not_sent", error: expect.any(String) } }));
  await handleRpc(home, { id: "duplicate", method: "start_session", args }, options);
  expect(startManaged).not.toHaveBeenCalled();
});

it("retains prepared identity even when native rejection precedes the first receipt poll", async () => {
  const { handleRpc } = await import("./core.js");
  const { addWorkspace } = await import("./workspaces.js");
  const { home, journal } = await fixture();
  const workspace = await addWorkspace(home, home, "test");
  const startManaged = vi.fn(async (input: { onPrepared: (id: string, transport: "app-server") => Promise<void> }) => {
    await input.onPrepared("rejected-native", "app-server");
    throw Object.assign(new Error("native model refused"), { inputRejected: true, safeFallback: false });
  });
  const args = { source: "codex", workspace_id: workspace.id, client_request_id: "op_native_refusal",
    operation_id: "native-refusal", prompt: "one task" };
  const options = { allowMachineOps: true, sessionOperations: journal, agentControlPlane: { startManaged } as never };
  await handleRpc(home, { id: "first", method: "start_session", args }, options);
  await vi.waitFor(async () => expect(await journal.status(undefined, args.operation_id)).toMatchObject({ state: "failed",
    session_id: "rejected-native", result: { error: "native model refused" } }));
  await handleRpc(home, { id: "duplicate", method: "start_session", args }, options);
  expect(startManaged).toHaveBeenCalledOnce();
});
