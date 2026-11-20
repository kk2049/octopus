import { parseRepairIdentity, repairFingerprint } from "../knowledge/repairs.js";
import { parseKnowledgeChanges } from "../knowledge/changes.js";
/**
 * `/knowledge` — the human-facing projection of the development knowledge
 * graph (`packages/bot/src/knowledge`), plus the one piece of runtime state a
 * human adds to it: review decisions on conflict candidates and ambiguous
 * records.
 *
 * ── What this service is ────────────────────────────────────────────────────
 *
 * A read-only view over `<dataDir>/knowledge/graph.db`, the derived graph the
 * dev pipeline rebuilds at startup and after every landing. Every statement,
 * edge, conflict candidate and coverage row shown on the page is the graph's;
 * this layer groups, counts and orders, and it never invents a fact.
 *
 * ── Human-in-the-loop ───────────────────────────────────────────────────────
 *
 * The graph routes conflicts and ambiguities to people but never resolves
 * them. A reviewer's decision (dismiss as false positive / confirm as real /
 * mark resolved in Git) is recorded in `knowledge_reviews` — runtime state,
 * append-only, keyed by the subject's stable id, so it survives rebuilds and
 * never pretends to be knowledge. Changing the knowledge itself still goes
 * through a ticket or a curated file, exactly like before.
 *
 * ── Sensitivity ─────────────────────────────────────────────────────────────
 *
 * Statements name paths, modules, ticket titles and internal decisions — the
 * same disclosure level as the architecture atlas, and the same audience
 * (`Contribute`). Review decisions are judgement on the shared knowledge and
 * need `UseDev`.
 */

import { conflictFingerprint, STRENGTH_RANK, knowledgeStrength, type KnowledgeProvenance } from "../knowledge/provenance.js";
import { reviewPolicy } from "../knowledge/review-policy.js";
import fs from "node:fs";
import path from "node:path";
import { buildStartupPack, governingDocumentOf } from "../knowledge/context-pack.js";
import { GraphDb } from "../knowledge/graph-db.js";
import { AUTHORITY_RANK, type ConflictCandidate, type CoverageRow, type KnowledgeNode, type NodeKind, type Relation } from "../knowledge/model.js";
import { KnowledgeRetriever, type Expansion } from "../knowledge/retrieval.js";
import type { KnowledgeArtifactHealth } from "../devpipe/knowledge-artifact-service.js";
import type { KnowledgeReviewRow } from "../store/repositories/knowledge.js";
import type {
  KnowledgeRetrievalReviewFilter,
  KnowledgeRetrievalReviewPage,
  KnowledgeRetrievalReviewRow,
  KnowledgeRetrievalTraceDetail,
  KnowledgeRetrievalTraceEventFilter,
  KnowledgeTicketRetrievalPage,
} from "../store/repositories/knowledge-retrieval.js";
import type { Store } from "../store/store.js";

// ── Wire types (the page's reading of the server) ───────────────────────────

