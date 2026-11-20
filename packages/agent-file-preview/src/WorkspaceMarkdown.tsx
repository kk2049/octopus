import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type MutableRefObject } from "react";
import { Markdown } from "@claude-bot/agent-view-react/ui";
import type { AnyWorkspaceFilesPort } from "@claude-bot/workspace-files-contract";
import { AnnotationsPanel, type AnnotationsPanelHandle } from "./AnnotationsPanel.js";
import { resolveAnchor } from "./anchor.js";
import type { FileAnnotation, FileAnnotationsAdapter } from "./annotations.js";
import { textRangeFromOffsets } from "./dom-selection.js";
import { markdownImageLabels, markdownRelativeLabels, type ListedFileLocation } from "./markdown-images.js";
import { useWorkspaceMedia } from "./media.js";
import type { PublishedFileLinks } from './file-links.js';

export interface WorkspaceMarkdownProps {
  text: string;
  port: AnyWorkspaceFilesPort;
  location: ListedFileLocation | null;
  annotations?: FileAnnotationsAdapter;
  fileKey?: string;
  label?: string;
  annotationControlRef?: MutableRefObject<AnnotationsPanelHandle | null>;
  onOpenFile?(ref: string, label: string, location: ListedFileLocation): boolean;
  links?: PublishedFileLinks;
  sourceRef?: string;
  /** Passed to `Markdown`; `Infinity` once the reader chose to render a large file. */
  renderBudgetChars?: number;
}

