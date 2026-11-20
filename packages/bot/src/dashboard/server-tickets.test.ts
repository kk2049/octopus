/**
 * Dev-ticket panel backend: shared visibility, requester-scoped lifecycle
 * actions, admin files on behalf of a named user (2026-07-25: the old
 * admin-cannot-create rule is gone — the acceptance owner is now explicit
 * instead of implied by the login), transcript + live view over the dev
 * scan home. Uses a REAL DevPipeline (scripted turns/gates, real git repo)
 * so the API tests exercise the same state machine the panel drives.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readBootstrapPayload } from "./app-page.js";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store/store.js";
import { DevPipeline } from "../devpipe/pipeline.js";
import { CodexAccountRouter } from "../devpipe/codex-account-router.js";
import { DeployService } from "../devpipe/deploy.js";
import {
  normalizeCliDeliveryTicketInput,
  normalizeDevTicketInput,
} from "../devpipe/ticket-models.js";
import { gitOrThrow } from "../devpipe/worktree.js";
import type { DevTurnResult, DevTurnSpec } from "../devpipe/executor.js";
import {
  DashboardServer,
  defaultTicketTitle,
  mintDashboardToken,
  resolveTicketRequester,
  type Capabilities,
} from "./server.js";
import { createDashboardTestServer } from "../e2e/dashboard-test-support.js";
import { ticketActorKind } from "./routes/tickets.js";

describe("resolveTicketRequester (pure)", () => {
  const hasUser = (u: string) => u === "lht" || u === "bob";
  const plain = (u: string): Capabilities => ({ username: u, admin: false, dev: true, deploy: false });
  const boss = (u: string): Capabilities => ({ username: u, admin: true, dev: true, deploy: true });
  const sharedKey: Capabilities = { admin: true, dev: true, deploy: true };

  it("files as itself when no requester is asked for", () => {
    expect(resolveTicketRequester(plain("lht"), "", hasUser)).toEqual({ ok: true, requester: "lht" });
    expect(resolveTicketRequester(plain("lht"), undefined, hasUser)).toEqual({ ok: true, requester: "lht" });
  });
  it("rejects a non-admin naming someone else instead of silently rewriting it", () => {
    // Pre-#15 this quietly filed as the caller. An explicit refusal is the
    // honest answer: the caller asked for something it may not have.
    const r = resolveTicketRequester(plain("bob"), "lht", hasUser);
    expect(r.ok).toBe(false);
  });
  it("lets an admin with an account file on someone's behalf, or as itself", () => {
    expect(resolveTicketRequester(boss("lht"), "bob", hasUser)).toEqual({ ok: true, requester: "bob" });
    expect(resolveTicketRequester(boss("lht"), "", hasUser)).toEqual({ ok: true, requester: "lht" });
  });
  it("shared key has no account, so it must name a real user", () => {
    expect(resolveTicketRequester(sharedKey, "lht", hasUser)).toEqual({ ok: true, requester: "lht" });
    expect(resolveTicketRequester(sharedKey, "", hasUser).ok).toBe(false);
    expect(resolveTicketRequester(sharedKey, undefined, hasUser).ok).toBe(false);
    expect(resolveTicketRequester(sharedKey, "ghost", hasUser).ok).toBe(false);
  });
});

describe("defaultTicketTitle", () => {
  it("renders as 新工单 · MM-DD HH:MM using local time components", () => {
    const dt = new Date(2026, 7, 10, 15, 30);
    expect(defaultTicketTitle(dt)).toBe("新工单 · 08-10 15:30");
  });
  it("pads single-digit components", () => {
    const dt = new Date(2026, 0, 3, 4, 5);
    expect(defaultTicketTitle(dt)).toBe("新工单 · 01-03 04:05");
  });
});

const NOW = "2026-07-25T10:00:00.000Z";
const ADMIN = "admin-secret";
const SESS = "ab12cd34-9999-8888-7777-666655554444";
const CODEX_SESS = "019f4b69-0bcb-7853-8cb1-83fe1f94b4f3";
const REMOTE_CODEX_SESS = "01a037a9-c693-7000-b0a8-882278f43996";

let httpCliReportSeq = 0;
async function commitHttpCliReport(cwd: string): Promise<void> {
  httpCliReportSeq++;
  const baseSha = await gitOrThrow(cwd, ["merge-base", "HEAD", "main"]);
  const rel = `doc/cli-reports/2026-08-13-http-${httpCliReportSeq}.json`;
  mkdirSync(join(cwd, "doc/cli-reports"), { recursive: true });
  writeFileSync(join(cwd, rel), JSON.stringify({
    version: 3,
    base_sha: baseSha,
    title: `HTTP CLI report ${httpCliReportSeq}`,
    summary: "The HTTP landing is visible in tickets.",
    requester: "alice",
    requirements: ["land the branch through the HTTP route"],
    decisions: ["record that this isolated fixture does not run retrieval"],
    non_goals: [],
    risks: [],
    supersedes: [],
    verification: ["route test passed"],
    acceptance: ["ticket row is visible"],
    retrieval: { traces: [], context_keys: [], feedback: [{ code: "not_run" }] },
  }));
  await gitOrThrow(cwd, ["add", rel]);
  await gitOrThrow(cwd, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", `CLI report ${httpCliReportSeq}`]);
}

/**
 * Ceiling for "the pipeline eventually gets there" waits.
 *
 * These are LIVENESS assertions, not latency ones: the state machine drives
 * real git subprocesses, and this suite is graded on a 2-core / 3.8G box where
 * the gate runs the whole vitest suite in parallel with other worktrees'. The
 * chain normally lands in well under a second; 8s → 15s → 30s each flaked in
 * turn under real load, so stop guessing at a latency budget and give the
 * liveness check the room it actually needs. Nothing is slower when the
 * pipeline is healthy — only a genuinely stuck one waits this long.
 */
const PIPELINE_WAIT_MS = 120_000;

