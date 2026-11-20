import { knowledgeDesignKey, knowledgeStrength, type KnowledgeProvenance } from "./provenance.js";
import { detectConflicts } from "./conflicts.js";
import { gitRunner, resolveSha, type GitRunner } from "./git.js";
import { GraphDb, type GraphSnapshot } from "./graph-db.js";
import { fingerprint } from "./ids.js";
import {
  AUTHORITY_RANK,
  GRAPH_SCHEMA_VERSION,
  GRAPH_TOOL_VERSION,
  STATEMENT_KINDS,
  type BuildMeta,
  type ConflictCandidate,
  type ConformanceArtifact,
  type ConformanceObservation,
  type ContractCell,
  type CoverageRow,
  type KnowledgeEdge,
  type KnowledgeNode,
  type NodeKind,
  type Relation,
} from "./model.js";
import { adrSource } from "./sources/adr.js";
import { atlasSource } from "./sources/atlas.js";
import { capabilitiesSource, loadCapabilities } from "./sources/capabilities.js";
import { cliReportsSource } from "./sources/cli-reports.js";
import { contractsSource, type ContractCodeIndexResolver } from "./sources/contracts.js";
import { WORKTREE_REF, createSourceContext, mergeOutputs, type SourceContext, type SourceOutput } from "./sources/context.js";
import { curatedSource } from "./sources/curated.js";
import { deliveriesSource } from "./sources/deliveries.js";
import { landingsSource, type RuntimeInputs } from "./sources/landings.js";
import { packageDocsSource } from "./sources/package-docs.js";
import { patternsSource } from "./sources/patterns.js";
import { rulesSource } from "./sources/rules.js";

export interface BuildOptions {
  repoDir: string;
  /** Commit-ish to build from; defaults to HEAD of `repoDir`. */
  ref?: string;
  /** Destination `graph.db`; omitted = in-memory snapshot only (tests). */
  out?: string;
  runtime?: RuntimeInputs | null;
  observedAt?: string;
  /** Explicit date for lifecycle/exception evaluation; defaults to observedAt's UTC date. */
  evaluationAsOf?: string;
  codeIndex?: ContractCodeIndexResolver;
  git?: GitRunner;
}

export interface BuildResult {
  sha: string;
  file: string | null;
  snapshot: GraphSnapshot;
  warnings: string[];
}

/**
 * Full rebuild from the repository at one commit plus optional runtime
 * inputs. Deterministic semantic projection for identical inputs; built_at
 * remains operational metadata and is excluded from projection_digest.
 */
export async function buildGraph(opts: BuildOptions): Promise<BuildResult> {
  const git = opts.git ?? gitRunner(opts.repoDir);
  const ref = opts.ref ?? "HEAD";
  const sha = ref === WORKTREE_REF ? WORKTREE_REF : await resolveSha(git, ref);
  const observedAt = opts.observedAt ?? new Date().toISOString();
  const evaluationAsOf = opts.evaluationAsOf ?? observedAt.slice(0, 10);
  const ctx = await createSourceContext({ repoDir: opts.repoDir, sha, git, observedAt, evaluationAsOf });
  const { doc: capabilities } = await loadCapabilities(ctx);
  const capabilityIds = new Set(capabilities.capabilities.map((capability) => capability.id));
  const runtime = opts.runtime ?? { landings: [], tickets: [] };

  const outputs = await Promise.all([
    atlasSource(ctx),
    capabilitiesSource(ctx),
    rulesSource(ctx),
    packageDocsSource(ctx),
    adrSource(ctx),
    deliveriesSource(ctx),
    cliReportsSource(ctx),
    curatedSource(ctx),
    patternsSource(ctx, { capabilities: capabilityIds }),
  ]);
  outputs.push(landingsSource(ctx, runtime));
  const contractOutput = await contractsSource(ctx, { codeIndex: opts.codeIndex });
  outputs.push(contractOutput);
  const merged = mergeOutputs(outputs);
  const existingPaths = new Set(await ctx.list([]));
  const inputsFingerprint = fingerprint([
    sha,
    GRAPH_TOOL_VERSION,
    evaluationAsOf,
    canonicalJson(runtime),
    opts.codeIndex?.gitSha ?? "",
    opts.codeIndex?.manifestDigest ?? "",
  ]);
  const snapshot: GraphSnapshot = {
    ...assembleSnapshot(merged, {
      sha,
      observedAt,
      evaluationAsOf,
      existingPaths,
      inputsFingerprint,
      codeIndexSha: opts.codeIndex?.gitSha,
      cells: contractOutput.cells,
      observations: contractOutput.observations,
      observationArtifacts: contractOutput.observationArtifacts,
    }),
    runtimeInputs: runtime,
  };
  if (opts.out) GraphDb.writeSnapshot(opts.out, snapshot);
  return { sha, file: opts.out ?? null, snapshot, warnings: merged.warnings };
}

