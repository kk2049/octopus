import { describe, expect, it } from "vitest";

import { CONVERGENCE_CANDIDATES, MemoryConvergenceUsage, evaluateUsageWindow } from "./usage.js";

describe("G0 usage evidence", () => {
  it("never persists the principal or arbitrary payload", () => {
    const sink = new MemoryConvergenceUsage(Buffer.alloc(32, 7), () => new Date("2026-08-15T01:00:00Z"));
    sink.record({
      candidate: "bot-agent-session",
      principal: "alice@example.invalid",
      endpoint: "private-device-id",
      entry: "session.create",
      provider: "legacy-agent-session",
      effect: "execute",
      outcome: "ok",
      reason: "completed",
    });
    expect(sink.events).toHaveLength(1);
    expect(JSON.stringify(sink.events[0])).not.toContain("alice");
    expect(JSON.stringify(sink.events[0])).not.toContain("private-device-id");
    expect(sink.events[0]!.userKey).toMatch(/^[a-f0-9]{24}$/);
    expect(sink.events[0]!.endpointKey).toMatch(/^[a-f0-9]{24}$/);

    sink.record({
      candidate: "v3-host-factory",
      principal: "alice@example.invalid",
      entry: "v3-app.page",
      provider: "v3-host",
      release: "../../private/artifact",
      effect: "read",
      outcome: "observed",
    });
    expect(sink.events).toHaveLength(1);
  });

  it("requires explicit evidence from every candidate and a full window", () => {
    const sink = new MemoryConvergenceUsage(Buffer.alloc(32, 9), () => new Date("2026-08-15T02:00:00Z"));
    for (const candidate of CONVERGENCE_CANDIDATES) {
      sink.record({ candidate, principal: "system", entry: "window.observed", provider: "none", effect: "read", outcome: "observed" });
    }
    const verdict = evaluateUsageWindow(
      sink.events,
      new Date("2026-08-15T00:00:00Z"),
      new Date("2026-08-15T04:00:00Z"),
      4 * 3_600_000,
    );
    expect(verdict.status).toBe("pass");
    expect(verdict.counts).toHaveLength(CONVERGENCE_CANDIDATES.length);
    expect(verdict.counts.every((row) => row.count === 1)).toBe(true);
    expect(evaluateUsageWindow(
      sink.events.slice(1),
      new Date("2026-08-15T00:00:00Z"),
      new Date("2026-08-15T04:00:00Z"),
      4 * 3_600_000,
    ).status).toBe("fail");
  });
});
