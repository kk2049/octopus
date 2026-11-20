import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject, type CSSProperties } from "react";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import { TextLayer } from "pdfjs-dist/legacy/build/pdf.mjs";
import { openPdfDocument, type PdfDocumentHandle } from "./pdf-document.js";
import { AnnotationsPanel, type AnnotationsPanelHandle, type PdfSelectionInfo } from "./AnnotationsPanel.js";
import type { FileAnnotation, FileAnnotationsAdapter } from "./annotations.js";
import { resolveAnchor, shortHash } from "./anchor.js";
import { textRangeFromOffsets, textSelectionOffsets } from "./dom-selection.js";
import { beginPdfCanvasPaint, observePdfPageWidth, pdfPageAspectRatio } from "./pdf-render.js";
import { pdfZoomFromPinch, pdfZoomFromWheel } from "./pdf-scale.js";

type PdfState =
  | { status: "loading"; document: null; message: string }
  | { status: "ready"; document: PDFDocumentProxy; message: string }
  | { status: "refused"; document: null; message: string };

export interface PdfPreviewProps {
  data: Uint8Array<ArrayBuffer>;
  label: string;
  annotations?: FileAnnotationsAdapter;
  fileKey?: string;
  annotationControlRef?: MutableRefObject<AnnotationsPanelHandle | null>;
}

/** Shared page-text map: text layers report their decoded page text upstream. */
type PageTextRegistry = Map<number, string>;

interface PdfZoomAnchor {
  page: number | null;
  xRatio: number;
  yRatio: number;
  clientX: number;
  clientY: number;
  scroller: HTMLElement;
}

interface PdfPinchGesture {
  distance: number;
  startZoom: number;
  page: number | null;
  xRatio: number;
  yRatio: number;
}

interface TwoTouchGeometry {
  clientX: number;
  clientY: number;
  distance: number;
}

function twoTouchGeometry(touches: TouchList): TwoTouchGeometry | null {
  if (touches.length !== 2) return null;
  const first = touches.item(0);
  const second = touches.item(1);
  if (!first || !second) return null;
  const dx = second.clientX - first.clientX;
  const dy = second.clientY - first.clientY;
  return {
    clientX: (first.clientX + second.clientX) / 2,
    clientY: (first.clientY + second.clientY) / 2,
    distance: Math.hypot(dx, dy),
  };
}

/** How far ahead of the viewport a page is fetched and painted. */
const PAINT_MARGIN = "700px 0px";

/** How far behind it a painted bitmap is kept before being handed back. */
const RELEASE_MARGIN = "1600px 0px";

