import type { KnowledgeNode } from "../knowledge/model.js";
import { parseSpecifications, SPECIFICATIONS_SCHEMA } from "../knowledge/specifications.js";
import { KNOWLEDGE_CHANGE_SCHEMA, parseKnowledgeChanges } from "../knowledge/changes.js";
import type { KnowledgeSearchHit, LandingKnowledge } from "../store/repositories/knowledge.js";

const MAX_ITEMS = 20;
const MAX_ITEM_CHARS = 800;
const MAX_SUMMARY_CHARS = 2_000;

export const LANDING_KNOWLEDGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "summary",
    "requirements",
    "decisions",
    "non_goals",
    "risks",
    "verification",
    "context_keys",
    "supersedes",
  ],
  properties: {
    specifications: SPECIFICATIONS_SCHEMA,
    changes: KNOWLEDGE_CHANGE_SCHEMA,
    summary: { type: "string", minLength: 1, maxLength: MAX_SUMMARY_CHARS },
    requirements: { type: "array", minItems: 1, maxItems: MAX_ITEMS, items: { type: "string", minLength: 1, maxLength: MAX_ITEM_CHARS } },
    decisions: { type: "array", minItems: 1, maxItems: MAX_ITEMS, items: { type: "string", minLength: 1, maxLength: MAX_ITEM_CHARS } },
    non_goals: { type: "array", maxItems: MAX_ITEMS, items: { type: "string", minLength: 1, maxLength: MAX_ITEM_CHARS } },
    risks: { type: "array", maxItems: MAX_ITEMS, items: { type: "string", minLength: 1, maxLength: MAX_ITEM_CHARS } },
    verification: { type: "array", minItems: 1, maxItems: MAX_ITEMS, items: { type: "string", minLength: 1, maxLength: MAX_ITEM_CHARS } },
    context_keys: { type: "array", maxItems: 50, items: { type: "string", minLength: 1, maxLength: 200 } },
    supersedes: { type: "array", maxItems: MAX_ITEMS, items: { type: "string", minLength: 1, maxLength: 200 } },
  },
} as const;

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${field} 必须是字符串`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} 不能为空`);
  if (normalized.length > max) throw new Error(`${field} 不能超过 ${max} 字符`);
  return normalized;
}

function list(value: unknown, field: string, min: number, max = MAX_ITEMS): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new Error(`${field} 必须有 ${min}-${max} 项`);
  }
  const items = value.map((item, index) => text(item, `${field}[${index}]`, MAX_ITEM_CHARS));
  if (new Set(items).size !== items.length) throw new Error(`${field} 不得包含重复项`);
  return items;
}

/** Strict parse at the trusted submit boundary; no coercion or undocumented fields. */
export function parseLandingKnowledge(value: unknown): LandingKnowledge {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("knowledge 必须是 object");
  const record = value as Record<string, unknown>;
  const allowed = new Set(Object.keys(LANDING_KNOWLEDGE_SCHEMA.properties));
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`knowledge 未知字段: ${unknown.join(", ")}`);
  const changes = record.changes === undefined ? [] : parseKnowledgeChanges(record.changes);
  const supersedes = list(record.supersedes, "knowledge.supersedes", 0);
  if (supersedes.some((id) => !changes.some((change) => change.record_id === id))) throw new Error("取代现有知识必须在 knowledge.changes 调查两边动机、行为、替代方案、影响和验证");
  return {
    // Optional record (#522); an empty list is the same as omitting it.
    ...(record.specifications === undefined || (Array.isArray(record.specifications) && record.specifications.length === 0)
      ? {} : { specifications: parseSpecifications(record.specifications) }),
    summary: text(record.summary, "knowledge.summary", MAX_SUMMARY_CHARS),
    requirements: list(record.requirements, "knowledge.requirements", 1),
    decisions: list(record.decisions, "knowledge.decisions", 1),
    non_goals: list(record.non_goals, "knowledge.non_goals", 0),
    risks: list(record.risks, "knowledge.risks", 0),
    verification: list(record.verification, "knowledge.verification", 1),
    context_keys: list(record.context_keys, "knowledge.context_keys", 0, 50),
    supersedes,
    ...(changes.length ? { changes } : {}),
  };
}

