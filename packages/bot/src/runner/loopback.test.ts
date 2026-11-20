import { describe, it, expect, afterEach, vi } from "vitest";
import type { BoundCapabilities } from "@claude-bot/capability-kernel";
import { CapabilityLoopback } from "./loopback.js";
import { unavailableMessage } from "../resources/recovery.js";

let loopback: CapabilityLoopback | null = null;

afterEach(async () => {
  vi.useRealTimers();
  await loopback?.stop();
  loopback = null;
});

function capabilitiesThatFailWith(reason: string): BoundCapabilities {
  return {
    request: async () => ({ status: "failed", reason }),
    result: () => null,
  } as unknown as BoundCapabilities;
}

async function rpc(token: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${loopback!.url}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-token": token },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("CapabilityLoopback × resource recovery", () => {
  it("records a waiter under the grant's label when the answer names an away resource", async () => {
    const noted: Array<[string, string, string]> = [];
    loopback = new CapabilityLoopback({ recovery: { note: (scope, resource, detail) => { noted.push([scope, resource, detail]); } } });
    await loopback.start();
    const token = loopback.mint(capabilitiesThatFailWith(unavailableMessage("runner:lht/lht-val15-ci", "设备 lht-val15-ci 不在线")), "dev-ticket/296");
    const out = await rpc(token, { slot: "runner", operation: "exec", args: { device: "lht-val15-ci", command: "true" } });
    expect(out.status).toBe(503);
    expect(out.body).toMatchObject({ ok: false, resource_unavailable: "runner:lht/lht-val15-ci" });
    expect(String(out.body.error)).toContain("已登记等待");
    expect(noted).toHaveLength(1);
    expect(noted[0][0]).toBe("dev-ticket/296");
    expect(noted[0][1]).toBe("runner:lht/lht-val15-ci");
    expect(noted[0][2]).toContain("设备 lht-val15-ci 不在线");
  });

  it("leaves an ordinary failure alone", async () => {
    const noted: unknown[] = [];
    loopback = new CapabilityLoopback({ recovery: { note: (...args) => { noted.push(args); } } });
    await loopback.start();
    const token = loopback.mint(capabilitiesThatFailWith("command exited 1"), "dev-ticket/296");
    const out = await rpc(token, { slot: "runner", operation: "exec", args: { device: "x", command: "false" } });
    expect(out.status).toBe(502);
    expect(noted).toHaveLength(0);
  });

  it("works without a recovery service at all", async () => {
    loopback = new CapabilityLoopback();
    await loopback.start();
    const token = loopback.mint(capabilitiesThatFailWith(unavailableMessage("runner:a/b", "offline")), "chat-feishu/a");
    const out = await rpc(token, { slot: "runner", operation: "exec", args: { device: "b", command: "true" } });
    expect(out.status).toBe(503);
  });
});

describe("CapabilityLoopback credential lifetime", () => {
  it("keeps a live owner's credential valid beyond its orphan TTL", async () => {
    vi.useFakeTimers();
    let released = 0;
    loopback = new CapabilityLoopback();
    const token = loopback.mint(capabilitiesThatFailWith("unused"), "dev-ticket/317", 1_000, () => { released++; });
    const keepalive = loopback.keepAlive(token, 1_000);

    await vi.advanceTimersByTimeAsync(3_100);
    expect(loopback.liveGrants).toBe(1);
    expect(released).toBe(0);

    keepalive.stop();
    loopback.revoke(token);
    expect(loopback.liveGrants).toBe(0);
    expect(released).toBe(1);
  });

  it("does not revive a credential after its owner stopped renewing", async () => {
    vi.useFakeTimers();
    let released = 0;
    loopback = new CapabilityLoopback();
    const token = loopback.mint(capabilitiesThatFailWith("unused"), "dev-ticket/317", 1_000, () => { released++; });
    const keepalive = loopback.keepAlive(token, 1_000);

    keepalive.stop();
    await vi.advanceTimersByTimeAsync(1_001);
    expect(loopback.liveGrants).toBe(0);
    expect(released).toBe(1);
  });
});
