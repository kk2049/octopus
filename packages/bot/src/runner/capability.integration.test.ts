/**
 * The P0 acceptance matrix (counterexamples: doc/tcb-reading-guide.md §5),
 * run against real WebSocket Runners.
 *
 * Every case asserts on RECEIVED FRAMES. "Denied" here means Bob's laptop got
 * nothing, not that a function returned `{status:"denied"}` — the reviews of
 * both earlier experiments landed on exactly that gap.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store/store.js";
import { RunnerGateway, hashRunnerToken } from "./gateway.js";
import {
  ARCHIVE_OPS,
  MACHINE_AUTO_ALLOW,
  MACHINE_OPS,
  RunnerCapabilities,
  RUNNER_READ_OPS,
  RUNNER_WRITE_OPS,
  SESSION_READ_OPS,
} from "./capability.js";
import { CapabilityLoopback } from "./loopback.js";
import { startFakeRunner, type FakeRunner } from "./fake-runner.helper.js";

const NOW = "2026-07-29T00:00:00.000Z";

let dir: string;
let store: Store;
let gateway: RunnerGateway;
let caps: RunnerCapabilities;
let alice: FakeRunner;
let bob: FakeRunner;
let projectionReads: Array<{ owner: string; operation: string }> = [];
let projectionHit: unknown = null;
let projectionDeviceHit: unknown = null;
let projectionDeviceReads: Array<{ owner: string; device: string }> = [];

const echo = {
  list_recent_sessions: (a: Record<string, unknown>) => ({ total_found: 1, sessions: [{ id: "s1", who: a.who ?? "" }] }),
  read_session: (a: Record<string, unknown>) => ({ id: a.id, messages: [] }),
  search_sessions: () => ({ scanned: 1, results: [], returned: 0, total_candidates: 0 }),
  read_file: (a: Record<string, unknown>) => ({ path: a.path, content: "secret" }),
  copy_session: (a: Record<string, unknown>) => ({ id: a.id, rel_path: ".claude/x.jsonl", content: "{}", size: 2 }),
  exec: (a: Record<string, unknown>) => ({ stdout: `ran ${String(a.command)}`, exit_code: 0 }),
  write_file: (a: Record<string, unknown>) => ({ path: a.path, bytes: 1 }),
  append_session: (a: Record<string, unknown>) => ({ ok: true, id: a.id }),
  start_session: () => ({ ok: true, session_id: "new-session" }),
  list_session_workspaces: () => ({ workspaces: [] }),
  host_info: () => ({ hostname: "laptop" }),
  list_dir: (a: Record<string, unknown>) => ({ path: a.path, entries: [] }),
  copy_file: (a: Record<string, unknown>) => ({ path: a.path, content: "x", size: 1 }),
};

beforeEach(async () => {
  projectionReads = [];
  projectionHit = null;
  projectionDeviceReads = [];
  projectionDeviceHit = null;
  dir = mkdtempSync(join(tmpdir(), "cap-"));
  store = new Store(join(dir, "t.db"));
  store.saveUser({ username: "alice", uid: 5001, home_dir: "/x/alice", created_at: NOW });
  store.saveUser({ username: "bob", uid: 5002, home_dir: "/x/bob", created_at: NOW });
  store.saveRunnerToken(hashRunnerToken("rt_alice"), "alice", "laptop", NOW);
  store.saveRunnerToken(hashRunnerToken("rt_alice2"), "alice", "desktop", NOW);
  store.saveRunnerToken(hashRunnerToken("rt_bob"), "bob", "laptop", NOW);
  gateway = new RunnerGateway(store, { port: 0 });
  await gateway.start();
  caps = new RunnerCapabilities(store, gateway.claimTransport(), {
    projectionReadCache: {
      read: (owner, operation) => {
        projectionReads.push({ owner, operation });
        return projectionHit === null ? { hit: false } : { hit: true, result: projectionHit };
      },
      readRosterDevice: (owner, device) => {
        projectionDeviceReads.push({ owner, device });
        return projectionDeviceHit === null ? { hit: false } : { hit: true, result: projectionDeviceHit };
      },
      remember: () => {},
    },
  });
  alice = await startFakeRunner(gateway.port, "rt_alice", "laptop", echo);
  bob = await startFakeRunner(gateway.port, "rt_bob", "laptop", echo);
});

afterEach(async () => {
  alice.close();
  bob.close();
  await gateway.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("acceptance: reads", () => {
  it("exposes a GUI-capable Mac only by policy, then routes one target-local-consent lease to that exact device", async () => {
    const expiresAt = new Date(Date.now() + 900_000).toISOString();
    const desktop = await startFakeRunner(gateway.port, "rt_alice2", "desktop", {
      gui_request_control: () => ({
        granted: true,
        grant_id: "gui_0123456789abcdef0123456789abcdef",
        expires_at: expiresAt,
      }),
      gui_capture_screen: () => ({
        media_type: "image/jpeg",
        data: "aW1hZ2U=",
        width: 1000,
        height: 500,
        captured_at: NOW,
        coordinate_space: { origin: "top_left", width: 1000, height: 500, display: "main" },
      }),
      gui_click: () => ({ clicked: true, authorization_active: true }),
      gui_release_control: () => ({ released: true }),
    }, {
      schema: "runner-inventory/v1",
      agent_backends: [
        { kind: "claude", available: false, split_execution: true, reason: "command_unavailable" },
        {
          kind: "codex",
          available: false,
          split_execution: false,
          split_execution_reason: "local_tools_unfilterable",
          reason: "command_unavailable",
        },
        { kind: "omp", available: false, split_execution: true, reason: "command_unavailable" },
      ],
      execution: {
        platform: "darwin",
        arch: "arm64",
        shell: true,
        workspace_files: true,
        workspace_count: 0,
        codex_exec_server: false,
      },
      gui_automation: {
        available: true,
        protocol: "runner-macos-gui/v1",
        consent_ttl_seconds: 900,
      },
    });
    try {
      expect(caps.listGuiAutomationTargets("alice")).toEqual([]);
      expect(caps.setGuiAutomationEnabled("alice", "desktop", true, NOW, "alice"))
        .toMatchObject({ changed: true, onlineApplied: true });
      expect(caps.listGuiAutomationTargets("alice")).toEqual([
        expect.objectContaining({ device: "desktop", gui_automation: expect.objectContaining({ display: "main" }) }),
      ]);
      expect(caps.listGuiAutomationTargets("bob")).toEqual([]);

      const lease = await caps.openGuiAutomation({
        username: "alice",
        controllerDevice: "laptop",
        targetDevice: "desktop",
      });
      expect(lease.description).toMatchObject({ granted: true, expires_at: expiresAt });
      expect(desktop.frames[0]).toEqual({
        method: "gui_request_control",
        args: {
          controller_label: "Octopus Agent on laptop",
        },
      });
      await expect(lease.call("capture_screen", {})).resolves.toMatchObject({ width: 1000, height: 500 });
      await expect(lease.call("click", { x: 200, y: 100 })).resolves.toMatchObject({ clicked: true });
      expect(desktop.frames.map((frame) => frame.method)).toEqual([
        "gui_request_control",
        "gui_capture_screen",
        "gui_click",
      ]);
      expect(alice.frames).toHaveLength(0);
      expect(bob.frames).toHaveLength(0);

      expect(caps.setGuiAutomationEnabled("alice", "desktop", false, NOW, "alice"))
        .toMatchObject({ changed: true, onlineApplied: true });
      await vi.waitFor(() => expect(desktop.frames.map((frame) => frame.method)).toContain("gui_release_control"));
      await expect(lease.call("click", { x: 1, y: 1 })).rejects.toThrow(/expired|not active|closed/i);
    } finally {
      desktop.close();
    }
  });

  it("Alice's Context reads Alice's Runner with no per-call approval", async () => {
    const grant = caps.open({ username: "alice", purpose: "test", kind: "session", rights: SESSION_READ_OPS })!;
    const out = await grant.request("list_recent_sessions", { limit: 5 });
    expect(out.status).toBe("succeeded");
    expect(alice.frames.map((f) => f.method)).toEqual(["list_recent_sessions"]);
    expect(bob.frames).toHaveLength(0);
  });

  it("serves twelve post-Gate materialized reads with zero Runner RPCs", async () => {
    const narrow = caps.open({
      username: "alice",
      purpose: "projection-denied",
      kind: "session",
      rights: ["search_sessions"],
    })!;
    expect((await narrow.request("list_recent_sessions", { limit: 5 })).status).toBe("denied");
    expect(projectionReads).toHaveLength(0);

    projectionHit = { devices: ["laptop"], total_found: 1, sessions: [{ id: "cached", source: "claude" }] };
    const granted = caps.open({
      username: "alice",
      purpose: "projection-allowed",
      kind: "session",
      rights: ["list_recent_sessions"],
    })!;
    const outputs = [];
    for (let index = 0; index < 12; index += 1) {
      outputs.push(await granted.request("list_recent_sessions", { limit: 5 }));
    }
    expect(outputs.every((out) => out.status === "succeeded")).toBe(true);
    expect(outputs[0]).toMatchObject({ status: "succeeded", result: { sessions: [{ id: "cached" }] } });
    expect(projectionReads).toHaveLength(12);
    expect(projectionReads.every((read) => read.owner === "alice" && read.operation === "list_recent_sessions")).toBe(true);
    expect(alice.frames).toHaveLength(0);
    expect(bob.frames).toHaveLength(0);
  });

  it("keeps per-device cached fanout behind the owner Gate and revocation", async () => {
    const denied = caps.open({ username: "alice", purpose: "cache-denied", kind: "session", rights: ["search_sessions"] })!;
    expect((await denied.request("list_recent_sessions", { limit: 5 })).status).toBe("denied");
    expect(projectionDeviceReads).toEqual([]);
    projectionDeviceHit = { total_found: 1, sessions: [{ id: "cached-alice", source: "codex" }] };
    const grant = caps.open({ username: "alice", purpose: "cache-allowed", kind: "session", rights: ["list_recent_sessions"] })!;
    expect(await grant.request("list_recent_sessions", { limit: 5 })).toMatchObject({
      status: "succeeded", result: { sessions: [{ id: "cached-alice", device: "laptop" }] },
    });
    expect(projectionDeviceReads).toEqual([{ owner: "alice", device: "laptop" }]);
    expect(alice.frames).toHaveLength(0);
    expect(bob.frames).toHaveLength(0);
    caps.revokeAccount("alice");
    expect((await grant.request("list_recent_sessions", { limit: 5 })).status).toBe("denied");
    expect(projectionDeviceReads).toHaveLength(1);
  });

  it("admits OMP as a first-class session source through the Gate", async () => {
    const grant = caps.open({ username: "alice", purpose: "test-omp", kind: "session", rights: SESSION_READ_OPS })!;
    expect((await grant.request("list_recent_sessions", { source: "omp", limit: 5 })).status).toBe("succeeded");
    expect((await grant.request("read_session", { source: "omp", id: "omp-1" })).status).toBe("succeeded");
    expect(alice.frames).toEqual([
      { method: "list_recent_sessions", args: { source: "omp", limit: 5 } },
      { method: "read_session", args: { source: "omp", id: "omp-1" } },
    ]);
    expect(bob.frames).toHaveLength(0);
  });

  it("an owner's chat agent silently uses its explicitly granted machine surface", async () => {
    const chat = caps.open({
      username: "alice",
      purpose: "chat-machines/alice",
      kind: "agent-run",
      rights: MACHINE_OPS,
      autoAllow: MACHINE_AUTO_ALLOW,
    })!;
    expect((await chat.request("__list_devices", {})).status).toBe("succeeded");
    expect((await chat.request("host_info", { device: "laptop" })).status).toBe("succeeded");
    expect((await chat.request("list_dir", { device: "laptop", path: "/home/alice" })).status).toBe("succeeded");
    const read = await chat.request("read_file", { device: "laptop", path: "/home/alice/.ssh/id_ed25519" });
    expect(read.status).toBe("succeeded");
    expect(alice.frames.filter((f) => f.method === "read_file")).toHaveLength(1);
    expect(caps.listPending("alice")).toHaveLength(0);
  });

  it("a device-scoped CI grant cannot enumerate or address another owner device", async () => {
    const ciOps = MACHINE_OPS.filter((operation) => operation !== "__list_devices");
    const grant = caps.open({
      username: "alice",
      purpose: "dev-ticket/232",
      kind: "agent-run",
      rights: ciOps,
      autoAllow: ciOps,
      metadata: { runner_device_scope: "laptop" },
    })!;

    expect((await grant.request("__list_devices", {})).status).toBe("denied");
    const wrong = await grant.request("exec", { device: "desktop", command: "whoami" });
    expect(wrong.status).toBe("denied");
    if (wrong.status === "denied") expect(wrong.reason).toContain("outside the bound resource scope");
    expect(alice.frames).toHaveLength(0);

    expect((await grant.request("exec", { device: "laptop", command: "whoami" })).status).toBe("succeeded");
    expect(alice.frames.map((frame) => frame.method)).toEqual(["exec"]);
    expect(bob.frames).toHaveLength(0);
  });

  /**
   * P1-3: a panel surface is one Context, not one per HTTP request.
   *
   * Every anti-duplicate and anti-abuse mechanism in the kernel is keyed on the
   * Context, because a Context is meant to be a lifecycle. Deriving one per POST
   * disabled all of them silently: a double-clicked "续跑" produced two cards for
   * one intent, approving both was two headless turns, and `maxPendingPerContext`
   * counted zero forever.
   */
  it("a re-submitted identical action joins the card that already exists", async () => {
    const request = (): Promise<{ status: string; pendingCallId?: string }> => {
      // What the panel does per POST: derive, use, release.
      const g = caps.open({
        username: "alice",
        purpose: "dashboard-append/alice",
        kind: "session",
        rights: ["append_session"],
        pool: "dashboard-append",
      })!;
      const out = g.request("append_session", { device: "laptop", id: "s1", prompt: "继续" });
      g.close();
      return out as Promise<{ status: string; pendingCallId?: string }>;
    };
    const first = await request();
    const second = await request();
    expect(first.status).toBe("approval_required");
    expect(second.pendingCallId).toBe(first.pendingCallId);
    expect(caps.listPending("alice")).toHaveLength(1);
    // One approval, one frame — not two.
    expect((await caps.approve(first.pendingCallId!, "alice")).status).toBe("succeeded");
    expect(alice.frames.filter((f) => f.method === "append_session")).toHaveLength(1);
  });

  it("two genuinely different actions still get their own card", async () => {
    const g = () =>
      caps.open({
        username: "alice",
        purpose: "dashboard-append/alice",
        kind: "session",
        rights: ["append_session"],
        pool: "dashboard-append",
      })!;
    await g().request("append_session", { device: "laptop", id: "s1", prompt: "一" });
    await g().request("append_session", { device: "laptop", id: "s1", prompt: "二" });
    expect(caps.listPending("alice")).toHaveLength(2);
  });

  it("a pooled Context does not survive the device that justified it", async () => {
    const pooled = () =>
      caps.open({
        username: "alice",
        purpose: "dashboard-read/alice",
        kind: "session",
        rights: ["read_session"],
        pool: "dashboard-read",
      });
    const before = pooled()!.contextId;
    expect(pooled()!.contextId).toBe(before); // same surface, same Context
    caps.revokeAccount("alice");
    // A cached Context whose root is revoked is not handed out again; the next
    // call derives from the fresh root instead.
    const after = pooled();
    expect(after).not.toBeNull();
    expect(after!.contextId).not.toBe(before);
    expect((await after!.request("read_session", { id: "s1" })).status).toBe("succeeded");
  });

  it("a grant that auto-allows a read does not queue a card for it", async () => {
    // Same Object, same operation class, different terms — and the policy has no
    // idea which caller it is serving.
    const archive = caps.open({
      username: "alice",
      purpose: "report-archive/alice",
      kind: "job",
      rights: ARCHIVE_OPS,
    })!;
    expect((await archive.request("copy_session", { id: "s1" })).status).toBe("succeeded");
    expect(caps.listPending("alice")).toHaveLength(0);
  });

  it("args naming another user cannot re-address the adapter", async () => {
    const grant = caps.open({ username: "alice", purpose: "test", kind: "session", rights: SESSION_READ_OPS })!;
    // `who` is not in the closed schema at all, so it is refused outright;
    // even a schema-legal arg could only ever reach alice's fixed binding.
    const spoof = await grant.request("list_recent_sessions", { limit: 1, who: "bob" });
    expect(spoof.status).toBe("denied");
    expect(alice.frames).toHaveLength(0);
    expect(bob.frames).toHaveLength(0);
  });

  it("a slot that does not exist in this Context is denied", async () => {
    const grant = caps.open({ username: "alice", purpose: "test", kind: "session", rights: SESSION_READ_OPS })!;
    const out = await grant.capabilities.request("runner-of-bob", "list_recent_sessions", {});
    expect(out.status).toBe("denied");
    expect(alice.frames).toHaveLength(0);
    expect(bob.frames).toHaveLength(0);
  });

  it("an unknown Runner method is denied by default", async () => {
    const grant = caps.open({ username: "alice", purpose: "test", kind: "session", rights: RUNNER_READ_OPS })!;
    const out = await grant.capabilities.request("runner", "nuke_from_orbit", {});
    expect(out.status).toBe("denied");
    expect(alice.frames).toHaveLength(0);
  });

  it("a user with no account row gets no authority at all", () => {
    expect(caps.open({ username: "mallory", purpose: "x", kind: "session", rights: RUNNER_READ_OPS })).toBeNull();
    expect(caps.open({ username: "", purpose: "x", kind: "session", rights: RUNNER_READ_OPS })).toBeNull();
  });

  it("__list_devices answers from the trusted registry without a frame", async () => {
    const grant = caps.open({ username: "alice", purpose: "test", kind: "session", rights: MACHINE_OPS })!;
    const out = await grant.request("__list_devices", {});
    expect(out).toMatchObject({ status: "succeeded" });
    expect(alice.frames).toHaveLength(0);
  });
});

