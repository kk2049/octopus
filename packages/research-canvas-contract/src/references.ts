import type { GraphSpec } from "./graph-document.js";
import { isHierarchyRelation } from "./organization.js";

/** Closest shared containing scope. Empty means the project root. Cycles are bounded. */
export function commonResearchScope(graph: GraphSpec, scopes: readonly string[]): string {
  if (!scopes.length || scopes.some(id => !id)) return "";
  const parents = new Map<string, string[]>();
  for (const edge of Object.values(graph.edges)) if (isHierarchyRelation(edge.relation) && graph.nodes[edge.from] && graph.nodes[edge.to]) {
    parents.set(edge.to, [...(parents.get(edge.to) ?? []), edge.from]);
  }
  const distances = [...new Set(scopes)].map(scope => {
    const found = new Map<string, number>([[scope, 0]]), queue = [scope];
    for (let i = 0; i < queue.length; i++) for (const parent of parents.get(queue[i]) ?? []) {
      if (found.has(parent)) continue;
      found.set(parent, found.get(queue[i])! + 1); queue.push(parent);
    }
    return found;
  });
  return [...distances[0].keys()].filter(id => distances.every(map => map.has(id))).sort((a, b) => {
    const cost = (id: string) => distances.reduce((sum, map) => sum + map.get(id)!, 0);
    return Math.max(...distances.map(map => map.get(a)!)) - Math.max(...distances.map(map => map.get(b)!)) || cost(a) - cost(b) || a.localeCompare(b);
  })[0] ?? "";
}

/** Change only membership/semantic edges. Every view keeps the original graph ID/ref/body. */
export function referenceResearchNode(graph: GraphSpec, node: string, scope: string, ownership: "common" | "retain", operation: string) {
  if (!graph.nodes[node] || !graph.nodes[scope] || node === scope) throw new Error("请选择当前项目中的节点和另一个目标子图");
  const own = Object.entries(graph.edges).filter(([, edge]) => edge.to === node && isHierarchyRelation(edge.relation));
  const consumers = Object.values(graph.edges).filter(edge => edge.to === node && edge.relation === "references").map(edge => edge.from);
  const owner = ownership === "retain" ? own[0]?.[1].from ?? "" : own.length ? commonResearchScope(graph, [...own.map(([, edge]) => edge.from), ...consumers, scope]) : "";
  const edges = { ...graph.edges };
  let sequence = 0;
  const add = (from: string, to: string, relation: string) => {
    if (Object.values(edges).some(edge => edge.from === from && edge.to === to && edge.relation === relation)) return;
    let id: string;
    do { id = `reference_${operation}_${sequence++}`; } while (Object.hasOwn(edges, id));
    edges[id] = { from, to, relation };
  };
  if (ownership === "common") {
    for (const [id, edge] of own) {
      if (edge.from === owner) continue;
      // Keep the former local entry as an explicit reference to the very same node.
      edges[id] = { ...edge, relation: "references" };
    }
    if (owner && !own.some(([, edge]) => edge.from === owner)) add(owner, node, "contains");
  }
  if (scope !== owner) add(scope, node, "references");
  return { graph: { nodes: graph.nodes, edges }, owner, relocated: ownership === "common" && own.some(([, edge]) => edge.from !== owner) };
}
