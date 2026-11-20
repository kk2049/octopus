import { clipStatement, moduleId, nodeId, pathId, statementId, ticketId } from "../ids.js";
import { bullets, headingSlug, parseFrontmatter, repoPaths, sections, ticketRefs } from "../markdown.js";
import type { KnowledgeNode, NodeKind, NodeStatus, Realization } from "../model.js";
import { emptyOutput, mapLimit, type SourceContext, type SourceOutput } from "./context.js";
import { anchorEdge, firstHeading } from "./rules.js";

export interface AdrLifecycle {
  decision_status: "proposed" | "accepted" | "rejected" | "superseded";
  realization_status: Realization;
  supersedes: string[];
  superseded_by: string[];
  tickets: number[];
  anchors: string[];
  evidence: Array<{ path?: string; command?: string; label?: string }>;
  /** `frontmatter` when the ADR carries the dual-axis header, `legacy` when parsed from the status bullet. */
  source: "frontmatter" | "legacy";
}

/**
 * Dual-axis lifecycle (doc/development/2026-08-20-knowledge-graph-redesign.md
 * §5.1): whether the decision holds and whether the code realises it are
 * different questions. Frontmatter wins; without it the free-text status
 * bullet is interpreted and flagged as `legacy`.
 */
export function adrLifecycle(text: string): AdrLifecycle {
  const { data, body } = parseFrontmatter(text);
  if (typeof data.decision_status === "string") {
    return {
      decision_status: asDecision(data.decision_status),
      realization_status: asRealization(typeof data.realization_status === "string" ? data.realization_status : ""),
      supersedes: list(data.supersedes),
      superseded_by: list(data.superseded_by),
      tickets: list(data.tickets).map(Number).filter((value) => Number.isInteger(value) && value > 0),
      anchors: list(data.anchors),
      evidence: Array.isArray(data.evidence) ? data.evidence.map(parseEvidence) : [],
      source: "frontmatter",
    };
  }
  const statusLine = body
    .split(/\r?\n/)
    .slice(0, 20)
    .find((line) => /^-\s*状态\s*[:：]/.test(line) || /^-\s*status\s*[:：]/i.test(line)) ?? "";
  const lower = statusLine.toLowerCase();
  let decision: AdrLifecycle["decision_status"] = "proposed";
  if (/拒绝|rejected/.test(lower)) decision = "rejected";
  else if (/已取代|superseded/.test(lower)) decision = "superseded";
  else if (/未接受|proposed|草案/.test(lower)) decision = "proposed";
  else if (/已接受|已采纳|accepted|已实施|已实现|implemented/.test(lower)) decision = "accepted";
  let realization: Realization = "not_applicable";
  if (/尚未实施|不产生代码|未实施|not implemented/.test(lower)) realization = "planned";
  else if (/部分|partial/.test(lower)) realization = "partial";
  else if (/已实施|已实现|implemented|并实现/.test(lower)) realization = "implemented";
  else if (decision === "accepted") realization = "planned";
  return {
    decision_status: decision,
    realization_status: realization,
    supersedes: [],
    superseded_by: [],
    tickets: ticketRefs(body.split(/\r?\n/).slice(0, 25).join("\n")),
    anchors: [],
    evidence: [],
    source: "legacy",
  };
}

function asDecision(value: string): AdrLifecycle["decision_status"] {
  const lower = value.trim().toLowerCase();
  if (lower === "accepted" || lower === "rejected" || lower === "superseded" || lower === "proposed") return lower;
  return "proposed";
}

function asRealization(value: string): Realization {
  const lower = value.trim().toLowerCase();
  if (lower === "planned" || lower === "partial" || lower === "implemented" || lower === "not_applicable") return lower;
  return "not_applicable";
}

function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function parseEvidence(value: unknown): { path?: string; command?: string; label?: string } {
  if (typeof value === "string") return value.includes(" ") ? { command: value } : { path: value };
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return {
      path: typeof record.path === "string" ? record.path : undefined,
      command: typeof record.command === "string" ? record.command : undefined,
      label: typeof record.label === "string" ? record.label : undefined,
    };
  }
  return {};
}

