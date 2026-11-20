import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import {
  accountToolResult,
  LocalBridgeClient,
  LocalBridgeError,
  callRemoteTool,
  callGuiTool,
  LOCAL_AGENT_MCP_INSTRUCTIONS,
  LOCAL_AGENT_MCP_TOOLS,
  localAgentMcpDiscovery,
  localAgentMcpTools,
  RunnerLocalAgentBridgeRuntime,
  runLocalAgentMcpStdio,
} from "./local-agent-bridge.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("RunnerLocalAgentBridgeRuntime", () => {
  it("keeps Octopus optional when the user explicitly chooses SSH or another transport", () => {
    expect(LOCAL_AGENT_MCP_INSTRUCTIONS).toContain("never override the user's explicit transport choice");
    expect(LOCAL_AGENT_MCP_INSTRUCTIONS).toContain("If the user asks for SSH");
    expect(LOCAL_AGENT_MCP_INSTRUCTIONS).toContain("offer Octopus only as an alternative");
    expect(LOCAL_AGENT_MCP_INSTRUCTIONS).toContain("octopus_list_execution_targets first");
    expect(LOCAL_AGENT_MCP_INSTRUCTIONS).toContain("approval-required");
    expect(LOCAL_AGENT_MCP_INSTRUCTIONS).toContain("native subagent roster or messaging");
    expect(LOCAL_AGENT_MCP_INSTRUCTIONS).toContain("input_mode=parent_owned");
    expect(LOCAL_AGENT_MCP_INSTRUCTIONS).toContain("GUI discovery is not consent");
    expect(LOCAL_AGENT_MCP_INSTRUCTIONS).toContain("octopus_request_gui_control");
    expect(LOCAL_AGENT_MCP_INSTRUCTIONS).toContain("15-minute consent dialog");
    expect(LOCAL_AGENT_MCP_INSTRUCTIONS).toContain("persistent desktop indicator");
    expect(LOCAL_AGENT_MCP_INSTRUCTIONS).toContain("lease capacity");
    expect(LOCAL_AGENT_MCP_INSTRUCTIONS).toContain("Restarting the target execution Runner does not release");
    expect(LOCAL_AGENT_MCP_TOOLS.map(({ name }) => name)).toEqual(expect.arrayContaining([
      "octopus_request_gui_control",
      "octopus_capture_screen",
      "octopus_gui_click",
      "octopus_gui_scroll",
      "octopus_gui_drag",
      "octopus_gui_type_text",
      "octopus_gui_key_press",
      "octopus_release_gui_control",
    ]));
  });

  it("publishes an explicit Codex/Claude/OMP discovery descriptor without changing default injection", () => {
    expect(localAgentMcpDiscovery("/home/alice/.local/bin/octopus-runner-mcp")).toMatchObject({
      name: "octopus",
      transport: "stdio",
      command: "/home/alice/.local/bin/octopus-runner-mcp",
      args: [],
      clients: ["codex", "claude", "omp"],
      default_injection: expect.stringContaining("does not change"),
    });
  });

  it("serves a mode-0600 Unix socket and forwards no device credential", async () => {
    const root = mkdtempSync(join(tmpdir(), "runner-local-mcp-"));
    roots.push(root);
    const socketPath = join(root, "private", "bridge.sock");
    const runtime = new RunnerLocalAgentBridgeRuntime(socketPath);
    await runtime.start();
    expect(statSync(join(root, "private")).mode & 0o777).toBe(0o700);
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);

    let forwarded: Record<string, unknown> | null = null;
    const gateway = {
      readyState: WebSocket.OPEN,
      send(text: string, callback: (error?: Error) => void) {
        forwarded = JSON.parse(text) as Record<string, unknown>;
        callback();
      },
    } as unknown as WebSocket;
    runtime.attach(gateway);

    const client = net.createConnection(socketPath);
    client.setEncoding("utf8");
    const reply = new Promise<Record<string, unknown>>((resolve) => {
      client.once("data", (line: string) => resolve(JSON.parse(line) as Record<string, unknown>));
    });
    client.write(`${JSON.stringify({
      id: "client-1",
      op: "list_targets",
      type: "runner_result",
      token: "rt_must_not_escape",
      client_pid: 4321,
    })}\n`);
    await vi.waitFor(() => expect(forwarded).not.toBeNull());
    expect(forwarded).toMatchObject({
      type: "local_agent_bridge",
      op: "list_targets",
      client_id: expect.stringMatching(/^[0-9a-f]{12}$/),
      client_pid: 4321,
    });
    expect(forwarded).not.toHaveProperty("token");
    expect(Object.keys(forwarded!).sort()).toEqual(["client_id", "client_pid", "id", "op", "type"]);
    runtime.handle({
      type: "local_agent_bridge_result",
      id: forwarded!.id,
      ok: true,
      result: { targets: [] },
    });
    await expect(reply).resolves.toEqual({ id: "client-1", ok: true, result: { targets: [] } });
    client.destroy();
    await runtime.close();
    expect(() => statSync(socketPath)).toThrow();
  });

  it("forwards only the dedicated account-tool operations without owner claims", async () => {
    const root = mkdtempSync(join(tmpdir(), "runner-local-account-mcp-"));
    roots.push(root);
    const socketPath = join(root, "private", "bridge.sock");
    const runtime = new RunnerLocalAgentBridgeRuntime(socketPath);
    await runtime.start();
    const forwarded: Record<string, unknown>[] = [];
    const gateway = {
      readyState: WebSocket.OPEN,
      send(text: string, callback: (error?: Error) => void) {
        forwarded.push(JSON.parse(text) as Record<string, unknown>);
        callback();
      },
    } as unknown as WebSocket;
    runtime.attach(gateway);
    const client = net.createConnection(socketPath);
    client.write(`${JSON.stringify({
      id: "account",
      op: "account_call",
      tool: "send_session_message",
      args: { resource_id: "opaque", prompt: "status?" },
      owner: "mallory",
      token: "rt_must_not_escape",
    })}\n`);
    await vi.waitFor(() => expect(forwarded).toHaveLength(1));
    expect(forwarded[0]).toMatchObject({
      type: "local_agent_bridge",
      op: "account_call",
      tool: "send_session_message",
      args: { resource_id: "opaque", prompt: "status?" },
    });
    expect(forwarded[0]).not.toHaveProperty("owner");
    expect(forwarded[0]).not.toHaveProperty("token");
    client.destroy();
    await runtime.close();
  });

  it("attaches the daemon's own answer for the caller's session to account calls, never the caller's claim", async () => {
    const root = mkdtempSync(join(tmpdir(), "runner-local-account-self-"));
    roots.push(root);
    const socketPath = join(root, "private", "bridge.sock");
    const resolveCaller = vi.fn(async (pid: number) => pid === 4242 ? { provider: "claude", sessionId: "claude-a" } : null);
    const runtime = new RunnerLocalAgentBridgeRuntime(socketPath, { resolveCaller });
    await runtime.start();
    const forwarded: Record<string, unknown>[] = [];
    runtime.attach({ readyState: WebSocket.OPEN, send(text: string, callback: (error?: Error) => void) { forwarded.push(JSON.parse(text) as Record<string, unknown>); callback(); } } as unknown as WebSocket);
    const client = net.createConnection(socketPath);
    client.write(`${JSON.stringify({ id: "a", op: "account_call", tool: "feishu_doc_place", args: { document: "x" }, client_pid: 4242, caller_session: { source: "codex", session_id: "forged" } })}\n`);
    client.write(`${JSON.stringify({ id: "b", op: "account_call", tool: "feishu_doc_place", args: { document: "x" }, client_pid: 7, caller_session: { source: "codex", session_id: "forged" } })}\n`);
    client.write(`${JSON.stringify({ id: "c", op: "list_account_tools", client_pid: 4242 })}\n`);
    await vi.waitFor(() => expect(forwarded).toHaveLength(3));
    const byOp = (op: string, pid: number) => forwarded.find((frame) => frame.op === op && frame.client_pid === pid)!;
    expect(byOp("account_call", 4242).caller_session).toEqual({ source: "claude", session_id: "claude-a" });
    expect(byOp("account_call", 7)).not.toHaveProperty("caller_session");
    expect(byOp("list_account_tools", 4242)).not.toHaveProperty("caller_session");
    expect(resolveCaller).toHaveBeenCalledTimes(2);
    client.destroy();
    await runtime.close();
  });

  it("releases established and racing leases when a local MCP client disconnects", async () => {
    const root = mkdtempSync(join(tmpdir(), "runner-local-mcp-leases-"));
    roots.push(root);
    const socketPath = join(root, "private", "bridge.sock");
    const runtime = new RunnerLocalAgentBridgeRuntime(socketPath);
    await runtime.start();
    const forwarded: Record<string, unknown>[] = [];
    const gateway = {
      readyState: WebSocket.OPEN,
      send(text: string, callback: (error?: Error) => void) {
        forwarded.push(JSON.parse(text) as Record<string, unknown>);
        callback();
      },
    } as unknown as WebSocket;
    runtime.attach(gateway);

    const established = net.createConnection(socketPath);
    established.write(`${JSON.stringify({
      id: "open-established",
      op: "open",
      device: "target",
      workspace_id: "ws_established",
    })}\n`);
    await vi.waitFor(() => expect(forwarded.filter((row) => row.op === "open")).toHaveLength(1));
    runtime.handle({
      type: "local_agent_bridge_result",
      id: forwarded[0].id,
      ok: true,
      result: { lease_id: "lease-established" },
    });
    established.destroy();
    await vi.waitFor(() => expect(forwarded).toContainEqual(expect.objectContaining({
      op: "close",
      lease_id: "lease-established",
    })));

    const racing = net.createConnection(socketPath);
    racing.write(`${JSON.stringify({
      id: "open-racing",
      op: "open",
      device: "target",
      workspace_id: "ws_racing",
    })}\n`);
    await vi.waitFor(() => expect(forwarded.filter((row) => row.op === "open")).toHaveLength(2));
    const racingOpen = forwarded.find((row) => row.op === "open" && row.workspace_id === "ws_racing")!;
    const racingClosed = new Promise<void>((resolve) => racing.once("close", () => resolve()));
    racing.destroy();
    await racingClosed;
    runtime.handle({
      type: "local_agent_bridge_result",
      id: racingOpen.id,
      ok: true,
      result: { lease_id: "lease-racing" },
    });
    await vi.waitFor(() => expect(forwarded).toContainEqual(expect.objectContaining({
      op: "close",
      lease_id: "lease-racing",
    })));

    const gui = net.createConnection(socketPath);
    gui.write(`${JSON.stringify({
      id: "open-gui",
      op: "open_gui",
      device: "target-mac",
      owner: "mallory",
    })}\n`);
    await vi.waitFor(() => expect(forwarded.filter((row) => row.op === "open_gui")).toHaveLength(1));
    const guiOpen = forwarded.find((row) => row.op === "open_gui")!;
    expect(guiOpen).not.toHaveProperty("owner");
    runtime.handle({
      type: "local_agent_bridge_result",
      id: guiOpen.id,
      ok: true,
      result: { lease_id: "lease-gui", expires_at: "2026-09-03T00:15:00.000Z" },
    });
    gui.destroy();
    await vi.waitFor(() => expect(forwarded).toContainEqual(expect.objectContaining({
      op: "close",
      lease_id: "lease-gui",
    })));

    await runtime.close();
  });

  it("reclaims a lease whose successful open response arrives after the local timeout", async () => {
    const root = mkdtempSync(join(tmpdir(), "runner-local-mcp-timeout-"));
    roots.push(root);
    const socketPath = join(root, "private", "bridge.sock");
    const runtime = new RunnerLocalAgentBridgeRuntime(socketPath, { requestTimeoutMs: 10 });
    await runtime.start();
    const forwarded: Record<string, unknown>[] = [];
    const gateway = {
      readyState: WebSocket.OPEN,
      send(text: string, callback: (error?: Error) => void) {
        forwarded.push(JSON.parse(text) as Record<string, unknown>);
        callback();
      },
    } as unknown as WebSocket;
    runtime.attach(gateway);

    const client = net.createConnection(socketPath);
    client.setEncoding("utf8");
    const timeoutReply = new Promise<Record<string, unknown>>((resolve) => {
      client.once("data", (line: string) => resolve(JSON.parse(line) as Record<string, unknown>));
    });
    client.write(`${JSON.stringify({
      id: "late-open",
      op: "open",
      device: "target",
      workspace_id: "ws_late",
      client_pid: 7654,
    })}\n`);
    await vi.waitFor(() => expect(forwarded).toHaveLength(1));
    await expect(timeoutReply).resolves.toMatchObject({
      id: "late-open",
      ok: false,
      error: expect.stringContaining("timed out"),
    });

    runtime.handle({
      type: "local_agent_bridge_result",
      id: forwarded[0].id,
      ok: true,
      result: { lease_id: "lease-opened-after-timeout" },
    });
    await vi.waitFor(() => expect(forwarded).toContainEqual(expect.objectContaining({
      op: "close",
      lease_id: "lease-opened-after-timeout",
    })));

    client.destroy();
    await runtime.close();
  });

  it("lets the server bind the device's Home when a command names no workspace", async () => {
    const requests: Array<{ op: string; fields: Record<string, unknown> }> = [];
    const bridge = {
      async request(op: string, fields: Record<string, unknown> = {}) {
        requests.push({ op, fields });
        if (op === "open") return { lease_id: "lease-home" };
        return { ok: true, result: { exit_code: 0, stdout: "ok" } };
      },
    };
    const leases = new Map();
    for (const command of ["pwd", "ver"]) {
      await expect(callRemoteTool(bridge, leases, "octopus_run_remote_command", { device: "execution", command }))
        .resolves.toEqual({ exit_code: 0, stdout: "ok" });
    }
    expect(requests[0]).toEqual({ op: "open", fields: { device: "execution" } });
    expect(requests.map(({ op }) => op)).toEqual(["open", "call", "call"]);
    const tool = LOCAL_AGENT_MCP_TOOLS.find((row) => row.name === "octopus_run_remote_command")!;
    expect(tool.inputSchema.required).toEqual(["device", "command"]);
  });

  it("opens shell authority once without an unnecessary workspace-root bridge call", async () => {
    const requests: Array<{ op: string; fields: Record<string, unknown> }> = [];
    const bridge = {
      async request(op: string, fields: Record<string, unknown> = {}) {
        requests.push({ op, fields });
        if (op === "open") return { lease_id: "lease-shell" };
        return { ok: true, result: { exit_code: 0, stdout: "ok" } };
      },
    };
    const leases = new Map();

    await expect(callRemoteTool(bridge, leases, "octopus_run_remote_command", {
      device: "execution",
      workspace_id: "ws_shell",
      command: "pwd",
    })).resolves.toEqual({ exit_code: 0, stdout: "ok" });
    await expect(callRemoteTool(bridge, leases, "octopus_run_remote_command", {
      device: "execution",
      workspace_id: "ws_shell",
      command: "git status --short",
    })).resolves.toEqual({ exit_code: 0, stdout: "ok" });

    expect(requests.map(({ op, fields }) => [op, fields.tool])).toEqual([
      ["open", undefined],
      ["call", "run_workspace_command"],
      ["call", "run_workspace_command"],
    ]);
  });

  it("resolves a path segment past the first listing page and forwards staged write steps", async () => {
    const requests: Array<{ op: string; fields: Record<string, unknown> }> = [];
    const bridge = {
      async request(op: string, fields: Record<string, unknown> = {}) {
        requests.push({ op, fields });
        if (op === "open") return { lease_id: "lease-1" };
        const args = (fields.args ?? {}) as Record<string, unknown>;
        if (fields.tool === "list_session_workspaces") return { ok: true, result: { roots: [{ ref: "wf_root" }] } };
        if (fields.tool === "list_workspace_entries") {
          // Page one does not hold the name; page two does.
          return args.after === "file/a499"
            ? { ok: true, result: { entries: [{ label: "big.md", ref: "wf_big" }], truncated: false } }
            : { ok: true, result: { entries: [{ label: "a499", ref: "wf_a" }], truncated: true, next_after: "file/a499" } };
        }
        return { ok: true, result: { upload: "0".repeat(32), sizeBytes: 0 } };
      },
    };
    const leases = new Map();
    await callRemoteTool(bridge, leases, "octopus_replace_remote_text", {
      device: "execution",
      workspace_id: "ws_files",
      relative_path: "big.md",
      stage: "begin",
      expected_digest: `sha256:${"a".repeat(64)}`,
    });
    const write = requests.find(({ fields }) => fields.tool === "replace_workspace_text")!;
    expect(write.fields.args).toEqual({ ref: "wf_big", stage: "begin", expected_digest: `sha256:${"a".repeat(64)}` });
    expect(requests.filter(({ fields }) => fields.tool === "list_workspace_entries")).toHaveLength(2);
    const list = LOCAL_AGENT_MCP_TOOLS.find(({ name }) => name === "octopus_list_remote_entries")!;
    expect(list.description).toContain("next_after");
    const replace = LOCAL_AGENT_MCP_TOOLS.find(({ name }) => name === "octopus_replace_remote_text")!;
    expect(replace.description).toContain("stage=commit");
  });

  it("forwards a text read's window (offset, max_bytes) and nothing else", async () => {
    const requests: Array<{ op: string; fields: Record<string, unknown> }> = [];
    const bridge = {
      async request(op: string, fields: Record<string, unknown> = {}) {
        requests.push({ op, fields });
        if (op === "open") return { lease_id: "lease-1" };
        if (fields.tool === "list_session_workspaces") return { ok: true, result: { roots: [{ ref: "wf_root" }] } };
        if (fields.tool === "list_workspace_entries") return { ok: true, result: { entries: [{ label: "log.txt", ref: "wf_log" }], truncated: false } };
        return { ok: true, result: { text: "b", offset: 262144, next_offset: 262145, eof: true } };
      },
    };
    await expect(callRemoteTool(bridge, new Map(), "octopus_read_remote_text", {
      device: "execution", workspace_id: "ws_files", relative_path: "log.txt", offset: 262144, max_bytes: 4096,
    })).resolves.toMatchObject({ next_offset: 262145, eof: true });
    const read = requests.find(({ fields }) => fields.tool === "read_workspace_text")!;
    expect(read.fields.args).toEqual({ ref: "wf_log", offset: 262144, max_bytes: 4096 });
    const tool = LOCAL_AGENT_MCP_TOOLS.find(({ name }) => name === "octopus_read_remote_text")!;
    expect(tool.description).toContain("next_offset");
    expect(Object.keys((tool.inputSchema as { properties: object }).properties)).toEqual(expect.arrayContaining(["offset", "max_bytes"]));
  });

  it("evicts and closes an expired cached lease before the next shell call", async () => {
    let opens = 0;
    const requests: Array<{ op: string; fields: Record<string, unknown> }> = [];
    const bridge = {
      async request(op: string, fields: Record<string, unknown> = {}) {
        requests.push({ op, fields });
        if (op === "open") return { lease_id: `lease-${++opens}` };
        if (op === "close") return { closed: true };
        if (fields.lease_id === "lease-1") {
          return { ok: false, code: "no_authority", message: "这个会话执行凭证已过期或不再存活" };
        }
        return { ok: true, result: { exit_code: 0 } };
      },
    };
    const leases = new Map();
    const args = { device: "execution", workspace_id: "ws_shell", command: "pwd" };

    await expect(callRemoteTool(bridge, leases, "octopus_run_remote_command", args))
      .rejects.toThrow(/no_authority/);
    await expect(callRemoteTool(bridge, leases, "octopus_run_remote_command", args))
      .resolves.toEqual({ exit_code: 0 });

    expect(requests.filter(({ op }) => op === "open")).toHaveLength(2);
    expect(requests).toContainEqual({
      op: "close",
      fields: { lease_id: "lease-1" },
    });
  });
});

