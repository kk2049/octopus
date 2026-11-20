import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { bootstrap } from "../lib/bootstrap.js";
import { renderPage, stubApi } from "../test-utils.js";
import { KnowledgePage } from "./KnowledgePage.js";
import type { WikiArtifactHealth, WikiCapabilityView, WikiConflict, WikiConflictWorkspace, WikiGraphView, WikiKnowledgeChatDetail, WikiNodeView, WikiOverview, WikiRetrievalReviewList, WikiRetrievalTraceDetail, WikiReviewView } from "./knowledge/types.js";

it("shows zero-query tickets and separates all successful traces from the attention queue", async () => {
  const traceId = `kr_${"6".repeat(32)}`;
  const row: WikiRetrievalReviewList["items"][number] = {
    trace_id: traceId, lane: "ticket", purpose: "path_refinement", subject_ref: "ticket:42", turn: 2,
    repo_sha: "a".repeat(40), started_at: "2026-09-16T05:00:00.000Z", expires_at: "2026-10-16T05:00:00.000Z",
    outcome: "assembled", unknown_codes: [], feedback_codes: [],
  };
  const calls: URL[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://dashboard.test");
    calls.push(url);
    const body = url.pathname === "/api/knowledge" ? overview
      : url.pathname === "/api/knowledge/review" ? review
      : url.pathname === "/api/knowledge/health" ? artifactHealth
      : url.pathname === "/api/knowledge/retrieval" ? { ...row, graph_input_fingerprint: "b".repeat(64), events: [], events_total: 0, events_has_more: false }
      : url.searchParams.get("view") === "tickets" ? {
        items: [
          { ticket_id: 43, title: "No retained queries", dev_status: "open", startup: 0, path_queries: 0, delivered_queries: 0, submit_checks: 0, cited_records: 0, feedback: 0, last_query_at: null },
          { ticket_id: 42, title: "Successful query", dev_status: "open", startup: 1, path_queries: 1, delivered_queries: 1, submit_checks: 0, cited_records: 0, feedback: 0, last_query_at: row.started_at },
        ], limit: 50, has_more: false,
      } : { items: url.searchParams.get("outcome") === "all" ? [row] : [], limit: 50, has_more: false };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  renderPage(<KnowledgePage />, "/knowledge?v=review&tab=retrieval");
  const table = await screen.findByRole("table", { name: "工单知识查询与引用" });
  expect(within(table).getByText(/No retained queries/)).toBeInTheDocument();
  expect(within(table).getByRole("button", { name: "查看工单 #43 的追踪" })).toHaveTextContent("0");
  expect(screen.getByText(/无记录不等于从未查询/)).toBeInTheDocument();
  expect(calls.filter((url) => url.pathname === "/api/knowledge/retrievals")).toHaveLength(1);
  await userEvent.click(within(table).getByRole("button", { name: "查看工单 #42 的追踪" }));
  const select = await screen.findByRole("button", { name: new RegExp(traceId) });
  expect(calls.some((url) => url.searchParams.get("ticket_id") === "42" && url.searchParams.get("outcome") === "all")).toBe(true);
  await userEvent.click(select);
  expect(await screen.findByRole("heading", { name: traceId })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "清除工单筛选" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "缺失、错误与反馈" }));
  expect(await screen.findByText("当前范围没有保留的追踪记录。")).toBeInTheDocument();
  expect(calls.filter((url) => url.pathname === "/api/knowledge/retrievals").at(-1)!.searchParams.has("outcome")).toBe(false);
  await userEvent.click(screen.getByRole("button", { name: "全部追踪" }));
  expect(await screen.findByRole("button", { name: new RegExp(traceId) })).toBeInTheDocument();
});

const overview: WikiOverview = {
  generated: true,
  meta: { commit: "abc1234abc1234", built_at: "2026-08-21T07:00:00.000Z", nodes: 12, edges: 20, byKind: {} },
  capabilities: [
    {
      id: "web.navigation",
      kind: "product",
      label: "导航",
      description: "Menu and routing",
      modules: 1,
      counts: { principle: 1, constraint: 1, decision: 1, requirement: 0, non_goal: 1, risk: 0, pattern: 1, landing: 1 },
      direct: 3,
    },
    {
      id: "concern.stability",
      kind: "concern",
      label: "稳定性",
      description: "State survives refresh",
      modules: 1,
      counts: { principle: 0, constraint: 0, decision: 0, requirement: 0, non_goal: 0, risk: 0, pattern: 0, landing: 0 },
      direct: 0,
    },
  ],
  review: { conflictsOpen: 1, conflictsDismissed: 0, conflictsConfirmed: 0, ambiguous: 1, adrLegacy: 0, adrPlanned: 1, staleAnchors: 0, unmappedModules: 1, emptyCapabilities: 1, ticketsWithoutKnowledge: 2 },
  landings: [],
};

