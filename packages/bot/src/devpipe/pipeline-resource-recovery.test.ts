import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Store } from "../store/store.js";
import { ResourceRecoveryService, ResourceUnavailableError, runnerResource, ticketScope } from "../resources/recovery.js";
import { DevPipeline } from "./pipeline.js";
import { BundleHandoff } from "./bundle-handoff.js";
import type { TicketRunnerAccess } from "./runner-ticket.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ticket-resource-recovery-"));
  const store = new Store(join(dir, "state.db"));
  cleanup.push(async () => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.saveUser({ username: "alice", uid: 1, home_dir: dir, created_at: "now" });
  const recovery = new ResourceRecoveryService(store.resourceWaiters);
  const resource = runnerResource("alice", "compute");
  const parent = `ws_${"a".repeat(24)}`, child = `ws_${"b".repeat(24)}`, sha = "a".repeat(40);
  let online = true, authorized = true, runtimeOnline = true, attachmentsOnline = true, holdAppend = false;
  const frames: Array<{ method: string; args: Record<string, unknown> }> = [];
  const receipts = new Map<string, Record<string, unknown>>();
  const make = () => {
    const pipe = new DevPipeline({ store, repoDir: dir, worktreesDir: dir, buildWarmEnabled: false,
      knowledgeCaptureEnabled: false, pushRemote: null, resourceRecovery: recovery,
      // Exercise the durable wait, independent of whether the error crosses a
      // 1 ms grace boundary. Recovery is signalled explicitly by the fixture.
      resourceWait: { graceMs: 0, retryMs: 60_000, waitingRetryMs: 60_000 } });
    cleanup.push(() => pipe.stop());
    pipe.setDevelopmentWorkspaces({ stateDir: join(dir, "state"), repositoryId: "repo", publicUrl: "https://head.invalid",
      bundles: new BundleHandoff(), available: () => authorized && online,
      assertAvailable: () => {
        if (!authorized) throw new Error("development authorization revoked");
        if (!online) throw new ResourceUnavailableError(resource, "offline");
      },
      call: async (_binding, _method, args) => ({ protocol: "workspace-development/v1", ...args,
        development: { worktree_workspace_id: child, base_sha: sha, head_sha: sha, synced_head_sha: sha, dirty: true, conflicted: false } }),
    }, () => ({ token: "test-token", endpoint: "https://head.invalid/mcp", expiresAt: Date.now() + 60_000, release() {} }));
    pipe.setRunnerTickets({ resourceOwner: (owner: string) => owner,
      authorized: () => authorized, config: { targets: {} }, target: () => ({ device: "model", workspace_id: child }),
      prepareAttachments: async (_binding: unknown, prompt: string) => {
        if (!attachmentsOnline) throw new ResourceUnavailableError(resource, "offline upload");
        return prompt;
      },
      call: async (_binding: unknown, method: string, args: Record<string, unknown>) => {
        if (!runtimeOnline) throw new ResourceUnavailableError(runnerResource("alice", "model"), "offline");
        frames.push({ method, args });
        const id = String(args.operation_id);
        if (method === "start_session") receipts.set(id, { state: "failed", session_id: "native-original",
          input: { phase: "provider_accepted", evidence: "provider_ack", at: new Date().toISOString() },
          result: { error: "Selected model is at capacity" } });
        if (method === "append_session") receipts.set(id, { state: holdAppend ? "running" : "succeeded", session_id: "native-original",
          input: { phase: "provider_accepted", evidence: "provider_ack", at: new Date().toISOString() }, result: { result_text: "continued" } });
        return { protocol: "runner-session-operation/v1", live_input: "steer-only/v1", operation_id: id,
          state: "missing", ...receipts.get(id) };
      },
    } as unknown as TicketRunnerAccess);
    return pipe;
  };
  const pipe = make();
  const ticket = pipe.createTicket({ requester: "alice", title: "task", body: "original request", model: "codex-gpt-6-astra" });
  store.devTickets.updateDevTicket(ticket.id, { worktree: dir, branch: "ticket/test" });
  store.devTickets.runner.bind(ticket.id, { owner: "alice", device: "model", executionDevice: "compute", workspaceId: child, source: "codex" });
  store.devTickets.development.bind({ ticketId: ticket.id, owner: "alice", device: "compute", parentWorkspaceId: parent,
    repositoryId: "repo", developmentId: "development-test", baseSha: sha, worktreeWorkspaceId: child });
  const firstTurn = async () => {
    pipe.start();
    await vi.waitFor(() => expect(store.devTickets.getDevTicket(ticket.id)?.error).toContain("at capacity"));
    await vi.waitFor(() => expect(pipe.idle()).toBe(true));
  };
  const wait = async () => {
    online = false; pipe.postMessage(ticket.id, "alice", "web", "continue original task");
    await vi.waitFor(() => expect(pipe.ticketResourceWait(ticket.id)?.state).toBe("waiting_resource"));
    await vi.waitFor(() => expect(pipe.idle()).toBe(true));
  };
  return { store, pipe, make, ticket, recovery, resource, frames, firstTurn, wait,
    online: (v: boolean) => { online = v; }, authorize: (v: boolean) => { authorized = v; },
    runtimeOnline: (v: boolean) => { runtimeOnline = v; },
    attachmentsOnline: (v: boolean) => { attachmentsOnline = v; },
    holdAppend: (v: boolean) => { holdAppend = v; },
    settle: (id: string) => receipts.set(id, { ...receipts.get(id), state: "succeeded" }) };
}

