/** Pure journey parsing and evaluation, safe to share with the live repair workflow. */
import type { CodeIndexResolver } from "../code-index.js";
import type { GraphDb } from "../graph-db.js";
import { NODE_KINDS, NODE_STATUSES, type BuildMeta, type NodeStatus } from "../model.js";
import type { KnowledgeRetriever, ContextSlot, KnowledgeQuery, RankedCandidate, RetrievalFilters, UnknownReason } from "../retrieval.js";

const JOURNEY_BLOCK = /```octopus-journeys\s*\n([\s\S]*?)\n```/gu;
const ID = /^J(?:00[1-9]|0[12]\d|030)$/u;
const STEP_ID = /^J(?:00[1-9]|0[12]\d|030)\.[1-9]\d*$/u;
const SLOTS: readonly ContextSlot[] = [
  "contract_principle", "scenarios", "sources_requirements", "decisions_exceptions",
  "actions_symbols", "tests_evidence", "landings_patterns", "unknown_conflicts",
];
const UNKNOWN_CODES: readonly UnknownReason["code"][] = [
  "no_grounded_answer", "missing_slot", "code_index_stale", "vector_unavailable",
  "conflict_supersession_only", "graph_unavailable", "index_failed", "privacy_denied",
  "telemetry_receipt_missing", "telemetry_receipt_invalid",
];

export type JourneyClass = "architecture" | "decision" | "code" | "history" | "parity" | "negative" | "lifecycle" | "waiver" | "sha";
export type QrelMatch = "record_id" | "capability" | "source_ref_contains" | "text_contains" | "field";

export interface JourneyQrel {
  match: QrelMatch;
  value: string;
  field?: string;
  expected?: string;
  relevance: 1 | 2 | 3;
  slots?: ContextSlot[];
  max_rank?: number;
}

export interface JourneyForbidden {
  record_id?: string;
  text_contains?: string;
  statuses?: string[];
  slots?: ContextSlot[];
}

export interface JourneyStep {
  id: string;
  query: {
    text?: string;
    input_ref?: string;
    paths?: string[];
    symbol?: { path?: string; qualified_name: string };
    filters?: RetrievalFilters;
    code_index: "matching" | "stale" | "none";
  };
  qrels: JourneyQrel[];
  forbidden: JourneyForbidden[];
  expected_unknown: UnknownReason["code"][];
  no_answer: boolean;
  max_chars: number;
}

export interface KnowledgeJourney {
  id: string;
  class: JourneyClass;
  title: string;
  hard_gate: boolean;
  steps: JourneyStep[];
}

export interface JourneyDocument {
  schema_version: 1;
  targets: {
    recall_at_10: number;
    ndcg_at_10: number;
    mrr: number;
    forbidden_at_10: 0;
    judged_noise_at_10: number;
  };
  journeys: KnowledgeJourney[];
}

export interface JourneyStepOutcome {
  id: string;
  recall_at_10: number;
  ndcg_at_10: number;
  reciprocal_rank: number;
  forbidden_at_10: number;
  judged_noise_at_10: number;
  chars: number;
  passed: boolean;
  missing: string[];
}

export interface JourneyReport {
  graph: Partial<BuildMeta>;
  outcomes: JourneyStepOutcome[];
  aggregate: {
    recall_at_10: number;
    ndcg_at_10: number;
    mrr: number;
    forbidden_at_10: number;
    judged_noise_at_10: number;
  };
  hard_gates_passed: boolean;
  aggregate_passed: boolean;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactFields(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length) throw new Error(`${label} has unknown field(s): ${extras.join(", ")}`);
}

