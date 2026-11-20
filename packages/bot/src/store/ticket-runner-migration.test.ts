import { afterEach, expect, it } from "vitest";
import { Store } from "./store.js";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

it("claims inbox atomically and makes Runner completion idempotent while retaining historical fields", () => {
  const store = new Store(":memory:"); stores.push(store);
  store.saveUser({ username: "alice", uid: 1, home_dir: "/unused", created_at: new Date().toISOString() });
  const ticket = store.devTickets.createDevTicket({ title: "retained", body: "original input", requester: "alice", model: "codex-gpt-6-astra", effort: "xhigh", kind: "simple", app_id: null });
  store.devTickets.updateDevTicket(ticket.id, { session_id: "historic", codex_account_slot: "slot-old" });
  expect(() => store.devTickets.prepareRunnerTurn(ticket.id, 1, () => { throw new Error("crash before journal"); })).toThrow();
  expect(store.devTickets.listTicketMessages(ticket.id, { undeliveredOnly: true })).toHaveLength(1);
  const turn = store.devTickets.prepareRunnerTurn(ticket.id, 2, () => ({ id: "op-one", ticketId: ticket.id, turn: 2, method: "append_session", state: "prepared", args: { prompt: "original input" } }))!;
  expect(store.devTickets.listTicketMessages(ticket.id, { undeliveredOnly: true })).toHaveLength(0);
  expect(store.devTickets.runner.finish(turn, { text: "answer" })).toBe(true);
  expect(store.devTickets.runner.finish(turn, { text: "answer" })).toBe(false);
  expect(store.devTickets.getDevTicket(ticket.id)).toMatchObject({ title: "retained", body: "original input", session_id: "historic", codex_account_slot: "slot-old" });
  expect(store.devTickets.listTicketMessages(ticket.id).filter((row) => row.author === "agent")).toHaveLength(1);
});


it("keeps the latest inserted start when process turn counters reset and old rows are updated", () => {
  const store = new Store(":memory:"); stores.push(store);
  store.saveUser({ username: "alice", uid: 1, home_dir: "/unused", created_at: new Date().toISOString() });
  const ticket = store.devTickets.createDevTicket({ title: "ordered", body: "input", requester: "alice",
    model: "codex-gpt-6-astra", effort: "xhigh", kind: "simple", app_id: null });
  for (const [id, turn] of [["start-high-z", 4], ["start-high-a", 4], ["start-low", 1]] as const) {
    store.devTickets.runner.save({ id, ticketId: ticket.id, turn, method: "start_session", state: "finished", args: {} });
  }
  expect(store.devTickets.runner.latestStart(ticket.id)?.id).toBe("start-low");
  store.devTickets.runner.save({ id: "start-high-z", ticketId: ticket.id, turn: 4,
    method: "start_session", state: "finished", args: { reconciled: true } });
  expect(store.devTickets.runner.latestStart(ticket.id)?.id).toBe("start-low");
  expect(store.devTickets.runner.latest(ticket.id)?.id).toBe("start-low");
  expect(store.devTickets.runner.latestStart(ticket.id + 1)).toBeNull();
});
