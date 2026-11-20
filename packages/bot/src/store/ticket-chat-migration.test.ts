import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { Store } from "./store.js";
import { migrateFixtureTo } from "./migration-test-helpers.js";

it("upgrades old messages unchanged and preserves paused, dispatched input across reopen", () => {
  const root = mkdtempSync(join(tmpdir(), "ticket-chat-upgrade-"));
  const file = join(root, "state.db");
  try {
    const old = new Database(file); migrateFixtureTo(old, 75);
    old.prepare("INSERT INTO users(username,uid,home_dir,created_at) VALUES ('alice',1,'/unused','before')").run();
    old.prepare("INSERT INTO dev_tickets(id,title,body,requester,dev_status,created_at,updated_at) VALUES (590,'original','original','alice','open','before','before')").run();
    old.prepare("INSERT INTO ticket_messages(id,ticket_id,author,via,body,delivered_turn,created_at) VALUES (1,590,'alice','web','原始消息',7,'before')").run();
    old.close();
    let store = new Store(file);
    expect(store.devTickets.listTicketMessages(590)[0]).toMatchObject({ body: "原始消息", delivered_turn: 7, delivery_state: null });
    expect(store.devTickets.getDevTicket(590)?.chat_paused).toBe(0);
    store.devTickets.addTicketMessage(590, "alice", "web", "new turn");
    const turn = store.devTickets.prepareRunnerTurn(590, 8, () => ({ id: "turn", ticketId: 590,
      turn: 8, method: "append_session", args: { id: "original-session" }, state: "dispatched" }))!;
    const message = store.devTickets.addTicketMessage(590, "alice", "web", "in flight");
    store.devTickets.runner.claimInput({ id: "input", ticketId: 590, turnId: turn.id, turn: 8,
      messageIds: [message.id], args: { prompt: "in flight" }, state: "dispatched" });
    store.devTickets.updateDevTicket(590, { chat_paused: 1 });
    store.devTickets.runner.save({ ...turn, stopRequestedBy: "alice" });
    store.devTickets.addTicketMessage(590, "alice", "web", "after stop");
    store.close();
    store = new Store(file);
    expect(store.devTickets.getDevTicket(590)?.chat_paused).toBe(1);
    expect(store.devTickets.runner.active(590)?.stopRequestedBy).toBe("alice");
    expect(store.devTickets.runner.inputs("turn")).toMatchObject([{ id: "input", state: "dispatched", messageIds: [message.id] }]);
    expect(store.devTickets.listTicketsNeedingTurn()).toEqual([]);
    expect(store.devTickets.listTicketMessages(590, { undeliveredOnly: true }).map((row) => row.body)).toEqual(["after stop"]);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
