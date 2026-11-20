const ROOMS = new Set(["room-a", "room-b", "room-c"]);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function book_room(ctx: any, params: any) {
  const role = ctx?.actor?.role;
  if (role !== "coordinator" && role !== "member") throw new Error("only a room member may book");
  const date = bounded(params?.date, 10, "date");
  if (!DATE.test(date) || !validDate(date)) throw new Error("date must be YYYY-MM-DD");
  const today = String(ctx?.now ?? "").slice(0, 10);
  if (!DATE.test(today) || !validDate(today)) throw new Error("trusted clock is invalid");
  const horizon = addDays(today, 13);
  if (date < today || date > horizon) throw new Error("date must be inside the current 14-day calendar");
  const room = bounded(params?.room, 16, "room");
  if (!ROOMS.has(room)) throw new Error("unknown room");
  const start = integer(params?.start);
  const end = integer(params?.end);
  if (start < 8 || end > 20 || start >= end) throw new Error("booking must be a non-empty range inside 08:00..20:00");
  const purpose = bounded(params?.purpose, 500, "purpose").trim();
  if (!purpose) throw new Error("purpose is required");
  const bookings = Array.isArray(ctx?.state?.bookings) ? ctx.state.bookings : [];
  const conflict = bookings.find((item: any) => item?.date === date && item?.room === room
    && Number(item?.start) < end && start < Number(item?.end));
  if (conflict) throw new Error(`time overlaps booking ${String(conflict.id ?? "")}`);
  const sequence = Number(ctx?.state?.sequence ?? 0) + 1;
  return {
    events: [event(ctx, "room_booked", { id: `booking-${sequence}`, date, room, start, end, purpose })],
    result: { id: `booking-${sequence}` },
  };
}

function bounded(value: any, max: number, name: string): string {
  if (typeof value !== "string" || value.length > max) throw new Error(`${name} is invalid`);
  return value;
}

function integer(value: any): number {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d{1,2}$/.test(value)) return Number(value);
  return -1;
}

function validDate(value: string): boolean {
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year!, month! - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month! - 1 && parsed.getUTCDate() === day;
}

function addDays(value: string, count: number): string {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + count)).toISOString().slice(0, 10);
}

function event(ctx: any, type: string, data: any) {
  return { type, data, at: String(ctx?.now ?? ""), by: "meeting-room" };
}
