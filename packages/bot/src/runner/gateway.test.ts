import { runnerDisplayNameKey } from "./display-name.js";
import { Agent, request } from "node:http";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { Store } from "../store/store.js";
import { RunnerGateway, hashRunnerToken, type RunnerTransport } from "./gateway.js";
import { discoverRunnerInventory } from "@claude-bot/runner/inventory";
import { WORKSPACE_DEVELOPMENT_PROTOCOL, WORKSPACE_DEVELOPMENT_LIMITS } from "@claude-bot/runner/workspace-development-protocol";
import { RunnerBundleRegistry } from "./bundle-registry.js";
import { RunnerSessionProjectionService } from "./session-projection.js";
import { dispatchToRunner } from "./dispatch.js";
import {
  RUNNER_MANAGED_COMPLETION_SCHEMA,
  SESSION_OPERATION_PROTOCOL,
  RUNNER_SYSTEM_STATUS_SCHEMA,
  runnerBundleProtocolBanner,
} from "@claude-bot/runner/gateway-protocol";

let dir: string;
let store: Store;
let gateway: RunnerGateway;
/**
 * Transport-level tests legitimately drive the raw dispatch: this file is
 * about the device protocol (register / merge / keepalive), not about
 * authorization — that lives in capability.integration.test.ts, which asserts
 * on frames. Claiming the transport here is the SAME once-only door the
 * Runner Object adapter uses in production.
 */
let transport: RunnerTransport;

const NOW = "2026-07-15T00:00:00.000Z";

