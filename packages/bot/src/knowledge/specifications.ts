import type { KnowledgeNode } from "./model.js";
import { moduleId, nodeId, pathId } from "./ids.js";
import type { SourceContext, SourceOutput } from "./sources/context.js";
import { knowledgeDesignKey, knowledgeStrength, validateProvenance, type KnowledgeProvenance, type KnowledgeStrength } from "./provenance.js";

/** One authored specification per submitted requirement/decision, stored in the immutable landing payload. */
export interface KnowledgeSpecification {
  kind: "requirement" | "decision";
  statement: string;
  strength: KnowledgeStrength;
  provenance: KnowledgeProvenance;
  realized_by: string[];
  verified_by: string[];
  /** Only documentation/test-only landings may explicitly omit executable verification. */
  verification_note?: string;
}

const boundedText = { type: "string", minLength: 1, maxLength: 400 } as const;
const paths = { type: "array", maxItems: 30, items: boundedText } as const;
export const SPECIFICATIONS_SCHEMA = {
  type: "array", minItems: 1, maxItems: 40,
  items: {
    type: "object", additionalProperties: false,
    required: ["kind", "statement", "strength", "provenance", "realized_by", "verified_by"],
    properties: {
      kind: { type: "string", enum: ["requirement", "decision"] }, statement: boundedText,
      strength: { type: "string", enum: ["agent_inferred", "human_reviewed", "human_required"] },
      provenance: {
        type: "object", additionalProperties: false, required: ["author", "basis", "events"],
        properties: {
          author: { type: "object", additionalProperties: false, required: ["kind", "name", "model", "ref"], properties: {
            kind: { type: "string", enum: ["human", "agent", "unknown"] }, name: boundedText,
            model: { type: ["string", "null"] }, ref: boundedText, at: boundedText,
          } },
          basis: { type: "array", minItems: 1, maxItems: 50, items: boundedText }, critical: boundedText,
          events: { type: "array", maxItems: 100, items: {
            type: "object", additionalProperties: false,
            required: ["kind", "actor", "at", "ref", "source_kind", "source_sha256", "quote", "design"],
            properties: {
              kind: { type: "string", enum: ["question", "acknowledgement", "endorsement", "requirement"] },
              actor: boundedText, at: boundedText, ref: boundedText,
              source_kind: { type: "string", enum: ["original_prompt", "human_message", "agent_message"] },
              source_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
              quote: { type: "string", maxLength: 120 }, design: { type: "string", maxLength: 120 },
            },
          } },
        },
      },
      realized_by: { ...paths, minItems: 1 }, verified_by: paths, verification_note: boundedText,
    },
  },
} as const;

const repositoryFile = (value: unknown): value is string => typeof value === "string"
  && value.length <= 400 && /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(value)
  && !value.split("/").some((part) => part === "." || part === "..");
// The repo also keeps Python and shell tests (scripts/ops/*.test.py, *.test.sh).
export const isTestFile = (file: string): boolean => /\.(test|spec)\.([cm]?[jt]sx?|py|sh)$/u.test(file);
export const isDocumentationOrTest = (file: string): boolean => file.startsWith("doc/")
  || file.startsWith("architecture/knowledge/") || /\.md$/u.test(file) || isTestFile(file);

