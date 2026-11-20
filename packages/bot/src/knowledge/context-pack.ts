import { knowledgeStrength } from "./provenance.js";
import { repoPaths } from "./markdown.js";
import type { KnowledgeNode } from "./model.js";
import type { RetrievalTraceCollector } from "./retrieval-trace.js";
import type {
  CapabilityMatch,
  ContextSlot,
  Expansion,
  KnowledgeRetriever,
  RankedCandidate,
  RetrievalResult,
  UnknownReason,
} from "./retrieval.js";

export interface PackInput {
  title: string;
  body: string;
  spec?: string | null;
  explicitPaths?: readonly string[];
  ciRoster?: readonly string[];
}

export interface PackOptions {
  budget?: number;
  repoSha?: string;
  codeIndexSha?: string;
  inputRef?: string;
  trace?: RetrievalTraceCollector;
}

export interface PackResult extends RetrievalResult {
  included: string[];
  capabilities: CapabilityMatch[];
}

interface SlotSpec {
  slot: ContextSlot;
  title: string;
  records: number;
  chars: number;
}

export const CONTEXT_SLOT_SPECS: readonly SlotSpec[] = [
  { slot: "contract_principle", title: "契约、义务与原则", records: 3, chars: 900 },
  { slot: "scenarios", title: "适用场景", records: 3, chars: 700 },
  { slot: "sources_requirements", title: "原始来源与需求", records: 4, chars: 1050 },
  { slot: "decisions_exceptions", title: "现行决策、例外与非目标", records: 4, chars: 950 },
  { slot: "actions_symbols", title: "动作、路径与符号", records: 4, chars: 1000 },
  { slot: "tests_evidence", title: "测试与机械证据", records: 4, chars: 1000 },
  { slot: "landings_patterns", title: "落地与复发模式", records: 3, chars: 600 },
  { slot: "unknown_conflicts", title: "未知、冲突与陈旧性（禁止省略）", records: 2, chars: 700 },
] as const;

export const MAX_CONTEXT_CHARS = 7_000;

export interface ContextAssembly {
  text: string;
  chars: number;
  /** Every record the pack delivers, including those folded into a document reference. */
  slots: Readonly<Record<ContextSlot, readonly RankedCandidate[]>>;
  /** One entry per rendered line — what the bounded retrieval trace audits. */
  delivered: Readonly<Record<ContextSlot, readonly RankedCandidate[]>>;
  included: string[];
  dropped: number;
}

/** `.claude/rules/frontend-stability.md#interaction-state-ownership:25` → `frontend-stability.md:25`. */
export function shortSource(ref: string): string {
  const ticket = /^ticket:(\d+)\/landing:(\d+)/.exec(ref);
  if (ticket) return `#${ticket[1]} landing:${ticket[2]}`;
  const match = /^(.*?)(?::(\d+))?$/.exec(ref);
  const file = match?.[1] ?? ref;
  const line = match?.[2] ?? "";
  const path = file.split("#")[0];
  const parts = path.split("/");
  const tail = parts.length > 2 && /^(CLAUDE|README|DEVELOPMENT)\.md$/.test(parts.at(-1) ?? "")
    ? parts.slice(-2).join("/")
    : parts.at(-1) ?? path;
  return line ? `${tail}:${line}` : tail;
}

export function formatStatement(node: KnowledgeNode, via?: string): string {
  const certainty = node.certainty === "exact" ? "" : node.certainty === "inferred" ? "?" : "??";
  const flags = [node.authority, `${node.kind}${certainty}`, node.status !== "active" ? node.status : null, node.realization && node.realization !== "not_applicable" && node.realization !== "implemented" ? node.realization : null]
    .filter(Boolean)
    .join("/");
  const statement = node.statement.length > 220 ? `${node.statement.slice(0, 218)}…` : node.statement;
  return `- [${flags}] ${statement} ← ${shortSource(node.source_ref)}${via && !via.includes("/") ? `（经 ${via}）` : ""} ⟨${node.id}⟩`;
}

