import { describe, expect, it } from "vitest";
import { readSessionTurnConfiguration } from "./turn-configuration.js";

describe("observed turn configuration", () => {
  it("only discloses model and effort identifiers, including newly observed levels", () => {
    expect(readSessionTurnConfiguration({ model: "custom/gpt-6-luna", effort: "ultra", cwd: "/private", auth: "secret" }))
      .toEqual({ model: "custom/gpt-6-luna", effort: "ultra" });
  });
  it.each([null, [], "high", {}, { model: "x".repeat(121), effort: "x".repeat(33) },
    { model: "<img src=x>", effort: "high\nsecret" }, { model: 123, effort: {} }])("rejects invalid display facts: %j", (input) => {
    expect(readSessionTurnConfiguration(input)).toBeNull();
  });
  it("keeps independently known values without inventing defaults", () => {
    expect(readSessionTurnConfiguration({ model: "gpt-6-luna", effort: null })).toEqual({ model: "gpt-6-luna" });
    expect(readSessionTurnConfiguration({ model: "", effort: "none" })).toEqual({ effort: "none" });
  });
});
