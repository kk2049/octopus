import { describe, expect, it } from "vitest";
import type { FlightEvent } from "./recorder.js";
import {
  evaluateAsserts,
  noFlap,
  noShrink,
  pendingSettles,
  revisionMonotonic,
  violationEvent,
} from "./asserts.js";
import { envelopeAssert } from "./envelope.js";

function frame(ts: number, delta: FlightEvent["delta"]): FlightEvent {
  return { ts, source: "frame", kind: "frame.projection", key: "sessions+", delta };
}
function propose(ts: number, key: string, rid?: string): FlightEvent {
  return { ts, source: "user", kind: "user.propose", key, delta: {}, ...(rid ? { rid } : {}) };
}
function uiState(ts: number, key: string, on: boolean): FlightEvent {
  return { ts, source: "ui", kind: "ui.state", key, delta: { on } };
}

describe("no-shrink", () => {
  const assert = noShrink({ collection: "sessions", exemptActions: ["search_sessions"] });

  it("flags a settled collapse and skips loading frames entirely", () => {
    const events = [
      frame(0, { sessions: 187 }),
      // The #138 shape: a loading head frame is progressive disclosure.
      frame(10, { sessions: 20, resourceState: "loading" }),
      frame(20, { sessions: 187 }),
      frame(30, { sessions: 12 }),
    ];
    const violations = assert.evaluate(events, 1_000);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      key: "sessions",
      at: 30,
      delta: { previous: 187, next: 12 },
    });
  });

  it("excuses a shrink right after an exempt user action", () => {
    const events = [
      frame(0, { sessions: 187 }),
      propose(100, "search_sessions"),
      frame(200, { sessions: 4 }),
    ];
    expect(assert.evaluate(events, 1_000)).toEqual([]);
  });
});

describe("no-flap", () => {
  it("tolerates a few flips and reports the oscillation once", () => {
    const assert = noFlap({ key: "absent", maxFlips: 3, windowMs: 10_000 });
    const calm = [uiState(0, "absent", true), uiState(1_000, "absent", false)];
    expect(assert.evaluate(calm, 20_000)).toEqual([]);

    const flappy = [0, 1, 2, 3, 4, 5].map((i) => uiState(i * 500, "absent", i % 2 === 0));
    const violations = assert.evaluate(flappy, 20_000);
    expect(violations).toHaveLength(1);
    expect(violations[0].assert).toBe("no-flap:absent");
  });
});

describe("pending-settles", () => {
  const assert = pendingSettles({ timeoutMs: 5_000 });

  it("flags only proposals past the timeout with no same-rid answer", () => {
    const events = [
      propose(0, "open_session", "rid-1"),
      { ts: 1_000, source: "frame", kind: "frame.projection", key: "sessions+", delta: {}, rid: "rid-1" } as FlightEvent,
      propose(2_000, "append_session", "rid-2"),
      propose(9_000, "append_session", "rid-3"),
    ];
    const violations = assert.evaluate(events, 10_000);
    expect(violations).toHaveLength(1);
    expect(violations[0].key).toBe("rid-2");
  });
});

describe("revision-monotonic", () => {
  it("flags a regressed revision per surface key", () => {
    const events = [
      frame(0, { revision: 10 }),
      frame(10, { revision: 11 }),
      frame(20, { revision: 9 }),
    ];
    const violations = revisionMonotonic().evaluate(events, 100);
    expect(violations).toHaveLength(1);
    expect(violations[0].delta).toEqual({ previous: 11, next: 9 });
  });
});

describe("intent envelope", () => {
  const envelope = envelopeAssert({
    action: "refresh_sessions",
    withinMs: 3_000,
    expect: [{ kind: "frame.projection", source: "frame" }],
    forbid: [{ kind: "ui.state", key: "absent" }],
  });

  it("waits for the budget to elapse before judging", () => {
    const events = [propose(0, "refresh_sessions", "rid-1")];
    expect(envelope.evaluate(events, 2_000)).toEqual([]);
    const late = envelope.evaluate(events, 4_000);
    expect(late).toHaveLength(1);
    expect(late[0].summary).toContain("expected frame.projection");
  });

  it("passes a satisfied envelope and flags a forbidden event", () => {
    const good = [propose(0, "refresh_sessions"), frame(500, { sessions: 10 })];
    expect(envelope.evaluate(good, 10_000)).toEqual([]);

    const bad = [
      propose(0, "refresh_sessions"),
      frame(500, { sessions: 10 }),
      uiState(800, "absent", true),
    ];
    const violations = envelope.evaluate(bad, 10_000);
    expect(violations).toHaveLength(1);
    expect(violations[0].summary).toContain("forbidden ui.state:absent");
  });
});

describe("engine", () => {
  it("runs every assert and converts violations to recordable events", () => {
    const events = [frame(0, { revision: 2 }), frame(10, { revision: 1 })];
    const violations = evaluateAsserts([revisionMonotonic()], events, 100);
    expect(violations).toHaveLength(1);
    const recorded = violationEvent(violations[0]);
    expect(recorded).toMatchObject({
      source: "assert",
      kind: "assert.violation",
      key: "revision-monotonic",
      ts: 10,
    });
  });
});
