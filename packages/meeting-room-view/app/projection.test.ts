import { describe, expect, it } from "vitest";
import { project, projectIncremental } from "./projection.js";

describe("meeting room projection", () => {
  it("always declares three rooms and fourteen immediately usable days", () => {
    const view = project([]);
    expect(view.schedule.resources.map((room: any) => room.id)).toEqual(["room-a", "room-b", "room-c"]);
    expect(view.schedule.days).toHaveLength(14);
    expect(view.schedule).toMatchObject({ start_hour: 8, end_hour: 20, bookings: [] });
  });

  it("folds trusted attribution into calendar and recent-list shapes", () => {
    const view = project([{ type: "room_booked", at: "x", by: "user:alice", data: {
      id: "booking-1", date: "2030-01-01", room: "room-b", start: 9, end: 11, purpose: "季度复盘",
    } }]);
    expect(view.bookings[0]).toMatchObject({ by: "alice", resource: "room-b", title: "季度复盘" });
    expect(view.recent[0].subtitle).toContain("银杏");
    expect(view.schedule.days.some((day: any) => day.date === "2030-01-01")).toBe(true);
  });

  it("is total over malformed logs", () => expect(project("bad" as any).bookings).toEqual([]));
});
describe("incremental meeting room projection", () => {
  it("matches a complete fold across a snapshot boundary", () => {
    const events = [
      { type: "room_booked", at: "x", by: "user:alice", data: { id: "booking-1", date: "2030-01-01", room: "room-a", start: 9, end: 10, purpose: "one" } },
      { type: "room_booked", at: "y", by: "user:bob", data: { id: "booking-2", date: "2030-01-02", room: "room-b", start: 11, end: 12, purpose: "two" } },
    ];
    expect(projectIncremental(project(events.slice(0, 1)), events.slice(1))).toEqual(project(events));
  });
});
