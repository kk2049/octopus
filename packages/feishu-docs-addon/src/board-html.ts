/**
 * Renders an agent's board — one page of static HTML — inside a shadow root.
 *
 * The markup is parsed inertly (DOMParser runs nothing and loads nothing),
 * then rebuilt element by element from an allowlist. Styles go through the
 * CSSOM (constructed sheets and `style.cssText`), so a board looks the same
 * under whatever Content-Security-Policy the host page carries, and its CSS
 * stays inside the shadow root. What survives cannot execute, navigate the
 * card, or reach outside it:
 * - scripts, frames, objects, forms, SMIL animation and every event-handler
 *   attribute are dropped;
 * - links keep only http(s)/mailto targets and are opened through the host;
 * - images and CSS url() keep only inline data:image (and #fragment refs), so
 *   showing a board never tells a third party who is reading it.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const MAX_NODES = 8000;
const MAX_DEPTH = 64;

/** Removed with everything inside them. */
const DROP = new Set(['script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'link', 'meta', 'base', 'noscript',
  'template', 'form', 'input', 'button', 'select', 'option', 'textarea', 'audio', 'video', 'source', 'track', 'canvas', 'portal', 'math',
  'slot', 'dialog', 'foreignobject', 'animate', 'animatemotion', 'animatetransform', 'set', 'image', 'feimage']);
const HTML_TAGS = new Set(['a', 'abbr', 'article', 'aside', 'b', 'bdi', 'blockquote', 'br', 'caption', 'cite', 'code', 'col', 'colgroup', 'dd', 'del',
  'details', 'dfn', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'i', 'img',
  'ins', 'kbd', 'label', 'li', 'main', 'mark', 'meter', 'nav', 'ol', 'p', 'pre', 'progress', 'q', 's', 'samp', 'section', 'small', 'span',
  'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'u', 'ul', 'var', 'wbr']);
const SVG_TAGS = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'textpath', 'defs',
  'lineargradient', 'radialgradient', 'stop', 'clippath', 'mask', 'pattern', 'use', 'marker', 'symbol', 'desc', 'title']);
const HTML_ATTRS = new Set(['class', 'id', 'title', 'role', 'lang', 'dir', 'alt', 'colspan', 'rowspan', 'scope', 'headers', 'align', 'valign',
  'width', 'height', 'span', 'start', 'reversed', 'type', 'value', 'min', 'max', 'low', 'high', 'optimum', 'open', 'datetime', 'abbr']);
const SVG_ATTRS = new Set(['class', 'id', 'viewbox', 'preserveaspectratio', 'width', 'height', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'r',
  'rx', 'ry', 'dx', 'dy', 'd', 'points', 'transform', 'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity',
  'stroke-dasharray', 'stroke-dashoffset', 'stroke-linecap', 'stroke-linejoin', 'opacity', 'offset', 'stop-color', 'stop-opacity',
  'gradientunits', 'gradienttransform', 'spreadmethod', 'fx', 'fy', 'patternunits', 'patterncontentunits', 'patterntransform', 'clip-path',
  'clip-rule', 'mask', 'marker-start', 'marker-mid', 'marker-end', 'markerwidth', 'markerheight', 'markerunits', 'refx', 'refy', 'orient',
  'text-anchor', 'dominant-baseline', 'alignment-baseline', 'baseline-shift', 'font-size', 'font-weight', 'font-family', 'font-style',
  'letter-spacing', 'textlength', 'lengthadjust', 'startoffset', 'visibility', 'display', 'vector-effect', 'shape-rendering', 'role']);

/** Keeps url() only for inline images and same-document references; drops @import and legacy script hooks. */
export function cleanCss(css: string): string {
  return css
    .replace(/@import[^;]*;?/gi, '')
    .replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (whole, _quote: string, target: string) => /^\s*(data:image\/|#)/i.test(target) ? whole : 'none')
    .replace(/expression\s*\(/gi, '(')
    .replace(/(-moz-binding|behavior)\s*:[^;}]*/gi, '');
}

const safeHref = (value: string): string | null => {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:' ? url.href : null;
  } catch { return null; }
};
const safeImage = (value: string) => /^data:image\/(png|jpe?g|gif|webp|svg\+xml)[;,]/i.test(value.trim()) ? value.trim() : null;
const fragment = (value: string) => /^#[A-Za-z][\w:.-]*$/.test(value.trim()) ? value.trim() : null;

