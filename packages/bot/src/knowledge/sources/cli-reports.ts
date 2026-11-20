import { changedBetween, introducedBy } from "../git.js";
import { clipStatement, moduleId, nodeId, pathId, statementId } from "../ids.js";
import type { KnowledgeEdge, KnowledgeNode, NodeKind, Relation } from "../model.js";
import { emptyOutput, mapLimit, type SourceContext, type SourceOutput } from "./context.js";
import { projectSpecification, specificationFor, type KnowledgeSpecification } from "../specifications.js";

interface CliReport {
  specifications?: KnowledgeSpecification[];
  changes?: import("../changes.js").KnowledgeChange[];
  version: 1 | 2 | 3;
  base_sha?: string;
  title: string;
  summary: string;
  requester: string;
  requirements?: string[];
  decisions?: string[];
  non_goals?: string[];
  risks?: string[];
  supersedes?: string[];
  verification: string[];
  acceptance: string[];
}

export function cliLandingId(introducedSha: string): string {
  return nodeId("landing", `cli:${introducedSha.slice(0, 12)}`);
}

const KIND_FIELDS: Array<[NodeKind, keyof CliReport]> = [
  ["requirement", "requirements"],
  ["decision", "decisions"],
  ["non_goal", "non_goals"],
  ["risk", "risks"],
];

/**
 * the human/CLI lane. The commit that added a report is the landing; v2 and
 * v3 reports also give the exact range (`base_sha..introduced`) and the same
 * knowledge fields the ticket lane submits. Runtime retrieval attestations
 * are deliberately not graph facts.
 */
export async function cliReportsSource(ctx: SourceContext): Promise<SourceOutput> {
  const out = emptyOutput();
  const files = (await ctx.list(["doc/cli-reports/*.json"])).filter((file) => /\/\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.json$/.test(file));
  const loaded = await mapLimit(files, 6, async (file) => {
    let report: CliReport;
    try {
      report = JSON.parse(await ctx.read(file)) as CliReport;
    } catch (error) {
      return { file, error: `unreadable report: ${String(error)}` };
    }
    const introduced = await introducedBy(ctx.git, ctx.historyRef, file);
    if (!introduced) return { file, error: "no introducing commit" };
    let changed: string[] = [];
    if ((report.version === 2 || report.version === 3) && report.base_sha) {
      try {
        changed = await changedBetween(ctx.git, report.base_sha, introduced);
      } catch (error) {
        return { file, report, introduced, changed, warning: `range unavailable: ${String(error)}` };
      }
    }
    return { file, report, introduced, changed };
  });

  for (const item of loaded) {
    if ("error" in item && item.error) {
      out.warnings.push(`${item.file}: ${item.error}`);
      continue;
    }
    if (!("report" in item) || !item.report || !item.introduced) continue;
    if ("warning" in item && item.warning) out.warnings.push(`${item.file}: ${item.warning}`);
    const { file, report, introduced, changed } = item;
    const date = /(\d{4}-\d{2}-\d{2})/.exec(file)?.[1] ?? undefined;
    const landingId = cliLandingId(introduced);
    const link = (from: string, relation: Relation, to: string, certainty: "exact" | "inferred" = "exact"): KnowledgeEdge => ({
      from_id: from,
      relation,
      to_id: to,
      method: "git",
      certainty,
      source_ref: file,
      source_sha: ctx.sha,
      observed_at: ctx.observedAt,
    });
    out.nodes.push({
      id: landingId,
      kind: "landing",
      statement: clipStatement(report.title),
      status: "active",
      authority: "derived",
      source_ref: file,
      source_sha: ctx.sha,
      valid_from: date,
      method: "git",
      certainty: "exact",
      metadata: {
        lane: "cli",
        changes: report.changes ?? [],
        version: report.version,
        introduced,
        base_sha: report.base_sha ?? null,
        requester: report.requester,
        summary: report.summary.slice(0, 400),
        acceptance: report.acceptance,
        verification: report.verification,
        changed_files: changed.length,
      },
    });
    const modules = new Set<string>();
    for (const path of changed) {
      out.nodes.push({
        id: pathId(path),
        kind: "path",
        statement: path,
        status: "active",
        authority: "derived",
        source_ref: file,
        source_sha: ctx.sha,
        method: "git",
        certainty: "exact",
      });
      out.edges.push(link(landingId, "touches", pathId(path)));
      const module = ctx.moduleForPath(path);
      if (module !== "unmapped") modules.add(module);
    }
    for (const module of modules) out.edges.push(link(landingId, "touches", moduleId(module)));

    const scope = `cli:${introduced.slice(0, 12)}`;
    for (const [kind, field] of KIND_FIELDS) {
      const values = report[field];
      if (!Array.isArray(values)) continue;
      for (const raw of values) {
        if (typeof raw !== "string" || !raw.trim()) continue;
        const statement = clipStatement(raw);
        const node: KnowledgeNode = {
          id: statementId(kind, scope, statement),
          kind,
          statement,
          status: "active",
          authority: "derived",
          source_ref: `${file}#${String(field)}`,
          source_sha: ctx.sha,
          valid_from: date,
          method: "landing",
          certainty: "exact",
          metadata: { landing: landingId, lane: "cli" },
        };
        out.nodes.push(node);
        const spec = specificationFor(report.specifications, node);
        if (spec) projectSpecification(spec, node, ctx, out);
        out.edges.push(link(landingId, "implements", node.id));
      }
    }
    report.verification?.forEach((text, index) => {
      if (typeof text !== "string" || !text.trim()) return;
      const evidenceId = nodeId("evidence", `${scope}:${index}`);
      out.nodes.push({
        id: evidenceId,
        kind: "evidence",
        statement: clipStatement(text),
        status: "active",
        authority: "derived",
        source_ref: `${file}#verification`,
        source_sha: ctx.sha,
        method: "landing",
        certainty: "exact",
      });
      out.edges.push(link(evidenceId, "evidences", landingId));
    });
    for (const change of report.changes ?? []) out.edges.push(link(landingId, "conflicts_with", change.record_id));
    for (const target of report.supersedes ?? []) {
      if (typeof target === "string" && target.trim()) out.edges.push(link(landingId, "supersedes", target.trim()));
    }
  }
  return out;
}
