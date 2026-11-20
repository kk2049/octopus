/// <reference lib="dom" />
import { expect } from "vitest";
import type { Locator, Page } from "playwright";
import { waitForSettledPdfCanvas, type observePdfWorkers } from "./pdf-browser-scenarios.js";

export interface FourLiveWindowScenario {
  page: Page;
  composer: Locator;
  /** Four independently opened resource transcripts; background mounts count. */
  transcripts: readonly Locator[];
  /** Update four actual source rows and signal their existing subscriptions. */
  publish(step: number): Promise<void>;
  expected(resourceIndex: number, step: number): string;
}

export interface LiveWindowPerformanceEvidence {
  resources: number;
  rounds: number;
  convergenceMs: number[];
  inputToFrameMs: number[];
  maxFrameGapMs: number;
  frameGapsMs: number[];
  longTasksMs: number[];
  longTasksSupported: boolean;
  droppedLongTasks: number;
  droppedFrameSamples: number;
  heapBefore?: number;
  heapAfter?: number;
  workloadBefore: TranscriptWorkload[];
  workloadAfter: TranscriptWorkload[];
}

/** The fixture owns resources and Gate. This only drives real input and observes. */
export async function exerciseFourLiveWindows(options: FourLiveWindowScenario): Promise<LiveWindowPerformanceEvidence> {
  const { page, composer, transcripts, publish, expected } = options;
  expect(transcripts).toHaveLength(4);
  const workloadBefore = await Promise.all(transcripts.map(readTranscriptWorkload));
  const originalDraft = await composer.inputValue();
  await composer.focus();
  await composer.press("ControlOrMeta+End");
  const sampling = await composer.evaluateHandle((node) => {
    const inputToFrameMs: number[] = [];
    const frameGaps: number[] = [];
    const longTasksMs: number[] = [];
    let droppedLongTasks = 0; let droppedFrameSamples = 0;
    const recordLongTasks = (entries: PerformanceEntry[]) => {
      for (const entry of entries) {
        if (longTasksMs.length < 100) longTasksMs.push(entry.duration); else droppedLongTasks++;
      }
    };
    const heap = () => (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
    const heapBefore = heap();
    let prior = performance.now();
    let frame = 0;
    const tick = () => {
      const at = performance.now();
      if (frameGaps.length < 6_000) frameGaps.push(at - prior); else droppedFrameSamples++;
      prior = at; frame = requestAnimationFrame(tick);
    };
    const onInput = () => {
      const started = performance.now();
      requestAnimationFrame(() => inputToFrameMs.push(performance.now() - started));
    };
    const longTasksSupported = typeof PerformanceObserver !== "undefined"
      && PerformanceObserver.supportedEntryTypes.includes("longtask");
    const observer = longTasksSupported ? new PerformanceObserver((list) => recordLongTasks(list.getEntries())) : undefined;
    observer?.observe({ entryTypes: ["longtask"] });
    node.addEventListener("input", onInput);
    frame = requestAnimationFrame(tick);
    return { stop: () => {
      cancelAnimationFrame(frame);
      recordLongTasks(observer?.takeRecords() ?? []);
      observer?.disconnect();
      node.removeEventListener("input", onInput);
      return { inputToFrameMs, maxFrameGapMs: Math.max(0, ...frameGaps), frameGapsMs: frameGaps, longTasksMs, longTasksSupported, droppedLongTasks, droppedFrameSamples, heapBefore, heapAfter: heap() };
    } };
  });
  const fragments = ["four-", "live-", "typing-", "intact"];
  const convergenceMs: number[] = [];
  let evidence: {
    inputToFrameMs: number[]; maxFrameGapMs: number; frameGapsMs: number[]; longTasksMs: number[];
    longTasksSupported: boolean; droppedLongTasks: number; droppedFrameSamples: number;
    heapBefore?: number; heapAfter?: number;
  };
  try {
    for (let step = 0; step < fragments.length; step++) {
      const started = Date.now();
      await Promise.all([publish(step), composer.pressSequentially(fragments[step]!, { delay: 12 })]);
      await Promise.all(transcripts.map((transcript, index) =>
        expect.poll(() => transcript.textContent(), { timeout: 8_000 }).toContain(expected(index, step))));
      convergenceMs.push(Date.now() - started);
    }
    // Flush the final input-to-paint sample without introducing read polling.
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(await composer.inputValue()).toBe(originalDraft + fragments.join(""));
    expect(await composer.evaluate((node) => document.activeElement === node)).toBe(true);
  } finally {
    evidence = await sampling.evaluate((probe) => probe.stop());
    await sampling.dispose();
  }
  expect(evidence.inputToFrameMs.length).toBeGreaterThanOrEqual(fragments.length);
  expect(Math.max(...evidence.inputToFrameMs)).toBeLessThan(500);
  expect(evidence.maxFrameGapMs).toBeLessThan(1_000);
  const workloadAfter = await Promise.all(transcripts.map(readTranscriptWorkload));
  return { resources: transcripts.length, rounds: fragments.length, convergenceMs, ...evidence, workloadBefore, workloadAfter };
}


export interface TranscriptWorkload {
  totalMessages: number;
  loadedMessages: number;
  firstMessage: number;
  lastMessage: number;
  mountedRows: number;
  descendantElements: number;
  visible: boolean;
  box: { x: number; y: number; width: number; height: number };
}

/** Count the actual window and virtual DOM, rather than inferring load from the fixture. */
export async function readTranscriptWorkload(transcript: Locator): Promise<TranscriptWorkload> {
  return transcript.evaluate((node) => {
    const values = ["offset", "count", "total"].map((key) => node.getAttribute(`data-av-chat-${key}`));
    if (values.some((value) => value === null || !/^\d+$/.test(value))) {
      throw new Error("transcript window metadata unavailable: " + values.join(","));
    }
    const [offset, count, total] = values.map(Number) as [number, number, number];
    const rect = node.getBoundingClientRect();
    const x = Math.max(0, rect.left); const right = Math.min(innerWidth, rect.right);
    const y = Math.max(0, rect.top); const bottom = Math.min(innerHeight, rect.bottom);
    const hit = right > x && bottom > y ? document.elementFromPoint((x + right) / 2, (y + bottom) / 2) : null;
    return {
      totalMessages: total, firstMessage: count ? offset + 1 : 0, lastMessage: offset + count,
      loadedMessages: count, mountedRows: node.querySelectorAll("[data-av-virtual-row]").length,
      descendantElements: node.querySelectorAll("*").length,
      visible: rect.width > 0 && rect.height > 0 && hit !== null && node.contains(hit),
      box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
  });
}

/**
 * Scroll upward, the way a reader does, until the transcript holds more than
 * `loaded` messages.
 *
 * Jumping to the top is a script write, not reader input. If a React commit
 * runs before Chromium dispatches the resulting scroll event, ChatScroller's
 * layout effect records the new top as already observed, so the event carries
 * no upward movement. A transcript that is still pinned then follows its next
 * content resize back to the tail, and the explicit wheel that follows moves
 * only 600px. Wheel, touch, key and pointer input reach ChatScroller's own
 * handlers before the browser moves, so only a script write meets this race.
 * A person keeps scrolling, so this helper repeats the gesture until the older
 * page lands. After the first wheel the transcript is no longer pinned, so a
 * repeated jump stays at the start. The transcript requests each cursor once
 * and never while a read is in flight, so repeating the gesture cannot ask
 * twice for the same page.
 */
export async function readOlderPage(page: Page, transcript: Locator, loaded: number, timeout = 15_000): Promise<void> {
  await expect.poll(async () => {
    const current = (await readTranscriptWorkload(transcript)).loadedMessages;
    if (current > loaded) return current;
    await transcript.evaluate((node) => { node.scrollTop = 0; });
    await transcript.hover();
    await page.mouse.wheel(0, -600);
    return current;
  }, { timeout, interval: 1_000 }).toBeGreaterThan(loaded);
}

export interface LoadedWorkspaceResizeScenario {
  page: Page;
  /** Four truly visible transcripts, each already paged to at least 600 rows. */
  transcripts: readonly Locator[];
  pdf: Locator;
  sashes: Locator;
  workers: ReturnType<typeof observePdfWorkers>;
  publish(step: number): Promise<void>;
  expected(resourceIndex: number, step: number): string;
}

async function pdfLeftSash(pdf: Locator, sashes: Locator) {
  const viewer = pdf.locator("xpath=ancestor::*[@data-av-module='workspace.file-viewer/v1'][1]");
  const box = await viewer.boundingBox();
  if (!box) throw new Error("PDF viewer is not visible");
  let selected: { x: number; y: number; distance: number } | undefined;
  for (let index = 0; index < await sashes.count(); index++) {
    const candidate = sashes.nth(index);
    if (!(await candidate.getAttribute("class"))?.includes("dv-enabled")) continue;
    const rect = await candidate.boundingBox();
    if (!rect || rect.height < 30 || rect.width > 20) continue;
    // A short row sash must not substitute for the PDF column's divider.
    const top = Math.max(box.y, rect.y); const bottom = Math.min(box.y + box.height, rect.y + rect.height);
    if (bottom - top < Math.min(100, box.height / 2)) continue;
    const x = rect.x + rect.width / 2;
    const distance = Math.abs(x - box.x);
    if (!selected || distance < selected.distance) selected = { x, y: (top + bottom) / 2, distance };
  }
  if (!selected || selected.distance > 24) throw new Error("PDF split sash was not found at its left edge");
  return selected;
}

function assertLoadedAndVisible(workloads: readonly TranscriptWorkload[]): void {
  expect(workloads).toHaveLength(4);
  for (const row of workloads) {
    expect(row.totalMessages).toBeGreaterThanOrEqual(1_200);
    expect(row.loadedMessages).toBeGreaterThanOrEqual(600);
    expect(row.visible).toBe(true);
    expect(row.mountedRows).toBeGreaterThan(0);
  }
  for (let index = 0; index < workloads.length; index++) {
    const a = workloads[index]!.box;
    for (const other of workloads.slice(index + 1)) {
      const b = other.box;
      const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
      const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
      expect(width * height).toBeLessThanOrEqual(1);
    }
  }
}

/**
 * Measures the loaded 4-chat + 20-page-PDF case with real mouse gestures.
 * Times are raw evidence for this machine; only behavioral correctness is gated.
 */
export async function exerciseLoadedWorkspaceResize(options: LoadedWorkspaceResizeScenario) {
  const { page, transcripts, pdf, sashes, workers, publish, expected } = options;
  const before = await Promise.all(transcripts.map(readTranscriptWorkload));
  assertLoadedAndVisible(before);
  const pages = pdf.locator("[data-av-pdf-page]");
  expect(await pages.count()).toBe(20);
  const firstPage = pages.first(); const lastPage = pages.last();
  const firstCanvas = firstPage.locator("canvas[data-av-pdf-canvas]");
  const lastCanvas = lastPage.locator("canvas[data-av-pdf-canvas]");
  await lastPage.scrollIntoViewIfNeeded();
  await expect.poll(() => lastPage.getAttribute("data-painted"), { timeout: 20_000 }).toBe("1");
  await expect.poll(() => lastPage.locator("[data-av-pdf-text-layer]").textContent(), { timeout: 20_000 }).toContain("Stress PDF page 20 of 20");
  await expect.poll(() => firstCanvas.evaluate((node) => (node as HTMLCanvasElement).width), { timeout: 10_000 }).toBe(0);
  await firstPage.scrollIntoViewIfNeeded();
  await expect.poll(() => firstPage.getAttribute("data-painted"), { timeout: 20_000 }).toBe("1");
  await expect.poll(() => lastCanvas.evaluate((node) => (node as HTMLCanvasElement).width), { timeout: 10_000 }).toBe(0);
  const workerBefore = { created: workers.created(), closed: workers.closed() };
  expect(workerBefore.created - workerBefore.closed).toBe(1);
  const pdfSnapshot = () => pdf.evaluate((node) => {
    const canvases = Array.from(node.querySelectorAll<HTMLCanvasElement>("canvas[data-av-pdf-canvas]"));
    return {
      pages: node.querySelectorAll("[data-av-pdf-page]").length,
      paintedPages: node.querySelectorAll('[data-av-pdf-page][data-painted="1"]').length,
      residentCanvases: canvases.filter((canvas) => canvas.width > 0 && canvas.height > 0).length,
      bitmapPixels: canvases.reduce((sum, canvas) => sum + canvas.width * canvas.height, 0),
      descendantElements: node.querySelectorAll("*").length,
    };
  });
  const pdfBefore = await pdfSnapshot();
  const sampling = await page.evaluateHandle(() => {
    const frameGapsMs: number[] = []; const longTasksMs: number[] = [];
    let droppedFrameSamples = 0; let droppedLongTasks = 0;
    const heap = () => (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
    const heapBefore = heap();
    const longTasksSupported = typeof PerformanceObserver !== "undefined"
      && PerformanceObserver.supportedEntryTypes.includes("longtask");
    const observer = longTasksSupported ? new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (longTasksMs.length < 200) longTasksMs.push(entry.duration); else droppedLongTasks++;
      }
    }) : undefined;
    observer?.observe({ entryTypes: ["longtask"] });
    const started = performance.now(); let prior = started; let frame = 0;
    const tick = () => {
      const now = performance.now();
      if (frameGapsMs.length < 12_000) frameGapsMs.push(now - prior); else droppedFrameSamples++;
      prior = now; frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return { stop: () => {
      cancelAnimationFrame(frame);
      for (const entry of observer?.takeRecords() ?? []) {
        if (longTasksMs.length < 200) longTasksMs.push(entry.duration); else droppedLongTasks++;
      }
      observer?.disconnect();
      return {
        durationMs: performance.now() - started, frameGapsMs, longTasksMs, droppedFrameSamples, droppedLongTasks,
        heapBefore, heapAfter: heap(), longTasksSupported,
        environment: { viewport: { width: innerWidth, height: innerHeight }, devicePixelRatio,
          hardwareConcurrency: navigator.hardwareConcurrency, userAgent: navigator.userAgent },
      };
    } };
  });
  const gestures: Array<{ widthBefore: number; widthAfter: number; bitmapBefore: number; bitmapAfter: number;
    canvasSamples: number; retainedBitmapSamples: number; emptyBitmapSamples: number }> = [];
  const during: Array<{ gesture: number; phase: "drag" | "settled"; transcripts: TranscriptWorkload[];
    pdf: Awaited<ReturnType<typeof pdfSnapshot>>; documentElements: number }> = [];
  const convergenceMs: number[] = [];
  let sampleResult;
  try {
    for (let gesture = 0; gesture < 2; gesture++) {
      const sash = await pdfLeftSash(pdf, sashes);
      // Dock layout and the previous gesture can leave a painted but stale
      // bitmap. Compare two settled widths, not an intermediate repaint.
      await waitForSettledPdfCanvas(firstCanvas);
      const original = await firstCanvas.evaluate((node) => ({
        width: node.getBoundingClientRect().width, bitmap: (node as HTMLCanvasElement).width,
      }));
      const canvasProbe = await firstCanvas.evaluateHandle((node) => {
        const canvas = node as HTMLCanvasElement;
        const initialWidth = canvas.getBoundingClientRect().width; const initialBitmap = canvas.width;
        let minWidth = initialWidth, maxWidth = initialWidth;
        let samples = 0; let retained = 0; let empty = 0; let frame = 0;
        const tick = () => {
          samples++;
          if (!canvas.isConnected || canvas.width === 0 || canvas.height === 0) empty++;
          const width = canvas.getBoundingClientRect().width;
          minWidth = Math.min(minWidth, width); maxWidth = Math.max(maxWidth, width);
          if (Math.abs(width - initialWidth) > 10 && canvas.width === initialBitmap) retained++;
          frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
        return { stop: () => { cancelAnimationFrame(frame); return { samples, retained, empty, minWidth, maxWidth }; } };
      });
      const started = Date.now();
      let canvasSamples;
      let hit;
      try {
        await page.mouse.move(sash.x, sash.y);
        hit = await page.evaluate(({ x, y }) => document.elementsFromPoint(x, y).slice(0, 5)
          .map(node => ({ tag: node.tagName, class: node.getAttribute("class"), sash: node.closest(".dv-sash")?.getAttribute("class") })), sash);
        await page.mouse.down();
        for (let step = 1; step <= 24; step++) {
          await page.mouse.move(sash.x + (gesture === 0 ? -72 : 72) * step / 24, sash.y);
          if (step === 1 || step === 9 || step === 24) {
            await publish(gesture * 3 + (step === 1 ? 0 : step === 9 ? 1 : 2));
          }
          if (step === 12) {
            during.push({ gesture, phase: "drag", transcripts: await Promise.all(transcripts.map(readTranscriptWorkload)),
              pdf: await pdfSnapshot(), documentElements: await page.locator("*").count() });
          }
          // Input pacing only: no application read/poll is issued by the probe.
          await page.waitForTimeout(20);
        }
        // The last content frame must land while the pointer still owns the
        // new width. Otherwise a restore during drag can hide behind mouseup.
        await Promise.all(transcripts.map((transcript, index) =>
          expect.poll(() => transcript.textContent(), { timeout: 15_000 }).toContain(expected(index, gesture * 3 + 2))));
      } finally {
        await page.mouse.up();
        canvasSamples = await canvasProbe.evaluate((probe) => probe.stop());
        await canvasProbe.dispose();
      }
      await waitForSettledPdfCanvas(firstCanvas);
      const settled = await firstCanvas.evaluate((node) => ({
        width: node.getBoundingClientRect().width, bitmap: (node as HTMLCanvasElement).width,
      }));
      expect(settled.bitmap, JSON.stringify({ gesture, sash, original, settled, canvasSamples, hit })).not.toBe(original.bitmap);
      expect(Math.abs(settled.width - original.width)).toBeGreaterThan(10);
      expect(canvasSamples.samples).toBeGreaterThan(0);
      expect(canvasSamples.empty).toBe(0);
      gestures.push({ widthBefore: original.width, widthAfter: settled.width, bitmapBefore: original.bitmap,
        bitmapAfter: settled.bitmap, canvasSamples: canvasSamples.samples,
        retainedBitmapSamples: canvasSamples.retained, emptyBitmapSamples: canvasSamples.empty });
      await Promise.all(transcripts.map((transcript, index) =>
        expect.poll(() => transcript.textContent(), { timeout: 15_000 }).toContain(expected(index, gesture * 3 + 2))));
      convergenceMs.push(Date.now() - started);
      const snapshot = await Promise.all(transcripts.map(readTranscriptWorkload));
      assertLoadedAndVisible(snapshot);
      during.push({ gesture, phase: "settled", transcripts: snapshot, pdf: await pdfSnapshot(),
        documentElements: await page.locator("*").count() });
    }
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  } finally {
    sampleResult = await sampling.evaluate((probe) => probe.stop());
    await sampling.dispose();
  }
  const after = await Promise.all(transcripts.map(readTranscriptWorkload));
  assertLoadedAndVisible(after);
  expect(sampleResult.frameGapsMs.length).toBeGreaterThan(0);
  expect(workers.created()).toBe(workerBefore.created);
  expect(workers.closed()).toBe(workerBefore.closed);
  expect(workers.warnings()).toEqual([]);
  return {
    fixture: { resources: 4, minimumTotalPerResource: 1_200, minimumLoadedPerResource: 600, pdfPages: 20 },
    transcriptsBefore: before, transcriptsAfter: after, pdfBefore, pdfAfter: await pdfSnapshot(), during,
    gestures, convergenceMs, workersBefore: workerBefore,
    workersAfter: { created: workers.created(), closed: workers.closed(), warnings: workers.warnings() },
    ...sampleResult, maxFrameGapMs: Math.max(0, ...sampleResult.frameGapsMs),
  };
}