export interface WikiStatement {
  id: string;
  kind: NodeKind;
  statement: string;
  status: string;
  authority: string;
  certainty: string;
  realization?: string;
  source_ref: string;
  source_sha: string;
  valid_from?: string;
  valid_to?: string;
  /** Curated/landing extras the page renders when present. */
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
  counts: Record<"principle" | "decision" | "requirement" | "non_goal" | "risk" | "pattern" | "landing" | "constraint", number>;
  /** Statements that point at this capability itself (curated, patterns, ADR). */
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
  /** Concrete graph object both sides are about, when the detector names one. */
  object: WikiStatement | null;
  /** Human explanation of what must be decided; `why` remains detector evidence. */
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

export interface WikiKnowledgeChatContext {
  context: string;
  readOnly: boolean;
  reason?: string;
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
  relation: Relation;
  /** Every neighbour on this relation; the page windows the display, never the wire. */
  nodes: WikiStatement[];
  /** Distinct neighbour ids the edges name (a dangling edge counts, but resolves to no row). */
  total: number;
}

export interface WikiNodeView {
  repair_fingerprint: string;
  history?: Array<{ decision: string; actor: string; at: string; note: string }>;
  node: WikiStatement;
  out: WikiEdgeGroup[];
  in: WikiEdgeGroup[];
  conflicts: WikiConflict[];
}

export interface WikiGraphNode {
  id: string;
  kind: NodeKind;
  statement: string;
  status: string;
  authority: string;
  certainty: string;
  source_ref: string;
}

export interface WikiGraphEdge {
  from_id: string;
  relation: Relation;
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

export const REVIEW_DECISIONS = ["dismissed", "confirmed", "resolved", "reopened"] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export interface KnowledgeWikiServiceOptions {
  dataDir: string;
  store: Pick<Store, "knowledge" | "knowledgeRetrieval"> & Partial<Pick<Store,"knowledgeSources"|"knowledgeRepairs">>;
  replayRepairs?: () => Promise<unknown>;
  artifactHealth?: () => KnowledgeArtifactHealth | null;
}

/*
 * Subject and node views carry their lists whole. A big capability has
 * hundreds of statements, but the relation graph view already ships every node
 * and edge in one response, so a per-subject list is a strict subset of a window
 * this surface already serves; capping it only made the rest unreachable. The
 * page bounds what it RENDERS (a display window with an explicit "show all").
 */
const MAX_PREVIEW_CHARS = 12_000;

/** Tightens a graph node to the wire shape; metadata is whitelisted, never forwarded whole. */
/**
 * A path rule and a package document are all-or-nothing, so the wiki lists the
 * FILE once with a link rather than its bullets: eighty fragments cost a reader
 * the whole column and still could not be obeyed without opening the file. The
 * bullets remain first-class records — they are what a query matches, and the
 * document node view still reaches them.
 */
export function collapseGoverningDocuments(graph: GraphDb, principles: readonly KnowledgeNode[]): KnowledgeNode[] {
  const out: KnowledgeNode[] = [];
  const members = new Map<string, KnowledgeNode[]>();
  const order: string[] = [];
  for (const node of principles) {
    const file = governingDocumentOf(node);
    if (!file) {
      out.push(node);
      continue;
    }
    const group = members.get(file);
    if (group) group.push(node);
    else {
      members.set(file, [node]);
      order.push(file);
    }
  }
  for (const file of order) {
    const group = members.get(file) ?? [];
    const doc = graph.node(`doc:${file}`);
    // Without the document node there is nothing to link to; keep the bullets.
    if (!doc) out.push(...group);
    else out.push({ ...doc, statement: `${file}：整份文档适用（命中 ${group.length} 条）` });
  }
  return out;
}

export function toWire(node: KnowledgeNode): WikiStatement {
  const meta = node.metadata ?? {};
  const list = (value: unknown): string[] | undefined => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined);
  const numbers = (value: unknown): number[] | undefined => (Array.isArray(value) ? value.filter((item): item is number => typeof item === "number") : undefined);
  const text = (value: unknown): string | null | undefined => (typeof value === "string" ? value : value === null ? null : undefined);
  const lifecycle = meta.lifecycle as { source?: string } | undefined;
  const origins = (Array.isArray(meta.origins) ? meta.origins : []).flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    if (!("ticket" in value) || !("requester" in value) || !("role" in value)) return [];
    if (typeof value.ticket !== "number" || !Number.isInteger(value.ticket) || typeof value.requester !== "string") return [];
    if (value.role !== "user_requirement" && value.role !== "task_evolution") return [];
    const actorKind = "actor_kind" in value && typeof value.actor_kind === "string" ? value.actor_kind : undefined;
    return [{ ticket: value.ticket, requester: value.requester, role: value.role, ...(actorKind ? { actor_kind: actorKind } : {}) }];
  });
  return {
    id: node.id,
    kind: node.kind,
    statement: node.statement,
    status: node.status,
    authority: node.authority,
    certainty: node.certainty,
    ...(node.realization ? { realization: node.realization } : {}),
    source_ref: node.source_ref,
    source_sha: node.source_sha,
    ...(node.valid_from ? { valid_from: node.valid_from } : {}),
    ...(node.valid_to ? { valid_to: node.valid_to } : {}),
    detail: {
      strength: knowledgeStrength(node),
      provenance: meta.provenance as KnowledgeProvenance | undefined,
      ticket: typeof meta.ticket === "number" ? meta.ticket : typeof meta.ticket_id === "number" ? meta.ticket_id : null,
      rationale: text(meta.rationale),
      quote: text(meta.quote),
      conflict_note: text(meta.conflict_note),
      mandatory_facts: list(meta.mandatory_facts),
      tickets: numbers(meta.tickets),
      commands: list(meta.commands),
      zone: typeof meta.zone === "string" ? meta.zone : undefined,
      trust: typeof meta.trust === "string" ? meta.trust : undefined,
      criticality: typeof meta.criticality === "string" ? meta.criticality : undefined,
      modules: list(meta.modules),
      docs: list(meta.docs),
      aliases: node.aliases,
      summary: typeof meta.summary === "string" ? meta.summary : undefined,
      lane: typeof meta.lane === "string" ? meta.lane : undefined,
      to_sha: typeof meta.to_sha === "string" ? meta.to_sha : undefined,
      introduced: typeof meta.introduced === "string" ? meta.introduced : undefined,
      superseded_by: text(meta.superseded_by),
      merged_from: list(meta.merged_from),
      global: meta.global === true ? true : undefined,
      lifecycle_source: lifecycle?.source,
      origins: origins.length ? origins : undefined,
    },
  };
}

function byAuthorityThenTime(a: KnowledgeNode, b: KnowledgeNode): number {
  return (
    STRENGTH_RANK[knowledgeStrength(b)] - STRENGTH_RANK[knowledgeStrength(a)]
    || AUTHORITY_RANK[b.authority] - AUTHORITY_RANK[a.authority]
    || (b.valid_from ?? "").localeCompare(a.valid_from ?? "")
    || a.source_ref.localeCompare(b.source_ref)
    || a.id.localeCompare(b.id)
  );
}

