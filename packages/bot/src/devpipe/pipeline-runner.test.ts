import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Store } from "../store/store.js";
import { DevPipeline } from "./pipeline.js";
import { TicketRunnerAccess } from "./runner-ticket.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it("stopping preserves queued messages without restarting, and explicit continue resumes the same Runner session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ticket-runner-chat-"));
  const store = new Store(":memory:");
  cleanups.push(async () => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.saveUser({ username: "alice", uid: 1, home_dir: dir, created_at: "now" });
  const pipe = new DevPipeline({ store, repoDir: dir, worktreesDir: dir, buildWarmEnabled: false,
    knowledgeCaptureEnabled: false, pushRemote: null });
  cleanups.push(() => pipe.stop());
  const receipts = new Map<string, Record<string, unknown>>();
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  const call = async (_binding: unknown, method: string, args: Record<string, unknown>) => {
    calls.push({ method, args });
    const id = String(args.operation_id);
    if (method === "start_session" || method === "append_session") {
      if (args.interrupt) {
        for (const [key, value] of receipts) if (value.state === "running") receipts.set(key, { ...value, state: "failed" });
        receipts.set(id, { state: "succeeded" });
      } else receipts.set(id, { state: args.steer_only ? "succeeded" : "running", session_id: "original-session",
        input: { phase: "provider_accepted", evidence: "provider_ack", at: new Date().toISOString() } });
    }
    return { protocol: "runner-session-operation/v1", live_input: "steer-only/v1", operation_id: id, state: "missing", ...receipts.get(id) };
  };
  pipe.setRunnerTickets({ resourceOwner: (owner: string) => owner, target: () => ({ device: "runner", workspace_id: "ws" }),
    config: { targets: {} }, prepareAttachments: async (_b: unknown, prompt: string) => prompt, call } as unknown as TicketRunnerAccess);
  const ticket = pipe.createTicket({ requester: "alice", title: "chat", body: "initial", model: "codex-gpt-6-astra" });
  store.devTickets.updateDevTicket(ticket.id, { worktree: dir, branch: "ticket/test" });
  pipe.start();
  await vi.waitFor(() => expect(store.devTickets.getDevTicket(ticket.id)?.session_id).toBe("original-session"));
  pipe.postMessage(ticket.id, "alice", "web", "keep 4090");
  pipe.interruptTurn(ticket.id, "alice");
  await vi.waitFor(() => expect(store.devTickets.getDevTicket(ticket.id)?.turn_started_at).toBeNull(), { timeout: 4_000 });
  expect(store.devTickets.getDevTicket(ticket.id)?.chat_paused).toBe(1);
  expect(store.devTickets.listTicketMessages(ticket.id, { undeliveredOnly: true }).map((row) => row.body)).toEqual(["keep 4090"]);
  expect(calls.filter((row) => row.method === "append_session" && !row.args.interrupt)).toHaveLength(0);
  pipe.resumeTurn(ticket.id, "alice");
  await vi.waitFor(() => expect(calls.filter((row) => row.method === "append_session" && !row.args.interrupt)).toHaveLength(1));
  const resumed = calls.find((row) => row.method === "append_session" && !row.args.interrupt)!;
  expect(resumed.args).toMatchObject({ id: "original-session", input_receipt: true });
  expect(resumed.args.prompt).toContain("keep 4090");
  expect(store.devTickets.listTicketMessages(ticket.id).filter((row) => row.body === "keep 4090")).toHaveLength(1);
});

