/**
 * The trusted page's timeline: proposals correlate with settlements by rid,
 * frames carry summarised counts (never payloads), and the monitor finds a
 * seeded roster collapse and reports it exactly once.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { composeFeedbackBody, createPageFlight, publishFlightHook } from "./flight.js";

describe("page flight", () => {
  afterEach(() => {
    delete window.__octopusFlight;
  });

  it("records propose/settle/frame with rid correlation and bounded deltas", () => {
    let ts = 1_000;
    const flight = createPageFlight("sessions+", { now: () => ts });
    const rid = flight.propose("refresh_sessions");
    ts = 1_100;
    flight.frame({ sessions: [1, 2, 3], operations: [], secret: "payload" }, 7, rid);
    ts = 1_200;
    flight.settle(rid, true);
    flight.wake();
    flight.channel("reconnecting");

    const events = flight.recorder.events();
    expect(events.map((event) => event.kind)).toEqual([
      "user.propose",
      "frame.projection",
      "user.settle",
      "wire.wake",
      "wire.channel",
    ]);
    expect(events[0].rid).toBe(rid);
    expect(events[1].rid).toBe(rid);
    // Counts only — the projection's contents never enter the timeline.
    expect(events[1].delta).toEqual({ revision: 7, sessions: 3, operations: 0 });
    expect(JSON.stringify(events)).not.toContain("payload");
  });

  it("summarises frame-over-frame changes so a shrink is one visible event", () => {
    const flight = createPageFlight("sessions+", { now: () => 0 });
    flight.frame({ sessions: new Array(187).fill(0) }, 1);
    flight.frame({ sessions: new Array(12).fill(0) }, 2);
    const [, second] = flight.recorder.events();
    expect(second.delta).toEqual({ revision: 2, sessions: 12, "sessions.prev": 187 });
  });

  it("records only revisions the Host can apply", () => {
    const flight = createPageFlight("sessions+", { now: () => 0 });
    flight.frame({ sessions: [1] }, 9);
    flight.frame({ sessions: [1, 2] }, 8, "late-action");
    flight.frame({ sessions: [1, 2, 3] }, 10);

    expect(flight.recorder.events().map((event) => event.delta.revision)).toEqual([9, 10]);
    const stop = flight.startMonitor();
    expect(flight.violations()).toEqual([]);
    stop();
  });

  it("monitor finds a settled collapse once and archives the finding", () => {
    vi.useFakeTimers();
    try {
      let ts = 0;
      const flight = createPageFlight("sessions+", { now: () => ts });
      flight.frame({ sessions: new Array(187).fill(0) }, 1);
      ts = 1_000;
      flight.frame({ sessions: new Array(12).fill(0) }, 2);
      const stop = flight.startMonitor(1_000);
      expect(flight.violations()).toHaveLength(1);
      expect(flight.violations()[0].assert).toBe("no-shrink:sessions");
      // Later passes must not duplicate the same finding.
      ts = 5_000;
      vi.advanceTimersByTime(4_000);
      expect(flight.violations()).toHaveLength(1);
      const archived = flight.recorder.events().filter((event) => event.kind === "assert.violation");
      expect(archived).toHaveLength(1);
      expect(document.body.getAttribute("data-flight-violations")).toBe("1");
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("composes a bounded feedback body — description first, every block clipped", () => {
    const body = composeFeedbackBody({
      description: "  列表在闪  ",
      picked: { tag: "div", text: "y".repeat(9_000) },
      timeline: new Array(300).fill({ kind: "frame.projection" }),
      violations: [{ assert: "no-flap:absent", key: "absent", at: 1, summary: "s", delta: {} }],
    });
    expect(body.startsWith("列表在闪")).toBe(true);
    expect(body).toContain("断言违例(1)");
    expect(body).toContain("最近 80 条");
    expect(body).toContain("已截断");
    expect(body.length).toBeLessThan(20_000);
    // Absent blocks stay absent instead of rendering empty fences.
    expect(composeFeedbackBody({ description: "x" })).not.toContain("View 侧");
  });

  it("publishes the export-only window hook", () => {
    const flight = createPageFlight("sessions+", { now: () => 3 });
    publishFlightHook(flight);
    flight.wake();
    const parsed = JSON.parse(window.__octopusFlight!.export()) as { events: unknown[] };
    expect(parsed.events).toHaveLength(1);
    expect(window.__octopusFlight!.violations()).toEqual([]);
  });
});
