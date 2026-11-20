/**
 * Runner lifecycle holes the first pass left open.
 *
 * All five were reachable: caller metadata could overwrite the trusted owner
 * label an approval card is drawn from, a cached account authority outlived
 * the user row it came from, an expired transport credential released its
 * Context zero or twice depending on how it was noticed, re-minting a device
 * token left the old socket serving, and the argument limits in the capability
 * registry disagreed with the limits the device actually enforces.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store/store.js";
import { RunnerGateway, hashRunnerToken } from "./gateway.js";
import { RUNNER_OPERATIONS, RunnerCapabilities, SESSION_READ_OPS } from "./capability.js";
import { CapabilityLoopback } from "./loopback.js";
import { startFakeRunner, type FakeRunner } from "./fake-runner.helper.js";
import { MACHINE_LIMITS } from "@claude-bot/runner/limits";

const NOW = "2026-07-29T00:00:00.000Z";

let dir: string;
let store: Store;
let gateway: RunnerGateway;
let caps: RunnerCapabilities;
let alice: FakeRunner | null = null;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "rl-"));
  store = new Store(join(dir, "t.db"));
  store.saveUser({ username: "alice", uid: 5001, home_dir: "/x/alice", created_at: NOW });
  store.saveRunnerToken(hashRunnerToken("rt_alice"), "alice", "laptop", NOW);
  gateway = new RunnerGateway(store, { port: 0 });
  await gateway.start();
  caps = new RunnerCapabilities(store, gateway.claimTransport());
  alice = await startFakeRunner(gateway.port, "rt_alice", "laptop", {
    read_session: () => ({ ok: true }),
    exec: () => ({ ok: true }),
  });
});

afterEach(async () => {
  alice?.close();
  await gateway.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("trusted metadata is not caller-supplied", () => {
  it("caller metadata cannot overwrite owner or purpose", async () => {
    const grant = caps.open({
      username: "alice",
      purpose: "chat-machines/alice",
      kind: "agent-run",
      rights: ["exec"],
      // A caller that gets to name the owner gets to name the approver.
      metadata: { owner: "mallory", purpose: "totally routine", surface: "chat" },
    })!;
    await grant.request("exec", { device: "laptop", command: "id" });
    const cards = caps.listPending("alice");
    expect(cards).toHaveLength(1);
    expect(cards[0].requestedBy.owner).toBe("alice");
    expect(cards[0].requestedBy.purpose).toBe("chat-machines/alice");
    expect(cards[0].requestedBy.surface).toBe("chat");
    // And mallory never gets a queue of their own.
    expect(caps.listPending("mallory")).toHaveLength(0);
  });
});

describe("cached authority is revalidated against current registration", () => {
  it("a deleted user cannot keep using an authority minted earlier", async () => {
    expect(caps.open({ username: "alice", purpose: "p", kind: "session", rights: SESSION_READ_OPS })).not.toBeNull();
    store.deleteUser("alice");
    expect(caps.open({ username: "alice", purpose: "p", kind: "session", rights: SESSION_READ_OPS })).toBeNull();
  });
});

describe("device tokens are revoked at the socket, immediately", () => {
  it("re-minting a device token closes the connection the old token opened", async () => {
    expect(caps.isOnline("alice")).toBe(true);
    caps.mintDeviceToken("alice", "laptop"); // the old token is now invalid
    await new Promise((r) => setTimeout(r, 120));
    expect(caps.isOnline("alice")).toBe(false);
  });

  it("a socket whose token row is gone is closed by the sweep, even if nobody pushed the revocation", async () => {
    expect(caps.isOnline("alice")).toBe(true);
    // Somebody revoked out of band — straight in the store, no notification.
    store.deleteRunnerToken("alice", "laptop");
    gateway.sweepConnections();
    await new Promise((r) => setTimeout(r, 120));
    expect(caps.isOnline("alice")).toBe(false);
  });

  it("deleting a device revokes the account authority as well as the socket", async () => {
    const grant = caps.open({ username: "alice", purpose: "p", kind: "session", rights: SESSION_READ_OPS })!;
    expect((await grant.request("read_session", { id: "s1" })).status).toBe("succeeded");
    store.deleteRunnerToken("alice", "laptop");
    caps.deviceRevoked("alice", "laptop");
    await new Promise((r) => setTimeout(r, 120));
    // Existing grants stop working; they were authority over a device that is gone.
    expect((await grant.request("read_session", { id: "s1" })).status).toBe("denied");
  });
});

describe("transport credential expiry runs exactly once", () => {
  it("an expired token releases its Context once, however it is noticed", async () => {
    const loopback = new CapabilityLoopback();
    await loopback.start();
    try {
      let released = 0;
      const grant = caps.open({ username: "alice", purpose: "mcp", kind: "agent-run", rights: SESSION_READ_OPS })!;
      const token = loopback.mint(grant.capabilities, "mcp/alice", -1, () => {
        released++;
      });
      // Noticed on a request...
      const res = await fetch(`${loopback.url}/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-token": token },
        body: JSON.stringify({ operation: "read_session", args: { id: "s1" } }),
      });
      expect(res.status).toBe(403);
      // ...and again by the sweep, and by stop(). Still once.
      expect(loopback.liveGrants).toBe(0);
      await loopback.stop();
      expect(released).toBe(1);
    } finally {
      await loopback.stop();
    }
  });
});

describe("one canonical set of size limits", () => {
  it("the capability registry and the device agree", () => {
    const exec = RUNNER_OPERATIONS.exec.args;
    expect(exec.command).toEqual({ type: "string", required: true });
    expect(exec.timeout_ms.type === "number" && exec.timeout_ms.max).toBe(MACHINE_LIMITS.execTimeoutMaxMs);
    const read = RUNNER_OPERATIONS.read_file.args;
    expect(read.max_bytes.type === "number" && read.max_bytes.max).toBe(MACHINE_LIMITS.readFileMaxBytes);
    expect(read.offset).toEqual({ type: "number", min: 0, max: Number.MAX_SAFE_INTEGER, integer: true });
    const list = RUNNER_OPERATIONS.list_dir.args;
    expect(list.limit.type === "number" && list.limit.max).toBe(MACHINE_LIMITS.listMaxEntries);
    expect(list.cursor).toEqual({ type: "string", maxLength: MACHINE_LIMITS.pathMaxBytes });
    const write = RUNNER_OPERATIONS.write_file.args;
    expect(write.content.type === "string" && write.content.maxLength).toBe(MACHINE_LIMITS.writeFileMaxBytes);
    expect(write.append).toEqual({ type: "boolean" });
    const path = RUNNER_OPERATIONS.read_file.args.path;
    expect(path.type === "string" && path.maxLength).toBe(MACHINE_LIMITS.pathMaxBytes);
    const start = RUNNER_OPERATIONS.start_session.args;
    expect(start.prompt.type === "string" && start.prompt.maxLength).toBe(MACHINE_LIMITS.startMaxPromptBytes);
    expect(RUNNER_OPERATIONS.append_session.args.prompt).toMatchObject({ maxLength: MACHINE_LIMITS.startMaxPromptBytes });
    expect(start.workspace_id.type === "string" && start.workspace_id.maxLength).toBe(MACHINE_LIMITS.workspaceIdMaxBytes);
    expect(start.permission_profile).toMatchObject({ type: "string", enum: ["full_access", "manual"] });
    expect(start._octopus_launch_mode).toMatchObject({ type: "string", enum: ["independent_cli"] });
    expect(RUNNER_OPERATIONS.append_session.args.permission_profile)
      .toMatchObject({ type: "string", enum: ["full_access", "manual"] });
    expect(RUNNER_OPERATIONS.append_session.args.model).toMatchObject({
      type: "string",
      maxLength: MACHINE_LIMITS.modelMaxBytes,
    });
    expect(RUNNER_OPERATIONS.append_session.args.effort).toMatchObject({
      type: "string",
      maxLength: MACHINE_LIMITS.effortMaxBytes,
      enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    });
    expect(RUNNER_OPERATIONS.append_session.args.account_fallback).toMatchObject({ type: "boolean" });
    expect(RUNNER_OPERATIONS.append_session.args.release_control).toMatchObject({ type: "boolean" });
  });

  it("refuses a later page from a Runner that ignored the window instead of returning its first page", async () => {
    alice?.close();
    // An older Runner: no offset/cursor echo, always answers from the start.
    const legacy = await startFakeRunner(gateway.port, "rt_alice", "laptop", {
      read_file: () => ({ path: "/f", size: 9, truncated: true, content: "first" }),
      list_dir: () => ({ path: "/d", total: 3, returned: 1, entries: [{ name: "a" }] }),
    });
    try {
      await new Promise((r) => setTimeout(r, 50));
      const grant = caps.open({
        username: "alice", purpose: "p", kind: "agent-run",
        rights: ["read_file", "list_dir"], autoAllow: ["read_file", "list_dir"],
      })!;
      expect(await grant.request("read_file", { device: "laptop", path: "/f" }))
        .toMatchObject({ status: "succeeded", result: { content: "first" } });
      const page = await grant.request("read_file", { device: "laptop", path: "/f", offset: 5 });
      expect(page).toMatchObject({ status: "failed" });
      expect(JSON.stringify(page)).toContain("升级 Runner");
      const listed = await grant.request("list_dir", { device: "laptop", path: "/d", cursor: "a" });
      expect(listed).toMatchObject({ status: "failed" });
      expect(JSON.stringify(listed)).toContain("升级 Runner");
    } finally {
      legacy.close();
    }
  });

  it("passes an honoured window through unchanged", async () => {
    alice?.close();
    const current = await startFakeRunner(gateway.port, "rt_alice", "laptop", {
      read_file: (args) => ({ path: "/f", size: 9, offset: args.offset, next_offset: 9, eof: true, content: "rest" }),
      list_dir: (args) => ({ path: "/d", cursor: args.cursor, next_cursor: null, entries: [{ name: "b" }] }),
    });
    try {
      await new Promise((r) => setTimeout(r, 50));
      const grant = caps.open({
        username: "alice", purpose: "p", kind: "agent-run",
        rights: ["read_file", "list_dir"], autoAllow: ["read_file", "list_dir"],
      })!;
      expect(await grant.request("read_file", { device: "laptop", path: "/f", offset: 5 }))
        .toMatchObject({ status: "succeeded", result: { offset: 5, content: "rest" } });
      expect(await grant.request("list_dir", { device: "laptop", path: "/d", cursor: "a" }))
        .toMatchObject({ status: "succeeded", result: { cursor: "a", entries: [{ name: "b" }] } });
      expect(current.frames.map((frame) => frame.args)).toEqual([
        { path: "/f", offset: 5 },
        { path: "/d", cursor: "a" },
      ]);
    } finally {
      current.close();
    }
  });

  it("keeps long commands intact through approval while retaining the whole-request budget", async () => {
    const grant = caps.open({ username: "alice", purpose: "p", kind: "agent-run", rights: ["exec"] })!;
    const command = `printf '%s' '${"章鱼".repeat(10_000)}'`;
    const out = await grant.request("exec", { device: "laptop", command, timeout_ms: MACHINE_LIMITS.execTimeoutMaxMs });
    expect(out.status).toBe("approval_required");
    expect(alice!.frames).toHaveLength(0);
    if (out.status !== "approval_required") throw new Error("expected approval");
    expect((await caps.approve(out.pendingCallId, "alice")).status).toBe("succeeded");
    expect(alice!.frames).toEqual([expect.objectContaining({ method: "exec", args: { command, timeout_ms: MACHINE_LIMITS.execTimeoutMaxMs } })]);
    const over = await grant.request("exec", { device: "laptop", command: "x".repeat(512 * 1024) });
    expect(over.status).toBe("denied");
    expect(alice!.frames).toHaveLength(1);
  });
});
