/**
 * Permission-free presentation primitives.
 *
 * The bar for living here is narrow on purpose: a component qualifies only if
 * it is **trust-neutral** — no credential, no same-origin API, no navigation, no
 * bootstrap payload, no privileged state. Everything below takes plain data and
 * returns elements. That is also why they are React elements rather than the
 * HTML strings this package replaces: with an element tree there is no escaping
 * convention for an App author to forget, because there is no string on the
 * path at all.
 *
 * The trusted Dashboard has visually similar pieces. They are deliberately NOT
 * shared: importing them here would put the untrusted View's bundle downstream
 * of a package whose modules read cookies and the bootstrap payload, and one
 * careless transitive import later that boundary would be gone. What is shared
 * is the design language (tokens), not the code.
 */

// The stylesheet is installed here rather than in the root entry, because the
// `./ui` subpath is a real entry point for View modules that never touch the
// transport — and a `<StatusChip>` without its tokens is an unstyled span.
import "./styles-index.css";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Alert from "antd/es/alert";
import Empty from "antd/es/empty";
import Modal from "antd/es/modal";
import Tag, { type TagProps } from "antd/es/tag";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { AvButton } from "./controls.js";
import { appPopupContainer } from "./popup-container.js";

export type Tone = "neutral" | "ok" | "warn" | "error" | "info";

const TONES = new Set<Tone>(["ok", "warn", "error", "info"]);

export interface StatusChipProps {
  icon?: string;
  word: string;
  tone?: Tone;
  /** A real in-flight lifecycle; paints the shared reduced-motion-aware spinner. */
  busy?: boolean;
}

export function StatusChip({ icon = "•", word, tone = "neutral", busy = false }: StatusChipProps) {
  const colors: Record<Tone, TagProps["color"]> = {
    neutral: "default",
    ok: "success",
    warn: "warning",
    error: "error",
    info: "processing",
  };
  return (
    <Tag
      className="av-status"
      color={colors[tone]}
      data-tone={TONES.has(tone) ? tone : "neutral"}
      role={busy ? "status" : undefined}
      aria-label={busy ? word : undefined}
    >
      {busy ? <span className="av-spin" aria-hidden="true" /> : <span aria-hidden="true">{icon}</span>}
      <span>{word}</span>
    </Tag>
  );
}

export interface BannerProps {
  icon?: string;
  title: string;
  text?: string;
  tone?: Tone;
  children?: ReactNode;
}

export function Banner({ icon = "ℹ", title, text, tone, children }: BannerProps) {
  const type = tone === "ok" ? "success" : tone === "warn" ? "warning" : tone === "error" ? "error" : "info";
  return (
    <Alert
      className="av-banner"
      role="note"
      type={type}
      showIcon
      icon={<span aria-hidden="true">{icon}</span>}
      title={<strong>{title}</strong>}
      description={text || children ? <>{text}{text && children ? " · " : null}{children}</> : undefined}
      data-tone={tone && TONES.has(tone) ? tone : undefined}
    />
  );
}

export interface EmptyStateProps {
  icon?: string;
  title: string;
  text?: string;
  action?: { id?: string; label: string; ariaLabel?: string; disabled?: boolean; onSelect(): void };
}

export function EmptyState({ icon = "○", title, text, action }: EmptyStateProps) {
  return (
    <Empty
      className="av-empty"
      image={<div className="av-empty-icon" aria-hidden="true">{icon}</div>}
      description={
        <>
          <h2>{title}</h2>
          <p>{text ?? ""}</p>
        </>
      }
    >
      {action ? (
        <AvButton
          tone="primary"
          data-empty-action={action.id ?? "primary"}
          aria-label={action.ariaLabel}
          disabled={action.disabled}
          onClick={action.onSelect}
        >
          {action.label}
        </AvButton>
      ) : null}
    </Empty>
  );
}


// ── browser download ────────────────────────────────────────────────────────

export type BrowserDownloadDocument = { label: string; mediaType: string };

export interface BrowserDownloadState {
  status: "idle" | "preparing" | "started" | "refused";
  message: string;
  code: string;
  receivedBytes: number;
  totalBytes: number | null;
}

export type BrowserDownloadPreparation<T extends BrowserDownloadDocument> = { ok: true; document: T } | { ok: false; document: T | null; message: string; code: string };

const EMPTY_DOWNLOAD = Object.freeze({
  status: "idle",
  message: "",
  code: "",
  receivedBytes: 0,
  totalBytes: null,
} as const);

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/**
 * Decoded bytes waiting to be folded into the Blob. Folding hands them to the
 * browser's blob storage (which Chromium pages to disk), so the page itself
 * holds at most one batch however large the file is.
 */
