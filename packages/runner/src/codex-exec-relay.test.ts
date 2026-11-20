import { once } from "node:events";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { CodexExecRelayCoordinator, CodexExecServerManager } from "./codex-exec-relay.js";
import { addWorkspace } from "./workspaces.js";

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("Codex execution relay", () => {
  it("bridges app-server frames to an exec-server in the selected opaque workspace", async () => {
    const home = await mkdtemp(join(tmpdir(), "codex-exec-relay-"));
    homes.push(home);
    const workspacePath = join(home, "project");
    await mkdir(workspacePath);
    const workspace = await addWorkspace(home, workspacePath, "project");

    const execServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(execServer, "listening");
    execServer.on("connection", (socket) => {
      socket.on("message", (data, binary) => socket.send(data, { binary }));
    });
    const port = (execServer.address() as { port: number }).port;
    let openedCwd = "";
    const manager = new CodexExecServerManager(home, {
      openLocal: async (cwd) => {
        openedCwd = cwd;
        const socket = new WebSocket(`ws://127.0.0.1:${port}`);
        await once(socket, "open");
        return {
          socket,
          async close() {
            if (socket.readyState === WebSocket.CLOSED) return;
            const closed = once(socket, "close");
            socket.close();
            await closed;
          },
        };
      },
    });
    const calls: string[] = [];
    const coordinator = new CodexExecRelayCoordinator({
      async request(input) {
        calls.push(input.method);
        return await manager.execute(input.method, input.args);
      },
    });

    const environment = await coordinator.open({
      executionDevice: "val15",
      workspaceId: workspace.id,
      executionToken: "relay-secret",
      operationId: "op:relay/test",
    });
    expect(environment.environmentId).toBe("octopus-op-relay-test");
    expect(openedCwd).toBe(await realpath(workspacePath));

    const appServer = new WebSocket(environment.endpoint);
    await once(appServer, "open");
    const echoed = once(appServer, "message");
    appServer.send("hello-exec-server");
    const [data, binary] = await echoed;
    expect(String(data)).toBe("hello-exec-server");
    expect(binary).toBe(false);
    expect(calls).toEqual(expect.arrayContaining([
      "codex_exec_open",
      "codex_exec_read",
      "codex_exec_write",
    ]));

    const appClosed = once(appServer, "close");
    appServer.close();
    await appClosed;
    await environment.close();
    expect(calls.at(-1)).toBe("codex_exec_close");
    await manager.close();
    await new Promise<void>((resolve) => execServer.close(() => resolve()));
  });

  it("gives a reconnecting app-server a fresh connection to the same exec-server", async () => {
    const home = await mkdtemp(join(tmpdir(), "codex-exec-relay-"));
    homes.push(home);
    const workspacePath = join(home, "project");
    await mkdir(workspacePath);
    const workspace = await addWorkspace(home, workspacePath, "project");

    // Like codex exec-server: one process, many connections, one initialize per connection.
    const execServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(execServer, "listening");
    const upstream: WebSocket[] = [];
    execServer.on("connection", (socket) => {
      upstream.push(socket);
      let initialized = false;
      socket.on("message", (data) => {
        if (String(data) !== "initialize") return socket.send(`echo:${String(data)}`);
        socket.send(initialized ? "error:initialize may only be sent once per connection" : `ok:${upstream.length}`);
        initialized = true;
      });
    });
    const url = `ws://127.0.0.1:${(execServer.address() as { port: number }).port}`;
    const connect = async () => {
      const socket = new WebSocket(url);
      await once(socket, "open");
      return socket;
    };
    const manager = new CodexExecServerManager(home, {
      openLocal: async () => {
        const socket = await connect();
        return { socket, connect, async close() { socket.terminate(); } };
      },
    });
    const calls: string[] = [];
    const coordinator = new CodexExecRelayCoordinator({
      async request(input) {
        calls.push(input.method);
        return await manager.execute(input.method, input.args);
      },
    });
    const environment = await coordinator.open({
      executionDevice: "val15", workspaceId: workspace.id, executionToken: "relay-secret", operationId: "op",
    });
    const initialize = async () => {
      const appServer = new WebSocket(environment.endpoint);
      await once(appServer, "open");
      const reply = once(appServer, "message");
      appServer.send("initialize");
      return { appServer, reply: String((await reply)[0]) };
    };

    const first = await initialize();
    expect(first.reply).toBe("ok:1");
    const dropped = once(first.appServer, "close");
    first.appServer.terminate();
    await dropped;

    const second = await initialize();
    expect(second.reply).toBe("ok:2");
    expect(calls).toContain("codex_exec_reconnect");
    expect(upstream[0]!.readyState).not.toBe(WebSocket.OPEN);
    const echoed = once(second.appServer, "message");
    second.appServer.send("ls");
    expect(String((await echoed)[0])).toBe("echo:ls");

    second.appServer.terminate();
    await environment.close();
    await manager.close();
    await new Promise<void>((resolve) => execServer.close(() => resolve()));
  });

  it("ends a superseded generation's pending read without handing it the new connection's frames", async () => {
    const home = await mkdtemp(join(tmpdir(), "codex-exec-relay-"));
    homes.push(home);
    const workspacePath = join(home, "project");
    await mkdir(workspacePath);
    const workspace = await addWorkspace(home, workspacePath, "project");
    const execServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(execServer, "listening");
    execServer.on("connection", (socket) => socket.on("message", (data) => socket.send(`echo:${String(data)}`)));
    const url = `ws://127.0.0.1:${(execServer.address() as { port: number }).port}`;
    const connect = async () => {
      const socket = new WebSocket(url);
      await once(socket, "open");
      return socket;
    };
    const manager = new CodexExecServerManager(home, {
      openLocal: async () => {
        const socket = await connect();
        return { socket, connect, async close() { socket.terminate(); } };
      },
    });
    const opened = await manager.execute("codex_exec_open", { workspace_id: workspace.id }) as { tunnel_id: string; generation: number };
    expect(opened.generation).toBe(1);
    const stale = manager.execute("codex_exec_read", { tunnel_id: opened.tunnel_id, generation: 1, wait_ms: 5_000 });
    const next = await manager.execute("codex_exec_reconnect", { tunnel_id: opened.tunnel_id }) as { generation: number };
    expect(next.generation).toBe(2);
    expect(await stale).toMatchObject({ frames: [], closed: true });
    await expect(manager.execute("codex_exec_write", { tunnel_id: opened.tunnel_id, generation: 1, data: Buffer.from("old").toString("base64") }))
      .rejects.toThrow("superseded");
    await manager.execute("codex_exec_write", { tunnel_id: opened.tunnel_id, generation: 2, data: Buffer.from("new").toString("base64") });
    const fresh = await manager.execute("codex_exec_read", { tunnel_id: opened.tunnel_id, generation: 2, wait_ms: 5_000 }) as { frames: Array<{ data: string }> };
    expect(fresh.frames.map((frame) => Buffer.from(frame.data, "base64").toString())).toEqual(["echo:new"]);
    await manager.close();
    await new Promise<void>((resolve) => execServer.close(() => resolve()));
  });
});
