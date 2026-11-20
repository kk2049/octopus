/** Native token counts. Cached input is a subset of input; reasoning is a subset of output. */
export interface CodexTokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Account quota snapshots cannot establish the cost of this particular chat. */
  weeklyUsagePercent: null;
  weeklyUsageStatus: "unattributable";
}

export function readCodexTokenUsage(value: unknown): CodexTokenUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  const input = v.input_tokens ?? v.inputTokens;
  const cached = v.cached_input_tokens ?? v.cachedInputTokens;
  const output = v.output_tokens ?? v.outputTokens;
  if (![input, cached, output].every((n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)) return undefined;
  if (Number(cached) > Number(input) || !Number.isSafeInteger(Number(input) + Number(output))) return undefined;
  return { inputTokens: Number(input), cachedInputTokens: Number(cached), outputTokens: Number(output),
    totalTokens: Number(input) + Number(output), weeklyUsagePercent: null, weeklyUsageStatus: "unattributable" };
}

/** Product fallback presets, NOT an OpenAI quota conversion or billing formula. */
export const SHARE_TOKEN_PRESETS = { "0.5": 750_000, "1": 1_500_000, "5": 7_500_000 } as const;
export const SHARE_LEASE_HOURS = [1, 5, 24] as const;

export function tokenUsageLabel(usage: CodexTokenUsage | undefined): string {
  return usage ? `${usage.totalTokens.toLocaleString()} tokens` : "";
}

export const OPEN_SHARED_SESSION_ACTION = "open_shared_session";
export interface SharedSessionSummary { shareId: string; title: string; expiresAt: number; revoked: boolean; tokenLimit: number; tokensUsed: number; canPrompt: boolean; /** Present only in the issuer's own resource plane. */ resourceId?: string }
