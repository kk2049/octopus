import type { PDFPageProxy, RenderTask } from "pdfjs-dist";
import { describe, expect, it, vi } from "vitest";
import { beginPdfCanvasPaint, observePdfPageWidth, pdfPageAspectRatio } from "./pdf-render.js";

function viewport(width: number, height: number, scale = 1) {
  return { width: width * scale, height: height * scale, scale } as ReturnType<PDFPageProxy["getViewport"]>;
}

function canvas(render: () => RenderTask) {
  const value = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => ({})),
  } as unknown as HTMLCanvasElement;
  const page = {
    getViewport: vi.fn(({ scale }: { scale: number }) => viewport(600, 800, scale)),
    render: vi.fn(render),
  } as unknown as Pick<PDFPageProxy, "getViewport" | "render">;
  return { value, page };
}

describe("PDF page failure containment", () => {
  it("turns a synchronous viewport failure into a page refusal", () => {
    const page = { getViewport: vi.fn(() => { throw new Error("broken page box"); }) } as unknown as Pick<PDFPageProxy, "getViewport">;
    expect(pdfPageAspectRatio(page)).toBeNull();
  });

  it("turns a synchronous PDF.js render failure into a released page refusal", () => {
    const { value, page } = canvas(() => { throw new Error("Cannot use the same canvas"); });
    expect(beginPdfCanvasPaint(page, value, 600, 2)).toBeNull();
    expect(value.width).toBe(0);
    expect(value.height).toBe(0);
  });

  it("returns the started render and CSS viewport for a valid page", () => {
    const render = { promise: Promise.resolve(), cancel: vi.fn() } as unknown as RenderTask;
    const { value, page } = canvas(() => render);
    const started = beginPdfCanvasPaint(page, value, 600, 2);
    expect(started?.render).toBe(render);
    expect(started?.cssViewport.width).toBe(600);
    expect(value.width).toBeGreaterThan(600);
    expect(value.height).toBeGreaterThan(800);
  });

  it("rounds fractional layouts outward to preserve the bitmap density floor", () => {
    const render = { promise: Promise.resolve(), cancel: vi.fn() } as unknown as RenderTask;
    const { value, page } = canvas(() => render);
    const cssWidth = 600.25;
    expect(beginPdfCanvasPaint(page, value, cssWidth, 1)?.render).toBe(render);
    expect(value.width / cssWidth).toBeGreaterThanOrEqual(2);
  });
});

describe("PDF container resize", () => {
  it("uses the settled fractional width and cancels pending work when released", () => {
    vi.useFakeTimers();
    let width = 600.25;
    let notify!: () => void;
    const disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { notify = callback; }
      observe = vi.fn();
      disconnect = disconnect;
    });
    const node = { getBoundingClientRect: () => ({ width }) } as HTMLElement;
    const changed = vi.fn();
    try {
      const close = observePdfPageWidth(node, changed);
      expect(changed).toHaveBeenLastCalledWith(600.25);
      for (let index = 0; index < 12; index++) {
        width += 1.5;
        notify();
        vi.advanceTimersByTime(20);
      }
      expect(changed).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(120);
      expect(changed).toHaveBeenCalledTimes(2);
      expect(changed).toHaveBeenLastCalledWith(width);
      notify();
      close();
      vi.advanceTimersByTime(200);
      expect(changed).toHaveBeenCalledTimes(2);
      expect(disconnect).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
  });
});
