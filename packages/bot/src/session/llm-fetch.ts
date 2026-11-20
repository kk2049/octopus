/**
 * Shared retry/timeout wrapper for every direct LLM HTTP call in the bot.
 *
 * Before this existed, three places (`session/llm-query.ts`, `hq/chat.ts`,
 * `router.ts::triageBystanderInner`) each called `fetch` directly, checked
 * `!res.ok`, and threw. A single 429 from the upstream gateway ("Concurrency
 * limit exceeded for user, please retry later") would blow up the whole turn:
 * the secretary lease dies, the report card flips to error, and the user is
 * told the run failed for a transient reason that a normal client would just
 * wait 200 ms and try again.
 *
 * The policy encoded here:
 *
 * · Retry 429 / 408 / 425 / 5xx / timeout / transport errors with jittered
 *   exponential backoff (default 5 attempts, ~400 ms → ~6.4 s base).
 * · Honor `Retry-After` (seconds or HTTP-date) when the server sends it.
 * · Never retry 4xx other than the ones above (400/401/403/404 mean the caller
 *   is wrong, retrying only wastes budget and confuses the operator).
 * · Never retry after the upstream `signal` fires (drain / user cancel / stop).
 * · Every attempt has an independent AbortController + timeout so a single
 *   hang doesn't eat the whole retry budget.
 *
 * The helper always throws on final failure (with `status` / `body` attached
 * on the Error), and returns `Response` on success. Callers that used to
 * `if (!res.ok) throw new Error(...)` can drop that branch: fetchLlm has done
 * it for them, with a richer message.
 */

import { createLogger } from "../logger.js";

const log = createLogger("llm-fetch");

export interface RetryOptions {
  /** Total attempts including the first try. Default 5. */
  maxAttempts?: number;
  /** Base delay for the first backoff, in ms. Doubles each attempt. Default 400. */
  initialDelayMs?: number;
  /** Cap for any single backoff (also caps a large Retry-After). Default 30_000. */
  maxDelayMs?: number;
  /** ±this fraction of jitter, e.g. 0.5 → multiply by [0.5, 1.5]. Default 0.5. */
  jitter?: number;
}

export interface FetchLlmOptions {
  /** Per-attempt timeout. Default 90_000 ms. */
  timeoutMs?: number;
  /** Upstream abort; cancels immediately and skips further retries. */
  signal?: AbortSignal;
  /** `false` to disable retry entirely; otherwise a partial policy. */
  retry?: RetryOptions | false;
  /** DI for tests; defaults to `globalThis.fetch`. */
  fetchImpl?: typeof globalThis.fetch;
  /** DI for tests; defaults to a promise-based `setTimeout`. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** DI for tests; defaults to `Math.random`. */
  random?: () => number;
  /** Human label used in error messages and logs (e.g. "OpenAI chat/completions"). */
  label?: string;
  /** Fires once per retry (before sleeping). Useful for progress events / logs. */
  onRetry?: (info: RetryInfo) => void;
}

export interface RetryInfo {
  /** 1-indexed number of the attempt that just failed. */
  attempt: number;
  /** 1-indexed number of the attempt about to be scheduled. */
  nextAttempt: number;
  /** How long we will sleep before the next attempt. */
  delayMs: number;
  reason: "http" | "timeout" | "network";
  status?: number;
  message: string;
}

/** Errors thrown by `fetchLlm` carry these props when applicable. */
export interface FetchLlmError extends Error {
  status?: number;
  body?: string;
  attempts?: number;
  reason?: "http" | "timeout" | "network";
}

const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_INITIAL_DELAY_MS = 400;
const DEFAULT_MAX_DELAY_MS = 30_000;
const DEFAULT_JITTER = 0.5;

const EXTRA_RETRYABLE = new Set([408, 425, 429]);

function isRetryableStatus(status: number): boolean {
  if (EXTRA_RETRYABLE.has(status)) return true;
  return status >= 500 && status < 600;
}

/**
 * `Retry-After` may be a number of seconds ("5") or an HTTP-date
 * ("Fri, 31 Dec 2025 23:59:59 GMT"). Return the delay in ms, or null if we
 * can't parse it (in which case the caller falls back to exponential backoff).
 */
export function parseRetryAfter(header: string | null, nowMs: number): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed) return null;
  const secs = Number(trimmed);
  if (Number.isFinite(secs)) return Math.max(0, Math.floor(secs * 1000));
  const date = Date.parse(trimmed);
  if (!Number.isFinite(date)) return null;
  return Math.max(0, date - nowMs);
}

