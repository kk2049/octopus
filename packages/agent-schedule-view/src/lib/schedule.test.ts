import { describe, expect, it } from "vitest";
import { bookingAt, readSchedule } from "./schedule.js";

const GOOD = {
  days: [{ date: "2026-08-17", label: "周一" }], resources: [{ id: "r1", label: "一号" }],
  start_hour: 8, end_hour: 12,
  bookings: [{ id: "b1", date: "2026-08-17", resource: "r1", start: 9, end: 11, title: "评审", by: "alice", tone: "info" }],
};

describe("schedule reader", () => {
  it("reads a bounded half-open resource schedule", () => {
    const out = readSchedule(GOOD);
    expect(out.status).toBe("ok");
    expect(bookingAt(out, "2026-08-17", "r1", 9)?.id).toBe("b1");
    expect(bookingAt(out, "2026-08-17", "r1", 10)?.id).toBe("b1");
    expect(bookingAt(out, "2026-08-17", "r1", 11)).toBeNull();
  });

  it("distinguishes a missing path, malformed frame and oversized frame", () => {
    expect(readSchedule(undefined).status).toBe("missing");
    expect(readSchedule({ days: [] }).status).toBe("malformed");
    expect(readSchedule({ ...GOOD, days: Array.from({ length: 32 }, () => GOOD.days[0]) }).status).toBe("too_large");
  });
});