const artifactHealth: WikiArtifactHealth = {
  configured: true,
  status: "degraded",
  protocolAvailable: true,
  vectorSearchOnline: true,
  active: {
    repoSha: "a".repeat(40),
    manifestDigest: "b".repeat(64),
    activatedAt: "2026-08-30T10:00:00.000Z",
    ageMs: 3_600_000,
    baselineRef: "v4",
    baselineSha: "c".repeat(40),
    commitsBehind: 2,
    baselineCheckedAt: "2026-08-30T11:00:00.000Z",
    evaluations: {
      journeys: { scope: "repository", executor: "dedicated-4090", state: "failed", startedAt: "2026-08-30T10:00:01.000Z", finishedAt: "2026-08-30T10:00:02.000Z", failureCode: "journeys_failed:J004", metrics: { recall_at_10: 0.7 } },
      vectorBenchmark: { state: "passed", startedAt: "2026-08-30T10:00:02.000Z", finishedAt: "2026-08-30T10:00:03.000Z", failureCode: null, metrics: { p95_ms: 12.4 } },
    },
  },
  task: { phase: "remote", remoteState: "running", reconcileStep: null },
  lastFailureCode: "conformance_failed:contracts",
  lastFailureAt: "2026-08-30T09:00:00.000Z",
  recentActivations: [
    {
      repoSha: "a".repeat(40),
      manifestDigest: "b".repeat(64),
      activatedAt: "2026-08-30T10:00:00.000Z",
      evaluations: {
        journeys: { state: "failed", startedAt: "2026-08-30T10:00:01.000Z", finishedAt: "2026-08-30T10:00:02.000Z", failureCode: "journeys_failed:J004", metrics: { recall_at_10: 0.7 } },
        vectorBenchmark: { state: "passed", startedAt: "2026-08-30T10:00:02.000Z", finishedAt: "2026-08-30T10:00:03.000Z", failureCode: null, metrics: { p95_ms: 12.4 } },
      },
    },
  ],
};

const graph: WikiGraphView = {
  generated: true,
  meta: { commit: "abc1234abc1234", built_at: "2026-08-21T07:00:00.000Z" },
  nodes: [
    { id: "capability:web.navigation", kind: "capability", statement: "导航：Menu and routing", status: "active", authority: "declared", certainty: "exact", source_ref: "architecture/capabilities.json" },
    { id: "module:web", kind: "module", statement: "Web UI（web）", status: "active", authority: "declared", certainty: "exact", source_ref: "architecture/atlas.json" },
    { id: "decision:menu", kind: "decision", statement: "菜单只在点击时打开。", status: "active", authority: "curated", certainty: "exact", source_ref: "ticket:6" },
  ],
  edges: [
    { from_id: "capability:web.navigation", relation: "spans", to_id: "module:web", certainty: "exact" },
    { from_id: "decision:menu", relation: "about", to_id: "capability:web.navigation", certainty: "exact" },
  ],
};

const capability: WikiCapabilityView = {
  capability: { id: "capability:web.navigation", kind: "capability", statement: "导航：Menu and routing", status: "active", authority: "declared", certainty: "exact", source_ref: "architecture/capabilities.json", source_sha: "f", detail: {} },
  modules: [{ id: "module:web", kind: "module", statement: "Web UI（web）", status: "active", authority: "declared", certainty: "exact", source_ref: "architecture/atlas.json", source_sha: "f", detail: { zone: "browser" } }],
  constraints: [{ id: "constraint:TRUST-001", kind: "constraint", statement: "Web must not import the API（TRUST-001）", status: "active", authority: "declared", certainty: "exact", source_ref: "architecture/atlas.json", source_sha: "f", detail: { commands: ["npx vitest run packages/web/dep.test.ts"] } }],
  principles: [{ id: "principle:p1", kind: "principle", statement: "Selection is keyed by resourceId.", status: "active", authority: "path_rule", certainty: "exact", source_ref: ".claude/rules/frontend.md#state:12", source_sha: "f", detail: {} }],
  decisions: [{ id: "decision:cur:b01:6:1", kind: "decision", statement: "菜单只在点击时打开。", status: "active", authority: "curated", certainty: "exact", source_ref: "ticket:6#message:30", source_sha: "f", valid_from: "2026-08-06T00:00:00.000Z", detail: { ticket: 6, quote: "只在点击时打开", origins: [{ ticket: 6, requester: "bob", role: "task_evolution" }] } }],
  requirements: [],
  nonGoals: [{ id: "non_goal:ng1", kind: "non_goal", statement: "不给菜单增加悬停预览。", status: "historical", authority: "record", certainty: "exact", source_ref: "doc/deliveries/2026-08-02-menu.md#没改什么:20", source_sha: "f", detail: {} }],
  risks: [],
  patterns: [],
  landings: [],
  docs: ["packages/web/CLAUDE.md"],
  unknown: [],
};

const review: WikiReviewView = {
  conflicts: [
    {
      id: "non_goal_vs_requirement:non_goal:ng1:requirement:r1",
      rule: "non_goal_vs_requirement",
      severity: "review",
      why: "overlap 0.52",
      object: capability.capability,
      explanation: "同一对象同时声明了“不做”和“需要做”。需要决定哪一个用户意图当前有效。",
      a: { ...capability.nonGoals[0], detail: { origins: [{ ticket: 6, requester: "bob", role: "task_evolution", actor_kind: "token" }] } },
      b: { id: "requirement:r1", kind: "requirement", statement: "给菜单增加悬停预览。", status: "active", authority: "curated", certainty: "ambiguous", source_ref: "ticket:5", source_sha: "f", detail: { ticket: 5, origins: [{ ticket: 5, requester: "alice", role: "user_requirement" }], conflict_note: "与 #6 相反" } },
      review: null,
    },
  ],
  ambiguous: [],
  adr: [],
  coverage: { modulesWithoutCapability: ["api"], emptyCapabilities: ["concern.stability"], ticketsWithoutKnowledge: { count: 2, sample: [7, 8] } },
};

