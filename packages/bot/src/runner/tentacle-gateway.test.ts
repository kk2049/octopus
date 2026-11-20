import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { Store } from "../store/store.js";
import { RunnerGateway, hashRunnerToken, type RunnerTentacleTransport } from "./gateway.js";

const NOW = "2026-08-14T00:00:00.000Z";
let dir: string;
let store: Store;
let gateway: RunnerGateway;
let transport: RunnerTentacleTransport;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "tentacle-gateway-"));
  store = new Store(join(dir, "bot.db"));
  store.saveUser({ username: "alice", uid: 5001, home_dir: "/x/a", created_at: NOW });
  store.saveUser({ username: "bob", uid: 5002, home_dir: "/x/b", created_at: NOW });
  gateway = new RunnerGateway(store, { port: 0 });
  transport = gateway.claimTentacleTransport({
    authenticate: (token) => token === "mcp_alice" ? { username: "alice", tokenHash: "mh_alice" } : null,
    active: (credential) => credential.username === "alice" && credential.tokenHash === "mh_alice",
  });
  await gateway.start();
});

afterEach(async () => {
  await gateway.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function connect(registration: Record<string, unknown>): Promise<{ ws: WebSocket; first: Record<string, unknown> }> {
  const ws = new WebSocket(`ws://127.0.0.1:${gateway.port}`);
  const first = await new Promise<Record<string, unknown>>((resolve, reject) => {
    ws.on("open", () => ws.send(JSON.stringify(registration)));
    ws.once("message", (data) => resolve(JSON.parse(String(data)) as Record<string, unknown>));
    ws.once("error", reject);
  });
  return { ws, first };
}

describe("RunnerGateway tentacle subprotocol", () => {
  it("requires matching rt_ device and mcp_ user identities and isolates dsh from Runner RPC", async () => {
    store.saveRunnerToken(hashRunnerToken("rt_dsh"), "alice", "dsh:alpha", NOW);
    const received = new Promise<{ username: string; device: string; raw: unknown }>((resolve) => {
      transport.onMessage((peer, raw) => resolve({ ...peer, raw }));
    });
    const { ws, first } = await connect({
      type: "register",
      protocol: "tentacle/v1",
      token: "rt_dsh",
      gateToken: "mcp_alice",
    });
    expect(first).toMatchObject({ type: "registered", protocol: "tentacle/v1", username: "alice", device: "dsh:alpha" });
    expect(gateway.listDevices("alice")).toEqual([]);
    expect(transport.listDevices("alice")).toEqual(["dsh:alpha"]);
    ws.send(JSON.stringify({ fromUser: "bob", payload: "forged" }));
    await expect(received).resolves.toMatchObject({
      username: "alice",
      device: "dsh:alpha",
      raw: { fromUser: "bob", payload: "forged" },
    });
    ws.close();
  });

  it("rejects a cross-user credential pair and a non-dsh device", async () => {
    store.saveRunnerToken(hashRunnerToken("rt_bob"), "bob", "dsh:beta", NOW);
    store.saveRunnerToken(hashRunnerToken("rt_laptop"), "alice", "laptop", NOW);
    const mismatch = await connect({ type: "register", protocol: "tentacle/v1", token: "rt_bob", gateToken: "mcp_alice" });
    expect(mismatch.first).toMatchObject({ type: "error" });
    mismatch.ws.close();
    const laptop = await connect({ type: "register", protocol: "tentacle/v1", token: "rt_laptop", gateToken: "mcp_alice" });
    expect(laptop.first).toMatchObject({ type: "error" });
    laptop.ws.close();
  });

  it("lets delivery acknowledgements release routes while an application call is still open", async () => {
    store.saveRunnerToken(hashRunnerToken("rt_dsh"), "alice", "dsh:alpha", NOW);
    let releaseApplication!: () => void;
    const applicationBlocked = new Promise<void>((resolve) => {
      releaseApplication = resolve;
    });
    let applicationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      applicationStarted = resolve;
    });
    let acknowledgementSeen!: () => void;
    const acknowledged = new Promise<void>((resolve) => {
      acknowledgementSeen = resolve;
    });
    transport.onMessage(async (_peer, raw) => {
      const op = (raw as { op?: unknown }).op;
      if (op === "delivery.ack") {
        acknowledgementSeen();
        return;
      }
      applicationStarted();
      await applicationBlocked;
    });
    const { ws } = await connect({
      type: "register",
      protocol: "tentacle/v1",
      token: "rt_dsh",
      gateToken: "mcp_alice",
    });
    ws.send(JSON.stringify({ op: "tool.invoke" }));
    await started;
    ws.send(JSON.stringify({ op: "delivery.ack" }));
    await expect(Promise.race([
      acknowledged.then(() => "ack"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 250)),
    ])).resolves.toBe("ack");
    releaseApplication();
    ws.close();
  });
});
