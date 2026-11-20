import { AvButton, AvInput, Banner, StatusChip } from "@claude-bot/agent-view-react/ui";
import type { ScheduleReadout } from "../lib/schedule.js";
import { bookingAt } from "../lib/schedule.js";

export interface BookingDraft { date: string; resource: string; start: number; end: number }
export interface BookingGridProps {
  schedule: ScheduleReadout;
  source: string;
  day: string;
  draft: BookingDraft | null;
  purpose: string;
  busy: boolean;
  notice: { tone: "ok" | "warn" | "error" | "info"; text: string } | null;
  purposeLabel: string;
  submitLabel: string;
  emptyText: string;
  onDay(date: string): void;
  onSlot(resource: string, hour: number): void;
  onPurpose(value: string): void;
  onSubmit(): void;
}

export function BookingGrid(props: BookingGridProps) {
  const { schedule, source, day, draft, purpose, busy, notice, purposeLabel, submitLabel, emptyText,
    onDay, onSlot, onPurpose, onSubmit } = props;
  if (schedule.status !== "ok") {
    const words = schedule.status === "missing" ? "投影路径不存在" : schedule.status === "too_large" ? "日历超出模块上限" : "日历数据不可读";
    return <p className="sv-note" role="note">{words}：<code>{source}</code></p>;
  }
  if (!schedule.days.length || !schedule.resources.length) return <p className="sv-note" role="note">{emptyText || "没有可预约日期或资源。"}</p>;
  const visibleDay = schedule.days.find((item) => item.date === day) ?? null;
  return (
    <section className="sv-booking" data-sv-source={source} aria-busy={busy || undefined}>
      <div className="sv-days" role="tablist" aria-label="选择日期">
        {schedule.days.map((item) => (
          <AvButton key={item.date} role="tab" aria-selected={item.date === day} onClick={() => onDay(item.date)}>
            <b>{item.label}</b><small>{item.date.slice(5)}</small>
          </AvButton>
        ))}
      </div>
      {!visibleDay ? <p className="sv-note" role="note">选中的日期暂不在当前投影中。</p> : (
        <div className="sv-grid" role="grid" aria-label={`${visibleDay.label} 预约表`}
          style={{ gridTemplateColumns: `64px repeat(${schedule.resources.length}, minmax(120px, 1fr))` }}>
          <div className="sv-corner" />
          {schedule.resources.map((resource) => <div role="columnheader" className="sv-resource" key={resource.id}>{resource.label}</div>)}
          {Array.from({ length: schedule.endHour - schedule.startHour }, (_, index) => schedule.startHour + index).map((hour) => (
            <div className="sv-row" role="row" key={hour}>
              <div role="rowheader" className="sv-hour">{String(hour).padStart(2, "0")}:00</div>
              {schedule.resources.map((resource) => {
                const booking = bookingAt(schedule, day, resource.id, hour);
                const selected = Boolean(draft && draft.date === day && draft.resource === resource.id
                  && draft.start <= hour && hour < draft.end);
                return (
                  <button type="button" role="gridcell" className="sv-slot" key={resource.id}
                    data-tone={booking?.tone ?? undefined} aria-selected={selected || undefined}
                    aria-label={booking
                      ? `${resource.label} ${hour}:00 已预约：${booking.title}`
                      : `${resource.label} ${hour}:00 可预约`}
                    disabled={busy || Boolean(booking)} onClick={() => onSlot(resource.id, hour)}>
                    {booking ? <><span>{booking.title}</span><small>{booking.by}</small></> : selected ? "已选" : ""}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
      <div className="sv-compose">
        <div className="sv-range">
          {draft
            ? <StatusChip word={`${draft.date} · ${draft.start}:00–${draft.end}:00`} tone="info" />
            : <span>先点一个空闲小时；再点同一会议室的另一个小时可扩展时段。</span>}
        </div>
        <label>{purposeLabel || "用途"}
          <AvInput value={purpose} maxLength={500} disabled={busy} placeholder="例如：产品评审"
            onChange={(event) => onPurpose(event.target.value)} />
        </label>
        <AvButton tone="primary" disabled={busy || !draft || !purpose.trim()} onClick={onSubmit}>
          {busy ? "提交中…" : submitLabel || "确认预约"}
        </AvButton>
      </div>
      {notice ? <Banner tone={notice.tone} title={notice.text} /> : null}
    </section>
  );
}
