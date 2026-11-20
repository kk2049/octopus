import { uiText, localizedLabels } from "../../i18n/ui-text.js";
/**
 * Wire types for `/api/knowledge*` — this page's reading of the server
 * (`packages/bot/src/dashboard/knowledge.ts`), declared in place like the
 * architecture page does. Every render is defensive: a missing array is empty.
 */

export interface WikiStatement {
  id: string;
  kind: string;
  statement: string;
  status: string;
  authority: string;
  certainty: string;
  realization?: string;
  source_ref: string;
  source_sha: string;
  valid_from?: string;
  valid_to?: string;
  detail: {
    strength?: "agent_inferred" | "human_reviewed" | "human_required";
    provenance?: { author: { kind: string; name: string; model: string | null; ref: string; at?: string }; basis: string[]; critical?: string; events: Array<{ kind: string; actor: string; at: string; ref: string; quote: string; design: string }> };
    ticket?: number | null;
    rationale?: string | null;
    quote?: string | null;
    conflict_note?: string | null;
    mandatory_facts?: string[];
    tickets?: number[];
    commands?: string[];
    zone?: string;
    trust?: string;
    criticality?: string;
    modules?: string[];
    docs?: string[];
    aliases?: string[];
    summary?: string;
    lane?: string;
    to_sha?: string;
    introduced?: string;
    superseded_by?: string | null;
    merged_from?: string[];
    global?: boolean;
    lifecycle_source?: string;
    origins?: Array<{
      ticket: number;
      requester: string;
      role: "user_requirement" | "task_evolution";
      /** How the origin ticket's opening request was written; absent = unknown. */
      actor_kind?: string;
    }>;
  };
}

export interface WikiCapabilitySummary {
  id: string;
  kind: "product" | "concern";
  label: string;
  description: string;
  modules: number;
  counts: Record<string, number>;
  direct: number;
}

export interface WikiReviewState {
  decision: string;
  note: string;
  actor: string;
  at: string;
}

export interface WikiConflict {
  policy?: { fingerprint: string; required: boolean; approved: boolean; blocked: boolean; investigation: { record_id: string; original_motivation: string; proposed_motivation: string; proposed_behavior: string; alternatives: string; impact: string; verification: string } | null };
  id: string;
  rule: string;
  severity: string;
  why: string;
  object: WikiStatement | null;
  explanation: string;
  a: WikiStatement | null;
  b: WikiStatement | null;
  review: WikiReviewState | null;
}

export interface WikiKnowledgeAnnotation {
  id: number;
  body: string;
  actor: string;
  at: string;
}

export interface WikiConflictWorkspace {
  subject_id: string;
  conflict: WikiConflict | null;
  review: WikiReviewState | null;
  annotations: WikiKnowledgeAnnotation[];
  terminal: boolean;
  history?: Array<{ decision: string; note: string; actor: string; at: string }>;
}

export interface WikiKnowledgeChat {
  id: string;
  subject_id: string | null;
  title: string;
  preview: string;
  created_at: string;
  updated_at: string;
  running_since: string | null;
}

export interface WikiKnowledgeChatMessage {
  id: number;
  chat_id: string;
  role: "user" | "assistant" | "error";
  content: string;
  at: string;
}

export interface WikiKnowledgeChatList {
  enabled: boolean;
  model: string | null;
  /** One roster window, most recently active first. */
  chats: WikiKnowledgeChat[];
  /** Cursor of the next (older) window; null/absent when this is the last. */
  next_before?: string | null;
}

export interface WikiKnowledgeChatDetail {
  enabled: boolean;
  model: string;
  chat: WikiKnowledgeChat;
  /** One window, oldest first; `has_earlier` means `?before=<first id>` has more. */
  messages: WikiKnowledgeChatMessage[];
  /** Absent from a server before history paging, which offered no older window. */
  has_earlier?: boolean;
  read_only: boolean;
  read_only_reason: string | null;
}