it("a ticket worktree that cannot be created fails the Runner turn once instead of re-running its inbox", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ticket-runner-worktree-"));
  const store = new Store(":memory:");
  cleanups.push(async () => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.saveUser({ username: "alice", uid: 1, home_dir: dir, created_at: "now" });
  // Not a Git repository: creating the ticket worktree fails every time.
  const pipe = new DevPipeline({ store, repoDir: join(dir, "missing-repo"), worktreesDir: dir, buildWarmEnabled: false,
    knowledgeCaptureEnabled: false, pushRemote: null });
  cleanups.push(() => pipe.stop());
  const calls: string[] = [];
  pipe.setRunnerTickets({ resourceOwner: (owner: string) => owner, target: () => ({ device: "runner", workspace_id: "ws" }),
    config: { targets: {} }, prepareAttachments: async (_b: unknown, prompt: string) => prompt,
    call: async (_binding: unknown, method: string, args: Record<string, unknown>) => {
      calls.push(method);
      return { protocol: "runner-session-operation/v1", live_input: "steer-only/v1", operation_id: String(args.operation_id), state: "missing" };
    } } as unknown as TicketRunnerAccess);
  const ticket = pipe.createTicket({ requester: "alice", title: "no worktree", body: "task", model: "codex-gpt-6-astra" });
  pipe.start();
  await vi.waitFor(() => expect(store.devTickets.getDevTicket(ticket.id)?.error).toContain("worktree 创建失败"));
  // Give a re-selected inbox time to show up as a second lap.
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(calls.filter((method) => method === "get_session_operation")).toHaveLength(1);
  expect(calls).not.toContain("start_session");
  expect(store.devTickets.listTicketMessages(ticket.id, { undeliveredOnly: true })).toHaveLength(0);
  expect(store.devTickets.listTicketMessages(ticket.id).filter((row) => row.body.includes("worktree 创建失败"))).toHaveLength(1);
});

it.each([
  ["without", undefined],
  ["with", "## 名字\n收尾\n\n已落地。"],
] as const)("a Runner turn that lands %s a final reply leaves exactly one landing record", async (_case, finalReply) => {
  const dir = mkdtempSync(join(tmpdir(), "ticket-runner-landing-"));
  const store = new Store(":memory:");
  cleanups.push(async () => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.saveUser({ username: "alice", uid: 1, home_dir: dir, created_at: "now" });
  const events: string[] = [];
  const pipe = new DevPipeline({ store, repoDir: dir, worktreesDir: dir, buildWarmEnabled: false,
    knowledgeCaptureEnabled: false, pushRemote: null, notify: (event) => { events.push(event.kind); } });
  cleanups.push(() => pipe.stop());
  const sha = "c".repeat(40);
  const internals = pipe as unknown as { turnTokens: Map<string, { ticketId: number }>; landedTurns: Map<string, unknown> };
  let ticketId = 0;
  let started = false;
  pipe.setRunnerTickets({ resourceOwner: (owner: string) => owner, target: () => ({ device: "runner", workspace_id: "ws" }),
    config: { targets: {} }, prepareAttachments: async (_b: unknown, prompt: string) => prompt,
    call: async (_binding: unknown, method: string, args: Record<string, unknown>) => {
      if (method === "start_session") {
        // The agent's devpipe_submit landed during this turn (same effect as toolSubmit).
        const token = [...internals.turnTokens].find(([, row]) => row.ticketId === ticketId)![0];
        internals.landedTurns.set(token, { sha, deliveryMode: "full_deploy", affectedAppCount: 0 });
        started = true;
      }
      return { protocol: "runner-session-operation/v1", live_input: "steer-only/v1", operation_id: String(args.operation_id),
        ...(!started || args.operation_id === "ticket-protocol-probe" ? { state: "missing" }
          : { state: "succeeded", session_id: "native", result: finalReply ? { result_text: finalReply } : {} }) };
    } } as unknown as TicketRunnerAccess);
  const ticket = pipe.createTicket({ requester: "alice", title: "lands", body: "task", model: "codex-gpt-6-astra" });
  ticketId = ticket.id;
  store.devTickets.updateDevTicket(ticket.id, { worktree: dir, branch: "ticket/test" });
  pipe.start();
  await vi.waitFor(() => expect(events).toContain("landed"));
  const messages = store.devTickets.listTicketMessages(ticket.id);
  const records = messages.filter((row) => row.body.includes("系统合成落地记录"));
  if (finalReply) {
    expect(messages.filter((row) => row.author === "agent").map((row) => row.body)).toEqual([finalReply]);
    expect(records).toHaveLength(0);
  } else {
    expect(messages.filter((row) => row.author === "agent")).toHaveLength(0);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ author: "pipeline", via: "pipeline" });
    expect(records[0]!.body).toContain(sha);
  }
  expect(store.devTickets.getDevTicket(ticket.id)?.error).toBeNull();
});

