import { describe, expect, it } from "vitest";
import { projectionFacts, summarizeProjectionFrame } from "./projection-summary.js";

describe("projection facts", () => {
  it("counts only the named array collections and never guesses", () => {
    const facts = projectionFacts(
      {
        sessions: [1, 2, 3],
        operations: [],
        transcript: { "res-1": {} },
        secret: ["not", "asked", "for"],
        resourceState: "loading",
      },
      { collections: ["sessions", "operations", "transcript", "missing"], revision: 12 },
    );
    expect(facts).toEqual({
      revision: 12,
      resourceState: "loading",
      // `transcript` is an object and `missing` is absent: both are honestly
      // absent facts, not zeros — a shrink assert must tell those apart.
      collections: { sessions: 3, operations: 0 },
    });
  });

  it("tolerates non-object projections and non-string state markers", () => {
    expect(projectionFacts(null, { collections: ["sessions"] })).toEqual({ collections: {} });
    expect(projectionFacts({ resourceState: 7, sessions: [1] }, { collections: ["sessions"] }))
      .toEqual({ collections: { sessions: 1 } });
  });
});

describe("projection frame summary", () => {
  it("emits flat counts, and `.prev` only where a size actually changed", () => {
    const previous = { revision: 11, collections: { sessions: 187, operations: 2 } };
    const next = {
      revision: 12,
      resourceState: "loading",
      collections: { sessions: 20, operations: 2 },
    };
    expect(summarizeProjectionFrame(previous, next)).toEqual({
      revision: 12,
      resourceState: "loading",
      sessions: 20,
      "sessions.prev": 187,
      operations: 2,
    });
  });

  it("stays a flat count list with no previous frame", () => {
    expect(summarizeProjectionFrame(null, { collections: { sessions: 3 } }))
      .toEqual({ sessions: 3 });
  });
});
