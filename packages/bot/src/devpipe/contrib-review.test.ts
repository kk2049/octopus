/**
 * The review lane's state machine, driven without git or a forge: a real
 * in-memory store, a scripted publisher and a scripted pipeline seam.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../store/store.js";
import type { DevTicketRow } from "../store/repositories/dev-tickets.js";
import {
  ContribReviewService,
  NO_FORGE_PUBLISHER,
  buildMergeBatchBody,
  contribBranchName,
  type ContribReviewPipeline,
  type PipelineVerdict,
  type ProposalPublisher,
} from "./contrib-review.js";

const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});

interface Harness {
  store: Store;
  svc: ContribReviewService;
  messages: Array<{ ticketId: number; author: string; via: string; body: string; actorKind?: string | null }>;
  notes: Array<{ ticketId: number; body: string }>;
  created: DevTicketRow[];
  verdicts: Map<string, PipelineVerdict>;
  opened: Array<{ branch: string; targetBranch: string; title: string }>;
  closed: Array<{ iid: number; note: string }>;
  applied: Map<string, { applied: boolean; evidence: string }>;
  ticket(requester?: string, lane?: "direct" | "review"): DevTicketRow;
}

function harness(opts: { publisher?: ProposalPublisher } = {}): Harness {
  const store = new Store(":memory:");
  stores.push(store);
  for (const u of ["lilei", "lht"]) store.saveUser({ username: u, uid: u === "lilei" ? 1 : 2, home_dir: "/x", created_at: "2026-08-20T00:00:00.000Z" });
  const messages: Harness["messages"] = [];
  const notes: Harness["notes"] = [];
  const created: DevTicketRow[] = [];
  const verdicts = new Map<string, PipelineVerdict>();
  const opened: Harness["opened"] = [];
  const closed: Harness["closed"] = [];
  const applied = new Map<string, { applied: boolean; evidence: string }>();
  const pipeline: ContribReviewPipeline = {
    baseBranch: "v4",
    createTicket(input) {
      const row = store.devTickets.createDevTicket({
        title: input.title,
        body: input.body,
        requester: input.requester,
        kind: input.kind ?? "simple",
        app_id: null,
        model: input.model ?? "omp-gpt-5.6-sol",
        effort: input.effort ?? "high",
        via: input.via,
        actor_kind: input.actor_kind ?? null,
      });
      created.push(row);
      return row;
    },
    postMessage(ticketId, author, via, body, actorKind) {
      messages.push({ ticketId, author, via, body, actorKind });
      return store.devTickets.addTicketMessage(ticketId, author, via, body, undefined, actorKind);
    },
    postPipelineNote(ticketId, body) {
      notes.push({ ticketId, body });
    },
    async proposalApplied(proposal, landedSha) {
      return applied.get(`${proposal.sha}@${landedSha}`) ?? { applied: false, evidence: "no stub" };
    },
  };
  const publisher: ProposalPublisher = opts.publisher ?? {
    async publish() {
      return { pipelineId: "p1", pipelineUrl: "https://ci/p1" };
    },
    async pipelineVerdict(id) {
      return verdicts.get(id) ?? { status: "running" };
    },
    async openMergeRequest(input) {
      opened.push(input);
      return { iid: 7, url: "https://gitlab/mr/7" };
    },
    async closeMergeRequest(iid, note) {
      closed.push({ iid, note });
    },
  };
  const svc = new ContribReviewService({ store, pipeline, publisher, pollMs: 5_000 });
  return {
    store, svc, messages, notes, created, verdicts, opened, closed, applied,
    ticket(requester = "lilei", lane: "direct" | "review" = "review") {
      return store.devTickets.createDevTicket({
        title: `T-${requester}`, body: "please", requester, kind: "simple", app_id: null, model: "m", effort: "high", lane,
      });
    },
  };
}

function propose(h: Harness, ticketId: number, status: "ci_pending" | "awaiting_review" = "ci_pending", pipelineId: string | null = "p1") {
  return h.store.mergeProposals.create({
    ticket_id: ticketId,
    requester: "lilei",
    branch: contribBranchName("lilei", ticketId),
    sha: "a".repeat(40),
    base_sha: "b".repeat(40),
    summary: "adds a thing",
    status,
    pipeline_id: pipelineId,
    pipeline_url: pipelineId ? `https://ci/${pipelineId}` : null,
  });
}

describe("ContribReviewService · CI verdicts", () => {
  it("green → opens the MR and moves to awaiting_review with a note, not a wake-up", async () => {
    const h = harness();
    const t = h.ticket();
    const p = propose(h, t.id);
    h.verdicts.set("p1", { status: "success" });
    await h.svc.pollOnce();
    const row = h.store.mergeProposals.get(p.id)!;
    expect(row.status).toBe("awaiting_review");
    expect(row.mr_iid).toBe(7);
    expect(row.mr_url).toBe("https://gitlab/mr/7");
    expect(h.opened[0]).toMatchObject({ branch: contribBranchName("lilei", t.id), targetBranch: "v4" });
    expect(h.opened[0].title).toContain(`[ticket #${t.id}]`);
    expect(h.notes.some((n) => n.ticketId === t.id && n.body.includes("CI 通过"))).toBe(true);
    // Green is not work for the agent: nothing was put in the inbox.
    expect(h.messages).toHaveLength(0);
  });

  it("red → ci_failed and a message that wakes the agent with the digest", async () => {
    const h = harness();
    const t = h.ticket();
    const p = propose(h, t.id);
    h.verdicts.set("p1", { status: "failed", digest: "● packages/x.test.ts\n  - case A" });
    await h.svc.pollOnce();
    expect(h.store.mergeProposals.get(p.id)!.status).toBe("ci_failed");
    expect(h.store.mergeProposals.get(p.id)!.detail).toContain("packages/x.test.ts");
    expect(h.messages).toHaveLength(1);
    expect(h.messages[0]).toMatchObject({ ticketId: t.id, author: "ci", via: "pipeline" });
    expect(h.messages[0].body).toContain("CI 失败");
    expect(h.messages[0].body).toContain("packages/x.test.ts");
    // A row that moved is not touched again on the next poll.
    await h.svc.pollOnce();
    expect(h.messages).toHaveLength(1);
  });

  it("aborted → ci_failed with an infrastructure explanation", async () => {
    const h = harness();
    const t = h.ticket();
    const p = propose(h, t.id);
    h.verdicts.set("p1", { status: "aborted", reason: "runner_system_failure" });
    await h.svc.pollOnce();
    expect(h.store.mergeProposals.get(p.id)!.status).toBe("ci_failed");
    expect(h.messages[0].body).toContain("基础设施");
  });

  it("a forge hiccup on MR creation leaves the row pending for the next poll", async () => {
    const h = harness();
    const t = h.ticket();
    const p = propose(h, t.id);
    h.verdicts.set("p1", { status: "success" });
    let fail = true;
    const publisher: ProposalPublisher = {
      async publish() { return { pipelineId: "p1", pipelineUrl: null }; },
      async pipelineVerdict() { return { status: "success" }; },
      async openMergeRequest(input) {
        if (fail) throw new Error("502");
        h.opened.push(input);
        return { iid: 1, url: "u" };
      },
      async closeMergeRequest() {},
    };
    const svc = new ContribReviewService({ store: h.store, pipeline: (h.svc as unknown as { pipeline: ContribReviewPipeline }).pipeline, publisher });
    await svc.pollOnce();
    expect(h.store.mergeProposals.get(p.id)!.status).toBe("ci_pending");
    fail = false;
    await svc.pollOnce();
    expect(h.store.mergeProposals.get(p.id)!.status).toBe("awaiting_review");
  });

  it("without a forge, review starts at once", async () => {
    const h = harness({ publisher: NO_FORGE_PUBLISHER });
    const t = h.ticket();
    const p = propose(h, t.id, "ci_pending", null);
    await h.svc.pollOnce();
    expect(h.store.mergeProposals.get(p.id)!.status).toBe("awaiting_review");
  });
});

describe("ContribReviewService · the maintainer's verbs", () => {
  it("approve is a promise, reject is feedback that wakes the agent", () => {
    const h = harness();
    const t = h.ticket();
    const p = propose(h, t.id, "awaiting_review");
    const rejected = h.svc.decide(p.id, "reject", "lht", "缺测试");
    expect(rejected.ok).toBe(true);
    expect(h.store.mergeProposals.get(p.id)).toMatchObject({ status: "rejected", review_by: "lht", review_note: "缺测试" });
    expect(h.messages).toHaveLength(1);
    // Signed by the reviewer, but the Head composed it: not the reviewer's own typing.
    expect(h.messages[0]).toMatchObject({ ticketId: t.id, author: "lht", via: "review", actorKind: "system" });
    expect(h.messages[0].body).toContain("缺测试");
    // Changed their mind: a rejected row may still be approved.
    const approved = h.svc.decide(p.id, "approve", "lht");
    expect(approved.ok).toBe(true);
    expect(h.store.mergeProposals.get(p.id)!.status).toBe("approved");
    // Approving does not wake the agent; it leaves a note.
    expect(h.messages).toHaveLength(1);
    expect(h.notes.some((n) => n.body.includes("批准"))).toBe(true);
  });

  it("refuses decisions on rows that are not decidable, with the current status", () => {
    const h = harness();
    const t = h.ticket();
    const p = propose(h, t.id); // ci_pending
    const out = h.svc.decide(p.id, "approve", "lht");
    expect(out).toMatchObject({ ok: false, code: "not_decidable" });
    expect(h.svc.decide(9999, "approve", "lht")).toMatchObject({ ok: false, code: "not_found" });
  });

  it("runBatch files ONE direct-lane ticket for every approved proposal and marks them merging", () => {
    const h = harness();
    const a = h.ticket();
    const b = h.ticket();
    const pa = propose(h, a.id, "awaiting_review");
    const pb = propose(h, b.id, "awaiting_review");
    h.svc.decide(pa.id, "approve", "lht");
    h.svc.decide(pb.id, "approve", "lht");
    expect(h.svc.runBatch("lht", [999])).toBeNull(); // nothing matched → nothing filed
    const out = h.svc.runBatch("lht");
    expect(out).not.toBeNull();
    expect(h.created).toHaveLength(1);
    const ticket = h.created[0];
    expect(ticket.requester).toBe("lht");
    expect(ticket.actor_kind).toBe("system");
    expect(ticket.kind).toBe("simple");
    expect(ticket.body).toContain(`提案 #${pa.id}`);
    expect(ticket.body).toContain(`提案 #${pb.id}`);
    expect(ticket.body).toContain("devpipe_submit");
    for (const id of [pa.id, pb.id]) {
      expect(h.store.mergeProposals.get(id)).toMatchObject({ status: "merging", merge_ticket_id: ticket.id });
    }
    expect(h.svc.runBatch("lht")).toBeNull(); // nothing approved is left
  });

  it("the queue joins the ticket title for the panel", () => {
    const h = harness();
    const t = h.ticket();
    propose(h, t.id, "awaiting_review");
    const q = h.svc.queue();
    expect(q).toHaveLength(1);
    expect(q[0].ticket_title).toBe("T-lilei");
  });
});

describe("ContribReviewService · after the batch lands", () => {
  it("merged when the landing contains the proposal; closes the MR", async () => {
    const h = harness();
    const t = h.ticket();
    const p = propose(h, t.id, "awaiting_review");
    h.store.mergeProposals.update(p.id, { mr_iid: 7 });
    h.svc.decide(p.id, "approve", "lht");
    const batch = h.svc.runBatch("lht")!.ticket;
    await h.svc.pollOnce(); // merge ticket still open → nothing happens
    expect(h.store.mergeProposals.get(p.id)!.status).toBe("merging");
    h.store.devTickets.updateDevTicket(batch.id, { dev_status: "landed", commit_sha: "c".repeat(40), deploy_status: "pending" });
    h.applied.set(`${"a".repeat(40)}@${"c".repeat(40)}`, { applied: true, evidence: "ancestor" });
    await h.svc.pollOnce();
    expect(h.store.mergeProposals.get(p.id)).toMatchObject({ status: "merged", merged_sha: "c".repeat(40) });
    expect(h.closed).toEqual([{ iid: 7, note: expect.stringContaining(`batch ticket #${batch.id}`) }]);
    expect(h.notes.some((n) => n.ticketId === t.id && n.body.includes("已通过批量合并"))).toBe(true);
  });

  it("merge_failed when the landing left the proposal out", async () => {
    const h = harness();
    const t = h.ticket();
    const p = propose(h, t.id, "awaiting_review");
    h.svc.decide(p.id, "approve", "lht");
    const batch = h.svc.runBatch("lht")!.ticket;
    h.store.devTickets.updateDevTicket(batch.id, { dev_status: "landed", commit_sha: "c".repeat(40), deploy_status: "pending" });
    h.applied.set(`${"a".repeat(40)}@${"c".repeat(40)}`, { applied: false, evidence: "2/2 commits missing" });
    await h.svc.pollOnce();
    expect(h.store.mergeProposals.get(p.id)!.status).toBe("merge_failed");
    expect(h.store.mergeProposals.get(p.id)!.detail).toContain("2/2 commits missing");
  });

  it("a cancelled batch hands the proposal back to approved", async () => {
    const h = harness();
    const t = h.ticket();
    const p = propose(h, t.id, "awaiting_review");
    h.svc.decide(p.id, "approve", "lht");
    const batch = h.svc.runBatch("lht")!.ticket;
    h.store.devTickets.updateDevTicket(batch.id, { dev_status: "cancelled" });
    await h.svc.pollOnce();
    expect(h.store.mergeProposals.get(p.id)!.status).toBe("approved");
    expect(h.store.mergeProposals.get(p.id)!.merge_ticket_id).toBe(batch.id);
  });
});

describe("buildMergeBatchBody", () => {
  it("lists every proposal with its sha, base and branch and forbids fetching", () => {
    const body = buildMergeBatchBody(
      [{
        id: 3, ticket_id: 12, requester: "lilei", branch: "contrib/lilei/ticket-12", sha: "a".repeat(40), base_sha: "b".repeat(40),
        summary: "x", status: "approved", pipeline_id: null, pipeline_url: null, mr_iid: 5, mr_url: "https://gitlab/mr/5",
        review_by: "lht", review_at: null, review_note: null, merge_ticket_id: null, merged_sha: null, detail: null,
        created_at: "", updated_at: "", ticket_title: "加一个按钮", ticket_slug: null,
      }],
      { baseBranch: "v4", approver: "lht" },
    );
    expect(body).toContain("提案 #3 ← 工单 #12「加一个按钮」");
    expect(body).toContain("contrib/lilei/ticket-12");
    expect(body).toContain("https://gitlab/mr/5");
    expect(body).toContain("不要 fetch 远端");
    expect(body).toContain("只调用一次 devpipe_submit");
  });
});