async function until(cond: () => boolean, ms = PIPELINE_WAIT_MS): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("condition not reached in time");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("dashboard dev tickets", () => {
  let dir: string;
  let store: Store;
  let dash: DashboardServer;
  let base: string;
  let dtAlice: string;
  let dtBob: string;
  let dtLht: string;
  let dtCarol: string;
  let pipe: DevPipeline;
  let remoteTranscriptOpens: Array<{ username: string; purpose: string; preferredDevice?: string }>;
  let remoteTranscriptCalls: Array<{ op: string; args: Record<string, unknown> }>;
  let remoteTranscriptCloses: number;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "dashtk-"));
    const repo = join(dir, "repo");
    await gitOrThrow(dir, ["init", "-b", "main", repo]);
    writeFileSync(join(repo, "README.md"), "base\n");
    await gitOrThrow(repo, ["add", "README.md"]);
    await gitOrThrow(repo, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"]);
    await gitOrThrow(repo, ["checkout", "-b", "live"]);

    // Dev scan home with the session the scripted spec turn will report.
    const devHome = join(dir, "devhome");
    const proj = join(devHome, ".claude", "projects", "-wt");
    mkdirSync(proj, { recursive: true });
    writeFileSync(
      join(proj, `${SESS}.jsonl`),
      [
        JSON.stringify({ type: "user", sessionId: SESS, cwd: "/wt", timestamp: NOW, message: { role: "user", content: "工单 spec prompt" } }),
        JSON.stringify({ type: "assistant", timestamp: NOW, message: { role: "assistant", content: [{ type: "text", text: "## 方案\nplan" }] } }),
      ].join("\n"),
    );
    const codexHome = join(devHome, "codex-account-a");
    const codexDir = join(codexHome, "sessions", "2026", "07", "25");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(
      join(codexDir, `rollout-2026-07-25T10-00-00-${CODEX_SESS}.jsonl`),
      [
        JSON.stringify({
          timestamp: NOW,
          type: "session_meta",
          payload: { id: CODEX_SESS, session_id: CODEX_SESS, cwd: "/wt-codex", git: { branch: "ticket/codex" } },
        }),
        JSON.stringify({ timestamp: NOW, type: "event_msg", payload: { type: "user_message", message: "Codex 工单 prompt" } }),
        JSON.stringify({ timestamp: NOW, type: "event_msg", payload: { type: "agent_message", message: "Codex 正在处理" } }),
      ].join("\n"),
    );

    store = new Store(join(dir, "t.db"));
    store.saveUser({ username: "alice", uid: 1, home_dir: "/x/a", created_at: NOW });
    store.saveUser({ username: "bob", uid: 2, home_dir: "/x/b", created_at: NOW });
    store.saveUser({ username: "lht", uid: 4, home_dir: "/x/lht", created_at: NOW });
    dtAlice = mintDashboardToken(store, "alice");
    dtBob = mintDashboardToken(store, "bob");
    dtLht = mintDashboardToken(store, "lht");
    // Ticket #15: the dev pipeline is opt-in per user now. alice and bob are
    // in it (that is what these tests exercise); carol below is not, and
    // stands in for every account that must not even see it exists.
    store.saveUser({ username: "carol", uid: 3, home_dir: "/x/c", created_at: NOW });
    dtCarol = mintDashboardToken(store, "carol");
    for (const u of ["alice", "bob", "lht"]) store.grantCapability(u, "dev", "test", NOW);
    remoteTranscriptOpens = [];
    remoteTranscriptCalls = [];
    remoteTranscriptCloses = 0;

    // The scripted agent (ticket #12 conversation model, ticket #16 parallel
    // coding + serial merge): discussion turns just reply; when the user says
    // go ("开始实现"), it commits and calls devpipe_submit — the single tool
    // that carries the entire merge phase.
    let fileSeq = 0;
    const runTurn = async (cwd: string, spec: DevTurnSpec): Promise<DevTurnResult> => {
      const baseR = { exit_code: 0, timed_out: false, duration_ms: 3 };
      let token: string | null = null;
      if (spec.mcpConfigPath) {
        const cfg = JSON.parse(readFileSync(spec.mcpConfigPath, "utf8")) as {
          mcpServers: { devpipe: { env: { DEVPIPE_TOKEN: string } } };
        };
        token = cfg.mcpServers.devpipe.env.DEVPIPE_TOKEN;
      }
      if (token && spec.prompt.includes("开始实现")) {
        fileSeq++;
        writeFileSync(join(cwd, `w${fileSeq}.txt`), "w\n");
        await gitOrThrow(cwd, ["add", "."]);
        await gitOrThrow(cwd, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "w"]);
        await pipe.toolSubmit(token);
        return { ok: true, session_id: spec.resumeSessionId ?? spec.sessionId, result_text: "已实现并落地", ...baseR };
      }
      const sessionId = spec.model?.startsWith("codex-") ? CODEX_SESS : SESS;
      return { ok: true, session_id: sessionId, result_text: "## 名字\n加个搜索\n\n方案:plan\n\n验收:可用", ...baseR };
    };

    pipe = new DevPipeline({
      // No remote in a temp repo, and a test must never push anywhere.
      pushRemote: null,
      knowledgeCaptureEnabled: false,
      // This fixture is a tiny git repo, not an Octopus/pnpm candidate tree.
      // The thin land gate has its own focused coverage; keep this suite on
      // the dashboard/ticket lifecycle it is intended to exercise.
      landGateEnabled: false,
      // Same reason for the post-landing build warmer (build-warm.test.ts).
      buildWarmEnabled: false,
      store,
      repoDir: repo,
      worktreesDir: join(dir, "wts"),
      baseBranch: "main",
      runTurn,
      remoteCodex: (username, purpose, preferredDevice) => {
        remoteTranscriptOpens.push({ username, purpose, preferredDevice });
        if (username !== "alice" || preferredDevice !== "macbookpro") return null;
        return {
          device: "macbookpro",
          online: true,
          call: async (op, args) => {
            remoteTranscriptCalls.push({ op, args });
            if (op !== "codex_agent_read_session") throw new Error(`unexpected remote op: ${op}`);
            return {
              meta: { id: REMOTE_CODEX_SESS, source: "codex", activity: { state: "idle" } },
              offset: Number(args.offset ?? 0),
              total_messages: 1,
              messages: [{
                id: "remote-agent-1",
                role: "assistant",
                blocks: [{ type: "text", text: "远端 Codex 完整执行细节" }],
              }],
            };
          },
          close: () => { remoteTranscriptCloses++; },
        };
      },
      codexAccountRouter: new CodexAccountRouter({
        accounts: { account_a: codexHome },
        readRateLimits: async () => ({
          rateLimitsByLimitId: { codex: { primary: {
            usedPercent: 25,
            windowDurationMins: 10_080,
            resetsAt: (Date.now() + 24 * 60 * 60 * 1000) / 1000,
          } } },
        }),
      }),
      gate: async () => ({ ok: true, log: "pass" }),
      mcpServerPath: "/nonexistent/mcp-server.js",
    });
    dash = createDashboardTestServer(store, undefined, {
      port: 0,
      host: "127.0.0.1",
      authToken: ADMIN,
      devPipeline: pipe,
      devScanHome: devHome,
    });
    await dash.start();
    base = `http://127.0.0.1:${dash.port}`;
    pipe.setToolApi(base); // production order: listening, tool bind, then scheduling
    pipe.start();
  }, 20_000);

  afterAll(async () => {
    await dash.stop();
    await pipe.stop(); // lanes are concurrent: quiesce before closing the store
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const as = (t: string) => ({ authorization: `Bearer ${t}` });
  // Writes present the bearer explicitly: a cookie is an ambient credential
  // and the mutation gate refuses those without a CSRF secret.
  const post = (path: string, token: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });

  it("page + nav gating: /tickets serves when enabled, dev tab appears everywhere", async () => {
    const page = await fetch(`${base}/tickets`, { headers: as(dtAlice) });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("开发工单");
    expect(readBootstrapPayload(html).nav.map((t) => t.path)).toContain("/tickets");
  });

  it("admin files on behalf of a real user; a user files as itself; the first turn replies", async () => {
    // Admin must name the acceptance owner — no requester / unknown requester → 400.
    expect((await post("/api/tickets", ADMIN, { title: "t", body: "b" })).status).toBe(400);
    expect((await post("/api/tickets", ADMIN, { title: "t", body: "b", requester: "ghost" })).status).toBe(400);

    // alice's ticket goes FIRST: later tests grab tickets by list position,
    // and the proxied ticket below must not displace their fixture.
    const ok = await post("/api/tickets", dtAlice, {
      body: "面板要能搜",
      model: "codex-gpt-5.6-sol",
      effort: "xhigh",
    });
    expect(ok.status).toBe(200);
    const t = ((await ok.json()) as { ticket: { id: number; title: string } }).ticket;
    expect(t.title).toMatch(/^新工单 · \d{2}-\d{2} \d{2}:\d{2}$/);
    // Conversation model: the creation message triggers the first turn, whose
    // reply lands in the thread (and its ## 名字 becomes the sidebar slug).
    await until(() => store.devTickets.listTicketMessages(t.id).some((m) => m.author === "agent"));
    expect(store.devTickets.getDevTicket(t.id)!.dev_status).toBe("open");
    expect(store.devTickets.getDevTicket(t.id)!.slug).toBe("加个搜索");

    const detail = (await (await fetch(`${base}/api/tickets/${t.id}`, { headers: as(dtBob) })).json()) as {
      messages: Array<{ author: string; body: string }>;
    };
    // Shared visibility: bob sees alice's ticket, agent reply included.
    expect(detail.messages.some((m) => m.author === "agent" && m.body.includes("方案"))).toBe(true);
  }, PIPELINE_WAIT_MS + 30_000);

  it("transcript + live come from the dev scan home", async () => {
    const t = store.devTickets.listDevTickets().at(-1)!;
    const sess = (await (await fetch(`${base}/api/tickets/${t.id}/session`, { headers: as(dtBob) })).json()) as {
      messages: unknown[];
      meta: { id: string };
    };
    expect(sess.meta.id).toBe(CODEX_SESS);
    expect(sess.messages.length).toBeGreaterThan(0);

    const ac = new AbortController();
    const live = await fetch(`${base}/api/tickets/${t.id}/live?from=0&frontier=0`, {
      headers: as(dtBob),
      signal: ac.signal,
    });
    expect(live.headers.get("content-type")).toContain("text/event-stream");
    const reader = live.body!.getReader();
    let buf = "";
    while (!buf.includes("event: delta")) buf += new TextDecoder().decode((await reader.read()).value);
    ac.abort();
  }, 15_000);

  it("projects only the compact Codex account label, never the private slot", async () => {
    const ticket = store.devTickets.listDevTickets().at(-1)!;
    const originalSlot = ticket.codex_account_slot;
    store.devTickets.updateDevTicket(ticket.id, { codex_account_slot: "account_a" });
    try {
      const detail = await (await fetch(`${base}/api/tickets/${ticket.id}`, { headers: as(dtAlice) })).json() as {
        ticket: Record<string, unknown>;
      };
      const list = await (await fetch(`${base}/api/tickets`, { headers: as(dtAlice) })).json() as {
        tickets: Array<Record<string, unknown>>;
      };
      expect(detail.ticket).not.toHaveProperty("codex_account_slot");
      expect(list.tickets.find((row) => row.id === ticket.id)).not.toHaveProperty("codex_account_slot");
      expect(detail.ticket.codex_account_label).toBe("a");
      expect(list.tickets.find((row) => row.id === ticket.id)?.codex_account_label).toBe("a");
    } finally {
      store.devTickets.updateDevTicket(ticket.id, { codex_account_slot: originalSlot });
    }
  });

  it("anyone may message (labeled), only requester/admin may steer the lifecycle", async () => {
    const t = store.devTickets.listDevTickets().at(-1)!;
    // A long message is kept whole (it used to be silently cut at 4,000).
    const long = `也考虑下大小写${"。".repeat(4_100)}`;
    const msg = await post(`/api/tickets/${t.id}/message`, dtBob, { body: long });
    expect(msg.status).toBe(200);
    expect(store.devTickets.listTicketMessages(t.id).some((m) => m.body === long)).toBe(true);
    // Only the shared session prompt budget refuses, explicitly.
    expect((await post(`/api/tickets/${t.id}/message`, dtBob, { body: "x".repeat(400 * 1024) })).status).toBe(413);

    // approve-spec survives as a compat shim (ops/ticket.sh) that posts a
    // conversation message — still requester/admin-gated.
    const denied = await post(`/api/tickets/${t.id}/approve-spec`, dtBob);
    expect(denied.status).toBe(403);

    // Let bob's message drain first so the approval turn is the one that builds.
    await until(() => store.devTickets.listTicketMessages(t.id, { undeliveredOnly: true }).length === 0
      && store.devTickets.getDevTicket(t.id)!.turn_started_at == null);
    const ok = await post(`/api/tickets/${t.id}/approve-spec`, dtAlice);
    expect(ok.status).toBe(200);
    // The scripted agent reads "开始实现", claims, commits, submits → landed.
    await until(() => store.devTickets.getDevTicket(t.id)?.dev_status === "landed");

    // Manual deploy markers: invalid jump 400, then the allowed chain.
    const bad = await post(`/api/tickets/${t.id}/deploy-mark`, dtAlice, { next: "verified" });
    expect(bad.status).toBe(400);
    expect((await post(`/api/tickets/${t.id}/deploy-mark`, dtAlice, { next: "live_unverified" })).status).toBe(200);
    expect((await post(`/api/tickets/${t.id}/deploy-mark`, dtAlice, { next: "verified" })).status).toBe(200);
    expect(store.devTickets.getDevTicket(t.id)!.deploy_status).toBe("verified");

    // The ticket #12 hang, end to end: a message to the LANDED ticket still
    // gets a turn — the agent replies instead of the message rotting as 待送达.
    const before = store.devTickets.listTicketMessages(t.id).length;
    expect((await post(`/api/tickets/${t.id}/message`, dtAlice, { body: "上线后有个 follow-up" })).status).toBe(200);
    await until(() => store.devTickets.listTicketMessages(t.id).length > before + 1
      && store.devTickets.listTicketMessages(t.id).at(-1)!.author === "agent");
  }, PIPELINE_WAIT_MS + 30_000);

  it("deploy endpoints: banner poll, whitelist trigger, confirm window, verify scoping", async () => {
    // Second server sharing the store/repo, with a deploy service (deployers: alice only).
    const repoDir = join(dir, "repo");
    await gitOrThrow(repoDir, ["branch", "stable"]).catch(() => {});
    // Snapshot the stable sha BEFORE the deploy: product acceptance no longer
    // touches the watermark (c7975d4 — CI owns it), so the assertion at the
    // bottom of this test needs a reference that survives resolveVerify.
    const stableAtStart = await gitOrThrow(repoDir, ["rev-parse", "stable"]);
    const svc = new DeployService({ store, repoDir, baseBranch: "main", deployers: ["alice"] });
    const dash2 = createDashboardTestServer(store, undefined, {
      port: 0,
      host: "127.0.0.1",
      authToken: ADMIN,
      devPipeline: {
        appReleaseDrainState: () => ({ active: true, mode: "automatic" as const }),
      } as never,
      deployService: svc,
    });
    await dash2.start();
    const b2 = `http://127.0.0.1:${dash2.port}`;
    try {
      const active = await (await fetch(`${b2}/api/deploy/active`, { headers: as(dtBob) })).json();
      expect(active).toMatchObject({ confirm_wait: false, intent_id: null });

      store.appCatalog.recordPendingAppRelease({
        app_id: "session-plus",
        commit_sha: "HEAD",
        ticket_id: null,
        requested_by: "test",
        requested_at: NOW,
        reason: "dashboard visibility",
      });
      const stateWithAppDebt = (await (await fetch(`${b2}/api/deploy`, { headers: as(dtAlice) })).json()) as {
        app_releases_pending: Array<{ app_id: string; title: string; commit_sha: string }>;
        app_release_drain: { active: boolean; mode: string | null };
      };
      expect(stateWithAppDebt.app_releases_pending).toEqual([
        expect.objectContaining({ app_id: "session-plus", title: "会话+（Session Plus）", commit_sha: "HEAD" }),
      ]);
      expect(stateWithAppDebt.app_release_drain).toEqual({ active: true, mode: "automatic" });
      const refusedGlobalBuild = await fetch(`${b2}/api/deploy`, {
        method: "POST",
        headers: { authorization: `Bearer ${dtAlice}`, "content-type": "application/json" },
        body: "{}",
      });
      expect(refusedGlobalBuild.status).toBe(409);
      expect(await refusedGlobalBuild.json()).toMatchObject({ code: "app_only_pending" });
      store.appCatalog.clearPendingAppRelease("session-plus");

      const runnerTicket = store.devTickets.listDevTickets()[0]!;
      store.runnerArtifacts.recordPending({
        ticket_id: runnerTicket.id,
        commit_sha: await gitOrThrow(repoDir, ["rev-parse", "HEAD"]),
        requested_by: "test",
        requested_at: NOW,
      });
      const stateWithRunnerDebt = (await (await fetch(`${b2}/api/deploy`, { headers: as(dtAlice) })).json()) as {
        runner_bundle: { active_sha: string | null; healthy: boolean; pending: Array<{ ticket_id: number; commit_sha: string }> };
      };
      expect(stateWithRunnerDebt.runner_bundle).toMatchObject({
        active_sha: null,
        healthy: false,
        pending: [expect.objectContaining({ ticket_id: runnerTicket.id })],
      });
      store.runnerArtifacts.clearIf(runnerTicket.id, stateWithRunnerDebt.runner_bundle.pending[0]!.commit_sha);

      // An older successful deploy is still waiting for product acceptance.
      // The next success must surface both as one block, while retaining two
      // audit rows underneath.
      const priorIntent = store.devTickets.createDeployIntent({ target_sha: "HEAD", triggered_by: "alice" });
      store.devTickets.updateDeployIntent(priorIntent.id, { status: "succeeded", notified: 1 });
      store.devTickets.createVerifyTicket({
        intent_id: priorIntent.id,
        target_sha: "HEAD",
        ticket_ids: [],
        modules_touched: ["packages/prior"],
        checklist: [],
        assignees: ["alice"],
      });

      const denied = await fetch(`${b2}/api/deploy`, {
        method: "POST",
        headers: { authorization: `Bearer ${dtBob}`, "content-type": "application/json" },
        body: "{}",
      });
      expect(denied.status).toBe(403); // bob not in deployers

      const ok = await fetch(`${b2}/api/deploy`, {
        method: "POST",
        headers: { authorization: `Bearer ${dtAlice}`, "content-type": "application/json" },
        body: "{}",
      });
      expect(ok.status).toBe(200);
      const intent = ((await ok.json()) as { intent: { id: number } }).intent;
      expect(JSON.parse(store.devTickets.getDeployIntent(intent.id)!.trigger_source!)).toEqual({ kind: "cli_api" });
      const origin = await (await fetch(`${b2}/api/deploy/active`, { headers: as(dtAlice) })).json();
      expect(origin).toMatchObject({ origin: { intent_id: intent.id, actor: "alice", kind: "cli_api" } });

      // Not in confirm_wait yet → 409; supervisor moves it → any user may confirm.
      const early = await fetch(`${b2}/api/deploy/confirm`, {
        method: "POST",
        headers: { authorization: `Bearer ${dtBob}`, "content-type": "application/json" },
        body: JSON.stringify({ intent_id: intent.id, decision: "alive" }),
      });
      expect(early.status).toBe(409);
      store.devTickets.updateDeployIntent(intent.id, { status: "confirm_wait" });

      // "rollback" is a production change — it checks out the previous sha and
      // restarts — so it takes the `deploy` capability, exactly like triggering
      // the release did. The outer route gate only asks for `dev`, which is the
      // shared read grant on the ticket workspace: without this, anyone who
      // could watch the pipeline could revert it.
      const rollbackDenied = await fetch(`${b2}/api/deploy/confirm`, {
        method: "POST",
        headers: { authorization: `Bearer ${dtBob}`, "content-type": "application/json" },
        body: JSON.stringify({ intent_id: intent.id, decision: "rollback" }),
      });
      expect(rollbackDenied.status).toBe(403);

      // "alive" stays wide on purpose: its meaning is "a human reached the
      // public entrance after the restart", and more witnesses is better.
      const confirmed = await fetch(`${b2}/api/deploy/confirm`, {
        method: "POST",
        headers: { authorization: `Bearer ${dtBob}`, "content-type": "application/json" },
        body: JSON.stringify({ intent_id: intent.id, decision: "alive" }),
      });
      expect(confirmed.status).toBe(200);

      // Success → verify ticket; only assignees/admin may resolve.
      store.devTickets.updateDeployIntent(intent.id, { status: "succeeded", base_sha: "HEAD" });
      await svc.pollOnce();
      const dep = (await (await fetch(`${b2}/api/deploy`, { headers: as(dtAlice) })).json()) as {
        verify_open: { id: number; assignees: string; deployment_count: number; modules_touched: string } | null;
      };
      expect(dep.verify_open).toBeTruthy();
      expect(dep.verify_open).toMatchObject({ deployment_count: 2 });
      expect(JSON.parse(dep.verify_open!.modules_touched)).toContain("packages/prior");
      const vid = dep.verify_open!.id;
      const notAssignee = await fetch(`${b2}/api/verify/${vid}`, {
        method: "POST",
        headers: { authorization: `Bearer ${dtBob}`, "content-type": "application/json" },
        body: JSON.stringify({ result: "passed" }),
      });
      expect(notAssignee.status).toBe(403);
      const resolved = await fetch(`${b2}/api/verify/${vid}`, {
        method: "POST",
        headers: { authorization: `Bearer ${dtAlice}`, "content-type": "application/json" },
        body: JSON.stringify({ result: "passed" }),
      });
      expect(resolved.status).toBe(200);
      // Product acceptance verifies the ticket's deployment axis; it does NOT
      // move the stable watermark. That watermark now means "the last SHA whose
      // full GitLab CI suite passed" — only a green post-submit batch advances
      // it (c7975d4: Move post-submit suites to batched GitLab CI). So `stable`
      // stays exactly where it was before the deploy triggered.
      expect(await gitOrThrow(repoDir, ["rev-parse", "stable"])).toBe(stableAtStart);
    } finally {
      svc.stop();
      await dash2.stop();
    }
  }, 20_000);

  it("list payload carries counts, kinds and viewer identity", async () => {
    const data = (await (await fetch(`${base}/api/tickets`, { headers: as(dtAlice) })).json()) as {
      viewer: { role: string; username?: string };
      spec_concurrency: number;
      counts: { open: number; running: number; queued_input: number; landed_pending: number };
      models: string[];
      model_catalog: Array<{ id: string; label: string; family: string }>;
      model_default: string;
      effort_default: string;
      kinds: string[];
      apps: Array<{ id: string; title: string; refreshable: boolean; served: boolean }>;
    };
    expect(data.viewer).toEqual({ username: "alice", admin: false, dev: true, deploy: false, contribute: true });
    expect(data.spec_concurrency).toBeGreaterThan(0);
    expect(data.models).toEqual([
      "claude-opus-5-5",
      "claude-opus-4-7",
      "claude-opus-5",
      "claude-fable-5-1",
      "codex-gpt-6-astra",
      "codex-gpt-5.6-sol",
      "codex-gpt-5.6-terra",
      "codex-gpt-5.6-luna",
      "codex-gpt-5.5",
      "codex-runner-gpt-6-astra",
      "codex-runner-gpt-5.6-sol",
      "omp-gpt-5.6-sol",
      "omp-opus",
    ]);
    expect(data).toMatchObject({ model_default: "codex-gpt-6-astra", effort_default: "xhigh" });
    // Labels and routing families come from the server; the browser keeps none.
    for (const model of data.models) expect(data.model_catalog.map((row) => row.id)).toContain(model);
    expect(data.model_catalog).toContainEqual({ id: "omp-opus", label: "omp · Opus", family: "omp" });
    expect(data.model_catalog).toContainEqual({ id: "codex-native", label: "Codex · 原生 CLI", family: "codex" });
    expect(data.kinds).toEqual(["simple", "complex", "app", "discuss"]);
    // The App picker rides on the ROSTER rather than on `/api/apps`: that route
    // is admin-only because it manages releases, while filing a ticket only
    // needs `dev` — alice here is exactly the person who would have got a 403.
    expect(data.apps.map((a) => a.id)).toContain("session-plus");
    expect(data.apps.find((a) => a.id === "session-plus")).toMatchObject({ refreshable: true });
    // …and this composition hosts no App catalog, so it says so instead of
    // letting somebody discover it from a pipeline note after landing.
    expect(data.apps.every((a) => a.served === false)).toBe(true);
    expect(data).not.toHaveProperty("wip_limit"); // the WIP gate is gone
  });

  it("projects owner-scoped Runner choices and forwards both independent selections", async () => {
    const choice = { sources: [{ id: "aws-b", device: "aws-local", source: "codex" as const, split_execution: true, label: "AWS · codexb", available: true }],
      workspaces: [{ id: "workspace-4090", device: "gpu-box", codex_remote: true, label: "Project", available: true }], source_default: "aws-b", workspace_default: "workspace-4090" };
    const choices = vi.spyOn(pipe, "ticketExecutionChoices").mockImplementation((owner) => owner === "alice" ? choice : undefined);
    const runner = vi.spyOn(pipe, "usesRunnerTickets").mockReturnValue(true);
    const create = vi.spyOn(pipe, "createTicket").mockImplementation((input) => store.devTickets.createDevTicket(normalizeDevTicketInput(input)));
    try {
      const data = await (await fetch(`${base}/api/tickets`, { headers: as(dtAlice) })).json() as { execution_choices: unknown; models: string[] };
      expect(data.execution_choices).toEqual({ alice: choice });
      expect(data.models).not.toContain("codex-runner-gpt-6-astra");
      expect(data.models).toContain("codex-gpt-5.6-terra");
      const bob = await (await fetch(`${base}/api/tickets`, { headers: as(dtBob) })).json() as { execution_choices: unknown };
      expect(bob.execution_choices).toEqual({});
      const response = await fetch(`${base}/api/tickets`, { method: "POST", headers: { ...as(dtAlice), "Content-Type": "application/json" },
        body: JSON.stringify({ body: "Choose execution", model: "codex-gpt-6-astra", effort: "max", agent_source: "aws-b", workspace: "workspace-4090" }) });
      expect(response.status).toBe(200);
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ requester: "alice", agent_source: "aws-b", workspace: "workspace-4090", effort: "max" }));
      const invalid = await fetch(`${base}/api/tickets`, { method: "POST", headers: { ...as(dtAlice), "Content-Type": "application/json" },
        body: JSON.stringify({ body: "Invalid", agent_source: { device: "forged" } }) });
      expect(invalid.status).toBe(400);
      expect(create).toHaveBeenCalledTimes(1);
    } finally { choices.mockRestore(); runner.mockRestore(); create.mockRestore(); }
  });

  it("shows only the current viewer's credit balance and bounded ledger", async () => {
    store.credits.record({
      username: "alice",
      delta: 321,
      reason: "admin_adjust",
      refKind: "test_seed",
      refId: "dashboard-alice-credit",
      createdAt: NOW,
    });
    const alice = (await (await fetch(`${base}/api/tickets`, { headers: as(dtAlice) })).json()) as {
      credit_account: { balance: number; entries: Array<Record<string, unknown>> };
    };
    expect(alice.credit_account.balance).toBe(321);
    expect(alice.credit_account.entries[0]).toMatchObject({
      delta: 321,
      reason: "admin_adjust",
      ref_kind: "test_seed",
    });
    expect(alice.credit_account.entries[0]).not.toHaveProperty("ref_id");

    const bob = (await (await fetch(`${base}/api/tickets`, { headers: as(dtBob) })).json()) as {
      credit_account: { balance: number; entries: Array<Record<string, unknown>> };
    };
    expect(bob.credit_account).toEqual({ balance: 0, entries: [] });
  });

  it("uses first-party Codex xhigh for omitted choices", async () => {
    const res = await post("/api/tickets", dtAlice, { body: "默认 agent 入口" });
    expect(res.status).toBe(200);
    const ticket = ((await res.json()) as { ticket: { model: string; effort: string } }).ticket;
    expect(ticket).toMatchObject({ model: "codex-gpt-6-astra", effort: "xhigh" });
  });

  it("parks Alice's Fable ticket for lht and puts the original input on the approval card", async () => {
    const original = "请用 Fable 评审这个交互\n\n原始输入第二段";
    const before = store.devTickets.listDevTickets().length;
    const res = await post("/api/tickets", dtAlice, {
      body: original,
      model: "claude-fable-5-1",
      effort: "xhigh",
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ approval_required: true });
    expect(store.devTickets.listDevTickets()).toHaveLength(before);

    const pending = (await (await fetch(`${base}/api/capabilities/pending`, { headers: as(dtLht) })).json()) as {
      pending: Array<{ title: string; details: string[] }>;
    };
    const card = pending.pending.find((item) => item.title === "Fable 工单申请 · alice");
    expect(card?.details.join("\n")).toContain("发起用户：alice");
    expect(card?.details.join("\n")).toContain(original);
  });

  it("kind: filed simple by API, switchable while open (prompt discipline only)", async () => {
    const ok = await post("/api/tickets", dtAlice, { title: "简单票", body: "直接干", kind: "simple" });
    const t = ((await ok.json()) as { ticket: { id: number; kind: string } }).ticket;
    expect(t.kind).toBe("simple");

    // Bob is not the requester → may not change the kind.
    expect((await post(`/api/tickets/${t.id}/kind`, dtBob, { kind: "complex" })).status).toBe(403);
    // Kind is prompt discipline now — switchable any time while the ticket lives.
    expect((await post(`/api/tickets/${t.id}/kind`, dtAlice, { kind: "complex" })).status).toBe(200);
  }, 15_000);

  it("filing ignores App/full selectors and leaves delivery classification to submit", async () => {
    const ok = await post("/api/tickets", dtAlice, {
      title: "改会话+布局", body: "b", kind: "app", app_id: "session-plus",
    });
    const t = ((await ok.json()) as { ticket: { id: number; kind: string; app_id: string | null } }).ticket;
    expect(t).toMatchObject({ kind: "simple", app_id: null });

    // Even an unknown selector is inert: humans describe the requirement and
    // the agent declares the delivery path only once the final diff exists.
    const unknown = await post("/api/tickets", dtAlice, {
      title: "x", body: "b", kind: "app", app_id: "not-an-app",
    });
    expect(unknown.status).toBe(200);
    expect(((await unknown.json()) as { ticket: { kind: string; app_id: string | null } }).ticket)
      .toMatchObject({ kind: "simple", app_id: null });

    // The old mutation route cannot put that decision back on the requester.
    const plain = ((await (await post("/api/tickets", dtAlice, { title: "y", body: "b", kind: "simple" })).json()) as {
      ticket: { id: number };
    }).ticket;
    const promoted = await post(`/api/tickets/${plain.id}/kind`, dtAlice, { kind: "app", app_id: "session-plus" });
    expect(promoted.status).toBe(400);
    expect(((await promoted.json()) as { error: string }).error).toContain("最终 diff");

    // A long request is filed whole; it used to be silently cut at 8,000.
    const longBody = `需求：${"细节".repeat(4_500)}`;
    const filed = ((await (await post("/api/tickets", dtAlice, { title: "long", body: longBody })).json()) as {
      ticket: { id: number };
    }).ticket;
    expect(store.devTickets.getDevTicket(filed.id)!.body).toBe(longBody);

    // Past the old 100,000-character schema cap, up to the byte budget.
    const bigBody = `需求：${"y".repeat(300 * 1024)}`;
    const big = await post("/api/tickets", dtAlice, { body: bigBody });
    expect(big.status).toBe(200);
    expect(store.devTickets.getDevTicket(((await big.json()) as { ticket: { id: number } }).ticket.id)!.body).toBe(bigBody);
    const over = await post("/api/tickets", dtAlice, { body: "z".repeat(384 * 1024 + 1) });
    expect(over.status).toBe(413);
    expect(((await over.json()) as { error: string }).error)
      .toBe("工单正文为 393217 字节（UTF-8），超过会话 prompt 预算 393216 字节（384 KiB）；请拆成多条或改为附件");
  }, 20_000);

  it("session endpoint says 'running' instead of 'not started' while the first turn runs", async () => {
    const t = store.devTickets.createDevTicket(normalizeDevTicketInput({ title: "starting", body: "b", requester: "alice" }));
    // Park the fixture from the pump: consume the creation message so no turn
    // fires (store-level ops don't kick, and the two calls share one JS tick).
    store.devTickets.takeTicketInbox(t.id, 999);
    store.devTickets.updateDevTicket(t.id, {
      session_id: "00000000-0000-4000-8000-000000000000", // minted, not written yet
      turn_started_at: new Date().toISOString(),
    });
    const r = (await (await fetch(`${base}/api/tickets/${t.id}/session`, { headers: as(dtAlice) })).json()) as {
      pending: boolean;
      running: boolean;
      turn_started_at: string;
    };
    expect(r).toMatchObject({ pending: true, running: true });
    expect(r.turn_started_at).toBeTruthy();

    // A stale missing-file error must not remain pending for the whole turn.
    store.devTickets.updateDevTicket(t.id, { turn_started_at: new Date(Date.now() - 60_000).toISOString() });
    const expired = await fetch(base + "/api/tickets/" + t.id + "/session", { headers: as(dtAlice) });
    expect(expired.status).toBe(502);
    expect(await expired.json()).toMatchObject({ error: "session not found for id: 00000000-0000-4000-8000-000000000000" });

    // Marker cleared → no more "running" cover for a session that isn't there;
    // the read failure is reported honestly instead.
    store.devTickets.updateDevTicket(t.id, { turn_started_at: null });
    const res = await fetch(`${base}/api/tickets/${t.id}/session`, { headers: as(dtAlice) });
    const after = (await res.json()) as { running?: boolean; error?: string };
    expect(after.running).not.toBe(true);
    expect(res.status).toBe(502);
    expect(after.error).toBeTruthy();
  });

  it("distinguishes a remote session's brief startup from permission, configuration and persistent read failures", async () => {
    const t = store.devTickets.createDevTicket(normalizeDevTicketInput({
      title: "remote transcript failures", body: "b", requester: "alice", model: "codex-runner-gpt-5.6-sol",
    }));
    store.devTickets.takeTicketInbox(t.id, 1_001);
    store.devTickets.updateDevTicket(t.id, { session_id: REMOTE_CODEX_SESS, codex_account_slot: "runner:macbookpro" });
    const close = vi.fn();
    const read = vi.fn<(input: { maxMessages: number; offset?: number }) => Promise<unknown>>();
    const open = vi.spyOn(pipe, "openRemoteTicketTranscript").mockReturnValue({ device: "macbookpro", read, close });
    const missing = "session not found for id: " + REMOTE_CODEX_SESS;
    const cases = [
      { message: missing, age: 1_000, status: 200 },
      { message: missing, age: 60_000, status: 502 },
      { message: "工单 Runner 尚未获得主人授权，或授权已经撤销", age: 1_000, status: 502 },
      { message: "Sessions+ split transcript root is unavailable on this Runner", age: 1_000, status: 502 },
      { message: "EACCES: permission denied, open transcript", age: 1_000, status: 502 },
      { message: "session not found for id: unrelated-session", age: 1_000, status: 502 },
    ];
    try {
      for (const row of cases) {
        store.devTickets.updateDevTicket(t.id, { turn_started_at: new Date(Date.now() - row.age).toISOString() });
        read.mockRejectedValueOnce(new Error(row.message));
        const res = await fetch(base + "/api/tickets/" + t.id + "/session?limit=20&offset=0", { headers: as(dtAlice) });
        expect(res.status).toBe(row.status);
        expect(await res.json()).toMatchObject(row.status === 200 ? { pending: true, running: true } : { error: row.message });
      }
      expect(read).toHaveBeenCalledWith({ maxMessages: 20, offset: 0 });
      expect(close).toHaveBeenCalledTimes(cases.length);
    } finally {
      open.mockRestore();
      store.devTickets.updateDevTicket(t.id, { turn_started_at: null });
    }
  });

  it("shows authoritative operation progress independently of a missing transcript, and exposes status-query errors", async () => {
    const t = store.devTickets.createDevTicket(normalizeDevTicketInput({
      title: "file-independent execution", body: "b", requester: "alice", model: "codex-runner-gpt-5.6-sol",
    }));
    store.devTickets.takeTicketInbox(t.id, 1_001);
    store.devTickets.updateDevTicket(t.id, { session_id: REMOTE_CODEX_SESS, codex_account_slot: "runner:macbookpro",
      turn_started_at: new Date(Date.now() - 120_000).toISOString() });
    const missing = "session not found for id: " + REMOTE_CODEX_SESS;
    const read = vi.fn(async () => { throw new Error(missing); });
    const close = vi.fn();
    const open = vi.spyOn(pipe, "openRemoteTicketTranscript").mockReturnValue({ device: "macbookpro", read, close });
    const execution = { operation_id: "ticket-operation", state: "running" as const,
      session_id: REMOTE_CODEX_SESS, observed_at: new Date().toISOString(),
      input: { phase: "provider_accepted" as const, evidence: "provider_ack" as const, at: new Date().toISOString() } };
    const status = vi.spyOn(pipe, "readTicketExecution").mockResolvedValue(execution);
    const get = () => fetch(base + "/api/tickets/" + t.id + "/session", { headers: as(dtAlice) });
    try {
      for (const state of ["running", "succeeded", "failed", "unknown"] as const) {
        status.mockResolvedValueOnce({ ...execution, state });
        const res = await get();
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ pending: true, running: state === "running",
          execution: { ...execution, state }, transcript_notice: missing });
      }
      status.mockResolvedValueOnce({ ...execution, state: "missing" });
      const absent = await get();
      expect(absent.status).toBe(502);
      expect(await absent.json()).toMatchObject({ error: missing, execution: { state: "missing" }, running: false });

      status.mockRejectedValueOnce(new Error("operation query denied"));
      const denied = await get();
      expect(denied.status).toBe(502);
      expect(await denied.json()).toMatchObject({ execution_error: "operation query denied", running: false });
      read.mockRejectedValueOnce(new Error("split root misconfigured"));
      const broken = await get();
      expect(broken.status).toBe(502);
      expect(await broken.json()).toMatchObject({ error: "split root misconfigured", execution });

      // Provider acceptance precedes the pipeline persisting the native identity.
      store.devTickets.updateDevTicket(t.id, { session_id: null });
      const before = read.mock.calls.length;
      const accepted = await get();
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toMatchObject({ execution, running: true });
      expect(read).toHaveBeenCalledTimes(before);
    } finally {
      open.mockRestore();
      status.mockRestore();
      store.devTickets.updateDevTicket(t.id, { turn_started_at: null });
    }
  });

  /**
   * The human lane's door (ticket #5). The endpoint is thin on purpose — the
   * gate+ff invariants live in DevPipeline.land and are tested there; what
   * matters here is who may knock and how refusals come back.
   */
  it("POST /api/land: deployers whitelist, request validation, real gated fast-forward", async () => {
    // Own repo + pipeline: the shared fixture's ticket lane keeps moving `main`
    // between tests, which would race this test's ancestry check.
    const repoDir = join(dir, "landrepo");
    await gitOrThrow(dir, ["init", "-b", "main", repoDir]);
    writeFileSync(join(repoDir, "README.md"), "base\n");
    await gitOrThrow(repoDir, ["add", "README.md"]);
    await gitOrThrow(repoDir, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"]);
    await gitOrThrow(repoDir, ["checkout", "-b", "live"]); // free `main` for the _base worktree
    await gitOrThrow(repoDir, ["branch", "stable"]);
    const landPipe = new DevPipeline({
      // No remote in a temp repo, and a test must never push anywhere.
      pushRemote: null,
      knowledgeCaptureEnabled: false,
      // This fixture validates the HTTP landing door and its named-test
      // plumbing. It is not a pnpm workspace for the thin gate to typecheck.
      landGateEnabled: false,
      // Nor for the post-landing warm build (build-warm.test.ts covers it).
      buildWarmEnabled: false,
      store,
      repoDir,
      worktreesDir: join(dir, "landwts"),
      baseBranch: "main",
      runTurn: async () => ({ ok: true, exit_code: 0, timed_out: false, duration_ms: 1, result_text: "" }),
      gate: async () => ({ ok: true, log: "pass" }),
    });
    const svc = new DeployService({ store, repoDir, baseBranch: "main", deployers: ["alice"] });
    const dash3 = createDashboardTestServer(store, undefined, {
      port: 0,
      host: "127.0.0.1",
      authToken: ADMIN,
      devPipeline: landPipe,
      deployService: svc,
    });
    await dash3.start();
    const b3 = `http://127.0.0.1:${dash3.port}`;
    const land = (token: string, body: unknown) =>
      fetch(`${b3}/api/land`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const codeOf = async (r: Response) => ((await r.json()) as { code?: string }).code;
    try {
      expect((await land(dtBob, { branch: "dev/alice" })).status).toBe(403); // bob not in deployers
      expect((await land(dtAlice, {})).status).toBe(400); // branch required
      expect((await land(ADMIN, { branch: "stable" })).status).toBe(400); // rollback anchor
      const ghost = await land(ADMIN, { branch: "dev/ghost" });
      expect(ghost.status).toBe(400);
      expect(await codeOf(ghost)).toBe("unknown_branch");

      // A real buffer branch: scripted gate passes, the base really moves.
      const wt = join(dir, "buf");
      await gitOrThrow(repoDir, ["worktree", "add", "-b", "dev/alice", wt, "main"]);
      writeFileSync(join(wt, "human.txt"), "buffer\n");
      await gitOrThrow(wt, ["add", "human.txt"]);
      await gitOrThrow(wt, ["-c", "user.email=h@h", "-c", "user.name=h", "commit", "-m", "human work"]);
      await commitHttpCliReport(wt);
      const sha = await gitOrThrow(wt, ["rev-parse", "HEAD"]);
      await gitOrThrow(repoDir, ["worktree", "remove", "--force", wt]);

      // No `tests` in the body → nothing runs (2026-08-09 post-submit switch),
      // and the record says which of the two it was rather than leaving an
      // empty log that reads like a gate with no output.
      const ok = await land(dtAlice, { branch: "dev/alice" });
      expect(ok.status).toBe(200);
      const okBody = (await ok.json()) as { gate_log_tail?: string; ticket_id?: number; report_path?: string };
      expect(okBody).toMatchObject({ ok: true, branch: "dev/alice", to_sha: sha });
      expect(okBody.gate_log_tail).toContain("没有点名");
      expect(okBody.ticket_id).toBeGreaterThan(0);
      expect(store.devTickets.getDevTicket(okBody.ticket_id!)).toMatchObject({ kind: "cli", deploy_status: "pending" });
      expect(await gitOrThrow(repoDir, ["rev-parse", "main"])).toBe(sha);

      // Landed already → nothing to do, and the base is not touched again.
      const again = await land(dtAlice, { branch: "dev/alice" });
      expect(again.status).toBe(400);
      expect(await codeOf(again)).toBe("no_commits");

      // …and when the body DOES name tests, the route carries them through to
      // the pipeline, which runs them before the ff. A route that accepted the
      // field and dropped it would be the worst outcome available: an author
      // told their tests ran when nothing did.
      await gitOrThrow(repoDir, ["checkout", "dev/alice"]);
      writeFileSync(join(repoDir, "second.txt"), "more\n");
      await gitOrThrow(repoDir, ["add", "second.txt"]);
      await gitOrThrow(repoDir, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "second"]);
      await commitHttpCliReport(repoDir);
      const sha2 = await gitOrThrow(repoDir, ["rev-parse", "dev/alice"]);
      await gitOrThrow(repoDir, ["checkout", "live"]);
      const named = await land(dtAlice, { branch: "dev/alice", tests: ["packages/bot/src/devpipe"] });
      expect(named.status).toBe(200);
      expect(await named.json()).toMatchObject({ ok: true, gate_log_tail: "pass" });
      expect(await gitOrThrow(repoDir, ["rev-parse", "main"])).toBe(sha2);
    } finally {
      svc.stop();
      await dash3.stop();
      await landPipe.stop();
    }
  }, 90_000);

  it("button shims sign as whoever pressed them, not as the requester", async () => {
    const made = await post("/api/tickets", dtAlice, { title: "署名票", body: "b", kind: "complex" });
    const id = ((await made.json()) as { ticket: { id: number } }).ticket.id;
    // The shared admin key has no account: it falls back to the requester,
    // which is the only name available and stays honest about that.
    expect((await post(`/api/tickets/${id}/approve-spec`, ADMIN)).status).toBe(200);
    const msgs = store.devTickets.listTicketMessages(id).filter((m) => m.body.includes("(按钮)"));
    expect(msgs.at(-1)!.author).toBe("alice");

    // An admin ACCOUNT signs with its own name — this is the case that used
    // to put words in the requester's mouth.
    store.grantCapability("carol", "dev", "test", NOW);
    const asCarol = await fetch(`${base}/api/tickets/${id}/message`, {
      method: "POST",
      headers: { authorization: `Bearer ${dtCarol}`, "content-type": "application/json" },
      body: JSON.stringify({ body: "我也说一句" }),
    });
    expect(asCarol.status).toBe(200);
    expect(store.devTickets.listTicketMessages(id).at(-1)!.author).toBe("carol");
    store.revokeCapability("carol", "dev");
    await post(`/api/tickets/${id}/cancel`, dtAlice);
  });

  it("keeps CLI delivery reports read-only while preserving deploy markers", async () => {
    const report = store.devTickets.createCliDeliveryTicket(normalizeCliDeliveryTicketInput({
      title: "CLI report",
      body: "result",
      spec: "## 验收标准\n- works",
      requester: "alice",
      branch: "dev/cli",
      commit_sha: "c".repeat(40),
    }));
    expect((await post(`/api/tickets/${report.id}/message`, dtAlice, { body: "continue" })).status).toBe(400);
    expect(store.devTickets.listTicketsNeedingTurn()).not.toContainEqual(expect.objectContaining({ id: report.id }));
    expect((await post(`/api/tickets/${report.id}/deploy-mark`, dtAlice, { next: "live_unverified" })).status).toBe(200);
    expect(store.devTickets.getDevTicket(report.id)?.deploy_status).toBe("live_unverified");
  });

  it("hides the whole dev system from an account without the dev grant", async () => {
    // carol is a perfectly valid logged-in user — she just was not let in.
    for (const path of ["/api/tickets", "/api/dev/quota", "/api/dev/system-status", "/api/deploy/active"]) {
      expect((await fetch(`${base}${path}`, { headers: as(dtCarol) })).status).toBe(403);
    }
    expect((await post("/api/tickets", dtCarol, { title: "x", body: "y" })).status).toBe(403);
    expect((await fetch(`${base}/tickets`, { headers: as(dtCarol) })).status).toBe(403);
    // ...and the nav on a page she CAN reach never mentions it.
    const home = await (await fetch(`${base}/`, { headers: as(dtCarol) })).text();
    expect(readBootstrapPayload(home).nav.map((t) => t.path)).not.toContain("/tickets");
    expect(home).not.toContain('href="/admin"');
  });

  it("grants take effect on the next request, and revoking closes the door again", async () => {
    store.grantCapability("carol", "dev", "test", NOW);
    expect((await fetch(`${base}/api/tickets`, { headers: as(dtCarol) })).status).toBe(200);
    const home = await (await fetch(`${base}/`, { headers: as(dtCarol) })).text();
    expect(readBootstrapPayload(home).nav.map((t) => t.path)).toContain("/tickets");
    store.revokeCapability("carol", "dev");
    expect((await fetch(`${base}/api/tickets`, { headers: as(dtCarol) })).status).toBe(403);
  });

  it("only admins reach /admin, and grants are attributed to the granter", async () => {
    expect((await fetch(`${base}/admin`, { headers: as(dtAlice) })).status).toBe(403);
    expect((await fetch(`${base}/api/admin/users`, { headers: as(dtAlice) })).status).toBe(403);

    const listed = await fetch(`${base}/api/admin/users`, { headers: as(ADMIN) });
    expect(listed.status).toBe(200);
    const { users } = (await listed.json()) as {
      users: Array<{ username: string; dev: boolean; deploy: boolean; grants: Record<string, { granted_by: string }> }>;
    };
    expect(users.map((u) => u.username).sort()).toEqual(["alice", "bob", "carol", "lht"]);

    expect((await post("/api/admin/grant", ADMIN, { username: "carol", capability: "deploy", value: true })).status).toBe(200);
    const after = (await (await fetch(`${base}/api/admin/users`, { headers: as(ADMIN) })).json()) as {
      users: Array<{ username: string; dev: boolean; deploy: boolean; grants: Record<string, { granted_by: string }> }>;
    };
    const carol = after.users.find((u) => u.username === "carol")!;
    expect(carol.deploy).toBe(true);
    expect(carol.dev).toBe(true); // deploy implies dev
    expect(carol.grants.deploy.granted_by).toBe("admin-key");

    expect((await post("/api/admin/grant", ADMIN, { username: "carol", capability: "root", value: true })).status).toBe(400);
    expect((await post("/api/admin/grant", ADMIN, { username: "ghost", capability: "dev", value: true })).status).toBe(404);
    store.revokeCapability("carol", "deploy");
  });

  it("derives the transcript namespace from the ticket model for Codex", async () => {
    const t = store.devTickets.createDevTicket(normalizeDevTicketInput({
      title: "codex transcript",
      body: "b",
      requester: "alice",
      model: "codex-gpt-5.6-sol",
    }));
    store.devTickets.takeTicketInbox(t.id, 1_001);
    store.devTickets.updateDevTicket(t.id, { session_id: CODEX_SESS, codex_account_slot: "account_a" });

    const res = await fetch(`${base}/api/tickets/${t.id}/session`, { headers: as(dtAlice) });
    expect(res.status).toBe(200);
    // `rich: true` returns `RichMessage[]` — text lives inside `blocks[i].text`,
    // not on the message itself. Asserting `message.text` was silently `undefined`
    // and the failure only surfaced when GitLab CI first ran this suite.
    const body = (await res.json()) as {
      meta: { id: string; source: string };
      messages: Array<{ blocks?: Array<{ text?: string }> }>;
    };
    expect(body.meta).toMatchObject({ id: CODEX_SESS, source: "codex" });
    expect(body.messages.some((m) => m.blocks?.some((b) => b.text === "Codex 正在处理"))).toBe(true);
  });

  it("reads and follows codex-runner transcript from the requester's pinned device", async () => {
    const t = store.devTickets.createDevTicket(normalizeDevTicketInput({
      title: "remote codex transcript",
      body: "b",
      requester: "alice",
      model: "codex-runner-gpt-5.6-sol",
    }));
    store.devTickets.takeTicketInbox(t.id, 1_001);
    store.devTickets.updateDevTicket(t.id, {
      session_id: REMOTE_CODEX_SESS,
      codex_account_slot: "runner:macbookpro",
    });

    // bob may view alice's dev ticket, but the trusted service must still bind
    // the remote read to alice's persisted owner and device — never bob's.
    const res = await fetch(`${base}/api/tickets/${t.id}/session`, { headers: as(dtBob) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      meta: { id: string; source: string };
      messages: Array<{ blocks?: Array<{ text?: string }> }>;
    };
    expect(body.meta).toMatchObject({ id: REMOTE_CODEX_SESS, source: "codex" });
    expect(body.messages[0].blocks?.[0]?.text).toBe("远端 Codex 完整执行细节");
    expect(remoteTranscriptOpens.at(-1)).toEqual({
      username: "alice",
      purpose: `dashboard-ticket/${t.id}/read`,
      preferredDevice: "macbookpro",
    });
    expect(remoteTranscriptCalls.at(-1)).toEqual({
      op: "codex_agent_read_session",
      args: { id: REMOTE_CODEX_SESS, max_messages: 200 },
    });
    expect(remoteTranscriptCloses).toBe(1);

    const ac = new AbortController();
    const live = await fetch(`${base}/api/tickets/${t.id}/live?from=0&frontier=0`, {
      headers: as(dtBob),
      signal: ac.signal,
    });
    expect(live.headers.get("content-type")).toContain("text/event-stream");
    const reader = live.body!.getReader();
    let buf = "";
    while (!buf.includes("event: delta")) buf += new TextDecoder().decode((await reader.read()).value);
    expect(buf).toContain("远端 Codex 完整执行细节");
    ac.abort();
    await until(() => remoteTranscriptCloses === 2, 5_000);
    expect(remoteTranscriptCalls.at(-1)).toEqual({
      op: "codex_agent_read_session",
      args: { id: REMOTE_CODEX_SESS, max_messages: 500 },
    });
  }, 15_000);

  // LAST on purpose: creates a ticket, and earlier tests pick fixtures by
  // list position — a new ticket in the middle would displace them.
  it("admin proxy-files for a named user (the old admin-403 rule is gone)", async () => {
    const proxied = await post("/api/tickets", ADMIN, { title: "代提票", body: "b", requester: "bob" });
    expect(proxied.status).toBe(200);
    const t = ((await proxied.json()) as { ticket: { id: number; requester: string } }).ticket;
    expect(t.requester).toBe("bob");
    // bob owns it: lifecycle allowed for bob, denied for alice.
    expect((await post(`/api/tickets/${t.id}/cancel`, dtAlice)).status).toBe(403);
    expect((await post(`/api/tickets/${t.id}/cancel`, dtBob)).status).toBe(200);
  });

  /**
   * Ticket #184: stopping the running turn is its own action with its own
   * refusals — it steers the same agent as `cancel`, so it takes the same
   * bar, but it never changes the ticket's status.
   */
  it("lets the owner complete an idle ticket without cancelling or waking the conversation", async () => {
    const made = await post("/api/tickets", dtAlice, { title: "验收完成", body: "b", kind: "simple" });
    const id = ((await made.json()) as { ticket: { id: number } }).ticket.id;
    await until(() => pipe.idle() && store.devTickets.getDevTicket(id)?.session_id != null);
    const sessionId = store.devTickets.getDevTicket(id)!.session_id;
    const worktree = store.devTickets.getDevTicket(id)!.worktree;
    expect((await post(`/api/tickets/${id}/complete`, dtBob)).status).toBe(403);
    expect((await post(`/api/tickets/${id}/complete`, dtAlice)).status).toBe(200);
    expect(store.devTickets.getDevTicket(id)).toMatchObject({ dev_status: "completed", session_id: sessionId, worktree });
    expect(store.devTickets.listTicketsNeedingTurn().some((ticket) => ticket.id === id)).toBe(false);
    expect((await post(`/api/tickets/${id}/message`, dtAlice, { body: "再检查一次" })).status).toBe(200);
    expect(store.devTickets.getDevTicket(id)).toMatchObject({ dev_status: "open", session_id: sessionId });
  });

  it("only the owner can request continuation of retained messages", async () => {
    const made = await post("/api/tickets", dtAlice, { title: "继续权限", body: "b", kind: "complex" });
    const id = ((await made.json()) as { ticket: { id: number } }).ticket.id;
    const resume = vi.spyOn(pipe, "resumeTurn").mockImplementation(() => store.devTickets.getDevTicket(id)!);
    try {
      expect((await post(`/api/tickets/${id}/resume`, dtBob)).status).toBe(403);
      expect(resume).not.toHaveBeenCalled();
      expect((await post(`/api/tickets/${id}/resume`, dtAlice)).status).toBe(200);
      expect(resume).toHaveBeenCalledWith(id, "alice", "token");
    } finally { resume.mockRestore(); await post(`/api/tickets/${id}/cancel`, dtAlice); }
  });

  it("ends native tracking only for the owner, preserving history and refusing managed lifecycle actions", async () => {
    const ticket = store.devTickets.registerNativeTicket({ owner: "alice", device: "local", source: "codex",
      sessionId: CODEX_SESS, workspaceId: "workspace", relativePath: "feature", branch: "dev/native-lifecycle",
      remote: "git@example:octopus.git", title: "Native lifecycle" });
    const interrupt = vi.spyOn(pipe, "interruptTurn");
    try {
      expect((await post(`/api/tickets/${ticket.id}/close-native`, dtBob)).status).toBe(403);
      expect((await post(`/api/tickets/${ticket.id}/kind`, dtAlice, { kind: "complex" })).status).toBe(400);
      expect((await post(`/api/tickets/${ticket.id}/cancel`, dtAlice)).status).toBe(400);
      expect((await post(`/api/tickets/${ticket.id}/close-native`, dtAlice)).status).toBe(200);
      expect((await post(`/api/tickets/${ticket.id}/close-native`, dtAlice)).status).toBe(200);
      expect(store.devTickets.getDevTicket(ticket.id)).toMatchObject({ chat_paused: 1, dev_status: "completed", session_id: CODEX_SESS });
      expect((await post(`/api/tickets/${ticket.id}/message`, dtAlice, { body: "do not launch" })).status).toBe(400);
      expect(interrupt).not.toHaveBeenCalled();
      expect(store.devTickets.listTicketsNeedingTurn().some(row => row.id === ticket.id)).toBe(false);
    } finally { interrupt.mockRestore(); }
  });

  it("derives native running state from current observation rather than the latest input receipt", async () => {
    const ticket = store.devTickets.registerNativeTicket({ owner: "alice", device: "native-runtime", source: "codex",
      sessionId: REMOTE_CODEX_SESS, workspaceId: "workspace", relativePath: "feature", branch: "dev/native-runtime",
      remote: "git@example:octopus.git", title: "Native runtime" });
    const usesRunner = vi.spyOn(pipe, "usesRunnerTickets").mockReturnValue(true);
    const read = vi.fn(async () => ({ messages: [], meta: { runtime: { event: "CodexDaemonObserved", process_state: "alive", turn_state: "working", observed_at: new Date().toISOString() } } }));
    const open = vi.spyOn(pipe, "openRemoteTicketTranscript").mockReturnValue({ device: "native-runtime", read, close: () => {} });
    const status = vi.spyOn(pipe, "readTicketExecution").mockResolvedValue({ operation_id: "old", session_id: REMOTE_CODEX_SESS,
      state: "succeeded", observed_at: new Date().toISOString() });
    const get = async () => (await fetch(base + `/api/tickets/${ticket.id}/session`, { headers: as(dtAlice) })).json();
    try {
      expect(await get()).toMatchObject({ running: true, execution: { state: "succeeded" } });
      read.mockResolvedValueOnce({ messages: [], meta: { runtime: { event: "SessionEnd", process_state: "unknown", turn_state: "idle", observed_at: new Date().toISOString() } } });
      status.mockResolvedValueOnce({ operation_id: "unknown-input", session_id: REMOTE_CODEX_SESS, state: "running", observed_at: new Date().toISOString() });
      expect(await get()).toMatchObject({ running: false, execution: { state: "running" } });
      store.devTickets.closeNativeTicket(ticket.id, "alice");
      expect(await get()).toMatchObject({ running: false });
    } finally { usesRunner.mockRestore(); open.mockRestore(); status.mockRestore(); }
  });

  it("stops a running turn for the owner only, and refuses when nothing is running", async () => {
    const made = await post("/api/tickets", dtAlice, { title: "可停止", body: "b", kind: "complex" });
    const id = ((await made.json()) as { ticket: { id: number } }).ticket.id;

    // Nothing running: a refusal with a reason, not a request armed at
    // whatever turn happens to start next.
    const idle = await post(`/api/tickets/${id}/interrupt`, dtAlice);
    expect(idle.status).toBe(400);
    expect(((await idle.json()) as { error: string }).error).toContain("没有正在执行的轮次");

    // The pipeline's own liveness marker is what makes a stop meaningful.
    store.devTickets.updateDevTicket(id, { turn_started_at: NOW });
    expect((await post(`/api/tickets/${id}/interrupt`, dtBob)).status).toBe(403);
    expect((await post(`/api/tickets/${id}/interrupt`, dtAlice)).status).toBe(200);
    // A stopped turn is not a cancelled ticket.
    expect(store.devTickets.getDevTicket(id)?.dev_status).toBe("open");

    store.devTickets.updateDevTicket(id, { turn_started_at: null });
    await post(`/api/tickets/${id}/cancel`, dtAlice);
  });

  /**
   * Ticket #236: the reader does not want to answer the agent's question.
   * Same bar as cancel, but available in every status — a landed ticket is
   * precisely where cancel is refused, so the question had no exit at all
   * except answering it, and typing an answer wakes a turn to say "never mind".
   */
  it("closes an unanswered question after landing, where cancel is refused", async () => {
    const made = await post("/api/tickets", dtAlice, { title: "有未决问题", body: "b", kind: "complex" });
    const id = ((await made.json()) as { ticket: { id: number } }).ticket.id;
    // Consume the creation message: what this action must NOT do is leave the
    // ticket owing a turn, and an unread inbox would mask that.
    store.devTickets.takeTicketInbox(id, 1_001);
    store.devTickets.updateDevTicket(id, {
      dev_status: "landed",
      open_question: "要我继续追那个具体成因吗?",
    });

    expect((await post(`/api/tickets/${id}/dismiss-question`, dtBob)).status).toBe(403);
    const cancelled = await post(`/api/tickets/${id}/cancel`, dtAlice);
    expect(cancelled.status).toBe(400);

    expect((await post(`/api/tickets/${id}/dismiss-question`, dtAlice)).status).toBe(200);
    const row = store.devTickets.getDevTicket(id)!;
    expect(row.open_question).toBeNull();
    // Only that axis moved.
    expect(row.dev_status).toBe("landed");
    const notes = store.devTickets.listTicketMessages(id).filter((m) => m.author === "pipeline");
    expect(notes.some((m) => m.body.includes("关闭了这个未决问题"))).toBe(true);
    expect(store.devTickets.listTicketsNeedingTurn().some((t) => t.id === id)).toBe(false);
  });
  it("projects persisted Runner placement and masked device-scoped Codex labels", async () => {
    const hosts = vi.spyOn(pipe, "ticketQuotaHosts").mockReturnValue([
      { key: "alice-model", device: "aws-workbench", label: "Model host", online: false,
        accounts: [{ id: "private_runner_slot", label: "codexb", emailLabel: "long-…@example.com" }] },
      { key: "alice-tools", device: "gpu-box", label: "Tool host", online: true,
        accounts: [{ id: "private_runner_slot", label: "codexa" }] },
    ]);
    try {
      for (const account of ["private_runner_slot", "@default", "missing_slot"]) {
        const ticket = store.devTickets.createDevTicket(normalizeDevTicketInput({
          title: "bound placement", body: "b", requester: "alice", model: "codex-gpt-5.6-sol",
        }));
        store.devTickets.takeTicketInbox(ticket.id, 999);
        store.devTickets.updateDevTicket(ticket.id, { codex_account_slot: "account_a" });
        store.devTickets.runner.bind(ticket.id, { owner: "alice", device: "aws-workbench", source: "codex",
          executionDevice: "gpu-box", workspaceId: "private_workspace", codexAccount: account });
        const detail = await (await fetch(`${base}/api/tickets/${ticket.id}`, { headers: as(dtBob) })).json() as { ticket: Record<string, unknown> };
        const list = await (await fetch(`${base}/api/tickets`, { headers: as(dtBob) })).json() as { tickets: Array<Record<string, unknown>> };
        const expected = { source: "codex", model_device: "aws-workbench", execution_device: "gpu-box",
          ...(account === "private_runner_slot" ? { account_label: "long-…@example.com" } : account === "@default" ? { account_label: "" } : {}) };
        for (const row of [detail.ticket, list.tickets.find((row) => row.id === ticket.id)!]) {
          expect(row.execution_placement).toEqual(expected);
          expect(row.codex_account_label).toBe(account === "private_runner_slot" ? "long-…@example.com" : undefined);
          expect(row).not.toHaveProperty("codex_account_slot");
          expect(JSON.stringify(row)).not.toMatch(/private_runner_slot|private_workspace|missing_slot|CODEX_HOME/);
        }
      }
      expect(hosts).toHaveBeenCalledWith("alice");
      expect(hosts).not.toHaveBeenCalledWith("bob");
    } finally { hosts.mockRestore(); }
  });

  it("records how each ticket write was authenticated: a live browser session, or a bearer key", async () => {
    // The browser flow: one POST exchange, then cookie + CSRF on every write.
    const login = await fetch(`${base}/login`, { method: "POST", redirect: "manual",
      headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ token: dtLht }) });
    const cookies = login.headers.getSetCookie();
    const cookie = cookies.find((value) => value.startsWith("octopus_sess="))?.split(";", 1)[0] ?? "";
    const csrf = /octopus_csrf=([0-9a-f]{64})/.exec(cookies.join(";"))?.[1] ?? "";
    expect(cookie && csrf).toBeTruthy();
    const browserPost = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST",
      headers: { cookie, origin: base, "x-csrf-token": csrf, "content-type": "application/json" }, body: JSON.stringify(body) });

    const typed = ((await (await browserPost("/api/tickets", { body: "本人在浏览器里写的" })).json()) as { ticket: { id: number; actor_kind: string } }).ticket;
    expect(typed.actor_kind).toBe("browser");
    // The same account's key used by a script or an agent is not the person typing.
    const scripted = ((await (await post("/api/tickets", dtLht, { body: "agent 拿令牌写的" })).json()) as { ticket: { id: number; actor_kind: string } }).ticket;
    expect(scripted.actor_kind).toBe("token");

    expect((await browserPost(`/api/tickets/${scripted.id}/message`, { body: "浏览器补充" })).status).toBe(200);
    expect((await post(`/api/tickets/${typed.id}/message`, dtLht, { body: "令牌补充" })).status).toBe(200);
    expect((await post(`/api/tickets/${typed.id}/approve-spec`, dtLht)).status).toBe(200);
    const kinds = (id: number) => store.devTickets.listTicketMessages(id).filter((row) => row.author === "lht").map((row) => [row.body, row.actor_kind]);
    expect(kinds(typed.id)).toEqual(expect.arrayContaining([["本人在浏览器里写的", "browser"], ["令牌补充", "token"],
      ["(按钮)方案可以,按当前讨论开始实现吧。", "token"]]));
    expect(kinds(scripted.id)).toEqual(expect.arrayContaining([["agent 拿令牌写的", "token"], ["浏览器补充", "browser"]]));

    // The ticket view reads it back, ticket and messages alike.
    const detail = (await (await fetch(`${base}/api/tickets/${scripted.id}`, { headers: as(dtBob) })).json()) as {
      ticket: { actor_kind: string }; messages: Array<{ body: string; actor_kind: string | null }>;
    };
    expect(detail.ticket.actor_kind).toBe("token");
    expect(detail.messages.find((row) => row.body === "agent 拿令牌写的")?.actor_kind).toBe("token");
    for (const id of [typed.id, scripted.id]) await post(`/api/tickets/${id}/cancel`, dtLht);
  });

  it("derives the kind from the resolved identity only", () => {
    expect(ticketActorKind({ session: {} as never })).toBe("browser");
    expect(ticketActorKind({})).toBe("token");
    expect(ticketActorKind({ mcpOnly: true })).toBe("mcp");
  });

});
