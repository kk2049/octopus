import type { PDFPageProxy, RenderTask } from "pdfjs-dist";
import { pdfPageScales } from "./pdf-scale.js";

type PdfPageForPaint = Pick<PDFPageProxy, "getViewport" | "render">;

export interface PdfCanvasPaint {
  cssViewport: ReturnType<PDFPageProxy["getViewport"]>;
  render: RenderTask;
}

/**
 * PDF.js may reject asynchronously, but malformed or unsupported page data can
 * also throw while deriving a viewport or starting a canvas render. Keep those
 * document-local failures out of React's effect boundary so one bad page does
 * not replace the whole Agent View with its crash fallback.
 */
export function pdfPageAspectRatio(page: Pick<PDFPageProxy, "getViewport">): number | null {
  try {
    const viewport = page.getViewport({ scale: 1 });
    const ratio = viewport.width / viewport.height;
    return Number.isFinite(ratio) && ratio > 0 ? ratio : null;
  } catch {
    return null;
  }
}

export function beginPdfCanvasPaint(
  page: PdfPageForPaint,
  canvas: HTMLCanvasElement,
  cssWidth: number,
  devicePixelRatio: number,
): PdfCanvasPaint | null {
  try {
    const natural = page.getViewport({ scale: 1 });
    const { cssScale, deviceScale } = pdfPageScales({
      cssWidth,
      naturalWidth: natural.width,
      naturalHeight: natural.height,
      devicePixelRatio,
    });
    if (!(cssScale > 0) || !(deviceScale > 0)) return null;
    const viewport = page.getViewport({ scale: deviceScale });
    const cssViewport = page.getViewport({ scale: cssScale });
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return null;
    // Fractional CSS layout widths are normal (grid tracks, browser zoom and
    // percentage insets can all produce them). Round the bitmap outward so
    // integer canvas dimensions never slip below the scale contract by a
    // fraction of a device pixel.
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const render = page.render({ canvas, canvasContext: context, viewport });
    return { cssViewport, render };
  } catch {
    // A partially-sized canvas can retain tens of MiB even when PDF.js refused
    // to start. Releasing it is best-effort because a hostile DOM shim may also
    // reject the size reset.
    try {
      canvas.width = 0;
      canvas.height = 0;
    } catch {
      // The page-level refusal remains the useful outcome.
    }
    return null;
  }
}

/** Coalesce panel dragging; keep the last bitmap available until layout settles. */
export function observePdfPageWidth(node: HTMLElement, onWidth: (width: number) => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  onWidth(node.getBoundingClientRect().width);
  const observer = new ResizeObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => onWidth(node.getBoundingClientRect().width), 120);
  });
  observer.observe(node);
  return () => { clearTimeout(timer); observer.disconnect(); };
}
