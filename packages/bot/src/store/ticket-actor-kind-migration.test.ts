import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { Store } from "./store.js";
import { migrateFixtureTo } from "./migration-test-helpers.js";

it("v86 leaves pre-existing tickets and messages unknown and records the kind of every new row", () => {
  const root = mkdtempSync(join(tmpdir(), "ticket-actor-kind-"));
  const file = join(root, "state.db");
  let store: Store | undefined;
  try {
    const old = new Database(file); migrateFixtureTo(old, 85);
    old.prepare("INSERT INTO users(username,uid,home_dir,created_at) VALUES ('lht',1,'/unused','before')").run();
    old.prepare("INSERT INTO dev_tickets(id,title,body,requester,dev_status,created_at,updated_at) VALUES (44,'old','agent-written long ago','lht','open','before','before')").run();
    old.prepare("INSERT INTO ticket_messages(id,ticket_id,author,via,body,delivered_turn,created_at) VALUES (1,44,'lht','web','old message',3,'before')").run();
    old.close();
    store = new Store(file);
    const tickets = store.devTickets;

    // Old rows are unknown, never guessed.
    expect(tickets.getDevTicket(44)?.actor_kind).toBeNull();
    expect(tickets.listTicketMessages(44)[0]).toMatchObject({ body: "old message", actor_kind: null });

    // A new ticket records its kind on the row and on its opening message.
    const scripted = tickets.createDevTicket({ title: "t", body: "written by a script", requester: "lht", kind: "simple",
      app_id: null, model: "fixture", effort: "high", actor_kind: "token" });
    expect(scripted.actor_kind).toBe("token");
    expect(tickets.listTicketMessages(scripted.id)).toMatchObject([{ author: "lht", via: "web", actor_kind: "token" }]);
    const typed = tickets.createDevTicket({ title: "t", body: "typed", requester: "lht", kind: "simple",
      app_id: null, model: "fixture", effort: "high", actor_kind: "browser" });
    expect(tickets.listTicketMessages(typed.id)[0]?.actor_kind).toBe("browser");
    // A caller that does not say is recorded as unknown rather than as a person.
    const unsaid = tickets.createDevTicket({ title: "t", body: "b", requester: "lht", kind: "simple", app_id: null, model: "fixture", effort: "high" });
    expect(unsaid.actor_kind).toBeNull();

    // Messages: explicit kinds persist; Head-authored rows default to system.
    expect(tickets.addTicketMessage(44, "lht", "web", "via mcp", undefined, "mcp").actor_kind).toBe("mcp");
    expect(tickets.addTicketMessage(44, "pipeline", "pipeline", "note").actor_kind).toBe("system");
    expect(tickets.addTicketMessage(44, "agent", "agent", "reply").actor_kind).toBe("system");
    expect(tickets.addTicketMessage(44, "lht", "web", "unsaid").actor_kind).toBeNull();

    // The Runner's recorded agent reply and the CLI report projection are Head-written.
    const turn = tickets.prepareRunnerTurn(typed.id, 1, () => ({ id: "turn-1", ticketId: typed.id,
      turn: 1, method: "append_session", args: { id: "session" }, state: "dispatched" }))!;
    expect(tickets.runner.finish(turn, { text: "done" })).toBe(true);
    expect(tickets.listTicketMessages(typed.id).at(-1)).toMatchObject({ author: "agent", body: "done", actor_kind: "system" });
    const cli = tickets.createCliDeliveryTicket({ title: "cli", body: "report", spec: "{}", requester: "lht",
      branch: "dev/x", commit_sha: "a".repeat(40), model: "fixture", effort: "high" });
    expect(cli.actor_kind).toBe("system");
    expect(tickets.listTicketMessages(cli.id)).toMatchObject([{ via: "cli-report", actor_kind: "system" }]);

    // A native CLI registration writes a fixed Head template, not the owner's words.
    const native = tickets.registerNativeTicket({ owner: "lht", device: "laptop", source: "codex", sessionId: "s-1",
      workspaceId: "w-1", relativePath: ".", branch: "dev/native", remote: "origin", title: "native" });
    expect(native.actor_kind).toBe("system");
    expect(tickets.listTicketMessages(native.id)[0]?.actor_kind).toBe("system");
    const native_input = tickets.createNativeInput({ id: "native-1", ticketId: native.id, kind: "message", state: "dispatched" },
      "lht", "typed in the browser", "browser");
    expect(tickets.listTicketMessages(native.id).find((row) => row.id === native_input.messageId)?.actor_kind).toBe("browser");

    // The column only admits the documented kinds.
    const db = new Database(file);
    try {
      expect(() => db.prepare("UPDATE ticket_messages SET actor_kind='someone' WHERE id=1").run()).toThrow(/CHECK/);
      expect(() => db.prepare("UPDATE dev_tickets SET actor_kind='someone' WHERE id=44").run()).toThrow(/CHECK/);
    } finally { db.close(); }

    // Reopen: nothing about the kind is in memory only.
    store.close(); store = new Store(file);
    expect(store.devTickets.getDevTicket(scripted.id)?.actor_kind).toBe("token");
    expect(store.devTickets.getDevTicket(44)?.actor_kind).toBeNull();
  } finally { store?.close(); rmSync(root, { recursive: true, force: true }); }
});
