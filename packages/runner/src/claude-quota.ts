/**
 * Claude subscription quota probe — how much of the credential-owning machine's plan is left.
 *
 * The Runner reads its own Claude login. Legacy Head execution imports the
 * same probe locally; neither path transfers credentials to another host.
 *
 * Source of truth is the very endpoint the CLI's own `/usage` view reads,
 * authenticated with the OAuth access token sitting in
 * `~/.claude/.credentials.json`. Two deliberate boundaries:
 *
 *  · **Read-only on credentials.** We never refresh the token. The refresh
 *    token is single-use-ish — racing the interactive CLI for a rotation is a
 *    great way to invalidate the human's login. Expired = say so, and let the
 *    next real `claude` run fix it.
 *  · **The token never leaves this module.** Callers get percentages and reset
 *    timestamps, nothing else.
 *
 * The response shape is a client-internal contract, not a published API, so
 * every field is parsed defensively: anything we cannot recognise is dropped
 * rather than surfaced, and a wholly unrecognised payload degrades to "quota
 * unavailable" instead of breaking the page that shows it.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA = "oauth-2025-04-20";
const REQUEST_TIMEOUT_MS = 8_000;
/** Success cache: browsers poll every 60s and there may be several of them. */
const OK_TTL_MS = 60_000;
/** Failure cache: back off, but recover within one poll cycle of a fix. */
const ERR_TTL_MS = 30_000;
/** A brief upstream outage may reuse the last good display, but not indefinitely. */
const STALE_MAX_AGE_MS = 5 * 60_000;

const WARN_AT = 80;
const CRITICAL_AT = 95;

export type QuotaSeverity = "normal" | "warning" | "critical";
export type QuotaError = "no_credentials" | "expired" | "unavailable";

export interface QuotaCard {
  /** Stable id: "session" | "weekly_all" | "scoped:<model>". */
  key: string;
  label: string;
  usedPercent: number;
  remainPercent: number;
  severity: QuotaSeverity;
  /** ISO timestamp when this window resets, if the upstream told us. */
  resetsAt?: string;
  /** Redacted account discriminator for providers with more than one login. */
  accountLabel?: string;
  /** The latest refresh failed and this card came from a recent good snapshot. */
  stale?: boolean;
}

export interface QuotaResult {
  cards: QuotaCard[];
  fetchedAt: string;
  /** True only while serving a bounded last-known-good fallback. */
  stale?: boolean;
  error?: QuotaError;
  /** Human-facing explanation for `error`; shown verbatim in the panel. */
  message?: string;
}

