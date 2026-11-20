import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { Store } from "../store.js";
import { MIGRATIONS } from "../migrations.js";
import {
  DEV_TICKET_KINDS,
  DEV_TICKET_MODELS,
  cliFamilyForModel,
  modelIdForCli,
  normalizeCliDeliveryTicketInput,
  normalizeDevTicketInput,
  type CliDeliveryTicketInput,
  type DevTicketInput,
} from "../../devpipe/ticket-models.js";

describe("migration v19 (ten statuses → open/landed/cancelled)", () => {
  it("maps old rows exactly: gated→landed, cancelled stays, the rest→open", () => {
    // Build a real v18 database, plant one row per legacy status, then apply
    // v19 alone — testing the shipped SQL, not a re-implementation of it.
    const db = new Database(":memory:");
    for (const m of MIGRATIONS) {
      if (m.version >= 19) break;
      db.exec(m.sql);
    }
    const legacy = [
      "queued", "speccing", "spec_ready", "ready_to_dev", "developing",
      "gating", "awaiting_reply", "needs_human", "gated", "cancelled",
    ];
    db.exec("INSERT INTO users (username, uid, home_dir, created_at) VALUES ('u', 1, '/x', 't')");
    const ins = db.prepare(
      "INSERT INTO dev_tickets (title, body, requester, dev_status, created_at, updated_at) VALUES (?, 'b', 'u', ?, 't', 't')",
    );
    for (const st of legacy) ins.run(st, st);

    db.exec(MIGRATIONS.find((m) => m.version === 19)!.sql);

    const got = Object.fromEntries(
      (db.prepare("SELECT title, dev_status FROM dev_tickets").all() as Array<{ title: string; dev_status: string }>)
        .map((r) => [r.title, r.dev_status]),
    );
    expect(got.gated).toBe("landed");
    expect(got.cancelled).toBe("cancelled");
    for (const st of legacy.filter((s) => s !== "gated" && s !== "cancelled")) {
      expect(got[st]).toBe("open");
    }
    db.close();
  });
});

describe("migration v32 (dev_tickets.app_id)", () => {
  it("adds the column to an existing database without touching its rows", () => {
    // Build a real v31 database with a ticket in it, then apply v32 alone —
    // testing the shipped SQL rather than a re-implementation of it. The point
    // of the additive rule is exactly this: an upgrade must not rewrite work.
    const db = new Database(":memory:");
    for (const m of MIGRATIONS) {
      if (m.version >= 32) break;
      db.exec(m.sql);
    }
    db.exec("INSERT INTO users (username, uid, home_dir, created_at) VALUES ('u', 1, '/x', 't')");
    db.exec(
      "INSERT INTO dev_tickets (title, body, requester, kind, dev_status, created_at, updated_at)"
        + " VALUES ('old', 'b', 'u', 'simple', 'open', 't', 't')",
    );

    db.exec(MIGRATIONS.find((m) => m.version === 32)!.sql);

    const row = db.prepare("SELECT title, kind, app_id FROM dev_tickets").get() as {
      title: string; kind: string; app_id: string | null;
    };
    // Every pre-existing ticket is null: an app id on a `simple` row would be a
    // claim nothing reads, and the pipeline keys the path gate off the KIND.
    expect(row).toEqual({ title: "old", kind: "simple", app_id: null });
    db.close();
  });

  it("no two migrations share a version number", () => {
    // A gap is harmless (the runner applies anything newer than MAX(version));
    // a COLLISION is silently destructive — the first is applied and the second
    // is skipped for ever. Worth one assertion now that versions 29–32 landed
    // from sibling branches.
    const versions = MIGRATIONS.map((m) => m.version);
    expect(new Set(versions).size).toBe(versions.length);
    expect([...versions].sort((a, b) => a - b)).toEqual(versions);
  });
});

describe("migration v54 (dev_tickets.codex_account_slot)", () => {
  it("adds a nullable opaque binding without migrating legacy sessions", () => {
    const db = new Database(":memory:");
    for (const migration of MIGRATIONS) {
      if (migration.version >= 54) break;
      db.exec(migration.sql);
    }
    db.exec("INSERT INTO users (username, uid, home_dir, created_at) VALUES ('u', 1, '/x', 't')");
    db.exec(
      "INSERT INTO dev_tickets (title, body, requester, model, session_id, dev_status, created_at, updated_at)"
        + " VALUES ('old', 'b', 'u', 'codex-gpt-5.6-sol', 'legacy-session', 'open', 't', 't')",
    );

    db.exec(MIGRATIONS.find((migration) => migration.version === 54)!.sql);
    expect(db.prepare("SELECT session_id, codex_account_slot FROM dev_tickets").get()).toEqual({
      session_id: "legacy-session",
      codex_account_slot: null,
    });
    db.close();
  });
});