const BLOB_FOLD_BYTES = 16 * 1024 * 1024;

class BlobAssembler {
  private blob = new Blob([]);
  private pending: Uint8Array<ArrayBuffer>[] = [];
  private pendingBytes = 0;

  push(base64: string): void {
    const bytes = decodeBase64(base64);
    this.pending.push(bytes);
    this.pendingBytes += bytes.length;
    if (this.pendingBytes >= BLOB_FOLD_BYTES) this.fold();
  }

  finish(mediaType: string): Blob {
    this.fold();
    return new Blob([this.blob], { type: mediaType });
  }

  private fold(): void {
    if (this.pending.length === 0) return;
    this.blob = new Blob([this.blob, ...this.pending]);
    this.pending = [];
    this.pendingBytes = 0;
  }
}

let downloadTargetSequence = 0;

function startBrowserDownload(file: BrowserDownloadDocument, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  // WebKit may ignore `download` for a programmatically-created Blob and
  // navigate its current frame instead. Give that fallback a disposable child
  // target so it can never replace the App document that initiated the save.
  const sink = Object.assign(globalThis.document.createElement("iframe"), { hidden: true, name: `av-download-${++downloadTargetSequence}` });
  sink.setAttribute("sandbox", "allow-downloads");
  const anchor = Object.assign(globalThis.document.createElement("a"), { href: url, download: file.label, target: sink.name, rel: "noopener" });
  globalThis.document.body.append(sink, anchor);
  // Blob consumption is asynchronous in WebKit. Keep the bounded URL alive
  // long enough for either a download or the isolated fallback navigation.
  setTimeout(() => { sink.remove(); URL.revokeObjectURL(url); }, 60_000);
  try { anchor.click(); } finally { anchor.remove(); }
}

/**
 * One explicit gesture prepares one Blob and starts one browser download.
 * `prepare` hands every base64 chunk to `onChunk` in order; nothing here keeps
 * more than one fold batch of decoded bytes in page memory.
 */
export function useBrowserDownload<T extends BrowserDownloadDocument>(
  scope: unknown,
  resource: unknown,
  prepare: (
    isCurrent: () => boolean,
    onProgress: (receivedBytes: number, totalBytes: number) => void,
    onChunk: (base64: string) => void,
  ) => Promise<BrowserDownloadPreparation<T>>,
): BrowserDownloadState & { start(): void } {
  const [state, setState] = useState<BrowserDownloadState>(EMPTY_DOWNLOAD);
  const generation = useRef(0);
  const pending = useRef(false);
  const prepareRef = useRef(prepare);
  prepareRef.current = prepare;
  useEffect(() => {
    generation.current += 1;
    pending.current = false;
    setState(EMPTY_DOWNLOAD);
    return () => { generation.current += 1; };
  }, [scope, resource]);
  const start = useCallback(() => {
    if (resource == null || pending.current) return;
    const owner = ++generation.current;
    pending.current = true;
    setState({ status: "preparing", message: "", code: "", receivedBytes: 0, totalBytes: null });
    const isCurrent = (): boolean => generation.current === owner;
    const onProgress = (receivedBytes: number, totalBytes: number): void => {
      if (!isCurrent()) return;
      const total = Number.isSafeInteger(totalBytes) && totalBytes >= 0 ? totalBytes : 0;
      const received = Number.isSafeInteger(receivedBytes) && receivedBytes >= 0
        ? Math.min(receivedBytes, total)
        : 0;
      setState((current) => current.status === "preparing"
        ? { ...current, receivedBytes: received, totalBytes: total }
        : current);
    };
    const assembler = new BlobAssembler();
    const onChunk = (base64: string): void => {
      if (isCurrent()) assembler.push(base64);
    };
    void prepareRef.current(isCurrent, onProgress, onChunk).then((result) => {
      if (generation.current !== owner) return;
      pending.current = false;
      if (!result.ok) {
        setState((current) => ({ ...current, status: "refused", message: result.message, code: result.code }));
        return;
      }
      startBrowserDownload(result.document, assembler.finish(result.document.mediaType));
      setState((current) => ({ ...current, status: "started", message: "文件已完整接收，浏览器保存已开始。", code: "" }));
    }).catch(() => {
      if (generation.current !== owner) return;
      pending.current = false;
      setState((current) => ({ ...current, status: "refused", message: "这次文件下载没有完成；请重新下载。", code: "unavailable" }));
    });
  }, [resource]);
  return { ...state, start };
}

type DownloadActionProps = { label: string; state: BrowserDownloadState; onDownload(): void };

