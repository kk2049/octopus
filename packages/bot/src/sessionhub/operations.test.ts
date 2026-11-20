/**
 * The submission lifecycle, against a real Store, a real capability kernel and a
 * fake Runner transport that COUNTS FRAMES.
 *
 * Frame counts, not return values, are the assertions that matter here: "it did
 * not run" has to mean the laptop heard nothing, and the whole point of the
 * restart rule is that a record which cannot prove what happened must not cause
 * a second turn.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store/store.js";
import { PermissionService } from "../permissions/service.js";
import { SESSION_HUB_OPERATION_IDS, SESSION_HUB_SUBJECT } from "../permissions/catalog.js";
import { RunnerCapabilities } from "../runner/capability.js";
import type { RunnerTransport } from "../runner/gateway.js";
import { hashRunnerToken } from "../runner/gateway.js";
import { appendFingerprint, SessionHubService, type HubPrincipal } from "./service.js";
import { SessionOperationCoordinator, type SessionOperationView } from "./operations.js";
import { SessionHubOperationExecutor, type HubOperationInput } from "./operation-executor.js";

const NOW = "2026-08-03T09:00:00.000Z";
const SESSION = "aaaa1111-2222-3333-4444-555566667777";

interface Frame {
  owner: string;
  operation: string;
  args: Record<string, unknown>;
}

let dir: string;
let store: Store;
let caps: RunnerCapabilities;
let hub: SessionHubService;
let coord: SessionOperationCoordinator;
/**
 * Every coordinator this file created. Each owns a recovery supervisor whose
 * sweep timer reads the store; one left open past the store's close throws
 * into whatever test runs next, so teardown closes all of them.
 */
let coordinators: SessionOperationCoordinator[] = [];
let frames: Frame[];
/** When true, an `append_session` frame hangs until a test releases it. */
let holdDevice: boolean;
let held: Array<(value: unknown) => void>;
let dispatchResult: unknown;

const alice: HubPrincipal = { username: "alice", admin: false, session: true, credential: "ws:one" };
const aliceBearer: HubPrincipal = { ...alice, session: false };

function transport(): RunnerTransport {
  return {
    dispatch: async (owner: string, operation: string, args: Record<string, unknown>) => {
      frames.push({ owner, operation, args });
      if (operation === "append_session" && holdDevice) {
        return await new Promise((resolve) => held.push(resolve as (v: unknown) => void));
      }
      return dispatchResult;
    },
    listDevices: () => [{ device: "laptop", online: true, created_at: NOW, last_seen_at: NOW }],
    isOnline: () => true,
    ping: async () => 1,
    disconnect: () => true,
  } as unknown as RunnerTransport;
}

function releaseDevice(result: unknown = { ok: true, agent: "claude", duration_ms: 900, result_text: "OK" }): void {
  const pending = held.splice(0);
  for (const r of pending) r(result);
}

/** Poll a coordinator until a predicate holds; the transitions are async now. */
async function waitFor(
  fn: () => SessionOperationView | null | undefined,
  pred: (v: SessionOperationView) => boolean,
  timeoutMs = 3000,
): Promise<SessionOperationView> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v && pred(v)) return v;
    if (Date.now() > deadline) throw new Error(`never reached the expected state (last: ${v?.status})`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function compose(directSubmit: string[] = [], ownerSilentAppend = false): void {
  caps = new RunnerCapabilities(store, transport(), {
    extraRootAutoAllow: (u) => (directSubmit.includes(u) ? ["append_session"] : []),
  });
  caps.ensureAccount("alice");
  const permissions = new PermissionService({ store, caps, directSubmitAutoAllowUsers: directSubmit });
  // Materialise the bootstrap grant the way the panel's first page load does.
  permissions.sessionHubEffective("alice");
  // The bootstrap grant now lets the owner append to their own sessions from
  // any credential (O1). These cases are about the approval lifecycle, so the
  // owner narrows that one term, which is exactly how a card still arises.
  if (!ownerSilentAppend) {
    permissions.grant({
      subjectType: "service",
      subjectId: SESSION_HUB_SUBJECT.id,
      owner: "alice",
      operations: SESSION_HUB_OPERATION_IDS,
      autoAllow: SESSION_HUB_OPERATION_IDS.filter((op) => op !== "append_session" && op !== "resume_session"),
      source: "user",
      createdBy: "alice",
    });
  }
  hub = new SessionHubService({ store, permissions, caps });
  coord = new SessionOperationCoordinator({
    store,
    executors: { hub: new SessionHubOperationExecutor(hub) },
    caps,
  });
  coordinators.push(coord);
}

async function settle(id: string, timeoutMs = 3000): Promise<SessionOperationView> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = coord.get("alice", id);
    if (v && !v.live) return v;
    if (Date.now() > deadline) throw new Error(`operation ${id} never settled (${v?.status})`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const submitAs = (principal: HubPrincipal, prompt: string, extra: Record<string, unknown> = {}) =>
  coord.submit("hub", principal, {
    owner: "alice",
    device: "laptop",
    sessionId: SESSION,
    prompt,
    source: "claude",
    operation: "append_session",
    ...extra,
  } as HubOperationInput);
const submit = (prompt: string, extra: Record<string, unknown> = {}) => submitAs(aliceBearer, prompt, extra);
const submitDirect = (prompt: string, extra: Record<string, unknown> = {}) => submitAs(alice, prompt, extra);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sessop-"));
  store = new Store(join(dir, "t.db"));
  store.saveUser({ username: "alice", uid: 5001, home_dir: "/x/a", created_at: NOW });
  store.saveUser({ username: "bob", uid: 5002, home_dir: "/x/b", created_at: NOW });
  store.saveRunnerToken(hashRunnerToken("rt_alice"), "alice", "laptop", NOW);
  frames = [];
  holdDevice = false;
  held = [];
  dispatchResult = { ok: true, agent: "claude", duration_ms: 1200, result_text: "done" };
  compose();
});

