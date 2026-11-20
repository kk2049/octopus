/**
 * Whether a refused session input may already have reached its agent.
 *
 * A durable receipt records a refusal as `failed` only with proof that the
 * input never left this Runner: the request ended before any transport was
 * handed the input, the thrower named a refusal it made before sending, or the
 * provider itself rejected the input. Everything else stays `unknown` and is
 * never replayed.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const attempt = new AsyncLocalStorage<{ handedOff: boolean }>();

/** Call immediately before an input, stop or release is given to any transport. */
export function markInputHandoff(): void {
  const current = attempt.getStore();
  if (current) current.handedOff = true;
}

/** Run one durable start/append and report whether it reached a transport. */
export async function withInputAttempt<T>(run: () => Promise<T>): Promise<{ value: T; handedOff: boolean }> {
  const state = { handedOff: false };
  const value = await attempt.run(state, run);
  return { value, handedOff: state.handedOff };
}

/** Tag a refusal decided before sending, inside an adapter that may send later. */
export function inputNotSent<E extends Error>(error: E): E {
  return Object.assign(error, { inputNotSent: true as const });
}

/** Codes whose throw sites refuse before any input, stop or release is sent. */
const NOT_SENT_CODES = new Set([
  "model_turn_active", "effort_turn_active", "model_external_cli", "effort_external_cli",
  "session_needs_input", "turn_not_active", "release_required",
  "session_active", "duplicate_terminal_send", "session_not_interruptible", "session_not_managed",
  "session_not_working", "release_not_supported", "release_not_available",
  "permission_profile_unsupported", "codex_subagent_thread", "terminal_composer_busy",
]);

/**
 * The code a receipt retains for a refusal proven to precede sending, or
 * undefined when the input may have been delivered. `safeFallback: true` is the
 * adapters' existing claim that the prompt never transferred; `inputRejected`
 * is the provider's own refusal of it.
 */
export function notSentRefusalCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const row = error as { code?: unknown; safeFallback?: unknown; inputRejected?: unknown; inputNotSent?: unknown };
  if (row.code === "unknown") return undefined;
  const code = typeof row.code === "string" && row.code ? row.code : undefined;
  if (code && NOT_SENT_CODES.has(code)) return code;
  if (row.safeFallback === true || row.inputRejected === true || row.inputNotSent === true) return code ?? "input_not_sent";
  return undefined;
}
