import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../store/store.js";
import { RunnerTicketInputDelivery } from "./runner-ticket-input.js";
import type { SessionOperationReceipt } from "@claude-bot/runner/gateway-protocol";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function fixture() {
  const store = new Store(":memory:"); stores.push(store);
  store.saveUser({ username: "alice", uid: 1, home_dir: "/unused", created_at: "now" });
  const ticket = store.devTickets.createDevTicket({ requester: "alice", title: "input", body: "initial", model: "codex-gpt-6-astra", effort: "high", kind: "simple", lane: "direct", app_id: null });
  const turn = store.devTickets.prepareRunnerTurn(ticket.id, 1, () => ({
    id: "turn-original", ticketId: ticket.id, turn: 1, method: "start_session", state: "dispatched", args: {},
  }))!;
  const receipts = new Map<string, SessionOperationReceipt>();
  const protocol = "runner-session-operation/v1" as const;
  let loseAck = false;
  const call = vi.fn(async (_binding, method, args) => {
    const id = String(args.operation_id);
    if (method === "append_session") {
      receipts.set(id, { protocol, operation_id: id, state: "succeeded", session_id: "native" });
      if (loseAck) { loseAck = false; throw new Error("connection lost"); }
    }
    return receipts.get(id) ?? { protocol, operation_id: id, state: "missing" };
  });
  const prepareAttachments = vi.fn(async (_binding, prompt: string) => prompt);
  const delivery = new RunnerTicketInputDelivery({ turn,
    binding: { owner: "alice", device: "runtime", executionDevice: "execution", source: "codex", workspaceId: "ws" },
    repository: store.devTickets.runner,
    access: { call, prepareAttachments },
    unread: () => store.devTickets.listTicketMessages(ticket.id, { undeliveredOnly: true }),
    blocked: () => Boolean(store.devTickets.getDevTicket(ticket.id)?.chat_paused),
    prompt: (messages) => messages.map((row) => row.body).join("\n"),
  });
  const started: SessionOperationReceipt = { protocol, operation_id: turn.id, state: "running", session_id: "native",
    live_input: "steer-only/v1", input: { phase: "provider_accepted", evidence: "provider_ack", at: new Date().toISOString() } };
  return { store, ticket, turn, delivery, call, started, receipts, prepareAttachments,
    post: (text: string) => store.devTickets.addTicketMessage(ticket.id, "alice", "web", text),
    messages: () => store.devTickets.listTicketMessages(ticket.id),
    loseAck: () => { loseAck = true; } };
}

describe("ordinary Runner input for ticket chat", () => {
  it("recovers attachment preparation before dispatching a claimed input", async () => {
    const f = fixture(); const message = f.post("attachment");
    f.store.devTickets.runner.claimInput({ id: "prepared-input", ticketId: f.ticket.id, turnId: f.turn.id,
      turn: 1, messageIds: [message.id], args: { id: "native", prompt: "attachment", steer_only: true },
      attachmentBodies: ["attachment"], state: "prepared" });
    f.prepareAttachments.mockResolvedValue("device attachment");
    await f.delivery.observe(f.started);
    expect(f.prepareAttachments).toHaveBeenCalledOnce();
    expect(f.call).toHaveBeenCalledWith(expect.anything(), "append_session", expect.objectContaining({ prompt: "device attachment", operation_id: "prepared-input" }));
    expect(f.messages()[1].delivery_state).toBe("delivered");
  });
  it("holds startup input only until admission, then steers the original turn without changing model", async () => {
    const f = fixture(); f.post("keep 4090"); f.post("default 4090");
    await f.delivery.observe({ ...f.started, input: undefined });
    expect(f.call).not.toHaveBeenCalled();
    expect(f.messages()[0].delivery_state).toBe("sending");
    await f.delivery.observe(f.started);
    const sends = f.call.mock.calls.filter((row) => row[1] === "append_session");
    expect(sends).toHaveLength(1);
    expect(sends[0][2]).toMatchObject({ id: "native", source: "codex", steer_only: true, input_receipt: true, prompt: "keep 4090\ndefault 4090" });
    expect(sends[0][2]).not.toHaveProperty("model");
    expect(sends[0][2]).not.toHaveProperty("effort");
    expect(f.messages().map((row) => row.delivery_state)).toEqual(["delivered", "delivered", "delivered"]);
    await f.delivery.observe(f.started);
    expect(f.call.mock.calls.filter((row) => row[1] === "append_session")).toHaveLength(1);
  });

  it("queries the original input after a lost acknowledgement, without replaying identical text", async () => {
    const f = fixture(); f.post("same"); f.loseAck();
    await f.delivery.observe(f.started);
    expect(f.messages()[1].delivery_state).toBe("unknown");
    await f.delivery.observe(f.started);
    expect(f.messages()[1].delivery_state).toBe("delivered");
    f.post("same"); await f.delivery.observe(f.started);
    const sends = f.call.mock.calls.filter((row) => row[1] === "append_session");
    expect(sends).toHaveLength(2);
    expect(sends[0][2].operation_id).not.toBe(sends[1][2].operation_id);
  });

  it("a pause preserves the unread inbox and still reconciles an already dispatched message", async () => {
    const f = fixture(); f.post("before stop"); f.loseAck();
    await f.delivery.observe(f.started);
    f.store.devTickets.updateDevTicket(f.ticket.id, { chat_paused: 1 });
    f.post("after stop");
    await f.delivery.observe(f.started);
    expect(f.messages()[1].delivery_state).toBe("delivered");
    expect(f.messages()[2].delivered_turn).toBeNull();
    expect(f.store.devTickets.listTicketsNeedingTurn()).toEqual([]);
    expect(f.call.mock.calls.filter((row) => row[1] === "append_session")).toHaveLength(1);
  });

  it("only an explicit no-input refusal returns a message to the next-turn inbox", async () => {
    const f = fixture(); f.post("late");
    f.call.mockImplementation(async (_binding, method, args) => ({
      protocol: "runner-session-operation/v1", operation_id: args.operation_id,
      state: method === "append_session" ? "failed" : "missing", result: { code: "turn_not_active" },
    }));
    await f.delivery.observe(f.started);
    expect(f.messages()[1]).toMatchObject({ delivered_turn: null, delivery_state: null });
    expect(f.store.devTickets.runner.inputs(f.turn.id)).toHaveLength(0);
  });

  it("does not send steer-only to a Runner that may ignore the narrowing parameter", async () => {
    const f = fixture(); f.post("must not start a new turn");
    await f.delivery.observe({ ...f.started, live_input: undefined });
    expect(f.call).not.toHaveBeenCalled();
    expect(f.messages()[1].delivered_turn).toBeNull();
  });

  it("a missing dispatched receipt is unknown and cannot wake a second execution", async () => {
    const f = fixture(); const message = f.post("unknown");
    f.store.devTickets.runner.claimInput({ id: "previous-input", ticketId: f.ticket.id, turnId: f.turn.id,
      turn: 1, messageIds: [message.id], args: { prompt: "unknown" }, state: "dispatched" });
    await f.delivery.observe(f.started);
    expect(f.messages()[1].delivery_state).toBe("unknown");
    expect(f.store.devTickets.listTicketsNeedingTurn()).toEqual([]);
    expect(f.call.mock.calls.every((row) => row[1] === "get_session_operation")).toBe(true);
  });
});
