import { useQueryClient } from "@tanstack/react-query";
/**
 * Rapid ticket switching, in the shape of the bug the user reproduced.
 *
 * The reproducer: open a ticket with a session (#44) whose transcript request
 * is slow, then switch to a ticket without a session (#45). The right-hand
 * pane belongs to #45 — but if the late #44 response is allowed to write into
 * component state, its transcript appears under #45's title. Two variants
 * covered here: (A) A has a session, B does not, and (B) both have sessions
 * whose transcript responses arrive out of order.
 *
 * The property tested: no state write from an old selection survives an
 * openTicket that moved the selection somewhere else.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderPage } from "../test-utils.js";
import { TicketsPage } from "./TicketsPage.js";
import { bootstrap } from "../lib/bootstrap.js";
import { applyLanguage } from "../i18n/language.js";

afterEach(() => {
  applyLanguage("zh-CN");
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}
function defer<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function ticketRow(patch: {
  id: number;
  session_id?: string | null;
  dev_status?: string;
  kind?: string;
  body?: string;
  /** The pipeline's liveness marker: set means a CLI turn is running now. */
  turn_started_at?: string;
  chat_paused?: number;
  requester?: string;
  open_question?: string;
  codex_account_label?: string;
  runtime_wait?: import("./tickets/model.js").Ticket["runtime_wait"];
  execution_placement?: import("./tickets/model.js").Ticket["execution_placement"];
  model?: string;
  execution_owner?: "native_cli";
  knowledge_subject_id?: string;
}) {
  // Title carries a unique tag per id so an assertion on the sidebar row can
  // pick exactly one button. No slug, so the row uses `title` as its label.
  return {
    id: patch.id,
    title: `TITLE-${patch.id}`,
    requester: patch.requester ?? "alice",
    chat_paused: patch.chat_paused ?? 0,
    ...(patch.turn_started_at ? { turn_started_at: patch.turn_started_at } : {}),
    runtime_wait: patch.runtime_wait,
    kind: patch.kind ?? "simple",
    body: patch.body,
    dev_status: patch.dev_status ?? "open",
    deploy_status: "pending",
    ...(patch.open_question ? { open_question: patch.open_question } : {}),
    execution_owner: patch.execution_owner,
    model: patch.model ?? "claude-opus-4-7",
    effort: "high",
    session_id: patch.session_id ?? undefined,
    ...(patch.codex_account_label ? { codex_account_label: patch.codex_account_label } : {}),
    ...(patch.execution_placement ? { execution_placement: patch.execution_placement } : {}),
    ...(patch.knowledge_subject_id ? { knowledge_subject_id: patch.knowledge_subject_id } : {}),
    updated_at: "2026-08-10T00:00:00Z",
  };
}

function transcriptOf(text: string, userText?: string) {
  return {
    pending: false,
    messages: [
      ...(userText
        ? [{
            role: "user",
            timestamp: "2026-08-10T00:00:00Z",
            blocks: [{ type: "text", text: userText }],
          }]
        : []),
      {
        role: "assistant",
        timestamp: "2026-08-10T00:00:00Z",
        blocks: [{ type: "text", text }],
      },
    ],
    offset: 0,
    total_messages: 1,
    meta: { activity: null },
  };
}

const PENDING_NO_SESSION = { pending: true, running: false };

/**
 * A fetch stub that answers ticket-page routes with per-URL programmable
 * resolvers. Tests hold a request until they want it to land, then release it.
 */
