import type { CanvasSide, GraphEdgePorts, GraphPosition } from "./graph-document.js";
import { canvasTree } from "./tree.js";
import { canvasCardSize, type CanvasSize } from "./presentation.js";
import type { ResearchEdge, ResearchNode, ResearchSubscription } from "./model.js";

/** Public canvas geometry, shared by the view and Agent inspection tools. */
export const CANVAS_CARD_SIZE = { width: 300, height: 212 } as const;
export const CANVAS_LAYOUT_LIMITS = { nodes: 120, edges: 200, warnings: 30 } as const;
export type CanvasPosition = { x: number; y: number };
export type CanvasPositions = Record<string, GraphPosition>;
export type CanvasLayoutMode = "hierarchy" | "canvas" | "tree";
export type CanvasRelationMode = "none" | "scope";
export type CanvasLayoutWarning = {
  code: "node_overlap" | "edge_crossing" | "edge_through_node" | "edge_density" | "hierarchy_cycle" | "multiple_parents" | "inspection_limit";
  message: string;
  nodes: string[];
  edges: string[];
};
export type CanvasLayoutInput = {
  nodes: readonly ResearchNode[];
  edges: readonly ResearchEdge[];
  subscriptions?: readonly ResearchSubscription[];
  positions?: CanvasPositions;
  edgePorts?: Record<string, GraphEdgePorts>;
  scope?: string;
  relations?: CanvasRelationMode;
  layout?: CanvasLayoutMode;
  expanded?: readonly string[];
};
export const canvasMembers = (node: ResearchNode): string[] =>
  Array.isArray(node.data.members)
    ? node.data.members.filter((id): id is string => typeof id === "string")
    : [];

/** Iterative three-color DFS: cycles can be reachable from a valid root too. */
function hierarchyCycleNodes(byId: ReadonlyMap<string, ResearchNode>): Set<string> {
  const colors = new Map<string, 1 | 2>(), cycles = new Set<string>();
  for (const start of byId.keys()) {
    if (colors.has(start)) continue;
    const stack: Array<{ id: string; children: string[]; next: number }> = [];
    const enter = (id: string) => {
      colors.set(id, 1);
      stack.push({ id, children: canvasMembers(byId.get(id)!).filter((child) => byId.has(child)), next: 0 });
    };
    enter(start);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      if (frame.next === frame.children.length) {
        colors.set(frame.id, 2);
        stack.pop();
        continue;
      }
      const child = frame.children[frame.next++];
      if (colors.get(child) === 1) {
        const ancestor = stack.findIndex((frame) => frame.id === child);
        for (let index = ancestor; index < stack.length; index++) cycles.add(stack[index].id);
      } else if (!colors.has(child)) enter(child);
    }
  }
  return cycles;
}

/** Goals stay on the canvas. Folder children use coordinates local to their scope. */
export function canvasScope(nodes: readonly ResearchNode[], scope = "") {
  const active = nodes.filter((node) => !node.archived);
  const byId = new Map(active.map((node) => [node.id, node]));
  const parents = new Map<string, string[]>();
  for (const folder of active) for (const child of canvasMembers(folder)) {
    if (!byId.has(child)) continue;
    const list = parents.get(child) ?? [];
    if (!list.includes(folder.id)) list.push(folder.id);
    parents.set(child, list);
  }
  if (scope && !byId.has(scope))
    throw new Error("画布节点不存在");
  const roots = active.filter((node) => !parents.has(node.id));
  // Cyclic legacy imports must remain reachable, without recursively walking forever.
  const reached = new Set<string>();
  const visit = (start: string) => {
    const pending = [start];
    while (pending.length) {
      const id = pending.pop()!;
      if (reached.has(id)) continue;
      reached.add(id);
      const node = byId.get(id);
      if (node) pending.push(...canvasMembers(node));
    }
  };
  roots.forEach((node) => visit(node.id));
  for (const node of active) if (!reached.has(node.id)) {
    roots.push(node);
    visit(node.id);
  }
  const allCycles = hierarchyCycleNodes(byId);
  if (scope) { reached.clear(); visit(scope); }
  const cycles = [...allCycles].filter((id) => !scope || reached.has(id));
  const members = scope ? new Set(canvasMembers(byId.get(scope)!)) : null;
  const visible = members ? [...members].flatMap((id) => byId.has(id) ? [byId.get(id)!] : []) : roots;
  return {
    nodes: visible,
    goals: visible.filter((node) => !scope && node.type === "goal"),
    parents,
    cycles,
  };
}

