import { capabilityId, clipStatement, moduleId, nodeId, pathId, statementKey, ticketId } from "../ids.js";
import {
  CERTAINTIES,
  MAX_QUOTE_CHARS,
  MAX_STATEMENT_CHARS,
  NODE_STATUSES,
  type CuratedRecord,
  type KnowledgeEdge,
  type Relation,
} from "../model.js";
import { loadCapabilities } from "./capabilities.js";
import { validateProvenance } from "../provenance.js";
import { emptyOutput, mapLimit, type SourceContext, type SourceOutput } from "./context.js";

export const CURATED_DIR = "architecture/knowledge/curated/";
export const CURATED_ID = /^cur:[a-z0-9][a-z0-9-]*:(?:\d+:)?\d+$/;
const KINDS = new Set(["requirement", "decision", "non_goal", "risk", "principle"]);
const SOURCE_TYPES = new Set(["ticket_body", "ticket_message", "delivery", "commit", "cli_report", "package_doc", "adr", "cli_message"]);
const REPO_PATH = /^(?:(?:packages|plugins|doc|scripts|architecture|ctl|tools|ops|\.claude|\.agents)\/[A-Za-z0-9_./-]+|[A-Za-z0-9_.-]+\.[A-Za-z0-9]+)$/;
const REF_PATTERN = /^(?:cur:[a-z0-9-]+:(?:\d+:)?\d+|landing:[A-Za-z0-9:-]+|decision:adr:[0-9-]+|(?:principle|decision|requirement|non_goal|risk):[A-Za-z0-9:._/-]+)$/;

export interface CuratedValidationContext {
  capabilities: ReadonlySet<string>;
  modules: ReadonlySet<string>;
  /** When provided, paths must exist (file) or be a directory prefix of an existing file. */
  existingPaths?: ReadonlySet<string>;
  /**
   * When provided, `certainty: exact` records must carry a verbatim `quote`
   * and the quote must occur in the cited source text (null = source text
   * unavailable, containment not checked). This is the mechanical half of
   * R6: an exact statement is one a reader can find in the evidence.
   */
  evidence?: (record: CuratedRecord) => string | null;
}

/** Whitespace-insensitive containment: agents trim and re-space quotes. */
export function quoteOccurs(quote: string, text: string): boolean {
  const squash = (value: string) => value.normalize("NFKC").replace(/[\s\u200b]+/g, "").toLowerCase();
  const needle = squash(quote);
  return needle.length >= 4 && squash(text).includes(needle);
}

/**
 * The backfill contract. Every rule here is also stated in
 * architecture/knowledge/README.md for the agents producing these files; the
 * CLI `validate-curated` command runs exactly this function.
 */
