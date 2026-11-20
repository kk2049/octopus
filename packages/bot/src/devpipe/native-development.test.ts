import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Store } from "../store/store.js";
import { NativeDevelopmentService } from "./native-development.js";
import type { TicketRunnerAccess } from "./runner-ticket.js";
import { SESSION_OPERATION_PROTOCOL } from "@claude-bot/runner/gateway-protocol";

let dir: string, store: Store, service: NativeDevelopmentService, call: ReturnType<typeof vi.fn>;
const owner = { owner: "alice", device: "workstation" };
const proof = () => ({ protocol: "native-development/v1", source: "codex", session_id: "11111111-1111-4111-8111-111111111111",
  workspace_id: "workspace", relative_path: "feature", branch: "dev/alice-feature", remote: "git@gitlab.example:team/octopus.git",
  observed_at: new Date().toISOString(), title: "Native development" });
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "native-development-"));
  execFileSync("git", ["init", dir], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "remote", "add", "origin", proof().remote]);
  store = new Store(":memory:"); store.saveUser({ username: "alice", uid: 1, home_dir: "/alice", created_at: new Date().toISOString() });
  call = vi.fn(async (_binding, method, args) => ({ protocol: SESSION_OPERATION_PROTOCOL, operation_id: args.operation_id,
    native_input: "cli-only/v1", state: method === "get_session_operation" ? "missing" : "running" }));
  service = new NativeDevelopmentService({ repository: store.devTickets, repoDir: dir,
    access: () => ({ devicesFor: () => [{ device: owner.device, online: true }], call } as unknown as TicketRunnerAccess) });
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

it("binds one native ticket idempotently without ever scheduling a managed turn", async () => {
  const first = await service.register(owner, proof());
  expect(await service.register(owner, proof())).toEqual(first);
  store.devTickets.addTicketMessage(first.ticket_id, "alice", "web", "not a managed prompt");
  expect(store.devTickets.listTicketsNeedingTurn()).toEqual([]);
  expect(store.devTickets.listDevTickets()[0].unread).toBe(0);
  expect(store.devTickets.countDevTickets().queued_input).toBe(0);
  expect(call).not.toHaveBeenCalled();
  await expect(service.register(owner, { ...proof(), workspace_id: "other" })).rejects.toThrow(/cannot change/);
});

it("ends tracking without controlling the CLI or discarding uncertain receipts, and explicitly re-registers", async () => {
  const registered = await service.register(owner, proof());
  const ticket = store.devTickets.getDevTicket(registered.ticket_id)!;
  const input = await service.input(ticket, "alice", "hello");
  const calls = call.mock.calls.length;
  const closed = store.devTickets.closeNativeTicket(ticket.id, "alice");
  expect(closed).toMatchObject({ dev_status: "completed", chat_paused: 1, session_id: ticket.session_id });
  expect(store.devTickets.nativeInput(input.id)?.state).toBe("dispatched");
  await expect(service.input(closed, "alice", "not sent")).rejects.toThrow(/结束/);
  expect(call).toHaveBeenCalledTimes(calls);
  expect(await service.register(owner, proof())).toEqual(registered);
  expect(store.devTickets.getDevTicket(ticket.id)).toMatchObject({ dev_status: "open", chat_paused: 0 });
  store.devTickets.updateDevTicket(ticket.id, { dev_status: "landed", deploy_status: "verified" });
  expect(store.devTickets.closeNativeTicket(ticket.id, "alice")).toMatchObject({ dev_status: "landed", deploy_status: "verified", chat_paused: 1 });
});
it("rejects foreign repository and stale proofs before creating a ticket", async () => {
  await expect(service.register(owner, { ...proof(), remote: "git@gitlab.example:other/private.git" })).rejects.toThrow(/different repository/);
  await expect(service.register(owner, { ...proof(), observed_at: "invalid" })).rejects.toThrow(/stale/);
  expect(store.devTickets.listDevTickets()).toHaveLength(0);
});

