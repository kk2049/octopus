/**
 * Per-provider effort ladders: the one definition every party compiles in.
 *
 * The View renders and clamps a Session's effort with it, the trusted Host
 * binds/validates an `append` or `start` request against it, and the Runner
 * refuses anything outside it before a CLI sees the value. They used to restate
 * the ladder five times; two spellings would let an approval card be signed for
 * an effort the device then refuses. The Runner bundles this module at build
 * time; nothing fetches it at runtime.
 *
 * This module has no imports beyond types, so a narrow consumer (the Runner)
 * can take it through `@claude-bot/agent-sessions-contract/providers` without
 * pulling in the rest of the ABI.
 */

import type { CliKind } from "./projection.js";

/** Every effort any provider accepts, in ladder order (schema enums use this). */
export const AGENT_EFFORT_LEVELS = Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const);

export const AGENT_EFFORTS: Readonly<Record<CliKind, readonly string[]>> = Object.freeze({
  claude: Object.freeze(["low", "medium", "high", "xhigh", "max"]),
  codex: Object.freeze(["low", "medium", "high", "xhigh", "max"]),
  // omp calls this a thinking level; `off` is a real setting there, not the
  // absence of one, so it is listed rather than folded into "Runner 默认".
  omp: Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
});

/** Whether `value` is in `provider`'s own closed ladder. Unknown providers accept nothing. */
export function isAgentEffort(provider: unknown, value: unknown): boolean {
  if (typeof provider !== "string" || typeof value !== "string") return false;
  if (!Object.prototype.hasOwnProperty.call(AGENT_EFFORTS, provider)) return false;
  return AGENT_EFFORTS[provider as CliKind].includes(value);
}

/** The Codex model the launch forms preselect. */
export const DEFAULT_CODEX_MODEL = "gpt-6-astra";

/** One selectable model: the string the CLI receives, and how to say it. */
export interface ModelChoice {
  /** Exactly what is proposed, and what the CLI's `--model` receives. */
  value: string;
  /** What the dropdown shows. The value stays visible; nobody has to guess. */
  label: string;
}

/** Public model metadata only; malformed/oversized catalogs trigger the static fallback. */
export function publicModelChoices(value: unknown): ModelChoice[] | undefined {
  if (!Array.isArray(value) || !value.length || value.length > 500) return;
  const rows: ModelChoice[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return;
    const { value: model, label } = item;
    if (typeof model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(model)
      || typeof label !== "string" || !label.trim() || label.length > 160 || /[\x00-\x1f\x7f]/.test(label)) return;
    if (!seen.has(model)) rows.push({ value: model, label });
    seen.add(model);
  }
  return rows.length ? rows : undefined;
}

/**
 * The models a launch form offers per CLI. One list for every surface that
 * starts an Agent (Sessions+, the Feishu Docs card), so no form invents its own.
 */
export const MODELS: Readonly<Record<CliKind, readonly ModelChoice[]>> = Object.freeze({
  claude: Object.freeze([
    { value: "opus", label: "Opus — 最强，默认选它" },
    { value: "sonnet", label: "Sonnet — 更快，够用" },
    { value: "fable", label: "Fable — 轻量" },
  ]),
  codex: Object.freeze([
    { value: "gpt-6-astra", label: "GPT-6 Astra" },
    { value: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
    { value: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
    { value: "codex-auto-review", label: "Codex 自动审查" },
  ]),
  // omp routes to whatever provider its own config resolves, and takes fuzzy
  // names ("opus", "gpt-5.2"). These are the two subscriptions this deployment
  // actually has wired; anything else stays typeable through a carried draft.
  omp: Object.freeze([
    { value: "opus", label: "Opus — 经 Claude 订阅" },
    { value: "gpt-5.6-sol", label: "GPT-5.6 Sol — 经 Codex 订阅" },
  ]),
});
