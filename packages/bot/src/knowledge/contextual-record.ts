import type { GraphDb } from "./graph-db.js";
import { createHash } from "node:crypto";
import { AUTHORITIES, CERTAINTIES, NODE_KINDS, NODE_STATUSES } from "./model.js";
import type { ContractCell, KnowledgeEdge, KnowledgeNode, NodeKind, NodeStatus } from "./model.js";
import { canonicalJson, sha256 } from "./model-binding.js";
import type { ContextSlot } from "./retrieval.js";

export const CONTEXTUAL_RECORD_SCHEMA_VERSION = 1 as const;
const CONTEXTUAL_RECORD_SCHEMA = Object.freeze({
  schema_version: CONTEXTUAL_RECORD_SCHEMA_VERSION,
  fields: ["id", "kind", "slot", "status", "authority", "certainty", "repo_sha", "source_ref", "source_sha", "text", "dimensions", "relations"],
  max_text_chars: 1800,
  metadata_policy: "allowlist",
});
export const CONTEXTUAL_RECORD_SCHEMA_DIGEST = sha256(canonicalJson(CONTEXTUAL_RECORD_SCHEMA));

const RETRIEVABLE_KINDS: ReadonlySet<NodeKind> = new Set([
  "principle",
  "capability",
  "requirement",
  "decision",
  "non_goal",
  "risk",
  "module",
  "path",
  "constraint",
  "evidence",
  "landing",
  "pattern",
  "capability_contract",
  "obligation",
  "scenario",
  "exception",
  "source",
  "artifact",
  "desired_conformance",
  "observed_conformance",
]);
const CONTEXT_RELATIONS = new Set([
  "governs",
  "enforced_by",
  "motivates",
  "supersedes",
  "implements",
  "about",
  "constrained_by",
  "evidences",
  "observed_in",
  "guards",
  "contract_for",
  "defines",
  "derives_from",
  "applies_to",
  "requires",
  "waives",
  "supported_by",
  "observes",
  "realized_by",
  "verified_by",
  "reaffirms",
]);
const PRIVATE_METADATA = new Set(["private", "sensitive", "raw", "credential", "transcript"]);
const SAFE_SOURCE = /^(?!\/)(?![A-Za-z]:[\\/])(?!~[\\/])[^\u0000-\u001f\u007f]{1,512}$/u;
const SECRET = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:bearer|password|passwd|api[_-]?key|secret|credential)\s*[:=]\s*\S+)/iu;
const SAFE_DIMENSION = /^[A-Za-z0-9][A-Za-z0-9:._/@#-]{0,255}$/u;
const SHA = /^[0-9a-f]{40}$/u;
const DIMENSION_KEYS = [
  "contract", "contract_id", "capability", "capabilities", "provider", "providers",
  "launch_mode", "launch_modes", "mode", "modes", "state", "states", "action", "actions",
  "artifact_role", "cell_id", "desired", "path", "qualified_name",
] as const;
// Private namespaces are coordinates, not arbitrary repository directory names.
// For example, packages/dashboard-web/src/transcript/SessionChat.tsx is code.
const PRIVATE_SOURCE = /(?:^|:)(transcript|credential)(?:[:/#]|$)/iu;

export interface ContextualRelation {
  relation: string;
  target_id: string;
}

export interface ContextualRecord {
  schema_version: 1;
  id: string;
  kind: NodeKind;
  slot: ContextSlot;
  status: NodeStatus;
  authority: KnowledgeNode["authority"];
  certainty: KnowledgeNode["certainty"];
  repo_sha: string;
  source_ref: string;
  source_sha: string;
  text: string;
  dimensions: Readonly<Record<string, readonly string[]>>;
  relations: readonly ContextualRelation[];
}

export interface ContextualRecordBuild {
  records: ContextualRecord[];
  excluded: Array<{ id: string; reason: "not_retrievable" | "embedding_excluded" | "unsafe_identity" }>;
  digest: string;
}

export interface ContextualRecordInput {
  schema_version: 1;
  repo_sha: string;
  evaluation_as_of: string;
  record_set_digest: string;
  record_count: number;
  records: ContextualRecord[];
}

export type ContextualRecordErrorCode = "privacy_denied" | "record_invalid" | "record_order_invalid";

export function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export class ContextualRecordError extends Error {
  constructor(readonly code: ContextualRecordErrorCode, message: string) {
    super(message);
    this.name = "ContextualRecordError";
  }
}

function artifactRole(node: KnowledgeNode): string {
  const metadata = node.metadata ?? {};
  for (const key of ["artifact_role", "role", "kind"]) {
    const value = metadata[key];
    if (typeof value === "string") return value;
  }
  return "";
}

export function slotForNode(node: KnowledgeNode): ContextSlot {
  switch (node.kind) {
    case "principle":
    case "capability":
    case "capability_contract":
    case "obligation":
    case "desired_conformance":
      return "contract_principle";
    case "scenario":
      return "scenarios";
    case "source":
    case "requirement":
      return "sources_requirements";
    case "decision":
    case "exception":
    case "non_goal":
    case "risk":
      return "decisions_exceptions";
    case "artifact":
      return artifactRole(node) === "test" ? "tests_evidence" : "actions_symbols";
    case "path":
    case "module":
      return "actions_symbols";
    case "constraint":
    case "evidence":
    case "observed_conformance":
      return "tests_evidence";
    case "landing":
    case "pattern":
      return "landings_patterns";
    default:
      return "unknown_conflicts";
  }
}

function assertPublicNode(node: KnowledgeNode): void {
  const privacy = node.metadata?.privacy;
  if (typeof privacy === "string" && PRIVATE_METADATA.has(privacy.toLowerCase())) {
    throw new ContextualRecordError("privacy_denied", `record ${node.id} is marked ${privacy}`);
  }
  if (!SAFE_SOURCE.test(node.source_ref) || PRIVATE_SOURCE.test(node.source_ref)) {
    throw new ContextualRecordError("privacy_denied", `record ${node.id} has a private source coordinate`);
  }
  if (SECRET.test(node.statement)) throw new ContextualRecordError("privacy_denied", `record ${node.id} contains secret-shaped text`);
  if (!SHA.test(node.source_sha)) throw new ContextualRecordError("record_invalid", `record ${node.id} has an invalid source SHA`);
}

function dimensions(node: KnowledgeNode, cells: readonly ContractCell[]): Readonly<Record<string, readonly string[]>> {
  const output: Record<string, string[]> = {};
  const metadata = node.metadata ?? {};
  for (const key of DIMENSION_KEYS) {
    const raw = metadata[key];
    const values = typeof raw === "string" ? [raw] : Array.isArray(raw) && raw.every((value) => typeof value === "string") ? raw : [];
    const normalized = [...new Set(values.map((value) => value.normalize("NFKC").trim()).filter((value) => SAFE_DIMENSION.test(value)))].sort();
    if (normalized.length) output[key] = normalized.slice(0, 16);
  }
  if (node.kind === "artifact") {
    const role = artifactRole(node);
    if (SAFE_DIMENSION.test(role)) output.artifact_role = [role];
  }
  const scoped = cells.filter((cell) => cell.id === node.id || cell.exception_id === node.id);
  if (scoped.length) {
    output.provider = [...new Set(scoped.map((cell) => cell.provider))].sort();
    output.launch_mode = [...new Set(scoped.map((cell) => cell.launch_mode))].sort();
    output.state = [...new Set(scoped.map((cell) => cell.state))].sort();
    output.action = [...new Set(scoped.map((cell) => cell.action))].sort();
    output.desired = [...new Set(scoped.map((cell) => cell.desired))].sort();
  }
  return output;
}

function exactRelations(node: KnowledgeNode, edges: readonly KnowledgeEdge[]): ContextualRelation[] {
  const values: ContextualRelation[] = [];
  for (const edge of edges) {
    if (edge.certainty !== "exact" || !CONTEXT_RELATIONS.has(edge.relation)) continue;
    if (edge.from_id === node.id) values.push({ relation: edge.relation, target_id: edge.to_id });
    else if (edge.to_id === node.id) values.push({ relation: `inverse:${edge.relation}`, target_id: edge.from_id });
  }
  return values
    .filter((value) => SAFE_DIMENSION.test(value.target_id))
    .sort((a, b) => compareCanonicalText(a.relation, b.relation) || compareCanonicalText(a.target_id, b.target_id))
    .filter((value, index, all) => index === 0 || value.relation !== all[index - 1].relation || value.target_id !== all[index - 1].target_id)
    .slice(0, 24);
}

function contextualText(node: KnowledgeNode, relations: readonly ContextualRelation[], nodes: ReadonlyMap<string, KnowledgeNode>): string {
  const heading = typeof node.metadata?.heading === "string" ? node.metadata.heading.normalize("NFKC").replace(/\s+/gu, " ").trim() : "";
  const lines = [
    `${node.kind}: ${heading ? `${heading} — ` : ""}${node.statement.normalize("NFKC").replace(/\s+/gu, " ").trim()}`,
    `source: ${node.source_ref}`,
    `lifecycle: ${node.status}; authority: ${node.authority}; certainty: ${node.certainty}`,
  ];
  const relationLines: string[] = [];
  for (const relation of relations) {
    const target = nodes.get(relation.target_id);
    if (!target || !RETRIEVABLE_KINDS.has(target.kind)) continue;
    assertPublicNode(target);
    // Must stay byte-identical with contextualTextFromRecords, which renders a
    // neighbor from the target record's first line: the artifact protocol
    // compares both sides' record-set digests.
    const targetHeading = typeof target.metadata?.heading === "string" ? target.metadata.heading.normalize("NFKC").replace(/\s+/gu, " ").trim() : "";
    relationLines.push(`${relation.relation} ${target.kind}: ${targetHeading ? `${targetHeading} — ` : ""}${target.statement.normalize("NFKC").replace(/\s+/gu, " ").trim()}`);
    if (relationLines.length === 8) break;
  }
  if (relationLines.length) lines.push(`context: ${relationLines.join(" | ")}`);
  return lines.join("\n").slice(0, 1800);
}

function validateRecord(value: unknown): ContextualRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ContextualRecordError("record_invalid", "contextual record must be an object");
  const record = value as Record<string, unknown>;
  const allowed = ["schema_version", "id", "kind", "slot", "status", "authority", "certainty", "repo_sha", "source_ref", "source_sha", "text", "dimensions", "relations"];
  if (Object.keys(record).some((key) => !allowed.includes(key))
    || record.schema_version !== CONTEXTUAL_RECORD_SCHEMA_VERSION
    || typeof record.id !== "string" || !SAFE_DIMENSION.test(record.id)
    || typeof record.kind !== "string" || !NODE_KINDS.includes(record.kind as NodeKind) || !RETRIEVABLE_KINDS.has(record.kind as NodeKind)
    || typeof record.slot !== "string" || !["contract_principle", "scenarios", "sources_requirements", "decisions_exceptions", "actions_symbols", "tests_evidence", "landings_patterns", "unknown_conflicts"].includes(record.slot)
    || typeof record.status !== "string" || !NODE_STATUSES.includes(record.status as NodeStatus)
    || typeof record.authority !== "string" || !AUTHORITIES.includes(record.authority as KnowledgeNode["authority"])
    || typeof record.certainty !== "string" || !CERTAINTIES.includes(record.certainty as KnowledgeNode["certainty"])
    || typeof record.repo_sha !== "string" || !SHA.test(record.repo_sha)
    || typeof record.source_ref !== "string" || !SAFE_SOURCE.test(record.source_ref) || PRIVATE_SOURCE.test(record.source_ref)
    || typeof record.source_sha !== "string" || !SHA.test(record.source_sha)) {
    throw new ContextualRecordError("record_invalid", `invalid contextual record identity: ${String(record.id ?? "unknown")}`);
  }
  if (typeof record.text !== "string" || record.text.length < 1 || record.text.length > 1800 || SECRET.test(record.text)) {
    throw new ContextualRecordError("privacy_denied", `invalid or sensitive contextual text: ${record.id}`);
  }
  if (!record.dimensions || typeof record.dimensions !== "object" || Array.isArray(record.dimensions)) throw new ContextualRecordError("record_invalid", `invalid dimensions: ${record.id}`);
  const dimensionEntries = Object.entries(record.dimensions);
  if (dimensionEntries.some(([key]) => !DIMENSION_KEYS.includes(key as (typeof DIMENSION_KEYS)[number]))) throw new ContextualRecordError("privacy_denied", `unapproved contextual dimension: ${record.id}`);
  for (const [, values] of dimensionEntries) {
    if (!Array.isArray(values) || values.length > 16 || values.some((item) => typeof item !== "string" || !SAFE_DIMENSION.test(item))) throw new ContextualRecordError("record_invalid", `invalid dimensions: ${record.id}`);
    if (values.some((item, index) => index > 0 && item <= values[index - 1])) throw new ContextualRecordError("record_order_invalid", `contextual dimensions must be unique and sorted: ${record.id}`);
  }
  if (!Array.isArray(record.relations) || record.relations.length > 24 || record.relations.some((relation) =>
    !relation || typeof relation !== "object" || Array.isArray(relation)
    || Object.keys(relation).some((key) => key !== "relation" && key !== "target_id")
    || !("relation" in relation) || typeof relation.relation !== "string"
    || !(CONTEXT_RELATIONS.has(relation.relation) || (relation.relation.startsWith("inverse:") && CONTEXT_RELATIONS.has(relation.relation.slice(8))))
    || !("target_id" in relation) || typeof relation.target_id !== "string" || !SAFE_DIMENSION.test(relation.target_id))) {
    throw new ContextualRecordError("record_invalid", `invalid relations: ${record.id}`);
  }
  const relations = record.relations as Array<{ relation: string; target_id: string }>;
  if (relations.some((relation, index) => index > 0
    && (relation.relation < relations[index - 1].relation
      || (relation.relation === relations[index - 1].relation && relation.target_id <= relations[index - 1].target_id)))) {
    throw new ContextualRecordError("record_order_invalid", `contextual relations must be unique and sorted: ${record.id}`);
  }
  return record as unknown as ContextualRecord;
}

export function buildContextualRecords(graph: GraphDb): ContextualRecordBuild {
  const repoSha = String(graph.meta().commit ?? "");
  if (!SHA.test(repoSha)) throw new ContextualRecordError("record_invalid", "contextual records require an exact repository baseline SHA");
  const allNodes = graph.allNodes();
  const nodes = new Map(allNodes.map((node) => [node.id, node]));
  // Index incident edges once. Scanning every edge for every node made a
  // cold runtime export quadratic and blocked the service event loop.
  const edgesByNode = new Map<string, KnowledgeEdge[]>();
  for (const edge of graph.allEdges()) {
    for (const id of edge.from_id === edge.to_id ? [edge.from_id] : [edge.from_id, edge.to_id]) {
      const incident = edgesByNode.get(id);
      if (incident) incident.push(edge);
      else edgesByNode.set(id, [edge]);
    }
  }
  const cells = graph.contractCells();
  const records: ContextualRecord[] = [];
  const excluded: ContextualRecordBuild["excluded"] = [];
  for (const node of allNodes.sort((a, b) => compareCanonicalText(a.id, b.id))) {
    if (!RETRIEVABLE_KINDS.has(node.kind)) {
      excluded.push({ id: node.id, reason: "not_retrievable" });
      continue;
    }
    if (node.metadata?.embedding === false || node.metadata?.retrieval === "exclude") {
      excluded.push({ id: node.id, reason: "embedding_excluded" });
      continue;
    }
    // A node id the record identity cannot carry (e.g. a non-ASCII file name
    // inside a CLI report's range) stays in the graph but out of the embedding
    // set. `exactRelations` drops edges to it, so both renderers still agree.
    if (!SAFE_DIMENSION.test(node.id)) {
      excluded.push({ id: node.id, reason: "unsafe_identity" });
      continue;
    }
    assertPublicNode(node);
    const relations = exactRelations(node, edgesByNode.get(node.id) ?? []);
    records.push(validateRecord({
      schema_version: CONTEXTUAL_RECORD_SCHEMA_VERSION,
      id: node.id,
      kind: node.kind,
      slot: slotForNode(node),
      status: node.status,
      authority: node.authority,
      repo_sha: repoSha,
      certainty: node.certainty,
      source_ref: node.source_ref,
      source_sha: node.source_sha,
      text: contextualText(node, relations, nodes),
      dimensions: dimensions(node, cells),
      relations,
    }));
  }
  const jsonl = encodeContextualRecordsJsonl(records);
  return { records, excluded, digest: sha256(jsonl) };
}

export function encodeContextualRecordsJsonl(records: readonly ContextualRecord[]): string {
  return records.map((record) => canonicalJson(validateRecord(record))).join("\n") + (records.length ? "\n" : "");
}

export function parseContextualRecordsJsonl(source: string): ContextualRecord[] {
  const records: ContextualRecord[] = [];
  let previous = "";
  for (const [index, line] of source.split("\n").entries()) {
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new ContextualRecordError("record_invalid", `contextual record line ${index + 1} is not JSON`);
    }
    const record = validateRecord(parsed);
    if (canonicalJson(record) !== line) throw new ContextualRecordError("record_invalid", `contextual record line ${index + 1} is not canonical JSON`);
    if (record.id <= previous) throw new ContextualRecordError("record_order_invalid", `contextual records must have unique ascending ids at line ${index + 1}`);
    previous = record.id;
    records.push(record);
  }
  return records;
}

export function encodeContextualRecordInput(
  repoSha: string,
  evaluationAsOf: string,
  recordsInput: readonly ContextualRecord[],
): string {
  if (!SHA.test(repoSha)) throw new ContextualRecordError("record_invalid", "contextual input requires an exact repository SHA");
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(evaluationAsOf) || !Number.isFinite(Date.parse(`${evaluationAsOf}T00:00:00.000Z`))) {
    throw new ContextualRecordError("record_invalid", "contextual input requires an ISO evaluation date");
  }
  const records = [...recordsInput].sort((a, b) => compareCanonicalText(a.id, b.id));
  const digest = createHash("sha256");
  let previous = "";
  for (const value of records) {
    const record = validateRecord(value);
    if (record.id <= previous) throw new ContextualRecordError("record_order_invalid", "contextual records must have unique ascending ids");
    previous = record.id;
    if (record.repo_sha !== repoSha) throw new ContextualRecordError("record_invalid", "contextual input contains a stale repository baseline SHA");
    digest.update(canonicalJson(record)); digest.update("\n");
  }
  return `${canonicalJson({
    schema_version: 1,
    repo_sha: repoSha,
    evaluation_as_of: evaluationAsOf,
    record_set_digest: digest.digest("hex"),
    record_count: records.length,
    records,
  } satisfies ContextualRecordInput)}\n`;
}