function installStub() {
  const held: Record<string, Deferred<unknown>> = {};
  const calls: string[] = [];
  const actionCalls: Array<{ path: string; method: string }> = [];
  const actionBodies: Array<{ path: string; body: string }> = [];
  const failures: Record<string, { error: string; status: number }> = {};
  const routes: Record<string, unknown> = {
    "/api/tickets": {
      viewer: { username: "alice", admin: false, dev: true, deploy: false },
      base_branch: "v4",
      models: ["claude-opus-4-7", "codex-gpt-5.6-sol", "omp-gpt-5.6-sol"],
      model_catalog: [
        { id: "claude-opus-4-7", label: "Opus 4.7", family: "claude" },
        { id: "codex-gpt-5.6-sol", label: "Codex · GPT 5.6-sol", family: "codex" },
        { id: "codex-runner-gpt-5.6-sol", label: "Codex · GPT 5.6-sol", family: "codex-runner" },
        { id: "omp-gpt-5.6-sol", label: "omp · GPT 5.6-sol", family: "omp" },
      ],
      model_default: "codex-gpt-5.6-sol",
      efforts: ["high"],
      apps: [],
      requester_choices: [],
      tickets: [
        ticketRow({ id: 44, session_id: "sess-A" }),
        ticketRow({ id: 45, session_id: null }),
      ],
      counts: {},
    },
    "/api/deploy": {
      base_branch: "v4",
      stable_branch: "v4-stable",
      may_deploy: false,
    },
    "/api/apps/publish-pending": { ok: true, results: [], remaining: [] },
    "/api/tickets/44": { ticket: ticketRow({ id: 44, session_id: "sess-A" }), messages: [] },
    "/api/tickets/45": { ticket: ticketRow({ id: 45, session_id: null }), messages: [] },
    "/api/tickets/44/message": { ok: true, message: { id: 4401, delivered_turn: null } },
    "/api/tickets/45/message": { ok: true, message: { id: 4501, delivered_turn: null } },
    "/api/tickets/44/session": null,
    "/api/tickets/45/session": null,
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const pathOnly = url.split("?")[0];
    calls.push(pathOnly);
    actionCalls.push({ path: pathOnly, method: init?.method ?? "GET" });
    if (typeof init?.body === "string") actionBodies.push({ path: pathOnly, body: init.body });
    if (init?.method === "POST" && failures[pathOnly]) {
      return Response.json({ error: failures[pathOnly].error }, { status: failures[pathOnly].status });
    }
    if (held[pathOnly]) {
      const body = await held[pathOnly].promise;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    // Exact match wins; longest prefix otherwise, so `/api/tickets/44/session`
    // is not answered by the `/api/tickets/44` detail stub.
    const keys = Object.keys(routes).sort((a, b) => b.length - a.length);
    const key = keys.find((path) => pathOnly === path) ?? keys.find((path) => pathOnly.startsWith(path));
    if (!key || routes[key] === null) {
      return new Response(JSON.stringify({ error: `no stub for ${url}` }), { status: 404 });
    }
    return new Response(JSON.stringify(routes[key]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return {
    calls,
    actionCalls,
    actionBodies,
    holdMessage(id: number): Deferred<unknown> { held[`/api/tickets/${id}/message`] = defer(); return held[`/api/tickets/${id}/message`]; },
    holdUpload(): Deferred<unknown> { held["/api/attachments"] = defer(); return held["/api/attachments"]; },
    holdSession(id: number): Deferred<unknown> {
      const key = `/api/tickets/${id}/session`;
      held[key] = defer();
      return held[key] as Deferred<unknown>;
    },
    setSession(id: number, body: unknown) {
      routes[`/api/tickets/${id}/session`] = body;
    },
    setTicket(id: number, session_id: string | null, messages: unknown[] = []) {
      routes[`/api/tickets/${id}`] = {
        ticket: ticketRow({ id, session_id }),
        messages,
      };
    },
    setCliTicket(id: number, body: string) {
      const row = ticketRow({ id, kind: "cli", dev_status: "landed", body });
      (routes["/api/tickets"] as { tickets: unknown[] }).tickets.unshift(row);
      routes[`/api/tickets/${id}`] = { ticket: row, messages: [] };
    },
    setTickets(tickets: unknown[]) {
      (routes["/api/tickets"] as { tickets: unknown[] }).tickets = tickets;
    },
    /** Replace one ticket's detail row wholesale (liveness marker, requester…). */
    setTicketRow(id: number, patch: Omit<Parameters<typeof ticketRow>[0], "id">) {
      routes[`/api/tickets/${id}`] = { ticket: ticketRow({ ...patch, id }), messages: [] };
    },
    setActionResponse(path: string, body: unknown) {
      routes[path] = body;
    },
    failAction(path: string, error: string, status = 409) {
      failures[path] = { error, status };
    },
    setDeploy(body: unknown) {
      routes["/api/deploy"] = body;
    },
  };
}

describe("switching between tickets", () => {
  beforeEach(() => {
    (bootstrap as { pageProps: unknown; viewer: unknown }).pageProps = {};
    (bootstrap as { viewer: { username: string; admin: boolean } }).viewer = {
      username: "alice",
      admin: false,
    };
  });

  it("switches ticket chrome immediately while preserving ticket and agent content", async () => {
    const stub = installStub();
    stub.setSession(44, transcriptOf("AGENT-RETURN-原样保留", "USER-INPUT-原样保留"));

    const user = userEvent.setup();
    renderPage(<TicketsPage />, "/tickets");
    await user.click(await screen.findByRole("button", { name: /TITLE-44/ }));
    expect(await screen.findByText("AGENT-RETURN-原样保留")).toBeInTheDocument();
    expect(screen.getByText("USER-INPUT-原样保留")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "➕ 新建工单" })).toBeInTheDocument();

    act(() => applyLanguage("en"));

    expect(screen.getByRole("button", { name: "➕ New ticket" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "💬 Discuss request" })).toBeInTheDocument();
    expect(screen.getByText(/No deployment in progress/)).toBeInTheDocument();
    expect(screen.getByText(/Filed by alice/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
    expect(screen.getByText("🤖 Assistant")).toBeInTheDocument();
    expect(screen.getByText("AGENT-RETURN-原样保留")).toBeInTheDocument();
    expect(screen.getByText("USER-INPUT-原样保留")).toBeInTheDocument();
    expect(screen.getByText("#44 TITLE-44")).toBeInTheDocument();
  });

  it("shows the compact account marker on Codex, not on the ticket title", async () => {
    const stub = installStub();
    const ticket = ticketRow({
      id: 44,
      session_id: "sess-A",
      codex_account_label: "b",
      model: "codex-gpt-5.6-sol",
      requester: "carol",
      knowledge_subject_id: "non_goal_vs_requirement:menu",
    });
    stub.setTickets([ticket]);
    stub.setActionResponse("/api/tickets/44", { ticket, messages: [] });
    stub.setSession(44, transcriptOf("account-b transcript"));

    const user = userEvent.setup();
    renderPage(<TicketsPage />, "/tickets");
    const row = await screen.findByRole("button", { name: /TITLE-44/ });
    expect(row).not.toHaveTextContent("· b");
    expect(row).toHaveTextContent("知识冲突 · carol");
    await user.click(row);

    expect(await screen.findByText("#44 TITLE-44")).toBeInTheDocument();
    expect(screen.getByText(/Codex-b · GPT 5\.6-sol\/high/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "知识冲突 non_goal_vs_requirement:menu" }))
      .toHaveAttribute("href", "/knowledge?v=review&tab=conflicts&conflict=non_goal_vs_requirement%3Amenu");
  });

  it("labels a ticket and a queued message that were not typed in the requester's browser", async () => {
    const stub = installStub();
    const scripted = { ...ticketRow({ id: 45, session_id: null, requester: "lht" }), actor_kind: "token" };
    stub.setTickets([ticketRow({ id: 44, session_id: "sess-A" }), scripted]);
    stub.setActionResponse("/api/tickets/45", { ticket: scripted, messages: [
      { id: 4510, author: "lht", via: "web", body: "AGENT-WROTE-AS-LHT", actor_kind: "token", created_at: "2026-08-10T00:00:00Z", delivered_turn: null },
    ] });
    stub.setSession(44, transcriptOf("plain"));

    const user = userEvent.setup();
    renderPage(<TicketsPage />, "/tickets");
    await user.click(await screen.findByRole("button", { name: /TITLE-45/ }));
    const label = await screen.findByTestId("ticket-actor-kind");
    expect(label).toHaveTextContent("脚本/令牌提交");
    expect(label).toHaveAttribute("title", "不是本人在浏览器中输入的，不作为本人原话");
    expect(await screen.findByText(/lht via web · 脚本\/令牌提交/)).toBeInTheDocument();

    act(() => applyLanguage("en"));
    expect(screen.getByTestId("ticket-actor-kind")).toHaveTextContent("Submitted by script/token");
    expect(screen.getByText(/lht via web · Submitted by script\/token/)).toBeInTheDocument();

    // A ticket written before kinds were recorded (no actor_kind) shows nothing.
    await user.click(screen.getByRole("button", { name: /TITLE-44/ }));
    expect(await screen.findByText("#44 TITLE-44")).toBeInTheDocument();
    expect(screen.queryByTestId("ticket-actor-kind")).toBeNull();
  });

  it.each([
    { source: "codex" as const, account_label: "b", label: "Codex-b" },
    { source: "codex" as const, account_label: "long-…@example.com", label: "Codex · long-…@example.com" },
    { source: "codex" as const, account_label: "", label: "Codex · 默认账号" },
    { source: "codex" as const, label: "Codex · 账号未确认" },
    { source: "claude" as const, label: "Claude" },
  ])("shows the bound model and tool machines with $label", async ({ source, account_label, label }) => {
    const stub = installStub();
    stub.setTicketRow(44, { execution_placement: { source, model_device: "aws-workbench",
      execution_device: "gpu-box", ...(account_label !== undefined ? { account_label } : {}) } });
    renderPage(<TicketsPage />, "/tickets");
    await userEvent.setup().click(await screen.findByRole("button", { name: /TITLE-44/ }));
    const placement = await screen.findByTestId("ticket-execution-placement");
    expect(placement).toHaveTextContent(`模型来源 aws-workbench · ${label} · 工具执行 gpu-box`);
    act(() => applyLanguage("en"));
    expect(placement).toHaveTextContent("Model source aws-workbench");
    expect(placement).toHaveTextContent("Tool runner gpu-box");
  });

  it("keeps historical placement unknown instead of borrowing current filing defaults", async () => {
    installStub();
    renderPage(<TicketsPage />, "/tickets");
    await userEvent.setup().click(await screen.findByRole("button", { name: /TITLE-44/ }));
    expect(await screen.findByTestId("ticket-execution-placement")).toHaveTextContent("执行来源未记录");
  });

  it("drops a slow response for #A after the reader has opened #B", async () => {
    // #A has a session and its transcript is held; #B has no session (its
    // /session endpoint answers `pending: true` right away). Once B has
    // painted "暂无会话" and we release A's late response, B's placeholder
    // must remain — a late write from A would silently overwrite it.
    const stub = installStub();
    stub.setSession(44, transcriptOf("A-ONLY-TEXT"));
    stub.setSession(45, PENDING_NO_SESSION);
    const held = stub.holdSession(44);

    const user = userEvent.setup();
    renderPage(<TicketsPage />, "/tickets");

    await user.click(await screen.findByRole("button", { name: /TITLE-44/ }));
    // A's fetch is in flight; the reader now switches to B.
    await user.click(await screen.findByRole("button", { name: /TITLE-45/ }));
    await waitFor(() =>
      expect(screen.getByText("工单还没进入开发,暂无会话。")).toBeInTheDocument(),
    );

    // A's response finally arrives. If the guard is missing this rewrites #B.
    held.resolve(transcriptOf("A-ONLY-TEXT"));
    // Give React a couple of macrotasks to run any late setState.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(screen.getByText("工单还没进入开发,暂无会话。")).toBeInTheDocument();
    expect(screen.queryByText("A-ONLY-TEXT")).toBeNull();
  });

  it("renders a CLI landing as a read-only report without requesting an agent session", async () => {
    const stub = installStub();
    stub.setCliTicket(46, "CLI 可追溯结果\n\n## 开发侧验证\n\n- tests passed\n\n## 生产验收\n\n- click works");

    const user = userEvent.setup();
    renderPage(<TicketsPage />, "/tickets");
    await user.click(await screen.findByRole("button", { name: /TITLE-46/ }));

    expect(await screen.findByRole("region", { name: "CLI 交付简报" })).toBeInTheDocument();
    expect(screen.getByText("CLI 可追溯结果")).toBeInTheDocument();
    expect(screen.queryByText("开发 agent 会话")).toBeNull();
    expect(screen.queryByLabelText("给这张工单发消息")).toBeNull();
    expect(stub.calls).not.toContain("/api/tickets/46/session");
  });

  it("prints what each ticket cost in the list, and nothing for a ticket that has not run", async () => {
    const stub = installStub();
    stub.setTickets([
      {
        ...ticketRow({ id: 60, dev_status: "landed" }),
        agent_ms: 1_920_000,
        agent_turns: 3,
        tokens_in: 30_000,
        tokens_out: 12_000,
        tokens_cached: 1_200_000,
        diff_files: 11,
        diff_modules: 3,
        diff_added: 420,
        diff_removed: 96,
      },
      ticketRow({ id: 61 }),
    ]);

    renderPage(<TicketsPage />, "/tickets");
    const strip = await screen.findByTestId("cost-60");
    // Keep the token unit, as required by ticketCost/cost.test.ts; all
    // other metrics and the empty-row behavior remain exact assertions.
    expect(strip.textContent).toBe("32m×31.2M tokens3模11文+420−96");
    expect(strip.getAttribute("title")).toContain("改动 3 个模块 / 11 个文件");
    // A ticket with nothing measured gains no row height at all.
    expect(screen.queryByTestId("cost-61")).toBeNull();
  });

  it.each([
    ["pending", "待上线", "Awaiting deployment"],
    ["deploying", "上线中", "Deploying"],
    ["live_unverified", "已上线待验证", "Live, awaiting verification"],
    ["not_needed", "无需上线", "No deployment needed"],
    ["app_live", "App 已热发布", "App hot-published"],
  ])("names deployment state %s with one word in the list and the detail, never the raw value", async (state, zh, en) => {
    const stub = installStub();
    const row = { ...ticketRow({ id: 44, dev_status: "landed", session_id: "sess-A" }), deploy_status: state };
    stub.setTickets([row]);
    stub.setActionResponse("/api/tickets/44", { ticket: row, messages: [] });
    stub.setSession(44, transcriptOf("LANDED"));
    renderPage(<TicketsPage />, "/tickets");
    const listed = await screen.findByRole("button", { name: /TITLE-44/ });
    expect(listed.textContent).toContain(zh);
    await userEvent.setup().click(listed);
    const badges = await screen.findByLabelText("工单状态");
    expect(badges).toHaveTextContent(zh);
    expect(badges.textContent).not.toContain(state);
    act(() => applyLanguage("en"));
    expect(screen.getByRole("button", { name: /TITLE-44/ }).textContent).toContain(en);
    expect(screen.getByLabelText("Ticket status")).toHaveTextContent(en);
  });

  /**
   * Ticket #201. The reported failure: an agent lands the work, says in its
   * reply that half of it needs a decision, and the board announces success —
   * so the question sits inside a transcript nobody has a reason to reopen.
   */
  it("says a landed ticket still needs an answer, instead of calling it done", async () => {
    const stub = installStub();
    const question = "剩下的一半要改权限契约,会作废所有用户的同意,要做吗?";
    stub.setTickets([
      ticketRow({ id: 70, dev_status: "landed", open_question: question }),
      ticketRow({ id: 71, dev_status: "landed" }),
    ]);

    renderPage(<TicketsPage />, "/tickets");

    const asking = await screen.findByRole("button", { name: /TITLE-70/ });
    // The row says "waiting on you", NOT the deploy axis — and the whole
    // question is the hover text rather than three wrapped lines in a rail.
    expect(asking.textContent).toContain("agent 有未决问题,等你回复");
    expect(asking.textContent).not.toContain("待上线");
    expect(asking.getAttribute("title")).toContain(question);

    // A landed ticket with nothing outstanding is unchanged.
    const done = await screen.findByRole("button", { name: /TITLE-71/ });
    expect(done.textContent).toContain("待上线");
    expect(done.textContent).not.toContain("未决问题");

    // And it is counted in the attention strip, which used to require `open`.
    // Match the strip's own text node rather than the same phrase in the row.
    const attention = await screen.findByText("🙋 等你回复", { selector: "span" });
    expect(attention.textContent).toBe("🙋 等你回复 1");
  });

  it("shows current follow-up work ahead of a landed ticket's historical verification", async () => {
    const stub = installStub();
    stub.setTickets([
      {
        ...ticketRow({ id: 74, dev_status: "landed" }),
        deploy_status: "verified",
        parked_for_lock: true,
      },
      {
        ...ticketRow({ id: 75, dev_status: "landed" }),
        deploy_status: "verified",
        unread: 1,
      },
      {
        ...ticketRow({ id: 76, dev_status: "landed" }),
        deploy_status: "verified",
      },
    ]);

    renderPage(<TicketsPage />, "/tickets");

    const parked = await screen.findByRole("button", { name: /TITLE-74/ });
    expect(parked.textContent).toContain("等合并锁,submit 会在锁释放后自动重试");
    expect(parked.textContent).not.toContain("已验证");

    const queued = await screen.findByRole("button", { name: /TITLE-75/ });
    expect(queued.textContent).toContain("消息排队中");
    expect(queued.textContent).not.toContain("已验证");

    const idle = await screen.findByRole("button", { name: /TITLE-76/ });
    expect(idle.textContent).toContain("已验证");
  });

  /**
   * Ticket #236. The reported failure: the question is rendered above the box
   * it has to be answered in, and answering is the ONLY thing that clears it.
   * On a landed ticket the lifecycle bar has no 取消工单 button either, so a
   * reader who simply did not want to answer had no button at all.
   */
  it("lets the requester close an unanswered question without answering it", async () => {
    const stub = installStub();
    const question = "要我继续追那个具体成因吗?";
    stub.setTickets([ticketRow({ id: 72, dev_status: "landed", open_question: question })]);
    stub.setTicketRow(72, { dev_status: "landed", open_question: question });
    stub.setSession(72, PENDING_NO_SESSION);
    stub.setActionResponse("/api/tickets/72/dismiss-question", { ok: true });

    const user = userEvent.setup();
    renderPage(<TicketsPage />, "/tickets");

    await user.click(await screen.findByRole("button", { name: /TITLE-72/ }));
    expect(await screen.findByRole("note")).toHaveTextContent(question);

    await user.click(await screen.findByRole("button", { name: "✖ 不用回答" }));
    await waitFor(() =>
      expect(
        stub.actionCalls.some(
          (call) => call.path === "/api/tickets/72/dismiss-question" && call.method === "POST",
        ),
      ).toBe(true),
    );
    // Closing the question is not sending a message: an agent turn must not be
    // woken by a reader who declined to answer.
    expect(stub.actionCalls.some((call) => call.path === "/api/tickets/72/message")).toBe(false);
  });

  it("hides the dismiss button from someone who does not own the ticket", async () => {
    const stub = installStub();
    const question = "要我继续追那个具体成因吗?";
    stub.setTickets([
      ticketRow({ id: 73, dev_status: "landed", open_question: question, requester: "bob" }),
    ]);
    stub.setTicketRow(73, { dev_status: "landed", open_question: question, requester: "bob" });
    stub.setSession(73, PENDING_NO_SESSION);

    const user = userEvent.setup();
    renderPage(<TicketsPage />, "/tickets");

    await user.click(await screen.findByRole("button", { name: /TITLE-73/ }));
    expect(await screen.findByRole("note")).toHaveTextContent(question);
    expect(screen.queryByRole("button", { name: "✖ 不用回答" })).toBeNull();
  });

  it("checks releases without deploying and freezes the selected pin in the confirmation", async () => {
    const stub = installStub(), sha = "a".repeat(40), digest = "b".repeat(64);
    stub.setTickets([]);
    const state = { base_branch: "v4", stable_branch: "v4-stable", may_deploy: true, deployed_sha: "c".repeat(40),
      preparation: { sha, state: "ready", manifestSha256: digest },
      releases: { enabled: true, deployable: { sha, manifestSha256: digest }, snapshot: { mainlineSha: "d".repeat(40), ready: { sha, manifestSha256: digest } } } };
    stub.setDeploy(state); stub.setActionResponse("/api/deploy/check", { ok: true });
    let queries!: ReturnType<typeof useQueryClient>;
    function CaptureQueries() { queries = useQueryClient(); return null; }
    const user = userEvent.setup(); renderPage(<><CaptureQueries /><TicketsPage /></>, "/tickets");
    await user.click(screen.getByText("部署", { selector: "summary" }));
    await user.click(await screen.findByRole("button", { name: "检查更新" }));
    expect(stub.actionCalls).toContainEqual({ path: "/api/deploy/check", method: "POST" });
    expect(stub.actionCalls).not.toContainEqual({ path: "/api/deploy", method: "POST" });
    await user.click(await screen.findByRole("button", { name: "上线" }));
    expect(screen.getByRole("dialog")).toHaveTextContent(sha);
    expect(screen.getByRole("dialog")).toHaveTextContent(digest);
    // A newer observation must not silently replace what this dialog showed.
    const next = { ...state, intent: { id: 99 }, releases: { enabled: true, deployable: { sha: "d".repeat(40), manifestSha256: "e".repeat(64) }, snapshot: { mainlineSha: "d".repeat(40), ready: { sha: "d".repeat(40), manifestSha256: "e".repeat(64) } } } };
    stub.setDeploy(next);
    await act(async () => { queries.setQueryData(["deploy", "panel"], next); });
    expect(screen.getByRole("dialog")).toHaveTextContent(digest);
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /上线/ }));
    await waitFor(() => expect(stub.actionBodies.find(row => row.path === "/api/deploy")).toEqual({ path: "/api/deploy", body: JSON.stringify({ target: sha, manifest_sha256: digest }) }));
  });

  it.each(["pending", "receiving", "staging", "failed"])("can deploy the prepared release while the newest package is %s", async state => {
    const stub = installStub(), sha = "a".repeat(40), digest = "b".repeat(64), latest = "d".repeat(40);
    stub.setTickets([]);
    stub.setDeploy({ base_branch: "v4", stable_branch: "v4-stable", may_deploy: true, deployed_sha: "c".repeat(40),
      preparation: { sha: latest, state },
      releases: { enabled: true, deployable: { sha, manifestSha256: digest },
        snapshot: { mainlineSha: latest, ready: { sha: latest, manifestSha256: "e".repeat(64) } } } });
    const user = userEvent.setup(); renderPage(<TicketsPage />, "/tickets");
    await userEvent.setup().click(screen.getByText("部署", { selector: "summary" }));
    const launch = await screen.findByRole("button", { name: "上线" });
    expect(launch).toBeEnabled();
    await user.click(launch);
    expect(screen.getByRole("dialog")).toHaveTextContent(sha);
    expect(screen.getByRole("dialog")).toHaveTextContent(digest);
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /上线/ }));
    await waitFor(() => expect(stub.actionBodies.find(row => row.path === "/api/deploy")).toEqual({ path: "/api/deploy", body: JSON.stringify({ target: sha, manifest_sha256: digest }) }));
  });

  it("shows the deployment's own warning when the knowledge review could not run", async () => {
    const stub = installStub(), sha = "a".repeat(40), digest = "b".repeat(64);
    const warning = "⚠ 知识审查未能运行(Runner offline)，本次部署未经第三档冲突复核。";
    stub.setDeploy({ base_branch: "v4", stable_branch: "v4-stable", may_deploy: true, deployed_sha: "c".repeat(40),
      intent: { id: 99, detail: warning },
      releases: { enabled: true, deployable: { sha, manifestSha256: digest }, snapshot: { mainlineSha: sha, ready: { sha, manifestSha256: digest } } } });
    const user = userEvent.setup(); renderPage(<TicketsPage />, "/tickets");
    await userEvent.setup().click(screen.getByText("部署", { selector: "summary" }));
    await user.click(await screen.findByRole("button", { name: "上线" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "上线" }));
    expect(await screen.findByText(warning)).toBeVisible();
  });

  it("shows deployment refusal without a selected ticket and clears it on an explicit update check", async () => {
    const stub = installStub(), sha = "a".repeat(40), digest = "b".repeat(64);
    stub.setDeploy({ base_branch: "v4", stable_branch: "v4-stable", may_deploy: true,
      releases: { enabled: true, deployable: { sha, manifestSha256: digest }, snapshot: { mainlineSha: sha, ready: { sha, manifestSha256: digest } } } });
    stub.failAction("/api/deploy", "所选发布包已被清理，请重新检查更新");
    stub.setActionResponse("/api/deploy/check", { ok: true });
    const user = userEvent.setup(); renderPage(<TicketsPage />, "/tickets");
    await userEvent.setup().click(screen.getByText("部署", { selector: "summary" }));
    await user.click(await screen.findByRole("button", { name: "上线" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "上线" }));
    expect(await screen.findByText("所选发布包已被清理，请重新检查更新")).toBeVisible();
    await user.click(screen.getByRole("button", { name: /TITLE-44/ }));
    expect(screen.getByText("所选发布包已被清理，请重新检查更新")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "检查更新" }));
    await waitFor(() => expect(screen.queryByText("所选发布包已被清理，请重新检查更新")).not.toBeInTheDocument());
    expect(stub.actionCalls.filter(row => row.path === "/api/deploy" && row.method === "POST")).toHaveLength(1);
  });

  it.each([
    ["idle", "原生 CLI 在线，等待输入", true],
    ["working", "原生 CLI 正在运行", true],
    // Waiting on a local permission/question: the Runner withholds append,
    // but the CLI is connected and must not be shown as disconnected.
    ["needs_input", "原生 CLI 正在等待本机确认：请先在终端处理权限或问题", false],
    ["unknown", "原生 CLI 已连接，当前状态未知", true],
  ] as const)("keeps a registered CLI's conversation available after its delivery is reconciled (%s)", async (turnState, label, append) => {
    const stub = installStub(); const row = ticketRow({ id: 44, kind: "cli", dev_status: "landed", execution_owner: "native_cli", session_id: "sess-A" });
    stub.setTickets([row]); stub.setTicketRow(44, { kind: "cli", dev_status: "landed", execution_owner: "native_cli", session_id: "sess-A" });
    stub.setSession(44, { ...transcriptOf("NATIVE-CONVERSATION"), meta: { runtime: {
      process_state: "alive", control_mode: "external_cli", turn_state: turnState, event: "CodexDaemonObserved",
      observed_at: new Date().toISOString(), capabilities: { protocol_append: append },
    } } });
    const user = userEvent.setup(); renderPage(<TicketsPage />, "/tickets");
    await user.click(await screen.findByRole("button", { name: /TITLE-44/ }));
    expect(await screen.findByText("NATIVE-CONVERSATION")).toBeInTheDocument();
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.queryByText("原生 CLI 未连接，历史记录仍可查看")).not.toBeInTheDocument();
    expect(screen.getByLabelText("给这张工单发消息")).toBeEnabled();
    expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
    if (turnState === "working") expect(screen.getByRole("button", { name: /停止这一轮/ })).toBeEnabled();
    else expect(screen.queryByRole("button", { name: /停止这一轮/ })).not.toBeInTheDocument();
  });

  it("shows a detached native CLI as unavailable, not queued or running, and ends tracking without managed controls", async () => {
    const stub = installStub();
    const row = ticketRow({ id: 44, execution_owner: "native_cli", session_id: "sess-A" });
    stub.setTickets([{ ...row, unread: 2 }]); stub.setTicketRow(44, row);
    stub.setSession(44, { ...transcriptOf("NATIVE-HISTORY"), execution: { state: "succeeded", operation_id: "old-input" },
      meta: { runtime: { process_state: "unknown", turn_state: "idle", event: "SessionEnd", capabilities: { managed_resume: true } } } });
    const user = userEvent.setup(); renderPage(<TicketsPage />, "/tickets");
    await user.click(await screen.findByRole("button", { name: /TITLE-44/ }));
    expect(await screen.findByText("NATIVE-HISTORY")).toBeInTheDocument();
    expect(screen.getAllByText("原生 CLI 未连接，历史记录仍可查看").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(screen.queryByText(/排队中：/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /停止这一轮/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /改为/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "取消工单" })).not.toBeInTheDocument();
    stub.setTicketRow(44, { ...row, dev_status: "completed", chat_paused: 1 });
    await user.click(screen.getByRole("button", { name: "结束跟踪" }));
    await waitFor(() => expect(stub.actionCalls).toContainEqual({ path: "/api/tickets/44/close-native", method: "POST" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "结束跟踪" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  });

  it("offers App-only hot publication instead of a complete deploy", async () => {
    const stub = installStub();
    stub.setDeploy({
      base_branch: "v4",
      stable_branch: "v4-stable",
      may_deploy: true,
      may_publish_apps: true,
      app_releases_pending: [
        {
          app_id: "session-plus",
          title: "会话+（Session Plus）",
          commit_sha: "a".repeat(40),
          ticket_id: 118,
        },
      ],
    });
    stub.setTickets([ticketRow({ id: 118, kind: "app", dev_status: "landed" })]);

    const user = userEvent.setup();
    renderPage(<TicketsPage />, "/tickets");
    await userEvent.setup().click(screen.getByText("部署", { selector: "summary" }));

    expect(await screen.findByText(/待发布 App 会话/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /热发布 1 个 App/ }));
    await user.click(screen.getByRole("button", { name: "热发布" }));
    await waitFor(() => {
      expect(stub.actionCalls).toContainEqual({ path: "/api/apps/publish-pending", method: "POST" });
    });
    expect(stub.actionCalls).not.toContainEqual({ path: "/api/deploy", method: "POST" });
  });

  it("offers the Administer retry beside the release deployment when releases are staged (GitLab)", async () => {
    const stub = installStub(), sha = "a".repeat(40), digest = "b".repeat(64);
    stub.setDeploy({
      base_branch: "v4",
      stable_branch: "v4-stable",
      may_deploy: true,
      may_publish_apps: true,
      deployed_sha: "c".repeat(40),
      preparation: { sha, state: "ready", manifestSha256: digest },
      releases: { enabled: true, deployable: { sha, manifestSha256: digest },
        snapshot: { mainlineSha: sha, ready: { sha, manifestSha256: digest }, checkedAt: "2026-10-15T00:00:00Z" } },
      app_releases_pending: [
        { app_id: "research-docs", title: "研究文档", commit_sha: sha, ticket_id: 118 },
      ],
    });
    stub.setTickets([ticketRow({ id: 118, kind: "app", dev_status: "landed" })]);

    const user = userEvent.setup();
    renderPage(<TicketsPage />, "/tickets");
    await userEvent.setup().click(screen.getByText("部署", { selector: "summary" }));

    expect(await screen.findByText(/待发布 App 研究文档 · 发布包暂存后若当前部署可直接运行，会自动上线/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "上线" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: /热发布 1 个 App/ }));
    await user.click(screen.getByRole("button", { name: "热发布" }));
    await waitFor(() => {
      expect(stub.actionCalls).toContainEqual({ path: "/api/apps/publish-pending", method: "POST" });
    });
    expect(stub.actionCalls).not.toContainEqual({ path: "/api/deploy", method: "POST" });
  });

  it("shows an in-flight automatic App drain without offering a duplicate hot publication", async () => {
    const stub = installStub();
    stub.setDeploy({
      base_branch: "v4",
      stable_branch: "v4-stable",
      may_deploy: true,
      may_publish_apps: true,
      app_releases_pending: [
        {
          app_id: "session-plus",
          title: "会话+（Session Plus）",
          commit_sha: "a".repeat(40),
          ticket_id: 118,
        },
      ],
      app_release_drain: { active: true, mode: "automatic" },
    });
    stub.setTickets([ticketRow({ id: 118, kind: "app", dev_status: "landed" })]);

    renderPage(<TicketsPage />, "/tickets");
    await userEvent.setup().click(screen.getByText("部署", { selector: "summary" }));

    expect(await screen.findByText("📦 自动发布 App")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("正在自动打包、安装并激活");
    expect(screen.queryByRole("button", { name: /热发布 1 个 App/ })).toBeNull();
  });

  it.each(["building", "receiving", "staging", "failed", "ready"])("only offers a prepared exact release for activation (%s)", async (state) => {
    const stub = installStub();
    stub.setTickets([ticketRow({ id: 44, dev_status: "landed" })]);
    stub.setDeploy({ base_branch: "v4", stable_branch: "v4-stable", may_deploy: true,
      preparation: { sha: "a".repeat(40), state } });
    renderPage(<TicketsPage />, "/tickets");
    await userEvent.setup().click(screen.getByText("部署", { selector: "summary" }));
    await screen.findByText(/发布准备/);
    const button = screen.getByRole("button", { name: /上线 v4/ });
    if (state === "ready") expect(button).toBeEnabled();
    else expect(button).toBeDisabled();
    expect(stub.actionCalls).not.toContainEqual({ path: "/api/deploy", method: "POST" });
  });

  it("exposes measured preparation phases without issuing another check or deployment", async () => {
    const stub = installStub();
    const user = userEvent.setup();
    stub.setDeploy({ base_branch: "v4", stable_branch: "v4-stable", may_deploy: true,
      preparation: { sha: "a".repeat(40), state: "ready",
        phases: [{ name: "receive_outputs", startedAt: "2026-10-10T00:00:00Z", state: "succeeded", elapsedMs: 2100 }],
        installation: { state: "succeeded", elapsedMs: 65000, dependencyCacheHit: true,
          phases: [{ name: "dependencies_link", startedAt: "2026-10-10T00:00:03Z", state: "succeeded", elapsedMs: 62000, cacheHit: true, filesReused: 53507 }] },
        maintenance: { state: "deferred", elapsedMs: 200, phases: [] } } });
    renderPage(<TicketsPage />, "/tickets");
    await userEvent.setup().click(screen.getByText("部署", { selector: "summary" }));
    const summary = await screen.findByText("查看准备耗时");
    const before = [...stub.actionCalls];
    await user.click(summary);
    expect(screen.getByTestId("release-preparation-details")).toHaveAttribute("open");
    expect(screen.getByText(/复用依赖 · 1m02s · 缓存命中 · 复用 53507 个文件/)).toBeInTheDocument();
    expect(screen.getByText(/后台清理 · 0s · 已让路或停止/)).toBeInTheDocument();
    expect(stub.actionCalls).toEqual(before);
  });

  it("does not present an interrupted installer's last running phase as continuing work", async () => {
    const stub = installStub();
    stub.setTickets([ticketRow({ id: 44, dev_status: "landed" })]);
    stub.setDeploy({ base_branch: "v4", stable_branch: "v4-stable", may_deploy: true,
      preparation: { sha: "a".repeat(40), state: "failed", error: "installation stopped",
        installation: { state: "running", elapsedMs: 65000,
          phases: [{ name: "dependencies_extract", startedAt: "2026-10-10T00:00:00Z", state: "running", elapsedMs: 62000 }] },
        maintenance: { state: "failed", elapsedMs: 200, phases: [] } } });
    renderPage(<TicketsPage />, "/tickets");
    await userEvent.setup().click(screen.getByText("部署", { selector: "summary" }));
    await userEvent.setup().click(await screen.findByText("查看准备耗时"));
    expect(screen.getByText("展开依赖 · 1m02s · 已让路或停止")).toBeInTheDocument();
    expect(screen.getByText("后台清理 · 0s · 失败")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /上线 v4/ })).toBeDisabled();
  });

  it("keeps the next complete deploy available while an older block awaits verification", async () => {
    const stub = installStub();
    stub.setDeploy({
      base_branch: "v4",
      stable_branch: "v4-stable",
      may_deploy: true,
      may_publish_apps: true,
      verify_open: {
        id: 117,
        intent_id: 132,
        target_sha: "b".repeat(40),
        modules_touched: JSON.stringify(["dashboard"]),
        checklist: JSON.stringify([]),
        assignees: JSON.stringify(["alice"]),
      },
      app_releases_pending: [
        {
          app_id: "session-plus",
          title: "会话+（Session Plus）",
          commit_sha: "a".repeat(40),
          ticket_id: 118,
        },
      ],
    });

    renderPage(<TicketsPage />, "/tickets");
    await userEvent.setup().click(screen.getByText("部署", { selector: "summary" }));

    expect(await screen.findByText(/待验证区块/)).toBeInTheDocument();
    expect(screen.getByText(/下一批待上线工单 0/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /热发布 1 个 App/ })).toBeInTheDocument();
  });

  it("distinguishes deployment batches and internal verify anchors from ticket numbers", async () => {
    const stub = installStub();
    stub.setDeploy({
      base_branch: "v4",
      stable_branch: "v4-stable",
      may_deploy: false,
      verify_open: {
        id: 193,
        intent_id: 205,
        target_sha: "c".repeat(40),
        modules_touched: JSON.stringify(["dashboard"]),
        checklist: JSON.stringify([
          { ticket_id: 325, title: "梳理部署编号", criteria: "编号语义清晰" },
        ]),
        assignees: JSON.stringify(["alice"]),
        deployment_count: 2,
      },
    });

    renderPage(<TicketsPage />, "/tickets");
    await userEvent.setup().click(screen.getByText("部署", { selector: "summary" }));

    expect(await screen.findByText(/最新部署批次 D205/)).toBeInTheDocument();
    expect(screen.getByText(/#325 梳理部署编号/)).toBeInTheDocument();
    expect(screen.queryByText(/#193/)).not.toBeInTheDocument();
  });

  it("labels recent deploy intent ids as deployment batches", async () => {
    const stub = installStub();
    stub.setDeploy({
      base_branch: "v4",
      stable_branch: "v4-stable",
      may_deploy: false,
      recent: [{ id: 193, status: "succeeded" }],
    });

    renderPage(<TicketsPage />, "/tickets");
    await userEvent.setup().click(screen.getByText("部署", { selector: "summary" }));

    expect(await screen.findByText(/上次部署批次 D193 后端已更新/)).toBeInTheDocument();
    expect(screen.queryByText(/上次 #193/)).not.toBeInTheDocument();
  });

  it("keeps the transcript for #B when #A/#B responses arrive out of order", async () => {
    // Both tickets have sessions. A's transcript takes longer; B's arrives
    // first. Then A's late response comes in — it must not overwrite B's
    // transcript that is already on screen.
    const stub = installStub();
    stub.setTicket(45, "sess-B");
    stub.setSession(44, transcriptOf("A-BODY"));
    stub.setSession(45, transcriptOf("B-BODY"));
    const heldA = stub.holdSession(44);
    const heldB = stub.holdSession(45);

    const user = userEvent.setup();
    renderPage(<TicketsPage />, "/tickets");

    await user.click(await screen.findByRole("button", { name: /TITLE-44/ }));
    await user.click(await screen.findByRole("button", { name: /TITLE-45/ }));

    heldB.resolve(transcriptOf("B-BODY"));
    await waitFor(() => expect(screen.getByText("B-BODY")).toBeInTheDocument());

    heldA.resolve(transcriptOf("A-BODY"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(screen.getByText("B-BODY")).toBeInTheDocument();
    expect(screen.queryByText("A-BODY")).toBeNull();
  });

  it("shows the new ticket's placeholder immediately, not the previous transcript", async () => {
    // openTicket clears state synchronously and paints "读取中…" before the
    // fetch settles — a rapid click must never leave the prior transcript on
    // screen under the new ticket's title.
    const stub = installStub();
    stub.setSession(44, transcriptOf("A-BODY"));
    stub.setSession(45, PENDING_NO_SESSION);
    const held = stub.holdSession(45);

    const user = userEvent.setup();
    renderPage(<TicketsPage />, "/tickets");

    await user.click(await screen.findByRole("button", { name: /TITLE-44/ }));
    await waitFor(() => expect(screen.getByText("A-BODY")).toBeInTheDocument());

    // Switching to #45 must instantly clear A's transcript, even before the
    // /session call for #45 resolves. Either the loading spinner or the
    // "读取中…" placeholder is legitimate here; the property is that A's body
    // is not on screen.
    await user.click(await screen.findByRole("button", { name: /TITLE-45/ }));
    expect(screen.queryByText("A-BODY")).toBeNull();

    held.resolve(PENDING_NO_SESSION);
    await waitFor(() =>
      expect(screen.getByText("工单还没进入开发,暂无会话。")).toBeInTheDocument(),
    );
    expect(screen.queryByText("A-BODY")).toBeNull();
  });

  it("uses one chat stream without duplicate conversation or buffer cards", async () => {
    const stub = installStub();
    stub.setSession(44, transcriptOf("SESSION-ANSWER", "ORIGINAL-REQUEST"));
    stub.setTicket(44, "sess-A", [
      { id: 1, author: "alice", via: "web", body: "ORIGINAL-REQUEST", delivered_turn: 1, created_at: "2026-08-10T00:00:00Z" },
      { id: 2, author: "agent", body: "DUPLICATE-ANSWER", delivered_turn: 1 },
      { id: 3, author: "pipeline", body: "PIPELINE-NOTICE" },
      { id: 4, author: "alice", body: "QUEUED-INPUT", delivered_turn: null },
    ]);
    const user = userEvent.setup();
    renderPage(<TicketsPage />, "/tickets");
    await user.click(await screen.findByRole("button", { name: /TITLE-44/ }));
    await screen.findByText("SESSION-ANSWER");
    expect(screen.queryByRole("button", { name: /需求与工单对话/ })).toBeNull();
    expect(screen.queryByRole("region", { name: "待送达消息" })).toBeNull();
    expect(screen.queryByText("DUPLICATE-ANSWER")).toBeNull();
    expect(screen.queryByText("PIPELINE-NOTICE")).toBeNull();
    expect(screen.getAllByText("ORIGINAL-REQUEST")).toHaveLength(1);
    expect(document.querySelectorAll("[data-av-chat-transcript]")).toHaveLength(1);
    const queued = screen.getByText("QUEUED-INPUT");
    expect(queued.closest("[data-av-chat-transcript]")).not.toBeNull();
    expect(queued.closest(".av-chat-pending")).not.toBeNull();
    expect(screen.getByText("SESSION-ANSWER").compareDocumentPosition(queued) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps queued bubbles visible before the first session log exists", async () => {
    const stub = installStub();
    stub.setSession(44, PENDING_NO_SESSION);
    stub.setTicket(44, null, [{ id: 1, author: "alice", body: "FIRST-INPUT", delivered_turn: null }]);
    const user = userEvent.setup();
    renderPage(<TicketsPage />, "/tickets");
    await user.click(await screen.findByRole("button", { name: /TITLE-44/ }));
    await screen.findByText("工单还没进入开发,暂无会话。");
    expect(screen.getByText("FIRST-INPUT").closest("[data-av-chat-transcript]")).not.toBeNull();
  });

  it("collapses secondary ticket cards and keeps Enter a newline in a phone viewport", async () => {
    vi.stubGlobal("matchMedia", vi.fn((media: string) => ({
      matches: media === "(max-width: 720px)",
      media,
      onchange: null,
      addEventListener(): void {},
      removeEventListener(): void {},
      addListener(): void {},
      removeListener(): void {},
      dispatchEvent: () => false,
    })));
    const stub = installStub();
    stub.setSession(44, transcriptOf("MOBILE-CHAT-BODY"));
    stub.setTicket(44, "sess-A", [
      { id: 1, author: "alice", via: "web", body: "已经进入上一轮", delivered_turn: 3 },
      { id: 2, author: "alice", via: "web", body: "手机端待送达命令", delivered_turn: null },
      { id: 3, author: "bob", via: "web", body: "另一位用户的待送达补充", delivered_turn: null },
    ]);
    const user = userEvent.setup();
    renderPage(<TicketsPage />, "/tickets");

    await user.click(await screen.findByRole("button", { name: /TITLE-44/ }));
    await screen.findByText("MOBILE-CHAT-BODY");
    expect(screen.queryByText("工单信息与操作")).toBeNull();
    expect(screen.queryByRole("button", { name: /需求与工单对话/ })).toBeNull();
    expect(screen.queryByText("开发 agent 会话")).toBeNull();
    expect(screen.getByLabelText("工单状态")).toBeInTheDocument();
    const pending = document.querySelector("[data-av-chat-transcript]")!;
    expect(pending.querySelectorAll("[data-ticket-input]")).toHaveLength(2);
    expect(pending).toHaveTextContent("alice via web");
    expect(pending).toHaveTextContent("手机端待送达命令");
    expect(pending).toHaveTextContent("bob via web");
    expect(pending).toHaveTextContent("另一位用户的待送达补充");
    expect(pending).not.toHaveTextContent("已经进入上一轮");

    const composer = screen.getByLabelText("给这张工单发消息");
    // Ticket #180: the phone placeholder has to fit one line, so the long
    // explanation only belongs to the wide layout.
    expect(composer).toHaveAttribute("placeholder", "给 agent 发消息…");

    // Keep the controlled value update and submit gesture as distinct browser
    // events. `user.type("…{Enter}")` lets its synthetic keystroke queue race
    // React's final Ant TextArea state flush on a loaded runner, so the Enter
    // handler can observe the previous empty draft even though the production
    // contract is explicitly change-then-keydown.
    fireEvent.change(composer, { target: { value: "手机补充" } });
    // A ticket message is a brief, not a chat line: Enter writes a newline even
    // here, and only the explicit gesture sends. Sending on the paragraph break
    // loses the draft AND wakes an agent turn on half a thought.
    fireEvent.keyDown(composer, { key: "Enter" });
    await Promise.resolve();
    expect(stub.actionCalls).not.toContainEqual({
      path: "/api/tickets/44/message",
      method: "POST",
    });
    expect(composer).toHaveValue("手机补充"); // draft intact, nothing was consumed

    fireEvent.keyDown(composer, { key: "Enter", metaKey: true });
    await waitFor(() => {
      expect(stub.actionCalls).toContainEqual({
        path: "/api/tickets/44/message",
        method: "POST",
      });
    });
    expect(screen.getAllByText("📨 已提交，等待发送确认").length).toBeGreaterThan(0);
  });

  it("reports whether a phone message entered the running turn or remains pending", async () => {
    vi.stubGlobal("matchMedia", vi.fn((media: string) => ({
      matches: media === "(max-width: 720px)",
      media,
      onchange: null,
      addEventListener(): void {},
      removeEventListener(): void {},
      addListener(): void {},
      removeListener(): void {},
      dispatchEvent: () => false,
    })));
    const stub = installStub();
    stub.setSession(44, transcriptOf("RUNNING-CHAT"));
    stub.setTicketRow(44, { session_id: "sess-A", turn_started_at: "2026-08-17T00:00:00Z" });
    stub.setActionResponse("/api/tickets/44/message", {
      ok: true,
      message: { id: 4402, delivered_turn: 7, delivery_state: "delivered", delivery_input: JSON.stringify({ phase: "provider_accepted", evidence: "provider_ack" }) },
    });

    const user = userEvent.setup();
    renderPage(<TicketsPage />, "/tickets");
    await user.click(await screen.findByRole("button", { name: /TITLE-44/ }));
    const composer = await screen.findByLabelText("给这张工单发消息");
    // Keep the controlled change and submit gesture as distinct browser
    // events, matching the phone-composer regression above.
    fireEvent.change(composer, { target: { value: "立刻改方向" } });
    expect(composer).toHaveValue("立刻改方向");
    await user.click(screen.getByRole("button", { name: "发送" }));

    const accepted = await screen.findByText("✓ Agent 已接收输入");
    expect(accepted).toHaveAttribute("aria-busy", "false");
    expect(accepted.closest(".av-chat-pending")).toBeNull();

    stub.setActionResponse("/api/tickets/44/message", {
      ok: true,
      message: { id: 4403, delivered_turn: null },
    });
    fireEvent.change(composer, { target: { value: "下一条只能排队" } });
    expect(composer).toHaveValue("下一条只能排队");
    await user.click(screen.getByRole("button", { name: "发送" }));
    expect(await screen.findByText("📨 已提交，等待发送确认"))
      .toBeInTheDocument();
  });

  it("echoes before acknowledgement and never retries an uncertain send after switching tickets", async () => {
    const stub = installStub(); stub.setSession(44, transcriptOf("CHAT"));
    const held = stub.holdMessage(44);
    const user = userEvent.setup(); renderPage(<TicketsPage />, "/tickets");
    await user.click(await screen.findByRole("button", { name: /TITLE-44/ }));
    fireEvent.change(await screen.findByLabelText("给这张工单发消息"), { target: { value: "ONE-SEND" } });
    await user.click(screen.getByRole("button", { name: "发送" }));
    expect(within(document.querySelector<HTMLElement>("[data-av-chat-transcript]")!).getByText("ONE-SEND")).toBeInTheDocument();
    expect(screen.getByText("⏳ 发送中…")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /TITLE-45/ }));
    await act(async () => held.reject(new Error("lost ack")));
    expect(screen.queryByText("ONE-SEND")).toBeNull();
    await user.click(screen.getByRole("button", { name: /TITLE-44/ }));
    expect(await screen.findByText("? 结果未知")).toBeInTheDocument();
    expect(screen.getByText("查看发送详情").closest("details")).not.toHaveAttribute("open");
    await user.click(screen.getByText("查看发送详情"));
    await user.click(screen.getByRole("button", { name: "放回输入框" }));
    expect(screen.getByLabelText("给这张工单发消息")).toHaveValue("ONE-SEND");
    expect(stub.actionCalls.filter((row) => row.path === "/api/tickets/44/message" && row.method === "POST")).toHaveLength(1);
  });

  it("treats an over-budget message (413) as refused and puts it back in the composer", async () => {
    const stub = installStub(); stub.setSession(44, transcriptOf("CHAT"));
    stub.failAction("/api/tickets/44/message", "工单消息为 409600 字节（UTF-8），超过会话 prompt 预算 393216 字节（384 KiB）", 413);
    const user = userEvent.setup(); renderPage(<TicketsPage />, "/tickets");
    await user.click(await screen.findByRole("button", { name: /TITLE-44/ }));
    fireEvent.change(await screen.findByLabelText("给这张工单发消息"), { target: { value: "TOO-LONG" } });
    await user.click(screen.getByRole("button", { name: "发送" }));
    // Answered before anything was written: a refusal, never "may have arrived".
    await waitFor(() => expect(screen.getByLabelText("给这张工单发消息")).toHaveValue("TOO-LONG"));
    expect(screen.queryByText("? 结果未知")).toBeNull();
  });

  it("continues retained input only after the paused turn has stopped", async () => {
    const stub = installStub(); stub.setSession(44, transcriptOf("PAUSED-CHAT"));
    stub.setTicketRow(44, { session_id: "sess-A", chat_paused: 1 });
    stub.setActionResponse("/api/tickets/44/resume", { ok: true });
    const user = userEvent.setup(); renderPage(<TicketsPage />, "/tickets");
    await user.click(await screen.findByRole("button", { name: /TITLE-44/ }));
    expect(await screen.findByText("已暂停，消息和会话已保留")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "继续" }));
    expect(stub.actionCalls.filter((row) => row.path === "/api/tickets/44/resume" && row.method === "POST")).toHaveLength(1);
    expect(stub.actionCalls.some((row) => row.path.endsWith("/message") && row.method === "POST")).toBe(false);
  });

  it("drops a slow #A response even when the reader entered the New composer", async () => {
    // The identity-change every setSelected(null) has to trigger: opening
    // "➕ 新建工单" moves the selection to null. If that path did not bump
    // the generation, a late /session response from #A (whose fetch started
    // before the click) would find the guard slack and quietly write win /
    // activity / liveUrl behind the composer form. Nothing would show it, but
    // the moment the reader closed the composer the stale state would flash
    // — and worse, the liveUrl useEffect could spin an SSE up against #A
    // while the pane says "新建工单".
    const stub = installStub();
    stub.setSession(44, transcriptOf("A-BODY"));
    const held = stub.holdSession(44);

    const user = userEvent.setup();
    renderPage(<TicketsPage />, "/tickets");

    await user.click(await screen.findByRole("button", { name: /TITLE-44/ }));
    // A's fetch is in flight; the reader now opens the New form.
    await user.click(await screen.findByRole("button", { name: /新建工单/ }));
    expect(await screen.findByRole("heading", { name: "新建工单" })).toBeInTheDocument();
    // Ant Select keeps its submitted value in React state and paints the
    // selected option beside an empty search input. `toHaveValue` would only
    // inspect that implementation-detail search input, so assert what the
    // reader actually sees in the combobox instead. Ticket #428 moved the
    // server-advertised default to Codex; this assertion follows that roster.
    expect(screen.getByRole("combobox", { name: "模型" }).closest(".ant-select"))
      .toHaveTextContent("模型: Codex · GPT 5.6-sol");
    // A's response finally arrives.
    held.resolve(transcriptOf("A-BODY"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The composer is still up and untouched.
    expect(screen.getByRole("heading", { name: "新建工单" })).toBeInTheDocument();
    expect(screen.queryByText("A-BODY")).toBeNull();
    // And closing the composer must not reveal a stale transcript underneath.
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.getByText("从左侧选择一个工单,或新建一个。")).toBeInTheDocument();
    expect(screen.queryByText("A-BODY")).toBeNull();
  });
});

/**
 * Ticket #184. The ticket lane's agent is a headless CLI child this process
 * holds, so "stop" is a real, separate act from "cancel the ticket" — and it
 * has to be one press away from the box the reader is already typing in.
 */
describe("stopping the running turn", () => {
  beforeEach(() => {
    (bootstrap as { pageProps: unknown; viewer: unknown }).pageProps = {};
    (bootstrap as { viewer: { username: string; admin: boolean } }).viewer = {
      username: "alice",
      admin: false,
    };
  });

  it("shows an offline wait with a pause action even before a provider turn starts", async () => {
    const stub = installStub();
    stub.setTicketRow(44, { session_id: "sess-A", runtime_wait: {
      state: "waiting_resource", resource: "runner:alice/compute", since: "2026-09-16T00:00:00Z", retry_at: null,
    } });
    stub.setSession(44, transcriptOf("previous capacity failure"));
    renderPage(<TicketsPage />, "/tickets");
    await userEvent.setup().click(await screen.findByRole("button", { name: /TITLE-44/ }));
    expect(await screen.findByTestId("ticket-resource-wait")).toHaveTextContent("超过 1 分钟未恢复");
    expect(screen.getByTestId("ticket-resource-wait")).toHaveTextContent("alice/compute");
    expect(screen.getByRole("button", { name: /停止这一轮/ })).toBeEnabled();
    act(() => applyLanguage("en"));
    expect(screen.getByTestId("ticket-resource-wait")).toHaveTextContent("Waiting for recovery");
  });

  it("offers nothing to stop while the agent is idle", async () => {
    const stub = installStub();
    stub.setSession(44, transcriptOf("已完成"));

    const user = userEvent.setup();
    renderPage(<TicketsPage />, "/tickets");
    await user.click(await screen.findByRole("button", { name: /TITLE-44/ }));

    expect(await screen.findByLabelText("给这张工单发消息")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /停止这一轮/ })).toBeNull();
  });

  it("stops the turn from beside the send box without cancelling the ticket", async () => {
    const stub = installStub();
    stub.setSession(44, transcriptOf("正在做"));
    stub.setTicketRow(44, { session_id: "sess-A", turn_started_at: "2026-08-16T02:00:00Z" });
    stub.setActionResponse("/api/tickets/44/interrupt", { ok: true });

    const user = userEvent.setup();
    renderPage(<TicketsPage />, "/tickets");
    await user.click(await screen.findByRole("button", { name: /TITLE-44/ }));

    await user.click(await screen.findByRole("button", { name: /停止这一轮/ }));
    await waitFor(() =>
      expect(stub.actionCalls).toContainEqual({ path: "/api/tickets/44/interrupt", method: "POST" }),
    );
    // Stopping a turn must never reach the endpoint that ends the ticket.
    expect(stub.actionCalls.some((call) => call.path === "/api/tickets/44/cancel")).toBe(false);
    expect(await screen.findByText(/worktree 与会话都保留/)).toBeInTheDocument();
  });

  it("hides the control from a reader who may not steer this ticket", async () => {
    const stub = installStub();
    stub.setSession(44, transcriptOf("正在做"));
    stub.setTicketRow(44, {
      session_id: "sess-A",
      turn_started_at: "2026-08-16T02:00:00Z",
      requester: "bob",
    });

    const user = userEvent.setup();
    renderPage(<TicketsPage />, "/tickets");
    await user.click(await screen.findByRole("button", { name: /TITLE-44/ }));

    expect(await screen.findByLabelText("给这张工单发消息")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /停止这一轮/ })).toBeNull();
  });
});

