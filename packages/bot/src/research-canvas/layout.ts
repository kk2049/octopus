import { canvasCardSize, canvasTree, isHierarchyRelation, type GraphPosition, type GraphSpec, type ResearchNode } from "@claude-bot/research-canvas-contract";

export interface ArrangeOptions { nodes?: readonly string[]; mode?: "tree" | "compact" }
/** Layout is an explicit public-coordinate action. Reading/expanding a graph
 * never runs it. Existing dimensions and pins survive every arrangement. */
export function arrangeGraph(spec: GraphSpec, current: Record<string, GraphPosition>, only?: string, missingOnly = false, resources: readonly ResearchNode[] = [], options: ArrangeOptions = {}): Record<string, GraphPosition> {
  const ids = Object.keys(spec.nodes);
  if (only && !spec.nodes[only]) throw new Error("排版节点不存在");
  if (options.nodes !== undefined && (!Array.isArray(options.nodes) || options.nodes.length > 1000 || options.nodes.some(id => typeof id !== "string" || !spec.nodes[id]))) throw new Error("排版范围必须是当前图中的节点 ID 数组");
  if (only && options.nodes) throw new Error("单节点补位和范围排版不能同时指定");
  if (options.mode && !["tree", "compact"].includes(options.mode)) throw new Error("未知排版方式");
  const byId = new Map(resources.map(node => [node.id, node]));
  const members = new Map<string, string[]>();
  for (const edge of Object.values(spec.edges)) if (isHierarchyRelation(edge.relation) && spec.nodes[edge.to]) members.set(edge.from, [...(members.get(edge.from) ?? []), edge.to]);
  const nodes = ids.map(id => {
    const resource = byId.get(id);
    return { ...resource, id, type: resource?.type ?? spec.nodes[id].ref.split(":")[0], title: spec.nodes[id].label, summary: resource?.summary ?? "", archived: false, x: current[id]?.x ?? 0, y: current[id]?.y ?? 0, data: { ...resource?.data, members: members.get(id) ?? [] } } as ResearchNode;
  });
  const nodeMap = new Map(nodes.map(node => [node.id, node]));
  const size = (node: ResearchNode) => canvasCardSize(node, "canvas", current[node.id]);
  const scope = options.nodes ? new Set(options.nodes) : null;
  const tree = canvasTree(scope ? nodes.filter(node => scope.has(node.id)) : nodes, "", undefined, "canvas", current);
  const selected = new Set(ids.filter(id => (!scope || scope.has(id)) && !current[id]?.pinned && (only ? id === only : missingOnly ? !current[id] : true)));
  const result: Record<string, GraphPosition> = {};
  const occupied = nodes.filter(node => !selected.has(node.id) && current[node.id]).map(node => ({ ...current[node.id], ...size(node) }));
  const grid: Record<string, GraphPosition> = {};
  if (options.mode === "compact") {
    let y = 0;
    for (let i = 0; i < tree.nodes.length; i += 3) {
      let x = 0, height = 0;
      for (const node of tree.nodes.slice(i, i + 3)) { grid[node.id] = { x, y }; x += size(node).width + 64; height = Math.max(height, size(node).height); }
      y += height + 48;
    }
  }
  const planned = options.mode === "compact" ? grid : tree.positions;
  const anchor = tree.nodes.find(node => current[node.id]);
  const offset = anchor ? { x: current[anchor.id].x - planned[anchor.id].x, y: current[anchor.id].y - planned[anchor.id].y } : { x: 0, y: 0 };
  for (const node of tree.nodes) {
    if (!selected.has(node.id)) continue;
    const ownSize = size(node), parent = tree.parent.get(node.id);
    let point = { x: planned[node.id].x + offset.x, y: planned[node.id].y + offset.y };
    if (parent && options.mode !== "compact") {
      const placedParent = result[parent] ?? current[parent];
      if (placedParent && (only || missingOnly)) point = { x: placedParent.x + size(nodeMap.get(parent)!).width + 112, y: placedParent.y };
      else if (placedParent) point = { x: placedParent.x + planned[node.id].x - planned[parent].x, y: placedParent.y + planned[node.id].y - planned[parent].y };
    }
    const overlaps = (other: GraphPosition & { width: number; height: number }) => point.x < other.x + other.width + 32 && point.x + ownSize.width + 32 > other.x && point.y < other.y + other.height + 32 && point.y + ownSize.height + 32 > other.y;
    // Finite collision avoidance against fixed cards and previously placed cards.
    for (let attempt = 0; attempt <= ids.length && occupied.some(overlaps); attempt++)
      point.y = Math.max(point.y + ownSize.height + 32, ...occupied.filter(other => point.x < other.x + other.width + 32 && point.x + ownSize.width + 32 > other.x).map(other => other.y + other.height + 32));
    result[node.id] = { ...current[node.id], ...point };
    occupied.push({ ...point, ...ownSize });
  }
  return result;
}
