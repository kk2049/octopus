import { researchRole } from "./organization.js";
import type { ResearchNode } from "./model.js";

export type CanvasSize = { width: number; height: number };
export const nodeMetadata = (node: ResearchNode): Record<string, unknown> => {
  const value = node.data.meta;
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
};
/** Shared bounds are validated by the server and used by gesture previews. */
export const CANVAS_SIZE_LIMITS = { minWidth: 240, minHeight: 144, maxWidth: 1600, maxHeight: 2000 } as const;
export function boundedCanvasSize(size: CanvasSize): CanvasSize {
  return {
    width: Math.max(CANVAS_SIZE_LIMITS.minWidth, Math.min(CANVAS_SIZE_LIMITS.maxWidth, size.width)),
    height: Math.max(CANVAS_SIZE_LIMITS.minHeight, Math.min(CANVAS_SIZE_LIMITS.maxHeight, size.height)),
  };
}
function defaultCardSize(node: ResearchNode): CanvasSize {
  const meta = nodeMetadata(node), role = researchRole(node);
  if (role === "goal") return { width: 520, height: 300 };
  if (role === "target") return { width: 380, height: 232 };
  if (role === "motivation") return { width: 300, height: 188 };
  if (typeof meta.reportId === "string" && meta.reportId) return { width: 460, height: 440 };
  if (meta.previewKind === "image") return { width: 520, height: 420 };
  if (node.type === "adapter") return { width: 480, height: 420 };
  if (meta.previewKind === "markdown" || typeof meta.excerpt === "string") return { width: 380, height: 420 };
  if (node.type === "folder") return { width: 340, height: 264 };
  if ((node.summary?.length ?? 0) > 150) return { width: 360, height: 248 };
  return { width: 300, height: 212 };
}
/** One preview geometry for every canvas. The legacy layout argument is accepted
 * for callers of older structural tools; layout commands never change sizes. */
export function canvasCardSize(node: ResearchNode, _layout: "canvas" | "hierarchy" | "tree" = "canvas", geometry?: Partial<CanvasSize>): CanvasSize {
  const fallback = defaultCardSize(node);
  return boundedCanvasSize({
    width: Number.isFinite(geometry?.width) ? geometry!.width! : fallback.width,
    height: Number.isFinite(geometry?.height) ? geometry!.height! : fallback.height,
  });
}
/** Excerpts are explicitly authored metadata, not silently generated summaries. */
export function excerptSource(node: ResearchNode) {
  const meta = nodeMetadata(node);
  return {
    text: typeof meta.excerpt === "string" ? meta.excerpt.slice(0, 2400) : "",
    kind: meta.excerptKind === "verbatim" ? "原文摘录" : meta.excerptKind === "human" ? "人工摘要" : "Agent 摘要",
    source: typeof meta.sourceNode === "string" ? meta.sourceNode : "",
    revision: typeof meta.sourceRevision === "string" ? meta.sourceRevision : typeof meta.sha256 === "string" ? meta.sha256 : "",
    at: typeof meta.sourceAt === "string" ? meta.sourceAt : "",
    limitation: typeof meta.limitation === "string" ? meta.limitation : "",
  };
}
