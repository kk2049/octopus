import { expect, it } from "vitest";
import { isTestFile, projectSpecification, type KnowledgeSpecification } from "./specifications.js";
import { landingsSource } from "./sources/landings.js";
import { emptyOutput, type SourceContext } from "./sources/context.js";
import type { KnowledgeNode, LandingInput } from "./model.js";
import { knowledgeStrength } from "./provenance.js";
import { toLandingInput } from "./bot-db.js";

const spec: KnowledgeSpecification = {
  kind: "requirement", statement: "会话按 tmux 优先级进入有界窗口", strength: "agent_inferred",
  provenance: { author: { kind: "agent", name: "extractor", model: null, ref: "ticket:529" }, basis: ["ticket:529"], events: [] },
  realized_by: ["packages/example/window.ts"], verified_by: ["packages/example/window.test.ts"],
};
const ctx = { sha: "a".repeat(40), observedAt: "2026-09-08", moduleForPath: () => "sessions" } as unknown as SourceContext;

it("projects only authored artifact bridges and module/path links, independently of vector indexes", () => {
  const out = emptyOutput();
  const node = { id: "requirement:example", kind: "requirement", statement: spec.statement, source_ref: "landing:1" } as KnowledgeNode;
  projectSpecification(spec, node, ctx, out);
  expect(out.edges.filter((edge) => edge.relation === "realized_by")).toEqual([expect.objectContaining({ from_id: node.id, to_id: "artifact:knowledge/realized_by/packages/example/window.ts", certainty: "exact" })]);
  expect(out.edges.filter((edge) => edge.relation === "verified_by")).toHaveLength(1);
  expect(out.edges).toContainEqual(expect.objectContaining({ relation: "about", to_id: "module:sessions" }));
  expect(knowledgeStrength(node)).toBe("agent_inferred");
});

it("rebuilds landing evidence without inheriting unrelated changed files or upgrading old summaries", () => {
  const landing: LandingInput = { id: 1, ticket_id: 529, from_sha: "b".repeat(40), to_sha: ctx.sha, landed_at: ctx.observedAt, source: "devpipe", report_path: null, summary: "窗口排序", changed_files: ["packages/unrelated/file.ts"], changed_modules: [], knowledge: {
    summary: "窗口排序", requirements: [spec.statement], decisions: [], non_goals: [], risks: [], verification: [], context_keys: [], supersedes: [], specifications: [spec],
  } };
  const restored = toLandingInput({ ...landing, status: "landed", changed_files: JSON.stringify(landing.changed_files), changed_modules: JSON.stringify(landing.changed_modules), knowledge_json: JSON.stringify(landing.knowledge) });
  expect(restored.knowledge.specifications).toEqual([spec]);
  const out = landingsSource(ctx, { landings: [restored], tickets: [] });
  expect(out.edges.filter((edge) => edge.from_id === "landing:1:requirement:1" && edge.relation === "verified_by")).toHaveLength(1);
  expect(out.edges.filter((edge) => edge.from_id === "landing:1:requirement:1").some((edge) => edge.to_id.includes("unrelated"))).toBe(false);
  delete landing.knowledge.specifications;
  const old = landingsSource(ctx, { landings: [landing], tickets: [] });
  expect(old.edges.some((edge) => edge.relation === "verified_by")).toBe(false);
  expect(knowledgeStrength(old.nodes.find((node) => node.id === "landing:1:requirement:1")!)).toBe("agent_inferred");
});

it("accepts the repository's Python and shell tests as verification evidence", () => {
  for (const file of ["scripts/ops/release-layer.test.py", "scripts/ops/reference-sync.test.sh", "scripts/ops/knowledge-graph-build.test.mjs", "packages/bot/src/x.test.ts"]) {
    expect(isTestFile(file)).toBe(true);
  }
  for (const file of ["scripts/ops/release-progress.py", "scripts/ops/land.sh", "packages/bot/src/x.ts"]) {
    expect(isTestFile(file)).toBe(false);
  }
});