export function canvasDisplayPositions(nodes: readonly ResearchNode[], layout: CanvasLayoutMode, positions?: CanvasPositions): CanvasPositions {
  if (layout === "tree") return canvasTree(nodes).positions;
  if (layout === "canvas") return Object.fromEntries(nodes.map(node => [node.id, position(node, positions)]));
  const result: CanvasPositions = {};
  let y = 0;
  for (let i = 0; i < nodes.length; i += 3) {
    const row = nodes.slice(i, i + 3); let x = 0;
    for (const node of row) { result[node.id] = { x, y }; x += canvasCardSize(node, "canvas", positions?.[node.id]).width + 40; }
    y += Math.max(...row.map(node => canvasCardSize(node, "canvas", positions?.[node.id]).height)) + 38;
  }
  return result;
}

const position = (node: ResearchNode, positions?: CanvasPositions): CanvasPosition => {
  const p = positions?.[node.id];
  return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? p : { x: node.x, y: node.y };
};
const cross = (a: CanvasPosition, b: CanvasPosition, c: CanvasPosition) =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const crosses = (a: CanvasPosition, b: CanvasPosition, c: CanvasPosition, d: CanvasPosition) =>
  // Include intersections at sampled segment endpoints: a real curve crossing
  // often lands exactly at t=.5 on both curves. Shared graph endpoints are
  // excluded by the caller, not by dropping these genuine intersections.
  Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)) <= Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) + 0.001 &&
  Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)) <= Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y)) + 0.001 &&
  cross(a, b, c) * cross(a, b, d) <= 0.001 && cross(c, d, a) * cross(c, d, b) <= 0.001;

/** Route from the facing card sides; one geometry for the view and diagnostics. */
export function canvasEdgeCurve(a: CanvasPosition, b: CanvasPosition, aSize: CanvasSize = CANVAS_CARD_SIZE, bSize: CanvasSize = CANVAS_CARD_SIZE, direction?: "horizontal", ports?: GraphEdgePorts) {
  const ac = { x: a.x + aSize.width / 2, y: a.y + aSize.height / 2 };
  const bc = { x: b.x + bSize.width / 2, y: b.y + bSize.height / 2 };
  const dx = bc.x - ac.x, dy = bc.y - ac.y;
  const horizontal = direction === "horizontal" || Math.abs(dx) / ((aSize.width + bSize.width) / 2) >= Math.abs(dy) / ((aSize.height + bSize.height) / 2);
  const sign = (horizontal ? dx : dy) >= 0 ? 1 : -1;
  let from = horizontal ? { x: a.x + (sign > 0 ? aSize.width : 0), y: ac.y } : { x: ac.x, y: a.y + (sign > 0 ? aSize.height : 0) };
  let to = horizontal ? { x: b.x + (sign > 0 ? 0 : bSize.width), y: bc.y } : { x: bc.x, y: b.y + (sign > 0 ? 0 : bSize.height) };
  const distance = Math.max(40, Math.abs(horizontal ? to.x - from.x : to.y - from.y) / 2);
  let c1 = { x: from.x + (horizontal ? sign * distance : 0), y: from.y + (horizontal ? 0 : sign * distance) };
  let c2 = { x: to.x - (horizontal ? sign * distance : 0), y: to.y - (horizontal ? 0 : sign * distance) };
  const sidePoint = (point: CanvasPosition, size: CanvasSize, side: CanvasSide) => ({ x: point.x + (side === "left" ? 0 : side === "right" ? size.width : size.width / 2), y: point.y + (side === "top" ? 0 : side === "bottom" ? size.height : size.height / 2) });
  const control = (point: CanvasPosition, side: CanvasSide) => ({ x: point.x + (side === "left" ? -distance : side === "right" ? distance : 0), y: point.y + (side === "top" ? -distance : side === "bottom" ? distance : 0) });
  if (ports?.sourceSide) { from = sidePoint(a, aSize, ports.sourceSide); c1 = control(from, ports.sourceSide); }
  if (ports?.targetSide) { to = sidePoint(b, bSize, ports.targetSide); c2 = control(to, ports.targetSide); }
  const points = Array.from({ length: 17 }, (_, i) => {
    const t = i / 16, u = 1 - t;
    return {
      x: u ** 3 * from.x + 3 * u ** 2 * t * c1.x + 3 * u * t ** 2 * c2.x + t ** 3 * to.x,
      y: u ** 3 * from.y + 3 * u ** 2 * t * c1.y + 3 * u * t ** 2 * c2.y + t ** 3 * to.y,
    };
  });
  return { d: `M ${from.x} ${from.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${to.x} ${to.y}`, points };
}

