/**
 * DOM Range helpers for PDF.js text layers.
 *
 * Browser Selection#toString may insert visual line breaks which do not exist
 * in `textContent`. Anchors, however, are rebound against that exact text
 * snapshot. Convert the range boundaries to text-node offsets first so a
 * selection spanning several positioned PDF.js spans stays byte-for-byte
 * aligned with the snapshot.
 */

export interface TextSelectionOffsets {
  start: number;
  end: number;
  text: string;
}

export function textSelectionOffsets(root: HTMLElement, selection: Selection): TextSelectionOffsets | null {
  if (selection.rangeCount < 1 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!containsBoundary(root, range.startContainer) || !containsBoundary(root, range.endContainer)) return null;

  const start = boundaryTextOffset(root, range.startContainer, range.startOffset);
  const end = boundaryTextOffset(root, range.endContainer, range.endOffset);
  const text = root.textContent ?? "";
  if (start < 0 || end <= start || end > text.length) return null;
  return { start, end, text: text.slice(start, end) };
}

/** Recreate a DOM Range from offsets into `root.textContent`. */
export function textRangeFromOffsets(root: HTMLElement, start: number, end: number): Range | null {
  const text = root.textContent ?? "";
  if (start < 0 || end <= start || end > text.length) return null;
  const startPoint = textBoundary(root, start);
  const endPoint = textBoundary(root, end);
  if (!startPoint || !endPoint) return null;
  const range = root.ownerDocument.createRange();
  range.setStart(startPoint.textNode, startPoint.offset);
  range.setEnd(endPoint.textNode, endPoint.offset);
  return range;
}

function containsBoundary(root: HTMLElement, candidate: Node): boolean {
  return candidate === root || root.contains(candidate);
}

function boundaryTextOffset(root: HTMLElement, container: Node, offset: number): number {
  try {
    const before = root.ownerDocument.createRange();
    before.selectNodeContents(root);
    before.setEnd(container, offset);
    return before.cloneContents().textContent?.length ?? 0;
  } catch {
    return -1;
  }
}

function textBoundary(root: HTMLElement, target: number): { textNode: Text; offset: number } | null {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let cursor = 0;
  let last: Text | null = null;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    last = node;
    const next = cursor + node.data.length;
    if (target <= next) return { textNode: node, offset: target - cursor };
    cursor = next;
  }
  return last && target === cursor ? { textNode: last, offset: last.data.length } : null;
}
