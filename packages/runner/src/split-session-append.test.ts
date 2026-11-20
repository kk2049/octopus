import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleRpc, type RpcOptions } from "./core.js";
import type { AgentControlPlane, ContinueAgentSessionInput } from "./agent-control-plane.js";
import type { CodexExecRelayCoordinator } from "./codex-exec-relay.js";
import { LaunchJournal } from "./launch-journal.js";
import { inputNotSent } from "./input-handoff.js";
import { RunnerSessionOperations } from "./session-operations.js";

const SID = "01a0380f-f9c3-7a41-a2fc-caf6be866715";
const WORKSPACE = "ws_0123456789abcdef01234567";
const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))); });

async function fixture(placement: "v1" | "v2" | "none" = "v2", namedAccount = false) {
  const home = await mkdtemp(path.join(tmpdir(), "split-append-"));
  homes.push(home);
  const ordinary = path.join(home, ".codex");
  const defaultSplit = path.join(home, ".octopus", "codex-split-home");
  const split = namedAccount ? path.join(defaultSplit, "accounts", "original-account") : defaultSplit;
  const writeTranscript = async (codexHome: string) => {
    const file = path.join(codexHome, "sessions", "2026", "09", "15", `rollout-2026-09-15T03-26-23-${SID}.jsonl`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ type: "session_meta", payload: { id: SID, cwd: home } }) + "\n");
    return file;
  };
  const sessionPath = await writeTranscript(split);
  if (placement !== "none") {
    const launches = new LaunchJournal(home);
    await launches.begin({ client_request_id: "op_split_original_launch", workspace_id: WORKSPACE,
      source: "codex", remote_execution: true, execution_device: "exec-b", prompt_hash: "a".repeat(64) });
    await launches.markManagedStarted("op_split_original_launch", SID, "app-server",
      placement === "v2" ? `spc_${"b".repeat(64)}` : undefined);
  }
  const continueSession = vi.fn(async (_input: ContinueAgentSessionInput): Promise<Record<string, unknown>> => ({ ok: true, session_id: SID }));
  const interruptSession = vi.fn(async () => ({ ok: true }));
  const releaseSession = vi.fn(async () => ({ ok: true }));
  const close = vi.fn(async () => {});
  const open = vi.fn(async () => ({ environmentId: "original-execution", endpoint: "ws://127.0.0.1:9001", close }));
  const options: RpcOptions = {
    allowMachineOps: true, gatewaySite: "site-a", sessionOperations: new RunnerSessionOperations(home),
    sessionScanRoot: { home, codexHome: ordinary },
    sessionPlusSessionScanRoot: { home, codexHome: defaultSplit,
      ...(namedAccount ? { codexHomes: [{ label: "b", codexHome: split }] } : {}) },
    agentControlPlane: { continueSession, interruptSession, releaseSession } as unknown as AgentControlPlane,
    codexExecRelay: { open } as unknown as CodexExecRelayCoordinator,
  };
  const args = { id: SID, source: "codex", prompt: "FOLLOWUP in the original session", execution_device: "exec-b",
    workspace_id: WORKSPACE, _octopus_execution_operation_id: "followup-scope",
    _octopus_execution_expires_at: Date.now() + 60_000,
    _octopus_execution_mcp_url: "http://127.0.0.1:1/api/mcp", _octopus_execution_mcp_token: "mcp_fixture_only" };
  const append = (input: Record<string, unknown> = args, opts = options) => handleRpc(home, { id: "rpc", method: "append_session", args: input }, opts);
  return { home, ordinary, split, sessionPath, writeTranscript, options, args, append, continueSession, interruptSession, releaseSession, open, close };
}

