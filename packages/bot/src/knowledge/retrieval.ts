import { knowledgeStrength, STRENGTH_RANK } from "./provenance.js";
import { createHash, randomBytes } from "node:crypto";
import type {
  CodeIndexResolver,
  CodeSymbol,
  StaticTestReference,
} from "./code-index.js";
import { assembleContextPack } from "./context-pack.js";
import type { GraphDb } from "./graph-db.js";
import { capabilityId, moduleId, pathId } from "./ids.js";
import { repoPaths } from "./markdown.js";
import {
  AUTHORITY_RANK,
  type Certainty,
  type ContractCell,
  type KnowledgeEdge,
  type KnowledgeNode,
  type NodeKind,
  type NodeStatus,
  type Relation,
} from "./model.js";
import {
  RetrievalTraceCollector,
  createRetrievalTraceEnvelope,
  type CandidateAudit,
  type ClassificationAudit,
  type IndexAttemptAudit,
  type RetrievalErrorCode,
  type RetrievalMissCode,
  type RetrievalSlot,
  type RetrievalTrace,
} from "./retrieval-trace.js";
import { moduleForPath, type AtlasModuleDef } from "./sources/context.js";

export type ContextSlot = RetrievalSlot;
export type RetrievalLifecycle = "current" | "history" | "proposed" | "all";

export interface RetrievalFilters {
  kinds?: readonly NodeKind[];
  lifecycle?: RetrievalLifecycle;
  capabilities?: readonly string[];
  providers?: readonly string[];
  launchModes?: readonly string[];
  states?: readonly string[];
  actions?: readonly string[];
  slots?: readonly ContextSlot[];
}

export interface KnowledgeQuery {
  text?: string;
  inputRef?: string;
  paths?: readonly string[];
  symbol?: { path?: string; qualifiedName: string };
  repoSha: string;
  codeIndexSha?: string;
  filters?: RetrievalFilters;
  budget?: { chars: number; rawCandidates: number; rankedCandidates: number };
  trace?: RetrievalTraceCollector;
  signal?: AbortSignal;
}

export interface CandidateSignal {
  index: string;
  rank: number;
  rawScore: number;
  rrfContribution: number;
}

export interface RankedCandidate {
  id: string;
  node: KnowledgeNode;
  slot: ContextSlot;
  grounding: "exact" | "expanded" | "hybrid" | "lexical" | "vector";
  signals: readonly CandidateSignal[];
  edgePath: ReadonlyArray<{ from: string; relation: Relation; to: string }>;
  rrfScore: number;
  finalScore: number;
  rerank: ReadonlyArray<{ feature: string; contribution: number }>;
}

export interface UnknownReason {
  code: RetrievalMissCode;
  slot?: ContextSlot;
  index?: string;
}

export interface RetrievalResult {
  ranked: readonly RankedCandidate[];
  slots: Readonly<Record<ContextSlot, readonly RankedCandidate[]>>;
  unknown: readonly UnknownReason[];
  text: string;
  chars: number;
  trace: RetrievalTrace;
  classifications: CapabilityMatch[];
}

export interface SimilarityRequest {
  text: string;
  filters: RetrievalFilters;
  limit: number;
  signal?: AbortSignal;
}

export interface SimilarityHit {
  id: string;
  score: number;
}

export interface SimilarityAttemptTrace {
  index: string;
  version: string;
  kind: "fts5_trigram" | "vector";
  sourceGitSha: string;
  artifactSha256: string;
  recordCount: number;
  status: "ok" | "degraded" | "rejected";
  latencyMs: number;
  hits: Array<{ id: string; rank: number; score: number }>;
  errorCode?: RetrievalErrorCode;
  embedding?: {
    provider: string;
    modelId: string;
    immutableRevision: string;
    dimensions: number;
  };
}

export interface SimilaritySearchResult {
  hits: readonly SimilarityHit[];
  trace: SimilarityAttemptTrace;
}

export interface SimilarityIndex {
  readonly name: string;
  readonly version: string;
  search(request: SimilarityRequest): Promise<SimilaritySearchResult>;
}

interface FusedSimilarityHit extends SimilarityHit {
  signals: CandidateSignal[];
}

interface SimilarityRegistryResult {
  hits: FusedSimilarityHit[];
  attempts: SimilarityAttemptTrace[];
  failures: Array<{ index: string; code: RetrievalErrorCode }>;
}

const HAN_RUN = /\p{Script=Han}+/gu;
const LATIN_TOKEN = /(?:[A-Za-z][A-Za-z0-9_.\-]{2,}|[A-Z]{2}|\d+(?:[.\-]\d+)+|\d{3,})/g;
const TRACE_KEY = randomBytes(32);
const ZERO_SHA256 = "0".repeat(64);
const ZERO_GIT_SHA = "0".repeat(40);
const RRF_K = 60;
/**
 * Similarity is optional evidence. A wedged local embedding worker must not
 * hold exact path expansion, lexical evidence, or the calling ticket turn
 * behind it indefinitely.
 */
export const SIMILARITY_INDEX_TIMEOUT_MS = 30_000;

export function matchExpression(text: string, top = 120): string | null {
  const normalized = text.normalize("NFKC");
  const counts = new Map<string, number>();
  const bump = (term: string) => counts.set(term, (counts.get(term) ?? 0) + 1);
  for (const match of normalized.matchAll(LATIN_TOKEN)) bump(match[0].toLowerCase());
  for (const match of normalized.matchAll(HAN_RUN)) {
    for (const width of [3, 2]) {
      for (let index = 0; index + width <= match[0].length; index += 1) bump(match[0].slice(index, index + width));
    }
  }
  const terms = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([term]) => term);
  return terms.length ? terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ") : null;
}

function graphDigest(graph: GraphDb): string {
  const meta = graph.meta();
  return createHash("sha256").update(JSON.stringify(meta, Object.keys(meta).sort())).digest("hex");
}

function lifecycleStatuses(lifecycle: RetrievalLifecycle): readonly NodeStatus[] {
  switch (lifecycle) {
    case "current": return ["active"];
    case "history": return ["superseded", "historical", "rejected"];
    case "proposed": return ["proposed"];
    case "all": return ["active", "proposed", "superseded", "historical", "rejected"];
  }
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return value === undefined || !Number.isSafeInteger(value) ? fallback : Math.max(minimum, Math.min(value, maximum));
}

function errorCode(error: unknown): RetrievalErrorCode {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    const known: readonly RetrievalErrorCode[] = [
      "graph_unavailable", "index_failed", "manifest_invalid", "checksum_mismatch", "model_binding_mismatch",
      "dimension_mismatch", "stale_source_sha", "privacy_denied", "index_missing", "embed_timeout", "provider_unavailable",
    ];
    if (known.includes(error.code as RetrievalErrorCode)) return error.code as RetrievalErrorCode;
  }
  return "index_failed";
}

export class LexicalIndex implements SimilarityIndex {
  readonly name = "lexical";
  readonly version = "fts5-trigram-v1";

  constructor(private readonly graph: GraphDb) {}

  async search(request: SimilarityRequest): Promise<SimilaritySearchResult> {
    const started = performance.now();
    const match = matchExpression(request.text);
    const hits = match
      ? this.graph.searchFts(match, {
        kinds: request.filters.kinds,
        statuses: lifecycleStatuses(request.filters.lifecycle ?? "current"),
        limit: request.limit,
      }).map((hit) => ({ id: hit.id, score: -hit.rank }))
      : [];
    const meta = this.graph.meta();
    const sourceGitSha = typeof meta.commit === "string" && /^[0-9a-f]{40}$/u.test(meta.commit) ? meta.commit : ZERO_GIT_SHA;
    return {
      hits,
      trace: {
        index: this.name,
        version: this.version,
        kind: "fts5_trigram",
        sourceGitSha,
        artifactSha256: graphDigest(this.graph),
        recordCount: this.graph.counts().nodes,
        status: "ok",
        latencyMs: performance.now() - started,
        hits: hits.slice(0, 20).map((hit, rank) => ({ id: hit.id, rank: rank + 1, score: hit.score })),
      },
    };
  }
}

