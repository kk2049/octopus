import { useEffect, useState } from "react";
import { quotaDeadline } from "@claude-bot/chat-ui-commons/quota";
import type { CodexAccountRegistration } from "@claude-bot/agent-sessions-contract";
import { AccountQuota } from "../ui/AccountQuota.js";
import { dateLocale } from "../lib/format.js";
import { useDashboardLanguage } from "../i18n/react.js";
import { uiText, localizedLabels } from "../i18n/ui-text.js";
/**
 * Plan availability from authenticated Runner inventories, grouped by machine
 * and public account registration. Legacy non-Runner deployments retain their
 * provider badges. Missing and stale measurements remain explicit.
 */

import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { pollInterval } from "../lib/query.js";
import styles from "./Quota.module.css";
import claudeMark from "../assets/claude.svg";
import openaiMark from "../assets/openai.svg";

interface QuotaCard {
  key?: string;
  label: string;
  severity?: "normal" | "warning" | "critical";
  usedPercent?: number;
  remainPercent?: number;
  resetsAt?: string;
  /** OMP-generated redacted label, unique within the active Codex pool. */
  accountLabel?: string;
  stale?: boolean;
}

type Severity = "normal" | "warning" | "critical";
export type QuotaProvider = "anthropic" | "openai";

const WORD = localizedLabels(() => ({ normal: uiText("充足"), warning: uiText("偏紧"), critical: uiText("告急") } as const));
const PROVIDER_NAME = { anthropic: "Anthropic", openai: "OpenAI" } as const;
const QUOTA_PATH = "/api/dev/quota";

export function providerOf(key: string): QuotaProvider {
  return key.startsWith("codex:") ? "openai" : "anthropic";
}

function durationSuffix(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "";
  if (minutes % 10_080 === 0) return `${minutes / 10_080}wk`;
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function labelSuffix(label: string): string {
  const bare = label.replace(/^codex\s*·\s*/i, "").trim();
  const hours = /^(\d+)\s*小时$/.exec(bare);
  if (hours) return `${hours[1]}h`;
  const mins = /^(\d+)\s*分钟$/.exec(bare);
  if (mins) return `${mins[1]}m`;
  const days = /^(\d+)\s*天$/.exec(bare);
  if (days) return `${days[1]}d`;
  if (bare === "一周") return "1wk";
  if (bare === "一天") return "1d";
  return bare.toLowerCase();
}

export function windowSuffix(key: string, label: string): string {
  if (key === "session") return "5h";
  if (key === "weekly_all") return "1wk";
  if (key.startsWith("scoped:")) return key.slice("scoped:".length).toLowerCase();
  const codex = /:(\d+)m$/.exec(key);
  if (key.startsWith("codex:") && codex) {
    const suffix = durationSuffix(Number(codex[1]));
    if (suffix) return suffix;
  }
  return labelSuffix(label);
}

function percent(value: number | undefined): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function resetWords(iso: string | undefined, now: number): string {
  if (!iso) return "";
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return "";
  const minutes = Math.round((timestamp - now) / 60_000);
  if (minutes <= 0) return uiText("即将重置");
  if (minutes < 60) return uiText("{v0} 分钟后重置", { v0: minutes });
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 48) return uiText("{v0} 小时{v1}后重置", { v0: hours, v1: rest ? uiText(" {v0} 分", { v0: rest }) : "" });
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return uiText("{v0} 天{v1}后重置", { v0: days, v1: restHours ? uiText(" {v0} 小时", { v0: restHours }) : "" });
}