afterEach(async () => {
  // Nothing may still be in flight when the database closes: a background
  // transition writing into a closed store is a test artefact, not a finding.
  holdDevice = false;
  releaseDevice();
  await new Promise((r) => setTimeout(r, 30));
  for (const each of coordinators) each.close();
  coordinators = [];
  caps.service.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("submission becomes a record", () => {
  it('reconnects a durable request after completion without issuing another Runner frame', async () => {
    const input: HubOperationInput = {owner: 'alice', device: 'laptop', sessionId: SESSION, prompt: 'one durable task', source: 'claude', operation: 'append_session'};
    const first = await coord.submit('hub', alice, input, {requestId: 'durable-one'});
    if (!first.ok) throw new Error(first.error);
    await first.settled;
    const count = frames.length;
    const again = await coord.submit('hub', alice, input, {requestId: 'durable-one'});
    expect(again).toMatchObject({ok: true, operation: {id: first.operation.id}});
    expect(frames).toHaveLength(count);
    const collision = await coord.submit('hub', alice, {...input, prompt: 'different task'}, {requestId: 'durable-one'});
    expect(collision).toMatchObject({ok: false, status: 409});
    expect(frames).toHaveLength(count);
  });
  it("persists a deterministic fingerprint, never the prompt", async () => {
    const prompt = "private prompt that must not enter the control-plane database";
    const out = await submit(prompt);
    if (!out.ok) throw new Error("expected acceptance");

    const [saved] = store.listSessionOperations("alice");
    expect(saved.args_hash).toBe(appendFingerprint("append_session", "claude", prompt));
    expect(saved.args_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(saved.args_hash).not.toContain(prompt);
  });

  it("a refused submission leaves NO record — a refusal is not a lifecycle", async () => {
    const notOwner = await coord.submit(
      "hub",
      { username: "bob", admin: false, session: true, credential: "ws:bob" },
      { owner: "alice", device: "laptop", sessionId: SESSION, prompt: "x", operation: "append_session" },
    );
    expect(notOwner).toMatchObject({ ok: false, status: 403 });
    const botHost = await coord.submit("hub", alice, {
      owner: "alice",
      device: "bot-host",
      sessionId: SESSION,
      prompt: "x",
      operation: "append_session",
    });
    expect(botHost).toMatchObject({ ok: false, status: 400 });
    expect(store.listSessionOperations("alice")).toHaveLength(0);
    expect(frames).toHaveLength(0);
  });

  it("runs the owner's own append from a script without a card under the bootstrap grant (O1)", async () => {
    coord.close();
    caps.service.close();
    store.close();
    store = new Store(join(dir, "o1.db"));
    store.saveUser({ username: "alice", uid: 5001, home_dir: "/x/a", created_at: NOW });
    store.saveRunnerToken(hashRunnerToken("rt_alice"), "alice", "laptop", NOW);
    compose([], true);
    const out = await submit("跑一下测试");
    if (!out.ok) throw new Error("expected acceptance");
    const settled = await settle(out.operation.id);
    expect(settled.status).toBe("succeeded");
    expect(frames).toHaveLength(1);
    expect(caps.listPending("alice")).toHaveLength(0);
  });

  it("an approval-bound submission waits, and nothing reaches the device", async () => {
    const out = await submit("跑一下测试");
    if (!out.ok) throw new Error("expected acceptance");
    const first = await out.settled;
    expect(first.view.status).toBe("waiting_approval");
    expect(first.view.pendingCallId).toBeTruthy();
    expect(frames).toHaveLength(0);
    // The record, not the socket, is what a reload would read.
    expect(coord.get("alice", out.operation.id)?.status).toBe("waiting_approval");
  });

  it("approving executes once and moves the SAME record to succeeded", async () => {
    const out = await submit("跑吧");
    if (!out.ok) throw new Error("expected acceptance");
    const pendingId = (await out.settled).view.pendingCallId!;
    const claimed = coord.approveAsOperation(pendingId, "alice");
    expect(claimed?.id).toBe(out.operation.id);
    expect(claimed?.status).toBe("running");
    const done = await settle(out.operation.id);
    expect(done.status).toBe("succeeded");
    expect(frames.filter((f) => f.operation === "append_session")).toHaveLength(1);
    expect(frames[0].args).toMatchObject({ device: "laptop", id: SESSION, prompt: "跑吧" });
  });

  it("accepts fallback only for Codex and freezes the intent into the Runner args", async () => {
    const refused = await submitDirect("不能换 Claude 账号", { operation: "fallback_session" });
    expect(refused).toMatchObject({ ok: false, status: 400 });
    expect(store.listSessionOperations("alice")).toHaveLength(0);
    expect(frames).toHaveLength(0);

    const out = await submitDirect("额度耗尽，换备用账号", {
      source: "codex",
      operation: "fallback_session",
    });
    if (!out.ok) throw new Error("expected acceptance");
    const done = await settle(out.operation.id);
    expect(done).toMatchObject({ operation: "fallback_session", status: "succeeded" });
    expect(frames).toEqual([{
      owner: "alice",
      operation: "append_session",
      args: {
        device: "laptop",
        id: SESSION,
        prompt: "额度耗尽，换备用账号",
        source: "codex",
        account_fallback: true,
        operation_id: out.operation.id,
        input_receipt: true,
      },
    }]);
  });

  it("rejecting is a decision the chat learns about, and runs nothing", async () => {
    const out = await submit("别跑");
    if (!out.ok) throw new Error("expected acceptance");
    const pendingId = (await out.settled).view.pendingCallId!;
    // The order the route uses: the kernel decides, then the record is told.
    expect(caps.reject(pendingId, "alice")).toBe(true);
    const view = coord.rejectAsOperation(pendingId, "alice");
    expect(view?.status).toBe("rejected");
    expect(view?.id).toBe(out.operation.id);
    expect(coord.get("alice", out.operation.id)?.status).toBe("rejected");
    expect(frames).toHaveLength(0);
    // Deciding it twice is not a second decision.
    expect(coord.rejectAsOperation(pendingId, "alice")).toBeNull();
  });

  it("an owner browser runs without a card by default, and the record says running then succeeded", async () => {
    holdDevice = true;
    const out = await submitDirect("直接跑");
    if (!out.ok) throw new Error("expected acceptance");
    // Observed while the device is still holding the call: the dispatch signal
    // is what makes the chip say "running" instead of sitting on "submitted"
    // for minutes. It never says "waiting_approval" — no card exists.
    const running = await waitFor(() => coord.get("alice", out.operation.id), (v) => v.status === "running");
    expect(running.pendingCallId).toBeUndefined();
    expect(running.message).toBe("claude 正在等待本机 CLI 响应");
    expect(caps.listPending("alice")).toHaveLength(0);
    expect(frames.filter((f) => f.operation === "append_session")).toHaveLength(1);
    releaseDevice();
    const done = await settle(out.operation.id);
    expect(done.status).toBe("succeeded");
    expect(done.detail).toContain("OK");
  });

  it("accepts another prompt after the first append reaches the Runner", async () => {
    holdDevice = true;
    const first = await submitDirect("第一条：继续实现");
    if (!first.ok) throw new Error("expected first acceptance");
    await waitFor(() => coord.get("alice", first.operation.id), (view) => view.status === "running");

    const second = await submitDirect("第二条：同时补上风险分析");
    if (!second.ok) throw new Error("expected second acceptance");
    expect(second.operation.id).not.toBe(first.operation.id);
    await waitFor(() => coord.get("alice", second.operation.id), (view) => view.status === "running");
    expect(frames.filter((frame) => frame.operation === "append_session").map((frame) => frame.args.prompt))
      .toEqual(["第一条：继续实现", "第二条：同时补上风险分析"]);

    releaseDevice();
    await expect(settle(first.operation.id)).resolves.toMatchObject({ status: "succeeded" });
    await expect(settle(second.operation.id)).resolves.toMatchObject({ status: "succeeded" });
  });

  it("interprets a device-level unknown after approval instead of recording a false success", async () => {
    dispatchResult = { ok: false, agent: "claude", code: "unknown", error: "transport outcome unknown" };
    const out = await submit("结果可能未知");
    if (!out.ok) throw new Error("expected acceptance");
    const pendingId = (await out.settled).view.pendingCallId!;

    // Simulate an approval path outside the coordinator. Reading the durable
    // row must reconcile through the surface executor, not treat an RPC frame
    // that completed with `{ok:false}` as a successful CLI operation.
    await caps.approve(pendingId, "alice");
    const reconciled = coord.get("alice", out.operation.id)!;
    expect(reconciled.status).toBe("unknown");
    expect(reconciled.detail).toContain("transport outcome unknown");
    expect(frames.filter((frame) => frame.operation === "append_session")).toHaveLength(1);
  });
});

describe("duplicate submissions are one intent", () => {
  it("the identical prompt joins the record that already exists", async () => {
    const a = await submit("同一条");
    const b = await submit("同一条");
    if (!a.ok || !b.ok) throw new Error("expected acceptance");
    expect(b.operation.id).toBe(a.operation.id);
    expect(caps.listPending("alice")).toHaveLength(1);
    expect(store.listSessionOperations("alice")).toHaveLength(1);
  });

  it("a different prompt on the same session is refused while one waits", async () => {
    const a = await submit("第一条");
    if (!a.ok) throw new Error("expected acceptance");
    await a.settled;
    const b = await submit("第二条");
    expect(b).toMatchObject({ ok: false, status: 409 });
  });

  it("a stale record whose card was decided elsewhere does not block the next submission", async () => {
    const a = await submit("同一条");
    if (!a.ok) throw new Error("expected acceptance");
    const pendingId = (await a.settled).view.pendingCallId!;
    // Decided through a route this coordinator never saw (a Feishu button, an
    // expiry sweep). The row still says waiting_approval until it is asked.
    expect(caps.reject(pendingId, "alice")).toBe(true);
    const b = await submit("同一条");
    if (!b.ok) throw new Error("expected acceptance");
    expect(b.operation.id).not.toBe(a.operation.id);
    expect(coord.get("alice", a.operation.id)?.status).toBe("rejected");
  });
});

describe("restart", () => {
  it("a running record becomes unknown and is NEVER re-dispatched", async () => {
    compose();
    holdDevice = true;
    const out = await submitDirect("跑到一半");
    if (!out.ok) throw new Error("expected acceptance");
    await waitFor(() => coord.get("alice", out.operation.id), (v) => v.status === "running");
    const sentBefore = frames.length;

    // A new process over the same database: same rows, nothing in memory. The
    // old kernel is closed first because the store takes a single-writer lease.
    caps.service.close();
    compose();
    const recovered = new SessionOperationCoordinator({
      store,
      executors: { hub: new SessionHubOperationExecutor(hub) },
      caps,
    });
    coordinators.push(recovered);
    const summary = recovered.recover();
    expect(summary.unknown).toBe(1);
    const view = recovered.get("alice", out.operation.id)!;
    expect(view.status).toBe("unknown");
    expect(view.message).toContain("不会自动重发");
    // The whole point: recovery reports, it does not retry.
    expect(frames).toHaveLength(sentBefore);
  });

  it("a waiting record survives, because the kernel's card is durable", async () => {
    const out = await submit("等人批");
    if (!out.ok) throw new Error("expected acceptance");
    await out.settled;
    const recovered = new SessionOperationCoordinator({
      store,
      executors: { hub: new SessionHubOperationExecutor(hub) },
      caps,
    });
    coordinators.push(recovered);
    expect(recovered.recover().unknown).toBe(0);
    expect(recovered.get("alice", out.operation.id)?.status).toBe("waiting_approval");
    expect(frames).toHaveLength(0);
  });
});

describe("teardown", () => {
  it("ending the login that submitted it voids the wait, and runs nothing", async () => {
    const out = await submit("待批准的");
    if (!out.ok) throw new Error("expected acceptance");
    await out.settled;
    expect(coord.endCredential("alice", "ws:one")).toBe(1);
    const view = coord.get("alice", out.operation.id)!;
    expect(view.status).toBe("failed");
    expect(view.detail).toContain("登录已结束");
    expect(frames).toHaveLength(0);
  });

  it("subscribers see every transition of their own account and no one else's", async () => {
    const seen: string[] = [];
    const off = coord.subscribe("alice", (v) => seen.push(v.status));
    const other: string[] = [];
    coord.subscribe("bob", (v) => other.push(v.status));
    const out = await submit("看事件");
    if (!out.ok) throw new Error("expected acceptance");
    await out.settled;
    expect(seen).toContain("waiting_approval");
    expect(other).toEqual([]);
    off();
    coord.endCredential("alice", "ws:one");
    expect(seen.filter((s) => s === "failed")).toHaveLength(0);
  });
});