function formatCandidate(candidate: RankedCandidate): string {
  const lifecycle = candidate.node.status === "active" ? "" : `/${candidate.node.status}`;
  // A rule bullet reads as a fragment without its section; the extractor
  // keeps the heading path exactly so the pack can restore that context.
  const heading = typeof candidate.node.metadata?.heading === "string" && candidate.node.metadata.heading.trim()
    ? `【${candidate.node.metadata.heading.trim().slice(0, 60)}】`
    : "";
  const statement = candidate.node.statement.length > 230 ? `${candidate.node.statement.slice(0, 228)}…` : candidate.node.statement;
  return `- [${candidate.node.kind}/${candidate.node.authority}/${knowledgeStrength(candidate.node)}${lifecycle}] ${heading}${statement} ← ${shortSource(candidate.node.source_ref)} ⟨${candidate.id}⟩`;
}

function emptySlotLine(slot: ContextSlot): string {
  return slot === "unknown_conflicts" ? "- 无已知缺口。" : "- 无已检索到的可靠记录。";
}

function unknownLine(reason: UnknownReason): string {
  return `- ${reason.code}${reason.slot ? `（${reason.slot}）` : ""}`;
}

function blankSlots(): Record<ContextSlot, RankedCandidate[]> {
  return {
    contract_principle: [],
    scenarios: [],
    sources_requirements: [],
    decisions_exceptions: [],
    actions_symbols: [],
    tests_evidence: [],
    landings_patterns: [],
    unknown_conflicts: [],
  };
}

/**
 * A path-scoped rule under `.claude/rules` and a package document such as
 * `packages/<name>/CLAUDE.md` are both all-or-nothing: an agent that must obey
 * one of their bullets has to read the file, exactly as Claude's harness loads
 * the whole rule when a matching path is touched. Matching therefore stays at
 * bullet granularity — that is what a query actually hits — while DELIVERY
 * collapses to one citable document reference per file. Listing the bullets
 * instead spent the pack's scarcest slot on fragments that read as
 * non-sequiturs out of their section, and still did not tell the agent to read
 * the rest of the file.
 */
const DOCUMENT_SCOPED_AUTHORITIES: ReadonlySet<string> = new Set(["path_rule", "package"]);

export function governingDocumentOf(node: KnowledgeNode): string | null {
  if (!DOCUMENT_SCOPED_AUTHORITIES.has(node.authority)) return null;
  const file = node.source_ref.split("#")[0].replace(/:\d+$/u, "").trim();
  return file || null;
}

interface DeliveryGroup {
  line: string;
  /** What the group occupies a heterogeneous slot as; rule files share one. */
  kind: string;
  members: RankedCandidate[];
}

function governingDocumentLine(file: string, members: readonly RankedCandidate[]): string {
  const headings = [...new Set(members
    .map((member) => (typeof member.node.metadata?.heading === "string" ? member.node.metadata.heading.trim() : ""))
    .filter(Boolean))];
  const where = headings.length ? `：${headings.slice(0, 2).join(" / ")}${headings.length > 2 ? " 等" : ""}` : "";
  const authority = members[0]?.node.authority ?? "path_rule";
  const label = authority === "package" ? "包级文档整体适用" : "路径规则整体适用";
  return `- [doc/${authority}] ${label}，动工前读全文（命中 ${members.length} 条${where}） ← ${file} ⟨doc:${file}⟩`;
}

/** One rendered line per delivered obligation: rule files fold, everything else is itself. */
function deliveryGroups(candidates: readonly RankedCandidate[]): DeliveryGroup[] {
  const groups: DeliveryGroup[] = [];
  const byRule = new Map<string, DeliveryGroup>();
  for (const candidate of candidates) {
    const file = governingDocumentOf(candidate.node);
    if (!file) {
      groups.push({ line: formatCandidate(candidate), kind: candidate.node.kind, members: [candidate] });
      continue;
    }
    const existing = byRule.get(file);
    if (existing) {
      existing.members.push(candidate);
      existing.line = governingDocumentLine(file, existing.members);
      continue;
    }
    const group: DeliveryGroup = { line: governingDocumentLine(file, [candidate]), kind: "governing_document", members: [candidate] };
    byRule.set(file, group);
    groups.push(group);
  }
  return groups;
}

