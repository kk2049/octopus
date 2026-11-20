import { createHash } from "node:crypto";
import { evidenceQualifies, type KnowledgeEvidenceEvent } from "./provenance.js";

export const sourceHash = (text: string): string => createHash("sha256").update(text).digest("hex");
export const SOURCE_DISPOSITIONS = ["requirement", "constraint", "revision", "question", "context", "irrelevant"] as const;
export type SourceDisposition = (typeof SOURCE_DISPOSITIONS)[number];
export interface SourceIdentity {
  ref: string; actor: string; at: string; source_kind: "original_prompt" | "human_message";
  source_sha256: string;
}
export interface SourceDraft {
  ref: string; source_sha256: string; disposition: SourceDisposition; statements: string[]; reason: string;
}
export interface KnowledgeNextAction {
  reason: "unaccounted_human_source" | "unmapped_requirement" | "source_changed" | "context_changed";
  source_ref?: string; next_action: string;
}
export interface SourcePage {
  sources: SourceIdentity[]; pending: number; next_after: number | null;
  knowledge_next_actions: KnowledgeNextAction[];
}
export interface CliSourceInput {
  provider: string; device: string; session_id: string; message_id: string;
  source_at: string; role: "user" | "assistant"; text: string;
}
export interface CliSource extends CliSourceInput {
  id: string; owner: string; source_sha256: string; imported_at: string; trust: "local_import";
}
export interface CliSourceSummary extends Omit<CliSource, "text"> {
  confirmations: KnowledgeEvidenceEvent[];
}
export function boundedText(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw new Error(`${name}: 需要非空且长度不超过 ${max} 的文本`);
  return value;
}
export function parseCliSource(input: unknown): CliSourceInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("来源须为单条消息对象");
  const x = input as Record<string, unknown>;
  if (Object.keys(x).some(k => !["provider", "device", "session_id", "message_id", "source_at", "role", "text"].includes(k))) throw new Error("来源含未知字段");
  const source_at = boundedText(x.source_at, "source_at", 40);
  if (!Number.isFinite(Date.parse(source_at))) throw new Error("source_at 无效");
  if (x.role !== "user" && x.role !== "assistant") throw new Error("role 无效");
  return { provider: boundedText(x.provider, "provider", 80), device: boundedText(x.device, "device", 100),
    session_id: boundedText(x.session_id, "session_id", 160), message_id: boundedText(x.message_id, "message_id", 160),
    source_at, role: x.role, text: boundedText(x.text, "text", 12000) };
}
export function parseSourceDraft(input: unknown): SourceDraft {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("来源处理须为对象");
  const x = input as Record<string, unknown>;
  if (Object.keys(x).some(k => !["ref", "source_sha256", "disposition", "statements", "reason"].includes(k))) throw new Error("来源处理含未知字段");
  const ref = boundedText(x.ref, "ref", 200), source_sha256 = boundedText(x.source_sha256, "source_sha256", 64);
  if (!/^[0-9a-f]{64}$/u.test(source_sha256) || !SOURCE_DISPOSITIONS.includes(x.disposition as SourceDisposition)) throw new Error("来源 hash 或分类无效");
  if (!Array.isArray(x.statements) || x.statements.length > 20) throw new Error("statements 最多 20 条");
  const statements = x.statements.map(s => boundedText(s, "statement", 400));
  const reason = boundedText(x.reason, "reason", 400);
  if (["requirement", "constraint", "revision"].includes(String(x.disposition)) && !statements.length) throw new Error("要求、约束或修正须映射到具体规格");
  if (!["requirement", "constraint", "revision"].includes(String(x.disposition)) && reason.trim().length < 8) throw new Error("不纳入规格须说明具体理由，至少 8 字");
  return { ref, source_sha256, disposition: x.disposition as SourceDisposition, statements, reason };
}
export function confirmationEvent(input: { ref: string; owner: string; at: string; kind: "requirement" | "endorsement"; statement: string }): KnowledgeEvidenceEvent {
  const text = boundedText(input.statement, "statement", 120);
  const event: KnowledgeEvidenceEvent = { kind: input.kind, actor: input.owner, at: input.at, ref: input.ref,
    source_kind: "human_message", source_sha256: sourceHash(text), quote: text, design: text };
  if (!evidenceQualifies(event)) throw new Error("请用自己的话明确要求或支持具体行为；强制要求需包含“必须/不得”等表述，普通确认不会升级证据");
  return event;
}
