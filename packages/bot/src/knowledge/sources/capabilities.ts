import { capabilityId, clipStatement, moduleId, nodeId, pathId } from "../ids.js";
import type { KnowledgeEdge, Relation } from "../model.js";
import { emptyOutput, type SourceContext, type SourceOutput } from "./context.js";

export const CAPABILITIES_FILE = "architecture/capabilities.json";

export interface CapabilityDef {
  id: string;
  kind: "product" | "concern";
  label: string;
  description: string;
  aliases: string[];
  modules: string[];
  paths?: string[];
  constraints?: string[];
  docs?: string[];
  parent?: string;
}

export interface CapabilitiesDoc {
  version: 1;
  capabilities: CapabilityDef[];
}

const ID_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)?$/;

/**
 * Structural validation mirrors `architecture/capabilities.schema.json` and
 * additionally checks referential integrity against the atlas. Errors are
 * build failures: the taxonomy is a curated authority file.
 */
export function validateCapabilities(raw: unknown, knownModules: ReadonlySet<string>, knownConstraints: ReadonlySet<string>): { doc: CapabilitiesDoc; errors: string[] } {
  const errors: string[] = [];
  const doc = raw as CapabilitiesDoc;
  if (!doc || typeof doc !== "object" || doc.version !== 1 || !Array.isArray(doc.capabilities)) {
    return { doc: { version: 1, capabilities: [] }, errors: ["capabilities.json must be {version: 1, capabilities: []}"] };
  }
  const seen = new Set<string>();
  for (const cap of doc.capabilities) {
    const where = `capability ${String(cap?.id)}`;
    if (!cap || typeof cap.id !== "string" || !ID_PATTERN.test(cap.id)) errors.push(`${where}: invalid id`);
    else if (seen.has(cap.id)) errors.push(`${where}: duplicate id`);
    else seen.add(cap.id);
    if (cap.kind !== "product" && cap.kind !== "concern") errors.push(`${where}: kind must be product|concern`);
    if (typeof cap.label !== "string" || !cap.label.trim() || cap.label.length > 60) errors.push(`${where}: label 1-60 chars`);
    if (typeof cap.description !== "string" || !cap.description.trim() || cap.description.length > 400) errors.push(`${where}: description 1-400 chars`);
    if (!Array.isArray(cap.aliases) || !cap.aliases.length || cap.aliases.some((alias) => typeof alias !== "string" || alias.length < 2 || alias.length > 40)) {
      errors.push(`${where}: aliases must be 1-40 strings of 2-40 chars`);
    }
    if (!Array.isArray(cap.modules)) errors.push(`${where}: modules must be an array`);
    else for (const module of cap.modules) if (!knownModules.has(module)) errors.push(`${where}: unknown module ${module}`);
    for (const constraint of cap.constraints ?? []) if (!knownConstraints.has(constraint)) errors.push(`${where}: unknown constraint ${constraint}`);
  }
  for (const cap of doc.capabilities) {
    if (cap?.parent && !seen.has(cap.parent)) errors.push(`capability ${cap.id}: unknown parent ${cap.parent}`);
  }
  return { doc, errors };
}

export async function loadCapabilities(ctx: SourceContext): Promise<{ doc: CapabilitiesDoc; errors: string[] }> {
  let text: string;
  try {
    text = await ctx.read(CAPABILITIES_FILE);
  } catch {
    return { doc: { version: 1, capabilities: [] }, errors: [`${CAPABILITIES_FILE} is missing at ${ctx.sha.slice(0, 10)}`] };
  }
  const knownModules = new Set(ctx.modules.map((module) => module.id));
  const knownConstraints = new Set((ctx.atlas.constraints ?? []).map((constraint) => constraint.id));
  return validateCapabilities(JSON.parse(text), knownModules, knownConstraints);
}

export async function capabilitiesSource(ctx: SourceContext): Promise<SourceOutput> {
  const out = emptyOutput();
  const { doc, errors } = await loadCapabilities(ctx);
  if (errors.length) throw new Error(`capabilities.json invalid:\n${errors.map((error) => `  - ${error}`).join("\n")}`);
  const link = (from: string, relation: Relation, to: string): KnowledgeEdge => ({
    from_id: from,
    relation,
    to_id: to,
    method: "declared",
    certainty: "exact",
    source_ref: CAPABILITIES_FILE,
    source_sha: ctx.sha,
    observed_at: ctx.observedAt,
  });
  for (const cap of doc.capabilities) {
    const id = capabilityId(cap.id);
    out.nodes.push({
      id,
      kind: "capability",
      statement: clipStatement(`${cap.label}：${cap.description}`),
      status: "active",
      authority: "declared",
      source_ref: CAPABILITIES_FILE,
      source_sha: ctx.sha,
      method: "declared",
      certainty: "exact",
      aliases: [cap.id, cap.label, ...cap.aliases],
      metadata: { kind: cap.kind, modules: cap.modules, paths: cap.paths ?? [], constraints: cap.constraints ?? [], docs: cap.docs ?? [] },
    });
    for (const module of cap.modules) out.edges.push(link(id, "spans", moduleId(module)));
    for (const path of cap.paths ?? []) {
      out.nodes.push({
        id: pathId(path),
        kind: "path",
        statement: path,
        status: "active",
        authority: "declared",
        source_ref: CAPABILITIES_FILE,
        source_sha: ctx.sha,
        method: "declared",
        certainty: "exact",
      });
      out.edges.push(link(id, "spans", pathId(path)));
    }
    for (const constraint of cap.constraints ?? []) out.edges.push(link(id, "constrained_by", nodeId("constraint", constraint)));
    for (const docPath of cap.docs ?? []) {
      out.nodes.push({
        id: nodeId("doc", docPath),
        kind: "doc",
        statement: docPath,
        status: "active",
        authority: "declared",
        source_ref: CAPABILITIES_FILE,
        source_sha: ctx.sha,
        method: "declared",
        certainty: "exact",
        metadata: { role: "capability doc" },
      });
      out.edges.push(link(id, "documented_by", nodeId("doc", docPath)));
      const adr = /^doc\/adr\/(\d{4})-(?!\d{2}-\d{2}-)/.exec(docPath)?.[1]
        ?? (docPath.startsWith("doc/adr/") ? docPath.replace(/^doc\/adr\//, "").replace(/\.md$/, "") : null);
      if (adr) out.edges.push(link(nodeId("decision", `adr:${adr}`), "about", id));
    }
    if (cap.parent) out.edges.push(link(capabilityId(cap.parent), "parent_of", id));
  }
  return out;
}