export type WikiRetrievalReviewPage = KnowledgeRetrievalReviewPage;
export type WikiRetrievalReviewRow = KnowledgeRetrievalReviewRow;
export type WikiRetrievalTraceDetail = KnowledgeRetrievalTraceDetail;

const CONFLICT_EXPLANATION: Record<string, string> = {
  non_goal_vs_requirement: "同一对象同时声明了“不做”和“需要做”。需要决定哪一个用户意图当前有效。",
  supersedes_not_mutual: "两份决策对“谁取代谁”的记录不一致。需要补齐双向生命周期关系。",
  dangling_supersedes: "一条取代声明指向不存在的知识。需要修正目标或删除这条声明。",
  proposed_referenced_as_current: "尚未生效的提案被当成现行事实引用。需要决定让提案生效还是移除引用。",
  accepted_not_realized: "决策已经接受但还未实现。需要避免把计划误写成当前行为。",
  stale_anchor: "知识仍指向已经不存在的路径。需要迁移或删除这个锚点。",
  negation_pair: "同一模块存在仅差否定词的两条现行规则。两条不能同时成立。",
};

export class KnowledgeWikiService {
  readonly file: string;
  private graph: GraphDb | null = null;
  private retriever: KnowledgeRetriever | null = null;
  private signature = "";
  private overviewCache: WikiOverview | null = null;

  constructor(private readonly opts: KnowledgeWikiServiceOptions) {
    this.file = path.join(opts.dataDir, "knowledge", "graph.db");
  }

  sources(owner: string, action: string, input: Record<string,unknown> = {}): unknown {
    const repo = this.opts.store.knowledgeSources;
    if (!repo || !owner) throw new Error("本人来源服务不可用");
    if (action === "list") return repo.list(owner,typeof input.after === "string" ? input.after : "",input.limit === undefined ? 20 : Number(input.limit));
    if (action === "import") {
      let source: unknown = input.source;
      if (typeof input.source_json === "string") {
        try { source = JSON.parse(input.source_json); }
        catch { throw new Error("source_json 必须是有效的单条消息 JSON"); }
      }
      return repo.import(owner,source);
    }
    if (action === "read") {
      const source = repo.read(owner,String(input.id));
      if (!source) throw new Error("来源不存在或不可访问");
      return {...source,confirmations:repo.confirmations(owner,source.id)};
    }
    throw new Error("来源操作无效；Agent 工具不能创建人类确认");
  }
  confirmSource(owner: string, input: {id:string;source_sha256:string;kind:"requirement"|"endorsement";statement:string}): unknown {
    const repo = this.opts.store.knowledgeSources;
    if (!repo || !owner) throw new Error("本人来源服务不可用");
    return repo.confirm(owner,input.id,input.source_sha256,input.kind,input.statement);
  }
  repairs(after = ""): unknown {
    if (!this.opts.store.knowledgeRepairs) throw new Error("纠错服务不可用");
    return this.opts.store.knowledgeRepairs.list(after);
  }
  async repair(action:string,input:Record<string,unknown>): Promise<unknown> {
    const repo = this.opts.store.knowledgeRepairs;
    if (!repo) throw new Error("纠错服务不可用");
    if (action === "list") return this.repairs(typeof input.after === "string" ? input.after : "");
    if (action === "replay") {
      if (!this.opts.replayRepairs) throw new Error("激活产物回放服务不可用");
      return this.opts.replayRepairs();
    }
    if (action === "investigate") return repo.investigate(String(input.id),typeof input.investigation_json === "string" ? JSON.parse(input.investigation_json) : input.investigation);
    if (action === "report") {
      const identity = parseRepairIdentity(input);
      const graph = this.open()?.graph, node = graph?.node(identity.record_id);
      if (!node || repairFingerprint(node) !== identity.fingerprint) throw new Error("记录已变化；重新读取知识节点与内容指纹");
      return repo.observe(identity,{key:`manual:${identity.problem}`,graph_sha:String(graph!.meta().commit),source:"explicit report"});
    }
    throw new Error("纠错操作无效");
  }