export function diagnoseCanvasLayout(input: CanvasLayoutInput) {
  const scope = input.scope ?? "", relations = input.relations ?? "scope", layout = input.layout ?? "canvas";
  const selected = canvasScope(input.nodes, scope);
  const tree = canvasTree(input.nodes, scope, new Set(input.expanded ?? canvasScope(input.nodes).goals.map(n => n.id)), "canvas", input.positions);
  const visible = tree?.nodes ?? selected.nodes;
  const nodes = visible.slice(0, CANVAS_LAYOUT_LIMITS.nodes);
  input = { ...input, positions: canvasDisplayPositions(nodes, "canvas", input.positions) };
  const ids = new Set(nodes.map((node) => node.id));
  const allEdges = [...input.edges, ...(input.subscriptions ?? [])].filter((edge) => !edge.archived && ids.has(edge.source) && ids.has(edge.target));
  const edges = relations === "scope" ? allEdges.slice(0, CANVAS_LAYOUT_LIMITS.edges) : [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const warnings: CanvasLayoutWarning[] = [];
  let totalWarnings = 0;
  const warn = (code: CanvasLayoutWarning["code"], message: string, nodes: string[] = [], edges: string[] = []) => {
    totalWarnings++;
    if (warnings.length < CANVAS_LAYOUT_LIMITS.warnings) warnings.push({ code, message, nodes, edges });
  };
  const complete = visible.length <= nodes.length && (relations === "none" || allEdges.length <= edges.length);
  if (!complete) warn("inspection_limit", "当前层超过检查预算；请拆分文件夹后逐层检查，未检查部分不代表没有问题。");
  if (selected.cycles.length) warn("hierarchy_cycle", "文件夹成员关系包含循环；请修正父子成员关系，避免循环导航。", selected.cycles.slice(0, 8));
  for (const node of nodes) {
    if ((selected.parents.get(node.id)?.length ?? 0) > 1)
      warn("multiple_parents", "节点属于多个文件夹；其公共坐标在各层复用，请确认层级归属。", [node.id]);
  }
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const a = position(nodes[i], input.positions), b = position(nodes[j], input.positions);
    const as = canvasCardSize(nodes[i], layout, input.positions?.[nodes[i].id]), bs = canvasCardSize(nodes[j], layout, input.positions?.[nodes[j].id]);
    if (a.x < b.x + bs.width && a.x + as.width > b.x && a.y < b.y + bs.height && a.y + as.height > b.y)
      warn("node_overlap", "同层卡片重叠；拉开间距或收纳到子文件夹。", [nodes[i].id, nodes[j].id]);
  }
  if (edges.length > Math.max(8, nodes.length * 1.5))
    warn("edge_density", "同层关系过密；优先使用任务层级并按选中节点显示关系。");
  const curves = edges.map((edge) => canvasEdgeCurve(position(byId.get(edge.source)!, input.positions), position(byId.get(edge.target)!, input.positions), canvasCardSize(byId.get(edge.source)!, "canvas", input.positions?.[edge.source]), canvasCardSize(byId.get(edge.target)!, "canvas", input.positions?.[edge.target]), undefined, input.edgePorts?.[edge.id]).points);
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i], points = curves[i];
    for (const node of nodes) {
      if (node.id === edge.source || node.id === edge.target) continue;
      const p = position(node, input.positions), size = canvasCardSize(node, "canvas", input.positions?.[node.id]);
      const inside = (v: CanvasPosition) => v.x > p.x && v.x < p.x + size.width && v.y > p.y && v.y < p.y + size.height;
      const corners = [p, { x: p.x + size.width, y: p.y }, { x: p.x + size.width, y: p.y + size.height }, { x: p.x, y: p.y + size.height }];
      if (points.some(inside) || points.slice(1).some((point, index) => corners.some((corner, k) => crosses(points[index], point, corner, corners[(k + 1) % 4]))))
        warn("edge_through_node", "关系线穿过其他卡片；调整本层位置或隐藏无关关系。", [node.id, edge.source, edge.target], [edge.id]);
    }
    for (let j = i + 1; j < edges.length; j++) {
      const other = edges[j];
      if ([edge.source, edge.target].some((id) => id === other.source || id === other.target)) continue;
      if (points.slice(1).some((point, k) => curves[j].slice(1).some((end, l) => crosses(points[k], point, curves[j][l], end))))
        warn("edge_crossing", "同层关系线交叉；按因果顺序排列或使用选中关系模式。", [edge.source, edge.target, other.source, other.target], [edge.id, other.id]);
    }
  }
  return { scope, relations, layout, complete, counts: { nodes: visible.length, edges: allEdges.length, checkedNodes: nodes.length, checkedEdges: edges.length, warnings: totalWarnings }, warnings, warningsTruncated: totalWarnings > warnings.length };
}

