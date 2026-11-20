import { describe, expect, it } from "vitest";
import { listedFileContext, markdownImageLabels, readListedFileLocation } from "@claude-bot/agent-file-preview";

describe("workspace Markdown images", () => {
  const location = {
    rootRef: "root-ref",
    labels: ["docs", "guide", "readme.md"],
    annotationRoot: "display:laptop:docs",
  } as const;

  it("normalizes relative syntax over listing-carried labels", () => {
    expect(markdownImageLabels(location, "./shots/phone.png?raw=1"))
      .toEqual(["docs", "guide", "shots", "phone.png"]);
    expect(markdownImageLabels(location, "../shared/logo.webp"))
      .toEqual(["docs", "shared", "logo.webp"]);
  });

  it("refuses external, root-relative, non-image and above-root addresses", () => {
    expect(markdownImageLabels(location, "https://example.com/a.png")).toBeNull();
    expect(markdownImageLabels(location, "/a.png")).toBeNull();
    expect(markdownImageLabels(location, "../../../../a.png")).toBeNull();
    expect(markdownImageLabels(location, "notes.txt")).toBeNull();
  });

  it("round-trips a bounded opaque root and listing lineage through intent context", () => {
    expect(readListedFileLocation(listedFileContext(location)!)).toEqual(location);
  });
});