/** Fixed eight-slot pack; per-slot caps include headings and empty-state text. */
export function assembleContextPack(
  ranked: readonly RankedCandidate[],
  unknown: readonly UnknownReason[],
  requestedChars = MAX_CONTEXT_CHARS,
): ContextAssembly {
  const limit = Math.max(800, Math.min(requestedChars, MAX_CONTEXT_CHARS));
  const scale = Math.min(1, limit / MAX_CONTEXT_CHARS);
  const slots = blankSlots();
  const delivered = blankSlots();
  const sections: string[] = [];
  const included: string[] = [];
  let dropped = 0;
  for (const spec of CONTEXT_SLOT_SPECS) {
    const cap = Math.max(90, Math.floor(spec.chars * scale));
    const lines = [`### ${spec.title}`];
    let used = lines[0].length;
    if (spec.slot === "unknown_conflicts") {
      for (const reason of unknown) {
        const line = unknownLine(reason);
        if (used + line.length + 1 > cap) {
          dropped += 1;
          continue;
        }
        lines.push(line);
        used += line.length + 1;
      }
      // Superseded/conflicting records surface here so lifecycle answers can
      // cite what was replaced instead of silently omitting it.
      for (const candidate of ranked.filter((value) => value.slot === spec.slot)) {
        if (slots[spec.slot].length >= spec.records) {
          dropped += 1;
          continue;
        }
        const line = formatCandidate(candidate);
        if (used + line.length + 1 > cap) {
          dropped += 1;
          continue;
        }
        lines.push(line);
        used += line.length + 1;
        slots[spec.slot].push(candidate);
        delivered[spec.slot].push(candidate);
        included.push(candidate.id);
      }
      if (unknown.length === 0 && slots[spec.slot].length === 0) {
        const empty = emptySlotLine(spec.slot);
        if (used + empty.length + 1 <= cap) lines.push(empty);
      }
    } else {
      const groups = deliveryGroups(ranked.filter((candidate) => candidate.slot === spec.slot));
      const kindCounts = new Map<string, number>();
      // The cap counts delivered LINES, not matched records: a rule file is one
      // obligation however many of its bullets matched.
      let rendered = 0;
      for (const group of groups) {
        if (rendered >= spec.records) {
          dropped += group.members.length;
          continue;
        }
        // The contract slot is heterogeneous by design: three rows of the same
        // kind (three capabilities) crowd out the governing principle or
        // obligation, so one kind may take at most two of its seats.
        if (spec.slot === "contract_principle" && (kindCounts.get(group.kind) ?? 0) >= 2) {
          dropped += group.members.length;
          continue;
        }
        if (used + group.line.length + 1 > cap) {
          dropped += group.members.length;
          continue;
        }
        kindCounts.set(group.kind, (kindCounts.get(group.kind) ?? 0) + 1);
        lines.push(group.line);
        used += group.line.length + 1;
        rendered += 1;
        // Slot membership and `included` stay record-level: the trace, the
        // acknowledgement set and journey grading all reason about records.
        slots[spec.slot].push(...group.members);
        delivered[spec.slot].push(group.members[0]);
        included.push(...group.members.map((member) => member.id));
      }
      if (slots[spec.slot].length === 0) {
        const empty = emptySlotLine(spec.slot);
        if (used + empty.length + 1 <= cap) lines.push(empty);
      }
    }
    sections.push(lines.join("\n"));
  }
  let text = sections.join("\n");
  if (text.length > limit) text = text.slice(0, limit);
  return { text, chars: text.length, slots, delivered, included, dropped };
}

function graphSha(retriever: KnowledgeRetriever, explicit?: string): string {
  const candidate = explicit ?? String(retriever.graph.meta().commit ?? "");
  if (!/^[0-9a-f]{40}$/u.test(candidate)) throw new Error("knowledge retrieval requires an exact repository SHA");
  return candidate;
}

/** Ticket startup adapter over the one typed query path. */
export async function buildStartupPack(retriever: KnowledgeRetriever, input: PackInput, options: PackOptions = {}): Promise<PackResult> {
  const text = [input.title, input.body, input.spec ?? ""].join("\n");
  const paths = [...new Set([...(input.explicitPaths ?? []), ...(input.ciRoster ?? []), ...repoPaths(text)])];
  const result = await retriever.retrieve({
    text,
    inputRef: options.inputRef,
    paths,
    repoSha: graphSha(retriever, options.repoSha),
    codeIndexSha: options.codeIndexSha,
    filters: { lifecycle: "current" },
    budget: { chars: options.budget ?? MAX_CONTEXT_CHARS, rawCandidates: 80, rankedCandidates: 32 },
    trace: options.trace,
  });
  return { ...result, included: result.ranked.filter((candidate) => Object.values(result.slots).some((values) => values.some((value) => value.id === candidate.id))).map((candidate) => candidate.id), capabilities: result.classifications };
}