export function WorkspaceMarkdown({
  text,
  port,
  location,
  annotations,
  fileKey,
  label,
  annotationControlRef,
  onOpenFile,
  links,
  sourceRef,
  renderBudgetChars,
}: WorkspaceMarkdownProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const localControlRef = useRef<AnnotationsPanelHandle>(null);
  const controlRef = annotationControlRef ?? localControlRef;
  const renderImage = useCallback((image: { src: string; alt: string; title?: string }) => (
    <WorkspaceMarkdownImage port={port} location={location} image={image} />
  ), [port, location?.rootRef, location?.labels.join("/")]);
  const showAnnotations = Boolean(annotations && fileKey);
  const list = showAnnotations ? annotations!.read(fileKey!) : [];
  const version = useMemo(() => ({}), [text, port, links, sourceRef, location?.rootRef, location?.labels.join("/")]);
  const liveVersion = useRef<object | null>(version); liveVersion.current = version;
  const request = useRef<{ version: object } | null>(null);
  const deadline = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [linkStatus, setLinkStatus] = useState({ version, pending: false, message: "" });
  useEffect(() => {
    liveVersion.current = version;
    return () => { liveVersion.current = null; request.current = null; if (deadline.current) clearTimeout(deadline.current); };
  }, [version]);
  const openLink = (event: MouseEvent<HTMLDivElement>) => {
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    const href = anchor?.getAttribute('href') ?? '';
    if (!onOpenFile || !href || href.startsWith('#') || href.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(href)) return;
    event.preventDefault();
    if (request.current?.version === version) return;
    let fileHref = href;
    try { fileHref = decodeURIComponent(href.split(/[?#]/, 1)[0] ?? ''); }
    catch { setLinkStatus({ version, pending: false, message: '文件链接编码无效。' }); return; }
    const labels = markdownRelativeLabels(location, href);
    if (!links && (!labels || !location || typeof port.resolvePath !== 'function')) {
      setLinkStatus({ version, pending: false, message: '此链接没有可用的文件目录上下文。' }); return;
    }
    const token = { version }; request.current = token;
    setLinkStatus({ version, pending: true, message: '正在打开链接文档…' });
    const current = () => liveVersion.current === version && request.current === token;
    const timer = setTimeout(() => {
      if (!current()) return;
      request.current = null;
      setLinkStatus({ version, pending: false, message: '文件链接未收到答复，请核对连接后再点击。' });
    }, 20_000);
    deadline.current = timer;
    const resolve = links
      ? links.resolve({ href: fileHref, ...(sourceRef ? { fileRef: sourceRef } : {}), location })
      : port.resolvePath!(location!.rootRef, labels!).then(answer => !answer.ok ? answer : answer.value.kind !== 'file'
        ? { ok: false as const, message: '链接目标不是可浏览的文件。' }
        : { ok: true as const, ref: answer.value.ref, label: answer.value.label, location: { ...location!, labels: labels! } });
    void resolve.then(answer => {
      if (!current()) return;
      const message = !answer.ok ? answer.message
        : onOpenFile(answer.ref, answer.label, answer.location) ? '' : '当前工作台无法打开此文件。';
      setLinkStatus({ version, pending: false, message });
    }, () => {
      if (current()) setLinkStatus({ version, pending: false, message: '文件链接读取失败，请检查连接。' });
    }).finally(() => { clearTimeout(timer); if (request.current === token) request.current = null; });
  };
  return (
    <>
      {linkStatus.version === version && linkStatus.message ? <div role="status" aria-busy={linkStatus.pending}>{linkStatus.message}</div> : null}
      <div ref={containerRef} className="wsmarkdown-body" onClick={openLink}>
        <Markdown renderImage={renderImage} {...(renderBudgetChars === undefined ? {} : { renderBudgetChars })}>{text}</Markdown>
        {showAnnotations ? (
          <MarkdownAnnotationMarkers
            containerRef={containerRef}
            annotations={list}
            onEdit={(annotationId) => controlRef.current?.edit(annotationId)}
          />
        ) : null}
      </div>
      {showAnnotations ? (
        <AnnotationsPanel
          ref={controlRef}
          fileKey={fileKey!}
          label={label ?? fileKey ?? "Markdown"}
          adapter={annotations!}
          containerRef={containerRef}
          kind="markdown"
        />
      ) : null}
    </>
  );
}

interface MarkdownMarker {
  id: string;
  note: string;
  left: number;
  top: number;
}

function MarkdownAnnotationMarkers({ containerRef, annotations, onEdit }: {
  containerRef: MutableRefObject<HTMLDivElement | null>;
  annotations: readonly FileAnnotation[];
  onEdit(annotationId: string): void;
}) {
  const [markers, setMarkers] = useState<MarkdownMarker[]>([]);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    let frame = 0;
    const update = () => {
      const text = root.textContent ?? "";
      const rootRect = root.getBoundingClientRect();
      const next: MarkdownMarker[] = [];
      for (const annotation of annotations) {
        if (annotation.target.kind !== "markdown") continue;
        const outcome = resolveAnchor(text, annotation.target);
        if (outcome.status !== "matched") continue;
        const range = textRangeFromOffsets(root, outcome.start, outcome.end);
        const rects = range ? Array.from(range.getClientRects()) : [];
        const tail = rects.at(-1);
        if (!tail || (!tail.width && !tail.height)) continue;
        next.push({
          id: annotation.id,
          note: annotation.note,
          left: Math.max(12, Math.min(rootRect.width - 12, tail.right - rootRect.left + 10)),
          top: Math.max(12, tail.top - rootRect.top + tail.height / 2),
        });
      }
      setMarkers(next);
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    schedule();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(root);
    return () => { cancelAnimationFrame(frame); observer?.disconnect(); };
  }, [annotations, containerRef]);

  return markers.map((marker, index) => (
    <button
      key={marker.id}
      type="button"
      className="av-markdown-annotation-marker"
      style={{ left: marker.left, top: marker.top + index * 3 }}
      aria-label={`编辑批注：${marker.note}`}
      title={marker.note}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onEdit(marker.id)}
    />
  ));
}

function WorkspaceMarkdownImage({ port, location, image }: {
  port: AnyWorkspaceFilesPort;
  location: ListedFileLocation | null;
  image: { src: string; alt: string; title?: string };
}) {
  const labels = markdownImageLabels(location, image.src);
  const key = labels && location ? `${location.rootRef}\0${labels.join("\0")}` : "";
  const [resolved, setResolved] = useState<{ key: string; ref: string | null }>({ key: "", ref: null });
  useEffect(() => {
    let live = true;
    if (!key || !labels || !location || typeof port.resolvePath !== "function") return setResolved({ key, ref: null });
    void port.resolvePath(location.rootRef, labels).then((answer) => {
      if (live) setResolved({ key, ref: answer.ok && answer.value.kind === "file" ? answer.value.ref : null });
    }, () => live && setResolved({ key, ref: null }));
    return () => { live = false; };
  }, [key, port]);
  const media = useWorkspaceMedia(port, resolved.key === key ? resolved.ref : null);
  if (media.status === "ready" && media.document?.mediaType.startsWith("image/") && media.url) {
    return <img className="wsmarkdown-image" data-av-markdown-image src={media.url} alt={image.alt} {...(image.title ? { title: image.title } : {}) } />;
  }
  const status = !labels ? "unsupported" : resolved.key !== key ? "resolving" : resolved.ref ? media.status : "unresolved";
  return <span className="wsmarkdown-image-missing" data-av-markdown-image-missing role="img" aria-label={image.alt || "图片"} data-state={status}>{image.alt || "图片暂不可用"}</span>;
}
