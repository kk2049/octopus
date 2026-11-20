import { capabilityId, clipStatement, moduleId, nodeId, pathId, ticketId } from "../ids.js";
import type { KnowledgeEdge, Relation } from "../model.js";
import { emptyOutput, type SourceContext, type SourceOutput } from "./context.js";

export const PATTERNS_FILE = "architecture/knowledge/patterns.jsonl";

export interface PatternRecord {
  id: string;
  title: string;
  detail: string;
  capabilities: string[];
  tickets: number[];
  modules?: string[];
  paths?: string[];
  tests?: string[];
  mandatory_facts?: string[];
  false_positive?: string;
  confidence?: number;
}

export function validatePattern(record: unknown, known: { capabilities: ReadonlySet<string>; modules: ReadonlySet<string> }): string[] {
  const errors: string[] = [];
  if (!record || typeof record !== "object") return ["pattern must be an object"];
  const r = record as Partial<PatternRecord>;
  if (typeof r.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(r.id)) errors.push("id must be kebab-case");
  if (typeof r.title !== "string" || !r.title.trim() || r.title.length > 120) errors.push("title 1-120 chars");
  if (typeof r.detail !== "string" || !r.detail.trim() || r.detail.length > 400) errors.push("detail 1-400 chars");
  if (!Array.isArray(r.capabilities) || !r.capabilities.length) errors.push("capabilities required");
  else for (const cap of r.capabilities) if (!known.capabilities.has(cap)) errors.push(`unknown capability ${cap}`);
  if (!Array.isArray(r.tickets) || r.tickets.length < 2) errors.push("a pattern needs at least two tickets");
  for (const module of r.modules ?? []) if (!known.modules.has(module)) errors.push(`unknown module ${module}`);
  if (r.confidence !== undefined && (typeof r.confidence !== "number" || r.confidence < 0 || r.confidence > 1)) errors.push("confidence 0-1");
  return errors;
}

/**
 * Recurrence patterns are derived knowledge: a human-reviewed cluster over
 * tickets that says which facts the next similar ticket must capture. They
 * are context in the startup pack and never gate a landing.
 */
export async function patternsSource(ctx: SourceContext, known: { capabilities: ReadonlySet<string> }): Promise<SourceOutput> {
  const out = emptyOutput();
  let text: string;
  try {
    text = await ctx.read(PATTERNS_FILE);
  } catch {
    return out;
  }
  const modules = new Set(ctx.modules.map((module) => module.id));
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  lines.forEach((line, index) => {
    let record: PatternRecord;
    try {
      record = JSON.parse(line) as PatternRecord;
    } catch {
      throw new Error(`${PATTERNS_FILE}:${index + 1}: invalid JSON`);
    }
    const errors = validatePattern(record, { capabilities: known.capabilities, modules });
    if (errors.length) throw new Error(`${PATTERNS_FILE}:${index + 1}: ${errors.join("; ")}`);
    const id = nodeId("pattern", record.id);
    const link = (from: string, relation: Relation, to: string): KnowledgeEdge => ({
      from_id: from,
      relation,
      to_id: to,
      method: "curated",
      certainty: "exact",
      source_ref: `${PATTERNS_FILE}:${index + 1}`,
      source_sha: ctx.sha,
      observed_at: ctx.observedAt,
    });
    out.nodes.push({
      id,
      kind: "pattern",
      statement: clipStatement(record.title),
      status: "active",
      authority: "curated",
      source_ref: `${PATTERNS_FILE}:${index + 1}`,
      source_sha: ctx.sha,
      method: "curated",
      certainty: "inferred",
      aliases: [record.id],
      metadata: {
        detail: record.detail,
        mandatory_facts: record.mandatory_facts ?? [],
        false_positive: record.false_positive ?? null,
        tests: record.tests ?? [],
        tickets: record.tickets,
        confidence: record.confidence ?? null,
      },
    });
    for (const cap of record.capabilities) out.edges.push(link(id, "about", capabilityId(cap)));
    for (const ticket of record.tickets) out.edges.push(link(id, "observed_in", ticketId(ticket)));
    for (const module of record.modules ?? []) out.edges.push(link(id, "guards", moduleId(module)));
    for (const path of record.paths ?? []) {
      out.nodes.push({ id: pathId(path), kind: "path", statement: path, status: "active", authority: "derived", source_ref: PATTERNS_FILE, source_sha: ctx.sha, method: "curated", certainty: "inferred" });
      out.edges.push(link(id, "guards", pathId(path)));
    }
    for (const test of record.tests ?? []) {
      const evidenceId = nodeId("evidence", `test:${test}`);
      out.nodes.push({ id: evidenceId, kind: "evidence", statement: test, status: "active", authority: "derived", source_ref: PATTERNS_FILE, source_sha: ctx.sha, method: "curated", certainty: "inferred", metadata: { path: test } });
      out.edges.push(link(evidenceId, "evidences", id));
    }
  });
  return out;
}