export function DownloadAction(props: DownloadActionProps) {
  const percent = downloadPercent(props.state);
  return (
    <AvButton
      className="av-download"
      disabled={props.state.status === "preparing"}
      aria-label={`下载 ${props.label}`}
      onClick={props.onDownload}
    >
      {props.state.status === "preparing"
        ? percent === null ? "正在连接…" : `正在下载 ${percent}%`
        : props.state.status === "refused" ? "重新下载" : "下载"}
    </AvButton>
  );
}

export function DownloadNotice({ state }: { state: BrowserDownloadState }) {
  if (state.status === "idle") return null;
  const percent = downloadPercent(state);
  const progress = state.totalBytes === null
    ? "正在建立下载连接…"
    : `${displayDownloadBytes(state.receivedBytes)} / ${displayDownloadBytes(state.totalBytes)}${percent === null ? "" : ` · ${percent}%`}`;
  if (state.status === "preparing") {
    return (
      <div className="av-download-status" role="status" data-status={state.status} data-av-download-progress>
        <span>{progress}</span>
        <progress
          aria-label="文件下载进度"
          {...(state.totalBytes === null
            ? {}
            : { value: state.receivedBytes, max: Math.max(1, state.totalBytes) })}
        />
      </div>
    );
  }
  return (
    <p className="av-download-status" role={state.status === "refused" ? "alert" : "status"} data-status={state.status} data-code={state.code || undefined}>
      <span>{state.message}</span>
      {state.totalBytes !== null ? <span>{progress}</span> : null}
    </p>
  );
}

function downloadPercent(state: BrowserDownloadState): number | null {
  if (state.totalBytes === null) return null;
  if (state.totalBytes === 0) return state.status === "started" ? 100 : 0;
  return Math.round(Math.min(1, state.receivedBytes / state.totalBytes) * 100);
}

function displayDownloadBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

type DownloadEmptyStateProps = DownloadActionProps & { text: string; className?: string };

export function DownloadEmptyState(props: DownloadEmptyStateProps) {
  return (
    <div
      className={`av-download-empty${props.className ? ` ${props.className}` : ""}`}
      data-av-download-empty
      role="region"
      aria-label={`无法在线浏览 ${props.label}`}
    >
      <EmptyState
        icon="↓"
        title="无法在线浏览"
        text={props.text}
        action={{
          label: props.state.status === "preparing"
            ? downloadPercent(props.state) === null ? "正在连接…" : `正在下载 ${downloadPercent(props.state)}%`
            : props.state.status === "refused" ? "重新下载" : "下载",
          ariaLabel: `下载 ${props.label}`,
          disabled: props.state.status === "preparing",
          onSelect: props.onDownload,
        }}
      />
    </div>
  );
}


// ── modal dialog ───────────────────────────────────────────────────────────

export interface ModalDialogProps {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose(): void;
}

/**
 * The controlled modal surface shared by Agent View modules.
 *
 * Ant owns focus trapping, Escape, the labelled dialog role and focus return;
 * the caller owns the semantic identity that decides whether it is open. The
 * contents stay mounted while hidden so a projection frame cannot erase local
 * interaction state by briefly removing the row that opened the dialog.
 */
export function ModalDialog({ open, title, children, onClose }: ModalDialogProps) {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const anchor = useCallback((node: HTMLSpanElement | null) => {
    if (node) setContainer(appPopupContainer(node));
  }, []);
  return (
    <>
      {/* Resolve after the anchor commits, before mounting a portal. An initially
          open alert must never first mount under body and lose its App styles. */}
      <span hidden ref={anchor} />
      {container ? (
        <Modal open={open} title={title} footer={null} destroyOnHidden={false} onCancel={onClose} getContainer={container}>
          {children}
        </Modal>
      ) : null}
    </>
  );
}

// ── Markdown ────────────────────────────────────────────────────────────────

const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/**
 * Returns "" for anything not on the allow-list. React then renders an anchor
 * with no href, which is inert and still shows the link text.
 */
function safeUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  if (/^[#/?]/.test(trimmed)) return trimmed;
  try {
    const parsed = new URL(trimmed, typeof location === "undefined" ? "http://localhost/" : location.href);
    return SAFE_PROTOCOLS.has(parsed.protocol) ? trimmed : "";
  } catch {
    return "";
  }
}

const markdownComponents: Components = {
  a({ href, children, ...rest }) {
    if (!href) return <span {...rest}>{children}</span>;
    return (
      <a {...rest} href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
};

/**
 * Characters rendered as Markdown without asking. Parsing and rendering are
 * synchronous on the main thread and super-linear on long soft-wrapped
 * paragraphs (measured: 256 KiB 0.2 s, 1 MiB 7 s, 4 MiB ~155 s of frozen
 * page). Past this the text is shown as plain text until the reader asks.
 */
export const MARKDOWN_RENDER_BUDGET_CHARS = 256 * 1024;

export interface MarkdownProps {
  children: string | null | undefined;
  className?: string;
  /** Override the render budget, e.g. `Infinity` once a reader chose to render. */
  renderBudgetChars?: number;
  renderImage?(image: { src: string; alt: string; title?: string }): ReactNode;
  /** The Host can opt into a diagram renderer without changing Markdown policy. */
  renderCodeBlock?(children: ReactNode): ReactNode;
}

/**
 * The one Markdown renderer an Agent View ships.
 *
 * Everything it renders is untrusted twice over: the projection is content the
 * Host declassified to this package, and this package is publisher code. There
 * is no HTML string on the path — `react-markdown` parses to an AST and React
 * creates elements — so injection is not a mistake that can be made here. Three
 * rules keep it that way:
 *
 *  1. **No `rehype-raw`, ever.** Raw HTML in the source stays text.
 *  2. **URL schemes are allow-listed.** `javascript:` and `data:` links render
 *     as inert text.
 *  3. **Links carry `rel="noopener noreferrer"`.** The sandbox has no
 *     `allow-popups`, so they cannot open anything anyway; this is the second
 *     lock rather than the only one.
 */
export function Markdown({ children, className, renderImage, renderCodeBlock, renderBudgetChars }: MarkdownProps) {
  const text = children ?? "";
  const [forced, setForced] = useState(false);
  const budget = renderBudgetChars ?? MARKDOWN_RENDER_BUDGET_CHARS;
  // The plain fallback is windowed too: laying out one huge text node froze the
  // page as surely as parsing it (4 MiB ≈ 40 s in the acceptance browser).
  const [plainChars, setPlainChars] = useState(MARKDOWN_RENDER_BUDGET_CHARS);
  const components = useMemo<Components>(() => {
    const components: Components = { ...markdownComponents };
    if (renderImage) components.img = ({ src, alt, title }) => (
      renderImage({ src: src ?? "", alt: alt ?? "", ...(title ? { title } : {}) })
    );
    if (renderCodeBlock) components.pre = ({ children }) => renderCodeBlock(children);
    return components;
  }, [renderImage, renderCodeBlock]);
  if (!forced && text.length > budget) {
    return (
      <div className={className ? `av-prose ${className}` : "av-prose"} data-av-markdown-plain>
        <p className="av-markdown-budget" role="note">
          这段内容有 {text.length.toLocaleString()} 个字符，按 Markdown 渲染可能让页面卡住一段时间，先以纯文本显示。{" "}
          <AvButton onClick={() => setForced(true)}>按 Markdown 渲染</AvButton>
        </p>
        <pre className="av-markdown-plain">{text.slice(0, plainChars)}</pre>
        {text.length > plainChars ? (
          <p className="av-markdown-budget">
            已显示 {plainChars.toLocaleString()} / {text.length.toLocaleString()} 个字符。{" "}
            <AvButton onClick={() => setPlainChars((shown) => shown + MARKDOWN_RENDER_BUDGET_CHARS)}>继续显示</AvButton>
          </p>
        ) : null}
      </div>
    );
  }
  return (
    <div className={className ? `av-prose ${className}` : "av-prose"}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={safeUrl} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

// ── split handle ────────────────────────────────────────────────────────────

/**
 * Sizes persisted for the lifetime of the document, keyed by the caller's
 * stable name.
 *
 * In memory and not in storage: an opaque origin has no storage at all
 * (`localStorage` throws), so a View that tried to persist a pane width would
 * throw on load. The trusted panel persists its own layout because it is the
 * side that has an origin to persist to.
 */
const sizes = new Map<string, number>();

export interface SplitHandleProps {
  axis: "x" | "y";
  /** Which flex sibling this handle resizes. */
  target: "prev" | "next";
  /** Stable name for the remembered size. */
  storageKey: string;
  min?: number;
  max?: number;
  /**
   * Pixels the other side must retain inside this handle's flex parent.
   * When set, the measured parent capacity replaces the static max; `max`
   * remains the fallback for non-layout environments such as SSR and jsdom.
   */
  remainingMin?: number;
  title?: string;
}

/**
 * A draggable separator between two flex siblings.
 *
 * It resizes a DOM SIBLING rather than owning both panes, which keeps layout
 * policy in the App's CSS — the App decides what is flexible and what is fixed,
 * and this only writes one number. Pointer, keyboard (arrow keys, shift for a
 * coarse step) and double-click-to-reset are all here so no App reinvents drag
 * code, and the ARIA separator roles come with it rather than being remembered.
 */
export function SplitHandle({
  axis,
  target,
  storageKey,
  min = 100,
  max = 900,
  remainingMin,
  title,
}: SplitHandleProps) {
  const ref = useRef<HTMLDivElement>(null);

  const targetOf = useCallback((): HTMLElement | null => {
    const node = ref.current;
    if (!node) return null;
    const sibling = target === "next" ? node.nextElementSibling : node.previousElementSibling;
    return sibling instanceof HTMLElement ? sibling : null;
  }, [target]);

  const maxForLayout = useCallback((): number => {
    const node = ref.current;
    const parent = node?.parentElement;
    if (remainingMin === undefined || !node || !parent) return max;
    const parentBox = parent.getBoundingClientRect();
    const handleBox = node.getBoundingClientRect();
    const parentSize = axis === "x" ? parentBox.width : parentBox.height;
    const handleSize = axis === "x" ? handleBox.width : handleBox.height;
    if (!Number.isFinite(parentSize) || parentSize <= 0) return max;
    return Math.max(min, Math.floor(parentSize - Math.max(0, handleSize) - Math.max(0, remainingMin)));
  }, [axis, max, min, remainingMin]);

  const apply = useCallback(
    (value: number): void => {
      const node = ref.current;
      const pane = targetOf();
      if (!node || !pane) return;
      const layoutMax = maxForLayout();
      const size = Math.max(min, Math.min(layoutMax, Math.round(value)));
      pane.style[axis === "x" ? "width" : "height"] = `${size}px`;
      pane.style.flex = "none";
      sizes.set(storageKey, size);
      node.setAttribute("aria-valuemax", String(layoutMax));
      node.setAttribute("aria-valuenow", String(size));
    },
    [axis, maxForLayout, min, storageKey, targetOf],
  );

  const reset = useCallback((): void => {
    const node = ref.current;
    const pane = targetOf();
    if (!node || !pane) return;
    sizes.delete(storageKey);
    pane.style.removeProperty(axis === "x" ? "width" : "height");
    pane.style.removeProperty("flex");
    node.removeAttribute("aria-valuenow");
  }, [axis, storageKey, targetOf]);

  // Re-apply on mount so a remembered size survives the App re-rendering the
  // pane it belongs to.
  useEffect(() => {
    ref.current?.setAttribute("aria-valuemax", String(maxForLayout()));
    const remembered = sizes.get(storageKey);
    if (remembered !== undefined) apply(remembered);
  }, [apply, maxForLayout, storageKey]);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    const node = ref.current;
    const pane = targetOf();
    if (!node || !pane) return;
    event.preventDefault();
    const start = axis === "x" ? event.clientX : event.clientY;
    const box = pane.getBoundingClientRect();
    const initial = axis === "x" ? box.width : box.height;
    const forward = target !== "next";
    try {
      node.setPointerCapture(event.pointerId);
    } catch {
      /* a synthetic pointer without capture support */
    }
    node.classList.add("dragging");
    const owner = node.closest<HTMLElement>("[data-app-surface]") ?? document.body;
    owner.classList.add(`av-resizing-${axis}`);
    const move = (next: PointerEvent): void => {
      const point = axis === "x" ? next.clientX : next.clientY;
      const delta = point - start;
      apply(initial + (forward ? delta : -delta));
    };
    const end = (): void => {
      node.classList.remove("dragging");
      owner.classList.remove(`av-resizing-${axis}`);
      try {
        node.releasePointerCapture(event.pointerId);
      } catch {
        /* already released */
      }
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerup", end);
      node.removeEventListener("pointercancel", end);
    };
    node.addEventListener("pointermove", move);
    node.addEventListener("pointerup", end);
    node.addEventListener("pointercancel", end);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const negative = axis === "x" ? event.key === "ArrowLeft" : event.key === "ArrowUp";
    const positive = axis === "x" ? event.key === "ArrowRight" : event.key === "ArrowDown";
    if (!negative && !positive) return;
    const pane = targetOf();
    if (!pane) return;
    event.preventDefault();
    const box = pane.getBoundingClientRect();
    const current = axis === "x" ? box.width : box.height;
    let direction = negative ? -1 : 1;
    if (target === "next") direction *= -1;
    apply(current + direction * (event.shiftKey ? 40 : 10));
  };

  return (
    <div
      ref={ref}
      className="av-splitter"
      data-av-axis={axis}
      data-av-split-key={storageKey}
      data-av-target={target}
      role="separator"
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title={title}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={reset}
    />
  );
}
