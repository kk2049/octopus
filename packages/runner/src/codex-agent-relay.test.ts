import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import {
  CodexAgentRelayFrameAssembler,
  CodexAgentRelayManager,
  type CodexAgentRelayWireFrame,
} from "./codex-agent-relay.js";
import { MACHINE_LIMITS } from "./limits.js";

interface Harness {
  manager: CodexAgentRelayManager;
  appServer: WebSocketServer;
  appConnections: WebSocket[];
  close(): Promise<void>;
}

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.close()));
});

/** A fake device-local Codex app-server: echoes every frame back uppercased. */
async function makeHarness(): Promise<Harness> {
  const appServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(appServer, "listening");
  const appConnections: WebSocket[] = [];
  appServer.on("connection", (socket) => {
    appConnections.push(socket);
    socket.on("message", (data) => socket.send(`echo:${String(data)}`));
  });
  const port = (appServer.address() as { port: number }).port;
  const manager = new CodexAgentRelayManager({ ensure: async () => `ws://127.0.0.1:${port}` });
  const harness: Harness = {
    manager,
    appServer,
    appConnections,
    async close() {
      await manager.close();
      await new Promise<void>((resolve) => appServer.close(() => resolve()));
    },
  };
  harnesses.push(harness);
  return harness;
}

async function readFrames(
  manager: CodexAgentRelayManager,
  tunnelId: string,
): Promise<{ frames: CodexAgentRelayWireFrame[]; closed: boolean; error?: string }> {
  return await manager.execute("codex_agent_read", { tunnel_id: tunnelId, wait_ms: 2_000 }) as {
    frames: CodexAgentRelayWireFrame[];
    closed: boolean;
    error?: string;
  };
}

describe("CodexAgentRelayManager", () => {
  it("tunnels agent frames both ways against the shared app-server endpoint", async () => {
    const h = await makeHarness();
    const opened = await h.manager.execute("codex_agent_open", {}) as {
      tunnel_id: string;
      environment_endpoint: string;
    };
    expect(opened.tunnel_id).toMatch(/[0-9a-f-]{36}/);
    expect(opened.environment_endpoint).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
    expect(h.appConnections).toHaveLength(1);

    await h.manager.execute("codex_agent_write", {
      tunnel_id: opened.tunnel_id,
      channel: "agent",
      data: Buffer.from("ping").toString("base64"),
    });
    const result = await readFrames(h.manager, opened.tunnel_id);
    expect(result.closed).toBe(false);
    expect(result.frames).toHaveLength(1);
    expect(result.frames[0].channel).toBe("agent");
    expect(Buffer.from(result.frames[0].data, "base64").toString()).toBe("echo:ping");

    await h.manager.execute("codex_agent_close", { tunnel_id: opened.tunnel_id });
    await expect(readFrames(h.manager, opened.tunnel_id)).rejects.toThrow(/unavailable/);
  });

  it("relays environment frames through its loopback server on the env channel", async () => {
    const h = await makeHarness();
    const opened = await h.manager.execute("codex_agent_open", {}) as {
      tunnel_id: string;
      environment_endpoint: string;
    };
    // Writing to env before the app-server attached is an explicit error, not a drop.
    await expect(h.manager.execute("codex_agent_write", {
      tunnel_id: opened.tunnel_id,
      channel: "env",
      data: Buffer.from("early").toString("base64"),
    })).rejects.toThrow(/environment is not connected/);

    const envClient = new WebSocket(opened.environment_endpoint);
    await once(envClient, "open");
    envClient.send("exec-request");
    const inbound = await readFrames(h.manager, opened.tunnel_id);
    expect(inbound.frames.map((f) => f.channel)).toEqual(["env"]);
    expect(Buffer.from(inbound.frames[0].data, "base64").toString()).toBe("exec-request");

    const echoed = once(envClient, "message");
    await h.manager.execute("codex_agent_write", {
      tunnel_id: opened.tunnel_id,
      channel: "env",
      data: Buffer.from("exec-reply").toString("base64"),
    });
    const [data] = await echoed;
    expect(String(data)).toBe("exec-reply");

    const closed = once(envClient, "close");
    await h.manager.execute("codex_agent_close", { tunnel_id: opened.tunnel_id });
    await closed;
  });

  it("reports tunnel closure when the app-server connection drops", async () => {
    const h = await makeHarness();
    const opened = await h.manager.execute("codex_agent_open", {}) as { tunnel_id: string };
    h.appConnections[0].close(1011, "server going away");
    const result = await readFrames(h.manager, opened.tunnel_id);
    expect(result.closed).toBe(true);
  });

  it("bounds read results and restores one large WebSocket message across batches", async () => {
    const h = await makeHarness();
    const opened = await h.manager.execute("codex_agent_open", {
      relay_protocol: MACHINE_LIMITS.codexAgentRelayProtocol,
    }) as { tunnel_id: string; relay_protocol: string };
    expect(opened.relay_protocol).toBe(MACHINE_LIMITS.codexAgentRelayProtocol);
    const payload = Buffer.alloc(6 * 1024 * 1024, 0x61);
    const firstRead = readFrames(h.manager, opened.tunnel_id);
    await new Promise<void>((resolve, reject) => {
      h.appConnections[0].send(payload, { binary: true }, (error) => error ? reject(error) : resolve());
    });

    const assembler = new CodexAgentRelayFrameAssembler();
    let batch = await firstRead;
    let batches = 0;
    let restored: Buffer | null = null;
    while (!restored && batches < 4) {
      batches += 1;
      expect(Buffer.byteLength(JSON.stringify(batch), "utf8")).toBeLessThan(8 * 1024 * 1024);
      for (const frame of batch.frames) {
        const value = assembler.accept(frame as unknown as Record<string, unknown>);
        if (value) restored = value.data;
      }
      if (!restored) batch = await readFrames(h.manager, opened.tunnel_id);
    }
    expect(batches).toBeGreaterThan(1);
    expect(restored && Buffer.compare(restored, payload)).toBe(0);
  });

  it("rejects an out-of-order fragment without emitting a partial WebSocket message", async () => {
    const h = await makeHarness();
    const opened = await h.manager.execute("codex_agent_open", {
      relay_protocol: MACHINE_LIMITS.codexAgentRelayProtocol,
    }) as { tunnel_id: string };
    await expect(h.manager.execute("codex_agent_write", {
      tunnel_id: opened.tunnel_id,
      channel: "agent",
      data: Buffer.from("second").toString("base64"),
      frame_id: "frame-1",
      chunk_index: 1,
      chunk_count: 2,
    })).rejects.toThrow(/fragment sequence is invalid/);

    await h.manager.execute("codex_agent_write", {
      tunnel_id: opened.tunnel_id,
      channel: "agent",
      data: Buffer.from("whole").toString("base64"),
    });
    const result = await readFrames(h.manager, opened.tunnel_id);
    expect(result.frames).toHaveLength(1);
    expect(Buffer.from(result.frames[0].data, "base64").toString()).toBe("echo:whole");
  });
});