describe("migration v59 (durable merge waiters)", () => {
  it("adds an ordered, cascading wait-intent table", () => {
    const db = new Database(":memory:");
    for (const migration of MIGRATIONS) {
      if (migration.version >= 59) break;
      db.exec(migration.sql);
    }
    db.exec(MIGRATIONS.find((migration) => migration.version === 59)!.sql);
    expect(db.prepare("PRAGMA table_info(dev_merge_waiters)").all()).toHaveLength(4);
    db.close();
  });
});

describe("migration v62 (submit-time delivery classification)", () => {
  it("adds nullable columns without reclassifying historical tickets", () => {
    const db = new Database(":memory:");
    for (const migration of MIGRATIONS) {
      if (migration.version >= 62) break;
      db.exec(migration.sql);
    }
    db.exec("INSERT INTO users (username, uid, home_dir, created_at) VALUES ('u', 1, '/x', 't')");
    db.exec(
      "INSERT INTO dev_tickets (title, body, requester, kind, dev_status, created_at, updated_at)"
        + " VALUES ('old', 'b', 'u', 'app', 'landed', 't', 't')",
    );
    db.exec(
      "INSERT INTO app_hotswap_approvals"
        + " (id, ticket_id, app_id, source_commit, package_digest, contract_digest, coexistence_verdict,"
        + " requested_by, requested_at, state)"
        + " VALUES ('old-approval', 1, 'session-plus', '1111111', '2222222', '3333333', '{}', 'u', 't', 'pending')",
    );

    db.exec(MIGRATIONS.find((migration) => migration.version === 62)!.sql);
    expect(db.prepare("SELECT kind, delivery_mode, delivery_apps FROM dev_tickets").get()).toEqual({
      kind: "app",
      delivery_mode: null,
      delivery_apps: null,
    });
    expect(db.prepare("SELECT id, app_id FROM app_hotswap_approvals").get()).toEqual({
      id: "old-approval",
      app_id: "session-plus",
    });
    db.exec(
      "INSERT INTO app_hotswap_approvals"
        + " (id, ticket_id, app_id, source_commit, package_digest, contract_digest, coexistence_verdict,"
        + " requested_by, requested_at, state)"
        + " VALUES ('second-app', 1, 'research-program', '1111111', '2222222', '3333333', '{}', 'u', 't', 'pending')",
    );
    expect(db.prepare("SELECT COUNT(*) AS n FROM app_hotswap_approvals").get()).toEqual({ n: 2 });
    db.close();
  });
});