export function PdfPreview({ data, label, annotations, fileKey, annotationControlRef }: PdfPreviewProps) {
  const [state, setState] = useState<PdfState>({ status: "loading", document: null, message: "正在解析 PDF…" });
  const containerRef = useRef<HTMLDivElement>(null);
  const pageTextRef = useRef<PageTextRegistry>(new Map());
  const [, setPageTextRevision] = useState(0);
  const contentHash = useState(() => shortHash(data))[0];
  const [zoom, setZoom] = useState(1);
  const pendingZoomAnchor = useRef<PdfZoomAnchor | null>(null);
  const pinchGesture = useRef<PdfPinchGesture | null>(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  useEffect(() => {
    let live = true;
    let loading: PdfDocumentHandle | undefined;
    const refuse = () => live && setState({ status: "refused", document: null, message: "浏览器无法显示这份 PDF，可以先下载后打开。" });
    setState({ status: "loading", document: null, message: "正在解析 PDF…" });
    try {
      loading = openPdfDocument(data, refuse);
      void loading.promise.then(
        (document) => live && setState({ status: "ready", document, message: "" }),
        refuse,
      );
    } catch { refuse(); }
    return () => { live = false; loading?.close(); pageTextRef.current = new Map(); };
  }, [data]);

  const registerPageText = useCallback((page: number, text: string) => {
    if (pageTextRef.current.get(page) === text) return;
    pageTextRef.current.set(page, text);
    setPageTextRevision((value) => value + 1);
  }, []);

  const pdfSelection = useCallback((): PdfSelectionInfo | null => {
    const selection = window.getSelection?.();
    if (!selection || selection.isCollapsed) return null;
    const range = selection.rangeCount ? selection.getRangeAt(0) : null;
    const start = range?.startContainer ?? null;
    if (!start) return null;
    const element = start.nodeType === Node.ELEMENT_NODE ? (start as Element) : start.parentElement;
    if (!element) return null;
    const pageEl = element.closest?.("[data-page]");
    if (!pageEl) return null;
    const page = Number(pageEl.getAttribute("data-page") ?? "0");
    if (!Number.isFinite(page) || page < 1) return null;
    const textLayer = pageEl.querySelector<HTMLElement>(".av-pdf-text-layer");
    if (!textLayer) return null;
    const offsets = textSelectionOffsets(textLayer, selection);
    if (!offsets) return null;
    return { page, pageText: textLayer.textContent ?? "", start: offsets.start, end: offsets.end, contentHash };
  }, [contentHash]);

  const pdfPageText = useCallback((page: number) => pageTextRef.current.get(page) ?? null, []);
  const editAnnotation = useCallback((annotationId: string) => {
    annotationControlRef?.current?.edit(annotationId);
  }, [annotationControlRef]);

  const zoomAtPointer = useCallback((event: WheelEvent) => {
    if ((!event.ctrlKey && !event.metaKey) || event.deltaY === 0) return;
    const root = containerRef.current;
    const scroller = root?.closest<HTMLElement>(".av-media");
    if (!root || !scroller) return;
    const page = event.target instanceof Element
      ? event.target.closest<HTMLElement>(".av-pdf-page")
      : null;
    const anchorElement = page ?? root;
    const rect = anchorElement.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) return;

    // Own the modified wheel even at either limit. Otherwise Chrome starts
    // scaling the whole App as soon as the local reader reaches 100% or 200%.
    event.preventDefault();
    const deltaY = event.deltaY;
    const deltaMode = event.deltaMode;
    setZoom((current) => {
      const next = pdfZoomFromWheel(current, deltaY, deltaMode);
      if (next === current) return current;
      pendingZoomAnchor.current = {
        page: page ? Number(page.dataset.page) : null,
        xRatio: (event.clientX - rect.left) / rect.width,
        yRatio: (event.clientY - rect.top) / rect.height,
        clientX: event.clientX,
        clientY: event.clientY,
        scroller,
      };
      return next;
    });
  }, []);

  const startPinch = useCallback((event: TouchEvent) => {
    const touch = twoTouchGeometry(event.touches);
    const root = containerRef.current;
    const scroller = root?.closest<HTMLElement>(".av-media");
    if (!touch || !root || !scroller || !(touch.distance > 0)) return;
    const page = root.ownerDocument
      .elementFromPoint(touch.clientX, touch.clientY)
      ?.closest<HTMLElement>(".av-pdf-page") ?? null;
    const anchorElement = page ?? root;
    const rect = anchorElement.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) return;
    event.preventDefault();
    pinchGesture.current = {
      distance: touch.distance,
      startZoom: zoomRef.current,
      page: page ? Number(page.dataset.page) : null,
      xRatio: (touch.clientX - rect.left) / rect.width,
      yRatio: (touch.clientY - rect.top) / rect.height,
    };
  }, []);

  const movePinch = useCallback((event: TouchEvent) => {
    const touch = twoTouchGeometry(event.touches);
    const pinch = pinchGesture.current;
    const root = containerRef.current;
    const scroller = root?.closest<HTMLElement>(".av-media");
    if (!touch || !pinch || !root || !scroller) return;
    event.preventDefault();
    const next = pdfZoomFromPinch(pinch.startZoom, touch.distance / pinch.distance);
    const current = zoomRef.current;
    if (next === current) return;
    pendingZoomAnchor.current = {
      page: pinch.page,
      xRatio: pinch.xRatio,
      yRatio: pinch.yRatio,
      clientX: touch.clientX,
      clientY: touch.clientY,
      scroller,
    };
    zoomRef.current = next;
    setZoom(next);
  }, []);

  const endPinch = useCallback((event: TouchEvent) => {
    if (event.touches.length < 2) pinchGesture.current = null;
  }, []);

  useEffect(() => {
    if (state.status !== "ready") return;
    const root = containerRef.current;
    if (!root) return;
    root.addEventListener("wheel", zoomAtPointer, { passive: false });
    root.addEventListener("touchstart", startPinch, { passive: false });
    root.addEventListener("touchmove", movePinch, { passive: false });
    root.addEventListener("touchend", endPinch);
    root.addEventListener("touchcancel", endPinch);
    return () => {
      root.removeEventListener("wheel", zoomAtPointer);
      root.removeEventListener("touchstart", startPinch);
      root.removeEventListener("touchmove", movePinch);
      root.removeEventListener("touchend", endPinch);
      root.removeEventListener("touchcancel", endPinch);
    };
  }, [endPinch, movePinch, startPinch, state.status, zoomAtPointer]);

  useLayoutEffect(() => {
    const anchor = pendingZoomAnchor.current;
    pendingZoomAnchor.current = null;
    if (!anchor) return;
    const root = containerRef.current;
    const target = anchor.page === null
      ? root
      : root?.querySelector<HTMLElement>(`[data-page="${anchor.page}"]`) ?? null;
    if (!target || !anchor.scroller.isConnected) return;
    const rect = target.getBoundingClientRect();
    anchor.scroller.scrollLeft += rect.left + rect.width * anchor.xRatio - anchor.clientX;
    anchor.scroller.scrollTop += rect.top + rect.height * anchor.yRatio - anchor.clientY;
  }, [zoom]);

  if (state.status !== "ready") return <p className="av-pdf-status" role={state.status === "refused" ? "alert" : "status"}>{state.message}</p>;

  const showAnnotations = Boolean(annotations && fileKey);
  const fileAnnotations = showAnnotations ? annotations!.read(fileKey!) : [];

  return (
    <>
      <div
        className="av-pdf"
        data-av-pdf
        ref={containerRef}
        aria-label={`PDF：${label}，共 ${state.document.numPages} 页；桌面按 Ctrl 或 Command 加滚轮、手机双指可局部缩放`}
        data-zoom={zoom.toFixed(3)}
        style={{ "--av-pdf-zoom": zoom } as CSSProperties}
        title="桌面按 Ctrl 或 Command 加滚轮，手机双指局部缩放 PDF"
      >
        {Array.from({ length: state.document.numPages }, (_, index) => (
          <PdfPage
            key={index + 1}
            document={state.document}
            pageNumber={index + 1}
            label={label}
            onPageText={registerPageText}
            annotations={fileAnnotations.filter((annotation) =>
              annotation.target.kind === "pdf-text"
              && annotation.target.page === index + 1
              && (!annotation.target.contentHash || annotation.target.contentHash === contentHash))}
            onEditAnnotation={editAnnotation}
          />
        ))}
      </div>
      {showAnnotations ? (
        <AnnotationsPanel
          ref={annotationControlRef}
          fileKey={fileKey!}
          label={label}
          adapter={annotations!}
          containerRef={containerRef}
          kind="pdf-text"
          pdfSelection={pdfSelection}
          pdfPageText={pdfPageText}
          currentContentHash={contentHash}
        />
      ) : null}
    </>
  );
}