it("missing Runner configuration refuses execution instead of entering the retired Head executor", async () => {
  const store = new Store(":memory:"); cleanups.push(async () => store.close());
  store.saveUser({ username: "alice", uid: 1, home_dir: "/unused", created_at: "now" });
  const pipe = new DevPipeline({ store, repoDir: "/unused", worktreesDir: "/unused", buildWarmEnabled: false,
    knowledgeCaptureEnabled: false, pushRemote: null });
  cleanups.push(() => pipe.stop());
  const ticket = pipe.createTicket({ requester: "alice", title: "blocked", body: "never launch" });
  // Avoid unrelated Git startup; the execution door itself must refuse.
  await (pipe as unknown as { runTicketTurn(row: typeof ticket): Promise<void> }).runTicketTurn(ticket);
  expect(store.devTickets.getDevTicket(ticket.id)?.error).toContain("Head 工单执行器已停用");
  expect(store.devTickets.getDevTicket(ticket.id)?.session_id).toBeNull();
  expect(store.devTickets.runner.latest(ticket.id)).toBeNull();
});

it("a service restart reattaches the same Runner turn and commits its reply once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ticket-runner-pipeline-"));
  const store = new Store(join(dir, "state.db"));
  cleanups.push(async () => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.saveUser({ username: "alice", uid: 1, home_dir: dir, created_at: new Date().toISOString() });
  const local = vi.fn(async () => { throw new Error("service must not run a provider"); });
  const makePipeline = () => {
    const pipe = new DevPipeline({ store, repoDir: dir, worktreesDir: dir, baseBranch: "v4",
      runTurn: local, buildWarmEnabled: false, knowledgeCaptureEnabled: false, pushRemote: null });
    cleanups.push(() => pipe.stop());
    return pipe;
  };
  let settled = false;
  // Exercise the real Runner's primary-site journal contract at this boundary;
  // a permissive RPC stub previously hid invalid launch request IDs.
  const { LaunchJournal } = await import(new URL("../../../runner/src/launch-journal.ts", import.meta.url).href);
  const launchJournal = new LaunchJournal(dir);
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  const receipts = new Map<string, Record<string, unknown>>();
  const prepareAttachments = vi.fn(async (_binding: unknown, prompt: string, bodies: readonly string[]) => {
    expect(bodies).toContain("one task");
    return prompt;
  });
  const access = {
    resourceOwner: (owner: string) => owner,
    config: { targets: { alice: { device: "laptop", workspace_id: "ws_test" } } },
    target: () => ({ device: "laptop", workspace_id: "ws_test", permission_profile: "full_access" }),
    prepareAttachments,
    call: async (_binding: unknown, method: string, args: Record<string, unknown>) => {
      calls.push({ method, args });
      const id = String(args.operation_id);
      if (method === "start_session") {
        await launchJournal.begin({ client_request_id: String(args.client_request_id),
          workspace_id: String(args.workspace_id), source: "codex", prompt_hash: "one-task" });
        receipts.set(id, { session_id: "native-thread", state: "running" });
      }
      const receipt = receipts.get(id);
      return { protocol: "runner-session-operation/v1", live_input: "steer-only/v1", operation_id: id, state: "missing", ...receipt,
        ...(receipt && settled ? { state: "succeeded", result: { result_text: "original result" } } : {}) };
    },
  } as unknown as TicketRunnerAccess;
  const first = makePipeline();
  first.setRunnerTickets(access);
  const ticket = first.createTicket({ requester: "alice", title: "internal test", body: "one task", model: "codex-gpt-6-astra" });
  store.devTickets.updateDevTicket(ticket.id, { worktree: dir, branch: "ticket/test" });
  store.devTickets.runner.bind(ticket.id, { owner: "alice", device: "laptop", workspaceId: "ws_remote",
    source: "codex", executionDevice: "4090", codexAccount: "pool-b" });
  first.start();
  await vi.waitFor(() => expect(store.devTickets.getDevTicket(ticket.id)?.session_id).toBe("native-thread"), { timeout: 3_000 });
  await first.stop();
  expect(store.devTickets.runner.active(ticket.id)).not.toBeNull();
  expect(store.devTickets.listTicketMessages(ticket.id).filter((m) => m.body === "继续执行")).toHaveLength(0);
  const second = makePipeline();
  second.setRunnerTickets(access);
  settled = true;
  second.start();
  await vi.waitFor(() => expect(store.devTickets.runner.active(ticket.id)).toBeNull(), { timeout: 3_000 });
  expect(calls.filter((call) => call.method === "start_session")).toHaveLength(1);
  expect(calls.find((call) => call.method === "start_session")?.args).toMatchObject({ permission_profile: "full_access",
    workspace_id: "ws_remote", execution_device: "4090", codex_account: "pool-b" });
  expect(calls.find((call) => call.method === "start_session")?.args.prompt).toContain("实际工具执行 Runner: 4090；已登记工作区: ws_remote");
  expect(store.devTickets.runner.binding(ticket.id)).toMatchObject({ device: "laptop", executionDevice: "4090", codexAccount: "pool-b" });
  expect(calls.filter((call) => call.method === "append_session")).toHaveLength(0);
  expect(store.devTickets.listTicketMessages(ticket.id).filter((m) => m.author === "agent").map((m) => m.body)).toEqual(["original result"]);
  expect(local).not.toHaveBeenCalled();
  expect(prepareAttachments).toHaveBeenCalledOnce();
  expect(prepareAttachments).toHaveBeenCalledWith(expect.objectContaining({ executionDevice: "4090", workspaceId: "ws_remote" }),
    expect.any(String), expect.arrayContaining(["one task"]), `ticket-${ticket.id}`);
});