/**
 * Ticket #190 made the compact layout usable. Ticket #322 removes the same
 * redundant progress banner from the wide layout; the actionable liveness row
 * remains beside the composer in both layouts.
 */
function stubViewport(compact: boolean) {
  vi.stubGlobal("matchMedia", vi.fn((media: string) => ({
    matches: compact && media === "(max-width: 720px)",
    media,
    onchange: null,
    addEventListener(): void {},
    removeEventListener(): void {},
    addListener(): void {},
    removeListener(): void {},
    dispatchEvent: () => false,
  })));
}

describe("the ticket chat across layouts", () => {
  beforeEach(() => {
    (bootstrap as { pageProps: unknown; viewer: unknown }).pageProps = {};
    (bootstrap as { viewer: { username: string; admin: boolean } }).viewer = {
      username: "alice",
      admin: false,
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([false, true])("offers reversible completion for an idle owner (compact=%s)", async (compact) => {
    stubViewport(compact);
    const stub = installStub();
    stub.setSession(44, transcriptOf("acceptance passed"));
    stub.setActionResponse("/api/tickets/44/complete", { ok: true });
    const user = userEvent.setup();
    renderPage(<TicketsPage />, "/tickets");
    await user.click(await screen.findByRole("button", { name: /TITLE-44/ }));
    const complete = await screen.findByRole("button", { name: "标记完成" });
    await user.click(complete);
    expect(stub.actionCalls.filter((call) => call.method === "POST" && call.path.endsWith("/complete"))).toHaveLength(1);
    expect(stub.actionCalls.some((call) => call.method === "POST" && call.path.endsWith("/cancel"))).toBe(false);
  });

  it("shows a queued ticket as waiting for dispatch and does not offer completion", async () => {
    stubViewport(false);
    const stub = installStub();
    stub.setTickets([{ ...ticketRow({ id: 44, session_id: null }), unread: 1 }]);
    stub.setTicketRow(44, { session_id: null });
    stub.setSession(44, PENDING_NO_SESSION);
    const user = userEvent.setup();
    renderPage(<TicketsPage />, "/tickets");
    await user.click(await screen.findByRole("button", { name: /TITLE-44/ }));
    expect(await screen.findByText(/排队中：/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "标记完成" })).toBeNull();
    expect(screen.queryByText(/尚未落盘|日志还没落盘/)).toBeNull();
  });

  it("waits for a pasted upload before sending the ticket message", async () => {
    stubViewport(false);
    vi.stubGlobal("URL", class extends URL { static createObjectURL = () => "blob:ticket-image"; static revokeObjectURL = () => {}; });
    const stub = installStub();
    stub.setSession(44, transcriptOf("ready"));
    const upload = stub.holdUpload();
    const user = userEvent.setup();
    renderPage(<TicketsPage />, "/tickets");
    await user.click(await screen.findByRole("button", { name: /TITLE-44/ }));
    const input = await screen.findByRole("textbox", { name: "给这张工单发消息" });
    fireEvent.change(input, { target: { value: "inspect this image" } });
    expect(input).toHaveValue("inspect this image");
    const file = new File(["image"], "capture.png", { type: "image/png" });
    fireEvent.paste(input, { clipboardData: { items: [{ kind: "file", type: "image/png", getAsFile: () => file }] } });
    await user.click(screen.getByRole("button", { name: "发送" }));
    expect(input).toHaveValue("inspect this image");
    expect(stub.actionCalls.some((call) => call.path.endsWith("/message") && call.method === "POST")).toBe(false);
    await act(async () => upload.resolve({ attachment: { path: "/workspace/capture.png", bytes: 5, media_type: "image/png" } }));
    await waitFor(() => expect(stub.actionBodies.some((call) => call.path.endsWith("/message") && call.body.includes("/workspace/capture.png"))).toBe(true));
  });

  it("does not send or carry a late upload into a different ticket", async () => {
    stubViewport(false);
    vi.stubGlobal("URL", class extends URL { static createObjectURL = () => "blob:ticket-image"; static revokeObjectURL = () => {}; });
    const stub = installStub();
    stub.setSession(44, transcriptOf("ready"));
    const upload = stub.holdUpload();
    const user = userEvent.setup();
    renderPage(<TicketsPage />, "/tickets");
    await user.click(await screen.findByRole("button", { name: /TITLE-44/ }));
    const input = await screen.findByRole("textbox", { name: "给这张工单发消息" });
    fireEvent.change(input, { target: { value: "keep my original draft" } });
    expect(input).toHaveValue("keep my original draft");
    const file = new File(["image"], "late-capture.png", { type: "image/png" });
    fireEvent.paste(input, { clipboardData: { items: [{ kind: "file", type: "image/png", getAsFile: () => file }] } });
    await user.click(screen.getByRole("button", { name: "发送" }));
    await user.click(screen.getByRole("button", { name: /TITLE-45/ }));
    await act(async () => upload.resolve({ attachment: { path: "/workspace/late.png", bytes: 5, media_type: "image/png" } }));
    expect(stub.actionCalls.some((call) => call.path.endsWith("/message") && call.method === "POST")).toBe(false);
    expect(screen.queryByText("late-capture.png")).toBeNull();
    await user.click(screen.getByRole("button", { name: /TITLE-44/ }));
    expect(await screen.findByRole("textbox", { name: "给这张工单发消息" })).toHaveValue("keep my original draft");
  });

  it("shows a provider acceptance receipt before a transcript exists", async () => {
    stubViewport(false);
    const stub = installStub();
    stub.setTicketRow(44, { session_id: null, turn_started_at: "2026-09-15T07:00:00Z" });
    stub.setSession(44, { pending: true, running: true,
      execution: { operation_id: "ticket-op", state: "running", input: { phase: "provider_accepted" }, observed_at: "2026-09-15T07:00:01Z" },
      transcript_notice: "Agent 正在运行；会话记录暂不可读。" });
    const user = userEvent.setup();
    renderPage(<TicketsPage />, "/tickets");
    await user.click(await screen.findByRole("button", { name: /TITLE-44/ }));
    expect(await screen.findByText("Agent 已接受输入，正在执行这一轮")).toBeInTheDocument();
    expect(screen.getByText("Agent 正在运行；会话记录暂不可读。")).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: /TITLE-45/ }));
    expect(screen.queryByText("Agent 已接受输入，正在执行这一轮")).toBeNull();
  });

  it("shows an unknown turn outcome as finished, with what to do, instead of a wait", async () => {
    stubViewport(false);
    const stub = installStub();
    stub.setSession(44, { ...transcriptOf("LAST-KNOWN"),
      execution: { operation_id: "ticket-op", state: "unknown", observed_at: "2026-09-15T07:00:01Z" } });
    const user = userEvent.setup();
    renderPage(<TicketsPage />, "/tickets");
    await user.click(await screen.findByRole("button", { name: /TITLE-44/ }));
    expect(await screen.findByText("? Agent 本轮结果未知")).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent("不会自动重试。请先查看会话记录，需要时再发一条消息继续。");
    expect(screen.queryByText(/暂不确定/)).toBeNull();
    expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
    act(() => applyLanguage("en"));
    expect(screen.getByText("? Agent turn outcome unknown")).toBeInTheDocument();
  });

  it("does not treat an ordinary final reply as a question requiring a response", async () => {
    stubViewport(false);
    const stub = installStub();
    stub.setTickets([{ ...ticketRow({ id: 44, session_id: "sess-A" }), last_author: "agent" }]);
    stub.setSession(44, transcriptOf("acceptance passed"));
    renderPage(<TicketsPage />, "/tickets");
    const row = await screen.findByRole("button", { name: /TITLE-44/ });
    expect(row.textContent).toContain("本轮已结束");
    expect(screen.queryByText(/🙋 等你回复/)).toBeNull();
  });

  it("says a turn is running once — in the send box, not in a banner above the chat", async () => {
    stubViewport(true);
    const stub = installStub();
    stub.setSession(44, transcriptOf("MOBILE-BODY"));
    stub.setTicketRow(44, { session_id: "sess-A", turn_started_at: "2026-08-16T02:00:00Z" });

    const user = userEvent.setup();
    renderPage(<TicketsPage />, "/tickets");
    await user.click(await screen.findByRole("button", { name: /TITLE-44/ }));

    // The liveness is still on screen, attached to the control that acts on it.
    expect(await screen.findByText("agent 正在执行这一轮")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "开发 agent 实时进度" })).toBeNull();
    expect(screen.queryByText(/开发 agent 正在工作/)).toBeNull();
  });

  it("keeps running-turn liveness by the composer without a wide progress banner", async () => {
    stubViewport(false);
    const stub = installStub();
    stub.setSession(44, transcriptOf("DESK-BODY"));
    stub.setTicketRow(44, { session_id: "sess-A", turn_started_at: "2026-08-16T02:00:00Z" });

    const user = userEvent.setup();
    renderPage(<TicketsPage />, "/tickets");
    await user.click(await screen.findByRole("button", { name: /TITLE-44/ }));

    expect(await screen.findByText("agent 正在执行这一轮")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "开发 agent 实时进度" })).toBeNull();
    expect(screen.queryByText(/开发 agent 正在工作/)).toBeNull();
  });

  it("ends an open ticket from beside the send button, through the usual confirmation", async () => {
    stubViewport(true);
    const stub = installStub();
    stub.setSession(44, transcriptOf("等你回复"));
    stub.setActionResponse("/api/tickets/44/cancel", { ok: true });

    const user = userEvent.setup();
    renderPage(<TicketsPage />, "/tickets");
    await user.click(await screen.findByRole("button", { name: /TITLE-44/ }));

    await user.click(await screen.findByRole("button", { name: /关单/ }));
    // Ending a ticket stays a two-step act on a phone too: the button is small
    // and sits next to 发送, which is exactly why it must not be a one-tap end.
    await user.click(await screen.findByRole("button", { name: "取消工单" }));
    await waitFor(() =>
      expect(stub.actionCalls).toContainEqual({ path: "/api/tickets/44/cancel", method: "POST" }),
    );
  });

  it("offers nothing to close once the ticket has left `open`", async () => {
    stubViewport(true);
    const stub = installStub();
    stub.setSession(44, transcriptOf("已合入"));
    stub.setTicketRow(44, { session_id: "sess-A", dev_status: "landed" });

    const user = userEvent.setup();
    renderPage(<TicketsPage />, "/tickets");
    await user.click(await screen.findByRole("button", { name: /TITLE-44/ }));

    expect(await screen.findByLabelText("给这张工单发消息")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /关单/ })).toBeNull();
  });

  it("hides it from a reader who may not steer the ticket", async () => {
    stubViewport(true);
    const stub = installStub();
    stub.setSession(44, transcriptOf("别人的工单"));
    stub.setTicketRow(44, { session_id: "sess-A", requester: "bob" });

    const user = userEvent.setup();
    renderPage(<TicketsPage />, "/tickets");
    await user.click(await screen.findByRole("button", { name: /TITLE-44/ }));

    expect(await screen.findByLabelText("给这张工单发消息")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /关单/ })).toBeNull();
  });

  it("does not add a second lifecycle button to the wide layout", async () => {
    stubViewport(false);
    const stub = installStub();
    stub.setSession(44, transcriptOf("DESK-BODY"));

    const user = userEvent.setup();
    renderPage(<TicketsPage />, "/tickets");
    await user.click(await screen.findByRole("button", { name: /TITLE-44/ }));

    // The desk keeps its own visible lifecycle bar; a phone-shaped duplicate
    // beside 发送 would be two ways to end the same ticket on one screen.
    expect(await screen.findByRole("button", { name: /取消工单/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /关单/ })).toBeNull();
  });
});