  /** Reopen when the pipeline swapped a new build into place; cheap stat per call. */
  private open(): { graph: GraphDb; retriever: KnowledgeRetriever } | null {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.file);
    } catch {
      this.close();
      return null;
    }
    const signature = `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
    if (this.graph && this.retriever && signature === this.signature) return { graph: this.graph, retriever: this.retriever };
    this.close();
    const graph = GraphDb.openReadonly(this.file);
    if (!graph) return null;
    this.graph = graph;
    this.retriever = new KnowledgeRetriever(graph);
    this.signature = signature;
    this.overviewCache = null;
    return { graph, retriever: this.retriever };
  }

  close(): void {
    this.graph?.close();
    this.graph = null;
    this.retriever = null;
    this.signature = "";
    this.overviewCache = null;
  }

  artifactHealth(): KnowledgeArtifactHealth {
    return this.opts.artifactHealth?.() ?? {
      configured: false,
      status: "unavailable",
      protocolAvailable: false,
      vectorSearchOnline: false,
      active: null,
      task: { phase: "idle", remoteState: null, reconcileStep: null },
      lastFailureCode: null,
      lastFailureAt: null,
      recentActivations: [],
    };
  }

  private reviews(): Map<string, WikiReviewState> {
    const latest = new Map<string, WikiReviewState>();
    for (const row of this.opts.store.knowledge.listReviews()) {
      if (!["dismissed", "confirmed", "resolved", "reopened", "approved_change"].includes(row.decision)) continue;
      latest.set(row.subject_id, { decision: row.decision, note: row.note, actor: row.actor, at: row.created_at });
    }
    return latest;
  }

  private conflictObject(graph: GraphDb, item: ConflictCandidate): KnowledgeNode | null {
    if (item.rule === "stale_anchor" || item.rule === "accepted_not_realized") {
      return graph.node(item.a_id);
    }
    if (item.b_id && (item.rule === "non_goal_vs_requirement" || item.rule === "negation_pair")) {
      const aTargets = new Set(
        graph.edgesFrom(item.a_id)
          .filter((edge) => ["about", "bounds", "governs", "realizes"].includes(edge.relation))
          .map((edge) => edge.to_id),
      );
      for (const edge of graph.edgesFrom(item.b_id)) {
        if (!aTargets.has(edge.to_id)) continue;
        const target = graph.node(edge.to_id);
        if (target?.kind === "capability" || target?.kind === "module") return target;
      }
    }
    return graph.node(item.b_id ?? item.a_id) ?? graph.node(item.a_id);
  }

  private conflictsWithReview(graph: GraphDb, only?: (item: ConflictCandidate) => boolean): WikiConflict[] {
    const reviews = this.reviews();
    const candidates = this.opts.store.knowledge.listReviewCandidates();
    const current = graph.conflicts();
    return [...current, ...candidates.map((row) => row.conflict).filter((item) => !current.some((candidate) => candidate.id === item.id))]
      .filter((item) => (only ? only(item) : true))
      .map((item) => {
        const saved = candidates.find((row) => row.conflict.id === item.id);
        const a = saved?.nodes[0] ?? graph.node(item.a_id) ?? null;
        const b = saved ? saved.nodes[1] ?? null : (item.b_id ? graph.node(item.b_id) : null);
        const object = this.conflictObject(graph, item);
        return {
          id: item.id,
          rule: item.rule,
          severity: item.severity,
          policy: reviewPolicy(item, [a, b], this.opts.store.knowledge.listReviews()),
          why: item.why,
          object: object ? toWire(object) : null,
          explanation: CONFLICT_EXPLANATION[item.rule] ?? "两条知识记录不能同时按当前方式成立，需要核对来源并决定现行结论。",
          a: a ? toWire(a) : null,
          b: b ? toWire(b) : null,
          review: reviews.get(item.id) ?? null,
        };
      });
  }

  overview(): WikiOverview {
    const opened = this.open();
    if (!opened) {
      return {
        generated: false,
        capabilities: [],
        review: { conflictsOpen: 0, conflictsDismissed: 0, conflictsConfirmed: 0, ambiguous: 0, adrLegacy: 0, adrPlanned: 0, staleAnchors: 0, unmappedModules: 0, emptyCapabilities: 0, ticketsWithoutKnowledge: 0 },
        landings: [],
      };
    }
    const { graph, retriever } = opened;
    // Reviews change independently of the graph file, so only the expensive
    // per-capability expansion is cached; the review summary is recomputed.
    if (!this.overviewCache) this.overviewCache = this.computeOverview(graph, retriever);
    const conflicts = this.conflictsWithReview(graph);
    const coverage = graph.coverage();
    const adr = graph.nodesByKind("decision").filter((node) => node.id.startsWith("decision:adr:"));
    const ambiguous = ["requirement", "decision", "non_goal", "risk", "principle"]
      .flatMap((kind) => graph.nodesByKind(kind as NodeKind))
      .filter((node) => node.certainty === "ambiguous");
    const review = {
      conflictsOpen: conflicts.filter((item) => item.policy?.blocked || !item.review || item.review.decision === "reopened").length,
      conflictsDismissed: conflicts.filter((item) => item.review?.decision === "dismissed").length,
      conflictsConfirmed: conflicts.filter((item) => item.review?.decision === "confirmed").length,
      ambiguous: ambiguous.length,
      adrLegacy: coverage.filter((row) => row.scope_kind === "adr" && row.measure === "legacy_status").length,
      adrPlanned: adr.filter((node) => node.status === "active" && (node.realization === "planned" || node.realization === "partial")).length,
      staleAnchors: conflicts.filter((item) => item.rule === "stale_anchor").length,
      unmappedModules: coverage.filter((row) => row.scope_kind === "module" && row.measure === "capabilities" && row.value === 0).length,
      emptyCapabilities: this.overviewCache.capabilities.filter((cap) => cap.direct === 0).length,
      ticketsWithoutKnowledge: coverage.filter((row) => row.scope_kind === "ticket" && row.measure === "knowledge" && row.value === 0).length,
    };
    return { ...this.overviewCache, review };
  }

  private computeOverview(graph: GraphDb, retriever: KnowledgeRetriever): WikiOverview {
    const meta = graph.meta();
    const counts = graph.counts();
    const capabilities: WikiCapabilitySummary[] = graph.nodesByKind("capability", "active").map((node) => {
      const expansion = retriever.expandFromCapabilities([node.id]);
      const direct = graph.edgesTo(node.id, ["about", "governs", "bounds"]).length;
      return {
        id: node.id.replace(/^capability:/, ""),
        kind: node.metadata?.kind === "concern" ? "concern" : "product",
        label: node.statement.split("：")[0],
        description: node.statement.split("：").slice(1).join("："),
        modules: ((node.metadata?.modules as string[] | undefined) ?? []).length,
        counts: {
          principle: expansion.principles.filter((item) => item.authority !== "always_on" && item.metadata?.global !== true).length,
          decision: expansion.decisions.length,
          requirement: expansion.requirements.length,
          non_goal: expansion.nonGoals.length,
          risk: expansion.risks.length,
          pattern: expansion.patterns.length,
          landing: graph.nodesByKind("landing").filter((landing) => expansion.landings.some((item) => item.id === landing.id)).length,
          constraint: expansion.constraints.length,
        },
        direct,
      };
    });
    capabilities.sort((a, b) => (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind === "product" ? -1 : 1));
    const landings = graph
      .nodesByKind("landing", "active")
      .sort((a, b) => (b.valid_from ?? "").localeCompare(a.valid_from ?? "") || a.id.localeCompare(b.id))
      .slice(0, 12)
      .map(toWire);
    return {
      generated: true,
      meta: {
        commit: String(meta.commit ?? ""),
        built_at: String(meta.built_at ?? ""),
        nodes: counts.nodes,
        edges: counts.edges,
        byKind: counts.byKind,
      },
      capabilities,
      review: { conflictsOpen: 0, conflictsDismissed: 0, conflictsConfirmed: 0, ambiguous: 0, adrLegacy: 0, adrPlanned: 0, staleAnchors: 0, unmappedModules: 0, emptyCapabilities: 0, ticketsWithoutKnowledge: 0 },
      landings,
    };
  }

  capability(id: string): WikiCapabilityView | null {
    const opened = this.open();
    if (!opened) return null;
    const { graph, retriever } = opened;
    const node = graph.node(id.startsWith("capability:") ? id : `capability:${id}`);
    if (!node) return null;
    const expansion = retriever.expandFromCapabilities([node.id]);
    return this.viewFromExpansion(graph, toWire(node), expansion, (node.metadata?.docs as string[] | undefined) ?? []);
  }

  module(id: string): WikiCapabilityView | null {
    const opened = this.open();
    if (!opened) return null;
    const { graph, retriever } = opened;
    const node = graph.node(id.startsWith("module:") ? id : `module:${id}`);
    if (!node) return null;
    const prefixes = (node.metadata?.pathPrefixes as string[] | undefined) ?? [];
    const expansion = retriever.expandFromPaths(prefixes.map((prefix) => (prefix.endsWith("/") ? prefix : `${prefix}/`)));
    const docs = graph.edgesFrom(node.id, ["documented_by"]).map((edge) => edge.to_id.replace(/^doc:/, ""));
    return this.viewFromExpansion(graph, toWire(node), expansion, docs);
  }

  private viewFromExpansion(graph: GraphDb, subject: WikiStatement, expansion: Expansion, docs: string[]): WikiCapabilityView {
    const principles = collapseGoverningDocuments(
      graph,
      expansion.principles.filter((item) => item.authority !== "always_on" && item.metadata?.global !== true),
    );
    const unknown: string[] = [];
    if (!principles.length) unknown.push("没有按路径或能力登记的原则；按模块读取 .claude/rules 与包级文档。");
    if (!expansion.decisions.length && !expansion.requirements.length) unknown.push("没有结构化的需求或决策记录（回填未覆盖或尚无工单）。");
    if (expansion.unmappedPaths.length) unknown.push(`未归属模块的路径：${expansion.unmappedPaths.slice(0, 5).join(", ")}`);
    const ordered = (nodes: KnowledgeNode[]) => [...nodes].sort(byAuthorityThenTime).map(toWire);
    return {
      capability: subject,
      modules: expansion.modules.map(toWire),
      constraints: expansion.constraints.map(toWire),
      principles: ordered(principles),
      decisions: ordered(expansion.decisions),
      requirements: ordered(expansion.requirements),
      nonGoals: ordered(expansion.nonGoals),
      risks: ordered(expansion.risks),
      patterns: expansion.patterns.map(toWire),
      landings: expansion.landings.map(toWire),
      docs: docs.filter((doc) => doc.length > 0 && graph.node(`doc:${doc}`) != null),
      unknown,
    };
  }

  relationGraph(): WikiGraphView {
    const opened = this.open();
    if (!opened) return { generated: false, nodes: [], edges: [] };
    const meta = opened.graph.meta();
    return {
      generated: true,
      meta: {
        commit: String(meta.commit ?? ""),
        built_at: String(meta.built_at ?? ""),
      },
      nodes: opened.graph.allNodes().map((node) => ({
        id: node.id,
        kind: node.kind,
        statement: node.statement,
        status: node.status,
        authority: node.authority,
        certainty: node.certainty,
        source_ref: node.source_ref,
      })),
      edges: opened.graph.allEdges().map((edge) => ({
        from_id: edge.from_id,
        relation: edge.relation,
        to_id: edge.to_id,
        certainty: edge.certainty,
      })),
    };
  }

  node(id: string): WikiNodeView | null {
    const opened = this.open();
    if (!opened) return null;
    const { graph } = opened;
    const node = graph.node(id);
    if (!node) return null;
    const group = (edges: Array<{ relation: Relation; from_id: string; to_id: string }>, pick: "from_id" | "to_id"): WikiEdgeGroup[] => {
      const byRelation = new Map<Relation, Set<string>>();
      for (const edge of edges) (byRelation.get(edge.relation) ?? byRelation.set(edge.relation, new Set()).get(edge.relation))!.add(edge[pick]);
      return [...byRelation.entries()]
        .map(([relation, ids]) => {
          // Sorted as a whole, so the page's first display window is the true
          // top of the group rather than the first ids in edge order.
          const nodes = graph.nodes([...ids]).sort(byAuthorityThenTime).map(toWire);
          return { relation, nodes, total: ids.size };
        })
        .sort((a, b) => a.relation.localeCompare(b.relation));
    };
    return {
      repair_fingerprint: repairFingerprint(node),
      node: toWire(node),
      history: this.opts.store.knowledge.listReviews().filter((row) => row.subject_id === node.id).map((row) => ({ decision: row.decision, actor: row.actor, at: row.created_at, note: row.note })),
      out: group(graph.edgesFrom(node.id), "to_id"),
      in: group(graph.edgesTo(node.id), "from_id"),
      conflicts: this.conflictsWithReview(graph, (item) => item.a_id === node.id || item.b_id === node.id),
    };
  }

  async search(query: string, kinds?: readonly NodeKind[]): Promise<WikiSearchView> {
    const opened = this.open();
    if (!opened) return { query, statements: [], capabilities: [], modules: [] };
    const { graph, retriever } = opened;
    const statementKinds: NodeKind[] = kinds?.length ? [...kinds] : ["principle", "decision", "requirement", "non_goal", "risk", "pattern", "constraint"];
    const statements = (await retriever.searchStatements(query, statementKinds, 40)).map(toWire);
    const capabilities = (await retriever.classify({ text: query })).map((match) => ({ id: match.id, certainty: match.certainty, why: match.why.slice(0, 3) }));
    const needle = query.normalize("NFKC").toLowerCase();
    const modules = graph
      .nodesByKind("module")
      .filter((node) => node.statement.toLowerCase().includes(needle) || (node.aliases ?? []).some((alias) => alias.toLowerCase().includes(needle)))
      .slice(0, 12)
      .map(toWire);
    return { query, statements, capabilities, modules };
  }

  /** What a ticket agent would be handed for this requirement — the same assembly devpipe runs. */
  async preview(title: string, body: string): Promise<WikiPreview | null> {
    const opened = this.open();
    if (!opened) return null;
    const pack = await buildStartupPack(opened.retriever, { title: title.slice(0, 200), body: body.slice(0, MAX_PREVIEW_CHARS) });
    return {
      text: pack.text,
      included: pack.included.length,
      capabilities: pack.capabilities.map((match) => ({ id: match.id, certainty: match.certainty, why: match.why.slice(0, 3) })),
      unknown: pack.unknown.map((reason) => reason.slot ? `${reason.code}:${reason.slot}` : reason.code),
      chars: pack.chars,
    };
  }

  review(): WikiReviewView {
    const opened = this.open();
    if (!opened) return { conflicts: [], ambiguous: [], adr: [], coverage: { modulesWithoutCapability: [], emptyCapabilities: [], ticketsWithoutKnowledge: { count: 0, sample: [] } } };
    const { graph } = opened;
    const reviews = this.reviews();
    const coverage = graph.coverage();
    const ambiguous = ["requirement", "decision", "non_goal", "risk", "principle"]
      .flatMap((kind) => graph.nodesByKind(kind as NodeKind))
      .filter((node) => node.certainty === "ambiguous")
      .sort(byAuthorityThenTime)
      .map((node) => ({ node: toWire(node), review: reviews.get(node.id) ?? null }));
    const legacy = new Set(coverage.filter((row) => row.scope_kind === "adr" && row.measure === "legacy_status").map((row) => row.scope_id));
    const adr = graph
      .nodesByKind("decision")
      .filter((node) => node.id.startsWith("decision:adr:"))
      .map((node) => ({ node: toWire(node), legacy: legacy.has(node.source_ref) }))
      .filter((item) => item.legacy || item.node.status === "proposed" || item.node.realization === "planned" || item.node.realization === "partial")
      .sort((a, b) => a.node.source_ref.localeCompare(b.node.source_ref));
    const tickets = coverage.filter((row) => row.scope_kind === "ticket" && row.measure === "knowledge" && row.value === 0);
    const capabilities = this.overview().capabilities;
    return {
      conflicts: this.conflictsWithReview(graph).sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || a.rule.localeCompare(b.rule) || a.id.localeCompare(b.id)),
      ambiguous,
      adr,
      coverage: {
        modulesWithoutCapability: coverage.filter((row) => row.scope_kind === "module" && row.measure === "capabilities" && row.value === 0).map((row) => row.scope_id.replace(/^module:/, "")).sort(),
        emptyCapabilities: capabilities.filter((cap) => cap.direct === 0).map((cap) => cap.id),
        ticketsWithoutKnowledge: {
          count: tickets.length,
          sample: tickets.map((row) => Number(row.scope_id.replace(/^ticket:/, ""))).filter(Number.isFinite).sort((a, b) => b - a).slice(0, 30),
        },
      },
    };
  }

  conflictWorkspace(subjectId: string): WikiConflictWorkspace | null {
    const subject = subjectId.trim();
    if (!subject || subject.length > 400) return null;
    const opened = this.open();
    const conflict = opened
      ? this.conflictsWithReview(opened.graph, (item) => item.id === subject)[0] ?? null
      : null;
    const review = conflict?.review ?? this.reviews().get(subject) ?? null;
    const annotations = this.opts.store.knowledge.listAnnotations(subject).map((row) => ({
      id: row.id,
      body: row.body,
      actor: row.actor,
      at: row.created_at,
    }));
    if (!conflict && !review && annotations.length === 0) return null;
    const terminal = !conflict || (!conflict.policy?.blocked && (review?.decision === "dismissed" || review?.decision === "resolved" || conflict.policy?.approved === true));
    return { subject_id: subject, conflict, review, annotations, terminal, history: this.opts.store.knowledge.listReviews().filter((row) => row.subject_id === subject).map((row) => ({ decision: row.decision, note: row.note, actor: row.actor, at: row.created_at })) };
  }

  async chatContext(subjectId: string | null, query: string): Promise<WikiKnowledgeChatContext> {
    if (subjectId) {
      const node = this.node(subjectId);
      if (node) return { context: JSON.stringify(node), readOnly: false };
      const workspace = this.conflictWorkspace(subjectId);
      if (!workspace?.conflict) {
        return {
          context: `关联冲突：${subjectId}\n当前知识图中已没有这个冲突对象。`,
          readOnly: true,
          reason: "关联冲突已关闭或已退出当前知识图",
        };
      }
      const conflict = workspace.conflict;
      const statement = (label: string, item: WikiStatement | null): string => item
        ? `${label}：${item.statement}\n来源：${item.source_ref}`
        : `${label}：（记录缺失）`;
      const annotations = workspace.annotations.length
        ? workspace.annotations.map((item) => `- ${item.actor}：${item.body}`).join("\n")
        : "- 暂无已保存批注";
      return {
        context: [
          `冲突 id：${conflict.id}`,
          `冲突对象：${conflict.object?.statement ?? conflict.a?.statement ?? conflict.id}`,
          `待决定：${conflict.explanation}`,
          statement("一方", conflict.a),
          statement("另一方", conflict.b),
          `检测证据：${conflict.why}`,
          `证据分级与调查：${JSON.stringify(conflict.policy)}`,
          `一方来源与动机：${JSON.stringify(conflict.a?.detail)}`,
          `另一方来源与动机：${JSON.stringify(conflict.b?.detail)}`,
          `代码与测试映射：${JSON.stringify([conflict.a, conflict.b].map((side) => side ? this.node(side.id)?.out : null))}`,
          "请先调查原始动机与代码/测试，不得把相似度检测当作语义冲突已经证实。",
          "已保存批注：",
          annotations,
        ].join("\n\n"),
        readOnly: workspace.terminal,
        ...(workspace.terminal ? { reason: "关联冲突已关闭" } : {}),
      };
    }

    const result = await this.search(query.trim().slice(0, 300), []);
    const statements = result.statements.slice(0, 12).map((item) =>
      `- [${item.kind}] ${item.statement}\n  来源：${item.source_ref}`,
    );
    return {
      context: statements.length
        ? `与问题匹配的知识记录：\n${statements.join("\n")}`
        : "没有检索到与这条消息直接匹配的知识记录。",
      readOnly: false,
    };
  }

  annotate(input: {
    subject_id: string;
    body: string;
    actor: string;
  }): { ok: true; annotation: WikiKnowledgeAnnotation } | { ok: false; error: string } {
    const workspace = this.conflictWorkspace(input.subject_id);
    if (!workspace?.conflict) return { ok: false, error: "冲突不存在或已不在当前知识图中" };
    if (workspace.terminal) return { ok: false, error: "冲突已关闭，批注保持只读" };
    const body = input.body.trim();
    if (!body || body.length > 2000) return { ok: false, error: "批注必须为 1-2000 字符" };
    const actor = input.actor.trim().slice(0, 64);
    if (!actor) return { ok: false, error: "批注作者无效" };
    const row = this.opts.store.knowledge.recordAnnotation({
      subject_id: workspace.subject_id,
      body,
      actor,
    });
    return { ok: true, annotation: { id: row.id, body: row.body, actor: row.actor, at: row.created_at } };
  }

  investigate(input: { subject_id: string; investigation: unknown; actor: string }): { ok: true } | { ok: false; error: string } {
    const opened = this.open();
    const workspace = this.conflictWorkspace(input.subject_id);
    if (!opened || !workspace?.conflict || workspace.terminal) return { ok: false, error: "冲突不存在或已关闭" };
    const saved = this.opts.store.knowledge.listReviewCandidates().find((row) => row.conflict.id === input.subject_id);
    const sides = [workspace.conflict.a, workspace.conflict.b].map((side, index) => side ? saved?.nodes[index] ?? opened.graph.node(side.id) ?? null : null);
    try {
      const [investigation] = parseKnowledgeChanges([input.investigation]);
      if (!sides.some((side) => side?.id === investigation.record_id)) return { ok: false, error: "调查必须指向此冲突的一方记录" };
      const actor = input.actor.trim().slice(0, 64);
      if (!actor) return { ok: false, error: "调查作者无效" };
      this.opts.store.knowledge.recordReview({ subject_id: workspace.subject_id, rule: workspace.conflict.rule, decision: "investigated", actor,
        note: JSON.stringify({ source_fingerprint: conflictFingerprint(workspace.conflict.id, sides), investigation }) });
      return { ok: true };
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : "调查内容无效" }; }
  }

  /** Record a reviewer's decision; the subject must exist in the current graph so a typo cannot create a ghost review. */
  decide(input: { subject_id: string; rule: string; decision: string; note: string; actor: string; admin?: boolean; fingerprint?: string }): { ok: true; review: WikiReviewState } | { ok: false; error: string } {
    const opened = this.open();
    if (!opened) return { ok: false, error: "知识图谱尚未构建" };
    if (input.decision !== "approved_change" && !(REVIEW_DECISIONS as readonly string[]).includes(input.decision)) return { ok: false, error: `decision 必须是 ${REVIEW_DECISIONS.join("|")}` };
    const subject = input.subject_id.trim();
    if (!subject || subject.length > 400) return { ok: false, error: "subject_id 无效" };
    const workspace = this.conflictWorkspace(subject);
    const known = workspace != null || opened.graph.node(subject) != null;
    if (!known) return { ok: false, error: "subject_id 不在当前图中" };
    let note = input.note.trim().slice(0, 600);
    if (workspace?.conflict?.policy?.blocked && ["dismissed", "resolved"].includes(input.decision)) return { ok: false, error: "用户强制要求的冲突须经管理员明确审阅，普通关闭不能消除上线义务" };
    if (input.decision === "approved_change") {
      if (!input.admin) return { ok: false, error: "只有管理员可以批准用户强制要求的设计修改" };
      const conflict = workspace?.conflict;
      if (!conflict?.policy?.investigation) return { ok: false, error: "请先让 Agent 提交完整调查，再审阅两边动机、修改与代价" };
      if (input.fingerprint !== conflict.policy.fingerprint) return { ok: false, error: "冲突内容已经变化，请重新阅读后再批准" };
      // The request is the administrator's one explicit confirmation of the
      // content they were shown; the note is optional context, not a test.
      note = JSON.stringify({ fingerprint: conflict.policy.fingerprint, confirmed: true, ...(note ? { note } : {}) });
    }
    const row = this.opts.store.knowledge.recordReview({ subject_id: subject, rule: input.rule.slice(0, 80), decision: input.decision, note, actor: input.actor });
    return { ok: true, review: { decision: row.decision, note: row.note, actor: row.actor, at: row.created_at } };
  }
  retrievals(filter: KnowledgeRetrievalReviewFilter = {}): WikiRetrievalReviewPage {
    return this.opts.store.knowledgeRetrieval.listForReview(filter);
  }

  retrievalTickets(filter: { before?: number; limit?: number } = {}): KnowledgeTicketRetrievalPage {
    return this.opts.store.knowledgeRetrieval.listTickets(filter);
  }

  retrievalTrace(id: string, filter: KnowledgeRetrievalTraceEventFilter = {}): WikiRetrievalTraceDetail | null {
    return this.opts.store.knowledgeRetrieval.getTrace(id, filter);
  }

}

function severityRank(value: string): number {
  return value === "high" ? 3 : value === "review" ? 2 : 1;
}

export type { KnowledgeReviewRow, CoverageRow };
