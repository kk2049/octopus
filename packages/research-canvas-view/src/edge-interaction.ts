import type { ResearchEdge, ResearchNode } from "@claude-bot/research-canvas-contract";

const EDITING_SURFACE = 'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="combobox"],[role="spinbutton"],[role="dialog"],[aria-modal="true"],.cm-editor,.monaco-editor,[data-editor]';
/** Check both the dispatch target and focus: editors and portals may retarget
 * key events. Only the focused canvas or its edge controls own deletion keys. */
export function edgeKeyboardContext(target: EventTarget | null, active: Element | null, root: Element): boolean {
  if (!(target instanceof Element) || target.closest(EDITING_SURFACE) || active?.closest(EDITING_SURFACE)) return false;
  if (root.querySelector('[role="dialog"][aria-modal="true"]')) return false;
  const owns = (element: Element) => root.contains(element) && (element.matches(".rv-canvas") || !!element.closest("[data-edge],.rv-edge-selection"));
  return owns(target) && (!active || active === document.body || owns(active));
}
/** Only a fully valid, explicitly declared mainline simplifies membership lines. */
export function mainlineEdges(nodes: readonly ResearchNode[], edges: readonly ResearchEdge[]) {
  const byId = new Map(nodes.filter(node => !node.archived).map(node => [node.id, node]));
  const hidden = new Set<string>(), emphasized = new Set<string>();
  for (const folder of nodes) {
    if (folder.archived || folder.type !== "folder") continue;
    const meta = folder.data.meta;
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) continue;
    // Resource metadata is scalar on the backend; JSON strings are the stored
    // form. Also accept arrays from older projections and synthetic fixtures.
    let line: unknown = meta.mainline;
    if (typeof line === "string") {
      try { line = JSON.parse(line); } catch { continue; }
    }
    const members = new Set(Array.isArray(folder.data.members) ? folder.data.members : []);
    if (!Array.isArray(line) || line.length < 2 || new Set(line).size !== line.length
      || !line.every(id => typeof id === "string" && byId.has(id) && members.has(id))) continue;
    for (const edge of edges) {
      if (edge.archived) continue;
      if (edge.source === folder.id && edge.label === "contains" && members.has(edge.target) && edge.target !== line[0]) hidden.add(edge.id);
      if (edge.label === "下一步" && line.some((id, index) => id === edge.source && line[index + 1] === edge.target)) emphasized.add(edge.id);
    }
  }
  return { hidden, emphasized };
}
