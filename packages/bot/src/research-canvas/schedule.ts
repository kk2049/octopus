import type { Schedule } from "@claude-bot/research-canvas-contract";
import { integer, object, text } from "./validation.js";

export function readSchedule(value: unknown): Schedule {
  const data = object(value),
    timezone = text(data.timezone, "时区", 80);
  new Intl.DateTimeFormat("en", { timeZone: timezone }).format(0);
  const missed = data.missed;
  if (missed !== "skip" && missed !== "latest")
    throw new Error("请选择漏触发处理方式");
  if (data.kind === "once")
    return { kind: "once", at: instant(data.at), timezone, missed };
  if (data.kind === "interval")
    return {
      kind: "interval",
      start: instant(data.start),
      minutes: integer(data.minutes, 1, 525600),
      timezone,
      missed,
    };
  if (data.kind !== "daily" && data.kind !== "weekly")
    throw new Error("计划类型无效");
  const time = text(data.time, "时间", 5);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
    throw new Error("时间应为 HH:MM");
  const weekdays =
    data.kind === "daily"
      ? [0, 1, 2, 3, 4, 5, 6]
      : Array.isArray(data.weekdays)
        ? [...new Set(data.weekdays.map((day) => integer(day, 0, 6)))]
        : [];
  if (!weekdays.length) throw new Error("请选择每周执行日");
  return { kind: data.kind, time, weekdays, timezone, missed };
}
function instant(value: unknown): string {
  const result = text(value, "绝对时间", 80);
  if (
    !/(Z|[+-]\d\d:\d\d)$/.test(result) ||
    !Number.isFinite(Date.parse(result))
  )
    throw new Error("绝对时间必须包含时区偏移");
  return new Date(result).toISOString();
}
/** UTC walk handles DST gaps without inventing a nonexistent local wall time. */
export function scheduleTick(
  schedule: Schedule,
  at: number,
  direction: "next" | "previous",
): { at: number; key: string } | null {
  if (schedule.kind === "once") {
    const time = Date.parse(schedule.at);
    return (direction === "next" ? time > at : time <= at)
      ? { at: time, key: schedule.at }
      : null;
  }
  if (schedule.kind === "interval") {
    const start = Date.parse(schedule.start),
      step = schedule.minutes * 60_000;
    const index =
      direction === "next"
        ? Math.max(0, Math.floor((at - start) / step) + 1)
        : Math.floor((at - start) / step);
    return index < 0
      ? null
      : { at: start + index * step, key: String(start + index * step) };
  }
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: schedule.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const sign = direction === "next" ? 1 : -1;
  let time =
    Math.floor(at / 60_000) * 60_000 + (direction === "next" ? 60_000 : 0);
  for (let i = 0; i < 8 * 24 * 60; i++, time += sign * 60_000) {
    const parts = Object.fromEntries(
      formatter.formatToParts(time).map((part) => [part.type, part.value]),
    );
    if (
      `${parts.hour}:${parts.minute}` === schedule.time &&
      schedule.weekdays.includes(days.indexOf(parts.weekday))
    ) {
      // Both fall-back occurrences share a key, so the durable event deduper
      // schedules exactly once for that local date and wall time.
      return {
        at: time,
        key: `${parts.year}-${parts.month}-${parts.day}T${schedule.time}@${schedule.timezone}`,
      };
    }
  }
  throw new Error("未能计算下一次计划时间");
}
