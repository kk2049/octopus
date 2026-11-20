import { describe, expect, it } from "vitest";
import {
  isResourceUriPrefix,
  parseResourceUri,
  resourceUri,
  resourceUriPrefixes,
  rewriteResourceUri,
} from "./namespace.js";

describe("authorization resource namespace", () => {
  it("builds canonical scheme-specific hierarchical addresses", () => {
    expect(resourceUri("file", "octopus", "alice", "laptop", "reports", "Q1 plan.md"))
      .toBe("file://octopus/alice/laptop/reports/Q1%20plan.md");
    expect(resourceUri("tool", "dsh", "alice", "laptop", "tools", "bash"))
      .toBe("tool://dsh/alice/laptop/tools/bash");
    expect(resourceUri("feishu", "people", "ou_abc"))
      .toBe("feishu://people/ou_abc");
    expect(resourceUri("feishu", "chats", "oc_abc"))
      .toBe("feishu://chats/oc_abc");
  });

  it("returns self-to-root prefixes and rewrites an exact subtree", () => {
    expect(resourceUriPrefixes("file://octopus/alice/laptop/reports/q1")).toEqual([
      "file://octopus/alice/laptop/reports/q1",
      "file://octopus/alice/laptop/reports",
      "file://octopus/alice/laptop",
      "file://octopus/alice",
    ]);
    expect(isResourceUriPrefix("file://octopus/alice/laptop", "file://octopus/alice/laptop/reports/q1"))
      .toBe(true);
    expect(rewriteResourceUri(
      "file://legacy/alice/reports/q1",
      "file://legacy/alice",
      "file://octopus/alice/laptop",
    )).toBe("file://octopus/alice/laptop/reports/q1");
  });

  it.each([
    "file://octopus/alice/../secret",
    "file://octopus/alice/%2e%2E/secret",
    "file://octopus/alice/%2Fetc",
    "file://octopus/alice/%5cetc",
    "file://octopus/alice//secret",
    "file://user@octopus/alice/file",
    "file://octopus:443/alice/file",
    "file://octopus/alice/file?version=1",
    "https://octopus/alice/file",
  ])("rejects non-canonical or traversal-shaped address %s", (value) => {
    expect(() => parseResourceUri(value)).toThrow(/canonical resource URI/);
  });
});