/** Minimal in-test runner: registers and answers RPCs from a handler map. */
async function fakeRunner(
  token: string,
  handlers: Record<string, (args: Record<string, unknown>) => unknown | Promise<unknown>>,
  device = "test",
  inventory?: unknown,
): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${gateway.port}`);
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => ws.send(JSON.stringify({ type: "register", token, device, inventory })));
    ws.on("message", function onMsg(data) {
      const msg = JSON.parse(String(data)) as Record<string, unknown>;
      if (msg.type === "registered") {
        ws.off("message", onMsg);
        resolve();
      } else if (msg.type === "error") {
        reject(new Error(String(msg.message)));
      }
    });
    ws.on("error", reject);
  });
  ws.on("message", (data) => {
    const msg = JSON.parse(String(data)) as { type: string; id?: string; method?: string; args?: Record<string, unknown> };
    if (msg.type !== "rpc" || !msg.id || !msg.method) return;
    const h = handlers[msg.method];
    if (!h) {
      ws.send(JSON.stringify({ type: "rpc_result", id: msg.id, ok: false, error: "no handler" }));
      return;
    }
    void Promise.resolve(h(msg.args ?? {})).then(
      (result) => ws.send(JSON.stringify({ type: "rpc_result", id: msg.id, ok: true, result })),
      (err) => ws.send(JSON.stringify({ type: "rpc_result", id: msg.id, ok: false, error: (err as Error).message })),
    );
  });
  return ws;
}

let peerRpcSequence = 0;

async function peerRpc(
  ws: WebSocket,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const id = `peer-${++peerRpcSequence}`;
  return await new Promise<Record<string, unknown>>((resolve) => {
    const onMessage = (data: WebSocket.RawData): void => {
      const message = JSON.parse(String(data)) as Record<string, unknown>;
      if (message.type !== "peer_rpc_result" || message.id !== id) return;
      ws.off("message", onMessage);
      resolve(message);
    };
    ws.on("message", onMessage);
    ws.send(JSON.stringify({ type: "peer_rpc", id, ...input }));
  });
}

let localBridgeSequence = 0;
async function localBridge(
  ws: WebSocket,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const id = `local-${++localBridgeSequence}`;
  return await new Promise<Record<string, unknown>>((resolve) => {
    const onMessage = (data: WebSocket.RawData): void => {
      const message = JSON.parse(String(data)) as Record<string, unknown>;
      if (message.type !== "local_agent_bridge_result" || message.id !== id) return;
      ws.off("message", onMessage);
      resolve(message);
    };
    ws.on("message", onMessage);
    ws.send(JSON.stringify({ type: "local_agent_bridge", id, ...input }));
  });
}

async function sessionRecoveryScope(
  ws: WebSocket,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const id = `recovery-${++peerRpcSequence}`;
  return await new Promise<Record<string, unknown>>((resolve) => {
    const onMessage = (data: WebSocket.RawData): void => {
      const message = JSON.parse(String(data)) as Record<string, unknown>;
      if (message.type !== "session_recovery_scope_result" || message.id !== id) return;
      ws.off("message", onMessage);
      resolve(message);
    };
    ws.on("message", onMessage);
    ws.send(JSON.stringify({ type: "session_recovery_scope", id, ...input }));
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "gw-"));
  store = new Store(join(dir, "t.db"));
  store.saveUser({ username: "alice", uid: 5001, home_dir: "/x/alice", created_at: NOW });
  gateway = new RunnerGateway(store, { port: 0 });
  await gateway.start();
  transport = gateway.claimTransport();
});

afterEach(async () => {
  await gateway.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("RunnerGateway", () => {
  it("projects hot extension catalogues only for the authenticated owner and dispatches to the exact device", async () => {
    const token = "rt_capability";
    store.saveRunnerToken(hashRunnerToken(token), "alice", "test", NOW);
    const ready = await discoverRunnerInventory(dir, { executionOnly: true,
      probe: { command: async () => ({ stdout: "" }), workspaceCount: async () => 1 } });
    const provider = { id: "demo", title: "Demo", version: "1", revision: "a".repeat(32), status: "ready",
      command: "/secret/bin", env: { SECRET: "hidden" }, tools: [{ name: "echo", inputSchema: { type: "object" } }] };
    const inventory = { ...ready, capabilities: { protocol: "runner-capabilities/v1", providers: [provider] } };
    const calls: Record<string, unknown>[] = [];
    const socket = await fakeRunner(token, { invoke_runner_capability: args => { calls.push(args); return { status: "succeeded" }; } }, "test", inventory);
    try {
      const publicInventory = gateway.listDevices("alice")[0]!.inventory!;
      expect(publicInventory.capabilities?.providers[0]!.tools[0]!.name).toBe("echo");
      expect(JSON.stringify(publicInventory)).not.toMatch(/secret|hidden/);
      expect(gateway.listDevices("bob")).toEqual([]);
      await expect(transport.dispatch("alice", "invoke_runner_capability", { provider: "demo" })).rejects.toThrow();
      await expect(transport.dispatch("bob", "invoke_runner_capability", { device: "test" })).rejects.toThrow();
      expect(calls).toHaveLength(0);
      await transport.dispatch("alice", "invoke_runner_capability", { device: "test", provider: "demo" });
      expect(calls).toEqual([{ provider: "demo" }]);
      socket.send(JSON.stringify({ type: "inventory_changed", inventory: { ...inventory,
        capabilities: { protocol: "runner-capabilities/v1", providers: [] } } }));
      await vi.waitFor(() => expect(gateway.listDevices("alice")[0]!.inventory!.capabilities?.providers).toEqual([]));
      expect(socket.readyState).toBe(WebSocket.OPEN);
    } finally { socket.close(); }
  });

  it("preserves file-transfer capability and carries full binary chunks over the authenticated socket", async () => {
    const token = "rt_file_transfer";
    store.saveRunnerToken(hashRunnerToken(token), "alice", "test", NOW);
    const ready = await discoverRunnerInventory(dir, {
      executionOnly: true,
      probe: { command: async () => ({ stdout: "" }), workspaceCount: async () => 1 },
    });
    expect(ready.file_transfer).toEqual({ protocol: "workspace-file-transfer/v1" });
    const bytes = Buffer.alloc(1024 * 1024, 173);
    const chunk = bytes.toString("base64");
    const seen: Record<string, unknown>[] = [];
    const socket = await fakeRunner(token, {
      workspace_file_transfer: (args) => {
        seen.push(args);
        return args.action === "read" ? { data: chunk } : { bytes: String(Buffer.from(String(args.data), "base64").length) };
      },
    }, "test", { ...ready, file_transfer: { ...ready.file_transfer, secret: "never-project-this" } });
    try {
      expect(gateway.listDevices("alice")[0]?.inventory?.file_transfer).toEqual(ready.file_transfer);
      const result = await transport.dispatch("alice", "workspace_file_transfer", { device: "test", action: "read" }) as { data: string };
      expect(Buffer.from(result.data, "base64").equals(bytes)).toBe(true);
      expect(await transport.dispatch("alice", "workspace_file_transfer", {
        device: "test", action: "write", data: result.data,
      })).toEqual({ bytes: String(bytes.length) });
      await expect(transport.dispatch("bob", "workspace_file_transfer", { device: "test", action: "read" })).rejects.toThrow();
      expect(seen).toHaveLength(2);
      expect(seen.every((args) => args.device === undefined)).toBe(true);
    } finally { socket.close(); }
  });

  it("refreshes a live Runner display name without reconnecting or changing its token identity", async () => {
    const token = "rt_display_name";
    store.saveRunnerToken(hashRunnerToken(token), "alice", "test", NOW);
    const before = store.getRunnerTokenByHash(hashRunnerToken(token));
    const socket = await fakeRunner(token, {});
    try {
      expect(gateway.listDevices("alice")[0]).toMatchObject({ device: "test", online: true });
      store.setSetting("alice", runnerDisplayNameKey("test"), "aliyun");
      expect(gateway.listDevices("alice")[0]).toMatchObject({ device: "test", display_name: "aliyun", online: true });
      expect(store.getRunnerTokenByHash(hashRunnerToken(token))?.device).toBe(before?.device);
      expect(socket.readyState).toBe(WebSocket.OPEN);
      store.setSetting("alice", runnerDisplayNameKey("test"), "changed again");
      expect(gateway.listDevices("alice")[0].display_name).toBe("changed again");
    } finally { socket.close(); }
  });

  it("stops even when an unauthenticated socket withholds its close handshake", async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${gateway.port}`);
    await new Promise<void>((resolve) => socket.once("open", resolve));
    socket.pause();
    try { await gateway.stop(); }
    finally { socket.resume(); socket.terminate(); }
  }, 10_000);

  it("rejects an unknown token", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${gateway.port}`);
    const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
    ws.on("open", () => ws.send(JSON.stringify({ type: "register", token: "rt_bogus" })));
    expect(await closed).toBe(4003);
    expect(gateway.isOnline("alice")).toBe(false);
  });

  it("registers, tracks presence + last_seen, and serves an rpc round-trip", async () => {
    const token = "rt_alice1";
    store.saveRunnerToken(hashRunnerToken(token), "alice", "test", NOW);
    const ws = await fakeRunner(token, {
      read_session: (args) => ({ echo: args.id }),
    });
    expect(gateway.isOnline("alice")).toBe(true);
    expect(gateway.listDevices("alice")).toEqual([
      expect.objectContaining({ device: "test", online: true }),
    ]);
    expect(store.listRunnerTokens("alice")[0].last_seen_at).not.toBeNull();

    const result = await transport.dispatch("alice", "read_session", { id: "s-9" });
    expect(result).toEqual({ echo: "s-9" });

    ws.close();
    await vi.waitFor(() => expect(gateway.isOnline("alice")).toBe(false), { timeout: 1_000 });
  });

  it("retains only a validated resource snapshot on the authenticated device", async () => {
    const token = "rt_status";
    store.saveRunnerToken(hashRunnerToken(token), "alice", "test", NOW);
    const ws = await fakeRunner(token, {});
    const status = {
      schema: RUNNER_SYSTEM_STATUS_SCHEMA,
      hostname: "runner-one",
      cpuPercent: 37,
      memoryPercent: 82,
      windowMs: 15_000,
      sampledAt: "2026-09-09T12:30:00.000Z",
    };
    ws.send(JSON.stringify({ type: "system_status", status }));
    await vi.waitFor(() => expect(gateway.listDevices("alice")[0]?.system_status).toEqual(status));

    ws.send(JSON.stringify({ type: "system_status", status: { ...status, cpuPercent: 120 } }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(gateway.listDevices("alice")[0]?.system_status).toEqual(status);
    ws.close();
  });

  it("issues restart scopes only for the authenticated Runner owner and device", async () => {
    const token = "rt_recovery";
    store.saveRunnerToken(hashRunnerToken(token), "alice", "test", NOW);
    const issue = vi.fn(() => ({
      token: "mcp_fresh",
      endpoint: "http://127.0.0.1:9820/api/mcp",
      expiresAt: Date.now() + 60_000,
      operationId: "op_rotated",
      executionDevice: "val15",
      workspaceId: "ws_0123456789abcdef01234567",
    }));
    const detach = gateway.installSessionRecoveryIssuer({ issue });
    const ws = await fakeRunner(token, {});
    try {
      await expect(sessionRecoveryScope(ws, {
        provider: "codex",
        sessionId: "thread-restart",
        owner: "mallory",
        runtimeDevice: "forged",
      })).resolves.toMatchObject({
        ok: true,
        result: {
          token: "mcp_fresh",
          executionDevice: "val15",
          workspaceId: "ws_0123456789abcdef01234567",
        },
      });
      expect(issue).toHaveBeenCalledWith({
        owner: "alice",
        runtimeDevice: "test",
        source: "codex",
        sessionId: "thread-restart",
      });
      await expect(sessionRecoveryScope(ws, {
        provider: "bogus",
        sessionId: "thread-restart",
      })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/invalid/) });
      expect(issue).toHaveBeenCalledOnce();
    } finally {
      ws.close();
      detach();
    }
  });

  it("projects a content-free session change from the authenticated device identity", async () => {
    const token = "rt_change";
    store.saveRunnerToken(hashRunnerToken(token), "alice", "test", NOW);
    const ws = await fakeRunner(token, {});
    const changed = new Promise<{ owner: string; device: string }>((resolve) => {
      transport.subscribeSessionChanges?.((owner, device) => resolve({ owner, device }));
    });
    ws.send(JSON.stringify({ type: "sessions_changed", owner: "mallory", device: "forged" }));
    await expect(changed).resolves.toEqual({ owner: "alice", device: "test" });
    ws.close();
  });

  it("binds a bounded managed completion to the authenticated Runner identity", async () => {
    const token = "rt_completion";
    store.saveRunnerToken(hashRunnerToken(token), "alice", "test", NOW);
    const ws = await fakeRunner(token, {});
    const completion = new Promise<Record<string, unknown>>((resolve) => {
      gateway.subscribeManagedSessionCompletions((owner, device, event) => {
        resolve({ owner, device, event });
      });
    });
    ws.send(JSON.stringify({
      type: "managed_session_completion",
      owner: "mallory",
      device: "forged",
      completion: {
        schema: RUNNER_MANAGED_COMPLETION_SCHEMA,
        provider: "codex",
        session_id: "thread-1",
        turn_id: "turn-1",
        status: "succeeded",
        completed_at: "2026-08-28T12:30:00.000Z",
      },
    }));
    await expect(completion).resolves.toMatchObject({
      owner: "alice",
      device: "test",
      event: { provider: "codex", session_id: "thread-1", status: "succeeded" },
    });
    ws.close();
  });

  it("acknowledges a receipt only after every receiver handled it", async () => {
    const token = "rt_completion_ack";
    store.saveRunnerToken(hashRunnerToken(token), "alice", "test", NOW);
    const ws = await fakeRunner(token, {});
    const acks: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => {
      const msg = JSON.parse(String(data)) as Record<string, unknown>;
      if (msg.type === "managed_session_completion_ack") acks.push(msg);
    });
    const seen: string[] = [];
    const detachOk = gateway.subscribeManagedSessionCompletions((_owner, _device, event) => { seen.push(event.turn_id); });
    const detachFlaky = gateway.subscribeManagedSessionCompletions((_owner, _device, event) => {
      if (event.turn_id === "turn-retained") throw new Error("receiver unavailable");
    });
    const send = (turn: string) => ws.send(JSON.stringify({ type: "managed_session_completion", completion: {
      schema: RUNNER_MANAGED_COMPLETION_SCHEMA, provider: "codex", session_id: "thread-1", turn_id: turn,
      status: "succeeded", completed_at: "2026-08-28T12:30:00.000Z" } }));
    try {
      send("turn-handled");
      await vi.waitFor(() => expect(acks).toEqual([{ type: "managed_session_completion_ack", provider: "codex", turn_id: "turn-handled" }]));
      send("turn-retained");
      send("turn-marker");
      await vi.waitFor(() => expect(seen).toEqual(["turn-handled", "turn-retained", "turn-marker"]));
      // A failed receiver keeps the receipt replayable; the next one is acknowledged.
      await vi.waitFor(() => expect(acks.map((ack) => ack.turn_id)).toEqual(["turn-handled", "turn-marker"]));
    } finally {
      detachOk(); detachFlaky();
      ws.close();
    }
  });

  it("binds projection identity to the authenticated socket and sends narrow demand commands", async () => {
    const token = "rt_projection";
    store.saveRunnerToken(hashRunnerToken(token), "alice", "test", NOW);
    const ws = await fakeRunner(token, {});
    const projectionTransport = gateway.claimSessionProjectionTransport();
    const projected = new Promise<Record<string, unknown>>((resolve) => {
      projectionTransport.subscribe((owner, device, projection) => {
        resolve({ owner, device, projection });
        return true;
      });
    });
    const changed = new Promise<{ owner: string; device: string }>((resolve) => {
      transport.subscribeSessionChanges?.((owner, device) => resolve({ owner, device }));
    });
    ws.send(JSON.stringify({
      type: "session_projection",
      owner: "mallory",
      device: "forged",
      projection: {
        schema: "runner-session-projection/v1",
        kind: "roster_full",
        epoch: "epoch-gateway",
        sequence: 1,
        observed_at: "2026-08-23T00:00:00.000Z",
        total_found: 1,
        sessions: [{ id: "s-1", source: "claude", title: "One" }],
      },
    }));
    await expect(projected).resolves.toMatchObject({
      owner: "alice",
      device: "test",
      projection: { kind: "roster_full", sessions: [{ id: "s-1" }] },
    });
    await expect(changed).resolves.toEqual({ owner: "alice", device: "test" });

    const commandFrame = new Promise<Record<string, unknown>>((resolve) => {
      const listener = (data: WebSocket.RawData): void => {
        const message = JSON.parse(String(data)) as Record<string, unknown>;
        if (message.type !== "session_projection_command") return;
        ws.off("message", listener);
        resolve(message);
      };
      ws.on("message", listener);
    });
    expect(projectionTransport.send("alice", "test", {
      schema: "runner-session-projection/v1",
      kind: "transcript_subscribe",
      source: "claude",
      session_id: "s-1",
      max_messages: 200,
    })).toBe(true);
    await expect(commandFrame).resolves.toMatchObject({
      type: "session_projection_command",
      command: { kind: "transcript_subscribe", source: "claude", session_id: "s-1" },
    });
    expect(projectionTransport.send("alice", "missing", {
      schema: "runner-session-projection/v1",
      kind: "transcript_unsubscribe",
      source: "claude",
      session_id: "s-1",
    })).toBe(false);
    ws.close();
  });

  it("validates Claude quota separately and strips credentials at the authenticated inventory boundary", async () => {
    const token = "rt_claude_quota";
    store.saveRunnerToken(hashRunnerToken(token), "alice", "test", NOW);
    const quota = { status: "available", fetchedAt: NOW, windows: [{ remainingPercent: 63, windowMinutes: 10080, resetsAt: NOW }] };
    const base = { schema: "runner-inventory/v1", agent_backends: [],
      execution: { platform: "linux", arch: "x64", shell: true, workspace_files: true, workspace_count: 0 },
      ticket_options: { protocol: "ticket-options/v1", codex_accounts: [{ id: "account_a", label: "codexa" }], workspaces: [] } };
    const ws = await fakeRunner(token, {}, "test", { ...base, ticket_options: { ...base.ticket_options,
      claude_accounts: [{ id: "@default", label: "private-identity", auth: "private-token", quota: { ...quota, accessToken: "private-token" } }],
    } });
    try {
      const options = gateway.listDevices("alice")[0]!.inventory!.ticket_options!;
      expect(options.claude_accounts).toEqual([{ id: "@default", label: "Claude", quota }]);
      expect(JSON.stringify(options)).not.toContain("private-");
      expect(gateway.listDevices("bob")).toEqual([]);
      const changed = new Promise<void>((resolve) => transport.subscribeSessionChanges?.(() => resolve()));
      ws.send(JSON.stringify({ type: "inventory_changed", inventory: { ...base, ticket_options: { ...base.ticket_options,
        claude_accounts: [{ id: "arbitrary", label: "bad" }],
      } } }));
      await changed;
      expect(gateway.listDevices("alice")[0]!.inventory!.ticket_options).toEqual(base.ticket_options);
    } finally { ws.close(); }
  });

  it("accepts a fresh bounded inventory report without reconnecting", async () => {
    const token = "rt_inventory";
    store.saveRunnerToken(hashRunnerToken(token), "alice", "test", NOW);
    const ws = await fakeRunner(token, {});
    const changed = new Promise<void>((resolve) => {
      transport.subscribeSessionChanges?.(() => resolve());
    });
    ws.send(JSON.stringify({
      type: "inventory_changed",
      inventory: {
        schema: "runner-inventory/v1",
        agent_backends: [
          { kind: "claude", available: true, split_execution: true, version: "2.1.3", diagnostic_code: "/private/untrusted-detail",
            diagnostic_detail: { path: "relative/untrusted-bin", rule: "group_writable" } },
          { kind: "codex", available: false, split_execution: false, split_execution_reason: "local_tools_unfilterable", reason: "probe_failed", diagnostic_code: "unsafe_permissions", detail: { path: "/secret/bin" },
            diagnostic_detail: { path: "/home/alice/.local/bin", rule: "group_writable", uid: 7 } },
          { kind: "omp", available: true, split_execution: true, version: "0.5.0" },
        ],
        execution: {
          platform: "darwin",
          arch: "x64",
          shell: true,
          workspace_files: true,
          workspace_count: 3,
          codex_exec_server: true,
        },
        workspace_jobs: { protocol: "workspace-jobs/v1", concurrency: 1, max_log_chunk_bytes: 65536, root: "/secret/bin" },
        ticket_options: { protocol: "ticket-options/v1",
          codex_accounts: [{ id: "pool-b", label: "codexb", home: "/secret/bin", models: [{value:"local-model",label:"Local",secret:"private"}] }],
          workspaces: [{ id: `ws_${"a".repeat(24)}`, label: "Project", path: "/secret/bin" }] },
        gui_automation: {
          available: true,
          protocol: "runner-macos-gui/v1",
          consent_ttl_seconds: 900,
        },
      },
    }));
    await changed;
    expect(gateway.listDevices("alice")).toEqual([
      expect.objectContaining({
        device: "test",
        inventory: expect.objectContaining({
          schema: "runner-inventory/v1",
          agent_backends: expect.arrayContaining([expect.objectContaining({ kind: "codex", reason: "probe_failed", diagnostic_code: "unsafe_permissions",
            diagnostic_detail: { path: "/home/alice/.local/bin", rule: "group_writable" } })]),
          execution: expect.objectContaining({ workspace_count: 3, codex_exec_server: true }),
          workspace_jobs: { protocol: "workspace-jobs/v1", concurrency: 1, max_log_chunk_bytes: 65536 },
          ticket_options: { protocol: "ticket-options/v1", codex_accounts: [{ id: "pool-b", label: "codexb", models: [{value:"local-model",label:"Local"}] }], workspaces: [{ id: `ws_${"a".repeat(24)}`, label: "Project" }] },
          gui_automation: { available: true, protocol: "runner-macos-gui/v1", consent_ttl_seconds: 900 },
        }),
        providers: [{ kind: "workspace", protocol: "workspace-jobs/v1", concurrency: 1 }],
      }),
    ]);
    expect(JSON.stringify(gateway.listDevices("alice"))).not.toContain("/secret/bin");
    expect(JSON.stringify(gateway.listDevices("alice"))).not.toContain("/private/untrusted-detail");
    expect(JSON.stringify(gateway.listDevices("alice"))).not.toContain("relative/untrusted-bin");
    ws.close();
  });

  it("drops only invalid inventory segments and keeps the device's valid backends", async () => {
    const token = "rt_inventory_segments";
    store.saveRunnerToken(hashRunnerToken(token), "alice", "test", NOW);
    const execution = { platform: "linux", arch: "x64", shell: true, workspace_files: true, workspace_count: 1, codex_exec_server: true };
    const ws = await fakeRunner(token, {}, "test", {
      schema: "runner-inventory/v1",
      agent_backends: [
        { kind: "claude", available: true, split_execution: true, version: "2.1.300" },
        { kind: "codex", available: "yes", split_execution: true },
        { kind: "future-cli", available: true, split_execution: true },
      ],
      execution,
      session_operations: { protocol: SESSION_OPERATION_PROTOCOL },
      workspace_jobs: { protocol: "workspace-jobs/v1", concurrency: 1, max_log_chunk_bytes: 65536 },
      workspace_development: { protocol: "workspace-development/v1", available: false, reason: "a-newer-reason",
        max_bundle_bytes: 128 * 1024 * 1024, max_artifact_chunk_bytes: 1024 * 1024 },
      dsh: { available: true },
    });
    const inventory = () => gateway.listDevices("alice")[0]?.inventory;
    try {
      expect(inventory()).toMatchObject({
        agent_backends: [{ kind: "claude", available: true, split_execution: true }],
        execution: { platform: "linux", codex_exec_server: true },
        session_operations: { protocol: SESSION_OPERATION_PROTOCOL },
        workspace_jobs: { protocol: "workspace-jobs/v1" },
      });
      expect(inventory()).not.toHaveProperty("workspace_development");
      expect(inventory()).not.toHaveProperty("dsh");
      // A Runner that does not say it hosts read-only scopes is taken not to.
      expect(inventory()!.execution).not.toHaveProperty("read_only_scope");
      const changed = new Promise<void>((resolve) => { transport.subscribeSessionChanges?.(() => resolve()); });
      ws.send(JSON.stringify({ type: "inventory_changed", inventory: {
        schema: "runner-inventory/v1",
        agent_backends: [{ kind: "codex", available: true, split_execution: true }, { kind: "omp", available: true }],
        execution,
        ticket_options: { protocol: "ticket-options/v1", codex_accounts: [{ id: "not valid!", label: "x" }], workspaces: [] },
      } }));
      await changed;
      expect(inventory()).toMatchObject({ agent_backends: [{ kind: "codex", available: true }, { kind: "omp", available: true }] });
      expect(inventory()).not.toHaveProperty("ticket_options");
    } finally { ws.close(); }
  });

  it("retains discovered session-operation support through authenticated registration and inventory replacement", async () => {
    const token = "rt_session_protocol_inventory";
    store.saveRunnerToken(hashRunnerToken(token), "alice", "test", NOW);
    const probe = { command: async () => ({ stdout: "codex 0.154.0" }), workspaceCount: async () => 1 };
    const ready = await discoverRunnerInventory(dir, { probe });
    expect(ready.session_operations).toEqual({ protocol: SESSION_OPERATION_PROTOCOL });
    const ws = await fakeRunner(token, {}, "test", { ...ready,
      session_operations: { ...ready.session_operations, path: "/private/operations", token: "never-project-this" } });
    const inventory = () => gateway.listDevices("alice")[0]?.inventory;
    const update = async (next: unknown): Promise<void> => {
      const changed = new Promise<void>((resolve) => {
        const off = transport.subscribeSessionChanges!((owner, device) => {
          if (owner === "alice" && device === "test") { off(); resolve(); }
        });
      });
      ws.send(JSON.stringify({ type: "inventory_changed", inventory: next }));
      await changed;
    };
    try {
      expect(inventory()?.session_operations).toEqual({ protocol: SESSION_OPERATION_PROTOCOL });
      // The Runner hosts read-only (document assistant) scopes, and says so.
      expect(ready.execution.read_only_scope).toBe(true);
      expect(inventory()?.execution.read_only_scope).toBe(true);
      expect(JSON.stringify(inventory())).not.toContain("/private/operations");
      expect(JSON.stringify(inventory())).not.toContain("never-project-this");
      expect(gateway.listDevices("bob")).toEqual([]);
      const { session_operations: _operations, ...legacy } = ready;
      await update(legacy);
      expect(inventory()?.session_operations).toBeUndefined();
      expect(inventory()?.agent_backends.find((backend) => backend.kind === "codex")?.available).toBe(true);
      await update(ready);
      expect(inventory()?.session_operations).toEqual(ready.session_operations);
      expect(gateway.isReadOnly("alice", "test")).toBe(false);
      await update(await discoverRunnerInventory(dir, { probe, allowMachineOps: false }));
      expect(inventory()?.session_operations).toBeUndefined();
      expect(inventory()?.read_only).toBe(true);
      expect(gateway.isReadOnly("alice", "test")).toBe(true);
      expect(gateway.isReadOnly("bob", "test")).toBe(false);
      await update({ ...ready, read_only: "yes" });
      expect(inventory()).not.toHaveProperty("read_only");
      await update(await discoverRunnerInventory(dir, { probe, executionOnly: true }));
      expect(inventory()?.session_operations).toBeUndefined();
      expect(inventory()?.execution.shell).toBe(true);
      expect(gateway.isReadOnly("alice", "test")).toBe(false);
      await update(ready);
      expect(inventory()?.session_operations).toEqual(ready.session_operations);
    } finally { ws.close(); }
  });

  it("accepts a legacy inventory without inferring durable operations from an available model", async () => {
    const token = "rt_legacy_session_protocol_inventory";
    store.saveRunnerToken(hashRunnerToken(token), "alice", "test", NOW);
    const ready = await discoverRunnerInventory(dir, {
      probe: { command: async () => ({ stdout: "codex 0.154.0" }), workspaceCount: async () => 0 },
    });
    const { session_operations: _operations, ...legacy } = ready;
    const ws = await fakeRunner(token, {}, "test", legacy);
    try {
      const inventory = gateway.listDevices("alice")[0]?.inventory;
      expect(inventory?.agent_backends.find((backend) => backend.kind === "codex")?.available).toBe(true);
      expect(inventory?.session_operations).toBeUndefined();
    } finally { ws.close(); }
  });

  it.each([null, true, [], {}, { protocol: "runner-session-operation/v2" }, { protocol: 1 }])(
    "drops a malformed session-operation declaration at authenticated registration and keeps the rest: %j", async (sessionOperations) => {
      const token = "rt_bad_session_protocol_inventory";
      store.saveRunnerToken(hashRunnerToken(token), "alice", "test", NOW);
      const inventory = await discoverRunnerInventory(dir, {
        probe: { command: async () => ({ stdout: "codex 0.154.0" }), workspaceCount: async () => 0 },
      });
      const ws = await fakeRunner(token, {}, "test", { ...inventory, session_operations: sessionOperations });
      try {
        expect(gateway.listDevices("alice")[0]?.online).toBe(true);
        const projected = gateway.listDevices("alice")[0]?.inventory;
        expect(projected?.session_operations).toBeUndefined();
        expect(projected?.agent_backends.find((backend) => backend.kind === "codex")?.available).toBe(true);
      } finally { ws.close(); }
    },
  );

  it.runIf(process.platform === "linux")("retains discovered development readiness through registration and live readonly/legacy updates", async () => {
    const token = "rt_development_inventory";
    store.saveRunnerToken(hashRunnerToken(token), "alice", "test", NOW);
    const probe = {
      command: async () => ({ stdout: "available" }),
      workspaceCount: async () => 1,
      workspaces: async () => [{ id: "ws_" + "a".repeat(24), label: "registered parent" }],
    };
    const ready = await discoverRunnerInventory(dir, { executionOnly: true, workspaceDevelopment: true, probe });
    expect(ready.workspace_development?.available).toBe(true);
    const ws = await fakeRunner(token, {}, "test", { ...ready,
      workspace_development: { ...ready.workspace_development, path: "/private/source", credential: "must-not-be-projected" } });
    const inventory = () => gateway.listDevices("alice")[0]?.inventory;
    const update = async (next: unknown): Promise<void> => {
      const changed = new Promise<void>((resolve) => {
        const off = transport.subscribeSessionChanges!((owner, device) => {
          if (owner === "alice" && device === "test") { off(); resolve(); }
        });
      });
      ws.send(JSON.stringify({ type: "inventory_changed", inventory: next }));
      await changed;
    };
    try {
      expect(inventory()?.workspace_development).toEqual(ready.workspace_development);
      expect(inventory()?.ticket_options?.workspaces).toEqual(ready.ticket_options?.workspaces);
      expect(JSON.stringify(inventory())).not.toContain("/private/source");
      expect(JSON.stringify(inventory())).not.toContain("must-not-be-projected");
      const readonly = await discoverRunnerInventory(dir, {
        executionOnly: true, workspaceDevelopment: true, allowMachineOps: false, probe,
      });
      await update(readonly);
      expect(inventory()?.workspace_development).toMatchObject({ available: false, reason: "machine_ops_disabled" });
      expect(gateway.listDevices("alice")[0]?.online).toBe(true);
      const { workspace_development: _development, ...legacy } = ready;
      await update(legacy);
      expect(inventory()?.workspace_development).toBeUndefined();
      expect(inventory()?.ticket_options).toEqual(ready.ticket_options);
      await update(ready);
      expect(inventory()?.workspace_development?.available).toBe(true);
    } finally { ws.close(); }
  });

  it.each([
    { protocol: "workspace-development/v2" },
    { available: "true" },
    { available: null },
    { reason: "unbounded-private-error" },
    { available: true, reason: "disabled" },
    { max_bundle_bytes: WORKSPACE_DEVELOPMENT_LIMITS.bundleBytes + 1 },
    { max_bundle_bytes: String(WORKSPACE_DEVELOPMENT_LIMITS.bundleBytes) },
    { max_artifact_chunk_bytes: 0 },
  ])("drops malformed development readiness at authenticated registration and keeps the rest: %j", async (patch) => {
    const token = "rt_bad_development_inventory";
    store.saveRunnerToken(hashRunnerToken(token), "alice", "test", NOW);
    const inventory = await discoverRunnerInventory(dir, { executionOnly: true,
      probe: { command: async () => ({ stdout: "" }), workspaceCount: async () => 0 } });
    const ws = await fakeRunner(token, {}, "test", { ...inventory,
      workspace_development: { protocol: WORKSPACE_DEVELOPMENT_PROTOCOL, available: true,
        max_bundle_bytes: WORKSPACE_DEVELOPMENT_LIMITS.bundleBytes,
        max_artifact_chunk_bytes: WORKSPACE_DEVELOPMENT_LIMITS.artifactChunkBytes, ...patch } });
    try {
      expect(gateway.listDevices("alice")[0]?.online).toBe(true);
      const projected = gateway.listDevices("alice")[0]?.inventory;
      expect(projected?.workspace_development).toBeUndefined();
      expect(projected?.execution).toEqual(inventory.execution);
    } finally { ws.close(); }
  });

  it("an export names its machine when the caller knows it, and is deterministic when not", async () => {
    // Two laptops that both hold `~/notes/plan.md`, with different contents.
    // Before this, `copy_file` took whichever connection the Map yielded first,
    // so which bytes ended up in a disclosed report archive depended on which
    // laptop had reconnected most recently.
    store.saveRunnerToken(hashRunnerToken("rt_c1"), "alice", "zeta", NOW);
    store.saveRunnerToken(hashRunnerToken("rt_c2"), "alice", "alpha", NOW);
    const ws1 = await fakeRunnerWithDevice("rt_c1", "zeta", {
      copy_file: () => ({ rel_path: "plan.md", content: "from-zeta" }),
    });
    const ws2 = await fakeRunnerWithDevice("rt_c2", "alpha", {
      copy_file: () => ({ rel_path: "plan.md", content: "from-alpha" }),
    });
    try {
      // Pinned: exactly that machine, whatever the connection order was.
      // …and the ANSWER says which machine, so a disclosure archive can record
      // provenance the scanner on the far side could not know.
      expect(await transport.dispatch("alice", "copy_file", { path: "~/notes/plan.md", device: "zeta" }))
        .toMatchObject({ content: "from-zeta", device: "zeta" });
      expect(await transport.dispatch("alice", "copy_file", { path: "~/notes/plan.md", device: "alpha" }))
        .toMatchObject({ content: "from-alpha", device: "alpha" });
      // Unpinned: sorted by device name, so the same request gives the same
      // answer on every run rather than tracking WebSocket timing.
      expect(await transport.dispatch("alice", "copy_file", { path: "~/notes/plan.md" }))
        .toMatchObject({ content: "from-alpha", device: "alpha" });
      // A named device that is not online is an error, never someone else.
      await expect(
        transport.dispatch("alice", "copy_file", { path: "~/notes/plan.md", device: "not-a-laptop" }),
      ).rejects.toThrow(/不在线|不属于你/);
    } finally {
      ws1.close();
      ws2.close();
    }
  });

  it("routes workspace media reads only to their named device", async () => {
    store.saveRunnerToken(hashRunnerToken("rt_media_z"), "alice", "zeta", NOW);
    store.saveRunnerToken(hashRunnerToken("rt_media_a"), "alice", "alpha", NOW);
    const zetaCalls: Record<string, unknown>[] = [];
    const alphaCalls: Record<string, unknown>[] = [];
    const ws1 = await fakeRunnerWithDevice("rt_media_z", "zeta", {
      read_workspace_binary: (args) => {
        zetaCalls.push(args);
        return { source: "zeta" };
      },
    });
    const ws2 = await fakeRunnerWithDevice("rt_media_a", "alpha", {
      read_workspace_binary: (args) => {
        alphaCalls.push(args);
        return { source: "alpha" };
      },
    });
    try {
      await expect(transport.dispatch("alice", "read_workspace_binary", {
        device: "alpha",
        workspace_id: "ws_1",
        relative_path: "sample.pdf",
        offset: 0,
        max_bytes: 1024,
      })).resolves.toEqual({ source: "alpha" });
      expect(zetaCalls).toEqual([]);
      expect(alphaCalls).toEqual([{
        workspace_id: "ws_1",
        relative_path: "sample.pdf",
        offset: 0,
        max_bytes: 1024,
      }]);
      await expect(transport.dispatch("alice", "read_workspace_binary", {
        workspace_id: "ws_1",
        relative_path: "sample.pdf",
        offset: 0,
        max_bytes: 1024,
      })).rejects.toThrow(/必须指定 device/);
      expect(zetaCalls).toEqual([]);
      expect(alphaCalls).toHaveLength(1);
    } finally {
      ws1.close();
      ws2.close();
    }
  });

  it("routes owner-file writes only to their named device and never broadcasts", async () => {
    store.saveRunnerToken(hashRunnerToken("rt_owner_z"), "alice", "zeta", NOW);
    store.saveRunnerToken(hashRunnerToken("rt_owner_a"), "alice", "alpha", NOW);
    const zeta = vi.fn(() => ({ source: "zeta" }));
    const alpha = vi.fn(() => ({ source: "alpha" }));
    const ws1 = await fakeRunnerWithDevice("rt_owner_z", "zeta", { replace_owner_text: zeta });
    const ws2 = await fakeRunnerWithDevice("rt_owner_a", "alpha", { replace_owner_text: alpha });
    const args = { absolute_path: "/draft.txt", expected_digest: `sha256:${"0".repeat(64)}`, text: "new" };
    try {
      await expect(transport.dispatch("alice", "replace_owner_text", { ...args, device: "alpha" }))
        .resolves.toEqual({ source: "alpha" });
      expect(alpha).toHaveBeenCalledExactlyOnceWith(args);
      expect(zeta).not.toHaveBeenCalled();
      await expect(transport.dispatch("alice", "replace_owner_text", args)).rejects.toThrow(/必须指定 device/);
      await expect(transport.dispatch("bob", "replace_owner_text", { ...args, device: "alpha" })).rejects.toThrow();
      expect(alpha).toHaveBeenCalledTimes(1);
      expect(zeta).not.toHaveBeenCalled();
    } finally {
      ws1.close(); ws2.close();
    }
  });

  it("routes an isolated Codex transcript read only to its named device", async () => {
    store.saveRunnerToken(hashRunnerToken("rt_codex_z"), "alice", "zeta", NOW);
    store.saveRunnerToken(hashRunnerToken("rt_codex_a"), "alice", "alpha", NOW);
    const zetaCalls: Record<string, unknown>[] = [];
    const alphaCalls: Record<string, unknown>[] = [];
    const ws1 = await fakeRunnerWithDevice("rt_codex_z", "zeta", {
      codex_agent_read_session: (args) => { zetaCalls.push(args); return { source: "zeta" }; },
    });
    const ws2 = await fakeRunnerWithDevice("rt_codex_a", "alpha", {
      codex_agent_read_session: (args) => { alphaCalls.push(args); return { source: "alpha" }; },
    });
    try {
      await expect(transport.dispatch("alice", "codex_agent_read_session", {
        device: "alpha",
        id: "01a0380f-f9c3-7a41-a2fc-caf6be86678a",
        max_messages: 200,
      })).resolves.toEqual({ source: "alpha" });
      expect(zetaCalls).toEqual([]);
      expect(alphaCalls).toEqual([{
        id: "01a0380f-f9c3-7a41-a2fc-caf6be86678a",
        max_messages: 200,
      }]);
      await expect(transport.dispatch("alice", "codex_agent_read_session", {
        id: "01a0380f-f9c3-7a41-a2fc-caf6be86678a",
      })).rejects.toThrow(/必须指定 device/);
    } finally {
      ws1.close();
      ws2.close();
    }
  });

  it("pins catalog pages to the requested owned device and preserves stable id order", async () => {
    store.saveRunnerToken(hashRunnerToken("rt_page_a"), "alice", "page-a", NOW);
    store.saveRunnerToken(hashRunnerToken("rt_page_b"), "alice", "page-b", NOW);
    let bCalls = 0;
    const wsA = await fakeRunnerWithDevice("rt_page_a", "page-a", { list_recent_sessions: () => ({ total_found: 501, has_more: true,
      sessions: [{ id: "a", source: "codex", last_activity: "2020" }, { id: "b", source: "codex", last_activity: "2026" }],
    }) });
    const wsB = await fakeRunnerWithDevice("rt_page_b", "page-b", { list_recent_sessions: () => { bCalls++; return { sessions: [] }; } });
    try {
      const out = await transport.dispatch("alice", "list_recent_sessions", { device: "page-a", cursor: "", limit: 100 }) as any;
      expect(out.sessions.map((row: any) => row.id)).toEqual(["a", "b"]);
      expect(out.has_more).toBe(true);
      expect(out.devices).toEqual(["page-a"]);
      expect(bCalls).toBe(0);
      const legacy = await transport.dispatch("alice", "list_recent_sessions", { device: "page-b", cursor: "" }) as any;
      expect(legacy.history_supported).toBe(false);
      await expect(transport.dispatch("alice", "list_recent_sessions", { device: "not-owned", cursor: "" })).rejects.toThrow(/不在线或不属于你/);
    } finally { wsA.close(); wsB.close(); }
  });

  it("merges a multi-device history page in one stable order and refuses it when a device fails", async () => {
    store.saveRunnerToken(hashRunnerToken("rt_walk_a"), "alice", "walk-a", NOW);
    store.saveRunnerToken(hashRunnerToken("rt_walk_b"), "alice", "walk-b", NOW);
    let bFails = false;
    const page = (ids: string[]) => (args: Record<string, unknown>) => {
      const after = ids.filter((id) => JSON.stringify(["codex", id]) > String(args.cursor)).sort();
      return { total_found: ids.length, has_more: after.length > Number(args.limit), sessions: after.slice(0, Number(args.limit))
        .map((id) => ({ id, source: "codex", last_activity: "2026" })) };
    };
    const wsA = await fakeRunnerWithDevice("rt_walk_a", "walk-a", { list_recent_sessions: page(["a1", "c1", "e1"]) });
    const wsB = await fakeRunnerWithDevice("rt_walk_b", "walk-b", { list_recent_sessions: (args) => {
      if (bFails) throw new Error("disk busy");
      return page(["b1", "d1"])(args);
    } });
    try {
      const out = await transport.dispatch("alice", "list_recent_sessions", { cursor: JSON.stringify(["", ""]), limit: 3 }) as any;
      expect(out.sessions.map((row: any) => `${row.device}/${row.id}`)).toEqual(["walk-a/a1", "walk-b/b1", "walk-a/c1"]);
      expect(out.has_more).toBe(true);
      bFails = true;
      await expect(transport.dispatch("alice", "list_recent_sessions", { cursor: JSON.stringify(["codex", "c1"]), limit: 3 }))
        .rejects.toThrow(/walk-b 读取失败，未推进会话翻页位置/);
      // The recent page (no cursor) still degrades to the devices that answered.
      await expect(transport.dispatch("alice", "list_recent_sessions", { limit: 3 })).resolves.toMatchObject({ devices: ["walk-a"] });
    } finally { wsA.close(); wsB.close(); }
  });

  it("skips explicit roster opt-outs only for recent fanout and retains their execution inventory", async () => {
    store.saveRunnerToken(hashRunnerToken("rt_roster_source"), "alice", "source", NOW);
    store.saveRunnerToken(hashRunnerToken("rt_roster_exec"), "alice", "execution", NOW);
    let executionCalls = 0;
    const source = await fakeRunnerWithDevice("rt_roster_source", "source", {
      list_recent_sessions: () => ({ total_found: 1, sessions: [{ id: "readable", source: "codex" }] }),
    });
    const execution = await fakeRunnerWithDevice("rt_roster_exec", "execution", {
      list_recent_sessions: () => { executionCalls++; return { total_found: 0, sessions: [], has_more: false }; },
    });
    const inventory = {
      schema: "runner-inventory/v1", session_roster: false,
      agent_backends: ["claude", "codex", "omp"].map((kind) => ({ kind, available: false, split_execution: false })),
      execution: { platform: "linux", arch: "x64", shell: true, workspace_files: true, workspace_count: 1, codex_exec_server: false },
    };
    const announce = async () => {
      const changed = new Promise<void>((resolve) => {
        const detach = transport.subscribeSessionChanges?.((_owner, device) => {
          if (device === "execution") { detach?.(); resolve(); }
        });
      });
      execution.send(JSON.stringify({ type: "inventory_changed", inventory }));
      await changed;
    };
    try {
      await announce();
      expect(await transport.dispatch("alice", "list_recent_sessions", {})).toMatchObject({
        devices: ["source", "execution"], total_found: 1, sessions: [{ id: "readable", device: "source" }],
        runner_inventory: [{ device: "execution", inventory: { session_roster: false } }],
      });
      expect(executionCalls).toBe(0);
      await transport.dispatch("alice", "list_recent_sessions", { device: "execution", cursor: "" });
      expect(executionCalls).toBe(1);
      await expect(transport.dispatch("alice", "list_recent_sessions", { device: "not-owned" })).rejects.toThrow(/不在线或不属于你/);
      delete (inventory as { session_roster?: boolean }).session_roster;
      await announce();
      await transport.dispatch("alice", "list_recent_sessions", {});
      expect(executionCalls).toBe(2);
    } finally { source.close(); execution.close(); }
  });

  it("merges twelve mixed devices while only uncached sources receive roster RPCs", async () => {
    const cache = new RunnerSessionProjectionService(":memory:", gateway.claimSessionProjectionTransport());
    const sockets: WebSocket[] = [];
    const calls = new Array<number>(12).fill(0);
    const changed = (device: string) => new Promise<void>((resolve) => {
      const detach = transport.subscribeSessionChanges?.((_owner, current) => {
        if (current === device) { detach?.(); resolve(); }
      });
    });
    try {
      for (let index = 0; index < 12; index++) {
        const device = "mixed-" + index;
        const token = "rt_mixed_" + index;
        store.saveRunnerToken(hashRunnerToken(token), "alice", device, NOW);
        const ws = await fakeRunnerWithDevice(token, device, { list_recent_sessions: () => {
          calls[index] = (calls[index] ?? 0) + 1;
          // Old execution-only/proxy builds may lack the inventory marker.
          if (index === 8 || index === 9) throw new Error("legacy session method unavailable");
          return { total_found: index === 7 ? 0 : 1, primary_window: true, has_more: false,
            sessions: index === 7 ? [] : [{ id: "session-" + index, source: "codex" }] };
        } });
        sockets.push(ws);
        const inventoryChanged = changed(device);
        ws.send(JSON.stringify({ type: "inventory_changed", inventory: {
          schema: "runner-inventory/v1",
          ...(index < 6 ? { session_roster: true } : index >= 10 ? { session_roster: false } : {}),
          agent_backends: ["claude", "codex", "omp"].map((kind) => ({ kind, available: false, split_execution: false })),
          execution: { platform: "linux", arch: "x64", shell: true, workspace_files: true, workspace_count: 1, codex_exec_server: false },
        } }));
        await inventoryChanged;
        if (index < 6) {
          const projected = changed(device);
          ws.send(JSON.stringify({ type: "session_projection", projection: {
            schema: "runner-session-projection/v1", kind: "roster_full", epoch: "epoch-" + device,
            sequence: 1, observed_at: NOW, primary_window: true, total_found: 1,
            sessions: [{ id: "session-" + index, source: "codex" }],
          } }));
          await projected;
        }
      }
      const binding = { owner: "alice", transport, projectionReadCache: cache };
      expect(cache.read("alice", "list_recent_sessions", {}).hit).toBe(false);
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await dispatchToRunner(binding, "list_recent_sessions", { limit: 200 }) as {
          total_found: number; sessions: Array<{ id: string; device: string }>;
          runner_inventory: Array<{ device: string }>;
        };
        expect(result.total_found).toBe(7);
        expect(result.sessions.map((row) => row.id).sort()).toEqual(
          Array.from({ length: 7 }, (_, index) => "session-" + index));
        expect(result.sessions.every((row) => row.device === row.id.replace("session-", "mixed-"))).toBe(true);
        expect(result.runner_inventory.map((row) => row.device)).toContain("mixed-10");
      }
      expect(calls).toEqual([0, 0, 0, 0, 0, 0, 2, 2, 2, 2, 0, 0]);

      const invalidated = changed("mixed-0");
      sockets[0]!.send(JSON.stringify({ type: "sessions_changed" }));
      await invalidated;
      await dispatchToRunner(binding, "list_recent_sessions", { limit: 200 });
      expect(calls).toEqual([1, 0, 0, 0, 0, 0, 3, 3, 3, 3, 0, 0]);
      // Paging stays on the authoritative RPC path, including a cached device.
      await dispatchToRunner(binding, "list_recent_sessions", { device: "mixed-1", cursor: "", limit: 200 });
      expect(calls[1]).toBe(1);
      // So does an exact selector: its chats are, by definition, outside the cached windows.
      const beforeIds = [...calls];
      await dispatchToRunner(binding, "list_recent_sessions", { ids: "codex:session-1", limit: 1 });
      expect(calls.slice(0, 6)).toEqual(beforeIds.slice(0, 6).map((count) => count + 1));
      await dispatchToRunner(binding, "list_recent_sessions", { device: "mixed-2", ids: "codex:session-2", limit: 1 });
      expect(calls[2]).toBe(beforeIds[2]! + 2);
      expect(cache.readRosterDevice("bob", "mixed-1", {}).hit).toBe(false);
      cache.purgeDevice("alice", "mixed-2");
      expect(cache.readRosterDevice("alice", "mixed-2", {}).hit).toBe(false);
      gateway.disconnectDevice("alice", "mixed-3");
      await vi.waitFor(() => expect(gateway.listDevices("alice").find((row) => row.device === "mixed-3")?.online).toBe(false));
      expect(cache.readRosterDevice("alice", "mixed-3", {}).hit).toBe(false);
    } finally {
      cache.close();
      for (const ws of sockets) ws.close();
    }
  });

  it("merges list results across two devices and tags each session", async () => {
    store.saveRunnerToken(hashRunnerToken("rt_d1"), "alice", "laptop-a", NOW);
    store.saveRunnerToken(hashRunnerToken("rt_d2"), "alice", "laptop-b", NOW);
    const mkList = (id: string, ts: string) => ({
      total_found: 1,
      sessions: [{ id, last_activity: ts }],
    });
    const wsA = await fakeRunnerWithDevice("rt_d1", "laptop-a", { list_recent_sessions: () => mkList("a-1", "2026-07-15T09:00:00Z") });
    const wsB = await fakeRunnerWithDevice("rt_d2", "laptop-b", { list_recent_sessions: () => mkList("b-1", "2026-07-15T10:00:00Z") });

    const merged = (await transport.dispatch("alice", "list_recent_sessions", {})) as {
      total_found: number;
      sessions: Array<{ id: string; device: string }>;
    };
    expect(merged.total_found).toBe(2);
    expect(merged.sessions.map((s) => s.id)).toEqual(["b-1", "a-1"]); // most recent first
    expect(merged.sessions[0].device).toBe("laptop-b");
    wsA.close();
    wsB.close();
  });

  it("pages a multi-device search with one cursor and never skips a slower device's range", async () => {
    store.saveRunnerToken(hashRunnerToken("rt_d1"), "alice", "laptop-a", NOW);
    store.saveRunnerToken(hashRunnerToken("rt_d2"), "alice", "laptop-b", NOW);
    store.saveRunnerToken(hashRunnerToken("rt_d3"), "alice", "laptop-old", NOW);
    const at = (mtimeMs: number, key: string) => JSON.stringify([mtimeMs, key]);
    const hit = (mtimeMs: number, key: string) => ({ session: { id: key }, matches: [], cursor: at(mtimeMs, key) });
    const seen: Array<{ device: string; cursor: unknown }> = [];
    // laptop-a finished its whole history; laptop-b ran out of budget at 600.
    const wsA = await fakeRunnerWithDevice("rt_d1", "laptop-a", { search_sessions: (args) => {
      seen.push({ device: "laptop-a", cursor: args.cursor });
      return args.cursor ? { results: [hit(100, "a-old")], complete: true, scanned: 1, total_candidates: 3 }
        : { results: [hit(900, "a-new"), hit(100, "a-old")], complete: true, scanned: 3, total_candidates: 3 };
    } });
    const wsB = await fakeRunnerWithDevice("rt_d2", "laptop-b", { search_sessions: (args) => {
      seen.push({ device: "laptop-b", cursor: args.cursor });
      return args.cursor ? { results: [hit(300, "b-old")], complete: true, scanned: 2, total_candidates: 4 }
        : { results: [hit(800, "b-new")], complete: false, next_cursor: at(600, "b-mid"), scanned: 2, total_candidates: 4 };
    } });
    // A Runner bundle that predates paging: no positions, no `complete`.
    const wsOld = await fakeRunnerWithDevice("rt_d3", "laptop-old", { search_sessions: () => ({
      results: [{ session: { id: "old-hit" }, matches: [] }], scanned: 100, total_candidates: 250,
    }) });
    type Page = { results: Array<{ session: { id: string; device: string } }>; next_cursor?: string; complete: boolean; incomplete_sources?: string[] };
    const first = await transport.dispatch("alice", "search_sessions", { query: "x" }) as Page;
    expect(first.results.map((item) => `${item.session.device}:${item.session.id}`))
      .toEqual(["laptop-a:a-new", "laptop-b:b-new", "laptop-old:old-hit"]);
    expect(first).toMatchObject({ complete: false, next_cursor: at(600, "b-mid"), incomplete_sources: ["laptop-old"] });
    const second = await transport.dispatch("alice", "search_sessions", { query: "x", cursor: first.next_cursor }) as Page;
    expect(second.results.map((item) => item.session.id)).toEqual(["b-old", "a-old"]);
    expect(second.complete).toBe(true);
    expect(second.next_cursor).toBeUndefined();
    // Every device received the same device-independent cursor.
    expect(seen.filter((call) => call.cursor !== undefined).map((call) => call.cursor))
      .toEqual([first.next_cursor, first.next_cursor]);
    wsA.close();
    wsB.close();
    wsOld.close();
  });

  it("gives only a cold session roster the longer bounded read budget", async () => {
    await gateway.stop();
    gateway = new RunnerGateway(store, {
      port: 0,
      rpcTimeoutMs: 20,
      sessionListTimeoutMs: 100,
    });
    await gateway.start();
    transport = gateway.claimTransport();
    const token = "rt_cold_roster";
    store.saveRunnerToken(hashRunnerToken(token), "alice", "test", NOW);
    const delayed = async (result: unknown) => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return result;
    };
    const ws = await fakeRunner(token, {
      list_recent_sessions: () => delayed({ total_found: 0, sessions: [] }),
      search_sessions: () => delayed({ scanned: 0, total_candidates: 0, results: [] }),
    });
    try {
      await expect(transport.dispatch("alice", "list_recent_sessions", { limit: 200 })).resolves.toMatchObject({
        returned: 0,
      });
      await expect(transport.dispatch("alice", "search_sessions", { query: "x" }))
        .rejects.toThrow(/响应超时/);
    } finally {
      ws.close();
    }
  });

  it("copy falls through to the device that has the session", async () => {
    store.saveRunnerToken(hashRunnerToken("rt_d1"), "alice", "laptop-a", NOW);
    store.saveRunnerToken(hashRunnerToken("rt_d2"), "alice", "laptop-b", NOW);
    const wsA = await fakeRunnerWithDevice("rt_d1", "laptop-a", {
      copy_session: () => {
        throw new Error("session not found for id: s-1");
      },
    });
    const wsB = await fakeRunnerWithDevice("rt_d2", "laptop-b", {
      copy_session: (args) => ({ id: args.id, rel_path: ".claude/projects/p/s-1.jsonl", content: "{}", source: "claude", size: 2 }),
    });
    const exp = (await transport.dispatch("alice", "copy_session", { id: "s-1" })) as { rel_path: string };
    expect(exp.rel_path).toBe(".claude/projects/p/s-1.jsonl");
    wsA.close();
    wsB.close();
  });

  it("errors clearly when the user has no online runner", async () => {
    await expect(transport.dispatch("alice", "read_session", {})).rejects.toThrow(/没有在线的 Runner/);
  });

  it("marks a sent RPC timeout with a structured runner_timeout code", async () => {
    await gateway.stop();
    gateway = new RunnerGateway(store, { port: 0, machineTimeoutMs: 30 });
    await gateway.start();
    transport = gateway.claimTransport();
    const token = "rt_timeout";
    store.saveRunnerToken(hashRunnerToken(token), "alice", "test", NOW);
    const ws = await fakeRunner(token, { start_session: async () => await new Promise(() => {}) });
    try {
      await expect(transport.dispatch("alice", "start_session", { device: "test" }))
        .rejects.toMatchObject({ code: "runner_timeout" });
    } finally {
      ws.close();
    }
  });

  it("marks a connection lost after dispatch with a structured runner_gone code", async () => {
    const token = "rt_gone";
    store.saveRunnerToken(hashRunnerToken(token), "alice", "test", NOW);
    const ws = await fakeRunner(token, { read_session: async () => await new Promise(() => {}) });
    const pending = transport.dispatch("alice", "read_session", { id: "s-9" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    ws.close();
    await expect(pending).rejects.toMatchObject({ code: "runner_gone" });
  });

  it("a WebSocket ping measures presence without any user data crossing", async () => {
    store.saveRunnerToken(hashRunnerToken("rt_ping"), "alice", "test", NOW);
    const ws = await fakeRunner("rt_ping", {});
    const rtt = await transport.ping("alice", "test");
    expect(typeof rtt).toBe("number");
    // The device answered a protocol pong; no rpc frame was sent at all.
    expect(await transport.ping("alice", "nosuch")).toBeNull();
    ws.close();
  });

  it("keepalive sweep pings live connections and keeps them online", async () => {
    const token = "rt_alive";
    store.saveRunnerToken(hashRunnerToken(token), "alice", "test", NOW);
    const ws = await fakeRunner(token, {});
    // First sweep marks not-alive and pings; the client's automatic protocol
    // pong restores isAlive before the next sweep.
    gateway.sweepConnections();
    await new Promise((r) => setTimeout(r, 150));
    gateway.sweepConnections();
    await new Promise((r) => setTimeout(r, 150));
    expect(gateway.isOnline("alice")).toBe(true);
    ws.close();
  });

  it("keepalive sweep terminates a connection silent for longer than the dead-after budget", async () => {
    await gateway.stop();
    gateway = new RunnerGateway(store, { port: 0, keepaliveDeadAfterMs: 80 });
    await gateway.start();
    transport = gateway.claimTransport();
    const token = "rt_zombie";
    store.saveRunnerToken(hashRunnerToken(token), "alice", "test", NOW);
    const ws = await fakeRunner(token, {});
    // Simulate a middlebox-killed link: the peer answers no pings. pause()
    // stops the socket from reading, so the protocol pong never happens.
    ws.pause();
    const closed = new Promise<void>((resolve) => ws.on("close", () => resolve()));
    gateway.sweepConnections(); // inside the budget: pings, keeps
    expect(gateway.isOnline("alice")).toBe(true);
    await new Promise((r) => setTimeout(r, 120));
    gateway.sweepConnections(); // silent past the budget → terminate
    ws.resume();
    await closed;
    await vi.waitFor(() => expect(gateway.isOnline("alice")).toBe(false), { timeout: 1_000 });
  });

  it("a single missed pong does not kill a connection (three sweeps inside the budget)", async () => {
    const token = "rt_jitter";
    store.saveRunnerToken(hashRunnerToken(token), "alice", "test", NOW);
    const ws = await fakeRunner(token, {});
    ws.pause();
    gateway.sweepConnections();
    gateway.sweepConnections();
    gateway.sweepConnections();
    expect(gateway.isOnline("alice")).toBe(true);
    ws.resume();
    await new Promise((r) => setTimeout(r, 50));
    expect(gateway.isOnline("alice")).toBe(true);
    ws.close();
  });

  it("a sweep that ran late (event loop stall) pings but judges nobody", async () => {
    await gateway.stop();
    gateway = new RunnerGateway(store, { port: 0, keepaliveDeadAfterMs: 10 });
    await gateway.start();
    transport = gateway.claimTransport();
    const token = "rt_stall";
    store.saveRunnerToken(hashRunnerToken(token), "alice", "test", NOW);
    const ws = await fakeRunner(token, {});
    ws.pause();
    gateway.sweepConnections();
    // Pretend the loop was blocked: the next sweep observes a huge gap.
    (gateway as unknown as { lastSweepAt: number }).lastSweepAt = Date.now() - 60_000;
    await new Promise((r) => setTimeout(r, 30));
    gateway.sweepConnections();
    expect(gateway.isOnline("alice")).toBe(true);
    ws.resume();
    ws.close();
  });
  it("relays only verifier-bound Codex execution RPCs between the selected devices", async () => {
    const runtimeToken = "rt_runtime";
    const executionToken = "rt_execution";
    store.saveRunnerToken(hashRunnerToken(runtimeToken), "alice", "runtime", NOW);
    store.saveRunnerToken(hashRunnerToken(executionToken), "alice", "execution", NOW);
    const executionCalls: Array<Record<string, unknown>> = [];
    const runtime = await fakeRunner(runtimeToken, {}, "runtime");
    const execution = await fakeRunner(executionToken, {
      codex_exec_open: (args) => {
        executionCalls.push(args);
        return { tunnel_id: "tunnel-1" };
      },
      codex_exec_reconnect: (args) => ({ tunnel_id: args.tunnel_id, generation: 2 }),
    }, "execution");
    const detach = gateway.installExecutionRelayVerifier({
      authorize: (request) => (
        request.owner === "alice"
        && request.runtimeDevice === "runtime"
        && request.executionDevice === "execution"
        && request.workspaceId === "ws_0123456789abcdef01234567"
        && request.token === "relay-secret"
        && ["codex_exec_open", "codex_exec_reconnect"].includes(request.method)
      ),
    });

    await expect(peerRpc(runtime, {
      target: "execution",
      workspaceId: "ws_0123456789abcdef01234567",
      executionToken: "wrong",
      method: "codex_exec_open",
      args: { workspace_id: "ws_0123456789abcdef01234567" },
    })).resolves.toMatchObject({
      ok: false,
      error: "execution relay credential is invalid, expired, or outside this placement",
    });
    expect(executionCalls).toHaveLength(0);

    await expect(peerRpc(runtime, {
      target: "execution",
      workspaceId: "ws_0123456789abcdef01234567",
      executionToken: "relay-secret",
      method: "codex_exec_open",
      args: { workspace_id: "ws_must_not_escape_placement" },
    })).resolves.toMatchObject({ ok: true, result: { tunnel_id: "tunnel-1" } });
    expect(executionCalls).toEqual([{ workspace_id: "ws_0123456789abcdef01234567" }]);

    await expect(peerRpc(runtime, {
      target: "execution",
      workspaceId: "ws_0123456789abcdef01234567",
      executionToken: "relay-secret",
      method: "codex_exec_reconnect",
      args: { tunnel_id: "tunnel-1" },
    })).resolves.toMatchObject({ ok: true, result: { tunnel_id: "tunnel-1", generation: 2 } });

    await expect(peerRpc(runtime, {
      target: "execution",
      workspaceId: "ws_0123456789abcdef01234567",
      executionToken: "relay-secret",
      method: "exec",
      args: {},
    })).resolves.toMatchObject({ ok: false, error: "invalid execution relay request" });

    detach();
    runtime.close();
    execution.close();
  });

  it("binds background account operations to the socket policy generation, ignoring caller claims", async () => {
    store.saveRunnerToken(hashRunnerToken("rt_transfer_generation"), "alice", "runtime", NOW);
    store.setRunnerLocalAgentBridgeMode("alice", "runtime", "manual", NOW, "alice");
    const runtime = await fakeRunner("rt_transfer_generation", {}, "runtime");
    let active: () => boolean = () => false;
    let caller: unknown;
    gateway.installLocalAgentBridgeHandler({
      listTargets: async () => [],
      callAccount: async (input) => {
        active = input.isActive;
        caller = { subject: input.subject, mode: input.mode };
        return { ok: true, result: { transfer_id: "receipt" } };
      },
      open: async () => { throw new Error("not used"); },
      openGui: async () => { throw new Error("not used"); },
    });
    await expect(localBridge(runtime, { op: "account_call", tool: "octopus_copy_file",
      owner: "bob", mode: "full_access", args: {} })).resolves.toMatchObject({ ok: true });
    expect(caller).toEqual({ subject: { owner: "alice", device: "runtime" }, mode: "manual" });
    expect(active()).toBe(true);
    store.setRunnerLocalAgentBridgeMode("alice", "runtime", "full_access", NOW, "alice");
    gateway.revokeLocalAgentBridge("alice", "runtime");
    expect(active()).toBe(false);
    store.setRunnerLocalAgentBridgeMode("alice", "runtime", "manual", NOW, "alice");
    gateway.revokeLocalAgentBridge("alice", "runtime");
    expect(active()).toBe(false);
    runtime.close();
  });

  it("fences a pending open when Dashboard changes policy, even if the mode changes back", async () => {
    store.saveRunnerToken(hashRunnerToken("rt_fenced"), "alice", "runtime", NOW);
    store.setRunnerLocalAgentBridgeMode("alice", "runtime", "full_access", NOW, "alice");
    const runtime = await fakeRunner("rt_fenced", {}, "runtime");
    let finish!: () => void;
    const ready = new Promise<void>((resolve) => { finish = resolve; });
    const close = vi.fn();
    const open = vi.fn(async () => { await ready; return { close, call: vi.fn() }; });
    gateway.installLocalAgentBridgeHandler({ listTargets: async () => [], open,
      openGui: async () => { throw new Error("not used"); } });
    const opening = localBridge(runtime, { op: "open", device: "execution", workspace_id: "ws_test" });
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
    store.setRunnerLocalAgentBridgeMode("alice", "runtime", "disabled", NOW, "alice");
    gateway.revokeLocalAgentBridge("alice", "runtime");
    store.setRunnerLocalAgentBridgeMode("alice", "runtime", "full_access", NOW, "alice");
    finish();
    await expect(opening).resolves.toMatchObject({ ok: false, error_code: "policy_changed" });
    expect(close).toHaveBeenCalledOnce();
    runtime.close();
  });

  it("opens a lease on the device's Home when the selection names no workspace", async () => {
    store.saveRunnerToken(hashRunnerToken("rt_home_default"), "alice", "runtime", NOW);
    store.setRunnerLocalAgentBridgeMode("alice", "runtime", "full_access", NOW, "alice");
    const runtime = await fakeRunner("rt_home_default", {}, "runtime");
    const open = vi.fn(async () => ({ call: vi.fn(), close: vi.fn(), workspaceId: "ws_home" }));
    gateway.installLocalAgentBridgeHandler({ listTargets: async () => [], open,
      openGui: async () => { throw new Error("not used"); } });
    const opened = await localBridge(runtime, { op: "open", device: "execution" });
    expect(opened).toMatchObject({ ok: true, result: { device: "execution", workspace_id: "ws_home" } });
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ selection: { device: "execution" } }));
    await expect(localBridge(runtime, { op: "open", device: "runtime" }))
      .resolves.toMatchObject({ ok: false, error: "a different execution device is required" });
    runtime.close();
  });

  it("marks a retired execution scope before any command is dispatched", async () => {
    store.saveRunnerToken(hashRunnerToken("rt_retired"), "alice", "runtime", NOW);
    store.setRunnerLocalAgentBridgeMode("alice", "runtime", "full_access", NOW, "alice");
    const runtime = await fakeRunner("rt_retired", {}, "runtime");
    let active = true;
    const call = vi.fn();
    const close = vi.fn();
    gateway.installLocalAgentBridgeHandler({ listTargets: async () => [],
      open: async () => ({ isActive: () => active, call, close }),
      openGui: async () => { throw new Error("not used"); } });
    const opened = await localBridge(runtime, { op: "open", device: "execution", workspace_id: "ws_test" });
    const { lease_id } = opened.result as { lease_id: string };
    active = false;
    const command = { op: "call", lease_id, tool: "run_workspace_command", args: { command: "write-once" } };
    await expect(localBridge(runtime, command)).resolves.toMatchObject({ ok: false, error_code: "lease_expired" });
    await expect(localBridge(runtime, command)).resolves.toMatchObject({ ok: false, error_code: "lease_missing" });
    expect(call).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    runtime.close();
  });

  it("binds local MCP authority to authenticated device policy and live socket leases", async () => {
    const runtimeToken = "rt_local_runtime";
    store.saveRunnerToken(hashRunnerToken(runtimeToken), "alice", "runtime", NOW);
    store.saveRunnerToken(hashRunnerToken("rt_local_execution"), "alice", "execution", NOW);
    store.saveUser({ username: "bob", uid: 5002, home_dir: "/x/bob", created_at: NOW });
    const bobToken = "rt_local_bob_execution";
    store.saveRunnerToken(hashRunnerToken(bobToken), "bob", "execution", NOW);
    const runtime = await fakeRunner(runtimeToken, {}, "runtime");
    const bobRuntime = await fakeRunner(bobToken, {}, "execution");
    const closed: string[] = [];
    const opened: Array<Record<string, unknown>> = [];
    const guiOpened: Array<Record<string, unknown>> = [];
    const accountCalls: Array<Record<string, unknown>> = [];
    gateway.installLocalAgentBridgeHandler({
      listTargets: async (subject) => ({ subject, targets: ["execution"] }),
      listAccountTools: async (subject) => ({
        subject,
        tools: [{ name: "feishu_doc_read" }, { name: "send_session_message" }],
      }),
      callAccount: async (input) => {
        accountCalls.push(input);
        if (input.tool !== "feishu_doc_read" && input.tool !== "send_session_message") {
          return { ok: false, code: "unknown_tool", message: "outside account surface" };
        }
        return { ok: true, result: { owner: input.subject.owner, tool: input.tool } };
      },
      open: async (input) => {
        opened.push(input);
        return {
          call: async (tool, args) => ({ ok: true, result: { tool, args } }),
          close: () => closed.push(input.selection.device),
        };
      },
      openGui: async (input) => {
        guiOpened.push(input);
        return {
          description: {
            granted: true,
            expires_at: "2026-09-03T00:15:00.000Z",
            consent_ttl_seconds: 900,
          },
          call: async (tool, args) => ({ tool, args }),
          close: () => closed.push(`gui:${input.device}`),
        };
      },
    });

    await expect(localBridge(runtime, {
      op: "list_targets",
      owner: "bob",
      runtime_device: "forged",
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("not authorized"),
    });
    expect(store.setRunnerLocalAgentBridgeMode("alice", "runtime", "manual", NOW, "alice")).toBe(true);
    await expect(localBridge(runtime, {
      op: "list_targets",
      owner: "bob",
      runtime_device: "forged",
    })).resolves.toMatchObject({
      ok: true,
      result: { subject: { owner: "alice", device: "runtime" }, targets: ["execution"] },
    });
    await expect(localBridge(runtime, {
      op: "list_account_tools",
      owner: "bob",
    })).resolves.toMatchObject({
      ok: true,
      result: {
        subject: { owner: "alice", device: "runtime" },
        tools: [{ name: "feishu_doc_read" }, { name: "send_session_message" }],
      },
    });
    await expect(localBridge(runtime, {
      op: "account_call",
      owner: "bob",
      tool: "feishu_doc_read",
      args: { document_id: "d1", username: "bob" },
    })).resolves.toMatchObject({ ok: true, result: { result: { owner: "alice", tool: "feishu_doc_read" } } });
    expect(accountCalls).toEqual([expect.objectContaining({
      subject: { owner: "alice", device: "runtime" },
      tool: "feishu_doc_read",
    })]);
    await expect(localBridge(runtime, {
      op: "account_call",
      owner: "bob",
      tool: "send_session_message",
      args: { resource_id: "opaque", prompt: "status?" },
    })).resolves.toMatchObject({
      ok: true,
      result: { result: { owner: "alice", tool: "send_session_message" } },
    });
    await expect(localBridge(runtime, {
      op: "account_call",
      tool: "read_workspace_text",
      args: {},
    })).resolves.toMatchObject({
      ok: true,
      result: { ok: false, code: "unknown_tool", message: expect.stringContaining("outside") },
    });
    await expect(localBridge(runtime, {
      op: "account_call",
      tool: "INVALID",
      args: {},
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining("outside") });
    const open = await localBridge(runtime, {
      op: "open",
      device: "execution",
      workspace_id: "ws_0123456789abcdef01234567",
      owner: "bob",
      target_owner: "bob",
    });
    expect(open).toMatchObject({ ok: true, result: { mode: "manual", device: "execution" } });
    expect(opened).toEqual([expect.objectContaining({
      subject: { owner: "alice", device: "runtime" },
      selection: { device: "execution", workspaceId: "ws_0123456789abcdef01234567" },
      mode: "manual",
    })]);
    const leaseId = (open.result as { lease_id: string }).lease_id;
    await expect(localBridge(runtime, {
      op: "call",
      lease_id: leaseId,
      tool: "run_workspace_command",
      args: { command: "pwd" },
    })).resolves.toMatchObject({ ok: true, result: { ok: true } });

    const guiOpen = await localBridge(runtime, {
      op: "open_gui",
      device: "execution",
      owner: "bob",
    });
    expect(guiOpen).toMatchObject({
      ok: true,
      result: {
        device: "execution",
        granted: true,
        expires_at: "2026-09-03T00:15:00.000Z",
      },
    });
    expect(guiOpened).toEqual([{
      subject: { owner: "alice", device: "runtime" },
      device: "execution",
    }]);
    const guiLeaseId = (guiOpen.result as { lease_id: string }).lease_id;
    await expect(localBridge(runtime, {
      op: "call",
      lease_id: guiLeaseId,
      tool: "capture_screen",
      args: {},
    })).resolves.toMatchObject({ ok: true, result: { tool: "capture_screen" } });
    await expect(localBridge(runtime, {
      op: "call",
      lease_id: guiLeaseId,
      tool: "run_workspace_command",
      args: { command: "pwd" },
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining("outside") });

    expect(store.setRunnerLocalAgentBridgeMode("bob", "execution", "full_access", NOW, "bob")).toBe(true);
    await expect(localBridge(bobRuntime, {
      op: "call",
      lease_id: leaseId,
      tool: "run_workspace_command",
      args: { command: "pwd" },
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining("lease is missing") });
    expect(opened).toHaveLength(1);

    expect(store.setRunnerLocalAgentBridgeMode("alice", "runtime", "full_access", NOW, "alice")).toBe(true);
    await expect(localBridge(runtime, {
      op: "call",
      lease_id: leaseId,
      tool: "run_workspace_command",
      args: { command: "pwd" },
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining("policy changed") });
    await expect(localBridge(runtime, {
      op: "call",
      lease_id: guiLeaseId,
      tool: "capture_screen",
      args: {},
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining("policy changed") });
    expect(closed).toEqual(["execution", "gui:execution"]);
    runtime.close();
    bobRuntime.close();
  });

  it("never starves lease cleanup behind the ordinary bridge in-flight limit", async () => {
    const token = "rt_local_cleanup";
    store.saveRunnerToken(hashRunnerToken(token), "alice", "runtime", NOW);
    expect(store.setRunnerLocalAgentBridgeMode("alice", "runtime", "full_access", NOW, "alice")).toBe(true);
    const runtime = await fakeRunner(token, {}, "runtime");
    const releaseLists: Array<() => void> = [];
    const closeLease = vi.fn();
    gateway.installLocalAgentBridgeHandler({
      listTargets: async () => await new Promise((resolve) => {
        releaseLists.push(() => resolve({ targets: [] }));
      }),
      open: async () => ({ call: vi.fn(), close: closeLease }),
      openGui: async () => ({ call: vi.fn(), close: closeLease }),
    });
    const opened = await localBridge(runtime, {
      op: "open",
      device: "execution",
      workspace_id: "ws_0123456789abcdef01234567",
    });
    const leaseId = (opened.result as { lease_id: string }).lease_id;

    for (let index = 0; index < 8; index++) {
      runtime.send(JSON.stringify({
        type: "local_agent_bridge",
        id: `saturated-${index}`,
        op: "list_targets",
      }));
    }
    await vi.waitFor(() => expect(releaseLists).toHaveLength(8));
    await expect(localBridge(runtime, { op: "close", lease_id: leaseId })).resolves.toMatchObject({
      ok: true,
      result: { closed: true },
    });
    expect(closeLease).toHaveBeenCalledOnce();

    for (const release of releaseLists) release();
    runtime.close();
  });

  it("reserves independent workspace capacity and reports the leases occupying it", async () => {
    const token = "rt_local_capacity";
    store.saveRunnerToken(hashRunnerToken(token), "alice", "runtime", NOW);
    expect(store.setRunnerLocalAgentBridgeMode("alice", "runtime", "full_access", NOW, "alice")).toBe(true);
    const runtime = await fakeRunner(token, {}, "runtime");
    const closeLease = vi.fn();
    gateway.installLocalAgentBridgeHandler({
      listTargets: async () => ({ targets: [] }),
      open: async () => ({
        call: async (tool) => ({ ok: true, result: { tool } }),
        close: closeLease,
      }),
      openGui: async () => ({
        call: async (tool) => ({ ok: true, result: { tool } }),
        close: closeLease,
      }),
    });

    await expect(localBridge(runtime, {
      op: "open_gui",
      device: "target-mac",
      client_id: "gui-client",
      client_pid: 9000,
    })).resolves.toMatchObject({ ok: true });

    let firstLeaseId = "";
    for (let index = 0; index < 32; index++) {
      const opened = await localBridge(runtime, {
        op: "open",
        device: "execution",
        workspace_id: `ws_capacity_${index}`,
        client_id: `client-${index}`,
        client_pid: 10_000 + index,
      });
      expect(opened).toMatchObject({ ok: true });
      if (index === 0) firstLeaseId = (opened.result as { lease_id: string }).lease_id;
    }
    await expect(localBridge(runtime, {
      op: "call",
      lease_id: firstLeaseId,
      tool: "run_workspace_command",
      args: { command: "pwd" },
    })).resolves.toMatchObject({ ok: true });

    const refused = await localBridge(runtime, {
      op: "open",
      device: "execution",
      workspace_id: "ws_over_capacity",
      client_id: "waiting-client",
      client_pid: 20_000,
    });
    expect(refused.ok).toBe(false);
    expect(refused.error).toEqual(expect.stringContaining("workspace lease capacity reached (32/32; 33 total"));
    expect(refused.error).toEqual(expect.stringContaining("gui target=\"target-mac\""));
    expect(refused.error).toEqual(expect.stringContaining("workspace=\"ws_capacity_0\""));
    expect(refused.error).toEqual(expect.stringContaining("client=\"client-0\" reported_pid=10000"));
    expect(refused.error).toEqual(expect.stringContaining("last_tool=\"run_workspace_command\""));
    expect(refused.error).toEqual(expect.stringContaining("closing stale Codex/Claude/OMP clients"));
    expect(refused.error).toEqual(expect.stringContaining("Restarting a target execution Runner does not release"));

    runtime.close();
  });

  it("opens a one-time connection-scoped DSH byte stream to the selected Runner", async () => {
    const token = "rt_dsh_tunnel";
    store.saveRunnerToken(hashRunnerToken(token), "alice", "dsh-device", NOW);
    const control = new WebSocket(`ws://127.0.0.1:${gateway.port}`);
    const tunnelRef: { current: WebSocket | null } = { current: null };
    await new Promise<void>((resolve, reject) => {
      control.once("open", () => control.send(JSON.stringify({
        type: "register",
        token,
        inventory: {
          schema: "runner-inventory/v1",
          agent_backends: [
            { kind: "claude", available: true },
            { kind: "codex", available: true },
            { kind: "omp", available: true },
          ],
          execution: {
            platform: "linux",
            arch: "x64",
            shell: true,
            workspace_files: true,
            workspace_count: 1,
            codex_exec_server: true,
          },
          dsh: { available: true, port: 9931 },
        },
      })));
      control.on("message", (data) => {
        const message = JSON.parse(String(data)) as Record<string, unknown>;
        if (message.type === "registered") resolve();
        if (message.type !== "dsh_tunnel_open") return;
        const tunnel = new WebSocket(`ws://127.0.0.1:${gateway.port}`);
        tunnelRef.current = tunnel;
        tunnel.once("open", () => tunnel.send(JSON.stringify({
          type: "register",
          protocol: "dsh-tunnel/v1",
          tunnelId: message.tunnelId,
          secret: message.secret,
        })));
        tunnel.on("message", (payload, isBinary) => {
          if (isBinary) {
            const text = Buffer.from(payload as Buffer).toString("utf8");
            tunnel.send(text.startsWith("GET ")
              ? "HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: keep-alive\r\n\r\ndsh-http"
              : text.toUpperCase());
          }
        });
      });
      control.once("error", reject);
    });

    await expect(transport.openDshTunnel("alice", "dsh-device", 9932)).rejects.toThrow(/未提供已验证/);
    const stream = await transport.openDshTunnel("alice", "dsh-device", 9931);
    expect(Reflect.get(stream, "setTimeout")).toBeTypeOf("function");
    const response = new Promise<string>((resolve, reject) => {
      stream.once("data", (chunk) => resolve(Buffer.from(chunk).toString("utf8")));
      stream.once("error", reject);
    });
    stream.write("hello dsh");
    await expect(response).resolves.toBe("HELLO DSH");

    stream.destroy();
    const httpStream = await transport.openDshTunnel("alice", "dsh-device", 9931);
    const agent = new Agent({ keepAlive: true });
    agent.createConnection = (_options, callback) => {
      if (!callback) throw new Error("HTTP Agent omitted its connection callback");
      callback(null, httpStream as never);
      return undefined;
    };
    const httpBody = await new Promise<string>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: 9931, path: "/", agent }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => { body += chunk; });
        res.on("end", () => resolve(body));
      });
      req.setTimeout(1_000);
      req.once("error", reject);
      req.end();
    });
    expect(httpBody).toBe("dsh-http");
    agent.destroy();
    tunnelRef.current?.close();
    control.close();
  });
});

