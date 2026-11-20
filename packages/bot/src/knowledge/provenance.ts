import { createHash } from "node:crypto";
import type { KnowledgeNode } from "./model.js";

/** Evidence strength is independent of source ranking and extraction certainty. */
export type KnowledgeStrength = "agent_inferred" | "human_reviewed" | "human_required";
export interface KnowledgeProvenance {
  author: { kind: "human" | "agent" | "unknown"; name: string; model: string | null; ref: string; at?: string };
  basis: string[];
  critical?: string;
  events: KnowledgeEvidenceEvent[];
}
export interface KnowledgeEvidenceEvent {
  kind: "question" | "acknowledgement" | "endorsement" | "requirement";
  actor: string;
  at: string;
  ref: string;
  /** Exact source role, never inferred from the ticket requester. */
  source_kind: "original_prompt" | "human_message" | "agent_message";
  source_sha256: string;
  quote: string;
  /** The part of the design the human actually named in their own words. */
  design: string;
}

// Keep operators, decimal points and internal punctuation: < is not > and 1.5 is not 15.
export const knowledgeDesignKey = (text: string): string => text.normalize("NFKC").replace(/\s+/gu, "").replace(/[。.!?！？;；]+$/gu, "").toLowerCase();
const normalize = knowledgeDesignKey;
const SUPPORT = /支持|同意|认可|赞成|保留|采用|就按|应该|应当|必须|不得|不许|需要|希望|要求|agree|support|endorse|must|should|keep|use/iu;
const STRONG = /必须|不得|不许|禁止|强烈要求|务必|must|shall|never/iu;

export function evidenceQualifies(event: KnowledgeEvidenceEvent): boolean {
  const design = normalize(event.design);
  return event.source_kind !== "agent_message"
    && event.actor.trim().length > 0
    && /^[0-9a-f]{64}$/u.test(event.source_sha256)
    && Number.isFinite(Date.parse(event.at))
    && design.length >= 8
    && normalize(event.quote).includes(design)
    && (event.kind === "requirement"
      ? event.source_kind === "original_prompt" || STRONG.test(event.quote)
      : event.kind === "endorsement" && SUPPORT.test(event.quote) && !/不同意|不支持|不认可|不赞成|尚未|没有审|没看|disagree|do not|don.t|not support/iu.test(event.quote));
}

export function knowledgeStrength(node: Pick<KnowledgeNode, "metadata" | "statement">): KnowledgeStrength {
  const provenance = node.metadata?.provenance as KnowledgeProvenance | undefined;
  const events = (provenance?.events ?? []).filter((event) => normalize(node.statement) === normalize(event.design));
  if (events.some((event) => event.kind === "requirement" && evidenceQualifies(event))) return "human_required";
  if (events.some((event) => event.kind === "endorsement" && evidenceQualifies(event))) return "human_reviewed";
  return "agent_inferred";
}

export function validateProvenance(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["provenance must be an object"];
  const p = value as KnowledgeProvenance;
  const errors: string[] = [];
  for (const key of Object.keys(p)) if (!["author", "basis", "events", "critical"].includes(key)) errors.push(`unknown provenance field ${key}`);
  if (!p.author || !["human", "agent", "unknown"].includes(p.author.kind)
    || typeof p.author.name !== "string" || !p.author.name.trim() || p.author.name.length > 100
    || typeof p.author.ref !== "string" || !p.author.ref.trim()
    || !(p.author.model === null || typeof p.author.model === "string")) errors.push("provenance.author requires kind, name, model (null when unknown), ref");
  if (!Array.isArray(p.basis) || p.basis.length > 50 || p.basis.some((ref) => typeof ref !== "string" || !ref.trim() || ref.length > 512)) errors.push("provenance.basis must contain bounded source pointers");
  if (p.critical !== undefined && (typeof p.critical !== "string" || !p.critical.trim() || p.critical.length > 400)) errors.push("provenance.critical must explain the review need");
  if (!Array.isArray(p.events) || p.events.length > 100) return [...errors, "provenance.events must be a bounded history"];
  for (const e of p.events) {
    if (!e || typeof e !== "object" || !["question", "acknowledgement", "endorsement", "requirement"].includes(e.kind)
      || !["original_prompt", "human_message", "agent_message"].includes(e.source_kind)
      || typeof e.actor !== "string" || !e.actor.trim() || e.actor.length > 100
      || typeof e.ref !== "string" || !e.ref.trim() || e.ref.length > 512
      || typeof e.at !== "string" || !Number.isFinite(Date.parse(e.at))
      || typeof e.quote !== "string" || e.quote.length > 120
      || typeof e.design !== "string" || e.design.length > 120
      || typeof e.source_sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(e.source_sha256)) {
      errors.push("invalid provenance evidence event");
      continue;
    }
    if ((e.kind === "endorsement" || e.kind === "requirement") && !evidenceQualifies(e)) errors.push("human evidence must quote a named design; acknowledgement is not endorsement");
  }
  return errors;
}

export const STRENGTH_RANK: Record<KnowledgeStrength, number> = { agent_inferred: 0, human_reviewed: 1, human_required: 2 };

export const STRENGTH_LABEL: Record<KnowledgeStrength, string> = {
  agent_inferred: "Agent 判断／未核实人类证据",
  human_reviewed: "人类明确审阅",
  human_required: "用户原始／强制要求",
};

/** Reviews bind the exact two statements and evidence, not just a reusable id. */
export function conflictFingerprint(id: string, nodes: readonly (KnowledgeNode | null)[], investigation: unknown = null): string {
  return createHash("sha256").update(JSON.stringify([id, ...nodes.map((node) => node && [node.id, node.statement, node.metadata?.provenance ?? null, node.metadata?.changes ?? null, node.metadata?.to_sha ?? null]), investigation])).digest("hex");
}
