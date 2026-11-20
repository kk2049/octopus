import type { ResearchNode } from "./model.js";
import { canvasMembers, canvasScope, type CanvasPositions } from "./layout.js";
import { canvasCardSize } from "./presentation.js";

/** A spanning tree for placement only. Shared nodes/other relations retain their identity.
 * Iterative traversal handles cycles and deep imported hierarchies without recursion.
 */
export function canvasTree(nodes: readonly ResearchNode[], scope = "", expanded?: ReadonlySet<string>, presentation: "tree" | "canvas" = "tree", geometry: Record<string, Partial<{ width: number; height: number }>> = {}) {
  const byId = new Map(nodes.filter(n => !n.archived).map(n => [n.id, n]));
  const selection = canvasScope(nodes, scope);
  const anchor = byId.get(scope);
  const roots = anchor ? [anchor] : selection.nodes;
  const children = new Map<string, string[]>(), parent = new Map<string, string>();
  const depth = new Map<string, number>(), order: ResearchNode[] = [], seen = new Set<string>();
  const pending = roots.map(node => ({ node, level: 0 }));
  for (let i = 0; i < pending.length; i++) {
    const { node, level } = pending[i];
    if (seen.has(node.id)) continue;
    seen.add(node.id); order.push(node); depth.set(node.id, level);
    const own: string[] = [];
    if (expanded === undefined || expanded.has(node.id) || node.id === scope) {
      for (const id of canvasMembers(node)) {
        if (!byId.has(id) || seen.has(id) || parent.has(id) || roots.some(root => root.id === id)) continue;
        parent.set(id, node.id); own.push(id); pending.push({ node: byId.get(id)!, level: level + 1 });
      }
    }
    children.set(node.id, own);
  }
  const heights = new Map<string, number>(), widths = new Map<number, number>();
  for (const node of [...order].reverse()) {
    const own = children.get(node.id) ?? [], size = canvasCardSize(node, presentation, geometry[node.id]);
    heights.set(node.id, Math.max(size.height, own.reduce((sum, id) => sum + heights.get(id)!, 0) + Math.max(0, own.length - 1) * 24));
    const level = depth.get(node.id)!;
    widths.set(level, Math.max(widths.get(level) ?? 0, size.width));
  }
  const columns = [0];
  for (let i = 0; i < widths.size; i++) columns[i + 1] = columns[i] + (widths.get(i) ?? 300) + 112;
  const positions: CanvasPositions = {}, tops = new Map<string, number>();
  let rootTop = 0;
  for (const node of roots) { tops.set(node.id, rootTop); rootTop += (heights.get(node.id) ?? 0) + 64; }
  for (const node of order) {
    const top = tops.get(node.id) ?? 0, height = heights.get(node.id)!;
    positions[node.id] = { x: columns[depth.get(node.id)!], y: top + (height - canvasCardSize(node, presentation, geometry[node.id]).height) / 2 };
    let childTop = top;
    for (const id of children.get(node.id) ?? []) { tops.set(id, childTop); childTop += heights.get(id)! + 24; }
  }
  return { nodes: order, positions, parent, depth };
}
