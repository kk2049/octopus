/** Observed native turn settings; display facts, never launch defaults. */
export interface SessionTurnConfiguration {
  model?: string;
  effort?: string;
}

/** Only public identifiers cross the display boundary, never the native context. */
export function readSessionTurnConfiguration(value: unknown): SessionTurnConfiguration | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const model = typeof input.model === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(input.model)
    ? input.model : undefined;
  // Observation must accept new native levels without changing the launch ladder.
  const effort = typeof input.effort === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(input.effort)
    ? input.effort : undefined;
  return model || effort ? { ...(model ? { model } : {}), ...(effort ? { effort } : {}) } : null;
}