async function mcpFixture() {
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const message = JSON.parse(body) as { id: string; method: string };
      const result = message.method === "initialize"
        ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "octopus", version: "1" } }
        : { tools: [{ name: "run_workspace_command" }] };
      response.writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("MCP fixture did not listen");
  return { endpoint: `http://127.0.0.1:${address.port}/api/mcp`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

describe("split session append RPC root selection", () => {
  it.each(["model_turn_active", "effort_turn_active", "session_active", "duplicate_terminal_send", "ECONNRESET"])("preserves definitive input refusal separately from uncertain transport (%s)", async code => {
    const f = await fixture();
    f.continueSession.mockRejectedValue(Object.assign(new Error("input refused or transport lost"), { code }));
    const args = { ...f.args, steer_only: true, input_receipt: true, operation_id: "refused-followup" };
    await f.append(args);
    await vi.waitFor(async () => expect(await f.options.sessionOperations!.status("site-a", "refused-followup"))
      .toMatchObject({ state: code === "ECONNRESET" ? "unknown" : "failed",
        result: { code: code === "ECONNRESET" ? "unknown" : code, error: "input refused or transport lost" } }));
    await f.append(args);
    expect(f.continueSession).toHaveBeenCalledOnce();
  });

  it.each([
    ["tagged before sending", () => inputNotSent(new Error("CLI changed before sending")), "failed", "input_not_sent"],
    // machineAppendSession reports a managed setup failure itself, without the legacy CLI ladder.
    ["proven before prompt transfer", () => Object.assign(new Error("provider setup failed"), { safeFallback: true }), "failed", "failed"],
    ["rejected by the provider", () => Object.assign(new Error("model refused"), { inputRejected: true, safeFallback: false }), "failed", "input_not_sent"],
    ["after possible transfer", () => Object.assign(new Error("turn/start response lost"), { safeFallback: false }), "unknown", "unknown"],
    ["claimed uncertain", () => inputNotSent(Object.assign(new Error("uncertain"), { code: "unknown" })), "unknown", "unknown"],
  ] as const)("classifies a control-plane refusal %s", async (_name, error, state, code) => {
    const f = await fixture();
    f.continueSession.mockRejectedValue(error());
    const args = { ...f.args, steer_only: true, input_receipt: true, operation_id: "classified-followup" };
    await f.append(args);
    await vi.waitFor(async () => expect(await f.options.sessionOperations!.status("site-a", "classified-followup"))
      .toMatchObject({ state, result: { ok: false, code } }));
    await f.append(args);
    expect(f.continueSession).toHaveBeenCalledOnce();
  });

  it("records an expired execution credential as a failed send with its reason, never as unknown", async () => {
    const f = await fixture();
    const args = { ...f.args, _octopus_execution_expires_at: Date.now() - 1, input_receipt: true, operation_id: "expired-followup" };
    const status = () => f.options.sessionOperations!.status("site-a", "expired-followup");
    await f.append(args);
    await vi.waitFor(async () => expect(await status()).toMatchObject({ state: "failed",
      result: { ok: false, code: "input_not_sent", error: expect.stringContaining("执行凭证已失效") } }));
    expect((await status()).input).toBeUndefined();
    await f.append(args);
    expect(f.continueSession).not.toHaveBeenCalled();
    expect(f.open).not.toHaveBeenCalled();
  });
  it("steers the existing controller without rebuilding its execution relay or tool configuration", async () => {
    const f = await fixture();
    // The upstream endpoint is deliberately unavailable: live input must not
    // open another proxy merely to write to the controller already running.
    expect(await f.append({ ...f.args, steer_only: true })).toMatchObject({ ok: true, result: { ok: true } });
    expect(f.continueSession).toHaveBeenCalledWith(expect.objectContaining({ steerOnly: true, sessionId: SID, sessionPath: f.sessionPath }));
    expect(f.open).not.toHaveBeenCalled();
    expect(f.close).not.toHaveBeenCalled();
    expect(await f.append({ ...f.args, steer_only: true, workspace_id: "wrong" })).toMatchObject({ ok: false });
    expect(f.continueSession).toHaveBeenCalledOnce();
  });

  it.each([false, true])("admits a durable followup from the original isolated account once (named: %s)", async (namedAccount) => {
    const f = await fixture("v2", namedAccount);
    // A same-id ordinary copy must not redirect a journaled split session.
    await f.writeTranscript(f.ordinary);
    const upstream = await mcpFixture();
    let complete!: () => void;
    const completion = new Promise<void>((resolve) => { complete = resolve; });
    const input = { phase: "provider_accepted", evidence: "provider_ack", at: "2026-09-15T03:28:20.600Z",
      session_id: SID, turn_id: "followup-turn", transport: "app-server", control_action: "resume" } as const;
    f.continueSession.mockImplementation(async (request) => {
      await request.onInput?.(input);
      await completion;
      return { ok: true, session_id: SID, new_session_id: SID, result_text: "FOLLOWUP" };
    });
    const args = { ...f.args, operation_id: "durable-followup", input_receipt: true, _octopus_execution_mcp_url: upstream.endpoint,
      // Wire values cannot override the native home resolved from the rollout.
      codex_home: f.ordinary, codex_account: "another-account" };
    const status = () => f.options.sessionOperations!.status("site-a", "durable-followup");
    try {
      expect(await f.append(args)).toMatchObject({ ok: true, result: { protocol: "runner-session-operation/v1", state: "running", session_id: SID } });
      await vi.waitFor(async () => expect(await status()).toMatchObject({ state: "running", session_id: SID, input }));
      expect(f.continueSession).toHaveBeenCalledWith(expect.objectContaining({ provider: "codex", sessionId: SID,
        sessionPath: f.sessionPath, codexHome: f.split, prompt: f.args.prompt,
        recoveryPlacement: { gatewaySite: "site-a", executionDevice: "exec-b", workspaceId: WORKSPACE },
        codexEnvironment: { environmentId: "original-execution", endpoint: "ws://127.0.0.1:9001" } }));
      expect(f.open).toHaveBeenCalledWith({ executionDevice: "exec-b", workspaceId: WORKSPACE,
        executionToken: "mcp_fixture_only", operationId: "followup-scope" });
      expect(f.close).not.toHaveBeenCalled();
      await f.append(args);
      expect(f.continueSession).toHaveBeenCalledOnce();
      complete();
      await vi.waitFor(async () => expect(await status()).toMatchObject({ state: "succeeded", session_id: SID, input,
        result: { new_session_id: SID, result_text: "FOLLOWUP" } }));
      expect(f.close).toHaveBeenCalledOnce();
    } finally {
      complete();
      await vi.waitFor(async () => expect((await status()).state).not.toBe("running"));
      await upstream.close();
    }
  });

  it("keeps v1 placement and append calls without operation_id compatible", async () => {
    const f = await fixture("v1");
    const upstream = await mcpFixture();
    try {
      expect(await f.append({ ...f.args, _octopus_execution_mcp_url: upstream.endpoint })).toMatchObject({ ok: true, result: { ok: true, session_id: SID } });
      expect(f.continueSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: SID, sessionPath: f.sessionPath }));
    } finally { await upstream.close(); }
  });

  it.each(["interrupt", "release_control"] as const)("resolves split %s controls without requiring a new execution credential", async (control) => {
    const f = await fixture();
    expect(await f.append({ id: SID, source: "codex", [control]: true })).toMatchObject({ ok: true, result: { ok: true } });
    expect(control === "interrupt" ? f.interruptSession : f.releaseSession).toHaveBeenCalledWith("codex", SID);
    expect(f.continueSession).not.toHaveBeenCalled();
    expect(f.open).not.toHaveBeenCalled();
  });

  it("requires durable placement to select the split root and preserves ordinary session routing", async () => {
    const f = await fixture("none");
    expect(await f.append({ ...f.args, path: f.sessionPath, codex_home: path.dirname(f.sessionPath) }))
      .toMatchObject({ ok: false, error: `session not found for id: ${SID}` });
    expect(f.continueSession).not.toHaveBeenCalled();
    const ordinary = await fixture("none");
    const ordinaryPath = await ordinary.writeTranscript(ordinary.ordinary);
    expect(await ordinary.append({ id: SID, source: "codex", prompt: "ordinary" })).toMatchObject({ ok: true, result: { ok: true } });
    expect(ordinary.continueSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: SID, sessionPath: ordinaryPath }));
    expect(ordinary.open).not.toHaveBeenCalled();
  });

  it("still rejects missing, expired and changed execution placement before provider admission", async () => {
    const f = await fixture();
    for (const args of [
      { id: SID, source: "codex", prompt: "missing scope" },
      { ...f.args, _octopus_execution_expires_at: Date.now() - 1 },
    ]) {
      expect(await f.append(args)).toMatchObject({ ok: false, error: expect.stringContaining("执行凭证已失效") });
    }
    for (const args of [{ ...f.args, execution_device: "another-device" }, { ...f.args, workspace_id: "ws_ffffffffffffffffffffffff" }]) {
      expect(await f.append(args)).toMatchObject({ ok: false, error: expect.stringContaining("执行放置与原始启动记录不一致") });
    }
    expect(f.continueSession).not.toHaveBeenCalled();
    expect(f.open).not.toHaveBeenCalled();
  });

  it("fails closed without a configured split root and never reruns the settled operation after configuration changes", async () => {
    const f = await fixture();
    const args = { ...f.args, operation_id: "original-refusal", input_receipt: true };
    await f.append(args, { ...f.options, sessionPlusSessionScanRoot: undefined });
    const status = () => f.options.sessionOperations!.status("site-a", "original-refusal");
    // The refusal precedes every transport, so it is a definite failure.
    await vi.waitFor(async () => expect(await status()).toMatchObject({ state: "failed",
      result: { code: "input_not_sent", error: "Sessions+ split transcript root is unavailable on this Runner" } }));
    expect((await status()).input).toBeUndefined();
    expect(await f.append(args)).toMatchObject({ ok: true, result: { state: "failed" } });
    expect(f.continueSession).not.toHaveBeenCalled();
    expect(f.open).not.toHaveBeenCalled();
  });
});
