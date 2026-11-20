/**
 * "Which thing on screen is this?", written so an agent can find it again.
 *
 * ── Why a path, and not just a subtree ──────────────────────────────────────
 *
 * The first element picker reported a bounded subtree: tags, ids, classes and
 * text under the click. That answers "what does it look like" and leaves the
 * only question an agent actually has unanswered — WHERE this is in the
 * document, and therefore which file renders it. A dump of
 * `<div><span>已完成</span></div>` matches forty places in this app.
 *
 * So a pick now leads with an ADDRESS: the ancestor chain from the document
 * root down to the element, each step carrying the same three things a
 * developer would use to grep for it (tag, id/class, and — when siblings share
 * a tag — its ordinal). The chain doubles as a real CSS selector, so the same
 * string can be pasted into a console or a Playwright locator; that is the test
 * of whether the address is honest rather than decorative.
 *
 * ── Bounded, like everything else that crosses into a ticket ────────────────
 *
 * Depth, node count, text samples and class lists are all capped. This module
 * is pure and DOM-read-only: it never writes, never listens, never navigates,
 * and produces plain data. It is the trusted page's own copy of the shape the
 * Agent View's embedded debug agent reports over the debug channel — the two
 * sides may not import each other (a trusted bundle downstream of the untrusted
 * one erases the boundary), so they share the field names and nothing else.
 */

/** Depth of the reported subtree below the picked element. */
const SUBTREE_MAX_DEPTH = 6;
/** Total nodes reported across the whole subtree. */
const SUBTREE_MAX_NODES = 120;
/** Per-node text sample ceiling. */
const TEXT_MAX = 80;
/** Steps reported in the address, counting from the element upwards. */
const PATH_MAX = 14;
/** Classes kept per step. A utility-CSS soup is not an address. */
const CLASS_MAX = 3;

export interface ElementPathStep {
  tag: string;
  id?: string;
  classes?: string[];
  /** 1-based position among same-tag siblings; omitted when it is the only one. */
  nth?: number;
  /** `data-testid`-ish hooks and the accessible name, when the element has them. */
  name?: string;
}

export interface SerializedNode {
  tag: string;
  id?: string;
  cls?: string;
  text?: string;
  kids?: SerializedNode[];
}

export interface PickedElement extends Record<string, unknown> {
  /** Root-down address, one readable step per level. */
  path: string[];
  /** The same address as a selector that resolves back to this element. */
  selector: string;
  /** Where in the app this was picked, so a ticket names the page. */
  route: string;
  /** Kept for continuity with the in-frame picker's report. */
  ancestors: string[];
  rect: { x: number; y: number; w: number; h: number };
  subtree: SerializedNode;
  nodes: number;
  truncated: boolean;
}

/**
 * A pick, from either side of the boundary.
 *
 * The in-frame agent reports the same field names through the debug channel,
 * but it is a different build behind a version-independent wire: treating its
 * answer as this exact type would be believing a foreign producer's shape.
 * Every consumer therefore reads these fields defensively.
 */
export type PickedElementLike = Partial<PickedElement> & Record<string, unknown>;

function classesOf(el: Element): string[] {
  const raw = typeof el.className === "string" ? el.className : el.getAttribute("class") ?? "";
  return raw.trim() ? raw.trim().split(/\s+/).slice(0, CLASS_MAX) : [];
}

/** A CSS identifier this module is willing to put in a selector, or "". */
function safeIdent(value: string): string {
  return /^[A-Za-z_][\w-]{0,63}$/.test(value) ? value : "";
}

function ordinalOf(el: Element): number | undefined {
  const parent = el.parentElement;
  if (!parent) return undefined;
  const peers = [...parent.children].filter((child) => child.tagName === el.tagName);
  if (peers.length < 2) return undefined;
  return peers.indexOf(el) + 1;
}

/**
 * One level of the address.
 *
 * `name` prefers a stable test hook over the accessible name: the hook is what
 * a developer greps for, while the label is what the person pointing at the
 * screen would say. Both are bounded; neither is a location.
 */
export function pathStep(el: Element): ElementPathStep {
  const step: ElementPathStep = { tag: el.tagName.toLowerCase() };
  const id = safeIdent(el.id ?? "");
  if (id) step.id = id;
  const classes = classesOf(el).map(safeIdent).filter(Boolean);
  if (classes.length) step.classes = classes;
  const nth = ordinalOf(el);
  if (nth !== undefined) step.nth = nth;
  const name = el.getAttribute("data-testid")
    ?? el.getAttribute("data-action")
    ?? el.getAttribute("aria-label")
    ?? el.getAttribute("name")
    ?? "";
  if (name) step.name = name.slice(0, TEXT_MAX);
  return step;
}

export function stepSelector(step: ElementPathStep): string {
  if (step.id) return `#${step.id}`;
  const classes = (step.classes ?? []).map((name) => `.${name}`).join("");
  const nth = step.nth === undefined ? "" : `:nth-of-type(${step.nth})`;
  return `${step.tag}${classes}${nth}`;
}

function stepWord(step: ElementPathStep): string {
  const named = step.name ? ` "${step.name}"` : "";
  return `${stepSelector(step)}${named}`;
}

/**
 * The address of `el`, root first.
 *
 * The chain stops at the nearest ancestor with an id, because that is where a
 * selector stops being a guess: everything above it cannot change which element
 * the rest of the chain resolves to.
 */
export function elementPath(el: Element): ElementPathStep[] {
  const steps: ElementPathStep[] = [];
  for (let at: Element | null = el; at && steps.length < PATH_MAX; at = at.parentElement) {
    const step = pathStep(at);
    steps.unshift(step);
    if (step.id) break;
  }
  return steps;
}

function serializeSubtree(root: Element): { subtree: SerializedNode; nodes: number; truncated: boolean } {
  let nodes = 0;
  let truncated = false;
  const walk = (el: Element, depth: number): SerializedNode => {
    nodes += 1;
    const out: SerializedNode = { tag: el.tagName.toLowerCase() };
    if (el.id) out.id = el.id.slice(0, TEXT_MAX);
    const classes = classesOf(el);
    if (classes.length) out.cls = classes.join(" ").slice(0, TEXT_MAX);
    // This element's OWN text, so a container does not repeat every
    // descendant's words back at the reader.
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
  return { subtree, nodes, truncated };
}

/** Everything one pick reports. Pure: reads the DOM, writes nothing. */
export function describeElement(el: Element, route: string): PickedElement {
  const steps = elementPath(el);
  const { subtree, nodes, truncated } = serializeSubtree(el);
  const rect = el.getBoundingClientRect();
  return {
    path: steps.map(stepWord),
    selector: steps.map(stepSelector).join(" > "),
    route,
    ancestors: steps.slice(0, -1).map(stepSelector),
    rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
    subtree,
    nodes,
    truncated,
  };
}
