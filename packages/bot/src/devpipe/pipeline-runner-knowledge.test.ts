import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Store } from "../store/store.js";
import { createRetrievalTraceEnvelope, type RetrievalPlanAudit, type RetrievalTraceId } from "../knowledge/retrieval-trace.js";
import { DevPipeline } from "./pipeline.js";
import { KnowledgeGraphService } from "./knowledge-graph-service.js";
import type { TicketRunnerAccess } from "./runner-ticket.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "runner-startup-knowledge-"));
  const store = new Store(join(dir, "state.db"));
  cleanups.push(async () => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.saveUser({ username: "alice", uid: 1, home_dir: dir, created_at: new Date().toISOString() });
  vi.spyOn(KnowledgeGraphService.prototype, "refresh").mockResolvedValue(false);
  const traces: RetrievalTraceId[] = [];
  let beforePack: (() => Promise<void>) | undefined;
  const startup = vi.spyOn(KnowledgeGraphService.prototype, "startupPack").mockImplementation(async (_input, audit) => {
    await beforePack?.();
    const envelope = createRetrievalTraceEnvelope({ ...audit, purpose: "startup", query: "startup fixture",
      repo_sha: "a".repeat(40), graph_input_fingerprint: "b".repeat(64) }, Buffer.alloc(32, 1));
    const plan: RetrievalPlanAudit = { classifications: [], indexes: [], candidates: [], slots: [], context_keys: [],
      unknown: [{ code: "vector_unavailable" }], budget: { limit_chars: 7000, used_chars: 40, dropped_records: 0 }, performance: { total_ms: 1 } };
    store.knowledgeRetrieval.beginTrace(envelope);
    store.knowledgeRetrieval.appendAssembled(envelope.trace_id, plan);
    traces.push(envelope.trace_id);
    return { text: "Scoped startup knowledge\nvector_unavailable", chars: 40, ranked: [], unknown: [], included: [], capabilities: [], classifications: [],
      slots: { contract_principle: [], scenarios: [], sources_requirements: [], decisions_exceptions: [],
        actions_symbols: [], tests_evidence: [], landings_patterns: [], unknown_conflicts: [] },
      trace: { envelope, outcome: { event: "assembled", plan } } };
  });
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  const receipts = new Map<string, Record<string, unknown>>();
  const call = vi.fn(async (_binding: unknown, method: string, args: Record<string, unknown>) => {
    calls.push({ method, args });
    const id = String(args.operation_id);
    if (method === "start_session" || method === "append_session") {
      receipts.set(id, { state: "running", session_id: "original-session",
        input: { phase: "dispatched", evidence: "launch_identity", at: new Date().toISOString() } });
    }
    return { protocol: "runner-session-operation/v1", live_input: "steer-only/v1", operation_id: id, state: "missing", ...receipts.get(id) };
  });
  const access = { resourceOwner: (owner: string) => owner, target: () => ({ device: "runner", workspace_id: "ws" }),
    config: { targets: {} }, prepareAttachments: async (_b: unknown, prompt: string) => prompt, call } as unknown as TicketRunnerAccess;
  const makePipeline = () => {
    const pipe = new DevPipeline({ store, repoDir: dir, worktreesDir: dir, buildWarmEnabled: false,
      knowledgeCaptureEnabled: false, knowledgeGraphDir: join(dir, "knowledge"), pushRemote: null });
    pipe.setRunnerTickets(access);
    cleanups.push(() => pipe.stop());
    return pipe;
  };
  const pipe = makePipeline();
  const ticket = pipe.createTicket({ requester: "alice", title: "startup", body: "first task", model: "codex-gpt-6-astra" });
  store.devTickets.updateDevTicket(ticket.id, { worktree: dir, branch: "ticket/test" });
  return { store, pipe, ticket, makePipeline, startup, traces, calls, receipts,
    delayPack: (fn: () => Promise<void>) => { beforePack = fn; },
    events: () => traces.flatMap(id => store.knowledgeRetrieval.getTrace(id)?.events ?? []) };
}

