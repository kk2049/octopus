import { describe, expect, it } from "vitest";
import { mergeFocusedZones } from "./DependencyView.js";

const modules = [
  { id: "ui", zone: "browser" },
  { id: "api", zone: "trusted" },
  { id: "worker", zone: "runner" },
];

describe("mergeFocusedZones", () => {
  it("adds focus zones without removing manually expanded zones", () => {
    const expanded = new Set(["runner"]);

    const merged = mergeFocusedZones(expanded, ["ui", "api"], modules);

    expect([...merged]).toEqual(["runner", "browser", "trusted"]);
    expect([...expanded]).toEqual(["runner"]);
  });

  it("keeps the previous set identity when focus adds no new zone", () => {
    const expanded = new Set(["browser"]);

    expect(mergeFocusedZones(expanded, ["ui", "missing"], modules)).toBe(expanded);
  });
});
