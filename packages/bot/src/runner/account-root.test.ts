/**
 * Exactly one live account root per (account, Object), across real restarts —
 * plus the fail-safe ordering of the device-credential lifecycle.
 *
 * `authorities` was memory-only. On a second service lifetime over the SAME
 * capability database, `authorityFor` found the persisted Object identity,
 * minted a BRAND NEW root, and cached that — while the previous root and every
 * capability derived from it stayed live in the store. Revoking the new tree
 * left the old one working, which is the whole point of revocation undone.
 *
 * `lifetime()` is what makes the restart cases mean anything: it opens a NEW
 * `CapabilityService` over the same SQLite file. A test that closed the first
 * repository and then kept calling through the first service — or through a
 * grant object that closed over it — would only be proving that an in-memory
 * handle still worked, which is not what surviving a restart is. Everything
 * after a `repo.close()` below goes through the new service, and the adapter is
 * re-registered there by `ensureAccount` before anything is expected to work.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityService, SqliteCapabilityStore } from "@claude-bot/capability-kernel";
import { Store } from "../store/store.js";
import { RunnerGateway, hashRunnerToken } from "./gateway.js";
import {
  RUNNER_ACCOUNT_OBJECT_PREFIX,
  RUNNER_OPERATIONS,
  RunnerCapabilities,
  SESSION_READ_OPS,
} from "./capability.js";
import { startFakeRunner, type FakeRunner } from "./fake-runner.helper.js";
import { sessionDirectoryPlacement } from "./session-catalog.js";

const NOW = "2026-07-29T00:00:00.000Z";
const RUNNER_V4_OPERATIONS = [
  "__list_devices",
  "append_session",
  "copy_file",
  "copy_session",
  "digest_recent_sessions",
  "exec",
  "host_info",
  "list_dir",
  "list_recent_sessions",
  "list_session_workspaces",
  "open_dsh_tunnel",
  "open_workspace_terminal",
  "read_file",
  "read_session",
  "search_sessions",
  "start_session",
  "workspace_terminal",
  "write_file",
] as const;

let dir: string;
let store: Store;
let gateway: RunnerGateway;
let transport: import("./gateway.js").RunnerTransport;
let alice: FakeRunner | null = null;
const repos: SqliteCapabilityStore[] = [];

/** A fresh service lifetime over the same durable capability database. */
function lifetime(): { svc: CapabilityService; caps: RunnerCapabilities; repo: SqliteCapabilityStore } {
  const repo = new SqliteCapabilityStore(join(dir, "cap.db"));
  repos.push(repo);
  const svc = new CapabilityService({ store: repo });
  const caps = new RunnerCapabilities(store, transport, { service: svc });
  return { svc, caps, repo };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "root-"));
  store = new Store(join(dir, "bot.db"));
  store.saveUser({ username: "alice", uid: 5001, home_dir: "/x/alice", created_at: NOW });
  store.saveRunnerToken(hashRunnerToken("rt_alice"), "alice", "laptop", NOW);
  gateway = new RunnerGateway(store, { port: 0 });
  await gateway.start();
  transport = gateway.claimTransport();
  alice = await startFakeRunner(gateway.port, "rt_alice", "laptop", {
    list_recent_sessions: () => ({
      total_found: 1,
      sessions: [{ id: "ordinary", source: "codex", last_activity: "2026-09-01T00:00:00.000Z" }],
    }),
    session_plus_list_sessions: () => ({
      total_found: 2,
      sessions: [
        { id: "split", source: "codex", last_activity: "2026-09-01T01:00:00.000Z" },
        // A compromised/stale Runner must not widen the Host catalog merely
        // because it returned another split-home transcript.
        { id: "ticket", source: "codex", last_activity: "2026-09-01T02:00:00.000Z" },
      ],
    }),
    session_plus_read_session: () => ({ rich: true, messages: [{ role: "user", text: "split" }] }),
    read_session: () => ({ ok: true }),
    exec: () => ({ ok: true }),
    append_session: () => ({ ok: true }),
  });
});