export function validateCuratedRecord(record: unknown, ctx: CuratedValidationContext): string[] {
  const errors: string[] = [];
  if (!record || typeof record !== "object" || Array.isArray(record)) return ["record must be an object"];
  const r = record as Partial<CuratedRecord> & Record<string, unknown>;
  const allowed = new Set(["id", "kind", "statement", "ticket", "source", "capabilities", "modules", "paths", "status", "supersedes", "superseded_by", "certainty", "rationale", "quote", "conflict_note", "provenance", "realized_by", "verified_by"]);
  for (const key of Object.keys(r)) if (!allowed.has(key)) errors.push(`unknown field ${key}`);
  if (typeof r.id !== "string" || !CURATED_ID.test(r.id)) errors.push("id must match cur:<batch>:<ticket>:<n> or cur:<batch>:<n>");
  if (typeof r.kind !== "string" || !KINDS.has(r.kind)) errors.push("kind must be requirement|decision|non_goal|risk|principle");
  if (typeof r.statement !== "string" || !r.statement.trim()) errors.push("statement required");
  else {
    if (r.statement.length > MAX_STATEMENT_CHARS) errors.push(`statement longer than ${MAX_STATEMENT_CHARS} chars`);
    if (/\n/.test(r.statement)) errors.push("statement must be a single line");
    if (r.statement.trim().length < 12) errors.push("statement too short to be a claim");
  }
  if (r.ticket !== undefined && (!Number.isInteger(r.ticket) || (r.ticket as number) <= 0)) errors.push("ticket must be a positive integer");
  if (!r.source || typeof r.source !== "object") errors.push("source required");
  else {
    const source = r.source as CuratedRecord["source"];
    if (!SOURCE_TYPES.has(source.type)) errors.push("source.type invalid");
    if (typeof source.ref !== "string" || !source.ref.trim()) errors.push("source.ref required");
    if (source.type === "ticket_message" && !Number.isInteger(source.message_id)) errors.push("source.message_id required for ticket_message");
    if ((source.type === "ticket_body" || source.type === "ticket_message") && r.ticket === undefined) errors.push("ticket required for ticket sources");
    if (source.path !== undefined && (typeof source.path !== "string" || !REPO_PATH.test(source.path))) errors.push("source.path must be a repository path");
    if (source.sha !== undefined && (typeof source.sha !== "string" || !/^[0-9a-f]{7,64}$/.test(source.sha))) errors.push("source.sha must be a hex sha");
  }
  if (!Array.isArray(r.capabilities) || !r.capabilities.length) errors.push("capabilities must name at least one capability");
  else for (const cap of r.capabilities) if (typeof cap !== "string" || !ctx.capabilities.has(cap)) errors.push(`unknown capability ${String(cap)}`);
  for (const module of r.modules ?? []) if (typeof module !== "string" || !ctx.modules.has(module)) errors.push(`unknown module ${String(module)}`);
  for (const path of r.paths ?? []) {
    if (typeof path !== "string" || !REPO_PATH.test(path)) {
      errors.push(`invalid path ${String(path)}`);
      continue;
    }
    if (ctx.existingPaths && !pathExists(path, ctx.existingPaths)) errors.push(`path does not exist at HEAD: ${path}`);
  }
  if (r.provenance !== undefined) errors.push(...validateProvenance(r.provenance));
  for (const field of ["realized_by", "verified_by"] as const) {
    if (r[field] !== undefined && (!Array.isArray(r[field]) || r[field]!.length > 30)) {
      errors.push(`${field} must be a bounded list`);
      continue;
    }
    for (const file of r[field] ?? []) {
      if (typeof file !== "string" || !REPO_PATH.test(file) || (ctx.existingPaths && !pathExists(file, ctx.existingPaths))) errors.push(`${field} needs existing repository paths`);
      if (field === "verified_by" && !/\.(test|spec)\.[cm]?[jt]sx?$/u.test(file)) errors.push("verified_by must name a test file");
    }
  }
  if (typeof r.status !== "string" || !(NODE_STATUSES as readonly string[]).includes(r.status)) errors.push("status invalid");
  if (r.status === "superseded" && typeof r.superseded_by !== "string") errors.push("superseded records must name superseded_by");
  if (r.superseded_by !== undefined && (typeof r.superseded_by !== "string" || !REF_PATTERN.test(r.superseded_by))) errors.push("superseded_by must reference a record id");
  for (const ref of r.supersedes ?? []) if (typeof ref !== "string" || !REF_PATTERN.test(ref)) errors.push(`supersedes reference invalid: ${String(ref)}`);
  if (typeof r.certainty !== "string" || !(CERTAINTIES as readonly string[]).includes(r.certainty)) errors.push("certainty invalid");
  if (typeof r.rationale !== "string" || !r.rationale.trim() || r.rationale.length > 200) errors.push("rationale required, ≤ 200 chars");
  if (r.quote !== undefined && (typeof r.quote !== "string" || r.quote.length > MAX_QUOTE_CHARS)) errors.push(`quote must be ≤ ${MAX_QUOTE_CHARS} chars`);
  if (r.conflict_note !== undefined && (typeof r.conflict_note !== "string" || r.conflict_note.length > 300)) errors.push("conflict_note ≤ 300 chars");
  if (r.certainty === "ambiguous" && !r.conflict_note) errors.push("ambiguous records must carry conflict_note");
  if (typeof r.statement === "string" && /(token|password|secret|密码|私钥)\s*[:=]\s*\S{6,}/i.test(r.statement)) errors.push("statement looks like a credential");
  if (ctx.evidence && r.certainty === "exact" && !errors.length) {
    const record = r as CuratedRecord;
    if (!record.quote) errors.push("exact statements need a verbatim quote (≤120 chars) from the cited source; otherwise set certainty to inferred and explain in rationale");
    else {
      const text = ctx.evidence(record);
      if (text != null && !quoteOccurs(record.quote, text)) errors.push("quote not found verbatim in the cited source");
    }
  }
  return errors;
}

export function pathExists(path: string, existing: ReadonlySet<string>): boolean {
  if (existing.has(path)) return true;
  const prefix = path.endsWith("/") ? path : `${path}/`;
  for (const candidate of existing) if (candidate.startsWith(prefix)) return true;
  return false;
}

export interface CuratedFile {
  file: string;
  records: CuratedRecord[];
  errors: string[];
}

export function parseCuratedJsonl(file: string, text: string, ctx: CuratedValidationContext): CuratedFile {
  const records: CuratedRecord[] = [];
  const errors: string[] = [];
  const seenIds = new Set<string>();
  const seenStatements = new Map<string, string>();
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      errors.push(`${file}:${index + 1}: invalid JSON`);
      return;
    }
    const problems = validateCuratedRecord(parsed, ctx);
    const record = parsed as CuratedRecord;
    if (typeof record.id === "string") {
      if (seenIds.has(record.id)) problems.push(`duplicate id ${record.id}`);
      seenIds.add(record.id);
    }
    if (typeof record.statement === "string" && typeof record.kind === "string") {
      const key = `${record.kind}:${statementKey(record.statement)}`;
      const previous = seenStatements.get(key);
      if (previous) problems.push(`duplicate statement of ${previous}; merge sources instead of repeating`);
      else seenStatements.set(key, record.id ?? `line ${index + 1}`);
    }
    if (problems.length) errors.push(...problems.map((problem) => `${file}:${index + 1}: ${problem}`));
    else records.push(record);
  });
  return { file, records, errors };
}