it("reads a historical ticket on its original Runner without using the viewer's device", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ticket-history-runner-"));
  const store = new Store(join(dir, "state.db"));
  cleanups.push(async () => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.saveUser({ username: "alice", uid: 1, home_dir: dir, created_at: new Date().toISOString() });
  const pipe = new DevPipeline({ store, repoDir: dir, worktreesDir: dir, baseBranch: "v4",
    buildWarmEnabled: false, knowledgeCaptureEnabled: false, pushRemote: null });
  const call = vi.fn(async () => ({ messages: [{ text: "historic transcript" }] }));
  pipe.setRunnerTickets({ resourceOwner: (owner: string) => owner, config: { targets: {}, legacy_host: { owner: "original-host-owner", device: "original-runner" } }, call } as unknown as TicketRunnerAccess);
  const ticket = pipe.createTicket({ requester: "alice", title: "retained ticket", body: "old input", model: "codex-gpt-6-astra" });
  store.devTickets.updateDevTicket(ticket.id, { session_id: "retained-provider-id", codex_account_slot: "account_b" });
  const lease = pipe.openRemoteTicketTranscript(store.devTickets.getDevTicket(ticket.id)!, "another-dev-viewer");
  expect(lease?.device).toBe("original-runner");
  await expect(lease!.read({ maxMessages: 20 })).resolves.toMatchObject({ messages: [{ text: "historic transcript" }] });
  expect(call).toHaveBeenCalledWith(expect.objectContaining({ owner: "original-host-owner", device: "original-runner" }),
    "read_session", expect.objectContaining({ id: "retained-provider-id", source: "codex" }));
  lease!.close();
});


