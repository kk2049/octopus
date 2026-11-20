import { statementKey } from "./ids.js";
import type { ConflictCandidate, KnowledgeEdge, KnowledgeNode } from "./model.js";
import { pathExists } from "./sources/curated.js";
import { knowledgeStrength } from "./provenance.js";

const NEGATION = /不得|不能|不应|不要|禁止|不可|never|must not|cannot|do not|don't|forbid/gi;
const OBLIGATION = /必须|应当|应该|总是|always|must|should/gi;

export interface ConflictInputs {
  nodes: Map<string, KnowledgeNode>;
  edges: KnowledgeEdge[];
  existingPaths: ReadonlySet<string> | null;
}

function trigrams(text: string): Set<string> {
  const key = statementKey(text);
  const out = new Set<string>();
  for (let index = 0; index + 3 <= key.length; index += 1) out.add(key.slice(index, index + 3));
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/**
 * Deterministic conflict candidates. The build never resolves any of them: a
 * candidate is routed to a human with both sides' sources (design §5.5).
 */
export function detectConflicts(input: ConflictInputs): ConflictCandidate[] {
  const out: ConflictCandidate[] = [];
  const push = (rule: string, a: string, b: string | null, why: string, severity: ConflictCandidate["severity"]) => {
    out.push({ id: `${rule}:${a}${b ? `:${b}` : ""}`.slice(0, 400), rule, a_id: a, b_id: b, why, severity });
  };
  const byTarget = new Map<string, KnowledgeEdge[]>();
  const bySource = new Map<string, KnowledgeEdge[]>();
  for (const edge of input.edges) {
    (byTarget.get(edge.to_id) ?? byTarget.set(edge.to_id, []).get(edge.to_id))!.push(edge);
    (bySource.get(edge.from_id) ?? bySource.set(edge.from_id, []).get(edge.from_id))!.push(edge);
  }

  // Explicitly investigated revisions include low-strength disagreements too.
  // Strength decides deployment obligations; heuristic severity never does.
  for (const edge of input.edges) {
    if (edge.relation !== "conflicts_with") continue;
    const target = input.nodes.get(edge.to_id);
    if (!target) continue;
    if (knowledgeStrength(target) === "human_required" && (bySource.get(edge.from_id) ?? []).some((candidate) => candidate.relation === "supersedes" && candidate.to_id === edge.to_id)) continue;
    push("design_revision", edge.to_id, edge.from_id, "Agent 已声明设计调整；核对原始动机、实现需要、替代方案与验证。", knowledgeStrength(target) === "human_required" ? "high" : "review");
  }

  // 1. ADR supersession must be mutual when both sides declare frontmatter.
  for (const node of input.nodes.values()) {
    const lifecycle = (node.metadata?.lifecycle ?? null) as { source?: string; supersedes?: string[]; superseded_by?: string[] } | null;
    if (node.kind !== "decision" || !lifecycle || lifecycle.source !== "frontmatter") continue;
    for (const other of lifecycle.supersedes ?? []) {
      const target = input.nodes.get(`decision:adr:${other.padStart(4, "0")}`);
      const back = (target?.metadata?.lifecycle ?? null) as { source?: string; superseded_by?: string[] } | null;
      if (target && back?.source === "frontmatter" && !(back.superseded_by ?? []).some((value) => value.padStart(4, "0") === String(node.metadata?.adr).padStart(4, "0"))) {
        push("supersedes_not_mutual", node.id, target.id, `${node.id} declares it supersedes ${target.id}, but the target does not declare superseded_by`, "review");
      }
    }
  }

  // 2. A proposed or rejected ADR cited as a current module/capability document.
  for (const edge of input.edges) {
    if (edge.relation !== "documented_by") continue;
    const doc = input.nodes.get(edge.to_id);
    if (doc?.kind === "doc" && (doc.status === "proposed" || doc.status === "rejected")) {
      push("proposed_referenced_as_current", edge.from_id, doc.id, `${edge.from_id} cites ${doc.source_ref} (status ${doc.status}) as a current document`, "review");
    }
  }

  // 3. Accepted-but-unrealized decisions referenced as current by a capability.
  for (const node of input.nodes.values()) {
    if (node.kind !== "decision" || node.status !== "active" || node.realization !== "planned") continue;
    const cited = (byTarget.get(node.id) ?? []).some((edge) => edge.relation === "documented_by" || edge.relation === "about");
    if (cited) push("accepted_not_realized", node.id, null, `${node.source_ref} is accepted but realization is planned; do not treat it as current behaviour`, "info");
  }

  // 4. Evidence / anchor paths that no longer exist.
  if (input.existingPaths) {
    for (const node of input.nodes.values()) {
      if (node.kind !== "path") continue;
      if (pathExists(node.statement, input.existingPaths)) continue;
      const referrers = byTarget.get(node.id) ?? [];
      const serious = referrers.filter((edge) => edge.certainty === "exact" && (edge.relation === "touches" || edge.relation === "governs" || edge.relation === "guards" || edge.relation === "owns" || edge.relation === "realizes"));
      const declaredOnly = referrers.some((edge) => edge.method === "declared" || edge.method === "curated");
      if (serious.length && declaredOnly) {
        push("stale_anchor", node.id, serious[0].from_id, `${node.statement} is referenced by ${serious.length} exact edge(s) but does not exist at this commit`, "review");
      }
    }
  }

  // 5. Non-goal (active or recorded) vs active requirement on the same
  //    capability or module with overlapping wording.
  const capabilityMembers = new Map<string, { requirements: KnowledgeNode[]; nonGoals: KnowledgeNode[] }>();
  for (const edge of input.edges) {
    if (!["about", "bounds", "touches", "realizes", "governs"].includes(edge.relation)) continue;
    const target = input.nodes.get(edge.to_id);
    const source = input.nodes.get(edge.from_id);
    if (!target || (target.kind !== "capability" && target.kind !== "module") || !source) continue;
    if (source.kind === "requirement" && source.status !== "active") continue;
    if (source.kind === "non_goal" && source.status !== "active" && source.status !== "historical") continue;
    const bucket = capabilityMembers.get(target.id) ?? { requirements: [], nonGoals: [] };
    if (source.kind === "requirement") bucket.requirements.push(source);
    if (source.kind === "non_goal") bucket.nonGoals.push(source);
    capabilityMembers.set(target.id, bucket);
  }
  for (const [capability, bucket] of capabilityMembers) {
    for (const nonGoal of bucket.nonGoals) {
      const ng = trigrams(nonGoal.statement);
      for (const requirement of bucket.requirements) {
        if (requirement.valid_from && nonGoal.valid_from && requirement.valid_from < nonGoal.valid_from) continue;
        const score = jaccard(ng, trigrams(requirement.statement));
        if (score >= 0.35) {
          push("non_goal_vs_requirement", nonGoal.id, requirement.id, `${capability}: non-goal "${nonGoal.statement.slice(0, 80)}" overlaps newer requirement "${requirement.statement.slice(0, 80)}" (similarity ${score.toFixed(2)})`, "review");
        }
      }
    }
  }

  // 6. Two active statements on the same module that differ only by negation.
  const byModule = new Map<string, KnowledgeNode[]>();
  for (const edge of input.edges) {
    if (edge.relation !== "governs" && edge.relation !== "realizes") continue;
    const target = input.nodes.get(edge.to_id);
    const source = input.nodes.get(edge.from_id);
    if (!target || target.kind !== "module" || !source || source.status !== "active") continue;
    if (source.kind !== "principle" && source.kind !== "decision") continue;
    (byModule.get(target.id) ?? byModule.set(target.id, []).get(target.id))!.push(source);
  }
  for (const [module, members] of byModule) {
    const seen = new Map<string, KnowledgeNode>();
    for (const node of members) {
      const stripped = statementKey(node.statement.replace(NEGATION, " ").replace(OBLIGATION, " "));
      if (stripped.length < 8) continue;
      const negated = NEGATION.test(node.statement);
      NEGATION.lastIndex = 0;
      const previous = seen.get(stripped);
      if (previous && previous.id !== node.id) {
        const previousNegated = NEGATION.test(previous.statement);
        NEGATION.lastIndex = 0;
        if (previousNegated !== negated) {
          push("negation_pair", previous.id, node.id, `${module}: "${previous.statement.slice(0, 80)}" and "${node.statement.slice(0, 80)}" differ only by negation`, "high");
        }
      } else {
        seen.set(stripped, node);
      }
    }
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}