export function parseSpecifications(value: unknown): KnowledgeSpecification[] {
  if (!Array.isArray(value) || !value.length || value.length > 40) throw new Error("specifications 必须逐条列出需求和决策（1–40 条）");
  return value.map((raw, index) => {
    const fail = (reason: string): never => { throw new Error(`specifications[${index}]: ${reason}`); };
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("必须是对象");
    const item = raw as KnowledgeSpecification;
    if (Object.keys(item).some((key) => !Object.hasOwn(SPECIFICATIONS_SCHEMA.items.properties, key))) fail("未知字段");
    if (!["requirement", "decision"].includes(item.kind) || typeof item.statement !== "string" || !item.statement.trim() || item.statement.length > 400) fail("需要 kind 和 ≤400 字的完整规格 statement");
    const errors = validateProvenance(item.provenance);
    if (errors.length) fail(errors.join("; "));
    if (!item.provenance.basis.length) fail("必须记录原始依据 basis");
    const strength = knowledgeStrength({ statement: item.statement, metadata: { provenance: item.provenance } });
    if (item.strength !== strength) fail(`声明强度与原始证据不符；实际为 ${strength}，文字标签不能升级`);
    if (item.provenance.author.kind === "human" && strength === "agent_inferred") fail("人类归因必须有覆盖整条设计的可核实证据；未核实归纳请标记 Agent/unknown");
    for (const field of ["realized_by", "verified_by"] as const) {
      if (!Array.isArray(item[field]) || item[field].length > 30 || item[field].some((file) => !repositoryFile(file)) || new Set(item[field]).size !== item[field].length) fail(`${field} 必须列出精确、无重复的仓库文件`);
    }
    if (!item.realized_by.length) fail("realized_by 不能为空");
    if (item.verified_by.some((file) => !isTestFile(file))) fail("verified_by 只接受测试文件");
    if (item.verification_note !== undefined && (typeof item.verification_note !== "string" || item.verification_note.trim().length < 20 || item.verification_note.length > 400)) fail("verification_note 必须说明无需执行测试的原因（20–400 字）");
    if (!item.verified_by.length && !item.verification_note) fail("缺少 verified_by；仅文档/测试提交可用 verification_note 说明不适用");
    return item;
  });
}

/**
 * Specifications are an optional, structured record of the requirements and
 * decisions a landing restates (#522: the knowledge base currently only
 * records). Present entries must parse and name exact candidate files; no
 * landing is refused for omitting them or for covering only some claims.
 */
export function checkSpecifications(input: { specifications?: KnowledgeSpecification[] }, files: ReadonlySet<string>): KnowledgeSpecification[] {
  if (!input.specifications?.length) return [];
  const specs = parseSpecifications(input.specifications);
  for (const spec of specs) {
    for (const file of [...spec.realized_by, ...spec.verified_by]) if (!files.has(file)) throw new Error(`规格映射不是候选提交中的普通文件：${file}`);
  }
  return specs;
}

export function specificationFor(specs: KnowledgeSpecification[] | undefined, node: Pick<KnowledgeNode, "kind" | "statement">): KnowledgeSpecification | undefined {
  return specs?.find((item) => item.kind === node.kind && knowledgeDesignKey(item.statement) === knowledgeDesignKey(node.statement));
}

/** Authored per-spec bridges, never a fan-out of all files in a landing. */
export function projectSpecification(spec: KnowledgeSpecification, node: KnowledgeNode, ctx: SourceContext, out: SourceOutput, producer?: { model: string; session_ref: string | null }): void {
  const provenance = spec.provenance.author.kind === "agent" ? {
    ...spec.provenance, author: { kind: "agent", name: "landing-agent", model: producer?.model ?? null, ref: producer?.session_ref ?? node.source_ref },
  } : spec.provenance;
  node.metadata = { ...node.metadata, provenance, verification_note: spec.verification_note ?? null };
  const link = (relation: "realized_by" | "verified_by" | "about" | "touches", to: string) => out.edges.push({
    from_id: node.id, relation, to_id: to, method: "landing", certainty: "exact", source_ref: node.source_ref, source_sha: ctx.sha, observed_at: ctx.observedAt,
  });
  for (const relation of ["realized_by", "verified_by"] as const) for (const file of spec[relation]) {
    const id = nodeId("artifact", `knowledge/${relation}/${file}`);
    out.nodes.push({ id, kind: "artifact", statement: file, status: "active", authority: "declared", source_ref: file, source_sha: ctx.sha, method: "landing", certainty: "exact", metadata: { path: file, kind: relation === "verified_by" ? "test" : "symbol", artifact_role: relation === "verified_by" ? "test" : "handler" } });
    link(relation, id);
    out.nodes.push({ id: pathId(file), kind: "path", statement: file, status: "active", authority: "declared", source_ref: file, source_sha: ctx.sha, method: "landing", certainty: "exact" });
    link("touches", pathId(file));
    const module = ctx.moduleForPath(file);
    if (module !== "unmapped") link("about", moduleId(module));
  }
}
