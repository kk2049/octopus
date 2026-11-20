import { describe, expect, it } from "vitest";
import { Store } from "../store/store.js";
import type { DevTicketRow } from "../store/repositories/dev-tickets.js";
import { normalizeDevTicketInput } from "./ticket-models.js";
import {
  ciRepairAgentBusy,
  classifyCiRepairFailure,
  ciRepairAwaitingVerification,
  ciRepairBusyForScheduling,
  findCiRepairRouteTarget,
  GitLabCiMonitor,
  type GitLabCiFailure,
  isInfrastructureFailure,
} from "./gitlab-ci.js";

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

describe("GitLabCiMonitor", () => {
  it("projects a green once and advances the tested anchor before recording it", async () => {
    const store = new Store(":memory:");
    const green: string[] = [];
    const fetchFn = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/pipelines?")) {
        expect(url).toContain("projects/lvht%2Foctopus/pipelines?");
        return json([{ id: 41, iid: 9, name: "octopus-v4-batch", sha: "abc123", ref: "v4", status: "success", web_url: "https://git/p/41", created_at: "2026-08-09T01:00:00Z", updated_at: "2026-08-09T01:01:00Z" }]);
      }
      if (url.includes("/pipelines/41/jobs")) return json([{ id: 410, name: "full_suite", status: "success" }]);
      if (url.includes("/repository/branches/v4")) return json({ commit: { id: "abc123" } });
      return new Response("missing", { status: 404 });
    };
    const monitor = new GitLabCiMonitor({
      store,
      apiUrl: "https://git/api/v4/",
      project: "lvht/octopus",
      token: "secret",
      ref: "v4",
      fetchFn: fetchFn as typeof fetch,
      onGreen: async (sha) => { green.push(sha); },
      onRed: () => null,
    });
    await monitor.pollOnce();
    await monitor.pollOnce();
    expect(green).toEqual(["abc123"]);
    expect(store.devTickets.getExternalTestRun("gitlab", "41")).toMatchObject({ status: "green", external_url: "https://git/p/41" });
    store.close();
  });

  it("opens one repair ticket for script failures and treats runner failures as aborted", async () => {
    const store = new Store(":memory:");
    const tickets: string[] = [];
    const pipelines = [
      { id: 52, iid: 11, name: "octopus-v4-batch", sha: "infra", ref: "v4", status: "failed", web_url: "https://git/p/52", created_at: "2026-08-09T03:00:00Z", updated_at: "2026-08-09T03:01:00Z" },
      { id: 51, iid: 10, name: "octopus-v4-batch", sha: "bad", ref: "v4", status: "failed", web_url: "https://git/p/51", created_at: "2026-08-09T02:00:00Z", updated_at: "2026-08-09T02:01:00Z" },
    ];
    const fetchFn = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/pipelines?")) return json(pipelines);
      if (url.includes("/pipelines/51/jobs")) return json([{ id: 501, name: "full_suite", status: "failed", failure_reason: "script_failure", web_url: "https://git/j/501" }]);
      if (url.includes("/pipelines/52/jobs")) return json([{ id: 502, name: "full_suite", status: "failed", failure_reason: "runner_system_failure", web_url: "https://git/j/502" }]);
      if (url.includes("/jobs/501/trace")) return new Response("AssertionError: expected true", { status: 200 });
      if (url.includes("/jobs/502/trace")) return new Response("runner vanished", { status: 200 });
      if (url.includes("/repository/branches/v4")) return json({ commit: { id: "infra" } });
      return new Response("missing", { status: 404 });
    };
    const monitor = new GitLabCiMonitor({
      store,
      apiUrl: "https://git/api/v4",
      project: 7,
      token: "secret",
      ref: "v4",
      fetchFn: fetchFn as typeof fetch,
      onGreen: async () => {},
      onRed: (failure) => { tickets.push(failure.summary); return 99; },
    });
    await monitor.pollOnce();
    await monitor.pollOnce();
    expect(store.devTickets.getExternalTestRun("gitlab", "51")).toMatchObject({ status: "red", ticket_id: 99 });
    expect(store.devTickets.getExternalTestRun("gitlab", "52")).toMatchObject({ status: "aborted", ticket_id: null });
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toContain("AssertionError");
    store.close();
  });

  it("awaits asynchronous repair context before attaching the red run", async () => {
    const store = new Store(":memory:");
    let releaseHistory!: () => void;
    let callbackStarted!: () => void;
    const historyReady = new Promise<void>((resolve) => { releaseHistory = resolve; });
    const started = new Promise<void>((resolve) => { callbackStarted = resolve; });
    const fetchFn = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/pipelines?")) {
        return json([{
          id: 53, iid: 12, name: "octopus-v4-batch", sha: "bad-async", ref: "v4", status: "failed",
          web_url: "https://git/p/53", created_at: "2026-08-09T04:00:00Z", updated_at: "2026-08-09T04:01:00Z",
        }]);
      }
      if (url.includes("/pipelines/53/jobs")) {
        return json([{ id: 503, name: "full_suite", status: "failed", failure_reason: "script_failure" }]);
      }
      if (url.includes("/jobs/503/trace")) return new Response("AssertionError: red", { status: 200 });
      if (url.includes("/repository/branches/v4")) return json({ commit: { id: "bad-async" } });
      return new Response("missing", { status: 404 });
    };
    const monitor = new GitLabCiMonitor({
      store,
      apiUrl: "https://git/api/v4",
      project: 7,
      token: "secret",
      ref: "v4",
      fetchFn: fetchFn as typeof fetch,
      onGreen: async () => {},
      onRed: async () => {
        callbackStarted();
        await historyReady;
        return 121;
      },
    });

    const polling = monitor.pollOnce();
    await started;
    expect(store.devTickets.getExternalTestRun("gitlab", "53")).toMatchObject({
      status: "red",
      ticket_id: null,
    });
    releaseHistory();
    await polling;
    expect(store.devTickets.getExternalTestRun("gitlab", "53")).toMatchObject({
      status: "red",
      ticket_id: 121,
    });
    store.close();
  });

  it("hands the repair ticket a parsed failure roster instead of a raw trace tail", async () => {
    const store = new Store(":memory:");
    const summaries: string[] = [];
    // Long enough that a 5 000-byte tail would have dropped the first failure —
    // which is exactly the regression this replaces.
    const noise = Array.from({ length: 400 }, (_, i) => `2026-08-10T07:00:0${i % 10}.000000Z 01O stdout noise line ${i}`).join("\n");
    const trace = [
      "2026-08-10T07:10:00.000000Z 01E  FAIL  node packages/bot/src/early.test.ts > early > first case",
      "2026-08-10T07:10:00.000001Z 01E AssertionError: expected 1 to be 2",
      noise,
      "2026-08-10T07:20:00.000000Z 01E  FAIL  web packages/dashboard-web/src/late.test.tsx > late > last case",
      "2026-08-10T07:20:00.000001Z 01E AssertionError: expected 3 to be 4",
      "2026-08-10T07:20:01.000000Z 01O  Test Files  2 failed | 100 passed (102)",
      "2026-08-10T07:20:01.000001Z 01O       Tests  2 failed | 900 passed (902)",
      "2026-08-10T07:20:02.000000Z 01E ERROR: Job failed: exit code 1",
    ].join("\n");
    const fetchFn = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/pipelines?")) {
        return json([{ id: 61, iid: 20, name: "octopus-v4-batch", sha: "red", ref: "v4", status: "failed", web_url: "https://git/p/61", created_at: "2026-08-10T07:00:00Z", updated_at: "2026-08-10T07:21:00Z" }]);
      }
      if (url.includes("/pipelines/61/jobs")) return json([{ id: 610, name: "full_suite", status: "failed", failure_reason: "script_failure", web_url: "https://git/j/610" }]);
      if (url.includes("/jobs/610/trace")) return new Response(trace, { status: 200 });
      if (url.includes("/repository/branches/v4")) return json({ commit: { id: "red" } });
      return new Response("missing", { status: 404 });
    };
    const rosters: string[][] = [];
    const monitor = new GitLabCiMonitor({
      store,
      apiUrl: "https://git/api/v4",
      project: 7,
      token: "secret",
      ref: "v4",
      fetchFn: fetchFn as typeof fetch,
      onGreen: async () => {},
      onRed: (failure) => { summaries.push(failure.summary); rosters.push(failure.roster); return 120; },
    });
    await monitor.pollOnce();
    // Ticket #219: the repair ticket is opened with the files it owes, not
    // only with prose about them — the land gate reruns exactly this list.
    expect(rosters[0]).toEqual([
      "packages/bot/src/early.test.ts",
      "packages/dashboard-web/src/late.test.tsx",
    ]);
    const summary = summaries[0];
    // Both ends of a long trace survive, and the runner bookkeeping does not.
    expect(summary).toContain("packages/bot/src/early.test.ts");
    expect(summary).toContain("packages/dashboard-web/src/late.test.tsx");
    expect(summary).toContain("用例 2 失败");
    expect(summary).not.toContain("stdout noise line");
    expect(summary).not.toContain("2026-08-10T07:10:00");
    expect(summary.length).toBeLessThan(trace.length / 10);
    store.close();
  });

  it("persists every parsed error and derives an untruncated failure roster", async () => {
    const store = new Store(":memory:");
    const failures = Array.from({ length: 30 }, (_, i) => [
      ` FAIL  node packages/bot/src/case-${i}.test.ts > suite > case ${i}`,
      `AssertionError: expected ${i} to be ${i + 1}`,
    ].join("\n")).join("\n");
    const fetchFn = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/pipelines?")) {
        return json([{
          id: 62, iid: 21, name: "octopus-v4-batch", sha: "red-many", ref: "v4", status: "failed",
          web_url: "https://git/p/62", created_at: "2026-08-10T08:00:00Z", updated_at: "2026-08-10T08:21:00Z",
        }]);
      }
      if (url.includes("/pipelines/62/jobs")) {
        return json([{ id: 620, name: "full_suite", status: "failed", failure_reason: "script_failure" }]);
      }
      if (url.includes("/jobs/620/trace")) return new Response(failures, { status: 200 });
      return new Response("missing", { status: 404 });
    };
    const received: GitLabCiFailure[] = [];
    const monitor = new GitLabCiMonitor({
      store,
      apiUrl: "https://git/api/v4",
      project: 7,
      token: "secret",
      ref: "v4",
      fetchFn: fetchFn as typeof fetch,
      onGreen: async () => {},
      onRed: (failure) => { received.push(failure); return 122; },
    });
    await monitor.pollOnce();
    expect(received[0].roster).toHaveLength(30);
    expect(received[0].roster[0]).toBe("packages/bot/src/case-0.test.ts");
    expect(received[0].roster[29]).toBe("packages/bot/src/case-29.test.ts");
    expect(received[0].summary).toContain("case 0");
    expect(received[0].summary).toContain("case 29");
    store.close();
  });

  it("holds the Beijing 04:00 batch until repair work clears and GitLab mirrors mainline", async () => {
    const store = new Store(":memory:");
    const posts: string[] = [];
    let repairing = true;
    let remoteSha = "old-remote-sha";
    const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/pipelines?")) return json([]);
      if (url.includes("/repository/branches/v4")) return json({ commit: { id: remoteSha } });
      if (url.endsWith("/pipeline") && init?.method === "POST") {
        posts.push(String(init.body));
        return json({ id: 77 });
      }
      return new Response("missing", { status: 404 });
    };
    const monitor = new GitLabCiMonitor({
      store,
      apiUrl: "https://git/api/v4",
      project: 7,
      token: "secret",
      ref: "v4",
      fetchFn: fetchFn as typeof fetch,
      onGreen: async () => {},
      onRed: () => null,
      repairBlocksScheduling: () => repairing,
      mainlineSha: async () => "next-sha",
    });
    await monitor.requestNightlyRun();
    expect(posts).toEqual([]);
    repairing = false;
    await monitor.pollOnce();
    expect(posts).toEqual([]); // repair ended, but the best-effort push is not visible yet
    remoteSha = "next-sha";
    await monitor.pollOnce();
    expect(posts).toEqual([JSON.stringify({ ref: "v4" })]);
    store.close();
  });


  it("does not schedule ordinary daytime commits before the nightly trigger", async () => {
    const store = new Store(":memory:");
    let branchReads = 0;
    const fetchFn = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/pipelines?")) return json([]);
      if (url.includes("/repository/branches/v4")) {
        branchReads += 1;
        return json({ commit: { id: "daytime-sha" } });
      }
      return new Response("missing", { status: 404 });
    };
    const monitor = new GitLabCiMonitor({
      store,
      apiUrl: "https://git/api/v4",
      project: 7,
      token: "secret",
      ref: "v4",
      fetchFn: fetchFn as typeof fetch,
      onGreen: async () => {},
      onRed: () => null,
    });
    await monitor.pollOnce();
    expect(branchReads).toBe(0);
    store.close();
  });

  it("immediately schedules a full verification after a repair landing", async () => {
    const store = new Store(":memory:");
    store.saveUser({ username: "lht", uid: 1, home_dir: "/tmp/x", created_at: "2026-01-01T00:00:00Z" });
    const ticket = store.devTickets.createDevTicket(normalizeDevTicketInput({
      title: "修复夜间 CI",
      body: "red",
      requester: "lht",
      kind: "simple",
      via: "gitlab-ci",
      ci_roster: JSON.stringify(["packages/bot/src/red.test.ts"]),
    }));
    store.devTickets.takeTicketInbox(ticket.id, 1);
    const red = store.devTickets.startExternalTestRun({
      provider: "gitlab",
      externalId: "night-red",
      externalUrl: "https://git/red",
      sha: "red-sha",
      fromSha: null,
      startedAt: "2026-08-18T20:00:00Z",
    });
    store.devTickets.finishExternalTestRun(red.id, "red", "2026-08-18T20:20:00Z", "red", "script_failure");
    store.devTickets.attachTestRunTicket(red.id, ticket.id);
    store.devTickets.updateDevTicket(ticket.id, {
      dev_status: "landed",
      commit_sha: "fix-sha",
      landed_at: "2026-08-18T20:30:00Z",
    });

    let posts = 0;
    const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/pipelines?")) return json([]);
      if (url.includes("/repository/branches/v4")) return json({ commit: { id: "fix-sha" } });
      if (url.endsWith("/pipeline") && init?.method === "POST") {
        posts += 1;
        return json({ id: 88 });
      }
      return new Response("missing", { status: 404 });
    };
    const monitor = new GitLabCiMonitor({
      store,
      apiUrl: "https://git/api/v4",
      project: 7,
      token: "secret",
      ref: "v4",
      fetchFn: fetchFn as typeof fetch,
      onGreen: async () => {},
      onRed: () => null,
    });
    await monitor.pollOnce();
    expect(posts).toBe(1);
    store.close();
  });
});