it("explicitly attaches an owned historical CLI report without rewriting its delivery, and refuses foreign or duplicate targets", async () => {
  const report = store.devTickets.createCliDeliveryTicket({ title: "Delivered", body: "Immutable report", spec: "acceptance", requester: "alice",
    branch: "v4", commit_sha: "b".repeat(40), model: "codex", effort: "high" });
  store.devTickets.updateDevTicket(report.id, { deploy_status: "verified" });
  await expect(service.register({ ...owner, owner: "bob" }, { ...proof(), ticket_id: report.id })).rejects.toThrow(/owned/);
  expect(store.devTickets.getDevTicket(report.id)?.session_id).toBeNull();
  expect(await service.register(owner, { ...proof(), ticket_id: report.id })).toMatchObject({ ticket_id: report.id });
  expect(store.devTickets.getDevTicket(report.id)).toMatchObject({ title: "Delivered", body: "Immutable report", branch: "v4",
    commit_sha: "b".repeat(40), dev_status: "landed", deploy_status: "verified", session_id: proof().session_id });
  expect(await service.register(owner, { ...proof(), ticket_id: report.id })).toMatchObject({ ticket_id: report.id });
  await expect(service.register(owner, { ...proof(), ticket_id: report.id + 1 })).rejects.toThrow(/another ticket/);
  expect(store.devTickets.listTicketsNeedingTurn()).toEqual([]);
});
it("never sends to an old Runner that could ignore native-only ownership", async () => {
  const registered = await service.register(owner, proof()), ticket = store.devTickets.getDevTicket(registered.ticket_id)!;
  call.mockImplementation(async (_binding, _method, args) => ({ protocol: SESSION_OPERATION_PROTOCOL, operation_id: args.operation_id, state: "missing" }));
  await expect(service.input(ticket, "alice", "continue")).rejects.toThrow(/升级/);
  expect(call.mock.calls.map(row => row[1])).toEqual(["get_session_operation"]);
  expect(store.devTickets.latestNativeInput(ticket.id)).toBeNull();
});
it("keeps an uncertain original operation across reconnect and only queries its receipt", async () => {
  const registered = await service.register(owner, proof()), ticket = store.devTickets.getDevTicket(registered.ticket_id)!;
  call.mockImplementation(async (_binding, method, args) => {
    if (method === "append_session") throw new Error("connection lost after write");
    return { protocol: SESSION_OPERATION_PROTOCOL, operation_id: args.operation_id, native_input: "cli-only/v1", state: "missing" };
  });
  const input = await service.input(ticket, "alice", "continue"); expect(input.state).toBe("unknown");
  expect(await service.execution(ticket)).toMatchObject({ operation_id: input.id, state: "unknown" });
  expect(await service.execution(ticket)).toMatchObject({ operation_id: input.id, state: "unknown" });
  expect(call.mock.calls.filter(row => row[1] === "append_session")).toHaveLength(1);
  expect(call.mock.calls.find(row => row[1] === "append_session")?.[2]).toMatchObject({ id: ticket.session_id, native_cli_only: true,
    native_workspace_id: "workspace", native_relative_path: "feature", operation_id: input.id });
  expect(store.devTickets.listTicketsNeedingTurn()).toEqual([]);
});
it("reconciles a native landing into the original ticket without losing the session", async () => {
  const registered = await service.register(owner, proof());
  const landed = store.devTickets.createCliDeliveryTicket({ native_ticket_id: registered.ticket_id, title: "Delivered", body: "report", spec: "acceptance",
    requester: "alice", branch: "v4", commit_sha: "a".repeat(40), model: "codex", effort: "high" });
  expect(landed).toMatchObject({ id: registered.ticket_id, session_id: proof().session_id, dev_status: "landed", deploy_status: "pending" });
  expect(landed.native_binding).toBeTruthy(); expect(store.devTickets.listDevTickets()).toHaveLength(1);
  expect(() => store.devTickets.createCliDeliveryTicket({ native_ticket_id: registered.ticket_id, title: "forged", body: "x", spec: "x",
    requester: "mallory", branch: "v4", commit_sha: "a".repeat(40), model: "codex", effort: "high" })).toThrow(/does not match/);
});

it("settles an earlier message receipt after an interrupt becomes the latest operation without replay", async () => {
  const registered = await service.register(owner, proof()), ticket = store.devTickets.getDevTicket(registered.ticket_id)!;
  const message = await service.input(ticket, "alice", "count until interrupted");
  const interrupt = await service.input(ticket, "alice");
  expect(store.devTickets.nativeInput(message.id)?.state).toBe("dispatched");
  call.mockImplementation(async (_binding, method, args) => {
    expect(method).toBe("get_session_operation");
    return { protocol: SESSION_OPERATION_PROTOCOL, operation_id: args.operation_id,
      native_input: "cli-only/v1", state: "succeeded", result: { ok: true } };
  });
  expect(await service.execution(ticket)).toMatchObject({ operation_id: interrupt.id, state: "succeeded" });
  expect(store.devTickets.nativeInput(message.id)?.state).toBe("accepted");
  expect(store.devTickets.listTicketMessages(ticket.id).find(row => row.id === message.messageId)?.delivery_state).toBe("delivered");
  expect(call.mock.calls.filter(row => row[1] === "append_session")).toHaveLength(2);
});

it("rechecks bridge authorization after asynchronous proof validation before persisting a binding", async () => {
  await expect(service.register(owner, proof(), () => false)).rejects.toThrow(/revoked/);
  expect(store.devTickets.listDevTickets()).toEqual([]);
});

it("binds a native Claude Code session separately and keeps its provider on every native input", async () => {
  const codex = await service.register(owner, proof());
  const claude = await service.register(owner, { ...proof(), source: "claude" });
  expect(claude.ticket_id).not.toBe(codex.ticket_id);
  const ticket = store.devTickets.getDevTicket(claude.ticket_id)!;
  expect(ticket).toMatchObject({ model: "claude-native", session_id: proof().session_id });
  expect(JSON.parse(ticket.native_binding!)).toMatchObject({ source: "claude" });
  expect(store.devTickets.runner.binding(ticket.id)).toMatchObject({ source: "claude", executionDevice: owner.device });
  await service.input(ticket, "alice", "continue");
  await service.input(ticket, "alice");
  const sends = call.mock.calls.filter((row) => row[1] === "append_session").map((row) => row[2]);
  expect(sends).toEqual([expect.objectContaining({ source: "claude", prompt: "continue", native_cli_only: true }),
    expect.objectContaining({ source: "claude", interrupt: true, native_cli_only: true })]);
  await expect(service.register(owner, { ...proof(), source: "omp" })).rejects.toThrow(/invalid/);
  expect(store.devTickets.listTicketsNeedingTurn()).toEqual([]);
});

it("sends a long native message whole and refuses only above the shared session prompt budget", async () => {
  const registered = await service.register(owner, proof());
  const ticket = store.devTickets.getDevTicket(registered.ticket_id)!;
  const long = "继续".repeat(3_000); // 6,000 characters: refused by the old 4,000 cap
  await service.input(ticket, "alice", long);
  expect(call.mock.calls.some(([, method, args]) => method === "append_session" && (args as { prompt?: string }).prompt === long)).toBe(true);
  await expect(service.input(ticket, "alice", "x".repeat(384 * 1024 + 1))).rejects.toThrow(/prompt budget/);
});
