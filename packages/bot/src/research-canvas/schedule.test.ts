import { describe, expect, it } from "vitest";
import { readSchedule, scheduleTick } from "./schedule.js";
describe("research schedules across local clock changes", () => {
  it("skips a nonexistent local time in a spring DST gap", () => {
    const schedule = readSchedule({
      kind: "daily",
      time: "02:30",
      timezone: "America/New_York",
      missed: "latest",
    });
    expect(
      scheduleTick(schedule, Date.parse("2026-03-08T06:59:00Z"), "next")?.at,
    ).toBe(Date.parse("2026-03-09T06:30:00Z"));
  });
  it("gives both fall-back occurrences one durable event identity", () => {
    const schedule = readSchedule({
      kind: "daily",
      time: "01:30",
      timezone: "America/New_York",
      missed: "latest",
    });
    const first = scheduleTick(
      schedule,
      Date.parse("2026-11-01T05:29:00Z"),
      "next",
    );
    const second = scheduleTick(schedule, first!.at, "next");
    expect(first?.at).toBe(Date.parse("2026-11-01T05:30:00Z"));
    expect(second?.at).toBe(Date.parse("2026-11-01T06:30:00Z"));
    expect(second?.key).toBe(first?.key);
  });
  it("respects selected weekdays, validates zones and requires explicit offsets for instants", () => {
    const schedule = readSchedule({
      kind: "weekly",
      time: "09:00",
      weekdays: [5],
      timezone: "Asia/Shanghai",
      missed: "skip",
    });
    expect(
      scheduleTick(schedule, Date.parse("2026-09-17T12:00:00Z"), "next")?.at,
    ).toBe(Date.parse("2026-09-18T01:00:00Z"));
    expect(() =>
      readSchedule({
        kind: "once",
        at: "2026-09-17T12:00",
        timezone: "UTC",
        missed: "skip",
      }),
    ).toThrow("偏移");
    expect(() =>
      readSchedule({ ...schedule, timezone: "invalid/place" }),
    ).toThrow();
  });
});