export function parseContextualRecordInput(source: string): ContextualRecordInput {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    throw new ContextualRecordError("record_invalid", "contextual input is not JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ContextualRecordError("record_invalid", "contextual input must be an object");
  }
  const candidate = raw as Partial<ContextualRecordInput>;
  if (
    candidate.schema_version !== 1
    || typeof candidate.repo_sha !== "string"
    || !SHA.test(candidate.repo_sha)
    || typeof candidate.evaluation_as_of !== "string"
    || !/^\d{4}-\d{2}-\d{2}$/u.test(candidate.evaluation_as_of)
    || typeof candidate.record_set_digest !== "string"
    || !/^[0-9a-f]{64}$/u.test(candidate.record_set_digest)
    || !Number.isSafeInteger(candidate.record_count)
    || !Array.isArray(candidate.records)
  ) {
    throw new ContextualRecordError("record_invalid", "contextual input envelope is invalid");
  }
  const canonical = encodeContextualRecordInput(candidate.repo_sha, candidate.evaluation_as_of, candidate.records);
  if (canonical !== source) throw new ContextualRecordError("record_invalid", "contextual input is not canonical or digest-bound");
  // `raw` is already a fresh JSON parse, and byte equality proved its exact
  // canonical form. Parsing another copy inflated the Head startup heap.
  return candidate as ContextualRecordInput;
}