afterEach(async () => {
  alice?.close();
  for (const r of repos) {
    try {
      r.close();
    } catch {
      /* already closed */
    }
  }
  repos.length = 0;
  await gateway.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("device credential lifecycle is fail-safe under a mid-way failure", () => {
  it("rotating Windows preserves a CI device branch, including across a capability service restart", async () => {
    store.saveRunnerToken(hashRunnerToken("rt_ci"), "alice", "ci", NOW);
    let executions = 0;
    const ci = await startFakeRunner(gateway.port, "rt_ci", "ci", {
      exec: () => { executions++; return { ok: true }; },
    });
    try {
      const first = lifetime();
      const ciGrant = first.caps.open({ username: "alice", purpose: "ticket", kind: "agent-run",
        device: "ci", rights: ["exec"], autoAllow: ["exec"] })!;
      const windowsGrant = first.caps.open({ username: "alice", purpose: "windows", kind: "agent-run",
        device: "laptop", rights: ["exec"], autoAllow: ["exec"] })!;
      const child = first.caps.open({ username: "alice", purpose: "child", kind: "agent-run",
        parent: ciGrant, rights: ["exec"], autoAllow: ["exec"],
        metadata: { runner_device_scope: "laptop" } })!;
      expect((await child.request("exec", { device: "laptop", command: "true" })).status).toBe("denied");
      const ciManual = first.caps.open({ username: "alice", purpose: "manual CI", kind: "agent-run",
        parent: ciGrant, rights: ["exec"], autoAllow: [] })!;
      const ciPending = await ciManual.request("exec", { device: "ci", command: "approved-once" });
      expect(ciPending.status).toBe("approval_required");
      if (ciPending.status !== "approval_required") throw new Error("missing CI approval");
      const windowsManual = first.caps.open({ username: "alice", purpose: "manual Windows", kind: "agent-run",
        parent: windowsGrant, rights: ["exec"], autoAllow: [] })!;
      const windowsPending = await windowsManual.request("exec", { device: "laptop", command: "never-run" });
      expect(windowsPending.status).toBe("approval_required");
      if (windowsPending.status !== "approval_required") throw new Error("missing Windows approval");
      first.repo.close();
      const next = lifetime();
      next.caps.ensureAccount("alice");
      next.caps.mintDeviceToken("alice", "laptop");
      expect((await next.caps.approve(ciPending.pendingCallId, "alice")).status).toBe("succeeded");
      expect(next.svc.pendingState(windowsPending.pendingCallId)).toBe("expired");
      const ciCalls = next.svc.bind(ciGrant.contextId);
      expect((await ciCalls.request("runner", "exec", { device: "ci", command: "true" })).status).toBe("succeeded");
      expect(executions).toBe(2);
      expect((await next.svc.bind(windowsGrant.contextId).request("runner", "exec", {
        device: "laptop", command: "true",
      })).status).toBe("denied");
      expect((await ciCalls.request("runner", "exec", { device: "laptop", command: "true" })).status).toBe("denied");
      next.caps.revokeAccount("alice");
      expect((await ciCalls.request("runner", "exec", { device: "ci", command: "true" })).status).toBe("denied");
      expect(executions).toBe(2);
    } finally { ci.close(); }
  });

  /**
   * A Store whose `saveRunnerToken` throws, so we can stop the mint exactly
   * between "old authority revoked" and "replacement credential persisted".
   * The invariant under test is one-directional: losing availability is fine,
   * leaving the OLD authority live next to a NEW credential is not.
   */
  function storeThatCannotSave(): Store {
    const real = store;
    return new Proxy(real, {
      get(t, k, r) {
        if (k === "saveRunnerToken") {
          return () => {
            throw new Error("disk full");
          };
        }
        return Reflect.get(t, k, r) as unknown;
      },
    }) as Store;
  }

  it("a throw before the new row lands leaves no usable old authority", async () => {
    const a = lifetime();
    const grant = a.caps.open({ username: "alice", purpose: "p", kind: "session", rights: SESSION_READ_OPS })!;
    expect((await grant.request("read_session", { id: "s1" })).status).toBe("succeeded");

    const brittle = new RunnerCapabilities(storeThatCannotSave(), transport, { service: a.svc });
    expect(() => brittle.mintDeviceToken("alice", "laptop")).toThrow(/disk full/);

    // Availability is gone — no credential for that device.
    expect(store.listRunnerTokens("alice")).toHaveLength(0);
    // Authority is gone with it. This is the assertion that fails when the new
    // row is written before the old root is revoked.
    expect((await grant.request("read_session", { id: "s1" })).status).toBe("denied");
    expect(a.caps.accountAuthority("alice")).toBeNull();
  });

  it("the old token stops authenticating before the replacement exists", async () => {
    const a = lifetime();
    a.caps.ensureAccount("alice");
    const oldHash = hashRunnerToken("rt_alice");
    expect(store.getRunnerTokenByHash(oldHash)).toBeTruthy();

    const brittle = new RunnerCapabilities(storeThatCannotSave(), transport, { service: a.svc });
    expect(() => brittle.mintDeviceToken("alice", "laptop")).toThrow();
    // The window the old ordering left open: a valid old credential coexisting
    // with a live root. Neither survives.
    expect(store.getRunnerTokenByHash(oldHash)).toBeUndefined();
  });

  it("a successful mint leaves exactly one credential and one fresh root", async () => {
    const a = lifetime();
    expect(store.setRunnerLocalAgentBridgeMode(
      "alice",
      "laptop",
      "full_access",
      "2026-08-25T00:01:00.000Z",
      "alice",
    )).toBe(true);
    expect(store.setRunnerDefaultAgentInjection(
      "alice",
      "laptop",
      true,
      "2026-08-25T00:01:00.000Z",
      "alice",
    )).toBe(true);
    const before = a.caps.accountAuthority("alice")!.contextId;
    const token = a.caps.mintDeviceToken("alice", "laptop");
    expect(store.listRunnerTokens("alice")).toHaveLength(1);
    expect(store.getRunnerTokenByHash(hashRunnerToken(token))).toBeTruthy();
    expect(store.getRunnerTokenByHash(hashRunnerToken("rt_alice"))).toBeUndefined();
    const after = a.caps.accountAuthority("alice")!.contextId;
    expect(after).not.toBe(before);
    const live = a.svc.rootsOf(`${RUNNER_ACCOUNT_OBJECT_PREFIX}:alice`);
    expect(live).toHaveLength(1);
    expect(store.getRunnerDevicePolicy("alice", "laptop")).toMatchObject({
      local_agent_bridge_mode: "full_access",
      default_agent_injection: 1,
      updated_at: "2026-08-25T00:01:00.000Z",
      updated_by: "alice",
    });
  });

  it("revoke drops the credential before the authority, and both go", async () => {
    const a = lifetime();
    const grant = a.caps.open({ username: "alice", purpose: "p", kind: "session", rights: SESSION_READ_OPS })!;
    expect((await grant.request("read_session", { id: "s1" })).status).toBe("succeeded");
    expect(a.caps.revokeDeviceToken("alice", "laptop")).toBe(true);
    expect(store.getRunnerTokenByHash(hashRunnerToken("rt_alice"))).toBeUndefined();
    expect((await grant.request("read_session", { id: "s1" })).status).toBe("denied");
    expect(a.caps.accountAuthority("alice")).toBeNull();
  });
});

describe("owner root terms", () => {
  it("allow the whole closed table but do not leak through a child that omitted autoAllow", async () => {
    const a = lifetime();

    const ordinary = a.caps.open({
      username: "alice",
      purpose: "an unrelated caller",
      kind: "job",
      rights: ["append_session"],
    })!;
    const queued = await ordinary.request("append_session", {
      device: "laptop",
      id: "s1",
      prompt: "continue",
    });
    expect(queued.status).toBe("approval_required");
    expect(alice!.frames).toHaveLength(0);

    const explicit = a.caps.open({
      username: "alice",
      purpose: "trusted direct session submit",
      kind: "session",
      rights: ["append_session"],
      autoAllow: ["append_session"],
    })!;
    expect((await explicit.request("append_session", {
      device: "laptop",
      id: "s2",
      prompt: "continue",
    })).status).toBe("succeeded");
    expect(alice!.frames.map((f) => f.method)).toEqual(["append_session"]);
  });

  it.each(["list_recent_sessions", "session_plus_list_sessions"])("refuses a complete catalog page when %s fails instead of skipping its rows", async (failedMethod) => {
    const original = transport;
    transport = { ...original, dispatch: async (owner, method, args) => {
      if (method === failedMethod && typeof args.cursor === "string") throw new Error("source temporarily unavailable");
      return original.dispatch(owner, method, args);
    } };
    const a = lifetime();
    a.caps.installDispatchPreparer(async (_owner, _operation, args) => ({ args, sessionCatalog: [{
      runtimeOwner: "alice", runtimeDevice: "laptop", source: "codex", sessionId: "split",
      catalogId: `spc_${"a".repeat(64)}`, executionDevice: "exec-box", workspaceId: "ws_0123456789abcdef01234567",
      workspaceLabel: "Octopus", workspaceDisplay: "~/lht/octopus",
    }] }));
    const grant = a.caps.open({ username: "alice", purpose: "Session Plus", kind: "session",
      rights: ["list_recent_sessions"], autoAllow: ["list_recent_sessions"],
    })!;
    const result = await grant.request("list_recent_sessions", { device: "laptop", source: "codex", cursor: "", limit: 100 });
    expect(result.status).toBe("failed");
    expect(JSON.stringify(result)).toContain("部分会话来源读取失败");
  });

  it("adds split sessions only after an opted-in Gate call and exact trusted catalog routing", async () => {
    const a = lifetime();
    a.caps.installDispatchPreparer(async (_owner, _operation, args) => {
      const { _octopus_include_session_plus: include, ...ordinary } = args;
      return include === true
        ? {
            args: ordinary,
            sessionCatalog: [{
              runtimeOwner: "alice",
              runtimeDevice: "laptop",
              source: "codex" as const,
              sessionId: "split",
              catalogId: `spc_${"a".repeat(64)}`,
              executionDevice: "exec-box",
              workspaceId: "ws_0123456789abcdef01234567",
              workspaceLabel: "Octopus",
              workspaceDisplay: "~/lht/octopus",
            }],
          }
        : { args: ordinary };
    });
    const grant = a.caps.open({
      username: "alice",
      purpose: "Session Plus",
      kind: "session",
      rights: ["list_recent_sessions", "read_session"],
      autoAllow: ["list_recent_sessions", "read_session"],
    })!;

    const ordinary = await grant.request("list_recent_sessions", { source: "codex", limit: 20 });
    expect(ordinary).toMatchObject({
      status: "succeeded",
      result: { sessions: [{ id: "ordinary" }] },
    });
    expect(alice!.frames.map((frame) => frame.method)).toEqual(["list_recent_sessions"]);

    alice!.frames.length = 0;
    const listed = await grant.request("list_recent_sessions", {
      source: "codex",
      limit: 20,
      _octopus_include_session_plus: true,
    });
    expect(listed).toMatchObject({
      status: "succeeded",
      result: { total_found: 2, sessions: [{ id: "split" }, { id: "ordinary" }] },
    });
    const listResult = listed.status === "succeeded"
      ? listed.result as { sessions: Array<Record<string, unknown>> }
      : null;
    expect(listResult && sessionDirectoryPlacement(listResult, listResult.sessions[0])).toMatchObject({
      executionDevice: "exec-box",
      workspaceId: "ws_0123456789abcdef01234567",
    });
    expect(alice!.frames.map((frame) => frame.method).sort()).toEqual([
      "list_recent_sessions",
      "session_plus_list_sessions",
    ]);
    expect(alice!.frames.find((frame) => frame.method === "list_recent_sessions")?.args)
      .not.toHaveProperty("_octopus_include_session_plus");

    // An exact selector routes only its own split rows and still reaches the device.
    alice!.frames.length = 0;
    const exact = await grant.request("list_recent_sessions", {
      device: "laptop", source: "all", limit: 1, ids: "codex:split", _octopus_include_session_plus: true,
    });
    expect(exact).toMatchObject({ status: "succeeded" });
    expect(alice!.frames.map((frame) => frame.method).sort()).toEqual(["list_recent_sessions", "session_plus_list_sessions"]);
    expect(alice!.frames.find((frame) => frame.method === "list_recent_sessions")?.args).toMatchObject({ ids: "codex:split" });
    alice!.frames.length = 0;
    await grant.request("list_recent_sessions", {
      device: "laptop", source: "all", limit: 1, ids: "codex:ordinary", _octopus_include_session_plus: true,
    });
    expect(alice!.frames.map((frame) => frame.method)).toEqual(["list_recent_sessions"]);

    alice!.frames.length = 0;
    const read = await grant.request("read_session", {
      device: "laptop",
      source: "codex",
      id: "split",
      rich: true,
      _octopus_include_session_plus: true,
    });
    expect(read).toMatchObject({ status: "succeeded", result: { rich: true } });
    expect(alice!.frames).toEqual([expect.objectContaining({
      method: "session_plus_read_session",
      args: expect.objectContaining({
        id: "split",
        source: "codex",
        _octopus_session_catalog: [expect.objectContaining({ id: "split" })],
      }),
    })]);
  });
});

describe("one live account root per account", () => {
  it("starts beside the persisted v6 Object after append arguments expand", () => {
    const legacy = new SqliteCapabilityStore(join(dir, "cap.db"));
    repos.push(legacy);
    legacy.putObject({
      id: "runner-account-v6:alice",
      kind: "runner-account",
      metadata: { owner: "alice" },
      operations: Object.keys(RUNNER_OPERATIONS),
    });
    legacy.close();

    const current = lifetime();
    expect(current.caps.ensureAccount("alice")).toBe(true);
    expect(current.repo.getObject("runner-account-v6:alice")).not.toBeNull();
    expect(current.repo.getObject(`${RUNNER_ACCOUNT_OBJECT_PREFIX}:alice`)).not.toBeNull();
    expect(current.svc.rootsOf(`${RUNNER_ACCOUNT_OBJECT_PREFIX}:alice`)).toHaveLength(1);
  });

  it.each(["v10", "v11"])("versions the expanded argument schema without retargeting persisted %s roots", (version) => {
    const legacy = new SqliteCapabilityStore(join(dir, "cap.db"));
    repos.push(legacy);
    const oldId = `runner-account-${version}:alice`;
    legacy.putObject({ id: oldId, kind: "runner-account", metadata: { owner: "alice" }, operations: Object.keys(RUNNER_OPERATIONS) });
    legacy.close();
    const current = lifetime();
    expect(current.caps.ensureAccount("alice")).toBe(true);
    expect(RUNNER_ACCOUNT_OBJECT_PREFIX).toBe("runner-account-v12");
    expect(current.repo.getObject(oldId)).not.toBeNull();
    expect(current.repo.getObject(`${RUNNER_ACCOUNT_OBJECT_PREFIX}:alice`)).not.toBeNull();
    expect(RUNNER_OPERATIONS.start_session.args?.codex_account).toBeDefined();
  });

  it("starts beside the persisted v9 Object without granting new operations to old roots", () => {
    const legacy = new SqliteCapabilityStore(join(dir, "cap.db"));
    repos.push(legacy);
    legacy.putObject({ id: "runner-account-v9:alice", kind: "runner-account", metadata: { owner: "alice" },
      operations: Object.keys(RUNNER_OPERATIONS).filter((op) => op !== "get_session_operation") });
    legacy.close();
    const current = lifetime();
    expect(current.caps.ensureAccount("alice")).toBe(true);
    expect(current.repo.getObject("runner-account-v9:alice")?.operations).not.toContain("get_session_operation");
    expect(current.repo.getObject(`${RUNNER_ACCOUNT_OBJECT_PREFIX}:alice`)?.operations).toContain("get_session_operation");
  });

  it("starts beside the persisted v4 Object after the operation table expands", () => {
    expect(Object.keys(RUNNER_OPERATIONS).sort()).toEqual([...RUNNER_V4_OPERATIONS, "upload_session_file", "get_session_operation"].sort());
    const legacy = new SqliteCapabilityStore(join(dir, "cap.db"));
    repos.push(legacy);
    legacy.putObject({
      id: "runner-account-v4:alice",
      kind: "runner-account",
      metadata: { owner: "alice" },
      operations: [...RUNNER_V4_OPERATIONS],
    });
    legacy.close();

    const current = lifetime();
    expect(current.caps.ensureAccount("alice")).toBe(true);
    expect(current.repo.getObject("runner-account-v4:alice")?.operations).not.toContain("upload_session_file");
    expect(current.repo.getObject(`${RUNNER_ACCOUNT_OBJECT_PREFIX}:alice`)?.operations).toContain(
      "upload_session_file",
    );
    expect(current.svc.rootsOf(`${RUNNER_ACCOUNT_OBJECT_PREFIX}:alice`)).toHaveLength(1);
  });

  it("starts beside a persisted v1 Object instead of retargeting it", () => {
    const legacy = new SqliteCapabilityStore(join(dir, "cap.db"));
    repos.push(legacy);
    legacy.putObject({
      id: "runner-account:alice",
      kind: "runner-account",
      metadata: { owner: "alice" },
      operations: ["read_session"],
    });
    legacy.close();

    const current = lifetime();
    expect(current.caps.ensureAccount("alice")).toBe(true);
    expect(current.repo.getObject("runner-account:alice")?.operations).toEqual(["read_session"]);
    expect(current.repo.getObject(`${RUNNER_ACCOUNT_OBJECT_PREFIX}:alice`)).not.toBeNull();
    expect(current.svc.rootsOf(`${RUNNER_ACCOUNT_OBJECT_PREFIX}:alice`)).toHaveLength(1);
  });

  it("a second service lifetime reuses the persisted root instead of minting another", () => {
    const a = lifetime();
    const first = a.caps.accountAuthority("alice")!;
    expect(first).not.toBeNull();
    a.repo.close();

    const b = lifetime();
    const second = b.caps.accountAuthority("alice")!;
    expect(second.contextId).toBe(first.contextId);
    // And there is exactly one account-authority Context in the store.
    const roots = b.svc.rootsOf(`${RUNNER_ACCOUNT_OBJECT_PREFIX}:alice`);
    expect(roots).toHaveLength(1);
  });

  it("revoking after a restart kills the ORIGINAL derivation tree", async () => {
    // A real second lifetime: everything below goes through the NEW service.
    // Nothing is invoked through the first service or through a grant object
    // that closed over it — that would prove only that an in-memory handle
    // still worked, which is not what surviving a restart means.
    const a = lifetime();
    const grant = a.caps.open({ username: "alice", purpose: "p", kind: "session", rights: SESSION_READ_OPS })!;
    expect((await grant.request("read_session", { id: "s1" })).status).toBe("succeeded");
    const derivedCtx = grant.contextId;
    const originalRoot = a.caps.accountAuthority("alice")!.contextId;
    a.repo.close();

    const b = lifetime();
    // `ensureAccount` is what re-registers the Object in the new service and
    // re-attaches its adapter; without it a persisted capability points at an
    // Object this process has never heard of and everything denies.
    expect(b.caps.ensureAccount("alice")).toBe(true);
    expect(b.caps.accountAuthority("alice")!.contextId).toBe(originalRoot);
    const roots = b.svc.rootsOf(`${RUNNER_ACCOUNT_OBJECT_PREFIX}:alice`);
    expect(roots).toHaveLength(1);

    // The restored adapter works: the Context derived in the FIRST lifetime
    // reaches the device through the SECOND service.
    const rebound = b.svc.bind(derivedCtx);
    expect((await rebound.request("runner", "read_session", { id: "s1" })).status).toBe("succeeded");

    b.caps.revokeAccount("alice");
    expect((await rebound.request("runner", "read_session", { id: "s1" })).status).toBe("denied");
  });

  it("a pending call from the previous lifetime dies with a revocation in the new one", async () => {
    // The security-relevant half: after a restart, revoking in the NEW service
    // must make both the old derived Context and the old PendingCall unusable.
    const a = lifetime();
    const grant = a.caps.open({ username: "alice", purpose: "p", kind: "job", rights: ["exec"] })!;
    const queued = await grant.request("exec", { device: "laptop", command: "id" });
    const pendingId = (queued as { pendingCallId: string }).pendingCallId;
    const derivedCtx = grant.contextId;
    const before = alice!.frames.length;
    a.repo.close();

    const b = lifetime();
    b.caps.ensureAccount("alice");
    b.caps.revokeAccount("alice");

    expect((await b.caps.approve(pendingId, "alice")).status).not.toBe("succeeded");
    const rebound = b.svc.bind(derivedCtx);
    expect((await rebound.request("runner", "read_session", { id: "s1" })).status).toBe("denied");
    expect(alice!.frames.length).toBe(before);
  });

  it("an undecided pending survives a restart and still executes exactly once", async () => {
    // A restart between approval and execution is the case the kernel calls
    // `unknown`: we cannot prove whether the adapter ran, so the record is
    // terminal and nothing re-runs it. And a pending that was never approved
    // must not become approvable by a process that has forgotten the claim.
    const a = lifetime();
    const grant = a.caps.open({ username: "alice", purpose: "p", kind: "job", rights: ["exec"] })!;
    const queued = await grant.request("exec", { device: "laptop", command: "id" });
    expect(queued.status).toBe("approval_required");
    const pendingId = (queued as { pendingCallId: string }).pendingCallId;
    const before = alice!.frames.length;
    a.repo.close();

    const b = lifetime();
    b.caps.ensureAccount("alice");
    // Still undecided, still owned by alice — approving it in the new lifetime
    // re-runs the FULL check against the persisted Context, and that Context's
    // root is the one this process just restored, so it is allowed exactly once.
    expect((await b.caps.approve(pendingId, "alice")).status).toBe("succeeded");
    expect(alice!.frames.length).toBe(before + 1);
    // A second approval returns the RECORD, never a second frame.
    expect((await b.caps.approve(pendingId, "alice")).status).toBe("succeeded");
    expect(alice!.frames.length).toBe(before + 1);
  });

  it("after the last device is removed, a restart cannot mint authority from a persisted Object", async () => {
    const a = lifetime();
    const grant = a.caps.open({ username: "alice", purpose: "p", kind: "job", rights: ["exec"] })!;
    const queued = await grant.request("exec", { device: "laptop", command: "id" });
    const pendingId = (queued as { pendingCallId: string }).pendingCallId;
    const before = alice!.frames.length;
    a.caps.revokeDeviceToken("alice", "laptop");
    a.repo.close();

    const b = lifetime();
    expect(b.caps.ensureAccount("alice")).toBe(false);
    expect(b.caps.accountAuthority("alice")).toBeNull();
    // The old pending is unapprovable: its Context descends from a revoked root.
    expect((await b.caps.approve(pendingId, "alice")).status).not.toBe("succeeded");
    expect(alice!.frames.length).toBe(before);
  });

  it("no registered device means no authority, even with a persisted Object", () => {
    const a = lifetime();
    expect(a.caps.accountAuthority("alice")).not.toBeNull();
    a.repo.close();

    // The device is gone; the Object identity row is still in the database.
    store.deleteRunnerToken("alice", "laptop");
    const b = lifetime();
    expect(b.caps.accountAuthority("alice")).toBeNull();
    expect(b.caps.open({ username: "alice", purpose: "p", kind: "session", rights: SESSION_READ_OPS })).toBeNull();
  });

  it("a grant made before the last device was removed stops working", async () => {
    const a = lifetime();
    const grant = a.caps.open({ username: "alice", purpose: "p", kind: "session", rights: SESSION_READ_OPS })!;
    expect((await grant.request("read_session", { id: "s1" })).status).toBe("succeeded");
    store.deleteRunnerToken("alice", "laptop");
    a.caps.deviceRevoked("alice", "laptop");
    expect((await grant.request("read_session", { id: "s1" })).status).toBe("denied");
  });

  it("re-registering a device mints exactly one fresh root, and the old tree stays dead", async () => {
    const a = lifetime();
    const old = a.caps.open({ username: "alice", purpose: "p", kind: "session", rights: SESSION_READ_OPS })!;
    const firstRoot = a.caps.accountAuthority("alice")!.contextId;
    store.deleteRunnerToken("alice", "laptop");
    a.caps.deviceRevoked("alice", "laptop");
    expect((await old.request("read_session", { id: "s1" })).status).toBe("denied");

    // A trusted registration fact — a new device token — is what allows a new
    // root, and it is a DIFFERENT one.
    a.caps.mintDeviceToken("alice", "laptop2");
    const freshRoot = a.caps.accountAuthority("alice")!.contextId;
    expect(freshRoot).not.toBe(firstRoot);
    const live = a.svc.rootsOf(`${RUNNER_ACCOUNT_OBJECT_PREFIX}:alice`);
    expect(live).toHaveLength(1);
    // The old grant is still dead.
    expect((await old.request("read_session", { id: "s1" })).status).toBe("denied");
  });

  /**
   * The property that decides whether `runner-account:<user>` is actually loose.
   *
   * The Object is bound to a SET of machines, so the obvious worry is that a
   * grant issued when the account had one laptop silently grows reach when a
   * second one is registered — a design note in
   * `doc/handover-security-migration.md` §15 asserted exactly that, and used it
   * as an argument for splitting the Object per device.
   *
   * It is not true, and this is why: registering a device goes through the one
   * door, `mintDeviceToken`, which revokes the account root BEFORE it writes
   * the new credential. So the device set the binding covers cannot change
   * under a live grant — every registry change ends every grant derived from
   * the old root, and the next call derives from a fresh one. That is stricter
   * than the per-device model would be, not looser.
   *
   * Untested until now, which is the only reason the claim could stand.
   */
  it("registering a SECOND device does not widen a grant that already exists", async () => {
    const a = lifetime();
    const before = a.caps.open({ username: "alice", purpose: "p", kind: "session", rights: SESSION_READ_OPS })!;
    expect((await before.request("read_session", { id: "s1" })).status).toBe("succeeded");
    const firstRoot = a.caps.accountAuthority("alice")!.contextId;

    // A brand-new laptop joins the account. `laptop` stays registered.
    a.caps.mintDeviceToken("alice", "desktop");
    expect(store.listRunnerTokens("alice").map((t) => t.device).sort()).toEqual(["desktop", "laptop"]);

    // The grant taken out before the account grew is dead — it does not reach
    // the new machine, and it no longer reaches the old one either.
    expect((await before.request("read_session", { id: "s1" })).status).toBe("denied");
    // Revocation does not re-mint: there is NO authority at all until somebody
    // asks for one, which is the fail-closed direction.
    expect(a.svc.rootsOf(`${RUNNER_ACCOUNT_OBJECT_PREFIX}:alice`)).toHaveLength(0);

    // A grant taken out afterwards works, from exactly one fresh root.
    const after = a.caps.open({ username: "alice", purpose: "p", kind: "session", rights: SESSION_READ_OPS })!;
    expect((await after.request("read_session", { id: "s1" })).status).toBe("succeeded");
    const roots = a.svc.rootsOf(`${RUNNER_ACCOUNT_OBJECT_PREFIX}:alice`);
    expect(roots).toHaveLength(1);
    expect(roots[0].contextId).not.toBe(firstRoot);
  });
});