describe("isInfrastructureFailure", () => {
  it("only classifies provider/runner failures as infrastructure", () => {
    expect(isInfrastructureFailure("runner_system_failure")).toBe(true);
    expect(isInfrastructureFailure("script_failure")).toBe(false);
  });
});

describe("ciRepairAgentBusy", () => {
  const ticket = (patch: Partial<{
    dev_status: string;
    turn_started_at: string | null;
    error: string | null;
  }> = {}) => ({
    dev_status: "landed",
    turn_started_at: null,
    error: null,
    ...patch,
  });

  it("counts landed-with-queued-follow-up as busy — a new batch would pin an intermediate", () => {
    expect(ciRepairAgentBusy(ticket(), 1)).toBe(true);
    expect(ciRepairAgentBusy(ticket({ turn_started_at: "2026-08-10T07:02:11Z" }), 0)).toBe(true);
  });

  it("clears once no queue and no running turn, so verification can be scheduled", () => {
    expect(ciRepairAgentBusy(ticket(), 0)).toBe(false);
    expect(ciRepairAgentBusy(ticket({ dev_status: "cancelled" }), 3)).toBe(false);
    expect(ciRepairAgentBusy(undefined, 0)).toBe(false);
    // `error` and a plain `open` used to answer true here. Both describe a
    // PARKED conversation that the pump will never wake on its own, so both
    // blocked mainline CI forever — see the follow-up describe block below.
    expect(ciRepairAgentBusy(ticket({ error: "turn failed" }), 0)).toBe(false);
    expect(ciRepairAgentBusy(ticket({ dev_status: "open" }), 0)).toBe(false);
  });
});