/** Mid-task path/question adapter over the same typed query path. */
export async function buildPathContext(
  retriever: KnowledgeRetriever,
  paths: readonly string[],
  question?: string,
  options: PackOptions = {},
): Promise<PackResult> {
  const result = await retriever.retrieve({
    text: question,
    inputRef: options.inputRef,
    paths,
    repoSha: graphSha(retriever, options.repoSha),
    codeIndexSha: options.codeIndexSha,
    filters: { lifecycle: "current" },
    budget: { chars: options.budget ?? MAX_CONTEXT_CHARS, rawCandidates: 80, rankedCandidates: 32 },
    trace: options.trace,
  });
  return { ...result, included: Object.values(result.slots).flat().map((candidate) => candidate.id), capabilities: result.classifications };
}

export interface AcknowledgementSet {
  principles: KnowledgeNode[];
  constraints: KnowledgeNode[];
  nonGoals: KnowledgeNode[];
}

/** Submit checks consume the exact graph expansion, never similarity candidates. */
export function acknowledgementSet(retriever: KnowledgeRetriever, changedFiles: readonly string[]): AcknowledgementSet {
  const expansion = retriever.expandFromPaths(changedFiles);
  const exact = (nodes: KnowledgeNode[]) => nodes.filter((node) => node.certainty === "exact" && node.authority !== "always_on" && node.authority !== "record");
  return {
    principles: exact(expansion.principles),
    constraints: exact(expansion.constraints),
    nonGoals: exact(expansion.nonGoals.filter((node) => node.status === "active")),
  };
}

export interface SubmitDigest {
  nonGoals: KnowledgeNode[];
  principles: number;
  constraints: number;
}

const HAN_RUN = /\p{Script=Han}+/gu;
const LATIN_TOKEN = /[A-Za-z][A-Za-z0-9_.\-]{2,}/g;

export function queryTerms(text: string, top = 60): string[] {
  const normalized = text.normalize("NFKC").toLowerCase();
  const counts = new Map<string, number>();
  const bump = (term: string) => counts.set(term, (counts.get(term) ?? 0) + 1);
  for (const match of normalized.matchAll(LATIN_TOKEN)) bump(match[0]);
  for (const match of normalized.matchAll(HAN_RUN)) {
    for (let index = 0; index + 3 <= match[0].length; index += 1) bump(match[0].slice(index, index + 3));
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, top).map(([term]) => term);
}

export function relevance(text: string, terms: readonly string[]): number {
  const haystack = text.normalize("NFKC").toLowerCase();
  let hits = 0;
  for (const term of terms) if (haystack.includes(term)) hits += 1;
  return hits;
}

export function submitDigest(
  ack: AcknowledgementSet,
  knowledge: { text: string; acknowledged: ReadonlySet<string>; ticket?: number },
  options: { minOverlap?: number; limit?: number } = {},
): SubmitDigest {
  const minOverlap = options.minOverlap ?? 3;
  const limit = options.limit ?? 6;
  const terms = queryTerms(knowledge.text, 80);
  const nonGoals = ack.nonGoals
    .filter((node) => {
      const metadata = node.metadata ?? {};
      const ownTicket = knowledge.ticket != null && (metadata.ticket_id === knowledge.ticket || metadata.ticket === knowledge.ticket);
      return node.status === "active" && !knowledge.acknowledged.has(node.id) && !ownTicket;
    })
    .map((node, index) => ({ node, index, score: relevance(node.statement, terms) }))
    .filter((item) => item.score >= minOverlap)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((item) => item.node);
  return { nonGoals, principles: ack.principles.length, constraints: ack.constraints.length };
}

/** Round-robin over source documents so a long source cannot fill a slot. */
export function diversify(nodes: readonly KnowledgeNode[], limit: number, perSource: number): KnowledgeNode[] {
  const groups = new Map<string, KnowledgeNode[]>();
  for (const node of nodes) {
    const key = node.source_ref.split("#")[0];
    const group = groups.get(key);
    if (group) group.push(node);
    else groups.set(key, [node]);
  }
  const output: KnowledgeNode[] = [];
  for (let round = 0; output.length < limit && round < perSource; round += 1) {
    for (const group of groups.values()) {
      const node = group[round];
      if (node && output.length < limit) output.push(node);
    }
  }
  return output;
}

export function viaLabel(expansion: Expansion, id: string): string | undefined {
  const first = [...(expansion.via.get(id) ?? [])][0];
  return first?.replace(/^(module|capability|path):/, "");
}
