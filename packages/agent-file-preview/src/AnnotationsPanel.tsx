/**
 * Reader-authored notes on top of a file preview.
 *
 * The panel is the ONLY place that creates, edits, deletes, exports, or clears
 * annotations. The preview surface just:
 *   - hosts the observable DOM (its container ref goes in via `containerRef`),
 *   - reports which page a selection landed on when the target is PDF text,
 *   - hands the panel a stable `fileKey`.
 *
 * Everything else — selection tracking, quote/prefix/suffix capture, adrift
 * detection, list rendering, editing UX and clipboard export — lives here.
 * `onSave` is fire-and-forget from the panel's point of view: the App layer
 * translates it into a `set_file_annotations` proposal and updates its own
 * store; the projection returning the new list is what the panel actually
 * renders on the next frame.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type MouseEvent,
  type RefObject,
} from "react";
import { CONTEXT_CHARS, buildAnchorHint, mintAnnotationId, normalizeNote, resolveAnchor } from "./anchor.js";
import {
  ANNOTATION_LIMITS,
  clampContext,
  clampQuote,
  type FileAnnotation,
  type FileAnnotationDraftStore,
  type FileAnnotationsAdapter,
} from "./annotations.js";
import type { AnnotationTarget } from "./annotations.js";
import { textSelectionOffsets } from "./dom-selection.js";

export interface PdfSelectionInfo {
  /** 1-indexed PDF page the selection anchor node lives on. */
  page: number;
  /** Full text of that page as PDF.js decoded it, for later rebind checks. */
  pageText: string;
  /** Exact offsets into pageText, derived from DOM Range boundaries. */
  start: number;
  end: number;
  /** Short hex of the PDF bytes at annotation time — used to spot forks. */
  contentHash: string;
}

export interface AnnotationsPanelProps {
  fileKey: string;
  label: string;
  adapter: FileAnnotationsAdapter;
  /** The DOM subtree whose text a selection is scored against. */
  containerRef: MutableRefObject<HTMLElement | null>;
  /**
   * `markdown` when the container renders a Markdown document (one text
   * body), `pdf-text` when it renders PDF text layers (per-page bodies).
   */
  kind: "markdown" | "pdf-text";
  /**
   * Only required for `pdf-text`. Returns the info the panel needs to build
   * a PDF anchor from a live selection. `null` means the current selection
   * cannot be located on a page (spans pages, or the text layer has not
   * finished painting).
   */
  pdfSelection?: () => PdfSelectionInfo | null;
  /**
   * Only for `pdf-text`. Given a page number, return that page's decoded
   * text so an existing annotation can be re-scored against the current PDF.
   */
  pdfPageText?: (page: number) => string | null;
  /** Only for `pdf-text`. The bytes hash of the PDF that is currently rendered. */
  currentContentHash?: string;
}

interface Draft {
  target: AnnotationTarget;
  note: string;
  draftKey: string;
}

interface EditingDraft {
  id: string;
  note: string;
  draftKey: string;
}

type AnnotationSaveReply = { ok: true } | { ok: false; message: string; code?: string };

const EMPTY_NOTE = "";

function newAnnotationDraftKey(fileKey: string, target: AnnotationTarget): string {
  // JSON preserves the complete tuple without delimiter ambiguity. The wire
  // store rejects an overlong key instead of shortening it into a collision.
  return `file-annotation:new:${JSON.stringify([fileKey, target])}`;
}

function editAnnotationDraftKey(fileKey: string, annotationId: string): string {
  return `file-annotation:edit:${JSON.stringify([fileKey, annotationId])}`;
}

function rememberedNote(store: FileAnnotationDraftStore | undefined, key: string, fallback: string): string {
  const text = store?.get(key).text ?? "";
  return text || fallback;
}

function definitelyNotSaved(reply: AnnotationSaveReply): boolean {
  return !reply.ok && reply.code !== "backend_unavailable" && reply.code !== "dispatch_failed" && reply.code !== "unknown_outcome";
}

export interface AnnotationsPanelHandle {
  startDraft(): void;
  exportAll(anchor?: HTMLElement): void;
  clearAll(): void;
  edit(annotationId: string): void;
  toggleList(): void;
}

export interface AnnotationToolbarProps {
  controlRef: RefObject<AnnotationsPanelHandle | null>;
  count: number;
}