interface AnnotationMarker {
  id: string;
  note: string;
  left: number;
  top: number;
}

function PdfPage({ document, pageNumber, label, onPageText, annotations, onEditAnnotation }: {
  document: PDFDocumentProxy;
  pageNumber: number;
  label: string;
  onPageText(page: number, text: string): void;
  annotations: readonly FileAnnotation[];
  onEditAnnotation(annotationId: string): void;
}) {
  const host = useRef<HTMLElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const textLayer = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(pageNumber === 1);
  const [page, setPage] = useState<PDFPageProxy | null>(null);
  const [width, setWidth] = useState(0);
  const [aspectRatio, setAspectRatio] = useState(3 / 4);
  const [painted, setPainted] = useState(false);
  const [refused, setRefused] = useState(false);
  const [decodedText, setDecodedText] = useState("");
  const [textLayerRevision, setTextLayerRevision] = useState(0);
  const [markers, setMarkers] = useState<AnnotationMarker[]>([]);

  // Two margins, not one. The inner one decides when a page is worth painting;
  // the outer one decides when its bitmap is worth keeping. Oversampled pages
  // cost real memory (tens of MiB each), and the previous latch never gave any
  // of it back, so a long document grew without bound as the reader scrolled.
  // The gap between the margins is the hysteresis that keeps an ordinary scroll
  // from thrashing paint against release.
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      setActive(true);
      return;
    }
    const root = node.closest(".av-media");
    const paint = new IntersectionObserver(
      (entries) => entries.some((entry) => entry.isIntersecting) && setActive(true),
      { root, rootMargin: PAINT_MARGIN },
    );
    const release = new IntersectionObserver(
      (entries) => entries.every((entry) => !entry.isIntersecting) && setActive(false),
      { root, rootMargin: RELEASE_MARGIN },
    );
    paint.observe(node);
    release.observe(node);
    return () => { paint.disconnect(); release.disconnect(); };
  }, []);

  // Releasing is only about the bitmap: the parsed page proxy and the decoded
  // text layer stay, so scrolling back repaints without a second parse and a
  // selection anchored off-screen still resolves.
  useEffect(() => {
    if (active) return;
    setPainted(false);
    const node = canvas.current;
    if (node) { node.width = 0; node.height = 0; }
  }, [active]);

  useEffect(() => {
    const node = host.current;
    if (!node) return;
    // The display cap is CSS (`.av-pdf-page`); measuring is not the place to
    // repeat it, or the two numbers drift and the canvas is stretched.
    return observePdfPageWidth(node, setWidth);
  }, []);

  useEffect(() => {
    if (!active || page || refused) return;
    let live = true;
    void document.getPage(pageNumber).then((nextPage) => {
      if (!live) return;
      const nextAspectRatio = pdfPageAspectRatio(nextPage);
      if (nextAspectRatio === null) {
        setRefused(true);
        return;
      }
      setAspectRatio(nextAspectRatio);
      setPage(nextPage);
    }, () => live && setRefused(true));
    return () => { live = false; };
  }, [active, document, page, pageNumber, refused]);

  useEffect(() => {
    if (!active || !page || !width || !canvas.current || refused) return;
    let live = true;
    let render: RenderTask | null = null;
    let text: { cancel(): void } | null = null;
    // The helper contains synchronous PDF.js/canvas failures. Promise failures
    // stay below on the same page-level refusal path.
    const paint = beginPdfCanvasPaint(page, canvas.current, width, globalThis.devicePixelRatio || 1);
    if (!paint) {
      setRefused(true);
      return;
    }
    setPainted(false);
    const { cssViewport } = paint;
    render = paint.render;
    void render.promise.then(() => live && setPainted(true), () => live && setRefused(true));

    const layer = textLayer.current;
    if (layer) {
      layer.style.width = `${cssViewport.width}px`;
      layer.style.height = `${cssViewport.height}px`;
      layer.replaceChildren();
      layer.style.setProperty("--scale-factor", `${cssViewport.scale}`);
      layer.style.setProperty("--user-unit", `${cssViewport.userUnit}`);
      try {
        const runner = new TextLayer({
          textContentSource: page.streamTextContent({ includeMarkedContent: false, disableNormalization: false }),
          container: layer,
          viewport: cssViewport,
        });
        text = runner;
        void runner.render().then(() => {
          if (!live) return;
          const decoded = layer.textContent ?? "";
          setDecodedText(decoded);
          // A repaint replaces text DOM even when its decoded string is equal.
          setTextLayerRevision((revision) => revision + 1);
          onPageText(pageNumber, decoded);
        }, () => {
          // Text layer failures are not fatal — the canvas still paints.
        });
      } catch {
        // Text layer construction errors are non-fatal; the canvas remains usable.
      }
    }

    return () => { live = false; render?.cancel(); text?.cancel(); };
  }, [active, page, width, onPageText, pageNumber, refused]);

  useEffect(() => {
    const layer = textLayer.current;
    if (!layer || !decodedText || !annotations.length) {
      setMarkers([]);
      return;
    }
    const layerRect = layer.getBoundingClientRect();
    const next: AnnotationMarker[] = [];
    for (const annotation of annotations) {
      const target = annotation.target;
      if (target.kind !== "pdf-text") continue;
      const outcome = resolveAnchor(decodedText, target);
      if (outcome.status !== "matched") continue;
      const range = textRangeFromOffsets(layer, outcome.start, outcome.end);
      const rects = range ? Array.from(range.getClientRects()) : [];
      const tail = rects.at(-1);
      if (!tail || (!tail.width && !tail.height)) continue;
      next.push({
        id: annotation.id,
        note: annotation.note,
        left: Math.max(12, Math.min(layerRect.width - 12, tail.right - layerRect.left + 10)),
        top: Math.max(12, Math.min(layerRect.height - 12, tail.top - layerRect.top + tail.height / 2)),
      });
    }
    setMarkers(next);
  }, [annotations, decodedText, width, textLayerRevision]);

  return (
    <section
      ref={host}
      className="av-pdf-page"
      data-av-pdf-page
      style={{ aspectRatio }}
      aria-label={`${label} 第 ${pageNumber} 页`}
      aria-busy={active && !painted && !refused || undefined}
      data-page={pageNumber}
      data-painted={painted ? "1" : "0"}
    >
      <canvas className="av-pdf-canvas" data-av-pdf-canvas ref={canvas} aria-hidden="true" />
      <div className="av-pdf-text-layer" data-av-pdf-text-layer ref={textLayer} aria-hidden="true" />
      {markers.map((marker, index) => (
        <button
          key={marker.id}
          type="button"
          className="av-pdf-annotation-marker"
          style={{ left: marker.left, top: marker.top + index * 3 }}
          aria-label={`编辑第 ${pageNumber} 页批注：${marker.note}`}
          title={marker.note}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onEditAnnotation(marker.id)}
        >✎</button>
      ))}
      {refused ? <span className="av-pdf-page-error" role="alert">这一页无法绘制，可以先下载后打开。</span> : null}
    </section>
  );
}