const conflictWorkspace: WikiConflictWorkspace = {
  subject_id: review.conflicts[0]!.id,
  conflict: review.conflicts[0]!,
  review: null,
  annotations: [],
  terminal: false,
};

describe("KnowledgePage", () => {
  it("opens on the capability index with the review summary", async () => {
    stubApi({ "/api/knowledge/health": artifactHealth, "/api/knowledge": overview });
    renderPage(<KnowledgePage />, "/knowledge");
    expect(await screen.findByRole("heading", { name: "知识库" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "导航" })).toHaveAttribute("href", "/knowledge?v=capability&id=web.navigation");
    expect(screen.getByText(/1 个冲突候选待裁决/)).toBeInTheDocument();
    expect(screen.getByText("暂无直接关联记录。")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /需要裁决/ })).toHaveTextContent("2");
    const health = await screen.findByRole("region", { name: "知识产物健康" });
    expect(health).toHaveTextContent("落后 2 个提交");
    expect(health).toHaveTextContent("conformance_failed:contracts");
    expect(health).toHaveTextContent("向量检索在线");
    expect(health).toHaveTextContent("journeys_failed:J004");
    expect(health).toHaveTextContent("仓库范围评估，不含服务私有台账");
    expect(health).toHaveTextContent("dedicated-4090");
  });

  it("opens the full relation map and explores a node without mutating knowledge", async () => {
    stubApi({ "/api/knowledge/graph": graph, "/api/knowledge": overview });
    renderPage(<KnowledgePage />, "/knowledge?v=graph");
    expect(await screen.findByRole("heading", { name: "全量知识关系图" })).toBeInTheDocument();
    expect(screen.getByLabelText("关系图统计")).toHaveTextContent("3节点2边3类型");
    expect(screen.getByRole("img", { name: "知识关系图，显示 3 个节点与 2 条关系" })).toBeInTheDocument();
    await userEvent.type(screen.getByRole("searchbox", { name: "定位节点" }), "navigation");
    await userEvent.click(within(screen.getByLabelText("节点搜索结果")).getByRole("button", { name: /导航：Menu and routing/ }));
    expect(screen.getByRole("complementary", { name: "节点关系详情" })).toHaveTextContent("architecture/capabilities.json");
    expect(screen.getByRole("complementary", { name: "节点关系详情" })).toHaveTextContent("直接关系 2");
    expect(screen.getByRole("link", { name: "打开完整节点页 →" })).toHaveAttribute("href", "/knowledge?v=node&id=capability%3Aweb.navigation");
    expect(screen.queryByRole("button", { name: /保存|编辑|删除/ })).not.toBeInTheDocument();
  });

  it("renders a capability's reading list with sources and a filterable statement list", async () => {
    stubApi({ "/api/knowledge/capability": capability, "/api/knowledge": overview });
    renderPage(<KnowledgePage />, "/knowledge?v=capability&id=web.navigation");
    expect(await screen.findByRole("heading", { name: "导航" })).toBeInTheDocument();
    expect(screen.getByText("Selection is keyed by resourceId.")).toBeInTheDocument();
    expect(screen.getByText("frontend.md:12")).toBeInTheDocument();
    expect(screen.getByText("npx vitest run packages/web/dep.test.ts")).toBeInTheDocument();
    expect(screen.getByText("菜单只在点击时打开。")).toBeInTheDocument();
    expect(screen.getByText("不给菜单增加悬停预览。")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "决策" }));
    expect(screen.queryByText("不给菜单增加悬停预览。")).not.toBeInTheDocument();
    expect(screen.getByText("菜单只在点击时打开。")).toBeInTheDocument();
  });

  it("renders a busy node's whole relation group behind an explicit show-all", async () => {
    const neighbours = Array.from({ length: 75 }, (_, index) => ({
      ...capability.decisions[0]!, id: `decision:bulk:${index}`, statement: `批量决策 ${index}`,
    }));
    const nodeView: WikiNodeView = {
      repair_fingerprint: "",
      node: capability.capability,
      out: [],
      in: [{ relation: "about", nodes: neighbours, total: 75 }],
      conflicts: [],
    };
    stubApi({ "/api/knowledge/node": nodeView, "/api/knowledge": overview });
    renderPage(<KnowledgePage />, "/knowledge?v=node&id=capability%3Aweb.navigation");
    expect(await screen.findByText("批量决策 0")).toBeInTheDocument();
    expect(screen.getByText("批量决策 59")).toBeInTheDocument();
    expect(screen.queryByText("批量决策 60")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "显示全部 75 条" }));
    expect(screen.getByText("批量决策 74")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "收起" })).toBeInTheDocument();
  });

  it("shows provenance, saves annotations on Enter, and links discussion to Knowledge Chat", async () => {
    bootstrap.viewer = { username: "alice", admin: false, dev: true, deploy: false, contribute: true, session: true };
    const subject = review.conflicts[0]!.id;
    const stub = stubApi({
      "/api/knowledge/conflict/annotate": { ok: true, annotation: { id: 1, body: "保留原始需求", actor: "alice", at: "2026-08-21T08:00:00.000Z" } },
      "/api/knowledge/conflict": conflictWorkspace,
      "/api/knowledge/review": review,
      "/api/knowledge": overview,
    });
    const user = userEvent.setup();
    renderPage(<KnowledgePage />, "/knowledge?v=review&tab=malformed");

    expect(await screen.findByRole("heading", { name: "导航：Menu and routing" })).toBeInTheDocument();
    expect(screen.getByText("用户 alice · 工单 #5")).toBeInTheDocument();
    expect(screen.getByText("源自 bob 的工单 #6")).toBeInTheDocument();
    // #6 was filed through a key, not typed by bob; #5 predates the record and shows nothing.
    expect(screen.getAllByTestId("origin-actor-kind").map((node) => node.textContent)).toEqual([" · 脚本/令牌提交"]);
    expect(screen.getByRole("button", { name: /冲突候选/ })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "在知识 Chat 中讨论" })).toHaveAttribute(
      "href",
      `/knowledge?v=chat&chat=new&subject=${encodeURIComponent(subject)}`,
    );

    const annotation = await screen.findByPlaceholderText(/Enter 保存/);
    await user.type(annotation, "保留原始需求");
    await user.keyboard("{Enter}");
    await waitFor(() => {
      const call = stub.calls.find((item) => item.url.startsWith("/api/knowledge/conflict/annotate"));
      expect(call?.init?.method).toBe("POST");
      expect(JSON.parse(String(call?.init?.body))).toEqual({ subject_id: subject, body: "保留原始需求" });
    });
    expect(stub.calls.filter((item) => item.url.startsWith("/api/knowledge/conflict/annotate"))).toHaveLength(1);
  });

  it("approves a blocking conflict with one explicit confirmation and an optional note", async () => {
    bootstrap.viewer = { username: "lht", admin: true, dev: true, deploy: true, contribute: true, session: true };
    const subject = review.conflicts[0]!.id;
    const fingerprint = "f".repeat(64);
    const investigation = { record_id: "requirement:r1", original_motivation: "原动机", proposed_motivation: "新动机",
      proposed_behavior: "新行为", alternatives: "替代方案", impact: "代价", verification: "验证" };
    const blocked: WikiConflict = { ...review.conflicts[0]!, policy: { fingerprint, required: true, approved: false, blocked: true, investigation: null } };
    const workspace: WikiConflictWorkspace = { ...conflictWorkspace, conflict: blocked, history: [{ decision: "approved_change", actor: "lht",
      at: "2026-10-01T08:00:00.000Z", note: JSON.stringify({ fingerprint: "e".repeat(64), confirmed: true }) }] };
    const stub = stubApi({
      "/api/knowledge/review/decide": { ok: true, review: { decision: "approved_change", note: "", actor: "lht", at: "2026-10-15T08:00:00.000Z" } },
      "/api/knowledge/conflict": workspace,
      "/api/knowledge/review": { ...review, conflicts: [blocked] },
      "/api/knowledge": overview,
    });
    const user = userEvent.setup();
    const view = renderPage(<KnowledgePage />, "/knowledge?v=review&tab=conflicts");

    // Without an investigation the reason is on screen, not a silently dead button.
    const approve = await screen.findByRole("button", { name: "批准此修改…" });
    expect(approve).toBeDisabled();
    expect(screen.getByText(/还不能批准：需先由 Agent 提交完整调查/)).toBeVisible();
    expect(screen.getByText("已确认批准，未附说明")).toBeInTheDocument();
    view.unmount();

    workspace.conflict = { ...blocked, policy: { ...blocked.policy!, investigation } };
    renderPage(<KnowledgePage />, "/knowledge?v=review&tab=conflicts");
    await waitFor(() => expect(screen.getByRole("button", { name: "批准此修改…" })).toBeEnabled());
    expect(screen.queryByText(/还不能批准/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("审阅说明（可选）")).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "批准此修改…" }));
    const dialog = await screen.findByRole("dialog", { name: "批准此修改？" });
    expect(stub.calls.some((call) => call.url.startsWith("/api/knowledge/review/decide"))).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "确认批准" }));
    await waitFor(() => {
      const call = stub.calls.find((item) => item.url.startsWith("/api/knowledge/review/decide"));
      expect(JSON.parse(String(call?.init?.body))).toEqual({ subject_id: subject, decision: "approved_change", note: "", fingerprint });
    });
    expect(stub.calls.filter((item) => item.url.startsWith("/api/knowledge/review/decide"))).toHaveLength(1);
  });

  it("requires a first message and creates an independent Knowledge Chat payload", async () => {
    bootstrap.viewer = { username: "alice", admin: false, dev: true, deploy: false, contribute: true, session: true };
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const chat = {
      id: "kc_knowledge_one",
      subject_id: null,
      title: "为什么菜单只在点击时打开？",
      preview: "为什么菜单只在点击时打开？",
      created_at: "2026-08-27T03:04:00.000Z",
      updated_at: "2026-08-27T03:04:01.000Z",
      running_since: null,
    };
    const detail: WikiKnowledgeChatDetail = {
      enabled: true,
      model: "test-model",
      chat,
      messages: [
        { id: 1, chat_id: chat.id, role: "user", content: chat.preview, at: chat.created_at },
        { id: 2, chat_id: chat.id, role: "assistant", content: "因为当前决策明确禁止悬停触发。", at: chat.updated_at },
      ],
      read_only: false,
      read_only_reason: null,
    };
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      const parsed = new URL(url, "http://dashboard.test");
      let body: unknown;
      if (parsed.pathname === "/api/knowledge/chats" && init?.method === "POST") {
        body = { ok: true, duplicate: false, chat, running: true };
      } else if (parsed.pathname === "/api/knowledge/chats") {
        body = { enabled: true, model: "test-model", chats: [] };
      } else if (parsed.pathname === "/api/knowledge/chat") {
        body = detail;
      } else if (parsed.pathname === "/api/knowledge") {
        body = overview;
      } else {
        return new Response(JSON.stringify({ error: `no stub for ${url}` }), { status: 404 });
      }
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const user = userEvent.setup();
    renderPage(<KnowledgePage />, "/knowledge?v=chat&chat=new");
    const dialog = await screen.findByRole("dialog", { name: "新建知识 Chat" });
    const createButton = within(dialog).getByRole("button", { name: "创建并提问" });
    expect(createButton).toBeDisabled();
    await user.type(within(dialog).getByLabelText("首条消息（必填）"), chat.preview);
    expect(createButton).toBeEnabled();
    await user.click(createButton);

    await waitFor(() => {
      const call = calls.find((item) => new URL(item.url, "http://dashboard.test").pathname === "/api/knowledge/chats" && item.init?.method === "POST");
      const body = JSON.parse(String(call?.init?.body)) as Record<string, unknown>;
      expect(body).toEqual({
        message: chat.preview,
        request_id: expect.stringMatching(/^kcr_[0-9a-f]{32}$/u),
      });
      expect(body).not.toHaveProperty("model");
      expect(body).not.toHaveProperty("ticket_id");
    });
    expect(await screen.findByText("因为当前决策明确禁止悬停触发。")).toBeInTheDocument();
    expect(screen.queryByText(/工单 #|dev_status|提单人/)).not.toBeInTheDocument();
  });

  it("keeps the first-message draft when chat creation is refused", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const pathname = new URL(String(input), "http://dashboard.test").pathname;
      if (pathname === "/api/knowledge/chats" && init?.method === "POST") {
        return new Response(JSON.stringify({ error: "关联冲突已关闭" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        });
      }
      const body = pathname === "/api/knowledge/chats"
        ? { enabled: true, model: "test-model", chats: [] }
        : overview;
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const user = userEvent.setup();
    renderPage(<KnowledgePage />, "/knowledge?v=chat&chat=new");
    const dialog = await screen.findByRole("dialog", { name: "新建知识 Chat" });
    const firstMessage = within(dialog).getByLabelText("首条消息（必填）");
    await user.type(firstMessage, "这段草稿不能丢");
    await user.click(within(dialog).getByRole("button", { name: "创建并提问" }));

    expect(await within(dialog).findByText(/关联冲突已关闭.*首条消息仍保留/)).toBeInTheDocument();
    expect(firstMessage).toHaveValue("这段草稿不能丢");
  });

  it("loads earlier knowledge chat windows on request and prepends them in order", async () => {
    bootstrap.viewer = { username: "alice", admin: false, dev: true, deploy: false, contribute: true, session: true };
    const chat = {
      id: "kc_long_history",
      subject_id: null,
      title: "很长的对话",
      preview: "最新问题",
      created_at: "2026-08-27T03:04:00.000Z",
      updated_at: "2026-08-27T03:04:01.000Z",
      running_since: null,
    };
    const message = (id: number) => ({ id, chat_id: chat.id, role: "assistant" as const, content: `第 ${id} 条`, at: chat.updated_at });
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://dashboard.test");
      urls.push(`${url.pathname}${url.search}`);
      let body: unknown;
      if (url.pathname === "/api/knowledge/chats") body = { enabled: true, model: "test-model", chats: [chat] };
      else if (url.pathname === "/api/knowledge/chat") {
        const before = url.searchParams.get("before");
        body = {
          enabled: true, model: "test-model", chat, read_only: false, read_only_reason: null,
          ...(before === null ? { messages: [message(500), message(501)], has_earlier: true }
            : before === "500" ? { messages: [message(300), message(301)], has_earlier: true }
            : { messages: [message(7)], has_earlier: false }),
        } satisfies WikiKnowledgeChatDetail;
      } else if (url.pathname === "/api/knowledge") body = overview;
      else return new Response(JSON.stringify({ error: `no stub for ${url}` }), { status: 404 });
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const user = userEvent.setup();
    renderPage(<KnowledgePage />, `/knowledge?v=chat&chat=${chat.id}`);
    expect(await screen.findByText("第 501 条")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "显示更早的消息" }));
    expect(await screen.findByText("第 300 条")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "显示更早的消息" }));
    expect(await screen.findByText("第 7 条")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "显示更早的消息" })).not.toBeInTheDocument();
    const order = ["第 7 条", "第 300 条", "第 301 条", "第 500 条", "第 501 条"]
      .map((text) => screen.getByText(text));
    order.slice(1).forEach((node, index) => {
      expect(order[index]!.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
    expect(urls.filter((url) => url.startsWith("/api/knowledge/chat?"))).toEqual([
      `/api/knowledge/chat?id=${chat.id}`,
      `/api/knowledge/chat?id=${chat.id}&before=500`,
      `/api/knowledge/chat?id=${chat.id}&before=300`,
    ]);
  });

  it("lists conversations past the newest 100 through 显示更早的对话, each once and in order", async () => {
    bootstrap.viewer = { username: "alice", admin: false, dev: true, deploy: false, contribute: true, session: true };
    // 230 conversations, newest first: three roster windows of 100 / 100 / 30.
    const chats = Array.from({ length: 230 }, (_, i) => ({
      id: `kc_${String(229 - i).padStart(3, "0")}`,
      subject_id: null,
      title: `对话 ${229 - i}`,
      preview: `预览 ${229 - i}`,
      created_at: "2026-08-27T03:04:00.000Z",
      updated_at: new Date(Date.parse("2026-08-27T03:04:00.000Z") + (229 - i) * 1_000).toISOString(),
      running_since: null,
    }));
    const cursorOf = (chat: (typeof chats)[number]) => `${chat.updated_at}|${chat.id}`;
    const window = (start: number) => {
      const page = chats.slice(start, start + 100);
      return { enabled: true, model: "test-model", chats: page, next_before: start + 100 < chats.length ? cursorOf(page.at(-1)!) : null };
    };
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://dashboard.test");
      urls.push(`${url.pathname}${url.search}`);
      let body: unknown;
      if (url.pathname === "/api/knowledge/chats") {
        const before = url.searchParams.get("before");
        body = window(before === null ? 0 : chats.findIndex((chat) => cursorOf(chat) === before) + 1);
      } else if (url.pathname === "/api/knowledge/chat") {
        body = { enabled: true, model: "test-model", chat: chats[0], messages: [], has_earlier: false, read_only: false, read_only_reason: null } satisfies WikiKnowledgeChatDetail;
      } else if (url.pathname === "/api/knowledge") body = overview;
      else return new Response(JSON.stringify({ error: `no stub for ${url}` }), { status: 404 });
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const user = userEvent.setup();
    renderPage(<KnowledgePage />, "/knowledge?v=chat");
    const list = await screen.findByRole("list", { name: "知识 Chat 列表" });
    await within(list).findByText("对话 229");
    expect(within(list).getAllByRole("listitem")).toHaveLength(100);
    expect(within(list).queryByText("对话 129")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "显示更早的对话" }));
    expect(await within(list).findByText("对话 129")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "显示更早的对话" }));
    expect(await within(list).findByText("对话 0")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "显示更早的对话" })).not.toBeInTheDocument();

    const titles = within(list).getAllByRole("listitem").map((item) => item.querySelector("b")!.textContent);
    expect(titles).toEqual(chats.map((chat) => chat.title));
    expect(urls.filter((url) => url.startsWith("/api/knowledge/chats?"))).toEqual([
      `/api/knowledge/chats?before=${encodeURIComponent(cursorOf(chats[99]!))}`,
      `/api/knowledge/chats?before=${encodeURIComponent(cursorOf(chats[199]!))}`,
    ]);
  });

  it("renders complete, inspectable retrieval audit identities and an accessible lifecycle", async () => {
    const traceId = `kr_${"a".repeat(32)}`;
    const row = {
      trace_id: traceId,
      lane: "ticket",
      purpose: "startup",
      subject_ref: "ticket:42",
      turn: 2,
      repo_sha: "1".repeat(40),
      code_index_sha: "2".repeat(40),
      vector_index_sha: "3".repeat(40),
      started_at: "2026-08-23T00:00:00.000Z",
      expires_at: "2026-11-21T00:00:00.000Z",
      outcome: "miss",
      unknown_codes: ["missing_slot"],
      feedback_codes: ["not_helpful"],
    } satisfies WikiRetrievalReviewList["items"][number];
    const detail: WikiRetrievalTraceDetail = {
      ...row,
      graph_input_fingerprint: "4".repeat(64),
      worktree_input_fingerprint: "5".repeat(64),
      events_total: 2,
      events_has_more: false,
      events: [
        {
          event: "started",
          event_key: "lifecycle:started",
          created_at: row.started_at,
          payload: {},
        },
        {
          event: "miss",
          event_key: "lifecycle:result",
          created_at: "2026-08-23T00:00:01.000Z",
          payload: {
            classifications: Array.from({ length: 32 }, (_, index) => ({
              dimension: index < 16 ? "capability" : "scenario",
              value: `classification-${index}`,
              certainty: index % 2 === 0 ? "exact" : "inferred",
              score: 0.75,
              reason_codes: ["lexical"],
            })),
            indexes: [{
              index: {
                id: "vector-main",
                kind: "vector",
                artifact_sha256: "6".repeat(64),
                source_git_sha: "7".repeat(40),
                graph_sha256: "8".repeat(64),
                manifest_schema: 3,
                record_schema_version: 2,
                record_count: 99,
                freshness: "exact",
                embedding: {
                  provider: "local",
                  model_id: "multilingual-e5-small",
                  immutable_revision: "rev-2026-08-01",
                  dimensions: 384,
                  dtype: "float32",
                  normalized: true,
                  distance: "cosine",
                },
              },
              status: "ok",
              latency_ms: 1.25,
              privacy_decision: "local_only",
              hits: [{ record_id: "statement:menu", rank: 1, raw_score: 0.9 }],
            }],
            candidates: [{
              record_id: "statement:menu",
              kind: "statement",
              source_ref: "architecture/knowledge/current/menu.md:12",
              source_sha: "9".repeat(40),
              fused_rank: 1,
              fused_score: 0.5,
              signals: [{ index_id: "vector-main", rank: 1, raw_score: 0.9, rrf_contribution: 0.4 }],
              rerank: [{ feature: "path_match", contribution: 0.1 }],
            }],
            slots: [{
              slot: "tests_evidence",
              ordinal: 1,
              record_id: "statement:menu",
              candidate_rank: 1,
              final_score: 0.5,
              chars: 120,
              reason_codes: ["required"],
            }],
            unknown: [{ code: "missing_slot", slot: "tests_evidence" }],
            budget: { limit_chars: 4_000, used_chars: 120, dropped_records: 1 },
            performance: { total_ms: 3, rss_delta_bytes: 128 },
          },
        },
      ],
    };
    stubApi({
      "/api/knowledge/retrievals": { items: [row], limit: 50, has_more: false },
      "/api/knowledge/retrieval": detail,
      "/api/knowledge/review": review,
      "/api/knowledge": overview,
    });

    renderPage(<KnowledgePage />, `/knowledge?v=review&tab=retrieval&trace=${traceId}`);
    const heading = await screen.findByRole("heading", { name: traceId });
    await waitFor(() => expect(heading).toHaveFocus());
    const selectedTrace = screen.getByRole("button", { name: new RegExp(traceId) });
    expect(selectedTrace).toHaveAttribute("aria-pressed", "true");
    expect(selectedTrace).toHaveAttribute("aria-controls", "retrieval-trace-detail");

    await userEvent.click(screen.getByText("绑定与索引身份"));
    for (const digest of [row.repo_sha, row.code_index_sha!, row.vector_index_sha!, detail.graph_input_fingerprint, detail.worktree_input_fingerprint!]) {
      expect(screen.getByText(digest)).toBeInTheDocument();
    }
    await userEvent.click(screen.getByText(/vector-main · ok · exact/));
    for (const digest of ["6".repeat(64), "7".repeat(40), "8".repeat(64), "9".repeat(40)]) {
      expect(screen.getByText(digest)).toBeInTheDocument();
    }
    expect(screen.getByText("local_only")).toBeInTheDocument();
    expect(screen.getByText("rev-2026-08-01")).toBeInTheDocument();
    expect(screen.getByText("true / cosine")).toBeInTheDocument();
    expect(screen.getByText("classification-31")).toBeInTheDocument();
    expect(screen.getAllByText("lexical").length).toBeGreaterThan(0);

    const lifecycle = screen.getByRole("list", { name: "检索生命周期" });
    expect(Array.from(lifecycle.querySelectorAll("[data-event-key]")).map((item) => item.getAttribute("data-event-key"))).toEqual([
      "lifecycle:started",
      "lifecycle:result",
    ]);
    expect(lifecycle.querySelector('[data-event-key="lifecycle:result"] details')).toHaveAttribute("open");
    expect(screen.getByText(/architecture\/knowledge\/current\/menu\.md:12/)).toBeInTheDocument();
    expect(screen.getByText(/missing_slot · tests_evidence/)).toBeInTheDocument();
    expect(screen.queryByText(/private ticket body|raw query|transcript|stack trace/i)).not.toBeInTheDocument();
  });

  it("loads opaque list and event cursors, merging repeated lifecycle events by event key", async () => {
    const listCursor = "list:+/=opaque";
    const eventCursor = "events:+/=opaque";
    const traceId = `kr_${"b".repeat(32)}`;
    const olderTraceId = `kr_${"c".repeat(32)}`;
    const newerRow = {
      trace_id: traceId,
      lane: "cli",
      purpose: "path_refinement",
      subject_ref: "runtime-ticket:42",
      repo_sha: "a".repeat(40),
      started_at: "2026-08-23T00:00:00.000Z",
      expires_at: "2026-11-21T00:00:00.000Z",
      outcome: "miss",
      unknown_codes: [],
      feedback_codes: ["newer_feedback"],
    } satisfies WikiRetrievalReviewList["items"][number];
    const olderRow = {
      ...newerRow,
      trace_id: olderTraceId,
      subject_ref: "runtime-ticket:41",
      started_at: "2026-08-22T00:00:00.000Z",
      feedback_codes: [],
    } satisfies WikiRetrievalReviewList["items"][number];
    const started = {
      event: "started",
      event_key: "lifecycle:started",
      created_at: "2026-08-23T00:00:00.000Z",
      payload: {},
    } satisfies WikiRetrievalTraceDetail["events"][number];
    const result = {
      event: "miss",
      event_key: "lifecycle:result",
      created_at: "2026-08-23T00:00:01.000Z",
      payload: { unknown: [{ code: "missing_slot" }] },
    } satisfies WikiRetrievalTraceDetail["events"][number];
    const newerFeedback = {
      event: "feedback",
      event_key: "feedback:newer",
      created_at: "2026-08-23T00:00:03.000Z",
      payload: { code: "newer_feedback" },
    } satisfies WikiRetrievalTraceDetail["events"][number];
    const olderFeedback = {
      event: "feedback",
      event_key: "feedback:older",
      created_at: "2026-08-23T00:00:02.000Z",
      payload: { code: "older_feedback" },
    } satisfies WikiRetrievalTraceDetail["events"][number];
    const firstDetail: WikiRetrievalTraceDetail = {
      ...newerRow,
      graph_input_fingerprint: "d".repeat(64),
      events: [started, result, newerFeedback],
      events_total: 4,
      events_has_more: true,
      events_next_before: eventCursor,
    };
    const olderDetail: WikiRetrievalTraceDetail = {
      ...firstDetail,
      events: [started, result, olderFeedback],
      events_has_more: false,
      events_next_before: undefined,
    };
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const requestUrl = String(input);
      calls.push(requestUrl);
      const parsed = new URL(requestUrl, "http://dashboard.test");
      let body: unknown;
      if (parsed.pathname === "/api/knowledge/retrievals") {
        body = parsed.searchParams.get("before") === listCursor
          ? { items: [olderRow], limit: 50, has_more: false }
          : { items: [newerRow], limit: 50, has_more: true, next_before: listCursor };
      } else if (parsed.pathname === "/api/knowledge/retrieval") {
        body = parsed.searchParams.get("events_before") === eventCursor ? olderDetail : firstDetail;
      } else if (parsed.pathname === "/api/knowledge/review") {
        body = review;
      } else if (parsed.pathname === "/api/knowledge") {
        body = overview;
      } else {
        return new Response(JSON.stringify({ error: `no stub for ${requestUrl}` }), { status: 404 });
      }
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    renderPage(<KnowledgePage />, `/knowledge?v=review&tab=retrieval&trace=${traceId}`);
    expect(await screen.findByRole("heading", { name: traceId })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "加载更早的追踪记录" }));
    expect(await screen.findByRole("button", { name: new RegExp(olderTraceId) })).toBeInTheDocument();
    const listPageUrl = calls.find((url) => new URL(url, "http://dashboard.test").searchParams.has("before"));
    expect(new URL(listPageUrl!, "http://dashboard.test").searchParams.get("before")).toBe(listCursor);
    expect(new URL(calls.find((url) => url.includes("/retrievals?"))!, "http://dashboard.test").searchParams.get("limit")).toBe("50");

    await userEvent.click(screen.getByRole("button", { name: "加载更早的反馈与使用事件" }));
    expect((await screen.findAllByText("older_feedback")).length).toBeGreaterThan(0);
    const eventPageUrl = calls.find((url) => new URL(url, "http://dashboard.test").searchParams.has("events_before"));
    const eventPageParams = new URL(eventPageUrl!, "http://dashboard.test").searchParams;
    expect(eventPageParams.get("events_before")).toBe(eventCursor);
    expect(eventPageParams.get("events_limit")).toBe("25");
    const lifecycle = screen.getByRole("list", { name: "检索生命周期" });
    expect(Array.from(lifecycle.querySelectorAll("[data-event-key]")).map((item) => item.getAttribute("data-event-key"))).toEqual([
      "lifecycle:started",
      "lifecycle:result",
      "feedback:older",
      "feedback:newer",
    ]);
    expect(lifecycle.querySelectorAll('[data-event-key="lifecycle:started"]')).toHaveLength(1);
    expect(screen.getByText("已加载 4/4 个事件；事件已全部加载。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "加载更早的反馈与使用事件" })).not.toBeInTheDocument();
  });

  it("runs a startup-pack preview through the server and renders it as Markdown", async () => {
    const stub = stubApi({
      "/api/knowledge/preview": { text: "### 能力与信任区\n- web.navigation [inferred]\n### 未知（禁止省略）\n- 无", included: 3, capabilities: [{ id: "web.navigation", certainty: "inferred", why: ["aliases 菜单"] }], unknown: [], chars: 80 },
      "/api/knowledge": overview,
    });
    renderPage(<KnowledgePage />, "/knowledge?v=preview");
    await userEvent.type(await screen.findByLabelText("需求正文"), "菜单点击后没有打开");
    await userEvent.click(screen.getByRole("button", { name: "试算" }));
    expect(await screen.findByText("未知（禁止省略）")).toBeInTheDocument();
    expect(stub.calls.some((item) => item.url.includes("/api/knowledge/preview") && item.init?.method === "POST")).toBe(true);
  });
});
