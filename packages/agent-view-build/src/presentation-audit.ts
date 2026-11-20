/// <reference lib="dom" />

/** Explicit semantic peers, not every text node on a page. A heading and its
 * caption must never become peers merely because they share a parent. */
export interface PresentationGroup {
  name: string;
  selector: string;
  minimum?: number;
  typography?: boolean;
  align?: "left" | "right" | "center-y";
  sameHeight?: boolean;
}

export interface PresentationMeasurement {
  text: string;
  fontSize: string;
  fontFamily: string;
  lineHeight: string;
  left: number;
  right: number;
  centerY: number;
  height: number;
}

/** Pass directly to Playwright's page.evaluate. No requests, writes, clicks,
 * observers or polling; hidden peers cannot make a check pass. */
export function measurePresentation(groups: PresentationGroup[]) {
  return groups.map(group => ({
    ...group,
    measurements: Array.from(document.querySelectorAll<HTMLElement>(group.selector))
      .filter(element => {
        const style = getComputedStyle(element);
        return element.getClientRects().length > 0 && style.visibility !== "hidden" && style.display !== "none";
      })
      .map(element => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return {
          text: (element.textContent || element.getAttribute("aria-label") || element.tagName).trim().slice(0, 100),
          fontSize: style.fontSize, fontFamily: style.fontFamily, lineHeight: style.lineHeight,
          left: rect.left, right: rect.right, centerY: rect.top + rect.height / 2, height: rect.height,
        };
      }),
  }));
}

export function presentationFailures(groups: Array<PresentationGroup & { measurements: PresentationMeasurement[] }>): string[] {
  const failures: string[] = [];
  for (const group of groups) {
    const rows = group.measurements;
    if (rows.length < (group.minimum ?? 2)) {
      failures.push(`${group.name}: expected at least ${group.minimum ?? 2} visible peers, got ${rows.length} (${group.selector})`);
      continue;
    }
    const properties: Array<keyof PresentationMeasurement> = group.typography === false ? [] : ["fontSize", "fontFamily", "lineHeight"];
    if (group.align) properties.push(group.align === "center-y" ? "centerY" : group.align);
    if (group.sameHeight) properties.push("height");
    for (const property of properties) {
      const values = rows.map(row => row[property]);
      const consistent = typeof values[0] === "number"
        ? Math.max(...values as number[]) - Math.min(...values as number[]) <= 1
        : new Set(values).size === 1;
      if (!consistent) failures.push(`${group.name}.${property}: ${JSON.stringify(rows)}`);
    }
  }
  return failures;
}

/** Conservatively discover repeated DOM roles for a batch audit. Group by the
 * same tag/role/classes under one parent, including matching text descendants
 * of repeated rows/cards. Different heading levels, captions, states and
 * editable controls are separate roles. Geometry needs explicit groups.
 *
 * This is candidate discovery, not a claim of semantic understanding. A
 * reported difference needs review before changing product CSS. */
export function discoverPresentationGroups(rootSelector = "body"): PresentationGroup[] {
  const root = document.querySelector<HTMLElement>(rootSelector);
  if (!root) throw new Error(`Presentation root missing: ${rootSelector}`);
  const elements = [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))];
  if (elements.length > 4000) throw new Error("Presentation audit exceeds 4000 elements; choose a smaller surface");
  const groups: PresentationGroup[] = [];
  const seen = new Set<string>();
  const signature = (element: Element) => [
    element.tagName, element.getAttribute("role") ?? "", Array.from(element.classList).sort().join("."),
  ].join("|");
  const visibleText = (element: Element) => {
    if (element.closest("svg, canvas, pre, code, input, textarea, select, [contenteditable]")) return false;
    const style = getComputedStyle(element);
    return element.getClientRects().length > 0 && style.visibility !== "hidden"
      && Array.from(element.childNodes).some(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim());
  };
  const path = (element: Element): string => {
    const segments: string[] = [];
    let current: Element | null = element;
    while (current && current !== document.documentElement) {
      const parent: Element | null = current.parentElement;
      if (!parent) break;
      segments.unshift(`${current.tagName.toLowerCase()}:nth-child(${Array.from(parent.children).indexOf(current) + 1})`);
      current = parent;
    }
    return "html > " + segments.join(" > ");
  };
  const add = (peers: Element[]) => {
    const visible = peers.filter(visibleText);
    if (visible.length < 2) return;
    const selector = visible.map(path).join(", ");
    if (seen.has(selector)) return;
    seen.add(selector);
    if (groups.length >= 600) throw new Error("Presentation audit exceeds 600 peer groups; choose a smaller surface");
    groups.push({ name: `repeated ${signature(visible[0])}`, selector, minimum: visible.length });
  };
  for (const parent of elements) {
    const repeated = new Map<string, Element[]>();
    for (const child of Array.from(parent.children)) {
      const key = signature(child);
      repeated.set(key, [...(repeated.get(key) ?? []), child]);
    }
    for (const peers of repeated.values()) {
      if (peers.length < 2) continue;
      add(peers);
      // Compare equivalent descendants, not arbitrary text in a card: title,
      // subtitle and footer each retain their own scale.
      const descendants = new Map<string, Element[]>();
      for (const peer of peers) {
        for (const child of Array.from(peer.querySelectorAll("*"))) {
          if (!visibleText(child)) continue;
          const relative: string[] = [];
          let current: Element | null = child;
          while (current && current !== peer) {
            relative.unshift(signature(current));
            current = current.parentElement;
          }
          const key = relative.join(" > ");
          descendants.set(key, [...(descendants.get(key) ?? []), child]);
        }
      }
      for (const matches of descendants.values()) add(matches);
    }
  }
  return groups;
}