it("reads only the ticket's current operation without a transcript and never dispatches or leaks result payloads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ticket-execution-read-"));
  const store = new Store(join(dir, "state.db"));
  cleanups.push(async () => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.saveUser({ username: "alice", uid: 1, home_dir: dir, created_at: new Date().toISOString() });
  const local = vi.fn(async () => { throw new Error("must not start a provider"); });
  const pipe = new DevPipeline({ store, repoDir: dir, worktreesDir: dir, baseBranch: "v4",
    runTurn: local, buildWarmEnabled: false, knowledgeCaptureEnabled: false, pushRemote: null });
  const ticket = pipe.createTicket({ requester: "alice", title: "execution evidence", body: "task", model: "codex-gpt-6-astra" });
  const binding = { owner: "alice", device: "original-runner", source: "codex" as const, workspaceId: "ws_original" };
  store.devTickets.runner.bind(ticket.id, binding);
  const operation = { id: "ticket-execution-first", ticketId: ticket.id, turn: 10,
    method: "start_session" as const, args: {}, state: "dispatched" as const };
  store.devTickets.runner.save(operation);
  const input = { phase: "provider_accepted", evidence: "provider_ack", at: new Date().toISOString(),
    session_id: "native-id", turn_id: "provider-turn", transport: "app-server" };
  const call = vi.fn(async () => ({ protocol: "runner-session-operation/v1", operation_id: operation.id,
    state: "running", session_id: "native-id", input, result: { result_text: "private tool output" } }));
  pipe.setRunnerTickets({ resourceOwner: (owner: string) => owner, config: { targets: {} }, call } as unknown as TicketRunnerAccess);
  const current = () => store.devTickets.getDevTicket(ticket.id)!;
  const evidence = await pipe.readTicketExecution(current());
  expect(evidence).toMatchObject({ operation_id: operation.id, state: "running", input });
  expect(evidence).not.toHaveProperty("result");
  expect(call).toHaveBeenCalledWith(binding, "get_session_operation", { operation_id: operation.id });
  expect(current().session_id).toBeNull();
  expect(local).not.toHaveBeenCalled();

  store.devTickets.runner.save({ ...operation, state: "finished" });
  call.mockResolvedValueOnce({ protocol: "runner-session-operation/v1", operation_id: operation.id,
    state: "succeeded", session_id: "native-id", input, result: { result_text: "private tool output" } });
  await expect(pipe.readTicketExecution(current())).resolves.toMatchObject({ state: "succeeded" });
  store.devTickets.runner.save({ ...operation, state: "finished", receipt: {
    protocol: "runner-session-operation/v1", operation_id: operation.id, state: "failed",
    result: { code: "dispatch_refused", error: "precise binding refusal" },
  } });
  call.mockResolvedValueOnce({ protocol: "runner-session-operation/v1", operation_id: operation.id,
    state: "missing", session_id: "native-id", input, result: { result_text: "not projected" } });
  await expect(pipe.readTicketExecution(current())).resolves.toMatchObject({ operation_id: operation.id, state: "failed" });
  const previousCalls = call.mock.calls.length;
  // A new turn marker precedes its operation record: the old result is not current.
  store.devTickets.updateDevTicket(ticket.id, { turn_started_at: new Date().toISOString() });
  await expect(pipe.readTicketExecution(current())).resolves.toBeUndefined();
  expect(call).toHaveBeenCalledTimes(previousCalls);
  store.devTickets.updateDevTicket(ticket.id, { turn_started_at: null });
  call.mockRejectedValueOnce(new Error("owner grant revoked"));
  await expect(pipe.readTicketExecution(current())).rejects.toThrow("owner grant revoked");

  const second = { ...operation, id: "ticket-execution-second", turn: 11 };
  store.devTickets.runner.save(second);
  call.mockResolvedValueOnce({ protocol: "runner-session-operation/v1", operation_id: second.id,
    state: "missing", session_id: "native-id", input, result: { result_text: "not projected" } });
  await expect(pipe.readTicketExecution(current())).resolves.toMatchObject({ operation_id: second.id, state: "missing" });
  expect(call).toHaveBeenLastCalledWith(binding, "get_session_operation", { operation_id: second.id });
  call.mockImplementationOnce(async () => {
    store.devTickets.runner.save({ ...second, state: "finished" });
    store.devTickets.updateDevTicket(ticket.id, { turn_started_at: new Date().toISOString() });
    return { protocol: "runner-session-operation/v1", operation_id: second.id,
      state: "succeeded", session_id: "native-id", input, result: { result_text: "old completion" } };
  });
  await expect(pipe.readTicketExecution(current())).rejects.toThrow("运行轮次已变化");
  store.devTickets.updateDevTicket(ticket.id, { turn_started_at: null });
  store.devTickets.runner.save(second);
  call.mockImplementationOnce(async () => {
    store.devTickets.runner.save({ ...second, state: "finished" });
    store.devTickets.runner.save({ ...second, id: "ticket-execution-third", turn: 12 });
    return { protocol: "runner-session-operation/v1", operation_id: second.id,
      state: "succeeded", session_id: "native-id", input, result: { result_text: "old completion" } };
  });
  await expect(pipe.readTicketExecution(current())).rejects.toThrow("运行轮次已变化");
});