export class SimilarityRegistry {
  private readonly indexes: SimilarityIndex[] = [];

  constructor(
    indexes: readonly SimilarityIndex[] = [],
    private readonly indexTimeoutMs: number = SIMILARITY_INDEX_TIMEOUT_MS,
  ) {
    for (const index of indexes) this.register(index);
  }

  register(index: SimilarityIndex): void {
    if (this.indexes.some((item) => item.name === index.name)) throw new Error(`similarity index ${index.name} already registered`);
    this.indexes.push(index);
  }

  get names(): string[] {
    return this.indexes.map((index) => index.name);
  }

  /** Optional signals run concurrently; failures stay visible and exact facts survive. */
  async search(request: SimilarityRequest): Promise<SimilarityRegistryResult> {
    const settled = await Promise.allSettled(this.indexes.map((index) => this.searchBounded(index, request)));
    const fused = new Map<string, FusedSimilarityHit>();
    const attempts: SimilarityAttemptTrace[] = [];
    const failures: SimilarityRegistryResult["failures"] = [];
    settled.forEach((outcome, indexPosition) => {
      const index = this.indexes[indexPosition];
      if (outcome.status === "rejected") {
        const code = errorCode(outcome.reason);
        failures.push({ index: index.name, code });
        attempts.push({
          index: index.name,
          version: index.version,
          kind: index.name.includes("vector") ? "vector" : "fts5_trigram",
          sourceGitSha: ZERO_GIT_SHA,
          artifactSha256: ZERO_SHA256,
          recordCount: 0,
          status: "rejected",
          latencyMs: 0,
          hits: [],
          errorCode: code,
        });
        return;
      }
      attempts.push(outcome.value.trace);
      const weight = outcome.value.trace.kind === "vector" ? 1.2 : 1;
      outcome.value.hits.forEach((hit, rank) => {
        const contribution = weight / (RRF_K + rank + 1);
        const existing = fused.get(hit.id) ?? { id: hit.id, score: 0, signals: [] };
        existing.score += contribution;
        existing.signals.push({ index: index.name, rank: rank + 1, rawScore: hit.score, rrfContribution: contribution });
        fused.set(hit.id, existing);
      });
    });
    return {
      hits: [...fused.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, request.limit),
      attempts,
      failures,
    };
  }

