import { describe, expect, it } from "vitest";

import { evaluateConstraints } from "./constraints.js";

const base = {
  root: "/repo",
  externalFileEdges: [],
  fileEdges: [],
  files: [],
  flows: [],
  annotations: [],
};

describe("architecture fitness constraints", () => {
  it("explains a transitive forbidden path", () => {
    const result = evaluateConstraints({
      ...base,
      dependencies: [
        { id: "a-b", from: "a", to: "b", runtimeCount: 1, typeOnlyCount: 0, testCount: 0, dynamicCount: 0, circular: false, samples: [] },
        { id: "b-c", from: "b", to: "c", runtimeCount: 1, typeOnlyCount: 0, testCount: 0, dynamicCount: 0, circular: false, samples: [] },
      ],
      definitions: [{
        id: "BOUNDARY",
        title: "Boundary",
        description: "",
        concern: "trust",
        severity: "critical",
        mechanism: { kind: "forbid-dependency", from: ["a"], to: ["c"], transitive: true },
      }],
    });
    expect(result.constraints[0]).toMatchObject({ status: "fail" });
    expect(result.constraints[0].violations[0].path).toEqual(["a", "b", "c"]);
  });

  it("does not present a documented claim as machine-proven", () => {
    const result = evaluateConstraints({
      ...base,
      dependencies: [],
      definitions: [{ id: "SEMANTIC", title: "Semantic", description: "", concern: "authority", severity: "high" }],
    });
    expect(result.constraints[0]).toMatchObject({ status: "review" });
  });

  it("reports an actionable shortest witness for a large strongly connected component", () => {
    const dependencies = [
      ["a", "b"], ["b", "a"], ["b", "c"], ["c", "d"], ["d", "b"],
    ].map(([from, to]) => ({ id: `${from}-${to}`, from, to, runtimeCount: 1, typeOnlyCount: 0, testCount: 0, dynamicCount: 0, circular: true, samples: [] }));
    const result = evaluateConstraints({
      ...base,
      dependencies,
      definitions: [{ id: "CYCLES", title: "Cycles", description: "", concern: "modularity", severity: "high", mechanism: { kind: "no-cycles" } }],
    });
    expect(result.constraints[0].violations[0].path).toEqual(["a", "b", "a"]);
  });

  it("does not turn a test-only external import into a production trust violation", () => {
    const result = evaluateConstraints({
      ...base,
      dependencies: [],
      externalFileEdges: [{
        fromModule: "view", source: "view.test.ts", package: "node:fs", typeOnly: false, test: true, builtin: true,
        sample: { source: { path: "view.test.ts", line: 1 }, specifier: "node:fs", typeOnly: false, dynamic: false, test: true },
      }],
      definitions: [{ id: "NO_NODE", title: "No Node", description: "", concern: "trust", severity: "critical", mechanism: { kind: "forbid-external", from: ["view"], patterns: ["^node:"] } }],
    });
    expect(result.constraints[0].status).toBe("pass");
  });

  it("limits external restrictions to the runtime closure of declared entrypoints", () => {
    const sample = (source: string, specifier: string) => ({
      source: { path: source, line: 1 }, specifier, typeOnly: false, dynamic: false, test: false,
    });
    const result = evaluateConstraints({
      ...base,
      dependencies: [],
      files: ["view/main.ts", "view/runtime.ts", "view/build.ts"].map((file) => ({
        id: file, path: file, moduleId: "view", isTest: false, loc: 1, codeLoc: 1,
        git: { touches: 0, additions: 0, deletions: 0 }, declarationCount: 0, complexity: 0,
      })),
      fileEdges: [{ from: "view/main.ts", to: "view/runtime.ts", typeOnly: false, dynamic: false, circular: false }],
      externalFileEdges: [
        { fromModule: "view", source: "view/runtime.ts", package: "node:fs", typeOnly: false, test: false, builtin: true, sample: sample("view/runtime.ts", "node:fs") },
        { fromModule: "view", source: "view/build.ts", package: "node:path", typeOnly: false, test: false, builtin: true, sample: sample("view/build.ts", "node:path") },
      ],
      definitions: [{
        id: "NO_NODE", title: "No Node", description: "", concern: "trust", severity: "critical",
        mechanism: { kind: "forbid-external", from: ["view"], patterns: ["^node:"], entrypoints: ["view/main.ts"] },
      }],
    });
    expect(result.constraints[0]).toMatchObject({ status: "fail", summary: "发现 1 条禁止的外部依赖" });
    expect(result.constraints[0].violations[0]).toMatchObject({ message: "view imports node:fs" });
  });

  it("fails a flow whose predecessor evidence is dangling", () => {
    const result = evaluateConstraints({
      ...base,
      dependencies: [],
      flows: [{
        id: "request", title: "Request", description: "", perspective: "control",
        coverage: { mode: "critical-branches", scope: "request gate" },
        steps: [{ id: "gate", label: "Gate", zone: "trusted", after: ["identity"], outcome: "dispatch", terminal: true, enforces: [] }],
        missingAnchors: [], duplicateAnchors: [],
        missingPredecessors: [{ stepId: "gate", predecessorId: "identity" }],
        cycles: [],
        invalidAttributes: [],
      }],
      definitions: [{
        id: "FLOW", title: "Flow", description: "", concern: "authority", severity: "critical",
        mechanism: { kind: "flow-complete", flow: "request", requiredSteps: ["gate"] },
      }],
    });
    expect(result.constraints[0]).toMatchObject({ status: "fail", summary: "控制流证据不完整（1 项）" });
    expect(result.constraints[0].violations[0].message).toMatch(/不存在的前驱/);
  });

  it("checks declared branch edges and terminal outcomes", () => {
    const result = evaluateConstraints({
      ...base,
      dependencies: [],
      flows: [{
        id: "request", title: "Request", description: "", perspective: "authority",
        coverage: { mode: "critical-branches", scope: "request outcomes" },
        steps: [
          { id: "input", label: "Input", zone: "external", after: [], enforces: [] },
          { id: "allow", label: "Allow", zone: "trusted", after: ["input"], outcome: "dispatch", terminal: true, enforces: [] },
          { id: "deny", label: "Deny", zone: "trusted", after: ["input"], outcome: "deny", enforces: [] },
        ],
        missingAnchors: [], duplicateAnchors: [], missingPredecessors: [], cycles: [], invalidAttributes: [],
      }],
      definitions: [{
        id: "FLOW", title: "Flow", description: "", concern: "authority", severity: "critical",
        mechanism: {
          kind: "flow-complete", flow: "request", requiredSteps: ["input", "allow", "deny"],
          requiredEdges: [{ from: "allow", to: "deny" }], requiredTerminals: ["allow", "deny"],
        },
      }],
    });
    expect(result.constraints[0].status).toBe("fail");
    expect(result.constraints[0].violations.map((violation) => violation.message)).toEqual(expect.arrayContaining([
      "缺少契约边 allow → deny",
      "步骤 deny 必须声明为契约终点",
      "叶子步骤 deny 没有声明契约结果",
    ]));
  });

  it("refuses to call a flow complete without a bounded coverage claim", () => {
    const result = evaluateConstraints({
      ...base,
      dependencies: [],
      flows: [{
        id: "request", title: "Request", description: "", perspective: "control",
        steps: [{ id: "done", label: "Done", zone: "trusted", outcome: "done", terminal: true, enforces: [] }],
        missingAnchors: [], duplicateAnchors: [], missingPredecessors: [], cycles: [], invalidAttributes: [],
      }],
      definitions: [{
        id: "FLOW", title: "Flow", description: "", concern: "authority", severity: "critical",
        mechanism: { kind: "flow-complete", flow: "request", requiredSteps: ["done"], requiredTerminals: ["done"] },
      }],
    });
    expect(result.constraints[0].violations[0].message).toMatch(/coverage\.scope/);
  });
});
