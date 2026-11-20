import { describe, expect, it } from "vitest";
import type { ArchConstraint, ArchDependency, ArchModule, ArchZone } from "../ArchitecturePage.js";
import {
  buildGraphEdges,
  edgeKey,
  flowRanks,
  forbiddenZonePairs,
  mentionedIds,
  zoneMatrix,
} from "./model.js";

function mod(id: string, zone: string, criticality = "normal"): ArchModule {
  return {
    id,
    label: id,
    description: "",
    zone,
    criticality,
    tags: [],
    docs: [],
    files: 1,
    codeLoc: 100,
    testFiles: 0,
    gitTouches: 1,
    runtimeFanIn: 0,
    runtimeFanOut: 0,
    typeOnlyFanIn: 0,
    typeOnlyFanOut: 0,
    fanIn: 0,
    fanOut: 0,
    annotations: 0,
  };
}

function dep(from: string, to: string, patch: Partial<ArchDependency> = {}): ArchDependency {
  return {
    from,
    to,
    runtimeCount: 1,
    typeOnlyCount: 0,
    testCount: 0,
    dynamicCount: 0,
    circular: false,
    samples: [],
    ...patch,
  };
}

const MODULES = [
  mod("web", "frontend"),
  mod("api", "backend", "critical"),
  mod("db", "backend"),
  mod("cli", "tools"),
];

describe("buildGraphEdges", () => {
  it("collapses runtime deps to zone level, dropping in-zone self loops and non-runtime edges", () => {
    const deps = [
      dep("web", "api"),
      dep("web", "db"),
      dep("api", "db"), // in-zone: invisible while backend is collapsed
      dep("cli", "api", { runtimeCount: 0, testCount: 3 }), // test-only: never drawn
    ];
    const edges = buildGraphEdges(deps, MODULES, new Set());
    expect(edges).toHaveLength(1);
    expect(edgeKey(edges[0])).toBe("zone:frontend->zone:backend");
    expect(edges[0].count).toBe(2);
    expect(edges[0].deps.map((d) => d.to)).toEqual(["api", "db"]);
  });

  it("refines endpoints touching an expanded zone to module level and keeps the circular flag", () => {
    const deps = [dep("web", "api", { circular: true }), dep("web", "db"), dep("api", "db")];
    const edges = buildGraphEdges(deps, MODULES, new Set(["backend"]));
    const keys = edges.map(edgeKey);
    expect(keys).toContain("zone:frontend->module:api");
    expect(keys).toContain("zone:frontend->module:db");
    expect(keys).toContain("module:api->module:db");
    expect(edges.find((e) => edgeKey(e) === "zone:frontend->module:api")?.circular).toBe(true);
  });

  it("applies the cross-zone and critical filters", () => {
    const deps = [dep("web", "api"), dep("api", "db"), dep("cli", "db")];
    const cross = buildGraphEdges(deps, MODULES, new Set(["backend"]), "cross");
    expect(cross.map(edgeKey)).toEqual(["zone:frontend->module:api", "zone:tools->module:db"]);
    // api is the only critical module: only edges touching it survive.
    const critical = buildGraphEdges(deps, MODULES, new Set(["backend"]), "critical");
    expect(critical.map(edgeKey)).toEqual(["zone:frontend->module:api", "module:api->module:db"]);
  });
});

describe("zoneMatrix", () => {
  it("counts runtime module edges per from→to zone pair, including the diagonal", () => {
    const deps = [
      dep("web", "api"),
      dep("web", "db"),
      dep("api", "db"),
      dep("web", "cli", { runtimeCount: 0, typeOnlyCount: 2 }), // type-only: not counted
    ];
    const matrix = zoneMatrix(deps, MODULES);
    expect(matrix.get("frontend|backend")).toBe(2);
    expect(matrix.get("backend|backend")).toBe(1);
    expect(matrix.get("frontend|tools")).toBeUndefined();
  });
});

describe("forbiddenZonePairs", () => {
  const zones: ArchZone[] = [
    { id: "frontend", label: "前端", trust: "untrusted", color: "" },
    { id: "backend", label: "后端", trust: "trusted", color: "" },
    { id: "tools", label: "工具", trust: "trusted", color: "" },
  ];
  function constraint(patch: Partial<ArchConstraint>): ArchConstraint {
    return {
      id: "c1",
      title: "",
      description: "",
      concern: "trust",
      severity: "high",
      status: "fail",
      mechanismKind: "forbid-dependency",
      violations: [],
      evidence: [],
      ...patch,
    };
  }

  it("resolves module→module arrows in constraint prose to zone pairs", () => {
    const pairs = forbiddenZonePairs(
      [constraint({ violations: [{ message: "违规：web -> db 直接读库" }] })],
      MODULES,
      zones,
    );
    expect(pairs).toEqual(new Set(["frontend|backend"]));
  });

  it("accepts zone ids on either side and ignores other mechanism kinds", () => {
    const pairs = forbiddenZonePairs(
      [
        constraint({ description: "frontend → tools 禁止" }),
        constraint({ mechanismKind: "no-cycles", description: "backend -> frontend" }),
      ],
      MODULES,
      zones,
    );
    expect(pairs).toEqual(new Set(["frontend|tools"]));
  });
});

describe("flowRanks", () => {
  it("ranks steps as max(predecessor)+1 with roots at zero", () => {
    const ranks = flowRanks([
      { id: "a", after: [] },
      { id: "b", after: ["a"] },
      { id: "c", after: ["a"] },
      { id: "d", after: ["b", "c"] },
      { id: "e", after: ["a", "d"] },
    ]);
    expect(ranks.get("a")).toBe(0);
    expect(ranks.get("b")).toBe(1);
    expect(ranks.get("c")).toBe(1);
    expect(ranks.get("d")).toBe(2);
    expect(ranks.get("e")).toBe(3);
  });

  it("ignores unknown predecessors and terminates on cycles", () => {
    const ranks = flowRanks([
      { id: "a", after: ["ghost"] },
      { id: "b", after: ["a", "c"] },
      { id: "c", after: ["b"] },
    ]);
    expect(ranks.get("a")).toBe(0);
    // The cycle converges to finite ranks rather than hanging.
    expect(Number.isFinite(ranks.get("b"))).toBe(true);
    expect(Number.isFinite(ranks.get("c"))).toBe(true);
  });
});

describe("mentionedIds", () => {
  it("matches whole ids only", () => {
    expect(mentionedIds("bot-host 依赖 web，与 webapp 无关", ["bot", "web", "webapp", "db"])).toEqual([
      "web",
      "webapp",
    ]);
  });
});