export interface WikiOverview {
  generated: boolean;
  meta?: { commit: string; built_at: string; nodes: number; edges: number; byKind: Record<string, number> };
  capabilities: WikiCapabilitySummary[];
  review: {
    conflictsOpen: number;
    conflictsDismissed: number;
    conflictsConfirmed: number;
    ambiguous: number;
    adrLegacy: number;
    adrPlanned: number;
    staleAnchors: number;
    unmappedModules: number;
    emptyCapabilities: number;
    ticketsWithoutKnowledge: number;
  };
  landings: WikiStatement[];
}

export type WikiArtifactEvaluationState = "pending" | "running" | "passed" | "failed" | "unavailable";

export interface WikiArtifactEvaluationHealth {
  scope?: "repository" | "artifact";
  executor?: string;
  state: WikiArtifactEvaluationState;
  startedAt: string | null;
  finishedAt: string | null;
  failureCode: string | null;
  metrics: Record<string, number | boolean>;
}

export interface WikiArtifactActivationHealth {
  repoSha: string;
  manifestDigest: string;
  activatedAt: string;
  evaluations: {
    journeys: WikiArtifactEvaluationHealth;
    vectorBenchmark: WikiArtifactEvaluationHealth;
  };
}

export interface WikiArtifactHealth {
  configured: boolean;
  status: "healthy" | "evaluating" | "degraded" | "unavailable";
  protocolAvailable: boolean;
  vectorSearchOnline: boolean;
  active: (WikiArtifactActivationHealth & {
    ageMs: number;
    baselineRef: string | null;
    baselineSha: string | null;
    commitsBehind: number | null;
    baselineCheckedAt: string | null;
  }) | null;
  task: {
    phase: "idle" | "prepared" | "remote" | "pulling" | "failed" | "stale";
    remoteState: "queued" | "running" | "upload_pending" | "succeeded" | "failed" | "cancellation_requested" | "cancelled" | "timed_out" | "orphaned" | null;
    reconcileStep: string | null;
    unavailableReason?: string | null;
    provider?: { owner: string; device: string };
  };
  lastFailureCode: string | null;
  lastFailureAt: string | null;
  recentActivations: WikiArtifactActivationHealth[];
}

export interface WikiCapabilityView {
  capability: WikiStatement;
  modules: WikiStatement[];
  constraints: WikiStatement[];
  principles: WikiStatement[];
  decisions: WikiStatement[];
  requirements: WikiStatement[];
  nonGoals: WikiStatement[];
  risks: WikiStatement[];
  patterns: WikiStatement[];
  landings: WikiStatement[];
  docs: string[];
  unknown: string[];
}

export interface WikiEdgeGroup {
  relation: string;
  /** Every neighbour on the relation; `EdgeGroups` windows the display. */
  nodes: WikiStatement[];
  total: number;
}

export interface WikiNodeView {
  repair_fingerprint?: string;
  history?: Array<{ decision: string; actor: string; at: string; note: string }>;
  node: WikiStatement;
  out: WikiEdgeGroup[];
  in: WikiEdgeGroup[];
  conflicts: WikiConflict[];
}

export interface WikiGraphNode {
  id: string;
  kind: string;
  statement: string;
  status: string;
  authority: string;
  certainty: string;
  source_ref: string;
}

export interface WikiGraphEdge {
  from_id: string;
  relation: string;
  to_id: string;
  certainty: string;
}

export interface WikiGraphView {
  generated: boolean;
  meta?: { commit: string; built_at: string };
  nodes: WikiGraphNode[];
  edges: WikiGraphEdge[];
}

export interface WikiSearchView {
  query: string;
  statements: WikiStatement[];
  capabilities: Array<{ id: string; certainty: string; why: string[] }>;
  modules: WikiStatement[];
}

export interface WikiPreview {
  text: string;
  included: number;
  capabilities: Array<{ id: string; certainty: string; why: string[] }>;
  unknown: string[];
  chars: number;
}

