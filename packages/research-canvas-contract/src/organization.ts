import type { GraphSpec } from "./graph-document.js";
import type { ResearchNode } from "./model.js";

/** Navigation relations do not trigger work. Evidence relations remain a graph. */
export const isHierarchyRelation = (relation: string): boolean => relation === "contains" || relation === "decomposes";
export type ResearchRole = "goal" | "target" | "motivation";
export function researchRole(node: ResearchNode): ResearchRole | null {
  const meta = node.data.meta;
  const kind = meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as Record<string, unknown>).cardKind : undefined;
  if (typeof kind === "string") return kind === "goal" || kind === "target" || kind === "motivation" ? kind : null;
  const role = meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as Record<string, unknown>).researchRole : undefined;
  return role === "goal" || role === "target" || role === "motivation" ? role : node.type === "goal" ? "goal" : null;
}
/** Only goal decomposition is constrained to be acyclic. Legacy contains and
 * evidence links retain their bounded traversal and do not gain new semantics. */
export function decompositionCycle(spec: GraphSpec): string[] {
  const children = new Map<string, string[]>(), color = new Map<string, number>();
  for (const edge of Object.values(spec.edges)) if (edge.relation === "decomposes" && spec.nodes[edge.from] && spec.nodes[edge.to])
    children.set(edge.from, [...(children.get(edge.from) ?? []), edge.to]);
  for (const start of children.keys()) {
    if (color.has(start)) continue;
    const stack = [{ id: start, next: 0 }]; color.set(start, 1);
    while (stack.length) {
      const frame = stack[stack.length - 1], own = children.get(frame.id) ?? [];
      if (frame.next === own.length) { color.set(frame.id, 2); stack.pop(); continue; }
      const id = own[frame.next++];
      if (color.get(id) === 1) return stack.slice(stack.findIndex(item => item.id === id)).map(item => item.id).concat(id);
      if (!color.has(id)) { color.set(id, 1); stack.push({ id, next: 0 }); }
    }
  }
  return [];
}
