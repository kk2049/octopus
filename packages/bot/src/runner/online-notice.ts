/**
 * "Tell me when this device is back": a per-device owner preference.
 *
 * Stored like the display name, as an owner setting. It never selects a
 * device, grants anything or reaches the Runner; its only effect is one
 * message to the device's own owner when the gateway sees that device return.
 *
 * A return, not a reconnect: the gateway reports each registration with the
 * device's previous proof of life (every Runner ping refreshes it), and a gap
 * shorter than RUNNER_ONLINE_NOTICE_MIN_OFFLINE_MS — a self-update handover,
 * a gateway restart, a network blip — sends nothing.
 */

import type { CardPayload } from "../feishu/direct-card.js";
import type { RunnerPresenceListener } from "./gateway.js";

export const RUNNER_ONLINE_NOTICE_CHANNELS = ["feishu"] as const;
export type RunnerOnlineNoticeChannel = typeof RUNNER_ONLINE_NOTICE_CHANNELS[number];

export const runnerOnlineNoticeKey = (device: string): string => `runner_online_notice:${device}`;

/** Unseen for less than this, a registration is a reconnect rather than a return. */
export const RUNNER_ONLINE_NOTICE_MIN_OFFLINE_MS = 10 * 60_000;

export function parseRunnerOnlineNoticeChannel(value: unknown): RunnerOnlineNoticeChannel | undefined {
  return (RUNNER_ONLINE_NOTICE_CHANNELS as readonly unknown[]).includes(value) ? value as RunnerOnlineNoticeChannel : undefined;
}

export function runnerOnlineNotice(
  store: { getSetting(owner: string, key: string): string | undefined },
  owner: string,
  device: string,
): RunnerOnlineNoticeChannel | undefined {
  return parseRunnerOnlineNoticeChannel(store.getSetting(owner, runnerOnlineNoticeKey(device)));
}

export interface RunnerOnlineNoticeOptions {
  channel(owner: string, device: string): RunnerOnlineNoticeChannel | undefined;
  displayName?(owner: string, device: string): string | undefined;
  /** Delivers a card to the owner's own Feishu private chat. */
  sendFeishu(owner: string, card: CardPayload): Promise<void>;
  sent?(owner: string, device: string): void;
  failed(owner: string, device: string, error: unknown): void;
  now?(): number;
  minOfflineMs?: number;
}

/** A gateway presence listener that sends at most one notice per return. */
export function runnerOnlineNotices(options: RunnerOnlineNoticeOptions): RunnerPresenceListener {
  const minOfflineMs = options.minOfflineMs ?? RUNNER_ONLINE_NOTICE_MIN_OFFLINE_MS;
  return (owner, device, online, previousSeenAt) => {
    if (!online || options.channel(owner, device) !== "feishu") return;
    const now = options.now?.() ?? Date.now();
    const seen = previousSeenAt ? Date.parse(previousSeenAt) : Number.NaN;
    const offlineMs = Number.isFinite(seen) ? Math.max(0, now - seen) : undefined;
    if (offlineMs !== undefined && offlineMs < minOfflineMs) return;
    const card = runnerOnlineNoticeCard({
      device,
      displayName: options.displayName?.(owner, device),
      at: new Date(now),
      ...(offlineMs !== undefined ? { lastSeenAt: new Date(seen), offlineMs } : {}),
    });
    void options.sendFeishu(owner, card).then(
      () => options.sent?.(owner, device),
      (error: unknown) => options.failed(owner, device, error),
    );
  };
}

export function runnerOnlineNoticeCard(input: {
  device: string;
  displayName?: string;
  at: Date;
  lastSeenAt?: Date;
  offlineMs?: number;
}): CardPayload {
  const label = input.displayName && input.displayName !== input.device
    ? `${input.displayName}（${input.device}）` : input.device;
  const lines = [`${label} 于 ${beijingTime(input.at)}（北京时间）连上 Octopus。`];
  lines.push(input.lastSeenAt && input.offlineMs !== undefined
    ? `上次在线 ${beijingTime(input.lastSeenAt)}，离线约 ${durationText(input.offlineMs)}。`
    : "此前没有在线记录。");
  return {
    header: { title: { tag: "plain_text", content: `设备已上线：${label}` }, template: "green" },
    // Device and display names are owner-chosen text: plain_text, never Markdown.
    elements: lines.map((content) => ({ tag: "div", text: { tag: "plain_text", content } })),
  };
}

function beijingTime(at: Date): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function durationText(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`;
  if (hours > 0) return minutes % 60 > 0 ? `${hours} 小时 ${minutes % 60} 分钟` : `${hours} 小时`;
  return `${Math.max(1, minutes)} 分钟`;
}