export type WikiClassificationDimension =
  | "capability"
  | "scenario"
  | "provider"
  | "launch_mode"
  | "state"
  | "action"
  | "path"
  | "symbol";

export interface WikiClassificationAudit {
  dimension: WikiClassificationDimension;
  value: string;
  certainty: "exact" | "inferred" | "ambiguous";
  score: number;
  reason_codes: Array<"explicit_path" | "explicit_typed" | "alias" | "lexical" | "vector">;
}

export type WikiRetrievalSlot =
  | "contract_principle"
  | "scenarios"
  | "sources_requirements"
  | "decisions_exceptions"
  | "actions_symbols"
  | "tests_evidence"
  | "landings_patterns"
  | "unknown_conflicts";

export type WikiRetrievalErrorCode =
  | "graph_unavailable"
  | "index_failed"
  | "manifest_invalid"
  | "checksum_mismatch"
  | "model_binding_mismatch"
  | "dimension_mismatch"
  | "stale_source_sha"
  | "privacy_denied"
  | "index_missing"
  | "embed_timeout"
  | "provider_unavailable"
  | "pack_failed"
  | "telemetry_receipt_missing"
  | "telemetry_receipt_invalid";

export interface WikiIndexIdentity {
  id: string;
  kind: "graph_exact" | "fts5_trigram" | "vector" | "scip" | "typescript_ls";
  artifact_sha256: string;
  source_git_sha: string;
  graph_sha256?: string;
  manifest_schema: number;
  record_schema_version: number;
  record_count: number;
  freshness: "exact" | "stale" | "unavailable";
  embedding?: {
    provider: string;
    model_id: string;
    immutable_revision: string;
    dimensions: number;
    dtype: "float32";
    normalized: true;
    distance: "cosine";
  };
}

export interface WikiIndexAttemptAudit {
  index: WikiIndexIdentity;
  status: "ok" | "degraded" | "rejected";
  latency_ms: number;
  privacy_decision?: "allow" | "redact" | "local_only" | "deny";
  error_code?: WikiRetrievalErrorCode;
  hits: Array<{ record_id: string; rank: number; raw_score: number }>;
}

export interface WikiCandidateAudit {
  record_id: string;
  kind: string;
  source_ref: string;
  source_sha: string;
  fused_rank: number;
  fused_score: number;
  signals: Array<{ index_id: string; rank: number; raw_score: number; rrf_contribution: number }>;
  allowed_edge_path?: Array<{ from: string; relation: string; to: string }>;
  rerank: Array<{ feature: string; contribution: number }>;
  dropped?: "superseded" | "stale_index" | "disallowed_relation" | "duplicate" | "slot_full" | "budget";
}

export interface WikiSlotAudit {
  slot: WikiRetrievalSlot;
  ordinal: number;
  record_id: string;
  candidate_rank: number;
  final_score: number;
  chars: number;
  reason_codes: string[];
}

export interface WikiRetrievalReviewRow {
  trace_id: string;
  lane: "ticket" | "cli";
  purpose: "startup" | "path_refinement" | "submit_check";
  subject_ref: string;
  turn?: number;
  parent_trace_id?: string;
  repo_sha: string;
  code_index_sha?: string;
  vector_index_sha?: string;
  started_at: string;
  expires_at: string;
  outcome: "assembled" | "miss" | "error" | "abandoned" | "unknown";
  unknown_codes: string[];
  feedback_codes: string[];
}

export interface WikiRetrievalEvent {
  event: "started" | "assembled" | "miss" | "error" | "delivered" | "delivered_error" | "abandoned" | "reported_use" | "feedback";
  event_key: string;
  created_at: string;
  payload: {
    classifications?: WikiClassificationAudit[];
    indexes?: WikiIndexAttemptAudit[];
    candidates?: WikiCandidateAudit[];
    slots?: WikiSlotAudit[];
    context_keys?: Array<string | { record_id: string; origin: "offered" | "manual"; offered_by_trace?: string; slot?: WikiRetrievalSlot }>;
    unknown?: Array<{ code: string; slot?: WikiRetrievalSlot }>;
    budget?: { limit_chars: number; used_chars: number; dropped_records: number };
    performance?: { total_ms: number; rss_delta_bytes?: number };
    channel?: "ticket_prompt" | "mcp_response" | "cli_stdout" | "land_import";
    stage?: "classify" | "exact" | "lexical" | "vector" | "expand" | "rerank" | "assemble" | "delivery" | "receipt_import";
    code?: string;
    landing_ref?: string;
    slot?: WikiRetrievalSlot;
    expected_record_id?: string;
  };
}

