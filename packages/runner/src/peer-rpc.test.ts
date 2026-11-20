import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { RunnerPeerRpcClient } from "./peer-rpc.js";

describe("RunnerPeerRpcClient managed recovery", () => {
  it("requests a session-bound scope and validates the Bot response", async () => {
    const frames: Array<Record<string, unknown>> = [];
    const socket = {
      readyState: WebSocket.OPEN,
      send: vi.fn((raw: string, callback: (error?: Error) => void) => {
        frames.push(JSON.parse(raw) as Record<string, unknown>);
        callback();
      }),
    } as unknown as WebSocket;
    const client = new RunnerPeerRpcClient();
    client.attach(socket);

    const pending = client.request("codex", "thread-restart");
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      type: "session_recovery_scope",
      provider: "codex",
      sessionId: "thread-restart",
    });
    expect(client.handle({
      type: "session_recovery_scope_result",
      id: frames[0].id,
      ok: true,
      result: {
        token: "mcp_fresh",
        endpoint: "http://127.0.0.1:9820/api/mcp",
        expiresAt: Date.now() + 60_000,
        operationId: "op_recovery",
        executionDevice: "val15",
        workspaceId: "ws_0123456789abcdef01234567",
      },
    })).toBe(true);
    await expect(pending).resolves.toMatchObject({
      token: "mcp_fresh",
      executionDevice: "val15",
      workspaceId: "ws_0123456789abcdef01234567",
    });
    client.close();
  });

  it("fails closed when a recovery response has no valid bounded scope", async () => {
    let id = "";
    const socket = {
      readyState: WebSocket.OPEN,
      send: vi.fn((raw: string, callback: (error?: Error) => void) => {
        id = String((JSON.parse(raw) as Record<string, unknown>).id);
        callback();
      }),
    } as unknown as WebSocket;
    const client = new RunnerPeerRpcClient();
    client.attach(socket);
    const pending = client.request("claude", "session-restart");
    client.handle({
      type: "session_recovery_scope_result",
      id,
      ok: true,
      result: { token: "not-a-token", expiresAt: 0 },
    });
    await expect(pending).rejects.toThrow(/invalid managed recovery scope/);
    client.close();
  });
});
