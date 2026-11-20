import { describe, expect, it } from "vitest";
import { MEETING_ROOM_COMPOSITION, MEETING_ROOM_MODULE_LOCK } from "./plan.js";

describe("meeting room composition", () => {
  it("assembles only declared generic modules", () => {
    expect(MEETING_ROOM_COMPOSITION.instances.map((item) => item.module)).toContain("schedule.booking-grid/v1");
    expect(MEETING_ROOM_MODULE_LOCK.modules.map((item) => item.id)).toContain("schedule.booking-grid/v1");
    expect(JSON.stringify(MEETING_ROOM_COMPOSITION)).toContain("book_room");
  });
});