describe("ciRepairAwaitingVerification", () => {
  const landed = (at: string | null) => ({ dev_status: "landed", landed_at: at });

  it("keeps a just-landed repair pending until a green batch started AFTER its landing", () => {
    expect(ciRepairAwaitingVerification(landed("2026-08-10T10:00:00Z"), null)).toBe(true);
    // A green that started before the repair landed cannot vouch for the repair.
    expect(ciRepairAwaitingVerification(landed("2026-08-10T10:00:00Z"), "2026-08-10T09:30:00Z")).toBe(true);
    // A green that started at or after the landing settles it.
    expect(ciRepairAwaitingVerification(landed("2026-08-10T10:00:00Z"), "2026-08-10T10:00:00Z")).toBe(false);
    expect(ciRepairAwaitingVerification(landed("2026-08-10T10:00:00Z"), "2026-08-10T10:15:00Z")).toBe(false);
  });

  it("never fires for non-landed or cancelled tickets, or for rows predating landed_at", () => {
    expect(ciRepairAwaitingVerification({ dev_status: "open", landed_at: null }, null)).toBe(false);
    expect(ciRepairAwaitingVerification({ dev_status: "cancelled", landed_at: "2026-08-10T10:00:00Z" }, null)).toBe(false);
    // A landed row with no landed_at (pre-v22) has to fall back to false so routing to a
    // fresh ticket is the observable behavior, exactly as before this split existed.
    expect(ciRepairAwaitingVerification(landed(null), null)).toBe(false);
    expect(ciRepairAwaitingVerification(undefined, null)).toBe(false);
  });
});

