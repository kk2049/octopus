import { describe, expect, it } from "vitest";
import { defineCustomPreview, definePreviewPlan, previewTitle } from "./plan.js";

describe("preview profiles", () => {
  it("keeps existing composition plans source-compatible", () => {
    const plan = definePreviewPlan({
      composition: { schema: "agent-composition/v1", app: "notes", instances: [], open: [] },
      modules: [],
    });
    expect(previewTitle(plan)).toBe("notes");
  });

  it("preserves a bespoke root instead of translating it into a module plan", () => {
    const render = () => "custom view";
    const plan = defineCustomPreview({ kind: "custom", app: "custom", title: "Custom", render });
    expect(plan.render).toBe(render);
    expect(previewTitle(plan)).toBe("Custom");
    expect("composition" in plan).toBe(false);
  });
});
