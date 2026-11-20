/**
 * Typed development knowledge graph — shared vocabulary.
 *
 * Design: doc/development/2026-08-20-knowledge-graph-redesign.md §3.
 * Everything here describes the rebuildable derived layer (`graph.db`).
 * Authoritative facts stay where they are produced (Git, docs, atlas,
 * `ticket_landings`); this module only projects them.
 */

export const NODE_KINDS = [
  "principle",
  "capability",
  "requirement",
  "decision",
  "non_goal",
  "risk",
  "module",
  "path",
  "zone",
  "flow",
  "constraint",
  "evidence",
  "landing",
  "ticket",
  "doc",
  "pattern",
  "capability_contract",
  "obligation",
  "scenario",
  "exception",
  "source",
  "artifact",
  "desired_conformance",
  "observed_conformance",
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

/** Kinds whose statement is a claim about the system, not an identifier. */
export const STATEMENT_KINDS: ReadonlySet<NodeKind> = new Set([
  "principle",
  "requirement",
  "decision",
  "non_goal",
  "risk",
  "pattern",
]);

export const NODE_STATUSES = ["active", "proposed", "superseded", "rejected", "historical"] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

export const AUTHORITIES = [
  "always_on",
  "path_rule",
  "package",
  "adr",
  "user",
  "curated",
  "declared",
  "derived",
  "record",
] as const;
export type Authority = (typeof AUTHORITIES)[number];

/** Ranking weight: higher wins ties and orders the startup pack. */
export const AUTHORITY_RANK: Record<Authority, number> = {
  always_on: 9,
  path_rule: 8,
  declared: 7,
  adr: 7,
  user: 7,
  package: 6,
  curated: 4,
  derived: 3,
  record: 2,
};

export const REALIZATIONS = ["not_applicable", "planned", "partial", "implemented"] as const;
export type Realization = (typeof REALIZATIONS)[number];

export const METHODS = ["declared", "parsed", "landing", "git", "llm_extracted", "curated"] as const;
export type Method = (typeof METHODS)[number];

export const CERTAINTIES = ["exact", "inferred", "ambiguous"] as const;
export type Certainty = (typeof CERTAINTIES)[number];

export const RELATIONS = [
  "governs", // principle → module | path | zone | capability
  "enforced_by", // principle → constraint | evidence
  "motivates", // requirement → decision
  "realizes", // decision → module | path
  "rejects", // decision → decision (alternative captured as node)
  "supersedes", // decision | principle | requirement → same kind
  "bounds", // non_goal → capability | module
  "implements", // landing → requirement | decision | non_goal | risk
  "touches", // landing | doc → path | module
  "about", // ticket | requirement | decision | landing | doc | pattern → capability | ticket
  "spans", // capability → module | flow | zone
  "in_zone", // module → zone
  "owns", // module → path
  "passes_through", // flow → module
  "constrains", // constraint → module
  "constrained_by", // capability → constraint
  "evidences", // evidence → constraint | decision | principle | pattern
  "observed_in", // pattern → ticket
  "guards", // pattern → module | path
  "anchors", // doc → principle | decision | non_goal | risk
  "documented_by", // module | capability → doc
  "parent_of", // capability → capability
  "conflicts_with", // any → any (candidate only)
  "contract_for", // capability_contract → capability
  "defines", // capability_contract → principle | obligation | scenario | desired_conformance
  "derives_from", // obligation → principle | requirement | decision
  "applies_to", // desired_conformance → scenario
  "requires", // desired_conformance → obligation
  "waives", // exception → obligation | desired_conformance | constraint
  "supported_by", // assertion/contract entity → source
  "observes", // observed_conformance → desired_conformance
  "realized_by", // obligation | scenario | desired_conformance | observed_conformance → artifact
  "verified_by", // scenario | desired_conformance | observed_conformance | obligation → test artifact
  "reaffirms", // newer typed assertion → same kind without superseding it
] as const;
export type Relation = (typeof RELATIONS)[number];

export const MAX_STATEMENT_CHARS = 400;
export const MAX_QUOTE_CHARS = 120;

export interface KnowledgeNode {
  /** `<kind>:<stable key>`; see ids.ts. */
  id: string;
  kind: NodeKind;
  /** ≤ MAX_STATEMENT_CHARS. For identifier kinds this is the label. */
  statement: string;
  status: NodeStatus;
  authority: Authority;
  realization?: Realization;
  /** File path (+ `#heading`), `ticket:<id>`, `landing:<id>`, `atlas:<kind>:<id>` … */
  source_ref: string;
  source_sha: string;
  valid_from?: string;
  valid_to?: string;
  method: Method;
  certainty: Certainty;
  /** Search aliases (capabilities) or short tags; indexed with the statement. */
  aliases?: string[];
  metadata?: Record<string, unknown>;
}

export interface KnowledgeEdge {
  from_id: string;
  relation: Relation;
  to_id: string;
  method: Method;
  certainty: Certainty;
  source_ref: string;
  source_sha: string;
  observed_at: string;
}

export interface CoverageRow {
  scope_kind: string;
  scope_id: string;
  measure: string;
  value: number;
  note?: string;
}

export interface ConflictCandidate {
  id: string;
  rule: string;
  a_id: string;
  b_id: string | null;
  why: string;
  severity: "info" | "review" | "high";
}
export const CONTRACT_DESIRED = ["required", "degraded", "unsupported", "not_applicable"] as const;
export type ContractDesired = (typeof CONTRACT_DESIRED)[number];

export const CONFORMANCE_STATUSES = ["conformant", "nonconformant", "unverified", "stale", "waived"] as const;
export type ConformanceStatus = (typeof CONFORMANCE_STATUSES)[number];

export const ARTIFACT_ROLES = ["handler", "adapter", "test", "config", "schema"] as const;
export type ArtifactRole = (typeof ARTIFACT_ROLES)[number];

/** One explicit provider × launch mode × state × action normative matrix cell. */
export interface ContractCell {
  id: string;
  contract_id: string;
  scenario_id: string;
  provider: string;
  launch_mode: string;
  state: string;
  action: string;
  desired: ContractDesired;
  expected_ux: string;
  trust_semantics: string;
  failure_semantics: string;
  exception_id?: string;
}

/** Generated observation for a desired cell at one graph/code-index baseline. */
export interface ConformanceObservation {
  id: string;
  cell_id: string;
  baseline_sha: string;
  code_index_sha?: string;
  verified_sha?: string;
  status: ConformanceStatus;
  reason: string;
}

/** Exact artifact evidence admitted into an observation. */
export interface ConformanceArtifact {
  observation_id: string;
  artifact_id: string;
  role: ArtifactRole;
}


export interface BuildMeta {
  schema_version: 2;
  commit: string;
  built_at: string;
  evaluation_as_of: string;
  tool_version: string;
  input_fingerprint: string;
  projection_digest: string;
  code_index_sha?: string;
  node_count: number;
  edge_count: number;
}

/** One unit of a curated backfill file (architecture/knowledge/curated/*.jsonl). */
export interface CuratedRecord {
  id: string;
  kind: "requirement" | "decision" | "non_goal" | "risk" | "principle";
  statement: string;
  ticket?: number;
  source: {
    type: "ticket_body" | "ticket_message" | "delivery" | "commit" | "cli_report" | "package_doc" | "adr" | "cli_message";
    ref: string;
    message_id?: number;
    path?: string;
    sha?: string;
  };
  capabilities: string[];
  modules?: string[];
  paths?: string[];
  status: NodeStatus;
  supersedes?: string[];
  superseded_by?: string;
  certainty: Certainty;
  rationale: string;
  quote?: string;
  conflict_note?: string;
  provenance?: import("./provenance.js").KnowledgeProvenance;
  /** Authored semantic bridges, never inferred from a shared landing. */
  realized_by?: string[];
  verified_by?: string[];
}

/** Input for landings — the repository (bot.db) or a CLI adapter supplies these. */
export interface LandingInput {
  id: number;
  ticket_id: number;
  from_sha: string;
  to_sha: string;
  landed_at: string | null;
  source: string;
  report_path: string | null;
  summary: string;
  changed_files: string[];
  changed_modules: string[];
  knowledge: {
    specifications?: import("./specifications.js").KnowledgeSpecification[];
    changes?: import("./changes.js").KnowledgeChange[];
    producer?: { model: string; session_ref: string | null };
    summary: string;
    requirements: string[];
    decisions: string[];
    non_goals: string[];
    risks: string[];
    verification: string[];
    context_keys: string[];
    supersedes: string[];
  };
}

export interface TicketInput {
  id: number;
  title: string;
  requester: string;
  kind: string;
  dev_status: string;
  created_at: string;
  landed_at: string | null;
  commit_sha: string | null;
  parent_ticket_id: number | null;
  model?: string;
  /** How the opening request was written (bot.db v86); absent/NULL = unknown. */
  actor_kind?: string | null;
}

export const GRAPH_SCHEMA_VERSION = 2 as const;
export const GRAPH_TOOL_VERSION = "2";
