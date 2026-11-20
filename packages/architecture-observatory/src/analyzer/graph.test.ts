import { describe, expect, it } from "vitest";

import { adjacency, shortestPath, stronglyConnectedComponents } from "./graph.js";

describe("directed graph helpers", () => {
  const graph = adjacency([
    { from: "a", to: "b" },
    { from: "b", to: "c" },
    { from: "c", to: "b" },
    { from: "c", to: "d" },
  ]);

  it("returns an explainable shortest path", () => {
    expect(shortestPath(graph, "a", "d")).toEqual(["a", "b", "c", "d"]);
    expect(shortestPath(graph, "d", "a")).toBeNull();
  });

  it("finds cycles without flattening unrelated nodes together", () => {
    expect(stronglyConnectedComponents(graph).filter((part) => part.length > 1)).toEqual([["b", "c"]]);
  });
});
