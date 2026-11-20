/**
 * Guest terminal tunnel, end to end through the real gateway broker: the
 * guest's console window → guest tunnel → gateway → host tunnel → the host's
 * guest-session sink. Proves the host learns the guest's identity from the
 * server-side profile only, bytes flow both ways unchanged, and a revoked
 * device cannot open a tunnel.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { openGuestTunnel } from "@claude-bot/runner/guest-console";
import { RunnerGuestTunnelRuntime } from "@claude-bot/runner/guest-sessions";
import { Store } from "../store/store.js";
import { RunnerGateway, hashRunnerToken } from "./gateway.js";

const NOW = "2026-11-12T00:00:00.000Z";
let dir: string;
let store: Store;
let gateway: RunnerGateway;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "guest-tunnel-e2e-"));
  store = new Store(join(dir, "t.db"));
  store.saveUser({ username: "alice", uid: 5001, home_dir: "/x/alice", created_at: NOW });
  gateway = new RunnerGateway(store, { port: 0 });
  await gateway.start();
  gateway.claimTransport();
});

afterEach(async () => {
  await gateway.stop();
  rmSync(dir, { recursive: true, force: true });
});

function readOnce(stream: Duplex): Promise<string> {
  return new Promise((resolve) => stream.once("data", (chunk: Buffer) => resolve(chunk.toString())));
}

describe("guest terminal tunnel end to end", () => {
  it("joins the guest's console to its own session on the model host", async () => {
    store.saveRunnerToken(hashRunnerToken("rt_host"), "alice", "host", NOW);
    store.saveRunnerToken(hashRunnerToken("rt_guest"), "alice", "friend-pc", NOW);
    store.saveRunnerGuestProfile({
      username: "alice", device: "friend-pc", model_host: "host", providers: "anthropic",
      created_at: NOW, created_by: "device:host",
    });
    const gatewayUrl = `ws://127.0.0.1:${gateway.port}`;
    const attached: Array<{ guest: unknown; stream: Duplex }> = [];
    const runtime = new RunnerGuestTunnelRuntime(gatewayUrl, {
      available: () => true,
      attach: (stream, guest) => {
        attached.push({ guest, stream });
        stream.on("data", (chunk: Buffer) => stream.write(Buffer.concat([Buffer.from("echo:"), chunk])));
      },
    });

    // The host Runner's control socket, as index.ts wires it.
    const host = new WebSocket(gatewayUrl);
    await new Promise<void>((resolve, reject) => {
      host.once("open", () => host.send(JSON.stringify({
        type: "register", token: "rt_host",
        inventory: {
          schema: "runner-inventory/v1", agent_backends: [],
          execution: { platform: "linux", arch: "x64", shell: true, workspace_files: true, workspace_count: 1, codex_exec_server: false },
          model_egress: { available: true, protocol: "model-egress/v1", providers: ["anthropic"] },
        },
      })));
      host.on("message", (data) => {
        const frame = JSON.parse(String(data)) as Record<string, unknown>;
        if (frame.type === "registered") resolve();
        runtime.handle(frame);
      });
      host.once("error", reject);
    });

    try {
      const console = await openGuestTunnel(gatewayUrl, "rt_guest");
      const reply = readOnce(console);
      console.write("hello");
      expect(await reply).toBe("echo:hello");
      expect(attached).toHaveLength(1);
      expect(attached[0]!.guest).toEqual({ device: "friend-pc", providers: ["anthropic"] });
      console.destroy();

      // A device that is not (or no longer) a guest gets a final refusal.
      store.deleteRunnerGuestProfile("alice", "friend-pc");
      await expect(openGuestTunnel(gatewayUrl, "rt_guest")).rejects.toMatchObject({ refusal: "unauthorized" });
      await expect(openGuestTunnel(gatewayUrl, "rt_nobody")).rejects.toMatchObject({ refusal: "unauthorized" });
    } finally {
      runtime.disconnect();
      host.close();
    }
  });
});
