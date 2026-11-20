import { afterEach, describe, expect, it } from "vitest";
import { Store } from "./store.js";
import { MERGE_PROPOSAL_LIVE_STATUSES } from "./repositories/merge-proposals.js";

const stores: Store[] = [];
function makeStore(): Store {
  const store = new Store(":memory:");
  stores.push(store);
  store.saveUser({ username: "lilei", uid: 1, home_dir: "/x", created_at: "2026-08-20T00:00:00.000Z" });
  return store;
}
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});

function ticket(store: Store, lane: "direct" | "review" = "review"): number {
  return store.devTickets.createDevTicket({
    title: "t",
    body: "b",
    requester: "lilei",
    kind: "simple",
    app_id: null,
    model: "omp-gpt-5.6-sol",
    effort: "high",
    lane,
  }).id;
}

describe("dev_tickets.lane (migration v51)", () => {
  it("defaults to direct and persists review when asked", () => {
    const store = makeStore();
    const direct = store.devTickets.createDevTicket({
      title: "t", body: "b", requester: "lilei", kind: "simple", app_id: null, model: "m", effort: "high",
    });
    expect(direct.lane).toBe("direct");
    expect(store.devTickets.getDevTicket(ticket(store, "review"))!.lane).toBe("review");
  });
});

describe("MergeProposalsRepository", () => {
  it("creates a row and supersedes the previous live one of the same ticket", () => {
    const store = makeStore();
    const id = ticket(store);
    const first = store.mergeProposals.create({
      ticket_id: id, requester: "lilei", branch: "contrib/lilei/ticket-1", sha: "a".repeat(40), base_sha: "b".repeat(40),
      summary: "first", status: "ci_pending", pipeline_id: "11", pipeline_url: "https://ci/11",
    });
    expect(first.status).toBe("ci_pending");
    const second = store.mergeProposals.create({
      ticket_id: id, requester: "lilei", branch: "contrib/lilei/ticket-1", sha: "c".repeat(40), base_sha: "b".repeat(40),
      summary: "second", status: "awaiting_review",
    });
    expect(store.mergeProposals.get(first.id)!.status).toBe("superseded");
    expect(store.mergeProposals.liveForTicket(id)!.id).toBe(second.id);
    expect(store.mergeProposals.latestByTicket().get(id)!.id).toBe(second.id);
    // History is kept, not rewritten.
    expect(store.mergeProposals.listRecent().map((r) => r.id)).toEqual([second.id, first.id]);
  });

  it("transitions atomically and refuses a stale view", () => {
    const store = makeStore();
    const id = ticket(store);
    const row = store.mergeProposals.create({
      ticket_id: id, requester: "lilei", branch: "b", sha: "a".repeat(40), base_sha: "b".repeat(40),
      summary: "s", status: "awaiting_review",
    });
    expect(store.mergeProposals.transition(row.id, ["awaiting_review"], "approved", { review_by: "lht" })).toBe(true);
    // A second reviewer acting on the same stale row changes nothing.
    expect(store.mergeProposals.transition(row.id, ["awaiting_review"], "rejected", { review_by: "x" })).toBe(false);
    const after = store.mergeProposals.get(row.id)!;
    expect(after.status).toBe("approved");
    expect(after.review_by).toBe("lht");
    expect(store.mergeProposals.listByStatus(["approved"]).map((r) => r.id)).toEqual([row.id]);
    expect(() => store.mergeProposals.transition(row.id, ["approved"], "merging", { sha: "x" } as never)).toThrow(/unpatchable/);
  });

  it("knows which statuses are still live", () => {
    expect([...MERGE_PROPOSAL_LIVE_STATUSES]).toEqual([
      "ci_pending", "ci_failed", "awaiting_review", "approved", "rejected", "merging", "merge_failed",
    ]);
  });
});