export interface AssembleContext {
  sha: string;
  observedAt: string;
  evaluationAsOf?: string;
  existingPaths: ReadonlySet<string> | null;
  inputsFingerprint: string;
  codeIndexSha?: string;
  cells?: readonly ContractCell[];
  observations?: readonly ConformanceObservation[];
  observationArtifacts?: readonly ConformanceArtifact[];
}

interface KnowledgeOrigin {
  ticket: number;
  requester: string;
  role: "user_requirement" | "task_evolution";
  /** How that ticket's opening request was written, when recorded (bot.db v86). */
  actor_kind?: string;
}

function originList(value: unknown): KnowledgeOrigin[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    if (!("ticket" in item) || !("requester" in item) || !("role" in item)) return [];
    if (typeof item.ticket !== "number" || !Number.isInteger(item.ticket) || typeof item.requester !== "string") return [];
    if (item.role !== "user_requirement" && item.role !== "task_evolution") return [];
    const actorKind = "actor_kind" in item && typeof item.actor_kind === "string" ? item.actor_kind : undefined;
    return [{ ticket: item.ticket, requester: item.requester, role: item.role, ...(actorKind ? { actor_kind: actorKind } : {}) }];
  });
}

function mergeOrigins(...lists: readonly KnowledgeOrigin[][]): KnowledgeOrigin[] {
  const seen = new Set<string>();
  const merged: KnowledgeOrigin[] = [];
  for (const origin of lists.flat()) {
    const key = `${origin.ticket}\0${origin.requester}\0${origin.role}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(origin);
  }
  return merged.sort((a, b) => a.ticket - b.ticket || a.requester.localeCompare(b.requester) || a.role.localeCompare(b.role));
}

/**
 * Runtime ticket rows are the authority for user attribution. Attach that
 * attribution after source-id merging, before duplicate statements fold, so a
 * claim preserved by several tickets keeps every origin instead of whichever
 * source won the authority tie.
 */
function attachTicketOrigins(nodes: Map<string, KnowledgeNode>, edges: readonly KnowledgeEdge[]): void {
  const requesterByTicket = new Map<number, string>();
  const actorKindByTicket = new Map<number, string>();
  for (const node of nodes.values()) {
    if (node.kind !== "ticket") continue;
    const ticket = Number(node.id.replace(/^ticket:/, ""));
    const requester = node.metadata?.requester;
    if (Number.isInteger(ticket) && typeof requester === "string" && requester) requesterByTicket.set(ticket, requester);
    const actorKind = node.metadata?.actor_kind;
    if (Number.isInteger(ticket) && typeof actorKind === "string" && actorKind) actorKindByTicket.set(ticket, actorKind);
  }
  const ticketsByNode = new Map<string, Set<number>>();
  const addTicket = (nodeId: string, value: unknown): void => {
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return;
    const tickets = ticketsByNode.get(nodeId) ?? new Set<number>();
    tickets.add(value);
    ticketsByNode.set(nodeId, tickets);
  };
  for (const node of nodes.values()) {
    addTicket(node.id, node.metadata?.ticket);
    addTicket(node.id, node.metadata?.ticket_id);
    addTicket(node.id, node.metadata?.origin_ticket_id);
    if (Array.isArray(node.metadata?.tickets)) {
      for (const ticket of node.metadata.tickets) addTicket(node.id, ticket);
    }
    if (node.kind === "ticket") addTicket(node.id, Number(node.id.replace(/^ticket:/, "")));
  }
  for (const edge of edges) {
    if (edge.relation !== "about" || !edge.to_id.startsWith("ticket:")) continue;
    addTicket(edge.from_id, Number(edge.to_id.slice("ticket:".length)));
  }
  for (const node of nodes.values()) {
    const role: KnowledgeOrigin["role"] = knowledgeStrength(node) === "human_required"
      ? "user_requirement"
      : "task_evolution";
    const additions = [...(ticketsByNode.get(node.id) ?? [])].flatMap((ticket) => {
      const requester = requesterByTicket.get(ticket);
      const actorKind = actorKindByTicket.get(ticket);
      return requester ? [{ ticket, requester, role, ...(actorKind ? { actor_kind: actorKind } : {}) }] : [];
    });
    if (!additions.length) continue;
    const origins = mergeOrigins(originList(node.metadata?.origins), additions);
    const requester = typeof node.metadata?.requester === "string"
      ? node.metadata.requester
      : additions[0]!.requester;
    const originTicket = typeof node.metadata?.origin_ticket_id === "number"
      ? node.metadata.origin_ticket_id
      : additions[0]!.ticket;
    node.metadata = { ...(node.metadata ?? {}), requester, origin_ticket_id: originTicket, origins };
  }
}

/**
 * Pure assembly: merge duplicate ids, fold duplicate statements, resolve
 * supersession, validate typed contract domains, drop legacy dangling edges,
 * detect conflicts and measure coverage.
 */
export function assembleSnapshot(output: SourceOutput, ctx: AssembleContext): GraphSnapshot {
  const nodes = new Map<string, KnowledgeNode>();
  const alias = new Map<string, string>();
  const warnings: string[] = [...output.warnings];

  // 1. Same id from several sources: keep the higher authority, merge aliases/metadata.
  for (const node of output.nodes) {
    const existing = nodes.get(node.id);
    if (!existing) {
      nodes.set(node.id, { ...node, aliases: [...(node.aliases ?? [])], metadata: { ...(node.metadata ?? {}) } });
      continue;
    }
    const keep = AUTHORITY_RANK[node.authority] > AUTHORITY_RANK[existing.authority] ? node : existing;
    const drop = keep === node ? existing : node;
    nodes.set(node.id, {
      ...keep,
      aliases: [...new Set([...(keep.aliases ?? []), ...(drop.aliases ?? [])])],
      metadata: { ...(drop.metadata ?? {}), ...(keep.metadata ?? {}), alias_ids: mergeAliasIds(keep, drop) },
    });
  }
  attachTicketOrigins(nodes, output.edges);
  for (const node of nodes.values()) {
    for (const id of (node.metadata?.alias_ids as string[] | undefined) ?? []) if (id !== node.id && !nodes.has(id)) alias.set(id, node.id);
  }

  // 2. Same claim written twice (statement kinds only): fold into the higher authority.
  // Contract-local principle/obligation/scenario identity is deliberately not folded.
  const byStatement = new Map<string, KnowledgeNode>();
  for (const node of [...nodes.values()].sort((a, b) => compare(a.id, b.id))) {
    if (!STATEMENT_KINDS.has(node.kind) || isContractLocalStatement(node)) continue;
    const key = `${node.kind}:${knowledgeDesignKey(node.statement)}`;
    const existing = byStatement.get(key);
    if (!existing) {
      byStatement.set(key, node);
      continue;
    }
    const keep = AUTHORITY_RANK[node.authority] > AUTHORITY_RANK[existing.authority] ? node : existing;
    const drop = keep === node ? existing : node;
    byStatement.set(key, keep);
    nodes.delete(drop.id);
    alias.set(drop.id, keep.id);
    const merged = (keep.metadata?.merged_from as string[] | undefined) ?? [];
    const mergedOrigins = mergeOrigins(originList(keep.metadata?.origins), originList(drop.metadata?.origins));
    const proofs = [keep, drop].flatMap((node) => (node.metadata?.provenance as KnowledgeProvenance | undefined)?.events ?? []);
    const provenance = (keep.metadata?.provenance ?? drop.metadata?.provenance) as KnowledgeProvenance | undefined;
    keep.metadata = {
      ...(keep.metadata ?? {}),
      ...(provenance ? { provenance: { ...provenance, events: [...new Map(proofs.map((event) => [JSON.stringify(event), event])).values()] } } : {}),
      merged_from: [...merged, drop.source_ref],
      ...(mergedOrigins.length ? { origins: mergedOrigins } : {}),
    };
    for (const id of (drop.metadata?.alias_ids as string[] | undefined) ?? []) alias.set(id, keep.id);
  }
  const resolve = (id: string): string => {
    let current = id;
    for (let hops = 0; hops < 5; hops += 1) {
      const next = alias.get(current);
      if (!next || next === current) break;
      current = next;
    }
    return current;
  };

  // 3. Rewrite edges; resolve supersession; reject invalid contract edges;
  // retain the legacy behavior of reporting/dropping unrelated dangling edges.
  const edges = new Map<string, KnowledgeEdge>();
  const conflicts: ConflictCandidate[] = [];
  const dangling = new Map<string, number>();
  for (const raw of output.edges) {
    const edge = { ...raw, from_id: resolve(raw.from_id), to_id: resolve(raw.to_id) };
    if (edge.from_id === edge.to_id) continue;
    const from = nodes.get(edge.from_id);
    const to = nodes.get(edge.to_id);
    if (isContractRelation(edge.relation) || isContractNode(from) || isContractNode(to)) validateContractEdge(edge, from, to);
    if (edge.relation === "supersedes") {
      if (!from) continue;
      if (!to) {
        conflicts.push({
          id: `dangling_supersedes:${edge.from_id}:${edge.to_id}`.slice(0, 400),
          rule: "dangling_supersedes",
          a_id: edge.from_id,
          b_id: edge.to_id,
          why: `${edge.source_ref} supersedes ${edge.to_id}, which is not in the graph`,
          severity: "review",
        });
        continue;
      }
      if (knowledgeStrength(to) === "human_required") {
        conflicts.push({ id: `required_revision:${edge.from_id}:${edge.to_id}`.slice(0, 400), rule: "required_revision", a_id: to.id, b_id: from.id, why: "新实现要求取代用户原始／强制要求；原始动机和修改理由须经管理员裁决。", severity: "high" });
      } else if (to.status === "active" || to.status === "proposed" || to.status === "historical") {
        to.status = "superseded";
        to.valid_to = to.valid_to ?? from.valid_from;
      }
      to.metadata = { ...(to.metadata ?? {}), [knowledgeStrength(to) === "human_required" ? "proposed_successor" : "superseded_by"]: edge.from_id };
    } else if (!from || !to) {
      const key = `${edge.relation}:${!from ? "from" : "to"}`;
      dangling.set(key, (dangling.get(key) ?? 0) + 1);
      continue;
    }
    const key = `${edge.from_id}\0${edge.relation}\0${edge.to_id}`;
    const existing = edges.get(key);
    if (!existing || rankCertainty(edge.certainty) > rankCertainty(existing.certainty)) edges.set(key, edge);
  }
  for (const [key, count] of dangling) warnings.push(`dropped ${count} dangling ${key} edge(s)`);

  const edgeList = [...edges.values()].sort((a, b) => compare(`${a.from_id}\0${a.relation}\0${a.to_id}`, `${b.from_id}\0${b.relation}\0${b.to_id}`));
  const cells = [...(ctx.cells ?? [])].sort((a, b) => compare(a.id, b.id));
  const observations = [...(ctx.observations ?? [])].sort((a, b) => compare(a.id, b.id));
  const observationArtifacts = [...(ctx.observationArtifacts ?? [])].sort((a, b) => compare(`${a.observation_id}\0${a.artifact_id}\0${a.role}`, `${b.observation_id}\0${b.artifact_id}\0${b.role}`));
  validateProjectionRows(nodes, cells, observations, observationArtifacts);
  conflicts.push(...detectConflicts({ nodes, edges: edgeList, existingPaths: ctx.existingPaths }));
  const coverage = [...output.coverage, ...measureCoverage(nodes, edgeList, dangling)];
  const nodeList = [...nodes.values()].sort((a, b) => compare(a.id, b.id));
  const projectionDigest = fingerprint([
    canonicalJson(nodeList),
    canonicalJson(edgeList.map((edge) => ({
      from_id: edge.from_id,
      relation: edge.relation,
      to_id: edge.to_id,
      method: edge.method,
      certainty: edge.certainty,
      source_ref: edge.source_ref,
      source_sha: edge.source_sha,
    }))),
    canonicalJson(cells),
    canonicalJson(observations),
    canonicalJson(observationArtifacts),
  ]);
  const meta: BuildMeta = {
    schema_version: GRAPH_SCHEMA_VERSION,
    commit: ctx.sha,
    built_at: ctx.observedAt,
    evaluation_as_of: ctx.evaluationAsOf ?? ctx.observedAt.slice(0, 10),
    tool_version: GRAPH_TOOL_VERSION,
    input_fingerprint: ctx.inputsFingerprint,
    projection_digest: projectionDigest,
    code_index_sha: ctx.codeIndexSha,
    node_count: nodeList.length,
    edge_count: edgeList.length,
  };
  return { nodes: nodeList, edges: edgeList, cells, observations, observationArtifacts, coverage, conflicts: dedupeConflicts(conflicts), meta };
}

function isContractLocalStatement(node: KnowledgeNode): boolean {
  return node.source_ref.startsWith("architecture/knowledge/contracts/") && node.metadata?.contract !== undefined;
}

const CONTRACT_NODE_KINDS: ReadonlySet<NodeKind> = new Set([
  "capability_contract",
  "obligation",
  "scenario",
  "exception",
  "source",
  "artifact",
  "desired_conformance",
  "observed_conformance",
]);

const CONTRACT_RELATIONS: ReadonlySet<Relation> = new Set([
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

function isContractNode(node: KnowledgeNode | undefined): boolean {
  return node !== undefined && (CONTRACT_NODE_KINDS.has(node.kind) || isContractLocalStatement(node));
}

function isContractRelation(relation: Relation): boolean {
  return CONTRACT_RELATIONS.has(relation);
}

function validateContractEdge(edge: KnowledgeEdge, from: KnowledgeNode | undefined, to: KnowledgeNode | undefined): void {
  if (!from || !to) throw new Error(`contract projection has dangling ${edge.relation} edge ${edge.from_id} -> ${edge.to_id}`);
  const allowed = relationDomain(edge.relation, from.kind, to.kind);
  if (!allowed) throw new Error(`contract projection relation domain invalid: ${from.kind} ${edge.relation} ${to.kind}`);
  const artifactKind = to.kind === "artifact" ? String(to.metadata?.kind ?? "") : "";
  if (edge.relation === "verified_by" && artifactKind !== "test") {
    throw new Error(`verified_by requires a test artifact: ${edge.to_id}`);
  }
  if (edge.relation === "realized_by" && artifactKind === "test") {
    throw new Error(`realized_by cannot use a test artifact: ${edge.to_id}`);
  }
  if ((edge.relation === "supersedes" || edge.relation === "reaffirms") && isContractNode(from) && from.kind !== to.kind) {
    throw new Error(`contract lineage must stay within one kind: ${edge.from_id} ${edge.relation} ${edge.to_id}`);
  }
}

function relationDomain(relation: Relation, from: NodeKind, to: NodeKind): boolean {
  switch (relation) {
    case "contract_for": return from === "capability_contract" && to === "capability";
    case "defines": return from === "capability_contract" && ["principle", "obligation", "scenario", "desired_conformance"].includes(to);
    case "derives_from": return from === "obligation" && ["principle", "requirement", "decision"].includes(to);
    case "applies_to": return from === "desired_conformance" && to === "scenario";
    case "requires": return from === "desired_conformance" && to === "obligation";
    case "waives": return from === "exception" && ["obligation", "desired_conformance", "constraint"].includes(to);
    case "supported_by": return ["principle", "obligation", "scenario", "exception", "desired_conformance"].includes(from) && to === "source";
    case "observes": return from === "observed_conformance" && to === "desired_conformance";
    case "realized_by": return ["principle", "requirement", "decision", "non_goal", "risk", "obligation", "scenario", "desired_conformance", "observed_conformance"].includes(from) && to === "artifact";
    case "verified_by": return ["principle", "requirement", "decision", "non_goal", "risk", "scenario", "desired_conformance", "observed_conformance", "obligation"].includes(from) && to === "artifact";
    case "reaffirms": return from === to;
    default: return true;
  }
}

function validateProjectionRows(
  nodes: ReadonlyMap<string, KnowledgeNode>,
  cells: readonly ContractCell[],
  observations: readonly ConformanceObservation[],
  artifacts: readonly ConformanceArtifact[],
): void {
  const cellIds = new Set<string>();
  for (const cell of cells) {
    if (cellIds.has(cell.id)) throw new Error(`duplicate contract cell ${cell.id}`);
    cellIds.add(cell.id);
    if (nodes.get(cell.id)?.kind !== "desired_conformance") throw new Error(`contract cell ${cell.id} has no desired_conformance node`);
    if (nodes.get(cell.contract_id)?.kind !== "capability_contract") throw new Error(`contract cell ${cell.id} has invalid contract ${cell.contract_id}`);
    if (nodes.get(cell.scenario_id)?.kind !== "scenario") throw new Error(`contract cell ${cell.id} has invalid scenario ${cell.scenario_id}`);
    if (cell.exception_id && nodes.get(cell.exception_id)?.kind !== "exception") throw new Error(`contract cell ${cell.id} has invalid exception ${cell.exception_id}`);
  }
  const observationIds = new Set<string>();
  for (const observation of observations) {
    if (observationIds.has(observation.id)) throw new Error(`duplicate conformance observation ${observation.id}`);
    observationIds.add(observation.id);
    if (!cellIds.has(observation.cell_id)) throw new Error(`observation ${observation.id} has unknown cell ${observation.cell_id}`);
    if (observation.status === "conformant" && !(observation.baseline_sha === observation.code_index_sha && observation.baseline_sha === observation.verified_sha)) {
      throw new Error(`conformant observation ${observation.id} is not bound to one SHA`);
    }
  }
  for (const artifact of artifacts) {
    if (!observationIds.has(artifact.observation_id)) throw new Error(`conformance artifact has unknown observation ${artifact.observation_id}`);
    const node = nodes.get(artifact.artifact_id);
    if (node?.kind !== "artifact") throw new Error(`conformance artifact has unknown artifact ${artifact.artifact_id}`);
    const kind = String(node.metadata?.kind ?? "");
    if (artifact.role === "test" && kind !== "test") throw new Error(`test observation artifact ${artifact.artifact_id} is not a test selector`);
    if (artifact.role !== "test" && kind === "test") throw new Error(`non-test observation role ${artifact.role} uses test selector ${artifact.artifact_id}`);
  }
}

function mergeAliasIds(a: KnowledgeNode, b: KnowledgeNode): string[] {
  return [...new Set([...((a.metadata?.alias_ids as string[] | undefined) ?? []), ...((b.metadata?.alias_ids as string[] | undefined) ?? [])])];
}

function rankCertainty(value: KnowledgeEdge["certainty"]): number {
  return value === "exact" ? 3 : value === "inferred" ? 2 : 1;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => compare(a, b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function dedupeConflicts(list: ConflictCandidate[]): ConflictCandidate[] {
  const seen = new Map<string, ConflictCandidate>();
  for (const item of list) if (!seen.has(item.id)) seen.set(item.id, item);
  return [...seen.values()].sort((a, b) => compare(a.id, b.id));
}

function measureCoverage(nodes: Map<string, KnowledgeNode>, edges: KnowledgeEdge[], dangling: Map<string, number>): CoverageRow[] {
  const rows: CoverageRow[] = [];
  const byTo = new Map<string, KnowledgeEdge[]>();
  const byFrom = new Map<string, KnowledgeEdge[]>();
  for (const edge of edges) {
    (byTo.get(edge.to_id) ?? byTo.set(edge.to_id, []).get(edge.to_id))!.push(edge);
    (byFrom.get(edge.from_id) ?? byFrom.set(edge.from_id, []).get(edge.from_id))!.push(edge);
  }
  const moduleCapabilities = new Map<string, Set<string>>();
  for (const node of nodes.values()) {
    if (node.kind !== "capability") continue;
    const modules = (byFrom.get(node.id) ?? []).filter((edge) => edge.relation === "spans").map((edge) => edge.to_id);
    for (const module of modules) (moduleCapabilities.get(module) ?? moduleCapabilities.set(module, new Set()).get(module))!.add(node.id);
    const direct = (byTo.get(node.id) ?? []).filter((edge) => edge.relation === "about" || edge.relation === "governs" || edge.relation === "bounds");
    const counts: Record<string, number> = {};
    for (const edge of direct) {
      const kind = nodes.get(edge.from_id)?.kind ?? "unknown";
      counts[kind] = (counts[kind] ?? 0) + 1;
    }
    let viaModules = 0;
    for (const module of modules) {
      viaModules += (byTo.get(module) ?? []).filter((edge) => ["governs", "realizes", "bounds", "touches", "guards", "constrains"].includes(edge.relation)).length;
    }
    for (const [kind, value] of Object.entries(counts)) rows.push({ scope_kind: "capability", scope_id: node.id, measure: `direct_${kind}`, value });
    rows.push({ scope_kind: "capability", scope_id: node.id, measure: "via_modules", value: viaModules });
    rows.push({ scope_kind: "capability", scope_id: node.id, measure: "modules", value: modules.length });
  }
  for (const node of nodes.values()) {
    if (node.kind === "module" && !moduleCapabilities.has(node.id)) {
      rows.push({ scope_kind: "module", scope_id: node.id, measure: "capabilities", value: 0, note: "no capability spans this module" });
    }
    if (node.kind === "ticket") {
      const linked = (byTo.get(node.id) ?? []).some((edge) => edge.relation === "about" && nodes.get(edge.from_id)?.kind !== "ticket");
      if (!linked) rows.push({ scope_kind: "ticket", scope_id: node.id, measure: "knowledge", value: 0, note: "no requirement, decision, landing or pattern points at this ticket" });
    }
    if (node.kind === "decision" && String(node.metadata?.adr ?? "")) {
      const realizes = (byFrom.get(node.id) ?? []).filter((edge) => edge.relation === "realizes").length;
      if (node.id.startsWith("decision:adr:")) rows.push({ scope_kind: "adr", scope_id: node.id, measure: "realizes", value: realizes });
    }
  }
  let ambiguous = 0;
  for (const node of nodes.values()) if (node.certainty === "ambiguous") ambiguous += 1;
  rows.push({ scope_kind: "graph", scope_id: "all", measure: "ambiguous_statements", value: ambiguous });
  for (const [key, value] of dangling) rows.push({ scope_kind: "graph", scope_id: "all", measure: `dangling_${key.replace(":", "_")}`, value });
  return rows;
}

export type { SourceContext };
