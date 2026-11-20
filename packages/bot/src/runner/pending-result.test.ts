/**
 * P0-4: how a caller learns what happened to a dangerous call it made.
 *
 * The loopback's 202 told the agent "批准后请重新发起这一步" — re-issue the
 * operation after approval. Re-issuing after the call has RUN does not join
 * the finished record; it creates a fresh PendingCall for the same command,
 * and approving that one executes the side effect a second time. The
 * documented recovery workflow was itself the double-execution bug.
 *
 * The fix is a retrieval path bound to the same credential: the pending id is
 * a lookup key, never a bearer token, so the Context comes from the channel
 * exactly like it does for a request.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store/store.js";
import { RunnerGateway, hashRunnerToken } from "./gateway.js";
import { RunnerCapabilities, MACHINE_OPS } from "./capability.js";
import { CapabilityLoopback } from "./loopback.js";
import { startFakeRunner, type FakeRunner } from "./fake-runner.helper.js";

const NOW = "2026-07-29T00:00:00.000Z";

let dir: string;
let store: Store;
let gateway: RunnerGateway;
let caps: RunnerCapabilities;
let loop: CapabilityLoopback;
let runner: FakeRunner | null = null;
let execs: Array<Record<string, unknown>> = [];

async function rpc(token: string, body: unknown, path = "/rpc"): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${loop.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-token": token },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pres-"));
  store = new Store(join(dir, "bot.db"));
  store.saveUser({ username: "alice", uid: 5001, home_dir: "/x/alice", created_at: NOW });
  store.saveRunnerToken(hashRunnerToken("rt_a"), "alice", "laptop", NOW);
  gateway = new RunnerGateway(store, { port: 0 });
  await gateway.start();
  caps = new RunnerCapabilities(store, gateway.claimTransport());
  loop = new CapabilityLoopback();
  await loop.start();
  execs = [];
  runner = await startFakeRunner(gateway.port, "rt_a", "laptop", {
    exec: (args) => {
      execs.push(args as Record<string, unknown>);
      return { stdout: "done", exit_code: 0 };
    },
  });
});

afterEach(async () => {
  runner?.close();
  await loop.stop();
  await gateway.stop();
  rmSync(dir, { recursive: true, force: true });
});

function grantToken(purpose = "mcp"): { token: string; close: () => void } {
  const grant = caps.open({ username: "alice", purpose, kind: "agent-run", rights: MACHINE_OPS })!;
  return { token: loop.mint(grant.capabilities, purpose), close: () => grant.close() };
}

describe("retrieving the outcome of an approved call", () => {
  it("the 202 does not tell the caller to re-issue the operation", async () => {
    const g = grantToken();
    const out = await rpc(g.token, { operation: "exec", args: { device: "laptop", command: "rm -rf /tmp/x" } });
    expect(out.status).toBe(202);
    expect(String(out.body.error)).not.toMatch(/重新发起|再试|重试这一步/);
    expect(out.body.pending_call_id).toBeTruthy();
    expect(out.body.result_url ?? out.body.how_to_check).toBeTruthy();
  });

  it("the original credential can read the recorded outcome without re-running anything", async () => {
    const g = grantToken();
    const first = await rpc(g.token, { operation: "exec", args: { device: "laptop", command: "echo hi" } });
    const pendingId = String(first.body.pending_call_id);

    const before = await rpc(g.token, { pending_call_id: pendingId }, "/result");
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ ok: true, state: "pending" });
    expect(execs).toHaveLength(0);

    expect((await caps.approve(pendingId, "alice")).status).toBe("succeeded");
    expect(execs).toHaveLength(1);

    const after = await rpc(g.token, { pending_call_id: pendingId }, "/result");
    expect(after.status).toBe(200);
    expect(after.body).toMatchObject({ ok: true, state: "finished", outcome: "succeeded" });
    expect((after.body.result as { stdout?: string }).stdout).toBe("done");
    // Reading a result is not an execution.
    expect(execs).toHaveLength(1);
  });

  it("another grant's credential cannot read that outcome, even with the right id", async () => {
    const mine = grantToken("mine");
    const theirs = grantToken("theirs");
    const first = await rpc(mine.token, { operation: "exec", args: { device: "laptop", command: "echo hi" } });
    const pendingId = String(first.body.pending_call_id);
    await caps.approve(pendingId, "alice");

    const stolen = await rpc(theirs.token, { pending_call_id: pendingId }, "/result");
    expect(stolen.status).toBe(404);
    expect(stolen.body.result).toBeUndefined();
  });

  it("a credential whose grant was released can no longer read it", async () => {
    const g = grantToken();
    const first = await rpc(g.token, { operation: "exec", args: { device: "laptop", command: "echo hi" } });
    const pendingId = String(first.body.pending_call_id);
    await caps.approve(pendingId, "alice");
    loop.revoke(g.token);
    const gone = await rpc(g.token, { pending_call_id: pendingId }, "/result");
    expect(gone.status).toBe(403);
  });

  it("re-issuing the same call while it is undecided joins the SAME approval", async () => {
    const g = grantToken();
    const a = await rpc(g.token, { operation: "exec", args: { device: "laptop", command: "echo hi" } });
    const b = await rpc(g.token, { operation: "exec", args: { device: "laptop", command: "echo hi" } });
    expect(b.body.pending_call_id).toBe(a.body.pending_call_id);
    expect(caps.listPending("alice")).toHaveLength(1);
  });

  it("re-issuing after it already ran does NOT silently execute again", async () => {
    // The workflow a caller might actually follow if told to retry. It must
    // not be able to produce a second side effect on its own — a second
    // execution requires the owner to approve a second, separate card.
    const g = grantToken();
    const first = await rpc(g.token, { operation: "exec", args: { device: "laptop", command: "echo hi" } });
    const pendingId = String(first.body.pending_call_id);
    await caps.approve(pendingId, "alice");
    expect(execs).toHaveLength(1);

    const again = await rpc(g.token, { operation: "exec", args: { device: "laptop", command: "echo hi" } });
    expect(again.status).toBe(202);
    expect(execs).toHaveLength(1);
    // And approving the FIRST id again returns the record, not a re-run.
    const replay = await caps.approve(pendingId, "alice");
    expect(replay.status).toBe("succeeded");
    expect(execs).toHaveLength(1);
  });
});