function computeDelay(
  attempt: number,
  retry: Required<RetryOptions>,
  random: () => number,
): number {
  const exp = Math.min(retry.maxDelayMs, retry.initialDelayMs * 2 ** (attempt - 1));
  const range = retry.jitter;
  // [1-jitter, 1+jitter], clamped to non-negative
  const factor = Math.max(0, 1 - range + random() * (range * 2));
  return Math.max(0, Math.floor(exp * factor));
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted) throw new Error("aborted");
  return await new Promise<void>((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      fn();
    };
    const timer = setTimeout(() => finish(resolve), ms);
    const onAbort = () => finish(() => reject(new Error("aborted")));
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

function resolveRetry(retry: RetryOptions | false | undefined): Required<RetryOptions> {
  if (retry === false) {
    return { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0, jitter: 0 };
  }
  return {
    maxAttempts: retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    initialDelayMs: retry?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS,
    maxDelayMs: retry?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
    jitter: retry?.jitter ?? DEFAULT_JITTER,
  };
}

/**
 * POST a body to an LLM endpoint. Returns a `Response` iff the server replied
 * 2xx; on any other outcome (including retryable failures we exhausted) it
 * throws a `FetchLlmError` with `status`/`body`/`attempts`/`reason` attached.
 */
export async function fetchLlm(
  url: string,
  init: RequestInit,
  options: FetchLlmOptions = {},
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const label = options.label ?? "LLM request";
  const upstream = options.signal;
  const retry = resolveRetry(options.retry);

  let lastError: FetchLlmError | null = null;

  for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
    if (upstream?.aborted) {
      throw wrapAborted(label, attempt);
    }

    const attemptResult = await runOnce(url, init, fetchImpl, timeoutMs, upstream, label);

    if (attemptResult.kind === "ok") {
      return attemptResult.response;
    }
    if (attemptResult.kind === "aborted") {
      throw wrapAborted(label, attempt);
    }

    const failure = attemptResult;
    const retryable =
      failure.kind === "timeout" ||
      failure.kind === "network" ||
      (failure.kind === "http" && isRetryableStatus(failure.status));

    if (!retryable) {
      throw makeError(label, failure, attempt);
    }

    const info = summarizeFailure(failure);
    const err = makeError(label, failure, attempt);
    lastError = err;

    const isLast = attempt >= retry.maxAttempts;
    if (isLast) {
      throw err;
    }

    const delayMs = pickDelayFor(failure, attempt, retry, random);
    const retryInfo: RetryInfo = {
      attempt,
      nextAttempt: attempt + 1,
      delayMs,
      reason: info.reason,
      status: info.status,
      message: err.message,
    };
    log.warn({ ...retryInfo, url }, `${label} retrying`);
    try {
      options.onRetry?.(retryInfo);
    } catch (cbErr) {
      log.warn({ err: cbErr }, `${label} onRetry callback threw`);
    }

    try {
      await sleep(delayMs, upstream);
    } catch {
      throw wrapAborted(label, attempt + 1);
    }
  }

  // Loop always throws when it exits; this is only for type completeness.
  throw lastError ?? makeError(label, { kind: "network", error: new Error("no attempts made") }, 0);
}

type AttemptResult =
  | { kind: "ok"; response: Response }
  | { kind: "http"; status: number; statusText: string; body: string; retryAfterMs: number | null }
  | { kind: "timeout"; timeoutMs: number }
  | { kind: "network"; error: Error }
  | { kind: "aborted" };

async function runOnce(
  url: string,
  init: RequestInit,
  fetchImpl: typeof globalThis.fetch,
  timeoutMs: number,
  upstream: AbortSignal | undefined,
  label: string,
): Promise<AttemptResult> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`${label} timeout after ${timeoutMs}ms`));
  }, timeoutMs);
  const onUpstreamAbort = () => controller.abort(new Error(`${label} aborted`));
  if (upstream) {
    if (upstream.aborted) {
      clearTimeout(timer);
      return { kind: "aborted" };
    }
    upstream.addEventListener("abort", onUpstreamAbort, { once: true });
  }

  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    if (response.ok) return { kind: "ok", response };
    const status = response.status;
    const body = await response.text().catch(() => "");
    // Defensive: test doubles sometimes omit `headers`, and real fetch()
    // responses always have it — either way, treat missing as absent header.
    const retryAfterHeader = response.headers?.get?.("retry-after") ?? null;
    const retryAfterMs = parseRetryAfter(retryAfterHeader, Date.now());
    return { kind: "http", status, statusText: response.statusText, body, retryAfterMs };
  } catch (err) {
    if (upstream?.aborted) return { kind: "aborted" };
    if (timedOut) return { kind: "timeout", timeoutMs };
    const error = err instanceof Error ? err : new Error(String(err));
    return { kind: "network", error };
  } finally {
    clearTimeout(timer);
    if (upstream) upstream.removeEventListener("abort", onUpstreamAbort);
  }
}

function summarizeFailure(f: Exclude<AttemptResult, { kind: "ok" } | { kind: "aborted" }>): {
  reason: "http" | "timeout" | "network";
  status?: number;
} {
  if (f.kind === "http") return { reason: "http", status: f.status };
  if (f.kind === "timeout") return { reason: "timeout" };
  return { reason: "network" };
}

function pickDelayFor(
  failure: Exclude<AttemptResult, { kind: "ok" } | { kind: "aborted" }>,
  attempt: number,
  retry: Required<RetryOptions>,
  random: () => number,
): number {
  if (failure.kind === "http" && failure.retryAfterMs != null) {
    return Math.min(retry.maxDelayMs, failure.retryAfterMs);
  }
  return computeDelay(attempt, retry, random);
}

function makeError(
  label: string,
  failure: Exclude<AttemptResult, { kind: "ok" } | { kind: "aborted" }>,
  attempts: number,
): FetchLlmError {
  let message: string;
  const err: FetchLlmError = new Error("placeholder");
  if (failure.kind === "http") {
    const bodySnippet = failure.body ? ` - ${failure.body.slice(0, 300)}` : "";
    message = `${label} failed: ${failure.status} ${failure.statusText}${bodySnippet}`;
    err.status = failure.status;
    err.body = failure.body;
    err.reason = "http";
  } else if (failure.kind === "timeout") {
    message = `${label} timed out after ${failure.timeoutMs}ms`;
    err.reason = "timeout";
  } else {
    message = `${label} network error: ${failure.error.message}`;
    err.reason = "network";
    if (failure.error.stack) err.stack = failure.error.stack;
  }
  err.message = attempts > 1 ? `${message} (after ${attempts} attempts)` : message;
  err.attempts = attempts;
  return err;
}

function wrapAborted(label: string, attempt: number): FetchLlmError {
  const err: FetchLlmError = new Error(`${label} aborted before attempt ${attempt}`);
  err.reason = "network";
  err.attempts = attempt - 1;
  return err;
}
