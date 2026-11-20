import { clipStatement, moduleId, nodeId, pathId } from "../ids.js";
import type { KnowledgeEdge, KnowledgeNode, Relation } from "../model.js";
import { emptyOutput, type SourceContext, type SourceOutput } from "./context.js";

const ATLAS = "architecture/atlas.json";

/**
 * The declared architecture vocabulary is reused verbatim: zones, modules,
 * flows and constraints keep their atlas ids. The graph never re-derives code
 * structure; that is the Observatory's job.
 */
export async function atlasSource(ctx: SourceContext): Promise<SourceOutput> {
  const out = emptyOutput();
  const atlas = ctx.atlas;
  const link = (from: string, relation: Relation, to: string, certainty: "exact" | "inferred" = "exact"): KnowledgeEdge => ({
    from_id: from,
    relation,
    to_id: to,
    method: "declared",
    certainty,
    source_ref: ATLAS,
    source_sha: ctx.sha,
    observed_at: ctx.observedAt,
  });
  const declared = (partial: Omit<KnowledgeNode, "status" | "authority" | "source_ref" | "source_sha" | "method" | "certainty">): KnowledgeNode => ({
    status: "active",
    authority: "declared",
    source_ref: ATLAS,
    source_sha: ctx.sha,
    method: "declared",
    certainty: "exact",
    ...partial,
  });

  for (const zone of atlas.zones ?? []) {
    out.nodes.push(declared({
      id: nodeId("zone", zone.id),
      kind: "zone",
      statement: clipStatement(`${zone.label}（${zone.id}，trust=${zone.trust ?? "?"}）：${zone.description ?? ""}`),
      aliases: [zone.id, zone.label],
      metadata: { trust: zone.trust },
    }));
  }

  const moduleIds = new Set<string>();
  for (const module of ctx.modules) {
    moduleIds.add(module.id);
    out.nodes.push(declared({
      id: moduleId(module.id),
      kind: "module",
      statement: clipStatement(`${module.label}（${module.id}）：${module.description ?? ""}`),
      aliases: [module.id, module.label, ...(module.tags ?? [])],
      metadata: { zone: module.zone, criticality: module.criticality, pathPrefixes: module.pathPrefixes, tags: module.tags ?? [] },
    }));
    out.edges.push(link(moduleId(module.id), "in_zone", nodeId("zone", module.zone)));
    for (const prefix of module.pathPrefixes) {
      out.nodes.push(declared({ id: pathId(prefix), kind: "path", statement: prefix }));
      out.edges.push(link(moduleId(module.id), "owns", pathId(prefix)));
    }
    for (const doc of module.docs ?? []) {
      out.nodes.push(declared({ id: nodeId("doc", doc), kind: "doc", statement: doc, metadata: { role: "module doc" } }));
      out.edges.push(link(moduleId(module.id), "documented_by", nodeId("doc", doc)));
    }
  }

  for (const flow of atlas.flows ?? []) {
    out.nodes.push(declared({
      id: nodeId("flow", flow.id),
      kind: "flow",
      statement: clipStatement(`${flow.title}（${flow.id}，${flow.perspective ?? ""}）：${flow.description ?? ""}`),
      aliases: [flow.id, flow.title],
      metadata: { perspective: flow.perspective },
    }));
    for (const step of flow.entrySteps ?? []) {
      if (step.module && moduleIds.has(step.module)) out.edges.push(link(nodeId("flow", flow.id), "passes_through", moduleId(step.module)));
    }
  }

  for (const constraint of atlas.constraints ?? []) {
    const id = nodeId("constraint", constraint.id);
    const mechanism = constraint.mechanism ?? {};
    const commands = (constraint.evidence ?? []).flatMap((item) => (item.command ? [item.command] : []));
    out.nodes.push(declared({
      id,
      kind: "constraint",
      statement: clipStatement(`${constraint.title}（${constraint.id}）：${constraint.description ?? ""}`),
      aliases: [constraint.id, constraint.title],
      metadata: {
        concern: constraint.concern,
        severity: constraint.severity,
        mechanism,
        commands,
        evidence: constraint.evidence ?? [],
      },
    }));
    const targets = new Set<string>();
    for (const key of ["from", "to", "modules"]) {
      const value = mechanism[key];
      if (Array.isArray(value)) for (const item of value) if (typeof item === "string" && moduleIds.has(item)) targets.add(item);
    }
    if (typeof mechanism.flow === "string") {
      const flow = (atlas.flows ?? []).find((item) => item.id === mechanism.flow);
      for (const step of flow?.entrySteps ?? []) if (step.module && moduleIds.has(step.module)) targets.add(step.module);
    }
    for (const target of targets) out.edges.push(link(id, "constrains", moduleId(target)));
    (constraint.evidence ?? []).forEach((item, index) => {
      const evidenceId = nodeId("evidence", `${constraint.id}:${index}`);
      out.nodes.push(declared({
        id: evidenceId,
        kind: "evidence",
        statement: clipStatement(item.label ?? item.source?.path ?? item.command ?? `${constraint.id} evidence ${index}`),
        metadata: {
          grade: item.grade,
          path: item.source?.path,
          line: item.source?.line,
          end_line: item.source?.endLine,
          symbol: item.source?.symbol,
          command: item.command,
          document: item.document,
        },
      }));
      out.edges.push(link(evidenceId, "evidences", id));
      if (item.source?.path) {
        out.nodes.push(declared({ id: pathId(item.source.path), kind: "path", statement: item.source.path }));
        out.edges.push(link(evidenceId, "touches", pathId(item.source.path)));
      }
    });
    out.coverage.push({
      scope_kind: "constraint",
      scope_id: constraint.id,
      measure: "evidence",
      value: (constraint.evidence ?? []).length,
      note: Object.keys(mechanism).length ? undefined : "no mechanical mechanism",
    });
  }
  return out;
}
