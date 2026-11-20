/// <reference lib="dom" />
import { Buffer } from "node:buffer";
import { expect } from "vitest";
import type { ConsoleMessage, Locator, Page, Worker } from "playwright";

/** Same uncompressed Helvetica/page objects as sample.pdf, with real byte offsets. */
export function createLightweightPdf(pageCount = 20): Buffer {
  if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 100) {
    throw new RangeError("PDF page count must be an integer from 1 to 100");
  }
  const pageRefs = Array.from({ length: pageCount }, (_, index) => (4 + index * 2) + " 0 R");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [" + pageRefs.join(" ") + "] /Count " + pageCount + " >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (let page = 1; page <= pageCount; page++) {
    const contentId = 5 + (page - 1) * 2;
    const content = "BT /F1 20 Tf 30 448 Td (Stress PDF page " + page + " of " + pageCount
      + ") Tj /F1 10 Tf 0 -30 Td (Lightweight document for concurrent workspace rendering.) Tj ET\n";
    objects.push(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 500] /Resources << /Font << /F1 3 0 R >> >> /Contents " + contentId + " 0 R >>",
      "<< /Length " + Buffer.byteLength(content, "ascii") + " >>\nstream\n" + content + "endstream",
    );
  }
  const chunks = [Buffer.from("%PDF-1.4\n", "ascii")];
  const offsets = [0];
  let length = chunks[0]!.byteLength;
  for (let index = 0; index < objects.length; index++) {
    offsets.push(length);
    const chunk = Buffer.from((index + 1) + " 0 obj\n" + objects[index] + "\nendobj\n", "ascii");
    chunks.push(chunk); length += chunk.byteLength;
  }
  const xref = "xref\n0 " + (objects.length + 1) + "\n0000000000 65535 f \n"
    + offsets.slice(1).map((offset) => String(offset).padStart(10, "0") + " 00000 n \n").join("")
    + "trailer\n<< /Size " + (objects.length + 1) + " /Root 1 0 R >>\nstartxref\n" + length + "\n%%EOF\n";
  chunks.push(Buffer.from(xref, "ascii"));
  return Buffer.concat(chunks);
}

export function observePdfWorkers(page: Page) {
  const workers: Worker[] = [];
  const closed = new Set<Worker>();
  const warnings: string[] = [];
  const onWorker = (worker: Worker) => {
    if (!/pdf-worker/.test(worker.url())) return;
    workers.push(worker);
    worker.on("close", () => closed.add(worker));
  };
  const onConsole = (message: ConsoleMessage) => {
    if (/fake worker/i.test(message.text())) warnings.push(message.text());
  };
  page.on("worker", onWorker);
  page.on("console", onConsole);
  return {
    created: () => workers.length,
    closed: () => closed.size,
    warnings: () => [...warnings],
    dispose: () => { page.off("worker", onWorker); page.off("console", onConsole); },
  };
}

/** These fit-width fixtures are below the pixel budget. A painted page can
 * still be showing the previous width's bitmap during the resize debounce. */
export async function waitForSettledPdfCanvas(canvas: Locator, timeout = 15_000): Promise<void> {
  await expect.poll(() => canvas.evaluate((node) => {
    const bitmap = node as HTMLCanvasElement;
    const density = Math.min(3, Math.max(2, devicePixelRatio));
    return node.closest<HTMLElement>("[data-av-pdf-page]")?.dataset.painted === "1"
      && bitmap.width > 0
      && Math.abs(bitmap.width - bitmap.getBoundingClientRect().width * density) <= 2;
  }), { timeout }).toBe(true);
}

export interface PdfResizeEvidence {
  beforeWidth: number;
  afterWidth: number;
  bitmapBefore: number;
  bitmapAfter: number;
  bitmapPixels: number;
  samples: number;
  maxFrameGapMs: number;
}

