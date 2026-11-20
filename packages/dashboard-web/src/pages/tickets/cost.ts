/**
 * The one-line cost strip under a ticket in the sidebar (#192).
 *
 * The list is the only place every ticket is visible at once, which makes it
 * the only place a trend is visible. Four numbers per row — time, tokens, blast
 * radius, churn — turn "does a simple change still cost a simple amount?" into
 * something you can see by scrolling, instead of something you find out after
 * a ticket has already gone badly.
 *
 * So it has to be SHORT. A sidebar row is ~220px; anything that wraps stops
 * being scannable and the trend disappears again. Every unit is abbreviated to
 * its shortest unambiguous form, zero-valued groups are dropped rather than
 * rendered as "0", and a ticket with nothing measured renders nothing at all.
 */

import type { Ticket } from "./model.js";
import type { DashboardLanguageId } from "../../i18n/language.js";

const COPY: Record<DashboardLanguageId, {
  duration: (value: string, turns: number) => string;
  token: (total: string, input: string, output: string, cached: string) => string;
  footprint: (modules: number, files: number) => { short: string; hint: string };
  churn: (added: number, removed: number) => string;
}> = {
  "zh-CN": {
    duration: (value, turns) => `agent 用时 ${value}${turns > 1 ? `，共 ${turns} 轮` : ""}`,
    token: (total, input, output, cached) => `token ${total}（新输入 ${input} / 输出 ${output} / 缓存读 ${cached}）`,
    footprint: (modules, files) => ({ short: `${modules}模${files}文`, hint: `改动 ${modules} 个模块 / ${files} 个文件` }),
    churn: (added, removed) => `代码 +${added} −${removed} 行`,
  },
  "zh-TW": {
    duration: (value, turns) => `agent 用時 ${value}${turns > 1 ? `，共 ${turns} 輪` : ""}`,
    token: (total, input, output, cached) => `token ${total}（新輸入 ${input} / 輸出 ${output} / 快取讀取 ${cached}）`,
    footprint: (modules, files) => ({ short: `${modules}模${files}檔`, hint: `變更 ${modules} 個模組 / ${files} 個檔案` }),
    churn: (added, removed) => `程式碼 +${added} −${removed} 行`,
  },
  "nan-TW": {
    duration: (value, turns) => `agent 用時 ${value}${turns > 1 ? `，攏總 ${turns} 輪` : ""}`,
    token: (total, input, output, cached) => `token ${total}（新輸入 ${input} / 輸出 ${output} / 快取讀取 ${cached}）`,
    footprint: (modules, files) => ({ short: `${modules}模${files}檔`, hint: `改著 ${modules} 个模組 / ${files} 个檔案` }),
    churn: (added, removed) => `程式碼 +${added} −${removed} 行`,
  },
  en: {
    duration: (value, turns) => `Agent time ${value}${turns > 1 ? ` across ${turns} turns` : ""}`,
    token: (total, input, output, cached) => `Tokens ${total} (new input ${input} / output ${output} / cache read ${cached})`,
    footprint: (modules, files) => ({ short: `${modules}mod${files}file`, hint: `Changed ${modules} modules / ${files} files` }),
    churn: (added, removed) => `Code +${added} −${removed} lines`,
  },
  "ja-JP": {
    duration: (value, turns) => `agent 時間 ${value}${turns > 1 ? `、全 ${turns} ターン` : ""}`,
    token: (total, input, output, cached) => `token ${total}（新規入力 ${input} / 出力 ${output} / キャッシュ読取 ${cached}）`,
    footprint: (modules, files) => ({ short: `${modules}モ${files}ファ`, hint: `${modules} モジュール / ${files} ファイルを変更` }),
    churn: (added, removed) => `コード +${added} −${removed} 行`,
  },
};

/** `45s` / `12m` / `3.4h`. Sub-minute work is not interesting beyond "fast". */
export function compactDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  return hours < 10 ? `${hours.toFixed(1)}h` : `${Math.round(hours)}h`;
}

/** `840` / `28k` / `1.4M`. Token totals span five orders of magnitude. */
export function compactCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 1_000) return String(Math.round(n));
  if (n < 1_000_000) {
    const k = n / 1_000;
    return k < 10 ? `${k.toFixed(1)}k` : `${Math.round(k)}k`;
  }
  const m = n / 1_000_000;
  return m < 10 ? `${m.toFixed(1)}M` : `${Math.round(m)}M`;
}

export interface CostStrip {
  /** Ordered, already-short segments. Empty when there is nothing to show. */
  parts: string[];
  /** Long-form explanation for the row's `title`. */
  hint: string;
}

/**
 * Build the strip.
 *
 * Cached tokens are folded into the total rather than shown separately: the
 * question the strip answers is "how much did this cost", and splitting the
 * number three ways in a 220px row answers nothing. The tooltip carries the
 * breakdown for anyone who wants it.
 */
export function ticketCostStrip(
  ticket: Ticket,
  language: DashboardLanguageId = "zh-CN",
): CostStrip {
  const parts: string[] = [];
  const hints: string[] = [];
  const copy = COPY[language];
  const locale = language === "nan-TW" ? "zh-TW" : language;

  const duration = compactDuration(ticket.agent_ms ?? 0);
  if (duration) {
    const turns = ticket.agent_turns ?? 0;
    // Turn count only earns its characters once there is more than one: a
    // one-turn ticket is the norm and "×1" on every row is pure noise.
    parts.push(turns > 1 ? `${duration}×${turns}` : duration);
    hints.push(copy.duration(duration, turns));
  }

  const tokens = (ticket.tokens_in ?? 0) + (ticket.tokens_out ?? 0) + (ticket.tokens_cached ?? 0);
  const tokenLabel = compactCount(tokens);
  if (tokenLabel) {
    parts.push(`${tokenLabel} tokens`);
    hints.push(
      copy.token(
        tokens.toLocaleString(locale),
        (ticket.tokens_in ?? 0).toLocaleString(locale),
        (ticket.tokens_out ?? 0).toLocaleString(locale),
        (ticket.tokens_cached ?? 0).toLocaleString(locale),
      ),
    );
  }

  if (tokenLabel) hints.push(language === "en" ? "Token accounting; Codex weekly usage cannot be reliably attributed to a ticket." : "按已有 token 用量记账；Codex weekly 用量无法可靠归因到单个工单。");

  // Diff columns are null until a landing measured them. `0` is a real answer
  // ("landed nothing"), so only null is treated as absent.
  const files = ticket.diff_files;
  const modules = ticket.diff_modules;
  if (files != null && modules != null) {
    const footprint = copy.footprint(modules, files);
    parts.push(footprint.short);
    hints.push(footprint.hint);
  }

  const added = ticket.diff_added;
  const removed = ticket.diff_removed;
  if (added != null && removed != null && added + removed > 0) {
    parts.push(`+${compactCount(added) || 0}−${compactCount(removed) || 0}`);
    hints.push(copy.churn(added, removed));
  }

  return { parts, hint: hints.join(" · ") };
}