/** fakeRunner variant that reports a specific device name. */
async function fakeRunnerWithDevice(
  token: string,
  device: string,
  handlers: Record<string, (args: Record<string, unknown>) => unknown>,
): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${gateway.port}`);
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => ws.send(JSON.stringify({ type: "register", token, device })));
    ws.on("message", function onMsg(data) {
      const msg = JSON.parse(String(data)) as Record<string, unknown>;
      if (msg.type === "registered") {
        ws.off("message", onMsg);
        resolve();
      } else if (msg.type === "error") reject(new Error(String(msg.message)));
    });
    ws.on("error", reject);
  });
  ws.on("message", (data) => {
    const msg = JSON.parse(String(data)) as { type: string; id?: string; method?: string; args?: Record<string, unknown> };
    if (msg.type !== "rpc" || !msg.id || !msg.method) return;
    const h = handlers[msg.method];
    try {
      const result = h ? h(msg.args ?? {}) : undefined;
      if (!h) throw new Error("no handler");
      ws.send(JSON.stringify({ type: "rpc_result", id: msg.id, ok: true, result }));
    } catch (err) {
      ws.send(JSON.stringify({ type: "rpc_result", id: msg.id, ok: false, error: (err as Error).message }));
    }
  });
  return ws;
}

describe("runner link resilience (2026-08-22)", () => {
  /** Register and keep every frame the device receives after `registered`. */
  async function observingRunner(token: string, device = "test", extra: Record<string, unknown> = {}) {
    const ws = new WebSocket(`ws://127.0.0.1:${gateway.port}`);
    const frames: Array<Record<string, unknown>> = [];
    const registered = await new Promise<Record<string, unknown>>((resolve, reject) => {
      ws.on("open", () => ws.send(JSON.stringify({ type: "register", token, device, ...extra })));
      ws.on("message", function onMsg(data) {
        const msg = JSON.parse(String(data)) as Record<string, unknown>;
        if (msg.type === "registered") {
          ws.off("message", onMsg);
          resolve(msg);
        } else if (msg.type === "error") {
          reject(new Error(String(msg.message)));
        }
      });
      ws.on("error", reject);
    });
    ws.on("message", (data) => frames.push(JSON.parse(String(data)) as Record<string, unknown>));
    return { ws, frames, registered };
  }

  it("projects closed-by-default Agent injection policy and pushes owner changes to an online device", async () => {
    store.saveRunnerToken(hashRunnerToken("rt_policy"), "alice", "policy", NOW);
    expect(store.setRunnerDefaultAgentInjection(
      "alice",
      "policy",
      true,
      "2026-08-30T00:00:00.000Z",
      "alice",
    )).toBe(true);
    expect(store.setRunnerGuiAutomationEnabled(
      "alice",
      "policy",
      true,
      "2026-09-03T00:00:00.000Z",
      "alice",
    )).toBe(true);
    const { ws, frames, registered } = await observingRunner("rt_policy", "policy");
    expect(registered).toMatchObject({ default_agent_injection: true, gui_automation_enabled: true });
    expect(transport.setDefaultAgentInjection?.("alice", "policy", false)).toBe(true);
    await vi.waitFor(() => {
      expect(frames).toContainEqual({ type: "agent_integration_policy", default_injection: false });
    });
    expect(transport.setGuiAutomationEnabled?.("alice", "policy", false)).toBe(true);
    await vi.waitFor(() => {
      expect(frames).toContainEqual({ type: "gui_automation_policy", enabled: false });
    });
    expect(transport.setGuiAutomationEnabled?.("alice", "offline", true)).toBe(false);
    expect(transport.setDefaultAgentInjection?.("alice", "offline", true)).toBe(false);
    ws.close();
  });

  it("announces a restart to every device before closing its socket", async () => {
    store.saveRunnerToken(hashRunnerToken("rt_restart"), "alice", "test", NOW);
    const { ws, frames } = await observingRunner("rt_restart");
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() })));
    await gateway.stop();
    const close = await closed;
    expect(frames).toEqual([{ type: "restarting", retry_after_ms: 2000 }]);
    expect(close).toEqual({ code: 1012, reason: "gateway restarting" });
    // afterEach stops again; that must be harmless.
    await gateway.start();
  });

  it("renegotiates a late artifact activation after pending RPCs settle, without looping opt-out clients", async () => {
    await gateway.stop();
    const bundles = new RunnerBundleRegistry(join(dir, "runner-bundles"));
    const oldSha = bundles.activate(Buffer.from(`${runnerBundleProtocolBanner()}\n// old`), "test").activeSha!;
    gateway = new RunnerGateway(store, { port: 0, bundleSource: bundles });
    await gateway.start();
    transport = gateway.claimTransport();
    store.saveRunnerToken(hashRunnerToken("rt_late"), "alice", "late", NOW);
    store.saveRunnerToken(hashRunnerToken("rt_no_sha"), "alice", "no-sha", NOW);
    const old = await observingRunner("rt_late", "late", { bundle_sha: oldSha });
    const legacy = await observingRunner("rt_no_sha", "no-sha");
    const pending = transport.dispatch("alice", "read_session", { device: "late", id: "s-1" });
    await vi.waitFor(() => expect(old.frames.some((frame) => frame.type === "rpc")).toBe(true));
    const nextSha = bundles.activate(Buffer.from(`${runnerBundleProtocolBanner()}\n// next`), "test").activeSha!;
    gateway.sweepConnections();
    expect(old.ws.readyState).toBe(WebSocket.OPEN);
    expect(old.frames.some((frame) => frame.type === "restarting")).toBe(false);
    const rpc = old.frames.find((frame) => frame.type === "rpc")!;
    old.ws.send(JSON.stringify({ type: "rpc_result", id: rpc.id, ok: true, result: {} }));
    await pending;
    const closed = new Promise<number>((resolve) => old.ws.once("close", resolve));
    gateway.sweepConnections();
    expect(await closed).toBe(1012);
    expect(old.frames).toContainEqual({ type: "restarting", retry_after_ms: 2000 });
    const optedOut = await observingRunner("rt_late", "late", { bundle_sha: oldSha });
    expect(optedOut.registered).toMatchObject({ bundle_sha: nextSha, update_available: true });
    gateway.sweepConnections();
    // Deliver the ping/pong round before asserting that neither client closed.
    await new Promise<void>((resolve) => optedOut.ws.once("ping", () => resolve()));
    expect(optedOut.ws.readyState).toBe(WebSocket.OPEN);
    expect(optedOut.frames).toEqual([]);
    expect(legacy.ws.readyState).toBe(WebSocket.OPEN);
    optedOut.ws.close();
    legacy.ws.close();
  });

  it("retries an unacknowledged requested build without marking a transfer as installed", async () => {
    await gateway.stop();
    const bundles = new RunnerBundleRegistry(join(dir, "runner-bundles"));
    const target = bundles.activate(Buffer.from(`${runnerBundleProtocolBanner()}\n// retry`), "test").activeSha!;
    gateway = new RunnerGateway(store, { port: 0, bundleSource: bundles, bundleRetryAfterMs: 0 });
    await gateway.start();
    transport = gateway.claimTransport();
    store.saveRunnerToken(hashRunnerToken("rt_retry"), "alice", "retry", NOW);
    const client = await observingRunner("rt_retry", "retry", { bundle_sha: "0".repeat(64) });
    client.ws.send(JSON.stringify({ type: "bundle_request" }));
    await vi.waitFor(() => expect(client.frames.some((f) => f.type === "bundle")).toBe(true));
    expect(transport.listDevices("alice").find((d) => d.device === "retry")).toMatchObject({
      bundle_current: false, bundle_target_sha: target, bundle_update_status: "retry_pending",
    });
    const closed = new Promise<number>((resolve) => client.ws.once("close", resolve));
    gateway.sweepConnections();
    expect(await closed).toBe(1012);
    const current = await observingRunner("rt_retry", "retry", { bundle_sha: target });
    expect(transport.listDevices("alice").find((d) => d.device === "retry")).toMatchObject({
      bundle_current: true, bundle_update_status: "current",
    });
    current.ws.close();
  });

  it.each([false, true])("reports disabled or quarantined updates without repeated reconnects (blocked=%s)", async (blocked) => {
    await gateway.stop();
    const bundles = new RunnerBundleRegistry(join(dir, "runner-bundles"));
    const target = bundles.activate(Buffer.from(`${runnerBundleProtocolBanner()}\n// blocked`), "test").activeSha!;
    gateway = new RunnerGateway(store, { port: 0, bundleSource: bundles, bundleRetryAfterMs: 0 });
    await gateway.start();
    transport = gateway.claimTransport();
    store.saveRunnerToken(hashRunnerToken("rt_blocked"), "alice", "blocked", NOW);
    const client = await observingRunner("rt_blocked", "blocked", { bundle_sha: "0".repeat(64),
      self_update_enabled: blocked, ...(blocked ? { rejected_bundle_sha: target } : {}) });
    expect(transport.listDevices("alice").find((d) => d.device === "blocked")).toMatchObject({
      bundle_current: false, bundle_update_status: blocked ? "blocked" : "disabled",
    });
    gateway.sweepConnections();
    await new Promise<void>((resolve) => client.ws.once("ping", () => resolve()));
    expect(client.ws.readyState).toBe(WebSocket.OPEN);
    expect(client.frames).toEqual([]);
    client.ws.close();
  });

  it("serves its bundle to a device that reports a different build, once a minute", async () => {
    await gateway.stop();
    const bytes = Buffer.from(`${runnerBundleProtocolBanner()}\nconsole.log('runner v-next')`, "utf8");
    const bundles = new RunnerBundleRegistry(join(dir, "runner-bundles"));
    const activated = bundles.activate(bytes, "test");
    const sha = activated.activeSha!;
    gateway = new RunnerGateway(store, { port: 0, bundleSource: bundles });
    await gateway.start();
    transport = gateway.claimTransport();
    expect(gateway.servedBundleSha).toBe(sha);

    store.saveRunnerToken(hashRunnerToken("rt_old"), "alice", "old", NOW);
    const stale = "0".repeat(64);
    const { ws, frames, registered } = await observingRunner("rt_old", "old", { bundle_sha: stale });
    expect(registered).toMatchObject({ bundle_sha: sha, update_available: true });
    const listed = transport.listDevices("alice").find((d) => d.device === "old");
    expect(listed).toMatchObject({ online: true, bundle_sha: stale, bundle_current: false });

    ws.send(JSON.stringify({ type: "bundle_request" }));
    await new Promise((r) => setTimeout(r, 100));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: "bundle", ok: true, sha, size: bytes.length });
    expect(Buffer.from(String(frames[0].data), "base64").equals(bytes)).toBe(true);

    ws.send(JSON.stringify({ type: "bundle_request" }));
    await new Promise((r) => setTimeout(r, 100));
    expect(frames[1]).toMatchObject({ type: "bundle", ok: false });
    ws.close();
  });

  it("tells a current build there is nothing to update and says nothing to builds that report no sha", async () => {
    await gateway.stop();
    const bundles = new RunnerBundleRegistry(join(dir, "runner-bundles"));
    const bytes = Buffer.from(`${runnerBundleProtocolBanner()}\nx`, "utf8");
    const sha = bundles.activate(bytes, "test").activeSha!;
    gateway = new RunnerGateway(store, { port: 0, bundleSource: bundles });
    await gateway.start();
    transport = gateway.claimTransport();
    store.saveRunnerToken(hashRunnerToken("rt_cur"), "alice", "cur", NOW);
    store.saveRunnerToken(hashRunnerToken("rt_legacy"), "alice", "legacy", NOW);
    const current = await observingRunner("rt_cur", "cur", { bundle_sha: sha });
    expect(current.registered).toMatchObject({ bundle_sha: sha, update_available: false });
    const legacy = await observingRunner("rt_legacy", "legacy");
    expect(legacy.registered).toMatchObject({ bundle_sha: sha, update_available: false });
    const devices = transport.listDevices("alice");
    expect(devices.find((d) => d.device === "cur")).toMatchObject({ bundle_current: true });
    expect(devices.find((d) => d.device === "legacy")).not.toHaveProperty("bundle_sha");
    current.ws.close();
    legacy.ws.close();
    const nextBytes = Buffer.from(`${runnerBundleProtocolBanner()}\ny`, "utf8");
    const nextSha = bundles.activate(nextBytes, "test:next").activeSha!;
    expect(gateway.servedBundleSha).toBe(nextSha);
    store.saveRunnerToken(hashRunnerToken("rt_switched"), "alice", "switched", NOW);
    const switched = await observingRunner("rt_switched", "switched", { bundle_sha: sha });
    expect(switched.registered).toMatchObject({ bundle_sha: nextSha, update_available: true });
    switched.ws.close();
  });

  it("offers no bundle when this deployment has none", async () => {
    store.saveRunnerToken(hashRunnerToken("rt_nobundle"), "alice", "test", NOW);
    const { ws, frames, registered } = await observingRunner("rt_nobundle", "test", { bundle_sha: "1".repeat(64) });
    expect(registered).not.toHaveProperty("bundle_sha");
    ws.send(JSON.stringify({ type: "bundle_request" }));
    await new Promise((r) => setTimeout(r, 100));
    expect(frames[0]).toMatchObject({ type: "bundle", ok: false });
    ws.close();
  });
});

