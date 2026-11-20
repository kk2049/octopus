import { describe, expect, it } from "vitest";
import { annotationFileKey, annotationRootKey, annotationRootsByRef } from "./annotations.js";

describe("workspace annotation identity", () => {
  it("survives a freshly minted root ref for the same listed file", () => {
    const annotationRoot = annotationRootKey({
      label: "octopus",
      sourceLabel: "laptop",
    });
    expect(annotationFileKey({ rootRef: "wf_first", labels: ["doc", "readme.md"], annotationRoot }))
      .toBe(annotationFileKey({ rootRef: "wf_after_reload", labels: ["doc", "readme.md"], annotationRoot }));
  });

  it("keeps roots separate and refuses to truncate an overlong display fallback", () => {
    expect(annotationRootKey({ label: "/", sourceLabel: "laptop" }))
      .not.toBe(annotationRootKey({ label: "/", sourceLabel: "desktop" }));
    expect(annotationRootKey({ label: "界".repeat(255), sourceLabel: "机".repeat(255) })).toBe("");
    expect(annotationRootKey({ label: "\ud800", sourceLabel: "laptop" })).toBe("");
  });

  it("maps only unique visible root coordinates back to their opaque refs", () => {
    const roots = annotationRootsByRef([
      { ref: "wf_docs", label: "docs", sourceLabel: "laptop" },
      { ref: "wf_duplicate_a", label: "shared", sourceLabel: "desktop" },
      { ref: "wf_duplicate_b", label: "shared", sourceLabel: "desktop" },
    ]);
    expect(roots.get("wf_docs")).toBe("display:laptop:docs");
    expect(roots.has("wf_duplicate_a")).toBe(false);
    expect(roots.has("wf_duplicate_b")).toBe(false);
  });
});