export interface WikiRetrievalTraceDetail extends WikiRetrievalReviewRow {
  graph_input_fingerprint: string;
  worktree_input_fingerprint?: string;
  events: WikiRetrievalEvent[];
  events_total: number;
  events_has_more: boolean;
  events_next_before?: string;
}

export interface WikiRetrievalReviewList {
  items: WikiRetrievalReviewRow[];
  limit: number;
  has_more: boolean;
  next_before?: string;
}

export interface WikiTicketRetrievalPage {
  items: Array<{
    ticket_id: number;
    title: string;
    dev_status: string;
    startup: number;
    path_queries: number;
    delivered_queries: number;
    submit_checks: number;
    cited_records: number;
    feedback: number;
    last_query_at: string | null;
  }>;
  limit: number;
  has_more: boolean;
  next_before?: number;
}

export interface WikiReviewView {
  conflicts: WikiConflict[];
  ambiguous: Array<{ node: WikiStatement; review: WikiReviewState | null }>;
  adr: Array<{ node: WikiStatement; legacy: boolean }>;
  coverage: {
    modulesWithoutCapability: string[];
    emptyCapabilities: string[];
    ticketsWithoutKnowledge: { count: number; sample: number[] };
  };
}

export const KIND_LABEL = localizedLabels((): Record<string, string> => ({
  principle: uiText("原则"),
  capability: uiText("能力"),
  requirement: uiText("需求"),
  decision: uiText("决策"),
  non_goal: uiText("非目标"),
  risk: uiText("风险"),
  module: uiText("模块"),
  path: uiText("路径"),
  zone: uiText("信任区"),
  flow: uiText("流程"),
  constraint: uiText("约束"),
  evidence: uiText("证据"),
  landing: uiText("落地"),
  ticket: uiText("工单"),
  doc: uiText("文档"),
  pattern: uiText("复发模式"),
  capability_contract: uiText("能力契约"),
  obligation: uiText("义务"),
  scenario: uiText("场景"),
  exception: uiText("例外"),
  source: uiText("来源"),
  artifact: uiText("工件"),
  desired_conformance: uiText("目标符合性"),
  observed_conformance: uiText("观测符合性"),
}));

export const AUTHORITY_LABEL = localizedLabels((): Record<string, string> => ({
  always_on: uiText("常驻规则"),
  path_rule: uiText("路径规则"),
  package: uiText("包级文档"),
  adr: "ADR",
  user: uiText("用户/落地"),
  curated: uiText("回填"),
  declared: uiText("声明"),
  derived: uiText("派生"),
  record: uiText("记录"),
}));

export const STATUS_LABEL = localizedLabels((): Record<string, string> => ({
  active: uiText("现行"),
  proposed: uiText("提案"),
  superseded: uiText("已取代"),
  rejected: uiText("已否决"),
  historical: uiText("历史"),
}));