describe("acceptance: rights attenuation across App → Controller → AgentRun", () => {
  it("a derived run can only use the intersection", async () => {
    const app = caps.open({
      username: "alice",
      purpose: "app:reports",
      kind: "app-instance",
      rights: [...SESSION_READ_OPS, ...ARCHIVE_OPS],
    })!;
    const run = caps.open({
      username: "alice",
      purpose: "agent-run:r17",
      kind: "agent-run",
      rights: ["read_session"],
      parent: app,
    })!;
    expect((await run.request("read_session", { id: "s1" })).status).toBe("succeeded");
    // Declared by the App but NOT by this run: denied even though the parent holds it.
    expect((await run.request("copy_session", { id: "s1" })).status).toBe("denied");
    expect(alice.frames.map((f) => f.method)).toEqual(["read_session"]);
  });

  it("a run cannot ask for more than its parent holds", () => {
    const app = caps.open({
      username: "alice",
      purpose: "app:reports",
      kind: "app-instance",
      rights: ["read_session"],
    })!;
    const run = caps.open({
      username: "alice",
      purpose: "agent-run:r18",
      kind: "agent-run",
      rights: ["exec"],
      parent: app,
    });
    expect(run).toBeNull();
  });

  it("a Context cannot be re-parented onto another owner's authority", () => {
    const aliceApp = caps.open({
      username: "alice",
      purpose: "app:reports",
      kind: "app-instance",
      rights: ["read_session"],
    })!;
    expect(
      caps.open({ username: "bob", purpose: "x", kind: "agent-run", rights: ["read_session"], parent: aliceApp }),
    ).toBeNull();
  });

  it("destroying the App Context kills the AgentRun derived from it", async () => {
    const app = caps.open({
      username: "alice",
      purpose: "app:reports",
      kind: "app-instance",
      rights: ["read_session"],
    })!;
    const run = caps.open({
      username: "alice",
      purpose: "agent-run:r19",
      kind: "agent-run",
      rights: ["read_session"],
      parent: app,
    })!;
    app.destroy();
    expect((await run.request("read_session", { id: "s1" })).status).toBe("denied");
    expect(alice.frames).toHaveLength(0);
  });
});