/** Persistent file-chrome controls. Phone CSS turns only New into a dock button. */
export function AnnotationToolbar({ controlRef, count }: AnnotationToolbarProps) {
  const keepSelection = (event: MouseEvent<HTMLButtonElement>) => event.preventDefault();
  return (
    <span className="av-annotation-toolbar" role="group" aria-label="文件批注">
      <button
        type="button"
        className="av-annotations-btn av-annotation-toolbar-new"
        aria-label="新增批注"
        title="新增批注"
        onMouseDown={keepSelection}
        onClick={() => controlRef.current?.startDraft()}
      >
        <span className="av-annotation-toolbar-icon" aria-hidden="true">✎</span>
        <span className="av-annotation-toolbar-word">新增批注</span>
      </button>
      <button
        type="button"
        className="av-annotations-btn av-annotation-toolbar-secondary"
        disabled={!count}
        onClick={(event) => controlRef.current?.exportAll(event.currentTarget)}
      >导出</button>
      <button
        type="button"
        className="av-annotations-btn av-annotations-btn-danger av-annotation-toolbar-secondary"
        disabled={!count}
        onClick={() => controlRef.current?.clearAll()}
      >清空批注</button>
    </span>
  );
}

export const AnnotationsPanel = forwardRef<AnnotationsPanelHandle, AnnotationsPanelProps>(function AnnotationsPanel(props, controlRef) {
  const list = props.adapter.read(props.fileKey);
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState<PendingSelection | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editing, setEditing] = useState<EditingDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [exportText, setExportText] = useState<string | null>(null);
  const [exportPosition, setExportPosition] = useState<ExportPopoverPosition | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (noticeTimer.current) clearTimeout(noticeTimer.current); }, []);

  useEffect(() => {
    const key = draft?.draftKey;
    const store = props.adapter.drafts;
    if (!key || !store) return;
    return store.subscribe(key, (record) => {
      // Empty is a tombstone, never a request to blank the live composer. It
      // is emitted before save/cancel and can return over the async Host bridge
      // after the person has already continued editing.
      if (!record.text) return;
      setDraft((current) => current?.draftKey === key && current.note !== record.text
        ? { ...current, note: record.text }
        : current);
    });
  }, [draft?.draftKey, props.adapter.drafts]);

  useEffect(() => {
    const key = editing?.draftKey;
    const store = props.adapter.drafts;
    if (!key || !store) return;
    return store.subscribe(key, (record) => {
      if (!record.text) return;
      setEditing((current) => current?.draftKey === key && current.note !== record.text
        ? { ...current, note: record.text }
        : current);
    });
  }, [editing?.draftKey, props.adapter.drafts]);

  const flashNotice = useCallback((message: string) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice(message);
    noticeTimer.current = setTimeout(() => setNotice(""), 4000);
  }, []);

  useEffect(() => {
    const listener = () => {
      const node = props.containerRef.current;
      if (!node) return;
      const selection = window.getSelection?.();
      // Clicking the persistent toolbar may collapse the browser selection.
      // Keep the most recent valid in-file selection until it is saved or a
      // new non-collapsed selection explicitly replaces it.
      if (!selection || selection.isCollapsed) return;
      const anchor = selection.anchorNode;
      const focus = selection.focusNode;
      if (!anchor || !focus || !node.contains(anchor) || !node.contains(focus)) { setPending(null); return; }
      if (props.kind === "pdf-text") {
        const info = props.pdfSelection?.() ?? null;
        if (!info) { setPending(null); return; }
        setPending({
          kind: "pdf-text",
          hint: buildAnchorHint(info.pageText, info.start, info.end),
          page: info.page,
          contentHash: info.contentHash,
        });
        return;
      }
      // Selection#toString inserts visual line breaks between Markdown blocks,
      // while anchors are rebound against the container's continuous
      // textContent. Derive both from the same DOM Range offsets so a selection
      // spanning headings, paragraphs, or list items stays byte-aligned.
      const offsets = textSelectionOffsets(node, selection);
      if (!offsets?.text.trim()) { setPending(null); return; }
      const haystack = node.textContent ?? "";
      setPending({
        kind: "markdown",
        hint: buildAnchorHint(haystack, offsets.start, offsets.end),
      });
    };
    document.addEventListener("selectionchange", listener);
    listener();
    return () => document.removeEventListener("selectionchange", listener);
  }, [props.containerRef, props.kind, props.pdfSelection]);

  const resolved = useMemo(() => list.map((annotation) => {
    if (annotation.target.kind === "markdown") {
      const haystack = props.containerRef.current?.textContent ?? "";
      const outcome = resolveAnchor(haystack, {
        quote: annotation.target.quote,
        prefix: annotation.target.prefix,
        suffix: annotation.target.suffix,
      });
      return { annotation, status: outcome.status };
    }
    if (annotation.target.kind === "pdf-text") {
      const pageText = props.pdfPageText?.(annotation.target.page) ?? "";
      const outcome = resolveAnchor(pageText, {
        quote: annotation.target.quote,
        prefix: annotation.target.prefix,
        suffix: annotation.target.suffix,
      });
      const forked = Boolean(
        props.currentContentHash
        && annotation.target.contentHash
        && props.currentContentHash !== annotation.target.contentHash,
      );
      return { annotation, status: forked ? "forked" as const : outcome.status };
    }
    return { annotation, status: "adrift" as const };
  }), [list, props.containerRef, props.pdfPageText, props.currentContentHash]);

  const persist = useCallback(async (
    next: readonly FileAnnotation[],
    onOk?: () => void,
  ): Promise<AnnotationSaveReply> => {
    setBusy(true);
    try {
      const reply = await props.adapter.save(props.fileKey, next);
      if (reply.ok) {
        onOk?.();
        flashNotice("已保存。");
      } else {
        flashNotice(reply.message || "保存被拒绝。");
      }
      return reply;
    } catch {
      flashNotice("保存失败。");
      return { ok: false, code: "unknown_outcome", message: "保存结果未知。" };
    } finally {
      setBusy(false);
    }
  }, [props.adapter, props.fileKey, flashNotice]);

  const startDraft = useCallback(() => {
    if (!pending) {
      flashNotice("请先在文件里选中要批注的文字。");
      return;
    }
    if (list.length >= ANNOTATION_LIMITS.perFileMax) {
      flashNotice(`每个文件最多 ${ANNOTATION_LIMITS.perFileMax} 条批注。`);
      return;
    }
    if (pending.kind === "markdown") {
      const target: AnnotationTarget = {
        kind: "markdown",
        quote: clampQuote(pending.hint.quote),
        prefix: clampContext(pending.hint.prefix),
        suffix: clampContext(pending.hint.suffix),
      };
      const draftKey = newAnnotationDraftKey(props.fileKey, target);
      setDraft({ target, draftKey, note: rememberedNote(props.adapter.drafts, draftKey, EMPTY_NOTE) });
    } else {
      const target: AnnotationTarget = {
        kind: "pdf-text",
        page: pending.page ?? 1,
        quote: clampQuote(pending.hint.quote),
        prefix: clampContext(pending.hint.prefix),
        suffix: clampContext(pending.hint.suffix),
        contentHash: pending.contentHash ?? "",
      };
      const draftKey = newAnnotationDraftKey(props.fileKey, target);
      setDraft({ target, draftKey, note: rememberedNote(props.adapter.drafts, draftKey, EMPTY_NOTE) });
    }
  }, [pending, list.length, props.adapter.drafts, props.fileKey, flashNotice]);

  const confirmDraft = useCallback(async () => {
    if (!draft) return;
    const note = normalizeNote(draft.note);
    if (!note) { flashNotice("请输入批注内容。"); return; }
    const submitted = draft;
    const now = Date.now();
    const next: FileAnnotation = {
      id: mintAnnotationId(),
      createdAt: now,
      updatedAt: now,
      note,
      target: draft.target,
    };
    props.adapter.drafts?.set(submitted.draftKey, "");
    const reply = await persist([...list, next], () => {
      setDraft(null);
      setPending(null);
      window.getSelection?.()?.removeAllRanges();
    });
    if (definitelyNotSaved(reply)) props.adapter.drafts?.set(submitted.draftKey, submitted.note);
  }, [draft, list, persist, props.adapter.drafts, flashNotice]);

  const submitEdit = useCallback(async () => {
    if (!editing) return;
    const note = normalizeNote(editing.note);
    if (!note) { flashNotice("批注内容不能为空。"); return; }
    const submitted = editing;
    const next = list.map((annotation) =>
      annotation.id === editing.id
        ? { ...annotation, note, updatedAt: Date.now() }
        : annotation);
    props.adapter.drafts?.set(submitted.draftKey, "");
    const reply = await persist(next, () => setEditing(null));
    if (definitelyNotSaved(reply)) props.adapter.drafts?.set(submitted.draftKey, submitted.note);
  }, [editing, list, persist, props.adapter.drafts, flashNotice]);

  const removeAnnotation = useCallback(async (id: string) => {
    const next = list.filter((annotation) => annotation.id !== id);
    props.adapter.drafts?.set(editAnnotationDraftKey(props.fileKey, id), "");
    await persist(next);
  }, [list, persist, props.adapter.drafts, props.fileKey]);

  const clearAll = useCallback(async () => {
    if (!list.length) return;
    if (typeof window !== "undefined" && !window.confirm(`确定要清空「${props.label}」的全部批注吗？此操作不可恢复。`)) return;
    await persist([]);
  }, [list, persist, props.label]);

  const exportAll = useCallback(async (anchor?: HTMLElement) => {
    if (!list.length) { flashNotice("没有可导出的批注。"); return; }
    const lines: string[] = [];
    lines.push(`# 批注导出：${props.label}`);
    if (props.currentContentHash) lines.push(`版本 hash：${props.currentContentHash}`);
    lines.push("");
    list.forEach((annotation, index) => {
      lines.push(`## 批注 ${index + 1}`);
      const target = annotation.target;
      if (target.kind === "markdown") {
        lines.push("- 位置：Markdown 段落");
      } else if (target.kind === "pdf-text") {
        lines.push(`- 位置：PDF 第 ${target.page} 页`);
        if (target.contentHash && props.currentContentHash && target.contentHash !== props.currentContentHash) {
          lines.push(`- 批注版本 hash：${target.contentHash}（与当前版本不同）`);
        }
      }
      lines.push("- 原文：");
      target.quote.split(/\n/).forEach((line) => lines.push(`  > ${line}`));
      lines.push("- 批注：");
      annotation.note.split(/\n/).forEach((line) => lines.push(`  ${line}`));
      lines.push("");
    });
    const body = lines.join("\n");
    setExportPosition(positionExportPopover(anchor));
    setExportText(body);
    try {
      await copyText(body);
      flashNotice("已复制到剪贴板；弹出卡片中也可再次复制。");
    } catch {
      flashNotice("剪贴板不可用；请从弹出卡片手动复制。");
    }
  }, [list, props.label, props.currentContentHash, flashNotice]);

  const editAnnotation = useCallback((annotationId: string) => {
    const annotation = list.find((candidate) => candidate.id === annotationId);
    if (!annotation) return;
    const draftKey = editAnnotationDraftKey(props.fileKey, annotation.id);
    setEditing({
      id: annotation.id,
      draftKey,
      note: rememberedNote(props.adapter.drafts, draftKey, annotation.note),
    });
  }, [list, props.adapter.drafts, props.fileKey]);

  useImperativeHandle(controlRef, () => ({
    startDraft,
    exportAll: (anchor) => { void exportAll(anchor); },
    clearAll: () => { void clearAll(); },
    edit: editAnnotation,
    toggleList: () => setExpanded((value) => !value),
  }), [startDraft, exportAll, clearAll, editAnnotation]);

  return (
    <section className="av-annotations" aria-label={`批注：${props.label}`}>
      <header className="av-annotations-head">
        <button
          className="av-annotations-toggle"
          data-av-annotations-toggle
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          批注（{list.length}）
        </button>
        <span className="av-annotations-actions">
          <button
            type="button"
            className="av-annotations-btn"
            disabled={!list.length || busy}
            onClick={(event) => void exportAll(event.currentTarget)}
          >导出</button>
          <button
            type="button"
            className="av-annotations-btn av-annotations-btn-danger"
            disabled={!list.length || busy}
            onClick={() => void clearAll()}
          >清空</button>
        </span>
      </header>
      {draft ? (
        <aside className="av-annotations-composer" role="dialog" aria-label="新增批注">
          <strong>新增批注</strong>
          <blockquote className="av-annotations-quote">{draft.target.quote}</blockquote>
          <textarea
            className="av-annotations-input"
            aria-label="批注内容"
            value={draft.note}
            disabled={busy}
            onChange={(event) => {
              const note = event.target.value;
              setDraft({ ...draft, note });
              props.adapter.drafts?.set(draft.draftKey, note);
            }}
            maxLength={ANNOTATION_LIMITS.noteMax * 4}
            rows={3}
            autoFocus
          />
          <div className="av-annotations-draft-actions">
            <button type="button" className="av-annotations-btn av-annotations-btn-primary" disabled={busy} onClick={() => void confirmDraft()}>保存</button>
            <button type="button" className="av-annotations-btn" disabled={busy} onClick={() => {
              props.adapter.drafts?.set(draft.draftKey, "");
              setDraft(null);
            }}>取消</button>
          </div>
        </aside>
      ) : null}
      {editing ? (
        <aside className="av-annotations-composer" role="dialog" aria-label="编辑批注">
          <strong>编辑批注</strong>
          <textarea
            className="av-annotations-input"
            aria-label="编辑批注"
            value={editing.note}
            disabled={busy}
            onChange={(event) => {
              const note = event.target.value;
              setEditing({ ...editing, note });
              props.adapter.drafts?.set(editing.draftKey, note);
            }}
            rows={3}
            autoFocus
          />
          <div className="av-annotations-draft-actions">
            <button type="button" className="av-annotations-btn av-annotations-btn-primary" disabled={busy} onClick={() => void submitEdit()}>保存</button>
            <button type="button" className="av-annotations-btn" disabled={busy} onClick={() => {
              props.adapter.drafts?.set(editing.draftKey, "");
              setEditing(null);
            }}>取消</button>
          </div>
        </aside>
      ) : null}
      {notice ? <p className="av-annotations-notice av-annotations-toast" role="status">{notice}</p> : null}
      {exportText && exportPosition ? (
        <aside
          className="av-annotations-export-popover"
          role="dialog"
          aria-label="导出批注"
          style={exportPosition}
        >
          <header className="av-annotations-export-head">
            <strong>导出文本</strong>
            <button
              type="button"
              className="av-annotations-btn"
              onClick={() => {
                setExportText(null);
                setExportPosition(null);
              }}
            >关闭</button>
          </header>
          <textarea
            readOnly
            value={exportText}
            rows={10}
            className="av-annotations-export-area"
            aria-label="可手动复制的批注导出文本"
          />
        </aside>
      ) : null}
      {expanded ? (
        <div className="av-annotations-body">
          <PendingBar
            pending={pending}
            disabled={busy || !!draft}
            onStart={startDraft}
          />
          <ul className="av-annotations-list">
            {resolved.length === 0 ? (
              <li className="av-annotations-empty">还没有批注。请在预览里选中文本后点「新建」。</li>
            ) : null}
            {resolved.map(({ annotation, status }) => (
              <li key={annotation.id} className="av-annotations-item" data-status={status}>
                <blockquote className="av-annotations-quote">{annotation.target.quote}</blockquote>
                <p className="av-annotations-meta">
                  {annotation.target.kind === "pdf-text" ? `第 ${annotation.target.page} 页` : "Markdown"}
                  {" · "}
                  {status === "matched" ? "定位正常" : status === "adrift" ? "位置未找到（文件可能已改动）" : status === "forked" ? "对应历史版本" : "未匹配"}
                </p>
                <p className="av-annotations-note">{annotation.note}</p>
                <div className="av-annotations-item-actions">
                  <button
                    type="button"
                    className="av-annotations-btn"
                    disabled={busy}
                    onClick={() => editAnnotation(annotation.id)}
                  >编辑</button>
                  <button
                    type="button"
                    className="av-annotations-btn av-annotations-btn-danger"
                    disabled={busy}
                    onClick={() => void removeAnnotation(annotation.id)}
                  >删除</button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
});

interface ExportPopoverPosition {
  top?: number;
  bottom?: number;
  right: number;
}

function positionExportPopover(anchor?: HTMLElement): ExportPopoverPosition {
  const gap = 8;
  const edge = 10;
  if (!anchor) return { top: 64, right: 16 };
  const rect = anchor.getBoundingClientRect();
  const roomBelow = window.innerHeight - rect.bottom;
  const roomAbove = rect.top;
  const right = Math.max(edge, window.innerWidth - rect.right);
  if (roomBelow >= 260 || roomBelow >= roomAbove) {
    return { top: rect.bottom + gap, right };
  }
  return { bottom: window.innerHeight - rect.top + gap, right };
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = typeof document.execCommand === "function" && document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("clipboard unavailable");
}

interface PendingSelection {
  kind: "markdown" | "pdf-text";
  hint: { quote: string; prefix: string; suffix: string };
  page?: number;
  contentHash?: string;
}

function PendingBar({ pending, disabled, onStart }: { pending: PendingSelection | null; disabled: boolean; onStart(): void }) {
  return (
    <div className="av-annotations-pending" data-has-selection={pending ? "1" : "0"}>
      {pending ? (
        <>
          <span className="av-annotations-pending-quote" title={pending.hint.quote}>
            {pending.hint.quote.length > CONTEXT_CHARS ? `${pending.hint.quote.slice(0, CONTEXT_CHARS)}…` : pending.hint.quote}
          </span>
          <button type="button" className="av-annotations-btn av-annotations-btn-primary" disabled={disabled} onClick={onStart}>
            新建批注
          </button>
        </>
      ) : (
        <span className="av-annotations-hint">在上方预览里选中一段文字，然后点这里的「新建」按钮。</span>
      )}
    </div>
  );
}
