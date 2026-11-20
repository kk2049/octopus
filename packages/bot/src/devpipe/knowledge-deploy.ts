import { buildGraph } from "../knowledge/build.js";
import { toLandingInput } from "../knowledge/bot-db.js";
import { knowledgeStrength } from "../knowledge/provenance.js";
import { reviewPolicy } from "../knowledge/review-policy.js";
import type { ConflictCandidate } from "../knowledge/model.js";
import type { Store } from "../store/store.js";
import { git } from "./worktree.js";
import type { RuntimeInputs } from "../knowledge/sources/landings.js";
import type { GraphSnapshot } from "../knowledge/graph-db.js";
import { createLogger } from "../logger.js";

const log = createLogger("knowledge-deploy");

export type KnowledgeDeployProjection = (input: { repoDir: string; ref: string; runtime: RuntimeInputs }) => Promise<Pick<GraphSnapshot, "nodes" | "conflicts">>;
// Bound by the composition root to this store's authorized execution provider.
const projections = new WeakMap<Store, KnowledgeDeployProjection>();
export function bindKnowledgeDeployProjection(store: Store, build: KnowledgeDeployProjection): () => void {
  projections.set(store, build);
  return () => { if (projections.get(store) === build) projections.delete(store); };
}

/**
 * Every production door uses the exact candidate, never a possibly stale
 * serving graph. Only a computed verdict blocks (a tier-3 conflict, or a
 * weakened/deleted human_required record). When the projection itself cannot
 * run (knowledge Runner offline, job failure or timeout, transport error, no
 * bound provider) there is no verdict: the review is skipped, logged, and
 * reported through `onUnavailable` for the caller's visible note.
 */
export async function assertKnowledgeDeployable(input: {
  repoDir: string; target: string; previous?: string | null; store: Store;
  onUnavailable?: (reason: string) => void;
}): Promise<void> {
  // Repositories predating this feature have no policy to project.
  const policy = await git(input.repoDir, ["cat-file", "-e", `${input.target}:packages/bot/src/knowledge/provenance.ts`]);
  if (!policy.ok) {
    const previousPolicy = input.previous && await git(input.repoDir, ["cat-file", "-e", `${input.previous}:packages/bot/src/knowledge/provenance.ts`]);
    if (!previousPolicy || !previousPolicy.ok) return;
    throw new Error("候选移除了知识裁决契约，不能绕过现行上线审查");
  }
  const runtime = {
    tickets: input.store.devTickets.listDevTickets(100_000).map(({ id, title, requester, model, kind, dev_status, created_at, landed_at, commit_sha, parent_ticket_id }) =>
      ({ id, title, requester, model, kind, dev_status, created_at, landed_at, commit_sha, parent_ticket_id })),
    landings: input.store.knowledge.listLandedLandings().map(toLandingInput),
  };
  // Exclude landings ahead of this exact deployment target.
  const contained = [];
  for (const landing of runtime.landings) {
    if ((await git(input.repoDir, ["merge-base", "--is-ancestor", landing.to_sha, input.target])).ok) contained.push(landing);
  }
  runtime.landings = contained;
  const remote = projections.get(input.store);
  type Projection = Pick<GraphSnapshot, "nodes" | "conflicts">;
  let current: Projection;
  let previous: Projection | null = null;
  try {
    if (!remote && process.env.OCTOPUS_COMPUTE_ROLE === "control") throw new Error("上线知识审查的远端 provider 未绑定；禁止在控制节点重建图谱");
    const project = async (ref: string) => remote ? remote({ repoDir: input.repoDir, ref, runtime })
      : (await buildGraph({ repoDir: input.repoDir, ref, runtime })).snapshot;
    current = await project(input.target);
    if (input.previous && input.previous !== input.target) previous = await project(input.previous);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    const reason = (error instanceof Error ? error.message : String(error)).slice(0, 300);
    log.warn({ target: input.target, previous: input.previous ?? null, err: reason }, "knowledge deploy review could not run; proceeding without a verdict");
    input.onUnavailable?.(reason);
    return;
  }
  const nodes = new Map(current.nodes.map((node) => [node.id, node]));
  const conflicts = [...current.conflicts];
  if (previous) {
    for (const node of previous.nodes) {
      if (knowledgeStrength(node) !== "human_required") continue;
      const next = nodes.get(node.id);
      if (next && next.statement === node.statement && next.status === node.status && knowledgeStrength(next) === "human_required") continue;
      // Editing/deleting a source or weakening its evidence cannot erase debt.
      const originalId = `${node.id}:before`;
      nodes.set(originalId, { ...node, id: originalId });
      conflicts.push({ id: `required_record_changed:${node.id}`.slice(0, 400), rule: "required_record_changed", a_id: originalId, b_id: next?.id ?? null, why: "候选修改、删除或降低了用户原始要求的证据。", severity: "high" });
    }
  }
  const reviews = input.store.knowledge.listReviews();
  const blocked = conflicts.filter((conflict: ConflictCandidate) => reviewPolicy(conflict, [nodes.get(conflict.a_id) ?? null, nodes.get(conflict.b_id ?? "") ?? null], reviews).blocked);
  for (const conflict of blocked) {
    const sides = [nodes.get(conflict.a_id) ?? null, nodes.get(conflict.b_id ?? "") ?? null];
    input.store.knowledge.recordReviewCandidate({ conflict, nodes: sides, target_sha: input.target, fingerprint: reviewPolicy(conflict, sides, reviews).fingerprint });
  }
  if (blocked.length) throw new Error(`知识裁决阻止上线：${blocked.slice(0, 8).map((conflict) => conflict.id).join("、")}。管理员需在知识库对应冲突页点「批准此修改」确认当前修改；普通确认和 Agent 自批无效。`);
}
