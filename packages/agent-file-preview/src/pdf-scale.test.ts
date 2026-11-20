import { describe, expect, it } from "vitest";
import {
  MAX_DEVICE_PIXELS_PER_CSS_PIXEL,
  MAX_PAGE_CANVAS_PIXELS,
  MAX_PDF_ZOOM,
  MIN_DEVICE_PIXELS_PER_CSS_PIXEL,
  MIN_PDF_ZOOM,
  pdfPageScales,
  pdfZoomFromPinch,
  pdfZoomFromWheel,
} from "./pdf-scale.js";

/** A4 at PDF user units, the shape almost every real document arrives in. */
const A4 = { naturalWidth: 595, naturalHeight: 842 };

describe("pdfPageScales", () => {
  it("oversamples a 1:1 display instead of painting an A4 page at ~115 DPI", () => {
    const { cssScale, deviceScale } = pdfPageScales({ ...A4, cssWidth: 960, devicePixelRatio: 1 });
    expect(cssScale).toBeCloseTo(960 / 595, 6);
    expect(deviceScale / cssScale).toBe(MIN_DEVICE_PIXELS_PER_CSS_PIXEL);
  });

  it("keeps every device pixel a dense phone screen actually has", () => {
    const phone = pdfPageScales({ ...A4, cssWidth: 360, devicePixelRatio: 3 });
    expect(phone.deviceScale / phone.cssScale).toBe(3);
    // The old renderer capped at 2, throwing away a third of the resolution.
    expect(phone.deviceScale).toBeGreaterThan(phone.cssScale * 2);
  });

  it("stops climbing past the point anyone can see", () => {
    const absurd = pdfPageScales({ ...A4, cssWidth: 360, devicePixelRatio: 8 });
    expect(absurd.deviceScale / absurd.cssScale).toBe(MAX_DEVICE_PIXELS_PER_CSS_PIXEL);
  });

  it("degrades sharpness rather than asking for a canvas the browser may refuse", () => {
    const huge = pdfPageScales({
      naturalWidth: 2400,
      naturalHeight: 3400,
      cssWidth: 2400,
      devicePixelRatio: 3,
    });
    const pixels = huge.deviceScale * 2400 * huge.deviceScale * 3400;
    expect(pixels).toBeLessThanOrEqual(MAX_PAGE_CANVAS_PIXELS + 1);
    // Still at least 1:1 — a soft page beats a blank one.
    expect(huge.deviceScale).toBeGreaterThanOrEqual(huge.cssScale);
  });

  it("never asks for a bitmap smaller than the box it fills", () => {
    for (const devicePixelRatio of [0, 1, 1.5, 2, 3, Number.NaN]) {
      const scales = pdfPageScales({ ...A4, cssWidth: 720, devicePixelRatio });
      expect(scales.deviceScale).toBeGreaterThanOrEqual(scales.cssScale);
    }
  });

  it("reports zero for a page box that has not been laid out yet", () => {
    expect(pdfPageScales({ ...A4, cssWidth: 0, devicePixelRatio: 2 })).toEqual({ cssScale: 0, deviceScale: 0 });
    expect(pdfPageScales({ naturalWidth: 0, naturalHeight: 0, cssWidth: 400, devicePixelRatio: 2 }))
      .toEqual({ cssScale: 0, deviceScale: 0 });
  });
});

describe("pdfZoomFromWheel", () => {
  it("zooms toward the pointer direction while fit-to-width remains the floor", () => {
    expect(pdfZoomFromWheel(MIN_PDF_ZOOM, -100, 0)).toBeGreaterThan(MIN_PDF_ZOOM);
    expect(pdfZoomFromWheel(MIN_PDF_ZOOM, 100, 0)).toBe(MIN_PDF_ZOOM);
  });

  it("caps local zoom at 200% and normalizes line-mode wheels", () => {
    expect(pdfZoomFromWheel(MAX_PDF_ZOOM, -100, 0)).toBe(MAX_PDF_ZOOM);
    expect(pdfZoomFromWheel(1, -3, 1)).toBeCloseTo(pdfZoomFromWheel(1, -48, 0), 8);
  });
});

describe("pdfZoomFromPinch", () => {
  it("tracks two-finger distance without escaping the local zoom bounds", () => {
    expect(pdfZoomFromPinch(1, 1.5)).toBe(1.5);
    expect(pdfZoomFromPinch(1.5, 0.5)).toBe(MIN_PDF_ZOOM);
    expect(pdfZoomFromPinch(1.5, 2)).toBe(MAX_PDF_ZOOM);
  });
});