describe("acceptance: cross-user isolation", () => {
  it("Bob's Runner never receives a frame from Alice's authority", async () => {
    const aliceGrant = caps.open({ username: "alice", purpose: "test", kind: "session", rights: RUNNER_READ_OPS })!;
    for (const op of ["read_file", "read_session", "copy_session"]) {
      await aliceGrant.request(
        op,
        op === "read_file" ? { device: "laptop", path: "/home/bob/.ssh/id_ed25519" } : { id: "s1" },
      );
    }
    expect(bob.frames).toHaveLength(0);
    expect(alice.frames.length).toBe(3);
  });

  it("revoking Alice's account authority stops every existing grant", async () => {
    const grant = caps.open({ username: "alice", purpose: "test", kind: "session", rights: RUNNER_READ_OPS })!;
    expect((await grant.request("read_session", { id: "s1" })).status).toBe("succeeded");
    caps.revokeAccount("alice");
    expect((await grant.request("read_session", { id: "s1" })).status).toBe("denied");
    expect(alice.frames).toHaveLength(1);
  });
});

describe("acceptance: mutating operations need trusted approval", () => {
  // `device` is required on every machine op: the approval card has to name the
  // box, and "the only one online" is resolved after the human clicks.
  const cases: Array<[string, Record<string, unknown>]> = [
    ["exec", { device: "laptop", command: "ls -la" }],
    ["write_file", { device: "laptop", path: "/tmp/x", content: "hi" }],
    ["append_session", { device: "laptop", id: "s1", prompt: "continue" }],
    ["start_session", {
      device: "laptop",
      workspace_id: "ws_0123456789abcdef01234567",
      workspace_label: "Demo",
      workspace_display: "~/demo",
      source: "claude",
      prompt: "start",
      client_request_id: "op_12345678",
    }],
  ];

  for (const [op, args] of cases) {
    it(`${op} reaches no frame before approval, exactly one after`, async () => {
      const grant = caps.open({ username: "alice", purpose: "chat", kind: "agent-run", rights: RUNNER_WRITE_OPS })!;
      const out = await grant.request(op, args);
      expect(out.status).toBe("approval_required");
      expect(alice.frames).toHaveLength(0);
      const id = (out as { pendingCallId: string }).pendingCallId;

      const wrong = await caps.approve(id, "bob");
      expect(wrong.status).toBe("denied");
      expect(alice.frames).toHaveLength(0);

      const ok = await caps.approve(id, "alice");
      expect(ok.status).toBe("succeeded");
      expect(alice.frames.map((f) => f.method)).toEqual([op]);
      expect(bob.frames).toHaveLength(0);
    });
  }

  it("`exec ls` is still an exec — read-looking shell text changes nothing", async () => {
    const grant = caps.open({ username: "alice", purpose: "chat", kind: "agent-run", rights: ["exec"] })!;
    for (const command of ["ls", "cat /etc/passwd", "echo hi"]) {
      const out = await grant.request("exec", { device: "laptop", command });
      expect(out.status).toBe("approval_required");
    }
    expect(alice.frames).toHaveLength(0);
  });

  it("a double-click approval produces at most one frame", async () => {
    const grant = caps.open({ username: "alice", purpose: "chat", kind: "agent-run", rights: ["exec"] })!;
    const out = await grant.request("exec", { device: "laptop", command: "whoami" });
    const id = (out as { pendingCallId: string }).pendingCallId;
    const results = await Promise.all([caps.approve(id, "alice"), caps.approve(id, "alice")]);
    expect(results.filter((r) => r.status === "succeeded")).toHaveLength(1);
    expect(alice.frames).toHaveLength(1);
  });

  it("replaying the same pending id returns the recorded result, never a second frame", async () => {
    const grant = caps.open({ username: "alice", purpose: "chat", kind: "agent-run", rights: ["exec"] })!;
    const out = await grant.request("exec", { device: "laptop", command: "whoami" });
    const id = (out as { pendingCallId: string }).pendingCallId;
    const first = await caps.approve(id, "alice");
    expect(first.status).toBe("succeeded");
    // A retry is answered from the durable record: the caller learns what
    // happened without the laptop being asked twice.
    expect(await caps.approve(id, "alice")).toEqual(first);
    expect(alice.frames).toHaveLength(1);
  });

  it("rejecting means no frame, ever", async () => {
    const grant = caps.open({ username: "alice", purpose: "chat", kind: "agent-run", rights: ["exec"] })!;
    const out = await grant.request("exec", { device: "laptop", command: "rm -rf /" });
    const id = (out as { pendingCallId: string }).pendingCallId;
    expect(caps.reject(id, "bob")).toBe(false);
    expect(caps.reject(id, "alice")).toBe(true);
    expect((await caps.approve(id, "alice")).status).toBe("denied");
    expect(alice.frames).toHaveLength(0);
  });

  it("revoking the authority between request and approval fails closed", async () => {
    const grant = caps.open({ username: "alice", purpose: "chat", kind: "agent-run", rights: ["exec"] })!;
    const out = await grant.request("exec", { device: "laptop", command: "whoami" });
    const id = (out as { pendingCallId: string }).pendingCallId;
    caps.revokeAccount("alice");
    expect((await caps.approve(id, "alice")).status).toBe("denied");
    expect(alice.frames).toHaveLength(0);
  });

  it("destroying the requesting run between request and approval fails closed", async () => {
    const grant = caps.open({ username: "alice", purpose: "chat", kind: "agent-run", rights: ["exec"] })!;
    const out = await grant.request("exec", { device: "laptop", command: "whoami" });
    const id = (out as { pendingCallId: string }).pendingCallId;
    grant.destroy(); // the run ended — hard termination, not a polite release
    expect((await caps.approve(id, "alice")).status).toBe("denied");
    expect(alice.frames).toHaveLength(0);
  });

  it("expiry is enforced at approval time", async () => {
    let now = 1_000_000;
    const gw2 = new RunnerGateway(store, { port: 0 });
    await gw2.start();
    const caps2 = new RunnerCapabilities(store, gw2.claimTransport(), { now: () => now, pendingTtlMs: 60_000 });
    const r = await startFakeRunner(gw2.port, "rt_alice", "laptop", echo);
    try {
      const grant = caps2.open({ username: "alice", purpose: "chat", kind: "agent-run", rights: ["exec"] })!;
      const out = await grant.request("exec", { device: "laptop", command: "whoami" });
      const id = (out as { pendingCallId: string }).pendingCallId;
      now += 61_000;
      expect((await caps2.approve(id, "alice")).status).toBe("denied");
      expect(r.frames).toHaveLength(0);
    } finally {
      r.close();
      await gw2.stop();
    }
  });

  it("only the device owner sees the pending card, and its summary is server-authored", async () => {
    const grant = caps.open({ username: "alice", purpose: "chat-machines/alice", kind: "agent-run", rights: ["exec"] })!;
    await grant.request("exec", { device: "laptop", command: "sudo rm -rf /" });
    expect(caps.listPending("bob")).toHaveLength(0);
    const mine = caps.listPending("alice");
    expect(mine).toHaveLength(1);
    // The card names the machine the FROZEN ARGS name. It used to say
    // "(唯一在线设备)" and let the gateway pick one after the click, so the
    // approved call and the executed call could be on different boxes.
    expect(mine[0].target).toBe("alice/laptop");
    expect(mine[0].details.join(" ")).toContain("sudo rm -rf /");
    expect(mine[0].requestedBy.purpose).toBe("chat-machines/alice");
  });

  it("a split launch card names both physical machines and their distinct roles", async () => {
    const grant = caps.open({ username: "alice", purpose: "session-plus", kind: "agent-run", rights: ["start_session"] })!;
    await grant.request("start_session", {
      device: "laptop",
      execution_device: "desktop",
      workspace_id: "ws_0123456789abcdef01234567",
      workspace_label: "Demo",
      workspace_display: "~/demo",
      source: "claude",
      prompt: "start",
      client_request_id: "op_split_card",
    });
    const card = caps.listPending("alice")[0]!;
    expect(card.target).toBe("alice/laptop");
    expect(card.details).toContain("Agent 运行机：laptop");
    expect(card.details).toContain("命令与文件执行机：desktop");
    expect(card.details.join(" ")).toContain("本地命令与文件工具会被关闭");
  });

  it("runs the post-Gate launch cleanup hook on a determinate Runner result", async () => {
    const afterResult = vi.fn();
    caps.installDispatchPreparer(async (_owner, _operation, args) => ({ args, afterResult }));
    const grant = caps.open({
      username: "alice",
      purpose: "session-plus",
      kind: "agent-run",
      rights: ["start_session"],
      autoAllow: ["start_session"],
    })!;
    const out = await grant.request("start_session", {
      device: "laptop",
      execution_device: "desktop",
      workspace_id: "ws_0123456789abcdef01234567",
      workspace_label: "Demo",
      workspace_display: "~/demo",
      source: "claude",
      prompt: "start",
      client_request_id: "op_cleanup_hook",
    });
    expect(out.status).toBe("succeeded");
    expect(afterResult).toHaveBeenCalledWith({ ok: true, session_id: "new-session" });
  });

  it("runs the trusted dispatch preparer again for a session continuation", async () => {
    const prepare = vi.fn(async (_owner: string, _operation: string, args: Readonly<Record<string, unknown>>) => ({
      args: { ...args, _octopus_execution_mcp_token: "mcp_resume" },
    }));
    caps.installDispatchPreparer(prepare);
    const grant = caps.open({
      username: "alice",
      purpose: "session-plus",
      kind: "agent-run",
      rights: ["append_session"],
      autoAllow: ["append_session"],
    })!;
    const out = await grant.request("append_session", {
      device: "laptop",
      source: "claude",
      id: "session-a",
      prompt: "continue",
    });
    expect(out.status).toBe("succeeded");
    expect(prepare).toHaveBeenCalledWith(
      "alice",
      "append_session",
      expect.objectContaining({ id: "session-a" }),
    );
  });

  it("routes only the closed Agent session operation set across owners", async () => {
    projectionHit = { id: "cached-owner-row", messages: [] };
    caps.installDispatchPreparer(async (_owner, _operation, args) => ({
      args,
      dispatchOwner: "bob",
    }));
    const sessions = caps.open({
      username: "alice",
      purpose: "borrowed-agent-runtime",
      kind: "agent-run",
      rights: ["start_session", "read_session"],
      autoAllow: ["start_session", "read_session"],
    })!;

    expect((await sessions.request("start_session", {
      device: "laptop",
      execution_device: "desktop",
      workspace_id: "ws_0123456789abcdef01234567",
      workspace_label: "Demo",
      workspace_display: "~/demo",
      source: "claude",
      prompt: "start",
      client_request_id: "op_borrowed_runtime",
    })).status).toBe("succeeded");
    expect((await sessions.request("read_session", {
      device: "laptop",
      source: "claude",
      id: "session-a",
    })).status).toBe("succeeded");
    expect(alice.frames).toHaveLength(0);
    expect(bob.frames.map((frame) => frame.method)).toEqual(["start_session", "read_session"]);
    expect(projectionReads).toHaveLength(0);

    const machine = caps.open({
      username: "alice",
      purpose: "borrowed-agent-runtime-negative",
      kind: "agent-run",
      rights: ["exec"],
      autoAllow: ["exec"],
    })!;
    const blocked = await machine.request("exec", { device: "laptop", command: "whoami" });
    expect(blocked).toMatchObject({
      status: "failed",
      reason: expect.stringMatching(/restricted to bound Agent session operations/),
    });
    expect(bob.frames.map((frame) => frame.method)).toEqual(["start_session", "read_session"]);
  });

  /**
   * The approval has to bind the TARGET, not just the command.
   *
   * Before this, `device` was optional and the gateway resolved "the single
   * online device" inside the adapter — which for a dangerous call runs after
   * the human clicked. So a card could be created while two machines were
   * online (the ambiguity check lives in the adapter, which an
   * approval_required call never reaches), and the machine it landed on was
   * whichever one happened to be alone at approval time.
   */
  it("a machine call with no device never becomes a card", async () => {
    const grant = caps.open({ username: "alice", purpose: "chat", kind: "agent-run", rights: RUNNER_WRITE_OPS })!;
    const out = await grant.request("exec", { command: "whoami" });
    expect(out.status).toBe("denied");
    expect(caps.listPending("alice")).toHaveLength(0);
    expect(alice.frames).toHaveLength(0);
  });

  it("the approved device is the executed device, even when the online set moves", async () => {
    // Two machines online when the card is made; the args pin one of them.
    const second = await startFakeRunner(gateway.port, "rt_alice2", "desktop", echo);
    try {
      const grant = caps.open({ username: "alice", purpose: "chat", kind: "agent-run", rights: ["exec"] })!;
      const out = await grant.request("exec", { device: "laptop", command: "whoami" });
      expect(out.status).toBe("approval_required");
      expect(caps.listPending("alice")[0].target).toBe("alice/laptop");

      // The laptop goes away before the owner clicks, leaving the desktop as
      // the only machine online. The old code would have run it there.
      alice.ws.terminate();
      await vi.waitFor(
        () => expect(gateway.listDevices("alice").find((row) => row.device === "laptop")?.online).toBe(false),
        { timeout: 1_000 },
      );
      const id = (out as { pendingCallId: string }).pendingCallId;
      const decided = await caps.approve(id, "alice");
      expect(decided.status).toBe("failed");
      expect(second.frames).toHaveLength(0);
    } finally {
      second.close();
    }
  });
});