it("reads the new running and finished operations after a real Store reopen resets the Bot turn counter", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ticket-execution-restart-order-"));
  const database = join(dir, "state.db");
  let store = new Store(database);
  cleanups.push(async () => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.saveUser({ username: "alice", uid: 1, home_dir: dir, created_at: new Date().toISOString() });
  const local = vi.fn(async () => { throw new Error("reading must not launch a provider"); });
  const makePipeline = () => new DevPipeline({ store, repoDir: dir, worktreesDir: dir, baseBranch: "v4",
    runTurn: local, buildWarmEnabled: false, knowledgeCaptureEnabled: false, pushRemote: null });
  const first = makePipeline();
  const ticket = first.createTicket({ requester: "alice", title: "restart order", body: "original task", model: "codex-gpt-6-astra" });
  const binding = { owner: "alice", device: "original-runner", source: "codex" as const, workspaceId: "ws_original" };
  store.devTickets.runner.bind(ticket.id, binding);
  store.devTickets.takeTicketInbox(ticket.id, 64);
  store.devTickets.updateDevTicket(ticket.id, { session_id: "original-native-id" });
  const old = { id: "ticket-old-unknown", ticketId: ticket.id, turn: 64,
    method: "start_session" as const, args: {}, state: "finished" as const };
  store.devTickets.runner.save(old);
  await first.stop();
  store.close();

  store = new Store(database);
  const second = makePipeline();
  cleanups.push(() => second.stop());
  const call = vi.fn(async (_binding: unknown, method: string, args: Record<string, unknown>) => {
    expect(method).toBe("get_session_operation");
    const operation = store.devTickets.runner.get(String(args.operation_id))!;
    return { protocol: "runner-session-operation/v1", operation_id: operation.id,
      state: operation.id === old.id ? "unknown" : operation.state === "finished" ? "succeeded" : "running",
      session_id: "original-native-id" };
  });
  second.setRunnerTickets({ config: { targets: {} }, call } as unknown as TicketRunnerAccess);
  const current = () => store.devTickets.getDevTicket(ticket.id)!;
  // A lower turn is expected after Bot restart, and must outrank old unknown.
  store.devTickets.addTicketMessage(ticket.id, "alice", "web", "continue original session");
  const next = store.devTickets.prepareRunnerTurn(ticket.id, 1, () => ({
    id: "ticket-new-continuation", ticketId: ticket.id, turn: 1, method: "append_session",
    args: { id: "original-native-id" }, state: "prepared",
  }))!;
  store.devTickets.runner.save({ ...next, state: "dispatched" });
  await expect(second.readTicketExecution(current())).resolves.toMatchObject({
    operation_id: next.id, state: "running", session_id: "original-native-id",
  });
  expect(store.devTickets.runner.latestStart(ticket.id)?.id).toBe(old.id);
  store.devTickets.runner.finish(next, { text: "new continuation completed", sessionId: "original-native-id" });
  await expect(second.readTicketExecution(current())).resolves.toMatchObject({
    operation_id: next.id, state: "succeeded", session_id: "original-native-id",
  });
  expect(call.mock.calls.every((row) => row[2].operation_id === next.id)).toBe(true);
  expect(local).not.toHaveBeenCalled();

  // A later original launch can also have a lower counter than pre-restart history.
  const latestStart = { ...old, id: "ticket-new-start", turn: 2 };
  store.devTickets.runner.save(latestStart);
  store.devTickets.runner.save({ ...old, args: { oldReceiptReconciled: true } });
  expect(store.devTickets.runner.latestStart(ticket.id)?.id).toBe(latestStart.id);
  expect(store.devTickets.runner.latest(ticket.id)?.id).toBe(latestStart.id);
});