export interface QuotaProbeOptions {
  credentialsPath?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  okTtlMs?: number;
  errTtlMs?: number;
  staleMaxAgeMs?: number;
  /** Bound on one upstream read, token read included. */
  requestTimeoutMs?: number;
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** Percent as an integer in [0,100]; null when the value is not usable. */
function asPercent(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.min(100, Math.max(0, Math.round(v)));
}

function asIsoTime(v: unknown): string | undefined {
  if (typeof v !== "string" || !v) return undefined;
  return Number.isFinite(Date.parse(v)) ? v : undefined;
}

function severityFor(usedPercent: number): QuotaSeverity {
  if (usedPercent >= CRITICAL_AT) return "critical";
  if (usedPercent >= WARN_AT) return "warning";
  return "normal";
}

function makeCard(key: string, label: string, usedPercent: number, resetsAt: unknown): QuotaCard {
  const card: QuotaCard = {
    key,
    label,
    usedPercent,
    remainPercent: 100 - usedPercent,
    severity: severityFor(usedPercent),
  };
  const iso = asIsoTime(resetsAt);
  if (iso) card.resetsAt = iso;
  return card;
}

/** Display name of a per-model weekly limit, e.g. "Fable". */
function scopedModelName(scope: unknown): string | null {
  const model = asRecord(asRecord(scope)?.model);
  const name = model?.display_name;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

const RANK: Record<string, number> = { session: 0, weekly_all: 1 };
const rankOf = (key: string): number => RANK[key] ?? 2;

/**
 * Turn a raw usage payload into display cards.
 *
 * Preferred source is the `limits[]` array — it is the generic one, carrying
 * per-model weekly windows (Fable today, whatever ships next week) with no
 * changes here. The flat `five_hour`/`seven_day` objects are a fallback for
 * payloads that lack it. Severity is computed locally rather than taken from
 * upstream's own `severity` field: the panel's thresholds must match what the
 * panel documents, not an undocumented remote policy.
 */
export function parseUsage(raw: unknown): QuotaCard[] {
  const root = asRecord(raw);
  if (!root) return [];

  const cards: QuotaCard[] = [];
  const seen = new Set<string>();
  const push = (card: QuotaCard): void => {
    if (seen.has(card.key)) return;
    seen.add(card.key);
    cards.push(card);
  };

  const limits = Array.isArray(root.limits) ? root.limits : [];
  for (const entry of limits) {
    const e = asRecord(entry);
    if (!e) continue;
    const used = asPercent(e.percent);
    if (used === null) continue;
    if (e.kind === "session") push(makeCard("session", "5 小时", used, e.resets_at));
    else if (e.kind === "weekly_all") push(makeCard("weekly_all", "一周", used, e.resets_at));
    else if (e.kind === "weekly_scoped") {
      const name = scopedModelName(e.scope);
      if (name) push(makeCard(`scoped:${name.toLowerCase()}`, `${name} · 周`, used, e.resets_at));
    }
  }

  for (const [key, label, field] of [
    ["session", "5 小时", root.five_hour],
    ["weekly_all", "一周", root.seven_day],
  ] as const) {
    if (seen.has(key)) continue;
    const w = asRecord(field);
    const used = asPercent(w?.utilization);
    if (used !== null) push(makeCard(key, label, used, w?.resets_at));
  }

  return cards.sort((a, b) => rankOf(a.key) - rankOf(b.key));
}

/**
 * Cached, de-duplicated probe. One instance per process: several dashboard
 * tabs polling at 60s must not turn into several upstream calls per minute,
 * and concurrent calls share one in-flight request.
 */
export class QuotaProbe {
  private cached: QuotaResult | null = null;
  private cachedAt = 0;
  private lastSuccess: QuotaResult | null = null;
  private lastSuccessAt = 0;
  private inflight: Promise<QuotaResult> | null = null;

  constructor(private opts: QuotaProbeOptions = {}) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** Never rejects: a quota outage must not take the panel down with it. */
  async snapshot(): Promise<QuotaResult> {
    const now = this.now();
    const ttl =
      this.cached?.error || this.cached?.stale
        ? (this.opts.errTtlMs ?? ERR_TTL_MS)
        : (this.opts.okTtlMs ?? OK_TTL_MS);
    const staleExpired =
      this.cached?.stale === true && now - this.lastSuccessAt > (this.opts.staleMaxAgeMs ?? STALE_MAX_AGE_MS);
    if (this.cached && !staleExpired && now - this.cachedAt < ttl) return this.cached;
    if (this.inflight) return this.inflight;

    this.inflight = this.probe()
      .catch((): QuotaResult => {
        return this.fail("unavailable", "额度查询失败");
      })
      .then((result) => {
        this.cached = this.withRecentFallback(result);
        this.cachedAt = this.now();
        this.inflight = null;
        return this.cached;
      });
    return this.inflight;
  }

  /**
   * Preserve the last successful Claude cards across a short, transient
   * upstream failure. Authentication failures remain authoritative: showing
   * an old value after an explicit logout/expiry would hide the action needed
   * to recover. Stale cards are cloned so the last-good snapshot stays fresh
   * and can be reused again without accumulating presentation state.
   */
  private withRecentFallback(result: QuotaResult): QuotaResult {
    const now = this.now();
    if (!result.error && result.cards.length) {
      this.lastSuccess = result;
      this.lastSuccessAt = now;
      return result;
    }
    if (
      result.error === "unavailable" &&
      this.lastSuccess &&
      now - this.lastSuccessAt <= (this.opts.staleMaxAgeMs ?? STALE_MAX_AGE_MS)
    ) {
      return {
        cards: this.lastSuccess.cards.map((card) => ({ ...card, stale: true })),
        fetchedAt: this.lastSuccess.fetchedAt,
        stale: true,
        message: result.message,
      };
    }
    return result;
  }

  private fail(error: QuotaError, message: string): QuotaResult {
    return { cards: [], fetchedAt: new Date(this.now()).toISOString(), error, message };
  }

  /** Read the OAuth access token the local CLI logged in with. */
  private async readToken(): Promise<string | null> {
    const path =
      this.opts.credentialsPath ??
      process.env.CLAUDE_CREDENTIALS_PATH ??
      join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), ".credentials.json");
    try {
      const raw = asRecord(JSON.parse(await readFile(path, "utf8")));
      const token = asRecord(raw?.claudeAiOauth)?.accessToken;
      return typeof token === "string" && token ? token : null;
    } catch {
      return null; // missing/unreadable/garbled — all mean "no local login"
    }
  }

  /**
   * Every caller shares `inflight`, so the probe settles on a deadline it owns
   * rather than trusting `fetch` to honour its abort signal. On 2026-10-26 one
   * read stayed pending for 22 hours after its `AbortSignal.timeout` expired,
   * and the Runner's gateway registration waited on it the whole time.
   */
  private async probe(): Promise<QuotaResult> {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<QuotaResult>((resolve) => {
      timer = setTimeout(() => {
        abort.abort();
        resolve(this.fail("unavailable", "额度接口超时"));
      }, this.opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
    });
    try {
      return await Promise.race([this.read(abort.signal), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async read(signal: AbortSignal): Promise<QuotaResult> {
    const token = await this.readToken();
    if (!token) return this.fail("no_credentials", "本机未登录 Claude 账号,无法读取额度");

    const doFetch = this.opts.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await doFetch(USAGE_URL, {
        headers: {
          authorization: `Bearer ${token}`,
          "anthropic-beta": OAUTH_BETA,
          accept: "application/json",
        },
        signal,
      });
    } catch {
      return this.fail("unavailable", "额度接口连接失败");
    }

    if (res.status === 401 || res.status === 403) {
      return this.fail("expired", "Claude 凭证已过期,在本机跑一次 claude 即可刷新");
    }
    if (!res.ok) return this.fail("unavailable", `额度接口返回 ${res.status}`);

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return this.fail("unavailable", "额度接口返回了无法解析的内容");
    }

    const cards = parseUsage(body);
    if (!cards.length) return this.fail("unavailable", "额度接口返回了无法识别的格式");
    return { cards, fetchedAt: new Date(this.now()).toISOString() };
  }
}