describe("acceptance: transport credentials carry no identity", () => {
  let loopback: CapabilityLoopback;

  beforeEach(async () => {
    loopback = new CapabilityLoopback();
    await loopback.start();
  });
  afterEach(async () => {
    await loopback.stop();
  });

  it("forwards an authorized read and refuses an unknown token", async () => {
    const grant = caps.open({ username: "alice", purpose: "mcp", kind: "agent-run", rights: SESSION_READ_OPS })!;
    const token = loopback.mint(grant.capabilities, "mcp/alice");

    const forbidden = await fetch(`${loopback.url}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": "wrong" },
      body: JSON.stringify({ operation: "search_sessions", args: { query: "x" } }),
    });
    expect(forbidden.status).toBe(403);
    expect(alice.frames).toHaveLength(0);

    const ok = await fetch(`${loopback.url}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": token },
      body: JSON.stringify({ operation: "search_sessions", args: { query: "x" } }),
    });
    expect(ok.status).toBe(200);
    expect(alice.frames.map((f) => f.method)).toEqual(["search_sessions"]);
  });

  it("rejects a body that states an identity instead of cross-checking it", async () => {
    const grant = caps.open({ username: "alice", purpose: "mcp", kind: "agent-run", rights: SESSION_READ_OPS })!;
    const token = loopback.mint(grant.capabilities, "mcp/alice");
    for (const claim of [{ user: "bob" }, { username: "bob" }, { approved: true }, { appId: "x" }]) {
      const r = await fetch(`${loopback.url}/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-token": token },
        body: JSON.stringify({ operation: "search_sessions", args: { query: "x" }, ...claim }),
      });
      expect(r.status).toBe(400);
    }
    expect(alice.frames).toHaveLength(0);
    expect(bob.frames).toHaveLength(0);
  });

  it("Bob's MCP token cannot reach Alice's laptop by any wording", async () => {
    const bobGrant = caps.open({ username: "bob", purpose: "mcp", kind: "agent-run", rights: SESSION_READ_OPS })!;
    const token = loopback.mint(bobGrant.capabilities, "mcp/bob");
    const r = await fetch(`${loopback.url}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": token },
      body: JSON.stringify({ operation: "read_session", args: { id: "alice-secret" } }),
    });
    expect(r.status).toBe(200);
    expect(alice.frames).toHaveLength(0);
    expect(bob.frames.map((f) => f.method)).toEqual(["read_session"]);
  });

  it("a mutating operation over the loopback returns approval_required, not a result", async () => {
    const grant = caps.open({ username: "alice", purpose: "mcp", kind: "agent-run", rights: RUNNER_WRITE_OPS })!;
    const token = loopback.mint(grant.capabilities, "mcp/alice");
    const r = await fetch(`${loopback.url}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": token },
      body: JSON.stringify({ operation: "exec", args: { device: "laptop", command: "ls" } }),
    });
    expect(r.status).toBe(202);
    const body = (await r.json()) as { approval_required: boolean; pending_call_id: string };
    expect(body.approval_required).toBe(true);
    expect(alice.frames).toHaveLength(0);
    expect((await caps.approve(body.pending_call_id, "alice")).status).toBe("succeeded");
    expect(alice.frames.map((f) => f.method)).toEqual(["exec"]);
  });

  it("an expired transport credential stops working and is pruned", async () => {
    const grant = caps.open({ username: "alice", purpose: "mcp", kind: "agent-run", rights: SESSION_READ_OPS })!;
    const token = loopback.mint(grant.capabilities, "mcp/alice", -1);
    const r = await fetch(`${loopback.url}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": token },
      body: JSON.stringify({ operation: "search_sessions", args: {} }),
    });
    expect(r.status).toBe(403);
    expect(loopback.liveGrants).toBe(0);
    expect(alice.frames).toHaveLength(0);
  });
});

