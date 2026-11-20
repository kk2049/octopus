import { useEffect, useState, type CSSProperties } from "react";
import type { CodexAccountRegistration } from "@claude-bot/agent-sessions-contract";

// The legacy Dashboard fuel gauge: the arc and its number both mean remaining.
const circumference = 2 * Math.PI * 8;
const row: CSSProperties = { display: "inline-flex", alignItems: "center", gap: 4, flexWrap: "wrap", verticalAlign: "middle" };

export function quotaDeadline(iso: string, now: number): string {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return "?";
  const minutes = Math.ceil((timestamp - now) / 60_000);
  if (minutes <= 0) return "0m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

export function quotaWindow(minutes: number): string {
  if (minutes % 10080 === 0) return `${minutes / 10080}wk`;
  if (minutes < 60) return `${minutes}m`;
  return minutes < 1440 ? `${minutes / 60}h` : `${minutes / 1440}d`;
}

export interface QuotaWords {
  unknown: string;
  cached: string;
  remaining: (percent: number) => string;
  reset: (absolute: string) => string;
}

const defaultWords: QuotaWords = {
  unknown: "额度未知", cached: "缓存值",
  remaining: (percent) => `剩余 ${percent}%`,
  reset: (absolute) => `重置时间 ${absolute}`,
};

/** Pure presentation of already supplied inventory; the timer never reads a resource. */
export function AccountQuota({ quota, offline = false, words = defaultWords }: {
  quota?: CodexAccountRegistration["quota"];
  offline?: boolean;
  words?: QuotaWords;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  if (quota?.status !== "available" || !quota.windows.length) return <span>{words.unknown}</span>;
  const fetchedAt = Date.parse(quota.fetchedAt);
  const stale = offline || !Number.isFinite(fetchedAt) || now - fetchedAt > 120_000;
  return <span style={row}>
    {quota.windows.map((window) => {
      if (!Number.isFinite(window.remainingPercent)) return <span key={window.windowMinutes}>{words.unknown}</span>;
      const remain = Math.max(0, Math.min(100, Math.round(window.remainingPercent)));
      const suffix = quotaWindow(window.windowMinutes);
      const deadline = quotaDeadline(window.resetsAt, now);
      const resetAt = Date.parse(window.resetsAt);
      const title = `${suffix} · ${words.remaining(remain)} · ${words.reset(Number.isFinite(resetAt) ? new Date(resetAt).toLocaleString() : "?")}${stale ? ` · ${words.cached}` : ""}`;
      const color = remain <= 5 ? "var(--q-critical, #d64545)" : remain <= 20 ? "var(--q-warning, #b7791f)" : "var(--q-normal, #279b72)";
      return <span key={window.windowMinutes} role="img" aria-label={title} title={title}
        style={{ ...row, flexWrap: "nowrap", gap: 3, whiteSpace: "nowrap" }}>
        <span style={{ fontSize: 11, fontWeight: 600 }}>{suffix}</span>
        <svg viewBox="0 0 22 22" width="22" height="22" aria-hidden="true" focusable="false" style={{ flex: "none" }}>
          <circle cx="11" cy="11" r="8" fill="none" stroke="currentColor" opacity="0.18" strokeWidth="2.5" />
          {remain > 0 ? <circle cx="11" cy="11" r="8" fill="none" stroke={color} strokeWidth="2.5"
            strokeLinecap="round" strokeDasharray={`${(remain / 100 * circumference).toFixed(2)} ${circumference.toFixed(2)}`}
            transform="rotate(-90 11 11)" /> : null}
          <text x="11" y="11" textAnchor="middle" dominantBaseline="central" fill="currentColor"
            style={{ fontSize: 7.5, fontWeight: 650, fontVariantNumeric: "tabular-nums" }}>{remain}</text>
        </svg>
        <small style={{ fontSize: 10.5, fontVariantNumeric: "tabular-nums", opacity: 0.75 }}>↻{deadline}</small>
      </span>;
    })}
    {stale ? <small title={words.cached} style={{ fontSize: 10, opacity: 0.7 }}>· {words.cached}</small> : null}
  </span>;
}