function contextualTextFromRecords(
  record: ContextualRecord,
  records: ReadonlyMap<string, ContextualRecord>,
): string {
  const statement = record.text.split("\n", 1)[0] ?? "";
  if (!statement.startsWith(`${record.kind}: `)) {
    throw new ContextualRecordError("record_invalid", `contextual record has no canonical statement line: ${record.id}`);
  }
  const lines = [
    statement,
    `source: ${record.source_ref}`,
    `lifecycle: ${record.status}; authority: ${record.authority}; certainty: ${record.certainty}`,
  ];
  const relationLines: string[] = [];
  for (const relation of record.relations) {
    const target = records.get(relation.target_id);
    if (!target) continue;
    const targetStatement = target.text.split("\n", 1)[0] ?? "";
    if (!targetStatement.startsWith(`${target.kind}: `)) {
      throw new ContextualRecordError("record_invalid", `contextual relation target has no canonical statement line: ${target.id}`);
    }
    relationLines.push(`${relation.relation} ${targetStatement}`);
    if (relationLines.length === 8) break;
  }
  if (relationLines.length) lines.push(`context: ${relationLines.join(" | ")}`);
  return lines.join("\n").slice(0, 1800);
}

export function replaceContextualRecords(
  base: readonly ContextualRecord[],
  replacements: readonly ContextualRecord[],
): ContextualRecord[] {
  const byId = new Map(base.map((record) => [record.id, record]));
  for (const replacement of replacements) {
    if (!byId.has(replacement.id)) {
      throw new ContextualRecordError("record_invalid", `contract replacement is absent from base input: ${replacement.id}`);
    }
    byId.set(replacement.id, replacement);
  }
  const records = [...byId.values()].sort((a, b) => compareCanonicalText(a.id, b.id));
  const merged = new Map(records.map((record) => [record.id, record]));
  const contextualized = records.map((record) => ({ ...record, text: contextualTextFromRecords(record, merged) }));
  return parseContextualRecordsJsonl(encodeContextualRecordsJsonl(contextualized));
}