const KIND_RELATION: Record<CuratedRecord["kind"], Relation> = {
  requirement: "touches",
  decision: "realizes",
  non_goal: "bounds",
  risk: "touches",
  principle: "governs",
};

/** Curated backfill files become nodes with `authority=curated`; links follow the record's own certainty. */
export async function curatedSource(ctx: SourceContext): Promise<SourceOutput> {
  const out = emptyOutput();
  const files = await ctx.list([`${CURATED_DIR}*.jsonl`]);
  if (!files.length) return out;
  const { doc } = await loadCapabilities(ctx);
  const validation: CuratedValidationContext = {
    capabilities: new Set(doc.capabilities.map((cap) => cap.id)),
    modules: new Set(ctx.modules.map((module) => module.id)),
  };
  const parsed = await mapLimit(files, 8, async (file) => parseCuratedJsonl(file, await ctx.read(file), validation));
  const errors = parsed.flatMap((item) => item.errors);
  if (errors.length) throw new Error(`curated knowledge invalid:\n${errors.slice(0, 40).map((error) => `  - ${error}`).join("\n")}${errors.length > 40 ? `\n  … ${errors.length - 40} more` : ""}`);

  for (const { file, records } of parsed) {
    for (const record of records) {
      const id = nodeId(record.kind, record.id);
      const certainty = record.certainty;
      const link = (from: string, relation: Relation, to: string, edgeCertainty = certainty): KnowledgeEdge => ({
        from_id: from,
        relation,
        to_id: to,
        method: "curated",
        certainty: edgeCertainty,
        source_ref: `${file}#${record.id}`,
        source_sha: ctx.sha,
        observed_at: ctx.observedAt,
      });
      const sourceRef = record.source.path
        ? record.source.path
        : record.source.message_id
          ? `${record.source.ref}#message:${record.source.message_id}`
          : record.source.ref;
      out.nodes.push({
        id,
        kind: record.kind,
        statement: clipStatement(record.statement),
        status: record.status,
        authority: "curated",
        source_ref: sourceRef,
        // CLI message digests identify private evidence, not a Git revision.
        // Keep them in metadata.source; contextual index identities use Git SHAs.
        source_sha: record.source.type === "cli_message" ? ctx.sha : record.source.sha ?? ctx.sha,
        method: "curated",
        certainty,
        metadata: {
          curated_id: record.id,
          scope: {capabilities:record.capabilities,modules:record.modules ?? [],paths:record.paths ?? []},
          alias_ids: [record.id],
          batch: file,
          ticket: record.ticket ?? null,
          source: record.source,
          rationale: record.rationale,
          quote: record.quote ?? null,
          conflict_note: record.conflict_note ?? null,
          superseded_by: record.superseded_by ?? null,
          provenance: record.provenance,
        },
      });
      for (const cap of record.capabilities) out.edges.push(link(id, record.kind === "non_goal" ? "bounds" : record.kind === "principle" ? "governs" : "about", capabilityId(cap)));
      for (const module of record.modules ?? []) out.edges.push(link(id, KIND_RELATION[record.kind], moduleId(module)));
      for (const relation of ["realized_by", "verified_by"] as const) {
        for (const file of record[relation] ?? []) {
          const artifact = nodeId("artifact", `knowledge/${relation}/${file}`);
          out.nodes.push({ id: artifact, kind: "artifact", statement: file, status: "active", authority: "declared", source_ref: file, source_sha: ctx.sha, method: "curated", certainty: "exact", metadata: { path: file, kind: relation === "verified_by" ? "test" : "symbol", artifact_role: relation === "verified_by" ? "test" : "handler" } });
          out.edges.push(link(id, relation, artifact, "exact"));
        }
      }
      for (const path of record.paths ?? []) {
        out.nodes.push({
          id: pathId(path),
          kind: "path",
          statement: path,
          status: "active",
          authority: "derived",
          source_ref: `${file}#${record.id}`,
          source_sha: ctx.sha,
          method: "curated",
          certainty,
        });
        out.edges.push(link(id, KIND_RELATION[record.kind], pathId(path)));
      }
      if (record.ticket) out.edges.push(link(id, "about", ticketId(record.ticket), "exact"));
      for (const target of record.supersedes ?? []) out.edges.push(link(id, "supersedes", resolveRef(target)));
      if (record.superseded_by) out.edges.push(link(resolveRef(record.superseded_by), "supersedes", id));
    }
  }
  return out;
}

/** `cur:…` references name a curated record whose node kind is unknown here; the build resolves them through alias ids. */
export function resolveRef(ref: string): string {
  return ref;
}
