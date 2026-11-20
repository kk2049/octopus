import { isHierarchyRelation, CANVAS_CARD_SIZE, canvasCardSize, type ResearchNode, type ResearchEdge } from "@claude-bot/research-canvas-contract";

export const CARD_WIDTH = CANVAS_CARD_SIZE.width;
export const CARD_HEIGHT = CANVAS_CARD_SIZE.height;
export const workKinds: Record<string, string> = {
  analysis: "分析", design: "设计", writing: "写作", development: "开发", testing: "测试",
};
export function nodeMeta(node: ResearchNode): Record<string, unknown> {
  const value = node.data.meta;
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
export function memberIds(node: ResearchNode): string[] {
  return Array.isArray(node.data.members)
    ? [...new Set(node.data.members.filter((id): id is string => typeof id === "string" && id !== node.id))]
    : [];
}
export function buildHierarchy(nodes: ResearchNode[]) {
  const live = nodes.filter((node) => !node.archived);
  const byId = new Map(live.map((node) => [node.id, node]));
  const children = new Map<string, ResearchNode[]>();
  const parents = new Map<string, string[]>();
  for (const node of live) {
    const members = memberIds(node).map((id) => byId.get(id)).filter((item): item is ResearchNode => !!item);
    if (node.type === "folder" || members.length) children.set(node.id, members);
    for (const member of members) parents.set(member.id, [...(parents.get(member.id) ?? []), node.id]);
  }
  const roots = live.filter((node) => !parents.has(node.id));
  // Keep malformed cyclic/orphaned components reachable, without inventing edges.
  const visited = new Set<string>();
  const visit = (id: string) => {
    const pending = [id];
    while (pending.length) {
      const next = pending.pop()!;
      if (visited.has(next)) continue;
      visited.add(next); pending.push(...(children.get(next) ?? []).map(child => child.id));
    }
  };
  roots.forEach((node) => visit(node.id));
  for (const node of live) if (!visited.has(node.id)) { roots.push(node); visit(node.id); }
  const trail = (id: string): ResearchNode[] => {
    const path: ResearchNode[] = [];
    const seen = new Set<string>();
    let current = byId.get(id);
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      path.unshift(current);
      current = byId.get((parents.get(current.id) ?? []).find((parent) => !seen.has(parent)) ?? "");
    }
    return path;
  };
  const descendants = (id: string): ResearchNode[] => {
    const result: ResearchNode[] = [], seen = new Set([id]);
    const pending = [...(children.get(id) ?? [])];
    for (let i = 0; i < pending.length; i++) {
      const child = pending[i];
      if (seen.has(child.id)) continue;
      seen.add(child.id); result.push(child); pending.push(...(children.get(child.id) ?? []));
    }
    return result;
  };
  return { byId, children, parents, roots, trail, descendants };
}
export function scopeEdges(edges: ResearchEdge[], ids: Set<string>, mode: "none" | "selected" | "scope", selected: string, includeContains = false) {
  return mode === "none" ? [] : edges.filter((edge) => !edge.archived && ids.has(edge.source) && ids.has(edge.target)
    && (mode === "scope" || includeContains && isHierarchyRelation(edge.label) || edge.source === selected || edge.target === selected));
}
export function nodeStatus(node: ResearchNode): { label: string; tone: string } {
  if (node.type === "review") {
    const status = String(node.data.reviewStatus ?? "pending");
    return { label: ({ approved: "已通过", changes_requested: "需修改", stale: "需重审" } as Record<string, string>)[status] ?? "待审查", tone: status === "approved" ? "done" : "review" };
  }
  const status = String(nodeMeta(node).status ?? "");
  const label = ({ todo: "待开始", in_progress: "进行中", blocked: "受阻", done: "已完成", needs_review: "待验收" } as Record<string, string>)[status];
  return label ? { label, tone: status } : { label: { past: "历史记录", present: "当前工作", future: "计划中" }[node.phase], tone: node.phase };
}
export function fitScopeCamera(nodes: ResearchNode[], position: (node: ResearchNode) => { x: number; y: number }, area: { left: number; top: number; width: number; height: number }, size = canvasCardSize) {
  if (!nodes.length) return { x: area.left, y: area.top, zoom: 1 };
  const points = nodes.map(position);
  const minX = Math.min(...points.map((p) => p.x)), minY = Math.min(...points.map((p) => p.y));
  const width = Math.max(...points.map((p, i) => p.x + size(nodes[i]).width)) - minX;
  const height = Math.max(...points.map((p, i) => p.y + size(nodes[i]).height)) - minY;
  const zoom = Math.max(0.2, Math.min(1, area.width / width, area.height / height));
  return { zoom, x: area.left + Math.max(0, (area.width - width * zoom) / 2) - minX * zoom, y: area.top - minY * zoom };
}

export function oneHopNeighbors(nodes: readonly ResearchNode[], edges: readonly ResearchEdge[], id: string) {
  const byId = new Map(nodes.filter(node => !node.archived).map(node => [node.id, node]));
  return edges.flatMap(edge => {
    if (edge.archived || edge.source !== id && edge.target !== id) return [];
    const direction = edge.source === id ? "out" as const : "in" as const;
    const node = byId.get(direction === "out" ? edge.target : edge.source);
    return node ? [{ edge, node, direction }] : [];
  });
}
/** Focused scopes show semantic one-hop neighbors as references to the original object. */
export function scopeReferences(nodes: readonly ResearchNode[], edges: readonly ResearchEdge[], owned: readonly ResearchNode[], scope: string) {
  const ownedIds = new Set(owned.map(node => node.id)), external = new Set<string>();
  if (scope) for (const edge of edges) {
    if (edge.archived || isHierarchyRelation(edge.label)) continue;
    if (ownedIds.has(edge.source) && !ownedIds.has(edge.target)) external.add(edge.target);
    if (ownedIds.has(edge.target) && !ownedIds.has(edge.source)) external.add(edge.source);
  }
  const references = nodes.filter(node => !node.archived && external.has(node.id));
  return { nodes: [...owned, ...references], external: new Set(references.map(node => node.id)) };
}
export function nodesInRectangle(nodes: readonly ResearchNode[], start: { x: number; y: number }, end: { x: number; y: number }, position: (node: ResearchNode) => { x: number; y: number }, size = canvasCardSize): string[] {
  const left = Math.min(start.x, end.x), right = Math.max(start.x, end.x), top = Math.min(start.y, end.y), bottom = Math.max(start.y, end.y);
  return nodes.filter(node => { const p = position(node), s = size(node); return p.x < right && p.x + s.width > left && p.y < bottom && p.y + s.height > top; }).map(node => node.id);
}
