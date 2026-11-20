import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { evidenceQualifies, knowledgeStrength, validateProvenance, type KnowledgeEvidenceEvent } from "./provenance.js";
import { verifyEvidenceEvent } from "./evidence-verification.js";
import { assembleSnapshot } from "./build.js";
import type { KnowledgeNode } from "./model.js";

const statement = "只有用户强制要求的冲突必须阻止上线";
const at = "2026-09-07T16:03:50.094Z";
const event = (patch: Partial<KnowledgeEvidenceEvent> = {}): KnowledgeEvidenceEvent => ({
  kind: "requirement", actor: "lht", at, ref: "ticket:522", source_kind: "original_prompt",
  source_sha256: createHash("sha256").update(statement).digest("hex"), quote: statement, design: statement, ...patch,
});
const claim = (events: KnowledgeEvidenceEvent[] = []): KnowledgeNode => ({
  id: "requirement:example", kind: "requirement", statement, status: "active", authority: "user", source_ref: "ticket:522", source_sha: "a".repeat(40), method: "curated", certainty: "exact",
  metadata: { provenance: { author: { kind: "agent", name: "extractor", model: null, ref: "ticket:522" }, basis: ["ticket:522"], events } },
});

describe("knowledge evidence strength", () => {
  it("does not infer endorsement from source ranking, exact extraction or requester", () => {
    expect(knowledgeStrength(claim())).toBe("agent_inferred");
    expect(knowledgeStrength({ ...claim(), metadata: { requester: "lht", origins: [{ role: "user_requirement" }] } })).toBe("agent_inferred");
  });
  it("requires explicit design evidence, and keeps questions and acknowledgements weakest", () => {
    for (const quote of ["好的", "收到", "同意，你看一下", `我不同意${statement}`, `我没看，但支持${statement}`]) expect(evidenceQualifies(event({ kind: "endorsement", quote }))).toBe(false);
    expect(knowledgeStrength(claim([event({ kind: "question" }), event({ kind: "acknowledgement" })]))).toBe("agent_inferred");
    expect(knowledgeStrength(claim([event({ kind: "endorsement", source_kind: "human_message", quote: `我支持${statement}` })]))).toBe("human_reviewed");
    expect(knowledgeStrength(claim([event()]))).toBe("human_required");
    expect(knowledgeStrength(claim([event({ source_kind: "agent_message" })]))).toBe("agent_inferred");
    expect(knowledgeStrength({ ...claim([event()]), statement: "完全不同的设计，不继承任何背书" })).toBe("agent_inferred");
    expect(knowledgeStrength({ ...claim([event()]), statement: `${statement}，而且额外要求删除所有历史审计记录` })).toBe("agent_inferred");
  });
  it("does not erase numeric or operator differences while matching or folding evidence", () => {
    const nodes = ["重试次数必须小于阈值 < 1.5", "重试次数必须小于阈值 > 15"].map((statement, index) => ({ ...claim(), id: `requirement:numeric:${index}`, statement }));
    const proof = event({ quote: nodes[0]!.statement, design: nodes[0]!.statement });
    expect(knowledgeStrength({ ...nodes[1]!, metadata: claim([proof]).metadata })).toBe("agent_inferred");
    const snapshot = assembleSnapshot({ nodes, edges: [], warnings: [], coverage: [] }, { sha: "a".repeat(40), observedAt: at, inputsFingerprint: "numeric", existingPaths: null });
    expect(snapshot.nodes.filter((node) => node.kind === "requirement")).toHaveLength(2);
  });
  it("verifies source role, actor, time, digest and literal quote before accepting new human evidence", () => {
    const source = { actor: "lht", kind: "original_prompt" as const, at, text: statement };
    expect(verifyEvidenceEvent(event(), source)).toBeNull();
    for (const change of [{ actor: "agent" }, { at: "2026-09-08" }, { text: "agent summary" }, { kind: "agent_message" as const }]) expect(verifyEvidenceEvent(event(), { ...source, ...change })).not.toBeNull();
    expect(verifyEvidenceEvent(event(), null)).not.toBeNull();
    expect(validateProvenance(claim([event()]).metadata?.provenance)).toEqual([]);
  });
  it("preserves human evidence on duplicate claims and keeps required revisions visible", () => {
    const old = claim([event()]);
    const landing = { ...claim(), id: "landing:1", kind: "landing" as const, statement: "开发已采用折中实现并记录影响" };
    const snapshot = assembleSnapshot({ nodes: [old, landing], edges: [{ from_id: landing.id, to_id: old.id, relation: "supersedes", method: "landing", certainty: "exact", source_ref: "landing:1", source_sha: "a".repeat(40), observed_at: at }], warnings: [], coverage: [] }, { sha: "a".repeat(40), observedAt: at, inputsFingerprint: "test", existingPaths: null });
    expect(snapshot.nodes.find((node) => node.id === old.id)?.status).toBe("active");
    expect(snapshot.conflicts).toEqual(expect.arrayContaining([expect.objectContaining({ rule: "required_revision", a_id: old.id })]));
  });
});