/**
 * Live follow says what the connection is, and a failed read never unloads a
 * transcript already on screen (review B15).
 */
describe("ticket live follow", () => {
  beforeEach(() => {
    (bootstrap as { pageProps: unknown; viewer: unknown }).pageProps = {};
    (bootstrap as { viewer: { username: string; admin: boolean } }).viewer = { username: "alice", admin: false };
  });

  class LiveSource {
    static all: LiveSource[] = [];
    readonly listeners: Record<string, Array<(event: MessageEvent) => void>> = {};
    readyState = 0;
    closed = false;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(readonly url: string) { LiveSource.all.push(this); }
    addEventListener(name: string, fn: (event: MessageEvent) => void) { (this.listeners[name] ??= []).push(fn); }
    removeEventListener(name: string, fn: (event: MessageEvent) => void) {
      this.listeners[name] = (this.listeners[name] ?? []).filter((item) => item !== fn);
    }
    close() { this.closed = true; this.readyState = 2; }
    emit(name: string, data: string) { act(() => { for (const fn of this.listeners[name] ?? []) fn({ data } as MessageEvent); }); }
  }
  const current = () => LiveSource.all.filter((source) => !source.closed).at(-1)!;
  const chip = () => document.querySelector<HTMLElement>("[data-live-status]");

  async function openFollowedTicket() {
    LiveSource.all = [];
    vi.stubGlobal("EventSource", LiveSource);
    const stub = installStub();
    stub.setSession(44, transcriptOf("LOADED-BODY"));
    const user = userEvent.setup();
    renderPage(<TicketsPage />, "/tickets");
    await user.click(await screen.findByRole("button", { name: /TITLE-44/ }));
    await waitFor(() => expect(screen.getByText("LOADED-BODY")).toBeInTheDocument());
    await waitFor(() => expect(current().url).toContain("/api/tickets/44/live?from=1"));
    return stub;
  }

  it("claims to follow only while the stream is open and says when it dropped", async () => {
    await openFollowedTicket();
    expect(chip()).toHaveTextContent("○ 正在连接实时跟随…");
    act(() => current().onopen?.());
    expect(chip()).toHaveTextContent("● 实时跟随中");

    // A non-200 answer: the browser closed the stream for good.
    const refused = current();
    act(() => { refused.readyState = 2; refused.onerror?.(); });
    expect(chip()).toHaveTextContent("○ 实时跟随已断开，正在重连…");
    expect(chip()).toHaveAttribute("data-live-status", "reconnecting");
    expect(screen.getByText("LOADED-BODY")).toBeInTheDocument();
  });

  it("keeps the loaded transcript and marks it stale when a later read fails", async () => {
    const stub = await openFollowedTicket();
    act(() => current().onopen?.());
    stub.setSession(44, null);
    // A frame that does not continue the window forces a full re-read.
    current().emit("delta", JSON.stringify({ from: 40, messages: [], total: 41 }));
    expect(await screen.findByText(/刷新失败，显示的是 .* 的数据/)).toBeInTheDocument();
    expect(screen.getByText("LOADED-BODY")).toBeInTheDocument();

    stub.setSession(44, transcriptOf("RECOVERED-BODY"));
    current().emit("delta", JSON.stringify({ from: 40, messages: [], total: 41 }));
    await waitFor(() => expect(screen.getByText("RECOVERED-BODY")).toBeInTheDocument());
    expect(screen.queryByText(/刷新失败/)).toBeNull();
  });

  it("states why the server ended the stream instead of dropping the chip", async () => {
    await openFollowedTicket();
    act(() => current().onopen?.());
    current().emit("err", JSON.stringify({ error: "权限已变更,实时流已断开" }));
    await waitFor(() => expect(chip()).toHaveTextContent("○ 实时跟随已停止：权限已变更,实时流已断开"));
    expect(LiveSource.all.every((source) => source.closed)).toBe(true);
    expect(screen.getByText("LOADED-BODY")).toBeInTheDocument();
  });
});
