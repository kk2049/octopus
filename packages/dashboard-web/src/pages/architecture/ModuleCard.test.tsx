import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ModuleCard } from "./ModuleCard.js";
import type { SafeView } from "./model.js";

const snap: SafeView = {
  meta: undefined,
  zones: [{ id: "backend", label: "Backend", trust: "trusted", color: "#fff" }],
  modules: [{
    id: "dashboard-server",
    label: "Dashboard Server",
    description: "Dashboard transport",
    zone: "backend",
    criticality: "normal",
    tags: [],
    docs: [],
    files: 4,
    codeLoc: 200,
    testFiles: 2,
    gitTouches: 3,
    runtimeFanIn: 5,
    runtimeFanOut: 7,
    typeOnlyFanIn: 11,
    typeOnlyFanOut: 13,
    fanIn: 5,
    fanOut: 7,
    annotations: 0,
  }],
  dependencies: [],
  moduleEcosystem: { frontend: [], contracts: [], backend: [], dependencies: [], issues: [] },
  flows: [],
  constraints: [],
  findings: [],
  tcb: null,
  hotspots: [],
};

describe("ModuleCard dependency profile", () => {
  it("reports runtime and type-only fan-out independently", () => {
    render(<ModuleCard snap={snap} module={snap.modules[0]!} onClose={() => undefined} />);

    expect(screen.getByText("runtime fan-in / out").nextElementSibling).toHaveTextContent("5 / 7");
    expect(screen.getByText("type-only fan-in / out").nextElementSibling).toHaveTextContent("11 / 13");
  });
});
