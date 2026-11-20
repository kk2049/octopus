import { createHmac, randomUUID } from "node:crypto";

export const RETRIEVAL_TRACE_SCHEMA_VERSION = 1 as const;
export const RETRIEVAL_TRACE_EVENT_BYTES = 24 * 1024;
export const RETRIEVAL_RECEIPT_BYTES = 32 * 1024;

export type RetrievalTraceId = `kr_${string}`;
export type RetrievalLane = "ticket" | "cli";
export type RetrievalPurpose = "startup" | "path_refinement" | "submit_check";
export type RetrievalSlot =
  | "contract_principle"
  | "scenarios"
  | "sources_requirements"
  | "decisions_exceptions"
  | "actions_symbols"
  | "tests_evidence"
  | "landings_patterns"
  | "unknown_conflicts";
export type IndexFreshness = "exact" | "stale" | "unavailable";
export type RetrievalMissCode =
  | "no_grounded_answer"
  | "missing_slot"
  | "code_index_stale"
  | "vector_unavailable"
  | "conflict_supersession_only"
  | "graph_unavailable"
  | "index_failed"
  | "privacy_denied"
  | "telemetry_receipt_missing"
  | "telemetry_receipt_invalid";
export type RetrievalFeedbackCode = RetrievalMissCode | "not_run" | "helpful" | "not_helpful" | "wrong_lifecycle" | "wrong_scope";
export type RetrievalErrorCode =
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

export interface RetrievalTraceEnvelopeV1 {
  schema_version: 1;
  trace_id: RetrievalTraceId;
  lane: RetrievalLane;
  purpose: RetrievalPurpose;
  subject_ref: `ticket:${number}` | `cli-scope:${string}`;
  turn?: number;
  parent_trace_id?: RetrievalTraceId;
  journey_step_id?: string;
  query_hash: string;
  query_chars: number;
  repo_sha: string;
  worktree_input_fingerprint?: string;
  graph_input_fingerprint: string;
  code_index_sha?: string;
  vector_index_sha?: string;
  started_at: string;
}

export interface ClassificationAudit {
  dimension: "capability" | "scenario" | "provider" | "launch_mode" | "state" | "action" | "path" | "symbol";
  value: string;
  certainty: "exact" | "inferred" | "ambiguous";
  score: number;
  reason_codes: Array<"explicit_path" | "explicit_typed" | "alias" | "lexical" | "vector">;
}