it("retains offline continuation through restart, releases the slot and resumes the original dirty worktree/session once", async () => {
  const f = fixture(); await f.firstTurn(); await f.wait();
  f.pipe.postMessage(f.ticket.id, "alice", "web", "also preserve my edits");
  expect(f.store.devTickets.listTicketMessages(f.ticket.id, { undeliveredOnly: true }).map((r) => r.body))
    .toEqual(["continue original task", "also preserve my edits"]);
  expect(f.store.devTickets.runner.active(f.ticket.id)).toBeNull();
  expect(f.store.devTickets.getDevTicket(f.ticket.id)?.error).toBeNull();
  await f.pipe.stop();
  const next = f.make(); next.start();
  await vi.waitFor(() => expect(next.ticketResourceWait(f.ticket.id)?.state).toBe("waiting_resource"));
  f.online(true);
  await Promise.all([f.recovery.recovered(f.resource), f.recovery.recovered(f.resource)]);
  await vi.waitFor(() => expect(f.store.devTickets.listTicketMessages(f.ticket.id).some((r) => r.body === "continued")).toBe(true));
  const append = f.frames.filter((r) => r.method === "append_session");
  expect(append).toHaveLength(1);
  expect(append[0]!.args.id).toBe("native-original");
  expect(append[0]!.args.prompt).toContain("continue original task");
  expect(append[0]!.args.prompt).toContain("also preserve my edits");
  expect(next.ticketResourceWait(f.ticket.id)).toBeNull();
  expect(f.store.devTickets.listTicketMessages(f.ticket.id, { undeliveredOnly: true })).toHaveLength(0);
});

it.each(["pause", "cancel", "revoke"])("does not revive a %s request on a recovery event", async (action) => {
  const f = fixture(); await f.firstTurn(); await f.wait();
  if (action === "pause") f.pipe.interruptTurn(f.ticket.id, "alice");
  if (action === "cancel") f.pipe.cancel(f.ticket.id);
  if (action === "revoke") f.authorize(false);
  f.online(true); await f.recovery.recovered(f.resource);
  if (action === "revoke") await vi.waitFor(() => expect(f.store.devTickets.getDevTicket(f.ticket.id)?.error).toContain("revoked"));
  expect(f.frames.filter((r) => r.method === "append_session")).toHaveLength(0);
  expect(f.pipe.ticketResourceWait(f.ticket.id)).toBeNull();
  if (action === "pause") {
    expect(f.store.devTickets.listTicketMessages(f.ticket.id, { undeliveredOnly: true })).toHaveLength(1);
    f.pipe.resumeTurn(f.ticket.id, "alice");
    await vi.waitFor(() => expect(f.frames.filter((r) => r.method === "append_session")).toHaveLength(1));
  }
});

it("wakes an idle ticket through the ordinary unread inbox after its tool resource returns", async () => {
  const f = fixture(); await f.firstTurn();
  f.recovery.note(ticketScope(f.ticket.id), f.resource, "offline tool");
  await f.recovery.recovered(f.resource);
  await vi.waitFor(() => expect(f.frames.filter((r) => r.method === "append_session")).toHaveLength(1));
  expect(f.frames.find((r) => r.method === "append_session")!.args.prompt).toContain("资源已恢复");
});

