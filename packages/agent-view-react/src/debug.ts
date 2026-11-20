/**
 * The embedded debug agent every packaged View carries
 * (design: doc/development/frontend-observability-design.md §5).
 *
 * It exists so a person can point at a suspicious element THROUGH the trust
 * boundary: the trusted parent asks `pick.start` over the debug channel, this
 * agent overlays a picker inside the frame, and the clicked element comes back
 * as a BOUNDED description — tag/id/class/text, depth- and node-capped — over
 * the same port. Nothing here runs parent-supplied code, reads anything the
 * View could not already read, or speaks unprompted: the one unsolicited
 * message (`debugEvent`) is the completion of a pick the parent started.
 */

/** Depth of the reported subtree below the picked element. */
const SUBTREE_MAX_DEPTH = 8;
/** Total nodes reported across the whole subtree. */
const SUBTREE_MAX_NODES = 200;
/** Per-node text sample ceiling. */
const TEXT_MAX = 80;
/** Ancestor names reported above the picked element. */
const ANCESTORS_MAX = 10;

export interface PickedElement {
  /**
   * A selector chain that resolves back to the picked element (ticket #201).
   *
   * The subtree below says what the element LOOKS like; only this says where
   * it is, and "where" is the question the person reading the report has. Each
   * step carries what a developer would grep for — tag, id or classes, and an
   * ordinal when siblings share a tag — so the same string works in a console
   * and in a locator. That is the test of whether the address is honest.
   */
  selector: string;
  /** The same chain, one readable step per level, with any accessible name. */
  path: string[];
  /** `tag#id.class` names from the document root down to the pick, bounded. */
  ancestors: string[];
  rect: { x: number; y: number; w: number; h: number };
  subtree: SerializedNode;
  nodes: number;
  truncated: boolean;
}

export interface SerializedNode {
  tag: string;
  id?: string;
  cls?: string;
  text?: string;
  kids?: SerializedNode[];
}

export interface DebugAgent {
  /** Arm the picker overlay; the next click reports and disarms. */
  start(): void;
  /** Disarm without reporting. Idempotent. */
  stop(): void;
}

function nameOf(el: Element): string {
  const id = el.id ? `#${el.id}` : "";
  const cls = typeof el.className === "string" && el.className.trim()
    ? `.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}`
    : "";
  return `${el.tagName.toLowerCase()}${id}${cls}`.slice(0, TEXT_MAX);
}

/** A CSS identifier this agent is willing to put in a selector, or "". */
function safeIdent(value: string): string {
  return /^[A-Za-z_][\w-]{0,63}$/.test(value) ? value : "";
}

/**
 * One addressable step: `#id` when there is one, else tag + classes + an
 * ordinal when the element has same-tag siblings. The ordinal is what makes
 * the chain resolve to ONE element rather than to a row shape.
 */
function selectorStep(el: Element): string {
  const id = safeIdent(el.id ?? "");
  if (id) return `#${id}`;
  const classes = (typeof el.className === "string" ? el.className.trim() : "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .map(safeIdent)
    .filter(Boolean)
    .map((name) => `.${name}`)
    .join("");
  const parent = el.parentElement;
  const peers = parent ? [...parent.children].filter((child) => child.tagName === el.tagName) : [];
  const nth = peers.length > 1 ? `:nth-of-type(${peers.indexOf(el) + 1})` : "";
  return `${el.tagName.toLowerCase()}${classes}${nth}`;
}

/**
 * The address, root first, stopping at the nearest id.
 *
 * Above an id nothing can change which element the rest of the chain names,
 * so continuing to the document root would add length and no precision.
 */
function addressOf(root: Element): { selector: string; path: string[] } {
  const steps: string[] = [];
  const words: string[] = [];
  for (let el: Element | null = root; el && steps.length < ANCESTORS_MAX + 4; el = el.parentElement) {
    const step = selectorStep(el);
    steps.unshift(step);
    const label = el.getAttribute("data-testid")
      ?? el.getAttribute("data-action")
      ?? el.getAttribute("aria-label")
      ?? "";
    words.unshift(label ? `${step} "${label.slice(0, TEXT_MAX)}"` : step);
    if (step.startsWith("#")) break;
  }
  return { selector: steps.join(" > "), path: words };
}

export function serializeSubtree(root: Element): PickedElement {
  let nodes = 0;
  let truncated = false;
  const walk = (el: Element, depth: number): SerializedNode => {
    nodes += 1;
    const out: SerializedNode = { tag: el.tagName.toLowerCase() };
    if (el.id) out.id = el.id.slice(0, TEXT_MAX);
    if (typeof el.className === "string" && el.className.trim()) out.cls = el.className.trim().slice(0, TEXT_MAX);
    // Only THIS element's own text (not the subtree's), so a container does
    // not duplicate every descendant's words.
    const ownText = [...el.childNodes]
      .filter((node) => node.nodeType === 3)
      .map((node) => node.textContent ?? "")
      .join(" ")
      .trim();
    if (ownText) out.text = ownText.slice(0, TEXT_MAX);
    if (depth >= SUBTREE_MAX_DEPTH) {
      if (el.children.length > 0) truncated = true;
      return out;
    }
    const kids: SerializedNode[] = [];
    for (const child of [...el.children]) {
      if (nodes >= SUBTREE_MAX_NODES) {
        truncated = true;
        break;
      }
      kids.push(walk(child, depth + 1));
    }
    if (kids.length) out.kids = kids;
    return out;
  };
  const subtree = walk(root, 0);
  const ancestors: string[] = [];
  for (let el = root.parentElement; el && ancestors.length < ANCESTORS_MAX; el = el.parentElement) {
    ancestors.unshift(nameOf(el));
  }
  const rect = root.getBoundingClientRect();
  const address = addressOf(root);
  return {
    selector: address.selector,
    path: address.path,
    ancestors,
    rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
    subtree,
    nodes,
    truncated,
  };
}

export function createDebugAgent(doc: Document, onPick: (result: PickedElement) => void): DebugAgent {
  let armed = false;
  let highlighted: { el: HTMLElement; outline: string } | null = null;

  const clearHighlight = (): void => {
    if (highlighted) highlighted.el.style.outline = highlighted.outline;
    highlighted = null;
  };

  const onOver = (event: Event): void => {
    const el = event.target;
    if (!(el instanceof HTMLElement)) return;
    clearHighlight();
    highlighted = { el, outline: el.style.outline };
    el.style.outline = "2px solid #e5484d";
  };

  const onClick = (event: Event): void => {
    // The pick swallows the click entirely: an armed picker must never
    // double as a real press on whatever button happened to be under it.
    event.preventDefault();
    event.stopPropagation();
    const el = event.target;
    stop();
    if (el instanceof Element) onPick(serializeSubtree(el));
  };

  function stop(): void {
    if (!armed) return;
    armed = false;
    clearHighlight();
    doc.removeEventListener("mouseover", onOver, true);
    doc.removeEventListener("click", onClick, true);
    doc.documentElement.style.cursor = "";
  }

  return {
    start() {
      if (armed) return;
      armed = true;
      doc.addEventListener("mouseover", onOver, true);
      doc.addEventListener("click", onClick, true);
      doc.documentElement.style.cursor = "crosshair";
    },
    stop,
  };
}