export const RELATION_LABEL = localizedLabels((): Record<string, string> => ({
  governs: uiText("约束着"),
  enforced_by: uiText("由…机械保证"),
  motivates: uiText("引出"),
  realizes: uiText("落实于"),
  rejects: uiText("否决了"),
  supersedes: uiText("取代了"),
  bounds: uiText("限定"),
  implements: uiText("实现了"),
  touches: uiText("触及"),
  about: uiText("关于"),
  spans: uiText("覆盖"),
  in_zone: uiText("属于信任区"),
  owns: uiText("拥有路径"),
  passes_through: uiText("经过"),
  constrains: uiText("约束"),
  constrained_by: uiText("受约束"),
  evidences: uiText("佐证"),
  observed_in: uiText("出现于"),
  guards: uiText("守护"),
  anchors: uiText("锚定"),
  documented_by: uiText("文档"),
  parent_of: uiText("下级能力"),
  conflicts_with: uiText("冲突"),
  contract_for: uiText("契约适用于"),
  defines: uiText("定义"),
  derives_from: uiText("派生自"),
  applies_to: uiText("适用于"),
  requires: uiText("要求"),
  waives: uiText("豁免"),
  supported_by: uiText("由来源支持"),
  observes: uiText("观测"),
  realized_by: uiText("由工件实现"),
  verified_by: uiText("由测试验证"),
  reaffirms: uiText("重申"),
}));

export const RULE_LABEL = localizedLabels((): Record<string, string> => ({
  required_revision: uiText("用户要求待调整"),
  design_revision: uiText("设计调整"),
  required_record_changed: uiText("原要求被改动"),
  non_goal_vs_requirement: uiText("非目标 vs 新需求"),
  supersedes_not_mutual: uiText("取代关系不互指"),
  dangling_supersedes: uiText("取代目标不存在"),
  proposed_referenced_as_current: uiText("提案被当作现行引用"),
  accepted_not_realized: uiText("已接受但未实现"),
  stale_anchor: uiText("锚点路径失效"),
  negation_pair: uiText("只差一个否定词"),
}));

export const DECISION_LABEL = localizedLabels((): Record<string, string> => ({
  approved_change: uiText("管理员已批准修改"),
  investigated: uiText("调查已保存"),
  question: uiText("曾提问，不构成背书"),
  dismissed: uiText("已忽略（误报）"),
  confirmed: uiText("已确认，待处理"),
  resolved: uiText("已处理（Git 已回写）"),
  reopened: uiText("重新打开"),
}));

/**
 * A review note as a person reads it. Approvals and investigations are stored
 * as JSON receipts; questions and older decisions are plain text.
 */
export function reviewNoteText(note: string): string {
  try {
    const data = JSON.parse(note) as Record<string, unknown> | null;
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const investigation = data.investigation as Record<string, unknown> | null | undefined;
      if (investigation && typeof investigation === "object") {
        return ["original_motivation", "proposed_motivation", "proposed_behavior", "alternatives", "impact", "verification"]
          .map((field) => investigation[field]).filter((value) => typeof value === "string").join("\n");
      }
      if (typeof data.fingerprint === "string") {
        const text = typeof data.note === "string" ? data.note : typeof data.design_review === "string" ? data.design_review : "";
        return text || uiText("已确认批准，未附说明");
      }
    }
  } catch { /* A plain-text note. */ }
  return note;
}

/** Node id → the wiki view that renders it. */
export function viewForId(id: string): { v: string; id: string } {
  if (id.startsWith("capability:")) return { v: "capability", id: id.replace(/^capability:/, "") };
  if (id.startsWith("module:")) return { v: "module", id: id.replace(/^module:/, "") };
  return { v: "node", id };
}

/** `.claude/rules/frontend-stability.md#interaction-state-ownership:25` → `frontend-stability.md:25`. */
export function shortSource(ref: string): string {
  const ticket = /^ticket:(\d+)\/landing:(\d+)/.exec(ref);
  if (ticket) return uiText("#{v0} 落地 {v1}", { v0: ticket[1], v1: ticket[2] });
  const match = /^(.*?)(?::(\d+))?$/.exec(ref);
  const file = (match?.[1] ?? ref).split("#")[0];
  const parts = file.split("/");
  const tail = parts.length > 2 && /^(CLAUDE|README|DEVELOPMENT)\.md$/.test(parts.at(-1) ?? "") ? parts.slice(-2).join("/") : parts.at(-1) ?? file;
  return match?.[2] ? `${tail}:${match[2]}` : tail;
}
