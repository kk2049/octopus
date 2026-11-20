import { describe, expect, it } from "vitest";
import { msUntilNextBeijingHour } from "./nightly-clock.js";

describe("msUntilNextBeijingHour", () => {
  it("returns 8h at UTC noon before Beijing 04:00 (=UTC 20:00 same day)", () => {
    const now = new Date(Date.UTC(2026, 6, 27, 12, 0, 0));
    expect(msUntilNextBeijingHour(now, 4)).toBe(8 * 3600 * 1000);
  });

  it("jumps to tomorrow when today's target has passed", () => {
    // 21:00 UTC = 05:00 Beijing next day → already past 04:00, wait ~23h
    const now = new Date(Date.UTC(2026, 6, 27, 21, 0, 0));
    expect(msUntilNextBeijingHour(now, 4)).toBe(23 * 3600 * 1000);
  });

  it("returns 24h when now exactly matches the trigger (must not fire twice)", () => {
    // 20:00 UTC = 04:00 Beijing next day. If now === target, schedule 24h out
    // rather than 0 — a self-rescheduling timer would busy-loop.
    const now = new Date(Date.UTC(2026, 6, 27, 20, 0, 0));
    expect(msUntilNextBeijingHour(now, 4)).toBe(24 * 3600 * 1000);
  });

  it("handles arbitrary Beijing hours across the day boundary", () => {
    // 02:00 Beijing = 18:00 UTC previous day; at UTC 17:00, wait 1h
    const now = new Date(Date.UTC(2026, 6, 27, 17, 0, 0));
    expect(msUntilNextBeijingHour(now, 2)).toBe(1 * 3600 * 1000);
  });
});