const MAX_CONTEXT_ITEM_CHARS = 1_500;

/**
 * Bounded, labelled evidence block: retrieval is context, never an unlabelled
 * instruction. Whole-document records are clipped per item and an item that
 * still does not fit is skipped, not the rest of the list — the 2026-08-19
 * `break` produced an empty pack whenever the first hit was a long file.
 */
export function formatKnowledgeContext(hits: readonly KnowledgeSearchHit[], maxChars = 12_000): string {
  if (!hits.length) return "(没有命中现行知识记录；不要把这理解为没有约束。仍须读取改动路径的规则和包级文档。)";
  const blocks: string[] = [];
  let used = 0;
  let skipped = 0;
  for (const hit of hits) {
    const body = hit.body.length > MAX_CONTEXT_ITEM_CHARS
      ? `${hit.body.slice(0, MAX_CONTEXT_ITEM_CHARS)}\n…(已截断，完整内容按 source 读取)`
      : hit.body;
    const block = [
      `[${hit.record_key}] ${hit.kind}/${hit.status}/${hit.authority}/confidence=${hit.confidence}`,
      hit.title,
      body,
      `source: ${hit.source_ref}${hit.source_sha ? ` @ ${hit.source_sha.slice(0, 12)}` : ""}`,
    ].join("\n");
    if (used + block.length > maxChars) {
      skipped += 1;
      continue;
    }
    blocks.push(block);
    used += block.length;
  }
  if (skipped) blocks.push(`(另有 ${skipped} 条命中记录超出上下文预算未列出；需要时按 source 读取。)`);
  return blocks.join("\n\n---\n\n");
}

/** High-authority active hits must be named at submit, preventing silent context loss. */
export function unacknowledgedKnowledge(
  hits: readonly KnowledgeSearchHit[],
  knowledge: LandingKnowledge,
): KnowledgeSearchHit[] {
  const acknowledged = new Set([...knowledge.context_keys, ...knowledge.supersedes]);
  return hits.filter((hit) =>
    hit.status === "active"
    && hit.confidence >= 0.9
    && ["user", "accepted", "declared"].includes(hit.authority)
    && ["requirement", "decision", "constraint"].includes(hit.kind)
    && !acknowledged.has(hit.record_key));
}

/** Graph-backed twin of `knowledgeTestFiles`: evidence test files of exactly-linked atlas constraints. */
export function constraintEvidenceTests(constraints: readonly KnowledgeNode[]): string[] {
  const files = new Set<string>();
  for (const node of constraints) {
    if (node.status !== "active") continue;
    const evidence = node.metadata?.evidence;
    if (!Array.isArray(evidence)) continue;
    for (const item of evidence) {
      const candidate = (item as { source?: { path?: unknown } } | null)?.source?.path;
      if (typeof candidate === "string" && /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(candidate)) files.add(candidate);
    }
  }
  return [...files];
}

/**
 * Only the declared executable evidence of an active architecture constraint
 * becomes an automatic test candidate. Historical patterns are context: they
 * are retrieved lexically and must never turn a rename into a fail-closed
 * landing refusal.
 */
export function knowledgeTestFiles(hits: readonly KnowledgeSearchHit[]): string[] {
  const files = new Set<string>();
  for (const hit of hits) {
    if (hit.status !== "active") continue;
    let metadata: unknown;
    try {
      metadata = JSON.parse(hit.metadata);
    } catch {
      continue;
    }
    if (!metadata || typeof metadata !== "object") continue;
    if (hit.source_type !== "architecture_constraint" || !("evidence" in metadata) || !Array.isArray(metadata.evidence)) {
      continue;
    }
    for (const item of metadata.evidence) {
      if (!item || typeof item !== "object" || !("source" in item)) continue;
      const source = item.source;
      if (!source || typeof source !== "object" || !("path" in source)) continue;
      const candidate = source.path;
      if (typeof candidate === "string" && /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(candidate)) files.add(candidate);
    }
  }
  return [...files];
}
