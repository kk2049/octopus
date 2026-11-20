import { describe, expect, it } from "vitest";

import { buildFlows } from "./flows.js";

describe("annotated architecture flows", () => {
  it("joins source-local relationships to declared external entry steps", () => {
    const result = buildFlows({
      definitions: [{
        id: "request",
        title: "Request",
        description: "",
        perspective: "control",
        coverage: { mode: "critical-branches", scope: "fixture request" },
        entrySteps: [{ id: "client", label: "Client", zone: "external", after: [], anchorRequired: false }],
      }],
      modules: [{ id: "server", label: "Server", description: "", zone: "trusted", criticality: "high", pathPrefixes: ["src/"] }],
      annotations: [{
        id: "a",
        attributes: { flow: "request", step: "gate", after: "client", label: "Identity gate", enforces: "AUTH-1", condition: "identity exists", outcome: "dispatch", authority: "bound session", terminal: "true" },
        source: { path: "src/server.ts", line: 8 },
      }],
    });
    expect(result.flows[0].steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "client" }),
      expect.objectContaining({ id: "gate", after: ["client"], module: "server", enforces: ["AUTH-1"], condition: "identity exists", outcome: "dispatch", authority: "bound session", terminal: true }),
    ]));
    expect(result.flows[0].missingAnchors).toEqual([]);
    expect(result.flows[0].steps.map((step) => step.id)).toEqual(["client", "gate"]);
  });

  it("reports malformed terminal metadata next to the source anchor", () => {
    const result = buildFlows({
      definitions: [{ id: "f", title: "F", description: "", perspective: "control" }],
      modules: [],
      annotations: [{ id: "bad", attributes: { flow: "f", step: "done", terminal: "yes" }, source: { path: "x.ts", line: 7 } }],
    });
    expect(result.flows[0].invalidAttributes).toEqual(["step \"done\" terminal must be true or false"]);
    expect(result.issues[0]).toMatchObject({ annotation: { id: "bad" } });
  });

  it("requires branch metadata for a critical-branches contract", () => {
    const result = buildFlows({
      definitions: [{ id: "f", title: "F", description: "", perspective: "authority", coverage: { mode: "critical-branches", scope: "fixture" } }],
      modules: [],
      annotations: [{ id: "sparse", attributes: { flow: "f", step: "gate" }, source: { path: "x.ts", line: 8 } }],
    });
    expect(result.flows[0].invalidAttributes).toEqual([
      "step \"gate\" needs condition metadata",
      "step \"gate\" needs outcome metadata",
      "step \"gate\" needs authority metadata",
    ]);
  });

  it("makes duplicate and dangling anchors visible", () => {
    const annotation = { id: "a", attributes: { flow: "f", step: "x", after: "missing" }, source: { path: "x.ts", line: 1 } };
    const result = buildFlows({
      definitions: [{ id: "f", title: "F", description: "", perspective: "authority" }],
      modules: [],
      annotations: [annotation, { ...annotation, id: "b", source: { path: "x.ts", line: 2 } }],
    });
    expect(result.flows[0].duplicateAnchors).toEqual(["x"]);
    expect(result.flows[0].missingPredecessors).toEqual([{ stepId: "x", predecessorId: "missing" }]);
    expect(result.issues[0].message).toMatch(/missing step/);
  });

  it("orders cross-file steps by predecessors and reports cycles", () => {
    const ordered = buildFlows({
      definitions: [{ id: "f", title: "F", description: "", perspective: "control" }], modules: [],
      annotations: [
        { id: "later", attributes: { flow: "f", step: "later", after: "first" }, source: { path: "a.ts", line: 1 } },
        { id: "first", attributes: { flow: "f", step: "first" }, source: { path: "z.ts", line: 1 } },
      ],
    });
    expect(ordered.flows[0].steps.map((step) => step.id)).toEqual(["first", "later"]);

    const cyclic = buildFlows({
      definitions: [{ id: "f", title: "F", description: "", perspective: "control" }], modules: [],
      annotations: [
        { id: "a", attributes: { flow: "f", step: "a", after: "b" }, source: { path: "a.ts", line: 1 } },
        { id: "b", attributes: { flow: "f", step: "b", after: "a" }, source: { path: "b.ts", line: 1 } },
      ],
    });
    expect(cyclic.flows[0].cycles).toEqual([["a", "b"]]);
    expect(cyclic.issues.some((issue) => issue.message.includes("contains a cycle"))).toBe(true);
  });
});
