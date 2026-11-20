/**
 * Time and text formatting shared by every page.
 *
 * These were four near-copies across the hand-built pages, and they had already
 * drifted: two of them called anything under a minute 刚刚 and one called it
 * 从未 when the timestamp was absent, while a third silently rendered
 * "NaN 分钟前" for an unparseable ISO string.
 */
import { currentLanguage, type DashboardLanguageId } from "../i18n/language.js";

/** Intl locale; Min Nan uses the existing Taiwan locale fallback. */
export function dateLocale(language: DashboardLanguageId = currentLanguage()): string {
  return language === "nan-TW" ? "zh-TW" : language;
}

/** Absolute local time, or the raw string when it is not a date. */
export function formatTime(iso: string | null | undefined, language = currentLanguage()): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(dateLocale(language), { hour12: false });
}

/** "3 分钟前". Empty input is 从未 — never seen, which is not the same as now. */
export function formatAgo(iso: string | null | undefined, language = currentLanguage()): string {
  if (!iso) return { "zh-CN": "从未", "zh-TW": "從未", "nan-TW": "猶未", en: "Never", "ja-JP": "未記録" }[language];
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const minutes = Math.floor((Date.now() - t) / 60_000);
  const copy = RELATIVE_COPY[language];
  if (minutes < 1) return copy.now;
  if (minutes < 60) return copy.minute(minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return copy.hour(hours);
  return copy.day(Math.floor(hours / 24));
}

/**
 * Relative time at minute granularity and coarser.
 *
 * Seconds are deliberately absent: the ticket list repaints on a 10 s cycle and
 * a seconds-accurate label would rewrite every row on every tick purely to turn
 * "3 秒前" into "13 秒前".
 */
const RELATIVE_COPY: Record<DashboardLanguageId, {
  now: string;
  minute: (value: number) => string;
  hour: (value: number) => string;
  day: (value: number) => string;
  month: (value: number) => string;
  year: (value: number) => string;
}> = {
  "zh-CN": {
    now: "刚刚",
    minute: (value) => `${value} 分钟前`,
    hour: (value) => `${value} 小时前`,
    day: (value) => `${value} 天前`,
    month: (value) => `${value} 个月前`,
    year: (value) => `${value} 年前`,
  },
  "zh-TW": {
    now: "剛剛",
    minute: (value) => `${value} 分鐘前`,
    hour: (value) => `${value} 小時前`,
    day: (value) => `${value} 天前`,
    month: (value) => `${value} 個月前`,
    year: (value) => `${value} 年前`,
  },
  "nan-TW": {
    now: "拄仔",
    minute: (value) => `${value} 分鐘進前`,
    hour: (value) => `${value} 點鐘進前`,
    day: (value) => `${value} 工進前`,
    month: (value) => `${value} 個月進前`,
    year: (value) => `${value} 年進前`,
  },
  en: {
    now: "just now",
    minute: (value) => `${value} min ago`,
    hour: (value) => `${value} hr ago`,
    day: (value) => `${value} day${value === 1 ? "" : "s"} ago`,
    month: (value) => `${value} mo ago`,
    year: (value) => `${value} yr ago`,
  },
  "ja-JP": {
    now: "たった今",
    minute: (value) => `${value} 分前`,
    hour: (value) => `${value} 時間前`,
    day: (value) => `${value} 日前`,
    month: (value) => `${value} か月前`,
    year: (value) => `${value} 年前`,
  },
};

export function formatRelative(
  iso: string | null | undefined,
  language: DashboardLanguageId = currentLanguage(),
): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - t) / 1000));
  const copy = RELATIVE_COPY[language];
  if (seconds < 60) return copy.now;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return copy.minute(minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return copy.hour(hours);
  const days = Math.floor(hours / 24);
  if (days < 30) return copy.day(days);
  const months = Math.floor(days / 30);
  if (months < 12) return copy.month(months);
  return copy.year(Math.floor(months / 12));
}

/** "1 分 43 秒" for an elapsed duration in milliseconds. */
export function formatElapsed(ms: number, language: DashboardLanguageId = currentLanguage()): string {
  const seconds = Math.floor(ms / 1000);
  if (language === "en") {
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  }
  if (language === "ja-JP") {
    if (seconds < 60) return `${seconds} 秒`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
    return `${Math.floor(minutes / 60)} 時間 ${minutes % 60} 分`;
  }
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} ${language === "zh-CN" ? "小时" : "小時"} ${minutes % 60} 分`;
}

/** ISO timestamp trimmed to `YYYY-MM-DD HH:MM`; "" when unusable. */
export function formatStamp(iso: string | null | undefined, length = 16): string {
  if (!iso) return "";
  return iso.replace("T", " ").slice(0, length);
}
