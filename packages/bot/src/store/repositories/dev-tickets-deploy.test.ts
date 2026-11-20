import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Store } from "../store.js";

describe("Store deploy intents + verify tickets (self-hosting phase 2)", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(":memory:");
  });
  afterEach(() => store.close());

  it("allows exactly one active intent; terminal states release the slot", () => {
    const a = store.devTickets.createDeployIntent({ target_sha: "aaa111", triggered_by: "alice" });
    expect(a.status).toBe("requested");
    expect(() => store.devTickets.createDeployIntent({ target_sha: "bbb222", triggered_by: "bob" })).toThrow(/进行中/);
    for (const st of ["claimed", "building", "restarting", "health_gate", "confirm_wait"]) {
      store.devTickets.updateDeployIntent(a.id, { status: st });
      expect(() => store.devTickets.createDeployIntent({ target_sha: "bbb222", triggered_by: "bob" })).toThrow(/进行中/);
      expect(store.devTickets.getActiveDeployIntent()?.id).toBe(a.id);
    }
    store.devTickets.updateDeployIntent(a.id, { status: "succeeded" });
    expect(store.devTickets.getActiveDeployIntent()).toBeUndefined();
    expect(store.devTickets.createDeployIntent({ target_sha: "bbb222", triggered_by: "bob" }).id).toBe(a.id + 1);
  });

  it("records the liveness decision exactly once and only during confirm_wait", () => {
    const a = store.devTickets.createDeployIntent({ target_sha: "aaa", triggered_by: "alice" });
    expect(store.devTickets.recordDeployDecision(a.id, "alive", "bob")).toBe(false); // not waiting yet
    store.devTickets.updateDeployIntent(a.id, { status: "confirm_wait", confirm_deadline: "2026-07-25T12:00:00.000Z" });
    expect(store.devTickets.recordDeployDecision(a.id, "alive", "bob")).toBe(true);
    expect(store.devTickets.recordDeployDecision(a.id, "rollback", "eve")).toBe(false); // already decided
    const row = store.devTickets.getDeployIntent(a.id)!;
    expect(row.confirm_decision).toBe("alive");
    expect(row.confirm_by).toBe("bob");
  });

  it("patch whitelist protects identity/decision columns", () => {
    const a = store.devTickets.createDeployIntent({ target_sha: "aaa", triggered_by: "alice" });
    store.devTickets.updateDeployIntent(a.id, { base_sha: "prev", detail: "building…" });
    expect(store.devTickets.getDeployIntent(a.id)!.base_sha).toBe("prev");
    expect(() => store.devTickets.updateDeployIntent(a.id, { confirm_decision: "alive" } as never)).toThrow(/unpatchable/);
    expect(() => store.devTickets.updateDeployIntent(a.id, { triggered_by: "eve" } as never)).toThrow(/unpatchable/);
  });

  it("sweep sees terminal unnotified intents until marked", () => {
    const a = store.devTickets.createDeployIntent({ target_sha: "aaa", triggered_by: "alice" });
    expect(store.devTickets.listUnnotifiedDeployIntents()).toHaveLength(0);
    store.devTickets.updateDeployIntent(a.id, { status: "rolled_back", detail: "confirm_timeout" });
    expect(store.devTickets.listUnnotifiedDeployIntents().map((r) => r.id)).toEqual([a.id]);
    store.devTickets.updateDeployIntent(a.id, { notified: 1 });
    expect(store.devTickets.listUnnotifiedDeployIntents()).toHaveLength(0);
  });

  it("verify tickets round-trip JSON fields and resolve exactly once", () => {
    const a = store.devTickets.createDeployIntent({ target_sha: "abc", triggered_by: "alice" });
    const v = store.devTickets.createVerifyTicket({
      intent_id: a.id,
      target_sha: "abc",
      ticket_ids: [1, 2],
      modules_touched: ["dashboard", "devpipe"],
      checklist: [{ ticket_id: 1, title: "面板", criteria: "- 打开可见" }],
      assignees: ["alice", "bob"],
    });
    expect(store.devTickets.getOpenVerifyTicket()?.id).toBe(v.id);
    expect(JSON.parse(v.ticket_ids)).toEqual([1, 2]);
    expect(JSON.parse(v.assignees)).toContain("bob");
    expect(store.devTickets.resolveVerifyTicket(v.id, "passed", "bob", "ok")).toBe(true);
    expect(store.devTickets.resolveVerifyTicket(v.id, "failed", "eve")).toBe(false);
    expect(store.devTickets.getVerifyTicket(v.id)!.status).toBe("passed");
    expect(store.devTickets.getOpenVerifyTicket()).toBeUndefined();
  });

  it("folds every open deploy into one snapshot and resolves that snapshot atomically", () => {
    const a = store.devTickets.createDeployIntent({ target_sha: "aaa", triggered_by: "alice" });
    store.devTickets.updateDeployIntent(a.id, { status: "succeeded" });
    const first = store.devTickets.createVerifyTicket({
      intent_id: a.id,
      target_sha: "aaa",
      ticket_ids: [11],
      modules_touched: ["packages/bot"],
      checklist: [{ ticket_id: 11, title: "first", criteria: "A" }],
      assignees: ["alice"],
    });
    const b = store.devTickets.createDeployIntent({ target_sha: "bbb", triggered_by: "bob" });
    store.devTickets.updateDeployIntent(b.id, { status: "succeeded" });
    const second = store.devTickets.createVerifyTicket({
      intent_id: b.id,
      target_sha: "bbb",
      ticket_ids: [11, 12],
      modules_touched: ["packages/dashboard-web"],
      checklist: [
        { ticket_id: 11, title: "first refreshed", criteria: "A2" },
        { ticket_id: 12, title: "second", criteria: "B" },
      ],
      assignees: ["bob"],
    });

    const block = store.devTickets.getOpenVerifyBlock()!;
    expect(block).toMatchObject({ id: second.id, target_sha: "bbb", deployment_count: 2 });
    expect(JSON.parse(block.ticket_ids)).toEqual([11, 12]);
    expect(JSON.parse(block.modules_touched)).toEqual(["packages/bot", "packages/dashboard-web"]);
    expect(JSON.parse(block.assignees)).toEqual(["alice", "bob"]);
    expect(JSON.parse(block.checklist)).toEqual([
      { ticket_id: 11, title: "first refreshed", criteria: "A2" },
      { ticket_id: 12, title: "second", criteria: "B" },
    ]);

    // A deploy that lands after the browser rendered has a larger anchor and
    // must not be accepted by the older click.
    const c = store.devTickets.createDeployIntent({ target_sha: "ccc", triggered_by: "carol" });
    store.devTickets.updateDeployIntent(c.id, { status: "succeeded" });
    const third = store.devTickets.createVerifyTicket({
      intent_id: c.id,
      target_sha: "ccc",
      ticket_ids: [13],
      modules_touched: ["doc/"],
      checklist: [{ ticket_id: 13, title: "third", criteria: "C" }],
      assignees: ["carol"],
    });
    const resolved = store.devTickets.resolveOpenVerifyBlock(second.id, "passed", "alice", "ok")!;
    expect(resolved.deployment_count).toBe(2);
    expect(store.devTickets.getVerifyTicket(first.id)?.status).toBe("passed");
    expect(store.devTickets.getVerifyTicket(second.id)?.status).toBe("passed");
    expect(store.devTickets.getVerifyTicket(third.id)?.status).toBe("open");
    expect(store.devTickets.getOpenVerifyBlock()).toMatchObject({ id: third.id, deployment_count: 1 });
  });
});