it("persists the first pack, confirms delivery from provider evidence after restart, and never reinjects on follow-up", async () => {
  const f = fixture();
  f.pipe.start();
  await vi.waitFor(() => expect(f.store.devTickets.getDevTicket(f.ticket.id)?.session_id).toBe("original-session"));
  const operation = f.store.devTickets.runner.active(f.ticket.id)!;
  expect(operation.startupTraceId).toBe(f.traces[0]);
  expect(operation.args.prompt).toContain("Scoped startup knowledge");
  expect(operation.args.prompt).toContain("vector_unavailable");
  expect(f.events().filter(e => e.event === "delivered")).toHaveLength(0);
  await f.pipe.stop();
  // A local queue still does not prove that the model received the prompt.
  f.receipts.set(operation.id, { state: "running", session_id: "original-session",
    input: { phase: "local_queued", evidence: "local_queue", at: new Date().toISOString() } });
  const second = f.makePipeline();
  const before = f.calls.length;
  second.start();
  await vi.waitFor(() => expect(f.calls.length).toBeGreaterThan(before));
  expect(f.startup).toHaveBeenCalledTimes(1);
  expect(f.events().filter(e => e.event === "delivered")).toHaveLength(0);
  f.receipts.set(operation.id, { state: "running", session_id: "original-session",
    input: { phase: "provider_accepted", evidence: "provider_ack", at: new Date().toISOString() } });
  await vi.waitFor(() => expect(f.events().filter(e => e.event === "delivered")).toHaveLength(1), { timeout: 3000 });
  f.receipts.set(operation.id, { state: "succeeded", session_id: "original-session", result: { result_text: "done" } });
  await vi.waitFor(() => expect(f.store.devTickets.runner.active(f.ticket.id)).toBeNull(), { timeout: 3000 });
  second.postMessage(f.ticket.id, "alice", "web", "next task");
  await vi.waitFor(() => expect(f.calls.some(c => c.method === "append_session")).toBe(true));
  expect(f.calls.filter(c => c.method === "start_session")).toHaveLength(1);
  expect(f.calls.find(c => c.method === "append_session")?.args.prompt).not.toContain("Scoped startup knowledge");
  expect(f.startup).toHaveBeenCalledTimes(1);
  expect(f.events().filter(e => e.event === "delivered")).toHaveLength(1);
  expect(f.store.knowledgeRetrieval.hasDeliveredPathContext(`ticket:${f.ticket.id}`, operation.turn)).toBe(false);
});

it("abandons an unsent startup pack when cancelled during assembly and keeps the original inbox", async () => {
  const f = fixture();
  let release!: () => void;
  f.delayPack(() => new Promise<void>(resolve => { release = resolve; }));
  f.pipe.start();
  await vi.waitFor(() => expect(f.startup).toHaveBeenCalledOnce());
  f.pipe.cancel(f.ticket.id);
  release();
  await vi.waitFor(() => expect(f.events().some(e => e.event === "abandoned")).toBe(true));
  expect(f.calls.some(c => c.method === "start_session")).toBe(false);
  expect(f.store.devTickets.runner.active(f.ticket.id)).toBeNull();
  expect(f.store.devTickets.listTicketMessages(f.ticket.id, { undeliveredOnly: true }).some(m => m.body === "first task")).toBe(true);
  expect(f.events().filter(e => e.event === "delivered")).toHaveLength(0);
});

it("reuses a prepared first prompt and its trace after a pre-dispatch restart", async () => {
  const f = fixture();
  const pack = await f.startup.getMockImplementation()!({ title: "startup", body: "first task" },
    { lane: "ticket", subject_ref: `ticket:${f.ticket.id}`, turn: 1 });
  f.store.devTickets.runner.bind(f.ticket.id, { owner: "alice", device: "runner", workspaceId: "ws", source: "codex" });
  const saved = f.store.devTickets.prepareRunnerTurn(f.ticket.id, 1, () => ({ id: "ticket-prepared-original", ticketId: f.ticket.id,
    turn: 1, method: "start_session", state: "prepared", startupTraceId: pack!.trace.envelope.trace_id,
    args: { source: "codex", workspace_id: "ws", prompt: "Persisted original startup pack", client_request_id: "op_original" } }));
  f.startup.mockClear();
  f.pipe.start();
  await vi.waitFor(() => expect(f.calls.some(c => c.method === "start_session")).toBe(true));
  expect(f.startup).not.toHaveBeenCalled();
  expect(f.calls.find(c => c.method === "start_session")?.args).toMatchObject({ operation_id: saved!.id, prompt: "Persisted original startup pack" });
  expect(f.store.devTickets.runner.active(f.ticket.id)?.startupTraceId).toBe(saved!.startupTraceId);
});

it("does not fabricate delivery when a dispatched start fails without provider admission", async () => {
  const f = fixture();
  f.pipe.start();
  await vi.waitFor(() => expect(f.store.devTickets.runner.active(f.ticket.id)?.state).toBe("dispatched"));
  const operation = f.store.devTickets.runner.active(f.ticket.id)!;
  f.receipts.set(operation.id, { state: "failed", result: { error: "provider refused launch" } });
  await vi.waitFor(() => expect(f.store.devTickets.runner.active(f.ticket.id)).toBeNull(), { timeout: 3000 });
  expect(f.events().filter(e => e.event === "delivered")).toHaveLength(0);
});

it("keeps the ticket usable when startup retrieval is unavailable", async () => {
  const f = fixture();
  f.startup.mockResolvedValue(null);
  f.pipe.start();
  await vi.waitFor(() => expect(f.calls.some(c => c.method === "start_session")).toBe(true));
  expect(f.store.devTickets.runner.active(f.ticket.id)?.startupTraceId).toBeUndefined();
});
