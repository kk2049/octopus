import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { argsTooLarge } from "@claude-bot/capability-kernel";
import { CodexAgentRelayManager } from "@claude-bot/runner/codex-agent-relay";
import { openRemoteCodexBridge, type RemoteCodexBridge } from "./remote-codex.js";

/**
 * Cross-package integration: the REAL device-side relay manager on one end,
 * the REAL bot-side bridge on the other, fake Codex processes at both tips —
 * an "app-server" that echoes control frames and an "exec-server" that echoes
 * environment frames. What is under test is the multiplexed frame protocol
 * the two halves must agree on.
 */

interface Rig {
  bridge: RemoteCodexBridge;
  appServer: WebSocketServer;
  execServer: WebSocketServer;
  close(): Promise<void>;
}

const rigs: Rig[] = [];

afterEach(async () => {
  await Promise.all(rigs.splice(0).map((rig) => rig.close()));
});

async function makeRig(): Promise<Rig> {
  const appServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(appServer, "listening");
  appServer.on("connection", (socket) => {
    socket.on("message", (data) => socket.send(`app:${String(data)}`));
  });
  const appPort = (appServer.address() as { port: number }).port;

  const execServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(execServer, "listening");
  execServer.on("connection", (socket) => {
    socket.on("message", (data) => socket.send(`exec:${String(data)}`));
  });
  const execPort = (execServer.address() as { port: number }).port;

  const manager = new CodexAgentRelayManager({ ensure: async () => `ws://127.0.0.1:${appPort}` });
  const bridge = await openRemoteCodexBridge({
    call: async (op, args) => {
      // Mirror the two capability-kernel envelopes used in production. The
      // regression in #476 crossed the schema's 16 MiB frame allowance but was
      // denied by the kernel's smaller per-call JSON argument ceiling.
      if (argsTooLarge({ device: "macbookpro", ...args })) throw new Error("arguments too large");
      const result = await manager.execute(op, args);
      if (Buffer.byteLength(JSON.stringify(result), "utf8") > 8 * 1024 * 1024) {
        throw new Error("adapter result too large");
      }
      return result;
    },
    worktree: "/unused-in-this-test",
    label: "ticket-358/it",
    openExec: async () => {
      const socket = new WebSocket(`ws://127.0.0.1:${execPort}`);
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
  const rig: Rig = {
    bridge,
    appServer,
    execServer,
    async close() {
      await bridge.close();
      await manager.close();
      await new Promise<void>((resolve) => appServer.close(() => resolve()));
      await new Promise<void>((resolve) => execServer.close(() => resolve()));
    },
  };
  rigs.push(rig);
  return rig;
}

describe("openRemoteCodexBridge", () => {
  it("round-trips control frames from the local endpoint to the device app-server", async () => {
    const rig = await makeRig();
    expect(rig.bridge.endpoint).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
    expect(rig.bridge.environment.environmentId).toBe("octopus-devpipe-ticket-358-it");
    expect(rig.bridge.environment.execServerUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);

    const attachment = new WebSocket(rig.bridge.endpoint);
    await once(attachment, "open");
    const reply = once(attachment, "message");
    attachment.send("initialize");
    const [data] = await reply;
    expect(String(data)).toBe("app:initialize");
    const closed = once(attachment, "close");
    attachment.close();
    await closed;
  });

  it("round-trips a control message larger than one capability invocation", async () => {
    const rig = await makeRig();
    const attachment = new WebSocket(rig.bridge.endpoint);
    await once(attachment, "open");
    const payload = "control-frame:".repeat(64 * 1024);
    const reply = once(attachment, "message");
    attachment.send(payload);
    const [data] = await reply;
    expect(String(data)).toBe(`app:${payload}`);
    const closed = once(attachment, "close");
    attachment.close();
    await closed;
  });

  it("pipes environment frames from the device-side endpoint into the worktree exec-server", async () => {
    const rig = await makeRig();
    // This plays the app-server's role after `environment/add`: it connects to
    // the device-local URL, and its bytes must come back from the bot-side
    // exec-server echo.
    const environment = new WebSocket(rig.bridge.environment.execServerUrl);
    await once(environment, "open");
    const reply = once(environment, "message");
    environment.send("run-command");
    const [data] = await reply;
    expect(String(data)).toBe("exec:run-command");
    const closed = once(environment, "close");
    environment.close();
    await closed;
  });

  it("round-trips a large environment message without changing its WebSocket boundary", async () => {
    const rig = await makeRig();
    const environment = new WebSocket(rig.bridge.environment.execServerUrl);
    await once(environment, "open");
    const payload = "environment-frame:".repeat(48 * 1024);
    const reply = once(environment, "message");
    environment.send(payload);
    const [data] = await reply;
    expect(String(data)).toBe(`exec:${payload}`);
    const closed = once(environment, "close");
    environment.close();
    await closed;
  });

  it("drops the local attachment when the bridge closes", async () => {
    const rig = await makeRig();
    const attachment = new WebSocket(rig.bridge.endpoint);
    await once(attachment, "open");
    const closed = once(attachment, "close");
    await rig.bridge.close();
    await closed;
    expect(attachment.readyState === WebSocket.CLOSING || attachment.readyState === WebSocket.CLOSED).toBe(true);
  });
});
