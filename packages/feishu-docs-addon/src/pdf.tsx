import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { getDocument, PDFWorker } from 'pdfjs-dist/legacy/build/pdf.mjs';

/**
 * Renders a PDF of any length into one placeholder per page; a page is painted
 * when it scrolls near and its canvas released again when it scrolls far away,
 * so only the pages around the reader hold pixels. Loaded on demand: the card
 * never pays for PDF.js until someone opens a PDF. Each document owns one
 * worker; a worker the host refuses to start shows the download fallback
 * instead.
 */
export default function PdfView({ data, onFailure }: { data: ArrayBuffer; onFailure(): void }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  useEffect(() => {
    const port = new Worker(new URL('./pdf-worker.ts', import.meta.url), { type: 'module', name: 'octopus-pdf' });
    let closed = false;
    const fail = () => { if (!closed) onFailure(); };
    port.addEventListener('error', fail);
    const worker = PDFWorker.create({ port });
    const loading = getDocument({ data: new Uint8Array(data.slice(0)), worker, useWasm: false, useWorkerFetch: false, stopAtErrors: true, maxImageSize: 40_000_000 });
    loading.promise.then((value) => { if (!closed) setDoc(value); }, fail);
    return () => {
      closed = true;
      port.removeEventListener('error', fail);
      void loading.destroy().catch(() => {});
      try { worker.destroy(); } finally { port.terminate(); }
    };
  }, [data, onFailure]);
  if (!doc) return <div className="viewer-empty"><span className="spinner"/>正在打开 PDF…</div>;
  return <div className="pdf">
    {Array.from({ length: doc.numPages }, (_, k) => <PdfPage key={k} doc={doc} index={k + 1}/>)}
  </div>;
}

function PdfPage({ doc, index }: { doc: PDFDocumentProxy; index: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const holder = useRef<HTMLDivElement>(null);
  const [ratio, setRatio] = useState(1.414);
  useEffect(() => {
    const node = holder.current;
    if (!node) return;
    let cancelled = false;
    let near = false;
    let task: { cancel(): void; promise: Promise<unknown> } | null = null;
    /** A page far from the reader keeps its size, not its pixels. */
    const release = () => {
      task?.cancel();
      const target = canvas.current;
      if (target) { target.width = 0; target.height = 0; }
    };
    const paint = async () => {
      // One render per canvas at a time: let a cancelled one finish first.
      const previous = task;
      previous?.cancel();
      await previous?.promise.catch(() => {});
      const page = await doc.getPage(index);
      if (cancelled || !near || !canvas.current) return;
      const base = page.getViewport({ scale: 1 });
      setRatio(base.height / base.width);
      const width = node.clientWidth || base.width;
      const scale = Math.min(3, (width / base.width) * Math.max(1, window.devicePixelRatio || 1));
      const viewport = page.getViewport({ scale });
      const target = canvas.current;
      const context = target.getContext('2d');
      if (!context) return;
      target.width = Math.floor(viewport.width);
      target.height = Math.floor(viewport.height);
      const render = page.render({ canvas: target, canvasContext: context, viewport });
      task = render;
      await render.promise.catch(() => {});
    };
    // Paint a page when it comes near the visible part of the scroller; release
    // it when it moves away. The root is the scroller itself: with the viewport
    // as root its clipping hid the 600px margin and pages painted only once seen.
    const observer = new IntersectionObserver((entries) => {
      const now = entries.some((entry) => entry.isIntersecting);
      if (now === near) return;
      near = now;
      if (near) void paint(); else release();
    }, { root: node.closest('.viewer-body'), rootMargin: '600px 0px' });
    observer.observe(node);
    return () => { cancelled = true; observer.disconnect(); release(); };
  }, [doc, index]);
  return <div className="pdf-page" ref={holder} style={{ aspectRatio: `1 / ${ratio}` }}><canvas ref={canvas} aria-label={`第 ${index} 页`}/></div>;
}
