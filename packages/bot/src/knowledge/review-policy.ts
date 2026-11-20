import type { ConflictCandidate, KnowledgeNode } from "./model.js";
import { conflictFingerprint, knowledgeStrength } from "./provenance.js";
import { parseKnowledgeChanges, type KnowledgeChange } from "./changes.js";

export interface ReviewRecord { subject_id: string; decision: string; note: string; actor: string; created_at: string }
const DESIGN_CONFLICTS = new Set(["required_revision", "design_revision", "negation_pair", "non_goal_vs_requirement", "required_record_changed"]);

export function investigationFor(nodes: readonly (KnowledgeNode | null)[]): KnowledgeChange | null {
  for (const node of nodes) {
    const changes = node?.metadata?.changes;
    if (!Array.isArray(changes)) continue;
    const change = changes.find((value) => nodes.some((side) => side?.id === value.record_id || (side?.metadata?.alias_ids as string[] | undefined)?.includes(value.record_id)));
    if (change) {
      try { return parseKnowledgeChanges([change])[0]!; } catch { /* Incomplete source investigation is not evidence. */ }
    }
  }
  return null;
}

export function reviewPolicy(conflict: ConflictCandidate, nodes: readonly (KnowledgeNode | null)[], reviews: readonly ReviewRecord[]) {
  const sourceFingerprint = conflictFingerprint(conflict.id, nodes);
  let investigation = investigationFor(nodes);
  for (const review of reviews.filter((row) => row.subject_id === conflict.id && row.decision === "investigated")) {
    try {
      const receipt = JSON.parse(review.note);
      if (receipt.source_fingerprint !== sourceFingerprint) continue;
      const [change] = parseKnowledgeChanges([receipt.investigation]);
      if (nodes.some((node) => node?.id === change.record_id)) investigation = change;
    } catch { /* Partial or stale investigations never authorize a change. */ }
  }
  const fingerprint = conflictFingerprint(conflict.id, nodes, investigation);
  const required = DESIGN_CONFLICTS.has(conflict.rule) && nodes.some((node) => node && knowledgeStrength(node) === "human_required");
  const latest = reviews.filter((review) => review.subject_id === conflict.id && ["approved_change", "reopened"].includes(review.decision)).at(-1);
  let approved = false;
  if (latest?.decision === "approved_change") {
    try {
      // One explicit administrator confirmation of the exact content shown
      // (the fingerprint covers both sides and the investigation). Any note is
      // optional context; a changed conflict needs a new confirmation.
      const receipt = JSON.parse(latest.note);
      approved = investigation !== null && receipt.fingerprint === fingerprint;
    } catch { /* Legacy free-text decisions are not deployment receipts. */ }
  }
  return { fingerprint, required, approved, blocked: required && !approved, investigation };
}