  private async searchBounded(index: SimilarityIndex, request: SimilarityRequest): Promise<SimilaritySearchResult> {
    const controller = new AbortController();
    const signal = request.signal
      ? AbortSignal.any([request.signal, controller.signal])
      : controller.signal;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = Object.assign(
          new Error(`similarity index ${index.name} timed out`),
          { code: index.name.includes("vector") ? "embed_timeout" : "index_failed" },
        );
        controller.abort(error);
        reject(error);
      }, this.indexTimeoutMs);
    });
    try {
      return await Promise.race([
        index.search({ ...request, signal }),
        timedOut,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export interface CapabilityMatch {
  id: string;
  node: KnowledgeNode;
  certainty: Certainty;
  score: number;
  why: string[];
}

export interface ClassifyInput {
  text: string;
  explicitPaths?: readonly string[];
  explicitModules?: readonly string[];
}

export interface Expansion {
  modules: KnowledgeNode[];
  capabilities: KnowledgeNode[];
  principles: KnowledgeNode[];
  constraints: KnowledgeNode[];
  decisions: KnowledgeNode[];
  nonGoals: KnowledgeNode[];
  requirements: KnowledgeNode[];
  risks: KnowledgeNode[];
  landings: KnowledgeNode[];
  patterns: KnowledgeNode[];
  evidence: KnowledgeNode[];
  via: Map<string, Set<string>>;
  unmappedPaths: string[];
}

interface CandidateWork {
  node: KnowledgeNode;
  signals: CandidateSignal[];
  exact: boolean;
  expanded: boolean;
  exactLineage: boolean;
  /** Reached from a literal query referent (path, input_ref, ticket ref, symbol, explicit filter) rather than a text classification. */
  referent: boolean;
  referentLineage: boolean;
  directSimilarity: boolean;
  inferredSubject: boolean;
  expansionScore: number;
  edgePath: Array<{ from: string; relation: Relation; to: string }>;
  slot: ContextSlot;
}

interface ExpansionRule {
  relation: Relation;
  from: readonly NodeKind[];
  to: readonly NodeKind[];
}

const EXPANSION_RULES: readonly ExpansionRule[] = [
  { relation: "contract_for", from: ["capability_contract"], to: ["capability"] },
  { relation: "defines", from: ["capability_contract"], to: ["principle", "obligation", "scenario", "desired_conformance", "exception"] },
  { relation: "derives_from", from: ["obligation", "scenario", "exception", "desired_conformance"], to: ["principle", "requirement", "decision", "source"] },
  { relation: "applies_to", from: ["desired_conformance", "exception", "obligation"], to: ["scenario", "artifact"] },
  { relation: "requires", from: ["desired_conformance", "scenario", "obligation"], to: ["obligation", "artifact", "constraint"] },
  { relation: "waives", from: ["exception"], to: ["obligation", "desired_conformance", "constraint"] },
  { relation: "supported_by", from: ["capability_contract", "obligation", "scenario", "desired_conformance", "exception", "requirement", "decision", "principle"], to: ["source", "artifact"] },
  { relation: "observes", from: ["observed_conformance"], to: ["desired_conformance"] },
  { relation: "realized_by", from: ["principle", "requirement", "decision", "non_goal", "risk", "obligation", "scenario", "observed_conformance", "desired_conformance"], to: ["artifact"] },
  { relation: "verified_by", from: ["principle", "requirement", "decision", "non_goal", "risk", "scenario", "observed_conformance", "desired_conformance", "obligation"], to: ["artifact", "evidence"] },
  { relation: "reaffirms", from: ["requirement", "decision", "principle", "obligation"], to: ["requirement", "decision", "principle", "obligation"] },
  { relation: "governs", from: ["principle"], to: ["capability", "module", "path", "zone"] },
  { relation: "enforced_by", from: ["principle"], to: ["constraint", "evidence"] },
  { relation: "motivates", from: ["requirement"], to: ["decision"] },
  { relation: "supersedes", from: ["decision", "principle", "requirement", "risk", "obligation"], to: ["decision", "principle", "requirement", "risk", "obligation"] },
  { relation: "bounds", from: ["non_goal"], to: ["capability", "module"] },
  { relation: "implements", from: ["landing"], to: ["requirement", "decision", "non_goal", "risk", "obligation"] },
  { relation: "touches", from: ["landing", "doc"], to: ["path", "module"] },
  { relation: "about", from: ["ticket", "requirement", "decision", "risk", "landing", "doc", "pattern", "source"], to: ["capability", "ticket", "capability_contract"] },
  { relation: "spans", from: ["capability"], to: ["module", "flow", "zone"] },
  { relation: "constrained_by", from: ["capability"], to: ["constraint"] },
  { relation: "evidences", from: ["evidence"], to: ["constraint", "decision", "principle", "pattern"] },
  { relation: "observed_in", from: ["pattern"], to: ["ticket"] },
  { relation: "guards", from: ["pattern"], to: ["module", "path"] },
];

function slotForNode(node: KnowledgeNode): ContextSlot {
  switch (node.kind) {
    case "principle":
    case "capability":
    case "capability_contract":
    case "obligation":
    case "desired_conformance": return "contract_principle";
    case "scenario": return "scenarios";
    case "source":
    case "requirement": return "sources_requirements";
    case "decision":
    case "exception":
    case "non_goal":
    case "risk": return "decisions_exceptions";
    case "path":
    case "module": return "actions_symbols";
    case "artifact": {
      const role = String(node.metadata?.artifact_role ?? node.metadata?.role ?? node.metadata?.kind ?? "");
      return role === "test" ? "tests_evidence" : "actions_symbols";
    }
    case "constraint":
    case "evidence":
    case "observed_conformance": return "tests_evidence";
    case "landing":
    case "pattern": return "landings_patterns";
    default: return "unknown_conflicts";
  }
}

function relationAllowed(edge: KnowledgeEdge, from: KnowledgeNode, to: KnowledgeNode): boolean {
  if (edge.certainty !== "exact") return false;
  return EXPANSION_RULES.some((rule) => rule.relation === edge.relation && rule.from.includes(from.kind) && rule.to.includes(to.kind));
}

function metadataValues(node: KnowledgeNode, keys: readonly string[]): string[] {
  const values: string[] = [];
  for (const key of keys) {
    const raw = node.metadata?.[key];
    if (typeof raw === "string") values.push(raw);
    else if (Array.isArray(raw)) for (const value of raw) if (typeof value === "string") values.push(value);
  }
  return values;
}

function scopedExceptionMatches(graph: GraphDb, node: KnowledgeNode, filters: RetrievalFilters): boolean {
  if (node.kind !== "exception") return true;
  if (!filters.providers?.length || !filters.launchModes?.length || !filters.states?.length || !filters.actions?.length) return false;
  const cells = graph.contractCells().filter((cell) => cell.exception_id === node.id);
  if (cells.length) {
    return cells.some((cell) =>
      filters.providers!.includes(cell.provider)
      && filters.launchModes!.includes(cell.launch_mode)
      && filters.states!.includes(cell.state)
      && filters.actions!.includes(cell.action));
  }
  const dimensions: Array<[readonly string[], readonly string[]]> = [
    [filters.providers, metadataValues(node, ["provider", "providers"])],
    [filters.launchModes, metadataValues(node, ["launch_mode", "launch_modes", "mode", "modes"])],
    [filters.states, metadataValues(node, ["state", "states"])],
    [filters.actions, metadataValues(node, ["action", "actions"])],
  ];
  return dimensions.every(([queryValues, scopeValues]) =>
    scopeValues.length > 0 && queryValues.some((value) => scopeValues.includes(value)));
}

function dimensionMatches(node: KnowledgeNode, filters: RetrievalFilters): number {
  let matches = 0;
  const dimensions: Array<[readonly string[] | undefined, readonly string[]]> = [
    [filters.capabilities, metadataValues(node, ["capability", "capabilities"])],
    [filters.providers, metadataValues(node, ["provider", "providers"])],
    [filters.launchModes, metadataValues(node, ["launch_mode", "launch_modes", "mode", "modes"])],
    [filters.states, metadataValues(node, ["state", "states"])],
    [filters.actions, metadataValues(node, ["action", "actions"])],
  ];
  for (const [wanted, actual] of dimensions) if (wanted?.some((value) => actual.includes(value))) matches += 1;
  return matches;
}

function dimensionsCompatible(node: KnowledgeNode, filters: RetrievalFilters): boolean {
  const dimensions: Array<[readonly string[] | undefined, readonly string[]]> = [
    [filters.providers, metadataValues(node, ["provider", "providers"])],
    [filters.launchModes, metadataValues(node, ["launch_mode", "launch_modes", "mode", "modes"])],
    [filters.states, metadataValues(node, ["state", "states"])],
    [filters.actions, metadataValues(node, ["action", "actions"])],
  ];
  return dimensions.every(([wanted, actual]) => !wanted?.length || actual.length === 0 || wanted.some((value) => actual.includes(value)));
}

function rankCertainty(certainty: Certainty): number {
  return certainty === "exact" ? 3 : certainty === "inferred" ? 2 : 1;
}

function lifecycleRank(status: NodeStatus): number {
  switch (status) {
    case "active": return 5;
    case "proposed": return 3;
    case "historical": return 2;
    case "superseded": return 1;
    case "rejected": return 0;
  }
}

function grounding(work: CandidateWork): RankedCandidate["grounding"] {
  if (work.exact) return "exact";
  const names = new Set(work.signals.map((signal) => signal.index.includes("vector") ? "vector" : "lexical"));
  if (work.directSimilarity) {
    if (names.size > 1) return "hybrid";
    return names.has("vector") ? "vector" : "lexical";
  }
  if (work.expanded || work.exactLineage) return "expanded";
  return names.has("vector") ? "vector" : "lexical";
}

function sourceOrder(a: KnowledgeNode, b: KnowledgeNode): number {
  return a.source_ref.localeCompare(b.source_ref) || a.id.localeCompare(b.id);
}

export class KnowledgeRetriever {
  private moduleDefs: AtlasModuleDef[] | null = null;
  private readonly capabilityMembership = new Map<string, ReadonlySet<string>>();
  readonly similarity: SimilarityRegistry;

  constructor(
    readonly graph: GraphDb,
    similarity?: SimilarityRegistry,
    private readonly codeIndex?: CodeIndexResolver,
  ) {
    this.similarity = similarity ?? new SimilarityRegistry([new LexicalIndex(graph)]);
  }

  private modules(): AtlasModuleDef[] {
    if (!this.moduleDefs) {
      this.moduleDefs = this.graph.nodesByKind("module").map((node) => ({
        id: node.id.replace(/^module:/, ""),
        label: node.statement,
        zone: String(node.metadata?.zone ?? "unmapped"),
        pathPrefixes: (node.metadata?.pathPrefixes as string[] | undefined) ?? [],
      }));
    }
    return this.moduleDefs;
  }

  moduleFor(path: string): string {
    return moduleForPath(path, this.modules());
  }

  /** Exact path and alias classification; lexical/vector classification is added by retrieve(). */
  async classify(input: ClassifyInput): Promise<CapabilityMatch[]> {
    const matches = new Map<string, CapabilityMatch>();
    const capabilities = this.graph.nodesByKind("capability", "active");
    const byId = new Map(capabilities.map((node) => [node.id, node]));
    const add = (id: string, certainty: Certainty, score: number, why: string) => {
      const node = byId.get(id);
      if (!node) return;
      const existing = matches.get(id);
      if (existing) {
        existing.score += score;
        existing.why.push(why);
        if (rankCertainty(certainty) > rankCertainty(existing.certainty)) existing.certainty = certainty;
      } else matches.set(id, { id: id.replace(/^capability:/, ""), node, certainty, score, why: [why] });
    };
    const explicitPaths = new Set([...(input.explicitPaths ?? []), ...repoPaths(input.text)]);
    const explicitModules = new Set(input.explicitModules ?? []);
    for (const explicitPath of explicitPaths) {
      const module = this.moduleFor(explicitPath);
      if (module !== "unmapped") explicitModules.add(module);
      for (const edge of this.graph.edgesTo(pathId(explicitPath), ["spans"])) if (edge.certainty === "exact") add(edge.from_id, "exact", 3, `path ${explicitPath}`);
    }
    for (const module of explicitModules) {
      for (const edge of this.graph.edgesTo(moduleId(module), ["spans"])) if (edge.certainty === "exact") add(edge.from_id, "exact", 2, `module ${module}`);
    }
    const haystack = input.text.normalize("NFKC").toLowerCase();
    for (const capability of capabilities) {
      let score = 0;
      const hits: string[] = [];
      for (const alias of capability.aliases ?? []) {
        if (alias === capability.id.replace(/^capability:/, "")) continue;
        const needle = alias.normalize("NFKC").toLowerCase();
        if (needle.length < 2) continue;
        const found = /^[a-z0-9 ._+-]+$/.test(needle)
          ? new RegExp(`(^|[^a-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "u").test(haystack)
          : haystack.includes(needle);
        if (!found) continue;
        score += /\p{Script=Han}/u.test(needle) ? (needle.length >= 3 ? 1.5 : 1.2) : needle.length >= 4 ? 1.5 : 1;
        hits.push(alias);
      }
      if (score >= 2) add(capability.id, "inferred", score, `aliases ${hits.slice(0, 4).join("、")}`);
      else if (score > 0) add(capability.id, "ambiguous", score, `alias ${hits[0]}`);
    }
    return [...matches.values()]
      .sort((a, b) => rankCertainty(b.certainty) - rankCertainty(a.certainty) || b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, 4);
  }

  async retrieve(query: KnowledgeQuery): Promise<RetrievalResult> {
    if (!/^[0-9a-f]{40}$/u.test(query.repoSha)) throw new Error("KnowledgeQuery.repoSha must be an exact lowercase Git SHA");
    const started = performance.now();
    const rssBefore = process.memoryUsage().rss;
    const text = (query.text ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
    const paths = [...new Set([...(query.paths ?? []), ...repoPaths(text)].map((value) => value.replace(/^\.\//, "")))].sort();
    const inferredLifecycle: RetrievalLifecycle = /(?:\b(?:history|historical|proposal|proposed|superseded|current status)\b|是否现行|提案|历史|以前|当时)/iu.test(text) ? "all" : "current";
    const filters: RetrievalFilters = { lifecycle: inferredLifecycle, ...(query.filters ?? {}) };
    const charLimit = boundedInteger(query.budget?.chars, 7_000, 800, 7_000);
    const rawLimit = boundedInteger(query.budget?.rawCandidates, 80, 8, 200);
    const rankedLimit = boundedInteger(query.budget?.rankedCandidates, 32, 1, 32);
    const collector = query.trace ?? this.ephemeralCollector(query, text, paths);
    const unknown: UnknownReason[] = [];
    const graphSha = String(this.graph.meta().commit ?? "");
    if (graphSha !== query.repoSha) {
      unknown.push({ code: "graph_unavailable" }, { code: "no_grounded_answer" });
      collector.addUnknown({ code: "graph_unavailable" });
      collector.addUnknown({ code: "no_grounded_answer" });
      collector.addIndexAttempt({
        index: {
          id: "graph-exact",
          kind: "graph_exact",
          artifact_sha256: graphDigest(this.graph),
          source_git_sha: /^[0-9a-f]{40}$/u.test(graphSha) ? graphSha : ZERO_GIT_SHA,
          manifest_schema: 2,
          record_schema_version: 2,
          record_count: this.graph.counts().nodes,
          freshness: /^[0-9a-f]{40}$/u.test(graphSha) ? "stale" : "unavailable",
        },
        status: "rejected",
        latency_ms: performance.now() - started,
        error_code: "graph_unavailable",
        hits: [],
      });
      const assembly = assembleContextPack([], unknown, charLimit);
      collector.setBudget({ limit_chars: charLimit, used_chars: assembly.chars, dropped_records: assembly.dropped });
      collector.setPerformance({ total_ms: performance.now() - started, rss_delta_bytes: process.memoryUsage().rss - rssBefore });
      return { ranked: [], slots: assembly.slots, unknown, text: assembly.text, chars: assembly.chars, trace: collector.miss(), classifications: [] };
    }
    const classifications = await this.classify({ text, explicitPaths: paths });
    classifications.forEach((match) => collector.addClassification({
      dimension: "capability",
      value: match.id,
      certainty: match.certainty,
      score: Math.max(0, match.score),
      reason_codes: match.why.some((why) => why.startsWith("path") || why.startsWith("module")) ? ["explicit_path"] : ["alias"],
    }));
    paths.slice(0, 40).forEach((value) => collector.addClassification({ dimension: "path", value, certainty: "exact", score: 1, reason_codes: ["explicit_path"] }));
    if (query.symbol) collector.addClassification({ dimension: "symbol", value: query.symbol.qualifiedName, certainty: "exact", score: 1, reason_codes: ["explicit_typed"] });
    const typedClassifications: Array<[
      ClassificationAudit["dimension"],
      readonly string[] | undefined,
    ]> = [
      ["provider", filters.providers],
      ["launch_mode", filters.launchModes],
      ["state", filters.states],
      ["action", filters.actions],
    ];
    for (const [dimension, values] of typedClassifications) {
      for (const value of values?.slice(0, 4) ?? []) {
        collector.addClassification({ dimension, value, certainty: "exact", score: 1, reason_codes: ["explicit_typed"] });
      }
    }

    const candidates = new Map<string, CandidateWork>();
    const add = (node: KnowledgeNode, values: Partial<Omit<CandidateWork, "node" | "slot">>) => {
      const existing = candidates.get(node.id);
      if (existing) {
        existing.exact ||= values.exact ?? false;
        existing.expanded ||= values.expanded ?? false;
        existing.exactLineage ||= values.exactLineage ?? values.exact ?? false;
        existing.referent ||= values.referent ?? false;
        existing.referentLineage ||= values.referentLineage ?? false;
        existing.directSimilarity ||= values.directSimilarity ?? false;
        existing.inferredSubject ||= values.inferredSubject ?? false;
        existing.expansionScore = Math.max(existing.expansionScore, values.expansionScore ?? 0);
        for (const signal of values.signals ?? []) if (!existing.signals.some((item) => item.index === signal.index)) existing.signals.push(signal);
        if (!existing.edgePath.length && values.edgePath?.length) existing.edgePath = [...values.edgePath];
        return;
      }
      candidates.set(node.id, {
        node,
        signals: [...(values.signals ?? [])],
        exact: values.exact ?? false,
        expanded: values.expanded ?? false,
        exactLineage: values.exactLineage ?? values.exact ?? false,
        referent: values.referent ?? false,
        referentLineage: values.referentLineage ?? false,
        directSimilarity: values.directSimilarity ?? false,
        inferredSubject: values.inferredSubject ?? false,
        expansionScore: values.expansionScore ?? 0,
        edgePath: [...(values.edgePath ?? [])],
        slot: slotForNode(node),
      });
    };

    let exactRank = 0;
    const exact = (node: KnowledgeNode | null, referent = true) => {
      if (!node) return;
      exactRank += 1;
      add(node, { exact: true, referent, signals: [{ index: "graph-exact", rank: exactRank, rawScore: 1, rrfContribution: 2 / (RRF_K + exactRank) }] });
    };
    // Explicit path leaves are the narrowest exact seeds. Expand them before
    // broad capability/module ancestors so a high-degree seed cannot exhaust
    // the bounded expansion set and hide the landing that touched the file.
    for (const explicitPath of paths) {
      const ancestry = ancestors(explicitPath);
      const leaf = ancestry.at(-1);
      if (leaf) exact(this.graph.node(pathId(leaf)));
      const module = this.moduleFor(explicitPath);
      if (module !== "unmapped") exact(this.graph.node(moduleId(module)));
      // Ancestor directories are structural context; "packages/" touches the
      // whole repository and must not grant referent lineage to all of it.
      for (const ancestor of ancestry.slice(0, -1).reverse()) exact(this.graph.node(pathId(ancestor)), false);
    }
    classifications.forEach((match, index) => {
      // Classified capabilities are inferred subjects, not literal referents:
      // their neighborhoods must not outrank lineage of what the query named.
      if (match.certainty === "exact") exact(match.node, false);
      else add(match.node, {
        directSimilarity: true,
        inferredSubject: match.certainty === "inferred",
        exactLineage: match.certainty === "inferred",
        signals: [{
          index: "classification",
          rank: index + 1,
          rawScore: match.score,
          // Inferred/ambiguous classifier hints are weak evidence: they must
          // not outrank genuine index hits or flood expansion with their
          // high-degree neighborhoods.
          rrfContribution: (match.certainty === "inferred" ? 0.7 : 0.15) / (RRF_K + index + 1),
        }],
      });
    });
    for (const capability of filters.capabilities ?? []) exact(this.graph.node(capability.startsWith("capability:") ? capability : capabilityId(capability)));
    const typedDimensions: Array<[readonly string[] | undefined, keyof Pick<ContractCell, "provider" | "launch_mode" | "state" | "action">]> = [
      [filters.providers, "provider"],
      [filters.launchModes, "launch_mode"],
      [filters.states, "state"],
      [filters.actions, "action"],
    ];
    if (typedDimensions.some(([values]) => values?.length)) {
      for (const cell of this.graph.contractCells()) {
        if (!typedDimensions.every(([values, key]) => !values?.length || values.includes(cell[key]))) continue;
        exact(this.graph.node(cell.contract_id));
        exact(this.graph.node(cell.id));
        exact(this.graph.node(cell.scenario_id));
        if (cell.exception_id) exact(this.graph.node(cell.exception_id));
      }
    }
    if (query.inputRef) {
      exact(this.graph.node(query.inputRef));
      for (const source of this.graph.nodesByKind("source")) {
        const coordinate = String(source.metadata?.coordinate ?? source.metadata?.ref ?? "");
        if (coordinate === query.inputRef || source.source_ref === query.inputRef) exact(source);
      }
    }
    // An explicit ticket reference in the text ("#328", "工单328", "ticket:328")
    // names a record, exactly like an input_ref; it must not depend on the
    // similarity indexes to surface.
    for (const referenced of text.matchAll(/(?:#|工单\s*|\bticket[\s:#]\s*)(\d{1,6})\b/giu)) {
      exact(this.graph.node(`ticket:${referenced[1]}`));
      exact(this.graph.node(`source:ticket:${referenced[1]}`));
    }
    const unknownBeforeCode = unknown.length;
    this.addCodeEvidence(query, exact, add, unknown);
    for (const reason of unknown.slice(unknownBeforeCode)) collector.addUnknown({ code: reason.code, ...(reason.slot ? { slot: reason.slot } : {}) });
    collector.addIndexAttempt({
      index: {
        id: "graph-exact",
        kind: "graph_exact",
        artifact_sha256: graphDigest(this.graph),
        source_git_sha: query.repoSha,
        manifest_schema: 2,
        record_schema_version: 2,
        record_count: this.graph.counts().nodes,
        freshness: "exact",
      },
      status: "ok",
      latency_ms: performance.now() - started,
      hits: [...candidates.values()]
        .filter((candidate) => candidate.exact)
        .slice(0, 20)
        .map((candidate, index) => ({ record_id: candidate.node.id, rank: index + 1, raw_score: 1 })),
    });

    const searchText = text || [query.inputRef ?? "", ...paths, query.symbol?.qualifiedName ?? ""].filter(Boolean).join(" ");
    const similarity = searchText
      ? await this.similarity.search({ text: searchText, filters, limit: rawLimit, signal: query.signal })
      : { hits: [], attempts: [], failures: [] };
    for (const attempt of similarity.attempts) collector.addIndexAttempt(this.indexAudit(attempt, query.repoSha));
    for (const failure of similarity.failures) {
      const code: RetrievalMissCode = failure.index.includes("vector") ? "vector_unavailable" : "index_failed";
      unknown.push({ code, index: failure.index });
      collector.addUnknown({ code });
    }
    if (searchText && !this.similarity.names.some((name) => name.includes("vector"))) {
      unknown.push({ code: "vector_unavailable", index: "vector" });
      collector.addUnknown({ code: "vector_unavailable" });
    }
    for (const hit of similarity.hits) {
      const node = this.graph.node(hit.id);
      if (node) add(node, { directSimilarity: true, signals: hit.signals });
    }
    similarity.hits.filter((hit) => hit.id.startsWith("capability:")).slice(0, 4).forEach((hit) => {
      if (classifications.some((item) => item.node.id === hit.id)) return;
      const node = this.graph.node(hit.id);
      if (!node) return;
      classifications.push({ id: hit.id.replace(/^capability:/, ""), node, certainty: "ambiguous", score: hit.score, why: ["similarity"] });
    });

    this.expandCandidates(candidates, rawLimit);
    const requestedSlots: readonly ContextSlot[] = filters.slots?.length
      ? filters.slots
      : ["contract_principle", "scenarios", "sources_requirements", "decisions_exceptions", "actions_symbols", "tests_evidence", "landings_patterns", "unknown_conflicts"];
    const allRanked = this.rankCandidates([...candidates.values()], query, filters);
    // Slot-diverse top window: every available requested slot gets its best
    // candidate inside the graded top 10, then global order fills the rest.
    // Within-slot and global relevance orders are both preserved.
    const windowSize = Math.min(10, rankedLimit);
    const windowIds = new Set<string>();
    for (const slot of requestedSlots) {
      if (windowIds.size >= windowSize) break;
      const best = allRanked.find((value) => value.slot === slot);
      if (best) windowIds.add(best.id);
    }
    for (const candidate of allRanked) {
      if (windowIds.size >= windowSize) break;
      windowIds.add(candidate.id);
    }
    const window = allRanked.filter((candidate) => windowIds.has(candidate.id));
    const tail = allRanked.filter((candidate) => !windowIds.has(candidate.id));
    const ranked = [...window, ...tail].slice(0, rankedLimit);
    if (!ranked.length) {
      unknown.push({ code: "no_grounded_answer" });
      collector.addUnknown({ code: "no_grounded_answer" });
    }
    for (const [rank, candidate] of ranked.entries()) collector.addCandidate(this.candidateAudit(candidate, rank + 1));
    let assembly = assembleContextPack(ranked, unknown, charLimit);
    if (ranked.length) {
      for (const slot of requestedSlots) {
        if (unknown.length >= 8) break;
        if (assembly.slots[slot].length) continue;
        const reason: UnknownReason = { code: "missing_slot", slot };
        if (!unknown.some((item) => item.code === reason.code && item.slot === reason.slot)) {
          unknown.push(reason);
          collector.addUnknown({ code: reason.code, slot: reason.slot });
        }
      }
      assembly = assembleContextPack(ranked, unknown, charLimit);
    }
    // The trace audits delivered LINES: a governing document folds many records
    // into one reference, and the schema bounds how many rows a trace may hold.
    for (const slot of Object.keys(assembly.delivered) as ContextSlot[]) {
      assembly.delivered[slot].forEach((candidate, ordinal) => {
        const candidateRank = ranked.findIndex((item) => item.id === candidate.id) + 1;
        collector.addSlot({
          slot,
          ordinal: ordinal + 1,
          record_id: candidate.id,
          candidate_rank: candidateRank,
          final_score: candidate.finalScore,
          chars: candidate.node.statement.length,
          reason_codes: [candidate.grounding],
        });
      });
    }
    collector.setBudget({ limit_chars: charLimit, used_chars: assembly.chars, dropped_records: assembly.dropped });
    collector.setPerformance({ total_ms: performance.now() - started, rss_delta_bytes: process.memoryUsage().rss - rssBefore });
    const trace = ranked.length ? collector.assemble() : collector.miss();
    return { ranked, slots: assembly.slots, unknown, text: assembly.text, chars: assembly.chars, trace, classifications: classifications.slice(0, 4) };
  }

  private ephemeralCollector(query: KnowledgeQuery, text: string, paths: readonly string[]): RetrievalTraceCollector {
    const rawInputRef = query.inputRef ?? "";
    const ticket = /^ticket:([1-9]\d*)$/u.exec(rawInputRef);
    const envelope = createRetrievalTraceEnvelope({
      lane: ticket ? "ticket" : "cli",
      purpose: paths.length || query.symbol ? "path_refinement" : "startup",
      subject_ref: ticket ? `ticket:${Number(ticket[1])}` : "cli-scope:knowledge",
      query: text || [rawInputRef, ...paths, query.symbol?.qualifiedName ?? ""].filter(Boolean).join(" "),
      repo_sha: query.repoSha,
      graph_input_fingerprint: graphDigest(this.graph),
      code_index_sha: query.codeIndexSha ?? this.codeIndex?.gitSha,
    }, TRACE_KEY);
    return new RetrievalTraceCollector(envelope);
  }

  private addCodeEvidence(
    query: KnowledgeQuery,
    exact: (node: KnowledgeNode | null) => void,
    add: (node: KnowledgeNode, values: Partial<Omit<CandidateWork, "node" | "slot">>) => void,
    unknown: UnknownReason[],
  ): void {
    if (!query.symbol) return;
    const selector = { path: query.symbol.path, qualifiedName: query.symbol.qualifiedName };
    // A stale code index cannot prove code evidence, but the exact-SHA graph
    // selector remains a safe internal seed for adjacent design obligations.
    for (const artifact of this.graph.nodesByKind("artifact")) {
      const metadata = artifact.metadata ?? {};
      const pathMatches = !selector.path || metadata.path === selector.path;
      const name = metadata.qualified_name ?? metadata.qualifiedName ?? metadata.symbol;
      if (pathMatches && name === selector.qualifiedName) exact(artifact);
    }
    const indexSha = query.codeIndexSha ?? this.codeIndex?.gitSha;
    if (!indexSha || indexSha !== query.repoSha || (this.codeIndex && this.codeIndex.gitSha !== query.repoSha)) {
      unknown.push({ code: "code_index_stale", slot: "actions_symbols" });
      return;
    }
    if (!this.codeIndex) {
      unknown.push({ code: "code_index_stale", slot: "actions_symbols" });
      return;
    }
    const definitions = this.codeIndex.definitions({ repoSha: query.repoSha, symbol: selector, limit: 8 });
    const tests = this.codeIndex.testsForSymbol({ repoSha: query.repoSha, symbol: selector, limit: 8 });
    if (definitions.status === "stale_code_index" || tests.status === "stale_code_index") {
      unknown.push({ code: "code_index_stale", slot: "actions_symbols" });
      return;
    }
    // Raw index rows are supporting evidence, not query referents: they rank
    // by a bounded code-index signal instead of crowding the exact band.
    const evidence = (node: KnowledgeNode, rank: number) => add(node, {
      directSimilarity: true,
      signals: [{ index: "code-index", rank, rawScore: 1, rrfContribution: 1 / (RRF_K + rank) }],
    });
    definitions.items.forEach((definition, index) => evidence(this.codeSymbolNode(definition, query.repoSha), index + 1));
    tests.items.forEach((test, index) => evidence(this.testReferenceNode(test, query.repoSha), index + 1));
  }

  private codeSymbolNode(symbol: CodeSymbol, repoSha: string): KnowledgeNode {
    return {
      id: `artifact:code/symbol/${createHash("sha256").update(`${symbol.definition.path}\0${symbol.qualifiedName}`).digest("hex").slice(0, 32)}`,
      kind: "artifact",
      statement: `${symbol.qualifiedName} — ${symbol.definition.path}:${symbol.definition.line + 1}`.slice(0, 400),
      status: "active",
      authority: "derived",
      source_ref: symbol.definition.path,
      source_sha: repoSha,
      method: "git",
      certainty: "exact",
      metadata: { artifact_role: "symbol", path: symbol.definition.path, qualified_name: symbol.qualifiedName },
    };
  }

  private testReferenceNode(test: StaticTestReference, repoSha: string): KnowledgeNode {
    return {
      id: `artifact:code/test/${createHash("sha256").update(`${test.path}\0${test.line}\0${test.target.qualifiedName}`).digest("hex").slice(0, 32)}`,
      kind: "artifact",
      statement: `${test.path}:${test.line + 1} statically references ${test.target.qualifiedName}`.slice(0, 400),
      status: "active",
      authority: "derived",
      source_ref: test.path,
      source_sha: repoSha,
      method: "git",
      certainty: "exact",
      metadata: { artifact_role: "test", path: test.path, qualified_name: test.target.qualifiedName },
    };
  }

  private expandCandidates(candidates: Map<string, CandidateWork>, rawLimit: number): void {
    const priority = (a: CandidateWork, b: CandidateWork) =>
      Number(b.exact) - Number(a.exact)
      || Number(b.exactLineage) - Number(a.exactLineage)
      || (b.signals.reduce((sum, signal) => sum + signal.rrfContribution, 0) + b.expansionScore) - (a.signals.reduce((sum, signal) => sum + signal.rrfContribution, 0) + a.expansionScore)
      || a.node.id.localeCompare(b.node.id);
    let frontier = [...candidates.values()].sort(priority).slice(0, rawLimit);
    const traversed = new Set<string>();
    for (let depth = 0; depth < 2; depth += 1) {
      const next: CandidateWork[] = [];
      const nextIds = new Set<string>();
      for (const origin of frontier) {
        if (traversed.has(origin.node.id)) continue;
        traversed.add(origin.node.id);
        const outgoing = this.graph.edgesFrom(origin.node.id);
        const incoming = this.graph.edgesTo(origin.node.id);
        for (const [edge, forward] of [...outgoing.map((value) => [value, true] as const), ...incoming.map((value) => [value, false] as const)]) {
          const from = this.graph.node(edge.from_id);
          const to = this.graph.node(edge.to_id);
          if (!from || !to || !relationAllowed(edge, from, to)) continue;
          const target = forward ? to : from;
          const hop = { from: edge.from_id, relation: edge.relation, to: edge.to_id };
          const exactLineage = origin.exact || origin.exactLineage;
          const referentLineage = (origin.exact && origin.referent) || origin.referentLineage;
          const inheritedScore = (origin.signals.reduce((sum, signal) => sum + signal.rrfContribution, 0) + origin.expansionScore) * 0.35;
          const existing = candidates.get(target.id);
          if (existing) {
            existing.expanded = true;
            existing.exactLineage ||= exactLineage;
            existing.referentLineage ||= referentLineage;
            existing.expansionScore = Math.max(existing.expansionScore, inheritedScore);
            if (!existing.edgePath.length) existing.edgePath = [...origin.edgePath, hop].slice(0, 2);
            if (!traversed.has(existing.node.id) && !nextIds.has(existing.node.id)) {
              next.push(existing);
              nextIds.add(existing.node.id);
            }
            continue;
          }
          const expanded: CandidateWork = {
            node: target,
            signals: [],
            exact: false,
            expanded: true,
            exactLineage,
            referent: false,
            referentLineage,
            directSimilarity: false,
            inferredSubject: false,
            expansionScore: inheritedScore,
            edgePath: [...origin.edgePath, hop].slice(0, 2),
            slot: slotForNode(target),
          };
          candidates.set(target.id, expanded);
          next.push(expanded);
          nextIds.add(expanded.node.id);
        }
      }
      frontier = next.sort(priority).slice(0, rawLimit);
      if (!frontier.length) break;
    }
  }

  private matchesCapabilities(node: KnowledgeNode, wanted: readonly string[]): boolean {
    let membership = this.capabilityMembership.get(node.id);
    if (!membership) {
      const capabilities = new Set<string>();
      const seen = new Set<string>();
      let frontier = [node];
      for (let depth = 0; depth <= 2 && frontier.length; depth += 1) {
        const next: KnowledgeNode[] = [];
        for (const current of frontier) {
          if (seen.has(current.id)) continue;
          seen.add(current.id);
          if (current.kind === "capability") capabilities.add(current.id.replace(/^capability:/, ""));
          for (const value of metadataValues(current, ["capability", "capabilities"])) capabilities.add(value.replace(/^capability:/, ""));
          const contract = current.metadata?.contract;
          if (typeof contract === "string") {
            const contractNode = this.graph.node(contract);
            if (contractNode) for (const value of metadataValues(contractNode, ["capability", "capabilities"])) capabilities.add(value.replace(/^capability:/, ""));
          }
          if (depth === 2) continue;
          const adjacent = [
            ...this.graph.edgesFrom(current.id).map((edge) => ({ edge, target: this.graph.node(edge.to_id) })),
            ...this.graph.edgesTo(current.id).map((edge) => ({ edge, target: this.graph.node(edge.from_id) })),
          ];
          for (const { edge, target } of adjacent) {
            const from = this.graph.node(edge.from_id);
            const to = this.graph.node(edge.to_id);
            if (target && from && to && relationAllowed(edge, from, to) && !seen.has(target.id)) next.push(target);
          }
        }
        frontier = next.sort((a, b) => a.id.localeCompare(b.id));
      }
      membership = capabilities;
      this.capabilityMembership.set(node.id, membership);
    }
    return wanted.some((value) => membership!.has(value.replace(/^capability:/, "")));
  }

  private rankCandidates(work: CandidateWork[], query: KnowledgeQuery, filters: RetrievalFilters): RankedCandidate[] {
    const codeFresh = !query.codeIndexSha || query.codeIndexSha === query.repoSha;
    // Per-slot lineage quota: the two most relevant records that a true query
    // referent reaches over allowlisted typed edges represent the contract's
    // own structure in their slot; an unbounded band would bury direct hits.
    const lineageQuota = new Map<ContextSlot, number>();
    const banded = new Set<string>();
    const recency = (candidate: CandidateWork): string => {
      const meta = candidate.node.metadata ?? {};
      if (typeof meta.landed_at === "string") return meta.landed_at;
      const landingRef = typeof meta.landing === "string" ? meta.landing : "";
      const landedAt = landingRef ? this.graph.node(landingRef)?.metadata?.landed_at : undefined;
      return typeof landedAt === "string" ? landedAt : "";
    };
    // With no query text every relevance number is seed plumbing, not
    // evidence: the referent's own structure and recency are the only honest
    // ordering signals for a bare path/ref lookup.
    const textual = (query.text ?? "").trim().length > 0;
    // Product labels occur in almost every neighboring summary and cannot
    // establish the intent of a concrete path refinement on their own.
    const scopeLabels = new Set(["session","sessions","plus","agent","agents","octopus"]);
    const intentTerms = queryTerms(query.text ?? "").filter(term => !scopeLabels.has(term));
    const bandRelevance = (candidate: CandidateWork): number =>
      candidate.signals.reduce((sum, signal) => sum + signal.rrfContribution, 0) + candidate.expansionScore;
    for (const candidate of [...work]
      .filter((value) => value.exactLineage && !value.exact)
      .sort((a, b) => Number(b.referentLineage) - Number(a.referentLineage)
        || (textual
          ? bandRelevance(b) - bandRelevance(a) || recency(b).localeCompare(recency(a))
          : recency(b).localeCompare(recency(a)) || bandRelevance(b) - bandRelevance(a))
        || a.node.id.localeCompare(b.node.id))) {
      const used = lineageQuota.get(candidate.slot) ?? 0;
      if (used >= 2) continue;
      lineageQuota.set(candidate.slot, used + 1);
      banded.add(candidate.node.id);
    }
    const ranked = work
      .filter((candidate) => {
        const lifecycle = filters.lifecycle ?? "current";
        if (candidate.node.authority === "always_on") return false;
        // A broad module/capability neighborhood is not evidence that an old
        // narrative answers a concrete path + question. Preserve direct index
        // hits, explicit references and authored path links; empty slots are OK.
        if (textual && query.paths?.length && ["requirement","decision","non_goal","risk"].includes(candidate.node.kind)
          && !candidate.exact
          && candidate.edgePath.some(hop => [hop.from,hop.to].some(id => /^(?:module|capability):/u.test(id)))
          && (!candidate.directSimilarity || (intentTerms.length > 0 && relevance(candidate.node.statement,intentTerms) === 0))) return false;
        if (filters.kinds?.length && !filters.kinds.includes(candidate.node.kind)) return false;
        if (!lifecycleStatuses(lifecycle).includes(candidate.node.status)) return false;
        if (!scopedExceptionMatches(this.graph, candidate.node, filters)) return false;
        if (!dimensionsCompatible(candidate.node, filters)) return false;
        if (filters.capabilities?.length && !this.matchesCapabilities(candidate.node, filters.capabilities)) return false;
        const resultSlot = ["superseded", "historical", "rejected"].includes(candidate.node.status) ? "unknown_conflicts" : candidate.slot;
        if (!codeFresh && (resultSlot === "actions_symbols" || resultSlot === "tests_evidence") && candidate.node.kind === "artifact") return false;
        if (candidate.node.kind === "artifact" && (resultSlot === "actions_symbols" || resultSlot === "tests_evidence")) {
          const resolved = candidate.node.metadata?.resolved;
          const artifactCodeSha = candidate.node.metadata?.code_index_sha;
          if (resolved === false || (typeof artifactCodeSha === "string" && artifactCodeSha !== query.repoSha)) return false;
        }
        if (filters.slots?.length && !filters.slots.includes(resultSlot)) return false;
        return true;
      })
      .map((candidate) => {
        let slot = candidate.slot;
        if (["superseded", "historical", "rejected"].includes(candidate.node.status)) slot = "unknown_conflicts";
        const candidateGrounding = grounding(candidate);
        // Structural hubs (capabilities, modules, paths, zones, flows) touch
        // large neighborhoods; counting inherited neighbor relevance toward
        // their own rank would sort them by degree rather than by the query.
        // They still relay full inherited relevance to their expansions.
        const structural = ["capability", "module", "path", "zone", "flow"].includes(candidate.node.kind);
        const rrfScore = candidate.signals.reduce((sum, signal) => sum + signal.rrfContribution, 0) + (structural ? 0 : candidate.expansionScore);
        const replacement = this.graph.edgesFrom(candidate.node.id, ["supersedes"]).some((edge) => edge.certainty === "exact") ? 1
          : this.graph.edgesTo(candidate.node.id, ["supersedes"]).some((edge) => edge.certainty === "exact") ? -1 : 0;
        const dimensions = dimensionMatches(candidate.node, filters);
        // Relevance-dominant ordering: explicit query referents form the top
        // band, fused similarity (direct signals plus hop-attenuated lineage)
        // decides the rest, and the typed constants only break near-ties.
        const rerank = [
          { feature: "exact_seed", contribution: candidate.exact ? 1_000 : 0 },
          { feature: "inferred_subject", contribution: candidate.inferredSubject ? 400 : 0 },
          // Records reached from true query referents over allowlisted typed
          // edges are the contract's own structure; they outrank the open
          // similarity pool and stay ordered by relevance within the band.
          { feature: "exact_lineage", contribution: banded.has(candidate.node.id) ? (candidate.edgePath.length > 1 ? 150 : 300) : 0 },
          { feature: "relevance", contribution: rrfScore * 10_000 },
          { feature: "lifecycle", contribution: lifecycleRank(candidate.node.status) * 0.4 },
          { feature: "replacement", contribution: replacement * 1.0 },
          { feature: "grounding", contribution: candidateGrounding === "hybrid" ? 0.5 : candidate.directSimilarity ? 0.3 : 0 },
          { feature: "slot_fit", contribution: slot === "unknown_conflicts" ? 0 : 0.2 },
          { feature: "typed_dimensions", contribution: dimensions * 0.3 },
          { feature: "human_evidence", contribution: STRENGTH_RANK[knowledgeStrength(candidate.node)] * 0.8 },
          { feature: "authority", contribution: AUTHORITY_RANK[candidate.node.authority] * 0.15 },
          { feature: "certainty", contribution: rankCertainty(candidate.node.certainty) * 0.1 },
        ];
        const finalScore = rerank.reduce((sum, item) => sum + item.contribution, 0);
        return { id: candidate.node.id, node: candidate.node, slot, grounding: candidateGrounding, signals: candidate.signals, edgePath: candidate.edgePath, rrfScore, finalScore, rerank } satisfies RankedCandidate;
      });
    return ranked.sort((a, b) => b.finalScore - a.finalScore || a.id.localeCompare(b.id));
  }

  private indexAudit(trace: SimilarityAttemptTrace, repoSha: string): IndexAttemptAudit {
    return {
      index: {
        id: trace.index,
        kind: trace.kind,
        artifact_sha256: trace.artifactSha256,
        source_git_sha: /^[0-9a-f]{40}$/u.test(trace.sourceGitSha) ? trace.sourceGitSha : repoSha,
        manifest_schema: 1,
        record_schema_version: 1,
        record_count: trace.recordCount,
        freshness: trace.sourceGitSha === repoSha ? "exact" : trace.sourceGitSha === ZERO_GIT_SHA ? "unavailable" : "stale",
        ...(trace.embedding ? { embedding: {
          provider: trace.embedding.provider,
          model_id: trace.embedding.modelId,
          immutable_revision: trace.embedding.immutableRevision,
          dimensions: trace.embedding.dimensions,
          dtype: "float32",
          normalized: true,
          distance: "cosine",
        } as const } : {}),
      },
      status: trace.status,
      latency_ms: trace.latencyMs,
      ...(trace.errorCode ? { error_code: trace.errorCode } : {}),
      hits: trace.hits.slice(0, 20).map((hit) => ({ record_id: hit.id, rank: hit.rank, raw_score: hit.score })),
    };
  }

  private candidateAudit(candidate: RankedCandidate, rank: number): CandidateAudit {
    return {
      record_id: candidate.id,
      kind: candidate.node.kind,
      source_ref: candidate.node.source_ref,
      source_sha: candidate.node.source_sha,
      fused_rank: rank,
      fused_score: candidate.rrfScore,
      signals: candidate.signals.map((signal) => ({ index_id: signal.index, rank: signal.rank, raw_score: signal.rawScore, rrf_contribution: signal.rrfContribution })),
      ...(candidate.edgePath.length ? { allowed_edge_path: [...candidate.edgePath] } : {}),
      rerank: [...candidate.rerank],
    };
  }

  /** Exact submit/legacy structural helper; retrieval callers use retrieve(). */
  expandFromPaths(paths: readonly string[], options: { landings?: number; seedCapabilities?: readonly string[] } = {}): Expansion {
    const via = new Map<string, Set<string>>();
    const note = (id: string, how: string) => {
      const existing = via.get(id);
      if (existing) existing.add(how);
      else via.set(id, new Set([how]));
    };
    const moduleIds = new Set<string>();
    const targetIds = new Set<string>();
    const unmappedPaths: string[] = [];
    for (const explicitPath of paths) {
      const module = this.moduleFor(explicitPath);
      if (module === "unmapped") unmappedPaths.push(explicitPath);
      else moduleIds.add(moduleId(module));
      for (const ancestor of ancestors(explicitPath)) targetIds.add(pathId(ancestor));
    }
    const modules = this.graph.nodes([...moduleIds]);
    modules.forEach((module) => targetIds.add(module.id));
    const existingTargets = new Set(this.graph.nodes([...targetIds]).map((node) => node.id));
    const buckets: Record<string, Map<string, KnowledgeNode>> = Object.fromEntries([
      "principle", "constraint", "decision", "non_goal", "requirement", "risk", "landing", "pattern", "capability", "evidence",
    ].map((kind) => [kind, new Map<string, KnowledgeNode>()]));
    const collect = (target: string, relations: readonly Relation[]) => {
      for (const edge of this.graph.edgesTo(target, relations).filter((value) => value.certainty === "exact")) {
        const node = this.graph.node(edge.from_id);
        const bucket = node ? buckets[node.kind] : undefined;
        if (!node || !bucket) continue;
        bucket.set(node.id, node);
        note(node.id, target);
      }
    };
    for (const target of existingTargets) collect(target, ["governs", "constrains", "realizes", "bounds", "touches", "guards", "spans"]);
    const seeds = new Set((options.seedCapabilities ?? []).map((id) => id.startsWith("capability:") ? id : capabilityId(id)));
    for (const seed of seeds) {
      const node = this.graph.node(seed);
      if (node) buckets.capability.set(node.id, node);
      collect(seed, ["about", "governs", "bounds", "defines", "contract_for"]);
      for (const edge of this.graph.edgesFrom(seed, ["constrained_by"]).filter((value) => value.certainty === "exact")) {
        const constraint = this.graph.node(edge.to_id);
        if (constraint) buckets.constraint.set(constraint.id, constraint);
      }
    }
    const active = (bucket: Map<string, KnowledgeNode>, history = false) => [...bucket.values()]
      .filter((node) => node.status === "active" || (history && node.status === "historical"))
      .sort((a, b) => AUTHORITY_RANK[b.authority] - AUTHORITY_RANK[a.authority] || rankCertainty(b.certainty) - rankCertainty(a.certainty) || sourceOrder(a, b));
    return {
      modules,
      capabilities: active(buckets.capability),
      principles: active(buckets.principle),
      constraints: active(buckets.constraint),
      decisions: active(buckets.decision),
      nonGoals: active(buckets.non_goal, true),
      requirements: active(buckets.requirement),
      risks: active(buckets.risk, true),
      landings: [...buckets.landing.values()].sort((a, b) => (b.valid_from ?? "").localeCompare(a.valid_from ?? "") || a.id.localeCompare(b.id)).slice(0, options.landings ?? 5),
      patterns: active(buckets.pattern),
      evidence: active(buckets.evidence),
      via,
      unmappedPaths,
    };
  }

  expandFromCapabilities(ids: readonly string[]): Expansion {
    const capabilities = ids.map((id) => id.startsWith("capability:") ? id : capabilityId(id));
    const paths = new Set<string>();
    for (const id of capabilities) {
      const node = this.graph.node(id);
      for (const explicitPath of (node?.metadata?.paths as string[] | undefined) ?? []) paths.add(explicitPath);
      for (const module of (node?.metadata?.modules as string[] | undefined) ?? []) {
        const definition = this.modules().find((item) => item.id === module);
        for (const prefix of definition?.pathPrefixes ?? []) paths.add(`${prefix.replace(/\/$/, "")}/`);
      }
    }
    return this.expandFromPaths([...paths], { seedCapabilities: capabilities });
  }

  async searchStatements(text: string, kinds: readonly NodeKind[], limit: number): Promise<KnowledgeNode[]> {
    const repoSha = String(this.graph.meta().commit ?? "");
    if (!/^[0-9a-f]{40}$/u.test(repoSha)) return [];
    const result = await this.retrieve({ text, repoSha, filters: { kinds, lifecycle: "all" }, budget: { chars: 7_000, rawCandidates: Math.max(20, limit * 2), rankedCandidates: Math.min(limit, 32) } });
    return result.ranked.slice(0, limit).map((candidate) => candidate.node);
  }
}

export function rank(certainty: Certainty): number {
  return rankCertainty(certainty);
}

export function relevance(text: string, terms: readonly string[]): number {
  const haystack = text.normalize("NFKC").toLowerCase();
  let hits = 0;
  for (const term of terms) if (haystack.includes(term)) hits += 1;
  return hits;
}

export function queryTerms(text: string, top = 60): string[] {
  const expression = matchExpression(text, top);
  return expression ? expression.split(" OR ").map((term) => term.slice(1, -1).replaceAll('""', '"')) : [];
}

export function ancestors(value: string): string[] {
  const path = value.replace(/\/+$/, "");
  const parts = path.split("/");
  const output: string[] = [];
  for (let index = 1; index < parts.length; index += 1) output.push(`${parts.slice(0, index).join("/")}/`);
  output.push(value.endsWith("/") ? value : path);
  return output;
}
