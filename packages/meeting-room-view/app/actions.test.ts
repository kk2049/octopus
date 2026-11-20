import { describe, expect, it } from "vitest";
import { book_room } from "./actions.js";
import { project } from "./projection.js";

const AT = "2026-08-13T10:00:00Z";
const params = { date: "2026-08-18", room: "room-a", start: "10", end: "12", purpose: "产品评审" };

function context(log: any[] = [], role = "member") {
  return { now: AT, actor: { kind: "user", user: "alice", role }, state: project(log) };
}
function commit(log: any[], output: any, user = "alice") {
  return [...log, ...output.events.map((row: any) => ({ ...row, by: `user:${user}`, at: AT }))];
}

describe("book_room", () => {
  it("creates a half-open booking from trusted actor context", () => {
    const output = book_room(context(), params);
    expect(output.events[0]).toMatchObject({ type: "room_booked", data: { id: "booking-1", start: 10, end: 12 } });
  });

  it("rejects every overlap but permits an adjacent booking", () => {
    const log = commit([], book_room(context(), params));
    for (const range of [[9, 11], [10, 11], [11, 13]]) {
      expect(() => book_room(context(log), { ...params, start: range[0], end: range[1] })).toThrow(/overlaps/);
    }
    expect(() => book_room(context(log), { ...params, start: 12, end: 13 })).not.toThrow();
    expect(() => book_room(context(log), { ...params, room: "room-b", start: 10, end: 12 })).not.toThrow();
  });

  it("rejects bad ranges, dates, rooms, purposes and roles", () => {
    expect(() => book_room(context([], "watcher"), params)).toThrow(/room member/);
    expect(() => book_room(context(), { ...params, date: "2026-02-30" })).toThrow(/date/);
    expect(() => book_room(context(), { ...params, date: "2026-09-01" })).toThrow(/14-day/);
    expect(() => book_room(context(), { ...params, room: "attic" })).toThrow(/room/);
    expect(() => book_room(context(), { ...params, start: 20, end: 20 })).toThrow(/08:00/);
    expect(() => book_room(context(), { ...params, purpose: "  " })).toThrow(/purpose/);
  });
});
