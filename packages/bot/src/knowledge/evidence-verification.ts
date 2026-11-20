import { createHash } from "node:crypto";
import type { KnowledgeEvidenceEvent } from "./provenance.js";

export interface OriginalKnowledgeSource {
  actor: string;
  kind: "original_prompt" | "human_message" | "agent_message";
  at: string;
  text: string;
}

/** Source hashes and literal quotes are verified against the original, not an agent's summary. */
export function verifyEvidenceEvent(event: KnowledgeEvidenceEvent, source: OriginalKnowledgeSource | null): string | null {
  if (!source) return "原始来源不可用，不能提高人类证据级别";
  if (source.kind === "agent_message" || event.source_kind !== source.kind || event.actor !== source.actor || event.at !== source.at) return "原始消息作者、角色或时间不符";
  const hash = createHash("sha256").update(source.text).digest("hex");
  if (hash !== event.source_sha256 || !source.text.includes(event.quote)) return "原始消息哈希或逐字引文不符";
  return null;
}