function string(value: unknown, label: string, max = 2_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw new Error(`${label} must be bounded text`);
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${label} must be a string array`);
  return value;
}

function slotArray(value: unknown, label: string): ContextSlot[] | undefined {
  if (value === undefined) return undefined;
  const values = stringArray(value, label);
  if (values.some((slot) => !SLOTS.includes(slot as ContextSlot))) throw new Error(`${label} contains an invalid slot`);
  return values as ContextSlot[];
}

function parseFilters(value: unknown, label: string): RetrievalFilters | undefined {
  if (value === undefined) return undefined;
  const item = object(value, label);
  exactFields(item, ["kinds", "lifecycle", "capabilities", "providers", "launchModes", "states", "actions", "slots"], label);
  const kinds = item.kinds === undefined ? undefined : stringArray(item.kinds, `${label}.kinds`);
  if (kinds?.some((kind) => !NODE_KINDS.includes(kind as (typeof NODE_KINDS)[number]))) throw new Error(`${label}.kinds contains an invalid kind`);
  const lifecycle = item.lifecycle;
  if (lifecycle !== undefined && !["current", "history", "proposed", "all"].includes(String(lifecycle))) throw new Error(`${label}.lifecycle is invalid`);
  const slots = slotArray(item.slots, `${label}.slots`);
  const optionalStrings = (key: "capabilities" | "providers" | "launchModes" | "states" | "actions") =>
    item[key] === undefined ? undefined : stringArray(item[key], `${label}.${key}`).map((entry, index) => string(entry, `${label}.${key}[${index}]`, 512));
  const capabilities = optionalStrings("capabilities");
  const providers = optionalStrings("providers");
  const launchModes = optionalStrings("launchModes");
  const states = optionalStrings("states");
  const actions = optionalStrings("actions");
  return {
    ...(kinds ? { kinds: kinds as RetrievalFilters["kinds"] } : {}),
    ...(typeof lifecycle === "string" ? { lifecycle: lifecycle as NonNullable<RetrievalFilters["lifecycle"]> } : {}),
    ...(capabilities ? { capabilities } : {}),
    ...(providers ? { providers } : {}),
    ...(launchModes ? { launchModes } : {}),
    ...(states ? { states } : {}),
    ...(actions ? { actions } : {}),
    ...(slots ? { slots } : {}),
  };
}

function parseQrel(value: unknown, label: string): JourneyQrel {
  const item = object(value, label);
  exactFields(item, ["match", "value", "field", "expected", "relevance", "slots", "max_rank"], label);
  if (!["record_id", "capability", "source_ref_contains", "text_contains", "field"].includes(String(item.match))) throw new Error(`${label}.match is invalid`);
  if (![1, 2, 3].includes(Number(item.relevance))) throw new Error(`${label}.relevance is invalid`);
  if (item.match === "field" && (typeof item.field !== "string" || typeof item.expected !== "string")) throw new Error(`${label} field matcher needs field and expected`);
  if (item.match === "field" && !["status", "realization"].includes(String(item.field))) throw new Error(`${label}.field is invalid`);
  if (item.max_rank !== undefined && (!Number.isSafeInteger(item.max_rank) || Number(item.max_rank) < 1 || Number(item.max_rank) > 32)) throw new Error(`${label}.max_rank is invalid`);
  const slots = slotArray(item.slots, `${label}.slots`);
  return {
    match: item.match as QrelMatch,
    value: string(item.value, `${label}.value`, 512),
    ...(typeof item.field === "string" ? { field: item.field } : {}),
    ...(typeof item.expected === "string" ? { expected: item.expected } : {}),
    relevance: item.relevance as 1 | 2 | 3,
    ...(slots ? { slots } : {}),
    ...(typeof item.max_rank === "number" ? { max_rank: item.max_rank } : {}),
  };
}

function parseForbidden(value: unknown, label: string): JourneyForbidden {
  const item = object(value, label);
  exactFields(item, ["record_id", "text_contains", "statuses", "slots"], label);
  if (typeof item.record_id !== "string" && typeof item.text_contains !== "string" && !Array.isArray(item.statuses)) throw new Error(`${label} needs a matcher`);
  const slots = slotArray(item.slots, `${label}.slots`);
  return {
    ...(typeof item.record_id === "string" ? { record_id: string(item.record_id, `${label}.record_id`, 512) } : {}),
    ...(typeof item.text_contains === "string" ? { text_contains: string(item.text_contains, `${label}.text_contains`, 512) } : {}),
    ...(item.statuses === undefined ? {} : { statuses: stringArray(item.statuses, `${label}.statuses`).map((status) => {
      if (!NODE_STATUSES.includes(status as NodeStatus)) throw new Error(`${label}.statuses contains an invalid status`);
      return status;
    }) }),
    ...(slots ? { slots } : {}),
  };
}

export function parseJourneyStep(value: unknown, journeyId: string, index: number): JourneyStep {
  const label = `${journeyId}.steps[${index}]`;
  const item = object(value, label);
  exactFields(item, ["id", "query", "qrels", "forbidden", "expected_unknown", "no_answer", "max_chars"], label);
  const id = string(item.id, `${label}.id`, 32);
  if (!STEP_ID.test(id) || id !== `${journeyId}.${index + 1}`) throw new Error(`${label}.id is invalid`);
  const query = object(item.query, `${label}.query`);
  exactFields(query, ["text", "input_ref", "paths", "symbol", "filters", "code_index"], `${label}.query`);
  if (!["matching", "stale", "none"].includes(String(query.code_index))) throw new Error(`${label}.query.code_index is invalid`);
  const symbol = query.symbol === undefined ? undefined : object(query.symbol, `${label}.query.symbol`);
  if (symbol) exactFields(symbol, ["path", "qualified_name"], `${label}.query.symbol`);
  const qrels = Array.isArray(item.qrels) ? item.qrels.map((qrel, qrelIndex) => parseQrel(qrel, `${label}.qrels[${qrelIndex}]`)) : (() => { throw new Error(`${label}.qrels must be an array`); })();
  const forbidden = Array.isArray(item.forbidden) ? item.forbidden.map((entry, entryIndex) => parseForbidden(entry, `${label}.forbidden[${entryIndex}]`)) : (() => { throw new Error(`${label}.forbidden must be an array`); })();
  const expectedUnknown = stringArray(item.expected_unknown, `${label}.expected_unknown`);
  if (expectedUnknown.some((code) => !UNKNOWN_CODES.includes(code as UnknownReason["code"]))) throw new Error(`${label}.expected_unknown has an invalid code`);
  if (typeof item.no_answer !== "boolean" || !Number.isSafeInteger(item.max_chars) || Number(item.max_chars) < 800 || Number(item.max_chars) > 7_000) throw new Error(`${label} has invalid gates`);
  if (item.no_answer && qrels.length) throw new Error(`${label} no-answer step cannot have qrels`);
  const filters = parseFilters(query.filters, `${label}.query.filters`);
  return {
    id,
    query: {
      ...(typeof query.text === "string" ? { text: string(query.text, `${label}.query.text`, 8_000) } : {}),
      ...(typeof query.input_ref === "string" ? { input_ref: string(query.input_ref, `${label}.query.input_ref`, 512) } : {}),
      ...(query.paths === undefined ? {} : { paths: stringArray(query.paths, `${label}.query.paths`) }),
      ...(symbol ? { symbol: {
        ...(typeof symbol.path === "string" ? { path: string(symbol.path, `${label}.query.symbol.path`, 512) } : {}),
        qualified_name: string(symbol.qualified_name, `${label}.query.symbol.qualified_name`, 512),
      } } : {}),
      ...(filters ? { filters } : {}),
      code_index: query.code_index as JourneyStep["query"]["code_index"],
    },
    qrels,
    forbidden,
    expected_unknown: expectedUnknown as UnknownReason["code"][],
    no_answer: item.no_answer,
    max_chars: Number(item.max_chars),
  };
}

/** Exactly one fenced JSON authority; prose outside the fence is never parsed as data. */
export function parseKnowledgeJourneys(markdown: string): JourneyDocument {
  const matches = [...markdown.matchAll(JOURNEY_BLOCK)];
  if (matches.length !== 1) throw new Error(`journeys Markdown must contain exactly one octopus-journeys block (found ${matches.length})`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(matches[0][1]);
  } catch {
    throw new Error("octopus-journeys block is not strict JSON");
  }
  const root = object(parsed, "journeys");
  exactFields(root, ["schema_version", "targets", "journeys"], "journeys");
  if (root.schema_version !== 1 || !Array.isArray(root.journeys) || root.journeys.length !== 30) throw new Error("journeys must be schema v1 with exactly 30 journeys");
  const targets = object(root.targets, "journeys.targets");
  exactFields(targets, ["recall_at_10", "ndcg_at_10", "mrr", "forbidden_at_10", "judged_noise_at_10"], "journeys.targets");
  const targetNumbers = [targets.recall_at_10, targets.ndcg_at_10, targets.mrr, targets.forbidden_at_10, targets.judged_noise_at_10];
  if (targetNumbers.some((value) => typeof value !== "number" || value < 0 || value > 1) || targets.forbidden_at_10 !== 0) throw new Error("journey targets are invalid");
  const journeys: KnowledgeJourney[] = root.journeys.map((value, index) => {
    const label = `journeys[${index}]`;
    const item = object(value, label);
    exactFields(item, ["id", "class", "title", "hard_gate", "steps"], label);
    const id = string(item.id, `${label}.id`, 8);
    if (!ID.test(id) || id !== `J${String(index + 1).padStart(3, "0")}`) throw new Error(`${label}.id must be contiguous J001-J030`);
    if (!["architecture", "decision", "code", "history", "parity", "negative", "lifecycle", "waiver", "sha"].includes(String(item.class))) throw new Error(`${label}.class is invalid`);
    if (typeof item.hard_gate !== "boolean" || item.hard_gate !== (index >= 24) || !Array.isArray(item.steps) || item.steps.length < 1 || item.steps.length > 2) throw new Error(`${label} has invalid hard-gate/steps`);
    return {
      id,
      class: item.class as JourneyClass,
      title: string(item.title, `${label}.title`, 300),
      hard_gate: item.hard_gate,
      steps: item.steps.map((step, stepIndex) => parseJourneyStep(step, id, stepIndex)),
    };
  });
  return {
    schema_version: 1,
    targets: targets as JourneyDocument["targets"],
    journeys,
  };
}

function normalized(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

function qrelMatches(qrel: JourneyQrel, candidate: RankedCandidate, slots: Readonly<Record<ContextSlot, readonly RankedCandidate[]>>): boolean {
  let matched = false;
  switch (qrel.match) {
    case "record_id": matched = candidate.id === qrel.value; break;
    case "capability": matched = candidate.id === (qrel.value.startsWith("capability:") ? qrel.value : `capability:${qrel.value}`); break;
    case "source_ref_contains": matched = normalized(candidate.node.source_ref).includes(normalized(qrel.value)); break;
    case "text_contains": matched = normalized(candidate.node.statement).includes(normalized(qrel.value)); break;
    case "field": matched = candidate.id === qrel.value && qrel.field != null && String(candidate.node[qrel.field as keyof typeof candidate.node] ?? "") === qrel.expected; break;
  }
  if (!matched || !qrel.slots?.length) return matched;
  return qrel.slots.some((slot) => slots[slot].some((item) => item.id === candidate.id));
}

function forbiddenMatches(forbidden: JourneyForbidden, candidate: RankedCandidate, slot?: ContextSlot): boolean {
  if (forbidden.record_id && candidate.id !== forbidden.record_id) return false;
  if (forbidden.text_contains && !normalized(candidate.node.statement).includes(normalized(forbidden.text_contains))) return false;
  if (forbidden.statuses?.length && !forbidden.statuses.includes(candidate.node.status)) return false;
  if (forbidden.slots?.length && (!slot || !forbidden.slots.includes(slot))) return false;
  return true;
}

function dcg(relevances: readonly number[]): number {
  return relevances.reduce((sum, relevance, index) => sum + (2 ** relevance - 1) / Math.log2(index + 2), 0);
}

export async function evaluateJourneys(retriever: KnowledgeRetriever, document: JourneyDocument, repoSha: string, codeIndex?: CodeIndexResolver): Promise<JourneyStepOutcome[]> {
  const outcomes: JourneyStepOutcome[] = [];
  for (const journey of document.journeys) {
    for (const step of journey.steps) {
      const query: KnowledgeQuery = {
        text: step.query.text,
        inputRef: step.query.input_ref,
        paths: step.query.paths,
        symbol: step.query.symbol ? { path: step.query.symbol.path, qualifiedName: step.query.symbol.qualified_name } : undefined,
        repoSha,
        codeIndexSha: step.query.code_index === "matching" ? codeIndex?.gitSha : step.query.code_index === "stale" ? "0".repeat(40) : undefined,
        filters: step.query.filters,
        budget: { chars: step.max_chars, rawCandidates: 80, rankedCandidates: 32 },
      };
      const result = await retriever.retrieve(query);
      const top = result.ranked.slice(0, 10);
      const matchedRanks = step.qrels.map((qrel) => {
        const index = top.findIndex((candidate) => qrelMatches(qrel, candidate, result.slots));
        return index < 0 ? 0 : index + 1;
      });
      const recall = step.qrels.length ? matchedRanks.filter(Boolean).length / step.qrels.length : 1;
      const firstRank = matchedRanks.filter(Boolean).sort((a, b) => a - b)[0] ?? 0;
      const reciprocalRank = firstRank ? 1 / firstRank : step.qrels.length ? 0 : 1;
      const actualRelevance = top.map((_candidate, index) =>
        Math.max(0, ...step.qrels.flatMap((qrel, qrelIndex) => matchedRanks[qrelIndex] === index + 1 ? [qrel.relevance] : [])));
      const idealRelevance = step.qrels.map((qrel) => qrel.relevance).sort((a, b) => b - a).slice(0, 10);
      const idealDcg = dcg(idealRelevance);
      const ndcg = idealDcg ? Math.min(1, dcg(actualRelevance) / idealDcg) : 1;
      const forbiddenJudgments = new Set<string>();
      const judgeForbidden = (candidate: RankedCandidate, slot?: ContextSlot) => {
        step.forbidden.forEach((entry, index) => {
          if (forbiddenMatches(entry, candidate, slot)) forbiddenJudgments.add(`${candidate.id}\0${index}`);
        });
      };
      for (const candidate of top) judgeForbidden(candidate);
      for (const slot of SLOTS) {
        for (const candidate of result.slots[slot]) judgeForbidden(candidate, slot);
      }
      const forbiddenHits = forbiddenJudgments.size;
      const missing: string[] = [];
      step.qrels.forEach((qrel, index) => {
        const rank = matchedRanks[index];
        if (!rank) missing.push(`${qrel.match}:${qrel.value}`);
        else if (qrel.max_rank && rank > qrel.max_rank) missing.push(`${qrel.match}:${qrel.value} rank ${rank}>${qrel.max_rank}`);
      });
      for (const code of step.expected_unknown) if (!result.unknown.some((reason) => reason.code === code)) missing.push(`unknown:${code}`);
      if (step.no_answer && !result.unknown.some((reason) => reason.code === "no_grounded_answer")) missing.push("no_grounded_answer");
      if (step.query.code_index === "matching") {
        if (!codeIndex) missing.push("code_index:matching resolver unavailable");
        else if (codeIndex.gitSha !== repoSha) missing.push(`code_index:matching SHA ${codeIndex.gitSha}!=${repoSha}`);
        if (!step.expected_unknown.includes("code_index_stale") && result.unknown.some((reason) => reason.code === "code_index_stale")) {
          missing.push("unexpected_unknown:code_index_stale");
        }
      }
      if (result.chars > step.max_chars || result.chars > 7_000) missing.push(`budget:${result.chars}`);
      if (forbiddenHits) missing.push(`forbidden:${forbiddenHits}`);
      const judged = top.filter((candidate) => step.qrels.some((qrel) => qrelMatches(qrel, candidate, result.slots)) || step.forbidden.some((entry) => forbiddenMatches(entry, candidate))).length;
      outcomes.push({
        id: step.id,
        recall_at_10: recall,
        ndcg_at_10: ndcg,
        reciprocal_rank: reciprocalRank,
        forbidden_at_10: forbiddenHits,
        judged_noise_at_10: judged ? forbiddenHits / judged : 0,
        chars: result.chars,
        passed: missing.length === 0,
        missing,
      });
    }
  }
  return outcomes;
}

function mean(values: readonly number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

export function journeyReport(graph: GraphDb, document: JourneyDocument, outcomes: JourneyStepOutcome[]): JourneyReport {
  const aggregate = {
    recall_at_10: mean(outcomes.map((outcome) => outcome.recall_at_10)),
    ndcg_at_10: mean(outcomes.map((outcome) => outcome.ndcg_at_10)),
    mrr: mean(outcomes.map((outcome) => outcome.reciprocal_rank)),
    forbidden_at_10: outcomes.reduce((sum, outcome) => sum + outcome.forbidden_at_10, 0),
    judged_noise_at_10: mean(outcomes.map((outcome) => outcome.judged_noise_at_10)),
  };
  const hardIds = new Set(document.journeys.filter((journey) => journey.hard_gate).flatMap((journey) => journey.steps.map((step) => step.id)));
  return {
    graph: graph.meta(),
    outcomes,
    aggregate,
    hard_gates_passed: outcomes.filter((outcome) => hardIds.has(outcome.id)).every((outcome) => outcome.passed),
    aggregate_passed: aggregate.recall_at_10 >= document.targets.recall_at_10
      && aggregate.ndcg_at_10 >= document.targets.ndcg_at_10
      && aggregate.mrr >= document.targets.mrr
      && aggregate.forbidden_at_10 === document.targets.forbidden_at_10
      && aggregate.judged_noise_at_10 <= document.targets.judged_noise_at_10,
  };
}

