/**
 * Codex subscription quota probe for every account OMP can route to.
 *
 * OMP owns the machine's Codex credential registry and balances new turns
 * across those accounts. Its `usage --json --provider openai-codex --redact`
 * projection is therefore the only source that describes the same account
 * pool the ticket executor spends. The older Codex app-server probe could see
 * only the CLI's active login and made a healthy second account invisible.
 *
 * Only the main Codex percentage window, a redacted account discriminator, and
 * reset time leave this module. Spark/model-specific limits, plan metadata,
 * account ids, and credentials are dropped.
 */

import { createLogger } from "../logger.js";
import { readOmpCodexUsage } from "./omp-usage-client.js";
import type { QuotaCard, QuotaError, QuotaResult, QuotaSeverity } from "./quota.js";

const log = createLogger("codex-quota");

const OK_TTL_MS = 60_000;
const ERR_TTL_MS = 30_000;
const WARN_AT = 80;
const CRITICAL_AT = 95;
const CODEX_PROVIDER = "openai-codex";
const PRIMARY_LIMIT = "openai-codex:primary";

export interface CodexQuotaProbeOptions {
  now?: () => number;
  okTtlMs?: number;
  errTtlMs?: number;
  /** Injection seam for OMP's redacted `usage --json` projection. */
  readUsageSnapshot?: () => Promise<unknown>;
  usageCommand?: string;
  usageArgs?: string[];
  usageTimeoutMs?: number;
  usageMaxOutputBytes?: number;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asArray = (value: unknown): unknown[] | null => Array.isArray(value) ? value : null;

function asPercent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, Math.round(value)));
}

function severityFor(usedPercent: number): QuotaSeverity {
  if (usedPercent >= CRITICAL_AT) return "critical";
  if (usedPercent >= WARN_AT) return "warning";
  return "normal";
}

function remainingPercent(amount: Record<string, unknown>): number | null {
  const direct = asPercent(amount.remaining);
  if (amount.unit === "percent" && direct !== null) return direct;
  const fraction = typeof amount.remainingFraction === "number" ? amount.remainingFraction : null;
  if (fraction !== null && Number.isFinite(fraction)) return asPercent(fraction * 100);
  const usedFraction = typeof amount.usedFraction === "number" ? amount.usedFraction : null;
  if (usedFraction !== null && Number.isFinite(usedFraction)) return asPercent((1 - usedFraction) * 100);
  const used = asPercent(amount.used);
  if (amount.unit === "percent" && used !== null) return 100 - used;
  return null;
}

function resetIso(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function durationMinutes(window: Record<string, unknown>): number | null {
  const ms = window.durationMs;
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return null;
  return Math.max(1, Math.round(ms / 60_000));
}

function labelForWindow(minutes: number | null): string {
  if (minutes === 10_080) return "Codex · 一周";
  if (minutes === 1_440) return "Codex · 一天";
  if (minutes === 300) return "Codex · 5 小时";
  if (minutes === null) return "Codex";
  if (minutes < 60) return `Codex · ${minutes} 分钟`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `Codex · ${hours} 小时`;
  return `Codex · ${Math.round(hours / 24)} 天`;
}

function redactedAccountLabel(metadata: Record<string, unknown> | null, index: number): string {
  const email = metadata?.email;
  if (typeof email !== "string") return `账号 ${index}`;
  const label = email.trim().slice(0, 40);
  return label || `账号 ${index}`;
}

function makeAccountCard(report: Record<string, unknown>, index: number): QuotaCard | null {
  const limits = asArray(report.limits);
  if (!limits) return null;
  const primary = limits
    .map(asRecord)
    .find((limit) => limit?.id === PRIMARY_LIMIT);
  if (!primary) return null;
  const amount = asRecord(primary.amount);
  const window = asRecord(primary.window);
  if (!amount || !window) return null;
  const remainPercent = remainingPercent(amount);
  if (remainPercent === null) return null;
  const usedPercent = 100 - remainPercent;
  const minutes = durationMinutes(window);
  const card: QuotaCard = {
    key: `codex:account:${index}${minutes === null ? "" : `:${minutes}m`}`,
    label: labelForWindow(minutes),
    accountLabel: redactedAccountLabel(asRecord(report.metadata), index),
    usedPercent,
    remainPercent,
    severity: severityFor(usedPercent),
  };
  const resetsAt = resetIso(window.resetsAt);
  if (resetsAt) card.resetsAt = resetsAt;
  return card;
}

/** Project OMP's redacted multi-account usage report into one card per login. */
export function parseOmpCodexUsage(raw: unknown): QuotaCard[] {
  const reports = asArray(asRecord(raw)?.reports);
  if (!reports) return [];
  const cards: QuotaCard[] = [];
  for (const value of reports) {
    const report = asRecord(value);
    if (!report || report.provider !== CODEX_PROVIDER) continue;
    const card = makeAccountCard(report, cards.length + 1);
    if (card) cards.push(card);
  }
  return cards;
}

function isUsageSnapshot(raw: unknown): boolean {
  return asArray(asRecord(raw)?.reports) !== null;
}

/** Cached, de-duplicated probe. A quota outage never rejects the dashboard. */
export class CodexQuotaProbe {
  private cached: QuotaResult | null = null;
  private cachedAt = 0;
  private inflight: Promise<QuotaResult> | null = null;

  constructor(private opts: CodexQuotaProbeOptions = {}) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  async snapshot(): Promise<QuotaResult> {
    const ttl = this.cached?.error ? (this.opts.errTtlMs ?? ERR_TTL_MS) : (this.opts.okTtlMs ?? OK_TTL_MS);
    if (this.cached && this.now() - this.cachedAt < ttl) return this.cached;
    if (this.inflight) return this.inflight;

    this.inflight = this.probe()
      .catch((err): QuotaResult => {
        log.warn({ err: String(err) }, "Codex quota probe threw");
        return this.fail("unavailable", "Codex 额度读取失败");
      })
      .then((result) => {
        this.cached = result;
        this.cachedAt = this.now();
        this.inflight = null;
        return result;
      });
    return this.inflight;
  }

  private fail(error: QuotaError, message: string): QuotaResult {
    return { cards: [], fetchedAt: new Date(this.now()).toISOString(), error, message };
  }

  private async probe(): Promise<QuotaResult> {
    try {
      const raw = await (this.opts.readUsageSnapshot
        ? this.opts.readUsageSnapshot()
        : readOmpCodexUsage({
            command: this.opts.usageCommand,
            args: this.opts.usageArgs,
            timeoutMs: this.opts.usageTimeoutMs,
            maxOutputBytes: this.opts.usageMaxOutputBytes,
          }));
      if (!isUsageSnapshot(raw)) {
        log.debug("OMP returned an unrecognised usage snapshot");
        return this.fail("unavailable", "Codex 额度接口返回了无法识别的格式");
      }
      return {
        cards: parseOmpCodexUsage(raw),
        fetchedAt: new Date(this.now()).toISOString(),
      };
    } catch (err) {
      log.debug({ err: String(err) }, "OMP Codex usage read failed");
      return this.fail("unavailable", "Codex 额度读取失败");
    }
  }
}
