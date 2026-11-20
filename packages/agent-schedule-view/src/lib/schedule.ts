export type ScheduleTone = "neutral" | "ok" | "warn" | "error" | "info";
export type ScheduleStatus = "ok" | "missing" | "malformed" | "too_large";

export interface ScheduleDay { date: string; label: string }
export interface ScheduleResource { id: string; label: string }
export interface ScheduleBooking {
  id: string; date: string; resource: string; start: number; end: number;
  title: string; by: string; tone: ScheduleTone;
}
export interface ScheduleReadout {
  status: ScheduleStatus;
  days: readonly ScheduleDay[];
  resources: readonly ScheduleResource[];
  startHour: number;
  endHour: number;
  bookings: readonly ScheduleBooking[];
}

export const SCHEDULE_LIMITS = Object.freeze({ days: 31, resources: 12, bookings: 500 });
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[a-z0-9][a-z0-9_-]{0,79}$/i;
const TONES = new Set<ScheduleTone>(["neutral", "ok", "warn", "error", "info"]);
const EMPTY: ScheduleReadout = Object.freeze({
  status: "malformed", days: [], resources: [], startHour: 0, endHour: 0, bookings: [],
});

export function readSchedule(value: unknown): ScheduleReadout {
  if (value === undefined) return { ...EMPTY, status: "missing" };
  if (!value || typeof value !== "object" || Array.isArray(value)) return EMPTY;
  const row = value as Record<string, unknown>;
  if (!Array.isArray(row.days) || !Array.isArray(row.resources) || !Array.isArray(row.bookings)) return EMPTY;
  if (row.days.length > SCHEDULE_LIMITS.days || row.resources.length > SCHEDULE_LIMITS.resources
    || row.bookings.length > SCHEDULE_LIMITS.bookings) return { ...EMPTY, status: "too_large" };
  const startHour = hour(row.start_hour);
  const endHour = hour(row.end_hour);
  if (startHour === null || endHour === null || endHour <= startHour) return EMPTY;
  const days = unique(row.days.map(dayOf).filter((day): day is ScheduleDay => day !== null), (day) => day.date);
  const resources = unique(
    row.resources.map(resourceOf).filter((item): item is ScheduleResource => item !== null),
    (item) => item.id,
  );
  if (!days.length || !resources.length) return { status: "ok", days, resources, startHour, endHour, bookings: [] };
  const daySet = new Set(days.map((day) => day.date));
  const resourceSet = new Set(resources.map((item) => item.id));
  const bookings: ScheduleBooking[] = [];
  for (const input of row.bookings) {
    if (!input || typeof input !== "object" || Array.isArray(input)) continue;
    const item = input as Record<string, unknown>;
    const start = hour(item.start);
    const end = hour(item.end);
    const date = text(item.date, 10);
    const resource = text(item.resource, 80);
    if (!ID.test(text(item.id, 80)) || !daySet.has(date) || !resourceSet.has(resource)
      || start === null || end === null || start < startHour || end > endHour || end <= start) continue;
    const tone = text(item.tone, 16) as ScheduleTone;
    bookings.push({
      id: text(item.id, 80), date, resource, start, end,
      title: text(item.title, 120), by: text(item.by, 80), tone: TONES.has(tone) ? tone : "neutral",
    });
  }
  return { status: "ok", days, resources, startHour, endHour, bookings };
}

export function bookingAt(readout: ScheduleReadout, date: string, resource: string, hourValue: number): ScheduleBooking | null {
  return readout.bookings.find(
    (booking) => booking.date === date && booking.resource === resource
      && booking.start <= hourValue && hourValue < booking.end,
  ) ?? null;
}

function hour(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 24 ? value : null;
}
function text(value: unknown, max: number): string { return typeof value === "string" ? value.slice(0, max) : ""; }
function dayOf(value: unknown): ScheduleDay | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const date = text(row.date, 10);
  return DATE.test(date) ? { date, label: text(row.label, 40) || date } : null;
}
function resourceOf(value: unknown): ScheduleResource | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const id = text(row.id, 80);
  return ID.test(id) ? { id, label: text(row.label, 80) || id } : null;
}
function unique<T>(rows: readonly T[], key: (row: T) => string): T[] {
  const seen = new Set<string>();
  return rows.filter((row) => (seen.has(key(row)) ? false : (seen.add(key(row)), true)));
}