describe("findCiRepairRouteTarget / ciRepairBusyForScheduling", () => {
  function seedStore(options: { leaveOpeningUnread?: boolean } = {}): { store: Store; ticket: DevTicketRow } {
    const store = new Store(":memory:");
    store.saveUser({ username: "lht", uid: 1, home_dir: "/tmp/x", created_at: "2026-01-01T00:00:00Z" });
    const ticket = store.devTickets.createDevTicket(normalizeDevTicketInput({
      title: "修复 GitLab CI 红灯 abcd1234",
      body: "log tail",
      requester: "lht",
      kind: "simple",
      via: "gitlab-ci",
    }));
    // The unread body message would count as agent-busy; the pump normally stamps
    // it when it takes the inbox for the first turn. Simulate that here so the
    // scenario tests can control "unread" explicitly.
    if (!options.leaveOpeningUnread) store.devTickets.takeTicketInbox(ticket.id, 1);
    return { store, ticket };
  }

  function seedRedRun(store: Store, ticketId: number, sha: string, startedAt: string): number {
    const run = store.devTickets.startExternalTestRun({
      provider: "gitlab",
      externalId: `pipe-${sha}`,
      externalUrl: "https://git/p/1",
      sha,
      fromSha: null,
      startedAt,
    });
    store.devTickets.finishExternalTestRun(run.id, "red", startedAt, "assert failed", "script_failure");
    store.devTickets.attachTestRunTicket(run.id, ticketId);
    return run.id;
  }

  function seedGreenRun(store: Store, sha: string, startedAt: string): number {
    const run = store.devTickets.startExternalTestRun({
      provider: "gitlab",
      externalId: `pipe-${sha}`,
      externalUrl: "https://git/p/2",
      sha,
      fromSha: null,
      startedAt,
    });
    store.devTickets.finishExternalTestRun(run.id, "green", startedAt, "ok", null);
    return run.id;
  }

  it("routes a new red to the same repair ticket while the conversation is open", () => {
    const { store, ticket } = seedStore({ leaveOpeningUnread: true });
    seedRedRun(store, ticket.id, "sha1", "2026-08-10T10:00:00Z");
    // A freshly created ticket still holds its undelivered opening message, so
    // somebody IS about to advance it: busy, and the route target.
    expect(ciRepairBusyForScheduling(store)).toBe(true);
    expect(findCiRepairRouteTarget(store)).toEqual({
      ticketId: ticket.id,
      awaiting: false,
    });

    // Now park it the way a manual stop does: inbox consumed, turn over,
    // nothing queued, still `open`.
    store.devTickets.takeTicketInbox(ticket.id, 1);
    expect(ciRepairBusyForScheduling(store)).toBe(false); // CI may run again
    // ...and the next red still belongs in this conversation, which wakes it.
    expect(findCiRepairRouteTarget(store)).toEqual({
      ticketId: ticket.id,
      awaiting: false,
    });
  });

  it("keeps routing to the same ticket after the fix lands but before CI verifies (the core fix)", () => {
    const { store, ticket } = seedStore();
    seedRedRun(store, ticket.id, "sha1", "2026-08-10T10:00:00Z");
    store.devTickets.updateDevTicket(ticket.id, {
      dev_status: "landed",
      commit_sha: "sha-fix",
      landed_at: "2026-08-10T10:20:00Z",
      error: null,
    });
    // Agent has no work left, so scheduling is unblocked...
    expect(ciRepairBusyForScheduling(store)).toBe(false);
    // ...but the same conversation is still the right routing target for the next red.
    // Before this split it flipped to null the moment the fix landed, and the next
    // red opened a fresh ticket that had to rediscover context — that is exactly
    // the loop this test locks down.
    expect(findCiRepairRouteTarget(store)).toEqual({
      ticketId: ticket.id,
      awaiting: true,
    });
  });

  it("closes the loop once a green batch starts after the landing", () => {
    const { store, ticket } = seedStore();
    seedRedRun(store, ticket.id, "sha1", "2026-08-10T10:00:00Z");
    store.devTickets.updateDevTicket(ticket.id, {
      dev_status: "landed",
      commit_sha: "sha-fix",
      landed_at: "2026-08-10T10:20:00Z",
      error: null,
    });
    seedGreenRun(store, "sha-fix", "2026-08-10T10:25:00Z");
    expect(findCiRepairRouteTarget(store)).toBeNull();
    expect(ciRepairBusyForScheduling(store)).toBe(false);
  });

  it("a green that started BEFORE the landing does not settle a later repair", () => {
    // The scenario admin flagged (2026-08-10): a stale batch was scheduled on an
    // ancestor SHA, finished green earlier, then a red batch came in that pins a
    // SHA older than the repair's landing. The stale-green must not be mistaken
    // for the fix's verification.
    const { store, ticket } = seedStore();
    seedGreenRun(store, "sha-old", "2026-08-10T09:00:00Z"); // stale green
    seedRedRun(store, ticket.id, "sha1", "2026-08-10T10:00:00Z");
    store.devTickets.updateDevTicket(ticket.id, {
      dev_status: "landed",
      commit_sha: "sha-fix",
      landed_at: "2026-08-10T10:20:00Z",
      error: null,
    });
    expect(findCiRepairRouteTarget(store)).toEqual({
      ticketId: ticket.id,
      awaiting: true,
    });
  });

  it("returns null when there is no red run — the fresh-ticket path stays available", () => {
    const store = new Store(":memory:");
    expect(findCiRepairRouteTarget(store)).toBeNull();
    expect(ciRepairBusyForScheduling(store)).toBe(false);
    store.close();
  });

  it("counts an unread pipeline message as agent-busy so a follow-up red does not race the pump", () => {
    const { store, ticket } = seedStore();
    seedRedRun(store, ticket.id, "sha1", "2026-08-10T10:00:00Z");
    store.devTickets.updateDevTicket(ticket.id, {
      dev_status: "landed",
      commit_sha: "sha-fix",
      landed_at: "2026-08-10T10:20:00Z",
      error: null,
    });
    // A previous batch already routed a red into the inbox; the fix agent has not
    // taken its turn yet. Blocks scheduling until it does.
    store.devTickets.addTicketMessage(ticket.id, "pipeline", "gitlab-ci-retry", "another red");
    expect(ciRepairBusyForScheduling(store)).toBe(true);
    expect(findCiRepairRouteTarget(store)).toEqual({
      ticketId: ticket.id,
      awaiting: true,
    });
  });
});