const escapeXml = (value: string) => value.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
const short = (text: string, size: number) => Array.from(text).slice(0, size).join("");
/** Inert SVG of authorized semantic state; not a browser/page screenshot. */
export function renderCanvasSnapshot(input: CanvasLayoutInput) {
  const relations = input.relations ?? "scope", layout = input.layout ?? "canvas";
  const selection = canvasScope(input.nodes, input.scope);
  const tree = canvasTree(input.nodes, input.scope, new Set(input.expanded ?? canvasScope(input.nodes).goals.map(n => n.id)), "canvas", input.positions);
  if ((tree?.nodes ?? selection.nodes).length > CANVAS_LAYOUT_LIMITS.nodes)
    throw new Error("当前层超过 120 个节点，请选择更小的文件夹后生成结构预览");
  const nodes = tree?.nodes ?? selection.nodes;
  input = { ...input, positions: canvasDisplayPositions(nodes, "canvas", input.positions), layout };
  const ids = new Set(nodes.map((node) => node.id));
  const edges = relations === "none" ? [] : [...input.edges, ...(input.subscriptions ?? [])].filter((edge) => !edge.archived && ids.has(edge.source) && ids.has(edge.target));
  if (edges.length > CANVAS_LAYOUT_LIMITS.edges)
    throw new Error("当前层超过 200 条关系，请关闭关系显示或拆分层级");
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const xs = nodes.map((node) => position(node, input.positions).x), ys = nodes.map((node) => position(node, input.positions).y);
  const left = Math.min(0, ...xs) - 32, top = Math.min(0, ...ys) - 100;
  const width = Math.max(800, Math.max(0, ...nodes.map((n, i) => xs[i] + canvasCardSize(n, "canvas", input.positions?.[n.id]).width)) - left + 32);
  const height = Math.max(400, Math.max(0, ...nodes.map((n, i) => ys[i] + canvasCardSize(n, "canvas", input.positions?.[n.id]).height)) - top + 32);
  const lines = edges.map((edge) => `<path d="${canvasEdgeCurve(position(byId.get(edge.source)!, input.positions), position(byId.get(edge.target)!, input.positions), canvasCardSize(byId.get(edge.source)!, "canvas", input.positions?.[edge.source]), canvasCardSize(byId.get(edge.target)!, "canvas", input.positions?.[edge.target]), undefined, input.edgePorts?.[edge.id]).d}" fill="none" stroke="#8f9b92" stroke-width="2" marker-end="url(#arrow)"/>`).join("");
  const cards = nodes.map((node) => {
    const p = position(node, input.positions), size = canvasCardSize(node, "canvas", input.positions?.[node.id]);
    return `<g transform="translate(${p.x} ${p.y})"><rect width="${size.width}" height="${size.height}" rx="14" fill="#fff" stroke="#d6ded5"/><text x="20" y="29" fill="#687c69" font-size="12">${escapeXml(node.type)} · ${escapeXml(node.phase)}</text><text x="20" y="65" fill="#203126" font-size="18">${escapeXml(short(node.title, 22))}</text><text x="20" y="98" fill="#5b675f" font-size="13">${escapeXml(short(node.summary, 30))}</text><text x="20" y="${size.height - 22}" fill="#87938a" font-size="11">${escapeXml(short(node.id, 42))}</text></g>`;
  }).join("");
  const title = input.scope ? input.nodes.find((node) => node.id === input.scope)?.title ?? "项目" : selection.goals[0]?.title ?? "项目总览";
  const scale = Math.min(1, 1600 / width, 1200 / height);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.max(1, Math.round(width * scale))}" height="${Math.max(1, Math.round(height * scale))}" viewBox="${left} ${top} ${width} ${height}" role="img" aria-label="研究画布结构预览"><rect x="${left}" y="${top}" width="${width}" height="${height}" fill="#f4f6f1"/><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8" fill="#8f9b92"/></marker></defs><g font-family="sans-serif"><text x="${left + 32}" y="${top + 34}" fill="#243c2b" font-size="22">${escapeXml(short(title, 60))}</text><text x="${left + 32}" y="${top + 61}" fill="#69796a" font-size="12">结构预览 · 非浏览器截图 · ${nodes.length} 个节点 / ${edges.length} 条可见关系</text>${lines}${cards}</g></svg>`;
  return { kind: "structure-preview" as const, mime: "image/svg+xml" as const, scope: input.scope ?? "", relations, layout, width, height, svg, diagnostics: diagnoseCanvasLayout({ ...input, relations }) };
}