it.each([
  ["reads the whole reply from the transcript", true],
  ["keeps the marked tail when the transcript cannot supply it", false],
] as const)("a truncated Runner receipt: %s", async (_case, transcriptHasReply) => {
  const dir = mkdtempSync(join(tmpdir(), "ticket-runner-receipt-"));
  const store = new Store(":memory:");
  cleanups.push(async () => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.saveUser({ username: "alice", uid: 1, home_dir: dir, created_at: "now" });
  const pipe = new DevPipeline({ store, repoDir: dir, worktreesDir: dir, buildWarmEnabled: false,
    knowledgeCaptureEnabled: false, pushRemote: null });
  cleanups.push(() => pipe.stop());
  const reply = "## 名字\nwhole-reply-slug\n\n## 方案\n" + "很长的说明。".repeat(20_000);
  const tail = reply.slice(-80_000);
  let started = false;
  const reads: Array<Record<string, unknown>> = [];
  pipe.setRunnerTickets({ resourceOwner: (owner: string) => owner, target: () => ({ device: "runner", workspace_id: "ws" }),
    config: { targets: {} }, prepareAttachments: async (_b: unknown, prompt: string) => prompt,
    call: async (_binding: unknown, method: string, args: Record<string, unknown>) => {
      if (method === "read_session") {
        reads.push(args);
        return { rich: true, offset: 0, total_messages: 2, messages: [
          { role: "user", blocks: [{ type: "text", text: "task" }] },
          { role: "assistant", blocks: [{ type: "text", text: transcriptHasReply ? reply : "unrelated" }] },
        ] };
      }
      if (method === "start_session") started = true;
      return { protocol: "runner-session-operation/v1", live_input: "steer-only/v1", operation_id: String(args.operation_id),
        ...(!started || args.operation_id === "ticket-protocol-probe" ? { state: "missing" }
          : { state: "succeeded", session_id: "native", result: { result_text: tail, result_text_truncated: true } }) };
    } } as unknown as TicketRunnerAccess);
  const ticket = pipe.createTicket({ requester: "alice", title: "long reply", body: "task", model: "codex-gpt-6-astra" });
  store.devTickets.updateDevTicket(ticket.id, { worktree: dir, branch: "ticket/test" });
  pipe.start();
  await vi.waitFor(() => expect(store.devTickets.listTicketMessages(ticket.id).filter((row) => row.author === "agent")).toHaveLength(1));
  const stored = store.devTickets.listTicketMessages(ticket.id).find((row) => row.author === "agent")!.body;
  expect(reads[0]).toMatchObject({ id: "native", rich: true });
  if (transcriptHasReply) {
    expect(stored).toBe(reply);
    expect(store.devTickets.getDevTicket(ticket.id)?.slug).toBe("whole-reply-slug");
  } else {
    expect(stored).toContain("Runner 回执只保留了这条回复的最后 80000 个字符");
    expect(stored.endsWith(tail)).toBe(true);
  }
});