describe("a repair that nobody is advancing (ticket #219, follow-up)", () => {
  const parked = { dev_status: "open", turn_started_at: null, error: null };

  it("does not block CI scheduling — stopping a repair must not switch mainline CI off", () => {
    // Live incident: #226 was stopped by hand mid-turn. That leaves `open`
    // with no running turn and no queued message, and `listTicketsNeedingTurn`
    // only ever selects tickets that HAVE an undelivered message — so the
    // ticket could never wake, and the old predicate blocked every future
    // batch waiting for it.
    expect(ciRepairAgentBusy(parked, 0)).toBe(false);
  });

  it("still blocks while a turn runs or a message is queued", () => {
    expect(ciRepairAgentBusy({ ...parked, turn_started_at: "2026-08-17T09:24:36Z" }, 0)).toBe(true);
    expect(ciRepairAgentBusy(parked, 1)).toBe(true);
  });

  it("treats an errored repair as parked, not as work in progress", () => {
    // Same deadlock shape: an errored repair waits for a human, and blocking
    // CI until that human appears leaves mainline untested indefinitely.
    expect(ciRepairAgentBusy({ ...parked, error: "轮次失败" }, 0)).toBe(false);
  });

  it("a cancelled repair is never busy", () => {
    expect(ciRepairAgentBusy({ ...parked, dev_status: "cancelled" }, 3)).toBe(false);
  });
});


