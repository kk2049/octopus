import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../store.js";
import { normalizeDevTicketInput } from "../../devpipe/ticket-models.js";
import type { LandingKnowledge } from "./knowledge.js";

const FACTS: LandingKnowledge = {
  summary: "手机端导航不再被文件面板抢占",
  requirements: ["手机端选择会话后必须进入会话"],
  decisions: ["路由身份与文件面板选择分开保存"],
  non_goals: ["不改变桌面端多面板布局"],
  risks: ["异步旧响应可能覆盖新选择"],
  verification: ["packages/dashboard-web/src/pages/TicketsPage.test.tsx: passed"],
  context_keys: [],
  supersedes: [],
};

describe("knowledge repository", () => {
  let store: Store;
  let ticketId: number;

  beforeEach(() => {
    store = new Store(":memory:");
    store.saveUser({ username: "alice", uid: 1, home_dir: "/x", created_at: "2026-08-19T00:00:00.000Z" });
    ticketId = store.devTickets.createDevTicket(normalizeDevTicketInput({
      title: "修复手机导航",
      body: "手机端从 chat 点导航却打开文件",
      requester: "alice",
    })).id;
  });

  afterEach(() => store.close());

  it("keeps a prepared exact range invisible until Git landing is completed", () => {
    store.knowledge.prepareLanding({
      ticket_id: ticketId,
      from_sha: "a".repeat(40),
      to_sha: "b".repeat(40),
      base_before: "a".repeat(40),
      tip_sha: "b".repeat(40),
      source: "devpipe",
      changed_files: ["packages/dashboard-web/src/pages/TicketsPage.tsx"],
      changed_modules: ["dashboard-web"],
      acceptance: ["手机端导航可达"],
      knowledge: FACTS,
    });

    expect(store.knowledge.listPreparedLandings()).toHaveLength(1);
    expect(store.knowledge.search("手机端导航")).toEqual([]);

    const landed = store.knowledge.completeLanding(ticketId, "b".repeat(40), "2026-08-19T01:00:00.000Z");
    expect(landed).toMatchObject({ status: "landed", from_sha: "a".repeat(40), to_sha: "b".repeat(40) });
    const outcome = store.knowledge.search("手机端导航").find((record) => record.kind === "outcome");
    expect(outcome).toMatchObject({ authority: "derived", ticket_id: ticketId });
    expect(JSON.parse(outcome!.metadata)).toMatchObject({ requester: "alice" });
    expect(store.knowledge.listPreparedLandings()).toEqual([]);
  });

  it("preserves superseded facts and makes only the new active decision retrievable", () => {
    store.knowledge.upsertRecord({
      record_key: "decision:old",
      kind: "decision",
      status: "active",
      authority: "accepted",
      title: "旧刷新策略",
      body: "轮询刷新所有会话",
      source_type: "test",
      source_ref: "ticket:#1",
      confidence: 1,
    });
    const knowledge = { ...FACTS, supersedes: ["decision:old"] };
    store.knowledge.recordLanding({
      ticket_id: ticketId,
      from_sha: "a".repeat(40),
      to_sha: "c".repeat(40),
      base_before: "a".repeat(40),
      tip_sha: "c".repeat(40),
      source: "devpipe",
      changed_files: ["packages/agent-sessions-view/src/controller.ts"],
      changed_modules: ["agent-sessions-view"],
      acceptance: ["刷新不抖动"],
      knowledge,
    });

    expect(store.knowledge.getRecords(["decision:old"])[0]?.status).toBe("superseded");
    expect(store.knowledge.search("旧刷新策略")).toEqual([]);
    expect(store.knowledge.listLandings(ticketId)).toHaveLength(1);
  });

  it("matches Chinese free text without whitespace and mixed identifiers", () => {
    store.knowledge.upsertRecord({
      record_key: "historical:pattern:mobile-nav",
      kind: "risk",
      status: "active",
      authority: "historical",
      title: "手机端跨界面交互会丢失导航状态",
      body: "#256 从 chat 页面点导航却跳转到了文件面板；必须区分 route/panel 与 selected identity。",
      source_type: "historical_pattern",
      source_ref: "runtime tickets #256",
      confidence: 0.9,
    });
    // A real ticket body: one clause, no spaces. The 2026-08-19 query builder
    // turned it into a single phrase and returned nothing.
    expect(store.knowledge.search("手机端的导航在有文件打开时会跳到文件页面"))
      .toContainEqual(expect.objectContaining({ record_key: "historical:pattern:mobile-nav" }));
    expect(store.knowledge.search("selected identity 丢失"))
      .toContainEqual(expect.objectContaining({ record_key: "historical:pattern:mobile-nav" }));
    expect(store.knowledge.search("无关")).toEqual([]);
  });

  it("retires disappeared repository projections without deleting their audit row", () => {
    const source = {
      record_key: "repo:rule:x",
      kind: "constraint" as const,
      status: "active" as const,
      authority: "declared" as const,
      title: "唯一写者",
      body: "持久状态只能有一个写者",
      source_type: "repo_rule",
      source_ref: ".claude/rules/example.md",
      confidence: 1,
    };
    store.knowledge.syncSourceRecords(["repo_rule"], [source]);
    expect(store.knowledge.search("持久状态只能")).toHaveLength(1);

    store.knowledge.syncSourceRecords(["repo_rule"], []);
    expect(store.knowledge.search("持久状态只能")).toEqual([]);
    expect(store.knowledge.getRecords([source.record_key])[0]?.status).toBe("superseded");
  });
});
