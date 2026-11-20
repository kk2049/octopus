import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { Store } from "../store/store.js";
import { RunnerGateway, hashRunnerToken } from "./gateway.js";
import { GuestEnrollmentError, issueGuestEnrollment, redeemRunnerEnrollment } from "./enrollment.js";
import { MODEL_TUNNEL_GUEST_PROTOCOL, MODEL_TUNNEL_HOST_PROTOCOL } from "./model-tunnels.js";

const NOW = "2026-11-12T00:00:00.000Z";
let dir: string;
let store: Store;
let gateway: RunnerGateway;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "model-tunnel-"));
  store = new Store(join(dir, "t.db"));
  store.saveUser({ username: "alice", uid: 5001, home_dir: "/x/alice", created_at: NOW });
  store.saveUser({ username: "bob", uid: 5002, home_dir: "/x/bob", created_at: NOW });
  gateway = new RunnerGateway(store, { port: 0 });
  await gateway.start();
  gateway.claimTransport();
});

afterEach(async () => {
  await gateway.stop();
  rmSync(dir, { recursive: true, force: true });
});

function inventory(egress?: Array<"anthropic" | "openai">): Record<string, unknown> {
  return {
    schema: "runner-inventory/v1",
    agent_backends: [],
    execution: { platform: "linux", arch: "x64", shell: true, workspace_files: true, workspace_count: 1, codex_exec_server: false },
    ...(egress ? { model_egress: { available: true, protocol: "model-egress/v1", providers: egress } } : {}),
  };
}

/** A registered Runner control socket that records every frame it receives. */
async function control(token: string, inv: Record<string, unknown>): Promise<{ ws: WebSocket; frames: Record<string, unknown>[] }> {
  const ws = new WebSocket(`ws://127.0.0.1:${gateway.port}`);
  const frames: Record<string, unknown>[] = [];
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => ws.send(JSON.stringify({ type: "register", token, inventory: inv })));
    ws.on("message", (data) => {
      const frame = JSON.parse(String(data)) as Record<string, unknown>;
      frames.push(frame);
      if (frame.type === "registered") resolve();
      if (frame.type === "error") reject(new Error(String(frame.message)));
    });
    ws.once("error", reject);
  });
  return { ws, frames };
}