describe("failure fingerprint and commit-aware repair routing", () => {
  function landedRepair() {
    const store = new Store(":memory:");
    store.saveUser({ username: "lht", uid: 1, home_dir: "/tmp/x", created_at: "2026-01-01T00:00:00Z" });
    const ticket = store.devTickets.createDevTicket(normalizeDevTicketInput({
      title: "修复 GitLab CI 红灯 old",
      body: "old red",
      requester: "lht",
      kind: "simple",
      via: "gitlab-ci",
      ci_roster: JSON.stringify(["packages/bot/src/old.test.ts"]),
    }));
    store.devTickets.takeTicketInbox(ticket.id, 1);
    const run = store.devTickets.startExternalTestRun({
      provider: "gitlab", externalId: "old", externalUrl: "https://git/old",
      sha: "old", fromSha: null, startedAt: "2026-08-17T10:00:00Z",
    });
    store.devTickets.finishExternalTestRun(run.id, "red", "2026-08-17T10:01:00Z", "old", "script_failure");
    store.devTickets.attachTestRunTicket(run.id, ticket.id);
    store.devTickets.updateDevTicket(ticket.id, {
      dev_status: "landed", commit_sha: "fix", landed_at: "2026-08-17T10:10:00Z",
    });
    return { store, ticket };
  }

  it("archives a red pinned before the landed fix without retrying", async () => {
    const { store, ticket } = landedRepair();
    await expect(classifyCiRepairFailure(
      store,
      { sha: "stale", roster: ["packages/bot/src/old.test.ts"] },
      async () => "failure_before_fix",
    )).resolves.toEqual({ action: "stale", ticketId: ticket.id });
    store.close();
  });

  it("continues only a descendant red with an overlapping failure fingerprint", async () => {
    const { store, ticket } = landedRepair();
    await expect(classifyCiRepairFailure(
      store,
      { sha: "new", roster: ["packages/bot/src/old.test.ts", "packages/runner/src/also.test.ts"] },
      async () => "failure_after_fix",
    )).resolves.toEqual({ action: "continue", ticketId: ticket.id, awaiting: true });
    store.close();
  });

  it("opens a separate ticket for a descendant red with a disjoint fingerprint", async () => {
    const { store } = landedRepair();
    await expect(classifyCiRepairFailure(
      store,
      { sha: "new", roster: ["packages/runner/src/codex-app-server.test.ts"] },
      async () => "failure_after_fix",
    )).resolves.toEqual({ action: "open" });
    store.close();
  });
});
