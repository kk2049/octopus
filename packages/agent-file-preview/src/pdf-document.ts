import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";
import { getDocument, PDFWorker } from "pdfjs-dist/legacy/build/pdf.mjs";

export interface PdfDocumentHandle {
  promise: Promise<PDFDocumentProxy>;
  close(): void;
}

/** Each displayed document owns one real worker and its transferred data copy. */
export function openPdfDocument(data: Uint8Array<ArrayBuffer>, onWorkerFailure: () => void): PdfDocumentHandle {
  const port = new Worker(new URL("./pdf-worker.ts", import.meta.url), { type: "module", name: "octopus-pdf" });
  let worker: PDFWorker | undefined;
  let loading: PDFDocumentLoadingTask | undefined;
  let closed = false;
  const fail = () => { if (!closed) { onWorkerFailure(); close(); } };
  const close = () => {
    if (closed) return;
    closed = true;
    port.removeEventListener("error", fail);
    if (loading) void loading.destroy().catch(() => {});
    try { worker?.destroy(); } finally { port.terminate(); }
  };
  port.addEventListener("error", fail);
  try {
    worker = PDFWorker.create({ port });
    loading = getDocument({
      data: data.slice(), worker, useWasm: false, useWorkerFetch: false,
      stopAtErrors: true, maxImageSize: 40_000_000,
    });
    void loading.promise.catch(() => close());
    return { promise: loading.promise, close };
  } catch (error) { close(); throw error; }
}