/** `0009-runner.md` → `0009`; date-named ADRs (`2026-08-15-topic.md`) keep their full slug so two of them never collide. */
export function adrNumber(file: string): string {
  const numbered = /doc\/adr\/(\d{4})-(?!\d{2}-\d{2}-)/.exec(file);
  return numbered ? numbered[1] : file.replace(/^doc\/adr\//, "").replace(/\.md$/, "");
}

const SECTION_KIND: Array<[RegExp, NodeKind | "rejected"]> = [
  [/拒绝|替代|被拒|rejected|alternative/i, "rejected"],
  [/非目标|不做|不在范围|non-goal|out of scope/i, "non_goal"],
  [/原则|不变量|invariant|principle|规则/i, "principle"],
  [/风险|risk/i, "risk"],
  [/决定|决策|裁决|结果|后果|decision|consequence|result|契约|contract|边界|boundar/i, "decision"],
];

function nodeStatus(decision: AdrLifecycle["decision_status"]): NodeStatus {
  return decision === "accepted" ? "active" : decision;
}

/**
 * One decision node per ADR (the title is the decision), plus one node per
 * bullet in its decision / principle / non-goal / rejected-alternative
 * sections. Rejected alternatives are decision nodes with status `rejected`
 * linked through `rejects`.
 */
export async function adrSource(ctx: SourceContext): Promise<SourceOutput> {
  const out = emptyOutput();
  const files = await ctx.list(["doc/adr/*.md"]);
  const parsed = await mapLimit(files, 8, async (file) => ({ file, text: await ctx.read(file) }));
  for (const { file, text } of parsed) {
    if (/\/README\.md$/.test(file)) continue;
    const lifecycle = adrLifecycle(text);
    const number = adrNumber(file);
    const mainId = nodeId("decision", `adr:${number}`);
    const status = nodeStatus(lifecycle.decision_status);
    const title = firstHeading(text) ?? file;
    const main: KnowledgeNode = {
      id: mainId,
      kind: "decision",
      statement: clipStatement(title),
      status,
      authority: "adr",
      realization: lifecycle.realization_status,
      source_ref: file,
      source_sha: ctx.sha,
      method: lifecycle.source === "frontmatter" ? "declared" : "parsed",
      certainty: lifecycle.source === "frontmatter" ? "exact" : "inferred",
      aliases: [`ADR ${number}`, `ADR${number}`],
      metadata: { adr: number, lifecycle },
    };
    out.nodes.push(main);
    const docNode: KnowledgeNode = {
      id: nodeId("doc", file),
      kind: "doc",
      statement: clipStatement(title),
      status,
      authority: "adr",
      source_ref: file,
      source_sha: ctx.sha,
      method: "parsed",
      certainty: "exact",
      metadata: { role: "adr", adr: number },
    };
    out.nodes.push(docNode);
    out.edges.push(anchorEdge(ctx, docNode.id, mainId, file));
    if (lifecycle.source === "legacy") {
      out.coverage.push({ scope_kind: "adr", scope_id: file, measure: "legacy_status", value: 1, note: "status parsed from free text; add frontmatter" });
    }

    for (const other of lifecycle.supersedes) {
      out.edges.push(edge(ctx, mainId, "supersedes", nodeId("decision", `adr:${other.padStart(4, "0")}`), file, "exact"));
    }
    for (const other of lifecycle.superseded_by) {
      out.edges.push(edge(ctx, nodeId("decision", `adr:${other.padStart(4, "0")}`), "supersedes", mainId, file, "exact"));
    }
    for (const ticket of lifecycle.tickets) {
      out.edges.push(edge(ctx, mainId, "about", ticketId(ticket), file, lifecycle.source === "frontmatter" ? "exact" : "inferred"));
    }

    const realizedPaths = new Set<string>(lifecycle.anchors);
    for (const section of sections(text)) {
      const sectionKind = SECTION_KIND.find(([pattern]) => pattern.test(section.title))?.[1];
      if (/现状实现|实现|关键文件|anchors|落地|implementation/i.test(section.title)) {
        for (const path of repoPaths(section.lines.join("\n"))) realizedPaths.add(path);
      }
      if (!sectionKind || section.level === 0) continue;
      const anchor = `${file}#${headingSlug(section.title)}`;
      for (const bullet of bullets(section.lines)) {
        if (bullet.text.length < 12) continue;
        const kind: NodeKind = sectionKind === "rejected" ? "decision" : sectionKind;
        const statement = clipStatement(bullet.text);
        const node: KnowledgeNode = {
          id: statementId(kind, anchor, statement),
          kind,
          statement,
          status: sectionKind === "rejected" ? "rejected" : status,
          authority: "adr",
          source_ref: `${anchor}:${section.startLine + bullet.line + 2}`,
          source_sha: ctx.sha,
          method: "parsed",
          certainty: "exact",
          metadata: { adr: number, heading: section.headingPath.join(" / "), rejected_alternative: sectionKind === "rejected" },
        };
        out.nodes.push(node);
        out.edges.push(anchorEdge(ctx, docNode.id, node.id, file));
        out.edges.push(edge(ctx, mainId, sectionKind === "rejected" ? "rejects" : "motivates", node.id, file, "exact"));
        for (const path of repoPaths(bullet.text)) realizedPaths.add(path);
      }
    }

    for (const path of realizedPaths) {
      out.edges.push(edge(ctx, mainId, "realizes", pathId(path), file, lifecycle.source === "frontmatter" ? "exact" : "inferred"));
      const module = ctx.moduleForPath(path);
      if (module !== "unmapped") out.edges.push(edge(ctx, mainId, "realizes", moduleId(module), file, "inferred"));
      out.nodes.push({
        id: pathId(path),
        kind: "path",
        statement: path,
        status: "active",
        authority: "derived",
        source_ref: file,
        source_sha: ctx.sha,
        method: "parsed",
        certainty: "inferred",
      });
    }
    lifecycle.evidence.forEach((item, index) => {
      const evidenceId = nodeId("evidence", `adr:${number}:${index}`);
      out.nodes.push({
        id: evidenceId,
        kind: "evidence",
        statement: clipStatement(item.label ?? item.path ?? item.command ?? `ADR ${number} evidence ${index}`),
        status: "active",
        authority: "adr",
        source_ref: file,
        source_sha: ctx.sha,
        method: "declared",
        certainty: "exact",
        metadata: { path: item.path, command: item.command },
      });
      out.edges.push(edge(ctx, evidenceId, "evidences", mainId, file, "exact"));
    });
    out.coverage.push({ scope_kind: "adr", scope_id: file, measure: "realizes_edges", value: realizedPaths.size });
  }
  return out;
}

function edge(
  ctx: SourceContext,
  from: string,
  relation: "supersedes" | "about" | "realizes" | "rejects" | "motivates" | "evidences",
  to: string,
  file: string,
  certainty: "exact" | "inferred",
) {
  return {
    from_id: from,
    relation,
    to_id: to,
    method: "parsed" as const,
    certainty,
    source_ref: file,
    source_sha: ctx.sha,
    observed_at: ctx.observedAt,
  };
}