describe("local MCP recovery without replay", () => {
  const args = { device: "execution", workspace_id: "ws_shell", command: "write-once" };

  it("lists the fixed tools at once while the resident Runner is stopped", async () => {
    const root = mkdtempSync(join(tmpdir(), "octopus-local-mcp-"));
    roots.push(root);
    const socket = join(root, "local-agent-bridge.sock");
    const bridge = { request: vi.fn(async () => ({ tools: [{ name: "account_tool" }] })) };
    await expect(localAgentMcpTools(socket, bridge)).resolves.toEqual(LOCAL_AGENT_MCP_TOOLS);
    expect(bridge.request).not.toHaveBeenCalled();
    writeFileSync(socket, "");
    await expect(localAgentMcpTools(socket, bridge)).resolves.toEqual([...LOCAL_AGENT_MCP_TOOLS, { name: "account_tool" }]);
    expect(bridge.request).toHaveBeenCalledWith("list_account_tools");
  });

  it.each(["lease_missing", "lease_expired"] as const)("renews a %s lease before dispatching once", async (code) => {
    let opens = 0;
    let executions = 0;
    const bridge = { request: vi.fn(async (op: string, fields: Record<string, unknown> = {}) => {
      if (op === "open") return { lease_id: `lease-${++opens}` };
      if (fields.lease_id === "lease-1") throw new LocalBridgeError("scope ended", code);
      executions++;
      return { ok: true, result: { exit_code: 0 } };
    }) };
    await expect(callRemoteTool(bridge, new Map(), "octopus_run_remote_command", args)).resolves.toEqual({ exit_code: 0 });
    expect(opens).toBe(2);
    expect(executions).toBe(1);
  });

  it.each([
    new LocalBridgeError("policy changed", "policy_changed"),
    new Error("approval_required"),
    new Error("connection lost; execution outcome may be unknown"),
    new Error("denied: capability revoked"),
  ])("does not replay %s", async (failure) => {
    let calls = 0;
    const bridge = { request: vi.fn(async (op: string) => {
      if (op === "open") return { lease_id: "lease" };
      calls++;
      throw failure;
    }) };
    await expect(callRemoteTool(bridge, new Map(), "octopus_run_remote_command", args)).rejects.toThrow(failure.message);
    expect(calls).toBe(1);
  });

  it("coalesces concurrent opens but sends each distinct command exactly once", async () => {
    let opens = 0;
    let calls = 0;
    const bridge = { async request(op: string) {
      if (op === "open") { opens++; await new Promise((resolve) => setTimeout(resolve, 10)); return { lease_id: "lease" }; }
      calls++;
      return { ok: true, result: { exit_code: 0 } };
    } };
    const leases = new Map();
    await Promise.all(Array.from({ length: 8 }, () => callRemoteTool(bridge, leases, "octopus_run_remote_command", args)));
    expect(opens).toBe(1);
    expect(calls).toBe(8);
  });

  it("reconnects the same MCP client after resident replacement without replaying a lost reply", async () => {
    const root = mkdtempSync(join(tmpdir(), "runner-mcp-reconnect-"));
    roots.push(root);
    const socketPath = join(root, "bridge.sock");
    const disconnected = vi.fn();
    const client = new LocalBridgeClient(socketPath, { connectTimeoutMs: 1_000, retryDelayMs: 5, onDisconnect: disconnected });
    let calls = 0;
    const sockets = new Set<net.Socket>();
    const makeServer = (drop: boolean) => net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("data", (bytes) => {
        const request = JSON.parse(String(bytes)) as { id: string };
        calls++;
        if (drop) socket.destroy();
        else socket.write(`${JSON.stringify({ id: request.id, ok: true, result: "new-resident" })}\n`);
      });
    });
    let server = makeServer(true);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      await expect(client.request("call", { command: "write-once" })).rejects.toThrow(/outcome may be unknown/);
      expect(calls).toBe(1);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // Begin the next request while the resident is absent: connection retries
      // have not dispatched a command and are safe.
      const next = client.request("list_targets");
      server = makeServer(false);
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));
      await expect(next).resolves.toBe("new-resident");
      expect(disconnected).toHaveBeenCalledOnce();
      expect(calls).toBe(2);
    } finally {
      client.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("waits through a Gateway reconnect only when the resident confirms no forwarding", async () => {
    const root = mkdtempSync(join(tmpdir(), "runner-mcp-offline-"));
    roots.push(root);
    const socketPath = join(root, "bridge.sock");
    const runtime = new RunnerLocalAgentBridgeRuntime(socketPath);
    await runtime.start();
    const client = new LocalBridgeClient(socketPath, { connectTimeoutMs: 1_000, retryDelayMs: 5 });
    const forwarded: Record<string, unknown>[] = [];
    const gateway = {
      readyState: WebSocket.OPEN,
      send(text: string, callback: (error?: Error) => void) {
        const msg = JSON.parse(text) as Record<string, unknown>;
        forwarded.push(msg);
        callback();
        runtime.handle({ type: "local_agent_bridge_result", id: msg.id, ok: true, result: "ok" });
      },
    } as unknown as WebSocket;
    try {
      const pending = client.request("call", { command: "write-once" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(forwarded).toHaveLength(0);
      runtime.attach(gateway);
      await expect(pending).resolves.toBe("ok");
      expect(forwarded).toHaveLength(1);
    } finally { client.close(); await runtime.close(); }
  });
});

describe("local MCP stdio lifetime", () => {
  it("closes its leases and exits when the MCP client's stdin reaches EOF", async () => {
    const root = mkdtempSync(join(tmpdir(), "runner-mcp-eof-"));
    roots.push(root);
    const socketPath = join(root, "bridge.sock");
    const ops: Array<Record<string, unknown>> = [];
    let residentClosed = false;
    const resident = net.createServer((socket) => {
      socket.on("close", () => { residentClosed = true; });
      socket.on("data", (bytes) => {
        for (const line of String(bytes).split("\n").filter(Boolean)) {
          const request = JSON.parse(line) as Record<string, unknown>;
          ops.push(request);
          const result = request.op === "open" ? { lease_id: "lease-eof" }
            : request.op === "call" ? { ok: true, result: { exit_code: 0 } }
            : {};
          socket.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
        }
      });
    });
    await new Promise<void>((resolve) => resident.listen(socketPath, resolve));
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const replies: Array<{ id?: number }> = [];
    let buffered = "";
    stdout.on("data", (chunk) => {
      buffered += String(chunk);
      for (let at = buffered.indexOf("\n"); at >= 0; at = buffered.indexOf("\n")) {
        replies.push(JSON.parse(buffered.slice(0, at)) as { id?: number });
        buffered = buffered.slice(at + 1);
      }
    });
    const send = (message: Record<string, unknown>) => stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    try {
      const running = runLocalAgentMcpStdio(socketPath, stdin, stdout);
      send({ id: 1, method: "initialize", params: {
        protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" },
      } });
      await vi.waitFor(() => expect(replies.some((reply) => reply.id === 1)).toBe(true));
      send({ method: "notifications/initialized" });
      send({ id: 2, method: "tools/call", params: {
        name: "octopus_run_remote_command",
        arguments: { device: "execution", workspace_id: "ws_eof", command: "pwd" },
      } });
      await vi.waitFor(() => expect(replies.some((reply) => reply.id === 2)).toBe(true));

      stdin.end();
      await running;
      expect(ops).toContainEqual(expect.objectContaining({ op: "close", lease_id: "lease-eof" }));
      await vi.waitFor(() => expect(residentClosed).toBe(true));
    } finally {
      await new Promise<void>((resolve) => resident.close(() => resolve()));
    }
  });
});

describe("operation denial", () => {
  it("does not revoke a session merely because one operation was denied", async () => {
    let calls = 0;
    const bridge = { request: vi.fn(async (op: string) => {
      if (op === "open") return { lease_id: "same-session" };
      return ++calls === 1 ? { ok: false, code: "denied", message: "operation refused" }
        : { ok: true, result: { exit_code: 0 } };
    }) };
    const leases = new Map();
    const args = { device: "execution", workspace_id: "ws_shell", command: "operation" };
    await expect(callRemoteTool(bridge, leases, "octopus_run_remote_command", args)).rejects.toThrow(/denied/);
    await expect(callRemoteTool(bridge, leases, "octopus_run_remote_command", args)).resolves.toEqual({ exit_code: 0 });
    expect(bridge.request.mock.calls.filter(([op]) => op === "open")).toHaveLength(1);
  });
});

describe("GUI MCP failure cleanup", () => {
  it.each(["octopus_gui_click", "octopus_gui_scroll", "octopus_gui_drag", "octopus_gui_type_text", "octopus_gui_key_press", "octopus_capture_screen"])(
    "%s forgets a failed lease, preserves the diagnostic and never replays input", async (tool) => {
      const failure = new Error("macOS GUI failed (exit=1): stage=post attempted=2 posted=1; input outcome unknown");
      const request = vi.fn(async (op: string) => {
        if (op === "open_gui") return { granted: true, lease_id: "gui-test", expires_at: new Date(Date.now() + 900_000).toISOString() };
        if (op === "call") throw failure;
        if (op === "close") throw new Error("release transport unavailable");
        throw new Error("unexpected request");
      });
      const leases = new Map();
      await callGuiTool({ request }, leases, "octopus_request_gui_control", { device: "mac" });
      await expect(callGuiTool({ request }, leases, tool, { device: "mac", x: 1, y: 2 })).rejects.toBe(failure);
      expect(leases.size).toBe(0);
      expect(request.mock.calls.map(([op]) => op)).toEqual(["open_gui", "call", "close"]);
      await expect(callGuiTool({ request }, leases, "octopus_capture_screen", { device: "mac" })).rejects.toThrow("not active");
      expect(request).toHaveBeenCalledTimes(3);
    },
  );
});


it("forwards only the Runner's native proof and discards caller owner and proof claims", async () => {
  const root = mkdtempSync(join(tmpdir(), "native-bridge-")); roots.push(root);
  const socketPath = join(root, "bridge.sock"), proof = { protocol: "native-development/v1", session_id: "verified" };
  const runtime = new RunnerLocalAgentBridgeRuntime(socketPath, { development: async () => proof });
  await runtime.start(); const frames: Record<string, unknown>[] = [];
  const gateway = { readyState: WebSocket.OPEN, send(text: string, callback: () => void) { frames.push(JSON.parse(text)); callback(); } } as unknown as WebSocket;
  runtime.attach(gateway); const client = new LocalBridgeClient(socketPath);
  try {
    const result = client.request("development_register", { owner: "forged", token: "secret", proof: { session_id: "forged" }, session_id: "requested" });
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    expect(frames[0]).toMatchObject({ op: "development_register", proof });
    expect(frames[0]).not.toHaveProperty("owner"); expect(frames[0]).not.toHaveProperty("token");
    runtime.handle({ type: "local_agent_bridge_result", id: frames[0]!.id, ok: true, result: { ticket_id: 1 } });
    await expect(result).resolves.toEqual({ ticket_id: 1 });
  } finally { client.close(); await runtime.close(); }
});

describe("account tool results", () => {
  it("renders images the Gateway lifted out of a result as image blocks beside its JSON", () => {
    const data = Buffer.from("slide").toString("base64");
    const result = { exit_code: 0, files: [{ path: "1.png", media_type: "image/png", image: 1 }] };
    expect(accountToolResult({ ok: true, result, images: [{ mimeType: "image/png", data }] })).toEqual({
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }, { type: "image", mimeType: "image/png", data }],
    });
    expect(accountToolResult({ ok: true, result })).toEqual({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
  });

  it("refuses an image it cannot render rather than dumping it as text", () => {
    for (const image of [{ mimeType: "image/svg+xml", data: "YWJj" }, { mimeType: "image/png", data: "not base64" }, null]) {
      expect(() => accountToolResult({ ok: true, result: {}, images: [image] })).toThrow(/do not replay/);
    }
  });

  it("keeps a refusal a refusal", () => {
    expect(() => accountToolResult({ ok: false, code: "approval_required", message: "待批准" })).toThrow(/approval_required/);
  });
});