it("parks a dispatched operation without replay and retrieves the original receipt on recovery", async () => {
  const f = fixture(); await f.firstTurn(); f.holdAppend(true);
  f.pipe.postMessage(f.ticket.id, "alice", "web", "continue");
  await vi.waitFor(() => expect(f.frames.filter((r) => r.method === "append_session")).toHaveLength(1));
  const original = f.store.devTickets.runner.active(f.ticket.id)!;
  expect(original.state).toBe("dispatched");
  f.runtimeOnline(false);
  await vi.waitFor(() => expect(f.pipe.ticketResourceWait(f.ticket.id)?.resource).toBe("runner:alice/model"), { timeout: 3_000 });
  await vi.waitFor(() => expect(f.pipe.idle()).toBe(true));
  expect(f.pipe.developmentRecoveryScope("alice", "model", "codex", "native-original"))
    .toMatchObject({ developmentId: "development-test", token: "test-token" });
  await f.pipe.stop();
  expect(f.pipe.developmentRecoveryScope("alice", "model", "codex", "native-original")).toBeUndefined();
  f.settle(original.id); f.runtimeOnline(true);
  const next = f.make(); next.start();
  expect(next.ticketResourceWait(f.ticket.id)?.state).toBe("waiting_resource");
  expect(f.store.devTickets.runner.active(f.ticket.id)?.id).toBe(original.id);
  await f.recovery.recovered(runnerResource("alice", "model"));
  await vi.waitFor(() => expect(f.store.devTickets.runner.active(f.ticket.id)).toBeNull());
  expect(f.frames.filter((r) => r.method === "append_session")).toHaveLength(1);
  expect(f.store.devTickets.getDevTicket(f.ticket.id)?.session_id).toBe("native-original");
  expect(next.ticketResourceWait(f.ticket.id)).toBeNull();
});

it("releases the merge lock held by a turn once the Head can no longer observe it", async () => {
  const f = fixture(); await f.firstTurn(); f.holdAppend(true);
  f.pipe.postMessage(f.ticket.id, "alice", "web", "repair and submit again");
  await vi.waitFor(() => expect(f.frames.filter((r) => r.method === "append_session")).toHaveLength(1));
  // The running turn holds the lock, as after a repairable gate failure.
  const internals = f.pipe as unknown as { turnTokens: Map<string, { ticketId: number }>; mergeLock: { acquire(id: number, token: string): unknown } };
  const token = [...internals.turnTokens].find(([, ctx]) => ctx.ticketId === f.ticket.id)![0];
  internals.mergeLock.acquire(f.ticket.id, token);
  expect(f.pipe.mergeLockHolder()).toBe(f.ticket.id);
  f.runtimeOnline(false);
  await vi.waitFor(() => expect(f.pipe.ticketResourceWait(f.ticket.id)?.resource).toBe("runner:alice/model"), { timeout: 3_000 });
  await vi.waitFor(() => expect(f.pipe.mergeLockHolder()).toBeNull());
  // Parking keeps the turn's tools usable; it only gives up the shared lock.
  expect(internals.turnTokens.has(token)).toBe(true);
});

it("returns prepared input to the inbox when paused during an offline attachment transfer", async () => {
  const f = fixture(); await f.firstTurn(); f.attachmentsOnline(false);
  f.pipe.postMessage(f.ticket.id, "alice", "web", "continue with attachment");
  await vi.waitFor(() => expect(f.pipe.ticketResourceWait(f.ticket.id)).not.toBeNull());
  expect(f.store.devTickets.runner.active(f.ticket.id)?.state).toBe("prepared");
  await vi.waitFor(() => expect(f.pipe.idle()).toBe(true));
  f.pipe.interruptTurn(f.ticket.id, "alice");
  expect(f.pipe.ticketResourceWait(f.ticket.id)).toBeNull();
  expect(f.store.devTickets.runner.active(f.ticket.id)).toBeNull();
  f.attachmentsOnline(true);
  expect(f.frames.filter((r) => r.method === "append_session")).toHaveLength(0);
  expect(f.store.devTickets.listTicketMessages(f.ticket.id, { undeliveredOnly: true }).map((r) => r.body)).toEqual(["continue with attachment"]);
  f.pipe.resumeTurn(f.ticket.id, "alice");
  await vi.waitFor(() => expect(f.frames.filter((r) => r.method === "append_session")).toHaveLength(1));
});
