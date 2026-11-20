import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeDevTicketInput } from "../devpipe/ticket-models.js";
import { Store } from "./store.js";

describe("app_hotswap_approvals (migration v42, multi-App key v62)", () => {
  let store: Store;
  let ticketId: number;

  beforeEach(() => {
    store = new Store(":memory:");
    store.saveUser({ username: "alice", uid: 5001, home_dir: "/x/alice", created_at: "2026-08-15T00:00:00.000Z" });
    ticketId = store.devTickets.createDevTicket(normalizeDevTicketInput({
      title: "hot replace",
      body: "replace exact App release",
      requester: "alice",
      kind: "app",
      app_id: "session-plus",
    })).id;
  });

  afterEach(() => store.close());

  function row(id = "ahr_00000000-0000-4000-8000-000000000001") {
    return {
      id,
      ticket_id: ticketId,
      app_id: "session-plus",
      source_commit: "1".repeat(40),
      package_digest: "2".repeat(64),
      previous_digest: "3".repeat(64),
      contract_digest: "4".repeat(64),
      coexistence_verdict: JSON.stringify({ mode: "refresh_required", reason: "state_epoch_changed" }),
      requested_by: `devpipe:ticket-${ticketId}`,
      requested_at: "2026-08-15T10:00:00.000Z",
    };
  }

  it("deduplicates one ticket/digest and consumes a decision with CAS", () => {
    const first = store.appCatalog.recordAppHotswapApproval(row());
    const replay = store.appCatalog.recordAppHotswapApproval(row("ahr_00000000-0000-4000-8000-000000000002"));
    expect(first.created).toBe(true);
    expect(replay).toMatchObject({ created: false, row: { id: first.row.id, state: "pending" } });

    expect(store.appCatalog.claimAppHotswapApproval(first.row.id, "approve", "user:root", "2026-08-15T10:01:00.000Z"))
      .toMatchObject({ ok: true, row: { state: "approved", decided_by: "user:root" } });
    expect(store.appCatalog.claimAppHotswapApproval(first.row.id, "reject", "user:other", "2026-08-15T10:02:00.000Z"))
      .toMatchObject({ ok: false, code: "not_pending", row: { state: "approved" } });
    expect(store.appCatalog.finishAppHotswapApproval(first.row.id, "executed", '{"code":"activated"}')).toBe(true);
    expect(store.appCatalog.getAppHotswapApproval(first.row.id)).toMatchObject({ state: "executed", outcome: '{"code":"activated"}' });
  });

  it("keeps the same digest as independent approval authority for each App", () => {
    const session = store.appCatalog.recordAppHotswapApproval(row());
    const research = store.appCatalog.recordAppHotswapApproval({
      ...row("ahr_00000000-0000-4000-8000-000000000002"),
      app_id: "research-program",
    });

    expect(session.created).toBe(true);
    expect(research).toMatchObject({
      created: true,
      row: { app_id: "research-program", package_digest: session.row.package_digest },
    });
    expect(store.appCatalog.listAppHotswapApprovals()).toHaveLength(2);
  });

  it("expires only pending requests at the 48-hour sweep boundary", () => {
    const pending = store.appCatalog.recordAppHotswapApproval(row()).row;
    expect(store.appCatalog.expireAppHotswapApprovals(
      "2026-08-15T10:00:00.000Z",
      "2026-08-17T10:00:00.000Z",
    )).toBe(1);
    expect(store.appCatalog.getAppHotswapApproval(pending.id)).toMatchObject({
      state: "expired",
      decided_by: "system:expiry",
    });
  });
});
