import { describe, expect, it } from "vitest";

import { parseArchitectureAnnotations, parseAttributeText } from "./annotations.js";

describe("@architecture annotations", () => {
  it("parses quoted labels and graph relationships", () => {
    expect(parseAttributeText('flow=auth step=gate after=identify label="Mandatory policy"').attributes).toEqual({
      flow: "auth",
      step: "gate",
      after: "identify",
      label: "Mandatory policy",
    });
  });

  it("reports malformed tags instead of silently inventing a node", () => {
    const parsed = parseArchitectureAnnotations(
      [
        "// @architecture flow=auth step=gate after=request",
        "// @architecture this is prose",
      ].join("\n"),
      "src/gate.ts",
    );
    expect(parsed.annotations).toHaveLength(1);
    expect(parsed.errors).toEqual([{ line: 2, message: "annotation has no key=value attributes" }]);
  });

  it("ignores marker-shaped text inside strings", () => {
    const parsed = parseArchitectureAnnotations(
      'const fixture = "// @architecture flow=fake step=nope";\n// ordinary comment',
      "src/parser.test.ts",
    );
    expect(parsed).toEqual({ annotations: [], errors: [] });
  });

  it("does not let a production comment promote a declaration to executable evidence", () => {
    const parsed = parseArchitectureAnnotations("// @architecture verifies=AUTH", "src/gate.ts");
    expect(parsed.annotations).toEqual([]);
    expect(parsed.errors[0].message).toMatch(/only allowed in test\/spec/);
  });
});
