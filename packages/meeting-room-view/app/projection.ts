const ROOMS = [
  { id: "room-a", label: "海棠 · 6人" },
  { id: "room-b", label: "银杏 · 10人" },
  { id: "room-c", label: "青松 · 16人" },
];

export function project(events: any[]) {
  return projectIncremental({}, events);
}

export function projectIncremental(snapshot: any, events: any[]) {
  const prior = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot) ? snapshot : {};
  const bookings: any[] = Array.isArray(prior.bookings)
    ? prior.bookings.map((booking: any) => booking && typeof booking === "object" ? { ...booking } : booking)
    : [];
  let sequence = Number.isSafeInteger(prior.sequence) && prior.sequence >= 0 ? prior.sequence : bookings.length;
  for (const row of Array.isArray(events) ? events : []) {
    if (row?.type !== "room_booked" || !row.data) continue;
    sequence += 1;
    bookings.push({
      id: String(row.data.id ?? `booking-${sequence}`),
      date: String(row.data.date ?? ""),
      room: String(row.data.room ?? ""),
      resource: String(row.data.room ?? ""),
      start: Number(row.data.start),
      end: Number(row.data.end),
      purpose: String(row.data.purpose ?? ""),
      title: String(row.data.purpose ?? ""),
      by: String(row.by ?? "").replace(/^user:/, ""),
      tone: "info",
      time: `${String(row.data.start ?? "").padStart(2, "0")}:00–${String(row.data.end ?? "").padStart(2, "0")}:00`,
    });
  }
  const dates = nextDays(14);
  for (const date of bookings.map((item) => item.date).sort()) {
    if (!dates.some((item) => item.date === date)) dates.push({ date, label: labelOf(date) });
  }
  return {
    sequence,
    bookings,
    schedule: { days: dates.slice(0, 31), resources: ROOMS, start_hour: 8, end_hour: 20, bookings },
    recent: bookings.slice(-50).reverse().map((item) => ({
      ...item, subtitle: `${roomLabel(item.room)} · ${item.date} ${item.time} · ${item.by}`,
    })),
    status_panel: {
      title: "会议室",
      房间数: "3",
      开放时段: "08:00–20:00",
      已有预约: String(bookings.length),
      冲突规则: "同房间半开区间不得相交",
    },
  };
}

function nextDays(count: number): Array<{ date: string; label: string }> {
  const base = new Date();
  const out: Array<{ date: string; label: string }> = [];
  for (let index = 0; index < count; index += 1) {
    const date = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + index));
    const iso = date.toISOString().slice(0, 10);
    out.push({ date: iso, label: index === 0 ? "今天" : index === 1 ? "明天" : `${date.getUTCMonth() + 1}月${date.getUTCDate()}日` });
  }
  return out;
}

function labelOf(date: string): string { return `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`; }
function roomLabel(id: string): string { return ROOMS.find((room) => room.id === id)?.label ?? id; }