describe("device presence and offline refusals (2026-08-22)", () => {
  it("wakes an account's peers without exposing another account's presence or authorizing input", async () => {
    store.saveUser({ username: "bob", uid: 5002, home_dir: "/x/bob", created_at: NOW });
    for (const [owner, device] of [["alice", "model"], ["alice", "execution"], ["bob", "model"]]) {
      store.saveRunnerToken(hashRunnerToken(`rt_${owner}_${device}`), owner!, device!, NOW);
    }
    const model = await fakeRunner("rt_alice_model", {}, "model");
    const outsider = await fakeRunner("rt_bob_model", {}, "model");
    const messages: unknown[] = [], foreign: unknown[] = [];
    model.on("message", data => messages.push(JSON.parse(String(data))));
    outsider.on("message", data => foreign.push(JSON.parse(String(data))));
    const execution = await fakeRunner("rt_alice_execution", {}, "execution");
    await vi.waitFor(() => expect(messages).toContainEqual({ type: "managed_recovery_wake" }));
    expect(foreign).toEqual([]);
    expect(messages).toEqual([{ type: "managed_recovery_wake" }]);
    model.close(); outsider.close(); execution.close();
  });

  it("announces register and drop to presence listeners, once each", async () => {
    const seen: Array<[string, string, boolean]> = [];
    const off = gateway.subscribePresence((owner, device, online) => seen.push([owner, device, online]));
    store.saveRunnerToken(hashRunnerToken("rt_presence"), "alice", "box", NOW);
    const ws = await fakeRunner("rt_presence", {}, "box");
    expect(seen).toEqual([["alice", "box", true]]);
    // A reconnect replaces the old socket; the device never went offline.
    const ws2 = await fakeRunner("rt_presence", {}, "box");
    await new Promise((r) => setTimeout(r, 100));
    expect(seen).toEqual([["alice", "box", true], ["alice", "box", true]]);
    ws2.close();
    await vi.waitFor(() => expect(gateway.isOnline("alice")).toBe(false), { timeout: 1_000 });
    expect(seen).toEqual([["alice", "box", true], ["alice", "box", true], ["alice", "box", false]]);
    off();
    ws.close();
  });

  it("reports each registration with the device's previous proof of life", async () => {
    const seen: Array<string | null | undefined> = [];
    const off = gateway.subscribePresence((_owner, _device, online, previousSeenAt) => {
      if (online) seen.push(previousSeenAt);
    });
    store.saveRunnerToken(hashRunnerToken("rt_seen"), "alice", "seen-box", NOW);
    const first = await fakeRunner("rt_seen", {}, "seen-box");
    expect(seen).toEqual([null]);
    first.close();
    await vi.waitFor(() => expect(gateway.isOnline("alice")).toBe(false), { timeout: 1_000 });
    const lastSeen = store.getRunnerTokenByHash(hashRunnerToken("rt_seen"))!.last_seen_at;
    expect(lastSeen).toEqual(expect.any(String));
    const second = await fakeRunner("rt_seen", {}, "seen-box");
    // The value read before this registration touched the row, not "now".
    expect(seen).toEqual([null, lastSeen]);
    off();
    second.close();
  });

  it("names an offline device with the runner_offline code, distinct from a lost link", async () => {
    store.saveRunnerToken(hashRunnerToken("rt_off"), "alice", "online-one", NOW);
    const ws = await fakeRunner("rt_off", {}, "online-one");
    const err = await transport.dispatch("alice", "exec", { device: "absent", command: "true" }).then(() => null, (e: unknown) => e);
    expect(err).toMatchObject({ code: "runner_offline" });
    expect(String((err as Error).message)).toContain("absent");
    ws.close();
    await vi.waitFor(() => expect(gateway.isOnline("alice")).toBe(false), { timeout: 1_000 });
    const none = await transport.dispatch("alice", "exec", { device: "absent", command: "true" }).then(() => null, (e: unknown) => e);
    expect(none).toMatchObject({ code: "runner_offline" });
  });
});