function shortDeadline(iso: string | undefined, now: number): string {
  if (!iso) return "";
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return "";
  const minutes = Math.round((timestamp - now) / 60_000);
  if (minutes <= 0) return uiText("即将");
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

const RING_RADIUS = 8;
export const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export function ringDasharray(remainPercent: number): string {
  const arc = (percent(remainPercent) / 100) * RING_CIRCUMFERENCE;
  return `${arc.toFixed(2)} ${RING_CIRCUMFERENCE.toFixed(2)}`;
}

function ProviderMark({ provider }: { provider: QuotaProvider }) {
  useDashboardLanguage();
  const openai = provider === "openai";
  return (
    <img
      className={openai ? `${styles.mark} ${styles.openai}` : styles.mark}
      src={openai ? openaiMark : claudeMark}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}

function RemainingRing({ remain }: { remain: number }) {
  useDashboardLanguage();
  return (
    <svg viewBox="0 0 22 22" className={styles.ring} aria-hidden="true" focusable="false">
      <circle className={styles.track} cx="11" cy="11" r={RING_RADIUS} />
      {remain > 0 ? (
        <circle
          className={styles.arc}
          cx="11"
          cy="11"
          r={RING_RADIUS}
          strokeDasharray={ringDasharray(remain)}
          transform="rotate(-90 11 11)"
        />
      ) : null}
      <text className={styles.ringNum} x="11" y="11" textAnchor="middle" dominantBaseline="central">
        {remain}
      </text>
    </svg>
  );
}

export function remainingOf(card: { usedPercent?: number; remainPercent?: number }): number {
  if (Number.isFinite(Number(card.remainPercent))) return percent(card.remainPercent);
  return 100 - percent(card.usedPercent);
}

interface CardPresentation {
  severity: Severity;
  remain: number;
  suffix: string;
  reset: string;
  short: string;
  title: string;
  aria: string;
  stale: boolean;
}

function presentCard(card: QuotaCard, now: number, codexSlot?: number): CardPresentation {
  const severity: Severity = card.severity && WORD()[card.severity] ? card.severity : "normal";
  const remain = remainingOf(card);
  const used = 100 - remain;
  const key = card.key ?? "";
  const provider = providerOf(key);
  const suffix = windowSuffix(key, card.label);
  const reset = resetWords(card.resetsAt, now);
  const short = shortDeadline(card.resetsAt, now);
  const stale = card.stale === true;
  let absolute = "";
  if (card.resetsAt) {
    const date = new Date(card.resetsAt);
    if (!Number.isNaN(date.getTime())) absolute = uiText(" · 重置时间 {v0}", { v0: date.toLocaleString(dateLocale()) });
  }
  const account = codexSlot ? uiText(" · Codex 账号 {v0}", { v0: codexSlot }) : "";
  return {
    severity,
    remain,
    suffix,
    reset,
    short,
    stale,
    title: uiText("{v0}{v1} · {v2} · 剩余 {v3}% · 已用 {v4}%{v5}{v6}{v7}", { v0: card.label, v1: account, v2: WORD()[severity], v3: remain, v4: used, v5: reset ? ` · ${reset}` : "", v6: absolute, v7: stale ? uiText(" · 暂时显示缓存值") : "" }),
    aria: uiText("{v0} 额度:{v1},剩余 {v2}%{v3}{v4}", { v0: codexSlot ? uiText("Codex 账号 {v0}", { v0: codexSlot }) : `${PROVIDER_NAME[provider]} ${suffix}`, v1: WORD()[severity], v2: remain, v3: reset ? `,${reset}` : "", v4: stale ? uiText(",缓存值") : "" }),
  };
}

function QuotaBadge({ card, now }: { card: QuotaCard; now: number }) {
  useDashboardLanguage();
  const presentation = presentCard(card, now);
  const provider = providerOf(card.key ?? "");
  return (
    <span
      className={`${styles.chip} ${styles[presentation.severity]}${
        presentation.stale ? ` ${styles.stale}` : ""
      }`}
      title={presentation.title}
      role="img"
      aria-label={presentation.aria}
    >
      <ProviderMark provider={provider} />
      <span className={styles.win}>{presentation.suffix}</span>
      <RemainingRing remain={presentation.remain} />
      {presentation.short ? <span className={styles.ddl}>↻{presentation.short}</span> : null}
    </span>
  );
}

function CodexAccountPanel({ cards, now }: { cards: QuotaCard[]; now: number }) {
  useDashboardLanguage();
  return (
    <span className={styles.codexPanel} role="group" aria-label={uiText("Codex {v0} 个账号额度", { v0: cards.length })}>
      <span className={styles.codexBrand} aria-hidden="true">
        <ProviderMark provider="openai" />
      </span>
      {cards.map((card, index) => {
        const presentation = presentCard(card, now, index + 1);
        return (
          <span
            key={card.key || card.accountLabel || `codex-${index}`}
            className={`${styles.codexAccount} ${styles[presentation.severity]}${
              presentation.stale ? ` ${styles.stale}` : ""
            }`}
            title={presentation.title}
            role="img"
            aria-label={presentation.aria}
          >
            <RemainingRing remain={presentation.remain} />
            {presentation.short ? <span className={styles.ddl}>↻{presentation.short}</span> : null}
          </span>
        );
      })}
    </span>
  );
}

interface CodexHost {
  key: string; device: string; label: string; online: boolean; accounts: CodexAccountRegistration[];
  claudeAccounts?: CodexAccountRegistration[];
}

function ResetCredits({ quota, now }: { quota: CodexAccountRegistration["quota"]; now: number }) {
  if (quota?.creditCount === undefined) return null;
  const expiresAt = quota.creditExpiresAt ? Date.parse(quota.creditExpiresAt) : NaN;
  const hasExpiry = quota.creditCount > 0 && Number.isFinite(expiresAt);
  const title = hasExpiry
    ? uiText("最早到期充值卡：{v0}", { v0: new Date(expiresAt).toLocaleString(dateLocale()) }) : undefined;
  return <span className={styles.creditCount}>
    {uiText("充值卡 {v0}", { v0: quota.creditCount })}
    {hasExpiry ? <> <span className={styles.ddl} title={title} aria-label={title}>
      ⏳{expiresAt <= now ? uiText("已过期") : quotaDeadline(quota.creditExpiresAt!, now)}
    </span></> : null}
  </span>;
}

function CodexHosts({ hosts }: { hosts: CodexHost[] }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return <span className={styles.hosts}>
    {hosts.map((host) => <span className={styles.host} key={host.key} role="group" aria-label={host.label}>
      <strong>{host.label}{host.online ? "" : ` · ${uiText("Runner 离线")}`}</strong>
      {[...host.accounts.map((account) => ({ account, provider: "openai" as const })),
        ...(host.claudeAccounts ?? []).map((account) => ({ account, provider: "anthropic" as const }))]
        .map(({ account, provider }) => <span className={styles.accountRow} key={`${provider}:${account.id}`}>
        <ProviderMark provider={provider} />
        <span className={styles.accountName} title={[account.label, account.emailLabel].filter(Boolean).join(" · ")}>
          {account.emailLabel ?? account.label}
        </span>
        <span className={styles.accountStats}>
          <AccountQuota quota={account.quota} offline={!host.online} />
          {provider === "openai" ? <ResetCredits quota={account.quota} now={now} /> : null}
        </span>
      </span>)}
    </span>)}
  </span>;
}

export function QuotaChips() {
  useDashboardLanguage();
  const { data } = useQuery({
    queryKey: ["dev", "quota"],
    queryFn: () => api<{ cards?: QuotaCard[]; codexHosts?: CodexHost[]; error?: string }>(QUOTA_PATH),
    refetchInterval: pollInterval(QUOTA_PATH, 60_000),
    refetchIntervalInBackground: false,
  });
  const cards = data?.error ? [] : (data?.cards ?? []);
  const hosts = data?.codexHosts ?? [];
  if (!cards.length && !hosts.length) return null;
  const codexAccounts = cards.filter((card) => providerOf(card.key ?? "") === "openai" && card.accountLabel);
  const standalone = cards.filter((card) => !codexAccounts.includes(card));
  const now = Date.now();
  return (
    <span className={styles.chips}>
      {standalone.map((card) => <QuotaBadge key={card.key || card.label} card={card} now={now} />)}
      {hosts.length ? <CodexHosts hosts={hosts} /> : null}
      {codexAccounts.length ? <CodexAccountPanel cards={codexAccounts} now={now} /> : null}
    </span>
  );
}