describe("Store dev tickets (agent-native pipeline, ticket #12)", () => {
  let store: Store;

  const createTicket = (input: DevTicketInput) => store.devTickets.createDevTicket(normalizeDevTicketInput(input));
  const createCliTicket = (input: CliDeliveryTicketInput) =>
    store.devTickets.createCliDeliveryTicket(normalizeCliDeliveryTicketInput(input));

  beforeEach(() => {
    store = new Store(":memory:");
    store.saveUser({ username: "alice", uid: 5001, home_dir: "/x/a", created_at: "2026-07-25T00:00:00.000Z" });
    store.saveUser({ username: "bob", uid: 5002, home_dir: "/x/b", created_at: "2026-07-25T00:00:00.000Z" });
  });

  afterEach(() => store.close());

  it("searches all historical titles, short names, requests and human follow-ups before paging", () => {
    const old = createTicket({ title: "Historical", body: "原始需求", requester: "alice" });
    store.devTickets.updateDevTicket(old.id, { slug: "文件搜索", dev_status: "cancelled" });
    store.devTickets.addTicketMessage(old.id, "alice", "web", "后续需求 100%_literal");
    store.devTickets.addTicketMessage(old.id, "agent", "agent", "agent-only-secret", 1);
    for (let i = 0; i < 205; i++) createTicket({ title: `Recent ${i}`, body: "other", requester: "bob" });
    expect(store.devTickets.listDevTickets().some((row) => row.id === old.id)).toBe(false);
    for (const query of ["historical", "文件搜索", "原始需求", "后续需求", "100%_", `#${old.id}`]) {
      expect(store.devTickets.listDevTickets(50, { query }).map((row) => row.id)).toEqual([old.id]);
    }
    expect(store.devTickets.listDevTickets(50, { query: "agent-only-secret" })).toEqual([]);
    expect(store.devTickets.listDevTickets(50, { query: "' OR 1=1 --" })).toEqual([]);
    expect(store.devTickets.listDevTickets(50, { owner: "alice", requester: "bob" })).toEqual([]);
    expect(store.devTickets.listDevTickets(50, { owner: "alice", status: "open" })).toEqual([]);
    expect(store.devTickets.listDevTickets(50, { owner: "alice", status: "cancelled" }).map((row) => row.id)).toEqual([old.id]);
    const first = store.devTickets.listDevTickets(50, { requester: "bob", query: "Recent" });
    const second = store.devTickets.listDevTickets(50, { requester: "bob", query: "Recent", offset: 50 });
    expect(first).toHaveLength(50);
    expect(second).toHaveLength(50);
    expect(new Set([...first, ...second].map((row) => row.id)).size).toBe(100);
  });

  it("completes without scheduling or discarding history, and reopens atomically on user input", () => {
    const ticket = createTicket({ title: "acceptance", body: "b", requester: "alice" });
    store.devTickets.updateDevTicket(ticket.id, {
      session_id: "native-session", worktree: "/workspace/ticket", branch: "ticket/acceptance",
      open_question: "old question", error: "old error",
    });
    store.devTickets.takeTicketInbox(ticket.id, 1);
    store.devTickets.addTicketMessage(ticket.id, "agent", "agent", "all checks passed", 1);
    const before = store.devTickets.listTicketMessages(ticket.id);
    expect(store.devTickets.completeTicket(ticket.id, "alice")).toMatchObject({
      dev_status: "completed", session_id: "native-session", worktree: "/workspace/ticket",
      branch: "ticket/acceptance", open_question: null, error: null,
    });
    store.devTickets.completeTicket(ticket.id, "alice");
    expect(store.devTickets.listTicketMessages(ticket.id).slice(0, before.length)).toEqual(before);
    expect(store.devTickets.listTicketMessages(ticket.id)).toHaveLength(before.length + 1);
    expect(store.devTickets.listTicketsNeedingTurn()).toEqual([]);
    expect(store.devTickets.countDevTickets()).toMatchObject({ open: 0, queued_input: 0 });
    expect(store.devTickets.listDevTickets(10).find((row) => row.id === ticket.id)?.dev_status).toBe("completed");
    store.devTickets.addTicketMessage(ticket.id, "alice", "web", "continue with the next check");
    expect(store.devTickets.getDevTicket(ticket.id)).toMatchObject({ dev_status: "open", session_id: "native-session" });
    expect(store.devTickets.listTicketsNeedingTurn().map((row) => row.id)).toEqual([ticket.id]);
  });

  it("does not complete an idle ticket while its review proposal is still actionable", () => {
    const ticket = createTicket({ title: "review", body: "b", requester: "alice", lane: "review" });
    store.devTickets.takeTicketInbox(ticket.id, 1);
    const proposal = store.mergeProposals.create({ ticket_id: ticket.id, requester: "alice", branch: "contrib/alice/ticket",
      sha: "a".repeat(40), base_sha: "b".repeat(40), summary: "review candidate", status: "awaiting_review" });
    expect(() => store.devTickets.completeTicket(ticket.id, "alice")).toThrow(/合入提案/);
    expect(store.devTickets.getDevTicket(ticket.id)?.dev_status).toBe("open");
    expect(store.mergeProposals.liveForTicket(ticket.id)?.id).toBe(proposal.id);
  });

  it("refuses completion while a message, running turn or durable operation still owns work", () => {
    const ticket = createTicket({ title: "busy", body: "b", requester: "alice" });
    store.devTickets.addTicketMessage(ticket.id, "alice", "web", "queued input");
    expect(() => store.devTickets.completeTicket(ticket.id, "alice")).toThrow(/排队消息/);
    expect(store.devTickets.listTicketMessages(ticket.id, { undeliveredOnly: true })).toHaveLength(2);
    store.devTickets.takeTicketInbox(ticket.id, 1);
    store.devTickets.updateDevTicket(ticket.id, { turn_started_at: new Date().toISOString() });
    expect(() => store.devTickets.completeTicket(ticket.id, "alice")).toThrow(/仍在执行/);
    store.devTickets.updateDevTicket(ticket.id, { turn_started_at: null });
    store.devTickets.runner.save({ id: "pending-operation", ticketId: ticket.id, turn: 1,
      method: "start_session", args: {}, state: "prepared" });
    expect(() => store.devTickets.completeTicket(ticket.id, "alice")).toThrow(/仍在执行/);
    expect(store.devTickets.getDevTicket(ticket.id)?.dev_status).toBe("open");
    store.devTickets.runner.save({ id: "pending-operation", ticketId: ticket.id, turn: 1,
      method: "start_session", args: {}, state: "finished" });
    store.devTickets.updateDevTicket(ticket.id, { dev_status: "landed" });
    expect(() => store.devTickets.completeTicket(ticket.id, "alice")).toThrow(/只有未合入/);
  });


  it("preserves FIFO place across repeated waits and can rotate a failed offer", () => {
    const a = createTicket({ title: "a", body: "b", requester: "alice" });
    const b = createTicket({ title: "b", body: "b", requester: "alice" });
    store.devTickets.rememberMergeWaiter(a.id, "2026-08-25T00:00:00.000Z");
    store.devTickets.rememberMergeWaiter(b.id, "2026-08-25T00:00:01.000Z");
    store.devTickets.rememberMergeWaiter(a.id, "2026-08-25T00:00:02.000Z");
    expect(store.devTickets.listMergeWaiters().map((row) => row.ticket_id)).toEqual([a.id, b.id]);

    store.devTickets.moveMergeWaiterToTail(a.id, "2026-08-25T00:00:03.000Z");
    expect(store.devTickets.listMergeWaiters().map((row) => row.ticket_id)).toEqual([b.id, a.id]);
    expect(store.devTickets.forgetMergeWaiter(b.id)).toBe(true);
    expect(store.devTickets.listMergeWaiters().map((row) => row.ticket_id)).toEqual([a.id]);
  });


  it("starts a ticket at zero cost with an unmeasured diff (migration v46)", () => {
    const t = createTicket({ title: "cost", body: "b", requester: "alice" });
    expect(t).toMatchObject({
      agent_ms: 0,
      agent_turns: 0,
      tokens_in: 0,
      tokens_out: 0,
      tokens_cached: 0,
    });
    // Nothing has landed, so the diff is unknown — not a zero-sized change.
    expect(t.diff_files).toBeNull();
    expect(t.diff_modules).toBeNull();
    expect(t.diff_added).toBeNull();
    expect(t.diff_removed).toBeNull();
  });

  it("persists accumulated cost and a measured landing diff, and lists them", () => {
    const t = createTicket({ title: "cost", body: "b", requester: "alice" });
    store.devTickets.updateDevTicket(t.id, {
      agent_ms: 1_920_000,
      agent_turns: 3,
      tokens_in: 30_000,
      tokens_out: 12_000,
      tokens_cached: 1_200_000,
      diff_files: 11,
      diff_modules: 3,
      diff_added: 420,
      diff_removed: 96,
    });
    expect(store.devTickets.getDevTicket(t.id)).toMatchObject({
      agent_ms: 1_920_000,
      agent_turns: 3,
      tokens_cached: 1_200_000,
      diff_modules: 3,
    });
    // The sidebar reads the list, not the detail row, so it has to carry them.
    const listed = store.devTickets.listDevTickets(10).find((r) => r.id === t.id);
    expect(listed).toMatchObject({ diff_files: 11, diff_added: 420, diff_removed: 96 });
  });

  it("records a measured empty landing as zero rather than unknown", () => {
    const t = createTicket({ title: "empty", body: "b", requester: "alice" });
    store.devTickets.updateDevTicket(t.id, {
      diff_files: 0,
      diff_modules: 0,
      diff_added: 0,
      diff_removed: 0,
    });
    expect(store.devTickets.getDevTicket(t.id)).toMatchObject({ diff_files: 0, diff_modules: 0 });
  });

  it("creates open, clamps unknown model/effort/kind, and seeds the opening message", () => {
    const t = createTicket({ title: "t1", body: "修一下滚动", requester: "alice" });
    expect(t.model).toBe("codex-gpt-6-astra");
    expect(t.effort).toBe("xhigh");
    expect(t.kind).toBe("complex");
    expect(t.dev_status).toBe("open");
    expect(t.deploy_status).toBeNull();
    expect(t.turn_started_at).toBeNull();
    expect(t.slug).toBeNull();
    expect(t.app_id).toBeNull();

    // Creation IS the first inbox message — the one uniform turn trigger.
    const msgs = store.devTickets.listTicketMessages(t.id, { undeliveredOnly: true });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].body).toBe("修一下滚动");
    expect(msgs[0].author).toBe("alice");
    expect(msgs[0].via).toBe("web");

    // The retired aliases are no longer offerable — they clamp like any unknown.
    const t2 = createTicket({ title: "t2", body: "b", requester: "alice", model: "sonnet", effort: "ultra", kind: "trivial" });
    expect(t2.model).toBe("codex-gpt-6-astra");
    expect(t2.effort).toBe("xhigh");
    expect(t2.kind).toBe("complex");

    const t3 = createTicket({ title: "t3", body: "b", requester: "bob", model: "claude-fable-5-1", effort: "xhigh", kind: "simple", via: "feishu" });
    expect(t3.model).toBe("claude-fable-5-1");
    expect(t3.effort).toBe("xhigh");
    expect(t3.kind).toBe("simple");
    expect(store.devTickets.listTicketMessages(t3.id)[0].via).toBe("feishu");
  });

  it("creates an idempotent, read-only CLI report already waiting for deploy", () => {
    const input = {
      title: "CLI trace",
      body: "结果\n\n## 开发侧验证\n\n- tests passed",
      spec: "## 验收标准\n- page works",
      requester: "alice",
      branch: "dev/alice-cli",
      commit_sha: "a".repeat(40),
    };
    const first = createCliTicket(input);
    const again = createCliTicket({ ...input, title: "must not replace" });

    expect(again.id).toBe(first.id);
    expect(first).toMatchObject({
      kind: "cli",
      dev_status: "landed",
      deploy_status: "pending",
      branch: "dev/alice-cli",
      commit_sha: "a".repeat(40),
      spec: input.spec,
    });
    expect(store.devTickets.listTicketsNeedingTurn()).toEqual([]);
    expect(store.devTickets.listTicketMessages(first.id)).toEqual([
      expect.objectContaining({ author: "alice", via: "cli-report", delivered_turn: 0 }),
    ]);
    expect(store.devTickets.countDevTickets().landed_pending).toBe(1);
  });

  it("app_id rides with the kind: kept for 'app', dropped for everything else", () => {
    const app = createTicket({
      title: "app", body: "b", requester: "alice", kind: "app", app_id: "  session-plus  ",
    });
    expect(app.kind).toBe("app");
    expect(app.app_id).toBe("session-plus"); // trimmed, not rejected

    // Not validated against the scope table HERE on purpose: which ids exist is
    // a source-code question (devpipe/app-scopes.ts) and the merge phase fails
    // closed on an unknown one. The store persists facts.
    const unknown = createTicket({
      title: "u", body: "b", requester: "alice", kind: "app", app_id: "who-knows",
    });
    expect(unknown.app_id).toBe("who-knows");

    // An app id on a non-app ticket is a claim nothing reads.
    for (const kind of ["simple", "complex", "trivial"]) {
      const row = createTicket({ title: kind, body: "b", requester: "alice", kind, app_id: "session-plus" });
      expect(row.app_id).toBeNull();
    }
    // Empty/blank normalises to null rather than to "".
    const blank = createTicket({ title: "blank", body: "b", requester: "alice", kind: "app", app_id: "   " });
    expect(blank.app_id).toBeNull();
  });

  it("app_id is patchable, so a kind change can carry it in one write", () => {
    const t = createTicket({ title: "t", body: "b", requester: "alice", kind: "simple" });
    store.devTickets.updateDevTicket(t.id, { kind: "app", app_id: "session-plus" });
    expect(store.devTickets.getDevTicket(t.id)).toMatchObject({ kind: "app", app_id: "session-plus" });
    store.devTickets.updateDevTicket(t.id, { kind: "complex", app_id: null });
    expect(store.devTickets.getDevTicket(t.id)).toMatchObject({ kind: "complex", app_id: null });
  });

  it("listTicketsNeedingTurn: unread inbox is the only trigger, pure FIFO by id, any live status", () => {
    const s = createTicket({ title: "simple", body: "b", requester: "alice", kind: "simple" });
    const c = createTicket({ title: "complex", body: "b", requester: "bob", kind: "complex" });
    // Ticket #16: pure FIFO. The simple one was filed first, so it goes first,
    // even though its neighbour is a complex ticket that would have jumped
    // the queue in the pre-#16 rule ("complex first"). Kind is now pure
    // prompt discipline; the schedule is who-asked-first.
    expect(store.devTickets.listTicketsNeedingTurn().map((t) => t.id)).toEqual([s.id, c.id]);

    // Consuming the inbox silences a ticket until someone speaks again.
    store.devTickets.takeTicketInbox(s.id, 1);
    store.devTickets.takeTicketInbox(c.id, 2);
    expect(store.devTickets.listTicketsNeedingTurn()).toHaveLength(0);

    // The ticket #12 bug, at the store level: a LANDED ticket with a fresh
    // message must still come up for a turn — there is no terminal parking.
    store.devTickets.updateDevTicket(s.id, { dev_status: "landed", deploy_status: "pending" });
    store.devTickets.addTicketMessage(s.id, "alice", "web", "上线后发现一个 follow-up");
    expect(store.devTickets.listTicketsNeedingTurn().map((t) => t.id)).toEqual([s.id]);

    // Cancelled is the one true terminal: unread or not, it never runs.
    store.devTickets.updateDevTicket(c.id, { dev_status: "cancelled" });
    store.devTickets.addTicketMessage(c.id, "bob", "web", "还在吗");
    expect(store.devTickets.listTicketsNeedingTurn().map((t) => t.id)).toEqual([s.id]);
  });

  it("a message can be stamped into the turn that is already running (ticket #183)", () => {
    const t = createTicket({ title: "t", body: "开工", requester: "alice", kind: "simple" });
    const inbox = store.devTickets.takeTicketInbox(t.id, 7);
    expect(inbox).toHaveLength(1);

    // Posted while turn 7 runs, and handed straight to it.
    const live = store.devTickets.addTicketMessage(t.id, "alice", "web", "顺便改标题");
    expect(live.delivered_turn).toBeNull();
    expect(store.devTickets.listTicketsNeedingTurn().map((row) => row.id)).toEqual([t.id]);
    expect(store.devTickets.markTicketMessageDelivered(live.id, 7)).toBe(true);
    expect(store.devTickets.listTicketsNeedingTurn()).toHaveLength(0);

    // Both messages belong to turn 7, in conversation order — that is what a
    // retry reads to recover what the dead attempt had already swallowed.
    expect(store.devTickets.listTicketMessagesForTurn(t.id, 7).map((m) => m.body))
      .toEqual(["开工", "顺便改标题"]);

    // Stamping is not re-stamping: an already delivered row keeps its turn.
    expect(store.devTickets.markTicketMessageDelivered(live.id, 9)).toBe(false);
    expect(store.devTickets.listTicketMessagesForTurn(t.id, 9)).toHaveLength(0);
    // And an unrelated queued message stays queued.
    const queued = store.devTickets.addTicketMessage(t.id, "bob", "web", "下一轮再说");
    expect(store.devTickets.listTicketMessagesForTurn(t.id, 7).map((m) => m.id)).not.toContain(queued.id);
  });

  it("listDevTickets: opens first, landed in commit order, and cancelled at the bottom", () => {
    // Ticket #16: the sidebar order should match git commit order in the
    // landed block. Ticket #80 archives cancelled work below every live or
    // landed ticket. Four tiers (see listDevTickets):
    //   0 open — top, id DESC
    //   1 landed with landed_at — landed_at DESC
    //   2 landed without landed_at (pre-v22 rows) — id DESC
    //   3 cancelled — bottom, id DESC within the group
    const t1 = createTicket({ title: "t1", body: "b", requester: "alice" });
    const t2 = createTicket({ title: "t2", body: "b", requester: "alice" });
    const t3 = createTicket({ title: "t3", body: "b", requester: "alice" });
    const t4 = createTicket({ title: "t4", body: "b", requester: "alice" });
    const t5 = createTicket({ title: "t5", body: "b", requester: "alice" });
    const t6 = createTicket({ title: "t6", body: "b", requester: "alice" });
    const t7 = createTicket({ title: "t7", body: "b", requester: "alice" });

    // t2 landed first (earlier landed_at), t4 landed second → the landed
    // block reads t4, t2 (newest on top, matching git log's default direction).
    store.devTickets.updateDevTicket(t2.id, { dev_status: "landed", landed_at: "2026-07-27T10:00:00.000Z" });
    store.devTickets.updateDevTicket(t4.id, { dev_status: "landed", landed_at: "2026-07-27T11:00:00.000Z" });
    // t5 is a legacy landed row (pre-v22): no landed_at → sinks to the bottom
    // of the landed block, but still stays above cancelled rows.
    store.devTickets.updateDevTicket(t5.id, { dev_status: "landed", landed_at: null });
    store.devTickets.updateDevTicket(t3.id, { dev_status: "cancelled" });
    // Even a row that once carried a landing timestamp is sorted by its current
    // terminal status, not leaked back into the landed block.
    store.devTickets.updateDevTicket(t7.id, {
      dev_status: "cancelled",
      landed_at: "2026-07-27T12:00:00.000Z",
    });

    // t1/t6 open, t2/t4 landed w/ stamps, t5 legacy-landed, t3/t7 cancelled.
    const ids = store.devTickets.listDevTickets(10).map((r) => r.id);
    expect(ids).toEqual([t6.id, t1.id, t4.id, t2.id, t5.id, t7.id, t3.id]);
  });

  it("listDevTickets: an incorporated review ticket rejoins the completed timeline", () => {
    const olderOpen = createTicket({ title: "older open", body: "b", requester: "alice" });
    const incorporated = createTicket({ title: "incorporated", body: "b", requester: "bob", lane: "review" });
    const newerOpen = createTicket({ title: "newer open", body: "b", requester: "alice" });
    const landed = createTicket({ title: "landed", body: "b", requester: "alice" });
    store.devTickets.updateDevTicket(landed.id, {
      dev_status: "landed",
      landed_at: "2026-08-20T00:00:00.000Z",
    });

    const proposal = store.mergeProposals.create({
      ticket_id: incorporated.id,
      requester: "bob",
      branch: `contrib/bob/ticket-${incorporated.id}`,
      sha: "a".repeat(40),
      base_sha: "b".repeat(40),
      summary: "incorporated by the batch ticket",
      status: "ci_pending",
    });
    expect(store.mergeProposals.transition(proposal.id, ["ci_pending"], "merged", {
      merged_sha: "c".repeat(40),
    })).toBe(true);

    store.devTickets.takeTicketInbox(incorporated.id, 1);

    // The ticket stays an open conversation, but no longer remains above
    // ordinary open work forever. Its proposal transition timestamp places it
    // in the same newest-first completed timeline as direct landings.
    expect(store.devTickets.getDevTicket(incorporated.id)!.dev_status).toBe("open");
    expect(store.devTickets.listDevTickets(10).map((row) => row.id)).toEqual([
      newerOpen.id,
      olderOpen.id,
      incorporated.id,
      landed.id,
    ]);
    store.devTickets.addTicketMessage(incorporated.id, "bob", "web", "please continue");
    const order = store.devTickets.listDevTickets(10).map((row) => row.id);
    expect(order.indexOf(incorporated.id)).toBeLessThan(order.indexOf(landed.id));
    expect(order.slice(0, 3)).toContain(incorporated.id);
  });

  it("recovers interrupted turns by atomically replacing markers with wake messages", () => {
    const a = createTicket({ title: "a", body: "b", requester: "alice" });
    const b = createTicket({ title: "b", body: "b", requester: "alice" });
    store.devTickets.takeTicketInbox(a.id, 1);
    store.devTickets.updateDevTicket(a.id, { turn_started_at: "2026-07-25T00:00:00.000Z" });
    expect(store.devTickets.recoverInterruptedDevTurns("继续执行")).toEqual([a.id]);
    expect(store.devTickets.getDevTicket(a.id)!.turn_started_at).toBeNull();
    expect(store.devTickets.getDevTicket(b.id)!.turn_started_at).toBeNull();
    expect(store.devTickets.listTicketMessages(a.id, { undeliveredOnly: true }).map((row) => row.body)).toEqual([
      "继续执行",
    ]);
    expect(store.devTickets.recoverInterruptedDevTurns("继续执行")).toEqual([]);
  });

  it("finishes a turn with at most one transactional restart wake-up", () => {
    const t = createTicket({ title: "a", body: "b", requester: "alice", kind: "discuss" });
    store.devTickets.takeTicketInbox(t.id, 1);
    store.devTickets.updateDevTicket(t.id, { turn_started_at: "2026-08-27T00:00:00.000Z" });

    expect(store.devTickets.finishDevTurn(t.id, "继续执行")).toBe(true);
    expect(store.devTickets.finishDevTurn(t.id, "继续执行")).toBe(false);
    expect(store.devTickets.listTicketMessages(t.id, { undeliveredOnly: true }).map((row) => row.body)).toEqual([
      "继续执行",
    ]);
  });

  it("does not count App-only tickets as trusted code waiting to deploy", () => {
    const app = createTicket({
      title: "app", body: "b", requester: "alice", kind: "app", app_id: "session-plus",
    });
    store.devTickets.updateDevTicket(app.id, { dev_status: "landed", deploy_status: "pending" });
    expect(store.devTickets.countDevTickets().landed_pending).toBe(0);
  });

  it("counts the final delivery declaration instead of the filing kind", () => {
    const appOnly = createTicket({ title: "multi", body: "b", requester: "alice", kind: "simple" });
    store.devTickets.updateDevTicket(appOnly.id, {
      dev_status: "landed",
      deploy_status: "pending",
      delivery_mode: "app_releases",
      delivery_apps: '["showcase","ppt-studio"]',
    });
    const trustedLegacyKind = createTicket({
      title: "trusted", body: "b", requester: "alice", kind: "app", app_id: "session-plus",
    });
    store.devTickets.updateDevTicket(trustedLegacyKind.id, {
      dev_status: "landed",
      deploy_status: "pending",
      delivery_mode: "full_deploy",
      delivery_apps: "[]",
    });

    expect(store.devTickets.countDevTickets().landed_pending).toBe(1);
  });

  it("patches only whitelisted columns and bumps updated_at", () => {
    const t = createTicket({ title: "t", body: "b", requester: "alice" });
    store.devTickets.updateDevTicket(t.id, { spec: "plan", branch: "ticket/1-x", gate_attempts: 2 });
    const got = store.devTickets.getDevTicket(t.id)!;
    expect(got.spec).toBe("plan");
    expect(got.branch).toBe("ticket/1-x");
    expect(got.gate_attempts).toBe(2);
    expect(() => store.devTickets.updateDevTicket(t.id, { requester: "eve" } as never)).toThrow(/unpatchable/);
    expect(() => store.devTickets.updateDevTicket(t.id, { id: 99 } as never)).toThrow(/unpatchable/);
  });

  it("counts panel numbers", () => {
    const a = createTicket({ title: "a", body: "b", requester: "alice" });
    createTicket({ title: "b", body: "b", requester: "alice" });
    const c = createTicket({ title: "c", body: "b", requester: "alice" });
    const d = createTicket({ title: "d", body: "b", requester: "alice" });
    store.devTickets.updateDevTicket(a.id, { turn_started_at: "2026-07-25T00:00:00.000Z" });
    store.devTickets.takeTicketInbox(a.id, 1); // running, nothing queued
    store.devTickets.updateDevTicket(c.id, { dev_status: "landed", deploy_status: "pending" });
    store.devTickets.takeTicketInbox(c.id, 2);
    store.devTickets.updateDevTicket(d.id, { dev_status: "cancelled" });
    expect(store.devTickets.countDevTickets()).toEqual({
      open: 2, // a + b (c landed, d cancelled)
      running: 1, // a
      queued_input: 1, // b: open, not running, creation message unread; d is cancelled → excluded
      landed_pending: 1, // c
    });
  });

  it("roster rows carry last_author for the attention dot", () => {
    const t = createTicket({ title: "t", body: "b", requester: "alice" });
    expect(store.devTickets.listDevTickets(10)[0].last_author).toBe("alice");
    store.devTickets.addTicketMessage(t.id, "agent", "agent", "我做完了,请验收", 3);
    expect(store.devTickets.listDevTickets(10)[0].last_author).toBe("agent");
  });

  it("links follow-up tickets to their parent", () => {
    const parent = createTicket({ title: "p", body: "b", requester: "alice" });
    const child = createTicket({ title: "c", body: "b", requester: "bob", parent_ticket_id: parent.id });
    expect(child.parent_ticket_id).toBe(parent.id);
  });

  it("inbox: messages queue undelivered; takeTicketInbox stamps atomically and exactly once", () => {
    const t = createTicket({ title: "t", body: "开场白", requester: "alice" });
    store.devTickets.addTicketMessage(t.id, "alice", "web", "先做A");
    store.devTickets.addTicketMessage(t.id, "bob", "feishu", "顺便看B");

    expect(store.devTickets.listTicketMessages(t.id, { undeliveredOnly: true })).toHaveLength(3);

    const taken = store.devTickets.takeTicketInbox(t.id, 3);
    expect(taken.map((m) => m.body)).toEqual(["开场白", "先做A", "顺便看B"]);
    expect(store.devTickets.listTicketMessages(t.id, { undeliveredOnly: true })).toHaveLength(0);
    expect(store.devTickets.takeTicketInbox(t.id, 4)).toHaveLength(0); // no double delivery
    // Full history keeps the stamps.
    expect(store.devTickets.listTicketMessages(t.id).map((m) => m.delivered_turn)).toEqual([3, 3, 3]);
  });

  it("the agent's own replies land pre-delivered (never fed back to it)", () => {
    const t = createTicket({ title: "t", body: "b", requester: "alice" });
    store.devTickets.takeTicketInbox(t.id, 1);
    store.devTickets.addTicketMessage(t.id, "agent", "agent", "用 A 还是 B?", 7);
    expect(store.devTickets.listTicketMessages(t.id, { undeliveredOnly: true })).toHaveLength(0);
    expect(store.devTickets.listTicketsNeedingTurn()).toHaveLength(0);
  });

  describe("ticket agent model options", () => {
    it("first-party Codex xhigh is the default while explicit Claude and OMP choices remain valid", () => {
      expect(DEV_TICKET_MODELS.has("omp-gpt-5.6-sol")).toBe(true);
      const t = createTicket({ title: "x", body: "y", requester: "alice" });
      expect(t).toMatchObject({ model: "codex-gpt-6-astra", effort: "xhigh" });
      const claude = createTicket({
        title: "claude", body: "y", requester: "alice", model: "claude-opus-4-7",
      });
      expect(claude.model).toBe("claude-opus-4-7");
    });

    it("cliFamilyForModel routes on the codex- prefix", () => {
      expect(cliFamilyForModel("codex-gpt-5.6-sol")).toBe("codex");
      expect(cliFamilyForModel("claude-opus-5")).toBe("claude");
      expect(cliFamilyForModel("claude-opus-4-7")).toBe("claude");
      // Legacy alias and unknown ids stay claude — the CLI still accepts them.
      expect(cliFamilyForModel("opus")).toBe("claude");
      expect(cliFamilyForModel(undefined)).toBe("claude");
      expect(cliFamilyForModel(null)).toBe("claude");
      expect(cliFamilyForModel("")).toBe("claude");
    });

    it("modelIdForCli strips the codex- prefix but leaves claude ids alone", () => {
      expect(modelIdForCli("codex-gpt-5.6-sol")).toBe("gpt-5.6-sol");
      expect(modelIdForCli("claude-opus-4-7")).toBe("claude-opus-4-7");
      expect(modelIdForCli("opus")).toBe("opus");
    });
  });

  // Ticket #38-5: discuss mode as a fourth kind.
  it("ticket #38-5: 'discuss' is a valid kind and the store persists it", () => {
    expect(DEV_TICKET_KINDS.has("discuss")).toBe(true);
    const t = createTicket({
      title: "新讨论 · 08-10",
      body: "想聊聊 SEC-01",
      requester: "alice",
      kind: "discuss",
    });
    expect(t.kind).toBe("discuss");
    expect(t.dev_status).toBe("open");
    // No app_id even if one was somehow passed — 'discuss' is not the app kind.
    const t2 = createTicket({
      title: "y",
      body: "z",
      requester: "alice",
      kind: "discuss",
      app_id: "session-plus",
    });
    expect(t2.app_id).toBeNull();
  });

  it("ticket #38-5: discuss tickets can be renamed via updateDevTicket({title})", () => {
    const t = createTicket({ title: "新讨论 · x", body: "y", requester: "alice", kind: "discuss" });
    store.devTickets.updateDevTicket(t.id, { title: "秘书投递 SEC-01 追问" });
    expect(store.devTickets.getDevTicket(t.id)!.title).toBe("秘书投递 SEC-01 追问");
  });
});

it("persists the ticket, inbox and selected execution binding together", () => {
  const store = new Store(":memory:");
  try {
    store.saveUser({ username: "alice", uid: 1, home_dir: "/unused", created_at: "now" });
    const binding = { owner: "alice", device: "aws", workspaceId: "ws_test", executionDevice: "4090", source: "codex" as const, codexAccount: "pool-b" };
    const row = store.devTickets.createDevTicket({ ...normalizeDevTicketInput({ title: "t", body: "b", requester: "alice" }), runner_binding: binding });
    expect(store.devTickets.runner.binding(row.id)).toEqual(binding);
    expect(store.devTickets.listTicketMessages(row.id).map((m) => m.body)).toEqual(["b"]);
    expect(() => store.devTickets.runner.bind(row.id, { ...binding, device: "other" })).toThrow("不可隐式更换");
  } finally { store.close(); }
});