export interface IndexIdentity {
  id: string;
  kind: "graph_exact" | "fts5_trigram" | "vector" | "scip" | "typescript_ls";
  artifact_sha256: string;
  source_git_sha: string;
  graph_sha256?: string;
  manifest_schema: number;
  record_schema_version: number;
  record_count: number;
  freshness: IndexFreshness;
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

export interface IndexAttemptAudit {
  index: IndexIdentity;
  status: "ok" | "degraded" | "rejected";
  latency_ms: number;
  privacy_decision?: "allow" | "redact" | "local_only" | "deny";
  error_code?: RetrievalErrorCode;
  hits: Array<{ record_id: string; rank: number; raw_score: number }>;
}

export interface CandidateAudit {
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

export interface SlotAudit {
  slot: RetrievalSlot;
  ordinal: number;
  record_id: string;
  candidate_rank: number;
  final_score: number;
  chars: number;
  reason_codes: string[];
}

export interface RetrievalPlanAudit {
  classifications: ClassificationAudit[];
  indexes: IndexAttemptAudit[];
  candidates: CandidateAudit[];
  slots: SlotAudit[];
  context_keys: string[];
  unknown: Array<{ code: RetrievalMissCode; slot?: RetrievalSlot }>;
  budget: { limit_chars: number; used_chars: number; dropped_records: number };
  performance: { total_ms: number; rss_delta_bytes?: number };
}

export type RetrievalTraceOutcome =
  | { event: "assembled"; plan: RetrievalPlanAudit }
  | { event: "miss"; plan: RetrievalPlanAudit }
  | { event: "error"; stage: RetrievalErrorStage; code: RetrievalErrorCode };

export interface RetrievalTrace {
  envelope: RetrievalTraceEnvelopeV1;
  outcome: RetrievalTraceOutcome;
}

export type RetrievalErrorStage = "classify" | "exact" | "lexical" | "vector" | "expand" | "rerank" | "assemble" | "delivery" | "receipt_import";
export const RETRIEVAL_DELIVERY_CHANNELS = ["ticket_prompt", "mcp_response", "cli_stdout", "land_import"] as const;
export type RetrievalDeliveryChannel = (typeof RETRIEVAL_DELIVERY_CHANNELS)[number];
export const RETRIEVAL_CANONICAL_DELIVERY_EVENT_KEYS = [
  "delivery:ticket_prompt",
  "delivery:mcp_response",
  "delivery:cli_stdout",
  "delivery:land_import",
] as const;

export type RetrievalTraceEventName =
  | "started"
  | "assembled"
  | "miss"
  | "error"
  | "delivered"
  | "delivered_error"
  | "abandoned"
  | "reported_use"
  | "feedback";

export type RetrievalTraceEventPayload =
  | { event: "started"; payload: Record<string, never> }
  | { event: "assembled" | "miss"; payload: RetrievalPlanAudit }
  | { event: "error" | "abandoned"; payload: { stage: RetrievalErrorStage; code: RetrievalErrorCode } }
  | { event: "delivered_error"; payload: { stage: RetrievalErrorStage; code: RetrievalErrorCode | RetrievalMissCode } }
  | { event: "delivered"; payload: { channel: RetrievalDeliveryChannel } }
  | {
      event: "reported_use";
      payload: {
        landing_ref: string;
        context_keys: Array<{
          record_id: string;
          origin: "offered" | "manual";
          offered_by_trace?: RetrievalTraceId;
          slot?: RetrievalSlot;
        }>;
        receipt_bindings?: Array<{
          trace_id: RetrievalTraceId;
          receipt_sha256: string;
        }>;
        repo_sha?: string;
      };
    }
  | {
      event: "feedback";
      payload: { code: RetrievalFeedbackCode; slot?: RetrievalSlot; expected_record_id?: string };
    };

export interface RetrievalTraceEventInput {
  trace_id: RetrievalTraceId;
  event_key: string;
  created_at: string;
  event: RetrievalTraceEventName;
  payload: RetrievalTraceEventPayload["payload"];
}

export interface RetrievalTraceReceiptV1 {
  schema_version: 1;
  envelope: RetrievalTraceEnvelopeV1;
  events: RetrievalTraceEventInput[];
}

export interface RetrievalTraceSink {
  beginTrace(envelope: RetrievalTraceEnvelopeV1): void | Promise<void>;
  appendEvent(event: RetrievalTraceEventInput): void | Promise<void>;
}

export interface CreateRetrievalTraceInput {
  lane: RetrievalLane;
  purpose: RetrievalPurpose;
  subject_ref: RetrievalTraceEnvelopeV1["subject_ref"];
  turn?: number;
  parent_trace_id?: RetrievalTraceId;
  journey_step_id?: string;
  query: string;
  repo_sha: string;
  worktree_input_fingerprint?: string;
  graph_input_fingerprint: string;
  code_index_sha?: string;
  vector_index_sha?: string;
  started_at?: string;
}

const LIMITS = {
  classificationsPerDimension: 4,
  indexAttempts: 8,
  hitsPerIndex: 20,
  candidates: 32,
  edgeHops: 4,
  // One row per delivered line; the eight slot budgets total 27, bounded by the 32 ranked candidates.
  slots: 32,
  contextKeys: 50,
  paths: 40,
} as const;

const FORBIDDEN_KEYS: Record<string, true> = {
  text: true,
  body: true,
  spec: true,
  question: true,
  prompt: true,
  transcript: true,
  message: true,
  statement: true,
  quote: true,
  stack: true,
  error: true,
  exception: true,
  token: true,
  credential: true,
  branch: true,
  username: true,
  session_id: true,
};
const ID = /^[A-Za-z0-9][A-Za-z0-9:._/@#-]{0,511}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const GIT_SHA = /^[0-9a-f]{40}$/u;
const TRACE_ID = /^kr_[0-9a-f]{32}$/u;
const SAFE_CODE = /^[a-z][a-z0-9_]{0,63}$/u;
const CLASSIFICATION_VALUE = /^[A-Za-z0-9_$][A-Za-z0-9_$:.[\]()/@#<>,*+-]{0,255}$/u;
const CLASSIFICATION_PATH = /^[A-Za-z0-9_$.][A-Za-z0-9_$:.[\]()/@#<>,*+-]{0,255}$/u;
const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/]|~[\\/])/u;
const SENSITIVE_VALUE = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:bearer|password|passwd|api[_-]?key|secret|credential)\s*[:=])/iu;
const SECRET_SHAPED_VALUE = /(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.)/u;
const PRIVATE_COORDINATE = /(?:^|[/#:])(?:transcript|credentials?|secrets?)(?:[/#:]|$)|(?:^|\/)\.(?:env|ssh|aws)(?:[./]|$)/iu;
const REPO_PATH_COORDINATE = /^(?:(?:[A-Za-z0-9._@+-]+\/)+[A-Za-z0-9._@+-]+|(?:[A-Za-z0-9_@+-]+(?:\.[A-Za-z0-9._@+-]+)+|\.[A-Za-z0-9._@+-]+|Dockerfile|Makefile|LICENSE|NOTICE|bot-ctl))(?:(?:#[^\s#?:][^\s#?]{0,159})|(?::\d+(?::\d+)?))?$/u;
const TICKET_COORDINATE = /^ticket:#?\d+(?:(?:(?::|\/)landing:\d+)|(?:\/message:\d+))?(?:#(?:message:\d+|[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}))?$/u;
const PATH_TRAVERSAL = /(?:^|\/)\.{1,2}(?:\/|$)/u;
const LANDING_COORDINATE = /^landing:\d+(?:#[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?$/u;
const ATLAS_COORDINATE = /^atlas:(?:module|capability|constraint|zone|flow|path|file|symbol):[A-Za-z0-9][A-Za-z0-9._/@#:-]{0,383}$/u;
const KNOWLEDGE_COORDINATE = /^knowledge:[A-Za-z0-9][A-Za-z0-9._/@#-]{0,127}:[A-Za-z0-9][A-Za-z0-9._/@#:-]{0,255}$/u;
const CONFIRMED_SOURCE_COORDINATE = /^knowledge-source:ks_[0-9a-f]{32}#confirmation:[0-9a-f]{32}$/u;
const RUNTIME_TICKET_COORDINATE = /^(?:runtime-ticket:#?\d+|runtime tickets #\d+(?:, #\d+)*)$/u;
const LANES: readonly RetrievalLane[] = ["ticket", "cli"];
const PURPOSES: readonly RetrievalPurpose[] = ["startup", "path_refinement", "submit_check"];
const SLOTS: readonly RetrievalSlot[] = [
  "contract_principle", "scenarios", "sources_requirements", "decisions_exceptions",
  "actions_symbols", "tests_evidence", "landings_patterns", "unknown_conflicts",
];
const MISS_CODES: readonly RetrievalMissCode[] = [
  "no_grounded_answer", "missing_slot", "code_index_stale", "vector_unavailable",
  "conflict_supersession_only", "graph_unavailable", "index_failed", "privacy_denied",
  "telemetry_receipt_missing", "telemetry_receipt_invalid",
];
const FEEDBACK_CODES: readonly RetrievalFeedbackCode[] = [
  ...MISS_CODES, "not_run", "helpful", "not_helpful", "wrong_lifecycle", "wrong_scope",
];
const ERROR_CODES: readonly RetrievalErrorCode[] = [
  "graph_unavailable", "index_failed", "manifest_invalid", "checksum_mismatch",
  "model_binding_mismatch", "dimension_mismatch", "stale_source_sha", "privacy_denied",
  "index_missing", "embed_timeout", "provider_unavailable", "pack_failed",
  "telemetry_receipt_missing", "telemetry_receipt_invalid",
];
const ERROR_STAGES: readonly RetrievalErrorStage[] = [
  "classify", "exact", "lexical", "vector", "expand", "rerank", "assemble",
  "delivery", "receipt_import",
];
const EVENT_NAMES: readonly RetrievalTraceEventName[] = [
  "started", "assembled", "miss", "error", "delivered", "delivered_error",
  "abandoned", "reported_use", "feedback",
];

function assertKeys(value: unknown, label: string, allowed: readonly string[]): asserts value is Record<string, unknown> {
  assert(Boolean(value) && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  const extras = Object.keys(value as Record<string, unknown>).filter((key) => !allowed.includes(key));
  assert(extras.length === 0, `${label} contains unknown fields: ${extras.join(", ")}`);
}

function assertArray(value: unknown, label: string): asserts value is unknown[] {
  assert(Array.isArray(value), `${label} must be an array`);
}

function assertMember<T extends string>(value: unknown, allowed: readonly T[], label: string): asserts value is T {
  assert(typeof value === "string" && allowed.includes(value as T), `invalid ${label}`);
}


function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`invalid retrieval trace: ${message}`);
}

function finite(value: number, label: string, min = 0): void {
  assert(Number.isFinite(value) && value >= min, `${label} must be a finite number >= ${min}`);
}

function safeString(value: string, label: string, max = 512, pattern: RegExp | null = ID): void {
  assert(typeof value === "string" && value.length > 0 && value.length <= max, `${label} has invalid length`);
  assert(!/[\u0000-\u001f\u007f]/u.test(value), `${label} contains control characters`);
  assert(!ABSOLUTE_PATH.test(value), `${label} must not be an absolute path`);
  assert(!SENSITIVE_VALUE.test(value), `${label} contains sensitive content`);
  if (pattern) assert(pattern.test(value), `${label} contains disallowed characters`);
}

function sourceCoordinate(value: string, label: string): void {
  safeString(value, label, 512, null);
  assert(!PRIVATE_COORDINATE.test(value), `${label} is a private coordinate`);
  assert(!SECRET_SHAPED_VALUE.test(value), `${label} contains secret-shaped content`);
  assert(
    (REPO_PATH_COORDINATE.test(value) && !PATH_TRAVERSAL.test(value))
      || TICKET_COORDINATE.test(value)
      || LANDING_COORDINATE.test(value)
      || GIT_SHA.test(value)
      || ATLAS_COORDINATE.test(value)
      || KNOWLEDGE_COORDINATE.test(value)
      || CONFIRMED_SOURCE_COORDINATE.test(value)
      || RUNTIME_TICKET_COORDINATE.test(value),
    `${label} must be a canonical source coordinate`,
  );
}

function sha(value: string | undefined, label: string, optional = false): void {
  if (optional && value === undefined) return;
  assert(typeof value === "string" && SHA256.test(value), `${label} must be lowercase sha256`);
}

function gitSha(value: string | undefined, label: string, optional = false): void {
  if (optional && value === undefined) return;
  assert(typeof value === "string" && GIT_SHA.test(value), `${label} must be a 40-character lowercase Git SHA`);
}

function timestamp(value: string, label: string): void {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  assert(Number.isFinite(parsed) && new Date(parsed).toISOString() === value, `${label} must be canonical ISO-8601`);
}

function assertNoForbiddenKeys(value: unknown, path = "payload"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenKeys(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    assert(!FORBIDDEN_KEYS[key.toLowerCase()], `${path}.${key} is forbidden`);
    assertNoForbiddenKeys(nested, `${path}.${key}`);
  }
}

export function normalizeRetrievalQuery(query: string): string {
  return query.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

export function hashRetrievalQuery(query: string, hmacKey: string | Uint8Array): string {
  const keyBytes = typeof hmacKey === "string" ? Buffer.from(hmacKey, "utf8") : Buffer.from(hmacKey);
  assert(keyBytes.byteLength >= 32, "query HMAC key must contain at least 32 bytes");
  return createHmac("sha256", keyBytes).update(normalizeRetrievalQuery(query), "utf8").digest("hex");
}

export function createRetrievalTraceId(): RetrievalTraceId {
  return `kr_${randomUUID().replaceAll("-", "")}`;
}

export function createRetrievalTraceEnvelope(input: CreateRetrievalTraceInput, hmacKey: string | Uint8Array): RetrievalTraceEnvelopeV1 {
  const normalized = normalizeRetrievalQuery(input.query);
  const envelope: RetrievalTraceEnvelopeV1 = {
    schema_version: RETRIEVAL_TRACE_SCHEMA_VERSION,
    trace_id: createRetrievalTraceId(),
    lane: input.lane,
    purpose: input.purpose,
    subject_ref: input.subject_ref,
    ...(input.turn === undefined ? {} : { turn: input.turn }),
    ...(input.parent_trace_id ? { parent_trace_id: input.parent_trace_id } : {}),
    ...(input.journey_step_id ? { journey_step_id: input.journey_step_id } : {}),
    query_hash: hashRetrievalQuery(normalized, hmacKey),
    query_chars: [...normalized].length,
    repo_sha: input.repo_sha,
    ...(input.worktree_input_fingerprint ? { worktree_input_fingerprint: input.worktree_input_fingerprint } : {}),
    graph_input_fingerprint: input.graph_input_fingerprint,
    ...(input.code_index_sha ? { code_index_sha: input.code_index_sha } : {}),
    ...(input.vector_index_sha ? { vector_index_sha: input.vector_index_sha } : {}),
    started_at: input.started_at ?? new Date().toISOString(),
  };
  return validateRetrievalTraceEnvelope(envelope);
}

export function validateRetrievalTraceEnvelope(envelope: RetrievalTraceEnvelopeV1): RetrievalTraceEnvelopeV1 {
  assertKeys(envelope, "envelope", [
    "schema_version", "trace_id", "lane", "purpose", "subject_ref", "turn",
    "parent_trace_id", "journey_step_id", "query_hash", "query_chars", "repo_sha",
    "worktree_input_fingerprint", "graph_input_fingerprint", "code_index_sha",
    "vector_index_sha", "started_at",
  ]);
  assertNoForbiddenKeys(envelope);
  assert(envelope.schema_version === RETRIEVAL_TRACE_SCHEMA_VERSION, "unsupported envelope schema");
  assert(TRACE_ID.test(envelope.trace_id), "invalid trace_id");
  assertMember(envelope.lane, LANES, "lane");
  assertMember(envelope.purpose, PURPOSES, "purpose");
  assert(/^(?:ticket:[1-9]\d*|cli-scope:[a-z0-9][a-z0-9._-]{0,63})$/u.test(envelope.subject_ref), "invalid subject_ref");
  if (envelope.lane === "ticket") assert(envelope.subject_ref.startsWith("ticket:"), "ticket lane needs ticket subject");
  if (envelope.lane === "cli") assert(envelope.subject_ref.startsWith("cli-scope:"), "CLI lane needs CLI subject");
  if (envelope.turn !== undefined) assert(Number.isSafeInteger(envelope.turn) && envelope.turn >= 0, "invalid turn");
  if (envelope.parent_trace_id !== undefined) assert(TRACE_ID.test(envelope.parent_trace_id), "invalid parent_trace_id");
  if (envelope.journey_step_id !== undefined) safeString(envelope.journey_step_id, "journey_step_id", 64, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u);
  sha(envelope.query_hash, "query_hash");
  assert(Number.isSafeInteger(envelope.query_chars) && envelope.query_chars >= 0 && envelope.query_chars <= 1_000_000, "invalid query_chars");
  gitSha(envelope.repo_sha, "repo_sha");
  sha(envelope.worktree_input_fingerprint, "worktree_input_fingerprint", true);
  sha(envelope.graph_input_fingerprint, "graph_input_fingerprint");
  gitSha(envelope.code_index_sha, "code_index_sha", true);
  gitSha(envelope.vector_index_sha, "vector_index_sha", true);
  timestamp(envelope.started_at, "started_at");
  return envelope;
}

function validateIndexIdentity(index: IndexIdentity): void {
  assertKeys(index, "index", [
    "id", "kind", "artifact_sha256", "source_git_sha", "graph_sha256",
    "manifest_schema", "record_schema_version", "record_count", "freshness", "embedding",
  ]);
  safeString(index.id, "index.id", 128);
  assertMember(index.kind, ["graph_exact", "fts5_trigram", "vector", "scip", "typescript_ls"], "index kind");
  sha(index.artifact_sha256, "index.artifact_sha256");
  gitSha(index.source_git_sha, "index.source_git_sha");
  sha(index.graph_sha256, "index.graph_sha256", true);
  assert(Number.isSafeInteger(index.manifest_schema) && index.manifest_schema >= 1, "invalid index manifest schema");
  assert(Number.isSafeInteger(index.record_schema_version) && index.record_schema_version >= 1, "invalid record schema");
  assert(Number.isSafeInteger(index.record_count) && index.record_count >= 0, "invalid index record count");
  assertMember(index.freshness, ["exact", "stale", "unavailable"], "freshness");
  if (!index.embedding) return;
  assertKeys(index.embedding, "index.embedding", [
    "provider", "model_id", "immutable_revision", "dimensions", "dtype", "normalized", "distance",
  ]);
  safeString(index.embedding.provider, "embedding.provider", 128);
  safeString(index.embedding.model_id, "embedding.model_id", 256);
  safeString(index.embedding.immutable_revision, "embedding.immutable_revision", 128);
  assert(Number.isSafeInteger(index.embedding.dimensions) && index.embedding.dimensions > 0 && index.embedding.dimensions <= 65_536, "invalid embedding dimensions");
  assert(index.embedding.dtype === "float32" && index.embedding.normalized === true && index.embedding.distance === "cosine", "invalid embedding binding");
}

export function validateRetrievalPlan(plan: RetrievalPlanAudit): RetrievalPlanAudit {
  assertKeys(plan, "plan", [
    "classifications", "indexes", "candidates", "slots", "context_keys",
    "unknown", "budget", "performance",
  ]);
  assertNoForbiddenKeys(plan);
  assertArray(plan.classifications, "plan.classifications");
  assertArray(plan.indexes, "plan.indexes");
  assertArray(plan.candidates, "plan.candidates");
  assertArray(plan.slots, "plan.slots");
  assertArray(plan.context_keys, "plan.context_keys");
  assertArray(plan.unknown, "plan.unknown");
  const dimensionCounts = new Map<string, number>();
  for (const classification of plan.classifications) {
    assertKeys(classification, "classification", ["dimension", "value", "certainty", "score", "reason_codes"]);
    assertMember(classification.dimension, ["capability", "scenario", "provider", "launch_mode", "state", "action", "path", "symbol"], "classification dimension");
    assertMember(classification.certainty, ["exact", "inferred", "ambiguous"], "classification certainty");
    assertArray(classification.reason_codes, "classification.reason_codes");
    classification.reason_codes.forEach((code) => assertMember(code, ["explicit_path", "explicit_typed", "alias", "lexical", "vector"], "classification reason"));
    dimensionCounts.set(classification.dimension, (dimensionCounts.get(classification.dimension) ?? 0) + 1);
    safeString(classification.value, `classification.${classification.dimension}`, 256, classification.dimension === "path" ? CLASSIFICATION_PATH : CLASSIFICATION_VALUE);
    if (classification.dimension === "path") assert(!PATH_TRAVERSAL.test(classification.value), "classification.path must not traverse directories");
    finite(classification.score, "classification score");
    assert(classification.reason_codes.length > 0 && classification.reason_codes.length <= 5, "invalid classification reasons");
  }
  assert([...dimensionCounts].every(([dimension, count]) => count <= (dimension === "path" ? LIMITS.paths : LIMITS.classificationsPerDimension)), "too many classifications per dimension");
  assert((dimensionCounts.get("path") ?? 0) <= LIMITS.paths, "too many path classifications");
  assert(plan.indexes.length <= LIMITS.indexAttempts, "too many index attempts");
  for (const attempt of plan.indexes) {
    assertKeys(attempt, "index attempt", ["index", "status", "latency_ms", "privacy_decision", "error_code", "hits"]);
    validateIndexIdentity(attempt.index);
    assertMember(attempt.status, ["ok", "degraded", "rejected"], "index status");
    if (attempt.privacy_decision !== undefined) assertMember(attempt.privacy_decision, ["allow", "redact", "local_only", "deny"], "privacy decision");
    if (attempt.error_code !== undefined) assertMember(attempt.error_code, ERROR_CODES, "index error code");
    finite(attempt.latency_ms, "index latency");
    assertArray(attempt.hits, "index hits");
    assert(attempt.hits.length <= LIMITS.hitsPerIndex, "too many hits for index");
    for (const hit of attempt.hits) {
      assertKeys(hit, "index hit", ["record_id", "rank", "raw_score"]);
      safeString(hit.record_id, "hit.record_id");
      assert(Number.isSafeInteger(hit.rank) && hit.rank >= 1, "invalid hit rank");
      assert(Number.isFinite(hit.raw_score), "invalid raw score");
    }
    if (attempt.status === "rejected") assert(Boolean(attempt.error_code), "rejected index needs an error code");
  }
  assert(plan.candidates.length <= LIMITS.candidates, "too many candidates");
  const candidateIds = new Set<string>();
  for (const candidate of plan.candidates) {
    assertKeys(candidate, "candidate", [
      "record_id", "kind", "source_ref", "source_sha", "fused_rank", "fused_score",
      "signals", "allowed_edge_path", "rerank", "dropped",
    ]);
    safeString(candidate.record_id, "candidate.record_id");
    assert(!candidateIds.has(candidate.record_id), "duplicate candidate");
    candidateIds.add(candidate.record_id);
    safeString(candidate.kind, "candidate.kind", 64, SAFE_CODE);
    sourceCoordinate(candidate.source_ref, "candidate.source_ref");
    gitSha(candidate.source_sha, "candidate.source_sha");
    assert(Number.isSafeInteger(candidate.fused_rank) && candidate.fused_rank >= 1, "invalid fused rank");
    assert(Number.isFinite(candidate.fused_score), "invalid fused score");
    assertArray(candidate.signals, "candidate.signals");
    assert(candidate.signals.length <= LIMITS.indexAttempts, "too many candidate signals");
    for (const signal of candidate.signals) {
      assertKeys(signal, "candidate signal", ["index_id", "rank", "raw_score", "rrf_contribution"]);
      safeString(signal.index_id, "signal.index_id", 128);
      assert(Number.isSafeInteger(signal.rank) && signal.rank >= 1, "invalid signal rank");
      assert(Number.isFinite(signal.raw_score), "invalid signal raw score");
      assert(Number.isFinite(signal.rrf_contribution), "invalid signal contribution");
    }
    if (candidate.allowed_edge_path !== undefined) assertArray(candidate.allowed_edge_path, "candidate.allowed_edge_path");
    assert((candidate.allowed_edge_path?.length ?? 0) <= LIMITS.edgeHops, "too many allowed edge hops");
    for (const hop of candidate.allowed_edge_path ?? []) {
      assertKeys(hop, "candidate edge", ["from", "relation", "to"]);
      safeString(hop.from, "edge.from");
      safeString(hop.relation, "edge.relation", 64, SAFE_CODE);
      safeString(hop.to, "edge.to");
    }
    assertArray(candidate.rerank, "candidate.rerank");
    assert(candidate.rerank.length <= 16, "too many rerank features");
    for (const feature of candidate.rerank) {
      assertKeys(feature, "rerank feature", ["feature", "contribution"]);
      safeString(feature.feature, "rerank.feature", 64, SAFE_CODE);
      assert(Number.isFinite(feature.contribution), "invalid rerank contribution");
    }
    if (candidate.dropped !== undefined) assertMember(candidate.dropped, ["superseded", "stale_index", "disallowed_relation", "duplicate", "slot_full", "budget"], "candidate drop reason");
  }
  assert(plan.slots.length <= LIMITS.slots, "too many slot rows");
  for (const slot of plan.slots) {
    assertKeys(slot, "slot", ["slot", "ordinal", "record_id", "candidate_rank", "final_score", "chars", "reason_codes"]);
    assertMember(slot.slot, SLOTS, "slot name");
    safeString(slot.record_id, "slot.record_id");
    assert(Number.isSafeInteger(slot.ordinal) && slot.ordinal >= 1, "invalid slot ordinal");
    assert(Number.isSafeInteger(slot.candidate_rank) && slot.candidate_rank >= 1, "invalid candidate rank");
    assert(Number.isFinite(slot.final_score), "invalid slot score");
    assert(Number.isSafeInteger(slot.chars) && slot.chars >= 0, "invalid slot chars");
    assertArray(slot.reason_codes, "slot.reason_codes");
    assert(slot.reason_codes.length <= 8, "too many slot reason codes");
    slot.reason_codes.forEach((code) => safeString(code, "slot.reason_code", 64, SAFE_CODE));
  }
  assert(plan.context_keys.length <= LIMITS.contextKeys, "too many context keys");
  assert(new Set(plan.context_keys).size === plan.context_keys.length, "duplicate context key");
  plan.context_keys.forEach((key) => safeString(key, "context_key"));
  assert(plan.unknown.length <= LIMITS.slots, "too many unknown rows");
  for (const unknown of plan.unknown) {
    assertKeys(unknown, "unknown", ["code", "slot"]);
    assertMember(unknown.code, MISS_CODES, "unknown code");
    if (unknown.slot !== undefined) assertMember(unknown.slot, SLOTS, "unknown slot");
  }
  assertKeys(plan.budget, "budget", ["limit_chars", "used_chars", "dropped_records"]);
  finite(plan.budget.limit_chars, "budget.limit_chars");
  finite(plan.budget.used_chars, "budget.used_chars");
  assert(plan.budget.used_chars <= plan.budget.limit_chars, "used budget exceeds limit");
  assert(Number.isSafeInteger(plan.budget.dropped_records) && plan.budget.dropped_records >= 0, "invalid dropped_records");
  assertKeys(plan.performance, "performance", ["total_ms", "rss_delta_bytes"]);
  finite(plan.performance.total_ms, "performance.total_ms");
  if (plan.performance.rss_delta_bytes !== undefined) assert(Number.isSafeInteger(plan.performance.rss_delta_bytes), "invalid rss delta");
  assert(Buffer.byteLength(JSON.stringify(plan), "utf8") <= RETRIEVAL_TRACE_EVENT_BYTES, "assembled plan exceeds 24 KiB");
  return plan;
}

export function validateRetrievalTraceEvent(input: RetrievalTraceEventInput): RetrievalTraceEventInput {
  assertKeys(input, "event", ["trace_id", "event_key", "created_at", "event", "payload"]);
  assertKeys(input.payload, "event.payload", input.event === "started" ? [] : input.event === "assembled" || input.event === "miss"
    ? ["classifications", "indexes", "candidates", "slots", "context_keys", "unknown", "budget", "performance"]
    : input.event === "delivered"
      ? ["channel"]
      : input.event === "reported_use"
        ? ["landing_ref", "context_keys", "receipt_bindings", "repo_sha"]
        : input.event === "feedback"
          ? ["code", "slot", "expected_record_id"]
          : ["stage", "code"]);
  assertNoForbiddenKeys(input.payload);
  assert(TRACE_ID.test(input.trace_id), "invalid event trace_id");
  assertMember(input.event, EVENT_NAMES, "event name");
  safeString(input.event_key, "event_key", 160, /^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,159}$/u);
  if (input.event === "started") {
    assert(input.event_key === "started", "started must use its canonical event key");
  } else if (input.event === "assembled" || input.event === "miss" || input.event === "error") {
    assert(input.event_key === "result", `${input.event} must use its canonical event key`);
  } else if (input.event === "delivered_error") {
    assertMember(input.event_key, RETRIEVAL_CANONICAL_DELIVERY_EVENT_KEYS, "delivered_error event key");
  } else if (input.event === "abandoned") {
    assert(input.event_key === "abandoned", "abandoned must use its canonical event key");
  }
  timestamp(input.created_at, "event.created_at");
  if (input.event === "assembled" || input.event === "miss") {
    const plan = validateRetrievalPlan(input.payload as unknown as RetrievalPlanAudit);
    if (input.event === "miss") assert(plan.unknown.length > 0, "miss needs at least one unknown reason");
  } else if (input.event === "delivered") {
    const payload = input.payload as Extract<RetrievalTraceEventPayload, { event: "delivered" }>["payload"];
    assertMember(payload.channel, RETRIEVAL_DELIVERY_CHANNELS, "delivery channel");
    assert(input.event_key === `delivery:${payload.channel}`, "delivered must use its channel's canonical event key");
  } else if (input.event === "reported_use") {
    const payload = input.payload as Extract<RetrievalTraceEventPayload, { event: "reported_use" }>["payload"];
    safeString(payload.landing_ref, "landing_ref", 256);
    assertArray(payload.context_keys, "reported context keys");
    assert(payload.context_keys.length <= LIMITS.contextKeys, "too many reported context keys");
    const recordIds = new Set<string>();
    for (const item of payload.context_keys) {
      assertKeys(item, "reported context key", ["record_id", "origin", "offered_by_trace", "slot"]);
      safeString(item.record_id, "reported record_id");
      assert(!recordIds.has(item.record_id), "duplicate reported context key");
      recordIds.add(item.record_id);
      assertMember(item.origin, ["offered", "manual"], "reported-use origin");
      if (item.offered_by_trace) assert(TRACE_ID.test(item.offered_by_trace), "invalid offered trace");
      if (item.slot !== undefined) assertMember(item.slot, SLOTS, "reported-use slot");
      if (item.origin === "offered") assert(Boolean(item.offered_by_trace && item.slot), "offered use needs trace and slot");
      if (item.origin === "manual") assert(!item.offered_by_trace && !item.slot, "manual use must not claim an offered slot");
    }
    const bindingValues = [payload.receipt_bindings, payload.repo_sha];
    const hasBinding = bindingValues.some((value) => value !== undefined);
    if (hasBinding) {
      assert(typeof payload.repo_sha === "string", "reported-use repo sha is required");
      assert(bindingValues.every((value) => value !== undefined), "reported-use receipt binding must be complete");
      assertArray(payload.receipt_bindings, "receipt bindings");
      assert(payload.receipt_bindings.length > 0 && payload.receipt_bindings.length <= 8, "receipt bindings must be non-empty and bounded");
      const boundTraceIds = new Set<string>();
      for (const binding of payload.receipt_bindings) {
        assertKeys(binding, "receipt binding", ["trace_id", "receipt_sha256"]);
        assert(TRACE_ID.test(binding.trace_id), "invalid bound receipt trace");
        assert(!boundTraceIds.has(binding.trace_id), "duplicate bound receipt trace");
        boundTraceIds.add(binding.trace_id);
        safeString(binding.receipt_sha256, "receipt_sha256", 64, /^[0-9a-f]{64}$/u);
      }
      assert(boundTraceIds.has(input.trace_id), "reported-use host must be among its receipt bindings");
      safeString(payload.repo_sha, "reported-use repo_sha", 40, /^[0-9a-f]{40}$/u);
    }
  } else if (input.event === "feedback") {
    const payload = input.payload as Extract<RetrievalTraceEventPayload, { event: "feedback" }>["payload"];
    assertMember(payload.code, FEEDBACK_CODES, "feedback code");
    if (payload.slot !== undefined) assertMember(payload.slot, SLOTS, "feedback slot");
    if (payload.expected_record_id) safeString(payload.expected_record_id, "feedback.expected_record_id");
  } else if (input.event === "error" || input.event === "delivered_error" || input.event === "abandoned") {
    const payload = input.payload as { stage?: RetrievalErrorStage; code?: RetrievalErrorCode | RetrievalMissCode };
    assertMember(payload.stage, ERROR_STAGES, "error stage");
    if (input.event === "delivered_error") {
      assert(typeof payload.code === "string" && (ERROR_CODES.includes(payload.code as RetrievalErrorCode) || MISS_CODES.includes(payload.code as RetrievalMissCode)), "invalid delivered error code");
    } else {
      assertMember(payload.code, ERROR_CODES, "error code");
    }
  } else {
    assert(input.event === "started" && Object.keys(input.payload).length === 0, "invalid started payload");
  }
  assert(Buffer.byteLength(JSON.stringify(input.payload), "utf8") <= RETRIEVAL_TRACE_EVENT_BYTES, "event payload exceeds 24 KiB");
  return input;
}

export function traceEvent(
  traceId: RetrievalTraceId,
  eventKey: string,
  value: RetrievalTraceEventPayload,
  createdAt = new Date().toISOString(),
): RetrievalTraceEventInput {
  return validateRetrievalTraceEvent({ trace_id: traceId, event_key: eventKey, created_at: createdAt, event: value.event, payload: value.payload });
}

export function traceOutcomeEvent(trace: RetrievalTrace): RetrievalTraceEventInput {
  if (trace.outcome.event === "error") {
    return traceEvent(trace.envelope.trace_id, "result", { event: "error", payload: { stage: trace.outcome.stage, code: trace.outcome.code } });
  }
  return traceEvent(trace.envelope.trace_id, "result", { event: trace.outcome.event, payload: trace.outcome.plan });
}

export function validateRetrievalTraceReceipt(receipt: RetrievalTraceReceiptV1): RetrievalTraceReceiptV1 {
  assertKeys(receipt, "receipt", ["schema_version", "envelope", "events"]);
  assertNoForbiddenKeys(receipt);
  assert(receipt.schema_version === RETRIEVAL_TRACE_SCHEMA_VERSION, "unsupported receipt schema");
  validateRetrievalTraceEnvelope(receipt.envelope);
  assertArray(receipt.events, "receipt.events");
  assert(receipt.events.length >= 2 && receipt.events.length <= 16, "receipt event count is out of bounds");
  const eventKeys = new Set<string>();
  let results = 0;
  for (const [index, event] of receipt.events.entries()) {
    validateRetrievalTraceEvent(event);
    assert(event.trace_id === receipt.envelope.trace_id, "receipt event belongs to another trace");
    assert(!eventKeys.has(event.event_key), "receipt event keys must be unique");
    eventKeys.add(event.event_key);
    if (event.event === "started") assert(index === 0, "started must be the first receipt event");
    if (event.event === "assembled" || event.event === "miss" || event.event === "error") results += 1;
  }
  assert(receipt.events[0]?.event === "started", "receipt must begin with started");
  assert(results === 1, "receipt must contain exactly one result");
  assert(Buffer.byteLength(`${JSON.stringify(receipt)}\n`, "utf8") <= RETRIEVAL_RECEIPT_BYTES, "receipt exceeds 32 KiB");
  return receipt;
}

export class RetrievalTraceCollector {
  readonly envelope: RetrievalTraceEnvelopeV1;
  private readonly classifications: ClassificationAudit[] = [];
  private readonly indexes: IndexAttemptAudit[] = [];
  private readonly candidates: CandidateAudit[] = [];
  private readonly slots: SlotAudit[] = [];
  private readonly contextKeys = new Set<string>();
  private readonly unknown: Array<{ code: RetrievalMissCode; slot?: RetrievalSlot }> = [];
  private budget: RetrievalPlanAudit["budget"] = { limit_chars: 0, used_chars: 0, dropped_records: 0 };
  private performance: RetrievalPlanAudit["performance"] = { total_ms: 0 };
  private outcome: RetrievalTraceOutcome | null = null;

  constructor(envelope: RetrievalTraceEnvelopeV1) {
    this.envelope = validateRetrievalTraceEnvelope(envelope);
  }

  addClassification(value: ClassificationAudit): void { this.requireOpen(); this.classifications.push(value); }
  addIndexAttempt(value: IndexAttemptAudit): void { this.requireOpen(); this.indexes.push(value); }
  addCandidate(value: CandidateAudit): void { this.requireOpen(); this.candidates.push(value); }
  addSlot(value: SlotAudit): void { this.requireOpen(); this.slots.push(value); this.contextKeys.add(value.record_id); }
  addContextKey(value: string): void { this.requireOpen(); this.contextKeys.add(value); }
  addUnknown(value: { code: RetrievalMissCode; slot?: RetrievalSlot }): void { this.requireOpen(); this.unknown.push(value); }
  setBudget(value: RetrievalPlanAudit["budget"]): void { this.requireOpen(); this.budget = value; }
  setPerformance(value: RetrievalPlanAudit["performance"]): void { this.requireOpen(); this.performance = value; }

  assemble(): RetrievalTrace {
    this.requireOpen();
    const plan = this.plan();
    this.outcome = { event: "assembled", plan };
    return this.snapshot();
  }

  miss(): RetrievalTrace {
    this.requireOpen();
    const plan = this.plan();
    assert(plan.unknown.length > 0, "miss needs at least one unknown reason");
    this.outcome = { event: "miss", plan };
    return this.snapshot();
  }

  fail(stage: RetrievalErrorStage, code: RetrievalErrorCode): RetrievalTrace {
    this.requireOpen();
    this.outcome = { event: "error", stage, code };
    return this.snapshot();
  }

  snapshot(): RetrievalTrace {
    assert(this.outcome, "collector has no terminal retrieval outcome");
    return { envelope: this.envelope, outcome: this.outcome };
  }

  private plan(): RetrievalPlanAudit {
    const indexes = this.indexes.map((attempt) => ({ ...attempt, hits: [...attempt.hits] }));
    const candidates = [...this.candidates];
    const selected = new Set(this.slots.map((slot) => slot.record_id));
    const snapshot = (): RetrievalPlanAudit => ({
      classifications: [...this.classifications],
      indexes,
      candidates,
      slots: [...this.slots],
      context_keys: [...this.contextKeys],
      unknown: [...this.unknown],
      budget: { ...this.budget },
      performance: { ...this.performance },
    });
    const oversized = (): boolean =>
      Buffer.byteLength(JSON.stringify(snapshot()), "utf8") > RETRIEVAL_TRACE_EVENT_BYTES;

    for (let index = candidates.length - 1; oversized() && index >= 0; index -= 1) {
      if (!selected.has(candidates[index].record_id)) candidates.splice(index, 1);
    }
    while (oversized()) {
      const attempt = indexes.reduce<IndexAttemptAudit | null>(
        (largest, current) => current.hits.length > (largest?.hits.length ?? 0) ? current : largest,
        null,
      );
      if (!attempt?.hits.length) break;
      attempt.hits.pop();
    }
    while (oversized() && candidates.length) candidates.pop();
    return validateRetrievalPlan(snapshot());
  }

  private requireOpen(): void {
    assert(!this.outcome, "collector is already complete");
  }
}
