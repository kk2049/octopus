import { describe, expect, it } from "vitest";

import type { ArchitectureModuleDefinition, DependencyFact } from "../shared/model.js";
import { aggregateModules } from "./aggregate.js";

const definitions: ArchitectureModuleDefinition[] = ["dashboard", "runtime", "contract"].map((id) => ({
  id,
  label: id,
  description: "",
  zone: "trusted",
  criticality: "normal",
  pathPrefixes: [`packages/${id}/`],
}));

function dependency(from: string, to: string, runtimeCount: number, typeOnlyCount: number): DependencyFact {
  return {
    id: `${from}:${to}`,
    from,
    to,
    runtimeCount,
    typeOnlyCount,
    testCount: 0,
    dynamicCount: 0,
    circular: false,
    samples: [],
  };
}

describe("module fan-out aggregation", () => {
  it("reports runtime and type-only neighbours independently", () => {
    const modules = aggregateModules({
      definitions,
      files: [],
      symbols: [],
      dependencies: [
        dependency("dashboard", "runtime", 1, 0),
        dependency("dashboard", "contract", 0, 2),
      ],
    });

    expect(modules.find((module) => module.id === "dashboard")).toMatchObject({
      runtimeFanIn: 0,
      runtimeFanOut: 1,
      typeOnlyFanIn: 0,
      typeOnlyFanOut: 1,
      fanIn: 0,
      fanOut: 1,
    });
    expect(modules.find((module) => module.id === "contract")).toMatchObject({
      runtimeFanIn: 0,
      typeOnlyFanIn: 1,
    });
  });
});