describe("acceptance: failure modes fail closed", () => {
  it("an offline device is an error, not a fallback", async () => {
    bob.close();
    await new Promise((r) => setTimeout(r, 60));
    const grant = caps.open({ username: "bob", purpose: "test", kind: "session", rights: SESSION_READ_OPS })!;
    const out = await grant.request("read_session", { id: "s1" });
    expect(out.status).toBe("failed");
    expect(alice.frames).toHaveLength(0);
  });

  it("the gateway's raw transport can only be claimed once", async () => {
    const gw = new RunnerGateway(store, { port: 0 });
    await gw.start();
    try {
      gw.claimTransport();
      expect(() => gw.claimTransport()).toThrow(/already claimed/);
    } finally {
      await gw.stop();
    }
  });
});

describe("grant lifetime around an undecided approval", () => {
  it("close() defers teardown while a pending call is undecided, then tears down", async () => {
    const grant = caps.open({ username: "alice", purpose: "chat", kind: "agent-run", rights: ["exec"] })!;
    const out = await grant.request("exec", { device: "laptop", command: "whoami" });
    const id = (out as { pendingCallId: string }).pendingCallId;
    // The HTTP handler that created the request is finished and releases it —
    // which must NOT invalidate the approval the user is about to give.
    grant.close();
    expect((await caps.approve(id, "alice")).status).toBe("succeeded");
    expect(alice.frames).toHaveLength(1);
    // Once decided, the deferred teardown lands: the Context is gone.
    caps.listPending("alice");
    expect((await grant.request("exec", { device: "laptop", command: "again" })).status).toBe("denied");
    expect(alice.frames).toHaveLength(1);
  });
});


it("preserves native CLI ownership and workspace constraints in the exact Runner frame", async () => {
  const grant = caps.open({ username: "alice", purpose: "ticket-runner", kind: "job", rights: ["append_session"], autoAllow: ["append_session"] })!;
  try {
    const out = await grant.request("append_session", { device: "laptop", id: "native-session", source: "codex", prompt: "continue",
      operation_id: "native-test", native_cli_only: true, native_workspace_id: "workspace", native_relative_path: "feature" });
    expect(out.status).toBe("succeeded");
    expect(alice.frames.find(frame => frame.method === "append_session")?.args).toMatchObject({
      id: "native-session", native_cli_only: true, native_workspace_id: "workspace", native_relative_path: "feature", operation_id: "native-test",
    });
    expect(bob.frames).toEqual([]);
  } finally { grant.destroy(); }
});