/** Existing fixture owns the PDF bytes, trust, open and close actions. */
export async function exercisePdfPanelResize(
  page: Page, pdf: Locator, sashes: Locator, delta = -90,
): Promise<PdfResizeEvidence> {
  const firstPage = pdf.locator("[data-av-pdf-page]").first();
  const canvas = firstPage.locator("canvas[data-av-pdf-canvas]");
  await expect.poll(() => firstPage.getAttribute("data-painted"), { timeout: 20_000 }).toBe("1");
  const before = await canvas.evaluate((node) => ({
    width: node.getBoundingClientRect().width,
    bitmap: (node as HTMLCanvasElement).width,
  }));
  const viewer = pdf.locator("xpath=ancestor::*[@data-av-module='workspace.file-viewer/v1'][1]");
  const box = await viewer.boundingBox();
  if (!box) throw new Error("PDF viewer is not visible");
  let selected: { x: number; y: number; distance: number } | undefined;
  for (let index = 0; index < await sashes.count(); index++) {
    const candidate = sashes.nth(index);
    if (!(await candidate.getAttribute("class"))?.includes("dv-enabled")) continue;
    const rect = await candidate.boundingBox();
    if (!rect || rect.height < 30 || rect.width > 20) continue;
    const x = rect.x + rect.width / 2;
    const distance = Math.abs(x - box.x);
    if (!selected || distance < selected.distance) selected = { x, y: rect.y + rect.height / 2, distance };
  }
  if (!selected || selected.distance > 24) throw new Error("PDF split sash was not found at its left edge");
  const sampling = await canvas.evaluateHandle((node) => {
    const canvas = node as HTMLCanvasElement;
    const samples: Array<{ at: number; width: number; bitmap: number }> = [];
    let frame = 0;
    const tick = () => {
      samples.push({ at: performance.now(), width: canvas.getBoundingClientRect().width, bitmap: canvas.width });
      if (samples.length < 600) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return { stop: () => { cancelAnimationFrame(frame); return samples; } };
  });
  let samples: Array<{ at: number; width: number; bitmap: number }>;
  try {
    await page.mouse.move(selected.x, selected.y);
    await page.mouse.down();
    // Cross the >10px observation threshold in the first delivered move. On a
    // busy browser, a Playwright round trip can outlast the 120ms debounce:
    // smaller initial moves let a valid repaint replace `before.bitmap`
    // before the gesture has moved far enough for the continuity assertion.
    const firstMove = delta / 4;
    for (let step = 0; step < 16; step++) {
      await page.mouse.move(selected.x + firstMove + (delta - firstMove) * step / 15, selected.y);
      // Keep the same total distance, 16 inputs and deliberate pacing. The
      // first frame already proves bitmap continuity if a later input stalls.
      await page.waitForTimeout(20);
    }
  } finally {
    await page.mouse.up();
    samples = await sampling.evaluate((probe) => probe.stop());
    await sampling.dispose();
  }
  expect(samples.length).toBeGreaterThan(4);
  expect(samples.every((sample) => sample.bitmap > 0)).toBe(true);
  expect(
    samples.some((sample) => Math.abs(sample.width - before.width) > 10 && sample.bitmap === before.bitmap),
    JSON.stringify({ delta, before, samples }),
  ).toBe(true);
  // A settled repaint is measured separately from CSS movement during drag.
  await expect.poll(() => canvas.evaluate((node) => (node as HTMLCanvasElement).width), { timeout: 10_000 }).not.toBe(before.bitmap);
  await expect.poll(() => firstPage.getAttribute("data-painted"), { timeout: 10_000 }).toBe("1");
  const after = await canvas.evaluate((node) => {
    const canvas = node as HTMLCanvasElement;
    return { width: canvas.getBoundingClientRect().width, bitmap: canvas.width, pixels: canvas.width * canvas.height };
  });
  expect(Math.abs(after.width - before.width)).toBeGreaterThan(10);
  expect(after.bitmap / after.width).toBeGreaterThanOrEqual(1);
  const maxFrameGapMs = Math.max(0, ...samples.slice(1).map((sample, index) => sample.at - samples[index]!.at));
  expect(maxFrameGapMs).toBeLessThan(500);
  return {
    beforeWidth: before.width, afterWidth: after.width, bitmapBefore: before.bitmap,
    bitmapAfter: after.bitmap, bitmapPixels: after.pixels, samples: samples.length, maxFrameGapMs,
  };
}

/** Run before annotation selection so zoom/scroll assertions remain independent. */
export async function exercisePdfZoomThenResize(page: Page, pdf: Locator, sashes: Locator) {
  expect(await pdf.locator("[data-av-pdf-page]").count()).toBeGreaterThanOrEqual(2);
  const first = pdf.locator("[data-av-pdf-page]").first();
  const before = await exercisePdfPanelResize(page, pdf, sashes);
  const firstCanvas = first.locator("canvas[data-av-pdf-canvas]");
  const preZoomBitmap = await firstCanvas.evaluate((node) => (node as HTMLCanvasElement).width);
  await first.evaluate((node) => {
    const box = node.getBoundingClientRect();
    node.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true, cancelable: true, ctrlKey: true, deltaY: -180,
      clientX: box.left + box.width / 2, clientY: box.top + Math.min(80, box.height / 2),
    }));
  });
  await expect.poll(async () => Number(await pdf.getAttribute("data-zoom"))).toBeGreaterThan(1);
  await expect.poll(() => firstCanvas.evaluate((node) => (node as HTMLCanvasElement).width), { timeout: 10_000 }).not.toBe(preZoomBitmap);
  await expect.poll(() => first.getAttribute("data-painted"), { timeout: 10_000 }).toBe("1");
  const afterZoom = await exercisePdfPanelResize(page, pdf, sashes, 90);
  // Restore fit width for the caller's text selection/mobile assertions.
  await first.evaluate((node) => {
    const box = node.getBoundingClientRect();
    node.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true, cancelable: true, ctrlKey: true, deltaY: 10_000,
      clientX: box.left + 20, clientY: box.top + 20,
    }));
  });
  await expect.poll(() => pdf.getAttribute("data-zoom")).toBe("1.000");
  const second = pdf.locator("[data-av-pdf-page]").nth(1);
  await second.scrollIntoViewIfNeeded();
  await expect.poll(() => second.getAttribute("data-painted"), { timeout: 20_000 }).toBe("1");
  await first.scrollIntoViewIfNeeded();
  // Zoom state changes before the settled Worker render. A following gesture
  // must compare against the fit-width bitmap, not the previous zoom's bitmap.
  await waitForSettledPdfCanvas(firstCanvas, 10_000);
  return { before, afterZoom };
}