export interface BoardRender { nodes: number; dropped: number; truncated: boolean }

/**
 * Replaces everything in `root` with the board. `baseCss` styles the board's
 * frame (fonts, tables, theme variables) and comes before the board's own CSS.
 */
export function renderBoard(root: ShadowRoot | HTMLElement, html: string, baseCss = ''): BoardRender {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const doc = root.ownerDocument;
  const stats: BoardRender = { nodes: 0, dropped: 0, truncated: false };
  const css = [baseCss, ...Array.from(parsed.querySelectorAll('style'), (style) => cleanCss(style.textContent ?? ''))].join('\n');

  const copy = (source: Node, into: Node, depth: number): void => {
    for (const child of Array.from(source.childNodes)) {
      if (stats.nodes >= MAX_NODES || depth > MAX_DEPTH) { stats.truncated = true; return; }
      if (child.nodeType === Node.TEXT_NODE) { into.appendChild(doc.createTextNode(child.textContent ?? '')); continue; }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const element = child as Element;
      const name = element.localName.toLowerCase();
      const svg = element.namespaceURI === SVG_NS;
      if (DROP.has(name)) { stats.dropped++; continue; }
      const allowed = svg ? SVG_TAGS.has(name) : HTML_TAGS.has(name);
      if (!allowed) { stats.dropped++; copy(element, into, depth + 1); continue; }
      const target = svg ? doc.createElementNS(SVG_NS, element.localName) : doc.createElement(name);
      stats.nodes++;
      for (const attr of Array.from(element.attributes)) {
        const key = attr.name.toLowerCase();
        if (key === 'style') { (target as HTMLElement | SVGElement).style.cssText = cleanCss(attr.value); continue; }
        if (key === 'href' || key === 'xlink:href') {
          const href = name === 'a' && !svg ? safeHref(attr.value) : svg ? fragment(attr.value) : null;
          if (href) target.setAttribute('href', href);
          continue;
        }
        if (key === 'src') { const src = name === 'img' ? safeImage(attr.value) : null; if (src) target.setAttribute('src', src); continue; }
        if (key.startsWith('aria-') || key.startsWith('data-') || (svg ? SVG_ATTRS : HTML_ATTRS).has(key)) {
          // A presentation attribute may still point somewhere: url() keeps only #fragments here too.
          const value = /url\(/i.test(attr.value) ? attr.value.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (whole, _q: string, ref: string) => fragment(ref) ? whole : 'none') : attr.value;
          target.setAttribute(attr.name, value);
        }
      }
      if (name === 'a' && !svg) {
        if (target.hasAttribute('href')) { target.setAttribute('target', '_blank'); target.setAttribute('rel', 'noopener noreferrer'); }
      }
      copy(element, target, depth + 1);
      into.appendChild(target);
    }
  };
  const fragmentRoot = doc.createDocumentFragment();
  copy(parsed.body, fragmentRoot, 0);
  root.replaceChildren(fragmentRoot);
  applyCss(root, css);
  return stats;
}

/** Constructed sheets are CSSOM, not inline markup, so no page policy blocks them; a host without them gets a style element. */
function applyCss(root: ShadowRoot | HTMLElement, css: string): void {
  if ('adoptedStyleSheets' in root && typeof CSSStyleSheet === 'function' && typeof CSSStyleSheet.prototype.replaceSync === 'function') {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      (root as ShadowRoot).adoptedStyleSheets = [sheet];
      return;
    } catch { /* fall back to a style element */ }
  }
  const style = root.ownerDocument.createElement('style');
  style.textContent = css;
  root.prepend(style);
}
