import { describe, expect, it } from "vitest";
import type { PermissionStudioResource } from "../contract.js";
import { buildResourceTree, nodeAncestors } from "./resource-tree.js";

const resource = (id: string, uri: string): PermissionStudioResource => ({
  id, uri, title: id, kind: "file", domainId: "personal", authorityLabel: "Alice",
  sensitivity: "normal", sourceSystem: "files", enforcement: "enforced",
});

describe("resource display hierarchy", () => {
  it("preserves exact resource identity and does not attach parent permissions to children", () => {
    const tree = buildResourceTree([
      resource("parent", "file://laptop/alice"),
      resource("child", "file://laptop/alice/reports/%E4%B8%AD%E6%96%87"),
      resource("sibling", "file://laptop/alice-other"),
    ], []);
    expect(tree.get("file://laptop/alice")?.children).toEqual(["file://laptop/alice/reports"]);
    expect(tree.get("file://laptop/alice/reports")?.resources).toEqual([]);
    expect(tree.get("file://laptop/alice/reports/%E4%B8%AD%E6%96%87")?.label).toBe("中文");
    expect(tree.get("file://laptop/alice/reports/%E4%B8%AD%E6%96%87")?.resources.map((r) => r.id)).toEqual(["child"]);
    expect(nodeAncestors(tree, "file://laptop/alice/reports").map((n) => n.uri)).toEqual([
      "file://laptop", "file://laptop/alice", "file://laptop/alice/reports",
    ]);
  });

  it("shows aliases as links without synthesizing grants or following cycles", () => {
    const tree = buildResourceTree([resource("child", "object://apps/alice/state")], [
      { uri: "object://apps/alice/shortcut", targetUri: "object://apps/alice/state" },
      { uri: "object://apps/alice/a", targetUri: "object://apps/alice/b" },
      { uri: "object://apps/alice/b", targetUri: "object://apps/alice/a" },
      { uri: "object://apps/alice/missing", targetUri: "object://private/bob/state" },
    ]);
    expect(tree.get("object://apps/alice/shortcut")?.resources).toEqual([]);
    expect(tree.get("object://apps/alice/shortcut")?.children).toEqual([]);
    expect(tree.has("object://private/bob/state")).toBe(false);
    expect(tree.get("object://apps/alice/a")?.alias?.targetUri).toBe("object://apps/alice/b");
  });

  it("handles empty inventory and missing selection without selecting another resource", () => {
    expect(buildResourceTree([], []).size).toBe(0);
    expect(nodeAncestors(buildResourceTree([], []), "object://missing/alice")).toEqual([]);
  });
});
