import { useState } from "react";
import type { ResearchNode } from "@claude-bot/research-canvas-contract";
import { requestId, type Call } from "../client.js";

export function TimerSettings({
  node,
  call,
  editable,
}: {
  node: ResearchNode;
  call: Call;
  editable: boolean;
}) {
  const initial = node.data.schedule as Record<string, unknown> | undefined;
  const [kind, setKind] = useState(String(initial?.kind ?? "daily")),
    [time, setTime] = useState(String(initial?.time ?? "09:00")),
    [timezone, setTimezone] = useState(
      String(initial?.timezone ?? "Asia/Shanghai"),
    ),
    [at, setAt] = useState(String(initial?.at ?? "")),
    [minutes, setMinutes] = useState(String(initial?.minutes ?? 60)),
    [missed, setMissed] = useState(String(initial?.missed ?? "latest")),
    [error, setError] = useState(""),
    [weekdays, setWeekdays] = useState<number[]>(
      (initial?.weekdays as number[]) ?? [1],
    );
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        try {
          await call("node_update", {
            request: requestId(),
            node: node.id,
            version: node.version,
            data: {
              data: {
                schedule: {
                  kind,
                  timezone,
                  missed,
                  ...(kind === "once"
                    ? { at }
                    : kind === "interval"
                      ? {
                          start: new Date().toISOString(),
                          minutes: Number(minutes),
                        }
                      : { time, weekdays }),
                },
              },
            },
          });
        } catch (error) {
          setError(String(error));
        }
      }}
    >
      <label>
        计划
        <select value={kind} onChange={(event) => setKind(event.target.value)}>
          <option value="once">一次</option>
          <option value="daily">每天</option>
          <option value="weekly">每周</option>
          <option value="interval">固定间隔</option>
        </select>
      </label>
      <label>
        时区
        <input
          value={timezone}
          onChange={(event) => setTimezone(event.target.value)}
        />
      </label>
      {kind === "once" ? (
        <label>
          含时区的时间
          <input
            value={at}
            onChange={(event) => setAt(event.target.value)}
            placeholder="2026-09-18T09:00:00+08:00"
          />
        </label>
      ) : kind === "interval" ? (
        <label>
          间隔分钟
          <input
            type="number"
            min="1"
            value={minutes}
            onChange={(event) => setMinutes(event.target.value)}
          />
        </label>
      ) : (
        <label>
          时间
          <input
            type="time"
            value={time}
            onChange={(event) => setTime(event.target.value)}
          />
        </label>
      )}
      {kind === "weekly" && (
        <fieldset>
          <legend>执行日</legend>
          {["日", "一", "二", "三", "四", "五", "六"].map((day, index) => (
            <label className="rv-check" key={day}>
              <input
                type="checkbox"
                checked={weekdays.includes(index)}
                onChange={(event) =>
                  setWeekdays((prior) =>
                    event.target.checked
                      ? [...prior, index]
                      : prior.filter((value) => value !== index),
                  )
                }
              />
              周{day}
            </label>
          ))}
        </fieldset>
      )}
      <label>
        错过计划时
        <select
          value={missed}
          onChange={(event) => setMissed(event.target.value)}
        >
          <option value="latest">补最近一次</option>
          <option value="skip">跳过</option>
        </select>
      </label>
      <button disabled={!editable}>保存计划</button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
