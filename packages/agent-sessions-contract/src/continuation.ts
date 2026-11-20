export const DEFAULT_CODEX_CONTINUATION = "继续执行";
export const CODEX_CONTINUATION_MAX_LENGTH = 4000;
export const CODEX_CONTINUATION_PROTOCOL = "codex-continuation/v1";

export interface CodexContinuationSettings {
  protocol: typeof CODEX_CONTINUATION_PROTOCOL;
  /** null selects the system default; custom text is never translated or trimmed. */
  prompt: string | null;
  effectivePrompt: string;
  revision: string;
}

export function validateCodexContinuationPrompt(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value.trim() || value.length > CODEX_CONTINUATION_MAX_LENGTH || value.includes("\0")) {
    throw new Error(`续接消息须为 1–${CODEX_CONTINUATION_MAX_LENGTH} 字符的非空文本`);
  }
  return value;
}

export function readCodexContinuationSettings(value: unknown): CodexContinuationSettings | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (row.protocol !== CODEX_CONTINUATION_PROTOCOL || typeof row.revision !== "string" || !/^(?:0|[a-f0-9-]{36})$/.test(row.revision)) return null;
  try {
    const prompt = validateCodexContinuationPrompt(row.prompt);
    if (row.effectivePrompt !== (prompt ?? DEFAULT_CODEX_CONTINUATION)) return null;
    return { protocol: CODEX_CONTINUATION_PROTOCOL, prompt, effectivePrompt: row.effectivePrompt as string, revision: row.revision };
  } catch { return null; }
}
