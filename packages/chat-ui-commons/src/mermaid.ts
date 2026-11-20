import { parseMermaid, renderMermaidSVG } from "beautiful-mermaid";

// Layout runs locally and synchronously on the page's main thread. A Worker
// is not available to every host: a legacy App frame is an opaque origin under
// a hash-only script policy, so it cannot start one. These bounds keep the
// AUTOMATIC render from freezing the page; a reader who explicitly asks for
// one diagram (`force`) accepts that diagram's layout cost and gets it whole.
export const MERMAID_MAX_LENGTH = 16_000;
const MAX_LINES = 400;
const MAX_NODES = 200;
const MAX_EDGES = 400;
const MAX_SVG_LENGTH = 1_000_000;

export type MermaidResult = { src: string } | { error: "invalid" | "too_large" };

export interface MermaidRenderOptions {
  /** The reader chose to render this diagram despite the automatic bounds. */
  force?: boolean;
}

/** Produce an inert image, never markup to insert into the host document. */
export function renderMermaidImage(source: string, options: MermaidRenderOptions = {}): MermaidResult {
  const bounded = !options.force;
  if (bounded && (source.length > MERMAID_MAX_LENGTH || source.split("\n").length > MAX_LINES)) {
    return { error: "too_large" };
  }
  try {
    // The request is for flowcharts. The public parser also understands state
    // diagrams; other diagram families remain visible as source, without guesses.
    const graph = parseMermaid(source);
    if (bounded && (graph.nodes.size > MAX_NODES || graph.edges.length > MAX_EDGES)) {
      return { error: "too_large" };
    }
    if (graph.nodes.size === 0) return { error: "invalid" };
    const svg = renderMermaidSVG(source, { font: "sans-serif", bg: "#ffffff", fg: "#202124" })
      // The library emits optional font imports. System fonts are sufficient;
      // keep the image self-contained even outside a network-blocking SVG viewer.
      .replace(/@import\s+url\([^)]*\);/g, "");
    if (bounded && svg.length > MAX_SVG_LENGTH) return { error: "too_large" };
    return { src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` };
  } catch {
    // Parser errors can contain the complete prompt; never echo their HTML or
    // stack into the UI. The exact source remains available beside the receipt.
    return { error: "invalid" };
  }
}
