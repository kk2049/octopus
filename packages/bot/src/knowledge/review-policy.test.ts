import { describe, expect, it } from "vitest";
import { reviewPolicy, type ReviewRecord } from "./review-policy.js";
import { parseKnowledgeChanges } from "./changes.js";
import type { ConflictCandidate, KnowledgeNode } from "./model.js";

const a: KnowledgeNode = { id: "requirement:a", kind: "requirement", statement: "用户要求知识讨论必须独立于工单后端", status: "active", authority: "user", source_ref: "ticket:407", source_sha: "a".repeat(40), method: "curated", certainty: "exact", metadata: { provenance: { author: { kind: "human", name: "lht", model: null, ref: "ticket:407" }, basis: [], events: [{ kind: "requirement", actor: "lht", at: "2026-09-07", ref: "ticket:407", source_kind: "original_prompt", source_sha256: "a".repeat(64), quote: "用户要求知识讨论必须独立于工单后端", design: "用户要求知识讨论必须独立于工单后端" }] } } };
const investigation = { record_id: a.id, original_motivation: "保留个人知识讨论的独立数据和权限归属", proposed_motivation: "新任务要求复用既有成熟的会话模块", proposed_behavior: "复用会话界面并保留独立知识讨论数据", alternatives: "没有采用共用工单后端因为会混淆归属", impact: "用户获得会话交互且已有历史保持独立", verification: "独立知识讨论后端的相关测试已经通过" };
const b: KnowledgeNode = { ...a, id: "landing:2", statement: "新实现复用会话模块并保留独立数据", metadata: { changes: [investigation] } };
const conflict: ConflictCandidate = { id: "required_revision:a:b", rule: "required_revision", severity: "high", a_id: a.id, b_id: b.id, why: "change" };
const record = (decision: string, note: string): ReviewRecord => ({ subject_id: conflict.id, decision, note, actor: "admin", created_at: "2026-09-07" });

describe("knowledge deployment review", () => {
  it("blocks only third-tier design conflicts, not heuristic severity or reviewed designs", () => {
    expect(reviewPolicy(conflict, [a, b], []).blocked).toBe(true);
    expect(reviewPolicy(conflict, [b, b], []).blocked).toBe(false);
    expect(reviewPolicy({ ...conflict, rule: "stale_anchor" }, [a, b], []).blocked).toBe(false);
  });
  it("accepts one explicit confirmation of the exact content, with or without a note, and nothing weaker", () => {
    const policy = reviewPolicy(conflict, [a, b], []);
    const confirmed = record("approved_change", JSON.stringify({ fingerprint: policy.fingerprint, confirmed: true }));
    expect(reviewPolicy(conflict, [a, b], [confirmed]).blocked).toBe(false);
    // A short note is context, not a reading test.
    expect(reviewPolicy(conflict, [a, b], [record("approved_change", JSON.stringify({ fingerprint: policy.fingerprint, confirmed: true, note: "好的" }))]).blocked).toBe(false);
    // Receipts written before the confirmation replaced the reading test stay valid.
    expect(reviewPolicy(conflict, [a, b], [record("approved_change", JSON.stringify({ fingerprint: policy.fingerprint, design_review: "旧的复述" }))]).blocked).toBe(false);
    // The confirmation binds the content that was shown.
    expect(reviewPolicy(conflict, [a, { ...b, metadata: {} }], [confirmed]).blocked).toBe(true);
    expect(reviewPolicy(conflict, [a, { ...b, statement: "另一个新版本" }], [confirmed]).blocked).toBe(true);
    expect(reviewPolicy(conflict, [a, b], [confirmed, record("reopened", "再审")]).blocked).toBe(true);
    for (const decision of ["resolved", "dismissed", "confirmed", "question"]) expect(reviewPolicy(conflict, [a, b], [record(decision, "好的")]).blocked).toBe(true);
    expect(reviewPolicy(conflict, [a, b], [record("approved_change", "好的")]).blocked).toBe(true);
  });
  it("refuses revisions without both motivations, alternatives, impact and verification", () => {
    expect(() => parseKnowledgeChanges([{ record_id: a.id, proposed_behavior: b.statement }])).toThrow(/original_motivation/);
    expect(parseKnowledgeChanges([{ record_id: a.id, original_motivation: a.statement, proposed_motivation: b.statement, proposed_behavior: b.statement, alternatives: "保留独立后端并复用已有会话模块", impact: "现有个人讨论与权限归属保持独立", verification: "运行独立知识会话后端的相关测试" }])).toHaveLength(1);
  });
});
