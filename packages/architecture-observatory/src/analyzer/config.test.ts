import { describe, expect, it } from "vitest";

import { validateConfig } from "./config.js";

const valid = {
  system: { id: "s", title: "System", description: "A system" },
  zones: [{ id: "trusted", label: "Trusted", description: "", color: "#fff", trust: "trusted" }],
  modules: [{ id: "core", label: "Core", description: "", zone: "trusted", criticality: "high", pathPrefixes: ["src/"] }],
  flows: [{ id: "request", title: "Request", description: "", perspective: "control" }],
  constraints: [{ id: "C-1", title: "One", description: "", concern: "modularity", severity: "high" }],
};

describe("architecture config", () => {
  it("accepts the minimal typed model", () => {
    expect(validateConfig(valid).modules[0].id).toBe("core");
  });

  it("rejects duplicate ids and unknown zones", () => {
    expect(() => validateConfig({ ...valid, flows: [valid.flows[0], valid.flows[0]] })).toThrow(/duplicate flows id/);
    expect(() => validateConfig({
      ...valid,
      modules: [{ ...valid.modules[0], zone: "missing" }],
    })).toThrow(/unknown zone/);
  });
});
