/**
 * How many real pixels a PDF page is painted with.
 *
 * The pipeline was never an image-distribution path — PDF.js parses the bytes
 * and paints vectors on a canvas — but the canvas was sized at `min(dpr, 2)`
 * device pixels per CSS pixel, and a canvas is the one surface a browser
 * cannot resample for free. Two things followed. A phone with `dpr = 3` threw
 * away a third of its resolution before the first stroke. And a desktop with
 * `dpr = 1` painted an A4 page at ~115 DPI, which survives a screenshot and
 * falls apart the moment anyone pinches or zooms into a footnote.
 *
 * So the page is OVERSAMPLED: at least `MIN_DEVICE_PIXELS_PER_CSS_PIXEL`
 * device pixels per CSS pixel, more when the screen really has more, and the
 * browser downsamples — which it does well, unlike upsampling. The ceiling is
 * a per-page pixel budget rather than a scale, because the memory that matters
 * is `width × height × 4` bytes and a scale cap says nothing about it.
 */

/** Never paint below this ratio, even on a `dpr = 1` display. */
export const MIN_DEVICE_PIXELS_PER_CSS_PIXEL = 2;

/** Above this, extra samples cost memory and buy nothing anyone can see. */
export const MAX_DEVICE_PIXELS_PER_CSS_PIXEL = 3;

/**
 * Per-page canvas budget, in device pixels (8 Mpx ≈ 32 MiB of bitmap). An A4
 * page at the 960 CSS px display cap uses ~5.2 Mpx at 2×, so the budget only
 * binds on unusually large page boxes — where it degrades sharpness instead of
 * asking the browser for a canvas it may refuse to allocate.
 */
export const MAX_PAGE_CANVAS_PIXELS = 8_388_608;

/** Fit-to-width is the floor; 200% keeps a normal A4 page inside the bitmap budget. */
export const MIN_PDF_ZOOM = 1;
export const MAX_PDF_ZOOM = 2;

/** Translate a Ctrl/Command + wheel gesture into the next local PDF zoom. */
export function pdfZoomFromWheel(currentZoom: number, deltaY: number, deltaMode: number): number {
  const boundedCurrent = Math.min(MAX_PDF_ZOOM, Math.max(MIN_PDF_ZOOM, currentZoom));
  if (!Number.isFinite(deltaY) || deltaY === 0) return boundedCurrent;
  const deltaUnit = deltaMode === 1 ? 16 : deltaMode === 2 ? 800 : 1;
  const next = boundedCurrent * Math.exp(-deltaY * deltaUnit * 0.002);
  return Math.min(MAX_PDF_ZOOM, Math.max(MIN_PDF_ZOOM, next));
}

/** Apply a two-finger distance ratio to the local PDF zoom. */
export function pdfZoomFromPinch(startZoom: number, distanceRatio: number): number {
  const boundedStart = Math.min(MAX_PDF_ZOOM, Math.max(MIN_PDF_ZOOM, startZoom));
  if (!Number.isFinite(distanceRatio) || !(distanceRatio > 0)) return boundedStart;
  return Math.min(MAX_PDF_ZOOM, Math.max(MIN_PDF_ZOOM, boundedStart * distanceRatio));
}

export interface PdfPageScaleInput {
  /** Laid-out width of the page box, in CSS pixels. */
  cssWidth: number;
  /** The page's own width at scale 1 (PDF user units). */
  naturalWidth: number;
  /** The page's own height at scale 1 (PDF user units). */
  naturalHeight: number;
  /** `window.devicePixelRatio`; non-finite or absent values read as 1. */
  devicePixelRatio: number;
}

export interface PdfPageScales {
  /** Viewport scale for the laid-out (CSS) geometry: text layer, hit testing. */
  cssScale: number;
  /** Viewport scale for the canvas bitmap; always ≥ `cssScale`. */
  deviceScale: number;
}

/** The CSS and bitmap viewport scales for one page. */
export function pdfPageScales(input: PdfPageScaleInput): PdfPageScales {
  const cssScale = input.naturalWidth > 0 ? input.cssWidth / input.naturalWidth : 0;
  if (!(cssScale > 0)) return { cssScale: 0, deviceScale: 0 };
  const screen = Number.isFinite(input.devicePixelRatio) && input.devicePixelRatio > 0
    ? input.devicePixelRatio
    : 1;
  const wanted = Math.min(
    Math.max(screen, MIN_DEVICE_PIXELS_PER_CSS_PIXEL),
    MAX_DEVICE_PIXELS_PER_CSS_PIXEL,
  );
  const cssPixels = cssScale * input.naturalWidth * cssScale * input.naturalHeight;
  // A page box larger than the budget still paints — at 1:1 if it has to.
  // Refusing to draw would be a worse answer than a soft one.
  const affordable = cssPixels > 0 ? Math.sqrt(MAX_PAGE_CANVAS_PIXELS / cssPixels) : wanted;
  const oversample = Math.max(1, Math.min(wanted, affordable));
  return { cssScale, deviceScale: cssScale * oversample };
}
