/** The investigation an agent must do before proposing a design revision. */
export interface KnowledgeChange {
  record_id: string;
  original_motivation: string;
  proposed_motivation: string;
  proposed_behavior: string;
  alternatives: string;
  impact: string;
  verification: string;
}

export const KNOWLEDGE_CHANGE_SCHEMA = {
  type: "array", maxItems: 20,
  items: {
    type: "object", additionalProperties: false,
    required: ["record_id", "original_motivation", "proposed_motivation", "proposed_behavior", "alternatives", "impact", "verification"],
    properties: {
      record_id: { type: "string", minLength: 1, maxLength: 200 },
      original_motivation: { type: "string", minLength: 12, maxLength: 400 },
      proposed_motivation: { type: "string", minLength: 12, maxLength: 400 },
      proposed_behavior: { type: "string", minLength: 12, maxLength: 400 },
      alternatives: { type: "string", minLength: 12, maxLength: 400 },
      impact: { type: "string", minLength: 12, maxLength: 400 },
      verification: { type: "string", minLength: 12, maxLength: 400 },
    },
  },
} as const;

export function parseKnowledgeChanges(value: unknown): KnowledgeChange[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error("knowledge.changes must be a bounded list");
  const fields = KNOWLEDGE_CHANGE_SCHEMA.items.properties;
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("knowledge change must be an object");
    for (const key of Object.keys(item)) if (!Object.hasOwn(fields, key)) throw new Error(`unknown knowledge change field ${key}`);
    const result: Record<string, string> = {};
    for (const [key, limits] of Object.entries(fields)) {
      const text = item[key];
      if (typeof text !== "string" || text.trim().length < limits.minLength || text.length > limits.maxLength) throw new Error(`knowledge change ${key}: investigate both motivations, alternatives, impact and verification before submitting`);
      result[key] = text.trim();
    }
    return result as unknown as KnowledgeChange;
  });
}