/** Open a guest tunnel socket; resolves with the first JSON answer. */
async function guestTunnel(token: string): Promise<{ ws: WebSocket; answer: Record<string, unknown> }> {
  const ws = new WebSocket(`ws://127.0.0.1:${gateway.port}`);
  const answer = await new Promise<Record<string, unknown>>((resolve, reject) => {
    ws.once("open", () => ws.send(JSON.stringify({ type: "register", protocol: MODEL_TUNNEL_GUEST_PROTOCOL, token })));
    ws.once("message", (data) => resolve(JSON.parse(String(data)) as Record<string, unknown>));
    ws.once("error", reject);
  });
  return { ws, answer };
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 3_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function guestSetup(): { hostToken: string; guestToken: string } {
  const hostToken = "rt_host_codexb";
  const guestToken = "rt_guest_friend";
  store.saveRunnerToken(hashRunnerToken(hostToken), "alice", "host", NOW);
  store.saveRunnerToken(hashRunnerToken(guestToken), "alice", "friend-pc", NOW);
  store.saveRunnerGuestProfile({
    username: "alice", device: "friend-pc", model_host: "host", providers: "anthropic,openai",
    created_at: NOW, created_by: "device:host",
  });
  return { hostToken, guestToken };
}

describe("model tunnels", () => {
  it("joins a guest stream to its profile's host and carries bytes both ways", async () => {
    const { hostToken, guestToken } = guestSetup();
    const host = await control(hostToken, inventory(["anthropic", "openai"]));
    const guestWs = new WebSocket(`ws://127.0.0.1:${gateway.port}`);
    const guestFrames: Array<string | Buffer> = [];
    guestWs.on("message", (data, isBinary) => guestFrames.push(isBinary ? Buffer.from(data as Buffer) : String(data)));
    await new Promise<void>((resolve) => guestWs.once("open", () => resolve()));
    guestWs.send(JSON.stringify({ type: "register", protocol: MODEL_TUNNEL_GUEST_PROTOCOL, token: guestToken }));

    const offer = await waitFor(() => host.frames.find((frame) => frame.type === "model_tunnel_open"));
    expect(offer.guest).toEqual({ device: "friend-pc", providers: ["anthropic", "openai"] });
    expect(JSON.stringify(offer)).not.toContain(guestToken);

    const hostData = new WebSocket(`ws://127.0.0.1:${gateway.port}`);
    const hostReceived: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      hostData.once("open", () => hostData.send(JSON.stringify({
        type: "register", protocol: MODEL_TUNNEL_HOST_PROTOCOL, tunnelId: offer.tunnelId, secret: offer.secret,
      })));
      hostData.on("message", (data, isBinary) => {
        if (!isBinary) {
          const frame = JSON.parse(String(data)) as Record<string, unknown>;
          if (frame.type === "registered") resolve();
          return;
        }
        hostReceived.push(Buffer.from(data as Buffer));
      });
      hostData.once("error", reject);
    });
    await waitFor(() => guestFrames.find((frame) => typeof frame === "string" && frame.includes("registered")));

    guestWs.send(Buffer.from("POST /anthropic/v1/messages HTTP/1.1\r\n\r\n"));
    await waitFor(() => hostReceived.length ? true : undefined);
    expect(Buffer.concat(hostReceived).toString()).toContain("/anthropic/v1/messages");
    hostData.send(Buffer.from("HTTP/1.1 200 OK\r\n\r\n"));
    await waitFor(() => guestFrames.some((frame) => Buffer.isBuffer(frame) && frame.toString().includes("200 OK")) ? true : undefined);

    // A keepalive round right after the join (no pong yet) keeps the tunnel.
    gateway.sweepConnections();
    guestWs.send(Buffer.from("after-sweep"));
    await waitFor(() => Buffer.concat(hostReceived).toString().includes("after-sweep") ? true : undefined);

    // A replayed secret cannot claim the same offer twice.
    const replay = new WebSocket(`ws://127.0.0.1:${gateway.port}`);
    const replayClose = await new Promise<number>((resolve) => {
      replay.once("open", () => replay.send(JSON.stringify({
        type: "register", protocol: MODEL_TUNNEL_HOST_PROTOCOL, tunnelId: offer.tunnelId, secret: offer.secret,
      })));
      replay.once("close", (code) => resolve(code));
    });
    expect(replayClose).toBe(4003);

    // Revoking the guest closes its open tunnels at the next sweep.
    store.deleteRunnerToken("alice", "friend-pc");
    const closed = new Promise<void>((resolve) => guestWs.once("close", () => resolve()));
    gateway.sweepConnections();
    await closed;
    host.ws.close();
    hostData.close();
  });

  it("refuses ordinary devices, offline hosts and hosts without egress", async () => {
    const { hostToken, guestToken } = guestSetup();
    store.saveRunnerToken(hashRunnerToken("rt_plain"), "alice", "laptop", NOW);
    expect((await guestTunnel("rt_plain")).answer).toMatchObject({ type: "error", message: "this device is not a guest client" });
    expect((await guestTunnel("rt_unknown")).answer).toMatchObject({ type: "error", message: "invalid token" });
    expect(String((await guestTunnel(guestToken)).answer.message)).toContain("不在线");
    const host = await control(hostToken, inventory());
    expect(String((await guestTunnel(guestToken)).answer.message)).toContain("没有开启模型出口");
    host.ws.close();
  });

  it("drops a guest Runner's bridge and session frames but serves its RPC replies", async () => {
    const { guestToken } = guestSetup();
    const guest = await control(guestToken, inventory());
    store.saveRunnerToken(hashRunnerToken("rt_plain"), "alice", "laptop", NOW);
    const plain = await control("rt_plain", inventory());
    for (const socket of [guest, plain]) {
      socket.ws.send(JSON.stringify({ type: "peer_rpc", id: "p1", method: "nope", target: "laptop" }));
    }
    await waitFor(() => plain.frames.find((frame) => frame.type === "peer_rpc_result"));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(guest.frames.some((frame) => frame.type === "peer_rpc_result")).toBe(false);
    guest.ws.close();
    plain.ws.close();
  });
});

describe("guest enrollment", () => {
  it("creates the profile and a single-use code that mints the guest device", () => {
    const issued = issueGuestEnrollment(store, {
      username: "alice", device: "friend-pc", modelHost: "host", providers: ["anthropic"], ttlMs: 3 * 24 * 3600_000,
    }, new Date(NOW));
    expect(issued.code).toMatch(/^re_[0-9a-f]{48}$/);
    expect(issued.expires_at).toBe("2026-11-15T00:00:00.000Z");
    expect(store.getRunnerGuestProfile("alice", "friend-pc")).toMatchObject({ model_host: "host", providers: "anthropic" });
    const minted: string[] = [];
    const caps = { mintDeviceToken: (username: string, device: string) => { minted.push(`${username}/${device}`); return "rt_x"; } };
    expect(redeemRunnerEnrollment(store, caps, issued.code, new Date("2026-11-14T00:00:00.000Z"))?.token).toBe("rt_x");
    expect(redeemRunnerEnrollment(store, caps, issued.code, new Date("2026-11-14T00:00:00.000Z"))).toBeNull();
    expect(minted).toEqual(["alice/friend-pc"]);
  });

  it("never demotes an ordinary device, lets no guest issue, and checks names and providers", () => {
    store.saveRunnerToken(hashRunnerToken("rt_laptop"), "alice", "laptop", NOW);
    const issue = (device: string, modelHost = "host", providers: Array<"anthropic" | "openai"> = ["openai"]) =>
      () => issueGuestEnrollment(store, { username: "alice", device, modelHost, providers });
    expect(issue("laptop")).toThrow(GuestEnrollmentError);
    expect(issue("bad name")).toThrow(/访客设备名/);
    expect(issue("host")).toThrow(/同名/);
    expect(issue("friend", "host", [])).toThrow(/providers/);
    issue("friend")();
    expect(issue("second", "friend")).toThrow(/不能为别的访客/);
    // Re-issuing for the same guest name is how a new installer is made.
    expect(() => issue("friend")()).not.toThrow();
  });
});
