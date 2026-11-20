import { afterEach, describe, expect, it, vi } from "vitest";
import { buildGraph } from "../knowledge/build.js";
import { git } from "./worktree.js";
import { Store } from "../store/store.js";
import { conflictFingerprint } from "../knowledge/provenance.js";
import { reviewPolicy } from "../knowledge/review-policy.js";
import type { KnowledgeNode } from "../knowledge/model.js";
import type { GraphSnapshot } from "../knowledge/graph-db.js";
import { assertKnowledgeDeployable, bindKnowledgeDeployProjection } from "./knowledge-deploy.js";

vi.mock("../knowledge/build.js", () => ({ buildGraph: vi.fn() }));
vi.mock("./worktree.js", () => ({ git: vi.fn() }));
const source: KnowledgeNode = { id: "requirement:original", kind: "requirement", statement: "知识讨论必须使用独立的个人数据后端", status: "active", authority: "curated", source_ref: "ticket:407", source_sha: "a".repeat(40), method: "curated", certainty: "exact", metadata: { provenance: { events: [{ kind: "requirement", actor: "lht", at: "2026-09-07", source_kind: "original_prompt", source_sha256: "a".repeat(64), quote: "知识讨论必须使用独立的个人数据后端", design: "知识讨论必须使用独立的个人数据后端" }] } } };
const stores: Store[] = [];
afterEach(() => { stores.splice(0).forEach((store) => store.close()); vi.resetAllMocks(); });
const setup = (next: KnowledgeNode[] = []) => {
  const store = new Store(":memory:"); stores.push(store);
  vi.mocked(git).mockResolvedValue({ ok: true, stdout: "", stderr: "", code: 0 });
  vi.mocked(buildGraph).mockImplementation(async (input) => ({ sha: input.ref!, file: null, warnings: [], snapshot: { nodes: input.ref === "before" ? [source] : next, conflicts: [] } as unknown as GraphSnapshot }));
  return { repoDir: "/fixture", target: "after", previous: "before", store };
};
describe("deployment knowledge debt", () => {
  it("uses the bound remote projection for both exact versions and retains review enforcement", async () => {
    const input = setup();
    const remote = vi.fn(async ({ ref }: { ref: string }) => ({ nodes: ref === "before" ? [source] : [], conflicts: [] }));
    const unbind = bindKnowledgeDeployProjection(input.store, remote);
    try {
      await expect(assertKnowledgeDeployable(input)).rejects.toThrow(/知识裁决阻止上线/);
      expect(remote.mock.calls.map(([call]) => call.ref)).toEqual(["after", "before"]);
      expect(buildGraph).not.toHaveBeenCalled();
    } finally { unbind(); }
  });
  it("an unavailable remote projection reports a warning, proceeds, and never falls back to local analysis", async () => {
    const input = setup();
    const unbind = bindKnowledgeDeployProjection(input.store, async () => { throw new Error("Runner offline"); });
    const onUnavailable = vi.fn();
    try {
      await expect(assertKnowledgeDeployable({ ...input, onUnavailable })).resolves.toBeUndefined();
      expect(onUnavailable).toHaveBeenCalledWith("Runner offline");
      expect(buildGraph).not.toHaveBeenCalled();
    } finally { unbind(); }
  });
  it("a control node without a bound projection proceeds with a warning instead of building locally", async () => {
    const input = setup();
    const onUnavailable = vi.fn();
    vi.stubEnv("OCTOPUS_COMPUTE_ROLE", "control");
    try {
      await expect(assertKnowledgeDeployable({ ...input, onUnavailable })).resolves.toBeUndefined();
      expect(onUnavailable).toHaveBeenCalledWith(expect.stringContaining("provider 未绑定"));
      expect(buildGraph).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });
  it("preserves deleted user requirements and only accepts approval for the exact proposed change", async () => {
    const input = setup();
    await expect(assertKnowledgeDeployable(input)).rejects.toThrow(/知识裁决阻止上线/);
    const [saved] = input.store.knowledge.listReviewCandidates();
    expect(saved.nodes[0]?.statement).toBe(source.statement);
    input.store.knowledge.recordReview({ subject_id: saved.conflict.id, rule: saved.conflict.rule, decision: "dismissed", actor: "admin", note: "好的" });
    await expect(assertKnowledgeDeployable(input)).rejects.toThrow(/知识裁决阻止上线/);
    input.store.knowledge.recordReview({ subject_id: saved.conflict.id, rule: saved.conflict.rule, decision: "investigated", actor: "agent:alice", note: JSON.stringify({ source_fingerprint: conflictFingerprint(saved.conflict.id, saved.nodes), investigation: { record_id: saved.nodes[0]!.id, original_motivation: "原设计保护个人知识讨论的数据独立性", proposed_motivation: "新任务要求调整旧规格但保持归属隔离", proposed_behavior: "删除过期规定并以新的独立数据契约替代", alternatives: "保留旧条目会导致与新契约的重复约束", impact: "个人历史记录的读取权限和归属保持不变", verification: "代码和测试均核对个人数据仍保持隔离" } }) });
    input.store.knowledge.recordReview({ subject_id: saved.conflict.id, rule: saved.conflict.rule, decision: "approved_change", actor: "admin", note: JSON.stringify({ fingerprint: reviewPolicy(saved.conflict, saved.nodes, input.store.knowledge.listReviews()).fingerprint, design_review: "我理解知识讨论必须使用独立的个人数据后端，同意这次删除旧设计并承担兼容代价。" }) });
    await expect(assertKnowledgeDeployable(input)).resolves.toBeUndefined();
    expect(vi.mocked(buildGraph).mock.calls.every(([call]) => ["before", "after"].includes(call.ref!))).toBe(true);
  });
  it("rejects weakening evidence or retiring a required record, but allows unchanged requirements", async () => {
    for (const next of [{ ...source, metadata: {} }, { ...source, status: "historical" as const }]) await expect(assertKnowledgeDeployable(setup([next]))).rejects.toThrow(/知识裁决阻止上线/);
    await expect(assertKnowledgeDeployable(setup([source]))).resolves.toBeUndefined();
  });
  it("cannot bypass the running policy by deleting its source from a candidate", async () => {
    const input = setup();
    vi.mocked(git).mockResolvedValueOnce({ ok: false, stdout: "", stderr: "missing", code: 1 });
    await expect(assertKnowledgeDeployable(input)).rejects.toThrow(/移除了知识裁决契约/);
  });
});
